import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DEFAULT_TIMEZONE, formatMinor } from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../common/tenant/tenant.service';
import { clampPageLimit } from '../common/pagination';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { localToday, resolveReportRange } from '../orders/report-range';

/**
 * A student's own wallet, read back out: the statement (FR-PAY-04), what
 * they have earned as a rider (S-24, FR-WM-08), and the withdrawal requests
 * on file. All three are reads. Nothing here credits, debits, requests or
 * pays out — moving money out of a wallet waits on the owner's choice of
 * payout route (/home/claude/requests/A1-DECISION-rider-payouts.md).
 *
 * Whose wallet is never a parameter. Every query takes the user id from the
 * token, so there is no id for a caller to change to read somebody else's.
 *
 * The one idea worth understanding here is `balanceChange`.
 *
 * Each ledger row carries the balance after it (`balance_after_minor`). The
 * difference between a row's balance and the previous row's is what that row
 * actually did to the balance — and it is not always the row's amount:
 *
 *   - A delivery fee on a CASH order is recorded (so the rider's earnings
 *     history is complete) but does not raise the balance: the rider already
 *     has that money, in their pocket, from the student (ADR-006). Amount
 *     2000, balance change 0.
 *   - A delivery fee on a wallet-paid order does raise it. Amount 2000,
 *     balance change 2000.
 *   - An errand reimbursement is settled directly between the two students
 *     and never moves the balance.
 *
 * So "how much did I earn" is the sum of the amounts, and "how much of that
 * can I ever withdraw" is the sum of the balance changes. Reading the
 * difference off the ledger itself — rather than re-deriving it from the
 * order's payment method — means the statement always agrees with the
 * balance, because both come from the same column.
 *
 * `LAG(...) OVER (ORDER BY created_at, seq)` is how SQL says "the value on
 * the previous row"; `seq` is the database's own insert counter, which puts
 * two rows written in the same millisecond in the order they were written.
 *
 * All money is integer paise, computed by PostgreSQL.
 */

const EARNINGS_MAX_DAYS = 366;

interface StatementRow {
  id: string;
  created_at: Date;
  type: string;
  direction: string;
  amount_minor: number;
  balance_after_minor: number;
  balance_change: number;
  note: string | null;
  order_id: string | null;
  task_id: string | null;
  order_reference: string | null;
}

interface EarningsRow {
  deliveries: number;
  fees: bigint;
  fees_credited: bigint;
  reimbursements: bigint;
}

function money<K extends string>(key: K, minor: number) {
  return { [`${key}Minor`]: minor, [`${key}Label`]: formatMinor(minor) } as Record<
    `${K}Minor`,
    number
  > &
    Record<`${K}Label`, string>;
}

