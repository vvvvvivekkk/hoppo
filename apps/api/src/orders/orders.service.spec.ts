import { ConflictException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * Money and state on the paths that end an order early.
 *
 * The real OrdersService and TenantService run against a small in-memory
 * stand-in for the database. The stand-in is deliberately dumb about the
 * service and strict about the database's own rules, because those rules are
 * what the fixes lean on:
 *
 *   - `updateMany` only touches a row whose status matches the WHERE clause,
 *     and reports how many it touched — the conditional UPDATE of ADR-001;
 *   - `broadcastLog.deleteMany` throws, as the append-only trigger does;
 *   - the "latest" wallet entry is found by the ORDER BY it is given.
 *
 * Real concurrency is not simulated here; `apps/api/test/race-refund.py`
 * does that against PostgreSQL. What a loser of that race sees is: the order
 * it read as PLACED is CANCELLED by the time its transaction reads it again.
 * `orderMovesAfterFirstRead` reproduces exactly that sequence.
 */

const STUDENT: AuthenticatedUser = {
  userId: 'student-1',
  collegeId: 'col-1',
  role: 'STUDENT',
  isVerified: true,
};
const SHOP: AuthenticatedUser = {
  userId: 'owner-1',
  collegeId: 'col-1',
  role: 'SHOP_OWNER',
  isVerified: false,
  shopApproved: true,
};

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) =>
    want !== null && typeof want === 'object' && 'in' in want
      ? (want.in as unknown[]).includes(row[key])
      : row[key] === want,
  );
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && 'decrement' in value) {
      row[key] -= value.decrement as number;
    } else {
      row[key] = value;
    }
  }
}

function build(seed: { order?: Row; task?: Row; entries?: Row[]; logs?: Row[] } = {}) {
  const order: Row = {
    id: 'order-1',
    collegeId: 'col-1',
    studentId: 'student-1',
    shopListingId: 'listing-1',
    status: 'PLACED',
    reference: 'HP-TEST123',
    paymentMethod: 'WALLET',
    paymentStatus: 'HELD',
    totalMinor: 3500,
    deliveryFeeMinor: 1000,
    statedPrepMinutes: 15,
    placedAt: new Date(),
    shopListing: { college: { config: null } },
    ...seed.order,
  };
  const task: Row = { id: 'task-1', status: 'CREATED', baseFeeMinor: 1000, ...seed.task };
  const entries: Row[] = seed.entries ?? [
    // The hold written at placement: 5000 in the wallet, 3500 held.
    {
      userId: 'student-1',
      type: 'ORDER_HOLD',
      direction: 'DEBIT',
      amountMinor: 3500,
      balanceAfterMinor: 1500,
      createdAt: new Date(Date.now() - 60_000),
    },
  ];
  const logs: Row[] = seed.logs ?? [];
  const headReads: unknown[] = [];
  let orderReads = 0;
  // Things "someone else" does to the rows straight after this request's
  // n-th read of the order, keyed by n.
  const afterOrderRead = new Map<number, () => void>();
  let taskReads = 0;
  const afterTaskRead = new Map<number, () => void>();

  const prisma: Row = {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    $executeRaw: jest.fn().mockResolvedValue(1),
    order: {
      findUnique: jest.fn(async () => {
        const snapshot = { ...order, task: { ...task } };
        orderReads += 1;
        afterOrderRead.get(orderReads)?.();
        return snapshot;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(order, where)) return { count: 0 };
        apply(order, data);
        return { count: 1 };
      }),
      // The unconditional write. The service no longer uses it on these
      // paths; it is here so this spec also runs against the code from before
      // the fixes and fails there on the behaviour, not on a missing mock.
      update: jest.fn(async ({ data }: { data: Row }) => {
        apply(order, data);
        return { ...order };
      }),
    },
    task: {
      findUnique: jest.fn(async () => {
        const snapshot = { ...task };
        taskReads += 1;
        afterTaskRead.get(taskReads)?.();
        return snapshot;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(task, where)) return { count: 0 };
        apply(task, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: { data: Row }) => {
        apply(task, data);
        return { ...task };
      }),
    },
    walletEntry: {
      findFirst: jest.fn(async ({ orderBy }: { orderBy: unknown }) => {
        headReads.push(orderBy);
        // Latest by createdAt; among equals, the later insert.
        return (
          entries
            .map((entry, index) => ({ entry, index }))
            .sort(
              (a, b) =>
                b.entry.createdAt.getTime() - a.entry.createdAt.getTime() || b.index - a.index,
            )[0]?.entry ?? null
        );
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        entries.push({ createdAt: new Date(), ...data });
        return data;
      }),
    },
    broadcastLog: {
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = logs.filter((log) => matches(log, where));
        hit.forEach((log) => apply(log, data));
        return { count: hit.length };
      }),
      deleteMany: jest.fn(async () => {
        throw new Error('Table broadcast_log is append-only: DELETE is not permitted.');
      }),
    },
    shopListing: {
      findUnique: jest.fn(async () => ({
        collegeId: 'col-1',
        shop: { staff: [{ userId: 'owner-1' }] },
      })),
    },
  };

  const audit = { recordInTransaction: jest.fn().mockResolvedValue(undefined) };
  const service = new OrdersService(prisma as never, new TenantService(), audit as never);

  return {
    service,
    prisma,
    audit,
    order,
    task,
    entries,
    logs,
    headReads,
    /** Someone else ends the order between this request's read and its transaction. */
    orderMovesAfterFirstRead(status: string) {
      afterOrderRead.set(1, () => {
        order.status = status;
        task.status = 'CANCELLED';
      });
    },
    /**
     * A change that commits after the n-th read of the order and before the
     * write that follows it. The request is left holding a stale snapshot,
     * which is the one situation only the WHERE clause can catch.
     */
    afterOrderRead(n: number, change: (rows: { order: Row; task: Row }) => void) {
      afterOrderRead.set(n, () => change({ order, task }));
    },
    /** The same, for the n-th direct read of the task row. */
    afterTaskRead(n: number, change: (rows: { order: Row; task: Row }) => void) {
      afterTaskRead.set(n, () => change({ order, task }));
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to be refused');
}

function expectConflict(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ConflictException);
  expect((error as ConflictException).getStatus()).toBe(409);
  expect((error as ConflictException).getResponse()).toMatchObject({ code });
}

