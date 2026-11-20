import { BadRequestException } from '@nestjs/common';
import {
  localToday,
  nextLocalDay,
  parseLocalDate,
  parseStatusFilter,
  resolveReportRange,
  startOfLocalDay,
} from './report-range';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { code: string }).code;
  }
  throw new Error('expected a refusal');
}

describe('report dates are read in the college timezone', () => {
  it('starts an Indian day at 18:30 UTC the evening before', () => {
    expect(startOfLocalDay('2026-11-20', 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-19T18:30:00.000Z',
    );
  });

  it('includes the whole of the last day: the range ends where the next day starts', () => {
    const range = resolveReportRange({ from: '2026-11-20', to: '2026-11-20' }, 'Asia/Kolkata');

    expect(range.start?.toISOString()).toBe('2026-11-19T18:30:00.000Z');
    expect(range.end?.toISOString()).toBe('2026-11-20T18:30:00.000Z');

    // 11:45 pm on the 20th in India is inside; 12:15 am on the 21st is not.
    const lateEvening = new Date('2026-11-20T18:15:00.000Z');
    const afterMidnight = new Date('2026-11-20T18:45:00.000Z');
    expect(lateEvening >= range.start! && lateEvening < range.end!).toBe(true);
    expect(afterMidnight < range.end!).toBe(false);
  });

  it('does not treat the date as UTC: 1 am IST on the 20th belongs to the 20th', () => {
    const range = resolveReportRange({ from: '2026-11-20', to: '2026-11-20' }, 'Asia/Kolkata');
    // 01:00 IST on the 20th is 19:30 UTC on the 19th — a UTC-day filter would miss it.
    const earlyMorning = new Date('2026-11-19T19:30:00.000Z');
    expect(earlyMorning >= range.start! && earlyMorning < range.end!).toBe(true);
  });

  it('handles a zone behind UTC and a daylight-saving change', () => {
    expect(startOfLocalDay('2026-01-15', 'America/New_York').toISOString()).toBe(
      '2026-01-15T05:00:00.000Z',
    );
    // Clocks go forward on 8 March 2026: that local day is 23 hours long.
    const start = startOfLocalDay('2026-03-08', 'America/New_York');
    const end = startOfLocalDay(nextLocalDay('2026-03-08'), 'America/New_York');
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('knows what "today" is in the college, not on the server', () => {
    // 20:00 UTC on the 19th is already the 20th in India.
    const now = new Date('2026-11-19T20:00:00.000Z');
    expect(localToday('Asia/Kolkata', now)).toBe('2026-11-20');
    expect(localToday('UTC', now)).toBe('2026-11-19');

    const range = resolveReportRange({}, 'Asia/Kolkata', { defaultToToday: true, now });
    expect([range.from, range.to]).toEqual(['2026-11-20', '2026-11-20']);
  });

  it('leaves an omitted end open on a list, and mirrors it on a summary', () => {
    const open = resolveReportRange({ from: '2026-11-01' }, 'Asia/Kolkata');
    expect(open.to).toBeNull();
    expect(open.end).toBeNull();

    const mirrored = resolveReportRange({ from: '2026-11-01' }, 'Asia/Kolkata', {
      defaultToToday: true,
    });
    expect(mirrored.to).toBe('2026-11-01');
  });

  it('rolls the month and the year when stepping to the next day', () => {
    expect(nextLocalDay('2026-11-30')).toBe('2026-12-01');
    expect(nextLocalDay('2026-12-31')).toBe('2027-01-01');
    expect(nextLocalDay('2028-02-28')).toBe('2028-02-29');
  });
});

describe('report input is validated, not guessed at', () => {
  it('refuses anything that is not YYYY-MM-DD', () => {
    for (const bad of ['20-11-2026', '2026/11/20', 'yesterday', '2026-11-20T10:00:00Z', '']) {
      expect(codeOf(() => parseLocalDate(bad, 'from'))).toBe('INVALID_DATE');
    }
  });

  it('refuses a date that does not exist rather than rolling it over', () => {
    expect(codeOf(() => parseLocalDate('2026-02-30', 'from'))).toBe('INVALID_DATE');
    expect(codeOf(() => parseLocalDate('2026-13-01', 'to'))).toBe('INVALID_DATE');
    expect(parseLocalDate('2028-02-29', 'from')).toBe('2028-02-29');
  });

  it('refuses a range that runs backwards or is too long', () => {
    expect(
      codeOf(() => resolveReportRange({ from: '2026-11-21', to: '2026-11-20' }, 'Asia/Kolkata')),
    ).toBe('INVALID_DATE_RANGE');
    expect(
      codeOf(() =>
        resolveReportRange({ from: '2025-01-01', to: '2026-11-20' }, 'Asia/Kolkata', {
          maxDays: 366,
        }),
      ),
    ).toBe('INVALID_DATE_RANGE');
  });

  it('parses a status list, in either form, without duplicates', () => {
    expect(parseStatusFilter(undefined)).toBeUndefined();
    expect(parseStatusFilter('')).toBeUndefined();
    expect(parseStatusFilter('placed, PREPARING,placed')).toEqual(['PLACED', 'PREPARING']);
    expect(parseStatusFilter(['COMPLETED', 'CANCELLED'])).toEqual(['COMPLETED', 'CANCELLED']);
  });

  it('refuses an unknown status instead of ignoring the filter', () => {
    expect(codeOf(() => parseStatusFilter('PLACED,SHIPPED'))).toBe('INVALID_STATUS');
  });
});
