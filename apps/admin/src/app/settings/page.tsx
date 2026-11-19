'use client';

import { RADIUS_MAX_M, RADIUS_MIN_M, formatDistance } from '@hoppo/shared';
import type { FlaggedShop } from '@hoppo/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Detail, Empty, Panel, Pill } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/**
 * A-09: college settings.
 *
 * Phase 1E exposes the one setting with teeth: the serviceable radius
 * (FR-TEN-04). The rest of FR-ADM-03 — fee bands, broadcast rounds, timeouts
 * — is in the database and configurable, but no screen for it yet, which this
 * page says rather than hides.
 *
 * The radius is not a harmless slider. FR-TEN-05: reducing it leaves
 * already-approved shops outside the new limit, and they *stay active* and
 * get flagged rather than being cut off. A shop trading for a month should
 * not vanish because somebody moved a number. So the UI warns before the
 * change and lists the consequences after.
 */
export default function SettingsPage() {
  const { api, user } = useApi();
  const [radius, setRadius] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [flagged, setFlagged] = useState<FlaggedShop[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);

  const load = useCallback(async () => {
    try {
      // The current radius has no endpoint of its own. Every flagged shop
      // carries it, and so does every shop waiting in the approval queue, so
      // both are read; with neither there is nothing to read it from, and the
      // field says "not known" rather than showing a guess.
      const [result, waiting] = await Promise.all([
        api.admin.flaggedShops(),
        api.admin.shopQueue(1).catch(() => null),
      ]);
      setFlagged(result.items);
      setRadius(
        (prev) => prev ?? result.items[0]?.currentRadiusM ?? waiting?.items[0]?.radiusM ?? null,
      );
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (pending === null || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const result = await api.admin.updateRadius(pending);
      setRadius(result.serviceableRadiusM);
      setNotice(result.message);
      setPending(null);
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  const shrinking = radius !== null && pending !== null && pending < radius;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight">College settings</h1>
        <p className="text-sm text-[var(--color-ink-faint)]">
          {user?.college?.name ?? 'All colleges'}
        </p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      <Panel
        title="Serviceable radius"
        subtitle="How far from campus a shop may be and still register"
      >
        <div className="space-y-4 p-4">
          <p className="text-sm text-[var(--color-ink-soft)]">
            Measured as geodesic distance from the campus coordinates — over the curved surface
            of the earth, not straight-line on a flat map. Permitted range is{' '}
            {formatDistance(RADIUS_MIN_M)} to {formatDistance(RADIUS_MAX_M)}.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold">Current</span>
            <span className="nums rounded-md bg-[var(--color-surface-sunken)] px-3 py-1 text-xl font-black">
              {radius !== null ? formatDistance(radius) : 'not known yet'}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {[1000, 2000, 3000, 4000, 5000].map((option) => (
              <Button
                key={option}
                tone={pending === option ? 'primary' : 'secondary'}
                onClick={() => setPending(option)}
              >
                {formatDistance(option)}
              </Button>
            ))}
          </div>

          {/*
            With the current radius unknown, this page cannot tell whether a
            choice widens or narrows it — so the FR-TEN-05 warning is given
            regardless, instead of being silently skipped.
          */}
          {radius === null && pending !== null && (
            <Banner tone="warn">
              The current radius could not be read, so this may be a reduction. If it is,
              shops already approved outside {formatDistance(pending)} stay active and are
              flagged below for you to review.
            </Banner>
          )}

          {/* FR-TEN-05 made explicit before the change, not after. */}
          {shrinking && (
            <Banner tone="warn">
              Reducing the radius to {formatDistance(pending!)} will not remove shops that are
              already approved. Any now outside it stay active and are flagged below for you to
              review — so trading shops do not disappear without a decision.
            </Banner>
          )}

          {pending !== null && !shrinking && radius !== null && pending > radius && (
            <Banner tone="info">
              Widening to {formatDistance(pending)} clears any flags on shops that fall back
              inside it.
            </Banner>
          )}

          <Button
            loading={busy}
            disabled={pending === null || pending === radius}
            onClick={() => void save()}
          >
            {pending === null
              ? 'Choose a radius'
              : `Set radius to ${formatDistance(pending)}`}
          </Button>
        </div>
      </Panel>

      <Panel
        title="Shops outside the current radius"
        subtitle="Approved under a wider radius, still active"
      >
        {flagged.length === 0 ? (
          <Empty
            title="None"
            body="Every approved shop is inside the current radius."
          />
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {flagged.map((shop) => (
              <li key={shop.listingId} className="flex flex-wrap items-start gap-4 p-4">
                <div className="w-full shrink-0 rounded-md border-l-4 border-[var(--color-pending)] bg-[var(--color-pending-bg)] px-3 py-2 sm:w-40">
                  <p className="nums text-xl font-black">{shop.distanceLabel}</p>
                  <p className="nums text-xs text-[var(--color-ink-soft)]">
                    {formatDistance(shop.overByM)} over the limit
                  </p>
                </div>

                <div className="min-w-56 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold">{shop.shop.name}</p>
                    <Pill tone="plain">{shop.shop.category.toLowerCase()}</Pill>
                    <Pill tone="ok">still active</Pill>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Detail label="Address" value={shop.shop.address} />
                    <Detail label="Lifetime orders" value={shop.lifetimeOrders} nums />
                    <Detail
                      label="Flagged"
                      value={new Date(shop.flaggedAt).toLocaleDateString('en-IN')}
                    />
                  </dl>
                  {/* A shop with real order history is a different decision
                      from one that never traded, so the count is shown rather
                      than left for the administrator to look up. */}
                  {shop.lifetimeOrders > 0 && (
                    <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                      This shop has completed orders. Suspending it affects students who use it.
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Configurable but not on a screen yet"
        subtitle="These live in the database and can be changed there (FR-ADM-03)"
      >
        <ul className="divide-y divide-[var(--color-line)] text-sm">
          {[
            ['Base delivery fee and distance bands', 'fee_band table'],
            ['Fee increment per re-broadcast round', 'college_config.fee_increment_minor'],
            ['Acceptance window and broadcast rounds', 'college_config'],
            ['Work-mode inactivity timeout', 'college_config.work_mode_idle_timeout_minutes'],
            ['Campus delivery points', 'delivery_point table'],
          ].map(([label, where]) => (
            <li key={label} className="flex flex-wrap items-baseline gap-2 px-4 py-2">
              <span className="font-semibold">{label}</span>
              <span className="nums text-[var(--color-ink-faint)]">{where}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
