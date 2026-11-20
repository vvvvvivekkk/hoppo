import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import {
  HANDOVER_OTP_LENGTH,
  OrderEvent,
  OrderStatus,
  TaskEvent,
  TaskStatus,
  assertOrderTransition,
  assertTaskTransition,
  formatMinor,
  RIDER_TERMS_VERSION,
} from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { TenantService } from '../common/tenant/tenant.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { DispatchGateway } from '../dispatch/dispatch.gateway';
import { presenceHour, recordRiderPresence } from '../dispatch/rider-presence';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { lockWallets, readWalletHead } from '../wallet/wallet-ledger';
import { acceptanceRateBps, acceptanceRatePercent } from './acceptance-rate';
import type {
  AbandonTaskDto,
  ConfirmPickupDto,
  SetWorkModeDto,
  SubmitHandoverOtpDto,
} from './dto/rider.dto';

/**
 * How a delivery comes to be settled. There are exactly two ways, and they
 * share one implementation (`RiderService.settleDelivery`):
 *
 *  - the rider enters the correct handover code — the task is PICKED_UP;
 *  - an administrator resolves an escalated task as delivered (FR-ADM-04) —
 *    the task is ESCALATED.
 *
 * Everything else about settlement — the wallet locks, the ledger entries,
 * the order, the reliability counters — is identical, and must stay
 * identical: an administrator's "this was delivered" has to pay the rider
 * exactly what the handover code would have.
 */
export interface SettlementOptions {
  /** The state the task must be in. The conditional UPDATE is on this. */
  from: 'PICKED_UP' | 'ESCALATED';
  /**
   * The student whose wallet holds the order's money, or null. Known before
   * the transaction starts because it decides which wallets to lock.
   */
  walletStudentId: string | null;
  /** Further columns set by the same conditional UPDATE — a resolution note. */
  taskData?: Pick<Prisma.TaskUpdateManyMutationInput, 'resolutionNote'>;
  /** The refusal to throw when the conditional UPDATE matches no row. */
  whenAlreadySettled: () => Error;
  /**
   * More work for the same transaction, after the money has been written and
   * before it commits — an audit row that must not exist without the
   * settlement, nor the settlement without it.
   */
  alsoInTransaction?: (tx: Prisma.TransactionClient, settled: SettledDelivery) => Promise<void>;
  /** Extra fields for the `task:status` event. */
  notifyExtra?: Record<string, unknown>;
}

export interface SettledDelivery {
  settledAt: Date;
  feeMinor: number;
  /** True when the fee was taken in cash at the door rather than credited (ADR-006). */
  isCash: boolean;
  orderId: string | null;
  orderReference: string | null;
  reimbursementMinor: number;
}

@Injectable()
export class RiderService {
  private readonly logger = new Logger(RiderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly tenant: TenantService,
    private readonly dispatch: DispatchService,
    private readonly gateway: DispatchGateway,
  ) {}

  // =======================================================================
  // Work mode — FR-WM-01 .. FR-WM-08
  // =======================================================================

  /** S-25, S-26: the Work tab. */
  async workStatus(user: AuthenticatedUser) {
    const collegeId = this.tenant.requireCollegeId(user);

    const [state, profile, reliability, config] = await Promise.all([
      this.prisma.riderState.findUnique({
        where: { userId: user.userId },
        select: {
          workModeOn: true,
          workModeOnAt: true,
          lastPingAt: true,
          activeTaskId: true,
          barredUntil: true,
        },
      }),
      this.prisma.studentProfile.findUnique({
        where: { userId: user.userId },
        select: { verificationStatus: true, riderTermsAcceptedAt: true, riderTermsVersion: true },
      }),
      this.prisma.riderReliability.findUnique({
        where: { userId: user.userId },
        select: {
          tasksOffered: true,
          tasksAccepted: true,
          tasksCompleted: true,
          tasksAbandoned: true,
          acceptanceRateBps: true,
          ratingSum: true,
          ratingCount: true,
        },
      }),
      this.prisma.collegeConfig.findUnique({
        where: { collegeId },
        select: { workModeIdleTimeoutMinutes: true, riderPingIntervalSeconds: true },
      }),
    ]);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    // FR-WM-08: lifetime and current-day totals.
    const [todayEarnings, lifetimeEarnings, todayTasks] = await Promise.all([
      this.prisma.walletEntry.aggregate({
        where: {
          userId: user.userId,
          type: 'DELIVERY_FEE_EARNED',
          createdAt: { gte: startOfDay },
        },
        _sum: { amountMinor: true },
        _count: true,
      }),
      this.prisma.walletEntry.aggregate({
        where: { userId: user.userId, type: 'DELIVERY_FEE_EARNED' },
        _sum: { amountMinor: true },
      }),
      this.prisma.task.count({
        where: { riderId: user.userId, status: 'COMPLETED', completedAt: { gte: startOfDay } },
      }),
    ]);

    const activeTask = state?.activeTaskId
      ? await this.activeTaskDetail(user, state.activeTaskId)
      : null;

    const barred = state?.barredUntil && state.barredUntil.getTime() > Date.now();

    return {
      workModeOn: state?.workModeOn ?? false,
      workModeOnAt: state?.workModeOnAt ?? null,
      lastPingAt: state?.lastPingAt ?? null,
      // FR-WM-01, FR-WM-02: what still has to be true before riding.
      canEnable: {
        verified: profile?.verificationStatus === 'VERIFIED',
        termsAccepted: Boolean(profile?.riderTermsAcceptedAt),
        termsVersionCurrent: profile?.riderTermsVersion === RIDER_TERMS_VERSION,
        notBarred: !barred,
      },
      barredUntil: barred ? state!.barredUntil : null,
      pingIntervalSeconds: config?.riderPingIntervalSeconds ?? 15,
      idleTimeoutMinutes: config?.workModeIdleTimeoutMinutes ?? 120,
      activeTask,
      today: {
        completedTasks: todayTasks,
        earningsMinor: todayEarnings._sum.amountMinor ?? 0,
        earningsLabel: formatMinor(todayEarnings._sum.amountMinor ?? 0),
      },
      lifetime: {
        completedTasks: reliability?.tasksCompleted ?? 0,
        earningsMinor: lifetimeEarnings._sum.amountMinor ?? 0,
        earningsLabel: formatMinor(lifetimeEarnings._sum.amountMinor ?? 0),
        // Clamped to 0..100 and null when nothing was ever offered — see
        // acceptanceRatePercent for why the plain ratio is wrong on old rows.
        acceptanceRate: acceptanceRatePercent(
          reliability?.tasksOffered ?? 0,
          reliability?.tasksAccepted ?? 0,
        ),
        abandonedTasks: reliability?.tasksAbandoned ?? 0,
        averageRating:
          (reliability?.ratingCount ?? 0) > 0
            ? Number((reliability!.ratingSum / reliability!.ratingCount).toFixed(1))
            : null,
      },
    };
  }

