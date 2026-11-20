'use client';

import type { OrderStatus, ShopOrderHistoryItem, ShopOrderHistoryQuery } from '@hoppo/api-client';
import { formatMinor } from '@hoppo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Card, EmptyState, Field, Status } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { isAwaitingApproval, RegistrationStatus } from '@/lib/approval';
import { useListing } from '@/lib/use-listing';

/**
 * D-10 and D-09: finished orders, and one of them in full.
 *
 * The live queue shows only orders still in progress; this is where a shop
 * looks up what it sold yesterday or checks an order a customer is asking
 * about. Newest first, a page at a time.
 *
 * The money shown is the shop's: what the items came to, the commission, and
 * what the shop keeps — exactly the three figures the API returns. Delivery
 * and platform fees are between the student, the rider and Hoppo, the API
 * does not send them here, and so they are not shown.
 */
type StatusChoice = '' | 'COMPLETED' | 'CANCELLED';

interface Filters {
  status: StatusChoice;
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { status: '', from: '', to: '' };

const toQuery = (f: Filters): ShopOrderHistoryQuery => ({
  // No status means the API's own default: completed and cancelled.
  status: (f.status || undefined) as OrderStatus | undefined,
  from: f.from || undefined,
  to: f.to || undefined,
});

const REFUSALS: Record<string, string> = {
  INVALID_DATE: 'One of the dates is not a real calendar date. Pick it again.',
  INVALID_DATE_RANGE: 'The "from" date is after the "to" date. Swap them and try again.',
  INVALID_CURSOR: 'The list changed while you were reading it. Press Show orders to start from the top.',
};

const CANCELLED_BY: Record<string, string> = {
  STUDENT: 'the student',
  SHOP: 'your shop',
  ADMIN: 'a campus administrator',
  SYSTEM: 'Hoppo, automatically',
};

const PAID_BY: Record<string, string> = {
  CASH: 'Cash on delivery',
  WALLET: 'Paid from Hoppo wallet',
  ONLINE: 'Paid online',
};

function explain(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  return (code && REFUSALS[code]) || describeError(error);
}

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function HistoryPage() {
  const { api } = useApi();
  const { listingId, listing, shop, error: listingError, loading, reload } = useListing();

  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [items, setItems] = useState<ShopOrderHistoryItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [open, setOpen] = useState<ShopOrderHistoryItem | null>(null);
  const [busy, setBusy] = useState<'load' | 'more' | null>(null);
  // The guard against a second request; `busy` is only how it looks.
  const running = useRef(false);

  // A shop that was approved keeps its history even while suspended; one that
  // never was has none, and the API refuses it.
  const approved = listing?.status === 'ACTIVE' || listing?.status === 'SUSPENDED';

  const read = useCallback(
    async (filters: Filters, cursor?: string) => {
      if (!listingId || running.current) return;
      running.current = true;
      setBusy(cursor ? 'more' : 'load');
      try {
        const page = await api.shops.orderHistory(listingId, { ...toQuery(filters), limit: 20, cursor });
        setItems((prev) => (cursor ? [...(prev ?? []), ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setTimezone(page.range.timezone);
        setApplied(filters);
        setError(null);
        setRefused(false);
      } catch (e) {
        if (isAwaitingApproval(e)) {
          setRefused(true);
          void reload();
        } else {
          setError(explain(e));
        }
      } finally {
        running.current = false;
        setBusy(null);
      }
    },
    [api, listingId, reload],
  );

  useEffect(() => {
    if (approved) void read(NO_FILTERS);
  }, [approved, read]);

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
        <h1 className="text-3xl font-black tracking-tight">Order history</h1>
        <RegistrationStatus shopName={shop?.name} listing={listing} refused={refused} />
      </div>
    );
  }

  if (open) return <OrderDetail order={open} onBack={() => setOpen(null)} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black tracking-tight">Order history</h1>
        <p className="text-[var(--color-ink-faint)]">
          {shop?.name} · finished orders, newest first
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-[var(--color-line)] bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void read(draft);
        }}
      >
        <div className="w-44">
          <Field label="From" type="date" value={draft.from} onChange={(e) => setDraft((p) => ({ ...p, from: e.target.value }))} />
        </div>
        <div className="w-44">
          <Field label="To" type="date" value={draft.to} onChange={(e) => setDraft((p) => ({ ...p, to: e.target.value }))} />
        </div>
        <label className="block w-52">
          <span className="mb-1 block font-semibold">Show</span>
          <select
            value={draft.status}
            onChange={(e) => setDraft((p) => ({ ...p, status: e.target.value as StatusChoice }))}
            className="tap w-full rounded-xl border-2 border-[var(--color-line)] bg-white px-4 text-lg"
          >
            <option value="">Delivered and cancelled</option>
            <option value="COMPLETED">Delivered only</option>
            <option value="CANCELLED">Cancelled only</option>
          </select>
        </label>
        <Button type="submit" loading={busy === 'load'}>
          Show orders
        </Button>
      </form>

      {timezone && (
        <p className="text-sm text-[var(--color-ink-faint)]">
          Dates are the day the order was placed, in your college&rsquo;s time ({timezone}).
        </p>
      )}

      {error && <Banner tone="error">{error}</Banner>}

