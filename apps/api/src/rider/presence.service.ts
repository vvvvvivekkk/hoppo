import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { presenceHour } from '../dispatch/rider-presence';

const HOUR_MS = 3_600_000;

/** The longest range one request may ask for: 92 days of hours is 2,208 points. */
export const MAX_PRESENCE_RANGE_HOURS = 92 * 24;

/**
 * FR-ADM-05: "active riders by hour", for the administrator's dashboard.
 *
 * Reads `rider_presence_hour`, which holds one row per rider per clock hour
 * in which they were online and heard from (written by
 * `recordRiderPresence`). The answer is counts only — never who: it is a
 * per-person record of when a student was working, and a supply chart has no
 * need of names.
 */
@Injectable()
export class RiderPresenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
  ) {}

  async byHour(user: AuthenticatedUser, fromIso: string, toIso: string) {
    // Whole clock hours: the range is widened outwards to hour boundaries, so
    // an hour that is partly asked for is wholly answered.
    const from = presenceHour(new Date(fromIso));
    const toInstant = new Date(toIso);
    const to =
      presenceHour(toInstant).getTime() === toInstant.getTime()
        ? toInstant
        : new Date(presenceHour(toInstant).getTime() + HOUR_MS);

    const hoursAsked = (to.getTime() - from.getTime()) / HOUR_MS;

    if (!(hoursAsked > 0)) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: '`to` must be later than `from`.',
      });
    }
    if (hoursAsked > MAX_PRESENCE_RANGE_HOURS) {
      throw new BadRequestException({
        code: 'RANGE_TOO_LONG',
        message: `Ask for at most ${MAX_PRESENCE_RANGE_HOURS / 24} days at a time.`,
      });
    }

    // C-1: an ADMIN is pinned to their own college; nobody writes
    // `collegeId` by hand. A super administrator sees every college summed.
    const scope = this.tenant.scope(user);
    const inRange = { ...scope, hourStart: { gte: from, lt: to } };

    const [perHour, riders, earliest] = await Promise.all([
      this.prisma.riderPresenceHour.groupBy({
        by: ['hourStart'],
        where: inRange,
        _count: { userId: true },
      }),
      // (user_id, hour_start) is the primary key, so one group per rider is a
      // count of distinct riders.
      this.prisma.riderPresenceHour.groupBy({ by: ['userId'], where: inRange }),
      this.prisma.riderPresenceHour.findFirst({
        where: scope,
        orderBy: { hourStart: 'asc' },
        select: { hourStart: true },
      }),
    ]);

    const counts = new Map(perHour.map((row) => [row.hourStart.getTime(), row._count.userId]));

    // Every hour of the range, in order, zero where nobody was online — a
    // chart needs the gaps, and a missing hour and an empty one must not
    // look alike to it.
    const hours = Array.from({ length: hoursAsked }, (_, i) => {
      const hourStart = new Date(from.getTime() + i * HOUR_MS);
      return { hourStart, activeRiders: counts.get(hourStart.getTime()) ?? 0 };
    });

    const peak = hours.reduce<{ hourStart: Date; activeRiders: number } | null>(
      (best, hour) => (hour.activeRiders > (best?.activeRiders ?? 0) ? hour : best),
      null,
    );

    return {
      from,
      to,
      // Presence has only been recorded since the table existed. An hour
      // before this is "not recorded", which is not the same as "nobody was
      // online" — null when nothing has ever been recorded for the college.
      recordedSince: earliest?.hourStart ?? null,
      hours,
      distinctRiders: riders.length,
      peak,
    };
  }
}
