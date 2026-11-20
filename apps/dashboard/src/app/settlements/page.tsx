'use client';

import type { ShopSettlementLine, ShopSettlementStatement } from '@hoppo/api-client';
import { formatMinor } from '@hoppo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Card, EmptyState, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { isAwaitingApproval, RegistrationStatus } from '@/lib/approval';
import { useListing } from '@/lib/use-listing';

/**
 * D-14: settlement statement.
 *
 * Shows what the shop earned, what commission was taken, and how cash and
 * platform-held orders net out. The API returns COMPLETED orders only, dated
 * by `completedAt`, so the numbers match what actually happened, not what was
 * placed. There is no payout route in this release; `payout.message` from the
 * API explains that in the shop's language.
 */

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function bps(value: number): string {
  return `${(value / 100).toFixed(2)}%`;
}

export default function SettlementsPage() {
  const { api } = useApi();
  const { listingId, listing, shop, error: listingError, loading, reload } = useListing();

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [statement, setStatement] = useState<ShopSettlementStatement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState<'load' | 'more' | null>(null);
  const running = useRef(false);

  const approved = listing?.status === 'ACTIVE' || listing?.status === 'SUSPENDED';

  const read = useCallback(
    async (cursor?: string) => {
      if (!listingId || running.current) return;
      running.current = true;
      setBusy(cursor ? 'more' : 'load');
      try {
        const result = await api.shops.settlements(listingId, {
          from: from || undefined,
          to: to || undefined,
          limit: 50,
          cursor,
        });
        if (cursor && statement) {
          // Append lines from the next page while keeping the same totals.
          setStatement({
            ...result,
            lines: [...statement.lines, ...result.lines],
          });
        } else {
          setStatement(result);
        }
        setError(null);
        setRefused(false);
      } catch (e) {
        if (isAwaitingApproval(e)) {
          setRefused(true);
          void reload();
        } else {
          setError(describeError(e));
        }
      } finally {
        running.current = false;
        setBusy(null);
      }
    },
    [api, listingId, from, to, statement, reload],
  );

  useEffect(() => {
    if (approved) void read();
    // Only on mount or when the listing changes — not when filters change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approved, listingId]);

  if (loading) return <p className="text-[var(--color-ink-faint)]">Loading…</p>;
  if (listingError) {
    return (
      <div className="space-y-4">
        <Banner tone="error">{listingError}</Banner>
        <Button tone="secondary" onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!listingId || !listing) {
    return <EmptyState title="No shop yet" body="Register a shop to start taking orders." />;
  }
  if (refused || !approved) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-black tracking-tight">Settlements</h1>
        <RegistrationStatus shopName={shop?.name} listing={listing} refused={refused} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black tracking-tight">Settlements</h1>
        <p className="text-[var(--color-ink-faint)]">
          {shop?.name} &middot; completed orders, by delivery date
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-[var(--color-line)] bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void read();
        }}
      >
        <div className="w-44">
          <Field label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="w-44">
          <Field label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button type="submit" loading={busy === 'load'}>
          Show statement
        </Button>
      </form>

      {error && <Banner tone="error">{error}</Banner>}

      {!statement && !error && (
        <p className="text-[var(--color-ink-faint)]">Loading your settlement statement…</p>
      )}

      {statement && (
        <>
          {/* Period summary */}
          <Card className="p-5">
            <h2 className="text-xl font-bold">Period summary</h2>
            <p className="text-sm text-[var(--color-ink-faint)]">
              {statement.range.from} to {statement.range.to} ({statement.range.timezone})
            </p>
            <dl className="mt-4 space-y-2 text-lg">
              <div className="flex justify-between gap-4">
                <dt>Orders delivered</dt>
                <dd className="font-semibold">{statement.totals.ordersDelivered}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Gross items total</dt>
                <dd className="font-semibold">{statement.totals.grossItemsLabel}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Commission ({bps(statement.totals.effectiveCommissionBps)})</dt>
                <dd className="font-semibold">&minus; {statement.totals.commissionLabel}</dd>
              </div>
              <div className="flex justify-between gap-4 border-t border-[var(--color-line)] pt-2">
                <dt className="font-bold">Net earnings</dt>
                <dd className="text-xl font-black">{statement.totals.netEarningsLabel}</dd>
              </div>
            </dl>
          </Card>

          {/* Cash vs platform breakdown */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="p-5">
              <h3 className="font-bold">Cash at counter</h3>
              <p className="text-sm text-[var(--color-ink-faint)]">
                {statement.byPaymentMethod.cash.orders} order{statement.byPaymentMethod.cash.orders === 1 ? '' : 's'}
              </p>
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-4">
                  <dt>Gross items</dt>
                  <dd className="nums font-semibold">{statement.byPaymentMethod.cash.grossItemsLabel}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Commission</dt>
                  <dd className="nums font-semibold">&minus; {statement.byPaymentMethod.cash.commissionLabel}</dd>
                </div>
                <div className="flex justify-between gap-4 border-t border-[var(--color-line)] pt-1">
                  <dt className="font-bold">Already received by you</dt>
                  <dd className="nums font-bold">{statement.byPaymentMethod.cash.alreadyReceivedByShopLabel}</dd>
                </div>
              </dl>
            </Card>

            <Card className="p-5">
              <h3 className="font-bold">Held by Hoppo</h3>
              <p className="text-sm text-[var(--color-ink-faint)]">
                {statement.byPaymentMethod.heldByPlatform.orders} order{statement.byPaymentMethod.heldByPlatform.orders === 1 ? '' : 's'}
              </p>
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-4">
                  <dt>Gross items</dt>
                  <dd className="nums font-semibold">{statement.byPaymentMethod.heldByPlatform.grossItemsLabel}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Commission</dt>
                  <dd className="nums font-semibold">&minus; {statement.byPaymentMethod.heldByPlatform.commissionLabel}</dd>
                </div>
                <div className="flex justify-between gap-4 border-t border-[var(--color-line)] pt-1">
                  <dt className="font-bold">Owed to you</dt>
                  <dd className="nums font-bold">{statement.byPaymentMethod.heldByPlatform.owedToShopLabel}</dd>
                </div>
              </dl>
            </Card>
          </div>

          {/* Net position */}
          <Card className="p-5">
            <h2 className="text-xl font-bold">Net position</h2>
            <dl className="mt-3 space-y-2">
              <div className="flex justify-between gap-4">
                <dt>Hoppo owes you</dt>
                <dd className="nums font-semibold">{statement.position.platformOwesShopLabel}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>You owe Hoppo (commission on cash orders)</dt>
                <dd className="nums font-semibold">{statement.position.shopOwesPlatformLabel}</dd>
              </div>
              <div className="flex justify-between gap-4 border-t border-[var(--color-line)] pt-2">
                <dt className="font-bold">Net payable to you</dt>
                <dd className="text-xl font-black">{statement.position.netPayableToShopLabel}</dd>
              </div>
            </dl>
            {statement.position.netPayableToShopMinor < 0 && (
              <p className="mt-2 text-sm text-[var(--color-ink-faint)]">
                A negative amount means your shop collected more in cash than the platform owed you,
                so you owe the difference in commission.
              </p>
            )}
          </Card>

          {/* Payout status */}
          <Banner tone="info">{statement.payout.message}</Banner>

          {/* Per-order lines */}
          <Card>
            <h2 className="p-5 text-xl font-bold">Order lines</h2>
            {statement.lines.length === 0 ? (
              <EmptyState
                title="No completed orders"
                body="Completed orders appear here as individual lines once they are delivered."
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                        <th className="px-4 py-2">Reference</th>
                        <th className="px-4 py-2">Completed</th>
                        <th className="px-4 py-2">Payment</th>
                        <th className="px-4 py-2 text-right">Items</th>
                        <th className="px-4 py-2 text-right">Commission</th>
                        <th className="px-4 py-2 text-right">To you</th>
                        <th className="px-4 py-2">Settled by</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-line)]">
                      {statement.lines.map((line) => (
                        <SettlementRow key={line.orderId} line={line} />
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center gap-4 p-4">
                  <p className="text-[var(--color-ink-faint)]">
                    Showing {statement.lines.length} line{statement.lines.length === 1 ? '' : 's'}
                    {statement.nextCursor ? '' : ' — that is all of them'}
                  </p>
                  {statement.nextCursor && (
                    <Button
                      tone="secondary"
                      loading={busy === 'more'}
                      onClick={() => void read(statement.nextCursor!)}
                    >
                      Show more
                    </Button>
                  )}
                </div>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

const PAYMENT_LABEL: Record<string, string> = {
  CASH: 'Cash',
  WALLET: 'Wallet',
  ONLINE: 'Online',
};

const SETTLED_LABEL: Record<string, string> = {
  CASH_AT_COUNTER: 'Cash at counter',
  PLATFORM: 'Platform',
};

function SettlementRow({ line }: { line: ShopSettlementLine }) {
  return (
    <tr>
      <td className="nums whitespace-nowrap px-4 py-2 font-semibold">{line.reference}</td>
      <td className="nums whitespace-nowrap px-4 py-2 text-[var(--color-ink-faint)]">{when(line.completedAt)}</td>
      <td className="px-4 py-2">{PAYMENT_LABEL[line.paymentMethod] ?? line.paymentMethod}</td>
      <td className="nums whitespace-nowrap px-4 py-2 text-right">{line.itemsSubtotalLabel}</td>
      <td className="nums whitespace-nowrap px-4 py-2 text-right">&minus; {line.commissionLabel}</td>
      <td className="nums whitespace-nowrap px-4 py-2 text-right font-semibold">{line.netToShopLabel}</td>
      <td className="px-4 py-2 text-[var(--color-ink-faint)]">{SETTLED_LABEL[line.settledBy] ?? line.settledBy}</td>
    </tr>
  );
}
