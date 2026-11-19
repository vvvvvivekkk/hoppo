import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  OrderEvent,
  OrderStatus,
  TaskEvent,
  TaskStatus,
  assertOrderTransition,
  assertTaskTransition,
  redisKeys,
} from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { readWalletHead } from '../wallet/wallet-ledger';
import { DispatchGateway } from './dispatch.gateway';

/**
 * Why a task could not be accepted, in words a rider can act on.
 *
 * `riderId` is checked before `status`, because "somebody already has it" is
 * the only reason that is about another rider — every other case is about the
 * task's own lifecycle and needs a different response from the person holding
 * the phone.
 */
export function describeUnacceptable(
  status: TaskStatus,
  riderId: string | null,
  offerExpired = false,
): { code: string; message: string } {
  if (riderId !== null) {
    return { code: 'ALREADY_TAKEN', message: 'Another rider took that task first.' };
  }

  switch (status) {
    case 'BROADCASTING':
      // L1: the accept UPDATE refuses an offer whose window has closed, and
      // the sweep that moves the task on runs every few seconds — so for a
      // moment a task is still BROADCASTING, unheld, and unacceptable. That
      // is not competition and not a bug; it is a rider who tapped late.
      if (offerExpired) {
        return {
          code: 'OFFER_EXPIRED',
          message:
            'That offer has expired. If nobody took it, it will come round again shortly.',
        };
      }
      // Still on offer, unheld, and yet the UPDATE did not take it: nothing
      // legitimate looks like this, so it falls through to the honest
      // "cannot be accepted" answer below rather than inventing a reason.
      return {
        code: 'TASK_NOT_ACCEPTABLE',
        message: `That delivery cannot be accepted right now (${status.toLowerCase()}).`,
      };
    case 'CREATED':
      // Dispatch broadcasts shortly before the order is due, so a rider can
      // reach a task id — from a stale screen or a shared link — before it is
      // offered to anybody.
      return {
        code: 'NOT_YET_OFFERED',
        message: 'That delivery has not been offered yet. Stay online and it will reach you.',
      };
    case 'UNFULFILLED':
    case 'ESCALATED':
      return {
        code: 'OFFER_CLOSED',
        message: 'That delivery is no longer being offered. The student is deciding what to do.',
      };
    case 'CANCELLED':
      return { code: 'TASK_CANCELLED', message: 'That order was cancelled.' };
    case 'DELIVERED':
    case 'COMPLETED':
      return { code: 'TASK_FINISHED', message: 'That delivery is already finished.' };
    default:
      // ASSIGNED or PICKED_UP with no rider is not a state the constraints
      // allow, so this is a bug rather than a race. Say so plainly instead of
      // dressing it up as competition.
      return {
        code: 'TASK_NOT_ACCEPTABLE',
        message: `That delivery cannot be accepted right now (${status.toLowerCase()}).`,
      };
  }
}

/**
 * Redis cannot store an empty set, so a round that found nobody would leave
 * no key — indistinguishable from "Redis lost the record", which fails open.
 * The sentinel makes "recorded, and it was nobody" a state that exists. It is
 * not a UUID, so it can never collide with a user id.
 */
const OFFERED_SET_SENTINEL = '-';

/**
 * L4: how many ping intervals may pass before a rider is treated as gone.
 * The same three the gateway uses for the position's own staleness.
 */