// ===========================================================================
// 1. The loser of a race is told 409, not 500
// ===========================================================================

describe('a request that loses the race for an order', () => {
  it('student cancel: 409 ORDER_STATE_CHANGED, and no second refund', async () => {
    const ctx = build();
    ctx.orderMovesAfterFirstRead('CANCELLED');

    const error = await rejection(ctx.service.cancelByStudent(STUDENT, 'order-1', {}));

    // Was: IllegalOrderTransitionError, a plain Error, which the API's filter
    // reports as 500 INTERNAL_ERROR.
    expectConflict(error, 'ORDER_STATE_CHANGED');
    expect(ctx.entries.filter((e) => e.type === 'ORDER_RELEASE')).toHaveLength(0);
  });

  it('shop reject: 409 ORDER_STATE_CHANGED, and no second refund', async () => {
    const ctx = build();
    ctx.orderMovesAfterFirstRead('CANCELLED');

    const error = await rejection(
      ctx.service.rejectOrder(SHOP, 'order-1', { reason: 'Out of stock' }),
    );

    expectConflict(error, 'ORDER_STATE_CHANGED');
    expect(ctx.entries.filter((e) => e.type === 'ORDER_RELEASE')).toHaveLength(0);
  });

  it('"mark ready" on an order that was just cancelled: 409 ORDER_STATE_CHANGED', async () => {
    const ctx = build({ order: { status: 'CANCELLED' }, task: { status: 'CANCELLED' } });

    expectConflict(
      await rejection(ctx.service.markReady(SHOP, 'order-1')),
      'ORDER_STATE_CHANGED',
    );
    expect(ctx.order.status).toBe('CANCELLED');
  });

  it('the winner still goes through: one release, order and task cancelled', async () => {
    const ctx = build();

    await expect(ctx.service.cancelByStudent(STUDENT, 'order-1', {})).resolves.toMatchObject({
      status: 'CANCELLED',
    });

    expect(ctx.order.status).toBe('CANCELLED');
    expect(ctx.task.status).toBe('CANCELLED');
    expect(ctx.entries.filter((e) => e.type === 'ORDER_RELEASE')).toHaveLength(1);
  });
});

// ===========================================================================
// 2. paymentStatus follows the money
// ===========================================================================

