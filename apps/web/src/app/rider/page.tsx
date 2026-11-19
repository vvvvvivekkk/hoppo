'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type ActiveTask, type RiderStatus, type TaskOffer } from '@hoppo/api-client';
import { RIDER_TERMS_VERSION, formatDistance, formatMinor } from '@hoppo/shared';
import { Shell } from '@/components/shell';
import { Banner, Button, Card, Field, Spinner } from '@/components/ui';
import { CountdownBar, useCountdown } from '@/components/countdown';
import { describeError, useApi } from '@/lib/api';
import { useRiderPosition } from '@/lib/geo';
import { usePolling } from '@/lib/poll';
import { isWorkModeDisabled, sendPing, useSocket } from '@/lib/socket';
import { useCanOrder } from '@/components/verify-prompt';

/**
 * The accept refusals that are not failures (FR-DLV-03/04): the window
 * closed, or the offer was never (or is no longer) this rider's. Each means
 * "this card is stale", so the card goes and the API's sentence is shown as
 * information, the same way losing the race is.
 */
const STALE_OFFER_CODES = new Set([
  'OFFER_EXPIRED',
  'NOT_OFFERED_TO_YOU',
  'NOT_YET_OFFERED',
  // Already carrying one (accepted on another tab or device). The card goes,
  // and the reload that follows puts the task they do hold on screen.
  'ALREADY_HOLDING_TASK',
]);

/** How often to re-read rider status while it can change without an event. */
const STATUS_POLL_MS = 10_000;

/**
 * S-21 to S-27: the rider side.
 *
 * One screen rather than several, because a rider's state is a single thing —
 * offline, online and waiting, holding an offer, or carrying an order — and
 * only one of those is true at a time. Routing between them would mean a
 * redirect every time a socket event arrived, and an offer that lands during
 * a navigation would be lost.
 *
 * The parts that are not obvious:
 *
 *  - **Accepting is a race, and losing is normal** (FR-DLV-04). The offer goes
 *    to several riders at once and the first conditional UPDATE wins. A loser
 *    gets `ALREADY_TAKEN`, which is shown as "someone was faster" rather than
 *    as an error, because nothing went wrong.
 *  - **Pickup is gated on the shop** (ADR-003). `canConfirmPickup` comes from
 *    the server and is false until the shop marks the order ready. A rider
 *    standing at the counter needs to know they are waiting on the shop, not
 *    on a broken button.
 *  - **Position comes from the browser**, with the limits set out in geo.ts.
 *    Work mode cannot be turned on without a fix, because dispatch ranks by
 *    distance and a rider with no position would never be offered anything —
 *    which looks like the app not working.
 *  - **Verification is checked before anything is fetched.** The API answers
 *    an unverified student's `/rider/status` with a 403, so asking first and
 *    reading `canEnable.verified` afterwards never got as far as the reading.
 *    The outer component decides from the account already in context; the
 *    inner one only mounts for somebody the API will actually talk to.
 */
export default function Rider() {
  const { loading, canOrder, status } = useCanOrder();

  if (loading) {
    return (
      <Shell title="Earn">
        <Spinner label="Checking your rider status" />
      </Shell>
    );
  }

  // FR-WM-01: verification first, and nothing else on the screen until it is
  // done — offering to accept terms for a ride they cannot take is noise.
  if (!canOrder) {
    return (
      <Shell title="Earn">
        <Card className="p-5">
          <p className="text-lg font-bold">
            {status === 'PENDING' ? 'Your ID is being checked' : 'Get verified first'}
          </p>
          <p className="mt-2 text-[var(--color-ink-soft)]">
            Riders carry other students&apos; food and other students&apos; cash, so your student ID
            has to be approved before you can go online.
            {status === 'PENDING' &&
              ' Yours is with an administrator now; this screen opens up as soon as it is approved.'}
            {status === 'REJECTED' && ' Your last submission was not accepted.'}
          </p>
          <Link href="/verify" className="mt-4 block">
            <Button className="w-full">
              {status === 'PENDING'
                ? 'Check the status'
                : status === 'REJECTED'
                  ? 'Try again'
                  : 'Go to verification'}
            </Button>
          </Link>
        </Card>
      </Shell>
    );
  }

  return <RiderHome />;
}

