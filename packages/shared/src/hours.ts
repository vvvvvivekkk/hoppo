/**
 * Opening hours.
 *
 * Hours are stored as minutes from midnight (540 = 09:00) so that "is this
 * shop open right now" is an integer comparison rather than date parsing.
 * A row whose closeMinute is less than or equal to its openMinute crosses
 * midnight.
 *
 * **Hours are in the college's timezone, not the server's.** This matters
 * more than it looks. A shop in Hyderabad opens at 09:00 IST. If the API
 * resolves "is it open" using the server process's local time, then the same
 * shop appears to open at 09:00 UTC on a server in London — 14:30 in
 * Hyderabad — and shows as closed through most of its actual trading day.
 * Every function here therefore takes an IANA timezone and uses it; none of
 * them reads the host's local time.
 *
 * FR-CAT-04, FR-CAT-05. See docs/srs-resolutions.md R-18.
 */

export interface HoursRow {
  /** 0 = Sunday .. 6 = Saturday, in the college's timezone. */
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
}

export interface OpenState {
  isOpen: boolean;
  reason: 'OPEN' | 'OUTSIDE_HOURS' | 'TEMPORARILY_CLOSED' | 'NO_HOURS_SET';
  /** Minutes until the next open window, when currently closed. */
  opensInMinutes?: number;
}

/** India, the default for every college until one says otherwise. */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * The day of week and minute of day at an instant, as observed in a
 * particular timezone.
 *
 * Uses Intl, which is built into Node and every browser and carries the full
 * IANA database — so daylight saving and historical offset changes are
 * handled without a date library and without hard-coding "+05:30".
 */
export function zonedDayAndMinute(
  at: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): { dayOfWeek: number; minuteOfDay: number } {
  let parts: Intl.DateTimeFormatPart[];

  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
  } catch {
    // An invalid timezone string must not take the endpoint down. Fall back
    // to the default rather than to the host's zone, which would be the
    // original bug wearing a disguise.
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TIMEZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
  }

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  // With hour12: false some ICU builds render midnight as "24" rather than
  // "00", which would put the minute of day at 1440 and break comparisons.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));

  return {
    dayOfWeek: WEEKDAY_INDEX[get('weekday')] ?? 0,
    minuteOfDay: hour * 60 + minute,
  };
}

export function formatMinuteOfDay(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * FR-CAT-05: a shop outside its hours, or inside a temporary closure, shows
 * as closed and cannot accept orders.
 */
export function resolveOpenState(params: {
  rows: readonly HoursRow[];
  now: Date;
  /** The college's IANA timezone, e.g. "Asia/Kolkata". */
  timeZone?: string;
  temporarilyClosedUntil?: Date | null;
}): OpenState {
  const { rows, now, timeZone = DEFAULT_TIMEZONE, temporarilyClosedUntil } = params;

  // A temporary closure is an absolute instant, so it needs no zone maths.
  if (temporarilyClosedUntil && temporarilyClosedUntil.getTime() > now.getTime()) {
    return { isOpen: false, reason: 'TEMPORARILY_CLOSED' };
  }

  if (rows.length === 0) {
    return { isOpen: false, reason: 'NO_HOURS_SET' };
  }

  const { dayOfWeek: today, minuteOfDay: nowMinute } = zonedDayAndMinute(now, timeZone);
  const yesterday = (today + 6) % 7;

  for (const row of rows) {
    const crossesMidnight = row.closeMinute <= row.openMinute;

    if (!crossesMidnight && row.dayOfWeek === today) {
      if (nowMinute >= row.openMinute && nowMinute < row.closeMinute) {
        return { isOpen: true, reason: 'OPEN' };
      }
    }

    if (crossesMidnight) {
      // Opened late yesterday and still open, or opened late today.
      if (row.dayOfWeek === yesterday && nowMinute < row.closeMinute) {
        return { isOpen: true, reason: 'OPEN' };
      }
      if (row.dayOfWeek === today && nowMinute >= row.openMinute) {
        return { isOpen: true, reason: 'OPEN' };
      }
    }
  }

  return {
    isOpen: false,
    reason: 'OUTSIDE_HOURS',
    opensInMinutes: minutesUntilNextOpen(rows, today, nowMinute),
  };
}

function minutesUntilNextOpen(
  rows: readonly HoursRow[],
  today: number,
  nowMinute: number,
): number | undefined {
  let best: number | undefined;

  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    const day = (today + dayOffset) % 7;
    for (const row of rows.filter((r) => r.dayOfWeek === day)) {
      const minutesAway = dayOffset * 1440 + row.openMinute - nowMinute;
      if (minutesAway > 0 && (best === undefined || minutesAway < best)) best = minutesAway;
    }
  }

  return best;
}
