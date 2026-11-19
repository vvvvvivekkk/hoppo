import { acceptanceRateBps, acceptanceRatePercent } from './acceptance-rate';

/**
 * `tasks_offered` only began counting with the L5 fix; `tasks_accepted` was
 * always counted. Riders active before then have accepted more than they were
 * "offered", and the plain ratio put them at several hundred percent.
 */
describe('acceptance rate', () => {
  it('is null when nothing was ever offered — not zero', () => {
    expect(acceptanceRatePercent(0, 0)).toBeNull();
    expect(acceptanceRateBps(0, 0)).toBeNull();
  });

  it('is null, not infinite, for a pre-fix rider with accepts and no offers', () => {
    expect(acceptanceRatePercent(0, 7)).toBeNull();
  });

  it('never exceeds 100% when old accepts outnumber counted offers', () => {
    expect(acceptanceRatePercent(2, 9)).toBe(100);
    expect(acceptanceRateBps(2, 9)).toBe(10_000);
  });

  it('never goes below 0%', () => {
    expect(acceptanceRatePercent(4, -1)).toBe(0);
    expect(acceptanceRatePercent(-3, 2)).toBeNull();
  });

  it('is the plain ratio in the ordinary case, to one decimal place', () => {
    expect(acceptanceRatePercent(3, 1)).toBe(33.3);
    expect(acceptanceRatePercent(8, 6)).toBe(75);
    expect(acceptanceRatePercent(5, 5)).toBe(100);
    expect(acceptanceRatePercent(5, 0)).toBe(0);
    expect(acceptanceRateBps(3, 2)).toBe(6667);
  });

  it('does not turn a corrupt counter into NaN', () => {
    expect(acceptanceRatePercent(Number.NaN, 3)).toBeNull();
    expect(acceptanceRatePercent(4, Number.NaN)).toBe(0);
  });
});
