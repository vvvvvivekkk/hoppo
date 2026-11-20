'use client';

import type { AdminOrderSummary, ReportRange } from '@hoppo/api-client';
import { Panel } from '@/components/ui';
import { CANCELLED_BY, span } from '@/lib/kit';

export function rangeWords(range: ReportRange): string {
  if (range.from && range.to) {
    return range.from === range.to ? range.from : `${range.from} to ${range.to}`;
  }
  if (range.from) return `from ${range.from}`;
  if (range.to) return `up to ${range.to}`;
  return 'all dates';
}

/** FR-ADM-05: the figures for the date range, with the basis the API states. */
export function SummaryPanel({ summary }: { summary: AdminOrderSummary }) {
  const rate = (summary.completionRateBps / 100).toFixed(2).replace(/\.?0+$/, '');
  const inProgress =
    summary.byStatus.PLACED +
    summary.byStatus.SHOP_ACCEPTED +
    summary.byStatus.PREPARING +
    summary.byStatus.READY +
    summary.byStatus.PICKED_UP +
    summary.byStatus.DELIVERED;

  return (
    <Panel
      title="Figures for the date range"
      subtitle={`Orders placed ${rangeWords(summary.range)} (${summary.range.timezone}) — every status and shop, whatever the filters above`}
    >
      <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Orders placed" value={summary.ordersPlaced} />
        <Figure label="Completed" value={summary.byStatus.COMPLETED} note={`${rate}% of those placed`} />
        <Figure label="Still in progress" value={inProgress} />
        <Figure
          label="Cancelled"
          value={summary.cancellations.total}
          note={(['STUDENT', 'SHOP', 'ADMIN', 'SYSTEM'] as const)
            .filter((who) => summary.cancellations.byWho[who] > 0)
            .map((who) => `${summary.cancellations.byWho[who]} by ${CANCELLED_BY[who]}`)
            .join(', ')}
        />
        <Figure
          label="No rider found"
          value={summary.unfulfilledBroadcasts}
          note="Orders whose delivery is unfulfilled right now"
        />
        <Figure
          label="Shop answers in (median)"
          value={span(summary.timings.medianPlacedToAcceptedSeconds)}
          note={`from ${summary.timings.placedToAcceptedSampleSize} accepted order${
            summary.timings.placedToAcceptedSampleSize === 1 ? '' : 's'
          }`}
        />
        <Figure
          label="Ready to delivered (median)"
          value={span(summary.timings.medianReadyToDeliveredSeconds)}
          note={`from ${summary.timings.readyToDeliveredSampleSize} delivered order${
            summary.timings.readyToDeliveredSampleSize === 1 ? '' : 's'
          }`}
        />
      </div>

      <div className="border-t border-[var(--color-line)] p-4">
        <p className="text-sm font-bold">Money</p>
        <p className="text-xs text-[var(--color-ink-faint)]">
          {summary.money.basis === 'COMPLETED'
            ? 'These totals cover completed orders only. A cancelled or unfinished order is not counted.'
            : `These totals are on the basis "${summary.money.basis}".`}
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Figure label="Items sold" value={summary.money.grossItemsLabel} />
          <Figure label="Delivery fees" value={summary.money.deliveryFeesLabel} />
          <Figure label="Platform fees" value={summary.money.platformFeesLabel} />
          <Figure label="Students paid in all" value={summary.money.totalLabel} />
          <Figure label="Commission" value={summary.money.commissionLabel} />
        </div>
      </div>

      {summary.revenueByShop.length > 0 && (
        <div className="border-t border-[var(--color-line)]">
          <p className="px-4 pt-3 text-sm font-bold">By shop (completed orders)</p>
          <ul className="divide-y divide-[var(--color-line)] text-sm">
            {summary.revenueByShop.map((shop) => (
              <li key={shop.listingId} className="flex flex-wrap items-baseline gap-3 px-4 py-2">
                <span className="font-semibold">{shop.shopName}</span>
                <span className="nums">{shop.grossItemsLabel}</span>
                <span className="text-[var(--color-ink-faint)]">
                  {shop.completedOrders} completed order{shop.completedOrders === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function Figure({ label: text, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">{text}</p>
      <p className="nums text-2xl font-black">{value}</p>
      {note && <p className="text-xs text-[var(--color-ink-faint)]">{note}</p>}
    </div>
  );
}
