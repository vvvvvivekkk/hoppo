import { resolveOpenState, minuteOfDay, formatMinuteOfDay, type HoursRow } from './hours';

/** 2026-11-18 is a Wednesday (dayOfWeek 3). */
const wednesdayAt = (h: number, m = 0) => new Date(2026, 10, 18, h, m, 0);

const nineToNine: HoursRow[] = [{ dayOfWeek: 3, openMinute: 540, closeMinute: 1260 }];

describe('minute helpers', () => {
  it('converts a time to minutes from midnight', () => {
    expect(minuteOfDay(wednesdayAt(9, 0))).toBe(540);
    expect(minuteOfDay(wednesdayAt(0, 0))).toBe(0);
    expect(minuteOfDay(wednesdayAt(23, 59))).toBe(1439);
  });

  it('formats minutes back to a clock time', () => {
    expect(formatMinuteOfDay(540)).toBe('09:00');
    expect(formatMinuteOfDay(1260)).toBe('21:00');
    expect(formatMinuteOfDay(0)).toBe('00:00');
  });
});

describe('resolveOpenState', () => {
  it('is open inside the window', () => {
    expect(resolveOpenState({ rows: nineToNine, now: wednesdayAt(13) })).toMatchObject({
      isOpen: true,
      reason: 'OPEN',
    });
  });

  it('is open exactly at opening time and closed exactly at closing time', () => {
    expect(resolveOpenState({ rows: nineToNine, now: wednesdayAt(9) }).isOpen).toBe(true);
    // The close minute is exclusive: at 21:00 sharp the shop is shut.
    expect(resolveOpenState({ rows: nineToNine, now: wednesdayAt(21) }).isOpen).toBe(false);
  });

  it('is closed before opening, and says how long until it opens', () => {
    const state = resolveOpenState({ rows: nineToNine, now: wednesdayAt(7) });
    expect(state.isOpen).toBe(false);
    expect(state.reason).toBe('OUTSIDE_HOURS');
    expect(state.opensInMinutes).toBe(120);
  });

  it('is closed on a day with no hours configured', () => {
    // Thursday, when the only row is for Wednesday.
    const thursday = new Date(2026, 10, 19, 13, 0, 0);
    expect(resolveOpenState({ rows: nineToNine, now: thursday }).isOpen).toBe(false);
  });

  it('reports a temporary closure ahead of the weekly schedule (FR-CAT-04)', () => {
    const state = resolveOpenState({
      rows: nineToNine,
      now: wednesdayAt(13),
      temporarilyClosedUntil: wednesdayAt(15),
    });
    expect(state.isOpen).toBe(false);
    expect(state.reason).toBe('TEMPORARILY_CLOSED');
  });

  it('ignores a temporary closure that has already elapsed', () => {
    const state = resolveOpenState({
      rows: nineToNine,
      now: wednesdayAt(13),
      temporarilyClosedUntil: wednesdayAt(11),
    });
    expect(state.isOpen).toBe(true);
  });

  it('distinguishes no-hours-set from outside-hours', () => {
    expect(resolveOpenState({ rows: [], now: wednesdayAt(13) }).reason).toBe('NO_HOURS_SET');
  });

  it('handles a window that crosses midnight', () => {
    // Open 20:00 Wednesday to 02:00 Thursday.
    const lateNight: HoursRow[] = [{ dayOfWeek: 3, openMinute: 1200, closeMinute: 120 }];
    expect(resolveOpenState({ rows: lateNight, now: wednesdayAt(23) }).isOpen).toBe(true);
    // 01:00 on Thursday is still inside Wednesday's window.
    const thursdayOneAm = new Date(2026, 10, 19, 1, 0, 0);
    expect(resolveOpenState({ rows: lateNight, now: thursdayOneAm }).isOpen).toBe(true);
    // 03:00 on Thursday is not.
    const thursdayThreeAm = new Date(2026, 10, 19, 3, 0, 0);
    expect(resolveOpenState({ rows: lateNight, now: thursdayThreeAm }).isOpen).toBe(false);
  });

  it('supports a split day, open for lunch and again for dinner', () => {
    const split: HoursRow[] = [
      { dayOfWeek: 3, openMinute: 660, closeMinute: 900 }, // 11:00-15:00
      { dayOfWeek: 3, openMinute: 1080, closeMinute: 1320 }, // 18:00-22:00
    ];
    expect(resolveOpenState({ rows: split, now: wednesdayAt(12) }).isOpen).toBe(true);
    expect(resolveOpenState({ rows: split, now: wednesdayAt(16) }).isOpen).toBe(false);
    expect(resolveOpenState({ rows: split, now: wednesdayAt(19) }).isOpen).toBe(true);
    // Closed between the two windows, reopening at 18:00.
    expect(resolveOpenState({ rows: split, now: wednesdayAt(16) }).opensInMinutes).toBe(120);
  });
});
