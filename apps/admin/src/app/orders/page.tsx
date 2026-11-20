'use client';

import type {
  AdminOrderListItem,
  AdminOrderListQuery,
  AdminOrderSummary,
  AdminShopListItem,
  OrderStatus,
  ReportRange,
} from '@hoppo/api-client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { SummaryPanel, rangeWords } from '@/components/order-summary';
import { Banner, Button, Empty, Field, Panel } from '@/components/ui';
import { useApi } from '@/lib/api';
import {
  CANCELLED_BY,
  ORDER_STATUS,
  ORDER_STATUSES,
  OrderStatusPill,
  PAYMENT_METHOD,
  Select,
  explain,
  label,
  useAction,
  when,
} from '@/lib/kit';

/**
 * A-07: the order report.
 *
 * The API returns orders newest first, a page at a time, filtered by status,
 * placed-on date range, shop and reference. This screen is that list plus the
 * figures for the same date range (FR-ADM-05). It is a report, not a live
 * kanban: nothing here refreshes by itself, and the page says when it was
 * last read rather than implying it is live.
 */
const REFUSALS = {
  INVALID_DATE: 'One of the dates is not a real calendar date. Pick it again.',
  INVALID_DATE_RANGE:
    'The "from" date is after the "to" date, or the range is longer than a year. Narrow it and try again.',
  INVALID_CURSOR: 'The list changed while you were reading it. Apply the filters again to start from the top.',
};

interface Filters {
  status: '' | OrderStatus;
  from: string;
  to: string;
  listingId: string;
  q: string;
}

const NO_FILTERS: Filters = { status: '', from: '', to: '', listingId: '', q: '' };

function toQuery(filters: Filters): AdminOrderListQuery {
  return {
    status: filters.status || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    listingId: filters.listingId || undefined,
    q: filters.q.trim() || undefined,
  };
}

