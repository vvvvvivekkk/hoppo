'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type OrderDetail } from '@hoppo/api-client';
import { formatMinor } from '@hoppo/shared';
import { Shell } from '@/components/shell';
import { Banner, Button, Card, Spinner, Status } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { usePolling } from '@/lib/poll';
import { useSocket } from '@/lib/socket';

/** The stages a student sees, in order. */
const STAGES = [
  { key: 'PLACED', label: 'Order placed' },
  { key: 'SHOP_ACCEPTED', label: 'Shop accepted it' },
  { key: 'PREPARING', label: 'Being prepared' },
  { key: 'READY', label: 'Ready, rider collecting' },
  { key: 'PICKED_UP', label: 'On the way to you' },
  { key: 'COMPLETED', label: 'Delivered' },
];

/**
 * The stages when the student fetched the order themselves (FR-DLV-07).
 *
 * No rider found, food ready, student walked over. The order ends COMPLETED
 * like any other, and the ordinary list would tick "On the way to you" and
 * "Delivered" for a delivery that never happened — on a screen whose whole
 * job is to say what happened.
 */
const COLLECTED_STAGES = [
  { key: 'PLACED', label: 'Order placed' },
  { key: 'SHOP_ACCEPTED', label: 'Shop accepted it' },
  { key: 'PREPARING', label: 'Being prepared' },
  { key: 'READY', label: 'Ready at the shop' },
  { key: 'COMPLETED', label: 'Collected by you' },
];

const STAGE_INDEX: Record<string, number> = {
  PLACED: 0,
  SHOP_ACCEPTED: 1,
  PREPARING: 2,
  READY: 3,
  PICKED_UP: 4,
  DELIVERED: 5,
  COMPLETED: 5,
};

/**
 * The refusals that mean "the order moved while you were looking at it": the
 * shop started preparing as the student tapped cancel, a rider took it as they
 * chose to collect it themselves. The API's message says what happened; the
 * screen then has to catch up, or the same dead button is still there to tap.
 */
function isStaleOrder(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'ORDER_STATE_CHANGED' || error.code === 'ORDER_NOT_READY')
  );
}

/**
 * S-18 and S-19: tracking one order.
 *
 * Socket plus poll, for the reason set out in poll.ts — the socket makes it
 * feel live, the poll makes it correct when the socket has quietly died on a
 * walk between buildings.
 *
 * The handover code (FR-DLV-12) is the part worth reading carefully. It is
 * never stored in plaintext anywhere, which means:
 *
 *  - It arrives **once**, over the socket, addressed to this student only.
 *  - A page reload loses it. There is nothing to re-fetch, because the server
 *    kept only an Argon2 hash.
 *  - So when the server says a code is live but this page does not have it,
 *    the only way back is to have a new one issued, which invalidates the
 *    old one. That is why the button says "Show me a new code" and not
 *    "Show the code" — it is a different code, and a student who has already
 *    read the old one aloud needs to know that.
 */
