import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

const logger = new Logger('RiderPresence');

const HOUR_MS = 3_600_000;

/**
 * The start of the clock hour containing `at`, in UTC: minutes, seconds and
 * milliseconds all zero.
 *
 * Arithmetic on the epoch rather than `setMinutes(0, 0, 0)`, which works in
 * the server's local zone — and India is UTC+5:30, so a "local hour" starts
 * on the half hour in UTC. The table has a CHECK that refuses anything not
 * exactly on a UTC hour; this is the one place that value is made.
 */
export function presenceHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * FR-ADM-05, "active riders by hour": note that this rider was online, and
 * heard from, in the current clock hour.
 *
 * One row per rider per hour, in `rider_presence_hour`. "Active" means the
 * same thing dispatch means by eligible (L4): work mode on *and the device
 * actually reporting* — so this is called when a rider goes online and when
 * a ping arrives, never from a timer that would count a rider who went online
 * and closed the app.
 *
 * **Idempotent under any concurrency.** The table's primary key is
 * (user_id, hour_start) and this is one INSERT … ON CONFLICT DO NOTHING
 * (`createMany` with `skipDuplicates`). A socket ping and an HTTP ping in the
 * same instant, two API instances, a reconnect: the first insert writes the
 * row and every other is skipped by the database. There is no read first, so
 * nothing to race.
 *
 * It records that the rider was present, and nothing else — no position
 * (FR-PRIV-02 keeps a rider's location to the requester of their current
 * task; a presence history must not become a location history) and no
 * duration.
 *
 * Never throws. Presence is a statistic; a rider's ping, or going online,
 * must not fail because a dashboard's table could not be written.
 */
export async function recordRiderPresence(
  prisma: Pick<PrismaService, 'riderPresenceHour'>,
  collegeId: string,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  try {
    await prisma.riderPresenceHour.createMany({
      data: [{ collegeId, userId, hourStart: presenceHour(at) }],
      skipDuplicates: true,
    });
  } catch (error) {
    logger.warn(
      `Could not record presence for rider ${userId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
