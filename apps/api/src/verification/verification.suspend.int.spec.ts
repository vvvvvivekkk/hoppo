import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { VerificationService } from './verification.service';
import { AuditService } from '../audit/audit.service';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * FR-SVER-08 against a real PostgreSQL.
 *
 * suspend() releases the rider's task with raw SQL, so a mocked Prisma proves
 * nothing about it: the statements, the column names and the CHECK constraint
 * (`task_rider_presence_matches_status`) only exist in the database. This
 * spec runs the real statements.
 *
 * Nothing it writes survives. Each test opens one interactive transaction,
 * builds its own rows inside it, runs suspend() on that same transaction, and
 * rolls back by throwing. The only rows it reads that it did not create are
 * one ACTIVE college (any will do) to hang the fixtures on.
 *
 * It needs the development database (DATABASE_URL, from the environment or
 * apps/api/.env). Without one it fails rather than skipping: a suspension
 * test that silently did not run is how this code went untested before.
 */
function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [join(process.cwd(), '.env'), join(process.cwd(), '..', '..', '.env')]) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const match = /^DATABASE_URL=["']?([^"'\r\n]+)["']?\s*$/m.exec(text);
    if (match) return match[1];
  }
  throw new Error('DATABASE_URL is not set and no .env provides it; this spec needs PostgreSQL');
}

class Rollback extends Error {}

const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });

afterAll(async () => {
  await db.$disconnect();
});

type Tx = Prisma.TransactionClient;

interface World {
  tx: Tx;
  service: VerificationService;
  admin: AuthenticatedUser;
  riderId: string;
  requesterId: string;
  collegeId: string;
  auth: { revokeAllSessions: jest.Mock };
  redis: { removeRider: jest.Mock };
  gateway: { disconnectUser: jest.Mock; notifyTaskStatus: jest.Mock };
  /** A peer-errand task held by the rider in the given state, with its chat room. */
  heldTask(status: 'ASSIGNED' | 'PICKED_UP'): Promise<{ taskId: string; roomId: string }>;
}

/** Run `body` inside a transaction that is always rolled back. */
async function inRolledBackTransaction(body: (world: World) => Promise<void>): Promise<void> {
  let finished = false;

  const attempt = db.$transaction(
    async (tx) => {
      const college = await tx.college.findFirst({
        where: { status: 'ACTIVE' },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      if (!college) throw new Error('The database has no ACTIVE college to attach fixtures to');

      const tag = randomUUID().slice(0, 12);
      const person = (role: 'STUDENT' | 'ADMIN', n: number) =>
        tx.user.create({
          data: {
            collegeId: college.id,
            role,
            name: `A5 suspend spec ${role} ${n}`,
            // Unique per run, and never a dialable number.
            mobile: `+9990${tag.replace(/\D/g, '').padEnd(6, '0').slice(0, 6)}${n}${Date.now() % 1000}`,
            email: `a5-suspend-${tag}-${n}@example.test`,
            passwordHash: 'not-a-real-hash',
          },
          select: { id: true },
        });

      const rider = await person('STUDENT', 1);
      const requester = await person('STUDENT', 2);
      const adminUser = await person('ADMIN', 3);
      await tx.riderState.create({ data: { userId: rider.id, workModeOn: true } });

      // The service sees the open transaction as its whole database: its own
      // `$transaction(fn)` becomes "run fn on this transaction".
      const prisma = new Proxy(tx as object, {
        get(target, prop, receiver) {
          if (prop === '$transaction') return (fn: (client: Tx) => Promise<unknown>) => fn(tx);
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });

      const auth = { revokeAllSessions: jest.fn().mockResolvedValue(0) };
      const redis = { removeRider: jest.fn().mockResolvedValue(undefined) };
      const gateway = { disconnectUser: jest.fn(), notifyTaskStatus: jest.fn() };
      const audit = new AuditService(prisma as never);

      const Ctor = VerificationService as unknown as new (
        ...args: unknown[]
      ) => VerificationService;
      const service = new Ctor(prisma, redis, audit, auth, new TenantService(), gateway);

      const heldTask: World['heldTask'] = async (status) => {
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
            // Escalated twice before it was accepted.
            feeMinor: 3500,
            broadcastRound: 2,
            currentProximityM: 1500,
            assignedAt: new Date(),
            pickedUpAt: status === 'PICKED_UP' ? new Date() : null,
          },
          select: { id: true },
        });
        await tx.riderState.update({
          where: { userId: rider.id },
          data: { activeTaskId: task.id },
        });
        const room = await tx.chatRoom.create({
          data: {
            collegeId: college.id,
            type: 'TASK',
            taskId: task.id,
            members: { create: [{ userId: requester.id }, { userId: rider.id }] },
          },
          select: { id: true },
        });
        return { taskId: task.id, roomId: room.id };
      };

      await body({
        tx,
        service,
        admin: { userId: adminUser.id, collegeId: college.id, role: 'ADMIN', isVerified: false },
        riderId: rider.id,
        requesterId: requester.id,
        collegeId: college.id,
        auth,
        redis,
        gateway,
        heldTask,
      });

      finished = true;
      throw new Rollback();
    },
    { timeout: 20_000, maxWait: 10_000 },
  );

  // The transaction always ends by throwing. Rollback is the expected way;
  // anything else (a failed assertion in the body, a database error) is
  // rethrown as itself so the report shows what actually went wrong.
  let outcome: unknown = null;
  try {
    await attempt;
  } catch (error) {
    outcome = error;
  }
  if (!(outcome instanceof Rollback)) throw outcome ?? new Error('The transaction committed');
  // Guards against a body that never ran to its end being read as a pass.
  expect(finished).toBe(true);
}