  /** FR-WM-01, FR-WM-02, FR-WM-05 */
  async setWorkMode(user: AuthenticatedUser, dto: SetWorkModeDto) {
    const collegeId = this.tenant.requireCollegeId(user);

    if (!dto.enabled) {
      // FR-WM-05: disabling takes effect immediately for new broadcasts, but
      // does not cancel a task already accepted. The rider who has somebody's
      // food still has to deliver it.
      const state = await this.prisma.riderState.findUnique({
        where: { userId: user.userId },
        select: { activeTaskId: true },
      });

      await this.prisma.riderState.updateMany({
        where: { userId: user.userId },
        data: { workModeOn: false },
      });

      await this.redis.removeRider(collegeId, user.userId);

      return {
        workModeOn: false,
        activeTaskId: state?.activeTaskId ?? null,
        message: state?.activeTaskId
          ? 'You are offline for new offers. Finish the task you are holding.'
          : 'You are offline. No new task offers will reach you.',
      };
    }

    // --- turning it on ----------------------------------------------------

    const profile = await this.prisma.studentProfile.findUnique({
      where: { userId: user.userId },
      select: { verificationStatus: true, riderTermsAcceptedAt: true, riderTermsVersion: true },
    });

    // FR-WM-01
    if (profile?.verificationStatus !== 'VERIFIED') {
      throw new ForbiddenException({
        code: 'VERIFICATION_REQUIRED',
        message: 'Your student verification must be approved before you can ride.',
      });
    }

    // FR-WM-02: acceptance is required on first use, and again when the terms
    // change — otherwise the recorded version stops meaning anything.
    if (!profile.riderTermsAcceptedAt || profile.riderTermsVersion !== RIDER_TERMS_VERSION) {
      throw new ForbiddenException({
        code: 'RIDER_TERMS_REQUIRED',
        message: 'Accept the current rider terms before going online.',
        details: { currentVersion: RIDER_TERMS_VERSION },
      });
    }

    const existing = await this.prisma.riderState.findUnique({
      where: { userId: user.userId },
      select: { barredUntil: true, activeTaskId: true },
    });

    // FR-TRST-05
    if (existing?.barredUntil && existing.barredUntil.getTime() > Date.now()) {
      const hours = Math.ceil((existing.barredUntil.getTime() - Date.now()) / 3_600_000);
      throw new ForbiddenException({
        code: 'RIDER_BARRED',
        message: `You cannot go online for another ${hours} hour${
          hours === 1 ? '' : 's'
        } because of repeated abandoned tasks.`,
        details: { barredUntil: existing.barredUntil },
      });
    }

    // FR-WM-03: a rider with no position cannot be matched to a pickup, so
    // the first position is required at the moment of going online rather
    // than waited for.
    if (dto.latitude === undefined || dto.longitude === undefined) {
      throw new BadRequestException({
        code: 'LOCATION_REQUIRED',
        message: 'Allow location access so nearby tasks can reach you.',
      });
    }

    const config = await this.prisma.collegeConfig.findUnique({
      where: { collegeId },
      select: { riderPingIntervalSeconds: true },
    });
    const intervalSeconds = config?.riderPingIntervalSeconds ?? 15;

    await this.prisma.riderState.upsert({
      where: { userId: user.userId },
      update: {
        workModeOn: true,
        workModeOnAt: new Date(),
        lastLatitude: dto.latitude,
        lastLongitude: dto.longitude,
        lastPingAt: new Date(),
      },
      create: {
        userId: user.userId,
        workModeOn: true,
        workModeOnAt: new Date(),
        lastLatitude: dto.latitude,
        lastLongitude: dto.longitude,
        lastPingAt: new Date(),
      },
    });

    // FR-ADM-05: going online, with a position, is being present this hour.
    await recordRiderPresence(this.prisma, collegeId, user.userId);

    await this.redis.setRiderPosition({
      collegeId,
      userId: user.userId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      ttlSeconds: intervalSeconds * 3,
    });

    // A rider who still holds a task stays excluded from broadcasts
    // (FR-WM-07), so going back online does not produce a second offer.
    if (existing?.activeTaskId) {
      await this.redis.markRiderBusy(collegeId, user.userId);
    } else {
      await this.redis.markRiderFree(collegeId, user.userId);
    }

    return {
      workModeOn: true,
      pingIntervalSeconds: intervalSeconds,
      activeTaskId: existing?.activeTaskId ?? null,
      message: 'You are online. Task offers will appear here.',
    };
  }

  /** FR-WM-03, as an HTTP fallback for when the socket is down. */
  async ping(user: AuthenticatedUser, latitude: number, longitude: number) {
    const collegeId = this.tenant.requireCollegeId(user);

    const state = await this.prisma.riderState.findUnique({
      where: { userId: user.userId },
      select: { workModeOn: true, lastPingAt: true },
    });

    if (!state?.workModeOn) {
      throw new ConflictException({
        code: 'WORK_MODE_OFF',
        message: 'You are offline. Go online to receive offers.',
      });
    }

    const now = new Date();

    const config = await this.prisma.collegeConfig.findUnique({
      where: { collegeId },
      select: { riderPingIntervalSeconds: true },
    });

    await this.redis.setRiderPosition({
      collegeId,
      userId: user.userId,
      latitude,
      longitude,
      ttlSeconds: (config?.riderPingIntervalSeconds ?? 15) * 3,
    });

    await this.prisma.riderState.update({
      where: { userId: user.userId },
      data: { lastLatitude: latitude, lastLongitude: longitude, lastPingAt: now },
    });

    // FR-ADM-05: the first ping of each clock hour records the rider as
    // present in it. "First" is judged from the previous ping's time, which
    // was just read — only to save an INSERT on the other 239 pings of the
    // hour. It decides nothing: two pings racing past this check both insert,
    // and the table's primary key keeps one row.
    const previousHour = state.lastPingAt ? presenceHour(state.lastPingAt).getTime() : null;
    if (previousHour !== presenceHour(now).getTime()) {
      await recordRiderPresence(this.prisma, collegeId, user.userId, now);
    }

    return { ok: true };
  }

  // =======================================================================
  // Accepting and abandoning — FR-DLV-04, FR-DLV-08
  // =======================================================================

