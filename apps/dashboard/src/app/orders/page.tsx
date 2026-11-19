'use client';

import { formatMinor } from '@hoppo/shared';
import { ApiError, type MyShop, type ShopQueueOrder } from '@hoppo/api-client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Banner, Button, Card, EmptyState, Status } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { isAwaitingApproval, RegistrationStatus } from '@/lib/approval';
import { OrderAlert, type AlertState } from '@/lib/alert';
import { usePolling } from '@/lib/poll';

/**
 * D-08 / D-09: the live order queue.
 *
 * This is the screen the dashboard exists for, and the SRS is specific about
 * it: arrival order, an audible and visual alert, accept and reject with
 * large targets, and a preparation-time stepper (FR-SHP-01, FR-SHP-02, UI-4).
 * NFR-U-02 asks that accepting take no more than two taps from the alert, so
 * accepting with the default prep time is a single tap on the card itself.
 */
export default function OrdersPage() {
  const { api } = useApi();
  const [listingId, setListingId] = useState<string | null>(null);
  const [shops, setShops] = useState<MyShop[] | null>(null);
  const [shopError, setShopError] = useState<{ message: string; awaiting: boolean } | null>(null);
  const [retrying, setRetrying] = useState(false);

  const loadShops = useCallback(async () => {
    try {
      const { shops: mine } = await api.shops.mine();
      const listings = mine.flatMap((s) => s.listings);
      setShops(mine);
      // Keep the listing already on screen if it still exists; a re-read must
      // not swap the queue to a different college's listing under the owner.
      setListingId(
        (prev) =>
          listings.find((l) => l.id === prev)?.id ??
          (listings.find((l) => l.status === 'ACTIVE') ?? listings[0])?.id ??
          null,
      );
      setShopError(null);
    } catch (e) {
      setShopError({ message: describeError(e), awaiting: isAwaitingApproval(e) });
    }
  }, [api]);

  useEffect(() => {
    void loadShops();
  }, [loadShops]);

  const listing = shops?.flatMap((s) => s.listings).find((l) => l.id === listingId) ?? null;
  const waitingOnAdmin =
    shopError?.awaiting === true || (listing !== null && listing.status !== 'ACTIVE');

  // An owner waiting for approval leaves this page open. Re-read the
  // registration every so often so that approval shows up without a reload.
  useEffect(() => {
    if (!waitingOnAdmin) return;
    const timer = setInterval(() => void loadShops(), 15_000);
    return () => clearInterval(timer);
  }, [waitingOnAdmin, loadShops]);

  // The registration could not be read at all. With a previous answer on
  // screen there is nothing to say; without one, say what happened and offer
  // the retry, rather than leaving a dead page until someone reloads.
  if (!shops && shopError) {
    if (shopError.awaiting) {
      return (
        <EmptyState
          title="Waiting for approval"
          body="Your shop is waiting for a campus administrator to review it. Nothing is visible to students until it is approved."
        />
      );
    }

    return (
      <div className="space-y-4">
        <Banner tone="error">{shopError.message}</Banner>
        <Button
          tone="secondary"
          loading={retrying}
          onClick={() =>
            void (async () => {
              setRetrying(true);
              await loadShops();
              setRetrying(false);
            })()
          }
        >
          Try again
        </Button>
      </div>
    );
  }

  if (!shops) return <p className="text-[var(--color-ink-faint)]">Loading your shop…</p>;

  if (!listing) {
    return (
      <EmptyState
        title="No shop attached to this account"
        body="If you have just registered, your shop is waiting for a campus administrator to approve it."
      />
    );
  }

  const shopName = shops.find((s) => s.listings.some((l) => l.id === listing.id))?.name;

  // FR-SHOP-09: a shop that is not approved cannot receive orders, so showing
  // an empty queue would be misleading. Say why instead.
  if (listing.status !== 'ACTIVE') {
    return <RegistrationStatus shopName={shopName} listing={listing} />;
  }

  return (
    <Queue
      listingId={listing.id}
      // The queue itself can be refused as "not approved" while /shops/mine
      // still reads ACTIVE. Re-read the registration when that happens, and
      // show its status in place of the queue.
      onRefused={() => void loadShops()}
      refusedPanel={<RegistrationStatus shopName={shopName} listing={listing} refused />}
    />
  );
}