describe('VerificationService.suspend against PostgreSQL', () => {
  jest.setTimeout(30_000);

  it('returns an ASSIGNED task to the pool where the dispatcher will find it', async () => {
    await inRolledBackTransaction(async (w) => {
      const { taskId, roomId } = await w.heldTask('ASSIGNED');

      const result = await w.service.suspend(w.admin, w.riderId, { reason: 'Forged ID card' });

      const task = await w.tx.task.findUniqueOrThrow({ where: { id: taskId } });
      // Not BROADCASTING-with-no-expiry, which neither dispatcher tick matches.
      expect(task.status).toBe('CREATED');
      expect(task.riderId).toBeNull();
      expect(task.assignedAt).toBeNull();
      expect(task.dispatchDueAt).toBeInstanceOf(Date);
      expect(task.dispatchDueAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(task.offerExpiresAt).toBeNull();
      // R-08: a fresh search — round 0, base fee, no widened radius.
      expect(task.broadcastRound).toBe(0);
      expect(task.feeMinor).toBe(2000);
      expect(task.currentProximityM).toBeNull();

      // The dispatcher's "due" query, as a statement of "not stranded".
      const due = await w.tx.task.findMany({
        where: {
          id: taskId,
          status: 'CREATED',
          dispatchDueAt: { lte: new Date(Date.now() + 1000) },
        },
        select: { id: true },
      });
      expect(due).toEqual([{ id: taskId }]);

      const state = await w.tx.riderState.findUniqueOrThrow({ where: { userId: w.riderId } });
      expect(state.workModeOn).toBe(false);
      expect(state.activeTaskId).toBeNull();

      const account = await w.tx.user.findUniqueOrThrow({ where: { id: w.riderId } });
      expect(account.status).toBe('SUSPENDED');

      // The task room was for this rider: archived, and the rider has left it.
      const room = await w.tx.chatRoom.findUniqueOrThrow({ where: { id: roomId } });
      expect(room.isArchived).toBe(true);
      expect(room.archivedAt).toBeInstanceOf(Date);
      const members = await w.tx.chatMember.findMany({ where: { roomId } });
      const left = Object.fromEntries(members.map((m) => [m.userId, m.leftAt !== null]));
      expect(left).toEqual({ [w.riderId]: true, [w.requesterId]: false });

      // The audit row names the task, and is part of the same transaction.
      const audit = await w.tx.auditLog.findFirstOrThrow({
        where: { targetId: w.riderId, action: 'STUDENT_SUSPENDED' },
      });
      expect(audit.detail).toMatchObject({ reason: 'Forged ID card', releasedTaskId: taskId });

      expect(result).toMatchObject({ status: 'SUSPENDED', taskReleased: taskId });
      expect(w.auth.revokeAllSessions).toHaveBeenCalledWith(w.riderId);
      expect(w.redis.removeRider).toHaveBeenCalledWith(w.collegeId, w.riderId);
      expect(w.gateway.disconnectUser).toHaveBeenCalledWith(w.riderId);
      // The requester is told; the suspended rider (now detached) is not.
      expect(w.gateway.notifyTaskStatus).toHaveBeenCalledWith([w.requesterId], taskId, 'CREATED', {
        reason: 'RIDER_REMOVED',
      });
    });
  });

  it('escalates a task already picked up, keeping the rider on record', async () => {
    await inRolledBackTransaction(async (w) => {
      const { taskId, roomId } = await w.heldTask('PICKED_UP');

      await w.service.suspend(w.admin, w.riderId, { reason: 'Reported for theft' });

      const task = await w.tx.task.findUniqueOrThrow({ where: { id: taskId } });
      expect(task.status).toBe('ESCALATED');
      // Whoever has the goods must stay identifiable (and the CHECK requires it).
      expect(task.riderId).toBe(w.riderId);
      expect(task.escalatedAt).toBeInstanceOf(Date);
      expect(task.resolutionNote).toBe('Rider suspended mid-delivery: Reported for theft');
      // Untouched: it is not going back on offer.
      expect(task.feeMinor).toBe(3500);
      expect(task.dispatchDueAt).toBeNull();

      const state = await w.tx.riderState.findUniqueOrThrow({ where: { userId: w.riderId } });
      expect(state).toMatchObject({ workModeOn: false, activeTaskId: null });

      // The room stays open: the requester and an administrator still need it.
      const room = await w.tx.chatRoom.findUniqueOrThrow({ where: { id: roomId } });
      expect(room.isArchived).toBe(false);

      expect(w.gateway.notifyTaskStatus).toHaveBeenCalledWith(
        [w.requesterId],
        taskId,
        'ESCALATED',
        {
          reason: 'RIDER_SUSPENDED',
        },
      );
    });
  });

  it('finds the held task by rider_id even when rider_state does not point at it', async () => {
    await inRolledBackTransaction(async (w) => {
      const { taskId } = await w.heldTask('ASSIGNED');
      // The stale-read case: rider_state says "no task" (as it would for a
      // suspension that read it a moment before the rider accepted).
      await w.tx.riderState.update({ where: { userId: w.riderId }, data: { activeTaskId: null } });

      await w.service.suspend(w.admin, w.riderId, { reason: 'Forged ID card' });

      const task = await w.tx.task.findUniqueOrThrow({ where: { id: taskId } });
      expect(task.status).toBe('CREATED');
      expect(task.riderId).toBeNull();
    });
  });

  it('suspends a rider who holds nothing without touching any task', async () => {
    await inRolledBackTransaction(async (w) => {
      const result = await w.service.suspend(w.admin, w.riderId, { reason: 'Forged ID card' });

      expect(result).toMatchObject({ status: 'SUSPENDED', taskReleased: null });
      expect(w.gateway.notifyTaskStatus).not.toHaveBeenCalled();
      expect(w.gateway.disconnectUser).toHaveBeenCalledWith(w.riderId);
      const account = await w.tx.user.findUniqueOrThrow({ where: { id: w.riderId } });
      expect(account.status).toBe('SUSPENDED');
    });
  });
});
