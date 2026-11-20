import { PrismaClient } from '@prisma/client';
import { VerificationService } from './verification.service';
import { AuditService } from '../audit/audit.service';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  type Tx,
  databaseUrl,
  inRolledBackTransaction,
  makeCollege,
  makeUser,
  prismaOver,
} from '../common/testing/rolled-back-transaction';

/**
 * Suspending a rider starts a fresh search for the task they held, and a
 * fresh search is a new broadcast cycle.
 *
 * `broadcast_log` is unique on (task_id, cycle, round). The new search begins
 * again at round 1, so unless the suspension advances `task.broadcast_cycle`
 * in the statement that returns the task to the pool, its round 1 collides
 * with the round-1 row of the search the suspended rider won — and the new
 * search's rounds go unrecorded. PostgreSQL, rolled back.
 */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

async function world(tx: Tx) {
  const college = await makeCollege(tx, `${Date.now()}-${Math.round(Math.random() * 1e6)}`);
  const adminRow = await makeUser(tx, college.id, 'ADMIN');
  const rider = await makeUser(tx, college.id, 'STUDENT');
  const requester = await makeUser(tx, college.id, 'STUDENT');
  await tx.riderState.create({ data: { userId: rider.id, workModeOn: true } });

  const heldTask = async (status: 'ASSIGNED' | 'PICKED_UP', broadcastCycle: number) => {
    const task = await tx.task.create({
      data: {
        collegeId: college.id,
        type: 'PEER_ERRAND',
        status,
        requesterId: requester.id,
        riderId: rider.id,
        pickupLabel: 'Library',
        pickupLatitude: 17.3045,
        pickupLongitude: 78.6188,
        dropLabel: 'Hostel B',
        dropLatitude: 17.305,
        dropLongitude: 78.619,
        distanceM: 400,
        baseFeeMinor: 2000,
        feeMinor: 2500,
        broadcastRound: 1,
        broadcastCycle,
        assignedAt: new Date(),
        pickedUpAt: status === 'PICKED_UP' ? new Date() : null,
      },
      select: { id: true },
    });
    // The search the rider won: round 1 of the task's current cycle.
    await tx.broadcastLog.create({
      data: {
        taskId: task.id,
        cycle: broadcastCycle,
        round: 1,
        radiusM: 1500,
        feeMinor: 2500,
        eligibleCount: 3,
        outcome: 'ACCEPTED',
        acceptedByUserId: rider.id,
        resolvedAt: new Date(),
      },
    });
    return task.id;
  };

  const prisma = prismaOver(tx) as never;
  const Ctor = VerificationService as unknown as new (...args: unknown[]) => VerificationService;
  const service = new Ctor(
    prisma,
    { removeRider: jest.fn().mockResolvedValue(undefined) },
    new AuditService(prisma),
    { revokeAllSessions: jest.fn().mockResolvedValue(0) },
    new TenantService(),
    { disconnectUser: jest.fn(), notifyTaskStatus: jest.fn() },
  );
  const admin: AuthenticatedUser = {
    userId: adminRow.id,
    collegeId: college.id,
    role: 'ADMIN',
    isVerified: false,
  };
  return { service, admin, rider, heldTask };
}

describe('suspending a rider advances the broadcast cycle of the task returned to the pool', () => {
  jest.setTimeout(30_000);

  it('an ASSIGNED task goes back to CREATED in the next cycle, round 0', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const taskId = await w.heldTask('ASSIGNED', 3);

      await w.service.suspend(w.admin, w.rider.id, { reason: 'Forged ID card' });

      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      expect(task.status).toBe('CREATED');
      expect(task.riderId).toBeNull();
      expect(task.broadcastRound).toBe(0);
      // One more than before — not reset to 1, not left at 3.
      expect(task.broadcastCycle).toBe(4);
    });
  });

  it("the new search's round 1 is recorded beside the old search's, not on top of it", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const taskId = await w.heldTask('ASSIGNED', 1);

      await w.service.suspend(w.admin, w.rider.id, { reason: 'Forged ID card' });

      // What the dispatcher does next: round 1 of the task's current cycle.
      // Raw SQL with ON CONFLICT DO NOTHING, so that a collision shows up as
      // "no row inserted" rather than as an aborted transaction.
      const inserted = await tx.$executeRaw`
        INSERT INTO broadcast_log (id, task_id, cycle, round, radius_m, fee_minor, eligible_count)
        SELECT gen_random_uuid(), t.id, t.broadcast_cycle, 1, 1500, t.fee_minor, 2
        FROM task t WHERE t.id = ${taskId}
        ON CONFLICT (task_id, cycle, round) DO NOTHING
      `;
      expect(inserted).toBe(1);

      const rows = await tx.broadcastLog.findMany({
        where: { taskId },
        orderBy: { cycle: 'asc' },
        select: { cycle: true, round: true, outcome: true, acceptedByUserId: true },
      });
      expect(rows).toEqual([
        // The search the suspended rider won, untouched.
        { cycle: 1, round: 1, outcome: 'ACCEPTED', acceptedByUserId: w.rider.id },
        // The fresh search.
        { cycle: 2, round: 1, outcome: 'PENDING', acceptedByUserId: null },
      ]);
    });
  });

  it('a task already picked up escalates and stays in its cycle: it is not searched for again', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const taskId = await w.heldTask('PICKED_UP', 2);

      await w.service.suspend(w.admin, w.rider.id, { reason: 'Reported for theft' });

      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      expect(task.status).toBe('ESCALATED');
      expect(task.broadcastCycle).toBe(2);
      expect(task.broadcastRound).toBe(1);
    });
  });
});
