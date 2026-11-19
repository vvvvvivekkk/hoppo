import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Rate limiting keyed on the authenticated user, not the IP address.
 *
 * The default ThrottlerGuard buckets by IP, which is the right choice for
 * endpoints where there is no user yet — login, OTP issue, password reset —
 * because there the IP *is* the actor and sharing a bucket is the point.
 *
 * It is the wrong choice for everything behind authentication here, because
 * of where this product runs. Every rider on campus Wi-Fi leaves through one
 * NAT address. Bucketing by IP means one rider tapping "accept" a few times
 * consumes the allowance for every other rider at that college — so the
 * busiest moment, when several riders are competing for offers, is exactly
 * when the endpoint starts refusing them. The symptom would be riders unable
 * to accept tasks with no error they could act on, and it would only appear
 * under load.
 *
 * So: authenticated requests are bucketed per user id, unauthenticated ones
 * per IP.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as AuthenticatedUser | undefined;

    if (user?.userId) return `user:${user.userId}`;

    // Fall back to the IP. Behind a proxy this needs `trust proxy` set, which
    // main.ts does — otherwise every request would share the load balancer's
    // address and the fallback would be useless.
    const ips = req.ips as string[] | undefined;
    const ip = req.ip as string | undefined;
    return `ip:${ips?.length ? ips[0] : (ip ?? 'unknown')}`;
  }
}
