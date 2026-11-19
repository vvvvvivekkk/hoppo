import { Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { RiderService } from './rider.service';
import { TenantService } from '../common/tenant/tenant.service';
import { WALLET_HEAD_ORDER } from '../wallet/wallet-ledger';
import { buildDispatch, wsEvents } from '../dispatch/test/fakes';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * The rider's side of a task: pickup and abandonment.
 *
 * The real RiderService, DispatchService and DispatchGateway run over a fake
 * database, Redis and Socket.IO server (see ../dispatch/test/fakes).
 *
 * A note on what these can and cannot show. Abandon-versus-pickup is a race,
 * and a race is only *proved* closed by two real transactions against a real
 * database. What a unit test can pin is the mechanism: that each side's write
 * is conditional on the task still being ASSIGNED to this rider, and that a
 * write which matches no row stops everything after it. That is what the
 * second half of this file does; the concurrent proof belongs to a harness.
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

/** An assigned shop-order task — a superset of every select that reads it. */
function assignedTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    collegeId: 'col-1',
    status: 'ASSIGNED',
    riderId: 'rider-1',
    type: 'SHOP_ORDER',
    requesterId: 'student-1',
    baseFeeMinor: 2000,
    orderId: 'order-1',
    chatRoom: { id: 'room-1' },
    order: {
      id: 'order-1',
      status: 'READY',
      reference: 'HP-0001',
      studentId: 'student-1',
      shopListing: { shop: { staff: [{ userId: 'staff-1' }] } },
    },
    ...overrides,
  };
}

function build() {
  const ctx = buildDispatch();
  const audit = { record: jest.fn(), recordInTransaction: jest.fn() };
  const storage = {};

  const Service = RiderService as unknown as new (...args: unknown[]) => RiderService;
  const service = new Service(
    ctx.prisma,
    ctx.redis,
    audit,
    storage,
    new TenantService(),
    ctx.service,
    ctx.gateway,
  );

  ctx.prisma.task.findUnique.mockResolvedValue(assignedTask());
  ctx.prisma.riderReliability.upsert.mockResolvedValue({ tasksAbandoned: 1 });
  return { ...ctx, rider: service };
}

/** The `code` of the structured error a rejected call carried. */
async function codeOf(call: Promise<unknown>): Promise<string> {
  const error: any = await call.then(
    () => {
      throw new Error('expected the call to be refused, but it succeeded');
    },
    (e: unknown) => e,
  );
  const response = error?.getResponse?.();
  if (!response?.code) throw error;
  return response.code;
}

// ===========================================================================
// (a) M7 — pickup is announced to the task's own people
// ===========================================================================

describe('who is told when an order is picked up (M7)', () => {
  /**
   * Before: both events went to `college:<id>`. Fails on that — the college
   * room appears, the user rooms do not.
   */
  it('tells the requester, the rider and the shop — task and order — and not the college', async () => {
    const ctx = build();

    const result = await ctx.rider.confirmPickup(rider, 'task-1', {} as never);
    expect(result).toMatchObject({ taskId: 'task-1', status: 'PICKED_UP' });

    const everyone = ['user:rider-1', 'user:staff-1', 'user:student-1'];

    const taskEvents = ctx.server.of(wsEvents.TASK_STATUS_CHANGED);
    expect(taskEvents).toHaveLength(1);
    expect([...taskEvents[0]!.rooms].sort()).toEqual(everyone);
    expect(taskEvents[0]!.payload).toEqual({ taskId: 'task-1', status: 'PICKED_UP' });

    const orderEvents = ctx.server.of(wsEvents.ORDER_STATUS_CHANGED);
    expect(orderEvents).toHaveLength(1);
    expect([...orderEvents[0]!.rooms].sort()).toEqual(everyone);
    expect(orderEvents[0]!.payload).toEqual({ orderId: 'order-1', status: 'PICKED_UP' });

    expect(ctx.server.toCollegeRooms()).toEqual([]);
  });

  it('sends the handover code to the requester alone', async () => {
    const ctx = build();

    await ctx.rider.confirmPickup(rider, 'task-1', {} as never);

    const codes = ctx.server.of(wsEvents.HANDOVER_CODE_ISSUED);
    expect(codes).toHaveLength(1);
    expect(codes[0]!.rooms).toEqual(['user:student-1']);
    expect(codes[0]!.payload.code).toMatch(/^\d{6}$/);
  });
});

// ===========================================================================
// (f) M4 — abandon and pickup are each one conditional UPDATE
// ===========================================================================

