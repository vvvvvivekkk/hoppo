import { Logger } from '@nestjs/common';
import { DispatchService } from './dispatch.service';
import { WALLET_HEAD_ORDER } from '../wallet/wallet-ledger';
import { buildDispatch, wsEvents } from './test/fakes';

/**
 * The dispatcher's behaviour at its edges: who is told what, what an offer
 * carries, who is eligible, and what happens to the broadcast log.
 *
 * Each `describe` pins one fix that had been accepted on a reading of the
 * code and nothing more. The real DispatchService and DispatchGateway run;
 * only the database, Redis and the Socket.IO server are fakes (see
 * ./test/fakes). Every block is written to fail against the behaviour it
 * replaced — the comment at the top of each says how.
 */

// The dispatcher logs each broadcast and each fail-open; none of it is under
// test, and a wall of expected warnings hides an unexpected one.
beforeAll(() => {
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

const STAFF = [{ userId: 'staff-1' }, { userId: 'owner-1' }];

/** A shop-order task as the dispatcher reads it — a superset of every select. */
function taskFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    collegeId: 'col-1',
    type: 'SHOP_ORDER',
    status: 'CREATED',
    riderId: null,
    requesterId: 'student-1',
    pickupLabel: 'Sri Sai Tiffins',
    pickupLatitude: 17.42,
    pickupLongitude: 78.65,
    dropLabel: 'Boys Hostel B',
    dropLatitude: 17.421,
    dropLongitude: 78.651,
    distanceM: 640,
    baseFeeMinor: 2000,
    feeMinor: 2000,
    broadcastRound: 0,
    description: null,
    reimbursementMinor: null,
    offerExpiresAt: new Date(Date.now() + 60_000),
    orderId: 'order-1',
    order: {
      reference: 'HP-0001',
      status: 'PREPARING',
      expectedReadyAt: new Date('2026-11-20T12:30:00Z'),
      itemsSubtotalMinor: 12_000,
      totalMinor: 14_500,
      paymentMethod: 'CASH',
      studentId: 'student-1',
      shopListing: { shop: { name: 'Sri Sai Tiffins', staff: STAFF } },
    },
    college: {
      config: {
        acceptanceWindowSeconds: 60,
        initialProximityM: 1500,
        proximityIncrementM: 1000,
        feeIncrementMinor: 500,
        maxBroadcastRounds: 3,
        riderPingIntervalSeconds: 15,
      },
      feeBands: [],
    },
    ...overrides,
  };
}

/** One online, eligible rider near the pickup. */
function withOneEligibleRider(ctx: ReturnType<typeof buildDispatch>, riderId = 'rider-1') {
  ctx.redis.findRidersNear.mockResolvedValue([{ userId: riderId, distanceM: 200 }]);
  ctx.prisma.user.findMany.mockResolvedValue([{ id: riderId }]);
}

// ===========================================================================
// (a) M7 — status and withdrawal events go to user rooms, not the college
// ===========================================================================

