import { Logger } from '@nestjs/common';
import { WALLET_HEAD_ORDER } from '../wallet/wallet-ledger';
import { buildDispatch, wsEvents } from './test/fakes';
import { codeOf, onOffer, seedChatRoom, seedRider, seedTask } from './test/world';

/**
 * The dispatcher: who may take a task, who is told what, what an offer
 * carries, and what each conditional write does when the row has moved on.
 *
 * The real DispatchService and DispatchGateway run over an in-memory database
 * that holds rows and evaluates every `where` — including the WHERE of the
 * raw accept UPDATE — plus a fake Redis and Socket.IO server (./test/fakes).
 *
 * That is the point of most of this file. The services protect themselves
 * with conditional UPDATEs: a write names the state it expects, and matches
 * no row if the task has moved on. A spec that only checked the arguments of
 * such a write would pass if a condition were deleted and the spec edited to
 * match. These seed the row a deleted condition would wrongly match, and
 * assert on what the rows and the sockets look like afterwards.
 */

// The dispatcher logs each broadcast and each fail-open; none of it is under
// test, and a wall of expected warnings hides an unexpected one.
beforeAll(() => {
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

type Ctx = ReturnType<typeof buildDispatch>;

/** One online, eligible rider near the pickup. */
function nearby(ctx: Ctx, ...riderIds: string[]) {
  for (const id of riderIds) seedRider(ctx.prisma, id);
  ctx.redis.findRidersNear.mockResolvedValue(riderIds.map((userId) => ({ userId, distanceM: 200 })));
}

/** A task on offer in round 1 to three riders, all of them free. */
function offeredToThree() {
  const ctx = buildDispatch();
  const { task, order } = seedTask(ctx.prisma, onOffer(1));
  for (const id of ['rider-win', 'rider-lose-1', 'rider-lose-2']) seedRider(ctx.prisma, id);
  ctx.redis.offer('task-1', ['rider-win', 'rider-lose-1', 'rider-lose-2'], task.firstBroadcastAt);
  return { ctx, task, order: order! };
}

// ===========================================================================
// Accept — the conditional UPDATE and everything hung on it
// ===========================================================================

describe('accept: the winner', () => {
  it('assigns the task, claims the rider and opens the chat room', async () => {
    const { ctx, task } = offeredToThree();

    const result = await ctx.service.accept('rider-win', 'task-1');

    expect(result).toMatchObject({ taskId: 'task-1', status: 'ASSIGNED' });
    expect(task).toMatchObject({ status: 'ASSIGNED', riderId: 'rider-win', offerExpiresAt: null });
    expect(ctx.prisma.$rows('riderState').find((r: any) => r.userId === 'rider-win').activeTaskId).toBe(
      'task-1',
    );
    const members = ctx.prisma.$rows('chatMember').map((m: any) => m.userId).sort();
    expect(members).toEqual(['owner-1', 'rider-win', 'staff-1', 'student-1']);
  });

  it('lets exactly one of several riders have it', async () => {
    const { ctx, task } = offeredToThree();

    const outcomes = await Promise.allSettled(
      ['rider-lose-1', 'rider-win', 'rider-lose-2'].map((id) => ctx.service.accept(id, 'task-1')),
    );

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const holders = ctx.prisma.$rows('riderState').filter((r: any) => r.activeTaskId === 'task-1');
    expect(holders).toHaveLength(1);
    expect(task.riderId).toBe(holders[0].userId);
  });
});

describe('accept: the conditions in the UPDATE, one at a time', () => {
  /**
   * Each test seeds the one row that a single missing condition would let
   * through, and asserts the task is not handed over.
   */

  it('refuses a task somebody already holds — `status = BROADCASTING`', async () => {
    const { ctx, task } = offeredToThree();
    Object.assign(task, { status: 'ASSIGNED', riderId: 'rider-lose-1', offerExpiresAt: null });
    // The rider's screen is a moment behind: their read still says on offer.
    ctx.prisma.$staleRead('task', {
      ...task,
      status: 'BROADCASTING',
      riderId: null,
      offerExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(await codeOf(ctx.service.accept('rider-win', 'task-1'))).toBe('ALREADY_TAKEN');
    expect(task.riderId).toBe('rider-lose-1');
  });

  it('refuses a task the student cancelled a moment ago — `status = BROADCASTING` alone', async () => {
    // No rider on it, so `rider_id IS NULL` is satisfied: only the status
    // stands between a rider and a delivery that no longer exists.
    const { ctx, task } = offeredToThree();
    const asRead = { ...task };
    Object.assign(task, { status: 'CANCELLED', offerExpiresAt: null });
    ctx.prisma.$staleRead('task', asRead);

    expect(await codeOf(ctx.service.accept('rider-win', 'task-1'))).toBe('TASK_CANCELLED');
    expect(task).toMatchObject({ status: 'CANCELLED', riderId: null });
    expect(ctx.prisma.$rows('riderState').find((r: any) => r.userId === 'rider-win').activeTaskId).toBeNull();
  });

  it('refuses a task with a rider on it whatever its status says — `rider_id IS NULL`', async () => {
    // BROADCASTING *with* a rider is a row the CHECK constraint
    // task_rider_presence_matches_status forbids, so in a real database this
    // condition never decides anything on its own: `status = 'BROADCASTING'`
    // already implies it. It is kept as defence in depth, and this is the
    // only place it can be exercised — with a row PostgreSQL would refuse.
    const { ctx, task } = offeredToThree();
    task.riderId = 'rider-lose-1';
    ctx.prisma.$staleRead('task', { ...task, riderId: null });

    expect(await codeOf(ctx.service.accept('rider-win', 'task-1'))).toBe('ALREADY_TAKEN');
    expect(task.riderId).toBe('rider-lose-1');
    expect(ctx.prisma.$rows('riderState').find((r: any) => r.userId === 'rider-win').activeTaskId).toBeNull();
  });

  it('refuses an offer whose window has closed — `offer_expires_at > now()`', async () => {
    const { ctx, task } = offeredToThree();
    task.offerExpiresAt = new Date(Date.now() - 1_000);

    expect(await codeOf(ctx.service.accept('rider-win', 'task-1'))).toBe('OFFER_EXPIRED');
    expect(task).toMatchObject({ status: 'BROADCASTING', riderId: null });
  });

  it('accepts a task on offer with no deadline', async () => {
    const { ctx, task } = offeredToThree();
    task.offerExpiresAt = null;

    await ctx.service.accept('rider-win', 'task-1');

    expect(task.riderId).toBe('rider-win');
  });

  it('refuses a rider already holding a task, and puts this one back — `activeTaskId: null`', async () => {
    // M3. The UNIQUE on active_task_id stops two riders sharing a task; it
    // says nothing about one rider's row being overwritten with a second.
    const { ctx, task } = offeredToThree();
    const state = ctx.prisma.$rows('riderState').find((r: any) => r.userId === 'rider-win');
    state.activeTaskId = 'task-other';

    expect(await codeOf(ctx.service.accept('rider-win', 'task-1'))).toBe('ALREADY_HOLDING_TASK');

    // Still holding the first task...
    expect(state.activeTaskId).toBe('task-other');
    // ...and the assignment made a statement earlier was rolled back, so the
    // task is on offer to everyone else rather than stranded.
    expect(task).toMatchObject({ status: 'BROADCASTING', riderId: null });
    expect(ctx.prisma.$rows('chatRoom')).toEqual([]);
    expect(ctx.server.emissions).toEqual([]);
  });

  it('refuses a rider with no rider-state row at all', async () => {
    const { ctx, task } = offeredToThree();
    ctx.redis.offer('task-1', ['rider-ghost'], task.firstBroadcastAt);

    expect(await codeOf(ctx.service.accept('rider-ghost', 'task-1'))).toBe('ALREADY_HOLDING_TASK');
    expect(task.riderId).toBeNull();
  });
});

describe('accept after an abandonment (H1)', () => {
  it('re-opens the task\'s existing chat room and swaps the rider', async () => {
    const { ctx, task } = offeredToThree();
    const room = seedChatRoom(ctx.prisma, task, ['student-1', 'staff-1', 'owner-1', 'rider-old']);
    Object.assign(room, { isArchived: true, archivedAt: new Date() });

    const result = await ctx.service.accept('rider-win', 'task-1');

    expect(result.chatRoomId).toBe('room-1');
    expect(ctx.prisma.$rows('chatRoom')).toHaveLength(1);
    expect(room).toMatchObject({ isArchived: false, archivedAt: null });

    const members = ctx.prisma.$rows('chatMember');
    const present = members.filter((m: any) => m.leftAt == null).map((m: any) => m.userId).sort();
    expect(present).toEqual(['owner-1', 'rider-win', 'staff-1', 'student-1']);
    expect(members.find((m: any) => m.userId === 'rider-old').leftAt).toBeInstanceOf(Date);
  });
});

// ===========================================================================
// M8 — who may accept at all
// ===========================================================================

describe('accept by a rider the task was never offered to (M8)', () => {
  it('is refused, and the task stays on offer', async () => {
    const { ctx, task } = offeredToThree();
    seedRider(ctx.prisma, 'rider-outsider');

    expect(await codeOf(ctx.service.accept('rider-outsider', 'task-1'))).toBe('NOT_OFFERED_TO_YOU');

    expect(task).toMatchObject({ status: 'BROADCASTING', riderId: null });
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
    expect(ctx.server.emissions).toEqual([]);
  });

  it('is told NOT_OFFERED_TO_YOU, not ALREADY_TAKEN, when somebody else holds the task', async () => {
    // The offered list is consulted before the status, so the answer is the
    // true one: they were never in the race they are being told they lost.
    const { ctx, task } = offeredToThree();
    seedRider(ctx.prisma, 'rider-outsider');
    Object.assign(task, { status: 'ASSIGNED', riderId: 'rider-win', offerExpiresAt: null });

    expect(await codeOf(ctx.service.accept('rider-outsider', 'task-1'))).toBe('NOT_OFFERED_TO_YOU');
  });

  it.each(['CREATED', 'UNFULFILLED', 'CANCELLED', 'COMPLETED'])(
    'is told NOT_OFFERED_TO_YOU for a %s task too',
    async (status) => {
      const { ctx, task } = offeredToThree();
      Object.assign(task, { status, offerExpiresAt: null });

      expect(await codeOf(ctx.service.accept('rider-outsider', 'task-1'))).toBe('NOT_OFFERED_TO_YOU');
    },
  );

  it('still tells a rider who *was* offered it that somebody was faster', async () => {
    const { ctx, task } = offeredToThree();
    Object.assign(task, { status: 'ASSIGNED', riderId: 'rider-win', offerExpiresAt: null });

    expect(await codeOf(ctx.service.accept('rider-lose-1', 'task-1'))).toBe('ALREADY_TAKEN');
  });

  it('refuses the requester before anything else', async () => {
    const { ctx } = offeredToThree();

    expect(await codeOf(ctx.service.accept('student-1', 'task-1'))).toBe('CANNOT_ACCEPT_OWN_TASK');
  });
});

describe('accept when there is no offer list for the task (M8)', () => {
  /**
   * The list is a Redis set, and a set that is not there is not evidence of
   * anything good. It used to be treated as "cannot say", and failed open —
   * so once the set expired (acceptance window + 120 s) any rider who knew a
   * task id could accept it. Now: a task that is on offer always has a list,
   * so no list means nobody was offered it.
   */
  function onOfferWithNoList() {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, onOffer(1));
    seedRider(ctx.prisma, 'rider-1');
    return { ctx, task };
  }

  it('refuses a task that is on offer but has no list', async () => {
    const { ctx, task } = onOfferWithNoList();

    expect(await codeOf(ctx.service.accept('rider-1', 'task-1'))).toBe('NOT_OFFERED_TO_YOU');

    expect(task).toMatchObject({ status: 'BROADCASTING', riderId: null });
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses when the list exists but is empty of riders', async () => {
    const { ctx, task } = onOfferWithNoList();
    ctx.redis.offer('task-1', [], task.firstBroadcastAt);

    expect(await codeOf(ctx.service.accept('rider-1', 'task-1'))).toBe('NOT_OFFERED_TO_YOU');
    expect(task.riderId).toBeNull();
  });

  it('gives the status answer for a task that is not on offer', async () => {
    // Nothing to protect: the conditional UPDATE refuses a task that is not
    // BROADCASTING whoever asks, and the honest answer is the state's own.
    const { ctx, task } = onOfferWithNoList();
    Object.assign(task, { status: 'ASSIGNED', riderId: 'rider-9', offerExpiresAt: null });

    expect(await codeOf(ctx.service.accept('rider-1', 'task-1'))).toBe('ALREADY_TAKEN');
    expect(task.riderId).toBe('rider-9');
  });

  it('fails open only when Redis itself cannot be reached', async () => {
    // ADR-002: Redis being down must not be the reason deliveries stop. The
    // conditional UPDATE still decides who wins.
    const { ctx, task } = onOfferWithNoList();
    ctx.redis.down();

    const result = await ctx.service.accept('rider-1', 'task-1');

    expect(result).toMatchObject({ taskId: 'task-1', status: 'ASSIGNED' });
    expect(task.riderId).toBe('rider-1');
  });

  it('withdraws via the college room, naming nobody, when Redis is down', async () => {
    const { ctx } = onOfferWithNoList();
    ctx.redis.down();

    await ctx.service.accept('rider-1', 'task-1');

    const toCollege = ctx.server.toCollegeRooms();
    expect(toCollege).toHaveLength(1);
    expect(toCollege[0]!.event).toBe(wsEvents.TASK_OFFER_WITHDRAWN);
    expect(toCollege[0]!.payload).toEqual({ taskId: 'task-1', winnerUserId: null, won: false });
  });
});

describe('how long the offer list lives (M8)', () => {
  /**
   * It expired at acceptance window + 120 s — three minutes, by default —
   * while a task can be on offer for every round of its search and longer if
   * the sweep stalls. The list now outlives any search, and each round
   * renews it.
   */
  const key = 'dispatch:offered:task-1';

  it('outlives every round of the search, not just the first window', async () => {
    const ctx = buildDispatch();
    seedTask(ctx.prisma);
    nearby(ctx, 'rider-1');

    await ctx.service.broadcast('task-1', { round: 0 });

    // Three rounds of sixty seconds is the whole search; an hour is not close.
    expect(ctx.redis.ttls.get(key)).toBeGreaterThanOrEqual(3_600);
  });

  it('is renewed by each round, and keeps the riders from earlier rounds', async () => {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma);
    nearby(ctx, 'rider-1');
    await ctx.service.broadcast('task-1', { round: 0 });

    // Time passes; the key is about to lapse; a wider round finds another rider.
    ctx.redis.ttls.set(key, 5);
    nearby(ctx, 'rider-2');
    await ctx.service.broadcast('task-1', { round: 1 });

    expect(task.broadcastRound).toBe(2);
    expect(ctx.redis.ttls.get(key)).toBeGreaterThanOrEqual(3_600);
    expect(ctx.redis.offeredTo('task-1', task.firstBroadcastAt)).toEqual(['rider-1', 'rider-2']);
  });

  it('starts afresh when a task returns to the pool', async () => {
    // R-08: a new search. The rider who abandoned it does not keep a standing
    // right to take it back — their entry belongs to a search that is over.
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, { firstBroadcastAt: new Date(Date.now() - 600_000) });
    ctx.redis.offer('task-1', ['rider-abandoned'], task.firstBroadcastAt);
    const previousSearch = task.firstBroadcastAt;
    nearby(ctx, 'rider-1');
    seedRider(ctx.prisma, 'rider-abandoned');

    await ctx.service.broadcast('task-1', { round: 0 });

    expect(task.firstBroadcastAt.getTime()).toBeGreaterThan(previousSearch.getTime());
    expect(ctx.redis.offeredTo('task-1', task.firstBroadcastAt)).toEqual(['rider-1']);
    expect(await codeOf(ctx.service.accept('rider-abandoned', 'task-1'))).toBe(
      'NOT_OFFERED_TO_YOU',
    );
  });

  it('gives two searches different stamps even in the same millisecond', async () => {
    const ctx = buildDispatch();
    const farFuture = new Date(Date.now() + 86_400_000);
    const { task } = seedTask(ctx.prisma, { firstBroadcastAt: farFuture });

    await ctx.service.broadcast('task-1', { round: 0 });

    expect(task.firstBroadcastAt).toEqual(new Date(farFuture.getTime() + 1));
  });

  it('records a round that found nobody, so the task is not left without a list', async () => {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma);

    await ctx.service.broadcast('task-1', { round: 0 });

    expect(ctx.redis.offeredTo('task-1', task.firstBroadcastAt)).toEqual([]);
  });

  it('reads a plain, unstamped list for a task the dispatcher never broadcast', async () => {
    // A row put straight into BROADCASTING — which is how the live race
    // harnesses in apps/api/test set up a task — has no first_broadcast_at,
    // and its hand-written list has no stamps. It must keep working.
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, { ...onOffer(1), firstBroadcastAt: null });
    seedRider(ctx.prisma, 'rider-1');
    seedRider(ctx.prisma, 'rider-outsider');
    ctx.redis.offer('task-1', ['rider-1']);

    expect(await codeOf(ctx.service.accept('rider-outsider', 'task-1'))).toBe('NOT_OFFERED_TO_YOU');
    await ctx.service.accept('rider-1', 'task-1');
    expect(task.riderId).toBe('rider-1');
  });
});