/**
 * Refusals that mean "the order moved on while you were looking at it".
 *
 * Each is a normal outcome of two people acting on one order — the student
 * cancels as the shop taps Accept — and not a fault to apologise for. The
 * API's own wording tells the caller to refresh; the dashboard has already
 * done that by the time these are shown, so they say what happened instead.
 */
const ORDER_MOVED_ON: Record<string, string> = {
  ORDER_STATE_CHANGED:
    'That order changed while you were answering it — the student may have cancelled. The queue below is up to date.',
  ORDER_NOT_READY:
    'That order is not at that stage yet. The queue below is up to date.',
  NOT_AWAITING_ACCEPTANCE:
    'That order had already been answered. The queue below is up to date.',
  ACCEPT_WINDOW_EXPIRED:
    'The time to answer that order ran out, so it was cancelled. The queue below is up to date.',
};

const ORDER_GONE =
  'That order is no longer in your queue — it was cancelled or completed while you were answering. The queue below is up to date.';

function Queue({
  listingId,
  onRefused,
  refusedPanel,
}: {
  listingId: string;
  onRefused: () => void;
  refusedPanel: ReactNode;
}) {
  const { api } = useApi();

  // FR-SHP-01: the queue must stay current without anyone refreshing. Three
  // seconds is frequent enough that an order feels live and light enough that
  // a tablet on 4G is not hammering the API.
  const { data, error, loading, refresh } = usePolling(
    () => api.shops.queue(listingId),
    3000,
    [listingId],
  );

  const alertRef = useRef<OrderAlert | null>(null);
  const [alertState, setAlertState] = useState<AlertState>('blocked');
  const [notice, setNotice] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);

  /**
   * Orders with a request in the air.
   *
   * The ref is the guard and the state is the picture. State alone is not
   * enough: two taps handled before React re-renders both see "not busy" and
   * both send. And a single id is not enough either: answering a second order
   * while the first is still in flight would overwrite it and re-enable the
   * first order's buttons mid-request.
   */
  const pending = useRef(new Set<string>());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  if (!alertRef.current) alertRef.current = new OrderAlert();

  useEffect(() => {
    const alert = alertRef.current!;
    return () => alert.dispose();
  }, []);

  // The API refused the queue because the shop is not approved. That is a
  // state to show, not a connection problem to retry around.
  const refused = isAwaitingApproval(error);

  useEffect(() => {
    if (refused) onRefused();
    // Only on the transition into the refused state, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refused]);

  const waiting = useMemo(
    () => (refused ? [] : (data?.items ?? []).filter((o) => o.status === 'PLACED')),
    [data, refused],
  );

  /**
   * FR-SHP-01: the audible alert. Repeating while anything is unanswered,
   * because a single chime at the moment nobody was looking is the same as
   * no chime — and FR-SHP-02 cancels the order if the window runs out.
   */
  useEffect(() => {
    const alert = alertRef.current!;
    if (waiting.length > 0) alert.startRepeating();
    else alert.stopRepeating();
  }, [waiting.length]);

  const waitingCount = useRef(0);
  waitingCount.current = waiting.length;

  const arm = useCallback(async () => {
    const alert = alertRef.current!;
    const next = await alert.arm();
    setAlertState(next);
    // Turning the sound on with an order already waiting should be heard now,
    // not up to eight seconds later when the repeat next comes round.
    if (next === 'ready' && waitingCount.current > 0) alert.chime();
  }, []);

  async function act(
    order: ShopQueueOrder,
    action: () => Promise<{ message?: string }>,
  ) {
    if (pending.current.has(order.id)) return;
    pending.current.add(order.id);
    setBusyIds(new Set(pending.current));
    setNotice(null);

    try {
      await action();
      await refresh();
    } catch (e) {
      // Whatever went wrong, look again before saying anything: most refusals
      // here mean the order moved on, and the queue should show where it is
      // now rather than leave a card with buttons that can only fail.
      const fresh = await refresh();
      const now = fresh?.items.find((o) => o.id === order.id);
      const code = e instanceof ApiError ? e.code : null;

      if (code && ORDER_MOVED_ON[code]) {
        setNotice({ tone: 'warn', text: ORDER_MOVED_ON[code] });
      } else if (fresh && !now) {
        setNotice({ tone: 'warn', text: ORDER_GONE });
      } else if (fresh && now && now.status !== order.status) {
        setNotice({ tone: 'warn', text: ORDER_MOVED_ON.ORDER_STATE_CHANGED });
      } else if (!isAwaitingApproval(e)) {
        setNotice({ tone: 'error', text: describeError(e) });
      }
    } finally {
      pending.current.delete(order.id);
      setBusyIds(new Set(pending.current));
    }
  }

  if (refused) return <>{refusedPanel}</>;

  const active = (data?.items ?? []).filter((o) => o.status !== 'PLACED');

  // "Could not reach the server" is only true of a failure to reach it. A
  // refusal the server did send (rate limiting, a permission problem) is
  // shown in its own words.
  const unreachable = !(error instanceof ApiError) || error.isRetryable;

  return (
    <div className="space-y-5">
      {/*
        Browsers refuse audio until the page has been interacted with, so a
        tablet reloaded overnight is silent with no indication. This banner is
        the only honest way to surface that: it says the alarm is off and
        offers the gesture that turns it on.
      */}
      {alertState !== 'ready' && (
        <div className="flex flex-wrap items-center gap-4 rounded-xl border-l-4 border-[var(--color-waiting)] bg-[var(--color-waiting-bg)] px-4 py-3">
          <p className="font-semibold text-[var(--color-waiting)]">
            {alertState === 'unsupported'
              ? 'This browser cannot play the order alert. Watch the screen for new orders.'
              : 'Sound is off. New orders will not chime until you turn it on.'}
          </p>
          {alertState !== 'unsupported' && (
            <Button tone="secondary" onClick={() => void arm()} className="ml-auto">
              Turn on sound
            </Button>
          )}
        </div>
      )}

      {error && (
        <Banner tone="warn">
          {unreachable
            ? data
              ? 'Could not reach the server just now — showing the last known queue. Retrying automatically.'
              : 'Could not reach the server just now. Retrying automatically.'
            : describeError(error)}
        </Banner>
      )}

      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}

      <section aria-labelledby="waiting-heading">
        <h2 id="waiting-heading" className="mb-3 flex items-center gap-3 text-2xl font-bold">
          New orders
          {waiting.length > 0 && (
            <span className="animate-pulse-soft rounded-full bg-[var(--color-waiting)] px-3 py-1 text-base font-bold text-white">
              {waiting.length}
            </span>
          )}
        </h2>

        {waiting.length === 0 ? (
          <EmptyState
            title={
              loading
                ? 'Checking for orders…'
                : data
                  ? 'No new orders'
                  : 'The queue could not be loaded yet'
            }
            body="New orders appear here the moment a student places them, with a chime."
          />
        ) : (
          <div className="space-y-4">
            {waiting.map((order) => (
              <WaitingCard
                key={order.id}
                order={order}
                busy={busyIds.has(order.id)}
                onAccept={(prepMinutes) =>
                  void act(order, () => api.shops.acceptOrder(listingId, order.id, prepMinutes))
                }
                onReject={(reason) =>
                  void act(order, () => api.shops.rejectOrder(listingId, order.id, reason))
                }
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="active-heading">
        <h2 id="active-heading" className="mb-3 text-2xl font-bold">
          In progress
        </h2>

        {active.length === 0 ? (
          <p className="text-[var(--color-ink-faint)]">Nothing being prepared right now.</p>
        ) : (
          <div className="space-y-4">
            {active.map((order) => (
              <ActiveCard
                key={order.id}
                order={order}
                busy={busyIds.has(order.id)}
                onReady={() => void act(order, () => api.shops.markReady(listingId, order.id))}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** A new order: the accept/reject decision, with the FR-SHP-02 countdown. */
function WaitingCard({
  order,
  busy,
  onAccept,
  onReject,
}: {
  order: ShopQueueOrder;
  busy: boolean;
  onAccept: (prepMinutes?: number) => void;
  onReject: (reason: string) => void;
}) {
  const [prepMinutes, setPrepMinutes] = useState(order.statedPrepMinutes ?? 15);
  const [rejecting, setRejecting] = useState(false);

  /**
   * The countdown ticks locally from the server's number rather than being
   * re-fetched every second. The poll corrects it every three seconds, so it
   * stays honest without one request per tick.
   */
  const [secondsLeft, setSecondsLeft] = useState(order.acceptSecondsRemaining ?? 0);

  useEffect(() => {
    setSecondsLeft(order.acceptSecondsRemaining ?? 0);
  }, [order.acceptSecondsRemaining]);

  useEffect(() => {
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const urgent = secondsLeft <= 60;
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;

  return (
    <Card tone="waiting" className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-4 p-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-2xl font-black tracking-tight">{order.reference}</p>
            <Status status={order.status} />
            <span
              className={`rounded-full px-3 py-1 text-sm font-bold ${
                urgent
                  ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
                  : 'bg-[var(--color-surface-sunken)] text-[var(--color-ink-soft)]'
              }`}
              // A countdown that changes every second would be read aloud
              // continuously by a screen reader, which is unusable.
              aria-live="off"
            >
              {secondsLeft > 0
                ? `${minutes}:${String(seconds).padStart(2, '0')} to answer`
                : 'Time is up'}
            </span>
          </div>

          <p className="mt-1 text-[var(--color-ink-faint)]">
            {order.student.name} · {order.dropLandmark ?? 'campus delivery point'} ·{' '}
            {order.paymentMethod === 'CASH'
              ? 'Cash on delivery'
              : order.paymentMethod === 'WALLET'
                ? 'Paid from Hoppo wallet'
                : 'Paid online'}
          </p>

          <ul className="mt-4 space-y-1">
            {order.items.map((item, i) => (
              <li key={i} className="flex gap-3 text-lg">
                <span className="w-10 shrink-0 font-bold">{item.quantity}×</span>
                <span className="flex-1">
                  {item.nameSnapshot}
                  {item.note && (
                    <span className="block text-base text-[var(--color-waiting)]">
                      Note: {item.note}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-semibold">
                  {formatMinor(item.unitPriceMinor * item.quantity)}
                </span>
              </li>
            ))}
          </ul>

          {order.studentNote && (
            <p className="mt-3 rounded-xl bg-[var(--color-waiting-bg)] px-4 py-2 font-medium text-[var(--color-waiting)]">
              {order.studentNote}
            </p>
          )}

          <p className="mt-4 text-xl font-bold">
            You receive {order.itemsSubtotalLabel}
            <span className="ml-2 text-base font-normal text-[var(--color-ink-faint)]">
              (student pays {formatMinor(order.totalMinor)} including delivery)
            </span>
          </p>
        </div>

        <div className="flex w-full shrink-0 flex-col gap-3 sm:w-64">
          {/* FR-SHP-02: the shop may revise the preparation time on acceptance,
              and that number decides when the rider is called (FR-DLV-01). */}
          <div>
            <p className="mb-1 font-semibold">Ready in</p>
            <div className="flex items-stretch gap-2">
              <button
                onClick={() => setPrepMinutes((m) => Math.max(1, m - 5))}
                aria-label="Five minutes less"
                className="tap w-14 rounded-xl border-2 border-[var(--color-line)] bg-white text-2xl font-bold"
              >
                −
              </button>
              <span className="tap flex flex-1 items-center justify-center rounded-xl bg-[var(--color-surface-sunken)] text-xl font-bold">
                {prepMinutes} min
              </span>
              <button
                onClick={() => setPrepMinutes((m) => Math.min(240, m + 5))}
                aria-label="Five minutes more"
                className="tap w-14 rounded-xl border-2 border-[var(--color-line)] bg-white text-2xl font-bold"
              >
                +
              </button>
            </div>
          </div>

          {/* NFR-U-02: accepting is one tap from here. */}
          <Button large loading={busy} onClick={() => onAccept(prepMinutes)}>
            Accept
          </Button>

          {!rejecting ? (
            <Button tone="danger" onClick={() => setRejecting(true)} disabled={busy}>
              Reject
            </Button>
          ) : (
            <div className="space-y-2 rounded-xl border-2 border-[var(--color-danger)] p-3">
              <p className="font-semibold text-[var(--color-danger)]">Why?</p>
              {['Out of stock', 'Too busy right now', 'Closing soon'].map((reason) => (
                <Button
                  key={reason}
                  tone="secondary"
                  className="w-full"
                  disabled={busy}
                  onClick={() => onReject(reason)}
                >
                  {reason}
                </Button>
              ))}
              <Button
                tone="quiet"
                className="w-full"
                disabled={busy}
                onClick={() => setRejecting(false)}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** An accepted order moving through preparation, pickup and delivery. */
function ActiveCard({
  order,
  busy,
  onReady,
}: {
  order: ShopQueueOrder;
  busy: boolean;
  onReady: () => void;
}) {
  const tone = order.status === 'READY' || order.status === 'PICKED_UP' ? 'ready' : 'preparing';

  return (
    <Card tone={tone}>
      <div className="flex flex-wrap items-center gap-4 p-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xl font-black tracking-tight">{order.reference}</p>
            <Status status={order.status} />
            {order.expectedReadyAt && order.status === 'PREPARING' && (
              <span className="text-[var(--color-ink-faint)]">
                due {new Date(order.expectedReadyAt).toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
          </div>

          <p className="mt-1 text-[var(--color-ink-faint)]">
            {order.items.map((i) => `${i.quantity}× ${i.nameSnapshot}`).join(', ')}
          </p>

          {/* FR-DLV-02 onwards: who is coming, once a rider has accepted. */}
          <p className="mt-2 font-medium">
            {order.task?.rider
              ? `${order.task.rider.name} is collecting this`
              : order.task?.status === 'BROADCASTING'
                ? 'Looking for a rider…'
                : order.task?.status === 'UNFULFILLED'
                  ? 'No rider found — the student is deciding what to do'
                  : 'A rider will be called shortly'}
          </p>
        </div>

        <div className="w-full shrink-0 sm:w-64">
          {order.status === 'PREPARING' && (
            <Button large loading={busy} onClick={onReady} className="w-full">
              Mark ready
            </Button>
          )}

          {/*
            ADR-003: marking ready is a permission grant, not a state write on
            the task. The shop unlocks the rider's pickup button; only the
            rider's tap records the handover. Saying so here stops an owner
            waiting for something to happen on their own screen.
          */}
          {order.status === 'READY' && (
            <p className="rounded-xl bg-[var(--color-ready-bg)] px-4 py-3 text-center font-semibold text-[var(--color-ready)]">
              {order.awaitingRiderPickup
                ? 'Hand it to the rider — they confirm on their phone'
                : 'Packed and waiting for a rider'}
            </p>
          )}

          {order.status === 'PICKED_UP' && (
            <p className="rounded-xl bg-[var(--color-ready-bg)] px-4 py-3 text-center font-semibold text-[var(--color-ready)]">
              On the way to the student
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