describe('confirmPickup when the task is no longer this rider\'s to pick up (M4)', () => {
  /**
   * The read at the top of confirmPickup says ASSIGNED; by the time the write
   * runs, an abandon has committed and the UPDATE matches no row.
   *
   * Before: the write was an unconditional `task.update`, which cannot match
   * no row — pickup "succeeded" on a task with no rider, moved the order to
   * PICKED_UP and issued a handover code. These fail on that: the call
   * resolves instead of being refused.
   */
  function abandonWonTheRace() {
    const ctx = build();
    ctx.prisma.task.updateMany.mockResolvedValue({ count: 0 });
    return ctx;
  }

  it('makes the write conditional on rider and status', async () => {
    const ctx = build();

    await ctx.rider.confirmPickup(rider, 'task-1', {} as never);

    expect(ctx.prisma.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'task-1', riderId: 'rider-1', status: 'ASSIGNED' },
        data: expect.objectContaining({ status: 'PICKED_UP' }),
      }),
    );
    expect(ctx.prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'order-1', status: 'READY' } }),
    );
  });

  it('refuses with NOT_AWAITING_PICKUP when the write matches no row', async () => {
    const ctx = abandonWonTheRace();

    expect(await codeOf(ctx.rider.confirmPickup(rider, 'task-1', {} as never))).toBe(
      'NOT_AWAITING_PICKUP',
    );
  });

  it('then leaves the order alone, issues no code and announces nothing', async () => {
    const ctx = abandonWonTheRace();

    await codeOf(ctx.rider.confirmPickup(rider, 'task-1', {} as never));

    expect(ctx.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(ctx.prisma.order.update).not.toHaveBeenCalled();
    expect(ctx.server.emissions).toEqual([]);
  });

  it('rolls the pickup back when the order is no longer READY', async () => {
    const ctx = build();
    ctx.prisma.order.updateMany.mockResolvedValue({ count: 0 });

    expect(await codeOf(ctx.rider.confirmPickup(rider, 'task-1', {} as never))).toBe(
      'SHOP_NOT_READY',
    );
    expect(ctx.server.emissions).toEqual([]);
  });
});

describe('abandonTask when the task is no longer this rider\'s to abandon (M4)', () => {
  /**
   * The mirror image: the read says ASSIGNED, a pickup commits, the abandon's
   * UPDATE matches no row.
   *
   * Before: an unconditional update un-assigned a task whose pickup had just
   * committed, counted an abandonment, and re-broadcast an order the rider
   * was already carrying. Fails on that: the call resolves.
   */
  function pickupWonTheRace() {
    const ctx = build();
    ctx.prisma.task.updateMany.mockResolvedValue({ count: 0 });
    return ctx;
  }

  it('makes the write conditional on rider and status', async () => {
    const ctx = build();

    const result = await ctx.rider.abandonTask(rider, 'task-1', { reason: 'Bike broke down' } as never);
    expect(result).toMatchObject({ taskId: 'task-1', abandoned: true });

    expect(ctx.prisma.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'task-1', riderId: 'rider-1', status: 'ASSIGNED' },
        data: expect.objectContaining({ status: 'CREATED', riderId: null }),
      }),
    );
  });

  it('refuses with CANNOT_ABANDON when the write matches no row', async () => {
    const ctx = pickupWonTheRace();

    expect(
      await codeOf(ctx.rider.abandonTask(rider, 'task-1', { reason: 'Changed my mind' } as never)),
    ).toBe('CANNOT_ABANDON');
  });

  it('then releases nobody, records no abandonment and re-broadcasts nothing', async () => {
    const ctx = pickupWonTheRace();

    await codeOf(ctx.rider.abandonTask(rider, 'task-1', { reason: 'Changed my mind' } as never));

    expect(ctx.prisma.riderState.updateMany).not.toHaveBeenCalled();
    expect(ctx.prisma.riderState.update).not.toHaveBeenCalled();
    expect(ctx.prisma.riderReliability.upsert).not.toHaveBeenCalled();
    expect(ctx.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(ctx.redis.markRiderFree).not.toHaveBeenCalled();
    expect(ctx.redis.findRidersNear).not.toHaveBeenCalled();
    expect(ctx.server.emissions).toEqual([]);
  });
});

// ===========================================================================
// Settlement and the wallet ledger
// ===========================================================================

