'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Banner, Panel, Pill } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/**
 * A-02: the operations overview.
 *
 * Built from what Phase 1 actually exposes rather than from the full A-02
 * screen in the SRS, which also wants live order counts, unfulfilled
 * broadcasts and riders online. Those come from the operational reporting in
 * FR-ADM-05, which is Phase 2 work — so rather than show plausible-looking
 * zeros, this page shows the queues that exist and says plainly what is not
 * here yet.
 *
 * The purpose of the page is "what needs me right now", so the queues lead
 * and the counts are the headline.
 */
export default function OverviewPage() {
  const { api, user } = useApi();
  const [students, setStudents] = useState<number | null>(null);
  const [shops, setShops] = useState<number | null>(null);
  const [flagged, setFlagged] = useState<number | null>(null);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health.ready>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Fetched together rather than in sequence: three independent reads, and
      // a dashboard that paints in three steps feels slower than it is.
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
          href="/settings"
          label="Shops outside the radius"
          count={flagged}
          hint="Approved under a wider radius. They stay active until you decide."
          tone={flagged && flagged > 0 ? 'pending' : 'plain'}
        />
      </div>

      <Panel title="Not in this build" subtitle="So the gaps are visible rather than implied">
        <ul className="divide-y divide-[var(--color-line)] text-sm">
          {[
            ['Live order board (A-07)', 'Orders by status with stuck-order flags'],
            ['Escalated tasks (A-08)', 'OTP failures and abandonments needing resolution'],
            ['Analytics (A-14)', 'Acceptance latency, rider supply by hour, revenue by shop'],
            ['Audit log viewer (A-15)', 'The log is written on every action; the viewer is not built'],
            ['Campus delivery points (A-10)', 'Map editor for drop points'],
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

