/**
 * Turn an untrusted `?limit=` query string into a usable page size.
 *
 * `Number('abc')` is NaN, and Prisma's `take: NaN + 1` is a 500; a very large
 * number is an unbounded read. Anything that is not a whole number becomes
 * the default, and everything else is clamped to 1..max.
 */
export function clampPageLimit(
  raw: string | number | undefined | null,
  fallback = 25,
  max = 100,
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(1, parsed));
}
