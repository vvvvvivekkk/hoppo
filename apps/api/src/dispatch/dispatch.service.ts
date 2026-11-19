import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import {
  OrderEvent,
  OrderStatus,
  TaskEvent,
  TaskStatus,
  assertOrderTransition,
  assertTaskTransition,
  quoteFee,
  redisKeys,
  type FeeBand,
} from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { DispatchGateway } from './dispatch.gateway';

export interface EligibleRider {
  userId: string;
  distanceM: number;
}

/**
 * The dispatcher.
 *
 * Nothing in the SRS creates this, which is resolution R-03: FR-DLV-01
 * broadcasts when an order's remaining preparation time drops below a
 * threshold, FR-DLV-06 re-broadcasts when an acceptance window expires, and
 * FR-WM-06 disables work mode after two hours idle. None of those is
 * triggered by a user action — something has to wake up on a timer and look.
 *
 * Three ticks, each backed by a partial index so the scan stays small however
 * large the task table grows (ADR-005).
 *
 * Every tick is written to be safe when two API instances run it at once: a
 * short Redis lock avoids duplicated work, and correctness rests on the
 * conditional UPDATE in `accept` plus the state machine refusing illegal
 * transitions — never on the lock.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: DispatchGateway,
  ) {}

  // =======================================================================
  // Tick 1: tasks due for their first broadcast — FR-DLV-01
  // =======================================================================

  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'dispatch-due' })
  async dispatchDueTasks(): Promise<void> {
    // Uses task_dispatch_due_partial.
    const due = await this.prisma.task.findMany({
      where: {
        status: 'CREATED',
        dispatchDueAt: { not: null, lte: new Date() },
      },
      select: { id: true, collegeId: true },
      take: 50,
    });

    for (const task of due) {
      await this.withTaskLock(task.id, 10, async () => {
        await this.broadcast(task.id, { round: 0 });
      });
    }
  }

  // =======================================================================
  // Tick 2: acceptance windows that have expired — FR-DLV-06, FR-DLV-07
  // =======================================================================

  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'offer-expiry' })
  async sweepExpiredOffers(): Promise<void> {
    // Uses task_offer_expiry_partial.
    const expired = await this.prisma.task.findMany({
      where: {
        status: 'BROADCASTING',
        offerExpiresAt: { not: null, lte: new Date() },
      },
      select: {
        id: true,
        collegeId: true,
        broadcastRound: true,
        college: { select: { config: { select: { maxBroadcastRounds: true } } } },
      },
      take: 50,
    });

    for (const task of expired) {
      await this.withTaskLock(task.id, 10, async () => {
        const maxRounds = task.college.config?.maxBroadcastRounds ?? 3;

        // broadcastRound counts rounds already *sent*. Round 1 of 3 sent
        // means two remain.
        if (task.broadcastRound < maxRounds) {
          this.logger.log(
            `Task ${task.id} round ${task.broadcastRound} expired; re-broadcasting`,
          );
          await this.broadcast(task.id, { round: task.broadcastRound });
        } else {
          await this.retireUnfulfilled(task.id);
        }
      });
    }
  }

  // =======================================================================
  // Tick 3: the shop acceptance window — FR-SHP-04
  // =======================================================================

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'shop-accept-expiry' })
  async sweepUnacceptedOrders(): Promise<void> {
    // Uses order_shop_open_partial.
    const candidates = await this.prisma.order.findMany({
      where: { status: 'PLACED' },
      select: {
        id: true,
        reference: true,
        collegeId: true,
        studentId: true,
        placedAt: true,
        paymentMethod: true,
        totalMinor: true,
        task: { select: { id: true, status: true } },
        shopListing: {
          select: {
            id: true,
            college: { select: { config: { select: { shopAcceptWindowSeconds: true } } } },
          },
        },
      },
      take: 100,
    });

    const now = Date.now();

    for (const order of candidates) {
      const windowSeconds = order.shopListing.college.config?.shopAcceptWindowSeconds ?? 300;
      if (order.placedAt.getTime() + windowSeconds * 1000 > now) continue;

      this.logger.log(`Order ${order.reference} not accepted within ${windowSeconds}s; cancelling`);

      try {
        await this.prisma.$transaction(async (tx) => {
          const fresh = await tx.order.findUnique({
            where: { id: order.id },
            select: { status: true },
          });
          // The shop may have accepted between the read and here.
          if (!fresh || fresh.status !== 'PLACED') return;

          assertOrderTransition(OrderStatus.PLACED, OrderEvent.ACCEPT_WINDOW_EXPIRED);

          await tx.order.update({
            where: { id: order.id },
            data: {
              status: 'CANCELLED',
              cancelledAt: new Date(),
              cancelledBy: 'SYSTEM',
              cancelledReason: `The shop did not respond within ${Math.round(
                windowSeconds / 60,
              )} minutes.`,
            },
          });

          if (order.task) {
            await tx.task.update({
              where: { id: order.task.id },
              data: { status: 'CANCELLED', cancelledAt: new Date() },
            });
          }

          // FR-SHP-04: release any held wallet amount.
          if (order.paymentMethod === 'WALLET') {
            const last = await tx.walletEntry.findFirst({
              where: { userId: order.studentId },
              orderBy: { createdAt: 'desc' },
              select: { balanceAfterMinor: true },
            });
            const balance = last?.balanceAfterMinor ?? 0;
            await tx.walletEntry.create({
              data: {
                userId: order.studentId,
                direction: 'CREDIT',
                amountMinor: order.totalMinor,
                type: 'ORDER_RELEASE',
                orderId: order.id,
                balanceAfterMinor: balance + order.totalMinor,
                note: `Hold released, shop did not accept order ${order.reference}`,
              },
            });
          }
        });

        this.gateway.notifyOrderStatus(order.collegeId, order.id, 'CANCELLED', {
          reason: 'SHOP_DID_NOT_RESPOND',
        });
      } catch (error) {
        this.logger.error(
          `Failed to expire order ${order.reference}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  // =======================================================================
  // Tick 4: work mode idle sweep — FR-WM-06
  // =======================================================================

  @Cron(CronExpression.EVERY_MINUTE, { name: 'work-mode-idle' })
  async sweepIdleRiders(): Promise<void> {
    const colleges = await this.prisma.college.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, config: { select: { workModeIdleTimeoutMinutes: true } } },
    });

    for (const college of colleges) {
      const timeoutMinutes = college.config?.workModeIdleTimeoutMinutes ?? 120;
      const cutoff = new Date(Date.now() - timeoutMinutes * 60_000);

      const idle = await this.prisma.riderState.findMany({
        where: {
          workModeOn: true,
          activeTaskId: null,
          user: { collegeId: college.id },
          OR: [{ lastPingAt: null }, { lastPingAt: { lt: cutoff } }],
        },
        select: { userId: true },
        take: 200,
      });

      if (idle.length === 0) continue;

      await this.prisma.riderState.updateMany({
        where: { userId: { in: idle.map((r) => r.userId) } },
        data: { workModeOn: false },
      });

      for (const rider of idle) {
        await this.redis.removeRider(college.id, rider.userId);
        this.gateway.notifyWorkModeDisabled(rider.userId, timeoutMinutes);
      }

      this.logger.log(
        `Work mode disabled for ${idle.length} idle rider(s) at college ${college.id}`,
      );
    }
  }

  // =======================================================================
  // Broadcasting — FR-DLV-02, FR-DLV-03, FR-DLV-06
  // =======================================================================

  /**
   * Offer a task to every eligible rider at once.
   *
   * `round` is the number of rounds already sent, so the first call passes 0
   * and the new round becomes 1.
   */
  async broadcast(taskId: string, opts: { round: number }): Promise<{
    eligibleCount: number;
    round: number;
    feeMinor: number;
    radiusM: number;
  } | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        collegeId: true,
        type: true,
        status: true,
        requesterId: true,
        pickupLabel: true,
        pickupLatitude: true,
        pickupLongitude: true,
        dropLabel: true,
        dropLatitude: true,
        dropLongitude: true,
        distanceM: true,
        baseFeeMinor: true,
        description: true,
        reimbursementMinor: true,
        order: {
          select: {
            reference: true,
            status: true,
            expectedReadyAt: true,
            itemsSubtotalMinor: true,
            shopListing: { select: { shop: { select: { name: true } } } },
          },
        },
        college: {
          select: {
            config: {
              select: {
                acceptanceWindowSeconds: true,
                initialProximityM: true,
                proximityIncrementM: true,
                feeIncrementMinor: true,
                maxBroadcastRounds: true,
              },
            },
            feeBands: {
              select: { minDistanceM: true, maxDistanceM: true, feeMinor: true },
              orderBy: { minDistanceM: 'asc' },
            },
          },
        },
      },
    });

    if (!task) return null;

    // Only CREATED (first broadcast) or BROADCASTING (re-broadcast) may go out.
    if (task.status !== 'CREATED' && task.status !== 'BROADCASTING') {
      this.logger.debug(`Task ${taskId} is ${task.status}; not broadcasting`);
      return null;
    }

    // A cancelled or already-collected order must not summon a rider.
    if (task.order && !['PREPARING', 'READY'].includes(task.order.status)) {
      this.logger.debug(
        `Task ${taskId} order is ${task.order.status}; not broadcasting`,
      );
      return null;
    }

    const config = task.college.config;
    const newRound = opts.round + 1;

    const acceptanceWindowSeconds = config?.acceptanceWindowSeconds ?? 60;
    const initialProximityM = config?.initialProximityM ?? 1500;
    const proximityIncrementM = config?.proximityIncrementM ?? 1000;
    const feeIncrementMinor = config?.feeIncrementMinor ?? 500;

    // FR-DLV-06: each round widens the radius and raises the offer. ADR-004:
    // the raise is borne by the platform, not added to the requester's bill —
    // which is why baseFeeMinor is left untouched.
    const radiusM = initialProximityM + opts.round * proximityIncrementM;

    const bands: FeeBand[] = task.college.feeBands.map((b) => ({
      minDistanceM: b.minDistanceM,
      maxDistanceM: b.maxDistanceM,
      feeMinor: b.feeMinor,
    }));

    const fee = quoteFee({
      bands,
      distanceM: task.distanceM,
      broadcastRound: opts.round,
      feeIncrementMinor,
    });

    // The offer fee is derived from the task's own base rather than the band,
    // so a band edited mid-flight cannot reduce what a rider was promised.
    const offeredFeeMinor = task.baseFeeMinor + opts.round * feeIncrementMinor;

    const eligible = await this.findEligibleRiders({
      collegeId: task.collegeId,
      latitude: task.pickupLatitude,
      longitude: task.pickupLongitude,
      radiusM,
      excludeUserIds: [task.requesterId],
    });

    const offerExpiresAt = new Date(Date.now() + acceptanceWindowSeconds * 1000);

    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.task.findUnique({
        where: { id: taskId },
        select: { status: true, broadcastRound: true },
      });
      if (!fresh || (fresh.status !== 'CREATED' && fresh.status !== 'BROADCASTING')) return;

      // Guards against two instances both broadcasting the same round.
      if (fresh.broadcastRound >= newRound) return;

      const event =
        fresh.status === 'CREATED'
          ? TaskEvent.DISPATCH_DUE
          : TaskEvent.WINDOW_EXPIRED_ROUNDS_REMAIN;
      assertTaskTransition(fresh.status as TaskStatus, event);

      await tx.task.update({
        where: { id: taskId },
        data: {
          status: 'BROADCASTING',
          broadcastRound: newRound,
          currentProximityM: radiusM,
          feeMinor: offeredFeeMinor,
          offerExpiresAt,
          dispatchDueAt: null,
          firstBroadcastAt: fresh.status === 'CREATED' ? new Date() : undefined,
        },
      });

      // FR-DLV-09 / FR-ADM-05: one row per round, so "how long to find a
      // rider" and "how often do we fail" are answerable without guessing.
      await tx.broadcastLog.upsert({
        where: { taskId_round: { taskId, round: newRound } },
        update: { eligibleCount: eligible.length, radiusM, feeMinor: offeredFeeMinor },
        create: {
          taskId,
          round: newRound,
          radiusM,
          feeMinor: offeredFeeMinor,
          eligibleCount: eligible.length,
          outcome: 'PENDING',
        },
      });
    });

    const offer = {
      taskId: task.id,
      type: task.type,
      round: newRound,
      pickupLabel: task.pickupLabel,
      pickupLatitude: task.pickupLatitude,
      pickupLongitude: task.pickupLongitude,
      dropLabel: task.dropLabel,
      dropLatitude: task.dropLatitude,
      dropLongitude: task.dropLongitude,
      distanceM: task.distanceM,
      feeMinor: offeredFeeMinor,
      description: task.description,
      reimbursementMinor: task.reimbursementMinor,
      orderReference: task.order?.reference ?? null,
      shopName: task.order?.shopListing.shop.name ?? null,
      expectedReadyAt: task.order?.expectedReadyAt ?? null,
      expiresAt: offerExpiresAt,
      acceptanceWindowSeconds,
    };

    // FR-DLV-03: delivered to all eligible riders simultaneously.
    // NFR-P-02: within 3 seconds — the WebSocket is already connected, so
    // this is a push rather than a poll.
    this.gateway.sendOffer(
      task.collegeId,
      eligible.map((r) => r.userId),
      offer,
    );

    this.logger.log(
      `Broadcast task ${taskId} round ${newRound}: ${eligible.length} rider(s) within ${radiusM}m, fee ${offeredFeeMinor}`,
    );

    return { eligibleCount: eligible.length, round: newRound, feeMinor: offeredFeeMinor, radiusM };
  }

  /**
   * FR-DLV-02: riders who are, at the moment of broadcast, in the same
   * college, verified and not suspended, in work mode, holding no active
   * task, and within the configured proximity of the pickup point.
   *
   * Proximity comes from a Redis GEO set rather than from Postgres — see
   * resolution R-02. The remaining conditions are confirmed against the
   * database, because Redis holds presence and Postgres holds the truth about
   * who is allowed to ride.
   */
  async findEligibleRiders(params: {
    collegeId: string;
    latitude: number;
    longitude: number;
    radiusM: number;
    excludeUserIds?: string[];
  }): Promise<EligibleRider[]> {
    const { collegeId, latitude, longitude, radiusM, excludeUserIds = [] } = params;

    const nearby = await this.redis.findRidersNear({
      collegeId,
      latitude,
      longitude,
      radiusM,
      limit: 200,
    });

    if (nearby.length === 0) return [];

    const busy = new Set(await this.redis.getBusyRiders(collegeId));
    const excluded = new Set(excludeUserIds);

    const candidateIds = nearby
      .map((r) => r.userId)
      .filter((id) => !busy.has(id) && !excluded.has(id));

    if (candidateIds.length === 0) return [];

    // Confirm against the database. Redis can be stale — a rider suspended a
    // second ago is still in the GEO set — and an offer must never reach
    // someone no longer entitled to it.
    const allowed = await this.prisma.user.findMany({
      where: {
        id: { in: candidateIds },
        collegeId,
        role: 'STUDENT',
        status: 'ACTIVE',
        studentProfile: { verificationStatus: 'VERIFIED' },
        riderState: {
          workModeOn: true,
          activeTaskId: null,
          OR: [{ barredUntil: null }, { barredUntil: { lte: new Date() } }],
        },
      },
      select: { id: true },
    });

    const allowedIds = new Set(allowed.map((u) => u.id));

    return nearby.filter((r) => allowedIds.has(r.userId));
  }

  // =======================================================================
  // Assignment — FR-DLV-04, the one that matters
  // =======================================================================

  /**
   * Assign a task to the first rider who accepts.
   *
   * This is the race the SRS warns will embarrass the product: two riders tap
   * accept forty milliseconds apart, and a read-then-write implementation
   * assigns both.
   *
   * The fix is a single conditional UPDATE. The database checks and writes in
   * one indivisible statement, and reports how many rows it changed:
   *
   *   1 -> this caller won the task
   *   0 -> somebody else won, or the task moved on
   *
   * There is no window between the check and the write for a second rider to
   * slip through, because there is no check separate from the write.
   *
   * Three further things make this safe:
   *
   *  - `rider_state.active_task_id` is UNIQUE, so one rider cannot hold two
   *    tasks even if the application tries (FR-WM-07). It is set inside the
   *    same transaction, so a rider who already holds a task fails the whole
   *    thing and the task returns to the pool.
   *  - A check constraint requires `rider_id` to be null while BROADCASTING
   *    and non-null once ASSIGNED.
   *  - No Redis lock is involved in deciding the winner. A lock would be a
   *    second source of truth that can disagree with the database.
   *
   * ADR-001.
   */
  async accept(
    userId: string,
    taskId: string,
  ): Promise<{
    taskId: string;
    status: string;
    feeMinor: number;
    pickupLabel: string;
    dropLabel: string;
    chatRoomId: string;
  }> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        collegeId: true,
        status: true,
        requesterId: true,
        broadcastRound: true,
        feeMinor: true,
        pickupLabel: true,
        dropLabel: true,
        offerExpiresAt: true,
        orderId: true,
        order: { select: { shopListing: { select: { shop: { select: { staff: { select: { userId: true } } } } } } } },
      },
    });

    if (!task) {
      throw new ConflictException({
        code: 'TASK_NOT_FOUND',
        message: 'That task is no longer available.',
      });
    }

    if (task.requesterId === userId) {
      throw new ConflictException({
        code: 'CANNOT_ACCEPT_OWN_TASK',
        message: 'You cannot deliver your own order.',
      });
    }

    // A cheap pre-check for a better error message. It is *not* the guard —
    // the conditional UPDATE below is, and it would reject this case anyway.
    if (task.status !== 'BROADCASTING') {
      throw new ConflictException({
        code: 'ALREADY_TAKEN',
        message: 'That task has already been taken.',
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      /**
       * The conditional update. Everything about FR-DLV-04 rests on this one
       * statement, and on the fact that it is one statement.
       */
      const rowsAffected = await tx.$executeRaw`
        UPDATE "task"
        SET rider_id = ${userId},
            status = 'ASSIGNED',
            assigned_at = now(),
            offer_expires_at = NULL,
            updated_at = now()
        WHERE id = ${taskId}
          AND rider_id IS NULL
          AND status = 'BROADCASTING'
      `;

      if (rowsAffected === 0) {
        // FR-DLV-04: "return a clear 'already taken' response to any later
        // acceptance".
        throw new ConflictException({
          code: 'ALREADY_TAKEN',
          message: 'Another rider took that task first.',
        });
      }

      // FR-WM-07, enforced by a UNIQUE constraint. If this rider already
      // holds a task, this throws and the whole transaction rolls back —
      // including the assignment above — so the task returns to the pool
      // rather than being stranded.
      await tx.riderState.update({
        where: { userId },
        data: { activeTaskId: taskId },
      });

      // FR-DLV-10: a task chat room with the requester and the rider, plus
      // the shop for a shop order.
      const memberIds = new Set<string>([task.requesterId, userId]);
      for (const staff of task.order?.shopListing.shop.staff ?? []) {
        memberIds.add(staff.userId);
      }

      const room = await tx.chatRoom.create({
        data: {
          collegeId: task.collegeId,
          type: 'TASK',
          taskId,
          members: {
            create: [...memberIds].map((id) => ({ userId: id })),
          },
        },
        select: { id: true },
      });

      await tx.broadcastLog.updateMany({
        where: { taskId, round: task.broadcastRound },
        data: { outcome: 'ACCEPTED', acceptedByUserId: userId, resolvedAt: new Date() },
      });

      // FR-TRST-03: acceptance feeds the reliability metric.
      await tx.riderReliability.upsert({
        where: { userId },
        update: { tasksAccepted: { increment: 1 } },
        create: { userId, tasksAccepted: 1 },
      });

      return { chatRoomId: room.id };
    });

    // Redis is updated after the transaction commits. If this fails, the
    // rider is still correctly assigned in the database and the next
    // broadcast's database confirmation excludes them anyway — Redis is an
    // optimisation here, not the guarantee.
    await this.redis.markRiderBusy(task.collegeId, userId);

    // FR-DLV-05: withdraw the offer from every other rider's device.
    // NFR-P-03: within 2 seconds.
    this.gateway.withdrawOffer(task.collegeId, taskId, userId);
    this.gateway.notifyTaskStatus(task.collegeId, taskId, 'ASSIGNED', { riderId: userId });

    this.logger.log(`Task ${taskId} assigned to rider ${userId}`);

    return {
      taskId,
      status: 'ASSIGNED',
      feeMinor: task.feeMinor,
      pickupLabel: task.pickupLabel,
      dropLabel: task.dropLabel,
      chatRoomId: result.chatRoomId,
    };
  }

  // =======================================================================
  // Unfulfilled — FR-DLV-07
  // =======================================================================

  private async retireUnfulfilled(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, collegeId: true, status: true, broadcastRound: true, orderId: true },
    });

    if (!task || task.status !== 'BROADCASTING') return;

    await this.prisma.$transaction(async (tx) => {
      assertTaskTransition(TaskStatus.BROADCASTING, TaskEvent.WINDOW_EXPIRED_ROUNDS_EXHAUSTED);

      await tx.task.update({
        where: { id: taskId },
        data: { status: 'UNFULFILLED', offerExpiresAt: null },
      });

      await tx.broadcastLog.updateMany({
        where: { taskId, outcome: 'PENDING' },
        data: { outcome: 'EXPIRED', resolvedAt: new Date() },
      });
    });

    this.logger.warn(
      `Task ${taskId} unfulfilled after ${task.broadcastRound} round(s); offering the requester a choice`,
    );

    // FR-DLV-07: the requester and the shop are notified, and the requester is
    // offered the three choices.
    this.gateway.notifyTaskStatus(task.collegeId, taskId, 'UNFULFILLED', {
      choices: ['KEEP_WAITING', 'COLLECT_IN_PERSON', 'CANCEL'],
    });
  }

  /**
   * Put an unfulfilled task back into the pool at round 0 with the base fee.
   *
   * Resolution R-08: a task returning to the pool is a fresh search. Resuming
   * at round 3 of 3 would retire it again on the next tick, having never
   * genuinely offered it again.
   */
  async rebroadcastFromScratch(taskId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({
        where: { id: taskId },
        select: { status: true, baseFeeMinor: true },
      });
      if (!task) return;

      await tx.task.update({
        where: { id: taskId },
        data: {
          status: 'CREATED',
          broadcastRound: 0,
          feeMinor: task.baseFeeMinor,
          currentProximityM: null,
          offerExpiresAt: null,
          dispatchDueAt: new Date(),
        },
      });

      await tx.broadcastLog.deleteMany({ where: { taskId, outcome: 'PENDING' } });
    });

    await this.broadcast(taskId, { round: 0 });
  }

  // =======================================================================
  // Locking
  // =======================================================================

  /**
   * Run a block while holding a short lock on a task.
   *
   * Stops two API instances doing the same dispatch work. Deliberately *not*
   * the correctness guarantee — if the lock is unavailable or Redis is down,
   * the worst outcome is duplicated effort, and the conditional UPDATE and
   * state machine still prevent a double assignment or an illegal transition.
   */
  private async withTaskLock(
    taskId: string,
    ttlSeconds: number,
    fn: () => Promise<void>,
  ): Promise<void> {
    const key = redisKeys.dispatchLock(taskId);

    let acquired = false;
    try {
      acquired = await this.redis.acquireLock(key, ttlSeconds);
    } catch (error) {
      // Redis unavailable: proceed without the lock rather than stalling
      // dispatch entirely.
      this.logger.warn(
        `Could not acquire dispatch lock for ${taskId}; proceeding unlocked: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      acquired = true;
    }

    if (!acquired) return;

    try {
      await fn();
    } catch (error) {
      this.logger.error(
        `Dispatch work failed for task ${taskId}`,
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      try {
        await this.redis.releaseLock(key);
      } catch {
        // The TTL will clear it.
      }
    }
  }
}