describe('paymentStatus when a hold is released or captured', () => {
  it('student cancel of a WALLET order: REFUNDED', async () => {
    const ctx = build();
    await ctx.service.cancelByStudent(STUDENT, 'order-1', {});
    expect(ctx.order.paymentStatus).toBe('REFUNDED');
  });

  it('shop reject of a WALLET order: REFUNDED', async () => {
    const ctx = build();
    await ctx.service.rejectOrder(SHOP, 'order-1', { reason: 'Out of stock' });
    expect(ctx.order.paymentStatus).toBe('REFUNDED');
  });

  it('cancel of a CASH order: stays NOT_REQUIRED and writes nothing to the ledger', async () => {
    const ctx = build({
      order: { paymentMethod: 'CASH', paymentStatus: 'NOT_REQUIRED' },
      entries: [],
    });
    await ctx.service.cancelByStudent(STUDENT, 'order-1', {});
    expect(ctx.order.paymentStatus).toBe('NOT_REQUIRED');
    expect(ctx.entries).toHaveLength(0);
  });

  it('no rider found, student cancels a WALLET order: REFUNDED, full amount back', async () => {
    const ctx = build({ order: { status: 'PREPARING' }, task: { status: 'UNFULFILLED' } });

    await ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'CANCEL');

    expect(ctx.order).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
    const release = ctx.entries.filter((e) => e.type === 'ORDER_RELEASE');
    expect(release).toHaveLength(1);
    expect(release[0]).toMatchObject({ amountMinor: 3500, balanceAfterMinor: 5000 });
  });

  it('no rider found, WALLET order collected in person: CAPTURED, with a capture entry', async () => {
    const ctx = build({ order: { status: 'READY' }, task: { status: 'UNFULFILLED' } });

    await ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'COLLECT_IN_PERSON');

    expect(ctx.order).toMatchObject({
      status: 'COMPLETED',
      paymentStatus: 'CAPTURED',
      deliveryFeeMinor: 0,
      totalMinor: 2500,
    });

    // The fee comes back; the rest of the hold is closed by a zero-amount capture.
    const written = ctx.entries.slice(1);
    expect(written.map((e) => e.type)).toEqual(['ORDER_RELEASE', 'ORDER_CAPTURE']);
    expect(written[0]).toMatchObject({ direction: 'CREDIT', amountMinor: 1000, balanceAfterMinor: 2500 });
    expect(written[1]).toMatchObject({ direction: 'DEBIT', amountMinor: 0, balanceAfterMinor: 2500 });
    // The wallet lock is taken for a wallet order.
    expect(ctx.prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('CASH order collected in person: stays NOT_REQUIRED, no ledger entry', async () => {
    const ctx = build({
      order: { status: 'READY', paymentMethod: 'CASH', paymentStatus: 'NOT_REQUIRED' },
      task: { status: 'UNFULFILLED' },
      entries: [],
    });

    await ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'COLLECT_IN_PERSON');

    expect(ctx.order).toMatchObject({ status: 'COMPLETED', paymentStatus: 'NOT_REQUIRED' });
    expect(ctx.entries).toHaveLength(0);
  });
});

// ===========================================================================
// 3. "Keep waiting" does not DELETE from an append-only table
// ===========================================================================

describe('keep waiting after no rider was found', () => {
  it('closes the pending broadcast rounds as EXPIRED instead of deleting them', async () => {
    const ctx = build({
      order: { status: 'PREPARING', paymentMethod: 'CASH', paymentStatus: 'NOT_REQUIRED' },
      task: { status: 'UNFULFILLED' },
      logs: [
        { taskId: 'task-1', round: 2, outcome: 'EXPIRED' },
        { taskId: 'task-1', round: 3, outcome: 'PENDING' },
      ],
    });

    // Was: deleteMany, which the trigger (and this fake) refuses — the whole
    // transaction failed and the task never went back into the pool.
    await expect(
      ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'KEEP_WAITING'),
    ).resolves.toMatchObject({ choice: 'KEEP_WAITING' });

    expect(ctx.prisma.broadcastLog.deleteMany).not.toHaveBeenCalled();
    expect(ctx.logs).toHaveLength(2);
    expect(ctx.logs.map((l) => l.outcome)).toEqual(['EXPIRED', 'EXPIRED']);
    expect(ctx.logs[1].resolvedAt).toBeInstanceOf(Date);
    expect(ctx.task).toMatchObject({ status: 'CREATED', broadcastRound: 0, feeMinor: 1000 });
  });
});

