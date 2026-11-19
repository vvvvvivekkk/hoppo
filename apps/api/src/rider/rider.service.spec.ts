import { Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { RiderService } from './rider.service';
import { TenantService } from '../common/tenant/tenant.service';
import { WALLET_HEAD_ORDER } from '../wallet/wallet-ledger';
import { buildDispatch, wsEvents } from '../dispatch/test/fakes';
import { codeOf, seedChatRoom, seedRider, seedTask } from '../dispatch/test/world';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * The rider's side of a task: pickup, abandonment, handover and settlement.
 *
 * The real RiderService, DispatchService and DispatchGateway run over an
 * in-memory database that holds rows and evaluates every `where`
 * (../dispatch/test/fakes).
 *
 * Most of this file is about one idea. Every write here is a conditional
 * UPDATE: it names the state it expects — this task, this rider, this status
 * — and changes nothing if the row has moved on. The way to test a condition
 * is to seed the row that only that condition refuses, let the service read
 * a stale copy (which is all a race is, from one request's point of view),
 * and look at the rows afterwards.
 *
 * What these cannot show is two real transactions interleaving. That proof is
 * the live harnesses in apps/api/test (race-abandon-pickup.py,
 * race-payout.py, race-otp-cap.py); these pin the mechanism those rely on.
 */

beforeAll(() => {
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

const rider: AuthenticatedUser = {
  userId: 'rider-1',
  collegeId: 'col-1',
  role: 'STUDENT',
  isVerified: true,
};

const requester: AuthenticatedUser = {
  userId: 'student-1',
  collegeId: 'col-1',
  role: 'STUDENT',
  isVerified: true,
};

const HANDOVER_CODE = '482913';
let handoverHash: string;

beforeAll(async () => {
  // A real Argon2id hash of a real code: the service verifies it for real.
  handoverHash = await argon2.hash(HANDOVER_CODE, { type: argon2.argon2id });
});

/**
 * rider-1 holding task-1, ASSIGNED, its shop order READY — unless told
 * otherwise. `order: null` makes it a peer errand.
 */
function build(task: Record<string, unknown> = {}, order: Record<string, unknown> | null = {}) {
  const ctx = buildDispatch();
  const world = seedTask(
    ctx.prisma,
    { status: 'ASSIGNED', riderId: 'rider-1', broadcastRound: 1, assignedAt: new Date(Date.now() - 600_000), ...task },
    order === null ? null : { status: 'READY', ...order },
  );
  const state = seedRider(ctx.prisma, 'rider-1', { activeTaskId: 'task-1' });
  const room = seedChatRoom(ctx.prisma, world.task, ['student-1', 'staff-1', 'owner-1', 'rider-1']);

  const Service = RiderService as unknown as new (...args: unknown[]) => RiderService;
  const service = new Service(
    ctx.prisma,
    ctx.redis,
    { record: jest.fn(), recordInTransaction: jest.fn() },
    {},
    new TenantService(),
    ctx.service,
    ctx.gateway,
  );

  return { ...ctx, rider: service, task: world.task, order: world.order, state, room };
}

/** rider-1 carrying the order: PICKED_UP, with a live handover code. */
function carrying(task: Record<string, unknown> = {}, order: Record<string, unknown> | null = {}) {
  return build(
    { status: 'PICKED_UP', pickedUpAt: new Date(Date.now() - 300_000), otpHash: handoverHash, otpAttempts: 0, ...task },
    order === null ? null : { status: 'PICKED_UP', ...order },
  );
}

type World = ReturnType<typeof build>;

/**
 * Make the service's next read of the task a copy taken *now*, then change
 * the row underneath it — "somebody else committed in between".
 */
function movedOn(world: World, actual: Record<string, unknown>, orderActual: Record<string, unknown> = {}) {
  const asRead = { ...world.task, order: world.order ? { ...world.order } : null };
  Object.assign(world.task, actual);
  if (world.order) Object.assign(world.order, orderActual);
  world.prisma.$staleRead('task', asRead);
}

// ===========================================================================
// Pickup
// ===========================================================================

describe('confirmPickup', () => {
  it('moves the task and the order to PICKED_UP together and issues a code', async () => {
    const world = build();

    const result = await world.rider.confirmPickup(rider, 'task-1', {} as never);

    expect(result).toMatchObject({ taskId: 'task-1', status: 'PICKED_UP' });
    expect(world.task).toMatchObject({ status: 'PICKED_UP', riderId: 'rider-1', otpAttempts: 0 });
    expect(world.task.otpHash).toMatch(/^\$argon2id\$/);
    expect(world.order).toMatchObject({ status: 'PICKED_UP' });
  });

  it('tells the requester, the rider and the shop — task and order — and not the college (M7)', async () => {
    const world = build();

    await world.rider.confirmPickup(rider, 'task-1', {} as never);

    const everyone = ['user:owner-1', 'user:rider-1', 'user:staff-1', 'user:student-1'];

    const taskEvents = world.server.of(wsEvents.TASK_STATUS_CHANGED);
    expect(taskEvents).toHaveLength(1);
    expect([...taskEvents[0]!.rooms].sort()).toEqual(everyone);
    expect(taskEvents[0]!.payload).toEqual({ taskId: 'task-1', status: 'PICKED_UP' });

    const orderEvents = world.server.of(wsEvents.ORDER_STATUS_CHANGED);
    expect(orderEvents).toHaveLength(1);
    expect([...orderEvents[0]!.rooms].sort()).toEqual(everyone);
    expect(orderEvents[0]!.payload).toEqual({ orderId: 'order-1', status: 'PICKED_UP' });

    expect(world.server.toCollegeRooms()).toEqual([]);
  });

  it('sends the handover code to the requester alone, and the code is the one stored', async () => {
    const world = build();

    await world.rider.confirmPickup(rider, 'task-1', {} as never);

    const codes = world.server.of(wsEvents.HANDOVER_CODE_ISSUED);
    expect(codes).toHaveLength(1);
    expect(codes[0]!.rooms).toEqual(['user:student-1']);
    expect(codes[0]!.payload.code).toMatch(/^\d{6}$/);
    expect(await argon2.verify(world.task.otpHash, codes[0]!.payload.code)).toBe(true);
  });

  describe('when the task moved on after it was read (M4)', () => {
    /** Refused, nothing written, nobody told. */
    async function refusedWith(world: World, code: string) {
      const taskBefore = { ...world.task };
      const orderBefore = { ...world.order };

      expect(await codeOf(world.rider.confirmPickup(rider, 'task-1', {} as never))).toBe(code);

      expect(world.task).toEqual(taskBefore);
      expect(world.order).toEqual(orderBefore);
      expect(world.server.emissions).toEqual([]);
    }

    it('refuses once the rider has abandoned it', async () => {
      const world = build();
      movedOn(world, { status: 'CREATED', riderId: null, assignedAt: null });

      await refusedWith(world, 'NOT_AWAITING_PICKUP');
    });

    it('refuses a second pickup, keeping the first code — `status: ASSIGNED`', async () => {
      // A double tap. Same rider, same task: only the status tells the second
      // request it is too late. Without it the second request would replace
      // the handover code the requester has already been sent.
      const world = build();
      movedOn(world, { status: 'PICKED_UP', otpHash: handoverHash, otpAttempts: 2 }, { status: 'PICKED_UP' });

      await refusedWith(world, 'NOT_AWAITING_PICKUP');
      expect(world.task.otpHash).toBe(handoverHash);
    });

    it('refuses a task that now belongs to another rider — `riderId`', async () => {
      // Abandoned, re-offered and accepted by rider-2 while this request was
      // in flight. Still ASSIGNED: only the rider tells it apart.
      const world = build();
      movedOn(world, { riderId: 'rider-2' });

      await refusedWith(world, 'NOT_AWAITING_PICKUP');
    });

    it('rolls the task back when the order is no longer READY — the order\'s `status`', async () => {
      const world = build();
      movedOn(world, {}, { status: 'CANCELLED' });

      await refusedWith(world, 'SHOP_NOT_READY');
      expect(world.task).toMatchObject({ status: 'ASSIGNED', otpHash: null });
    });
  });
});

// ===========================================================================
// Abandon
// ===========================================================================

describe('abandonTask', () => {
  const reason = { reason: 'Bike broke down' } as never;

  it('returns the task to the pool at round 0 and frees the rider', async () => {
    const world = build({ broadcastRound: 2, feeMinor: 2500 });

    const result = await world.rider.abandonTask(rider, 'task-1', reason);

    expect(result).toMatchObject({ taskId: 'task-1', abandoned: true, barred: false });
    expect(world.task.riderId).toBeNull();
    // Straight back on offer: a fresh search at the base fee.
    expect(world.task).toMatchObject({ status: 'BROADCASTING', broadcastRound: 1, feeMinor: 2000 });
    expect(world.state.activeTaskId).toBeNull();
    expect(world.prisma.$rows('riderReliability')[0]).toMatchObject({ userId: 'rider-1', tasksAbandoned: 1 });
  });

  it('archives the chat room and marks the rider as having left it', async () => {
    const world = build();

    await world.rider.abandonTask(rider, 'task-1', reason);

    expect(world.room.isArchived).toBe(true);
    const left = world.prisma.$rows('chatMember').filter((m: any) => m.leftAt != null);
    expect(left.map((m: any) => m.userId)).toEqual(['rider-1']);
  });

  it('tells the requester and the shop, and not the college (M7)', async () => {
    const world = build();

    await world.rider.abandonTask(rider, 'task-1', reason);

    const events = world.server.of(wsEvents.TASK_STATUS_CHANGED);
    expect(events).toHaveLength(1);
    expect([...events[0]!.rooms].sort()).toEqual([
      'user:owner-1',
      'user:rider-1',
      'user:staff-1',
      'user:student-1',
    ]);
    expect(events[0]!.payload).toEqual({ taskId: 'task-1', status: 'CREATED', reason: 'RIDER_ABANDONED' });
    expect(world.server.toCollegeRooms()).toEqual([]);
  });

  it('releases only the task being abandoned — `activeTaskId: taskId`', async () => {
    // rider_state says the rider holds something else. Abandoning task-1 must
    // not clear that: a blind `activeTaskId: null` would free a rider who is
    // in the middle of a different delivery.
    const world = build();
    world.state.activeTaskId = 'task-other';

    await world.rider.abandonTask(rider, 'task-1', reason);

    expect(world.task.riderId).toBeNull();
    expect(world.state.activeTaskId).toBe('task-other');
  });

  describe('when the task moved on after it was read (M4)', () => {
    /** Refused; no abandonment counted; nobody released, re-offered or told. */
    async function refused(world: World) {
      const taskBefore = { ...world.task };

      expect(await codeOf(world.rider.abandonTask(rider, 'task-1', reason))).toBe('CANNOT_ABANDON');

      expect(world.task).toEqual(taskBefore);
      expect(world.state.activeTaskId).toBe('task-1');
      expect(world.room.isArchived).toBe(false);
      expect(world.prisma.$rows('riderReliability')).toEqual([]);
      expect(world.prisma.$rows('auditLog')).toEqual([]);
      expect(world.redis.markRiderFree).not.toHaveBeenCalled();
      expect(world.redis.findRidersNear).not.toHaveBeenCalled();
      expect(world.server.emissions).toEqual([]);
    }

    it('refuses once the pickup has committed — `status: ASSIGNED`', async () => {
      // Same rider, same task, now carrying the food. Without the status the
      // task would be un-assigned with the order PICKED_UP and a live code.
      const world = build();
      movedOn(world, { status: 'PICKED_UP', otpHash: handoverHash }, { status: 'PICKED_UP' });

      await refused(world);
      expect(world.order!.status).toBe('PICKED_UP');
    });

    it('refuses a task that now belongs to another rider — `riderId`', async () => {
      const world = build();
      movedOn(world, { riderId: 'rider-2' });

      await refused(world);
    });
  });
});

// ===========================================================================
// Handover code re-issue (requester)
// ===========================================================================

describe('reissueHandoverCode', () => {
  it('replaces the code and resets the attempts while the rider is carrying the order', async () => {
    const world = carrying({ otpAttempts: 4 });

    const result = await world.rider.reissueHandoverCode(requester, 'task-1');

    expect(world.task.otpAttempts).toBe(0);
    expect(world.task.otpHash).not.toBe(handoverHash);
    expect(await argon2.verify(world.task.otpHash, result.code)).toBe(true);
    expect(world.server.roomsFor(wsEvents.HANDOVER_CODE_ISSUED)).toEqual(['user:student-1']);
  });

  it('plants no code on a delivery that completed a moment ago — `status: PICKED_UP`', async () => {
    // The requester's read said PICKED_UP; the rider's correct code landed
    // before the write. Completion cleared the hash. Without the status
    // condition a live handover code would be written onto a finished task.
    const world = carrying();
    movedOn(world, { status: 'COMPLETED', otpHash: null }, { status: 'COMPLETED' });

    expect(await codeOf(world.rider.reissueHandoverCode(requester, 'task-1'))).toBe('CODE_NOT_APPLICABLE');

    expect(world.task).toMatchObject({ status: 'COMPLETED', otpHash: null });
    expect(world.server.emissions).toEqual([]);
  });

  it('is refused to anyone but the requester', async () => {
    const world = carrying();

    expect(await codeOf(world.rider.reissueHandoverCode(rider, 'task-1'))).toBe('NOT_YOUR_TASK');
    expect(world.task.otpHash).toBe(handoverHash);
  });
});

// ===========================================================================
// Handover: the attempt counter
// ===========================================================================

describe('submitHandoverCode: wrong codes (M1, M2)', () => {
  const wrong = { code: '000000' } as never;

  it('counts a wrong code and says how many attempts are left', async () => {
    const world = carrying();

    expect(await codeOf(world.rider.submitHandoverCode(rider, 'task-1', wrong))).toBe('OTP_INCORRECT');

    expect(world.task).toMatchObject({ status: 'PICKED_UP', otpAttempts: 1 });
  });

  it('escalates on the fifth wrong code and releases the rider', async () => {
    const world = carrying({ otpAttempts: 4 });

    expect(await codeOf(world.rider.submitHandoverCode(rider, 'task-1', wrong))).toBe(
      'OTP_ATTEMPTS_EXHAUSTED',
    );

    expect(world.task).toMatchObject({ status: 'ESCALATED', otpAttempts: 5, riderId: 'rider-1' });
    expect(world.state.activeTaskId).toBeNull();
    expect(world.redis.markRiderFree).toHaveBeenCalledWith('col-1', 'rider-1');
  });

  it('on escalation, releases the rider only from this task — `activeTaskId: taskId`', async () => {
    const world = carrying({ otpAttempts: 4 });
    world.state.activeTaskId = 'task-other';

    await codeOf(world.rider.submitHandoverCode(rider, 'task-1', wrong));

    expect(world.task.status).toBe('ESCALATED');
    expect(world.state.activeTaskId).toBe('task-other');
  });

  it('does not even look at a code once the cap is reached — `otp_attempts < max`', async () => {
    // The *correct* code, past the cap. If the cap were not part of the
    // UPDATE that counts, this would deliver.
    const world = carrying({ otpAttempts: 5 });

    expect(
      await codeOf(world.rider.submitHandoverCode(rider, 'task-1', { code: HANDOVER_CODE } as never)),
    ).toBe('OTP_ATTEMPTS_EXHAUSTED');

    expect(world.task).toMatchObject({ status: 'PICKED_UP', otpAttempts: 5 });
    expect(world.prisma.$rows('walletEntry')).toEqual([]);
  });
});

// ===========================================================================
// Handover: completion and settlement
// ===========================================================================

describe('submitHandoverCode: the correct code', () => {
  const correct = { code: HANDOVER_CODE } as never;

  it('completes the task and the order, frees the rider, and writes one fee entry', async () => {
    const world = carrying({}, { paymentMethod: 'ONLINE', paymentStatus: 'CAPTURED' });

    const result = await world.rider.submitHandoverCode(rider, 'task-1', correct);

    expect(result).toMatchObject({ taskId: 'task-1', status: 'COMPLETED', feeMinor: 2000 });
    expect(world.task).toMatchObject({ status: 'COMPLETED', otpHash: null });
    expect(world.order).toMatchObject({ status: 'COMPLETED' });
    expect(world.state.activeTaskId).toBeNull();

    const entries = world.prisma.$rows('walletEntry');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: 'rider-1',
      type: 'DELIVERY_FEE_EARNED',
      direction: 'CREDIT',
      amountMinor: 2000,
      balanceAfterMinor: 2000,
    });
    expect(world.prisma.$rows('riderReliability')[0]).toMatchObject({ userId: 'rider-1', tasksCompleted: 1 });
  });

  it('tells the requester, the rider and the shop, and not the college (M7)', async () => {
    const world = carrying();

    await world.rider.submitHandoverCode(rider, 'task-1', correct);

    const events = world.server.of(wsEvents.TASK_STATUS_CHANGED);
    expect(events).toHaveLength(1);
    expect([...events[0]!.rooms].sort()).toEqual([
      'user:owner-1',
      'user:rider-1',
      'user:staff-1',
      'user:student-1',
    ]);
    expect(events[0]!.payload).toEqual({ taskId: 'task-1', status: 'COMPLETED' });
    expect(world.server.toCollegeRooms()).toEqual([]);
  });

  it('pays once when the same correct code arrives twice — `status: PICKED_UP` (H4)', async () => {
    /**
     * Two requests carry the correct code. Both are counted and both verify;
     * the first then settles. This is the second, arriving at the settlement
     * UPDATE to find the task already COMPLETED by the same rider — so the
     * status is the only condition that can stop it. Without it, the rider is
     * paid twice in a ledger that cannot be edited.
     *
     * The first request's commit is simulated at the one point it can fall:
     * after this request's attempt was counted, before it settles.
     */
    const world = carrying({}, { paymentMethod: 'ONLINE', paymentStatus: 'CAPTURED' });
    world.prisma.$seed('walletEntry', [
      { id: 'paid-once', userId: 'rider-1', type: 'DELIVERY_FEE_EARNED', balanceAfterMinor: 2000, createdAt: new Date() },
    ]);

    const countAttempt = world.prisma.$queryRaw.getMockImplementation()!;
    world.prisma.$queryRaw.mockImplementationOnce(async (...args: unknown[]) => {
      const counted = await countAttempt(...args);
      Object.assign(world.task, { status: 'COMPLETED', otpHash: null });
      Object.assign(world.order!, { status: 'COMPLETED' });
      world.state.activeTaskId = null;
      return counted;
    });

    expect(await codeOf(world.rider.submitHandoverCode(rider, 'task-1', correct))).toBe(
      'NOT_AWAITING_HANDOVER',
    );

    expect(world.prisma.$rows('walletEntry').map((e: any) => e.id)).toEqual(['paid-once']);
    expect(world.prisma.$rows('riderReliability')).toEqual([]);
    expect(world.server.emissions).toEqual([]);
  });

  it('does not settle a task that now belongs to another rider — `riderId`', async () => {
    const world = carrying();

    const countAttempt = world.prisma.$queryRaw.getMockImplementation()!;
    world.prisma.$queryRaw.mockImplementationOnce(async (...args: unknown[]) => {
      const counted = await countAttempt(...args);
      world.task.riderId = 'rider-2';
      return counted;
    });

    expect(await codeOf(world.rider.submitHandoverCode(rider, 'task-1', correct))).toBe(
      'NOT_AWAITING_HANDOVER',
    );
    expect(world.task.status).toBe('PICKED_UP');
    expect(world.prisma.$rows('walletEntry')).toEqual([]);
  });

  it('rolls the whole settlement back when the order is not PICKED_UP', async () => {
    const world = carrying({}, { status: 'CANCELLED' });
    // The rider's read still shows the order as it was.
    world.prisma.$staleRead('task', { ...world.task, order: { ...world.order, status: 'PICKED_UP' } });

    expect(await codeOf(world.rider.submitHandoverCode(rider, 'task-1', correct))).toBe(
      'ORDER_NOT_AWAITING_HANDOVER',
    );

    expect(world.task).toMatchObject({ status: 'PICKED_UP', otpHash: handoverHash });
    expect(world.order!.status).toBe('CANCELLED');
    expect(world.state.activeTaskId).toBe('task-1');
    expect(world.prisma.$rows('walletEntry')).toEqual([]);
  });

  it('frees the rider only from the task being completed — `activeTaskId: taskId`', async () => {
    // As with abandon: if rider_state points at a different task, completing
    // this one must leave it pointing there.
    const world = carrying();
    world.state.activeTaskId = 'task-other';

    await world.rider.submitHandoverCode(rider, 'task-1', correct);

    expect(world.task.status).toBe('COMPLETED');
    expect(world.state.activeTaskId).toBe('task-other');
  });
});

describe('the ledger entries a completed delivery writes', () => {
  /**
   * A wallet's balance is whatever its latest entry says, so "latest" must
   * have one answer. A peer errand with a reimbursement writes two entries
   * for the rider in one transaction, in the same millisecond.
   *
   * The rider's existing head entry is stamped an hour ahead, so "strictly
   * after the head" is visible without freezing the clock.
   */
  const HEAD_AT = new Date(Date.now() + 3_600_000);

  async function completeErrand() {
    // An errand has no order and is settled in cash between the two students
    // (ADR-006), so both entries are statement lines.
    const world = carrying({ feeMinor: 2_500, reimbursementMinor: 800 }, null);
    world.prisma.$seed('walletEntry', [
      { id: 'entry-old', userId: 'rider-1', balanceAfterMinor: 1_000, createdAt: new Date(0) },
      { id: 'entry-head', userId: 'rider-1', balanceAfterMinor: 7_000, createdAt: HEAD_AT },
      { id: 'entry-other', userId: 'somebody-else', balanceAfterMinor: 99_000, createdAt: HEAD_AT },
    ]);

    const result = await world.rider.submitHandoverCode(rider, 'task-1', { code: HANDOVER_CODE } as never);
    expect(result).toMatchObject({ taskId: 'task-1', status: 'COMPLETED', feeMinor: 2_500 });

    const written = world.prisma.$rows('walletEntry').filter((e: any) => !String(e.id).startsWith('entry-'));
    expect(written.map((e: any) => [e.userId, e.type])).toEqual([
      ['rider-1', 'DELIVERY_FEE_EARNED'],
      ['rider-1', 'ERRAND_REIMBURSEMENT'],
    ]);
    return { world, fee: written[0], reimbursement: written[1] };
  }

  it('takes the rider\'s wallet lock before the settlement UPDATE', async () => {
    const { world } = await completeErrand();

    expect(world.prisma.$locks).toEqual(['rider-1']);
    const lockedAt = world.prisma.$executeRaw.mock.invocationCallOrder[0]!;
    expect(lockedAt).toBeLessThan(world.prisma.task.updateMany.mock.invocationCallOrder[0]!);
  });

  it('reads the wallet head with the shared tie-break ordering, every time', async () => {
    const { world } = await completeErrand();

    const reads = world.prisma.walletEntry.findFirst.mock.calls.map((call: any[]) => call[0]);
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.where).toEqual({ userId: 'rider-1' });
      expect(read.orderBy).toEqual([...WALLET_HEAD_ORDER]);
    }
  });

  it('stamps each entry strictly after the one before it', async () => {
    const { fee, reimbursement } = await completeErrand();

    expect(fee.createdAt).toEqual(new Date(HEAD_AT.getTime() + 1));
    expect(reimbursement.createdAt).toEqual(new Date(HEAD_AT.getTime() + 2));
  });

  it('builds on the rider\'s own latest balance', async () => {
    const { fee, reimbursement } = await completeErrand();

    // Cash-settled: both are statement lines, so the withdrawable balance is
    // carried through unchanged from the head entry — not from the older
    // entry, and not from somebody else's.
    expect(fee).toMatchObject({ amountMinor: 2_500, balanceAfterMinor: 7_000 });
    expect(reimbursement).toMatchObject({ amountMinor: 800, balanceAfterMinor: 7_000 });
  });
});
