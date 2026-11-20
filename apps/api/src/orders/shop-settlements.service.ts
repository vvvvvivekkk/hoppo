import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DEFAULT_TIMEZONE, formatMinor } from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../common/tenant/tenant.service';
import { clampPageLimit } from '../common/pagination';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { localToday, resolveReportRange } from './report-range';

/**
 * D-14: a shop's settlement statement. Read-only.
 *
 * This service answers "what did this shop sell in the period, what
 * commission was retained on it, and how do the two sides stand" — and stops
 * there. It moves no money, records no payout and stores no bank details.
 * How a shop is actually paid (which provider, on what schedule, to which
 * account) is an open decision for the owner; see
 * /home/claude/requests/A1-DECISION-settlements.md. Until it is made, the
 * honest product is a statement, and `payout.status` says so in the response.
 *
 * Where the figures come from. A shop has no rows in the wallet ledger — the
 * ledger records students' holds and riders' fees — so the source is the
 * order itself, which fixed `items_subtotal_minor` and `commission_minor` at
 * placement precisely so that a later menu or rate change cannot rewrite
 * history. Only COMPLETED orders count: an order that was cancelled earned
 * the shop nothing and owes no commission.
 *
 * An order belongs to the period in which it was COMPLETED, not the one in
 * which it was placed. A statement is about money earned, and an order placed
 * at 11:50 pm and handed over at 12:10 am was earned on the second day.
 *
 * How the two sides stand depends on how the student paid (ADR-006):
 *
 *   - CASH: the shop has already been paid. The rider hands the shop the
 *     item subtotal in cash at pickup (or the student does, when collecting
 *     in person). The platform never held that money, so the commission on
 *     it is something the SHOP owes the platform.
 *   - WALLET (and ONLINE, once a gateway exists): the student's money is
 *     with the platform, so the platform owes the shop the item subtotal
 *     less the commission.
 *
 * `netPayableToShopMinor` is the second minus the first, and can be negative
 * for a shop that sells mostly for cash.
 *
 * All money is integer paise, summed by PostgreSQL. Nothing here is a float.
 */

const STATEMENT_MAX_DAYS = 366;

interface TotalsRow {
  orders: number;
  gross: bigint;
  commission: bigint;
  cash_orders: number;
  cash_gross: bigint;
  cash_commission: bigint;
  held_orders: number;
  held_gross: bigint;
  held_commission: bigint;
}

function money<K extends string>(key: K, minor: number) {
  return { [`${key}Minor`]: minor, [`${key}Label`]: formatMinor(minor) } as Record<
    `${K}Minor`,
    number
  > &
    Record<`${K}Label`, string>;
}