  /**
   * FR-DLV-04. The work is in DispatchService.accept — a single conditional
   * UPDATE (ADR-001). This method only establishes that the caller is
   * entitled to try.
   */
  async acceptTask(user: AuthenticatedUser, taskId: string) {
    // Called for the throw, not the value: C-1 requires a caller with no
    // college to be rejected before anything else happens. Do not remove
    // this because the result looks unused — binding it is what was unused.
    this.tenant.requireCollegeId(user);

    const state = await this.prisma.riderState.findUnique({
      where: { userId: user.userId },
      select: { workModeOn: true, activeTaskId: true, barredUntil: true },
    });

    if (!state?.workModeOn) {
      throw new ConflictException({
        code: 'WORK_MODE_OFF',
        message: 'Go online before accepting tasks.',
      });
    }

    // FR-WM-07. The real guard is the conditional UPDATE on rider_state
    // inside DispatchService.accept; this is the early, cheap answer with the
    // id of the task being held.
    if (state.activeTaskId) {
      throw new ConflictException({
        code: 'ALREADY_HOLDING_TASK',
        message: 'Finish the task you are holding before accepting another.',
        details: { activeTaskId: state.activeTaskId },
      });
    }

    if (state.barredUntil && state.barredUntil.getTime() > Date.now()) {
      throw new ForbiddenException({
        code: 'RIDER_BARRED',
        message: 'You cannot accept tasks at the moment.',
      });
    }

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { collegeId: true },
    });

    this.tenant.assertSameTenant(user, task, 'Task');

    return this.dispatch.accept(user.userId, taskId);
  }

  /**
   * FR-DLV-08: "An assigned rider shall be able to abandon a task before
   * pickup. The task shall return to broadcast and the abandonment shall be
   * recorded against the rider's reliability metric."
   *
   * "Before pickup" is the operative phrase: once the rider is carrying
   * somebody's food, abandoning is not a self-service action and the task
   * escalates to an administrator instead.
   */
  async abandonTask(user: AuthenticatedUser, taskId: string, dto: AbandonTaskDto) {
    const collegeId = this.tenant.requireCollegeId(user);

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        collegeId: true,
        status: true,
        riderId: true,
        baseFeeMinor: true,
        chatRoom: { select: { id: true } },
      },
    });

    this.tenant.assertSameTenant(user, task, 'Task');

    if (task!.riderId !== user.userId) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_TASK',
        message: 'That task is not assigned to you.',
      });
    }

    if (task!.status !== 'ASSIGNED') {
      throw new ConflictException({
        code: 'CANNOT_ABANDON',
        message:
          task!.status === 'PICKED_UP'
            ? 'You are already carrying this order. Contact your campus administrator for help.'
            : `This task is ${task!.status.toLowerCase()} and cannot be abandoned.`,
      });
    }

    const config = await this.prisma.collegeConfig.findUnique({
      where: { collegeId },
      select: {
        abandonmentBanThreshold: true,
        abandonmentWindowDays: true,
        abandonmentBanHours: true,
      },
    });

    const windowDays = config?.abandonmentWindowDays ?? 7;
    const threshold = config?.abandonmentBanThreshold ?? 3;
    const banHours = config?.abandonmentBanHours ?? 48;

    const result = await this.prisma.$transaction(async (tx) => {
      assertTaskTransition(TaskStatus.ASSIGNED, TaskEvent.RIDER_ABANDONED);

      // R-08: a task returning to the pool is a fresh search. Resuming at
      // round 3 of 3 would retire it on the next tick having never genuinely
      // re-offered it, and punishing the task for the rider's choice is the
      // wrong party.
      //
      // M4, ADR-001: the WHERE is the decision. The checks above read the
      // task a moment ago, and "abandon" and "confirm pickup" are two buttons
      // on one screen — tapped together (or retried by a flaky connection)
      // an unconditional update here would un-assign a task whose pickup had
      // just committed, leaving an order PICKED_UP, a live handover code, and
      // no rider. Exactly one of the two UPDATEs can match `status =
      // 'ASSIGNED'`; the other changes nothing and says so.
      const released = await tx.task.updateMany({
        where: { id: taskId, riderId: user.userId, status: 'ASSIGNED' },
        data: {
          riderId: null,
          status: 'CREATED',
          assignedAt: null,
          broadcastRound: 0,
          // A fresh search is a new cycle, advanced here — in the statement
          // that returns the task to the pool, so the two cannot come apart.
          // broadcast_log is keyed on (task, cycle, round): without this the
          // new search's round 1 would land on the row that records this
          // rider's acceptance.
          broadcastCycle: { increment: 1 },
          feeMinor: task!.baseFeeMinor,
          currentProximityM: null,
          offerExpiresAt: null,
          dispatchDueAt: new Date(),
        },
      });
      if (released.count !== 1) {
        throw new ConflictException({
          code: 'CANNOT_ABANDON',
          message: 'This task can no longer be abandoned. Refresh to see where it stands.',
        });
      }

      // Only ever clears *this* task: a blind `activeTaskId: null` would also
      // release a task the rider had legitimately moved on to.
      await tx.riderState.updateMany({
        where: { userId: user.userId, activeTaskId: taskId },
        data: { activeTaskId: null },
      });

      // FR-CHAT-08-adjacent: the task room's membership was for this rider.
      // Archiving it rather than deleting keeps the history for a dispute.
      // The next rider's accept re-opens the same room (task_id is unique),
      // so this rider is marked as having left it — otherwise they would sit
      // in on the conversation about a delivery they walked away from.
      if (task!.chatRoom) {
        await tx.chatRoom.update({
          where: { id: task!.chatRoom.id },
          data: { isArchived: true, archivedAt: new Date() },
        });
        await tx.chatMember.updateMany({
          where: { roomId: task!.chatRoom.id, userId: user.userId, leftAt: null },
          data: { leftAt: new Date() },
        });
      }

      // FR-TRST-03
      const reliability = await tx.riderReliability.upsert({
        where: { userId: user.userId },
        update: { tasksAbandoned: { increment: 1 } },
        create: { userId: user.userId, tasksAbandoned: 1 },
        select: { tasksAbandoned: true },
      });

      // FR-TRST-05: a rolling-window count, not a lifetime one — a rider who
      // abandoned three tasks last year should not be barred today.
      const windowStart = new Date(Date.now() - windowDays * 86_400_000);
      const recentAbandonments = await tx.auditLog.count({
        where: {
          actorId: user.userId,
          action: 'TASK_ABANDONED',
          createdAt: { gte: windowStart },
        },
      });

      // +1 for the one being recorded now.
      const shouldBar = recentAbandonments + 1 >= threshold;

      if (shouldBar) {
        await tx.riderState.update({
          where: { userId: user.userId },
          data: {
            workModeOn: false,
            barredUntil: new Date(Date.now() + banHours * 3_600_000),
          },
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: user.userId,
          collegeId,
          action: 'TASK_ABANDONED',
          targetType: 'task',
          targetId: taskId,
          detail: {
            reason: dto.reason,
            abandonmentsInWindow: recentAbandonments + 1,
            threshold,
            barred: shouldBar,
          },
        },
      });

      return { shouldBar, totalAbandoned: reliability.tasksAbandoned };
    });

    await this.redis.markRiderFree(collegeId, user.userId);
    if (result.shouldBar) {
      await this.redis.removeRider(collegeId, user.userId);
    }

    // The requester and the shop learn their rider is gone — addressed to
    // them individually (M7). The status is the task's real one; the reason
    // says why it went backwards. The task row no longer names this rider,
    // so they are added by hand for their other devices.
    await this.dispatch.notifyTaskParties(
      taskId,
      'CREATED',
      { reason: 'RIDER_ABANDONED' },
      [user.userId],
    );

    // Straight back into the pool at round 0.
    //
    // The abandonment has committed, so a failure here must not be reported
    // as a failed abandon — the rider would retry and be told the task is
    // not theirs. The task is CREATED with dispatchDueAt set, so the
    // dispatch-due tick offers it within five seconds regardless.
    try {
      await this.dispatch.rebroadcastFromScratch(taskId);
    } catch (error) {
      this.logger.error(
        `Immediate re-broadcast of abandoned task ${taskId} failed; the dispatch tick will pick it up`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    this.logger.warn(
      `Rider ${user.userId} abandoned task ${taskId}${result.shouldBar ? ' and was barred' : ''}`,
    );

    return {
      taskId,
      abandoned: true,
      barred: result.shouldBar,
      message: result.shouldBar
        ? `Task returned to other riders. You have reached ${threshold} abandoned tasks in ` +
          `${windowDays} days, so you cannot go online for ${banHours} hours.`
        : 'Task returned to other riders. Repeated abandonment affects your reliability score.',
    };
  }

  // =======================================================================
  // Pickup — FR-DLV-11, FR-DLV-12
  // =======================================================================

  /**
   * ADR-003 in practice: the shop's confirmation sets the order to READY and
   * *unlocks* this button. Only this call writes `pickedUpAt`, and it writes
   * it to the order and the task in one transaction, so the two rows cannot
   * disagree about when the handover happened.
   */
  async confirmPickup(user: AuthenticatedUser, taskId: string, dto: ConfirmPickupDto) {
    // Called for the throw, not the value (C-1) — see acceptTask.
    this.tenant.requireCollegeId(user);

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        collegeId: true,
        status: true,
        riderId: true,
        type: true,
        requesterId: true,
        orderId: true,
        order: { select: { id: true, status: true, reference: true } },
      },
    });

    this.tenant.assertSameTenant(user, task, 'Task');

    if (task!.riderId !== user.userId) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_TASK',
        message: 'That task is not assigned to you.',
      });
    }

    if (task!.status !== 'ASSIGNED') {
      throw new ConflictException({
        code: 'NOT_AWAITING_PICKUP',
        message: `This task is ${task!.status.toLowerCase()}.`,
      });
    }

    // FR-DLV-11: for a shop order, the shop must have confirmed first.
    if (task!.type === 'SHOP_ORDER') {
      if (task!.order?.status !== 'READY') {
        throw new ConflictException({
          code: 'SHOP_NOT_READY',
          message:
            'The shop has not marked this order ready yet. Wait for them to hand it over.',
          details: { orderStatus: task!.order?.status },
        });
      }
    }

    /**
     * FR-DLV-12: a six-digit handover code, generated on pickup and shown to
     * the requester only.
     *
     * Generated with the OS cryptographic source, not Math.random — this is a
     * credential that releases goods. Stored as an Argon2id hash (NFR-S-04);
     * the plaintext exists only in this response and on the requester's
     * screen, and is never written down anywhere on our side.
     */
    const code = String(randomInt(0, 10 ** HANDOVER_OTP_LENGTH)).padStart(
      HANDOVER_OTP_LENGTH,
      '0',
    );
    const otpHash = await argon2.hash(code, { type: argon2.argon2id });

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      assertTaskTransition(TaskStatus.ASSIGNED, TaskEvent.PICKUP_CONFIRMED);

      // M4, ADR-001: the other half of the abandon/pickup race — see
      // abandonTask. Conditional on the rider and the status, so a pickup
      // cannot land on a task that was abandoned (or re-assigned to somebody
      // else) after the checks above read it, and a double-tap cannot issue
      // two handover codes with the second silently replacing the first.
      const pickedUp = await tx.task.updateMany({
        where: { id: taskId, riderId: user.userId, status: 'ASSIGNED' },
        data: {
          status: 'PICKED_UP',
          pickedUpAt: now,
          otpHash,
          otpAttempts: 0,
          otpIssuedAt: now,
          pickupProofUrl: dto.proofImageKey ?? null,
        },
      });
      if (pickedUp.count !== 1) {
        throw new ConflictException({
          code: 'NOT_AWAITING_PICKUP',
          message: 'This task is no longer awaiting pickup. Refresh to see where it stands.',
        });
      }

      // ADR-003: both rows, one transaction, one writer. The order moves
      // only from READY — if the student or shop cancelled it in the last
      // instant, zero rows change and throwing rolls the task back too, so
      // the two rows still cannot disagree.
      if (task!.order) {
        assertOrderTransition(OrderStatus.READY, OrderEvent.RIDER_PICKED_UP);
        const orderMoved = await tx.order.updateMany({
          where: { id: task!.order.id, status: 'READY' },
          data: { status: 'PICKED_UP', pickedUpAt: now },
        });
        if (orderMoved.count !== 1) {
          throw new ConflictException({
            code: 'SHOP_NOT_READY',
            message: 'This order is no longer ready for pickup. Refresh to see where it stands.',
          });
        }
      }
    });

    // M7: to the requester, the rider and the shop — not the college.
    await this.dispatch.notifyTaskParties(taskId, 'PICKED_UP');
    if (task!.order) {
      await this.dispatch.notifyOrderParties(taskId, task!.order.id, 'PICKED_UP');
    }

    /**
     * FR-DLV-12: "display it to the requester only."
     *
     * The code is pushed to the requester's device and is never returned to
     * the rider, and never persisted in plaintext — only the Argon2id hash is
     * stored (NFR-S-04). This push is the only time the plaintext exists
     * outside the requester's screen.
     *
     * If the requester misses it — app closed, phone switched — they ask for
     * a new one, which invalidates this one. That is why re-issue exists: a
     * code that cannot be recovered and cannot be replaced would strand the
     * delivery.
     */
    this.gateway.sendHandoverCode(task!.requesterId, {
      taskId,
      code,
      orderReference: task!.order?.reference ?? null,
    });

    this.logger.log(`Task ${taskId} picked up by ${user.userId}; handover code issued`);

    return {
      taskId,
      status: 'PICKED_UP',
      pickedUpAt: now,
      // The code deliberately does not appear here. FR-DLV-12 shows it to the
      // requester only; the rider types in what the requester reads out.
      message:
        'Picked up. Ask the customer for their 6-digit handover code when you arrive.',
    };
  }

  /**
   * FR-DLV-12, recovery path: issue a fresh handover code to the requester.
   *
   * The plaintext is never stored, so a lost code cannot be looked up — it can
   * only be replaced. Re-issuing invalidates the previous code and resets the
   * attempt counter, because the rider's failed attempts were against a code
   * the requester no longer has.
   */
  async reissueHandoverCode(user: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        collegeId: true,
        requesterId: true,
        status: true,
        order: { select: { reference: true } },
      },
    });

    this.tenant.assertSameTenant(user, task, 'Task');

    if (task!.requesterId !== user.userId) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_TASK',
        message: 'Only the person who placed this order can request a new code.',
      });
    }

    if (task!.status !== 'PICKED_UP') {
      throw new ConflictException({
        code: 'CODE_NOT_APPLICABLE',
        message: 'A handover code only exists while the rider is carrying your order.',
      });
    }

    const code = String(randomInt(0, 10 ** HANDOVER_OTP_LENGTH)).padStart(
      HANDOVER_OTP_LENGTH,
      '0',
    );
    const otpHash = await argon2.hash(code, { type: argon2.argon2id });

    // Conditional for the same reason as every other write here: the status
    // was read above, and a re-issue landing just after the delivery
    // completed would otherwise plant a live code on a finished task.
    const reissued = await this.prisma.task.updateMany({
      where: { id: taskId, requesterId: user.userId, status: 'PICKED_UP' },
      data: { otpHash, otpAttempts: 0, otpIssuedAt: new Date() },
    });
    if (reissued.count !== 1) {
      throw new ConflictException({
        code: 'CODE_NOT_APPLICABLE',
        message: 'A handover code only exists while the rider is carrying your order.',
      });
    }

    this.gateway.sendHandoverCode(task!.requesterId, {
      taskId,
      code,
      orderReference: task!.order?.reference ?? null,
    });

    this.logger.log(`Handover code re-issued for task ${taskId}`);

    return {
      taskId,
      // Returned here as well as pushed: this call is the requester asking
      // for it directly, so they are the only recipient either way.
      code,
      codeLength: HANDOVER_OTP_LENGTH,
      message: 'New code issued. The previous code no longer works.',
    };
  }

  /**
   * FR-DLV-12: the requester's copy of the handover code.
   *
   * Only the requester, and only between pickup and delivery. A rider who
   * could read this could mark a delivery complete without ever meeting
   * anyone, which is the entire point of having a code.
   */
  async handoverCodeForRequester(user: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, collegeId: true, requesterId: true, status: true, otpIssuedAt: true },
    });

    this.tenant.assertSameTenant(user, task, 'Task');

    if (task!.requesterId !== user.userId) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_TASK',
        message: 'Only the person who placed this order can see the handover code.',
      });
    }

    if (task!.status !== 'PICKED_UP') {
      throw new ConflictException({
        code: 'CODE_NOT_ISSUED',
        message:
          task!.status === 'DELIVERED' || task!.status === 'COMPLETED'
            ? 'This delivery is already complete.'
            : 'The code appears once the rider has collected your order.',
      });
    }

    /**
     * The plaintext is not stored, so it cannot be re-read here — only the
     * Argon2id hash exists. That is deliberate: a stored plaintext code is a
     * credential sitting in a database.
     *
     * The code reaches the requester at pickup, over the socket to their
     * device. This endpoint tells them whether one is live, and if they lost
     * it, re-issuing is the correct recovery.
     */
    return {
      taskId,
      codeIssuedAt: task!.otpIssuedAt,
      codeLength: HANDOVER_OTP_LENGTH,
      // There is no `code` field, and there cannot be: only the hash is
      // stored. Recovery is re-issue, not retrieval.
      canReissue: true,
      message:
        'Your handover code was sent to this device when the rider collected your order. ' +
        'If you cannot find it, request a new one — the old one stops working.',
    };
  }

  /**
   * FR-DLV-13: the rider enters the code at the drop point.
   * FR-DLV-14: at most five attempts, then the task escalates.
   */
  async submitHandoverCode(
    user: AuthenticatedUser,
    taskId: string,
    dto: SubmitHandoverOtpDto,
  ) {
    const collegeId = this.tenant.requireCollegeId(user);

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        collegeId: true,
        status: true,
        riderId: true,
        requesterId: true,
        otpHash: true,
        otpAttempts: true,
        feeMinor: true,
        type: true,
        reimbursementMinor: true,
        orderId: true,
        order: { select: { id: true, reference: true, status: true, paymentMethod: true, totalMinor: true, studentId: true } },
        chatRoom: { select: { id: true } },
      },
    });

    this.tenant.assertSameTenant(user, task, 'Task');

    if (task!.riderId !== user.userId) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_TASK',
        message: 'That task is not assigned to you.',
      });
    }

    if (task!.status !== 'PICKED_UP') {
      throw new ConflictException({
        code: 'NOT_AWAITING_HANDOVER',
        message: `This task is ${task!.status.toLowerCase()}.`,
      });
    }

    if (!task!.otpHash) {
      throw new ConflictException({
        code: 'NO_CODE_ISSUED',
        message: 'No handover code has been issued for this task.',
      });
    }

    const config = await this.prisma.collegeConfig.findUnique({
      where: { collegeId },
      select: { maxOtpAttempts: true },
    });
    const maxAttempts = config?.maxOtpAttempts ?? 5;

    /**
     * M1, FR-DLV-14: count the attempt first, atomically, then check the code.
     *
     * This used to verify, and on a miss write back `otpAttempts + 1` using
     * the value read at the top of the method. Fifty wrong guesses sent in
     * parallel all read 0 and all wrote 1 — so the five-attempt cap on a
     * six-digit code was really "five batches of as many as you like".
     *
     * One UPDATE now does the counting and the cap together: it increments
     * only while the count is below the maximum, and reports the new value.
     * However many requests race, exactly `maxAttempts` of them can ever get
     * a row back; the rest are refused without the code being looked at.
     *
     * The hash is returned by the same statement, so the code is checked
     * against whichever hash this attempt was counted against — a re-issue
     * landing mid-request cannot be guessed at with the old code's attempts.
     *
     * A correct code spends an attempt too. That costs nothing: success
     * clears the hash and ends the task.
     */
    const [counted] = await this.prisma.$queryRaw<{ otpAttempts: number; otpHash: string }[]>`
      UPDATE "task"
      SET otp_attempts = otp_attempts + 1,
          updated_at = now()
      WHERE id = ${taskId}
        AND rider_id = ${user.userId}
        AND status = 'PICKED_UP'
        AND otp_hash IS NOT NULL
        AND otp_attempts < ${maxAttempts}
      RETURNING otp_attempts AS "otpAttempts", otp_hash AS "otpHash"
    `;

    if (!counted) {
      // Zero rows: the cap was already reached, or the task moved on. Read
      // back only to word the refusal — the UPDATE has already refused.
      const current = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { status: true, riderId: true, otpAttempts: true },
      });

      if (
        current?.status === 'PICKED_UP' &&
        current.riderId === user.userId &&
        current.otpAttempts >= maxAttempts
      ) {
        // Deliberately does not escalate from here. The request that spent
        // the final attempt escalates if its code was wrong; escalating from
        // this branch as well would let a stray extra request escalate a
        // task whose final attempt is, right now, verifying the correct code.
        throw new ConflictException({
          code: 'OTP_ATTEMPTS_EXHAUSTED',
          message:
            'Too many incorrect codes. Ask the customer to request a new code, or ' +
            'contact your campus administrator.',
        });
      }

      throw new ConflictException({
        code: 'NOT_AWAITING_HANDOVER',
        message: 'This task is no longer awaiting handover.',
      });
    }

    const matches = await argon2.verify(counted.otpHash, dto.code);

    if (!matches) {
      const attempts = counted.otpAttempts;

      // FR-DLV-14
      if (attempts >= maxAttempts) {
        await this.escalate(taskId, collegeId, user.userId, 'OTP attempts exhausted');

        throw new ConflictException({
          code: 'OTP_ATTEMPTS_EXHAUSTED',
          message:
            'Too many incorrect codes. This delivery has been passed to a campus ' +
            'administrator, who will contact you both.',
        });
      }

      throw new BadRequestException({
        code: 'OTP_INCORRECT',
        message: `That code is not correct. ${maxAttempts - attempts} attempt${
          maxAttempts - attempts === 1 ? '' : 's'
        } left.`,
        details: { attemptsRemaining: maxAttempts - attempts },
      });
    }

    // --- correct code: deliver and settle --------------------------------
    const settled = await this.settleDelivery(user.userId, taskId, collegeId, {
      from: 'PICKED_UP',
      // Immutable facts about the order, read above; used only to know whose
      // wallet to lock before the transaction touches a row.
      walletStudentId:
        task!.order?.paymentMethod === 'WALLET' ? task!.order.studentId : null,
      whenAlreadySettled: () =>
        new ConflictException({
          code: 'NOT_AWAITING_HANDOVER',
          message: 'This task is no longer awaiting handover.',
        }),
    });

    this.logger.log(
      `Task ${taskId} completed by ${user.userId}, fee ${settled.feeMinor} (${
        settled.isCash ? 'cash' : 'wallet'
      })`,
    );

    return {
      taskId,
      status: 'COMPLETED',
      deliveredAt: settled.settledAt,
      feeMinor: settled.feeMinor,
      feeLabel: formatMinor(settled.feeMinor),
      settledInCash: settled.isCash,
      message: settled.isCash
        ? `Delivered. You keep ${formatMinor(settled.feeMinor)} from the cash you collected.`
        : `Delivered. ${formatMinor(settled.feeMinor)} added to your wallet.`,
      // FR-DLV-16: both parties are prompted to rate, and it is skippable.
      ratingPrompt: { taskId, optional: true },
    };
  }

  /**
   * FR-DLV-13, FR-DLV-15, NFR-R-03.
   *
   * NFR-R-03 is the reason this is one transaction: "Wallet ledger entries
   * shall be written within the same transaction as the task completion that
   * causes them." A rider marked as having completed a delivery with no
   * corresponding ledger entry would be owed money the books do not show.
   *
   * The one place a delivery is settled. Called by the handover-code path
   * above and by EscalationsService when an administrator resolves an
   * escalated task as delivered — see SettlementOptions. It is public for
   * that second caller only; it does no authorisation of its own, so whoever
   * calls it must already have established that this settlement is allowed.
   */
  async settleDelivery(
    riderId: string,
    taskId: string,
    collegeId: string,
    opts: SettlementOptions,
  ): Promise<SettledDelivery> {
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      /**
       * The per-user wallet lock, taken before anything else.
       *
       * A wallet balance here is a running total: each entry stores
       * `balanceAfterMinor`, computed from the entry before it. Two
       * transactions writing to one wallet at once both read the same
       * "latest" entry and both write the same balance — one credit vanishes
       * from the total while both rows sit in an append-only ledger. The lock
       * makes writers to one wallet take turns; it is transaction-scoped, so
       * it releases itself on commit or rollback.
       *
       * Taken through the ledger's own `lockWallets` — the one copy of the
       * lock's key expression, shared with the orders module and the
       * escalation refund, because two spellings of the key for one wallet
       * would be two locks and no protection. It comes first, before the
       * task row is touched, and `lockWallets` sorts the ids: every
       * transaction then acquires in the same order and none can deadlock
       * against another.
       */
      await lockWallets(tx, [riderId, ...(opts.walletStudentId ? [opts.walletStudentId] : [])]);

      // DELIVERED then COMPLETED, both legal moves in the state machine —
      // reached by the handover code, or by an administrator's resolution.
      if (opts.from === 'PICKED_UP') {
        assertTaskTransition(TaskStatus.PICKED_UP, TaskEvent.OTP_VALID);
      } else {
        assertTaskTransition(TaskStatus.ESCALATED, TaskEvent.ADMIN_RESOLVED_DELIVERED);
      }
      assertTaskTransition(TaskStatus.DELIVERED, TaskEvent.SETTLEMENT_WRITTEN);

      /**
       * H4, ADR-001: the settlement gate.
       *
       * This was `findUnique`, check the status, then an unconditional
       * `update`. Two requests carrying the correct code — a double tap, a
       * retry after a timeout — both read PICKED_UP before either wrote, and
       * both went on to credit the delivery fee and bump tasksCompleted. The
       * rider was paid twice for one delivery, in a ledger that cannot be
       * edited afterwards.
       *
       * One conditional UPDATE decides instead. Exactly one request can move
       * the row out of the state it is being settled from (PICKED_UP for a
       * handover code, ESCALATED for an administrator); every other changes
       * zero rows and stops here, before a single ledger entry is written.
       * That is also what makes two administrators resolving the same task at
       * once safe: one settles, the other is told it is already resolved.
       */
      const settled = await tx.task.updateMany({
        where: { id: taskId, status: opts.from, riderId },
        data: {
          ...opts.taskData,
          status: 'COMPLETED',
          deliveredAt: now,
          completedAt: now,
          // The hash is cleared on success: the code has done its job and
          // keeping it serves no purpose.
          otpHash: null,
        },
      });

      if (settled.count !== 1) throw opts.whenAlreadySettled();

      // Read after the UPDATE, inside the transaction that now holds the row:
      // these are the values being settled, and nobody else can change them
      // until this commits.
      const task = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        select: {
          id: true,
          feeMinor: true,
          reimbursementMinor: true,
          assignedAt: true,
          pickedUpAt: true,
          requesterId: true,
          orderId: true,
          order: {
            select: {
              id: true,
              reference: true,
              paymentMethod: true,
              totalMinor: true,
              studentId: true,
            },
          },
          chatRoom: { select: { id: true } },
        },
      });

      if (task.order) {
        assertOrderTransition(OrderStatus.PICKED_UP, OrderEvent.HANDOVER_CONFIRMED);
        assertOrderTransition(OrderStatus.DELIVERED, OrderEvent.SETTLEMENT_WRITTEN);

        // Conditional as well: an order that is not PICKED_UP while its task
        // was is a disagreement between the two rows, and settling money on
        // top of it would bury it. Throwing rolls the task back.
        const orderSettled = await tx.order.updateMany({
          where: { id: task.order.id, status: 'PICKED_UP' },
          data: {
            status: 'COMPLETED',
            deliveredAt: now,
            completedAt: now,
            paymentStatus:
              task.order.paymentMethod === 'CASH'
                ? 'NOT_REQUIRED'
                : task.order.paymentMethod === 'WALLET'
                  ? 'CAPTURED'
                  : 'CAPTURED',
          },
        });
        if (orderSettled.count !== 1) {
          throw new ConflictException({
            code: 'ORDER_NOT_AWAITING_HANDOVER',
            message:
              'This order can no longer be completed. Contact your campus administrator.',
          });
        }

        // FR-PAY-06: a wallet hold is captured on completion. The hold was
        // already debited at placement, so capture is a status change rather
        // than a second debit.
        if (task.order.paymentMethod === 'WALLET') {
          const studentHead = await readWalletHead(tx, task.order.studentId);
          await tx.walletEntry.create({
            data: {
              userId: task.order.studentId,
              direction: 'DEBIT',
              amountMinor: 0,
              type: 'ORDER_CAPTURE',
              orderId: task.order.id,
              balanceAfterMinor: studentHead.balanceMinor,
              createdAt: studentHead.nextCreatedAt,
              note: `Captured for completed order ${task.order.reference}`,
            },
          });
        }
      }

      /**
       * FR-DLV-15: credit the delivery fee to the rider's wallet.
       *
       * ADR-006 settles what this means for a cash order. The rider has
       * already taken the fee in physical cash at the door, so this entry is
       * a *statement line* rather than a withdrawable claim — which is why
       * the note says so, and why the withdrawal endpoint counts only
       * online-settled credits.
       */
      const isCash = !task.order || task.order.paymentMethod === 'CASH';

      // The head of the rider's ledger, through the shared helper: it reads
      // "the latest entry" with a tie-break, and hands back the timestamp the
      // next entry must carry so that it sorts strictly after that one. The
      // wallet lock taken at the top of this transaction is what makes the
      // read safe to build on.
      const feeHead = await readWalletHead(tx, riderId);
      const balanceAfterFee = isCash ? feeHead.balanceMinor : feeHead.balanceMinor + task.feeMinor;

      await tx.walletEntry.create({
        data: {
          userId: riderId,
          direction: 'CREDIT',
          amountMinor: task.feeMinor,
          type: 'DELIVERY_FEE_EARNED',
          taskId,
          orderId: task.order?.id ?? null,
          counterpartyUserId: task.requesterId,
          balanceAfterMinor: balanceAfterFee,
          createdAt: feeHead.nextCreatedAt,
          note: isCash
            ? `Delivery fee for ${task.order?.reference ?? taskId} — collected in cash at the door (ADR-006)`
            : `Delivery fee for ${task.order?.reference ?? taskId}`,
        },
      });

      // FR-ORD-08: a peer errand reimburses the rider for what they spent.
      if (task.reimbursementMinor && task.reimbursementMinor > 0) {
        // Read again rather than reusing `feeHead`: this is the second entry
        // for the same wallet in the same millisecond, and it must sort after
        // the fee entry just written. The fresh read sees that entry, so its
        // balance is the one to carry and its timestamp lands one tick later.
        const reimbursementHead = await readWalletHead(tx, riderId);
        await tx.walletEntry.create({
          data: {
            userId: riderId,
            direction: 'CREDIT',
            amountMinor: task.reimbursementMinor,
            type: 'ERRAND_REIMBURSEMENT',
            taskId,
            counterpartyUserId: task.requesterId,
            balanceAfterMinor: reimbursementHead.balanceMinor,
            createdAt: reimbursementHead.nextCreatedAt,
            note: 'Errand reimbursement — settled directly with the requester',
          },
        });
      }

      // FR-WM-07: free the rider for the next task — this task, specifically.
      await tx.riderState.updateMany({
        where: { userId: riderId, activeTaskId: taskId },
        data: { activeTaskId: null },
      });

      // FR-TRST-03: completion time feeds the reliability metric.
      const deliverySeconds =
        task.assignedAt !== null
          ? Math.round((now.getTime() - task.assignedAt.getTime()) / 1000)
          : null;

      const current = await tx.riderReliability.findUnique({
        where: { userId: riderId },
        select: { tasksCompleted: true, avgDeliverySeconds: true, tasksOffered: true, tasksAccepted: true },
      });

      const completed = (current?.tasksCompleted ?? 0) + 1;

      // A running mean, so the whole history need not be re-read.
      const newAvg =
        deliverySeconds === null
          ? (current?.avgDeliverySeconds ?? null)
          : Math.round(
              ((current?.avgDeliverySeconds ?? deliverySeconds) * (completed - 1) +
                deliverySeconds) /
                completed,
            );

      await tx.riderReliability.upsert({
        where: { userId: riderId },
        update: {
          // An atomic increment rather than the value computed above: the
          // settlement gate already makes this run once per task, and the
          // counter should not depend on that staying true.
          tasksCompleted: { increment: 1 },
          avgDeliverySeconds: newAvg,
          // The column is NOT NULL, so "no rate yet" is stored as 0 here;
          // the API reports null for it from the counters themselves.
          acceptanceRateBps:
            acceptanceRateBps(current?.tasksOffered ?? 0, current?.tasksAccepted ?? 0) ?? 0,
        },
        create: { userId: riderId, tasksCompleted: 1, avgDeliverySeconds: newAvg },
      });

      // FR-DLV-15: close the task room to new messages, keeping its history.
      if (task.chatRoom) {
        await tx.chatRoom.update({
          where: { id: task.chatRoom.id },
          data: { isArchived: true, archivedAt: now },
        });
      }

      const settledDelivery: SettledDelivery = {
        settledAt: now,
        feeMinor: task.feeMinor,
        isCash,
        orderId: task.order?.id ?? null,
        orderReference: task.order?.reference ?? null,
        reimbursementMinor: task.reimbursementMinor ?? 0,
      };

      await opts.alsoInTransaction?.(tx, settledDelivery);

      return settledDelivery;
    });

    await this.freeRiderInRedis(collegeId, riderId);

    // M7: to the requester, the rider and the shop — not the college.
    await this.dispatch.notifyTaskParties(taskId, 'COMPLETED', opts.notifyExtra);

    return result;
  }

  /**
   * FR-DLV-14, FR-ADM-04.
   *
   * M2: escalation releases the rider. It used to mark the task ESCALATED and
   * stop — leaving `rider_state.active_task_id` pointing at it and the rider
   * in the Redis busy set. Nothing else ever cleared either, so a rider whose
   * customer misread a code five times answered ALREADY_HOLDING_TASK to every
   * offer from then on, with no way out short of someone editing the
   * database.
   *
   * An escalated task waits for an administrator (FR-ADM-04 —
   * EscalationsService, `/admin/escalations`), which can take hours. The
   * rider is released here rather than then, so a person is not kept from
   * working for as long as a queue takes to be read. The task keeps its
   * `rider_id` — the CHECK constraint requires one while ESCALATED, and
   * whoever resolves it needs to know who was carrying the goods and whom to
   * pay if it turns out to have been delivered.
   */
  private async escalate(
    taskId: string,
    collegeId: string,
    riderId: string,
    reason: string,
  ): Promise<void> {
    const escalated = await this.prisma.$transaction(async (tx) => {
      assertTaskTransition(TaskStatus.PICKED_UP, TaskEvent.OTP_ATTEMPTS_EXHAUSTED);

      // ADR-001: conditional, so an escalation cannot land on a task that a
      // correct code completed in the same instant.
      const moved = await tx.task.updateMany({
        where: { id: taskId, status: 'PICKED_UP', riderId },
        data: { status: 'ESCALATED', escalatedAt: new Date(), resolutionNote: reason },
      });
      if (moved.count !== 1) return false;

      await tx.riderState.updateMany({
        where: { userId: riderId, activeTaskId: taskId },
        data: { activeTaskId: null },
      });

      await tx.auditLog.create({
        data: {
          actorId: null,
          collegeId,
          action: AuditAction.TASK_ESCALATED,
          targetType: 'task',
          targetId: taskId,
          detail: { reason, riderId, riderReleased: true },
        },
      });

      return true;
    });

    if (!escalated) return;

    await this.freeRiderInRedis(collegeId, riderId);

    await this.dispatch.notifyTaskParties(taskId, 'ESCALATED', { reason });
    this.logger.warn(`Task ${taskId} escalated: ${reason}; rider ${riderId} released`);
  }

  /**
   * Clear the Redis busy flag after a task has been released in the database.
   *
   * Never throws. The database is the truth about who holds a task — the
   * broadcast re-confirms `active_task_id IS NULL` there — and by the time
   * this runs the transaction has committed, so a Redis hiccup must not turn
   * a completed delivery into an error response.
   */
  async freeRiderInRedis(collegeId: string, riderId: string): Promise<void> {
    try {
      await this.redis.markRiderFree(collegeId, riderId);
    } catch (error) {
      this.logger.warn(
        `Could not clear the busy flag for rider ${riderId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // =======================================================================
  // Active task detail (S-28, S-30)
  // =======================================================================

  async activeTaskDetail(user: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        collegeId: true,
        type: true,
        status: true,
        riderId: true,
        pickupLabel: true,
        pickupLatitude: true,
        pickupLongitude: true,
        dropLabel: true,
        dropLatitude: true,
        dropLongitude: true,
        distanceM: true,
        feeMinor: true,
        description: true,
        collectionRef: true,
        reimbursementMinor: true,
        otpAttempts: true,
        assignedAt: true,
        pickedUpAt: true,
        chatRoom: { select: { id: true, isArchived: true } },
        order: {
          select: {
            id: true,
            reference: true,
            status: true,
            paymentMethod: true,
            totalMinor: true,
            itemsSubtotalMinor: true,
            expectedReadyAt: true,
            studentNote: true,
            items: { select: { nameSnapshot: true, quantity: true } },
            student: { select: { id: true, name: true } },
            shopListing: {
              select: { shop: { select: { name: true, ownerMobile: true, address: true } } },
            },
          },
        },
      },
    });

    if (!task) return null;
    this.tenant.assertSameTenant(user, task, 'Task');

    // H6: the assigned rider, or an administrator of the same college (the
    // tenant check above has already pinned an ADMIN to their own).
    //
    // The old test was "not the rider AND a student", which let every other
    // role through — a shop owner or shop staff account could read any task
    // in the college by id: the customer's name, their drop point, the
    // shop's phone number, what they ordered.
    const isAdministrator = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';

    if (task.riderId !== user.userId && !isAdministrator) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_TASK',
        message: 'That task is not assigned to you.',
      });
    }

    return {
      ...task,
      collegeId: undefined,
      feeLabel: formatMinor(task.feeMinor),
      // S-29: the rider's pickup button is enabled only once the shop is ready
      // (ADR-003).
      canConfirmPickup:
        task.status === 'ASSIGNED' &&
        (task.type !== 'SHOP_ORDER' || task.order?.status === 'READY'),
      canAbandon: task.status === 'ASSIGNED',
      awaitingHandoverCode: task.status === 'PICKED_UP',
      // ADR-006: the rider pays the shop in cash at pickup and collects the
      // full total at the door, so the dashboard has to tell them the amount.
      cashToPayShopMinor:
        task.order?.paymentMethod === 'CASH' ? task.order.itemsSubtotalMinor : 0,
      cashToCollectMinor: task.order?.paymentMethod === 'CASH' ? task.order.totalMinor : 0,
    };
  }
}
