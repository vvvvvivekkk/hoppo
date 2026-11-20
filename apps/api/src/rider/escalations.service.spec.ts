import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as argon2 from 'argon2';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { OrdersService } from '../orders/orders.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { buildDispatch, wsEvents } from '../dispatch/test/fakes';
import { codeOf, seedChatRoom, seedRider, seedTask } from '../dispatch/test/world';
import { ResolveEscalationDto } from './dto/escalation.dto';
import { EscalationsController } from './escalations.controller';
import { EscalationsService } from './escalations.service';
import { RiderService } from './rider.service';

/**
 * FR-ADM-04: an administrator resolving an escalated task.
 *
 * The real EscalationsService, RiderService, DispatchService, AuditService
 * and TenantService run over the in-memory database (../dispatch/test/fakes),
 * which evaluates every `where` — so "a second resolution changes nothing"
 * is tested by resolving twice and looking at the rows, not by inspecting a
 * call.
 *
 * What it cannot show is two administrators' transactions truly interleaving;
 * that is asked of a live harness in A2-to-A8-escalation-resolve-harness.md.
 */

beforeAll(() => {
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

const admin: AuthenticatedUser = { userId: 'admin-1', collegeId: 'col-1', role: 'ADMIN', isVerified: true };
const otherAdmin: AuthenticatedUser = { userId: 'admin-2', collegeId: 'col-1', role: 'ADMIN', isVerified: true };
const foreignAdmin: AuthenticatedUser = { userId: 'admin-9', collegeId: 'col-2', role: 'ADMIN', isVerified: true };
const superAdmin: AuthenticatedUser = { userId: 'root', collegeId: null, role: 'SUPER_ADMIN', isVerified: true };
const riderUser: AuthenticatedUser = { userId: 'rider-1', collegeId: 'col-1', role: 'STUDENT', isVerified: true };

const NOTE = 'Called both: the student confirms she has the food.';
const delivered = { outcome: 'DELIVERED', note: NOTE } as ResolveEscalationDto;
const notDelivered = { outcome: 'NOT_DELIVERED', note: NOTE } as ResolveEscalationDto;

const HANDOVER_CODE = '482913';
let handoverHash: string;
beforeAll(async () => {
  handoverHash = await argon2.hash(HANDOVER_CODE, { type: argon2.argon2id });
});

/**
 * rider-1 was carrying task-1 when it escalated after five wrong codes. As
 * RiderService.escalate leaves it: ESCALATED, still naming the rider, the
 * rider released, the order still PICKED_UP. `order: null` for a peer errand.
 */
function escalated(task: Record<string, unknown> = {}, order: Record<string, unknown> | null = {}) {
  const ctx = buildDispatch();
  const world = seedTask(
    ctx.prisma,
    {
      status: 'ESCALATED',
      riderId: 'rider-1',
      broadcastRound: 1,
      assignedAt: new Date(Date.now() - 1_800_000),
      pickedUpAt: new Date(Date.now() - 1_500_000),
      escalatedAt: new Date(Date.now() - 900_000),
      createdAt: new Date(Date.now() - 2_400_000),
      resolutionNote: 'OTP attempts exhausted',
      otpHash: handoverHash,
      otpAttempts: 5,
      requester: { id: 'student-1', name: 'Asha', mobile: '+910000000001' },
      rider: { id: 'rider-1', name: 'Ravi', mobile: '+910000000002', status: 'ACTIVE' },
      ...task,
    },
    order === null
      ? null
      : {
          status: 'PICKED_UP',
          deliveryFeeMinor: 2000,
          items: [{ nameSnapshot: 'Idli', quantity: 2 }],
          ...order,
        },
  );
  const state = seedRider(ctx.prisma, 'rider-1', { activeTaskId: null });
  const room = seedChatRoom(ctx.prisma, world.task, ['student-1', 'staff-1', 'owner-1', 'rider-1']);

  const tenant = new TenantService();
  const Rider = RiderService as unknown as new (...args: unknown[]) => RiderService;
  const rider = new Rider(ctx.prisma, ctx.redis, { record: jest.fn() }, {}, tenant, ctx.service, ctx.gateway);
  // The real audit and orders services: the rows they write — the audit
  // entries, and the refund the orders module owns — are part of what is
  // tested here.
  const audit = new AuditService(ctx.prisma);
  const Escalations = EscalationsService as unknown as new (...args: unknown[]) => EscalationsService;
  const escalations = new Escalations(
    ctx.prisma,
    tenant,
    audit,
    rider,
    ctx.service,
    new OrdersService(ctx.prisma, tenant, audit),
  );

  return { ...ctx, escalations, rider, task: world.task, order: world.order, state, room };
}

type World = ReturnType<typeof escalated>;

/** What a wallet-ledger row says, without what differs run to run. */
const ledger = (world: World) =>
  world.prisma.$rows('walletEntry').map(({ id: _id, createdAt: _at, ...entry }: any) => entry);

const auditRows = (world: World) => world.prisma.$rows('auditLog');

/** Nothing was decided: the rows are as they were and nobody was told. */
function expectUntouched(world: World, taskBefore: object, orderBefore: object | null) {
  expect(world.task).toEqual(taskBefore);
  if (world.order) expect(world.order).toEqual(orderBefore);
  expect(world.prisma.$rows('walletEntry')).toEqual([]);
  expect(auditRows(world)).toEqual([]);
  expect(world.server.emissions).toEqual([]);
}

// ===========================================================================
// Who may call it
// ===========================================================================

describe('EscalationsController', () => {
  function guardAllows(handlerName: string, user: AuthenticatedUser): boolean {
    const handler = (EscalationsController.prototype as unknown as Record<string, () => unknown>)[handlerName];
    expect(typeof handler).toBe('function');
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => handler,
      getClass: () => EscalationsController,
    } as unknown as ExecutionContext;
    return new RolesGuard(new Reflector()).canActivate(context);
  }

  const HANDLERS = ['list', 'detail', 'resolve'];

  it('is restricted to ADMIN, on the class', () => {
    expect(Reflect.getMetadata(ROLES_KEY, EscalationsController)).toEqual(['ADMIN']);
    for (const handler of HANDLERS) {
      expect(
        Reflect.getMetadata(ROLES_KEY, EscalationsController.prototype[handler as never]),
      ).toBeUndefined();
    }
  });

  it.each(['STUDENT', 'SHOP_OWNER', 'SHOP_STAFF'] as const)('refuses a %s every endpoint', (role) => {
    for (const handler of HANDLERS) {
      expect(() => guardAllows(handler, { ...riderUser, role })).toThrow(ForbiddenException);
    }
  });

  it('admits an administrator, and a super administrator', () => {
    for (const handler of HANDLERS) {
      expect(guardAllows(handler, admin)).toBe(true);
      expect(guardAllows(handler, superAdmin)).toBe(true);
    }
  });
});

describe('ResolveEscalationDto — the mandatory note', () => {
  const errorsFor = async (body: object) =>
    (await validate(plainToInstance(ResolveEscalationDto, body))).map((e) => e.property);

  it('accepts an outcome with a real note', async () => {
    expect(await errorsFor({ outcome: 'DELIVERED', note: NOTE })).toEqual([]);
    expect(await errorsFor({ outcome: 'NOT_DELIVERED', note: NOTE })).toEqual([]);
  });

  it.each([
    ['missing', { outcome: 'DELIVERED' }],
    ['empty', { outcome: 'DELIVERED', note: '' }],
    ['too short to mean anything', { outcome: 'DELIVERED', note: 'ok' }],
    ['ten spaces', { outcome: 'DELIVERED', note: '          ' }],
    ['padded up to length with spaces', { outcome: 'DELIVERED', note: '   done      ' }],
    ['not a string', { outcome: 'DELIVERED', note: 1234567890123 }],
    ['longer than 500 characters', { outcome: 'DELIVERED', note: 'x'.repeat(501) }],
  ])('refuses a note that is %s', async (_name, body) => {
    expect(await errorsFor(body)).toEqual(['note']);
  });

  it.each([
    ['missing', { note: NOTE }],
    ['DISPUTED, which this release does not offer', { outcome: 'DISPUTED', note: NOTE }],
    ['lower case', { outcome: 'delivered', note: NOTE }],
  ])('refuses an outcome that is %s', async (_name, body) => {
    expect(await errorsFor(body)).toEqual(['outcome']);
  });

  it('trims the note it keeps', () => {
    const dto = plainToInstance(ResolveEscalationDto, { outcome: 'DELIVERED', note: `  ${NOTE}  ` });
    expect(dto.note).toBe(NOTE);
  });
});

// ===========================================================================
// The queue (A-08)
// ===========================================================================

describe('list', () => {
  /** Three more tasks beside task-1: an older escalation, another college's, and one not escalated. */
  function withAQueue() {
    const world = escalated();
    const clone = (overrides: Record<string, unknown>) => ({ ...world.task, order: null, chatRoom: null, ...overrides });
    world.prisma.$seed('task', [
      clone({ id: 'task-older', escalatedAt: new Date(Date.now() - 7_200_000) }),
      clone({ id: 'task-elsewhere', collegeId: 'col-2', escalatedAt: new Date(Date.now() - 9_000_000) }),
      clone({ id: 'task-in-flight', status: 'PICKED_UP', escalatedAt: null }),
      clone({ id: 'task-resolved', status: 'COMPLETED', escalatedAt: new Date(Date.now() - 86_400_000) }),
    ]);
    return world;
  }

  it('shows my college\'s escalated tasks, the longest-waiting first', async () => {
    const world = withAQueue();

    const page = await world.escalations.list(admin);

    expect(page.items.map((i) => i.taskId)).toEqual(['task-older', 'task-1']);
    expect(page.nextCursor).toBeNull();
  });

  it('never shows another college\'s — to that college\'s admin, only theirs', async () => {
    const world = withAQueue();

    expect((await world.escalations.list(foreignAdmin)).items.map((i) => i.taskId)).toEqual([
      'task-elsewhere',
    ]);
  });

  it('shows a super administrator every college\'s', async () => {
    const world = withAQueue();

    expect((await world.escalations.list(superAdmin)).items.map((i) => i.taskId)).toEqual([
      'task-elsewhere',
      'task-older',
      'task-1',
    ]);
  });

  it('pages with a cursor, without repeating or dropping a task', async () => {
    const world = withAQueue();

    const first = await world.escalations.list(admin, 1);
    expect(first.items.map((i) => i.taskId)).toEqual(['task-older']);
    expect(first.nextCursor).toBe('task-older');

    const second = await world.escalations.list(admin, 1, first.nextCursor!);
    expect(second.items.map((i) => i.taskId)).toEqual(['task-1']);
    expect(second.nextCursor).toBeNull();
  });

  it('gives everything needed to decide, on the row (FR-ADM-02)', async () => {
    const world = escalated();

    const [item] = (await world.escalations.list(admin)).items;

    expect(item).toMatchObject({
      taskId: 'task-1',
      type: 'SHOP_ORDER',
      status: 'ESCALATED',
      escalationReason: 'OTP attempts exhausted',
      otpAttempts: 5,
      maxOtpAttempts: 5,
      pickupLabel: 'Sri Sai Tiffins',
      dropLabel: 'Boys Hostel B',
      feeMinor: 2000,
      requester: { id: 'student-1', name: 'Asha', mobile: '+910000000001' },
      rider: { id: 'rider-1', name: 'Ravi', mobile: '+910000000002', status: 'ACTIVE' },
      order: {
        id: 'order-1',
        reference: 'HP-0001',
        status: 'PICKED_UP',
        paymentMethod: 'CASH',
        itemsSubtotalMinor: 12_000,
        deliveryFeeMinor: 2000,
        totalMinor: 14_500,
        shopName: 'Sri Sai Tiffins',
        items: [{ name: 'Idli', quantity: 2 }],
      },
      canResolveAs: ['DELIVERED', 'NOT_DELIVERED'],
    });
    expect(item!.escalatedAt).toBeInstanceOf(Date);
    expect(item!.pickedUpAt).toBeInstanceOf(Date);
  });

  it('does not hand the console the handover code\'s hash', async () => {
    const world = escalated();

    const page = await world.escalations.list(admin);

    expect(JSON.stringify(page)).not.toContain('argon2');
    expect(page.items[0]).not.toHaveProperty('otpHash');
  });

  it('offers both outcomes for a wallet-paid order too', async () => {
    const world = escalated({}, { paymentMethod: 'WALLET', paymentStatus: 'HELD' });

    expect((await world.escalations.list(admin)).items[0]!.canResolveAs).toEqual([
      'DELIVERED',
      'NOT_DELIVERED',
    ]);
  });

  it('fails loudly rather than send a task with no rider', async () => {
    // The client is promised `rider` is never null. An escalated task with no
    // rider breaks a CHECK constraint, so reaching this means the data is
    // wrong — and a 500 that says so is better than a console that crashes
    // on `rider.name`, or one that quietly shows a blank.
    const world = escalated({ rider: null });

    await expect(world.escalations.list(admin)).rejects.toThrow(/no rider/i);
    await expect(world.escalations.detail(admin, 'task-1')).rejects.toThrow(/no rider/i);
  });
});

describe('detail', () => {
  it('returns one escalated task', async () => {
    const world = escalated();

    expect(await world.escalations.detail(admin, 'task-1')).toMatchObject({
      taskId: 'task-1',
      status: 'ESCALATED',
      canResolveAs: ['DELIVERED', 'NOT_DELIVERED'],
    });
  });

  it('shows how a resolved task ended, and offers nothing further', async () => {
    const world = escalated();
    await world.escalations.resolve(admin, 'task-1', delivered);

    expect(await world.escalations.detail(otherAdmin, 'task-1')).toMatchObject({
      status: 'COMPLETED',
      resolutionNote: NOTE,
      escalationReason: null,
      canResolveAs: [],
    });
  });

  it('refuses another college\'s task', async () => {
    const world = escalated();

    expect(await codeOf(world.escalations.detail(foreignAdmin, 'task-1'))).toBe('CROSS_TENANT_ACCESS');
  });

  it('refuses a task that was never escalated', async () => {
    const world = escalated({ status: 'PICKED_UP', escalatedAt: null });

    expect(await codeOf(world.escalations.detail(admin, 'task-1'))).toBe('NOT_ESCALATED');
  });

  it('answers 404 for a task that does not exist', async () => {
    const world = escalated();

    await expect(world.escalations.detail(admin, 'no-such-task')).rejects.toMatchObject({ status: 404 });
  });
});

// ===========================================================================
// Resolve: delivered
// ===========================================================================

describe('resolve as DELIVERED', () => {
  it('completes the task and the order and keeps the administrator\'s note', async () => {
    const world = escalated();

    const result = await world.escalations.resolve(admin, 'task-1', delivered);

    expect(result).toMatchObject({
      taskId: 'task-1',
      outcome: 'DELIVERED',
      status: 'COMPLETED',
      orderStatus: 'COMPLETED',
      riderFeeMinor: 2000,
      settledInCash: true,
      refundedMinor: 0,
    });
    expect(world.task).toMatchObject({ status: 'COMPLETED', resolutionNote: NOTE, otpHash: null });
    expect(world.task.completedAt).toBeInstanceOf(Date);
    expect(world.order).toMatchObject({ status: 'COMPLETED' });
    expect(world.room.isArchived).toBe(true);
  });

  describe('settles the rider exactly as the handover code would have', () => {
    /**
     * The same delivery, finished two ways: by the rider entering the correct
     * code, and by an administrator resolving it after it escalated. The
     * ledger, the order and the reliability counters must come out the same —
     * an administrator's "delivered" must not pay a rider differently.
     */
    async function byHandoverCode(task: Record<string, unknown>, order: Record<string, unknown> | null) {
      const world = escalated(
        { status: 'PICKED_UP', escalatedAt: null, resolutionNote: null, otpAttempts: 0, ...task },
        order,
      );
      world.state.activeTaskId = 'task-1';
      await world.rider.submitHandoverCode(riderUser, 'task-1', { code: HANDOVER_CODE } as never);
      return world;
    }

    async function byAdministrator(task: Record<string, unknown>, order: Record<string, unknown> | null) {
      const world = escalated(task, order);
      await world.escalations.resolve(admin, 'task-1', delivered);
      return world;
    }

    it.each([
      ['a cash order', {}, {}],
      ['a wallet order', {}, { paymentMethod: 'WALLET', paymentStatus: 'HELD' }],
      ['a peer errand with a reimbursement', { feeMinor: 2500, reimbursementMinor: 800 }, null],
    ])('for %s', async (_name, task, order) => {
      const [code, adminResolved] = [await byHandoverCode(task, order), await byAdministrator(task, order)];

      // Something was written — two empty ledgers would also be "equal".
      expect(ledger(adminResolved).length).toBeGreaterThan(0);
      expect(ledger(adminResolved)).toEqual(ledger(code));
      expect(adminResolved.prisma.$locks).toEqual(code.prisma.$locks);

      const settledOrder = (w: World) =>
        w.order && { status: w.order.status, paymentStatus: w.order.paymentStatus };
      expect(settledOrder(adminResolved)).toEqual(settledOrder(code));

      const reliability = (w: World) => {
        const { tasksCompleted } = w.prisma.$rows('riderReliability')[0];
        return { tasksCompleted };
      };
      expect(reliability(adminResolved)).toEqual(reliability(code));
    });
  });

  it('writes the rider\'s fee entry for a cash order', async () => {
    const world = escalated();

    await world.escalations.resolve(admin, 'task-1', delivered);

    expect(ledger(world)).toEqual([
      expect.objectContaining({
        userId: 'rider-1',
        type: 'DELIVERY_FEE_EARNED',
        direction: 'CREDIT',
        amountMinor: 2000,
        taskId: 'task-1',
        orderId: 'order-1',
        counterpartyUserId: 'student-1',
      }),
    ]);
  });

  it('captures a wallet hold, locking both wallets in a fixed order first', async () => {
    const world = escalated({}, { paymentMethod: 'WALLET', paymentStatus: 'HELD' });

    await world.escalations.resolve(admin, 'task-1', delivered);

    expect(world.prisma.$locks).toEqual(['rider-1', 'student-1']);
    expect(world.order).toMatchObject({ status: 'COMPLETED', paymentStatus: 'CAPTURED' });
    expect(ledger(world).map((e: any) => [e.userId, e.type])).toEqual([
      ['student-1', 'ORDER_CAPTURE'],
      ['rider-1', 'DELIVERY_FEE_EARNED'],
    ]);
  });

  it('records who decided, what, and why, in the audit log (FR-ADM-06)', async () => {
    const world = escalated();

    await world.escalations.resolve(admin, 'task-1', delivered);

    expect(auditRows(world)).toEqual([
      expect.objectContaining({
        actor: { connect: { id: 'admin-1' } },
        collegeId: 'col-1',
        action: 'TASK_RESOLVED',
        targetType: 'task',
        targetId: 'task-1',
        detail: {
          outcome: 'DELIVERED',
          note: NOTE,
          escalationReason: 'OTP attempts exhausted',
          riderId: 'rider-1',
          orderId: 'order-1',
          riderFeeMinor: 2000,
          refundedMinor: 0,
        },
      }),
    ]);
  });

  it('tells the requester, the rider and the shop, and not the college', async () => {
    const world = escalated();

    await world.escalations.resolve(admin, 'task-1', delivered);

    const everyone = ['user:owner-1', 'user:rider-1', 'user:staff-1', 'user:student-1'];
    const [taskEvent] = world.server.of(wsEvents.TASK_STATUS_CHANGED);
    expect([...taskEvent!.rooms].sort()).toEqual(everyone);
    expect(taskEvent!.payload).toEqual({ taskId: 'task-1', status: 'COMPLETED', resolvedBy: 'ADMIN' });

    const [orderEvent] = world.server.of(wsEvents.ORDER_STATUS_CHANGED);
    expect([...orderEvent!.rooms].sort()).toEqual(everyone);
    expect(orderEvent!.payload).toEqual({ orderId: 'order-1', status: 'COMPLETED', resolvedBy: 'ADMIN' });

    expect(world.server.toCollegeRooms()).toEqual([]);
  });

  it('pays a rider who has since been suspended — they still made the delivery', async () => {
    const world = escalated({ rider: { id: 'rider-1', name: 'Ravi', mobile: null, status: 'SUSPENDED' } });

    await world.escalations.resolve(admin, 'task-1', delivered);

    expect(ledger(world)).toHaveLength(1);
  });

  it('leaves alone a different task the rider has since taken — `activeTaskId: taskId`', async () => {
    // Escalation released the rider hours ago; they are mid-delivery on
    // something else. Resolving the old task must not free them from it.
    const world = escalated();
    world.state.activeTaskId = 'task-newer';

    await world.escalations.resolve(admin, 'task-1', delivered);

    expect(world.state.activeTaskId).toBe('task-newer');
  });

  it('changes nothing when the order is not where an escalated order should be', async () => {
    const world = escalated({}, { status: 'CANCELLED' });
    const [taskBefore, orderBefore] = [{ ...world.task }, { ...world.order }];

    expect(await codeOf(world.escalations.resolve(admin, 'task-1', delivered))).toBe(
      'ORDER_NOT_AWAITING_HANDOVER',
    );

    expectUntouched(world, taskBefore, orderBefore);
  });

  it('settles nothing if the audit row cannot be written', async () => {
    // The decision and its record commit together or not at all.
    const world = escalated();
    const [taskBefore, orderBefore] = [{ ...world.task }, { ...world.order }];
    world.prisma.auditLog.create.mockRejectedValueOnce(new Error('audit_log unavailable'));

    await expect(world.escalations.resolve(admin, 'task-1', delivered)).rejects.toThrow(
      'audit_log unavailable',
    );

    expectUntouched(world, taskBefore, orderBefore);
  });
});

// ===========================================================================
// Resolve: not delivered
// ===========================================================================

describe('resolve as NOT_DELIVERED', () => {
  it('cancels the task and a cash order, and pays nobody', async () => {
    const world = escalated();

    const result = await world.escalations.resolve(admin, 'task-1', notDelivered);

    expect(result).toMatchObject({
      taskId: 'task-1',
      outcome: 'NOT_DELIVERED',
      status: 'CANCELLED',
      orderStatus: 'CANCELLED',
      riderFeeMinor: 0,
      refundedMinor: 0,
    });
    expect(world.task).toMatchObject({ status: 'CANCELLED', resolutionNote: NOTE, otpHash: null });
    expect(world.task.cancelledAt).toBeInstanceOf(Date);
    expect(world.order).toMatchObject({ status: 'CANCELLED', cancelledBy: 'ADMIN', cancelledReason: NOTE });
    expect(world.room.isArchived).toBe(true);
    expect(world.prisma.$rows('walletEntry')).toEqual([]);
    expect(world.prisma.$rows('riderReliability')).toEqual([]);
  });

  it('cancels a peer errand, which has no order', async () => {
    const world = escalated({ feeMinor: 2500, reimbursementMinor: 800 }, null);

    const result = await world.escalations.resolve(admin, 'task-1', notDelivered);

    expect(result).toMatchObject({ status: 'CANCELLED', orderStatus: null });
    expect(world.task.status).toBe('CANCELLED');
    expect(world.server.of(wsEvents.ORDER_STATUS_CHANGED)).toEqual([]);
  });

  it('records the decision in the audit log', async () => {
    const world = escalated();

    await world.escalations.resolve(admin, 'task-1', notDelivered);

    expect(auditRows(world)).toEqual([
      expect.objectContaining({
        actor: { connect: { id: 'admin-1' } },
        action: 'TASK_RESOLVED',
        targetId: 'task-1',
        detail: expect.objectContaining({
          outcome: 'NOT_DELIVERED',
          note: NOTE,
          escalationReason: 'OTP attempts exhausted',
          riderFeeMinor: 0,
        }),
      }),
    ]);
  });

  it('tells the requester, the rider and the shop, and not the college', async () => {
    const world = escalated();

    await world.escalations.resolve(admin, 'task-1', notDelivered);

    const [taskEvent] = world.server.of(wsEvents.TASK_STATUS_CHANGED);
    expect([...taskEvent!.rooms].sort()).toEqual([
      'user:owner-1',
      'user:rider-1',
      'user:staff-1',
      'user:student-1',
    ]);
    expect(taskEvent!.payload).toEqual({ taskId: 'task-1', status: 'CANCELLED', resolvedBy: 'ADMIN' });
    expect(world.server.of(wsEvents.ORDER_STATUS_CHANGED)[0]!.payload).toEqual({
      orderId: 'order-1',
      status: 'CANCELLED',
      resolvedBy: 'ADMIN',
    });
    expect(world.server.toCollegeRooms()).toEqual([]);
  });

  describe('a wallet-paid order', () => {
    /**
     * The student's money is on hold. Cancelling the order means giving it
     * back — by the orders module's own refund (adminCancelInTransaction),
     * inside this resolution's transaction, so the cancel, the refund and the
     * record of who decided commit or roll back as one.
     */
    const HEAD_AT = new Date(Date.now() + 3_600_000);

    function walletOrder() {
      const world = escalated({}, { paymentMethod: 'WALLET', paymentStatus: 'HELD' });
      // The student's ledger: 2,000 left after the 14,500 hold.
      world.prisma.$seed('walletEntry', [
        { id: 'entry-hold', userId: 'student-1', type: 'ORDER_HOLD', balanceAfterMinor: 2_000, createdAt: HEAD_AT },
      ]);
      return world;
    }

    const releases = (world: World) =>
      world.prisma.$rows('walletEntry').filter((e: any) => e.type === 'ORDER_RELEASE');

    it('is cancelled and the hold refunded in full', async () => {
      const world = walletOrder();

      const result = await world.escalations.resolve(admin, 'task-1', notDelivered);

      expect(result).toMatchObject({
        outcome: 'NOT_DELIVERED',
        status: 'CANCELLED',
        orderStatus: 'CANCELLED',
        riderFeeMinor: 0,
        refundedMinor: 14_500,
      });
      expect(world.task).toMatchObject({ status: 'CANCELLED', resolutionNote: NOTE });
      expect(world.order).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'ADMIN',
        cancelledReason: NOTE,
        paymentStatus: 'REFUNDED',
      });
      expect(releases(world)).toEqual([
        expect.objectContaining({
          userId: 'student-1',
          direction: 'CREDIT',
          amountMinor: 14_500,
          orderId: 'order-1',
          balanceAfterMinor: 16_500,
        }),
      ]);
      // The rider is paid nothing for a delivery that was not made.
      expect(world.prisma.$rows('walletEntry').filter((e: any) => e.userId === 'rider-1')).toEqual([]);
    });

    it('leaves two audit rows: the money that moved, and the decision', async () => {
      const world = walletOrder();

      await world.escalations.resolve(admin, 'task-1', notDelivered);

      const rows = auditRows(world);
      expect(rows.map((r: any) => [r.action, r.targetType, r.targetId])).toEqual([
        ['WALLET_ADJUSTED', 'order', 'order-1'],
        ['TASK_RESOLVED', 'task', 'task-1'],
      ]);
      for (const row of rows) expect(row.actor).toEqual({ connect: { id: 'admin-1' } });
      expect(rows[1].detail).toMatchObject({ outcome: 'NOT_DELIVERED', note: NOTE, refundedMinor: 14_500 });
    });

    it('takes the student\'s wallet lock before writing any row', async () => {
      // Every wallet writer locks first and writes rows second. A resolution
      // that updated the task row and *then* waited for the wallet lock could
      // deadlock against a settlement holding that lock and waiting for the
      // same task row.
      const world = walletOrder();

      await world.escalations.resolve(admin, 'task-1', notDelivered);

      // Only ever the student's wallet. (The orders module asks for the same
      // lock again before its own write; a transaction that already holds an
      // advisory lock is given it at once, so the second ask is a no-op.)
      expect(world.prisma.$locks.length).toBeGreaterThan(0);
      expect([...new Set(world.prisma.$locks)]).toEqual(['student-1']);

      const firstCall = (mock: jest.Mock) => mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
      const lockedAt = firstCall(world.prisma.$executeRaw);
      const writes = {
        'task.updateMany': world.prisma.task.updateMany,
        'order.updateMany': world.prisma.order.updateMany,
        'walletEntry.create': world.prisma.walletEntry.create,
        'auditLog.create': world.prisma.auditLog.create,
        'riderState.updateMany': world.prisma.riderState.updateMany,
        'chatRoom.updateMany': world.prisma.chatRoom.updateMany,
      };
      for (const [name, mock] of Object.entries(writes)) {
        // Each of these really was called — or the comparison means nothing.
        expect([name, mock.mock.calls.length > 0]).toEqual([name, true]);
        expect([name, lockedAt < firstCall(mock)]).toEqual([name, true]);
      }
    });

    it('refunds nothing on a second resolution', async () => {
      const world = walletOrder();
      await world.escalations.resolve(admin, 'task-1', notDelivered);
      const balance = () => world.prisma.$rows('walletEntry').at(-1).balanceAfterMinor;
      expect(balance()).toBe(16_500);

      for (const dto of [notDelivered, delivered]) {
        expect(await codeOf(world.escalations.resolve(otherAdmin, 'task-1', dto))).toBe('ALREADY_RESOLVED');
      }

      expect(releases(world)).toHaveLength(1);
      expect(balance()).toBe(16_500);
      expect(auditRows(world)).toHaveLength(2);
    });

    it('refunds nothing when another administrator resolved it a moment ago', async () => {
      // Both read ESCALATED; the other committed first. This request reaches
      // its conditional UPDATE with a stale read.
      const world = walletOrder();
      const asBothRead = { ...world.task, order: { ...world.order } };
      await world.escalations.resolve(admin, 'task-1', notDelivered);

      world.prisma.$staleRead('task', asBothRead);
      expect(await codeOf(world.escalations.resolve(otherAdmin, 'task-1', notDelivered))).toBe(
        'ALREADY_RESOLVED',
      );

      expect(releases(world)).toHaveLength(1);
      expect(auditRows(world)).toHaveLength(2);
    });

    it('does not refund a delivery that was settled a moment ago', async () => {
      const world = walletOrder();
      const asBothRead = { ...world.task, order: { ...world.order } };
      await world.escalations.resolve(admin, 'task-1', delivered);

      world.prisma.$staleRead('task', asBothRead);
      expect(await codeOf(world.escalations.resolve(otherAdmin, 'task-1', notDelivered))).toBe(
        'ALREADY_RESOLVED',
      );

      expect(releases(world)).toEqual([]);
      expect(world.order).toMatchObject({ status: 'COMPLETED', paymentStatus: 'CAPTURED' });
    });

    it('rolls the task back when the order has moved on — the refund\'s STATE_CHANGED', async () => {
      // The task is ESCALATED but its order is no longer PICKED_UP. The
      // orders module refuses to cancel it and writes nothing; this
      // resolution must then undo its own task UPDATE and refund nothing.
      const world = walletOrder();
      world.order!.status = 'COMPLETED';
      const [taskBefore, orderBefore] = [{ ...world.task }, { ...world.order }];
      const ledgerBefore = world.prisma.$rows('walletEntry').length;

      expect(await codeOf(world.escalations.resolve(admin, 'task-1', notDelivered))).toBe(
        'ORDER_NOT_AWAITING_HANDOVER',
      );

      expect(world.task).toEqual(taskBefore);
      expect(world.task.status).toBe('ESCALATED');
      expect(world.order).toEqual(orderBefore);
      expect(world.prisma.$rows('walletEntry')).toHaveLength(ledgerBefore);
      expect(auditRows(world)).toEqual([]);
      expect(world.room.isArchived).toBe(false);
      expect(world.server.emissions).toEqual([]);
    });

    it('refunds nothing if the decision\'s own audit row cannot be written', async () => {
      // The refund (and its WALLET_ADJUSTED row) are written first; the
      // TASK_RESOLVED row last. If that last write fails, all of it goes.
      const world = walletOrder();
      const create = world.prisma.auditLog.create.getMockImplementation()!;
      world.prisma.auditLog.create.mockImplementation(async (args: any) => {
        if (args.data.action === 'TASK_RESOLVED') throw new Error('audit_log unavailable');
        return create(args);
      });

      await expect(world.escalations.resolve(admin, 'task-1', notDelivered)).rejects.toThrow(
        'audit_log unavailable',
      );

      expect(world.task.status).toBe('ESCALATED');
      expect(world.order).toMatchObject({ status: 'PICKED_UP', paymentStatus: 'HELD' });
      expect(releases(world)).toEqual([]);
      expect(auditRows(world)).toEqual([]);
    });
  });

  it('refunds nothing on a cash order, where nothing was held', async () => {
    const world = escalated();

    const result = await world.escalations.resolve(admin, 'task-1', notDelivered);

    expect(result.refundedMinor).toBe(0);
    expect(world.order!.paymentStatus).toBe('NOT_REQUIRED');
    expect(auditRows(world).map((r: any) => r.action)).toEqual(['TASK_RESOLVED']);
  });

  it('changes nothing when the order is not PICKED_UP — the order\'s `status`', async () => {
    const world = escalated({}, { status: 'COMPLETED' });
    const [taskBefore, orderBefore] = [{ ...world.task }, { ...world.order }];

    expect(await codeOf(world.escalations.resolve(admin, 'task-1', notDelivered))).toBe(
      'ORDER_NOT_AWAITING_HANDOVER',
    );

    expectUntouched(world, taskBefore, orderBefore);
  });

  it('leaves alone a different task the rider has since taken — `activeTaskId: taskId`', async () => {
    const world = escalated();
    world.state.activeTaskId = 'task-newer';

    await world.escalations.resolve(admin, 'task-1', notDelivered);

    expect(world.state.activeTaskId).toBe('task-newer');
  });

  it('cancels nothing if the audit row cannot be written', async () => {
    const world = escalated();
    const [taskBefore, orderBefore] = [{ ...world.task }, { ...world.order }];
    world.prisma.auditLog.create.mockRejectedValueOnce(new Error('audit_log unavailable'));

    await expect(world.escalations.resolve(admin, 'task-1', notDelivered)).rejects.toThrow(
      'audit_log unavailable',
    );

    expectUntouched(world, taskBefore, orderBefore);
    expect(world.room.isArchived).toBe(false);
  });
});

