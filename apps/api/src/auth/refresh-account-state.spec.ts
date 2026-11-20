import { AuthService } from './auth.service';

/**
 * A refresh that is refused because of what happened to the ACCOUNT says so,
 * with the same codes the per-request check uses — even though suspending or
 * deactivating an account also revokes its refresh tokens, which used to make
 * every such refresh look like a reused (possibly stolen) token.
 */
type Owner = { status: string; college: { status: string } | null } | null;

function build(owner: Owner, tokenRevoked: boolean) {
  const stored = {
    id: 'rt-1',
    userId: 'user-1',
    familyId: 'family-1',
    revokedAt: tokenRevoked ? new Date() : null,
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(
        owner && {
          id: 'user-1',
          collegeId: owner.college ? 'college-a' : null,
          role: 'STUDENT',
          studentProfile: null,
          ...owner,
        },
      ),
    },
    refreshToken: {
      findUnique: jest.fn().mockResolvedValue(stored),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const jwt = {
    verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-1', fam: 'family-1' }),
    signAsync: jest.fn().mockResolvedValue('header.payload.signature'),
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

const TOKEN = 'a.b.c.secret-part';
const active = { status: 'ACTIVE', college: { status: 'ACTIVE' } };

describe('refresh: the account state is reported ahead of token reuse', () => {
  it.each([
    ['SUSPENDED', 'ACCOUNT_SUSPENDED'],
    ['DEACTIVATED', 'ACCOUNT_DEACTIVATED'],
  ])(
    'a %s account whose tokens were revoked gets 401 %s, not "reused"',
    async (status, code) => {
      const { service, jwt, audit, prisma } = build({ ...active, status }, true);

      await expect(service.refresh(TOKEN, {})).rejects.toMatchObject({
        status: 401,
        response: { code },
      });

      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      // Not a theft signal: no reuse entry is written for it.
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('says the same when the token happens not to have been revoked', async () => {
    const { service, prisma } = build({ ...active, status: 'SUSPENDED' }, false);

    await expect(service.refresh(TOKEN, {})).rejects.toMatchObject({
      status: 401,
      response: { code: 'ACCOUNT_SUSPENDED' },
    });
    // And the family is ended, so the token cannot be tried again.
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { familyId: 'family-1', revokedAt: null } }),
    );
  });

  it("a deactivated college's user with revoked tokens gets 403 COLLEGE_INACTIVE, not \"reused\"", async () => {
    const { service, audit, jwt } = build({ status: 'ACTIVE', college: { status: 'INACTIVE' } }, true);

    await expect(service.refresh(TOKEN, {})).rejects.toMatchObject({
      status: 403,
      response: { code: 'COLLEGE_INACTIVE' },
    });
    expect(jwt.signAsync).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('an ACTIVE account presenting a used token is still treated as reuse, and logged', async () => {
    const { service, audit, prisma, jwt } = build(active, true);

    await expect(service.refresh(TOKEN, {})).rejects.toMatchObject({
      status: 401,
      response: { code: 'REFRESH_REUSED' },
    });

    expect(jwt.signAsync).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { familyId: 'family-1', revokedAt: null } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SESSIONS_REVOKED',
        detail: expect.objectContaining({ reason: 'REFRESH_TOKEN_REUSE' }),
      }),
    );
  });

  it('an ACTIVE account with a good token rotates as before', async () => {
    const { service, prisma } = build(active, false);

    await expect(service.refresh(TOKEN, {})).resolves.toMatchObject({
      accessToken: 'header.payload.signature',
    });
    expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
  });
});
