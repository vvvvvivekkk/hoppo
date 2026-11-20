import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus as DbOrderStatus, Prisma } from '@prisma/client';
import { DEFAULT_TIMEZONE, formatMinor } from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../common/tenant/tenant.service';
import { clampPageLimit } from '../common/pagination';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { OrdersService } from './orders.service';
import { parseStatusFilter, resolveReportRange, type ReportRange } from './report-range';

/**
 * Reading orders back out: the administrator's report and a shop's history.
 *
 * SRS §12.3 ends the Phase 1 acceptance walk with "...and the order in the
 * administrator's report", and FR-ADM-05 asks for an operational dashboard
 * over a chosen date range. Everything here is a read; nothing changes an
 * order, so nothing here needs the conditional-UPDATE care that
 * OrdersService takes.
 *
 * Three rules run through every method:
 *
 *  1. **Tenancy.** An administrator's authority stops at their own college
 *     (FR-TEN-03). List and summary queries carry the caller's college in the
 *     WHERE clause; single-order reads go through `assertSameTenant`.
 *
 *  2. **Dates are local.** A date range is read in the college's timezone and
 *     turned into UTC instants once, in `resolveReportRange`.
 *
 *  3. **No contact details.** FR-PRIV-03 says a student's mobile number is
 *     not exposed to other students and that the parties to a task talk
 *     through in-app chat. The SRS nowhere grants the order report a need for
 *     a phone number — an administrator reaches a student through the
 *     verification and escalation screens, which have their own rules — so
 *     these responses carry ids and names only. Every `select` below names
 *     its columns for that reason: a bare `include: { student: true }` would
 *     ship `mobile` and `email` to the browser.
 */

/** Just enough of a person to label a row. Never `mobile`, never `email`. */
const PERSON = { select: { id: true, name: true } } as const;

const SUMMARY_MAX_DAYS = 366;
const REFERENCE_SEARCH_MAX = 32;

const ORDER_STATUS_KEYS = Object.values(DbOrderStatus);
const CANCELLED_BY_KEYS = ['STUDENT', 'SHOP', 'ADMIN', 'SYSTEM'] as const;

export interface AdminOrderListQuery {
  status?: string | string[];
  from?: string;
  to?: string;
  listingId?: string;
  q?: string;
  limit?: string;
  cursor?: string;
  /** Honoured for a super administrator only. */
  collegeId?: string;
}

interface SummaryRow {
  orders_placed: number;
  completion_rate_bps: number;
  gross_items: bigint;
  delivery_fees: bigint;
  platform_fees: bigint;
  commission: bigint;
  total: bigint;
  median_placed_to_accepted: number | null;
  median_ready_to_delivered: number | null;
  placed_to_accepted_n: number;
  ready_to_delivered_n: number;
  unfulfilled: number;
  [counter: string]: number | bigint | null;
}

interface ShopRevenueRow {
  listing_id: string;
  shop_name: string;
  completed_orders: number;
  gross_items: bigint;
  commission: bigint;
}

function money<K extends string>(key: K, minor: number) {
  return { [`${key}Minor`]: minor, [`${key}Label`]: formatMinor(minor) } as Record<
    `${K}Minor`,
    number
  > &
    Record<`${K}Label`, string>;
}

