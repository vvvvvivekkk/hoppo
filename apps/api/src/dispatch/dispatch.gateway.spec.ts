import { Logger } from '@nestjs/common';
import { buildDispatch } from './test/fakes';

/**
 * The gateway's outbound addressing and connect-time checks. The RIDER_PING
 * handler has its own file, dispatch.gateway.ping.spec.ts.
 *
 * The real DispatchGateway over a fake database, Redis and Socket.IO server
 * (see ./test/fakes).
 */

beforeAll(() => {
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

// ===========================================================================
// (a) M7 — the gateway's own addressing
// ===========================================================================

describe('offer withdrawal when the offered list is unknown (M7)', () => {
  it('falls back to the college room with nothing about any person', () => {
    const ctx = buildDispatch();

    ctx.gateway.withdrawOffer('col-1', 'task-1', 'rider-win', null);

    const toCollege = ctx.server.toCollegeRooms();
    expect(toCollege).toHaveLength(1);
    expect(toCollege[0]!.except).toEqual(['user:rider-win']);
    expect(toCollege[0]!.payload).toEqual({ taskId: 'task-1', winnerUserId: null, won: false });
  });
});

describe('disconnectUser', () => {
  it('closes every socket in the user\'s own room and no other', () => {
    const ctx = buildDispatch();

    ctx.gateway.disconnectUser('student-9');

    expect(ctx.server.disconnectedRooms).toEqual(['user:student-9']);
  });
});

// ===========================================================================
// Connect: an unapproved shop account does not get a socket
// ===========================================================================

describe('handleConnection and shop approval', () => {
  function connecting(ctx: ReturnType<typeof buildDispatch>, role: string) {
    ctx.jwt.verifyAsync.mockResolvedValue({ sub: 'user-1' });
    ctx.prisma.$seed('user', [{ id: 'user-1', collegeId: 'col-1', role, status: 'ACTIVE' }]);
    return {
      handshake: { auth: { token: 'signed' }, headers: {} },
      data: {} as Record<string, unknown>,
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
  }

  it.each(['SHOP_OWNER', 'SHOP_STAFF'])(
    'refuses a %s whose shop nobody has approved, and joins no room',
    async (role) => {
      const ctx = buildDispatch({ shopApproved: false });
      const client = connecting(ctx, role);

      await ctx.gateway.handleConnection(client as never);

      expect(ctx.shopAccess.hasApprovedShop).toHaveBeenCalledWith('user-1');
      expect(client.join).not.toHaveBeenCalled();
      expect(client.data.user).toBeUndefined();
      expect(client.emit).toHaveBeenCalledWith(
        'exception',
        expect.objectContaining({ code: 'SHOP_NOT_APPROVED' }),
      );
      expect(client.disconnect).toHaveBeenCalledWith(true);
    },
  );

  it('admits an approved shop account to its own rooms', async () => {
    const ctx = buildDispatch({ shopApproved: true });
    const client = connecting(ctx, 'SHOP_OWNER');

    await ctx.gateway.handleConnection(client as never);

    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.join.mock.calls.map((c) => c[0])).toEqual(['user:user-1', 'college:col-1']);
  });

  it('does not ask about shop approval for a student', async () => {
    const ctx = buildDispatch({ shopApproved: false });
    const client = connecting(ctx, 'STUDENT');

    await ctx.gateway.handleConnection(client as never);

    expect(ctx.shopAccess.hasApprovedShop).not.toHaveBeenCalled();
    expect(client.join).toHaveBeenCalledWith('user:user-1');
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Connect: a deactivated college's users do not get a socket (FR-ADM-07)
// ===========================================================================

describe('handleConnection and a deactivated college', () => {
  /**
   * HTTP refuses every request from a user of an INACTIVE college (the JWT
   * strategy, COLLEGE_INACTIVE). The socket handshake checked only the user's
   * own status, so those same users — whose accounts are still ACTIVE — could
   * connect, join their college's room, and go on receiving offers and chat.
   */
  function connecting(
    ctx: ReturnType<typeof buildDispatch>,
    user: { role?: string; collegeId?: string | null; college?: { status: string } | null },
  ) {
    ctx.jwt.verifyAsync.mockResolvedValue({ sub: 'user-1' });
    ctx.prisma.$seed('user', [
      { id: 'user-1', role: 'STUDENT', status: 'ACTIVE', collegeId: 'col-1', college: { status: 'ACTIVE' }, ...user },
    ]);
    return {
      handshake: { auth: { token: 'signed' }, headers: {} },
      data: {} as Record<string, unknown>,
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
  }

  it.each(['STUDENT', 'SHOP_OWNER', 'SHOP_STAFF', 'ADMIN'])(
    'refuses a %s of an INACTIVE college, and joins no room',
    async (role) => {
      const ctx = buildDispatch({ shopApproved: true });
      const client = connecting(ctx, { role, college: { status: 'INACTIVE' } });

      await ctx.gateway.handleConnection(client as never);

      expect(client.join).not.toHaveBeenCalled();
      expect(client.data.user).toBeUndefined();
      expect(client.emit).toHaveBeenCalledWith(
        'exception',
        expect.objectContaining({ code: 'COLLEGE_INACTIVE' }),
      );
      expect(client.disconnect).toHaveBeenCalledWith(true);
    },
  );

  it('admits a user of an ACTIVE college to their rooms', async () => {
    const ctx = buildDispatch();
    const client = connecting(ctx, {});

    await ctx.gateway.handleConnection(client as never);

    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.join.mock.calls.map((c) => c[0])).toEqual(['user:user-1', 'college:col-1']);
  });

  it('admits a super administrator, who belongs to no college', async () => {
    const ctx = buildDispatch();
    const client = connecting(ctx, { role: 'SUPER_ADMIN', collegeId: null, college: null });

    await ctx.gateway.handleConnection(client as never);

    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.join.mock.calls.map((c) => c[0])).toEqual(['user:user-1']);
  });

  it('asks the database for the college\'s status at connect, not the token', async () => {
    // The token was signed while the college was active. Deactivation has to
    // take effect on the next connection without waiting for it to expire.
    const ctx = buildDispatch();
    const client = connecting(ctx, { college: { status: 'INACTIVE' } });
    ctx.jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', cid: 'col-1', role: 'STUDENT', ver: true });

    await ctx.gateway.handleConnection(client as never);

    expect(ctx.prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ college: { select: { status: true } } }),
      }),
    );
    expect(client.join).not.toHaveBeenCalled();
  });
});
