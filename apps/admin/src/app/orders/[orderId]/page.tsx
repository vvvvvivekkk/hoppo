'use client';

import type { AdminOrderDetail } from '@hoppo/api-client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Banner, Detail, Empty, Panel, Pill } from '@/components/ui';
import { useApi } from '@/lib/api';
import {
  CANCELLED_BY,
  ORDER_STATUS,
  OrderStatusPill,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  TASK_STATUS,
  explain,
  label,
  money,
  span,
  when,
  words,
} from '@/lib/kit';

/**
 * A-07, one order: what happened to it and where the money went.
 *
 * Everything shown is in the API's answer for this order. There are no
 * mobile numbers or coordinates here because the API does not send any
 * (FR-PRIV-03), not because they were left off the screen.
 */
const ROUND_OUTCOME: Record<string, string> = {
  PENDING: 'Waiting for a rider',
  ACCEPTED: 'A rider accepted',
  EXPIRED: 'Nobody accepted in time',
  CANCELLED: 'Cancelled',
};

const WALLET_PARTY: Record<string, string> = {
  STUDENT: 'student',
  RIDER: 'rider',
  OTHER: 'other',
};

const REFUSALS = {
  ORDER_NOT_FOUND: 'There is no order with that id. It may have been opened from an old link.',
  CROSS_TENANT_ACCESS: 'That order belongs to another college, so it cannot be opened from this account.',
};

