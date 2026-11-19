/**
 * Money handling.
 *
 * Every amount in this system is an integer number of paise — the smallest
 * unit of the currency. ₹120.50 is stored and passed around as 12050.
 *
 * The reason is that computers cannot represent 0.1 exactly in binary, the
 * same way you cannot write 1/3 exactly in decimal. Add 0.1 to itself ten
 * times in JavaScript and you get 0.9999999999999999, not 1. Do that to
 * money and the books stop balancing. Integers have no such problem, so all
 * arithmetic happens in paise and the conversion to rupees happens once, at
 * the very edge, purely for display.
 *
 * FR-PAY-07.
 */

/** A whole number of paise. 100 minor units = ₹1. */
export type Minor = number;

export const MINOR_UNITS_PER_RUPEE = 100;

/** Rupees as entered by a human (e.g. 120.5) into paise (12050). */
export function rupeesToMinor(rupees: number): Minor {
  return Math.round(rupees * MINOR_UNITS_PER_RUPEE);
}

/** Paise (12050) into rupees as a number (120.5). For display only. */
export function minorToRupees(minor: Minor): number {
  return minor / MINOR_UNITS_PER_RUPEE;
}

/** Paise into a display string: 12050 becomes "₹120.50". */
export function formatMinor(minor: Minor, withSymbol = true): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / MINOR_UNITS_PER_RUPEE);
  const fraction = abs % MINOR_UNITS_PER_RUPEE;

  // Indian digit grouping: 1,23,456 rather than 123,456.
  const grouped = groupIndian(whole);
  const body = `${grouped}.${String(fraction).padStart(2, '0')}`;

  return `${negative ? '-' : ''}${withSymbol ? '₹' : ''}${body}`;
}

function groupIndian(value: number): string {
  const s = String(value);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  // Every two digits from the right, in the part before the final three.
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/**
 * Apply a rate expressed in basis points. 1 basis point = 0.01%, so
 * 1000 bps = 10%. Rates are stored as integer basis points for the same
 * reason amounts are stored as integers.
 *
 * Rounds half-up, which is what an invoice reader expects.
 */
export function applyBps(minor: Minor, bps: number): Minor {
  return Math.round((minor * bps) / 10_000);
}

/** Sum a list of amounts. Present so no call site reaches for reduce on floats. */
export function sumMinor(values: readonly Minor[]): Minor {
  return values.reduce((total, v) => total + v, 0);
}

/** Guard for values crossing a trust boundary (request bodies, webhooks). */
export function isValidMinor(value: unknown): value is Minor {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