// ===========================================================================
// Only once, and only mine
// ===========================================================================

describe('a second resolution', () => {
  it.each([
    ['DELIVERED then DELIVERED', delivered, delivered],
    ['DELIVERED then NOT_DELIVERED', delivered, notDelivered],
    ['NOT_DELIVERED then DELIVERED', notDelivered, delivered],
    ['NOT_DELIVERED then NOT_DELIVERED', notDelivered, notDelivered],
  ])('%s: the second is refused and changes nothing', async (_name, first, second) => {
    const world = escalated();
    await world.escalations.resolve(admin, 'task-1', first);

    const after = {
      task: { ...world.task },
      order: { ...world.order },
      ledger: ledger(world),
      audit: auditRows(world).length,
      events: world.server.emissions.length,
    };

    expect(await codeOf(world.escalations.resolve(otherAdmin, 'task-1', second))).toBe('ALREADY_RESOLVED');

    expect(world.task).toEqual(after.task);
    expect(world.order).toEqual(after.order);
    expect(ledger(world)).toEqual(after.ledger);
    expect(auditRows(world)).toHaveLength(after.audit);
    expect(world.server.emissions).toHaveLength(after.events);
  });

  describe('arriving while the first is committing', () => {
    /**
     * Two administrators have the same row open. Both requests read
     * ESCALATED; one commits. This is the other, reaching its conditional
     * UPDATE with a read that is now stale — the status in the WHERE is all
     * that stands between the rider and a second payout.
     */
    async function raceLostTo(first: ResolveEscalationDto, second: ResolveEscalationDto) {
      const world = escalated();
      const asBothRead = { ...world.task, order: { ...world.order } };

      await world.escalations.resolve(admin, 'task-1', first);
      const after = { task: { ...world.task }, ledger: ledger(world), audit: auditRows(world).length };

      world.prisma.$staleRead('task', asBothRead);
      expect(await codeOf(world.escalations.resolve(otherAdmin, 'task-1', second))).toBe('ALREADY_RESOLVED');

      expect(world.task).toEqual(after.task);
      expect(ledger(world)).toEqual(after.ledger);
      expect(auditRows(world)).toHaveLength(after.audit);
      return world;
    }

    it('does not pay the rider twice — DELIVERED vs DELIVERED', async () => {
      const world = await raceLostTo(delivered, delivered);

      expect(ledger(world)).toHaveLength(1);
      expect(world.prisma.$rows('riderReliability')[0].tasksCompleted).toBe(1);
    });

    it('does not pay for a delivery already ruled not made — NOT_DELIVERED vs DELIVERED', async () => {
      const world = await raceLostTo(notDelivered, delivered);

      expect(world.task.status).toBe('CANCELLED');
      expect(ledger(world)).toEqual([]);
    });

    it('does not cancel a delivery already settled — DELIVERED vs NOT_DELIVERED', async () => {
      const world = await raceLostTo(delivered, notDelivered);

      expect(world.task.status).toBe('COMPLETED');
      expect(world.order!.status).toBe('COMPLETED');
    });
  });
});

