import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import { AuthController, LegalController } from './auth.controller';
import { PRIVACY_NOTICE_VERSION } from '../common/legal/privacy-notice';

/**
 * Signed-in password change (S-50) and in-app acceptance of the privacy
 * notice (FR-PRIV-01). The database is mocked; argon2 is real.
 */
type Loose = Record<string, (...args: never[]) => Promise<Record<string, unknown>>>;

async function build(opts: { currentPassword?: string; acceptedVersion?: string | null } = {}) {
  const passwordHash = await argon2.hash(opts.currentPassword ?? 'the-old-password', {
    type: argon2.argon2id,
  });
  const auditRows: { action: string; detail: unknown; createdAt: Date }[] = opts.acceptedVersion
    ? [
        {
          action: 'PRIVACY_NOTICE_ACCEPTED',
          detail: { version: opts.acceptedVersion, at: 'REGISTRATION' },
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]
    : [];

  const tx = {
    user: { update: jest.fn().mockResolvedValue({}) },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
  };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'user-1',
        collegeId: 'college-a',
        role: 'STUDENT',
        passwordHash,
        studentProfile: { verificationStatus: 'VERIFIED' },
      }),
    },
    auditLog: {
      findFirst: jest.fn(async () => auditRows[auditRows.length - 1] ?? null),
    },
    refreshToken: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const audit = {
    record: jest.fn(),
    recordInTransaction: jest.fn(
      async (_tx: unknown, entry: { action: string; detail: unknown }) => {
        auditRows.push({ action: entry.action, detail: entry.detail, createdAt: new Date() });
      },
    ),
  };
  const config = {
    get: (_key: string, fallback?: unknown) => fallback,
    getOrThrow: () => 'a-secret-that-is-long-enough-for-tests',
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('header.payload.signature') };
  const service = new AuthService(
    prisma as never,
    jwt as never,
    config as never,
    {} as never,
    audit as never,
  ) as unknown as Loose;
  return { service, prisma, tx, audit, passwordHash };
}

describe('POST /auth/password/change', () => {
  it('needs the current password; a wrong one changes nothing', async () => {
    const { service, prisma } = await build();

    await expect(
      service.changePassword(
        'user-1' as never,
        { currentPassword: 'a-guess-at-it', newPassword: 'a-brand-new-password' } as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ status: 403, response: { code: 'PASSWORD_INCORRECT' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('stores a new argon2id hash, ends every session, and returns a fresh pair', async () => {
    const { service, tx, prisma, audit, passwordHash } = await build();

    const result = await service.changePassword(
      'user-1' as never,
      { currentPassword: 'the-old-password', newPassword: 'a-brand-new-password' } as never,
      { ipAddress: '10.0.0.9', userAgent: 'spec' } as never,
    );

    const update = tx.user.update.mock.calls[0][0] as { data: { passwordHash: string } };
    expect(update.data.passwordHash).not.toBe(passwordHash);
    expect(update.data.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await argon2.verify(update.data.passwordHash, 'a-brand-new-password')).toBe(true);
    expect(update.data).toMatchObject({ failedLoginCount: 0, lockedUntil: null });

    // Every existing session, not "every one but this".
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', revokedAt: null } }),
    );
    // And one new session for the device that made the change, created after.
    expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    expect(prisma.refreshToken.create.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.refreshToken.updateMany.mock.invocationCallOrder[0],
    );
    expect(result).toMatchObject({
      accessToken: 'header.payload.signature',
      sessionsRevoked: 3,
    });
    expect(typeof result.refreshToken).toBe('string');

    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'PASSWORD_CHANGED',
        actorId: 'user-1',
        targetId: 'user-1',
      }),
    );
    // The audit entry never carries a password or a hash.
    expect(JSON.stringify(audit.recordInTransaction.mock.calls)).not.toContain('a-brand-new');
  });

  it('refuses to "change" to the same password', async () => {
    const { service, prisma } = await build();

    await expect(
      service.changePassword(
        'user-1' as never,
        { currentPassword: 'the-old-password', newPassword: 'the-old-password' } as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ status: 400, response: { code: 'PASSWORD_UNCHANGED' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('is a signed-in, throttled, 200 route open to an unapproved shop account', () => {
    const handler = (AuthController.prototype as unknown as Record<string, object>).changePassword;
    expect(Reflect.getMetadata('path', handler)).toBe('password/change');
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(200);
    expect(Reflect.getMetadata('isPublic', handler)).toBeUndefined();
    expect(Reflect.getMetadata('allowUnapprovedShop', handler)).toBe(true);
  });
});

describe('POST /legal/privacy-notice/accept', () => {
  const user = { userId: 'user-1', collegeId: 'college-a' };

  it('records acceptance of the current version, as registration does', async () => {
    const { service, audit } = await build({ acceptedVersion: null });

    const result = await service.acceptPrivacyNotice(
      user as never,
      PRIVACY_NOTICE_VERSION as never,
      { ipAddress: '10.0.0.9', userAgent: 'spec' } as never,
    );

    expect(result.version).toBe(PRIVACY_NOTICE_VERSION);
    expect(result.acceptedAt).toBeInstanceOf(Date);
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction.mock.calls[0][1]).toMatchObject({
      action: 'PRIVACY_NOTICE_ACCEPTED',
      actorId: 'user-1',
      targetType: 'user',
      targetId: 'user-1',
      collegeId: 'college-a',
      detail: { version: PRIVACY_NOTICE_VERSION, at: 'IN_APP' },
    });
  });

  it('refuses a version that is not the current notice, and records nothing', async () => {
    const { service, audit } = await build();

    await expect(
      service.acceptPrivacyNotice(user as never, '2020-01-01' as never, {} as never),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'PRIVACY_NOTICE_OUTDATED',
        details: { currentVersion: PRIVACY_NOTICE_VERSION },
      },
    });
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('accepting again returns the first acceptance and writes no second row', async () => {
    const { service, audit } = await build({ acceptedVersion: PRIVACY_NOTICE_VERSION });

    const result = await service.acceptPrivacyNotice(
      user as never,
      PRIVACY_NOTICE_VERSION as never,
      {} as never,
    );

    expect(result).toEqual({
      version: PRIVACY_NOTICE_VERSION,
      acceptedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('records a new acceptance for someone who accepted an older version', async () => {
    const { service, audit } = await build({ acceptedVersion: '2025-01-01' });

    const result = await service.acceptPrivacyNotice(
      user as never,
      PRIVACY_NOTICE_VERSION as never,
      {} as never,
    );

    expect(result.version).toBe(PRIVACY_NOTICE_VERSION);
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
  });

  it('needs a login (unlike reading the notice) and admits any role', () => {
    const proto = LegalController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata('path', proto.accept)).toBe('privacy-notice/accept');
    expect(Reflect.getMetadata('__httpCode__', proto.accept)).toBe(200);
    expect(Reflect.getMetadata('isPublic', proto.accept)).toBeUndefined();
    expect(Reflect.getMetadata('roles', proto.accept)).toBeUndefined();
    expect(Reflect.getMetadata('roles', LegalController)).toBeUndefined();
    expect(Reflect.getMetadata('allowUnapprovedShop', proto.accept)).toBe(true);
    // Reading it stays public.
    expect(Reflect.getMetadata('isPublic', proto.privacyNotice)).toBe(true);
  });
});