describe('when the offer list cannot be written (M8)', () => {
  /**
   * The list is written to Redis; the round is written to PostgreSQL. They
   * can fail separately. The invariant that must survive a failed write:
   *
   *     a rider who was sent an offer can accept it,
   *     and a rider who was not, cannot.
   *
   * The first cut of the fail-closed rule broke it three ways, each
   * reproduced below: it sent offers it had not managed to record, and a
   * task on offer with no record refuses everybody.
   *
   * `failWrite` is the realistic failure: the pipeline's `exec` resolves and
   * the error sits in the command's own slot, where it is easy not to look.
   */
  const failWrite = (ctx: Ctx) => ctx.redis.failCommand('sadd');
  const heal = (ctx: Ctx) => ctx.redis.failCommand('sadd', 0);

  /** Riders the gateway actually pushed a TASK_OFFER to. */
  const sentOffers = (ctx: Ctx) =>
    ctx.server.roomsFor(wsEvents.TASK_OFFER).map((r) => r.slice('user:'.length));

  it('S1: never sends an offer that the rider would then be refused', async () => {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, { dispatchDueAt: new Date(Date.now() - 1_000) });
    nearby(ctx, 'rider-1');
    failWrite(ctx);

    await ctx.service.broadcast('task-1', { round: 0 });
    heal(ctx);

    // Whoever was told about the task must be able to take it. (Nobody being
    // told is fine — the round is simply tried again.)
    for (const riderId of sentOffers(ctx)) {
      await expect(ctx.service.accept(riderId, 'task-1')).resolves.toMatchObject({
        status: 'ASSIGNED',
      });
    }

    // And the search has not been used up: the next tick offers it for real.
    if (task.status !== 'ASSIGNED') {
      await ctx.service.dispatchDueTasks();
      expect(sentOffers(ctx)).toEqual(['rider-1']);
      await expect(ctx.service.accept('rider-1', 'task-1')).resolves.toMatchObject({
        status: 'ASSIGNED',
      });
    }
    expect(task).toMatchObject({ status: 'ASSIGNED', riderId: 'rider-1' });
  });

  it('S1: a round that could not be recorded is not sent, and does not spend a round', async () => {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma);
    nearby(ctx, 'rider-1');
    failWrite(ctx);

    const result = await ctx.service.broadcast('task-1', { round: 0 });

    expect(result).toBeNull();
    expect(ctx.server.emissions).toEqual([]);
    expect(task).toMatchObject({ status: 'CREATED', broadcastRound: 0, feeMinor: 2000 });
    expect(ctx.prisma.$rows('broadcastLog')).toEqual([]);
    expect(ctx.prisma.$rows('riderReliability')).toEqual([]);
  });

  describe('one failed write is retried before the round is given up', () => {
    /**
     * The commonest failure is a connection that has only just come back:
     * the first write fails and the next succeeds. Giving up on the first
     * would cost the task five seconds, every time Redis blinks, for nothing.
     */
    it.each([
      ['the write command fails once', (ctx: Ctx) => ctx.redis.failCommand('sadd', 1)],
      ['setting the expiry fails once', (ctx: Ctx) => ctx.redis.failCommand('expire', 1)],
      ['the connection drops for one call', (ctx: Ctx) => ctx.redis.downFor(1)],
    ])('sends the round when %s', async (_name, fail) => {
      const ctx = buildDispatch();
      const { task } = seedTask(ctx.prisma);
      nearby(ctx, 'rider-1');
      fail(ctx);

      const result = await ctx.service.broadcast('task-1', { round: 0 });

      expect(result).toMatchObject({ eligibleCount: 1, round: 1 });
      expect(task).toMatchObject({ status: 'BROADCASTING', broadcastRound: 1 });
      expect(sentOffers(ctx)).toEqual(['rider-1']);
      // And the offer it sent is one the rider can take.
      expect(ctx.redis.offeredTo('task-1', task.firstBroadcastAt)).toEqual(['rider-1']);
      await ctx.service.accept('rider-1', 'task-1');
      expect(task.riderId).toBe('rider-1');
    });

    it('gives the round up after the second failure, not the first and not the tenth', async () => {
      const ctx = buildDispatch();
      const { task } = seedTask(ctx.prisma);
      nearby(ctx, 'rider-1');
      ctx.redis.failCommand('sadd', 2);

      expect(await ctx.service.broadcast('task-1', { round: 0 })).toBeNull();
      expect(task.status).toBe('CREATED');
      expect(ctx.server.emissions).toEqual([]);

      // Both failures were spent on that one round: the next try goes through.
      expect(await ctx.service.broadcast('task-1', { round: 0 })).toMatchObject({ round: 1 });
    });
  });

  it('S2: a failed write on the final round does not retire a task a rider wants', async () => {
    // Round 2 of 3 has expired. The sweep sends round 3 — the last — while
    // the write is failing. Before: the offer went out unrecorded, the rider
    // who tapped it was refused, and the next sweep marked the task
    // UNFULFILLED with a willing rider standing by.
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, {
      status: 'BROADCASTING',
      broadcastRound: 2,
      firstBroadcastAt: new Date(Date.now() - 120_000),
      offerExpiresAt: new Date(Date.now() - 1_000),
    });
    nearby(ctx, 'rider-1');
    failWrite(ctx);

    await ctx.service.sweepExpiredOffers();

    for (const riderId of sentOffers(ctx)) {
      await expect(ctx.service.accept(riderId, 'task-1')).resolves.toMatchObject({
        status: 'ASSIGNED',
      });
    }

    heal(ctx);
    if (task.status !== 'ASSIGNED') {
      // The final round is still to come: nothing was spent on the failure.
      expect(task).toMatchObject({ status: 'BROADCASTING', broadcastRound: 2 });
      await ctx.service.sweepExpiredOffers();
      expect(task).toMatchObject({ status: 'BROADCASTING', broadcastRound: 3 });
      expect(sentOffers(ctx)).toEqual(['rider-1']);
      await ctx.service.accept('rider-1', 'task-1');
    }

    expect(task).toMatchObject({ status: 'ASSIGNED', riderId: 'rider-1' });
    expect(ctx.server.of(wsEvents.TASK_STATUS_CHANGED).map((e) => e.payload.status)).not.toContain(
      'UNFULFILLED',
    );
  });

  describe('S3: a task that returned to the pool', () => {
    /**
     * rider-old was offered the task and abandoned it. The new search is
     * offered to rider-new — and its first write to Redis fails.
     *
     * Before: the list was one set per task, cleared by a DEL in the same
     * failed pipeline. So rider-old's entry survived for a day: the rider who
     * walked away could take the task back without being offered it, and the
     * rider it was now offered to could not take it at all.
     */
    type Failure = 'the write command fails' | 'the connection drops';

    async function secondSearchAfterAFailedWrite(failure: Failure) {
      const ctx = buildDispatch();
      const { task } = seedTask(ctx.prisma);

      // The first search: offered to rider-old, who takes it and abandons it.
      nearby(ctx, 'rider-old');
      await ctx.service.broadcast('task-1', { round: 0 });
      Object.assign(task, {
        status: 'CREATED',
        broadcastRound: 0,
        riderId: null,
        offerExpiresAt: null,
        dispatchDueAt: new Date(),
      });
      ctx.server.emissions.length = 0;

      // The second search, with rider-old out of range.
      ctx.redis.findRidersNear.mockResolvedValue([{ userId: 'rider-new', distanceM: 150 }]);
      seedRider(ctx.prisma, 'rider-new');

      // Either way the new search's list is not written. When the connection
      // drops, the whole pipeline is lost — including whatever in it was
      // meant to clear the previous search's list.
      if (failure === 'the write command fails') failWrite(ctx);
      else ctx.redis.down();
      await ctx.service.dispatchDueTasks();
      heal(ctx);
      ctx.redis.down(false);

      return { ctx, task };
    }

    const FAILURES: Failure[] = ['the write command fails', 'the connection drops'];

    it.each(FAILURES)('does not let the previous rider take it back, when %s', async (failure) => {
      const { ctx, task } = await secondSearchAfterAFailedWrite(failure);

      // Straight after the failure, and again once the round has gone out.
      if (task.status === 'BROADCASTING') {
        expect(await codeOf(ctx.service.accept('rider-old', 'task-1'))).toBe('NOT_OFFERED_TO_YOU');
      }
      await ctx.service.dispatchDueTasks();

      expect(task.status).toBe('BROADCASTING');
      expect(await codeOf(ctx.service.accept('rider-old', 'task-1'))).toBe('NOT_OFFERED_TO_YOU');
      expect(task.riderId).toBeNull();
    });

    it.each(FAILURES)('lets the rider it is now offered to accept it, when %s', async (failure) => {
      const { ctx, task } = await secondSearchAfterAFailedWrite(failure);
      await ctx.service.dispatchDueTasks();

      expect(sentOffers(ctx)).toContain('rider-new');
      await ctx.service.accept('rider-new', 'task-1');

      expect(task).toMatchObject({ status: 'ASSIGNED', riderId: 'rider-new' });
    });

    it('keeps the two searches apart even when nothing fails', async () => {
      // The same separation, without the failure: a new search is a new list.
      const ctx = buildDispatch();
      const { task } = seedTask(ctx.prisma);
      nearby(ctx, 'rider-old');
      await ctx.service.broadcast('task-1', { round: 0 });
      Object.assign(task, {
        status: 'CREATED',
        broadcastRound: 0,
        riderId: null,
        offerExpiresAt: null,
      });

      ctx.redis.findRidersNear.mockResolvedValue([{ userId: 'rider-new', distanceM: 150 }]);
      seedRider(ctx.prisma, 'rider-new');
      await ctx.service.broadcast('task-1', { round: 0 });

      expect(await codeOf(ctx.service.accept('rider-old', 'task-1'))).toBe('NOT_OFFERED_TO_YOU');
      await ctx.service.accept('rider-new', 'task-1');
      expect(task.riderId).toBe('rider-new');
    });
  });

  it('treats an unreachable Redis the same way: no record, no offer', async () => {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma);
    nearby(ctx, 'rider-1');
    ctx.redis.down();

    const result = await ctx.service.broadcast('task-1', { round: 0 });

    expect(result).toBeNull();
    expect(ctx.server.emissions).toEqual([]);
    expect(task.status).toBe('CREATED');
  });
});

