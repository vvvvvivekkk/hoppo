import { BadRequestException } from '@nestjs/common';
import { OrderStatus as DbOrderStatus } from '@prisma/client';

/**
 * Turning what an administrator typed into what a query can use.
 *
 * A report is asked for by calendar date — "the 20th" — and a calendar date
 * only means something in a place. For a college in India the 20th starts at
 * 18:30 UTC on the 19th. Filtering `placedAt` against midnight UTC instead
 * would put the evening's orders on the wrong day, which is exactly when a
 * campus food service is busiest. So every date here is read in the college's
 * own timezone (`college.timezone`, the same field opening hours use, R-18)
 * and converted to a pair of UTC instants before it reaches the database.
 *
 * Everything in this file is pure: no clock unless one is passed in, no
 * database. That is what lets the day-boundary arithmetic be tested directly.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export interface ReportRange {
  /** First local day included, `YYYY-MM-DD`, or null when open-ended. */
  from: string | null;
  /** Last local day included, `YYYY-MM-DD`, or null when open-ended. */
  to: string | null;
  timezone: string;
  /** `placedAt >= start`: the first instant of `from` in the timezone. */
  start: Date | null;
  /** `placedAt < end`: the first instant of the day AFTER `to`. */
  end: Date | null;
}

function invalidDate(field: string, raw: string): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_DATE',
    message: `"${field}" must be a calendar date written as YYYY-MM-DD.`,
    details: { field, value: raw },
  });
}

/**
 * Check that a string is a real calendar date and return it unchanged.
 *
 * "2026-02-30" matches the pattern and is not a date; JavaScript would
 * quietly roll it over into March. Building the date and reading it back
 * catches that.
 */
export function parseLocalDate(raw: string, field: string): string {
  const match = DATE_PATTERN.exec(raw.trim());
  if (!match) throw invalidDate(field, raw);

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  const real =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  if (!real) throw invalidDate(field, raw);

  return match[0];
}

/** How far ahead of UTC a timezone is at a given instant, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  // The wall-clock reading in that zone, re-read as if it were UTC. The gap
  // between that and the true instant is the zone's offset.
  const wallAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which a calendar day begins in a timezone.
 *
 * The offset is looked up twice. The first guess uses the offset at midnight
 * UTC, which is wrong on the two days a year a zone with daylight saving
 * changes its offset; the second lookup, at the guessed instant, corrects it.
 */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day);
  const guess = wallAsUtc - offsetAt(new Date(wallAsUtc), timeZone);
  return new Date(wallAsUtc - offsetAt(new Date(guess), timeZone));
}

/** The calendar day after `date`. */
export function nextLocalDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + DAY_MS).toISOString().slice(0, 10);
}

/** Today's calendar date in a timezone. */
export function localToday(timeZone: string, now: Date = new Date()): string {
  return new Date(now.getTime() + offsetAt(now, timeZone)).toISOString().slice(0, 10);
}

/**
 * Resolve `from` / `to` into the half-open interval a query filters on.
 *
 * Both ends are inclusive as the user sees them (`to=2026-11-20` includes the
 * whole of the 20th), which in instants is `start <= placedAt < end` with
 * `end` at the start of the 21st. Half-open avoids "23:59:59.999" and the
 * order placed in the last millisecond of the day.
 */
export function resolveReportRange(
  input: { from?: string; to?: string },
  timeZone: string,
  options: { defaultToToday?: boolean; maxDays?: number; now?: Date } = {},
): ReportRange {
  let from = input.from?.trim() ? parseLocalDate(input.from, 'from') : null;
  let to = input.to?.trim() ? parseLocalDate(input.to, 'to') : null;

  if (options.defaultToToday) {
    const today = localToday(timeZone, options.now);
    // One end given means "that single day onwards / up to", so only fill
    // both when neither was supplied; otherwise mirror the end that was.
    if (!from && !to) {
      from = today;
      to = today;
    } else {
      from ??= to;
      to ??= from;
    }
  }

  // YYYY-MM-DD sorts as text in date order.
  if (from && to && from > to) {
    throw new BadRequestException({
      code: 'INVALID_DATE_RANGE',
      message: '"from" must not be after "to".',
      details: { from, to },
    });
  }

  if (options.maxDays && from && to) {
    const days =
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
    if (days > options.maxDays) {
      throw new BadRequestException({
        code: 'INVALID_DATE_RANGE',
        message: `A report can cover at most ${options.maxDays} days.`,
        details: { from, to, days },
      });
    }
  }

  return {
    from,
    to,
    timezone: timeZone,
    start: from ? startOfLocalDay(from, timeZone) : null,
    end: to ? startOfLocalDay(nextLocalDay(to), timeZone) : null,
  };
}

const ORDER_STATUSES = new Set<string>(Object.values(DbOrderStatus));

/**
 * Parse `status=PLACED,PREPARING` (or a repeated parameter) into statuses.
 *
 * An unknown value is refused rather than ignored: silently dropping a typo
 * would return every order and look like a working filter.
 */
export function parseStatusFilter(
  raw: string | string[] | undefined,
): DbOrderStatus[] | undefined {
  const values = [raw ?? []]
    .flat()
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);

  if (values.length === 0) return undefined;

  const unknown = values.filter((value) => !ORDER_STATUSES.has(value));
  if (unknown.length > 0) {
    throw new BadRequestException({
      code: 'INVALID_STATUS',
      message: `Unknown order status: ${unknown.join(', ')}.`,
      details: { unknown, allowed: [...ORDER_STATUSES] },
    });
  }

  return [...new Set(values)] as DbOrderStatus[];
}
