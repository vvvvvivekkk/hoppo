import { randomBytes } from 'node:crypto';
import { ORDER_REFERENCE_LENGTH, ORDER_REFERENCE_PREFIX } from '@hoppo/shared';

/**
 * The order reference is read aloud across a counter — "order HP-7F3K2MP" —
 * so the alphabet deliberately excludes characters that sound or look alike.
 *
 * Mirrors OrdersService.generateReference. Kept as its own test because the
 * properties checked here are about the alphabet and the arithmetic, not about
 * the service.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateReference(): string {
  const bytes = randomBytes(ORDER_REFERENCE_LENGTH);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${ORDER_REFERENCE_PREFIX}-${out}`;
}

/**
 * Probability that at least one collision occurs among `n` draws from a space
 * of `space` — the standard birthday result, computed properly rather than
 * with the n²/2N approximation. That approximation only holds while n² is far
 * smaller than the space, and relying on it is what hid an undersized
 * reference here in the first place.
 */
function anyCollisionProbability(n: number, space: number): number {
  return 1 - Math.exp(-(n * (n - 1)) / (2 * space));
}

/**
 * Probability that *one* insert collides, given `existing` references already
 * stored.
 *
 * This is the number that actually matters. "Will any collision ever happen"
 * is the wrong question for a space reused indefinitely — over enough orders
 * the answer is always yes, and that is fine, because a collision is a unique
 * constraint violation and the service retries. What matters is whether that
 * retry is cold code or a hot path.
 */
function perInsertCollisionProbability(existing: number, space: number): number {
  return existing / space;
}

describe('order reference', () => {
  it('has the expected shape', () => {
    expect(generateReference()).toMatch(
      new RegExp(`^${ORDER_REFERENCE_PREFIX}-[A-Z2-9]{${ORDER_REFERENCE_LENGTH}}$`),
    );
  });

  it('never contains a character that is ambiguous when spoken or read', () => {
    // O/0 and I/1 are the classic confusions at a noisy counter.
    const forbidden = /[OI01]/;
    expect(ALPHABET).not.toMatch(forbidden);
    for (let i = 0; i < 2000; i += 1) {
      const body = generateReference().slice(ORDER_REFERENCE_PREFIX.length + 1);
      expect(body).not.toMatch(forbidden);
    }
  });

  it('maps random bytes to the alphabet without modulo bias', () => {
    // 256 is exactly 8 x 32, so every character is equally likely. With a
    // 30-character alphabet the first 16 would come up slightly more often —
    // harmless for readability, a bad habit in code that also generates
    // credentials.
    expect(256 % ALPHABET.length).toBe(0);
  });

  /**
   * Deliberately *not* "N references never collide". The space is finite, so
   * that assertion is flaky by construction — written that way first, it
   * failed about one run in three.
   */
  it('keeps the collision retry cold at platform scale', () => {
    const space = ALPHABET.length ** ORDER_REFERENCE_LENGTH;
    expect(space).toBe(34_359_738_368);

    // Ten colleges placing 200 orders a day each, over five years.
    const storedReferences = 73_000 * 10 * 5;

    // Roughly one insert in ten thousand collides, so the retry stays cold.
    const perInsert = perInsertCollisionProbability(storedReferences, space);
    expect(perInsert).toBeLessThan(0.0002);

    // Three consecutive collisions is where the retry gives up. Past one in a
    // trillion, which is why there are three attempts and no fourth branch.
    expect(perInsert ** 3).toBeLessThan(1e-11);
  });

  it('shows why five characters was not enough', () => {
    // Kept as a test rather than a comment, because this arithmetic is the
    // whole reason the length changed and a future reader may be tempted to
    // shorten it again for readability.
    const fiveCharSpace = ALPHABET.length ** 5;
    const storedReferences = 73_000 * 10 * 5;

    // More than one insert in ten would have collided — a hot retry path, on
    // a space of only 33.5 million slots.
    expect(perInsertCollisionProbability(storedReferences, fiveCharSpace)).toBeGreaterThan(
      0.1,
    );

    // And within a single college-year, a collision was near-certain rather
    // than unlikely. The original test asserted zero collisions in 5,000
    // draws, which is why it flaked.
    expect(anyCollisionProbability(73_000, fiveCharSpace)).toBeGreaterThan(0.99);
  });

  it('produces different references on consecutive calls', () => {
    const a = generateReference();
    const b = generateReference();
    expect(a).not.toBe(b);
  });
});