export default function Order() {
  const params = useParams<{ orderId: string }>();
  const orderId = params.orderId;

  const { api, client, signedIn } = useApi();
  const router = useRouter();

  // Nothing is asked for, and no socket is opened, until there is a session
  // to ask with. Signed out, the Shell is already on its way to /welcome, and
  // a socket handshake with no token is just a rejection in the server log.
  const { data, error, loading, refresh } = usePolling<OrderDetail>(
    () => api.orders.detail(orderId),
    12_000,
    [orderId],
    signedIn,
  );

  const [handoverCode, setHandoverCode] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Live updates. `refresh` rather than patching state from the payload: the
  // socket says something changed, the API says what it changed to, and one
  // source of truth for the shape beats two.
  const { connected, settled } = useSocket(client, signedIn, {
    onOrderStatus: (payload) => {
      if (payload.orderId === orderId) void refresh();
    },
    // Task events are broadcast to the whole college. Only this order's task
    // matters here; refetching on all of them meant every open tracking
    // screen hit the API whenever any delivery on campus moved. (The other
    // shape on this event, a rider being taken offline, has no taskId and so
    // falls through the same test.)
    onTaskStatus: (payload) => {
      if (data?.task && 'taskId' in payload && payload.taskId === data.task.id) void refresh();
    },
    onHandoverCode: (payload) => {
      if (data?.task && payload.taskId === data.task.id) {
        setHandoverCode(payload.code);
      }
    },
  });

  const reissueCode = useCallback(async () => {
    if (!data?.task) return;
    setBusy(true);
    setActionError(null);

    try {
      const res = await api.tasks.reissueHandoverCode(data.task.id);
      setHandoverCode(res.code);
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [api, data?.task]);

  async function cancel() {
    setBusy(true);
    setActionError(null);

    try {
      await api.orders.cancel(orderId, 'Changed my mind');
      await refresh();
    } catch (e) {
      setActionError(describeError(e));
      if (isStaleOrder(e)) await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function resolveUnfulfilled(choice: 'KEEP_WAITING' | 'COLLECT_IN_PERSON' | 'CANCEL') {
    setBusy(true);
    setActionError(null);

    try {
      await api.orders.resolveUnfulfilled(orderId, choice);
      await refresh();
    } catch (e) {
      setActionError(describeError(e));
      if (isStaleOrder(e)) await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn || (loading && !data)) {
    return (
      <Shell back="/orders" title="Order">
        <Spinner />
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell back="/orders" title="Order">
        <Banner tone="error">{error ? describeError(error) : 'Could not load this order.'}</Banner>
      </Shell>
    );
  }

  const cancelled = data.status === 'CANCELLED';
  const unfulfilled = data.task?.status === 'UNFULFILLED';
  const escalated = data.task?.status === 'ESCALATED';
  const completed = data.status === 'COMPLETED';
  // Completed without ever being picked up by anyone: the student collected
  // it. `pickedUpAt` is only ever set by a rider's pickup.
  const collectedInPerson = completed && !data.rider && !data.pickedUpAt;

  const stages = collectedInPerson ? COLLECTED_STAGES : STAGES;
  const stage = collectedInPerson ? stages.length - 1 : (STAGE_INDEX[data.status] ?? 0);

  return (
    <Shell back="/orders" title={data.shopListing.shop.name}>
      <div className="flex items-center gap-2">
        <Status status={data.status} />
        <span className="text-sm text-[var(--color-ink-faint)]">{data.reference}</span>
        {/* Not before the first attempt has finished: until then it is
            connecting, not reconnecting. */}
        {settled && !connected && (
          <span className="ml-auto text-xs font-semibold text-[var(--color-waiting)]">
            Reconnecting…
          </span>
        )}
      </div>

      {actionError && (
        <div className="mt-3">
          <Banner tone="error">{actionError}</Banner>
        </div>
      )}

      {cancelled && (
        <div className="mt-3">
          <Banner tone="error">
            Cancelled
            {data.cancelledBy ? ` by the ${data.cancelledBy.toLowerCase()}` : ''}
            {data.cancelledReason ? `: ${data.cancelledReason}` : '.'}
          </Banner>
        </div>
      )}

      {/* FR-DLV-07: nobody took the delivery. The student chooses, rather than
          the order sitting in limbo or being cancelled over their head. */}
      {unfulfilled && (
        <div className="mt-3">
          <Card tone="waiting" className="p-4">
            <p className="font-bold">No rider picked this up</p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              Your food is {data.status === 'READY' ? 'ready at the shop' : 'still being prepared'},
              but nobody is free to bring it. What would you like to do?
            </p>
            <div className="mt-3 space-y-2">
              <Button
                className="w-full"
                loading={busy}
                onClick={() => void resolveUnfulfilled('KEEP_WAITING')}
              >
                Keep looking for a rider
              </Button>
              <Button
                tone="secondary"
                className="w-full"
                loading={busy}
                onClick={() => void resolveUnfulfilled('COLLECT_IN_PERSON')}
              >
                I will collect it myself
              </Button>
              <Button
                tone="danger"
                className="w-full"
                loading={busy}
                onClick={() => void resolveUnfulfilled('CANCEL')}
              >
                Cancel the order
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* FR-DLV-14: too many wrong codes. The code flow is over for this
          delivery — no new code will be issued and none will be accepted — so
          promising that "a code will appear here" would be untrue. */}
      {escalated && !cancelled && !completed && (
        <div className="mt-3">
          <Banner tone="warn">
            The handover code was entered wrongly too many times; an administrator has to resolve
            this delivery. You do not need to do anything with a code now — your college&apos;s
            Hoppo administrator will sort it out with you and the rider.
          </Banner>
        </div>
      )}

      {/* FR-DLV-12: the code the rider needs at the door. */}
      {data.status === 'PICKED_UP' && !escalated && (
        <div className="mt-3">
          <Card tone="ready" className="p-4">
            <p className="font-bold">Your handover code</p>
            {handoverCode ? (
              <>
                <p
                  className="mt-2 font-mono text-4xl font-bold tracking-[0.3em]"
                  aria-label={`Handover code ${handoverCode.split('').join(' ')}`}
                >
                  {handoverCode}
                </p>
                <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
                  Read this to the rider when they hand your order over. Do not send it to anyone
                  before then — it is what proves the delivery reached you.
                </p>
              </>
            ) : (
              <>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  {data.handoverCodeAvailable
                    ? 'A code was sent to this account. If you reloaded the page it is gone from here — we only ever keep a one-way hash of it, never the code itself.'
                    : 'A code will appear here the moment the rider collects your order.'}
                </p>
                {data.handoverCodeAvailable && (
                  <Button className="mt-3 w-full" loading={busy} onClick={() => void reissueCode()}>
                    Show me a new code
                  </Button>
                )}
                {data.handoverCodeAvailable && (
                  <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
                    This replaces the earlier code, so the old one will stop working.
                  </p>
                )}
              </>
            )}
          </Card>
        </div>
      )}

      <section className="mt-5">
        <ol className="relative space-y-0">
          {stages.map((s, index) => {
            // The last stage of a finished order is done, not "in progress".
            const done = index < stage || (index === stage && completed);
            const current = index === stage && !cancelled && !completed;
            return (
              <li key={s.key} className="flex gap-3 pb-5 last:pb-0">
                <div className="flex flex-col items-center">
                  <span
                    aria-hidden
                    className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[10px] font-bold ${
                      done || current
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
                        : 'border-[var(--color-line)] bg-white'
                    } ${current ? 'animate-pulse-soft' : ''}`}
                  >
                    {done ? '✓' : ''}
                  </span>
                  {index < stages.length - 1 && (
                    <span
                      aria-hidden
                      className={`mt-1 w-0.5 flex-1 ${
                        done ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-line)]'
                      }`}
                    />
                  )}
                </div>
                <div className="pb-1">
                  <p
                    className={`font-semibold ${
                      done || current ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-faint)]'
                    }`}
                  >
                    {s.label}
                  </p>
                  <StageTime order={data} stageKey={s.key} />
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {data.rider && (
        <section className="mt-2">
          <Card className="p-4">
            <p className="text-sm text-[var(--color-ink-faint)]">Your rider</p>
            <p className="mt-0.5 font-bold">{data.rider.name}</p>
            <p className="text-sm text-[var(--color-ink-soft)]">
              {data.rider.averageRating !== null
                ? `★ ${data.rider.averageRating.toFixed(1)} · `
                : ''}
              {data.rider.completedTasks} deliveries
            </p>
            {/* FR-PRIV-03: no mobile number, in either direction. Chat is the
                channel, and it is not built yet — say so rather than show a
                dead button. */}
            <p className="mt-2 text-sm text-[var(--color-ink-faint)]">
              Numbers stay private. In-app chat is coming in a later phase.
            </p>
          </Card>
        </section>
      )}

      <section className="mt-5">
        <h2 className="mb-2 font-bold">What you ordered</h2>
        <Card className="divide-y divide-[var(--color-line)]">
          {data.items.map((item, index) => (
            <div key={index} className="flex items-baseline gap-3 p-3">
              <span className="font-semibold">{item.quantity}×</span>
              <span className="min-w-0 flex-1">
                <span className="block">{item.nameSnapshot}</span>
                {item.note && (
                  <span className="block text-sm text-[var(--color-ink-faint)]">{item.note}</span>
                )}
              </span>
              <span className="font-semibold">{formatMinor(item.lineTotalMinor)}</span>
            </div>
          ))}
          <div className="space-y-1 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-[var(--color-ink-soft)]">Items</span>
              <span>{formatMinor(data.itemsSubtotalMinor)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--color-ink-soft)]">Delivery</span>
              <span>{formatMinor(data.deliveryFeeMinor)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--color-ink-soft)]">Platform fee</span>
              <span>{formatMinor(data.platformFeeMinor)}</span>
            </div>
            <div className="flex justify-between border-t border-[var(--color-line)] pt-2 text-base font-bold">
              <span>Total</span>
              <span>{data.totalLabel}</span>
            </div>
            <p className="pt-1 text-[var(--color-ink-faint)]">
              {data.paymentMethod === 'CASH'
                ? 'Pay the rider in cash on delivery.'
                : `Paid from your ${data.paymentMethod.toLowerCase()}.`}
            </p>
          </div>
        </Card>
      </section>

      {data.dropLandmark && (
        <p className="mt-4 text-sm text-[var(--color-ink-soft)]">
          Dropping at <strong>{data.dropLandmark}</strong>.
        </p>
      )}

      {data.canCancel && (
        <div className="mt-6 pb-safe">
          <Button tone="danger" className="w-full" loading={busy} onClick={() => void cancel()}>
            Cancel this order
          </Button>
          <p className="mt-2 text-center text-sm text-[var(--color-ink-faint)]">
            You can cancel free until the shop starts preparing it.
          </p>
        </div>
      )}

      {!data.canCancel && !cancelled && data.status !== 'COMPLETED' && (
        <p className="mt-6 text-center text-sm text-[var(--color-ink-faint)]">
          Too late to cancel — the shop has started on it.
        </p>
      )}

      {data.status === 'COMPLETED' && (
        <div className="mt-6 pb-safe">
          <Button tone="secondary" className="w-full" onClick={() => router.push('/shops')}>
            Order again
          </Button>
        </div>
      )}
    </Shell>
  );
}

function StageTime({ order, stageKey }: { order: OrderDetail; stageKey: string }) {
  const at =
    stageKey === 'PLACED'
      ? order.placedAt
      : stageKey === 'SHOP_ACCEPTED'
        ? order.shopAcceptedAt
        : stageKey === 'READY'
          ? order.readyAt
          : stageKey === 'PICKED_UP'
            ? order.pickedUpAt
            : stageKey === 'COMPLETED'
              ? (order.completedAt ?? order.deliveredAt)
              : null;

  if (stageKey === 'PREPARING' && order.expectedReadyAt && !order.readyAt) {
    return (
      <p className="text-sm text-[var(--color-ink-faint)]">
        Ready around{' '}
        {new Date(order.expectedReadyAt).toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </p>
    );
  }

  if (!at) return null;

  return (
    <p className="text-sm text-[var(--color-ink-faint)]">
      {new Date(at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
    </p>
  );
}
