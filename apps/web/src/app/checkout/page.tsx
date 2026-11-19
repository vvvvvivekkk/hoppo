'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type DeliveryPoint, type OrderQuote } from '@hoppo/api-client';
import { formatMinor } from '@hoppo/shared';
import { Shell } from '@/components/shell';
import { Banner, Button, Card, Spinner, Stepper, TextArea } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { VerifyPrompt, useCanOrder } from '@/components/verify-prompt';

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
  const { api, signedIn } = useApi();
  const router = useRouter();
  const cart = useCart();
  const { canOrder, loading: accountLoading } = useCanOrder();

  const [points, setPoints] = useState<DeliveryPoint[] | null>(null);
  const [pointId, setPointId] = useState<string>('');
  const [note, setNote] = useState('');
  const [payment, setPayment] = useState<Payment>('CASH');

  const [quote, setQuote] = useState<OrderQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  /** Set when the server refused because the total moved under us. */
  const [priceMoved, setPriceMoved] = useState<{ from: number; to: number | null } | null>(null);

  useEffect(() => {
    // Signed out, the Shell is already redirecting; asking anyway only
    // produces a 401 to show for it.
    if (!signedIn) return;
    void api.browse
      .deliveryPoints()
      .then(({ points: rows }) => {
        setPoints(rows);
        // Preselect the first, so the common case is one tap: most students
        // use the same hostel gate every time.
        if (rows.length > 0) setPointId((current) => current || rows[0].id);
      })
      .catch((e) => setError(describeError(e)));
  }, [api, signedIn]);

  const lines = cart.cart?.lines ?? [];
  const listingId = cart.cart?.listingId;

  // Each quote request takes a number, and only the newest one may write to
  // the screen. Tapping the stepper three times sends three quotes, and they
  // do not have to come back in the order they left: without this an older,
  // slower answer could land last and leave a total on screen for a cart the
  // student no longer has — which is the total `place()` would then send.
  const quoteSeq = useRef(0);

  const requote = useCallback(async () => {
    if (!listingId || lines.length === 0 || !pointId || !canOrder) return;

    const seq = ++quoteSeq.current;
    setQuoting(true);
    setError(null);

    try {
      const next = await api.orders.quote({
        listingId,
        lines: lines.map((l) => ({
          catalogItemId: l.catalogItemId,
          quantity: l.quantity,
          note: l.note,
        })),
        deliveryPointId: pointId,
      });
      if (seq !== quoteSeq.current) return;
      setQuote(next);
    } catch (e) {
      if (seq !== quoteSeq.current) return;
      setError(describeError(e));
      setQuote(null);
    } finally {
      if (seq === quoteSeq.current) setQuoting(false);
    }
    // The cart lines are compared by value rather than by reference, so a
    // quantity change re-quotes but a re-render does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, listingId, pointId, canOrder, JSON.stringify(lines)]);

  // The student changed the cart or the drop point, so whatever the last
  // refusal said about the total no longer describes this order. Cleared
  // here, on their action — not inside `requote`, which `place()` also calls
  // straight after setting the banner. That wiped it before it ever painted,
  // so a price change looked like a button that did nothing.
  useEffect(() => {
    setPriceMoved(null);
    void requote();
  }, [requote]);

  async function place() {
    if (!quote || !listingId) return;

    setPlacing(true);
    setError(null);

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

      setPriceMoved(null);
      cart.clear();
      router.replace(`/orders/${res.orderId}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PRICE_CHANGED') {
        const details = e.details as
          { shownTotalMinor?: number; currentTotalMinor?: number } | undefined;
        // The server's two numbers when it sends them; otherwise the total
        // that was on screen, with the new one read off the fresh quote.
        setPriceMoved({
          from: details?.shownTotalMinor ?? quote.totals.totalMinor,
          to: details?.currentTotalMinor ?? null,
        });
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

  // Not "empty" until the saved cart has actually been read — and not the
  // verify prompt until the account has. Both used to flash on every load.
  if (!cart.hydrated || accountLoading) {
    return (
      <Shell back="/shops" title="Checkout">
        <Spinner />
      </Shell>
    );
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

  // The hard stop. Browsing and building a cart are open; this is the line.
  // Placed before the quote so an unverified student is not shown a total they
  // cannot act on, and the cart is deliberately left intact — it is waiting
  // for them when verification comes back.
  if (!canOrder) {
    return (
      <Shell back={`/shops/${listingId}`} title="Checkout">
        <VerifyPrompt />
        <p className="text-sm text-[var(--color-ink-soft)]">
          Your cart is saved. Come back to it once your ID is approved.
        </p>
      </Shell>
    );
  }

  const movedTo = priceMoved ? (priceMoved.to ?? quote?.totals.totalMinor ?? null) : null;

  return (
    <Shell back={`/shops/${listingId}`} title="Checkout">
      <p className="text-sm text-[var(--color-ink-faint)]">From</p>
      <p className="text-lg font-bold">{cart.cart.shopName}</p>

      <section className="mt-5">
        <h2 className="mb-2 font-bold">Your order</h2>
        <Card className="divide-y divide-[var(--color-line)]">
          {lines.map((line) => {
            // The quote is the authority on price; the cart's copy is only
            // what the item cost when it was added. Show the quoted price
            // once there is one, and say so when the two differ — otherwise
            // the lines add up to one number and the total says another.
            const quoted = quote?.lines.find((l) => l.catalogItemId === line.catalogItemId);
            const unitPriceMinor = quoted?.unitPriceMinor ?? line.unitPriceMinor;
            const changed = quoted !== undefined && quoted.unitPriceMinor !== line.unitPriceMinor;

            return (
              <div key={line.catalogItemId} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{line.name}</p>
                  <p className="text-sm text-[var(--color-ink-faint)]">
                    {formatMinor(unitPriceMinor)} each
                  </p>
                  {changed && (
                    <p className="text-sm font-semibold text-[var(--color-waiting)]">
                      Price changed — it was {formatMinor(line.unitPriceMinor)} when you added it.
                    </p>
                  )}
                </div>
                <Stepper
                  quantity={line.quantity}
                  onChange={(next) => cart.setQuantity(line.catalogItemId, next)}
                  label={line.name}
                />
              </div>
            );
          })}
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
              The total changed from {formatMinor(priceMoved.from)}
              {movedTo !== null && ` to ${formatMinor(movedTo)}`} while you were ordering, so
              nothing was placed. The figures below are current — confirm again if you are happy
              with them.
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
