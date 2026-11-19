import { Logger } from '@nestjs/common';
import { buildDispatch } from './test/fakes';

/**
 * The gateway's RIDER_PING handler (FR-WM-03).
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

/** A connected, authenticated rider's socket, online in work mode. */
function riderSocket(ctx: ReturnType<typeof buildDispatch>) {
  if (ctx.prisma.$rows('riderState').length === 0) {
    ctx.prisma.$seed('riderState', [{ userId: 'rider-1', workModeOn: true, lastPingAt: null }]);
    ctx.prisma.$seed('collegeConfig', [{ collegeId: 'col-1', riderPingIntervalSeconds: 15 }]);
  }
  return {
    data: { user: { userId: 'rider-1', collegeId: 'col-1', role: 'STUDENT' } } as Record<string, any>,
  };
}

// ===========================================================================
// (c) L9 — RIDER_PING validation and rate limit
// ===========================================================================

describe('RIDER_PING validation (L9)', () => {
  /**
   * Before: only `typeof` and `Number.isFinite` were checked, so the
   * out-of-range rows below were written to Redis and the database and
   * answered `{ ok: true }`. Those rows fail on that.
   */
  it.each([
    ['latitude above 90', { latitude: 90.0001, longitude: 78.65 }],
    ['latitude below -90', { latitude: -91, longitude: 78.65 }],
    ['longitude above 180', { latitude: 17.42, longitude: 180.5 }],
    ['longitude below -180', { latitude: 17.42, longitude: -181 }],
    ['a wildly out-of-range pair', { latitude: 9000, longitude: 9000 }],
    ['NaN', { latitude: Number.NaN, longitude: 78.65 }],
    ['Infinity', { latitude: 17.42, longitude: Number.POSITIVE_INFINITY }],
    ['a numeric string', { latitude: '17.42', longitude: 78.65 }],
    ['a missing longitude', { latitude: 17.42 }],
    ['no body at all', undefined],
  ])('rejects %s and writes nothing', async (_name, body) => {
    const ctx = buildDispatch();
    const client = riderSocket(ctx);

    const reply = await ctx.gateway.handleRiderPing(client as never, body as never);

    expect(reply).toEqual({ ok: false, reason: 'INVALID_POSITION' });
    expect(ctx.redis.setRiderPosition).not.toHaveBeenCalled();
    expect(ctx.prisma.riderState.update).not.toHaveBeenCalled();
    expect(ctx.prisma.$rows('riderState')[0].lastPingAt).toBeNull();
  });

  it.each([
    ['an ordinary campus position', { latitude: 17.42, longitude: 78.65 }],
    ['the north pole on the antimeridian', { latitude: 90, longitude: 180 }],
    ['the south pole on the antimeridian', { latitude: -90, longitude: -180 }],
    ['null island', { latitude: 0, longitude: 0 }],
  ])('accepts %s and records it', async (_name, body) => {
    const ctx = buildDispatch();
    const client = riderSocket(ctx);

    const reply = await ctx.gateway.handleRiderPing(client as never, body);

    expect(reply).toEqual({ ok: true });
    // The audit copy in the database is written too.
    expect(ctx.prisma.$rows('riderState')[0]).toMatchObject({
      lastLatitude: body.latitude,
      lastLongitude: body.longitude,
      lastPingAt: expect.any(Date),
    });
    expect(ctx.redis.setRiderPosition).toHaveBeenCalledWith({
      collegeId: 'col-1',
      userId: 'rider-1',
      latitude: body.latitude,
      longitude: body.longitude,
      ttlSeconds: 45,
    });
  });
});

describe('RIDER_PING rate limit (L9)', () => {
  /**
   * Before: no limit — every ping was two reads, a write and a Redis
   * transaction, as fast as a socket cared to send them. Fails on that with
   * the second ping answered `{ ok: true }` and two positions written.
   */
  const body = { latitude: 17.42, longitude: 78.65 };
  let now: jest.SpyInstance<number, []>;

  beforeEach(() => {
    now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  });
  afterEach(() => now.mockRestore());

  it('ignores a second ping from the same socket inside two seconds', async () => {
    const ctx = buildDispatch();
    const client = riderSocket(ctx);

    expect(await ctx.gateway.handleRiderPing(client as never, body)).toEqual({ ok: true });

    now.mockReturnValue(1_800_000_000_000 + 1_999);
    expect(await ctx.gateway.handleRiderPing(client as never, body)).toEqual({
      ok: false,
      reason: 'TOO_FREQUENT',
    });

    expect(ctx.redis.setRiderPosition).toHaveBeenCalledTimes(1);
    expect(ctx.prisma.riderState.update).toHaveBeenCalledTimes(1);
    // Dropped before it costs anything: one ping's worth of reads, not two.
    expect(ctx.prisma.riderState.findUnique).toHaveBeenCalledTimes(1);
  });

  it('accepts the next ping once two seconds have passed', async () => {
    const ctx = buildDispatch();
    const client = riderSocket(ctx);

    await ctx.gateway.handleRiderPing(client as never, body);
    now.mockReturnValue(1_800_000_000_000 + 2_000);

    expect(await ctx.gateway.handleRiderPing(client as never, body)).toEqual({ ok: true });
    expect(ctx.redis.setRiderPosition).toHaveBeenCalledTimes(2);
  });

  it('measures from the last accepted ping, so a flood cannot starve itself', async () => {
    const ctx = buildDispatch();
    const client = riderSocket(ctx);

    await ctx.gateway.handleRiderPing(client as never, body);
    // Ignored pings every half second must not push the window forward.
    for (const offset of [500, 1_000, 1_500]) {
      now.mockReturnValue(1_800_000_000_000 + offset);
      expect(await ctx.gateway.handleRiderPing(client as never, body)).toMatchObject({ ok: false });
    }
    now.mockReturnValue(1_800_000_000_000 + 2_000);

    expect(await ctx.gateway.handleRiderPing(client as never, body)).toEqual({ ok: true });
  });

  it('limits per socket, not per server', async () => {
    const ctx = buildDispatch();
    const first = riderSocket(ctx);
    const second = riderSocket(ctx);

    expect(await ctx.gateway.handleRiderPing(first as never, body)).toEqual({ ok: true });
    expect(await ctx.gateway.handleRiderPing(second as never, body)).toEqual({ ok: true });
  });

  it('does not let an invalid ping use up the allowance', async () => {
    const ctx = buildDispatch();
    const client = riderSocket(ctx);

    await ctx.gateway.handleRiderPing(client as never, { latitude: 9000, longitude: 0 });

    expect(await ctx.gateway.handleRiderPing(client as never, body)).toEqual({ ok: true });
  });
});
