import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

/**
 * FR-ADM-07: a deactivated college's users are locked out — at login, and at
 * refresh. (The per-request check is in jwt.strategy.spec.ts.) The database
 * is mocked; argon2 and the token hashing are real.
 */
const PASSWORD = 'the-right-password';

async function build(collegeStatus: 'ACTIVE' | 'INACTIVE' | null) {
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const account = {
    id: 'user-1',
    collegeId: collegeStatus === null ? null : 'college-a',
    role: collegeStatus === null ? 'SUPER_ADMIN' : 'STUDENT',
    status: 'ACTIVE',
    passwordHash,
    failedLoginCount: 0,
    lockedUntil: null,
    studentProfile: null,
    college: collegeStatus === null ? null : { status: collegeStatus },
  };
  const stored = {
    id: 'rt-1',
    userId: 'user-1',
    familyId: 'family-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(account),
      update: jest.fn().mockResolvedValue({}),
    },
    refreshToken: {
      findUnique: jest.fn().mockResolvedValue(stored),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const jwt = {
    signAsync: jest.fn().mockResolvedValue('header.payload.signature'),
    verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-1', fam: 'family-1' }),
  };
  const config = {
    get: (_key: string, fallback?: unknown) => fallback,
    getOrThrow: () => 'a-secret-that-is-long-enough-for-tests',
  };
  const audit = { record: jest.fn(), recordInTransaction: jest.fn() };
  const service = new AuthService(
    prisma as never,
    jwt as never,
    config as never,
    {} as never,
    audit as never,
  );
  return { service, prisma, jwt, audit };
}

const login = (password: string) => ({ identifier: '+919812345678', password });

describe('login and a deactivated college', () => {
  it('refuses a correct password with COLLEGE_INACTIVE and issues no tokens', async () => {
    const { service, prisma, jwt, audit } = await build('INACTIVE');

    await expect(service.login(login(PASSWORD), {})).rejects.toMatchObject({
      status: 403,
      response: { code: 'COLLEGE_INACTIVE' },
    });

    expect(jwt.signAsync).not.toHaveBeenCalled();
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    // Not a successful login: no last-login stamp, no LOGIN_SUCCEEDED entry.
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN_SUCCEEDED' }),
    );
  });

  it('does not reveal the college state to someone who does not know the password', async () => {
    const { service } = await build('INACTIVE');

    await expect(service.login(login('a-wrong-guess'), {})).rejects.toMatchObject({
      status: 401,
      response: { code: 'INVALID_CREDENTIALS' },
    });
  });

  it('logs in a user of an active college, and a super administrator with no college', async () => {
    for (const status of ['ACTIVE', null] as const) {
      const { service, prisma } = await build(status);
      await expect(service.login(login(PASSWORD), {})).resolves.toMatchObject({
        accessToken: 'header.payload.signature',
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    }
  });
});

describe('refresh and a deactivated college', () => {
  it('refuses to mint a new pair, and revokes the family it was asked with', async () => {
    const { service, prisma, jwt } = await build('INACTIVE');

    await expect(service.refresh('a.b.c.secret-part', {})).rejects.toMatchObject({
      status: 403,
      response: { code: 'COLLEGE_INACTIVE' },
    });

    expect(jwt.signAsync).not.toHaveBeenCalled();
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { familyId: 'family-1', revokedAt: null } }),
    );
  });

  it('still rotates for a user of an active college, and for a super administrator', async () => {
    for (const status of ['ACTIVE', null] as const) {
      const { service, prisma } = await build(status);
      await expect(service.refresh('a.b.c.secret-part', {})).resolves.toMatchObject({
        accessToken: 'header.payload.signature',
      });
      // The presented token is marked used and one new one is created.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'rt-1', revokedAt: null }),
        }),
      );
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    }
  });
});
