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

/**
 * Take the per-user wallet lock for every wallet a transaction will write to.
 *
 * THE LOCK ORDER, which every wallet-writing transaction in the API follows
 * (orders, the rider's settlement in rider.service.ts `settleDelivery`, the
 * accept-window sweep in dispatch, an administrator's resolution):
 *
 *   1. wallet locks first, before the transaction writes any row;
 *   2. when more than one wallet is involved, in ascending order of user id.
 *
 * Two transactions that both need wallets A and B then both ask for A first,
 * so neither can end up holding one while waiting for the other — which is
 * what a deadlock is. Row locks (taken by UPDATE) always come after, so a
 * transaction never waits for a wallet while holding a row another
 * wallet-holder needs.
 *
 * The lock is an advisory lock: a lock on a number rather than on a row,
 * which is what is needed when the thing protected is "the next ledger row"
 * and does not exist yet. The `_xact_` kind is released automatically when
 * the transaction commits or rolls back. Asking again for a lock the same
 * transaction already holds returns at once, so a helper may safely take a
 * lock its caller has already taken.
 *
 * The key expression must be byte-for-byte the same everywhere; a different
 * prefix would be a different lock and protect nothing. $executeRaw rather
 * than $queryRaw because the function returns `void`, which Prisma cannot
 * read back as a result column.
 */
export async function lockWallets(
  tx: Prisma.TransactionClient,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of [...new Set(userIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wallet:' || ${userId}))`;
  }
}

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
