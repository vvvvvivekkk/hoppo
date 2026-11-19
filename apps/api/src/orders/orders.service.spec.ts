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
  let afterFirstOrderRead: (() => void) | null = null;

  const prisma: Row = {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    $executeRaw: jest.fn().mockResolvedValue(1),
    order: {
      findUnique: jest.fn(async () => {
        const snapshot = { ...order, task: { ...task } };
        orderReads += 1;
        if (orderReads === 1 && afterFirstOrderRead) afterFirstOrderRead();
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
      findUnique: jest.fn(async () => ({ ...task })),
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

  const service = new OrdersService(prisma as never, new TenantService(), {} as never);

  return {
    service,
    prisma,
    order,
    task,
    entries,
    logs,
    headReads,
    /** Someone else ends the order between this request's read and its transaction. */
    orderMovesAfterFirstRead(status: string) {
      afterFirstOrderRead = () => {
        order.status = status;
        task.status = 'CANCELLED';
      };
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