@Injectable()
export class AdminOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly orders: OrdersService,
  ) {}

  // =======================================================================
  // Whose orders, and in which timezone
  // =======================================================================

  /**
   * The college a report covers.
   *
   * For an administrator this is always their own, taken from the token
   * (NFR-S-05) — a `collegeId` in the query string is not even looked at, so
   * there is nothing to tamper with. A super administrator belongs to no
   * college and may name one; without it they see every college.
   */
  private reportCollegeId(user: AuthenticatedUser, requested?: string): string | null {
    if (user.role === 'SUPER_ADMIN') return requested?.trim() || null;
    return this.tenant.requireCollegeId(user);
  }

  private async timezoneOf(collegeId: string | null): Promise<string> {
    if (!collegeId) return DEFAULT_TIMEZONE;
    const college = await this.prisma.college.findUnique({
      where: { id: collegeId },
      select: { timezone: true },
    });
    return college?.timezone ?? DEFAULT_TIMEZONE;
  }

  private placedWithin(range: ReportRange): Prisma.OrderWhereInput {
    if (!range.start && !range.end) return {};
    return {
      placedAt: {
        ...(range.start ? { gte: range.start } : {}),
        ...(range.end ? { lt: range.end } : {}),
      },
    };
  }

  private publicRange(range: ReportRange) {
    return { from: range.from, to: range.to, timezone: range.timezone };
  }

  /**
   * The paging half of a "newest first" order query.
   *
   * The sort has a second key because `placedAt` is not unique: two orders in
   * the same millisecond would otherwise be free to swap places between
   * pages, and a cursor would skip one or show it twice. One row more than
   * the page is fetched; `cutPage` uses it to tell whether another page exists.
   */
  private async pageArgs(where: Prisma.OrderWhereInput, limit: number, cursor?: string) {
    if (cursor) {
      // Prisma answers an unknown cursor with an empty page, which reads as
      // "no more orders". A stale or invented cursor is a client mistake and
      // is reported as one.
      const anchor = await this.prisma.order.findFirst({
        where: { AND: [where, { id: cursor }] },
        select: { id: true },
      });
      if (!anchor) {
        throw new BadRequestException({
          code: 'INVALID_CURSOR',
          message: 'That page marker is not valid for this list. Start again from the first page.',
        });
      }
    }

    return {
      where,
      orderBy: [
        { placedAt: 'desc' },
        { id: 'desc' },
      ] satisfies Prisma.OrderOrderByWithRelationInput[],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    };
  }

  private cutPage<T extends { id: string }>(rows: T[], limit: number) {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  // =======================================================================
  // (a) The list — A-07 live order board, and "the order in the report"
  // =======================================================================

  async list(user: AuthenticatedUser, query: AdminOrderListQuery) {
    const collegeId = this.reportCollegeId(user, query.collegeId);
    const range = resolveReportRange(query, await this.timezoneOf(collegeId));
    const statuses = parseStatusFilter(query.status);
    const search = query.q?.trim().slice(0, REFERENCE_SEARCH_MAX);

    if (query.listingId) {
      // A listing id is client input like any other. Checking it against the
      // caller's college says "that shop is not yours" out loud, rather than
      // returning an empty list that looks like a quiet day.
      await this.assertListingInTenant(user, query.listingId);
    }

    const where: Prisma.OrderWhereInput = {
      ...(collegeId ? { collegeId } : {}),
      ...(statuses ? { status: { in: statuses } } : {}),
      ...this.placedWithin(range),
      ...(query.listingId ? { shopListingId: query.listingId } : {}),
      ...(search ? { reference: { contains: search, mode: 'insensitive' } } : {}),
    };

    const limit = clampPageLimit(query.limit);
    const rows = await this.prisma.order.findMany({
      ...(await this.pageArgs(where, limit, query.cursor)),
      select: {
        id: true,
        reference: true,
        status: true,
        placedAt: true,
        itemsSubtotalMinor: true,
        deliveryFeeMinor: true,
        platformFeeMinor: true,
        totalMinor: true,
        commissionMinor: true,
        paymentMethod: true,
        paymentStatus: true,
        cancelledBy: true,
        student: PERSON,
        shopListing: { select: { id: true, shop: { select: { id: true, name: true } } } },
        task: { select: { status: true, rider: PERSON } },
      },
    });
    const { items, nextCursor } = this.cutPage(rows, limit);

    return {
      items: items.map((o) => ({
        id: o.id,
        reference: o.reference,
        status: o.status,
        placedAt: o.placedAt,
        shop: {
          listingId: o.shopListing.id,
          shopId: o.shopListing.shop.id,
          name: o.shopListing.shop.name,
        },
        student: o.student,
        rider: o.task?.rider ?? null,
        ...money('itemsSubtotal', o.itemsSubtotalMinor),
        ...money('deliveryFee', o.deliveryFeeMinor),
        ...money('platformFee', o.platformFeeMinor),
        ...money('total', o.totalMinor),
        ...money('commission', o.commissionMinor),
        paymentMethod: o.paymentMethod,
        paymentStatus: o.paymentStatus,
        taskStatus: o.task?.status ?? null,
        cancelledBy: o.cancelledBy,
      })),
      nextCursor,
      range: this.publicRange(range),
    };
  }

  private async assertListingInTenant(user: AuthenticatedUser, listingId: string) {
    const listing = await this.prisma.shopListing.findUnique({
      where: { id: listingId },
      select: { id: true, collegeId: true, college: { select: { timezone: true } } },
    });
    if (!listing) {
      throw new NotFoundException({ code: 'SHOP_NOT_FOUND', message: 'Shop not found' });
    }
    return this.tenant.assertSameTenant(user, listing, 'Shop');
  }

  // =======================================================================
  // (b) One order, with everything that happened to it
  // =======================================================================

  async detail(user: AuthenticatedUser, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        collegeId: true,
        reference: true,
        status: true,
        itemsSubtotalMinor: true,
        deliveryFeeMinor: true,
        platformFeeMinor: true,
        totalMinor: true,
        commissionMinor: true,
        paymentMethod: true,
        paymentStatus: true,
        dropLandmark: true,
        studentNote: true,
        statedPrepMinutes: true,
        expectedReadyAt: true,
        placedAt: true,
        shopAcceptedAt: true,
        readyAt: true,
        pickedUpAt: true,
        deliveredAt: true,
        completedAt: true,
        cancelledAt: true,
        cancelledBy: true,
        cancelledReason: true,
        studentId: true,
        student: PERSON,
        shopListing: { select: { id: true, shop: { select: { id: true, name: true } } } },
        items: {
          select: {
            nameSnapshot: true,
            unitPriceMinor: true,
            quantity: true,
            lineTotalMinor: true,
            note: true,
          },
        },
        task: {
          select: {
            id: true,
            status: true,
            baseFeeMinor: true,
            feeMinor: true,
            broadcastRound: true,
            broadcastCycle: true,
            distanceM: true,
            // The name of the drop point, not its coordinates.
            dropLabel: true,
            firstBroadcastAt: true,
            assignedAt: true,
            pickedUpAt: true,
            deliveredAt: true,
            completedAt: true,
            cancelledAt: true,
            riderId: true,
            rider: PERSON,
            broadcasts: {
              select: {
                cycle: true,
                round: true,
                radiusM: true,
                feeMinor: true,
                eligibleCount: true,
                sentAt: true,
                outcome: true,
                resolvedAt: true,
              },
              orderBy: [{ cycle: 'asc' }, { round: 'asc' }],
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }
    this.tenant.assertSameTenant(user, order, 'Order');

    // The ledger rows for this order: the student's hold, release or capture,
    // and the rider's fee. Ordered by the database's own insert counter after
    // the timestamp, so two rows from one transaction read in the order they
    // were written. `seq` itself is not selected — it is a BigInt, which JSON
    // cannot carry, and it means nothing to a reader.
    const ledger = await this.prisma.walletEntry.findMany({
      where: { orderId },
      select: {
        id: true,
        userId: true,
        type: true,
        direction: true,
        amountMinor: true,
        balanceAfterMinor: true,
        note: true,
        createdAt: true,
        user: PERSON,
      },
      orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }],
    });

    const task = order.task;
    // A task that went back into the pool (abandoned, "keep waiting") has
    // been searched for more than once; each search is a `cycle` with its own
    // rounds 1..n. `rounds` lists every round of every search, oldest search
    // first, because the history of failed searches is the point of keeping
    // the table. The time to acceptance, though, is a statement about the
    // search that produced the current assignment, so it is measured inside
    // the latest cycle only — from that search's first round, not from a
    // round sent for an earlier search that ended long before.
    const rounds = task?.broadcasts ?? [];
    const latestSearch = rounds.filter((r) => r.cycle === task?.broadcastCycle);
    const firstSentAt = latestSearch[0]?.sentAt ?? task?.firstBroadcastAt ?? null;

    // Only the steps that happened, in the order they happened.
    const timeline = (
      [
        ['PLACED', order.placedAt],
        ['SHOP_ACCEPTED', order.shopAcceptedAt],
        ['READY', order.readyAt],
        ['PICKED_UP', order.pickedUpAt],
        ['DELIVERED', order.deliveredAt],
        ['COMPLETED', order.completedAt],
        ['CANCELLED', order.cancelledAt],
      ] as const
    )
      .filter((step): step is readonly [(typeof step)[0], Date] => step[1] !== null)
      .map(([event, at]) => ({ event, at }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    return {
      id: order.id,
      reference: order.reference,
      status: order.status,
      shop: {
        listingId: order.shopListing.id,
        shopId: order.shopListing.shop.id,
        name: order.shopListing.shop.name,
      },
      student: order.student,
      rider: task?.rider ?? null,
      ...money('itemsSubtotal', order.itemsSubtotalMinor),
      ...money('deliveryFee', order.deliveryFeeMinor),
      ...money('platformFee', order.platformFeeMinor),
      ...money('total', order.totalMinor),
      ...money('commission', order.commissionMinor),
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      dropLabel: task?.dropLabel ?? order.dropLandmark ?? null,
      studentNote: order.studentNote,
      statedPrepMinutes: order.statedPrepMinutes,
      expectedReadyAt: order.expectedReadyAt,
      cancelledBy: order.cancelledBy,
      cancelledReason: order.cancelledReason,
      timeline,
      items: order.items.map((i) => ({
        name: i.nameSnapshot,
        unitPriceMinor: i.unitPriceMinor,
        quantity: i.quantity,
        lineTotalMinor: i.lineTotalMinor,
        note: i.note,
      })),
      task: task
        ? {
            id: task.id,
            status: task.status,
            baseFeeMinor: task.baseFeeMinor,
            feeMinor: task.feeMinor,
            broadcastRound: task.broadcastRound,
            distanceM: task.distanceM,
            assignedAt: task.assignedAt,
            pickedUpAt: task.pickedUpAt,
            deliveredAt: task.deliveredAt,
            completedAt: task.completedAt,
            cancelledAt: task.cancelledAt,
          }
        : null,
      broadcast: {
        rounds,
        // Every round ever sent for this order, across all searches.
        roundsSent: rounds.length,
        // How many separate searches there have been (1 unless it went back
        // into the pool), and how many rounds the latest one has used.
        searches: task?.broadcastCycle ?? 0,
        roundsInLatestSearch: latestSearch.length,
        // FR-ADM-05 "time to rider acceptance", for this one order.
        secondsToAcceptance:
          firstSentAt && task?.assignedAt
            ? Math.max(0, Math.round((task.assignedAt.getTime() - firstSentAt.getTime()) / 1000))
            : null,
      },
      walletEntries: ledger.map((e) => ({
        id: e.id,
        type: e.type,
        direction: e.direction,
        ...money('amount', e.amountMinor),
        balanceAfterMinor: e.balanceAfterMinor,
        party:
          e.userId === order.studentId
            ? ('STUDENT' as const)
            : e.userId === task?.riderId
              ? ('RIDER' as const)
              : ('OTHER' as const),
        user: e.user,
        note: e.note,
        createdAt: e.createdAt,
      })),
    };
  }

  // =======================================================================
  // (c) The figures for a date range — FR-ADM-05
  // =======================================================================

  /**
   * Every number here is computed by PostgreSQL, in one pass over the range.
   *
   * Money is summed as integers of paise and never touches a float: SUM over
   * an INT column is a BIGINT, which arrives as a JavaScript BigInt and is
   * narrowed with Number() only at the edge (a college would need to turn
   * over ninety trillion rupees to exceed what a double holds exactly). The
   * completion rate is integer basis points for the same reason — 7381, not
   * 0.7381.
   *
   * `FILTER (WHERE ...)` is what lets one scan answer many questions: each
   * aggregate counts only the rows its own condition admits.
   *
   * Money totals cover COMPLETED orders only. A cancelled order's
   * "delivery fee" was never earned by anyone, and adding it would make the
   * report disagree with the wallet ledger.
   */
  async summary(
    user: AuthenticatedUser,
    query: { from?: string; to?: string; collegeId?: string },
  ) {
    const collegeId = this.reportCollegeId(user, query.collegeId);
    const range = resolveReportRange(query, await this.timezoneOf(collegeId), {
      defaultToToday: true,
      maxDays: SUMMARY_MAX_DAYS,
    });

    const inScope = Prisma.sql`
      o.placed_at >= ${range.start} AND o.placed_at < ${range.end}
      ${collegeId ? Prisma.sql`AND o.college_id = ${collegeId}` : Prisma.empty}
    `;

    const statusCounters = Prisma.join(
      ORDER_STATUS_KEYS.map(
        (status) =>
          Prisma.sql`count(*) FILTER (WHERE o.status::text = ${status})::int AS ${Prisma.raw(
            `"status_${status}"`,
          )}`,
      ),
    );
    const cancelCounters = Prisma.join(
      CANCELLED_BY_KEYS.map(
        (who) =>
          Prisma.sql`count(*) FILTER (WHERE o.status = 'CANCELLED' AND o.cancelled_by::text = ${who})::int AS ${Prisma.raw(
            `"cancelled_${who}"`,
          )}`,
      ),
    );

    const [row] = await this.prisma.$queryRaw<SummaryRow[]>`
      SELECT
        count(*)::int AS orders_placed,
        ${statusCounters},
        ${cancelCounters},
        CASE WHEN count(*) = 0 THEN 0
             ELSE (count(*) FILTER (WHERE o.status = 'COMPLETED') * 10000 / count(*))::int
        END AS completion_rate_bps,
        coalesce(sum(o.items_subtotal_minor) FILTER (WHERE o.status = 'COMPLETED'), 0)::bigint AS gross_items,
        coalesce(sum(o.delivery_fee_minor)   FILTER (WHERE o.status = 'COMPLETED'), 0)::bigint AS delivery_fees,
        coalesce(sum(o.platform_fee_minor)   FILTER (WHERE o.status = 'COMPLETED'), 0)::bigint AS platform_fees,
        coalesce(sum(o.commission_minor)     FILTER (WHERE o.status = 'COMPLETED'), 0)::bigint AS commission,
        coalesce(sum(o.total_minor)          FILTER (WHERE o.status = 'COMPLETED'), 0)::bigint AS total,
        round(percentile_cont(0.5) WITHIN GROUP (
          ORDER BY extract(epoch FROM (o.shop_accepted_at - o.placed_at))
        ) FILTER (WHERE o.shop_accepted_at IS NOT NULL))::int AS median_placed_to_accepted,
        round(percentile_cont(0.5) WITHIN GROUP (
          ORDER BY extract(epoch FROM (o.delivered_at - o.ready_at))
        ) FILTER (WHERE o.ready_at IS NOT NULL AND o.delivered_at IS NOT NULL))::int AS median_ready_to_delivered,
        count(*) FILTER (WHERE o.shop_accepted_at IS NOT NULL)::int AS placed_to_accepted_n,
        count(*) FILTER (WHERE o.ready_at IS NOT NULL AND o.delivered_at IS NOT NULL)::int AS ready_to_delivered_n,
        count(*) FILTER (WHERE t.status = 'UNFULFILLED')::int AS unfulfilled
      FROM "order" o
      LEFT JOIN "task" t ON t.order_id = o.id
      WHERE ${inScope}
    `;

    const byShop = await this.prisma.$queryRaw<ShopRevenueRow[]>`
      SELECT
        l.id   AS listing_id,
        s.name AS shop_name,
        count(*)::int AS completed_orders,
        coalesce(sum(o.items_subtotal_minor), 0)::bigint AS gross_items,
        coalesce(sum(o.commission_minor), 0)::bigint     AS commission
      FROM "order" o
      JOIN "shop_listing" l ON l.id = o.shop_listing_id
      JOIN "shop" s ON s.id = l.shop_id
      WHERE ${inScope} AND o.status = 'COMPLETED'
      GROUP BY l.id, s.name
      ORDER BY gross_items DESC, s.name ASC
      LIMIT 50
    `;

    const count = (key: string) => Number(row[key] ?? 0);
    const byStatus = Object.fromEntries(
      ORDER_STATUS_KEYS.map((status) => [status, count(`status_${status}`)]),
    ) as Record<DbOrderStatus, number>;
    const byWho = Object.fromEntries(
      CANCELLED_BY_KEYS.map((who) => [who, count(`cancelled_${who}`)]),
    ) as Record<(typeof CANCELLED_BY_KEYS)[number], number>;

    return {
      range: this.publicRange(range),
      ordersPlaced: row.orders_placed,
      byStatus,
      completionRateBps: row.completion_rate_bps,
      money: {
        basis: 'COMPLETED' as const,
        ...money('grossItems', Number(row.gross_items)),
        ...money('deliveryFees', Number(row.delivery_fees)),
        ...money('platformFees', Number(row.platform_fees)),
        ...money('commission', Number(row.commission)),
        ...money('total', Number(row.total)),
      },
      cancellations: { total: byStatus.CANCELLED, byWho },
      timings: {
        medianPlacedToAcceptedSeconds: row.median_placed_to_accepted,
        medianReadyToDeliveredSeconds: row.median_ready_to_delivered,
        placedToAcceptedSampleSize: row.placed_to_accepted_n,
        readyToDeliveredSampleSize: row.ready_to_delivered_n,
      },
      unfulfilledBroadcasts: row.unfulfilled,
      revenueByShop: byShop.map((s) => ({
        listingId: s.listing_id,
        shopName: s.shop_name,
        completedOrders: s.completed_orders,
        ...money('grossItems', Number(s.gross_items)),
        commissionMinor: Number(s.commission),
      })),
    };
  }

  // =======================================================================
  // A shop's own history — D-10
  // =======================================================================

  /**
   * Past orders for one listing.
   *
   * The live queue (`OrdersService.shopQueue`) only ever returns orders still
   * in play, unpaginated, because that is what a counter tablet needs. Once
   * an order completes or is cancelled it drops off that list, and until this
   * existed a shop had no way to look one up again.
   *
   * What a shop sees of the money is its own side of it: the items, the
   * commission, and what is left. Delivery fee, platform fee and the
   * student's payment state are between the student, the rider and the
   * platform.
   */
  async shopHistory(
    user: AuthenticatedUser,
    listingId: string,
    query: {
      status?: string | string[];
      from?: string;
      to?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    // Tenancy first, then "is this your shop" — the same order as every other
    // shop-side order route.
    await this.orders.assertShopAccess(user, listingId);

    const listing = await this.prisma.shopListing.findUnique({
      where: { id: listingId },
      select: { college: { select: { timezone: true } } },
    });
    const range = resolveReportRange(query, listing?.college.timezone ?? DEFAULT_TIMEZONE);
    const statuses = parseStatusFilter(query.status) ?? [
      DbOrderStatus.COMPLETED,
      DbOrderStatus.CANCELLED,
    ];

    const where: Prisma.OrderWhereInput = {
      ...this.tenant.scope(user),
      shopListingId: listingId,
      status: { in: statuses },
      ...this.placedWithin(range),
    };
    const limit = clampPageLimit(query.limit);
    const rows = await this.prisma.order.findMany({
      ...(await this.pageArgs(where, limit, query.cursor)),
      select: {
        id: true,
        reference: true,
        status: true,
        placedAt: true,
        shopAcceptedAt: true,
        readyAt: true,
        pickedUpAt: true,
        deliveredAt: true,
        completedAt: true,
        cancelledAt: true,
        cancelledBy: true,
        cancelledReason: true,
        studentNote: true,
        itemsSubtotalMinor: true,
        commissionMinor: true,
        paymentMethod: true,
        student: PERSON,
        items: {
          select: {
            nameSnapshot: true,
            quantity: true,
            unitPriceMinor: true,
            lineTotalMinor: true,
            note: true,
          },
        },
        task: { select: { status: true, rider: PERSON } },
      },
    });
    const { items, nextCursor } = this.cutPage(rows, limit);

    return {
      listingId,
      items: items.map((o) => ({
        id: o.id,
        reference: o.reference,
        status: o.status,
        placedAt: o.placedAt,
        shopAcceptedAt: o.shopAcceptedAt,
        readyAt: o.readyAt,
        pickedUpAt: o.pickedUpAt,
        deliveredAt: o.deliveredAt,
        completedAt: o.completedAt,
        cancelledAt: o.cancelledAt,
        cancelledBy: o.cancelledBy,
        cancelledReason: o.cancelledReason,
        student: o.student,
        rider: o.task?.rider ?? null,
        items: o.items.map((i) => ({
          name: i.nameSnapshot,
          quantity: i.quantity,
          unitPriceMinor: i.unitPriceMinor,
          lineTotalMinor: i.lineTotalMinor,
          note: i.note,
        })),
        studentNote: o.studentNote,
        ...money('itemsSubtotal', o.itemsSubtotalMinor),
        ...money('commission', o.commissionMinor),
        ...money('netToShop', o.itemsSubtotalMinor - o.commissionMinor),
        paymentMethod: o.paymentMethod,
        taskStatus: o.task?.status ?? null,
      })),
      nextCursor,
      range: this.publicRange(range),
    };
  }
}