      {items === null ? (
        !error && <p className="text-[var(--color-ink-faint)]">Loading your orders…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="No finished orders here"
          body={
            applied.from || applied.to || applied.status
              ? 'Nothing matches these dates. Widen them, or clear them to see everything.'
              : 'Orders appear here once they are delivered or cancelled. Orders still in progress are on the Orders page.'
          }
        />
      ) : (
        <div className="space-y-3">
          {items.map((order) => (
            <Card key={order.id} tone={order.status === 'COMPLETED' ? 'ready' : 'plain'}>
              <button
                className="flex w-full flex-wrap items-center gap-4 p-5 text-left"
                onClick={() => setOpen(order)}
                aria-label={`Open order ${order.reference}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-3">
                    <span className="text-xl font-black tracking-tight">{order.reference}</span>
                    <Status status={order.status} />
                    <span className="text-[var(--color-ink-faint)]">{when(order.placedAt)}</span>
                  </span>
                  <span className="mt-1 block text-[var(--color-ink-faint)]">
                    {order.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  {order.status === 'COMPLETED' ? (
                    <>
                      <span className="block text-xl font-bold">{order.netToShopLabel}</span>
                      <span className="block text-sm text-[var(--color-ink-faint)]">to your shop</span>
                    </>
                  ) : (
                    <span className="block text-sm text-[var(--color-ink-faint)]">
                      {order.itemsSubtotalLabel} of items, not delivered
                    </span>
                  )}
                </span>
              </button>
            </Card>
          ))}

          <div className="flex flex-wrap items-center gap-4">
            <p className="text-[var(--color-ink-faint)]">
              Showing {items.length} order{items.length === 1 ? '' : 's'}
              {nextCursor ? '' : ' — that is all of them'}
            </p>
            {nextCursor && (
              <Button
                tone="secondary"
                loading={busy === 'more'}
                onClick={() => void read(applied, nextCursor)}
              >
                Show more
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** D-09 for a finished order: everything the history row carries. */
function OrderDetail({ order, onBack }: { order: ShopOrderHistoryItem; onBack: () => void }) {
  const steps: [string, string | null][] = [
    ['Placed', order.placedAt],
    ['You accepted', order.shopAcceptedAt],
    ['Marked ready', order.readyAt],
    ['Picked up by the rider', order.pickedUpAt],
    ['Delivered', order.deliveredAt],
    ['Completed', order.completedAt],
    ['Cancelled', order.cancelledAt],
  ];

  return (
    <div className="space-y-5">
      <Button tone="quiet" onClick={onBack}>
        ← Back to order history
      </Button>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-black tracking-tight">{order.reference}</h1>
        <Status status={order.status} />
      </div>

      {order.status === 'CANCELLED' && (
        <Banner tone="warn">
          Cancelled by {order.cancelledBy ? (CANCELLED_BY[order.cancelledBy] ?? 'someone') : 'someone'}
          {order.cancelledReason ? `: ${order.cancelledReason}` : '.'}
        </Banner>
      )}

      <Card className="p-5">
        <p className="text-[var(--color-ink-faint)]">
          {order.student.name} · {PAID_BY[order.paymentMethod] ?? 'Payment method not recorded'} ·{' '}
          {order.rider ? `delivered by ${order.rider.name}` : 'no rider was assigned'}
        </p>

        <ul className="mt-4 space-y-1">
          {order.items.map((item, i) => (
            <li key={i} className="flex gap-3 text-lg">
              <span className="w-10 shrink-0 font-bold">{item.quantity}×</span>
              <span className="flex-1">
                {item.name}
                {item.note && (
                  <span className="block text-base text-[var(--color-waiting)]">Note: {item.note}</span>
                )}
              </span>
              <span className="shrink-0 font-semibold">{formatMinor(item.lineTotalMinor)}</span>
            </li>
          ))}
        </ul>

        {order.studentNote && (
          <p className="mt-3 rounded-xl bg-[var(--color-waiting-bg)] px-4 py-2 font-medium text-[var(--color-waiting)]">
            {order.studentNote}
          </p>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-xl font-bold">Money</h2>
        <dl className="mt-3 space-y-2 text-lg">
          <div className="flex justify-between gap-4">
            <dt>Items</dt>
            <dd className="font-semibold">{order.itemsSubtotalLabel}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Hoppo commission</dt>
            <dd className="font-semibold">− {order.commissionLabel}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-[var(--color-line)] pt-2">
            <dt className="font-bold">To your shop</dt>
            <dd className="text-xl font-black">{order.netToShopLabel}</dd>
          </div>
        </dl>
        {order.status === 'CANCELLED' && (
          <p className="mt-3 text-[var(--color-ink-faint)]">
            This order was cancelled, so these are the amounts it would have come to, not money
            you were paid.
          </p>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-xl font-bold">What happened</h2>
        <ol className="mt-3 space-y-1">
          {steps
            .filter(([, at]) => at !== null)
            .map(([name, at]) => (
              <li key={name} className="flex flex-wrap gap-3">
                <span className="w-56 font-semibold">{name}</span>
                <span className="text-[var(--color-ink-faint)]">{when(at)}</span>
              </li>
            ))}
        </ol>
      </Card>
    </div>
  );
}
