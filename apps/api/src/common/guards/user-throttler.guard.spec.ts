import { UserThrottlerGuard } from './user-throttler.guard';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * The default ThrottlerGuard buckets by IP. That is wrong for every
 * authenticated endpoint in this product, because every rider on campus Wi-Fi
 * leaves through one NAT address — so one rider tapping "accept" would consume
 * the allowance for the whole college, and the endpoint would start refusing
 * riders exactly when several are competing for offers.
 *
 * These tests exist because that failure only appears under load, which is the
 * worst time to discover it.
 */
describe('UserThrottlerGuard', () => {
  // The guard's constructor wants Nest internals it does not use for
  // tracking, so the tracker is exercised directly.
  const guard = Object.create(UserThrottlerGuard.prototype) as UserThrottlerGuard & {
    getTracker(req: Record<string, unknown>): Promise<string>;
  };

  const rider = (id: string): AuthenticatedUser => ({
    userId: id,
    collegeId: 'college-a',
    role: 'STUDENT',
    isVerified: true,
  });

  it('buckets an authenticated request by user, not by address', async () => {
    const tracker = await guard.getTracker({
      user: rider('rider-1'),
      ip: '10.0.0.7',
    });
    expect(tracker).toBe('user:rider-1');
  });

  it('gives two riders behind one NAT address separate buckets', async () => {
    // The whole point: same IP, different allowances.
    const a = await guard.getTracker({ user: rider('rider-1'), ip: '10.0.0.7' });
    const b = await guard.getTracker({ user: rider('rider-2'), ip: '10.0.0.7' });
    expect(a).not.toBe(b);
  });

  it('falls back to the address when there is no user yet', async () => {
    // Login, OTP issue and password reset have no user, and there the IP is
    // the actor — sharing a bucket is correct.
    const tracker = await guard.getTracker({ ip: '203.0.113.9' });
    expect(tracker).toBe('ip:203.0.113.9');
  });

  it('prefers the forwarded client address over the proxy address', async () => {
    const tracker = await guard.getTracker({
      ips: ['203.0.113.9', '10.0.0.1'],
      ip: '10.0.0.1',
    });
    // Without this, every request would share the load balancer's address and
    // the unauthenticated fallback would be useless.
    expect(tracker).toBe('ip:203.0.113.9');
  });

  it('still produces a key when it has nothing to go on', async () => {
    const tracker = await guard.getTracker({});
    expect(tracker).toBe('ip:unknown');
  });
});