// ===========================================================================
// 4. One unambiguous "latest" ledger entry
// ===========================================================================

describe('ledger entries written by the orders service', () => {
  it('are stamped strictly after the entry they were computed from', async () => {
    // The previous entry carries a timestamp at or ahead of this clock — the
    // same-millisecond case, made unmissable.
    const head = new Date(Date.now() + 10_000);
    const ctx = build({
      entries: [
        {
          userId: 'student-1',
          type: 'ORDER_HOLD',
          direction: 'DEBIT',
          amountMinor: 3500,
          balanceAfterMinor: 1500,
          createdAt: head,
        },
      ],
    });

    await ctx.service.cancelByStudent(STUDENT, 'order-1', {});

    const release = ctx.entries[1];
    expect(release.type).toBe('ORDER_RELEASE');
    // Was: no createdAt supplied at all, so the database's own clock decided
    // and a tie (or an earlier value) left "latest" ambiguous.
    expect(release.createdAt).toBeInstanceOf(Date);
    expect(release.createdAt.getTime()).toBeGreaterThan(head.getTime());
  });

  it('keep two entries from one transaction in order', async () => {
    const ctx = build({ order: { status: 'READY' }, task: { status: 'UNFULFILLED' } });

    await ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'COLLECT_IN_PERSON');

    const [, release, capture] = ctx.entries;
    expect(capture.createdAt.getTime()).toBeGreaterThan(release.createdAt.getTime());
  });

  it('read the head of the ledger with a tie-break, never createdAt alone', async () => {
    const ctx = build();

    await ctx.service.cancelByStudent(STUDENT, 'order-1', {});
    await ctx.service.walletBalance('student-1');

    expect(ctx.headReads.length).toBeGreaterThanOrEqual(2);
    for (const orderBy of ctx.headReads) {
      expect(Array.isArray(orderBy)).toBe(true);
      expect(orderBy).toEqual([{ createdAt: 'desc' }, { seq: 'desc' }]);
    }
  });
});

// ===========================================================================
// 5. The WHERE clause is what decides
// ===========================================================================

/**
 * In each of these the service has read a status that was true at the time
 * and is no longer: another request committed in the gap between the read
 * and the write. No check made on the stale snapshot can notice. Only an
 * UPDATE that names the expected status in its WHERE can — it matches no row
 * and the request is refused.
 *
 * Each test goes red if `status` is taken out of the corresponding `where`:
 * the write then lands on a row it should not touch.
 */
