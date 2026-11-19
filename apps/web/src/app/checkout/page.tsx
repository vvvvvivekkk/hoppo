'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type DeliveryPoint, type OrderQuote } from '@hoppo/api-client';
import { formatMinor } from '@hoppo/shared';
import { Shell } from '@/components/shell';
import { Banner, Button, Card, Spinner, Stepper, TextArea } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { useCart } from '@/lib/cart';

type Payment = 'CASH' | 'WALLET';

/**
 * S-16 and S-17: where it goes, what it costs, and confirm.
 *
 * The flow is quote-then-place, and the gap between them is the interesting
 * part. The quote is computed by the server from live prices; the order is
 * placed with `expectedTotalMinor` set to the total that was actually on
 * screen. If a shop changes a price in those seconds, the server refuses with
 * `PRICE_CHANGED` rather than charging the new amount (FR-ORD-03) — and this
 * screen then shows both numbers and makes the student agree again.
 *
 * Re-quoting happens on every change to the cart or the drop point, because
 * the delivery fee depends on the distance from the shop to that point. A
 * fee that updates only at the end is a fee nobody reads.
 */
export default function Checkout() {
  const { api } = useApi();
  const router = useRouter();
  const cart = useCart();

  const [points, setPoints] = useState<DeliveryPoint[] | null>(null);
  const [pointId, setPointId] = useState<string>('');
  const [note, setNote] = useState('');
  const [payment, setPayment] = useState<Payment>('CASH');

  const [quote, setQuote] = useState<OrderQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  /** Set when the server refused because the total moved under us. */
  const [priceMoved, setPriceMoved] = useState<{ from: number; to: number } | null>(null);

  useEffect(() => {
    void api.browse
      .deliveryPoints()
      .then(({ points: rows }) => {
        setPoints(rows);
        // Preselect the first, so the common case is one tap: most students
        // use the same hostel gate every time.
        if (rows.length > 0) setPointId((current) => current || rows[0].id);
      })
      .catch((e) => setError(describeError(e)));
  }, [api]);

  const lines = cart.cart?.lines ?? [];
  const listingId = cart.cart?.listingId;

  const requote = useCallback(async () => {
    if (!listingId || lines.length === 0 || !pointId) return;

    setQuoting(true);
    setError(null);
    setPriceMoved(null);

    try {
      setQuote(
        await api.orders.quote({
          listingId,
          lines: lines.map((l) => ({
            catalogItemId: l.catalogItemId,
            quantity: l.quantity,
            note: l.note,
          })),
          deliveryPointId: pointId,
        }),
      );
    } catch (e) {
      setError(describeError(e));
      setQuote(null);
    } finally {
      setQuoting(false);
    }
    // The cart lines are compared by value rather than by reference, so a
    // quantity change re-quotes but a re-render does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, listingId, pointId, JSON.stringify(lines)]);

  useEffect(() => {
    void requote();
  }, [requote]);

  async function place() {
    if (!quote || !listingId) return;

    setPlacing(true);
    setError(null);
    setPriceMoved(null);

    try {
      const res = await api.orders.place({
        listingId,
        lines: lines.map((l) => ({
          catalogItemId: l.catalogItemId,
          quantity: l.quantity,
          note: l.note,
        })),
        deliveryPointId: pointId,
        paymentMethod: payment,
        studentNote: note.trim() || undefined,
        // FR-ORD-03: the number the student saw, not a number recomputed here.
        expectedTotalMinor: quote.totals.totalMinor,
      });

      cart.clear();
      router.replace(`/orders/${res.orderId}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PRICE_CHANGED') {
        const details = e.details as
          | { shownTotalMinor?: number; currentTotalMinor?: number }
          | undefined;
        if (details?.shownTotalMinor !== undefined && details.currentTotalMinor !== undefined) {
          setPriceMoved({ from: details.shownTotalMinor, to: details.currentTotalMinor });
        }
        // Pull the new numbers in so the student is agreeing to what is
        // actually true now, rather than retrying the stale total.
        await requote();
      } else {
        setError(describeError(e));
      }
    } finally {
      setPlacing(false);
    }
  }

  if (!cart.cart || lines.length === 0) {
    return (
      <Shell back="/shops" title="Checkout">
        <Banner tone="info">Your cart is empty.</Banner>
        <Button className="mt-4 w-full" onClick={() => router.push('/shops')}>
          Find a shop
        </Button>
      </Shell>
    );
  }

  return (
    <Shell back={`/shops/${listingId}`} title="Checkout">
      <p className="text-sm text-[var(--color-ink-faint)]">From</p>
      <p className="text-lg font-bold">{cart.cart.shopName}</p>

      <section className="mt-5">
        <h2 className="mb-2 font-bold">Your order</h2>
        <Card className="divide-y divide-[var(--color-line)]">
          {lines.map((line) => (
            <div key={line.catalogItemId} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{line.name}</p>
                <p className="text-sm text-[var(--color-ink-faint)]">
                  {formatMinor(line.unitPriceMinor)} each
                </p>
              </div>
              <Stepper
                quantity={line.quantity}
                onChange={(next) => cart.setQuantity(line.catalogItemId, next)}
                label={line.name}
              />
            </div>
          ))}
        </Card>
      </section>

      <section className="mt-5">
        <h2 className="mb-2 font-bold">Where should it go?</h2>
        {points === null ? (
          <Spinner label="Loading drop points" />
        ) : points.length === 0 ? (
          <Banner tone="warn">
            No delivery points are set up for your college yet, so orders cannot be placed. An
            administrator needs to add at least one.
          </Banner>
        ) : (
          <ul className="space-y-2">
            {points.map((point) => (
              <li key={point.id}>
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-2xl border-2 bg-white p-4 ${
                    pointId === point.id
                      ? 'border-[var(--color-accent)]'
                      : 'border-[var(--color-line)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="drop-point"
                    value={point.id}
                    checked={pointId === point.id}
                    onChange={() => setPointId(point.id)}
                    className="mt-1 h-5 w-5"
                  />
                  <span className="min-w-0">
                    <span className="block font-semibold">{point.name}</span>
                    {point.description && (
                      <span className="block text-sm text-[var(--color-ink-soft)]">
                        {point.description}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-5">
        <TextArea
          label="Anything the shop should know?"
          hint="Optional. Less chilli, no onion, that sort of thing."
          rows={2}
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </section>

      <section className="mt-5">
        <h2 className="mb-2 font-bold">Paying</h2>
        <div className="flex gap-2">
          <PaymentChoice
            label="Cash on delivery"
            hint="Pay the rider when it arrives"
            selected={payment === 'CASH'}
            onSelect={() => setPayment('CASH')}
          />
          <PaymentChoice
            label="Wallet"
            hint="From your Hoppo balance"
            selected={payment === 'WALLET'}
            onSelect={() => setPayment('WALLET')}
          />
        </div>
        {/* Online payment is in the schema but has no provider wired up in
            Phase 1, so it is not offered rather than offered and broken. */}
        <p className="mt-2 text-sm text-[var(--color-ink-faint)]">
          Card and UPI are not available yet.
        </p>
      </section>

      <section className="mt-5">
        <h2 className="mb-2 font-bold">What it costs</h2>

        {priceMoved && (
          <div className="mb-3">
            <Banner tone="warn">
              The total changed from {formatMinor(priceMoved.from)} to{' '}
              {formatMinor(priceMoved.to)} while you were ordering, so nothing was placed. The
              figures below are current — confirm again if you are happy with them.
            </Banner>
          </div>
        )}

        {error && (
          <div className="mb-3">
            <Banner tone="error">{error}</Banner>
          </div>
        )}

        {quoting && !quote && <Spinner label="Working out the fees" />}

        {quote && (
          <Card className={`p-4 ${quoting ? 'opacity-60' : ''}`}>
            <Row label="Items" value={quote.totals.itemsSubtotalLabel} />
            <Row
              label={`Delivery (${quote.distanceLabel})`}
              value={quote.totals.deliveryFeeLabel}
            />
            <Row label="Platform fee" value={quote.totals.platformFeeLabel} />
            <div className="mt-3 flex items-baseline justify-between border-t border-[var(--color-line)] pt-3">
              <span className="text-lg font-bold">Total</span>
              <span className="text-xl font-bold">{quote.totals.totalLabel}</span>
            </div>
            <p className="mt-2 text-sm text-[var(--color-ink-faint)]">
              Ready in about {quote.estimatedPrepMinutes} minutes, then a rider brings it to{' '}
              {quote.drop.label}.
            </p>
          </Card>
        )}
      </section>

      <div className="mt-6 pb-safe">
        <Button
          large
          className="w-full"
          loading={placing}
          disabled={!quote || quoting || !quote.shopIsOpen || !pointId}
          onClick={() => void place()}
        >
          {quote && !quote.shopIsOpen
            ? 'The shop just closed'
            : quote
              ? `Place the order · ${quote.totals.totalLabel}`
              : 'Place the order'}
        </Button>
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-1">
      <span className="text-[var(--color-ink-soft)]">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function PaymentChoice({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex-1 rounded-2xl border-2 bg-white p-3 text-left ${
        selected ? 'border-[var(--color-accent)]' : 'border-[var(--color-line)]'
      }`}
    >
      <span className="block font-semibold">{label}</span>
      <span className="block text-sm text-[var(--color-ink-faint)]">{hint}</span>
    </button>
  );
}