describe('who is told when a task is accepted (M7)', () => {
  /**
   * Before: `notifyTaskStatus` and `withdrawOffer` emitted to `college:<id>`,
   * so every connected account in the college received the rider's id and
   * which task they took. These assertions fail on that: the college room is
   * in `toCollegeRooms()`, and the user rooms are absent.
   */
  async function acceptAsWinner() {
    const ctx = buildDispatch({
      offered: ['-', 'rider-win', 'rider-lose-1', 'rider-lose-2'],
    });
    ctx.prisma.task.findUnique.mockResolvedValue(taskFixture({ status: 'BROADCASTING', broadcastRound: 1 }));

    const result = await ctx.service.accept('rider-win', 'task-1');
    expect(result).toMatchObject({ taskId: 'task-1', status: 'ASSIGNED' });
    return ctx;
  }

  it('sends nothing at all to the college room', async () => {
    const { server } = await acceptAsWinner();

    // Something was emitted — otherwise an empty list would pass this.
    expect(server.emissions.length).toBeGreaterThan(0);
    expect(server.toCollegeRooms()).toEqual([]);
  });

  it('tells the requester, the rider and the shop staff the task is ASSIGNED', async () => {
    const { server } = await acceptAsWinner();

    const status = server.of(wsEvents.TASK_STATUS_CHANGED);
    expect(status).toHaveLength(1);
    expect([...status[0]!.rooms].sort()).toEqual([
      'user:owner-1',
      'user:rider-win',
      'user:staff-1',
      'user:student-1',
    ]);
    expect(status[0]!.payload).toEqual({
      taskId: 'task-1',
      status: 'ASSIGNED',
      riderId: 'rider-win',
    });
  });

  it('withdraws the offer only from the riders who were offered it', async () => {
    const { server } = await acceptAsWinner();

    const rooms = server.roomsFor(wsEvents.TASK_OFFER_WITHDRAWN).sort();
    expect(rooms).toEqual(['user:rider-lose-1', 'user:rider-lose-2', 'user:rider-win']);
  });

  it('does not tell the losing riders who won', async () => {
    const { server } = await acceptAsWinner();

    const withdrawals = server.of(wsEvents.TASK_OFFER_WITHDRAWN);
    const toLosers = withdrawals.filter((e) => !e.rooms.includes('user:rider-win'));
    const toWinner = withdrawals.filter((e) => e.rooms.includes('user:rider-win'));

    expect(toLosers).toHaveLength(2);
    for (const emission of toLosers) {
      expect(emission.payload).toEqual({ taskId: 'task-1', winnerUserId: null, won: false });
      expect(JSON.stringify(emission.payload)).not.toContain('rider-win');
    }

    // The winner's own copy still carries their id, so a client comparing
    // `winnerUserId` with its own user id keeps working.
    expect(toWinner).toHaveLength(1);
    expect(toWinner[0]!.payload).toEqual({ taskId: 'task-1', winnerUserId: 'rider-win', won: true });
  });
});

describe('who is told when an order times out at the shop (M7)', () => {
  /**
   * Before: ORDER_STATUS_CHANGED, with the cancellation reason, went to
   * `college:<id>`. Fails on that for the same reason as above.
   */
  it('tells the student and the shop staff, and nobody else', async () => {
    const ctx = buildDispatch();
    ctx.prisma.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        reference: 'HP-0001',
        collegeId: 'col-1',
        studentId: 'student-1',
        placedAt: new Date(Date.now() - 3_600_000),
        paymentMethod: 'CASH',
        totalMinor: 14_500,
        task: { id: 'task-1', status: 'CREATED' },
        shopListing: {
          id: 'listing-1',
          college: { config: { shopAcceptWindowSeconds: 300 } },
          shop: { staff: STAFF },
        },
      },
    ]);
    // The pre-fix code re-read the order inside its transaction.
    ctx.prisma.order.findUnique.mockResolvedValue({ status: 'PLACED' });

    await ctx.service.sweepUnacceptedOrders();

    const events = ctx.server.of(wsEvents.ORDER_STATUS_CHANGED);
    expect(events).toHaveLength(1);
    expect([...events[0]!.rooms].sort()).toEqual(['user:owner-1', 'user:staff-1', 'user:student-1']);
    expect(events[0]!.payload).toEqual({
      orderId: 'order-1',
      status: 'CANCELLED',
      reason: 'SHOP_DID_NOT_RESPOND',
    });
    expect(ctx.server.toCollegeRooms()).toEqual([]);
  });

  it('announces nothing when the shop accepted first and the cancel matched no row', async () => {
    const ctx = buildDispatch();
    ctx.prisma.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        reference: 'HP-0001',
        collegeId: 'col-1',
        studentId: 'student-1',
        placedAt: new Date(Date.now() - 3_600_000),
        paymentMethod: 'CASH',
        totalMinor: 14_500,
        task: null,
        shopListing: {
          id: 'listing-1',
          college: { config: { shopAcceptWindowSeconds: 300 } },
          shop: { staff: STAFF },
        },
      },
    ]);
    ctx.prisma.order.findUnique.mockResolvedValue({ status: 'SHOP_ACCEPTED' });
    ctx.prisma.order.updateMany.mockResolvedValue({ count: 0 });

    await ctx.service.sweepUnacceptedOrders();

    expect(ctx.prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'order-1', status: 'PLACED' } }),
    );
    expect(ctx.server.emissions).toEqual([]);
  });
});

// ===========================================================================
// (b) the offer tells the rider what cash they must front
// ===========================================================================