describe('a write based on a stale read is refused by the conditional UPDATE', () => {
  it('cancel: the order is accepted by the shop after the in-transaction read', async () => {
    // Cash, so no wallet lock serialises the two requests.
    const ctx = build({
      order: { paymentMethod: 'CASH', paymentStatus: 'NOT_REQUIRED' },
      entries: [],
    });
    // Read 1 is cancelByStudent's own; read 2 is inside transitionOrderAndTask.
    ctx.afterOrderRead(2, ({ order }) => {
      order.status = 'PREPARING';
    });

    expectConflict(
      await rejection(ctx.service.cancelByStudent(STUDENT, 'order-1', {})),
      'ORDER_STATE_CHANGED',
    );

    // The order the shop is now cooking was not cancelled underneath it.
    expect(ctx.order.status).toBe('PREPARING');
    expect(ctx.order.cancelledBy).toBeUndefined();
    expect(ctx.task.status).toBe('CREATED');
  });

  it('cancel of a WALLET order: no release is written when the UPDATE matches nothing', async () => {
    const ctx = build();
    ctx.afterOrderRead(2, ({ order }) => {
      order.status = 'PREPARING';
    });

    expectConflict(
      await rejection(ctx.service.cancelByStudent(STUDENT, 'order-1', {})),
      'ORDER_STATE_CHANGED',
    );

    expect(ctx.order).toMatchObject({ status: 'PREPARING', paymentStatus: 'HELD' });
    expect(ctx.entries.filter((e) => e.type === 'ORDER_RELEASE')).toHaveLength(0);
  });

  it('mark ready: the order is cancelled after it was read as PREPARING', async () => {
    const ctx = build({ order: { status: 'PREPARING' } });
    ctx.afterOrderRead(1, ({ order }) => {
      order.status = 'CANCELLED';
    });

    expectConflict(await rejection(ctx.service.markReady(SHOP, 'order-1')), 'ORDER_STATE_CHANGED');

    // A cancelled order was not brought back as READY.
    expect(ctx.order.status).toBe('CANCELLED');
    expect(ctx.order.readyAt).toBeUndefined();
  });

  it('collect in person: the order stops being READY after it was read', async () => {
    const ctx = build({ order: { status: 'READY' }, task: { status: 'UNFULFILLED' } });
    ctx.afterOrderRead(1, ({ order }) => {
      order.status = 'CANCELLED';
    });

    expectConflict(
      await rejection(ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'COLLECT_IN_PERSON')),
      'ORDER_NOT_READY',
    );

    // Not completed, fee not zeroed, nothing captured or refunded.
    expect(ctx.order).toMatchObject({
      status: 'CANCELLED',
      paymentStatus: 'HELD',
      deliveryFeeMinor: 1000,
      totalMinor: 3500,
    });
    expect(ctx.entries).toHaveLength(1);
  });

  it('collect in person: the task is cancelled after it was read as UNFULFILLED', async () => {
    const ctx = build({ order: { status: 'READY' }, task: { status: 'UNFULFILLED' } });
    ctx.afterOrderRead(1, ({ task }) => {
      task.status = 'CANCELLED';
    });

    expectConflict(
      await rejection(ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'COLLECT_IN_PERSON')),
      'NOT_UNFULFILLED',
    );

    expect(ctx.task.status).toBe('CANCELLED');
    expect(ctx.order.status).toBe('READY');
    expect(ctx.entries).toHaveLength(1);
  });

  it('keep waiting: the task is cancelled after it was read as UNFULFILLED', async () => {
    const ctx = build({
      order: { status: 'PREPARING', paymentMethod: 'CASH', paymentStatus: 'NOT_REQUIRED' },
      task: { status: 'UNFULFILLED' },
      entries: [],
    });
    ctx.afterOrderRead(1, ({ task }) => {
      task.status = 'CANCELLED';
    });

    expectConflict(
      await rejection(ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'KEEP_WAITING')),
      'NOT_UNFULFILLED',
    );

    // A cancelled task was not put back into the dispatch pool.
    expect(ctx.task.status).toBe('CANCELLED');
    expect(ctx.task.dispatchDueAt).toBeUndefined();
  });

  it('unfulfilled cancel: the task went back to the pool after it was read', async () => {
    const ctx = build({ order: { status: 'PREPARING' }, task: { status: 'UNFULFILLED' } });
    // A parallel "keep waiting" won.
    ctx.afterOrderRead(1, ({ task }) => {
      task.status = 'CREATED';
    });

    expectConflict(
      await rejection(ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'CANCEL')),
      'NOT_UNFULFILLED',
    );

    // The task now being offered to riders was not cancelled, and nothing was refunded.
    expect(ctx.task.status).toBe('CREATED');
    expect(ctx.order).toMatchObject({ status: 'PREPARING', paymentStatus: 'HELD' });
    expect(ctx.entries.filter((e) => e.type === 'ORDER_RELEASE')).toHaveLength(0);
  });

  it('unfulfilled cancel: the order is completed after it was read', async () => {
    const ctx = build({ order: { status: 'READY' }, task: { status: 'UNFULFILLED' } });
    ctx.afterOrderRead(1, ({ order }) => {
      order.status = 'COMPLETED';
    });

    expectConflict(
      await rejection(ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'CANCEL')),
      'ORDER_STATE_CHANGED',
    );

    // A completed order was not turned into a cancelled, refunded one.
    expect(ctx.order).toMatchObject({ status: 'COMPLETED', paymentStatus: 'HELD' });
    expect(ctx.order.cancelledBy).toBeUndefined();
    expect(ctx.entries.filter((e) => e.type === 'ORDER_RELEASE')).toHaveLength(0);
  });

  it('shop accept: the student cancels after the order was read as PLACED', async () => {
    const ctx = build();
    ctx.afterOrderRead(1, ({ order, task }) => {
      order.status = 'CANCELLED';
      task.status = 'CANCELLED';
    });

    expectConflict(
      await rejection(ctx.service.acceptOrder(SHOP, 'order-1', {})),
      'ORDER_STATE_CHANGED',
    );

    // The cancelled order was not resurrected as PREPARING.
    expect(ctx.order.status).toBe('CANCELLED');
    expect(ctx.order.shopAcceptedAt).toBeUndefined();
    expect(ctx.task.dispatchDueAt).toBeUndefined();
  });

  it('cancel: a rider accepts the task after the in-transaction read of it', async () => {
    const ctx = build({
      order: { paymentMethod: 'CASH', paymentStatus: 'NOT_REQUIRED' },
      entries: [],
    });
    ctx.afterTaskRead(1, ({ task }) => {
      task.status = 'ASSIGNED';
    });

    expectConflict(
      await rejection(ctx.service.cancelByStudent(STUDENT, 'order-1', {})),
      'ORDER_STATE_CHANGED',
    );

    // The task a rider is now carrying was not cancelled underneath them.
    expect(ctx.task.status).toBe('ASSIGNED');
    expect(ctx.task.cancelledAt).toBeUndefined();
  });

  it('shop accept: the task is cancelled after the order was read, the order still PLACED', async () => {
    const ctx = build({
      order: { paymentMethod: 'CASH', paymentStatus: 'NOT_REQUIRED' },
      entries: [],
    });
    // Only the task moves, so the order's own conditional UPDATE still
    // matches and it is the task's predicate that has to refuse.
    ctx.afterOrderRead(1, ({ task }) => {
      task.status = 'CANCELLED';
    });

    expectConflict(
      await rejection(ctx.service.acceptOrder(SHOP, 'order-1', {})),
      'ORDER_STATE_CHANGED',
    );

    // A cancelled task was not given a dispatch time.
    expect(ctx.task.status).toBe('CANCELLED');
    expect(ctx.task.dispatchDueAt).toBeUndefined();
  });
});

