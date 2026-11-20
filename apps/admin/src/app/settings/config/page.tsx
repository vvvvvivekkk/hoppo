'use client';

import type { CollegeConfig, CollegeConfigEditable, CollegeConfigUpdate, FeeBand } from '@hoppo/api-client';
import { formatDistance, formatMinor } from '@hoppo/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banner, Button, Empty, Field, Panel } from '@/components/ui';
import { useApi } from '@/lib/api';
import { SETTINGS_TABS, Tabs, explain, useAction, when } from '@/lib/kit';

/**
 * A-09: fees, windows and caps (FR-ADM-03).
 *
 * Every number on this page decides money or time for real people — what a
 * rider is paid, how long a shop has to answer, when a student is barred from
 * riding. So nothing is saved from the form directly: "Review changes" lists
 * each value as it is and as it will be, and only that list has a Save.
 *
 * The limits are the API's own (`limits` in its answer), not copies kept
 * here, and the fee band rules mirror the ones it enforces: the first band
 * starts at 0, each band starts where the one before it ends, and only the
 * last one is open-ended. The radius is not here because changing it flags
 * shops (FR-TEN-05); it has its own page.
 */
type Key = keyof CollegeConfigEditable;
type Unit = 'seconds' | 'minutes' | 'hours' | 'days' | 'metres' | 'rupees' | 'percent' | 'count';

interface FieldSpec {
  key: Key;
  label: string;
  unit: Unit;
  hint?: string;
}