export default function OrderDetailPage() {
  const { api } = useApi();
  const { orderId } = useParams<{ orderId: string }>();
  const [order, setOrder] = useState<AdminOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const detail = await api.admin.orders.detail(orderId);
        if (live) setOrder(detail);
      } catch (e) {
        if (live) setError(explain(e, REFUSALS));
      }
    })();
    return () => {
      live = false;
    };
  }, [api, orderId]);

  return (
    <div className="space-y-4">
      <Link href="/orders" className="text-sm font-semibold text-[var(--color-accent)] underline">
        ← All orders
      </Link>

      {error && <Banner tone="error">{error}</Banner>}
      {!order && !error && <Empty title="Loading…" body="Fetching the order." />}

      {order && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="nums text-2xl font-black tracking-tight">{order.reference}</h1>
            <OrderStatusPill status={order.status} />
          </div>

          {order.status === 'CANCELLED' && (
            <Banner tone="warn">
              Cancelled by {label(CANCELLED_BY, order.cancelledBy)}
              {order.cancelledReason ? `: ${order.cancelledReason}` : '.'}
            </Banner>
          )}

          <Panel title="Who and where">
            <dl className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Shop" value={order.shop.name} />
              <Detail label="Student" value={order.student.name} />
              <Detail label="Rider" value={order.rider?.name ?? 'None assigned'} />
              <Detail label="Deliver to" value={order.dropLabel ?? 'Not recorded'} />
              <Detail label="Paid by" value={label(PAYMENT_METHOD, order.paymentMethod)} />
              <Detail label="Payment" value={label(PAYMENT_STATUS, order.paymentStatus)} />
              <Detail
                label="Shop's stated preparation"
                value={order.statedPrepMinutes === null ? 'Not stated' : `${order.statedPrepMinutes} min`}
              />
              <Detail label="Expected ready" value={when(order.expectedReadyAt)} nums />
            </dl>
            {order.studentNote && (
              <p className="border-t border-[var(--color-line)] px-4 py-3 text-sm">
                <span className="font-semibold">Note from the student:</span> {order.studentNote}
              </p>
            )}
          </Panel>

          <Panel title="Timeline" subtitle="Only the steps that happened, in order">
            <ol className="divide-y divide-[var(--color-line)] text-sm">
              {order.timeline.map((step) => (
                <li key={`${step.event}-${step.at}`} className="flex flex-wrap gap-3 px-4 py-2">
                  <span className="w-56 font-semibold">{label(ORDER_STATUS, step.event)}</span>
                  <span className="nums text-[var(--color-ink-soft)]">{when(step.at)}</span>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Items">
            <ul className="divide-y divide-[var(--color-line)] text-sm">
              {order.items.map((item, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-3 px-4 py-2">
                  <span className="nums w-10 font-bold">{item.quantity}×</span>
                  <span className="flex-1">
                    {item.name}
                    {item.note && (
                      <span className="block text-xs text-[var(--color-ink-faint)]">Note: {item.note}</span>
                    )}
                  </span>
                  <span className="nums text-[var(--color-ink-faint)]">{money(item.unitPriceMinor)} each</span>
                  <span className="nums font-semibold">{money(item.lineTotalMinor)}</span>
                </li>
              ))}
            </ul>
            <dl className="grid gap-4 border-t border-[var(--color-line)] p-4 sm:grid-cols-5">
              <Detail label="Items" value={order.itemsSubtotalLabel} nums />
              <Detail label="Delivery fee" value={order.deliveryFeeLabel} nums />
              <Detail label="Platform fee" value={order.platformFeeLabel} nums />
              <Detail label="Student pays" value={order.totalLabel} nums />
              <Detail label="Commission from the shop" value={order.commissionLabel} nums />
            </dl>
          </Panel>

          <Panel title="Delivery">
            {order.task ? (
              <dl className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
                <Detail label="Delivery status" value={label(TASK_STATUS, order.task.status)} />
                <Detail label="Rider's fee" value={money(order.task.feeMinor)} nums />
                <Detail label="Fee at the first round" value={money(order.task.baseFeeMinor)} nums />
                <Detail label="Distance" value={`${order.task.distanceM} m`} nums />
                <Detail label="Assigned" value={when(order.task.assignedAt)} nums />
                <Detail label="Picked up" value={when(order.task.pickedUpAt)} nums />
                <Detail label="Delivered" value={when(order.task.deliveredAt)} nums />
                <Detail label="Completed" value={when(order.task.completedAt)} nums />
              </dl>
            ) : (
              <Empty title="No delivery task" body="This order has no delivery attached to it." />
            )}
          </Panel>

          <Panel
            title="Search for a rider"
            subtitle={
              order.broadcast.roundsSent === 0
                ? 'No round has been sent'
                : `${order.broadcast.roundsSent} round${order.broadcast.roundsSent === 1 ? '' : 's'} sent · ${
                    order.broadcast.secondsToAcceptance === null
                      ? 'not accepted'
                      : `accepted after ${span(order.broadcast.secondsToAcceptance)}`
                  }`
            }
          >
            {order.broadcast.rounds.length === 0 ? (
              <Empty
                title="No rounds"
                body="The order was never offered to riders — it was cancelled first, or the shop has not accepted it yet."
              />
            ) : (
              <ul className="divide-y divide-[var(--color-line)] text-sm">
                {order.broadcast.rounds.map((round) => (
                  // Keyed on when it was sent, not the round number: a delivery
                  // that went back into the pool is searched for again from
                  // round 1, so round numbers repeat within one order.
                  <li key={`${round.round}-${round.sentAt}`} className="flex flex-wrap items-baseline gap-3 px-4 py-2">
                    <span className="w-20 font-bold">Round {round.round}</span>
                    <span className="nums">within {round.radiusM} m</span>
                    <span className="nums">fee {money(round.feeMinor)}</span>
                    <span className="nums">
                      {round.eligibleCount} rider{round.eligibleCount === 1 ? '' : 's'} offered it
                    </span>
                    <Pill tone={round.outcome === 'ACCEPTED' ? 'ok' : round.outcome === 'PENDING' ? 'pending' : 'plain'}>
                      {label(ROUND_OUTCOME, round.outcome)}
                    </Pill>
                    <span className="nums text-[var(--color-ink-faint)]">sent {when(round.sentAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Wallet entries" subtitle="Every ledger row for this order, oldest first">
            {order.walletEntries.length === 0 ? (
              <Empty
                title="No wallet entries"
                body="Nothing has moved through a Hoppo wallet for this order — a cash order before the rider is paid, for example."
              />
            ) : (
              <ul className="divide-y divide-[var(--color-line)] text-sm">
                {order.walletEntries.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-baseline gap-3 px-4 py-2">
                    <span className="nums w-36 text-[var(--color-ink-faint)]">{when(entry.createdAt)}</span>
                    <span className="font-semibold">{words(entry.type)}</span>
                    <span className="nums font-bold">
                      {entry.direction === 'CREDIT' ? '+' : '−'}
                      {entry.amountLabel}
                    </span>
                    <span>
                      {entry.user.name} ({label(WALLET_PARTY, entry.party)})
                    </span>
                    <span className="nums text-[var(--color-ink-faint)]">
                      balance after {money(entry.balanceAfterMinor)}
                    </span>
                    {entry.note && <span className="text-[var(--color-ink-faint)]">{entry.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
