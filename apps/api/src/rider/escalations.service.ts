import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TaskEvent, TaskStatus, assertTaskTransition } from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { TenantService } from '../common/tenant/tenant.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { OrdersService } from '../orders/orders.service';
import { lockWallets } from '../wallet/wallet-ledger';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { RiderService } from './rider.service';
import type { EscalationOutcome, ResolveEscalationDto } from './dto/escalation.dto';

/**
 * Everything the console needs to decide an escalation without leaving the
 * row (FR-ADM-02) — and nothing it does not: no handover-code hash.
 */
const ESCALATION_SELECT = {
  id: true,
  collegeId: true,
  type: true,
  status: true,
  escalatedAt: true,
  resolutionNote: true,
  otpAttempts: true,
  assignedAt: true,
  pickedUpAt: true,
  createdAt: true,
  completedAt: true,
  cancelledAt: true,
  pickupLabel: true,
  dropLabel: true,
  feeMinor: true,
  reimbursementMinor: true,
  riderId: true,
  requester: { select: { id: true, name: true, mobile: true } },
  rider: { select: { id: true, name: true, mobile: true, status: true } },
  college: { select: { config: { select: { maxOtpAttempts: true } } } },
  order: {
    select: {
      id: true,
      reference: true,
      status: true,
      paymentMethod: true,
      paymentStatus: true,
      studentId: true,
      itemsSubtotalMinor: true,
      deliveryFeeMinor: true,
      totalMinor: true,
      items: { select: { nameSnapshot: true, quantity: true } },
      shopListing: { select: { shop: { select: { name: true } } } },
    },
  },
} as const;

/**
 * FR-ADM-04: the way out of ESCALATED.
 *
 * A task escalates when the handover cannot be completed by the two people
 * at the door — five wrong codes (FR-DLV-14), or the rider suspended while
 * carrying the order. From then on only an administrator can say what
 * happened, and until this existed nothing could: the task sat ESCALATED for
 * ever, the order with it, the rider unpaid for a delivery they may well
 * have made.
 *
 * Two outcomes:
 *
 *  - **DELIVERED** — the goods reached the requester. Settled by
 *    `RiderService.settleDelivery`, the same code a correct handover code
 *    runs, so the rider is paid exactly what they would have been.
 *  - **NOT_DELIVERED** — they did not. The task and order are cancelled, a
 *    wallet hold is refunded to the student in full (by the orders module's
 *    own refund, not a copy of it), and the rider is paid nothing.
 *
 * The SRS lists a third, "disputed". There is no such state in the task
 * state machine, so it is not offered; see A2-CONTRACT-escalations.md.
 *
 * As everywhere in this module (ADR-001), the decision is one conditional
 * UPDATE: `WHERE status = 'ESCALATED'`. Two administrators can open the same
 * row and press different buttons; exactly one of them changes it, and the
 * other is told it has been resolved.
 */
@Injectable()
export class EscalationsService {
  private readonly logger = new Logger(EscalationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly audit: AuditService,
    private readonly rider: RiderService,
    private readonly dispatch: DispatchService,
    private readonly orders: OrdersService,
  ) {}

  // =======================================================================
  // Reading (A-08)
  // =======================================================================