const GROUPS: { title: string; subtitle: string; fields: FieldSpec[] }[] = [
  {
    title: 'Finding a rider',
    subtitle: 'How a delivery is offered to riders, round by round',
    fields: [
      { key: 'acceptanceWindowSeconds', label: 'Time a rider has to accept', unit: 'seconds' },
      { key: 'maxBroadcastRounds', label: 'Rounds before giving up', unit: 'count' },
      { key: 'initialProximityM', label: 'First round reaches riders within', unit: 'metres' },
      { key: 'proximityIncrementM', label: 'Each later round reaches further by', unit: 'metres' },
      { key: 'feeIncrementMinor', label: 'Each later round adds to the fee', unit: 'rupees' },
      { key: 'dispatchLeadMinutes', label: 'Call a rider this long before the food is due', unit: 'minutes' },
    ],
  },
  {
    title: 'Shops and handover',
    subtitle: 'Windows that cancel or escalate when they run out',
    fields: [
      { key: 'shopAcceptWindowSeconds', label: 'Time a shop has to answer an order', unit: 'seconds' },
      { key: 'maxOtpAttempts', label: 'Wrong handover codes before a delivery escalates', unit: 'count' },
    ],
  },
  {
    title: 'Money',
    subtitle: 'What the platform charges, and the smallest payout',
    fields: [
      { key: 'platformFeeMinor', label: 'Platform fee per order', unit: 'rupees' },
      { key: 'commissionBps', label: 'Commission taken from the shop', unit: 'percent' },
      { key: 'minWithdrawalMinor', label: 'Smallest wallet withdrawal', unit: 'rupees' },
    ],
  },
  {
    title: 'Riders',
    subtitle: 'Work mode and the ban for abandoning deliveries',
    fields: [
      { key: 'workModeIdleTimeoutMinutes', label: 'Switch work mode off after this long idle', unit: 'minutes' },
      { key: 'riderPingIntervalSeconds', label: 'Location update every', unit: 'seconds' },
      { key: 'abandonmentBanThreshold', label: 'Abandoned deliveries that trigger a ban', unit: 'count' },
      { key: 'abandonmentWindowDays', label: 'Counted over', unit: 'days' },
      { key: 'abandonmentBanHours', label: 'Length of the ban', unit: 'hours' },
    ],
  },
  {
    title: 'Verification and community',
    subtitle: 'Resubmission limits, chat retention and the auto-hide threshold',
    fields: [
      { key: 'maxVerificationSubmissions', label: 'ID submissions allowed', unit: 'count' },
      { key: 'verificationWindowDays', label: 'In any period of', unit: 'days' },
      { key: 'chatRetentionDays', label: 'Keep chat messages for', unit: 'days' },
      { key: 'reportHideThreshold', label: 'Reports that hide a post automatically', unit: 'count' },
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);

/** Stored integer -> what goes in the box. */
function toBox(unit: Unit, stored: number): string {
  if (unit === 'rupees' || unit === 'percent') return String(stored / 100);
  return String(stored);
}

/** What is in the box -> stored integer, or null if it is not a usable number. */
function fromBox(unit: Unit, text: string): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const stored = unit === 'rupees' || unit === 'percent' ? Math.round(n * 100) : n;
  return Number.isInteger(stored) ? stored : null;
}

function show(unit: Unit, stored: number): string {
  switch (unit) {
    case 'rupees':
      return formatMinor(stored);
    case 'percent':
      return `${stored / 100}%`;
    case 'metres':
      return `${stored} m`;
    case 'count':
      return String(stored);
    default:
      return `${stored} ${unit}`;
  }
}

const UNIT_WORD: Record<Unit, string> = {
  seconds: 'seconds',
  minutes: 'minutes',
  hours: 'hours',
  days: 'days',
  metres: 'metres',
  rupees: '₹',
  percent: '%',
  count: '',
};

/** A band as it is edited: where it ends ("" on the last = and beyond) and its fee in rupees. */
interface BandRow {
  upTo: string;
  rupees: string;
}

const toRows = (bands: FeeBand[]): BandRow[] =>
  bands.map((b) => ({
    upTo: b.maxDistanceM === null ? '' : String(b.maxDistanceM),
    rupees: String(b.feeMinor / 100),
  }));

/**
 * The band rows as the API wants them, or the first rule they break.
 *
 * Each band starts where the previous one ended, so the "contiguous, no gap,
 * no overlap" rule holds by construction; what is left to check is that the
 * ends go up, only the last is open, and the numbers are in range.
 */
function toBands(
  rows: BandRow[],
  limits: CollegeConfig['limits']['feeBands'],
): { bands: FeeBand[]; problem: null } | { bands: null; problem: string } {
  if (rows.length < limits.minBands) return { bands: null, problem: 'There has to be at least one fee band.' };
  if (rows.length > limits.maxBands) {
    return { bands: null, problem: `There can be at most ${limits.maxBands} fee bands.` };
  }

  const bands: FeeBand[] = [];
  let start = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const last = i === rows.length - 1;
    const name = `Band ${i + 1}`;
    const fee = fromBox('rupees', rows[i].rupees);

    if (fee === null || fee < 0) return { bands: null, problem: `${name}: enter the fee in rupees.` };
    if (fee > limits.maxFeeMinor) {
      return { bands: null, problem: `${name}: the fee cannot be more than ${formatMinor(limits.maxFeeMinor)}.` };
    }

    if (last) {
      if (rows[i].upTo.trim() !== '') {
        return {
          bands: null,
          problem: `${name} is the last band, so it has to cover every longer distance: leave its "up to" empty.`,
        };
      }
      bands.push({ minDistanceM: start, maxDistanceM: null, feeMinor: fee });
      break;
    }

    const end = fromBox('metres', rows[i].upTo);
    if (end === null) {
      return { bands: null, problem: `${name}: enter where it ends, in whole metres. Only the last band is open-ended.` };
    }
    if (end <= start) {
      return {
        bands: null,
        problem: `${name} has to end further out than it starts (${start} m).`,
      };
    }
    if (end > limits.maxDistanceM) {
      return { bands: null, problem: `${name}: a band cannot end beyond ${limits.maxDistanceM} m.` };
    }
    bands.push({ minDistanceM: start, maxDistanceM: end, feeMinor: fee });
    start = end;
  }

  return { bands, problem: null };
}

const bandWords = (b: FeeBand): string =>
  `${formatDistance(b.minDistanceM)} ${b.maxDistanceM === null ? 'and beyond' : `to ${formatDistance(b.maxDistanceM)}`}: ${formatMinor(b.feeMinor)}`;

const sameBands = (a: FeeBand[], b: FeeBand[]): boolean =>
  a.length === b.length &&
  a.every(
    (band, i) =>
      band.minDistanceM === b[i].minDistanceM &&
      band.maxDistanceM === b[i].maxDistanceM &&
      band.feeMinor === b[i].feeMinor,
  );