// ===========================================================================
// 6. The response says what happened to the money
// ===========================================================================

describe('what the caller is told about a refund', () => {
  const CASH = { paymentMethod: 'CASH', paymentStatus: 'NOT_REQUIRED' };

  it('unfulfilled cancel of a CASH order: nothing refunded, and it says so', async () => {
    const ctx = build({
      order: { ...CASH, status: 'PREPARING' },
      task: { status: 'UNFULFILLED' },
      entries: [],
    });

    const result = await ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'CANCEL');

    // Was: refundedMinor 3500 and "refunded in full", with no money moved.
    expect((result as { refundedMinor: number }).refundedMinor).toBe(0);
    expect(result.message).not.toMatch(/refunded in full/);
    expect(result.message).not.toContain('35');
    expect(result.message).toMatch(/nothing to refund/);
    expect(ctx.entries).toHaveLength(0);
  });

  it('unfulfilled cancel of a WALLET order: the full total, matching the ledger', async () => {
    const ctx = build({ order: { status: 'PREPARING' }, task: { status: 'UNFULFILLED' } });

    const result = await ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'CANCEL');

    expect((result as { refundedMinor: number }).refundedMinor).toBe(3500);
    expect(result.message).toMatch(/refunded in full/);
    expect(ctx.entries[1]).toMatchObject({ type: 'ORDER_RELEASE', amountMinor: 3500 });
  });

  it('CASH order collected in person: no fee refunded; told what to pay at the shop', async () => {
    const ctx = build({
      order: { ...CASH, status: 'READY' },
      task: { status: 'UNFULFILLED' },
      entries: [],
    });

    const result = await ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'COLLECT_IN_PERSON');

    // Was: refundedFeeMinor 1000 and "delivery fee has been refunded".
    expect((result as { refundedFeeMinor: number }).refundedFeeMinor).toBe(0);
    expect(result.message).not.toMatch(/refunded|returned/);
    expect(result.message).toMatch(/No delivery fee is charged/);
    // 3500 total less the 1000 fee.
    expect(result.message).toContain('25');
  });

  it('WALLET order collected in person: the fee, matching the ledger', async () => {
    const ctx = build({ order: { status: 'READY' }, task: { status: 'UNFULFILLED' } });

    const result = await ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'COLLECT_IN_PERSON');

    expect((result as { refundedFeeMinor: number }).refundedFeeMinor).toBe(1000);
    expect(result.message).toMatch(/returned to your wallet/);
  });

  it('student cancel: 0 for cash, the held total for a wallet order', async () => {
    const cash = build({ order: CASH, entries: [] });
    const cashResult = await cash.service.cancelByStudent(STUDENT, 'order-1', {});
    expect(cashResult.refundedMinor).toBe(0);
    expect(cashResult.message).toBe('Order cancelled. You have not been charged.');

    const wallet = build();
    const walletResult = await wallet.service.cancelByStudent(STUDENT, 'order-1', {});
    expect(walletResult.refundedMinor).toBe(3500);
    expect(walletResult.message).toMatch(/returned to your wallet/);
  });

  it('shop reject: 0 for cash, the held total for a wallet order', async () => {
    const cash = build({ order: CASH, entries: [] });
    expect(
      (await cash.service.rejectOrder(SHOP, 'order-1', { reason: 'Closed' })).refundedMinor,
    ).toBe(0);

    const wallet = build();
    expect(
      (await wallet.service.rejectOrder(SHOP, 'order-1', { reason: 'Closed' })).refundedMinor,
    ).toBe(3500);
  });
});

