/**
 * Opening hours.
 *
 * Hours are stored as minutes from midnight (540 = 09:00) so that "is this
 * shop open right now" is an integer comparison rather than date parsing.
 * A row whose closeMinute is less than its openMinute crosses midnight.
 *
 * FR-CAT-04, FR-CAT-05.
 */

export interface HoursRow {
  /** 0 = Sunday .. 6 = Saturday */
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

export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
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
  temporarilyClosedUntil?: Date | null;
}): OpenState {
  const { rows, now, temporarilyClosedUntil } = params;

  if (temporarilyClosedUntil && temporarilyClosedUntil.getTime() > now.getTime()) {
    return { isOpen: false, reason: 'TEMPORARILY_CLOSED' };
  }

  if (rows.length === 0) {
    return { isOpen: false, reason: 'NO_HOURS_SET' };
  }

  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  const nowMinute = minuteOfDay(now);

  for (const row of rows) {
    const crossesMidnight = row.closeMinute <= row.openMinute;

    if (!crossesMidnight && row.dayOfWeek === today) {
      if (nowMinute >= row.openMinute && nowMinute < row.closeMinute) {
        return { isOpen: true, reason: 'OPEN' };
      }
    }

    if (crossesMidnight) {
      // Open late yesterday and still open now, or open late today.
      if (row.dayOfWeek === yesterday && nowMinute < row.closeMinute) {
        return { isOpen: true, reason: 'OPEN' };
      }
      if (row.dayOfWeek === today && nowMinute >= row.openMinute) {
        return { isOpen: true, reason: 'OPEN' };
      }
    }
  }

  return { isOpen: false, reason: 'OUTSIDE_HOURS', opensInMinutes: minutesUntilNextOpen(rows, now) };
}

function minutesUntilNextOpen(rows: readonly HoursRow[], now: Date): number | undefined {
  const nowMinute = minuteOfDay(now);
  const today = now.getDay();
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