const PING_FRESHNESS_INTERVALS = 3;

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
            shop: { select: { staff: { select: { userId: true } } } },
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
        const cancelled = await this.prisma.$transaction(async (tx) => {
          // The per-user wallet lock, first, before any row is touched: the
          // release below computes a running balance from the latest ledger
          // row, and two transactions doing that for one student at once
          // would both read the same "latest" and write the same balance.
          // Every wallet-writing transaction takes this same lock, and takes
          // it before its row locks so the two cannot deadlock.
          if (order.paymentMethod === 'WALLET') {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wallet:' || ${order.studentId}))`;
          }

          assertOrderTransition(OrderStatus.PLACED, OrderEvent.ACCEPT_WINDOW_EXPIRED);

          // ADR-001: the shop may accept at any moment, so "is it still
          // PLACED" is asked by the UPDATE itself. A read followed by an
          // unconditional write would cancel an order the shop accepted in
          // between — and release a hold on food being cooked.
          const moved = await tx.order.updateMany({
            where: { id: order.id, status: 'PLACED' },
            data: {
              status: 'CANCELLED',
              cancelledAt: new Date(),
              cancelledBy: 'SYSTEM',
              cancelledReason: `The shop did not respond within ${Math.round(
                windowSeconds / 60,
              )} minutes.`,
              // The hold is released a few lines down, in this transaction.
              // Without this the order went on saying HELD about money the
              // ledger had already given back. In the same conditional UPDATE
              // as the cancel, as every other cancel path does it, so the
              // status and the payment status cannot be seen to disagree.
              ...(order.paymentMethod === 'WALLET' ? { paymentStatus: 'REFUNDED' as const } : {}),
            },
          });
          if (moved.count !== 1) return false;

          if (order.task) {
            await tx.task.updateMany({
              where: { id: order.task.id, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
              data: { status: 'CANCELLED', cancelledAt: new Date(), offerExpiresAt: null },
            });
          }

          // FR-SHP-04: release any held wallet amount. Read after the lock,
          // and through the ledger's own helper: "the latest entry" needs a
          // tie-break when two land in one millisecond, and that rule lives
          // in one place (wallet-ledger.ts) so every writer agrees on it. The
          // new entry is stamped with the timestamp the helper hands back,
          // strictly after the one it was computed from.
          if (order.paymentMethod === 'WALLET') {
            const head = await readWalletHead(tx, order.studentId);
            await tx.walletEntry.create({
              data: {
                userId: order.studentId,
                direction: 'CREDIT',
                amountMinor: order.totalMinor,
                type: 'ORDER_RELEASE',
                orderId: order.id,
                balanceAfterMinor: head.balanceMinor + order.totalMinor,
                createdAt: head.nextCreatedAt,
                note: `Hold released, shop did not accept order ${order.reference}`,
              },
            });
          }

          return true;
        });

        // Nothing changed — the shop got there first — so nothing is announced.
        if (!cancelled) continue;

        // M7: the student and the shop, not the whole college.
        this.gateway.notifyOrderStatus(
          [order.studentId, ...order.shopListing.shop.staff.map((s) => s.userId)],
          order.id,
          'CANCELLED',
          { reason: 'SHOP_DID_NOT_RESPOND' },
        );
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
            totalMinor: true,
            paymentMethod: true,
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
                riderPingIntervalSeconds: true,
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

    // The offer fee is derived from the task's own base rather than re-quoted
    // from the college's current fee bands, so a band edited mid-flight cannot
    // change what a rider was already promised. `quoteFee` used to be called
    // here and its result thrown away — dead since that decision, and only
    // visible once `pnpm lint` started working.
    const offeredFeeMinor = task.baseFeeMinor + opts.round * feeIncrementMinor;

    const eligible = await this.findEligibleRiders({
      collegeId: task.collegeId,
      latitude: task.pickupLatitude,
      longitude: task.pickupLongitude,
      radiusM,
      excludeUserIds: [task.requesterId],
      pingIntervalSeconds: config?.riderPingIntervalSeconds ?? 15,
    });

    const offerExpiresAt = new Date(Date.now() + acceptanceWindowSeconds * 1000);

    // The status this round moves the task *from*. Round 0 is a first
    // broadcast and starts from CREATED; any later round is a re-broadcast of
    // a task already on offer.
    const fromStatus: TaskStatus = opts.round === 0 ? TaskStatus.CREATED : TaskStatus.BROADCASTING;
    assertTaskTransition(
      fromStatus,
      fromStatus === TaskStatus.CREATED
        ? TaskEvent.DISPATCH_DUE
        : TaskEvent.WINDOW_EXPIRED_ROUNDS_REMAIN,
    );

    // L2: the transaction reports whether it did anything. It used to return
    // nothing, and the code below emitted offers regardless — so the instance
    // that lost the race for a round, or arrived after a rider had accepted,
    // still pushed an offer for a task that was no longer on offer.
    const sent = await this.prisma.$transaction(async (tx) => {
      // ADR-001: one conditional UPDATE decides. `broadcast_round = round`
      // is what stops two instances both sending the same round, and
      // `rider_id IS NULL` plus the status is what stops a broadcast landing
      // on top of an accept that committed a millisecond ago. The previous
      // read-then-write could do both.
      const moved = await tx.task.updateMany({
        where: {
          id: taskId,
          status: fromStatus,
          riderId: null,
          broadcastRound: opts.round,
        },
        data: {
          status: 'BROADCASTING',
          broadcastRound: newRound,
          currentProximityM: radiusM,
          feeMinor: offeredFeeMinor,
          offerExpiresAt,
          dispatchDueAt: null,
          firstBroadcastAt: fromStatus === TaskStatus.CREATED ? new Date() : undefined,
        },
      });
      if (moved.count !== 1) return false;

      // M5: the round before this one found nobody, so it is EXPIRED, not
      // still PENDING. Left alone these rows accumulated, and the only code
      // that ever cleared them was a DELETE the append-only trigger refuses.
      await tx.broadcastLog.updateMany({
        where: { taskId, outcome: 'PENDING', round: { lt: newRound } },
        data: { outcome: 'EXPIRED', resolvedAt: new Date() },
      });

      // FR-DLV-09 / FR-ADM-05: one row per round, so "how long to find a
      // rider" and "how often do we fail" are answerable without guessing.
      //
      // (task_id, round) is unique and rows cannot be deleted, so a task that
      // returns to the pool after an abandonment meets its own earlier
      // round-1 row here. The update branch re-opens it — outcome, acceptor
      // and timestamps included. Without that the row kept saying ACCEPTED by
      // the rider who had since walked away.
      await tx.broadcastLog.upsert({
        where: { taskId_round: { taskId, round: newRound } },
        update: {
          eligibleCount: eligible.length,
          radiusM,
          feeMinor: offeredFeeMinor,
          sentAt: new Date(),
          outcome: 'PENDING',
          acceptedByUserId: null,
          resolvedAt: null,
        },
        create: {
          taskId,
          round: newRound,
          radiusM,
          feeMinor: offeredFeeMinor,
          eligibleCount: eligible.length,
          outcome: 'PENDING',
        },
      });

      return true;
    });

    if (!sent) {
      this.logger.debug(
        `Task ${taskId} round ${newRound} not broadcast: the task moved on or another instance sent it`,
      );
      return null;
    }

    const eligibleIds = eligible.map((r) => r.userId);

    // M8: record who is being offered this task *before* the offer leaves, so
    // the fastest possible accept still finds its own name on the list.
    const newlyOffered = await this.recordOfferedRiders(
      taskId,
      eligibleIds,
      newRound,
      acceptanceWindowSeconds,
    );

    // ADR-006: on a cash order the rider pays the shop out of their own
    // pocket at pickup and collects the full total at the door. That is
    // something to know *before* accepting — a rider with no cash on them
    // cannot do this delivery. Computed exactly as RiderService.activeTaskDetail
    // computes it, so the offer and the task screen cannot disagree.
    const isCashOrder = task.order?.paymentMethod === 'CASH';

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
      cashToPayShopMinor: isCashOrder ? (task.order?.itemsSubtotalMinor ?? 0) : 0,
      cashToCollectMinor: isCashOrder ? (task.order?.totalMinor ?? 0) : 0,
    };

    // FR-DLV-03: delivered to all eligible riders simultaneously.
    // NFR-P-02: within 3 seconds — the WebSocket is already connected, so
    // this is a push rather than a poll.
    this.gateway.sendOffer(eligibleIds, offer);

    // L5 / FR-TRST-03: nothing ever incremented tasks_offered, so the
    // acceptance rate divided by zero and was reported as null for everyone.
    // Counted once per rider per search — a rider who sees rounds 1, 2 and 3
    // of one task has had one opportunity to take it, not three. After the
    // send, and never allowed to fail it: a statistic is not worth an offer.
    await this.countOffers(newlyOffered);

    this.logger.log(
      `Broadcast task ${taskId} round ${newRound}: ${eligible.length} rider(s) within ${radiusM}m, fee ${offeredFeeMinor}`,
    );

    return { eligibleCount: eligible.length, round: newRound, feeMinor: offeredFeeMinor, radiusM };
  }

  /**
   * M8: remember who this round is offered to — a Redis set per task, under
   * `redisKeys.offeredRiders` — and report which of them had
   * not already been offered this task in an earlier round of the same search.
   *
   * Round 1 starts the set afresh — R-08 makes a task returning to the pool a
   * new search, and the rider who abandoned it should not be able to quietly
   * take it back without being offered it. Later rounds add to the set: a
   * rider shown round 1 who taps a moment after round 2 goes out was offered
   * the task, and refusing them would be pedantry.
   *
   * The TTL outlives the acceptance window with room to spare for the expiry
   * sweep; once the window has closed the accept UPDATE refuses on its own.
   *
   * Redis failing here must not stop dispatch (ADR-002). The accept path
   * fails open when the set is missing, so the cost of an outage is the M8
   * check being skipped for a while — not riders unable to work.
   */
  private async recordOfferedRiders(
    taskId: string,
    riderIds: string[],
    round: number,
    acceptanceWindowSeconds: number,
  ): Promise<string[]> {
    const key = redisKeys.offeredRiders(taskId);

    try {
      const already =
        round > 1 ? new Set(await this.redis.client.smembers(key)) : new Set<string>();

      const pipeline = this.redis.client.multi();
      if (round <= 1) pipeline.del(key);
      pipeline.sadd(key, OFFERED_SET_SENTINEL, ...riderIds);
      pipeline.expire(key, acceptanceWindowSeconds + 120);
      await pipeline.exec();

      return riderIds.filter((id) => !already.has(id));
    } catch (error) {
      this.logger.warn(
        `Could not record offered riders for task ${taskId}; accepts will not be ` +
          `checked against the offer list: ${error instanceof Error ? error.message : String(error)}`,
      );
      return riderIds;
    }
  }

  /**
   * M8: was this rider offered this task?
   *
   * `null` means "cannot say" — Redis is down, or the set is gone (flushed,
   * or a task put on offer by something other than `broadcast`). The caller
   * fails open on null, the same policy as the dispatch lock: Redis is never
   * the reason a delivery cannot happen.
   */
  private async wasOffered(taskId: string, userId: string): Promise<boolean | null> {
    const key = redisKeys.offeredRiders(taskId);

    try {
      const results = await this.redis.client.multi().exists(key).sismember(key, userId).exec();
      const exists = results?.[0]?.[1] === 1;
      if (!exists) {
        this.logger.warn(
          `No offer list for task ${taskId}; accepting without the offered-rider check`,
        );
        return null;
      }
      return results?.[1]?.[1] === 1;
    } catch (error) {
      this.logger.warn(
        `Could not read the offer list for task ${taskId}; proceeding unchecked: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** The riders a task was offered to, or null when that cannot be known. */
  private async offeredRiders(taskId: string): Promise<string[] | null> {
    try {
      const members = await this.redis.client.smembers(redisKeys.offeredRiders(taskId));
      if (members.length === 0) return null;
      return members.filter((id) => id !== OFFERED_SET_SENTINEL);
    } catch {
      return null;
    }
  }

  private async countOffers(riderIds: string[]): Promise<void> {
    if (riderIds.length === 0) return;

    try {
      // Two statements rather than N upserts: make sure every row exists,
      // then one atomic increment across all of them.
      await this.prisma.riderReliability.createMany({
        data: riderIds.map((userId) => ({ userId })),
        skipDuplicates: true,
      });
      await this.prisma.riderReliability.updateMany({
        where: { userId: { in: riderIds } },
        data: { tasksOffered: { increment: 1 } },
      });
    } catch (error) {
      this.logger.warn(
        `Could not count offers for ${riderIds.length} rider(s): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * M7: the people a task's status is the business of — the requester, the
   * rider if there is one, and the shop's staff for a shop order.
   *
   * Looked up rather than passed around because every caller would otherwise
   * carry its own slightly different idea of who that is.
   */
  async taskAudience(taskId: string): Promise<string[]> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        requesterId: true,
        riderId: true,
        order: {
          select: {
            studentId: true,
            shopListing: { select: { shop: { select: { staff: { select: { userId: true } } } } } },
          },
        },
      },
    });
    if (!task) return [];

    const ids = new Set<string>([task.requesterId]);
    if (task.riderId) ids.add(task.riderId);
    if (task.order) {
      ids.add(task.order.studentId);
      for (const staff of task.order.shopListing.shop.staff) ids.add(staff.userId);
    }
    return [...ids];
  }

  /**
   * Announce a task's new status to its audience. `alsoNotify` is for someone
   * the task row no longer names — a rider just released from it.
   *
   * Never throws: this runs after the state change has committed, and a
   * failed notification must not turn a successful request into an error.
   */
  async notifyTaskParties(
    taskId: string,
    status: string,
    extra: Record<string, unknown> = {},
    alsoNotify: string[] = [],
  ): Promise<void> {
    try {
      const audience = await this.taskAudience(taskId);
      this.gateway.notifyTaskStatus([...audience, ...alsoNotify], taskId, status, extra);
    } catch (error) {
      this.logger.warn(
        `Could not notify parties of task ${taskId} (${status}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** As notifyTaskParties, for the order a task carries. */
  async notifyOrderParties(
    taskId: string,
    orderId: string,
    status: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const audience = await this.taskAudience(taskId);
      this.gateway.notifyOrderStatus(audience, orderId, status, extra);
    } catch (error) {
      this.logger.warn(
        `Could not notify parties of order ${orderId} (${status}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    /** The college's configured ping interval; defaults to the schema default. */
    pingIntervalSeconds?: number;
  }): Promise<EligibleRider[]> {
    const {
      collegeId,
      latitude,
      longitude,
      radiusM,
      excludeUserIds = [],
      pingIntervalSeconds = 15,
    } = params;

    // L4: a rider who closed the app stays in the GEO set — the set's expiry
    // is on the whole college key, not on a member — and stays `workModeOn`
    // until the idle sweep, which by default waits two hours. For all of that
    // time they were being offered tasks they could not see, and every such
    // offer is an acceptance window wasted for a student waiting on food.
    // A device that is really there pings every interval; three missed is gone.
    const freshSince = new Date(
      Date.now() - pingIntervalSeconds * PING_FRESHNESS_INTERVALS * 1000,
    );

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
          lastPingAt: { gte: freshSince },
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
   *  - One rider cannot hold two tasks (FR-WM-07): `rider_state` is claimed
   *    by a second conditional UPDATE (`active_task_id IS NULL`) inside the
   *    same transaction, so a rider who already holds a task fails the whole
   *    thing and the task returns to the pool. The UNIQUE constraint on that
   *    column covers the other direction — two riders, one task.
   *  - The offer window is part of the same statement, judged by the
   *    database's clock, and only riders the task was offered to may try.
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
        riderId: true,
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

    // M8: an offer is addressed to particular riders — the ones in range,
    // verified, online and free when it went out. A task id is not a secret
    // (it travels in every offer and status event), so without this any
    // rider who learned one could take a task from across campus that the
    // dispatcher had deliberately not offered them.
    //
    // This is a permission check, not the race guard: it does not decide who
    // wins, only who may enter. `null` means the list could not be consulted,
    // and that fails open — see wasOffered.
    //
    // It comes *before* the status pre-check below, so the answer is the true
    // one. The other way round, a rider who was never offered a task and
    // tried one somebody already held was told ALREADY_TAKEN — "you were too
    // slow" — about a race they were never in, and whether they heard that or
    // NOT_OFFERED_TO_YOU depended on how quickly the real winner had tapped.
    if ((await this.wasOffered(taskId, userId)) === false) {
      throw new ConflictException({
        code: 'NOT_OFFERED_TO_YOU',
        message: 'That delivery was not offered to you. Offers you can take appear on your Work tab.',
      });
    }

    // A cheap pre-check for a better error message. It is *not* the guard —
    // the conditional UPDATE below is, and it would reject every case this
    // catches anyway.
    //
    // This used to answer ALREADY_TAKEN for any status other than
    // BROADCASTING, which was wrong for six of the eight task states and
    // actively misleading for two of them. A task still CREATED has not been
    // offered to anyone yet; telling a rider "someone else got it" sends them
    // off to wait for the next offer when the one in front of them is about
    // to arrive. Worse, it hid breakage: if dispatch stopped broadcasting
    // altogether, every accept would report healthy competition.
    if (task.status !== 'BROADCASTING') {
      throw new ConflictException(describeUnacceptable(task.status, task.riderId));
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
          AND (offer_expires_at IS NULL OR offer_expires_at > now())
      `;
      // L1, the last line: the offer window is part of the decision, judged
      // by the database's clock in the same statement. Without it a rider
      // could accept at the old fee in the seconds between a window closing
      // and the sweep re-broadcasting or retiring the task. NULL is allowed
      // because a task can be BROADCASTING with no deadline only if something
      // other than `broadcast` put it there, and that is not this rider's
      // fault.

      if (rowsAffected === 0) {
        /**
         * FR-DLV-04: "return a clear 'already taken' response to any later
         * acceptance". Losing this race is the expected outcome for every
         * rider but one.
         *
         * The row is read back *only to word the error*. The decision was
         * already made by the UPDATE above — zero rows means this rider did
         * not get it, whatever the reason — so this read cannot reintroduce
         * the read-then-write it would be a mistake to go back to. If the
         * read itself fails or races, the plain already-taken answer stands.
         */
        // "Expired" is asked of the database, by the same clock the UPDATE
        // used, so the wording cannot disagree with the decision.
        const [current] = await tx.$queryRaw<
          { status: TaskStatus; riderId: string | null; offerExpired: boolean }[]
        >`
          SELECT status::text AS "status",
                 rider_id AS "riderId",
                 (offer_expires_at IS NOT NULL AND offer_expires_at <= now()) AS "offerExpired"
          FROM "task"
          WHERE id = ${taskId}
        `;

        throw new ConflictException(
          current
            ? describeUnacceptable(current.status, current.riderId, current.offerExpired)
            : { code: 'ALREADY_TAKEN', message: 'Another rider took that task first.' },
        );
      }

      // FR-WM-07, M3: one rider, one task — decided by a conditional UPDATE.
      //
      // The comment that used to sit here said the UNIQUE constraint on
      // active_task_id made this safe. It does not: that constraint stops two
      // riders sharing one task, and says nothing about one rider's row being
      // overwritten with a second task. A plain `update` did exactly that, so
      // two accepts by the same rider for two different tasks both succeeded
      // and the first task was left ASSIGNED to someone who no longer knew
      // they held it.
      //
      // `active_task_id IS NULL` in the WHERE makes the second accept change
      // zero rows. Throwing rolls back the assignment above, so the task this
      // rider could not take goes straight back on offer.
      const claimed = await tx.riderState.updateMany({
        where: { userId, activeTaskId: null },
        data: { activeTaskId: taskId },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: 'ALREADY_HOLDING_TASK',
          message: 'Finish the task you are holding before accepting another.',
        });
      }

      // FR-DLV-10: a task chat room with the requester and the rider, plus
      // the shop for a shop order.
      const memberIds = new Set<string>([task.requesterId, userId]);
      for (const staff of task.order?.shopListing.shop.staff ?? []) {
        memberIds.add(staff.userId);
      }

      // H1: upsert, not create. chat_room.task_id is UNIQUE and an abandoned
      // task keeps its (archived) room for the dispute history, so the second
      // rider to accept a task hit a unique violation here, the transaction
      // rolled back, and the task could never be assigned again — every
      // accept after an abandonment was a 500.
      //
      // The room is re-opened, and its membership is made to be exactly the
      // people on the task *now*.
      const room = await tx.chatRoom.upsert({
        where: { taskId },
        update: { isArchived: false, archivedAt: null },
        create: { collegeId: task.collegeId, type: 'TASK', taskId },
        select: { id: true },
      });

      const members = [...memberIds];

      // Whoever is in the room but not on the task is the previous rider.
      // Marked as having left rather than deleted: their messages stay
      // attributable, and they stop being a member of a conversation about a
      // delivery that is no longer theirs.
      await tx.chatMember.updateMany({
        where: { roomId: room.id, userId: { notIn: members }, leftAt: null },
        data: { leftAt: new Date() },
      });

      // New members are added; a returning one (the requester, the shop, or a
      // rider who abandoned and was offered it again) is un-left.
      await tx.chatMember.createMany({
        data: members.map((id) => ({ roomId: room.id, userId: id })),
        skipDuplicates: true,
      });
      await tx.chatMember.updateMany({
        where: { roomId: room.id, userId: { in: members }, leftAt: { not: null } },
        data: { leftAt: null, joinedAt: new Date() },
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
    try {
      await this.redis.markRiderBusy(task.collegeId, userId);
    } catch (error) {
      // The assignment has committed. Turning that into a 500 would tell the
      // winner they lost.
      this.logger.warn(
        `Could not mark rider ${userId} busy in Redis: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // FR-DLV-05: withdraw the offer from every other rider's device.
    // NFR-P-03: within 2 seconds. M7: only the riders it was offered to.
    this.gateway.withdrawOffer(task.collegeId, taskId, userId, await this.offeredRiders(taskId));

    // M7: the requester, the shop and the rider — built from what this
    // method already read, so the winner's response does not wait on a query.
    this.gateway.notifyTaskStatus(
      [
        task.requesterId,
        userId,
        ...(task.order?.shopListing.shop.staff.map((s) => s.userId) ?? []),
      ],
      taskId,
      'ASSIGNED',
      { riderId: userId },
    );

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

    const retired = await this.prisma.$transaction(async (tx) => {
      assertTaskTransition(TaskStatus.BROADCASTING, TaskEvent.WINDOW_EXPIRED_ROUNDS_EXHAUSTED);

      // ADR-001: conditional, because a rider can accept between the read
      // above and here. An unconditional write would have tried to make an
      // ASSIGNED task UNFULFILLED with its rider still attached, which the
      // rider-presence CHECK refuses — a 500 in a cron tick, every time.
      const moved = await tx.task.updateMany({
        where: {
          id: taskId,
          status: 'BROADCASTING',
          riderId: null,
          broadcastRound: task.broadcastRound,
        },
        data: { status: 'UNFULFILLED', offerExpiresAt: null },
      });
      if (moved.count !== 1) return false;

      await tx.broadcastLog.updateMany({
        where: { taskId, outcome: 'PENDING' },
        data: { outcome: 'EXPIRED', resolvedAt: new Date() },
      });

      return true;
    });

    if (!retired) return;

    this.logger.warn(
      `Task ${taskId} unfulfilled after ${task.broadcastRound} round(s); offering the requester a choice`,
    );

    // FR-DLV-07: the requester and the shop are notified, and the requester is
    // offered the three choices.
    await this.notifyTaskParties(taskId, 'UNFULFILLED', {
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
        select: { baseFeeMinor: true },
      });
      if (!task) return;

      // Conditional (ADR-001): only a task nobody holds and nobody is being
      // offered goes back to the start. This used to reset whatever it found,
      // so a call arriving late could pull a task out from under the rider
      // who had just accepted it — or, with a rider attached, fail the
      // rider-presence CHECK. `baseFeeMinor` is immutable, so reading it
      // first decides nothing.
      const reset = await tx.task.updateMany({
        where: { id: taskId, status: { in: ['CREATED', 'UNFULFILLED'] }, riderId: null },
        data: {
          status: 'CREATED',
          broadcastRound: 0,
          feeMinor: task.baseFeeMinor,
          currentProximityM: null,
          offerExpiresAt: null,
          dispatchDueAt: new Date(),
        },
      });
      if (reset.count !== 1) return;

      // M5: broadcast_log is append-only — migration 20261119170100 puts a
      // BEFORE DELETE trigger on it, and UPDATE is the only change it
      // permits. The `deleteMany` that stood here therefore raised on any
      // task with a PENDING row: abandoning a task accepted in round 2 or
      // later committed the abandonment and then answered 500. The rounds
      // that found nobody are resolved as EXPIRED, which is also the truth.
      await tx.broadcastLog.updateMany({
        where: { taskId, outcome: 'PENDING' },
        data: { outcome: 'EXPIRED', resolvedAt: new Date() },
      });
    });

    // `broadcast` re-checks everything itself, and if it does nothing the
    // dispatch-due tick picks the task up within five seconds.
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

    // No initialiser: both the try and the catch assign it before it is
    // read, so `= false` was dead and read as if the unlocked path were the
    // default. It is not — a Redis failure deliberately proceeds unlocked.
    let acquired: boolean;
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
