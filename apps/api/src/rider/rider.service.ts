import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import type {
  AbandonTaskDto,
  ConfirmPickupDto,
  SetWorkModeDto,
  SubmitHandoverOtpDto,
} from './dto/rider.dto';

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
        acceptanceRate:
          (reliability?.tasksOffered ?? 0) > 0
            ? Number(
                (((reliability!.tasksAccepted ?? 0) / reliability!.tasksOffered) * 100).toFixed(1),
              )
            : null,
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
      select: { workModeOn: true },
    });

    if (!state?.workModeOn) {
      throw new ConflictException({
        code: 'WORK_MODE_OFF',
        message: 'You are offline. Go online to receive offers.',
      });
    }

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
      data: { lastLatitude: latitude, lastLongitude: longitude, lastPingAt: new Date() },
    });

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

    // FR-WM-07. The UNIQUE constraint on active_task_id is the real guard;
    // this gives a readable error instead of a constraint violation.
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
      await tx.task.update({
        where: { id: taskId },
        data: {
          riderId: null,
          status: 'CREATED',
          assignedAt: null,
          broadcastRound: 0,
          feeMinor: task!.baseFeeMinor,
          currentProximityM: null,
          offerExpiresAt: null,
          dispatchDueAt: new Date(),
        },
      });

      await tx.riderState.update({
        where: { userId: user.userId },
        data: { activeTaskId: null },
      });

      // FR-CHAT-08-adjacent: the task room's membership was for this rider.
      // Archiving it rather than deleting keeps the history for a dispute.
      if (task!.chatRoom) {
        await tx.chatRoom.update({
          where: { id: task!.chatRoom.id },
          data: { isArchived: true, archivedAt: new Date() },
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

    // Straight back into the pool at round 0.
    await this.dispatch.rebroadcastFromScratch(taskId);

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
    const collegeId = this.tenant.requireCollegeId(user);

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

      await tx.task.update({
        where: { id: taskId },
        data: {
          status: 'PICKED_UP',
          pickedUpAt: now,
          otpHash,
          otpAttempts: 0,
          otpIssuedAt: now,
          pickupProofUrl: dto.proofImageKey ?? null,
        },
      });

      // ADR-003: both rows, one transaction, one writer.
      if (task!.order) {
        assertOrderTransition(OrderStatus.READY, OrderEvent.RIDER_PICKED_UP);
        await tx.order.update({
          where: { id: task!.order.id },
          data: { status: 'PICKED_UP', pickedUpAt: now },
        });
      }
    });

    this.gateway.notifyTaskStatus(collegeId, taskId, 'PICKED_UP');
    if (task!.order) {
      this.gateway.notifyOrderStatus(collegeId, task!.order.id, 'PICKED_UP');
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

    await this.prisma.task.update({
      where: { id: taskId },
      data: { otpHash, otpAttempts: 0, otpIssuedAt: new Date() },
    });

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

    const matches = await argon2.verify(task!.otpHash, dto.code);

    if (!matches) {
      const attempts = task!.otpAttempts + 1;

      await this.prisma.task.update({
        where: { id: taskId },
        data: { otpAttempts: attempts },
      });

      // FR-DLV-14
      if (attempts >= maxAttempts) {
        await this.escalate(taskId, collegeId, 'OTP attempts exhausted');

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
    return this.completeDelivery(user.userId, taskId, collegeId);
  }

  /**
   * FR-DLV-13, FR-DLV-15, NFR-R-03.
   *
   * NFR-R-03 is the reason this is one transaction: "Wallet ledger entries
   * shall be written within the same transaction as the task completion that
   * causes them." A rider marked as having completed a delivery with no
   * corresponding ledger entry would be owed money the books do not show.
   */
  private async completeDelivery(riderId: string, taskId: string, collegeId: string) {
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          status: true,
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

      if (!task || task.status !== 'PICKED_UP') {
        throw new ConflictException({
          code: 'NOT_AWAITING_HANDOVER',
          message: 'This task is no longer awaiting handover.',
        });
      }

      // DELIVERED then COMPLETED, both legal moves in the state machine.
      assertTaskTransition(TaskStatus.PICKED_UP, TaskEvent.OTP_VALID);
      assertTaskTransition(TaskStatus.DELIVERED, TaskEvent.SETTLEMENT_WRITTEN);

      await tx.task.update({
        where: { id: taskId },
        data: {
          status: 'COMPLETED',
          deliveredAt: now,
          completedAt: now,
          // The hash is cleared on success: the code has done its job and
          // keeping it serves no purpose.
          otpHash: null,
        },
      });

      if (task.order) {
        assertOrderTransition(OrderStatus.PICKED_UP, OrderEvent.HANDOVER_CONFIRMED);
        assertOrderTransition(OrderStatus.DELIVERED, OrderEvent.SETTLEMENT_WRITTEN);

        await tx.order.update({
          where: { id: task.order.id },
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

        // FR-PAY-06: a wallet hold is captured on completion. The hold was
        // already debited at placement, so capture is a status change rather
        // than a second debit.
        if (task.order.paymentMethod === 'WALLET') {
          const balance = await this.balanceTx(tx, task.order.studentId);
          await tx.walletEntry.create({
            data: {
              userId: task.order.studentId,
              direction: 'DEBIT',
              amountMinor: 0,
              type: 'ORDER_CAPTURE',
              orderId: task.order.id,
              balanceAfterMinor: balance,
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
      const riderBalance = await this.balanceTx(tx, riderId);

      await tx.walletEntry.create({
        data: {
          userId: riderId,
          direction: 'CREDIT',
          amountMinor: task.feeMinor,
          type: 'DELIVERY_FEE_EARNED',
          taskId,
          orderId: task.order?.id ?? null,
          counterpartyUserId: task.requesterId,
          balanceAfterMinor: isCash ? riderBalance : riderBalance + task.feeMinor,
          note: isCash
            ? `Delivery fee for ${task.order?.reference ?? taskId} — collected in cash at the door (ADR-006)`
            : `Delivery fee for ${task.order?.reference ?? taskId}`,
        },
      });

      // FR-ORD-08: a peer errand reimburses the rider for what they spent.
      if (task.reimbursementMinor && task.reimbursementMinor > 0) {
        const afterFee = isCash ? riderBalance : riderBalance + task.feeMinor;
        await tx.walletEntry.create({
          data: {
            userId: riderId,
            direction: 'CREDIT',
            amountMinor: task.reimbursementMinor,
            type: 'ERRAND_REIMBURSEMENT',
            taskId,
            counterpartyUserId: task.requesterId,
            balanceAfterMinor: afterFee,
            note: 'Errand reimbursement — settled directly with the requester',
          },
        });
      }

      // FR-WM-07: free the rider for the next task.
      await tx.riderState.update({
        where: { userId: riderId },
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
          tasksCompleted: completed,
          avgDeliverySeconds: newAvg,
          acceptanceRateBps:
            (current?.tasksOffered ?? 0) > 0
              ? Math.round(((current!.tasksAccepted ?? 0) / current!.tasksOffered) * 10_000)
              : 0,
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

      return {
        feeMinor: task.feeMinor,
        isCash,
        orderReference: task.order?.reference ?? null,
        reimbursementMinor: task.reimbursementMinor ?? 0,
      };
    });

    await this.redis.markRiderFree(collegeId, riderId);

    this.gateway.notifyTaskStatus(collegeId, taskId, 'COMPLETED');

    this.logger.log(
      `Task ${taskId} completed by ${riderId}, fee ${result.feeMinor} (${
        result.isCash ? 'cash' : 'wallet'
      })`,
    );

    return {
      taskId,
      status: 'COMPLETED',
      deliveredAt: now,
      feeMinor: result.feeMinor,
      feeLabel: formatMinor(result.feeMinor),
      settledInCash: result.isCash,
      message: result.isCash
        ? `Delivered. You keep ${formatMinor(result.feeMinor)} from the cash you collected.`
        : `Delivered. ${formatMinor(result.feeMinor)} added to your wallet.`,
      // FR-DLV-16: both parties are prompted to rate, and it is skippable.
      ratingPrompt: { taskId, optional: true },
    };
  }

  /** FR-DLV-14, FR-ADM-04 */
  private async escalate(taskId: string, collegeId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({
        where: { id: taskId },
        select: { status: true },
      });
      if (!task || task.status !== 'PICKED_UP') return;

      assertTaskTransition(TaskStatus.PICKED_UP, TaskEvent.OTP_ATTEMPTS_EXHAUSTED);

      await tx.task.update({
        where: { id: taskId },
        data: { status: 'ESCALATED', escalatedAt: new Date(), resolutionNote: reason },
      });

      await tx.auditLog.create({
        data: {
          actorId: null,
          collegeId,
          action: AuditAction.TASK_ESCALATED,
          targetType: 'task',
          targetId: taskId,
          detail: { reason },
        },
      });
    });

    this.gateway.notifyTaskStatus(collegeId, taskId, 'ESCALATED', { reason });
    this.logger.warn(`Task ${taskId} escalated: ${reason}`);
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

    if (task.riderId !== user.userId && user.role === 'STUDENT') {
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

  private async balanceTx(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    const last = await tx.walletEntry.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfterMinor: true },
    });
    return last?.balanceAfterMinor ?? 0;
  }
}