describe('the task offer payload (ADR-006)', () => {
  /**
   * Before: the offer had no cash fields at all, so a rider learned they had
   * to pay the shop out of pocket only after accepting. Fails on that with
   * `cashToPayShopMinor` undefined.
   */
  async function offerFor(overrides: Record<string, unknown>) {
    const ctx = buildDispatch();
    ctx.prisma.task.findUnique.mockResolvedValue(taskFixture(overrides));
    withOneEligibleRider(ctx);

    const result = await ctx.service.broadcast('task-1', { round: 0 });
    expect(result).toMatchObject({ eligibleCount: 1, round: 1 });

    const offers = ctx.server.of(wsEvents.TASK_OFFER);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.rooms).toEqual(['user:rider-1']);
    return offers[0]!.payload;
  }

  it('carries the cash to pay the shop and to collect, on a cash order', async () => {
    const offer = await offerFor({});

    expect(offer.cashToPayShopMinor).toBe(12_000);
    expect(offer.cashToCollectMinor).toBe(14_500);
  });

  it('reports zero cash on a wallet order', async () => {
    const base = taskFixture();
    const offer = await offerFor({ order: { ...base.order, paymentMethod: 'WALLET' } });

    expect(offer.cashToPayShopMinor).toBe(0);
    expect(offer.cashToCollectMinor).toBe(0);
  });

  it('reports zero cash on a peer errand, which has no order', async () => {
    const offer = await offerFor({ type: 'PEER_ERRAND', orderId: null, order: null });

    expect(offer.cashToPayShopMinor).toBe(0);
    expect(offer.cashToCollectMinor).toBe(0);
    expect(offer.orderReference).toBeNull();
  });

  it('keeps every field the offer already had', async () => {
    const offer = await offerFor({});

    expect(offer).toMatchObject({
      taskId: 'task-1',
      type: 'SHOP_ORDER',
      round: 1,
      pickupLabel: 'Sri Sai Tiffins',
      pickupLatitude: 17.42,
      pickupLongitude: 78.65,
      dropLabel: 'Boys Hostel B',
      dropLatitude: 17.421,
      dropLongitude: 78.651,
      distanceM: 640,
      feeMinor: 2000,
      description: null,
      reimbursementMinor: null,
      orderReference: 'HP-0001',
      shopName: 'Sri Sai Tiffins',
      expectedReadyAt: new Date('2026-11-20T12:30:00Z'),
      acceptanceWindowSeconds: 60,
    });
    expect(offer.expiresAt).toBeInstanceOf(Date);
  });
});

// ===========================================================================
// (d) L4 — a rider who stopped pinging is not offered tasks
// ===========================================================================

describe('findEligibleRiders and ping freshness (L4)', () => {
  /**
   * The database fake here applies the `lastPingAt` filter it is given, and
   * returns everybody when it is given none. Before the fix no filter was
   * sent, so the stale riders come back and these fail.
   */
  const seconds = (n: number) => new Date(Date.now() - n * 1000);

  function withRiders(lastPings: Record<string, Date | null>) {
    const ctx = buildDispatch();
    ctx.redis.findRidersNear.mockResolvedValue(
      Object.keys(lastPings).map((userId) => ({ userId, distanceM: 100 })),
    );
    ctx.prisma.user.findMany.mockImplementation(async (args: any) => {
      const since: Date | undefined = args?.where?.riderState?.lastPingAt?.gte;
      return Object.entries(lastPings)
        .filter(([id]) => args.where.id.in.includes(id))
        .filter(([, at]) => since === undefined || (at !== null && at >= since))
        .map(([id]) => ({ id }));
    });
    return ctx;
  }

  const near = { collegeId: 'col-1', latitude: 17.42, longitude: 78.65, radiusM: 1500 };

  it('excludes riders whose last ping is older than three intervals, or missing', async () => {
    const ctx = withRiders({
      'rider-fresh': seconds(10),
      'rider-closed-app': seconds(600),
      'rider-never-pinged': null,
    });

    const eligible = await ctx.service.findEligibleRiders(near);

    expect(eligible.map((r) => r.userId)).toEqual(['rider-fresh']);
  });

  it('measures staleness in the college\'s own ping interval', async () => {
    const ctx = withRiders({ 'rider-20s-ago': seconds(20) });

    // 15 s interval (the default): 20 s is inside three intervals.
    const lenient = await ctx.service.findEligibleRiders(near);
    expect(lenient.map((r) => r.userId)).toEqual(['rider-20s-ago']);

    // 5 s interval: 20 s is four missed pings. Gone.
    const strict = await ctx.service.findEligibleRiders({
      ...near,
      pingIntervalSeconds: 5,
    } as Parameters<DispatchService['findEligibleRiders']>[0]);
    expect(strict).toEqual([]);
  });

  it('asks the database for the cutoff rather than filtering afterwards', async () => {
    const ctx = withRiders({ 'rider-fresh': seconds(1) });
    const before = Date.now();

    await ctx.service.findEligibleRiders(near);

    const where = ctx.prisma.user.findMany.mock.calls[0]![0].where;
    const cutoff: Date = where.riderState.lastPingAt.gte;
    expect(cutoff).toBeInstanceOf(Date);
    // now - 3 x 15 s, give or take the time the call took.
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(45_000 - 50);
    expect(before - cutoff.getTime()).toBeLessThanOrEqual(45_000 + 1_000);
  });
});

