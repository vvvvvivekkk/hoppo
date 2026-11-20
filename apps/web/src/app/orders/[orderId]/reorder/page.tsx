'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { ReorderDraft } from '@hoppo/api-client';
import { formatMinor } from '@hoppo/shared';
import { Shell } from '@/components/shell';
import { Banner, Button, Card, Spinner } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { useCart, type Cart } from '@/lib/cart';

/**
 * S-21: reorder CTA.
 *
 * Shows the student what their old order looks like on today's menu: which
 * items are still available (possibly at a different price), which are gone,
 * and whether the shop is open. The student can then add the available items
 * to their cart and go to checkout, or go back.
 *
 * No order is placed here, nothing is reserved. This is a read that fills a
 * cart for the normal checkout flow.
 */
export default function Reorder() {
  const params = useParams<{ orderId: string }>();
  const orderId = params.orderId;
  const router = useRouter();
  const { api, user } = useApi();
  const { replace } = useCart();

  const [draft, setDraft] = useState<ReorderDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.orders.reorder(orderId);
      setDraft(result);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [api, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  function addToCartAndCheckout() {
    if (!draft || !user) return;

    const cart: Cart = {
      ownerId: user.id,
      listingId: draft.listingId,
      shopName: draft.shop.name,
      lines: draft.lines.map((line) => ({
        catalogItemId: line.catalogItemId,
        name: line.name,
        unitPriceMinor: line.unitPriceMinor,
        quantity: line.quantity,
        note: line.note ?? undefined,
      })),
    };

    replace(cart);
    router.push('/checkout');
  }

  if (loading) {
    return (
      <Shell back={`/orders/${orderId}`} title="Reorder">
        <Spinner />
      </Shell>
    );
  }

  if (error || !draft) {
    return (
      <Shell back={`/orders/${orderId}`} title="Reorder">
        <Banner tone="error">{error ?? 'Could not load the reorder draft.'}</Banner>
        <div className="mt-4">
          <Button tone="secondary" className="w-full" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell back={`/orders/${orderId}`} title={`Reorder from ${draft.shop.name}`}>
      <p className="text-sm text-[var(--color-ink-soft)]">
        From your order {draft.sourceOrder.reference},{' '}
        {new Date(draft.sourceOrder.placedAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}.
      </p>

      {!draft.shopIsOpen && (
        <div className="mt-3">
          <Banner tone="warn">{closedSentence(draft.closedReason)}</Banner>
        </div>
      )}

      {draft.anyPriceChanged && (
        <div className="mt-3">
          <Banner tone="warn">Some prices have changed since your last order.</Banner>
        </div>
      )}

      {draft.unavailable.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-2 font-bold text-[var(--color-ink-soft)]">No longer available</h2>
          <Card className="divide-y divide-[var(--color-line)]">
            {draft.unavailable.map((item, index) => (
              <div key={index} className="p-3">
                <div className="flex items-baseline gap-3">
                  <span className="font-semibold">{item.quantity}×</span>
                  <span className="min-w-0 flex-1">
                    <span className="block">{item.name}</span>
                    <span className="block text-sm text-[var(--color-ink-faint)]">
                      {item.reason === 'REMOVED' ? 'No longer on the menu' : 'Switched off for now'}
                    </span>
                  </span>
                </div>
              </div>
            ))}
          </Card>
        </section>
      )}

      {draft.lines.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-2 font-bold">
            {draft.unavailable.length > 0 ? 'Still available' : 'Your items'}
          </h2>
          <Card className="divide-y divide-[var(--color-line)]">
            {draft.lines.map((line) => (
              <div key={line.catalogItemId} className="flex items-baseline gap-3 p-3">
                <span className="font-semibold">{line.quantity}×</span>
                <span className="min-w-0 flex-1">
                  <span className="block">{line.name}</span>
                  {line.note && (
                    <span className="block text-sm text-[var(--color-ink-faint)]">{line.note}</span>
                  )}
                  {line.priceChanged && (
                    <span className="block text-sm text-[var(--color-ink-faint)]">
                      was {formatMinor(line.previousUnitPriceMinor)}
                    </span>
                  )}
                </span>
                <span className="font-semibold">{formatMinor(line.lineTotalMinor)}</span>
              </div>
            ))}
            <div className="flex justify-between p-3 font-bold">
              <span>Items subtotal</span>
              <span>{draft.itemsSubtotalLabel}</span>
            </div>
          </Card>
        </section>
      )}

      {draft.estimatedPrepMinutes !== null && (
        <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
          Estimated prep time: about {draft.estimatedPrepMinutes} minutes.
        </p>
      )}

      {draft.suggestedDeliveryPoint && (
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          Last delivered to {draft.suggestedDeliveryPoint.name}.
        </p>
      )}

      <div className="mt-6 space-y-2 pb-safe">
        {draft.canCheckout ? (
          <Button className="w-full" onClick={addToCartAndCheckout}>
            Add to cart and checkout
          </Button>
        ) : (
          <>
            <Button className="w-full" disabled>
              {draft.lines.length === 0
                ? 'Nothing available to reorder'
                : 'Shop is closed right now'}
            </Button>
            {draft.lines.length > 0 && !draft.shopIsOpen && (
              <p className="text-center text-sm text-[var(--color-ink-faint)]">
                You can reorder when the shop opens.
              </p>
            )}
          </>
        )}
        <Button
          tone="secondary"
          className="w-full"
          onClick={() => router.push(`/orders/${orderId}`)}
        >
          Go back
        </Button>
      </div>
    </Shell>
  );
}

function closedSentence(reason: string | null): string {
  switch (reason) {
    case 'TEMPORARILY_CLOSED':
      return 'The shop has paused orders for now.';
    case 'NO_HOURS_SET':
      return 'This shop has not set its opening hours yet, so it cannot take orders.';
    case 'OUTSIDE_HOURS':
      return 'The shop is closed right now — outside its opening hours.';
    default:
      return 'The shop is closed right now.';
  }
}
