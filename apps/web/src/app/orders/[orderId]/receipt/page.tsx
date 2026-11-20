'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { OrderDetail } from '@hoppo/api-client';
import { formatMinor } from '@hoppo/shared';
import { Shell } from '@/components/shell';
import { Banner, Button, Card, Spinner } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

const PAYMENT_LABEL: Record<string, string> = {
  CASH: 'Cash',
  WALLET: 'Hoppo wallet',
  ONLINE: 'Online payment',
};

/**
 * S-22: the receipt for a finished order.
 *
 * A separate route from the tracking screen because it is a different kind of
 * page: tracking is live and full of buttons, a receipt is a fixed record
 * somebody saves or shows to a friend they are splitting with. Everything on
 * it comes from the order detail — nothing is computed here, so it cannot
 * disagree with what was charged.
 *
 * "Save" is the browser's own print dialog, which on every phone offers
 * "Save as PDF". That is a real file the student keeps, made on their device,
 * without this app having to generate PDFs. The shell's header and tab bar
 * are hidden in print (see shell.tsx), so what is saved is the receipt alone.
 *
 * Only for a completed order. Before that the figures can still change — a
 * student who collects in person is not charged the delivery fee — and a
 * receipt for an order that was then cancelled would be a receipt for
 * nothing.
 */
export default function Receipt() {
  const params = useParams<{ orderId: string }>();
  const orderId = params.orderId;
  const { api, signedIn } = useApi();

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Signed out, the Shell is redirecting; the request would only 401.
    if (!signedIn) return;
    let cancelled = false;
    api.orders
      .detail(orderId)
      .then((res) => {
        if (!cancelled) setOrder(res);
      })
      .catch((e) => {
        if (!cancelled) setError(describeError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, orderId, signedIn]);

  const back = `/orders/${orderId}`;

  if (error) {
    return (
      <Shell back={back} title="Receipt">
        <Banner tone="error">{error}</Banner>
      </Shell>
    );
  }

  if (!order) {
    return (
      <Shell back={back} title="Receipt">
        <Spinner />
      </Shell>
    );
  }

  if (order.status !== 'COMPLETED') {
    return (
      <Shell back={back} title="Receipt">
        <Banner tone="info">
          {order.status === 'CANCELLED'
            ? 'This order was cancelled, so there is no receipt for it.'
            : 'The receipt is available once this order is complete.'}
        </Banner>
        <Link href={back} className="mt-4 block">
          <Button tone="secondary" className="w-full">
            Back to the order
          </Button>
        </Link>
      </Shell>
    );
  }

  // Completed without a rider ever picking it up: the student collected it.
  const collectedInPerson = !order.rider && !order.pickedUpAt;
  const finishedAt = order.completedAt ?? order.deliveredAt;

  return (
    <Shell back={back} title="Receipt">
      <Card className="p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-bold">Receipt</h1>
          <p className="font-mono text-sm font-semibold">{order.reference}</p>
        </div>
        <p className="mt-1 text-lg font-semibold">{order.shopListing.shop.name}</p>

        <dl className="mt-4 space-y-1 text-sm">
          <Line label="Ordered" value={dateTime(order.placedAt)} />
          {order.pickedUpAt && (
            <Line label="Picked up by rider" value={dateTime(order.pickedUpAt)} />
          )}
          {finishedAt && (
            <Line
              label={collectedInPerson ? 'Collected by you' : 'Delivered'}
              value={dateTime(finishedAt)}
            />
          )}
          {order.dropLandmark && !collectedInPerson && (
            <Line label="Delivered to" value={order.dropLandmark} />
          )}
          {order.rider && <Line label="Rider" value={order.rider.name} />}
        </dl>

        <table className="mt-5 w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-faint)]">
              <th className="py-1 font-semibold">Item</th>
              <th className="py-1 text-right font-semibold">Qty</th>
              <th className="py-1 text-right font-semibold">Each</th>
              <th className="py-1 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item, index) => (
              <tr key={index} className="border-b border-[var(--color-line)] align-top">
                <td className="py-1.5 pr-2">{item.nameSnapshot}</td>
                <td className="py-1.5 text-right">{item.quantity}</td>
                <td className="py-1.5 text-right">{formatMinor(item.unitPriceMinor)}</td>
                <td className="py-1.5 text-right font-semibold">
                  {formatMinor(item.lineTotalMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="mt-3 space-y-1 text-sm">
          <Line label="Items" value={formatMinor(order.itemsSubtotalMinor)} />
          <Line
            label="Delivery fee"
            value={
              // Zero on an order collected in person, and worth saying why
              // rather than leaving a bare ₹0 that looks like a mistake.
              collectedInPerson && order.deliveryFeeMinor === 0
                ? 'Not charged — collected in person'
                : formatMinor(order.deliveryFeeMinor)
            }
          />
          <Line label="Platform fee" value={formatMinor(order.platformFeeMinor)} />
          <div className="flex justify-between gap-3 border-t border-[var(--color-line)] pt-2 text-base font-bold">
            <dt>Total</dt>
            <dd>{order.totalLabel}</dd>
          </div>
        </dl>

        <dl className="mt-4 space-y-1 text-sm">
          <Line
            label="Paid by"
            value={PAYMENT_LABEL[order.paymentMethod] ?? order.paymentMethod.toLowerCase()}
          />
          {/* The order reference is the payment reference in Phase 1: cash
              and wallet payments have no separate gateway id to quote. */}
          <Line label="Reference" value={order.reference} />
        </dl>

        <p className="mt-5 text-xs text-[var(--color-ink-faint)]">
          Hoppo order receipt. Prices are as charged when the order was placed.
        </p>
      </Card>

      <div className="mt-4 space-y-2 pb-safe print:hidden">
        <Button className="w-full" onClick={() => window.print()}>
          Save or print this receipt
        </Button>
        <p className="text-center text-sm text-[var(--color-ink-faint)]">
          Choose &quot;Save as PDF&quot; in the print dialog to keep a copy.
        </p>
      </div>
    </Shell>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--color-ink-faint)]">{label}</dt>
      <dd className="text-right font-semibold">{value}</dd>
    </div>
  );
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}
