'use client';

import { formatMinuteOfDay } from '@hoppo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Card, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { canOperate, isAwaitingApproval, RegistrationStatus } from '@/lib/approval';
import { useListing } from '@/lib/use-listing';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Window {
  openMinute: number;
  closeMinute: number;
}

/**
 * "09:00" to 540. Null for a cleared or half-typed time input, which reports
 * its value as "" — turning that into NaN and sending it would have the API
 * reject the whole week over one empty box.
 */
function toMinutes(time: string): number | null {
  const [h, m] = time.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return h * 60 + m;
}

/** 540 to "09:00", for an <input type="time">. */
function toTime(minute: number): string {
  return formatMinuteOfDay(minute);
}

/**
 * D-13: opening hours and temporary closure.
 *
 * Two things the UI has to make clear, because both are easy to get wrong:
 *
 *  - **Hours are in the college's timezone**, not the tablet's. A shop owner
 *    setting 09:00 means nine in the morning where the shop is, and the API
 *    resolves it in the college's zone (resolution R-18). The copy says so,
 *    because a tablet with the wrong clock would otherwise be blamed.
 *  - **No hours means permanently closed.** An owner who clears the week
 *    expecting "always open" would get the opposite, so the empty state says
 *    what will happen rather than looking like a blank slate.
 */