  /** Escalated tasks for the caller's college, the longest-waiting first. */
  async list(user: AuthenticatedUser, limit = 25, cursor?: string) {
    const rows = await this.prisma.task.findMany({
      // C-1: `scope` pins an ADMIN to their own college. Nobody writes
      // `collegeId` by hand here, so nobody can forget to.
      where: { ...this.tenant.scope(user), status: 'ESCALATED' },
      select: ESCALATION_SELECT,
      // `id` breaks ties so a page boundary between two tasks escalated in
      // the same millisecond is stable.
      orderBy: [{ escalatedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: page.map((row) => this.present(row)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  /**
   * One escalation — including one that has since been resolved, so the
   * administrator who lost a race can see how it ended.
   */
  async detail(user: AuthenticatedUser, taskId: string) {
    const row = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: ESCALATION_SELECT,
    });

    const task = this.tenant.assertSameTenant(user, row, 'Task');

    // `escalatedAt` is written when a task escalates and never cleared, so it
    // is the record that this task was ever any of this endpoint's business.
    if (!task.escalatedAt) throw this.notEscalated();

    return this.present(task);
  }

  // =======================================================================
  // Resolving
  // =======================================================================

  async resolve(user: AuthenticatedUser, taskId: string, dto: ResolveEscalationDto) {
    const row = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        collegeId: true,
        status: true,
        riderId: true,
        escalatedAt: true,
        resolutionNote: true,
        order: {
          select: { id: true, status: true, paymentMethod: true, studentId: true, reference: true },
        },
      },
    });

    const task = this.tenant.assertSameTenant(user, row, 'Task');

    // A readable answer for the common cases. Not the guard: the conditional
    // UPDATE in each branch below is, and it would refuse all of these.
    if (task.status !== 'ESCALATED') {
      throw task.escalatedAt ? this.alreadyResolved() : this.notEscalated();
    }

    // The CHECK constraint guarantees an ESCALATED task has a rider; this is
    // for the type, and for the day that constraint is edited.
    if (!task.riderId) throw this.notEscalated();

    const context = {
      adminId: user.userId,
      taskId,
      collegeId: task.collegeId,
      riderId: task.riderId,
      // What the task said when it escalated. `resolutionNote` is about to
      // be overwritten with the administrator's note, so it is carried into
      // the audit row rather than lost.
      escalationReason: task.resolutionNote,
      note: dto.note,
      order: task.order,
    };

    return dto.outcome === 'DELIVERED'
      ? this.resolveDelivered(context)
      : this.resolveNotDelivered(context);
  }

  /**
   * The goods arrived. Settle the delivery exactly as the handover code
   * would have — same function, same transaction shape, same ledger entries.
   */
  private async resolveDelivered(context: ResolutionContext) {
    const { adminId, taskId, collegeId, riderId, order, note } = context;

    const settled = await this.rider.settleDelivery(riderId, taskId, collegeId, {
      from: 'ESCALATED',
      walletStudentId: order?.paymentMethod === 'WALLET' ? order.studentId : null,
      taskData: { resolutionNote: note },
      whenAlreadySettled: () => this.alreadyResolved(),
      // FR-ADM-06: the audit row is written in the settlement's transaction.
      // A settled delivery with no record of who decided it, or a record of
      // a decision that then rolled back, are both worse than a failed request.
      alsoInTransaction: (tx, result) =>
        this.audit.recordInTransaction(tx, {
          actorId: adminId,
          collegeId,
          action: AuditAction.TASK_RESOLVED,
          targetType: 'task',
          targetId: taskId,
          detail: this.auditDetail(context, 'DELIVERED', result.feeMinor),
        }),
      notifyExtra: { resolvedBy: 'ADMIN' },
    });

    if (order) {
      await this.dispatch.notifyOrderParties(taskId, order.id, 'COMPLETED', { resolvedBy: 'ADMIN' });
    }

    this.logger.warn(`Escalated task ${taskId} resolved DELIVERED by ${adminId}`);

    return {
      taskId,
      outcome: 'DELIVERED' as EscalationOutcome,
      status: 'COMPLETED',
      orderStatus: order ? 'COMPLETED' : null,
      resolvedAt: settled.settledAt,
      riderFeeMinor: settled.feeMinor,
      settledInCash: settled.isCash,
      refundedMinor: 0,
      message: 'Marked delivered. The rider has been settled.',
    };
  }

  /**
   * The goods did not arrive. Cancel the task and its order, give a wallet
   * hold back to the student, pay the rider nothing.
   *
   * The order and its money belong to the orders module, so the cancellation
   * and the refund are its code (`OrdersService.adminCancelInTransaction`),
   * run inside this transaction: one implementation of "refund an order", and
   * the task, the order, the ledger entry and both audit rows commit or roll
   * back together. It handles a cash order too — cancelled, nothing to refund.
   *
   * The order of statements is deliberate:
   *
   *  1. **The wallet lock, before any row is written.** The rule every
   *     wallet writer follows (see `lockWallets`): wallet locks first, rows
   *     second. A resolution that updated the task row and only then waited
   *     for the student's wallet could deadlock against a settlement holding
   *     that wallet and waiting for the same task row. Taken for any order,
   *     cash included — it costs nothing, and whether a lock is needed then
   *     does not rest on a payment method read before the transaction began.
   *  2. **The conditional task UPDATE**, `WHERE status = 'ESCALATED'`. This
   *     is the decision (ADR-001): of two administrators, or an administrator
   *     and anything else, exactly one matches the row. The loser stops here,
   *     told ALREADY_RESOLVED, before the order or the ledger is touched.
   *  3. **The order's cancellation and refund.** If the order is not where an
   *     escalated task's order should be, it reports STATE_CHANGED having
   *     written nothing, and throwing rolls step 2 back with it.
   */
  private async resolveNotDelivered(context: ResolutionContext) {
    const { adminId, taskId, collegeId, riderId, order, note } = context;

    const now = new Date();

    const refundedMinor = await this.prisma.$transaction(async (tx) => {
      // 1. Locks first.
      if (order) await lockWallets(tx, [order.studentId]);

      assertTaskTransition(TaskStatus.ESCALATED, TaskEvent.ADMIN_RESOLVED_CANCELLED);

      // 2. The decision.
      const cancelled = await tx.task.updateMany({
        where: { id: taskId, status: 'ESCALATED' },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          resolutionNote: note,
          // No handover will happen now; the code is dead.
          otpHash: null,
        },
      });
      if (cancelled.count !== 1) throw this.alreadyResolved();

      // 3. The order, and the student's money.
      let refunded = 0;
      if (order) {
        const result = await this.orders.adminCancelInTransaction(tx, {
          orderId: order.id,
          adminUserId: adminId,
          reason: note,
        });
        // STATE_CHANGED or ORDER_NOT_FOUND: nothing was written by the orders
        // module, and nothing may be kept of what was written above.
        if (result.outcome !== 'CANCELLED') throw this.orderNotAwaitingHandover();
        refunded = result.refundedMinor;
      }

      // Escalation released the rider already; this covers a task that
      // escalated by another route, and only ever clears *this* task.
      await tx.riderState.updateMany({
        where: { userId: riderId, activeTaskId: taskId },
        data: { activeTaskId: null },
      });

      // Close the task's chat room to new messages, keeping its history.
      await tx.chatRoom.updateMany({
        where: { taskId, isArchived: false },
        data: { isArchived: true, archivedAt: now },
      });

      // FR-ADM-06. The orders module has already written its own row
      // (WALLET_ADJUSTED) if money moved; this one records the decision
      // about the task. Two rows, two different facts.
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        collegeId,
        action: AuditAction.TASK_RESOLVED,
        targetType: 'task',
        targetId: taskId,
        detail: this.auditDetail(context, 'NOT_DELIVERED', 0, refunded),
      });

      return refunded;
    });

    await this.rider.freeRiderInRedis(collegeId, riderId);

    await this.dispatch.notifyTaskParties(taskId, 'CANCELLED', { resolvedBy: 'ADMIN' });
    if (order) {
      await this.dispatch.notifyOrderParties(taskId, order.id, 'CANCELLED', { resolvedBy: 'ADMIN' });
    }

    this.logger.warn(
      `Escalated task ${taskId} resolved NOT_DELIVERED by ${adminId}; refunded ${refundedMinor}`,
    );

    return {
      taskId,
      outcome: 'NOT_DELIVERED' as EscalationOutcome,
      status: 'CANCELLED',
      orderStatus: order ? 'CANCELLED' : null,
      resolvedAt: now,
      riderFeeMinor: 0,
      settledInCash: false,
      refundedMinor,
      message:
        refundedMinor > 0
          ? 'Marked not delivered. The order is cancelled and the student has been refunded in full.'
          : 'Marked not delivered. The task and its order are cancelled; nothing was paid.',
    };
  }

  // =======================================================================
  // Shapes and refusals
  // =======================================================================

  private auditDetail(
    context: ResolutionContext,
    outcome: EscalationOutcome,
    riderFeeMinor: number,
    refundedMinor = 0,
  ) {
    return {
      outcome,
      note: context.note,
      escalationReason: context.escalationReason,
      riderId: context.riderId,
      orderId: context.order?.id ?? null,
      riderFeeMinor,
      refundedMinor,
    };
  }

  /** The outcomes the server will accept for a task as it stands. */
  private resolvableAs(status: string): EscalationOutcome[] {
    return status === 'ESCALATED' ? ['DELIVERED', 'NOT_DELIVERED'] : [];
  }

  private present(task: EscalationRow) {
    const resolved = task.status !== 'ESCALATED';

    // The client is promised `rider` is never null, and it is right to be:
    // a task that escalated had a rider (the CHECK constraint
    // task_rider_presence_matches_status requires one while ESCALATED), and
    // neither resolution removes them. So a missing rider is corrupt data,
    // not a case to render — fail here, loudly and with the task id, rather
    // than hand the console a null it was told could not happen.
    if (!task.rider) {
      throw new InternalServerErrorException({
        code: 'ESCALATION_HAS_NO_RIDER',
        message: `Escalated task ${task.id} has no rider, which should be impossible.`,
      });
    }

    return {
      taskId: task.id,
      type: task.type,
      status: task.status,
      escalatedAt: task.escalatedAt,
      // While escalated, `resolutionNote` holds why it escalated; once
      // resolved it holds the administrator's note.
      escalationReason: resolved ? null : task.resolutionNote,
      ...(resolved
        ? { resolutionNote: task.resolutionNote, resolvedAt: task.completedAt ?? task.cancelledAt }
        : {}),
      otpAttempts: task.otpAttempts,
      maxOtpAttempts: task.college.config?.maxOtpAttempts ?? 5,
      assignedAt: task.assignedAt,
      pickedUpAt: task.pickedUpAt,
      createdAt: task.createdAt,
      pickupLabel: task.pickupLabel,
      dropLabel: task.dropLabel,
      feeMinor: task.feeMinor,
      reimbursementMinor: task.reimbursementMinor,
      requester: task.requester,
      rider: task.rider,
      order: task.order
        ? {
            id: task.order.id,
            reference: task.order.reference,
            status: task.order.status,
            paymentMethod: task.order.paymentMethod,
            paymentStatus: task.order.paymentStatus,
            itemsSubtotalMinor: task.order.itemsSubtotalMinor,
            deliveryFeeMinor: task.order.deliveryFeeMinor,
            totalMinor: task.order.totalMinor,
            shopName: task.order.shopListing.shop.name,
            items: task.order.items.map((item) => ({
              name: item.nameSnapshot,
              quantity: item.quantity,
            })),
          }
        : null,
      canResolveAs: this.resolvableAs(task.status),
    };
  }

  private alreadyResolved(): ConflictException {
    return new ConflictException({
      code: 'ALREADY_RESOLVED',
      message: 'This escalation has already been resolved. Reload it to see how.',
    });
  }

  private notEscalated(): ConflictException {
    return new ConflictException({
      code: 'NOT_ESCALATED',
      message: 'That task is not an escalated task.',
    });
  }

  private orderNotAwaitingHandover(): ConflictException {
    return new ConflictException({
      code: 'ORDER_NOT_AWAITING_HANDOVER',
      message: 'The order for this task is no longer awaiting handover, so nothing was changed.',
    });
  }
}

interface ResolutionContext {
  adminId: string;
  taskId: string;
  collegeId: string;
  riderId: string;
  escalationReason: string | null;
  note: string;
  order: {
    id: string;
    status: string;
    paymentMethod: string;
    studentId: string;
    reference: string;
  } | null;
}

/** A task row as ESCALATION_SELECT returns it. */
type EscalationRow = Prisma.TaskGetPayload<{ select: typeof ESCALATION_SELECT }>;
