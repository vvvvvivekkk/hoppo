'use client';

import type { AuditLogEntry, AuditLogQuery } from '@hoppo/api-client';
import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Empty, Field, Panel, Pill } from '@/components/ui';
import { useApi } from '@/lib/api';
import { Select, explain, useAction, when, words } from '@/lib/kit';

/**
 * A-15: the audit log (FR-ADM-06).
 *
 * Read-only, newest first. A college administrator sees the rows of their
 * own college; a platform administrator sees all of them. "Exportable" in
 * the SRS is, in this release, paging to the end with "Show more" — the API
 * has no file export.
 */
const REFUSALS = {
  INVALID_DATE_RANGE: 'The "from" date has to be before the "to" date. Pick the dates again.',
};

const TARGET_TYPES: Record<string, string> = {
  user: 'A person',
  shop_listing: 'A shop',
  task: 'A delivery',
  shop_document: 'A shop document',
  college_config: 'College settings',
  college: 'A college',
  delivery_point: 'A delivery point',
  verification_submission: 'An ID submission',
};

const ROLE: Record<string, string> = {
  STUDENT: 'student',
  SHOP_OWNER: 'shop owner',
  SHOP_STAFF: 'shop staff',
  ADMIN: 'administrator',
  SUPER_ADMIN: 'platform administrator',
};

interface Filters {
  action: string;
  targetType: string;
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { action: '', targetType: '', from: '', to: '' };

/**
 * The API takes instants and treats `to` as exclusive. The form takes two
 * calendar days and means both of them, so `to` is sent as the start of the
 * day after.
 */
function toQuery(f: Filters): AuditLogQuery {
  const dayStart = (date: string, plusDays: number) => {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + plusDays);
    return d.toISOString();
  };
  return {
    action: f.action || undefined,
    targetType: f.targetType || undefined,
    from: f.from ? dayStart(f.from, 0) : undefined,
    to: f.to ? dayStart(f.to, 1) : undefined,
  };
}

/** One value from a `detail` object, as plain text. */
function plain(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export default function AuditPage() {
  const { api } = useApi();
  const [actions, setActions] = useState<string[]>([]);
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [items, setItems] = useState<AuditLogEntry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useAction();
  const more = useAction();

  useEffect(() => {
    void (async () => {
      try {
        setActions((await api.admin.audit.actions()).actions);
      } catch {
        // The filter loses its choices; the log itself still loads.
        setActions([]);
      }
    })();
  }, [api]);

  const read = useCallback(
    (filters: Filters) =>
      load.run(async () => {
        if (filters.from && filters.to && filters.from > filters.to) {
          setError(REFUSALS.INVALID_DATE_RANGE);
          return;
        }
        try {
          const page = await api.admin.audit.list({ ...toQuery(filters), limit: 50 });
          setItems(page.items);
          setNextCursor(page.nextCursor);
          setApplied(filters);
          setError(null);
        } catch (e) {
          setError(explain(e, REFUSALS));
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  );

  useEffect(() => {
    void read(NO_FILTERS);
  }, [read]);

  const showMore = () =>
    more.run(async () => {
      if (!nextCursor) return;
      try {
        const page = await api.admin.audit.list({ ...toQuery(applied), limit: 50, cursor: nextCursor });
        setItems((prev) => [...(prev ?? []), ...page.items]);
        setNextCursor(page.nextCursor);
      } catch (e) {
        setError(explain(e, REFUSALS));
      }
    });

  const set = (patch: Partial<Filters>) => setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black tracking-tight">Audit log</h1>

      <Panel title="Filter" subtitle="Dates are whole days on this computer's clock, both included">
        <form
          className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            void read(draft);
          }}
        >
          <Select label="What happened" value={draft.action} onChange={(e) => set({ action: e.target.value })}>
            <option value="">Anything</option>
            {actions.map((action) => (
              <option key={action} value={action}>
                {words(action)}
              </option>
            ))}
          </Select>
          <Select label="Done to" value={draft.targetType} onChange={(e) => set({ targetType: e.target.value })}>
            <option value="">Anything</option>
            {Object.entries(TARGET_TYPES).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
          <Field label="From" type="date" value={draft.from} onChange={(e) => set({ from: e.target.value })} />
          <Field label="To" type="date" value={draft.to} onChange={(e) => set({ to: e.target.value })} />
          <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" loading={load.busy}>
              Show entries
            </Button>
            <Button
              type="button"
              tone="quiet"
              disabled={load.busy}
              onClick={() => {
                setDraft(NO_FILTERS);
                void read(NO_FILTERS);
              }}
            >
              Clear filters
            </Button>
          </div>
        </form>
      </Panel>

      {error && <Banner tone="error">{error}</Banner>}

      <Panel title="Entries" subtitle="Newest first">
        {items === null ? (
          <Empty title="Loading…" body="Fetching the audit log." />
        ) : items.length === 0 ? (
          <Empty title="No entries match" body="Nothing was recorded with these filters. Widen the dates or clear a filter." />
        ) : (
          <>
            <ul className="divide-y divide-[var(--color-line)] text-sm">
              {items.map((entry) => (
                <li key={entry.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="nums w-40 text-[var(--color-ink-faint)]">{when(entry.createdAt)}</span>
                    <span className="font-bold">{words(entry.action)}</span>
                    <span>
                      {entry.actor ? (
                        <>
                          by {entry.actor.name}{' '}
                          <Pill tone="plain">{ROLE[entry.actor.role] ?? words(entry.actor.role)}</Pill>
                        </>
                      ) : (
                        <span className="text-[var(--color-ink-faint)]">by the system</span>
                      )}
                    </span>
                    {entry.targetType && (
                      <span className="text-[var(--color-ink-soft)]">
                        {(TARGET_TYPES[entry.targetType] ?? words(entry.targetType)).toLowerCase()}{' '}
                        <span className="nums text-xs">{entry.targetId}</span>
                      </span>
                    )}
                  </div>
                  {entry.detail && Object.keys(entry.detail).length > 0 && (
                    <dl className="mt-2 grid gap-x-6 gap-y-1 pl-0 text-xs sm:grid-cols-2 sm:pl-44">
                      {Object.entries(entry.detail).map(([key, value]) => (
                        <div key={key} className="flex gap-2">
                          <dt className="font-semibold">{key}</dt>
                          <dd className="nums break-all text-[var(--color-ink-soft)]">{plain(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {entry.ipAddress && (
                    <p className="nums mt-1 pl-0 text-xs text-[var(--color-ink-faint)] sm:pl-44">
                      from {entry.ipAddress}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-3 border-t border-[var(--color-line)] px-4 py-3 text-sm">
              <span className="text-[var(--color-ink-faint)]">
                Showing {items.length} entr{items.length === 1 ? 'y' : 'ies'}
                {nextCursor ? '' : ' — that is all of them'}
              </span>
              {nextCursor && (
                <Button tone="secondary" loading={more.busy} onClick={() => void showMore()}>
                  Show more
                </Button>
              )}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
