'use client';

import Link from 'next/link';
import type { MyOrder } from '@hoppo/api-client';
import { Shell } from '@/components/shell';
import { Banner, Button, Card, EmptyState, Spinner, Status } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { usePolling } from '@/lib/poll';
import { VerifyPrompt, useCanOrder } from '@/components/verify-prompt';

const LIVE_STATUSES = new Set(['PLACED', 'SHOP_ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP']);

/**
 * S-20: order history, live orders first.
 *
 * Polled rather than socket-driven. The socket is per-order on the tracking
 * screen, where it matters; a list that is a few seconds stale is fine, and
 * one poll beats holding a subscription open for every order a student has
 * ever placed.
 *
 * An unverified student is not asked. The API refuses their `GET /orders`
 * with a 403, and they cannot have placed an order anyway, so the request
 * would only produce an error banner over a "No orders yet" that is true for
 * the wrong reason. They get the verify prompt, which says what is actually
 * in the way.
 */
export default function Orders() {
  const { api } = useApi();
  const { canOrder, loading: accountLoading } = useCanOrder();
  const { data, error, loading } = usePolling(() => api.orders.mine(30), 15_000, [], canOrder);

  if (accountLoading) {
    return (
      <Shell title="Your orders">
        <Spinner />
      </Shell>
    );
  }

  if (!canOrder) {
    return (
      <Shell title="Your orders">
        <VerifyPrompt />
        <p className="text-sm text-[var(--color-ink-soft)]">
          Orders you place will show up here once your ID is approved.
        </p>
      </Shell>
    );
  }

  const orders = data?.items ?? [];
  const live = orders.filter((o) => LIVE_STATUSES.has(o.status));
  const past = orders.filter((o) => !LIVE_STATUSES.has(o.status));

  return (
    <Shell title="Your orders">
      {loading && !data && <Spinner />}

      {error && (
        <div className="mb-3">
          <Banner tone="warn">
            {describeError(error)}
            {data ? ' Showing whatever loaded last.' : ''}
          </Banner>
        </div>
      )}

      {/* Only once a list has actually loaded. A failed first request is not
          "no orders", and saying so sends people off to order twice. */}
      {data && orders.length === 0 && (
        <EmptyState
          title="No orders yet"
          body="Pick a shop near your college and your first order will show up here."
          action={
            <Link href="/shops">
              <Button>Find a shop</Button>
            </Link>
          }
        />
      )}

      {live.length > 0 && (
        <section>
          <h2 className="mb-2 font-bold text-[var(--color-ink-soft)]">Happening now</h2>
          <ul className="space-y-3">
            {live.map((order) => (
              <li key={order.id}>
                <OrderRow order={order} live />
              </li>
            ))}
          </ul>
        </section>
      )}

      {past.length > 0 && (
        <section className={live.length > 0 ? 'mt-6' : ''}>
          <h2 className="mb-2 font-bold text-[var(--color-ink-soft)]">Earlier</h2>
          <ul className="space-y-3">
            {past.map((order) => (
              <li key={order.id}>
                <OrderRow order={order} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  );
}

function OrderRow({ order, live = false }: { order: MyOrder; live?: boolean }) {
  const itemSummary = order.items
    .map((i) => (i.quantity > 1 ? `${i.quantity}× ${i.nameSnapshot}` : i.nameSnapshot))
    .join(', ');

  return (
    <Link href={`/orders/${order.id}`} className="block">
      <Card className="p-4" tone={live ? 'preparing' : 'plain'}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold">{order.shopListing.shop.name}</p>
            <p className="mt-0.5 truncate text-sm text-[var(--color-ink-soft)]">{itemSummary}</p>
            <p className="mt-1 text-sm text-[var(--color-ink-faint)]">
              {order.reference} ·{' '}
              {new Date(order.placedAt).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="font-bold">{order.totalLabel}</p>
            <div className="mt-1">
              <Status status={order.status} />
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}