// ===========================================================================
// (e) L2 — a broadcast that changed nothing offers nothing
// ===========================================================================

describe('broadcast() when its transaction is a no-op (L2)', () => {
  /**
   * A rider accepts between the dispatcher reading the task and writing the
   * round. Before: the transaction returned early and the code after it sent
   * the offer anyway — for a task somebody already held. Fails on that with
   * one TASK_OFFER emitted.
   */
  async function broadcastOntoTakenTask() {
    const ctx = buildDispatch();
    withOneEligibleRider(ctx);

    // First read: on offer. Any later read, and the conditional UPDATE: taken.
    ctx.prisma.task.findUnique
      .mockResolvedValue(taskFixture({ status: 'ASSIGNED', riderId: 'rider-9', broadcastRound: 1 }))
      .mockResolvedValueOnce(taskFixture());
    ctx.prisma.task.updateMany.mockResolvedValue({ count: 0 });

    const result = await ctx.service.broadcast('task-1', { round: 0 });
    return { ctx, result };
  }

  it('emits no offer', async () => {
    const { ctx, result } = await broadcastOntoTakenTask();

    // The eligible rider was really found — the silence is not for want of one.
    expect(ctx.redis.findRidersNear).toHaveBeenCalledTimes(1);
    expect(ctx.server.of(wsEvents.TASK_OFFER)).toEqual([]);
    expect(ctx.server.emissions).toEqual([]);
    expect(result).toBeNull();
  });

  it('records nobody as offered and counts no offer against any rider', async () => {
    const { ctx } = await broadcastOntoTakenTask();

    expect(ctx.redis.client.saddCalls).toEqual([]);
    expect(ctx.prisma.riderReliability.updateMany).not.toHaveBeenCalled();
    expect(ctx.prisma.broadcastLog.upsert).not.toHaveBeenCalled();
  });

  it('does offer when the transaction did move the task', async () => {
    // The control: same setup, the write matches, the offer goes out. Without
    // this the two tests above would pass against a dispatcher that never
    // offers anything.
    const ctx = buildDispatch();
    withOneEligibleRider(ctx);
    ctx.prisma.task.findUnique.mockResolvedValue(taskFixture());

    await ctx.service.broadcast('task-1', { round: 0 });

    expect(ctx.server.roomsFor(wsEvents.TASK_OFFER)).toEqual(['user:rider-1']);
    expect(ctx.redis.client.saddCalls).toEqual([['-', 'rider-1']]);
    expect(ctx.prisma.riderReliability.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: ['rider-1'] } },
      data: { tasksOffered: { increment: 1 } },
    });
  });
});

// ===========================================================================
// (g) M5 — broadcast_log rows are resolved, never deleted
// ===========================================================================