/** Show enough of a UPI id to recognise it, and no more: "ra***@okbank". */
export function maskUpiId(upiId: string | null): string | null {
  if (!upiId) return null;
  const [name, handle] = upiId.split('@');
  const shown = name.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(3, name.length - shown.length))}${handle ? `@${handle}` : ''}`;
}

@Injectable()
export class WalletStatementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
  ) {}

  private async timezoneOf(user: AuthenticatedUser): Promise<string> {
    if (!user.collegeId) return DEFAULT_TIMEZONE;
    const college = await this.prisma.college.findUnique({
      where: { id: user.collegeId },
      select: { timezone: true },
    });
    return college?.timezone ?? DEFAULT_TIMEZONE;
  }

  /** The ledger of one user with, on every row, what it did to the balance. */
  private ledgerOf(userId: string): Prisma.Sql {
    return Prisma.sql`
      SELECT
        e.id, e.created_at, e.seq, e.type::text AS type, e.direction::text AS direction,
        e.amount_minor, e.balance_after_minor, e.note, e.order_id, e.task_id,
        (e.balance_after_minor
          - coalesce(lag(e.balance_after_minor) OVER (ORDER BY e.created_at, e.seq), 0))::int
          AS balance_change
      FROM "wallet_entry" e
      WHERE e.user_id = ${userId}
    `;
  }

  /** The balance as it stood just before an instant (or now, with no instant). */
  private async balanceBefore(userId: string, instant: Date | null): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ balance: number }[]>`
      SELECT e.balance_after_minor AS balance
      FROM "wallet_entry" e
      WHERE e.user_id = ${userId}
        ${instant ? Prisma.sql`AND e.created_at < ${instant}` : Prisma.empty}
      ORDER BY e.created_at DESC, e.seq DESC
      LIMIT 1
    `;
    return row?.balance ?? 0;
  }

  // =======================================================================
  // FR-PAY-04 — the statement
  // =======================================================================

  /**
   * "A chronological wallet statement with running balance", filterable by
   * date range. Oldest first, as a bank statement reads: the opening balance,
   * then each entry and the balance after it, down to the closing balance.
   */
  async statement(
    user: AuthenticatedUser,
    query: { from?: string; to?: string; limit?: string; cursor?: string },
  ) {
    const userId = user.userId;
    const range = resolveReportRange(query, await this.timezoneOf(user));
    const limit = clampPageLimit(query.limit);

    // The cursor is the id of the last entry already shown. It must be one of
    // this user's own entries: another user's id finds nothing here and is
    // refused, rather than being used as a position in their ledger.
    let after: Prisma.Sql = Prisma.empty;
    if (query.cursor) {
      const [anchor] = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "wallet_entry" WHERE id = ${query.cursor} AND user_id = ${userId}
      `;
      if (!anchor) {
        throw new BadRequestException({
          code: 'INVALID_CURSOR',
          message:
            'That page marker is not valid for this statement. Start again from the first page.',
        });
      }
      after = Prisma.sql`
        AND (l.created_at, l.seq) > (
          SELECT c.created_at, c.seq FROM "wallet_entry" c WHERE c.id = ${query.cursor}
        )
      `;
    }

    const rows = await this.prisma.$queryRaw<StatementRow[]>`
      WITH ledger AS (${this.ledgerOf(userId)})
      SELECT
        l.id, l.created_at, l.type, l.direction, l.amount_minor, l.balance_after_minor,
        l.balance_change, l.note, l.order_id, l.task_id,
        o.reference AS order_reference
      FROM ledger l
      LEFT JOIN "order" o ON o.id = l.order_id
      WHERE true
        ${range.start ? Prisma.sql`AND l.created_at >= ${range.start}` : Prisma.empty}
        ${range.end ? Prisma.sql`AND l.created_at < ${range.end}` : Prisma.empty}
        ${after}
      ORDER BY l.created_at ASC, l.seq ASC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const [openingBalance, closingBalance, currentBalance] = await Promise.all([
      range.start ? this.balanceBefore(userId, range.start) : Promise.resolve(0),
      this.balanceBefore(userId, range.end),
      this.balanceBefore(userId, null),
    ]);

    return {
      range: { from: range.from, to: range.to, timezone: range.timezone },
      ...money('openingBalance', openingBalance),
      ...money('closingBalance', closingBalance),
      ...money('currentBalance', currentBalance),
      entries: page.map((e) => ({
        id: e.id,
        createdAt: e.created_at,
        type: e.type,
        direction: e.direction,
        ...money('amount', e.amount_minor),
        // What this entry did to the balance: + for money in, − for money
        // out, 0 for a line that is a record only (a fee already collected
        // in cash, a reimbursement settled in person, a capture marker).
        balanceChangeMinor: e.balance_change,
        affectsBalance: e.balance_change !== 0,
        ...money('balanceAfter', e.balance_after_minor),
        note: e.note,
        orderId: e.order_id,
        orderReference: e.order_reference,
        taskId: e.task_id,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  // =======================================================================
  // S-24 / FR-WM-08 — what a rider has earned
  // =======================================================================

  async earnings(user: AuthenticatedUser, query: { from?: string; to?: string }) {
    const userId = user.userId;
    const collegeId = this.tenant.requireCollegeId(user);
    const timeZone = await this.timezoneOf(user);

    // No dates: this calendar month so far.
    const today = localToday(timeZone);
    const range = resolveReportRange(
      query.from?.trim() || query.to?.trim()
        ? query
        : { from: `${today.slice(0, 8)}01`, to: today },
      timeZone,
      { defaultToToday: true, maxDays: EARNINGS_MAX_DAYS },
    );

    const [row] = await this.prisma.$queryRaw<EarningsRow[]>`
      WITH ledger AS (${this.ledgerOf(userId)})
      SELECT
        count(*) FILTER (WHERE l.type = 'DELIVERY_FEE_EARNED')::int AS deliveries,
        coalesce(sum(l.amount_minor)   FILTER (WHERE l.type = 'DELIVERY_FEE_EARNED'), 0)::bigint AS fees,
        coalesce(sum(l.balance_change) FILTER (WHERE l.type = 'DELIVERY_FEE_EARNED'), 0)::bigint AS fees_credited,
        coalesce(sum(l.amount_minor)   FILTER (WHERE l.type = 'ERRAND_REIMBURSEMENT'), 0)::bigint AS reimbursements
      FROM ledger l
      WHERE l.created_at >= ${range.start} AND l.created_at < ${range.end}
    `;

    const fees = Number(row.fees);
    const credited = Number(row.fees_credited);

    const [balance, config, pending] = await Promise.all([
      this.balanceBefore(userId, null),
      this.prisma.collegeConfig.findUnique({
        where: { collegeId },
        select: { minWithdrawalMinor: true },
      }),
      this.prisma.withdrawalRequest.aggregate({
        where: { userId, status: { in: ['REQUESTED', 'APPROVED'] } },
        _sum: { amountMinor: true },
        _count: true,
      }),
    ]);
    const minimum = config?.minWithdrawalMinor ?? 10_000;

    return {
      range: { from: range.from, to: range.to, timezone: range.timezone },
      deliveries: row.deliveries,
      // Everything earned in fees in the period...
      ...money('feesEarned', fees),
      // ...of which this much was handed over in cash at the door and is
      // already the rider's (ADR-006)...
      ...money('collectedInCash', fees - credited),
      // ...and this much was added to the wallet balance.
      ...money('creditedToWallet', credited),
      // Paid back to the rider directly by the requester of an errand.
      ...money('reimbursedDirectly', Number(row.reimbursements)),
      wallet: {
        ...money('balance', balance),
        ...money('minWithdrawal', minimum),
        // FR-PAY-05's threshold, as a fact about the balance. It does not
        // mean a withdrawal can be made here: see `withdrawals`.
        meetsMinimum: balance >= minimum,
        pendingWithdrawals: pending._count,
        ...money('pendingWithdrawal', pending._sum.amountMinor ?? 0),
      },
      withdrawals: {
        status: 'NOT_AVAILABLE' as const,
        message:
          'Withdrawals cannot be requested in the app yet. Cash fees are already yours; a wallet balance is settled by your campus administrator.',
      },
    };
  }

  // =======================================================================
  // The withdrawal requests on file (read-only)
  // =======================================================================

  /**
   * The caller's own withdrawal requests, newest first.
   *
   * Listing only. Creating one is not offered: a request records where to
   * send money (account, UPI id), and how payouts are made and what may be
   * stored for them is not decided. The destination is returned masked — the
   * last four digits of an account and a partly hidden UPI id — because this
   * is a screen someone may open with another person looking on.
   */
  async withdrawals(user: AuthenticatedUser, query: { limit?: string; cursor?: string }) {
    const where: Prisma.WithdrawalRequestWhereInput = { userId: user.userId };
    const limit = clampPageLimit(query.limit);

    if (query.cursor) {
      const anchor = await this.prisma.withdrawalRequest.findFirst({
        where: { ...where, id: query.cursor },
        select: { id: true },
      });
      if (!anchor) {
        throw new BadRequestException({
          code: 'INVALID_CURSOR',
          message: 'That page marker is not valid for this list. Start again from the first page.',
        });
      }
    }

    const rows = await this.prisma.withdrawalRequest.findMany({
      where,
      select: {
        id: true,
        amountMinor: true,
        status: true,
        bankAccountLast4: true,
        upiId: true,
        createdAt: true,
        handledAt: true,
        payoutReference: true,
        rejectionNote: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: page.map((w) => ({
        id: w.id,
        ...money('amount', w.amountMinor),
        status: w.status,
        destination: {
          bankAccountLast4: w.bankAccountLast4,
          upiIdMasked: maskUpiId(w.upiId),
        },
        requestedAt: w.createdAt,
        handledAt: w.handledAt,
        payoutReference: w.payoutReference,
        rejectionNote: w.rejectionNote,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      canRequest: false as const,
    };
  }
}