// ===========================================================================
// 7. An administrator cancels a picked-up order (FR-ADM-04)
// ===========================================================================

/**
 * `adminCancelInTransaction` is called by the escalations service inside its
 * own transaction; here the stand-in plays that transaction. The order of an
 * escalated delivery is PICKED_UP.
 */
describe('adminCancelInTransaction', () => {
  const PICKED_UP = { order: { status: 'PICKED_UP' }, task: { status: 'ESCALATED' } };
  const call = (ctx: ReturnType<typeof build>) =>
    ctx.service.adminCancelInTransaction(ctx.prisma as never, {
      orderId: 'order-1',
      adminUserId: 'admin-1',
      reason: 'Rider could not find the student; food returned.',
    });
  /** The position, among all mock calls in this test, of a mock's first call. */
  const firstCall = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];

  it('WALLET order: cancelled by ADMIN, REFUNDED, exactly one release of the full total', async () => {
    const ctx = build(PICKED_UP);

    await expect(call(ctx)).resolves.toEqual({
      outcome: 'CANCELLED',
      refundedMinor: 3500,
      studentId: 'student-1',
    });

    expect(ctx.order).toMatchObject({
      status: 'CANCELLED',
      cancelledBy: 'ADMIN',
      cancelledReason: 'Rider could not find the student; food returned.',
      paymentStatus: 'REFUNDED',
    });
    const releases = ctx.entries.filter((e) => e.type === 'ORDER_RELEASE');
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      userId: 'student-1',
      direction: 'CREDIT',
      amountMinor: 3500,
      balanceAfterMinor: 5000,
      orderId: 'order-1',
    });
    // Stamped after the hold it reverses, like every other ledger entry.
    expect(releases[0].createdAt.getTime()).toBeGreaterThan(ctx.entries[0].createdAt.getTime());
  });

  it('leaves the task row alone and opens no transaction of its own', async () => {
    const ctx = build(PICKED_UP);
    const openTransaction = jest.spyOn(ctx.prisma, '$transaction');

    await call(ctx);

    // The caller's conditional UPDATE on the task decides the escalation race.
    expect(ctx.task.status).toBe('ESCALATED');
    expect(ctx.prisma.task.updateMany).not.toHaveBeenCalled();
    expect(openTransaction).not.toHaveBeenCalled();
  });

  it('takes the wallet lock before it writes any row', async () => {
    const ctx = build(PICKED_UP);

    await call(ctx);

    // Goes red if the lock is removed, or moved after the UPDATE.
    expect(ctx.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, lockedUser] = ctx.prisma.$executeRaw.mock.calls[0] as [string[], string];
    expect(strings.join('?')).toContain("pg_advisory_xact_lock(hashtext('wallet:' || ?))");
    expect(lockedUser).toBe('student-1');
    expect(firstCall(ctx.prisma.$executeRaw)).toBeLessThan(firstCall(ctx.prisma.order.updateMany));
    expect(firstCall(ctx.prisma.$executeRaw)).toBeLessThan(firstCall(ctx.prisma.walletEntry.create));
  });

  it('records who refunded, in the same transaction (FR-ADM-06)', async () => {
    const ctx = build(PICKED_UP);

    await call(ctx);

    expect(ctx.audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(ctx.audit.recordInTransaction).toHaveBeenCalledWith(
      ctx.prisma,
      expect.objectContaining({
        actorId: 'admin-1',
        collegeId: 'col-1',
        action: 'WALLET_ADJUSTED',
        targetType: 'order',
        targetId: 'order-1',
        detail: expect.objectContaining({ entryType: 'ORDER_RELEASE', amountMinor: 3500 }),
      }),
    );
  });

  it('CASH order: cancelled, nothing refunded, no lock, no ledger entry, no wallet audit', async () => {
    const ctx = build({
      order: { status: 'PICKED_UP', paymentMethod: 'CASH', paymentStatus: 'NOT_REQUIRED' },
      task: { status: 'ESCALATED' },
      entries: [],
    });

    await expect(call(ctx)).resolves.toEqual({
      outcome: 'CANCELLED',
      refundedMinor: 0,
      studentId: 'student-1',
    });

    expect(ctx.order).toMatchObject({
      status: 'CANCELLED',
      cancelledBy: 'ADMIN',
      paymentStatus: 'NOT_REQUIRED',
    });
    expect(ctx.entries).toHaveLength(0);
    expect(ctx.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(ctx.audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('stale read: a correct handover code settles the order after it was read', async () => {
    const ctx = build(PICKED_UP);
    // Read 1 is the method's own read of the order.
    ctx.afterOrderRead(1, ({ order }) => {
      order.status = 'DELIVERED';
    });

    // Goes red if `status` is taken out of the conditional UPDATE: the
    // delivered order would be cancelled and its payment refunded.
    await expect(call(ctx)).resolves.toEqual({ outcome: 'STATE_CHANGED' });

    expect(ctx.order).toMatchObject({ status: 'DELIVERED', paymentStatus: 'HELD' });
    expect(ctx.order.cancelledBy).toBeUndefined();
    expect(ctx.entries.filter((e) => e.type === 'ORDER_RELEASE')).toHaveLength(0);
    expect(ctx.audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('a second resolution finds nothing to cancel and refunds nothing more', async () => {
    const ctx = build(PICKED_UP);

    await call(ctx);
    await expect(call(ctx)).resolves.toEqual({ outcome: 'STATE_CHANGED' });

    expect(ctx.entries.filter((e) => e.type === 'ORDER_RELEASE')).toHaveLength(1);
  });

  it('only a PICKED_UP order: one still with the shop is not this method\'s to cancel', async () => {
    for (const status of ['PLACED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED']) {
      const ctx = build({ order: { status } });
      await expect(call(ctx)).resolves.toEqual({ outcome: 'STATE_CHANGED' });
      expect(ctx.order.status).toBe(status);
      expect(ctx.entries).toHaveLength(1);
    }
  });

  it('an order that does not exist: says so, writes nothing', async () => {
    const ctx = build(PICKED_UP);
    ctx.prisma.order.findUnique.mockResolvedValueOnce(null);

    await expect(call(ctx)).resolves.toEqual({ outcome: 'ORDER_NOT_FOUND' });
    expect(ctx.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(ctx.entries).toHaveLength(1);
  });
});

// ===========================================================================
// 8. Every refund path takes the wallet lock first
// ===========================================================================

describe('the wallet lock comes before any write, on every path that refunds', () => {
  const firstCall = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];

  function expectLockedFirst(ctx: ReturnType<typeof build>): void {
    expect(ctx.prisma.$executeRaw).toHaveBeenCalled();
    const lock = firstCall(ctx.prisma.$executeRaw);
    for (const write of [
      ctx.prisma.order.updateMany,
      ctx.prisma.task.updateMany,
      ctx.prisma.walletEntry.create,
    ]) {
      if (write.mock.calls.length > 0) expect(lock).toBeLessThan(firstCall(write));
    }
  }

  it('student cancel', async () => {
    const ctx = build();
    await ctx.service.cancelByStudent(STUDENT, 'order-1', {});
    expectLockedFirst(ctx);
  });

  it('shop reject', async () => {
    const ctx = build();
    await ctx.service.rejectOrder(SHOP, 'order-1', { reason: 'Closed' });
    expectLockedFirst(ctx);
  });

  it('no rider, cancel', async () => {
    const ctx = build({ order: { status: 'PREPARING' }, task: { status: 'UNFULFILLED' } });
    await ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'CANCEL');
    expectLockedFirst(ctx);
  });

  it('no rider, collect in person', async () => {
    const ctx = build({ order: { status: 'READY' }, task: { status: 'UNFULFILLED' } });
    await ctx.service.resolveUnfulfilled(STUDENT, 'order-1', 'COLLECT_IN_PERSON');
    expectLockedFirst(ctx);
  });
});