// ===========================================================================
// (a) M7 — status and withdrawal events go to user rooms, not the college
// ===========================================================================

describe('who is told when a task is accepted (M7)', () => {
  async function acceptAsWinner() {
    const { ctx } = offeredToThree();
    await ctx.service.accept('rider-win', 'task-1');
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
    expect(status[0]!.payload).toEqual({ taskId: 'task-1', status: 'ASSIGNED', riderId: 'rider-win' });
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
    }
    expect(toWinner).toHaveLength(1);
    expect(toWinner[0]!.payload).toEqual({ taskId: 'task-1', winnerUserId: 'rider-win', won: true });
  });
});

// ===========================================================================
// The shop accept-window sweep
// ===========================================================================

describe('sweepUnacceptedOrders', () => {
  const HEAD_AT = new Date(Date.now() + 3_600_000);

  /** An order the shop has ignored for an hour. */
  function overdue(order: Record<string, unknown> = {}) {
    const ctx = buildDispatch();
    const seeded = seedTask(ctx.prisma, {}, { status: 'PLACED', placedAt: new Date(Date.now() - 3_600_000), ...order });
    return { ctx, task: seeded.task, order: seeded.order! };
  }

  it('cancels the order and its task', async () => {
    const { ctx, task, order } = overdue();

    await ctx.service.sweepUnacceptedOrders();

    expect(order).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM' });
    expect(task.status).toBe('CANCELLED');
  });

  it('tells the student and the shop staff, and nobody else (M7)', async () => {
    const { ctx } = overdue();

    await ctx.service.sweepUnacceptedOrders();

    const events = ctx.server.of(wsEvents.ORDER_STATUS_CHANGED);
    expect(events).toHaveLength(1);
    expect([...events[0]!.rooms].sort()).toEqual([
      'user:owner-1',
      'user:staff-1',
      'user:student-1',
    ]);
    expect(events[0]!.payload).toEqual({
      orderId: 'order-1',
      status: 'CANCELLED',
      reason: 'SHOP_DID_NOT_RESPOND',
    });
    expect(ctx.server.toCollegeRooms()).toEqual([]);
  });

  it('leaves an order the shop accepted a moment ago — `status: PLACED`', async () => {
    // The sweep's list was read while the order was still PLACED; the shop
    // accepted before the write. The UPDATE must match nothing.
    const { ctx, task, order } = overdue({ paymentMethod: 'WALLET', paymentStatus: 'HELD' });
    const listedAsPlaced = { ...order };
    order.status = 'SHOP_ACCEPTED';
    ctx.prisma.order.findMany.mockResolvedValueOnce([listedAsPlaced]);

    await ctx.service.sweepUnacceptedOrders();

    expect(order).toMatchObject({ status: 'SHOP_ACCEPTED', paymentStatus: 'HELD' });
    expect(task.status).toBe('CREATED');
    expect(ctx.prisma.$rows('walletEntry')).toEqual([]);
    expect(ctx.server.emissions).toEqual([]);
  });

  it('does not sweep an order still inside the shop\'s window', async () => {
    const { ctx, order } = overdue({ placedAt: new Date(Date.now() - 60_000) });

    await ctx.service.sweepUnacceptedOrders();

    expect(order.status).toBe('PLACED');
  });

  describe('releasing a wallet hold', () => {
    function overdueWalletOrder() {
      const world = overdue({ paymentMethod: 'WALLET', paymentStatus: 'HELD' });
      // The student's latest ledger entry: 2,000 left after the hold, stamped
      // in the future so "strictly after the head" is visible.
      world.ctx.prisma.$seed('walletEntry', [
        { id: 'entry-old', userId: 'student-1', balanceAfterMinor: 9_000, createdAt: new Date(0) },
        { id: 'entry-head', userId: 'student-1', balanceAfterMinor: 2_000, createdAt: HEAD_AT },
        { id: 'entry-other', userId: 'somebody-else', balanceAfterMinor: 99_000, createdAt: HEAD_AT },
      ]);
      return world;
    }

    it('marks the order REFUNDED in the same UPDATE that cancels it', async () => {
      const { ctx, order } = overdueWalletOrder();

      await ctx.service.sweepUnacceptedOrders();

      expect(order).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
      expect(ctx.prisma.order.updateMany).toHaveBeenCalledTimes(1);
    });

    it('leaves the payment status of a CASH order alone', async () => {
      const { ctx, order } = overdue();

      await ctx.service.sweepUnacceptedOrders();

      expect(order).toMatchObject({ status: 'CANCELLED', paymentStatus: 'NOT_REQUIRED' });
      expect(ctx.prisma.$rows('walletEntry')).toEqual([]);
    });

    it('takes the student\'s wallet lock before touching a row', async () => {
      const { ctx } = overdueWalletOrder();

      await ctx.service.sweepUnacceptedOrders();

      expect(ctx.prisma.$locks).toEqual(['student-1']);
      const lockedAt = ctx.prisma.$executeRaw.mock.invocationCallOrder[0]!;
      expect(lockedAt).toBeLessThan(ctx.prisma.order.updateMany.mock.invocationCallOrder[0]!);
    });

    it('credits the hold back on top of the student\'s own latest balance', async () => {
      const { ctx } = overdueWalletOrder();

      await ctx.service.sweepUnacceptedOrders();

      const release = ctx.prisma.$rows('walletEntry').find((e: any) => e.type === 'ORDER_RELEASE');
      expect(release).toMatchObject({
        userId: 'student-1',
        direction: 'CREDIT',
        amountMinor: 14_500,
        balanceAfterMinor: 16_500,
        orderId: 'order-1',
      });
      // Stamped strictly after the entry it was computed from.
      expect(release.createdAt).toEqual(new Date(HEAD_AT.getTime() + 1));
    });

    it('reads the wallet head with the ledger\'s shared tie-break ordering', async () => {
      const { ctx } = overdueWalletOrder();

      await ctx.service.sweepUnacceptedOrders();

      expect(ctx.prisma.walletEntry.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'student-1' }, orderBy: [...WALLET_HEAD_ORDER] }),
      );
    });
  });
});

