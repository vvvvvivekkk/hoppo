import { clampPageLimit } from '../common/pagination';
import { MY_ORDERS_DEFAULT_LIMIT } from './orders.service';

/**
 * The page size of GET /orders, as the controller and the service compute it:
 * the shared clamp from src/common/pagination with this list's own default.
 */
const limitFor = (raw: string | number | undefined) =>
  clampPageLimit(raw, MY_ORDERS_DEFAULT_LIMIT);

describe('my-orders page limit', () => {
  it('defaults to 30, not the shared helper default', () => {
    expect(MY_ORDERS_DEFAULT_LIMIT).toBe(30);
    expect(limitFor(undefined)).toBe(30);
    expect(limitFor('')).toBe(30);
  });

  it('defaults on anything that is not a number, rather than passing NaN to the query', () => {
    expect(limitFor('abc')).toBe(30);
    expect(limitFor('Infinity')).toBe(30);
    expect(limitFor(Number.NaN)).toBe(30);
  });

  it('caps a huge request at the maximum', () => {
    expect(limitFor('999999999')).toBe(100);
    expect(limitFor('101')).toBe(100);
  });

  it('raises zero and negatives to one', () => {
    expect(limitFor('0')).toBe(1);
    expect(limitFor('-5')).toBe(1);
  });

  it('keeps an in-range whole number', () => {
    expect(limitFor('1')).toBe(1);
    expect(limitFor('30')).toBe(30);
    expect(limitFor('100')).toBe(100);
  });

  // The shared helper treats a fraction as unusable input. The helper this
  // replaced truncated it (12.9 -> 12); either is safe, one rule is better.
  it('falls back to the default on a fraction', () => {
    expect(limitFor('12.9')).toBe(30);
  });
});