describe('the append-only broadcast log (M5)', () => {
  /**
   * Migration 20261119170100 puts a BEFORE DELETE trigger on broadcast_log.
   * The fake reproduces it: a delete rejects with the trigger's own message.
   * Before the fix `rebroadcastFromScratch` called `deleteMany`, so the first
   * test fails on that with the rejection — exactly the 500 a rider saw when
   * abandoning a task accepted in round 2.
   */
  const TRIGGER_ERROR =
    'Table broadcast_log is append-only: DELETE is not permitted. Insert a compensating row instead.';

  it('returns a task to the pool by expiring its pending rounds, without a DELETE', async () => {
    const ctx = buildDispatch();
    ctx.prisma.task.findUnique.mockResolvedValue(taskFixture());
    ctx.prisma.broadcastLog.deleteMany.mockRejectedValue(new Error(TRIGGER_ERROR));
    ctx.prisma.broadcastLog.delete.mockRejectedValue(new Error(TRIGGER_ERROR));

    await expect(ctx.service.rebroadcastFromScratch('task-1')).resolves.toBeUndefined();

    expect(ctx.prisma.broadcastLog.deleteMany).not.toHaveBeenCalled();
    expect(ctx.prisma.broadcastLog.delete).not.toHaveBeenCalled();
    expect(ctx.prisma.broadcastLog.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task-1', outcome: 'PENDING' },
      data: { outcome: 'EXPIRED', resolvedAt: expect.any(Date) },
    });
  });

  it('expires the previous round\'s pending row when the next round goes out', async () => {
    // Before: earlier rounds stayed PENDING for ever; this call was never made.
    const ctx = buildDispatch();
    ctx.prisma.task.findUnique.mockResolvedValue(
      taskFixture({ status: 'BROADCASTING', broadcastRound: 1 }),
    );

    const result = await ctx.service.broadcast('task-1', { round: 1 });
    expect(result).toMatchObject({ round: 2 });

    expect(ctx.prisma.broadcastLog.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task-1', outcome: 'PENDING', round: { lt: 2 } },
      data: { outcome: 'EXPIRED', resolvedAt: expect.any(Date) },
    });
    expect(ctx.prisma.broadcastLog.deleteMany).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// M8 — the offered list is consulted before the task's status
// ===========================================================================

describe('accept by a rider the task was never offered to (M8)', () => {
  /**
   * The status pre-check used to run first, so a rider who was never offered
   * a task and tried one that somebody had already taken was told
   * ALREADY_TAKEN — "you were too slow" — about a race they were never in.
   * The first test fails on that ordering.
   */
  async function refusal(ctx: ReturnType<typeof buildDispatch>, riderId: string): Promise<string> {
    const error: any = await ctx.service.accept(riderId, 'task-1').then(
      () => {
        throw new Error('expected the accept to be refused, but it succeeded');
      },
      (e: unknown) => e,
    );
    const code = error?.getResponse?.()?.code;
    if (!code) throw error;
    return code;
  }

  const taken = () =>
    taskFixture({ status: 'ASSIGNED', riderId: 'rider-win', broadcastRound: 1, offerExpiresAt: null });

  it('answers NOT_OFFERED_TO_YOU even when somebody else already holds the task', async () => {
    const ctx = buildDispatch({ offered: ['-', 'rider-win', 'rider-lose-1'] });
    ctx.prisma.task.findUnique.mockResolvedValue(taken());

    expect(await refusal(ctx, 'rider-outsider')).toBe('NOT_OFFERED_TO_YOU');
  });

  it.each(['CREATED', 'UNFULFILLED', 'CANCELLED', 'COMPLETED'])(
    'answers NOT_OFFERED_TO_YOU for a %s task too',
    async (status) => {
      const ctx = buildDispatch({ offered: ['-', 'rider-lose-1'] });
      ctx.prisma.task.findUnique.mockResolvedValue(taskFixture({ status }));

      expect(await refusal(ctx, 'rider-outsider')).toBe('NOT_OFFERED_TO_YOU');
    },
  );

  it('never reaches the assignment UPDATE, whatever the task\'s state', async () => {
    for (const fixture of [taken(), taskFixture({ status: 'BROADCASTING', broadcastRound: 1 })]) {
      const ctx = buildDispatch({ offered: ['-', 'rider-win', 'rider-lose-1'] });
      ctx.prisma.task.findUnique.mockResolvedValue(fixture);

      expect(await refusal(ctx, 'rider-outsider')).toBe('NOT_OFFERED_TO_YOU');

      expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
      expect(ctx.prisma.$executeRaw).not.toHaveBeenCalled();
      expect(ctx.prisma.riderState.updateMany).not.toHaveBeenCalled();
      expect(ctx.server.emissions).toEqual([]);
    }
  });

  it('still tells a rider who *was* offered it that somebody was faster', async () => {
    const ctx = buildDispatch({ offered: ['-', 'rider-win', 'rider-lose-1'] });
    ctx.prisma.task.findUnique.mockResolvedValue(taken());

    expect(await refusal(ctx, 'rider-lose-1')).toBe('ALREADY_TAKEN');
  });

  it('falls back to the status answer when there is no offer list to consult', async () => {
    // Redis flushed, or the set expired: membership is unknown, so it fails
    // open — and the status check and the conditional UPDATE still stand.
    const ctx = buildDispatch({ offered: null });
    ctx.prisma.task.findUnique.mockResolvedValue(taken());

    expect(await refusal(ctx, 'rider-outsider')).toBe('ALREADY_TAKEN');
    expect(ctx.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses the requester before anything else', async () => {
    const ctx = buildDispatch({ offered: ['-', 'rider-lose-1'] });
    ctx.prisma.task.findUnique.mockResolvedValue(taken());

    expect(await refusal(ctx, 'student-1')).toBe('CANNOT_ACCEPT_OWN_TASK');
  });
});

// ===========================================================================
// The accept-window sweep and the wallet ledger
// ===========================================================================

describe('sweepUnacceptedOrders releasing a wallet hold', () => {
  const HEAD_AT = new Date(Date.now() + 3_600_000);

  function overdueOrder(paymentMethod: 'WALLET' | 'CASH') {
    return {
      id: 'order-1',
      reference: 'HP-0001',
      collegeId: 'col-1',
      studentId: 'student-1',
      placedAt: new Date(Date.now() - 3_600_000),
      paymentMethod,
      totalMinor: 14_500,
      task: { id: 'task-1', status: 'CREATED' },
      shopListing: {
        id: 'listing-1',
        college: { config: { shopAcceptWindowSeconds: 300 } },
        shop: { staff: STAFF },
      },
    };
  }

  async function sweep(paymentMethod: 'WALLET' | 'CASH') {
    const ctx = buildDispatch();
    ctx.prisma.order.findMany.mockResolvedValue([overdueOrder(paymentMethod)]);
    // The student's latest ledger entry: 2,000 left after the hold, stamped
    // in the future so the "strictly after the head" rule is visible.
    ctx.prisma.walletEntry.findFirst.mockResolvedValue({
      balanceAfterMinor: 2_000,
      createdAt: HEAD_AT,
    });

    await ctx.service.sweepUnacceptedOrders();

    // The sweep catches and logs its own errors; this proves it got through.
    expect(ctx.server.of(wsEvents.ORDER_STATUS_CHANGED)).toHaveLength(1);
    return ctx;
  }

  /**
   * Before: the cancel left `payment_status = HELD` on an order whose hold
   * had just been released — the order said the money was held, the ledger
   * said it had been given back. Fails on that: no paymentStatus in the data.
   */
  it('marks a WALLET order REFUNDED in the same conditional UPDATE that cancels it', async () => {
    const ctx = await sweep('WALLET');

    expect(ctx.prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(ctx.prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'PLACED' },
      data: expect.objectContaining({ status: 'CANCELLED', paymentStatus: 'REFUNDED' }),
    });
  });

  it('leaves the payment status of a CASH order alone', async () => {
    const ctx = await sweep('CASH');

    const data = ctx.prisma.order.updateMany.mock.calls[0]![0].data;
    expect(data.status).toBe('CANCELLED');
    expect(data).not.toHaveProperty('paymentStatus');
    expect(ctx.prisma.walletEntry.create).not.toHaveBeenCalled();
  });

  /**
   * Before: `orderBy: { createdAt: 'desc' }` and no `createdAt` on the new
   * entry — two entries in one millisecond had no defined order. Fails on
   * that: the orderBy differs and `createdAt` is undefined.
   */
  it('reads the wallet head with the shared tie-break ordering', async () => {
    const ctx = await sweep('WALLET');

    expect(ctx.prisma.walletEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'student-1' },
        orderBy: [...WALLET_HEAD_ORDER],
      }),
    );
  });

  it('stamps the release strictly after the head and builds the balance on it', async () => {
    const ctx = await sweep('WALLET');

    expect(ctx.prisma.walletEntry.create).toHaveBeenCalledTimes(1);
    const data = ctx.prisma.walletEntry.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      userId: 'student-1',
      direction: 'CREDIT',
      type: 'ORDER_RELEASE',
      amountMinor: 14_500,
      balanceAfterMinor: 16_500,
      orderId: 'order-1',
    });
    expect(data.createdAt).toEqual(new Date(HEAD_AT.getTime() + 1));
  });
});
