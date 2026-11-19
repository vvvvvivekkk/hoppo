import type { Prisma } from '@prisma/client';

/**
 * Reading the head of one user's wallet ledger, and stamping the next entry.
 *
 * The balance of a wallet is whatever its latest entry says
 * (`balanceAfterMinor`), so "which entry is the latest" has to have exactly
 * one answer. Ordering by `createdAt` alone does not give one: the column
 * stores milliseconds, and two entries for the same user can easily land in
 * the same millisecond — a transaction that writes a release and then a
 * capture, or two quick transactions on a fast machine. When that happens the
 * database is free to return either row as "the latest", and the next entry
 * is then built on the wrong balance.
 *
 * Two things close that, and both are here so that every service that writes
 * to the ledger can share them rather than re-derive them:
 *
 *   1. `nextEntryTimestamp` — the next entry is stamped strictly later than
 *      the one before it, by at least one millisecond. The writer already
 *      holds the per-user wallet lock (see OrdersService.lockWallet), so
 *      nobody else can append in between and the timestamps for one user
 *      only ever go up.
 *   2. `WALLET_HEAD_ORDER` — a fixed sort with a tie-break. `seq` is a
 *      counter the database increments on every insert (migration
 *      20261120090000_wallet_integrity). Writers hold the wallet lock while
 *      they insert, so for one user a higher `seq` is always a later entry,
 *      and two rows that do share a millisecond are read in the order they
 *      were written.
 *
 * Both are kept, on purpose. `seq` only breaks ties: `createdAt` is still the
 * first sort key, because that is what the (user_id, created_at) index
 * serves. So an entry stamped *earlier* than its predecessor — a clock
 * stepped back, or two API instances whose clocks disagree — would still be
 * passed over as "latest" even though its `seq` is higher. Rule 1 is what
 * rules that out.
 */
export const WALLET_HEAD_ORDER = [
  { createdAt: 'desc' },
  { seq: 'desc' },
] as const satisfies readonly Prisma.WalletEntryOrderByWithRelationInput[];

export interface WalletHead {
  /** The balance the next entry must be computed from. */
  balanceMinor: number;
  /** The `createdAt` to give the next entry. */
  nextCreatedAt: Date;
}

/**
 * The timestamp for the next ledger entry: now, unless the previous entry is
 * at or after now, in which case one millisecond after it.
 *
 * Pure, and takes "now" as an argument, so the rule can be tested without a
 * clock or a database.
 */
export function nextEntryTimestamp(lastCreatedAt: Date | null, now: Date): Date {
  if (lastCreatedAt === null) return now;
  return new Date(Math.max(now.getTime(), lastCreatedAt.getTime() + 1));
}

/**
 * Read the latest entry for a user and say what the next one should carry.
 *
 * Call it only after taking the wallet lock in the same transaction, and call
 * it again before each further entry in that transaction: the second read
 * sees the first entry, so the second timestamp lands after it.
 */
export async function readWalletHead(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date = new Date(),
): Promise<WalletHead> {
  const last = await tx.walletEntry.findFirst({
    where: { userId },
    orderBy: [...WALLET_HEAD_ORDER],
    select: { balanceAfterMinor: true, createdAt: true },
  });

  return {
    balanceMinor: last?.balanceAfterMinor ?? 0,
    nextCreatedAt: nextEntryTimestamp(last?.createdAt ?? null, now),
  };
}
