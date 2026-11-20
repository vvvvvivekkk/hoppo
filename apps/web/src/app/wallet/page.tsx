'use client';

import { useState } from 'react';
import { formatMinor } from '@hoppo/shared';
import type { WalletStatement, RiderEarnings } from '@hoppo/api-client';
import { Shell } from '@/components/shell';
import { Banner, Button, Card, Spinner } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { usePolling } from '@/lib/poll';

/**
 * S-24 / S-25: wallet balance, earnings summary and transaction history.
 *
 * This serves both roles a student can have:
 * - As a buyer: wallet balance and top-up / spend history.
 * - As a rider: delivery fees earned, cash collected, and the withdrawal list.
 *
 * Everything is read-only. Withdrawals and payouts are not built yet — the
 * API serves the list but nothing creates a request, because the payout
 * provider is an open owner decision.
 */
export default function WalletPage() {
  const { api, signedIn } = useApi();
  const [tab, setTab] = useState<'statement' | 'earnings'>('statement');

  const { data: statement, loading: stmtLoading, error: stmtError } = usePolling<WalletStatement>(
    () => api.wallet.statement({}),
    30_000,
    [],
    signedIn,
  );

  const { data: earnings, loading: earnLoading, error: earnError } = usePolling<RiderEarnings>(
    () => api.wallet.earnings(),
    30_000,
    [],
    signedIn,
  );

  if (!signedIn) {
    return (
      <Shell title="Wallet">
        <Spinner />
      </Shell>
    );
  }

  return (
    <Shell title="Wallet" back="/shops">
      {/* Balance card */}
      <Card className="p-4 text-center">
        <p className="text-sm text-[var(--color-ink-soft)]">Wallet balance</p>
        <p className="mt-1 text-3xl font-bold">
          {statement ? formatMinor(statement.closingBalanceMinor) : '…'}
        </p>
      </Card>

      {/* Tabs */}
      <div className="mt-4 flex border-b border-[var(--color-line)]">
        <button
          type="button"
          className={`flex-1 pb-2 text-center text-sm font-semibold ${
            tab === 'statement'
              ? 'border-b-2 border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'text-[var(--color-ink-faint)]'
          }`}
          onClick={() => setTab('statement')}
        >
          Transactions
        </button>
        <button
          type="button"
          className={`flex-1 pb-2 text-center text-sm font-semibold ${
            tab === 'earnings'
              ? 'border-b-2 border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'text-[var(--color-ink-faint)]'
          }`}
          onClick={() => setTab('earnings')}
        >
          Earnings
        </button>
      </div>

      {/* Statement tab */}
      {tab === 'statement' && (
        <div className="mt-4">
          {stmtLoading && !statement && <Spinner />}
          {stmtError && <Banner tone="error">{describeError(stmtError)}</Banner>}
          {statement && statement.entries.length === 0 && (
            <p className="py-8 text-center text-sm text-[var(--color-ink-faint)]">
              No transactions yet. Your wallet activity will show up here.
            </p>
          )}
          {statement && statement.entries.length > 0 && (
            <ul className="space-y-1">
              {statement.entries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center justify-between border-b border-[var(--color-line)] py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {describeEntryType(entry.type)}
                    </p>
                    <p className="text-xs text-[var(--color-ink-faint)]">
                      {new Date(entry.createdAt).toLocaleString('en-IN', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={`font-semibold ${
                        entry.balanceChangeMinor > 0
                          ? 'text-green-600'
                          : entry.balanceChangeMinor < 0
                            ? 'text-red-600'
                            : 'text-[var(--color-ink-faint)]'
                      }`}
                    >
                      {entry.balanceChangeMinor > 0 ? '+' : ''}
                      {entry.balanceChangeMinor !== 0 ? formatMinor(entry.balanceChangeMinor) : '—'}
                    </p>
                    <p className="text-xs text-[var(--color-ink-faint)]">
                      Bal: {formatMinor(entry.balanceAfterMinor)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Earnings tab */}
      {tab === 'earnings' && (
        <div className="mt-4">
          {earnLoading && !earnings && <Spinner />}
          {earnError && <Banner tone="error">{describeError(earnError)}</Banner>}
          {earnings && (
            <div className="space-y-3">
              <Card className="p-4">
                <div className="flex justify-between">
                  <span className="text-sm text-[var(--color-ink-soft)]">Total earned</span>
                  <span className="font-bold">{formatMinor(earnings.feesEarnedMinor)}</span>
                </div>
                <div className="mt-2 flex justify-between">
                  <span className="text-sm text-[var(--color-ink-soft)]">Credited to wallet</span>
                  <span>{formatMinor(earnings.creditedToWalletMinor)}</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-sm text-[var(--color-ink-soft)]">Collected in cash</span>
                  <span>{formatMinor(earnings.collectedInCashMinor)}</span>
                </div>
              </Card>
              <Card className="p-4">
                <div className="flex justify-between">
                  <span className="text-sm text-[var(--color-ink-soft)]">Wallet balance</span>
                  <span className="font-bold">{formatMinor(earnings.wallet.balanceMinor)}</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-sm text-[var(--color-ink-soft)]">Min. withdrawal</span>
                  <span>{formatMinor(earnings.wallet.minWithdrawalMinor)}</span>
                </div>
              </Card>
              <p className="text-center text-sm text-[var(--color-ink-faint)]">
                Withdrawals are not available yet. When they are, you will be able to request a
                payout from this screen.
              </p>
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

function describeEntryType(type: string): string {
  const labels: Record<string, string> = {
    ORDER_HOLD: 'Order payment held',
    ORDER_RELEASE: 'Order payment released',
    DELIVERY_FEE_EARNED: 'Delivery fee earned',
    ADMIN_CREDIT: 'Admin credit',
    ADMIN_DEBIT: 'Admin debit',
    REFUND: 'Refund',
    TOPUP: 'Top-up',
    WITHDRAWAL: 'Withdrawal',
  };
  return labels[type] ?? type.replace(/_/g, ' ').toLowerCase();
}