const REFUSALS = {
  EMPTY_UPDATE: 'Nothing was different from what is already saved, so nothing was changed.',
  COLLEGE_CONFIG_MISSING: 'This college has no configuration record yet. Ask a platform administrator to create it.',
};

export default function ConfigPage() {
  const { api } = useApi();
  const [saved, setSaved] = useState<CollegeConfig | null>(null);
  const [boxes, setBoxes] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<BandRow[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useAction();

  const adopt = useCallback((config: CollegeConfig) => {
    setSaved(config);
    setBoxes(Object.fromEntries(ALL_FIELDS.map((f) => [f.key, toBox(f.unit, config.config[f.key])])));
    setRows(toRows(config.feeBands));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        adopt(await api.admin.config.get());
      } catch (e) {
        setError(explain(e, REFUSALS));
      }
    })();
  }, [api, adopt]);

  /** Per-field problems, the parsed bands, and exactly what differs from what is saved. */
  const draft = useMemo(() => {
    if (!saved) return null;

    const problems: Partial<Record<Key, string>> = {};
    const update: CollegeConfigUpdate = {};
    const changes: { label: string; before: string; after: string }[] = [];

    for (const field of ALL_FIELDS) {
      const value = fromBox(field.unit, boxes[field.key] ?? '');
      const limit = saved.limits[field.key];
      if (value === null) {
        problems[field.key] =
          field.unit === 'rupees' || field.unit === 'percent'
            ? 'Enter a number with at most two decimal places.'
            : 'Enter a whole number.';
        continue;
      }
      if (value < limit.min || value > limit.max) {
        problems[field.key] = `Has to be between ${show(field.unit, limit.min)} and ${show(field.unit, limit.max)}.`;
        continue;
      }
      if (value !== saved.config[field.key]) {
        update[field.key] = value;
        changes.push({
          label: field.label,
          before: show(field.unit, saved.config[field.key]),
          after: show(field.unit, value),
        });
      }
    }

    const parsed = toBands(rows, saved.limits.feeBands);
    if (parsed.bands && !sameBands(parsed.bands, saved.feeBands)) {
      update.feeBands = parsed.bands;
      changes.push({
        label: 'Delivery fee by distance',
        before: saved.feeBands.map(bandWords).join(' · '),
        after: parsed.bands.map(bandWords).join(' · '),
      });
    }

    return {
      problems,
      bandProblem: parsed.problem,
      update,
      changes,
      valid: Object.keys(problems).length === 0 && parsed.problem === null,
    };
  }, [saved, boxes, rows]);

  const commit = () =>
    save.run(async () => {
      if (!draft || !draft.valid || draft.changes.length === 0) return;
      setError(null);
      setNotice(null);
      try {
        const result = await api.admin.config.update(draft.update);
        adopt(result);
        setReviewing(false);
        setNotice(
          result.changed.length === 0
            ? 'Nothing was different from what was already saved.'
            : `Saved. ${result.changed.length} setting${result.changed.length === 1 ? '' : 's'} changed, and the change is in the audit log.`,
        );
      } catch (e) {
        setReviewing(false);
        setError(explain(e, REFUSALS));
      }
    });

  const setRow = (index: number, patch: Partial<BandRow>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black tracking-tight">College settings</h1>
      <Tabs current="/settings/config" tabs={SETTINGS_TABS} />

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      {!saved && !error && <Empty title="Loading…" body="Fetching the current settings." />}

      {saved && draft && !reviewing && (
        <>
          <p className="text-sm text-[var(--color-ink-faint)]">Last changed {when(saved.updatedAt)}.</p>

          <Panel
            title="Delivery fee by distance"
            subtitle="The fee a student pays and a rider earns, by how far the delivery is. Each band starts where the one above it ends."
          >
            <div className="space-y-3 p-4">
              {rows.map((row, i) => {
                const last = i === rows.length - 1;
                const startsAt = i === 0 ? '0' : rows[i - 1].upTo || '?';
                return (
                  <div key={i} className="flex flex-wrap items-end gap-3">
                    <p className="w-40 pb-2 text-sm font-semibold">
                      Band {i + 1} · from {startsAt} m
                    </p>
                    <div className="w-40">
                      {last ? (
                        <p className="pb-2 text-sm text-[var(--color-ink-soft)]">and every longer distance</p>
                      ) : (
                        <Field
                          label={`Band ${i + 1} ends at (metres)`}
                          inputMode="numeric"
                          value={row.upTo}
                          onChange={(e) => setRow(i, { upTo: e.target.value })}
                        />
                      )}
                    </div>
                    <div className="w-32">
                      <Field
                        label={`Band ${i + 1} fee (₹)`}
                        inputMode="decimal"
                        value={row.rupees}
                        onChange={(e) => setRow(i, { rupees: e.target.value })}
                      />
                    </div>
                    {rows.length > saved.limits.feeBands.minBands && (
                      <Button
                        tone="quiet"
                        onClick={() =>
                          setRows((prev) => {
                            const next = prev.filter((_, j) => j !== i);
                            // Whatever is last now covers "and beyond".
                            next[next.length - 1] = { ...next[next.length - 1], upTo: '' };
                            return next;
                          })
                        }
                      >
                        Remove band {i + 1}
                      </Button>
                    )}
                  </div>
                );
              })}

              <Button
                tone="secondary"
                disabled={rows.length >= saved.limits.feeBands.maxBands}
                onClick={() =>
                  setRows((prev) => [
                    ...prev.slice(0, -1),
                    // The old last band needs an end now; it is left for the
                    // administrator to fill in rather than guessed.
                    { ...prev[prev.length - 1], upTo: '' },
                    { upTo: '', rupees: prev[prev.length - 1].rupees },
                  ])
                }
              >
                Add a band
              </Button>

              {draft.bandProblem && <Banner tone="error">{draft.bandProblem}</Banner>}
            </div>
          </Panel>

          {GROUPS.map((group) => (
            <Panel key={group.title} title={group.title} subtitle={group.subtitle}>
              <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
                {group.fields.map((field) => {
                  const limit = saved.limits[field.key];
                  return (
                    <Field
                      key={field.key}
                      label={`${field.label}${UNIT_WORD[field.unit] ? ` (${UNIT_WORD[field.unit]})` : ''}`}
                      hint={`${show(field.unit, limit.min)} to ${show(field.unit, limit.max)}`}
                      inputMode="decimal"
                      value={boxes[field.key] ?? ''}
                      onChange={(e) => setBoxes((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      error={draft.problems[field.key]}
                    />
                  );
                })}
              </div>
            </Panel>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!draft.valid || draft.changes.length === 0} onClick={() => setReviewing(true)}>
              Review changes
            </Button>
            <Button tone="quiet" disabled={draft.changes.length === 0 && draft.valid} onClick={() => adopt(saved)}>
              Discard my edits
            </Button>
            <span className="text-sm text-[var(--color-ink-faint)]">
              {!draft.valid
                ? 'Fix the highlighted values before reviewing.'
                : draft.changes.length === 0
                  ? 'Nothing has been changed yet.'
                  : `${draft.changes.length} change${draft.changes.length === 1 ? '' : 's'} not saved yet.`}
            </span>
          </div>
        </>
      )}

      {saved && draft && reviewing && (
        <Panel
          title="Review changes"
          subtitle="Nothing has been saved yet. These take effect for new orders and deliveries as soon as you save."
        >
          <ul className="divide-y divide-[var(--color-line)] text-sm">
            {draft.changes.map((change) => (
              <li key={change.label} className="grid gap-1 px-4 py-3 sm:grid-cols-3">
                <span className="font-semibold">{change.label}</span>
                <span className="text-[var(--color-ink-soft)]">
                  <span className="text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">now </span>
                  {change.before}
                </span>
                <span className="font-bold">
                  <span className="text-xs font-normal uppercase tracking-wide text-[var(--color-ink-faint)]">
                    becomes{' '}
                  </span>
                  {change.after}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 border-t border-[var(--color-line)] p-4">
            <Button loading={save.busy} onClick={() => void commit()}>
              Save {draft.changes.length} change{draft.changes.length === 1 ? '' : 's'}
            </Button>
            <Button tone="quiet" disabled={save.busy} onClick={() => setReviewing(false)}>
              Back to editing
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}