export default function HoursPage() {
  const { api } = useApi();
  const { listingId, listing, shop, error: listingError, loading, reload } = useListing();

  const [week, setWeek] = useState<Record<number, Window[]>>({});
  const [closure, setClosure] = useState<{ until: string | null; note: string | null }>({
    until: null,
    note: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  /**
   * Whether the schedule on screen came from the server.
   *
   * Until it has, the week is an empty object — which is also exactly what
   * "closed every day" looks like. Saving in that state (after a failed load)
   * would replace the shop's real hours with nothing, so Save stays disabled
   * until there is a loaded schedule to edit.
   */
  const [loaded, setLoaded] = useState(false);
  const [refused, setRefused] = useState(false);

  // Asked of /shops/mine, which always answers. The menu and hours of a
  // listing that is not ACTIVE are refused by the API, so they are not
  // requested at all.
  const operable = canOperate(listing);

  const load = useCallback(async () => {
    if (!listingId || !operable) return;
    try {
      const catalog = await api.catalog.get(listingId);
      const grouped: Record<number, Window[]> = {};
      for (const row of catalog.hours) {
        grouped[row.dayOfWeek] ??= [];
        grouped[row.dayOfWeek].push({
          openMinute: row.openMinute,
          closeMinute: row.closeMinute,
        });
      }
      setWeek(grouped);
      setClosure({ until: catalog.temporarilyClosedUntil, note: catalog.closureNote });
      setError(null);
      setLoaded(true);
      setRefused(false);
    } catch (e) {
      if (isAwaitingApproval(e)) {
        setRefused(true);
        setError(null);
        void reload();
      } else {
        setError(describeError(e));
      }
    }
  }, [api, listingId, operable, reload]);

  /** One change at a time, and never a second copy of the same one. */
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await action();
    } catch (e) {
      if (isAwaitingApproval(e)) {
        setRefused(true);
        void reload();
      } else {
        setError(describeError(e));
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!listingId || !loaded) return;

    const hours = Object.entries(week).flatMap(([day, windows]) =>
      windows.map((w) => ({
        dayOfWeek: Number(day),
        openMinute: w.openMinute,
        closeMinute: w.closeMinute,
      })),
    );

    await run(async () => {
      const result = await api.catalog.setHours(listingId, hours);
      setSaved(result.message);
      await load();
    });
  }

  function setWindow(day: number, index: number, patch: Partial<Record<keyof Window, number | null>>) {
    // A cleared time box has no minute to store; keep the last real time.
    const open = patch.openMinute ?? undefined;
    const close = patch.closeMinute ?? undefined;
    if (open === undefined && close === undefined) return;

    setWeek((prev) => {
      const windows = [...(prev[day] ?? [])];
      windows[index] = {
        openMinute: open ?? windows[index].openMinute,
        closeMinute: close ?? windows[index].closeMinute,
      };
      return { ...prev, [day]: windows };
    });
  }

  function addWindow(day: number) {
    setWeek((prev) => ({
      ...prev,
      // A sensible second window is the evening, which is the common case for
      // a shop that closes for an afternoon break.
      [day]: [...(prev[day] ?? []), { openMinute: 540, closeMinute: 1260 }],
    }));
  }

  function removeWindow(day: number, index: number) {
    setWeek((prev) => ({
      ...prev,
      [day]: (prev[day] ?? []).filter((_, i) => i !== index),
    }));
  }

  function copyMondayToWeekdays() {
    const monday = week[1];
    if (!monday?.length) return;
    setWeek((prev) => ({
      ...prev,
      2: monday.map((w) => ({ ...w })),
      3: monday.map((w) => ({ ...w })),
      4: monday.map((w) => ({ ...w })),
      5: monday.map((w) => ({ ...w })),
    }));
  }

  if (loading) return <p className="text-[var(--color-ink-faint)]">Loading…</p>;
  if (listingError) {
    return (
      <div className="space-y-4">
        <Banner tone="error">{listingError}</Banner>
        <Button tone="secondary" onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!listingId || !listing) return <Banner tone="warn">Register a shop first.</Banner>;

  if (refused || !operable) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-black tracking-tight">Opening hours</h1>
        <RegistrationStatus shopName={shop?.name} listing={listing} refused={refused} />
        {(refused || listing.status === 'PENDING_VERIFICATION') && (
          <p className="text-[var(--color-ink-faint)]">
            Opening hours can be set once the shop is approved.
          </p>
        )}
      </div>
    );
  }

  const closedNow = closure.until !== null && new Date(closure.until).getTime() > Date.now();
  const totalWindows = Object.values(week).flat().length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black tracking-tight">Opening hours</h1>
        <p className="text-[var(--color-ink-faint)]">
          {shop?.name} · times are in your college&rsquo;s local time, not this
          tablet&rsquo;s
        </p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {saved && <Banner tone="success">{saved}</Banner>}

      {/* FR-CAT-04: a temporary closure overrides the weekly schedule. */}
      <Card className="p-5">
        <h2 className="text-xl font-bold">Close temporarily</h2>
        {closedNow ? (
          <div className="mt-3 space-y-3">
            <Banner tone="warn">
              Students see this shop as closed until{' '}
              {new Date(closure.until!).toLocaleString('en-IN')}
              {closure.note ? ` — ${closure.note}` : ''}.
            </Banner>
            <Button
              loading={busy}
              onClick={() =>
                void run(async () => {
                  await api.catalog.clearClosure(listingId);
                  await load();
                })
              }
            >
              Reopen now
            </Button>
          </div>
        ) : (
          <ClosureForm
            disabled={busy || !loaded}
            onSubmit={(hours, note) =>
              void run(async () => {
                const reopenAt = new Date(Date.now() + hours * 3_600_000).toISOString();
                await api.catalog.setClosure(listingId, reopenAt, note || undefined);
                await load();
              })
            }
          />
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-5 py-3">
          <h2 className="text-xl font-bold">Weekly schedule</h2>
          <Button tone="quiet" onClick={copyMondayToWeekdays} disabled={!week[1]?.length}>
            Copy Monday to Tue–Fri
          </Button>
        </div>

        {!loaded && (
          <div className="border-b border-[var(--color-line)] px-5 py-3 text-[var(--color-ink-faint)]">
            {error
              ? 'Your hours could not be loaded, so they cannot be changed from here yet.'
              : 'Loading your hours…'}{' '}
            {error && (
              <button className="font-semibold underline" onClick={() => void load()}>
                Try again
              </button>
            )}
          </div>
        )}

        {loaded && totalWindows === 0 && (
          <div className="border-b border-[var(--color-line)] bg-[var(--color-waiting-bg)] px-5 py-3 font-medium text-[var(--color-waiting)]">
            No hours set, so students will see this shop as closed and cannot order. Add at
            least one window.
          </div>
        )}

        <div className="divide-y divide-[var(--color-line)]">
          {loaded && DAYS.map((label, day) => {
            const windows = week[day] ?? [];
            return (
              <div key={day} className="flex flex-wrap items-start gap-4 p-5">
                <p className="w-28 shrink-0 text-lg font-bold">{label}</p>

                <div className="flex-1 space-y-3">
                  {windows.length === 0 && (
                    <p className="text-[var(--color-ink-faint)]">Closed all day</p>
                  )}

                  {windows.map((w, index) => (
                    <div key={index} className="flex flex-wrap items-center gap-3">
                      <input
                        type="time"
                        aria-label={`${label} opening time`}
                        value={toTime(w.openMinute)}
                        onChange={(e) =>
                          setWindow(day, index, { openMinute: toMinutes(e.target.value) })
                        }
                        className="tap rounded-xl border-2 border-[var(--color-line)] bg-white px-3 text-lg"
                      />
                      <span className="text-[var(--color-ink-faint)]">to</span>
                      <input
                        type="time"
                        aria-label={`${label} closing time`}
                        value={toTime(w.closeMinute)}
                        onChange={(e) =>
                          setWindow(day, index, { closeMinute: toMinutes(e.target.value) })
                        }
                        className="tap rounded-xl border-2 border-[var(--color-line)] bg-white px-3 text-lg"
                      />
                      {/* A close at or before the open crosses midnight, which
                          is legitimate for a late-night shop but surprising
                          enough to label. */}
                      {w.closeMinute <= w.openMinute && (
                        <span className="rounded-full bg-[var(--color-preparing-bg)] px-3 py-1 text-sm font-semibold text-[var(--color-preparing)]">
                          closes next morning
                        </span>
                      )}
                      <Button tone="quiet" onClick={() => removeWindow(day, index)}>
                        Remove
                      </Button>
                    </div>
                  ))}

                  <Button tone="quiet" onClick={() => addWindow(day)}>
                    {windows.length === 0 ? 'Open on this day' : 'Add another window'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-[var(--color-line)] p-5">
          <Button large loading={busy} disabled={!loaded} onClick={() => void save()}>
            Save hours
          </Button>
        </div>
      </Card>
    </div>
  );
}

function ClosureForm({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (hours: number, note: string) => void;
}) {
  const [hours, setHours] = useState(2);
  const [note, setNote] = useState('');

  return (
    <div className="mt-3 space-y-4">
      <p className="text-[var(--color-ink-faint)]">
        For a power cut, a staff shortage, or anything that stops you taking orders for a
        while. Students see the shop as closed until the time you set.
      </p>

      <div className="flex flex-wrap gap-2">
        {[1, 2, 4, 8].map((h) => (
          <Button
            key={h}
            tone={hours === h ? 'primary' : 'secondary'}
            onClick={() => setHours(h)}
          >
            {h} hour{h === 1 ? '' : 's'}
          </Button>
        ))}
      </div>

      <Field
        label="Reason (optional)"
        hint="Shown to students, so keep it short"
        placeholder="Power cut"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <Button tone="danger" disabled={disabled} onClick={() => onSubmit(hours, note)}>
        Close for {hours} hour{hours === 1 ? '' : 's'}
      </Button>
    </div>
  );
}