export default function OrdersPage() {
  const { api } = useApi();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [shops, setShops] = useState<AdminShopListItem[]>([]);

  const [items, setItems] = useState<AdminOrderListItem[] | null>(null);
  const [range, setRange] = useState<ReportRange | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [summary, setSummary] = useState<AdminOrderSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const load = useAction();
  const more = useAction();

  // The shop filter's choices. A failure here costs the filter, not the page.
  useEffect(() => {
    void (async () => {
      try {
        const page = await api.admin.listShops({ limit: 100 });
        setShops(page.items);
      } catch {
        setShops([]);
      }
    })();
  }, [api]);

  const read = useCallback(
    (filters: Filters) =>
      load.run(async () => {
        setError(null);
        setSummaryError(null);
        try {
          const page = await api.admin.orders.list({ ...toQuery(filters), limit: 25 });
          setItems(page.items);
          setRange(page.range);
          setNextCursor(page.nextCursor);
          setApplied(filters);
        } catch (e) {
          setError(explain(e, REFUSALS));
          return;
        }
        // The figures are for the date range only — the API's summary takes no
        // status, shop or reference filter — and default to today.
        try {
          setSummary(
            await api.admin.orders.summary({
              from: filters.from || undefined,
              to: filters.to || undefined,
            }),
          );
        } catch (e) {
          setSummary(null);
          setSummaryError(explain(e, REFUSALS));
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  );

  useEffect(() => {
    void read(NO_FILTERS);
  }, [read]);

  const showMore = () =>
    more.run(async () => {
      if (!nextCursor) return;
      try {
        const page = await api.admin.orders.list({
          ...toQuery(applied),
          limit: 25,
          cursor: nextCursor,
        });
        setItems((prev) => [...(prev ?? []), ...page.items]);
        setNextCursor(page.nextCursor);
      } catch (e) {
        setError(explain(e, REFUSALS));
      }
    });

  const set = (patch: Partial<Filters>) => setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black tracking-tight">Orders</h1>

      <Panel title="Find orders" subtitle="Dates are the day the order was placed, in the college's own timezone">
        <form
          className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            void read(draft);
          }}
        >
          <Select
            label="Status"
            value={draft.status}
            onChange={(e) => set({ status: e.target.value as Filters['status'] })}
          >
            <option value="">Any status</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS[s]}
              </option>
            ))}
          </Select>
          <Field label="From" type="date" value={draft.from} onChange={(e) => set({ from: e.target.value })} />
          <Field label="To" type="date" value={draft.to} onChange={(e) => set({ to: e.target.value })} />
          <Select label="Shop" value={draft.listingId} onChange={(e) => set({ listingId: e.target.value })}>
            <option value="">Any shop</option>
            {shops.map((s) => (
              <option key={s.listingId} value={s.listingId}>
                {s.shop.name}
              </option>
            ))}
          </Select>
          <Field
            label="Reference"
            placeholder="HP-7F3K"
            maxLength={32}
            value={draft.q}
            onChange={(e) => set({ q: e.target.value })}
          />
          <div className="flex gap-2 sm:col-span-2 lg:col-span-5">
            <Button type="submit" loading={load.busy}>
              Show orders
            </Button>
            <Button
              type="button"
              tone="quiet"
              disabled={load.busy}
              onClick={() => {
                setDraft(NO_FILTERS);
                void read(NO_FILTERS);
              }}
            >
              Clear filters
            </Button>
          </div>
        </form>
      </Panel>

      {error && <Banner tone="error">{error}</Banner>}

      {summaryError && <Banner tone="warn">The figures could not be worked out: {summaryError}</Banner>}
      {summary && <SummaryPanel summary={summary} />}

      <Panel
        title="Orders"
        subtitle={
          range
            ? `Placed ${rangeWords(range)} (${range.timezone}) · newest first`
            : 'Newest first'
        }
      >
        {items === null ? (
          <Empty title="Loading…" body="Fetching orders." />
        ) : items.length === 0 ? (
          <Empty
            title="No orders match"
            body="Nothing was placed in this date range with these filters. Widen the dates or clear a filter."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                  <tr>
                    <th className="px-4 py-2">Order</th>
                    <th className="px-4 py-2">Placed</th>
                    <th className="px-4 py-2">Shop</th>
                    <th className="px-4 py-2">Student</th>
                    <th className="px-4 py-2">Rider</th>
                    <th className="px-4 py-2">Total</th>
                    <th className="px-4 py-2">Paid by</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-line)]">
                  {items.map((order) => (
                    <tr key={order.id}>
                      <td className="px-4 py-2">
                        <Link
                          href={`/orders/${order.id}`}
                          className="nums font-bold text-[var(--color-accent)] underline"
                        >
                          {order.reference}
                        </Link>
                        <div className="mt-1">
                          <OrderStatusPill status={order.status} />
                        </div>
                        {order.cancelledBy && (
                          <div className="mt-1 text-xs text-[var(--color-ink-faint)]">
                            by {label(CANCELLED_BY, order.cancelledBy)}
                          </div>
                        )}
                      </td>
                      <td className="nums px-4 py-2">{when(order.placedAt)}</td>
                      <td className="px-4 py-2">{order.shop.name}</td>
                      <td className="px-4 py-2">{order.student.name}</td>
                      <td className="px-4 py-2">
                        {order.rider?.name ?? (
                          <span className="text-[var(--color-ink-faint)]">none yet</span>
                        )}
                      </td>
                      <td className="nums px-4 py-2 font-semibold">{order.totalLabel}</td>
                      <td className="px-4 py-2">{label(PAYMENT_METHOD, order.paymentMethod)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-3 border-t border-[var(--color-line)] px-4 py-3 text-sm">
              <span className="text-[var(--color-ink-faint)]">
                Showing {items.length} order{items.length === 1 ? '' : 's'}
                {nextCursor ? '' : ' — that is all of them'}
              </span>
              {nextCursor && (
                <Button tone="secondary" loading={more.busy} onClick={() => void showMore()}>
                  Show more
                </Button>
              )}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
