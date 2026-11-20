'use client';

import type { AdminOrderSummary, RiderPresence } from '@hoppo/api-client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Banner, Panel, Pill } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { ORDER_STATUS } from '@/lib/kit';

/**
 * A-02: the operations overview.
 *
 * "What needs me right now": the queues waiting on a decision, and today's
 * orders from the order summary (FR-ADM-05). The SRS also asks for riders
 * online; the API does not keep rider presence history, so that figure is
 * named below as missing rather than shown as a zero.
 */
const LIVE_STATUSES = ['PLACED', 'SHOP_ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP'] as const;

export default function OverviewPage() {
  const { api, user } = useApi();
  const [students, setStudents] = useState<number | null>(null);
  const [shops, setShops] = useState<number | null>(null);
  const [flagged, setFlagged] = useState<number | null>(null);
  const [today, setToday] = useState<AdminOrderSummary | null>(null);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health.ready>> | null>(null);
  const [presence, setPresence] = useState<RiderPresence | null>(null);
  const [presenceError, setPresenceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Today's orders are read on their own: a failure there should cost that
    // panel, not the queue counts beside it.
    void (async () => {
      try {
        setToday(await api.admin.orders.summary());
        setTodayError(null);
      } catch (e) {
        setTodayError(describeError(e));
      }
    })();

    // Rider presence for today, also independent.
    void (async () => {
      try {
        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        setPresence(
          await api.admin.riderPresence(startOfDay.toISOString(), now.toISOString()),
        );
        setPresenceError(null);
      } catch (e) {
        setPresenceError(describeError(e));
      }
    })();

    try {
      // Fetched together rather than in sequence: independent reads, and a
      // dashboard that paints in steps feels slower than it is.
      const [studentQueue, shopQueue, flaggedShops, ready] = await Promise.all([
        api.admin.verificationQueue(1),
        api.admin.shopQueue(1),
        api.admin.flaggedShops(),
        api.health.ready().catch(() => null),
      ]);

      setStudents(studentQueue.total ?? studentQueue.items.length);
      setShops(shopQueue.total ?? shopQueue.items.length);
      setFlagged(flaggedShops.items.length);
      setHealth(ready);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const postgisDown = health?.checks?.postgis?.ok === false;
  const isSuper = user?.role === 'SUPER_ADMIN';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Overview</h1>
        <p className="text-sm text-[var(--color-ink-faint)]">
          {user?.college?.name ?? 'All colleges'}
        </p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      {/*
        Without PostGIS, shop registration cannot validate a radius at all —
        the geodesic function does not exist. That is worth a loud banner
        rather than letting an administrator wonder why registrations fail.
      */}
      {postgisDown && (
        <Banner tone="error">
          PostGIS is unavailable, so shop registration cannot measure distances. New shops will
          fail to register until this is fixed.
        </Banner>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <QueueCard
          href="/students"
          label="Students awaiting verification"
          count={students}
          hint="They can browse shops but cannot order, ride or post until approved."
        />
        <QueueCard
          href="/shops"
          label="Shops awaiting verification"
          count={shops}
          hint="Nothing they submit is visible to students until approved."
        />
        <QueueCard
          href={isSuper ? '/shops/all' : '/settings'}
          label="Shops outside the radius"
          count={flagged}
          hint="Approved under a wider radius. They stay active until you decide."
          tone={flagged && flagged > 0 ? 'pending' : 'plain'}
        />
      </div>

      <Panel
        title="Orders today"
        subtitle={
          today
            ? `Placed on ${today.range.from ?? 'today'} (${today.range.timezone}) · refreshed every 15 seconds`
            : 'Placed today'
        }
        actions={
          <Link href="/orders" className="text-sm font-semibold text-[var(--color-accent)] underline">
            Open the order report
          </Link>
        }
      >
        {todayError && (
          <div className="p-4">
            <Banner tone="warn">Today&rsquo;s orders could not be read: {todayError}</Banner>
          </div>
        )}
        {!today && !todayError && (
          <p className="p-4 text-sm text-[var(--color-ink-faint)]">Loading today&rsquo;s orders…</p>
        )}
        {today && (
          <>
            <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Placed" value={today.ordersPlaced} />
              <Stat label="Completed" value={today.byStatus.COMPLETED} />
              <Stat label="Cancelled" value={today.cancellations.total} />
              <Stat
                label="No rider found"
                value={today.unfulfilledBroadcasts}
                alert={today.unfulfilledBroadcasts > 0}
              />
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-[var(--color-line)] px-4 py-3 text-sm">
              <span className="font-bold">In progress now</span>
              {LIVE_STATUSES.map((status) => (
                <span key={status}>
                  <span className="nums font-bold">{today.byStatus[status]}</span>{' '}
                  <span className="text-[var(--color-ink-soft)]">{ORDER_STATUS[status].toLowerCase()}</span>
                </span>
              ))}
            </div>
            <p className="border-t border-[var(--color-line)] px-4 py-3 text-sm">
              <span className="nums font-bold">{today.money.totalLabel}</span> paid by students today
              {today.money.basis === 'COMPLETED' ? ', counting completed orders only.' : '.'}
            </p>
          </>
        )}
      </Panel>

      <Panel
        title="Rider presence today"
        subtitle={
          presence
            ? `${presence.distinctRiders} distinct rider${presence.distinctRiders === 1 ? '' : 's'} seen` +
              (presence.peak
                ? ` · peak ${presence.peak.activeRiders} at ${new Date(presence.peak.hourStart).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
                : '')
            : 'Loading…'
        }
      >
        {presenceError && (
          <div className="p-4">
            <Banner tone="warn">Could not load rider presence: {presenceError}</Banner>
          </div>
        )}
        {presence && presence.hours.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                  <th className="px-4 py-2 text-left">Hour</th>
                  <th className="px-4 py-2 text-right">Active riders</th>
                  <th className="px-4 py-2 text-left">Bar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {presence.hours.map((h) => {
                  const maxCount = presence.peak?.activeRiders ?? 1;
                  const pct = maxCount > 0 ? (h.activeRiders / maxCount) * 100 : 0;
                  const beforeRecording =
                    presence.recordedSince !== null &&
                    new Date(h.hourStart) < new Date(presence.recordedSince);
                  return (
                    <tr key={h.hourStart} className={beforeRecording ? 'opacity-40' : ''}>
                      <td className="nums whitespace-nowrap px-4 py-1">
                        {new Date(h.hourStart).toLocaleTimeString('en-IN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="nums px-4 py-1 text-right font-semibold">
                        {beforeRecording ? '—' : h.activeRiders}
                      </td>
                      <td className="px-4 py-1">
                        {!beforeRecording && h.activeRiders > 0 && (
                          <div
                            className="h-4 rounded bg-[var(--color-accent)]"
                            style={{ width: `${Math.max(pct, 4)}%` }}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          presence && !presenceError && (
            <div className="p-4">
              <p className="text-sm text-[var(--color-ink-faint)]">
                No rider presence data for today yet.
              </p>
            </div>
          )
        )}
      </Panel>

      <Panel title="Not in this build" subtitle="So the gaps are visible rather than implied">
        <ul className="divide-y divide-[var(--color-line)] text-sm">
          {[
            ['Withdrawal requests (A-13)', 'Marking payouts as paid'],
            ['Reported users and content (A-11, A-12)', 'Community moderation queues'],
          ].map(([title, body]) => (
            <li key={title} className="flex flex-wrap items-baseline gap-2 px-4 py-2">
              <span className="font-semibold">{title}</span>
              <span className="text-[var(--color-ink-faint)]">{body}</span>
            </li>
          ))}
        </ul>
      </Panel>

      {health && (
        <Panel title="System" subtitle="Dependencies this console relies on">
          <dl className="divide-y divide-[var(--color-line)] text-sm">
            {Object.entries(health.checks).map(([name, check]) => (
              <div key={name} className="flex items-center gap-3 px-4 py-2">
                <dt className="w-28 font-semibold capitalize">{name}</dt>
                <dd className="flex items-center gap-2">
                  <Pill tone={check.ok ? 'ok' : 'danger'}>{check.ok ? 'ok' : 'down'}</Pill>
                  {check.detail && (
                    <span className="text-[var(--color-ink-faint)]">{check.detail}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      )}
    </div>
  );
}

function Stat({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</p>
      <p className={`nums text-3xl font-black ${alert ? 'text-[var(--color-pending)]' : ''}`}>{value}</p>
    </div>
  );
}

function QueueCard({
  href,
  label,
  count,
  hint,
  tone = 'plain',
}: {
  href: string;
  label: string;
  count: number | null;
  hint: string;
  tone?: 'plain' | 'pending';
}) {
  return (
    <Link
      href={href}
      className={`block rounded-lg border bg-white p-4 transition-colors hover:border-[var(--color-accent)] ${
        tone === 'pending' && count
          ? 'border-[var(--color-pending)]'
          : 'border-[var(--color-line)]'
      }`}
    >
      <p className="nums text-4xl font-black">{count ?? '–'}</p>
      <p className="mt-1 font-semibold">{label}</p>
      <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{hint}</p>
    </Link>
  );
}
