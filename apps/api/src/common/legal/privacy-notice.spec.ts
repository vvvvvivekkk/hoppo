import { PRIVACY_NOTICE_VERSION, acceptedPrivacyVersion, privacyNotice } from './privacy-notice';
import { AuthService } from '../../auth/auth.service';
import { LegalController } from '../../auth/auth.controller';

describe('privacy notice (FR-PRIV-01)', () => {
  it('states what is collected, the purpose, the retention period and the grievance contact', () => {
    const notice = privacyNotice({
      PRIVACY_GRIEVANCE_NAME: 'Grievance Officer',
      PRIVACY_GRIEVANCE_EMAIL: 'privacy@example.test',
    });

    expect(notice.version).toBe(PRIVACY_NOTICE_VERSION);
    expect(notice.sections.map((s) => s.key)).toEqual([
      'dataCollected',
      'purpose',
      'retention',
      'grievance',
    ]);
    for (const section of notice.sections) {
      expect(section.heading.length).toBeGreaterThan(0);
      expect(section.body.length).toBeGreaterThan(40);
    }
    expect(notice.grievanceContact).toEqual({
      name: 'Grievance Officer',
      email: 'privacy@example.test',
    });
    expect(notice.acceptanceRequired).toBe(false);
  });

  it('says so, rather than inventing one, when no grievance contact is configured', () => {
    expect(privacyNotice({}).grievanceContact).toEqual({ name: null, email: null });
  });

  it('is served without a login', () => {
    expect(Reflect.getMetadata('isPublic', LegalController.prototype.privacyNotice)).toBe(true);
    const controller = new LegalController({ get: () => undefined } as never, {} as never);
    expect(controller.privacyNotice().version).toBe(PRIVACY_NOTICE_VERSION);
  });
});

describe('acceptance at registration', () => {
  it('records the current version when it is sent', () => {
    expect(acceptedPrivacyVersion(PRIVACY_NOTICE_VERSION, {})).toBe(PRIVACY_NOTICE_VERSION);
  });

  it('refuses a version that is not the current notice', () => {
    expect(() => acceptedPrivacyVersion('2020-01-01', {})).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'PRIVACY_NOTICE_OUTDATED',
          details: { currentVersion: PRIVACY_NOTICE_VERSION },
        }),
      }),
    );
  });

  it('lets a registration without it through only while acceptance is optional', () => {
    expect(acceptedPrivacyVersion(undefined, {})).toBeNull();
    expect(acceptedPrivacyVersion(undefined, { PRIVACY_ACCEPTANCE_REQUIRED: 'false' })).toBeNull();
    for (const missing of [undefined, null, '']) {
      expect(() =>
        acceptedPrivacyVersion(missing, { PRIVACY_ACCEPTANCE_REQUIRED: 'true' }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'PRIVACY_NOTICE_NOT_ACCEPTED' }),
        }),
      );
    }
  });
});

/**
 * AuthService.register, with the database mocked: what matters here is that
 * acceptance is checked before anything is created, and recorded in the same
 * transaction as the account.
 */
describe('AuthService.register and the privacy notice', () => {
  function build(env: Record<string, string> = {}) {
    const created = { id: 'user-1', collegeId: 'college-a', role: 'STUDENT' };
    const tx = {
      user: { create: jest.fn().mockResolvedValue(created) },
      studentProfile: { create: jest.fn() },
      riderReliability: { create: jest.fn() },
    };
    const prisma = {
      otpChallenge: {
        findUnique: jest.fn().mockResolvedValue({
          purpose: 'PHONE_VERIFY',
          recipient: '+919812345678',
          consumedAt: new Date(),
        }),
      },
      college: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'college-a', name: 'A', status: 'ACTIVE', emailDomain: null }),
      },
      refreshToken: { create: jest.fn() },
      $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const config = {
      get: (key: string, fallback?: unknown) => env[key] ?? fallback,
      getOrThrow: () => 'a-secret-that-is-long-enough-for-tests',
    };
    const jwt = { signAsync: jest.fn().mockResolvedValue('a.b.c') };
    const audit = { record: jest.fn(), recordInTransaction: jest.fn() };
    const service = new AuthService(
      prisma as never,
      jwt as never,
      config as never,
      {} as never,
      audit as never,
    );
    return { service, prisma, tx, audit };
  }

  const body = {
    name: 'New Student',
    mobile: '+919812345678',
    email: 'new@example.test',
    password: 'a-long-password',
    collegeId: 'college-a',
    mobileOtpChallengeId: 'challenge-1',
  };

  it('records version and timestamp in the same transaction as the account', async () => {
    const { service, tx, audit } = build();

    await service.register({ ...body, privacyNoticeVersion: PRIVACY_NOTICE_VERSION }, {});

    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'PRIVACY_NOTICE_ACCEPTED',
        actorId: 'user-1',
        targetType: 'user',
        targetId: 'user-1',
        detail: { version: PRIVACY_NOTICE_VERSION, at: 'REGISTRATION' },
      }),
    );
  });

  it('creates nothing when the version sent is out of date', async () => {
    const { service, prisma } = build();

    await expect(
      service.register({ ...body, privacyNoticeVersion: '2020-01-01' }, {}),
    ).rejects.toMatchObject({ response: { code: 'PRIVACY_NOTICE_OUTDATED' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a registration without acceptance once it is required', async () => {
    const { service, prisma } = build({ PRIVACY_ACCEPTANCE_REQUIRED: 'true' });

    await expect(service.register(body, {})).rejects.toMatchObject({
      response: { code: 'PRIVACY_NOTICE_NOT_ACCEPTED' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('still registers without it while acceptance is optional, recording nothing', async () => {
    const { service, tx, audit } = build();

    await expect(service.register(body, {})).resolves.toMatchObject({ userId: 'user-1' });
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });
});
