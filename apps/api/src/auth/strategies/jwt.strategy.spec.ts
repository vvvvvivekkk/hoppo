import { JwtStrategy } from './jwt.strategy';

/**
 * The strategy is where "is this shop account approved?" is answered for
 * every HTTP request. The answer has to come from the database each time, so
 * that approval (and nothing short of it) is what opens the API to a shop
 * login created by the public registration endpoint.
 */
interface StrategyLike {
  validate(payload: {
    sub: string;
    cid: string | null;
    role: string;
    ver: boolean;
  }): Promise<Record<string, unknown>>;
}

function build(user: Record<string, unknown> | null, approved: boolean) {
  const config = { getOrThrow: () => 'test-secret' };
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) } };
  const shopAccess = { hasApprovedShop: jest.fn().mockResolvedValue(approved) };
  // Constructed loosely so this spec can also be run against the revision
  // before the fix, where the strategy took two arguments.
  const Ctor = JwtStrategy as unknown as new (...args: unknown[]) => StrategyLike;
  return { strategy: new Ctor(config, prisma, shopAccess), shopAccess };
}

const payload = { sub: 'u1', cid: 'college-a', role: 'SHOP_OWNER', ver: false };

describe('JwtStrategy and shop approval', () => {
  it('marks a shop owner with no approved listing as not approved', async () => {
    const { strategy, shopAccess } = build(
      {
        id: 'u1',
        collegeId: 'college-a',
        role: 'SHOP_OWNER',
        status: 'ACTIVE',
        studentProfile: null,
      },
      false,
    );

    const result = await strategy.validate(payload);

    expect(shopAccess.hasApprovedShop).toHaveBeenCalledWith('u1');
    expect(result.shopApproved).toBe(false);
    expect(result.role).toBe('SHOP_OWNER');
  });

  it('marks shop staff as approved once a listing has been approved', async () => {
    const { strategy } = build(
      {
        id: 'u1',
        collegeId: 'college-a',
        role: 'SHOP_STAFF',
        status: 'ACTIVE',
        studentProfile: null,
      },
      true,
    );

    expect((await strategy.validate(payload)).shopApproved).toBe(true);
  });

  it('takes the role from the database, not from the token', async () => {
    // A token minted while the account was a student must not skip the check.
    const { strategy, shopAccess } = build(
      {
        id: 'u1',
        collegeId: 'college-a',
        role: 'SHOP_OWNER',
        status: 'ACTIVE',
        studentProfile: null,
      },
      false,
    );

    const result = await strategy.validate({ ...payload, role: 'STUDENT', ver: true });

    expect(shopAccess.hasApprovedShop).toHaveBeenCalledTimes(1);
    expect(result.shopApproved).toBe(false);
    expect(result.isVerified).toBe(false);
  });

  it('does not look up shops for a student, and sets no flag', async () => {
    const { strategy, shopAccess } = build(
      {
        id: 'u1',
        collegeId: 'college-a',
        role: 'STUDENT',
        status: 'ACTIVE',
        studentProfile: { verificationStatus: 'VERIFIED' },
      },
      true,
    );

    const result = await strategy.validate({ ...payload, role: 'STUDENT' });

    expect(shopAccess.hasApprovedShop).not.toHaveBeenCalled();
    expect('shopApproved' in result).toBe(false);
    expect(result.isVerified).toBe(true);
  });

  it('still refuses a suspended account before anything else', async () => {
    const { strategy, shopAccess } = build(
      {
        id: 'u1',
        collegeId: 'college-a',
        role: 'SHOP_OWNER',
        status: 'SUSPENDED',
        studentProfile: null,
      },
      true,
    );

    await expect(strategy.validate(payload)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_SUSPENDED' },
    });
    expect(shopAccess.hasApprovedShop).not.toHaveBeenCalled();
  });

  // FR-ADM-07: deactivating a tenant locks its users out at once.
  it('refuses any account of a deactivated college, with a code', async () => {
    for (const role of ['STUDENT', 'ADMIN', 'SHOP_OWNER']) {
      const { strategy, shopAccess } = build(
        {
          id: 'u1',
          collegeId: 'college-a',
          role,
          status: 'ACTIVE',
          studentProfile: null,
          college: { status: 'INACTIVE' },
        },
        true,
      );

      await expect(strategy.validate({ ...payload, role })).rejects.toMatchObject({
        status: 403,
        response: { code: 'COLLEGE_INACTIVE' },
      });
      expect(shopAccess.hasApprovedShop).not.toHaveBeenCalled();
    }
  });

  it('admits accounts of an active college, and a super administrator with none', async () => {
    const active = build(
      {
        id: 'u1',
        collegeId: 'college-a',
        role: 'ADMIN',
        status: 'ACTIVE',
        studentProfile: null,
        college: { status: 'ACTIVE' },
      },
      false,
    );
    await expect(active.strategy.validate({ ...payload, role: 'ADMIN' })).resolves.toMatchObject({
      userId: 'u1',
      role: 'ADMIN',
    });

    const root = build(
      {
        id: 'root',
        collegeId: null,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        studentProfile: null,
        college: null,
      },
      false,
    );
    await expect(
      root.strategy.validate({ sub: 'root', cid: null, role: 'SUPER_ADMIN', ver: false }),
    ).resolves.toMatchObject({ userId: 'root', collegeId: null });
  });
});