function RiderHome() {
  const { api, client, user, refreshUser } = useApi();

  const [status, setStatus] = useState<RiderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [offer, setOffer] = useState<TaskOffer | null>(null);
  const [lostOffer, setLostOffer] = useState(false);

  const workModeOn = status?.workModeOn ?? false;
  const activeTask = status?.activeTask ?? null;

  const position = useRiderPosition(workModeOn);
  /** The rider tapped "Go online" and we are waiting on a location fix. */
  const [pendingOnline, setPendingOnline] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.rider.status());
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.needsVerification) {
        // The account in context said verified and the server disagrees
        // (verification was withdrawn since). Re-read it; the outer component
        // then shows the verify card instead of this error.
        void refreshUser();
      }
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [api, refreshUser]);

  useEffect(() => {
    void load();
  }, [load]);

  // The poll underneath the socket. Two things on this screen change with no
  // event addressed to the rider: the shop marking an order ready (which is
  // what enables "I have collected it") and the server's idle sweep. Without
  // this a rider at the counter stared at "Waiting for the shop" until they
  // reloaded. Quiet on failure — a missed poll must not put an error banner
  // over a delivery, or wipe the message from an action the rider just took.
  const pollStatus = useCallback(async () => {
    try {
      setStatus(await api.rider.status());
    } catch {
      /* the next tick, or the next action, will say so if it matters */
    }
  }, [api]);
  usePolling(pollStatus, STATUS_POLL_MS, [], workModeOn || activeTask !== null);

  const { connected, settled, socket } = useSocket(client, workModeOn || activeTask !== null, {
    onOffer: (incoming) => {
      // Ignore a new offer while already holding one: a rider can only take
      // one task, and swapping the card under their thumb mid-decision is how
      // you get an accidental accept.
      setOffer((current) => current ?? incoming);
      setLostOffer(false);
    },
    onOfferWithdrawn: (payload) => {
      setOffer((current) => {
        if (current?.taskId !== payload.taskId) return current;
        // Only call it a loss if this rider did not win it. The server says
        // so directly; the id comparison is for an API build without `won`.
        setLostOffer(!(payload.won ?? payload.winnerUserId === user?.id));
        return null;
      });
    },
    onTaskStatus: (payload) => {
      // FR-WM-06: the server took this rider offline for going quiet. Say
      // so — otherwise the screen flips to "offline" and it reads as a bug.
      if (isWorkModeDisabled(payload)) {
        setOffer(null);
        setNotice(
          `You were taken offline after ${payload.afterMinutes} minutes without a location update. ` +
            'Browsers stop reporting when the tab is hidden or the phone is locked. Go online again when you are ready.',
        );
        void load();
        return;
      }
      // This event goes to everyone in the college for every task. Only the
      // one being carried is this screen's business; refetching on all of
      // them meant every online rider hit the API each time anybody's
      // delivery moved.
      if (activeTask && payload.taskId === activeTask.id) void load();
    },
  });

  // FR-WM-03: report position on the interval the server asks for, over the
  // open socket rather than as a request per ping.
  //
  // A real timer reading the latest values through refs. This used to be an
  // effect that pinged whenever its dependencies changed, which meant "when
  // the position changed" — so a rider standing still at a shop counter sent
  // nothing, and the idle sweep took them offline while they waited.
  const positionRef = useRef(position.state);
  positionRef.current = position.state;
  const socketRef = useRef(socket);
  socketRef.current = socket;

  const pingIntervalSeconds = status?.pingIntervalSeconds ?? null;
  const hasFix = position.state.kind === 'granted';

  useEffect(() => {
    if (!workModeOn || !hasFix || pingIntervalSeconds === null) return;

    const ping = () => {
      const fix = positionRef.current;
      if (fix.kind !== 'granted') return;

      // The socket is the normal path; the HTTP endpoint exists for when it
      // is down, which on campus Wi-Fi is often enough to matter.
      if (!sendPing(socketRef.current, fix.latitude, fix.longitude)) {
        void api.rider.ping(fix.latitude, fix.longitude).catch(() => {
          /* a dropped ping is not worth interrupting a delivery over */
        });
      }
    };

    // Once straight away: a page opened with work mode already on should
    // report as soon as it has a fix, not one interval later.
    ping();
    const timer = setInterval(ping, Math.max(5, pingIntervalSeconds) * 1000);
    return () => clearInterval(timer);
  }, [workModeOn, hasFix, pingIntervalSeconds, api]);

  const releasePosition = position.release;

  const goOnline = useCallback(
    async (latitude: number, longitude: number) => {
      setBusy(true);
      setError(null);

      try {
        const res = await api.rider.setWorkMode(true, latitude, longitude);
        setNotice(res.message);
        await load();
      } catch (e) {
        // Not going online after all, so stop holding the GPS open.
        releasePosition();

        if (e instanceof ApiError && e.code === 'RIDER_TERMS_REQUIRED') {
          setNotice(null);
          setStatus((current) =>
            current
              ? { ...current, canEnable: { ...current.canEnable, termsAccepted: false } }
              : current,
          );
        } else {
          setNotice(null);
          setError(describeError(e));
        }
      } finally {
        setBusy(false);
      }
    },
    [api, load, releasePosition],
  );

  // Once work mode is on, it is what keeps the watch alive, and the earlier
  // request has done its job. Dropping it here means that when work mode ends
  // by any route — the button, the idle sweep, another device — the GPS is
  // let go, instead of being held by a request nobody remembers making.
  useEffect(() => {
    if (workModeOn) releasePosition();
  }, [workModeOn, releasePosition]);

  // One tap, not two. "Go online" without a fix asks for one and remembers
  // the intent; this finishes the job when the fix arrives, or gives up and
  // lets the panel explain when it cannot.
  useEffect(() => {
    if (!pendingOnline) return;
    const geo = position.state;

    if (geo.kind === 'granted') {
      setPendingOnline(false);
      void goOnline(geo.latitude, geo.longitude);
    } else if (geo.kind === 'denied' || geo.kind === 'unavailable') {
      setPendingOnline(false);
      setNotice(null);
    }
  }, [pendingOnline, position.state, goOnline]);

  async function toggleWorkMode(enable: boolean) {
    setError(null);
    setNotice(null);

    if (enable) {
      if (position.state.kind === 'granted') {
        await goOnline(position.state.latitude, position.state.longitude);
        return;
      }
      // No fix yet. Ask, and let the effect above go online when it lands.
      position.request();
      setPendingOnline(true);
      setNotice(
        'Getting your location — allow it if your browser asks. You will go online as soon as there is a fix.',
      );
      return;
    }

    setBusy(true);
    setPendingOnline(false);
    try {
      const res = await api.rider.setWorkMode(false);
      setNotice(res.message);
      setOffer(null);
      position.release();
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function acceptTerms() {
    setBusy(true);
    try {
      await api.verification.acceptRiderTerms();
      await load();
      setNotice('Terms accepted. You can go online now.');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function acceptOffer(taskId: string) {
    setBusy(true);
    setError(null);

    try {
      await api.rider.accept(taskId);
      setOffer(null);
      setLostOffer(false);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.isAlreadyTaken) {
        // FR-DLV-04: losing the race is the expected outcome for everyone but
        // one rider. Not an error.
        setOffer(null);
        setLostOffer(true);
      } else if (e instanceof ApiError && STALE_OFFER_CODES.has(e.code)) {
        // The card was out of date — the window closed a moment before the
        // tap, or the offer moved on. Nothing the rider did wrong, so the
        // card goes and the API's own sentence is shown as information.
        setOffer(null);
        setLostOffer(false);
        setNotice(e.message);
        void load();
      } else {
        setError(describeError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Shell title="Earn">
        <Spinner label="Checking your rider status" />
      </Shell>
    );
  }

  if (!status) {
    return (
      <Shell title="Earn">
        <Banner tone="error">{error ?? 'Could not load your rider status.'}</Banner>
        <Button className="mt-4 w-full" onClick={() => void load()}>
          Try again
        </Button>
      </Shell>
    );
  }

  const barred = status.barredUntil !== null && new Date(status.barredUntil).getTime() > Date.now();

  return (
    <Shell
      title="Earn"
      action={
        workModeOn ? (
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              connected
                ? 'bg-[var(--color-ready-bg)] text-[var(--color-ready)]'
                : 'bg-[var(--color-waiting-bg)] text-[var(--color-waiting)]'
            }`}
          >
            {/* "Reconnecting" only once a first attempt has actually failed
                or dropped; before that it is simply connecting. */}
            {connected ? 'Online' : settled ? 'Reconnecting' : 'Connecting'}
          </span>
        ) : null
      }
    >
      {error && (
        <div className="mb-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      {notice && !error && (
        <div className="mb-3">
          <Banner tone="info">{notice}</Banner>
        </div>
      )}

      {/* FR-TRST-05 */}
      {barred && (
        <div className="mb-3">
          <Banner tone="error">
            You cannot take tasks until{' '}
            {new Date(status.barredUntil!).toLocaleString('en-IN', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
            , after abandoning several deliveries in a short time.
          </Banner>
        </div>
      )}

      {/* A live task comes before everything, the terms gate included. A new
          terms version published while a rider is mid-delivery must not swap
          the order in their bag for a wall of text — somebody is waiting for
          it. The terms are asked for again once the delivery is done. */}
      {activeTask ? (
        <ActiveTaskPanel task={activeTask} onChanged={() => void load()} />
      ) : !status.canEnable.termsAccepted || !status.canEnable.termsVersionCurrent ? (
        // FR-WM-02
        <RiderTerms
          renewal={status.canEnable.termsAccepted && !status.canEnable.termsVersionCurrent}
          busy={busy}
          onAccept={() => void acceptTerms()}
        />
      ) : offer ? (
        <OfferCard
          offer={offer}
          busy={busy}
          onAccept={() => void acceptOffer(offer.taskId)}
          onDecline={() => setOffer(null)}
          onExpire={() => setOffer(null)}
        />
      ) : (
        <WorkModePanel
          status={status}
          position={position}
          barred={barred}
          busy={busy || pendingOnline}
          lostOffer={lostOffer}
          onToggle={(enable) => void toggleWorkMode(enable)}
        />
      )}

      <section className="mt-6">
        <h2 className="mb-2 font-bold text-[var(--color-ink-soft)]">Your earnings</h2>
        <div className="grid grid-cols-2 gap-3">
          <Card className="p-4">
            <p className="text-sm text-[var(--color-ink-faint)]">Today</p>
            <p className="mt-1 text-2xl font-bold">{status.today.earningsLabel}</p>
            <p className="text-sm text-[var(--color-ink-soft)]">
              {status.today.completedTasks}{' '}
              {status.today.completedTasks === 1 ? 'delivery' : 'deliveries'}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-[var(--color-ink-faint)]">All time</p>
            <p className="mt-1 text-2xl font-bold">{status.lifetime.earningsLabel}</p>
            <p className="text-sm text-[var(--color-ink-soft)]">
              {status.lifetime.completedTasks}{' '}
              {status.lifetime.completedTasks === 1 ? 'delivery' : 'deliveries'}
            </p>
          </Card>
        </div>

        {(status.lifetime.averageRating !== null || status.lifetime.acceptanceRate !== null) && (
          <Card className="mt-3 p-4">
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {status.lifetime.averageRating !== null && (
                <span>
                  <span className="text-[var(--color-ink-faint)]">Rating</span>{' '}
                  <strong>★ {status.lifetime.averageRating.toFixed(1)}</strong>
                </span>
              )}
              {status.lifetime.acceptanceRate !== null && (
                <span>
                  <span className="text-[var(--color-ink-faint)]">Accepted</span>{' '}
                  {/* Already a percentage (0–100) from the API, not a fraction. */}
                  <strong>{Math.round(status.lifetime.acceptanceRate)}%</strong>
                </span>
              )}
              {status.lifetime.abandonedTasks > 0 && (
                <span>
                  <span className="text-[var(--color-ink-faint)]">Abandoned</span>{' '}
                  <strong>{status.lifetime.abandonedTasks}</strong>
                </span>
              )}
            </div>
          </Card>
        )}

        <p className="mt-3 text-sm text-[var(--color-ink-faint)]">
          Fees for wallet-paid orders land in your Hoppo wallet. On a cash order you keep your fee
          out of the cash you collect at the door, so nothing is added to the wallet for it.
          Withdrawals arrive in a later phase.
        </p>
      </section>
    </Shell>
  );
}

function RiderTerms({
  renewal,
  busy,
  onAccept,
}: {
  renewal: boolean;
  busy: boolean;
  onAccept: () => void;
}) {
  return (
    <Card className="p-5">
      <p className="text-lg font-bold">
        {renewal ? 'The rider terms have changed' : 'Before you start riding'}
      </p>
      <p className="mt-2 text-[var(--color-ink-soft)]">
        {renewal
          ? 'Have a look and accept the current version to go back online.'
          : 'Short version, and all of it matters:'}
      </p>
      <ul className="mt-3 space-y-2 text-[var(--color-ink-soft)]">
        <li>
          You are not an employee. Each delivery is a task you choose to take, paid per delivery.
        </li>
        <li>
          Cash orders mean you pay the shop and collect from the student. The amounts are shown
          before you accept.
        </li>
        <li>
          Abandoning a delivery after accepting counts against you, because somebody&apos;s food
          goes cold. Do it repeatedly in a short time and you are barred from new tasks for a
          period.
        </li>
        <li>You follow traffic law. Hoppo does not ask anyone to rush.</li>
      </ul>
      <p className="mt-3 text-sm text-[var(--color-ink-faint)]">Version {RIDER_TERMS_VERSION}</p>
      <Button large className="mt-4 w-full" loading={busy} onClick={onAccept}>
        I accept
      </Button>
    </Card>
  );
}

function WorkModePanel({
  status,
  position,
  barred,
  busy,
  lostOffer,
  onToggle,
}: {
  status: RiderStatus;
  position: ReturnType<typeof useRiderPosition>;
  barred: boolean;
  busy: boolean;
  lostOffer: boolean;
  onToggle: (enable: boolean) => void;
}) {
  const geo = position.state;

  return (
    <>
      {lostOffer && (
        <div className="mb-3">
          <Banner tone="info">
            Someone was faster on that one. Offers go to several riders at once — stay online and
            another will come.
          </Banner>
        </div>
      )}

      <Card className="p-5" tone={status.workModeOn ? 'ready' : 'plain'}>
        <p className="text-lg font-bold">
          {status.workModeOn ? 'You are online' : 'You are offline'}
        </p>
        <p className="mt-1 text-[var(--color-ink-soft)]">
          {status.workModeOn
            ? 'Waiting for a delivery near you. Keep this tab open and your screen awake — a browser stops reporting your location when the tab is hidden.'
            : 'Go online to start receiving delivery offers from shops near you.'}
        </p>

        {status.workModeOn && geo.kind === 'granted' && (
          <p className="mt-3 text-sm text-[var(--color-ink-faint)]">
            Location accurate to about {formatDistance(Math.round(geo.accuracyM))}.
            {geo.accuracyM > 200 &&
              ' That is poor — step outside for a better fix, or you may be passed over for closer riders.'}
          </p>
        )}

        {geo.kind === 'denied' && (
          <div className="mt-3">
            <Banner tone="error">
              Location permission was refused, so you cannot be matched to nearby deliveries. Allow
              it in your browser&apos;s site settings and try again.
            </Banner>
          </div>
        )}

        {geo.kind === 'unavailable' && (
          <div className="mt-3">
            <Banner tone="warn">{geo.reason}</Banner>
          </div>
        )}

        {geo.kind === 'asking' && (
          <p className="mt-3 text-sm text-[var(--color-ink-faint)]">Waiting for a location fix…</p>
        )}

        <Button
          large
          tone={status.workModeOn ? 'secondary' : 'primary'}
          className="mt-4 w-full"
          loading={busy}
          disabled={barred}
          onClick={() => onToggle(!status.workModeOn)}
        >
          {status.workModeOn ? 'Go offline' : 'Go online'}
        </Button>

        {!status.workModeOn && (
          <p className="mt-3 text-sm text-[var(--color-ink-faint)]">
            Hoppo takes you offline automatically after {status.idleTimeoutMinutes} minutes without
            a position update, so you are never shown as available when you are not.
          </p>
        )}
      </Card>
    </>
  );
}

function OfferCard({
  offer,
  busy,
  onAccept,
  onDecline,
  onExpire,
}: {
  offer: TaskOffer;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onExpire: () => void;
}) {
  const remaining = useCountdown(offer.expiresAt);

  // Clear the card when the window closes rather than leaving a dead button.
  useEffect(() => {
    if (remaining <= 0) {
      const timer = setTimeout(onExpire, 1500);
      return () => clearTimeout(timer);
    }
  }, [remaining, onExpire]);

  return (
    <Card tone="waiting" className="p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-lg font-bold">A delivery for you</p>
        <p className="text-2xl font-bold text-[var(--color-ready)]">
          {formatMinor(offer.feeMinor)}
        </p>
      </div>

      <div className="mt-4">
        <CountdownBar remaining={remaining} total={offer.acceptanceWindowSeconds} />
      </div>

      <dl className="mt-4 space-y-3">
        <div>
          <dt className="text-sm text-[var(--color-ink-faint)]">Collect from</dt>
          <dd className="font-semibold">{offer.shopName ?? offer.pickupLabel}</dd>
          {offer.expectedReadyAt && (
            <dd className="text-sm text-[var(--color-ink-soft)]">
              Ready around{' '}
              {new Date(offer.expectedReadyAt).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </dd>
          )}
        </div>
        <div>
          <dt className="text-sm text-[var(--color-ink-faint)]">Deliver to</dt>
          <dd className="font-semibold">{offer.dropLabel}</dd>
        </div>
        <div>
          <dt className="text-sm text-[var(--color-ink-faint)]">Distance</dt>
          <dd className="font-semibold">{formatDistance(offer.distanceM)}</dd>
        </div>
        {offer.reimbursementMinor !== null && offer.reimbursementMinor > 0 && (
          <div>
            <dt className="text-sm text-[var(--color-ink-faint)]">You pay the shop</dt>
            <dd className="font-semibold">
              {formatMinor(offer.reimbursementMinor)} — reimbursed with your fee
            </dd>
          </div>
        )}
        {/* ADR-006: a cash order means the rider fronts the shop's money and
            gets it back at the door. That is the thing to know before
            accepting, not after — a rider with ₹40 in their pocket cannot
            take a ₹300 order. */}
        {((offer.cashToPayShopMinor ?? 0) > 0 || (offer.cashToCollectMinor ?? 0) > 0) && (
          <div>
            <dt className="text-sm text-[var(--color-ink-faint)]">Cash order</dt>
            <dd className="font-semibold">
              {(offer.cashToPayShopMinor ?? 0) > 0 && (offer.cashToCollectMinor ?? 0) > 0
                ? `You pay the shop ${formatMinor(offer.cashToPayShopMinor ?? 0)} in cash, collect ${formatMinor(offer.cashToCollectMinor ?? 0)} at the door`
                : (offer.cashToPayShopMinor ?? 0) > 0
                  ? `You pay the shop ${formatMinor(offer.cashToPayShopMinor ?? 0)} in cash`
                  : `You collect ${formatMinor(offer.cashToCollectMinor ?? 0)} in cash at the door`}
            </dd>
          </div>
        )}
        {offer.description && (
          <div>
            <dt className="text-sm text-[var(--color-ink-faint)]">Note</dt>
            <dd>{offer.description}</dd>
          </div>
        )}
      </dl>

      <div className="mt-5 space-y-2">
        <Button
          large
          className="w-full"
          loading={busy}
          disabled={remaining <= 0}
          onClick={onAccept}
        >
          {remaining > 0 ? 'Accept this delivery' : 'Window closed'}
        </Button>
        <Button tone="quiet" className="w-full" onClick={onDecline}>
          Not this one
        </Button>
      </div>

      <p className="mt-3 text-center text-sm text-[var(--color-ink-faint)]">
        This offer went to several riders. The first to accept gets it.
      </p>
    </Card>
  );
}

function ActiveTaskPanel({ task, onChanged }: { task: ActiveTask; onChanged: () => void }) {
  const { api } = useApi();

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
      // On failure too. A wrong handover code changes the task (the attempt
      // counter, and after enough of them the task itself is escalated), and
      // refreshing only on success left the rider reading a stale count.
      onChanged();
    }
  }

  const order = task.order;

  return (
    <Card tone="preparing" className="p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-lg font-bold">
          {task.status === 'ASSIGNED' ? 'Collect this order' : 'Deliver this order'}
        </p>
        <p className="font-bold text-[var(--color-ready)]">{task.feeLabel}</p>
      </div>

      {error && (
        <div className="mt-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      <dl className="mt-4 space-y-3">
        <div>
          <dt className="text-sm text-[var(--color-ink-faint)]">
            {task.status === 'ASSIGNED' ? 'Go to' : 'Collected from'}
          </dt>
          <dd className="font-semibold">{task.pickupLabel}</dd>
          {order?.shopListing.shop.address && (
            <dd className="text-sm text-[var(--color-ink-soft)]">
              {order.shopListing.shop.address}
            </dd>
          )}
          {/* The shop's number, unlike the student's, is shared — a rider at
              the wrong gate needs to be able to ring the shop. FR-PRIV-03
              protects students from riders, not businesses from customers. */}
          {task.status === 'ASSIGNED' && order?.shopListing.shop.ownerMobile && (
            <dd className="mt-1">
              <a
                href={`tel:${order.shopListing.shop.ownerMobile}`}
                className="font-semibold text-[var(--color-accent)] underline"
              >
                Call the shop
              </a>
            </dd>
          )}
        </div>

        <div>
          <dt className="text-sm text-[var(--color-ink-faint)]">Deliver to</dt>
          <dd className="font-semibold">{task.dropLabel}</dd>
          {order?.student.name && (
            <dd className="text-sm text-[var(--color-ink-soft)]">For {order.student.name}</dd>
          )}
        </div>

        {order && order.items.length > 0 && (
          <div>
            <dt className="text-sm text-[var(--color-ink-faint)]">
              {order.reference} — check this before you leave
            </dt>
            <dd>
              <ul className="mt-1 space-y-0.5">
                {order.items.map((item, index) => (
                  <li key={index} className="font-semibold">
                    {item.quantity}× {item.nameSnapshot}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}

        {order?.studentNote && (
          <div>
            <dt className="text-sm text-[var(--color-ink-faint)]">Student&apos;s note</dt>
            <dd>{order.studentNote}</dd>
          </div>
        )}

        {/* ADR-006: cash settlement, stated as two separate numbers because
            they are two separate transactions the rider performs. */}
        {task.cashToPayShopMinor > 0 && (
          <div>
            <dt className="text-sm text-[var(--color-ink-faint)]">Pay the shop</dt>
            <dd className="text-lg font-bold">{formatMinor(task.cashToPayShopMinor)}</dd>
          </div>
        )}
        {task.cashToCollectMinor > 0 && (
          <div>
            <dt className="text-sm text-[var(--color-ink-faint)]">Collect at the door</dt>
            <dd className="text-lg font-bold">{formatMinor(task.cashToCollectMinor)}</dd>
          </div>
        )}
      </dl>

      {task.status === 'ASSIGNED' && (
        <div className="mt-5">
          {/* ADR-003: the shop owns the handover, so this stays disabled until
              the order is marked ready. */}
          <Button
            large
            className="w-full"
            loading={busy}
            disabled={!task.canConfirmPickup}
            onClick={() => void run(() => api.rider.confirmPickup(task.id))}
          >
            {task.canConfirmPickup ? 'I have collected it' : 'Waiting for the shop'}
          </Button>
          {!task.canConfirmPickup && (
            <p className="mt-2 text-center text-sm text-[var(--color-ink-faint)]">
              The shop has not marked this ready yet. They will hand it over when it is.
            </p>
          )}
        </div>
      )}

      {task.status === 'PICKED_UP' && (
        <div className="mt-5">
          <p className="font-semibold">Ask for the student&apos;s code</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            They have a code on their phone. Entering it is what completes the delivery and pays
            you.
          </p>
          <div className="mt-3">
            <Field
              label="Handover code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="off"
              className="text-center font-mono text-2xl tracking-[0.4em]"
            />
          </div>
          {task.otpAttempts > 0 && (
            <p className="mt-2 text-sm font-semibold text-[var(--color-waiting)]">
              {task.otpAttempts} wrong {task.otpAttempts === 1 ? 'attempt' : 'attempts'} so far. The
              student can have a new code sent to themselves if they have lost it.
            </p>
          )}
          <Button
            large
            className="mt-3 w-full"
            loading={busy}
            // The code is exactly six digits; anything shorter is refused by
            // the API and still costs one of the limited attempts.
            disabled={code.length !== 6}
            onClick={() => void run(() => api.rider.submitHandoverCode(task.id, code))}
          >
            Complete the delivery
          </Button>
        </div>
      )}

      {task.canAbandon && (
        <div className="mt-6 border-t border-[var(--color-line)] pt-4">
          {confirmAbandon ? (
            <>
              <p className="font-semibold text-[var(--color-danger)]">Give this delivery up?</p>
              <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                Somebody is waiting for this food, so this is recorded against you, and abandoning
                several deliveries in a short time bars you from new tasks for a while. Only do it
                if you genuinely cannot finish.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  tone="danger"
                  className="flex-1"
                  loading={busy}
                  onClick={() =>
                    void run(() => api.rider.abandon(task.id, 'Unable to complete the delivery'))
                  }
                >
                  Yes, give it up
                </Button>
                <Button
                  tone="secondary"
                  className="flex-1"
                  onClick={() => setConfirmAbandon(false)}
                >
                  Keep it
                </Button>
              </div>
            </>
          ) : (
            <Button tone="quiet" className="w-full" onClick={() => setConfirmAbandon(true)}>
              I cannot finish this delivery
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