describe('what may be resolved, and by whom', () => {
  it('refuses another college\'s administrator, and changes nothing', async () => {
    const world = escalated();
    const [taskBefore, orderBefore] = [{ ...world.task }, { ...world.order }];

    for (const dto of [delivered, notDelivered]) {
      expect(await codeOf(world.escalations.resolve(foreignAdmin, 'task-1', dto))).toBe(
        'CROSS_TENANT_ACCESS',
      );
    }

    expectUntouched(world, taskBefore, orderBefore);
  });

  it('lets a super administrator resolve any college\'s, recorded under that college', async () => {
    const world = escalated();

    await world.escalations.resolve(superAdmin, 'task-1', delivered);

    expect(world.task.status).toBe('COMPLETED');
    expect(auditRows(world)[0]).toMatchObject({ actor: { connect: { id: 'root' } }, collegeId: 'col-1' });
  });

  it.each(['PICKED_UP', 'ASSIGNED', 'BROADCASTING'])(
    'refuses a %s task that never escalated — it is the rider\'s to finish',
    async (status) => {
      const world = escalated({ status, escalatedAt: null, resolutionNote: null });
      const [taskBefore, orderBefore] = [{ ...world.task }, { ...world.order }];

      for (const dto of [delivered, notDelivered]) {
        expect(await codeOf(world.escalations.resolve(admin, 'task-1', dto))).toBe('NOT_ESCALATED');
      }

      expectUntouched(world, taskBefore, orderBefore);
    },
  );

  it('does not settle a task that is being carried, even on a stale read — `status: ESCALATED`', async () => {
    // The read says ESCALATED; the row is PICKED_UP. Without the status in
    // the UPDATE an administrator could complete a delivery in progress.
    const world = escalated({ status: 'PICKED_UP' });
    const [taskBefore, orderBefore] = [{ ...world.task }, { ...world.order }];

    for (const dto of [delivered, notDelivered]) {
      world.prisma.$staleRead('task', { ...world.task, status: 'ESCALATED', order: { ...world.order } });
      expect(await codeOf(world.escalations.resolve(admin, 'task-1', dto))).toBe('ALREADY_RESOLVED');
    }

    expectUntouched(world, taskBefore, orderBefore);
  });

  it('answers 404 for a task that does not exist', async () => {
    const world = escalated();

    await expect(world.escalations.resolve(admin, 'no-such-task', delivered)).rejects.toMatchObject({
      status: 404,
    });
  });
});