// ===========================================================================
// (b) the offer tells the rider what cash they must front
// ===========================================================================

describe('the task offer payload (ADR-006)', () => {
  async function offerFor(order: Record<string, unknown> | null) {
    const ctx = buildDispatch();
    seedTask(ctx.prisma, {}, order);
    nearby(ctx, 'rider-1');

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
    const offer = await offerFor({ paymentMethod: 'WALLET' });

    expect(offer.cashToPayShopMinor).toBe(0);
    expect(offer.cashToCollectMinor).toBe(0);
  });

  it('reports zero cash on a peer errand, which has no order', async () => {
    const offer = await offerFor(null);

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
// (d) L4 — who is eligible
// ===========================================================================

describe('findEligibleRiders', () => {
  const seconds = (n: number) => new Date(Date.now() - n * 1000);
  const near = { collegeId: 'col-1', latitude: 17.42, longitude: 78.65, radiusM: 1500 };

  function withRiders(riders: Record<string, Record<string, unknown>>) {
    const ctx = buildDispatch();
    for (const [id, state] of Object.entries(riders)) seedRider(ctx.prisma, id, state);
    ctx.redis.findRidersNear.mockResolvedValue(
      Object.keys(riders).map((userId) => ({ userId, distanceM: 100 })),
    );
    return ctx;
  }

  it('excludes riders whose last ping is older than three intervals, or missing (L4)', async () => {
    const ctx = withRiders({
      'rider-fresh': { lastPingAt: seconds(10) },
      'rider-closed-app': { lastPingAt: seconds(600) },
      'rider-never-pinged': { lastPingAt: null },
    });

    const eligible = await ctx.service.findEligibleRiders(near);

    expect(eligible.map((r) => r.userId)).toEqual(['rider-fresh']);
  });

  it('measures staleness in the college\'s own ping interval (L4)', async () => {
    const ctx = withRiders({ 'rider-20s-ago': { lastPingAt: seconds(20) } });

    // 15 s interval (the default): 20 s is inside three intervals.
    expect((await ctx.service.findEligibleRiders(near)).map((r) => r.userId)).toEqual(['rider-20s-ago']);
    // 5 s interval: 20 s is four missed pings. Gone.
    expect(await ctx.service.findEligibleRiders({ ...near, pingIntervalSeconds: 5 })).toEqual([]);
  });

  it('has the database exclude stale riders, rather than filtering them afterwards (L4)', async () => {
    // The cutoff is part of the query that decides who is entitled to an
    // offer — one statement, one answer. Fetching everyone and dropping the
    // stale ones in code would pass the tests above and still be a second
    // implementation of eligibility, free to drift from the first.
    const ctx = withRiders({ 'rider-fresh': { lastPingAt: seconds(1) } });
    const before = Date.now();

    await ctx.service.findEligibleRiders(near);

    expect(ctx.prisma.user.findMany).toHaveBeenCalledTimes(1);
    const cutoff: Date = ctx.prisma.user.findMany.mock.calls[0]![0].where.riderState.lastPingAt.gte;
    expect(cutoff).toBeInstanceOf(Date);
    // now - 3 x 15 s, give or take the time the call took.
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(45_000 - 50);
    expect(before - cutoff.getTime()).toBeLessThanOrEqual(45_000 + 1_000);

    // And with the college's own interval: 3 x 5 s.
    await ctx.service.findEligibleRiders({ ...near, pingIntervalSeconds: 5 });
    const strict: Date = ctx.prisma.user.findMany.mock.calls[1]![0].where.riderState.lastPingAt.gte;
    expect(Date.now() - strict.getTime()).toBeLessThanOrEqual(15_000 + 1_000);
    expect(Date.now() - strict.getTime()).toBeGreaterThanOrEqual(15_000 - 50);
  });

  it('excludes a rider who is offline, holding a task, or barred', async () => {
    const ctx = withRiders({
      'rider-ok': {},
      'rider-offline': { workModeOn: false },
      'rider-busy': { activeTaskId: 'task-9' },
      'rider-barred': { barredUntil: new Date(Date.now() + 3_600_000) },
      'rider-ban-over': { barredUntil: new Date(Date.now() - 1_000) },
    });

    const eligible = await ctx.service.findEligibleRiders(near);

    expect(eligible.map((r) => r.userId).sort()).toEqual(['rider-ban-over', 'rider-ok']);
  });

  it('excludes the requester and riders Redis marks busy', async () => {
    const ctx = withRiders({ 'rider-ok': {}, 'rider-redis-busy': {}, 'student-1': {} });
    ctx.redis.getBusyRiders.mockResolvedValue(['rider-redis-busy']);

    const eligible = await ctx.service.findEligibleRiders({ ...near, excludeUserIds: ['student-1'] });

    expect(eligible.map((r) => r.userId)).toEqual(['rider-ok']);
  });
});

// ===========================================================================
// Broadcast — the conditional UPDATE that sends a round
// ===========================================================================

describe('broadcast()', () => {
  it('puts the task on offer and tells the eligible rider', async () => {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma);
    nearby(ctx, 'rider-1');

    await ctx.service.broadcast('task-1', { round: 0 });

    expect(task).toMatchObject({ status: 'BROADCASTING', broadcastRound: 1, currentProximityM: 1500 });
    expect(ctx.server.roomsFor(wsEvents.TASK_OFFER)).toEqual(['user:rider-1']);
    expect(task.firstBroadcastAt).toBeInstanceOf(Date);
    expect(ctx.redis.offeredTo('task-1', task.firstBroadcastAt)).toEqual(['rider-1']);
    expect(ctx.prisma.$rows('riderReliability')).toEqual([
      expect.objectContaining({ userId: 'rider-1', tasksOffered: 1 }),
    ]);
  });

  it('counts an offer once per rider per search, not once per round (L5)', async () => {
    const ctx = buildDispatch();
    seedTask(ctx.prisma);
    nearby(ctx, 'rider-1');

    await ctx.service.broadcast('task-1', { round: 0 });
    await ctx.service.broadcast('task-1', { round: 1 });

    expect(ctx.server.of(wsEvents.TASK_OFFER)).toHaveLength(2);
    expect(ctx.prisma.$rows('riderReliability')[0].tasksOffered).toBe(1);
  });

  describe('when the task moved on between the read and the write (L2)', () => {
    /**
     * The dispatcher read the task as CREATED; before its UPDATE, something
     * else committed. Each test is one such "something", and each is a row
     * one condition of the UPDATE exists to refuse. Nothing may be offered,
     * recorded or counted.
     */
    async function broadcastOnto(actual: Record<string, unknown>, round = 0) {
      const ctx = buildDispatch();
      const { task } = seedTask(ctx.prisma, round === 0 ? {} : onOffer(round));
      nearby(ctx, 'rider-1');

      const asRead = { ...task };
      Object.assign(task, actual);
      ctx.prisma.$staleRead('task', asRead);

      const before = { ...task };
      const result = await ctx.service.broadcast('task-1', { round });

      // The eligible rider was really found — the silence is not for want of one.
      expect(ctx.redis.findRidersNear).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
      expect(task).toEqual(before);
      expect(ctx.server.emissions).toEqual([]);
      // (The offer list is written before the round is committed, so one may
      // exist for a round that was never sent. It grants nothing the search
      // would not have, and the task row above is what `accept` obeys.)
      expect(ctx.prisma.$rows('riderReliability')).toEqual([]);
      expect(ctx.prisma.$rows('broadcastLog')).toEqual([]);
    }

    it('offers nothing for a task the student just cancelled — `status`', async () => {
      await broadcastOnto({ status: 'CANCELLED' });
    });

    it('offers nothing when another instance already sent this round — `broadcastRound`', async () => {
      await broadcastOnto({ broadcastRound: 2, offerExpiresAt: new Date(Date.now() + 60_000) }, 1);
    });

    it('offers nothing for a task with a rider on it — `riderId: null`', async () => {
      // As with accept's `rider_id IS NULL`: a rider on a CREATED task is a
      // row the CHECK constraint forbids, so in PostgreSQL the status
      // condition already covers this. Defence in depth, exercised here with
      // a row the real database would refuse.
      await broadcastOnto({ riderId: 'rider-9' });
    });

    it('offers nothing for a task a rider accepted a moment ago', async () => {
      await broadcastOnto({ status: 'ASSIGNED', riderId: 'rider-9', offerExpiresAt: null }, 1);
    });
  });
});

// ===========================================================================
// Offers that ran out — FR-DLV-07
// ===========================================================================

describe('sweepExpiredOffers', () => {
  /** A task whose final round's window closed a moment ago. */
  function finalRoundExpired() {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, {
      status: 'BROADCASTING',
      broadcastRound: 3,
      offerExpiresAt: new Date(Date.now() - 1_000),
    });
    ctx.prisma.$seed('broadcastLog', [
      { id: 'log-1', cycle: 1, taskId: 'task-1', round: 1, outcome: 'EXPIRED' },
      { id: 'log-3', cycle: 1, taskId: 'task-1', round: 3, outcome: 'PENDING' },
    ]);
    return { ctx, task };
  }

  it('retires a task nobody took and offers the requester the three choices', async () => {
    const { ctx, task } = finalRoundExpired();

    await ctx.service.sweepExpiredOffers();

    expect(task).toMatchObject({ status: 'UNFULFILLED', offerExpiresAt: null });
    expect(ctx.prisma.$rows('broadcastLog').map((l: any) => l.outcome)).toEqual(['EXPIRED', 'EXPIRED']);

    const events = ctx.server.of(wsEvents.TASK_STATUS_CHANGED);
    expect(events).toHaveLength(1);
    expect([...events[0]!.rooms].sort()).toEqual([
      'user:owner-1',
      'user:staff-1',
      'user:student-1',
    ]);
    expect(events[0]!.payload).toEqual({
      taskId: 'task-1',
      status: 'UNFULFILLED',
      choices: ['KEEP_WAITING', 'COLLECT_IN_PERSON', 'CANCEL'],
    });
  });

  it('re-broadcasts instead while rounds remain', async () => {
    const { ctx, task } = finalRoundExpired();
    task.broadcastRound = 2;

    await ctx.service.sweepExpiredOffers();

    expect(task).toMatchObject({ status: 'BROADCASTING', broadcastRound: 3 });
  });

  describe('when the task moved on between the sweep\'s read and its write', () => {
    /**
     * The sweep listed the task, and retireUnfulfilled read it, as
     * BROADCASTING. Before the UPDATE, something else committed.
     */
    async function sweepOnto(actual: Record<string, unknown>) {
      const { ctx, task } = finalRoundExpired();

      const asRead = { ...task };
      Object.assign(task, actual);
      ctx.prisma.task.findMany.mockResolvedValueOnce([asRead]);
      ctx.prisma.$staleRead('task', asRead);

      const before = { ...task };
      await ctx.service.sweepExpiredOffers();

      expect(task).toEqual(before);
      // The log of the round is not resolved as EXPIRED either.
      expect(ctx.prisma.$rows('broadcastLog').map((l: any) => l.outcome)).toEqual(['EXPIRED', 'PENDING']);
      expect(ctx.server.emissions).toEqual([]);
    }

    it('does not retire a task the student cancelled — `status: BROADCASTING`', async () => {
      // No rider, same round: only the status tells this row apart.
      await sweepOnto({ status: 'CANCELLED', offerExpiresAt: null });
    });

    it('does not retire a task a rider just accepted', async () => {
      await sweepOnto({ status: 'ASSIGNED', riderId: 'rider-9', offerExpiresAt: null });
    });

    it('does not retire a task that was abandoned and is on a new search — `broadcastRound`', async () => {
      await sweepOnto({ broadcastRound: 1, offerExpiresAt: new Date(Date.now() + 60_000) });
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
   */
  const TRIGGER_ERROR =
    'Table broadcast_log is append-only: DELETE is not permitted. Insert a compensating row instead.';

  function withTrigger(ctx: Ctx) {
    ctx.prisma.broadcastLog.deleteMany.mockRejectedValue(new Error(TRIGGER_ERROR));
    ctx.prisma.broadcastLog.delete.mockRejectedValue(new Error(TRIGGER_ERROR));
  }

  it('returns a task to the pool by expiring its pending rounds, without a DELETE', async () => {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, { status: 'UNFULFILLED', broadcastRound: 3, feeMinor: 3000 });
    ctx.prisma.$seed('broadcastLog', [
      { id: 'log-2', cycle: 1, taskId: 'task-1', round: 2, outcome: 'PENDING' },
      { id: 'log-3', cycle: 1, taskId: 'task-1', round: 3, outcome: 'PENDING' },
      { id: 'log-x', cycle: 1, taskId: 'task-other', round: 1, outcome: 'PENDING' },
    ]);
    withTrigger(ctx);

    await expect(ctx.service.rebroadcastFromScratch('task-1')).resolves.toBeUndefined();

    expect(ctx.prisma.broadcastLog.deleteMany).not.toHaveBeenCalled();
    const outcome = (id: string) => ctx.prisma.$rows('broadcastLog').find((l: any) => l.id === id).outcome;
    expect(outcome('log-2')).toBe('EXPIRED');
    expect(outcome('log-3')).toBe('EXPIRED');
    // Another task's rounds are none of this one's business.
    expect(outcome('log-x')).toBe('PENDING');
    // And the search starts again at round 1, at the base fee.
    expect(task).toMatchObject({ status: 'BROADCASTING', broadcastRound: 1, feeMinor: 2000 });
  });

  it('does not reset a task a rider is holding', async () => {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, { status: 'ASSIGNED', riderId: 'rider-9', broadcastRound: 2 });
    withTrigger(ctx);

    await ctx.service.rebroadcastFromScratch('task-1');

    expect(task).toMatchObject({ status: 'ASSIGNED', riderId: 'rider-9', broadcastRound: 2 });
    expect(ctx.server.emissions).toEqual([]);
  });

  it('closes every row still PENDING when a round goes out, except that round\'s own', async () => {
    // Normally that is just the round before. It is also anything an earlier
    // search left open — a suspension returns a task to the pool without
    // tidying the log — whatever its cycle or round number.
    const ctx = buildDispatch();
    seedTask(ctx.prisma, { ...onOffer(1), broadcastCycle: 2 });
    ctx.prisma.$seed('broadcastLog', [
      { id: 'log-old-3', cycle: 1, taskId: 'task-1', round: 3, outcome: 'PENDING', resolvedAt: null },
      { id: 'log-new-1', cycle: 2, taskId: 'task-1', round: 1, outcome: 'PENDING', resolvedAt: null },
      { id: 'log-other', cycle: 2, taskId: 'task-other', round: 1, outcome: 'PENDING', resolvedAt: null },
    ]);

    await ctx.service.broadcast('task-1', { round: 1 });

    const row = (id: string) => ctx.prisma.$rows('broadcastLog').find((l: any) => l.id === id);
    expect(row('log-old-3')).toMatchObject({ outcome: 'EXPIRED', resolvedAt: expect.any(Date) });
    expect(row('log-new-1')).toMatchObject({ outcome: 'EXPIRED', resolvedAt: expect.any(Date) });
    expect(row('log-other')).toMatchObject({ outcome: 'PENDING', resolvedAt: null });
    // The round that just went out is the one row left open.
    const open = ctx.prisma.$rows('broadcastLog').filter((l: any) => l.taskId === 'task-1' && l.outcome === 'PENDING');
    expect(open.map((l: any) => [l.cycle, l.round])).toEqual([[2, 2]]);
  });

  it('expires the previous round\'s pending row when the next round goes out', async () => {
    const ctx = buildDispatch();
    seedTask(ctx.prisma, onOffer(1));
    ctx.prisma.$seed('broadcastLog', [{ id: 'log-1', cycle: 1, taskId: 'task-1', round: 1, outcome: 'PENDING' }]);
    withTrigger(ctx);

    const result = await ctx.service.broadcast('task-1', { round: 1 });
    expect(result).toMatchObject({ round: 2 });

    const log = ctx.prisma.$rows('broadcastLog');
    expect(log.map((l: any) => [l.round, l.outcome])).toEqual([
      [1, 'EXPIRED'],
      [2, 'PENDING'],
    ]);
    expect(ctx.prisma.broadcastLog.deleteMany).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// A second search of the same task — broadcast_log keyed by cycle
// ===========================================================================

describe('searching for a rider a second time', () => {
  /**
   * A task is searched for again after a rider abandons it, a rider is
   * suspended, or the student answers "keep waiting" to an unfulfilled
   * search. Its rounds restart at 1.
   *
   * broadcast_log used to be keyed on (task, round), written with an upsert
   * whose update branch re-opened the row. So the second search's round 1 was
   * written *onto* the first search's round 1: same row id, `sent_at`
   * replaced, EXPIRED back to PENDING. Three rows for four broadcasts, round
   * 1 dated after rounds 2 and 3, and the administrator's "rounds" and
   * "seconds to acceptance" computed from a row that described neither search.
   *
   * It is keyed on (task, cycle, round) now, and a search's rows are never
   * touched by another's.
   */
  const T0 = new Date('2026-11-20T02:22:10.000Z');
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

  /** The log of a first search that ran three rounds and found nobody. */
  const FIRST_SEARCH = [
    { id: 'first-1', taskId: 'task-1', cycle: 1, round: 1, radiusM: 1500, feeMinor: 2000, eligibleCount: 2, sentAt: at(0), outcome: 'EXPIRED', acceptedByUserId: null, resolvedAt: at(65) },
    { id: 'first-2', taskId: 'task-1', cycle: 1, round: 2, radiusM: 2500, feeMinor: 2500, eligibleCount: 3, sentAt: at(65), outcome: 'EXPIRED', acceptedByUserId: null, resolvedAt: at(130) },
    { id: 'first-3', taskId: 'task-1', cycle: 1, round: 3, radiusM: 3500, feeMinor: 3000, eligibleCount: 3, sentAt: at(130), outcome: 'EXPIRED', acceptedByUserId: null, resolvedAt: at(195) },
  ];

  /**
   * The task as "keep waiting" leaves it: back in the pool, round 0, base
   * fee — and on cycle 2, advanced by the statement that put it there.
   */
  function keptWaiting() {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, {
      status: 'CREATED',
      broadcastRound: 0,
      broadcastCycle: 2,
      firstBroadcastAt: at(0),
      dispatchDueAt: at(200),
    });
    ctx.prisma.$seed('broadcastLog', FIRST_SEARCH.map((row) => ({ ...row })));
    nearby(ctx, 'rider-1');
    return { ctx, task };
  }

  const rows = (ctx: Ctx) => ctx.prisma.$rows('broadcastLog');
  const firstSearchRows = (ctx: Ctx) => rows(ctx).filter((l: any) => l.cycle === 1);
  const secondSearchRows = (ctx: Ctx) =>
    rows(ctx)
      .filter((l: any) => l.cycle === 2)
      .map((l: any) => [l.round, l.outcome]);

  it('does not touch a single field of the first search\'s rows', async () => {
    const { ctx } = keptWaiting();

    await ctx.service.dispatchDueTasks();

    expect(firstSearchRows(ctx)).toEqual(FIRST_SEARCH);
  });

  it('records its own round 1 in a row of its own', async () => {
    const { ctx } = keptWaiting();

    await ctx.service.dispatchDueTasks();

    // Four broadcasts, four rows.
    expect(rows(ctx)).toHaveLength(4);
    const [second] = rows(ctx).filter((l: any) => l.cycle === 2);
    expect(second).toMatchObject({
      taskId: 'task-1',
      cycle: 2,
      round: 1,
      radiusM: 1500,
      feeMinor: 2000,
      eligibleCount: 1,
      outcome: 'PENDING',
    });
    expect(second.id).not.toBe('first-1');
  });

  it('keeps the two searches apart through every later round', async () => {
    const { ctx, task } = keptWaiting();

    await ctx.service.dispatchDueTasks();
    for (const round of [1, 2]) {
      task.offerExpiresAt = new Date(Date.now() - 1_000);
      await ctx.service.sweepExpiredOffers();
      expect(task.broadcastRound).toBe(round + 1);
    }

    expect(firstSearchRows(ctx)).toEqual(FIRST_SEARCH);
    expect(secondSearchRows(ctx)).toEqual([
      [1, 'EXPIRED'],
      [2, 'EXPIRED'],
      [3, 'PENDING'],
    ]);
  });

  it('marks the accepted round of the *second* search, not the first search\'s round 1', async () => {
    const { ctx } = keptWaiting();
    await ctx.service.dispatchDueTasks();

    await ctx.service.accept('rider-1', 'task-1');

    expect(firstSearchRows(ctx)).toEqual(FIRST_SEARCH);
    expect(rows(ctx).filter((l: any) => l.outcome === 'ACCEPTED')).toEqual([
      expect.objectContaining({ cycle: 2, round: 1, acceptedByUserId: 'rider-1', resolvedAt: expect.any(Date) }),
    ]);
  });

  it('retires the second search without re-stamping the first', async () => {
    const { ctx, task } = keptWaiting();
    await ctx.service.dispatchDueTasks();
    Object.assign(task, { broadcastRound: 3, offerExpiresAt: new Date(Date.now() - 1_000) });

    await ctx.service.sweepExpiredOffers();

    expect(task.status).toBe('UNFULFILLED');
    expect(firstSearchRows(ctx)).toEqual(FIRST_SEARCH);
    expect(secondSearchRows(ctx)).toEqual([[1, 'EXPIRED']]);
  });

  it('retires only the search that ran out — the log write is keyed on its cycle', async () => {
    // A row of another search that is somehow still open is not this
    // search's to close: it did not expire now, and stamping it with this
    // moment would be a false record. (A new round going out does close it —
    // see "closes every row still PENDING" — because then it is known to be
    // over; a search being retired says nothing about any other.)
    const { ctx, task } = keptWaiting();
    Object.assign(task, { status: 'BROADCASTING', broadcastRound: 3, offerExpiresAt: new Date(Date.now() - 1_000) });
    ctx.prisma.$seed('broadcastLog', [
      { id: 'other-open', taskId: 'task-1', cycle: 1, round: 4, outcome: 'PENDING', resolvedAt: null },
      { id: 'second-3', taskId: 'task-1', cycle: 2, round: 3, outcome: 'PENDING', resolvedAt: null },
    ]);

    await ctx.service.sweepExpiredOffers();

    expect(task.status).toBe('UNFULFILLED');
    const row = (id: string) => rows(ctx).find((l: any) => l.id === id);
    expect(row('second-3')).toMatchObject({ outcome: 'EXPIRED', resolvedAt: expect.any(Date) });
    expect(row('other-open')).toMatchObject({ outcome: 'PENDING', resolvedAt: null });
  });

  it('leaves the first search at cycle 1: sending a round never advances the cycle', async () => {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, { dispatchDueAt: at(0) });
    nearby(ctx, 'rider-1');

    await ctx.service.dispatchDueTasks();

    expect(task).toMatchObject({ status: 'BROADCASTING', broadcastRound: 1, broadcastCycle: 1 });
    expect(rows(ctx).map((l: any) => [l.cycle, l.round, l.outcome])).toEqual([[1, 1, 'PENDING']]);
  });

  it('sends nothing if the task moved to a new search after it was read — `broadcastCycle`', async () => {
    // The dispatcher read the task on cycle 1. Before its UPDATE the task
    // was returned to the pool: same status, same round 0, new cycle. Without
    // the cycle in the WHERE this round would be logged under the old search.
    const { ctx, task } = keptWaiting();
    ctx.prisma.$staleRead('task', { ...task, broadcastCycle: 1 });

    const result = await ctx.service.broadcast('task-1', { round: 0 });

    expect(result).toBeNull();
    expect(task).toMatchObject({ status: 'CREATED', broadcastRound: 0, broadcastCycle: 2 });
    expect(rows(ctx)).toEqual(FIRST_SEARCH);
    expect(ctx.server.emissions).toEqual([]);
  });

  it('does not retire a task that is on a newer search than the one read — `broadcastCycle`', async () => {
    // Same round number, different search: only the cycle tells them apart.
    const { ctx, task } = keptWaiting();
    Object.assign(task, { status: 'BROADCASTING', broadcastRound: 3, offerExpiresAt: new Date(Date.now() - 1_000) });
    ctx.prisma.$seed('broadcastLog', [
      { id: 'second-3', taskId: 'task-1', cycle: 2, round: 3, outcome: 'PENDING', resolvedAt: null },
    ]);
    const asRead = { ...task, broadcastCycle: 1 };
    ctx.prisma.task.findMany.mockResolvedValueOnce([asRead]);
    ctx.prisma.$staleRead('task', asRead);

    await ctx.service.sweepExpiredOffers();

    expect(task.status).toBe('BROADCASTING');
    expect(rows(ctx).find((l: any) => l.id === 'second-3').outcome).toBe('PENDING');
  });

  describe('when something returned the task to the pool without advancing the cycle', () => {
    /**
     * Not every route back to the pool is in this module. If one forgets the
     * cycle, the new search's round 1 meets the old search's row. The old
     * behaviour was to overwrite it. Now the row is left exactly as it was,
     * the round still goes out — a student is waiting — and it is logged as
     * an error.
     */
    it('leaves the existing row alone, sends the round, and says so', async () => {
      const { ctx, task } = keptWaiting();
      task.broadcastCycle = 1;
      const error = jest.spyOn((ctx.service as any).logger, 'error');

      await ctx.service.dispatchDueTasks();

      expect(rows(ctx)).toEqual(FIRST_SEARCH);
      expect(task).toMatchObject({ status: 'BROADCASTING', broadcastRound: 1 });
      expect(ctx.server.roomsFor(wsEvents.TASK_OFFER)).toEqual(['user:rider-1']);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/broadcast_cycle/));
    });
  });
});

describe('rebroadcastFromScratch and the cycle', () => {
  it('advances the cycle in the statement that restarts an unfulfilled search', async () => {
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, { status: 'UNFULFILLED', broadcastRound: 3, broadcastCycle: 4 });

    await ctx.service.rebroadcastFromScratch('task-1');

    expect(task.broadcastCycle).toBe(5);
    // One statement: the status and the cycle moved together.
    const restart = ctx.prisma.task.updateMany.mock.calls
      .map((c: any[]) => c[0])
      .find((args: any) => args.data.status === 'CREATED');
    expect(restart.where).toEqual({ id: 'task-1', status: 'UNFULFILLED', riderId: null });
    expect(restart.data.broadcastCycle).toEqual({ increment: 1 });
    expect(ctx.prisma.$rows('broadcastLog').map((l: any) => [l.cycle, l.round])).toEqual([[5, 1]]);
  });

  it('does not advance it again for a task its caller already returned to the pool', async () => {
    // Abandonment returns the task (and advances the cycle) in its own
    // UPDATE, then calls this to broadcast at once. One abandonment, one cycle.
    const ctx = buildDispatch();
    const { task } = seedTask(ctx.prisma, { status: 'CREATED', broadcastRound: 0, broadcastCycle: 2 });

    await ctx.service.rebroadcastFromScratch('task-1');

    expect(task).toMatchObject({ status: 'BROADCASTING', broadcastRound: 1, broadcastCycle: 2 });
  });

  describe('closing the log of earlier searches', () => {
    /**
     * After returning a task to the pool this method resolves rows an earlier
     * search left PENDING. It must never touch a row of the task's *current*
     * cycle — and "current" has to be judged by the statement that writes,
     * not by a check made before it.
     *
     * On the abandon path the task is already CREATED when this runs, so no
     * UPDATE here holds its row. A dispatch tick is free to commit round 1 of
     * the new search at any moment. A guard of the form "is the task still in
     * the pool? then expire everything PENDING" can be passed just before
     * that commit and acted on just after it — stamping the round that is
     * live, the one riders are looking at, as EXPIRED.
     */
    const open = (id: string, cycle: number, round: number) => ({
      id,
      taskId: 'task-1',
      cycle,
      round,
      outcome: 'PENDING',
      resolvedAt: null,
    });
    const row = (ctx: Ctx, id: string) => ctx.prisma.$rows('broadcastLog').find((l: any) => l.id === id);

    it('leaves the live round alone and closes the older search\'s, when a tick got there first', async () => {
      // The state a moment after the race: the tick has sent round 1 of
      // cycle 2. An earlier search also left a row open.
      const ctx = buildDispatch();
      const { task } = seedTask(ctx.prisma, { ...onOffer(1), broadcastCycle: 2 });
      ctx.prisma.$seed('broadcastLog', [
        open('older-search', 1, 3),
        open('live-round', 2, 1),
        { ...open('other-task', 1, 1), taskId: 'task-other' },
      ]);

      await ctx.service.rebroadcastFromScratch('task-1');

      expect(row(ctx, 'live-round')).toEqual(open('live-round', 2, 1));
      expect(row(ctx, 'older-search')).toMatchObject({ outcome: 'EXPIRED', resolvedAt: expect.any(Date) });
      expect(row(ctx, 'other-task')).toMatchObject({ outcome: 'PENDING', resolvedAt: null });
      // And the task itself was not disturbed.
      expect(task).toMatchObject({ status: 'BROADCASTING', broadcastRound: 1, broadcastCycle: 2 });
    });

    it('does not expire the live round when the tick commits at the last moment before the write', async () => {
      // The race itself. An abandoned task is in the pool on cycle 2, with a
      // row an earlier search left open. `tickCommits` is the dispatcher
      // sending round 1 of cycle 2; it is made to happen at the last possible
      // instant before this method writes to the log — after any check the
      // method might make first, before the write. (Hooked on both things a
      // version of this method could do immediately before writing, so the
      // test does not depend on which it does.)
      const ctx = buildDispatch();
      const { task } = seedTask(ctx.prisma, { status: 'CREATED', broadcastRound: 0, broadcastCycle: 2 });
      ctx.prisma.$seed('broadcastLog', [open('older-search', 1, 3)]);

      let committed = false;
      const tickCommits = () => {
        if (committed) return;
        committed = true;
        Object.assign(task, onOffer(1));
        ctx.prisma.$seed('broadcastLog', [open('live-round', 2, 1)]);
      };

      const count = ctx.prisma.task.count.getMockImplementation()!;
      ctx.prisma.task.count.mockImplementation(async (args: unknown) => {
        const pooled = await count(args);
        tickCommits();
        return pooled;
      });
      const executeRaw = ctx.prisma.$executeRaw.getMockImplementation()!;
      ctx.prisma.$executeRaw.mockImplementation(async (...args: unknown[]) => {
        tickCommits();
        return executeRaw(...args);
      });

      await ctx.service.rebroadcastFromScratch('task-1');

      expect(committed).toBe(true);
      expect(row(ctx, 'live-round')).toEqual(open('live-round', 2, 1));
      expect(row(ctx, 'older-search')).toMatchObject({ outcome: 'EXPIRED', resolvedAt: expect.any(Date) });
    });

    it('decides "older" in the statement that writes, with no check before it', async () => {
      // No read of the task stands between entering the transaction and the
      // UPDATE of the log: there is nothing for a tick to slip in behind.
      const ctx = buildDispatch();
      seedTask(ctx.prisma, { ...onOffer(1), broadcastCycle: 2 });
      ctx.prisma.$seed('broadcastLog', [open('older-search', 1, 3), open('live-round', 2, 1)]);

      await ctx.service.rebroadcastFromScratch('task-1');

      expect(ctx.prisma.task.count).not.toHaveBeenCalled();
      expect(ctx.prisma.broadcastLog.updateMany).not.toHaveBeenCalled();
      const [sql] = ctx.prisma.$executeRaw.mock.calls.at(-1) as [TemplateStringsArray];
      expect(sql.join('?')).toMatch(/cycle\s*<\s*\(\s*SELECT\s+broadcast_cycle\s+FROM\s+"task"/);
    });

    it('closes the search that just ran out when it restarts an unfulfilled task', async () => {
      // The restart advances the cycle in the same transaction, so the search
      // that was unfulfilled is now an older one.
      const ctx = buildDispatch();
      const { task } = seedTask(ctx.prisma, { status: 'UNFULFILLED', broadcastRound: 3, broadcastCycle: 1 });
      ctx.prisma.$seed('broadcastLog', [open('ran-out', 1, 3)]);

      await ctx.service.rebroadcastFromScratch('task-1');

      expect(task.broadcastCycle).toBe(2);
      expect(row(ctx, 'ran-out')).toMatchObject({ outcome: 'EXPIRED', resolvedAt: expect.any(Date) });
      expect(ctx.prisma.$rows('broadcastLog').filter((l: any) => l.outcome === 'PENDING').map((l: any) => [l.cycle, l.round])).toEqual([[2, 1]]);
    });

    it('never deletes', async () => {
      const ctx = buildDispatch();
      seedTask(ctx.prisma, { ...onOffer(1), broadcastCycle: 2 });
      ctx.prisma.$seed('broadcastLog', [open('older-search', 1, 3)]);

      await ctx.service.rebroadcastFromScratch('task-1');

      expect(ctx.prisma.$rows('broadcastLog')).toHaveLength(1);
      expect(ctx.prisma.broadcastLog.deleteMany).not.toHaveBeenCalled();
    });
  });

  it.each(['ASSIGNED', 'PICKED_UP', 'CANCELLED', 'COMPLETED'])(
    'neither restarts nor advances a %s task',
    async (status) => {
      const ctx = buildDispatch();
      const { task } = seedTask(ctx.prisma, {
        status,
        riderId: status === 'CANCELLED' ? null : 'rider-9',
        broadcastRound: 2,
        broadcastCycle: 3,
      });
      ctx.prisma.$seed('broadcastLog', [
        { id: 'log-2', cycle: 3, taskId: 'task-1', round: 2, outcome: 'ACCEPTED' },
      ]);
      const before = { ...task };

      await ctx.service.rebroadcastFromScratch('task-1');

      expect(task).toEqual(before);
      expect(ctx.prisma.$rows('broadcastLog')).toEqual([
        { id: 'log-2', cycle: 3, taskId: 'task-1', round: 2, outcome: 'ACCEPTED' },
      ]);
    },
  );
});
