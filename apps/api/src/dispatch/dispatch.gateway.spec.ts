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