describe('the ledger entries a completed delivery writes', () => {
  /**
   * A wallet's balance is whatever its latest entry says, so "latest" must
   * have one answer. Completion writes two entries for the rider in one
   * transaction — the fee, then an errand reimbursement — within the same
   * millisecond.
   *
   * The ledger fake below is a list: `findFirst` returns the newest row by
   * the `createdAt` it was given, `create` appends. The rider's existing head
   * entry is stamped an hour ahead, so "strictly after the head" is visible
   * without freezing the clock.
   *
   * Before: `orderBy: { createdAt: 'desc' }`, one read reused for both
   * entries, and no `createdAt` passed at all. Every test here fails on that.
   */
  const HEAD_AT = new Date(Date.now() + 3_600_000);

  async function completeErrand() {
    const ctx = build();

    const ledger: { userId: string; balanceAfterMinor: number; createdAt: Date; type?: string }[] = [
      { userId: 'rider-1', balanceAfterMinor: 7_000, createdAt: HEAD_AT },
    ];
    ctx.prisma.walletEntry.findFirst.mockImplementation(async (args: any) => {
      const rows = ledger.filter((r) => r.userId === args.where.userId);
      return rows.length === 0 ? null : rows.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    });
    ctx.prisma.walletEntry.create.mockImplementation(async (args: any) => {
      // A row with no timestamp gets "now", as the column default would.
      ledger.push({ ...args.data, createdAt: args.data.createdAt ?? new Date() });
      return { id: `entry-${ledger.length}` };
    });

    // A peer errand with a reimbursement: two rider entries. An errand has
    // no order and is settled in cash between the two students (ADR-006).
    const pickedUp = assignedTask({
      status: 'PICKED_UP',
      type: 'PEER_ERRAND',
      otpHash: 'unused-by-the-fix',
      otpAttempts: 0,
      feeMinor: 2_500,
      reimbursementMinor: 800,
      assignedAt: new Date(Date.now() - 600_000),
      pickedUpAt: new Date(Date.now() - 300_000),
      orderId: null,
      order: null,
    });
    ctx.prisma.task.findUnique.mockResolvedValue(pickedUp);
    ctx.prisma.task.findUniqueOrThrow.mockResolvedValue(pickedUp);
    ctx.prisma.collegeConfig.findUnique.mockResolvedValue({ maxOtpAttempts: 5 });
    // The atomic attempt counter hands back the hash it counted against.
    ctx.prisma.$queryRaw.mockResolvedValue([
      { otpAttempts: 1, otpHash: await argon2.hash('482913', { type: argon2.argon2id }) },
    ]);

    const result = await ctx.rider.submitHandoverCode(rider, 'task-1', { code: '482913' } as never);
    expect(result).toMatchObject({ taskId: 'task-1', status: 'COMPLETED', feeMinor: 2_500 });

    const riderEntries = ctx.prisma.walletEntry.create.mock.calls
      .map((call: any[]) => call[0].data)
      .filter((data: any) => data.userId === 'rider-1');
    expect(riderEntries.map((e: any) => e.type)).toEqual([
      'DELIVERY_FEE_EARNED',
      'ERRAND_REIMBURSEMENT',
    ]);
    return { ctx, fee: riderEntries[0], reimbursement: riderEntries[1] };
  }

  it('reads the wallet head with the shared tie-break ordering, every time', async () => {
    const { ctx } = await completeErrand();

    const reads = ctx.prisma.walletEntry.findFirst.mock.calls.map((call: any[]) => call[0]);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.orderBy).toEqual([...WALLET_HEAD_ORDER]);
    }
  });

  it('re-reads the head before the second entry rather than reusing one read', async () => {
    const { ctx } = await completeErrand();

    const riderReads = ctx.prisma.walletEntry.findFirst.mock.calls.filter(
      (call: any[]) => call[0].where.userId === 'rider-1',
    );
    expect(riderReads).toHaveLength(2);
  });

  it('stamps each entry strictly after the one before it', async () => {
    const { fee, reimbursement } = await completeErrand();

    expect(fee.createdAt).toEqual(new Date(HEAD_AT.getTime() + 1));
    expect(reimbursement.createdAt).toEqual(new Date(HEAD_AT.getTime() + 2));
  });

  it('keeps the balances it always wrote', async () => {
    const { fee, reimbursement } = await completeErrand();

    // Cash-settled: both are statement lines, so the withdrawable balance
    // is carried through unchanged from the head entry.
    expect(fee).toMatchObject({ amountMinor: 2_500, balanceAfterMinor: 7_000 });
    expect(reimbursement).toMatchObject({ amountMinor: 800, balanceAfterMinor: 7_000 });
  });
});