@Injectable()
export class ShopSettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
  ) {}

  /**
   * Who may read a shop's money: its owner, and an administrator of its
   * college.
   *
   * Narrower than the order queue, which any staff member of the shop can
   * work. Counter staff need to see orders to cook them; what the business
   * earned and owes is the owner's to see. Tenancy is checked first and for
   * every role, as everywhere else: an administrator's authority stops at
   * their own college.
   */
  private async loadListingForStatement(user: AuthenticatedUser, listingId: string) {
    const listing = await this.prisma.shopListing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        collegeId: true,
        college: { select: { timezone: true } },
        shop: {
          select: {
            id: true,
            name: true,
            staff: { select: { userId: true, isOwner: true } },
          },
        },
      },
    });

    if (!listing) {
      throw new NotFoundException({ code: 'SHOP_NOT_FOUND', message: 'Shop not found' });
    }
    this.tenant.assertSameTenant(user, listing, 'Shop');

    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return listing;

    const membership = listing.shop.staff.find((s) => s.userId === user.userId);
    if (!membership) {
      throw new ForbiddenException({
        code: 'NOT_SHOP_STAFF',
        message: 'You do not manage this shop.',
      });
    }
    if (!membership.isOwner) {
      throw new ForbiddenException({
        code: 'NOT_SHOP_OWNER',
        message: "Only the shop's owner can see its settlement statement.",
      });
    }
    return listing;
  }

  async statement(
    user: AuthenticatedUser,
    listingId: string,
    query: { from?: string; to?: string; limit?: string; cursor?: string },
  ) {
    const listing = await this.loadListingForStatement(user, listingId);
    const timeZone = listing.college.timezone ?? DEFAULT_TIMEZONE;

    // With no dates given: this calendar month so far, in the college's
    // timezone — the period a shop owner means by "my statement".
    const today = localToday(timeZone);
    const range = resolveReportRange(
      query.from?.trim() || query.to?.trim()
        ? query
        : { from: `${today.slice(0, 8)}01`, to: today },
      timeZone,
      { defaultToToday: true, maxDays: STATEMENT_MAX_DAYS },
    );

    const [totals] = await this.prisma.$queryRaw<TotalsRow[]>`
      SELECT
        count(*)::int AS orders,
        coalesce(sum(items_subtotal_minor), 0)::bigint AS gross,
        coalesce(sum(commission_minor), 0)::bigint     AS commission,
        count(*) FILTER (WHERE payment_method = 'CASH')::int AS cash_orders,
        coalesce(sum(items_subtotal_minor) FILTER (WHERE payment_method = 'CASH'), 0)::bigint AS cash_gross,
        coalesce(sum(commission_minor)     FILTER (WHERE payment_method = 'CASH'), 0)::bigint AS cash_commission,
        count(*) FILTER (WHERE payment_method <> 'CASH')::int AS held_orders,
        coalesce(sum(items_subtotal_minor) FILTER (WHERE payment_method <> 'CASH'), 0)::bigint AS held_gross,
        coalesce(sum(commission_minor)     FILTER (WHERE payment_method <> 'CASH'), 0)::bigint AS held_commission
      FROM "order"
      WHERE shop_listing_id = ${listing.id}
        AND college_id = ${listing.collegeId}
        AND status = 'COMPLETED'
        AND completed_at >= ${range.start}
        AND completed_at <  ${range.end}
    `;

    const gross = Number(totals.gross);
    const commission = Number(totals.commission);
    const cashGross = Number(totals.cash_gross);
    const cashCommission = Number(totals.cash_commission);
    const heldGross = Number(totals.held_gross);
    const heldCommission = Number(totals.held_commission);

    // Integer arithmetic on integers of paise.
    const platformOwesShop = heldGross - heldCommission;
    const shopOwesPlatform = cashCommission;

    // The per-order lines behind those totals, newest first, a page at a time.
    const where: Prisma.OrderWhereInput = {
      shopListingId: listing.id,
      collegeId: listing.collegeId,
      status: 'COMPLETED',
      completedAt: { gte: range.start!, lt: range.end! },
    };
    const limit = clampPageLimit(query.limit);

    if (query.cursor) {
      const anchor = await this.prisma.order.findFirst({
        where: { AND: [where, { id: query.cursor }] },
        select: { id: true },
      });
      if (!anchor) {
        throw new BadRequestException({
          code: 'INVALID_CURSOR',
          message:
            'That page marker is not valid for this statement. Start again from the first page.',
        });
      }
    }

    const rows = await this.prisma.order.findMany({
      where,
      select: {
        id: true,
        reference: true,
        placedAt: true,
        completedAt: true,
        paymentMethod: true,
        itemsSubtotalMinor: true,
        commissionMinor: true,
      },
      // completedAt is not unique; the id makes the order total, so a cursor
      // can neither skip a line nor show one twice.
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      listingId: listing.id,
      shop: { id: listing.shop.id, name: listing.shop.name },
      range: { from: range.from, to: range.to, timezone: range.timezone },
      // Which orders are in it, and by which date — so nobody has to guess.
      basis: { status: 'COMPLETED' as const, date: 'completedAt' as const },
      totals: {
        ordersDelivered: totals.orders,
        ...money('grossItems', gross),
        ...money('commission', commission),
        ...money('netEarnings', gross - commission),
        // Commission as a share of gross, in basis points (500 = 5.00%). The
        // rate is fixed per order at placement, so this is the blended rate
        // actually applied, not the college's current setting.
        effectiveCommissionBps: gross > 0 ? Math.round((commission * 10_000) / gross) : 0,
      },
      byPaymentMethod: {
        // The shop was paid in cash at the counter; it owes the commission.
        cash: {
          orders: totals.cash_orders,
          ...money('grossItems', cashGross),
          ...money('commission', cashCommission),
          ...money('alreadyReceivedByShop', cashGross),
        },
        // The student's money is with the platform; it owes the shop the rest.
        heldByPlatform: {
          orders: totals.held_orders,
          ...money('grossItems', heldGross),
          ...money('commission', heldCommission),
          ...money('owedToShop', platformOwesShop),
        },
      },
      position: {
        ...money('platformOwesShop', platformOwesShop),
        ...money('shopOwesPlatform', shopOwesPlatform),
        // Positive: the platform owes the shop. Negative: the shop owes the
        // platform (commission on cash sales exceeds what the platform holds).
        ...money('netPayableToShop', platformOwesShop - shopOwesPlatform),
      },
      // Nothing is paid out by this system yet, and it holds no bank details.
      payout: {
        status: 'NOT_AVAILABLE' as const,
        message:
          'Payouts are not processed in the app yet. This statement shows what is owed; settlement is arranged with your campus administrator.',
      },
      lines: page.map((o) => ({
        orderId: o.id,
        reference: o.reference,
        placedAt: o.placedAt,
        completedAt: o.completedAt,
        paymentMethod: o.paymentMethod,
        ...money('itemsSubtotal', o.itemsSubtotalMinor),
        ...money('commission', o.commissionMinor),
        ...money('netToShop', o.itemsSubtotalMinor - o.commissionMinor),
        settledBy:
          o.paymentMethod === 'CASH' ? ('CASH_AT_COUNTER' as const) : ('PLATFORM' as const),
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }
}
