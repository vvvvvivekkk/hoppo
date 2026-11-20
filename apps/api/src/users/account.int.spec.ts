import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';
import { AuditService } from '../audit/audit.service';
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
 * FR-PRIV-05 against PostgreSQL: export of the caller's own data, and
 * account deletion with its refusals. Rolled back; nothing persists.
 */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

const PASSWORD = 'correct horse battery';
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
});

async function world(tx: Tx) {
  const tag = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const college = await makeCollege(tx, tag);
  const me = await makeUser(tx, college.id, 'STUDENT', { passwordHash, name: 'Asha Mine' });
  const other = await makeUser(tx, college.id, 'STUDENT', { name: 'Ravi Other' });
  for (const u of [me, other]) {
    await tx.studentProfile.create({
      data: {
        userId: u.id,
        rollNumber: `ROLL-${u.id.slice(0, 6)}`,
        department: 'CSE',
        yearOfStudy: 3,
        idCardUrl: `id_card/${u.id}/card.jpg`,
        verificationStatus: 'VERIFIED',
      },
    });
    await tx.riderState.create({ data: { userId: u.id, workModeOn: true } });
  }

  const task = (requesterId: string, riderId: string | null, status: 'COMPLETED' | 'ASSIGNED') =>
    tx.task.create({
      data: {
        collegeId: college.id,
        type: 'PEER_ERRAND',
        status,
        requesterId,
        riderId,
        pickupLabel: `Pickup for ${requesterId.slice(0, 6)}`,
        pickupLatitude: 17.3,
        pickupLongitude: 78.6,
        dropLabel: 'Hostel',
        dropLatitude: 17.3,
        dropLongitude: 78.6,
        distanceM: 300,
        baseFeeMinor: 2000,
        feeMinor: 2000,
        assignedAt: riderId ? new Date() : null,
        completedAt: status === 'COMPLETED' ? new Date() : null,
      },
    });

  const auth = { revokeAllSessions: jest.fn().mockResolvedValue(1) };
  const redis = { removeRider: jest.fn().mockResolvedValue(undefined) };
  const storage = {
    deletePrivateObject: jest.fn().mockResolvedValue(true),
    deletePublicObject: jest.fn().mockResolvedValue(true),
    publicKeyFromUrl: (url: string | null) =>
      url ? (url.split('/hoppo-public/')[1] ?? null) : null,
  };
  const gateway = { disconnectUser: jest.fn() };
  const prisma = prismaOver(tx) as never;
  const service = new AccountService(
    prisma,
    redis as never,
    storage as never,
    new AuditService(prisma),
    auth as never,
    gateway as never,
  );
  const asUser = (u: { id: string }): AuthenticatedUser => ({
    userId: u.id,
    collegeId: college.id,
    role: 'STUDENT',
    isVerified: true,
  });

  return { service, college, me, other, task, auth, redis, storage, gateway, asUser };
}

describe('GET /account/export against PostgreSQL', () => {
  jest.setTimeout(30_000);

  it("returns the caller's own records and nobody else's", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const mineRequested = await w.task(w.me.id, w.other.id, 'COMPLETED');
      const mineDelivered = await w.task(w.other.id, w.me.id, 'COMPLETED');
      // A task between other people entirely.
      const notMine = await w.task(w.other.id, null, 'COMPLETED');
      await tx.verificationSubmission.create({
        data: {
          userId: w.me.id,
          collegeId: w.college.id,
          rollNumber: 'ROLL-ME',
          department: 'CSE',
          yearOfStudy: 3,
          idCardUrl: `id_card/${w.me.id}/submitted.jpg`,
          status: 'VERIFIED',
          decidedByUserId: w.other.id,
          decidedAt: new Date(),
        },
      });
      await tx.verificationSubmission.create({
        data: {
          userId: w.other.id,
          collegeId: w.college.id,
          rollNumber: 'ROLL-OTHER',
          department: 'ECE',
          yearOfStudy: 2,
          idCardUrl: `id_card/${w.other.id}/submitted.jpg`,
          status: 'VERIFIED',
        },
      });

      const data = await w.service.exportData(w.asUser(w.me));

      expect(data.formatVersion).toBe(1);
      expect(data.account).toMatchObject({ id: w.me.id, name: 'Asha Mine', mobile: w.me.mobile });
      expect(data.studentProfile).toMatchObject({ department: 'CSE', yearOfStudy: 3 });
      expect(data.tasksRequested.map((t) => t.id)).toEqual([mineRequested.id]);
      expect(data.tasksDelivered.map((t) => t.id)).toEqual([mineDelivered.id]);
      expect(data.verificationSubmissions.map((s) => s.rollNumber)).toEqual(['ROLL-ME']);

      // Nothing identifying anyone else, and no document keys, anywhere in it.
      const text = JSON.stringify(data);
      for (const forbidden of [
        w.other.id,
        w.other.mobile,
        w.other.email,
        'Ravi Other',
        'ROLL-OTHER',
        'id_card/',
        'passwordHash',
        w.me.passwordHash,
      ]) {
        expect(text).not.toContain(forbidden);
      }
      expect(text).not.toContain(notMine.id);

      // FR-ADM-06 does not require it, but an export is worth a trace.
      expect(
        await tx.auditLog.count({ where: { action: 'DATA_EXPORTED', targetId: w.me.id } }),
      ).toBe(1);
    });
  });
});

describe('POST /account/delete against PostgreSQL', () => {
  jest.setTimeout(30_000);

  it('refuses a wrong password and changes nothing', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      await expect(
        w.service.deleteAccount(w.asUser(w.me), 'not the password'),
      ).rejects.toMatchObject({ response: { code: 'PASSWORD_INCORRECT' } });

      const row = await tx.user.findUniqueOrThrow({ where: { id: w.me.id } });
      expect(row).toMatchObject({ status: 'ACTIVE', name: 'Asha Mine' });
    });
  });

  it('refuses while the user is delivering a task', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const held = await w.task(w.other.id, w.me.id, 'ASSIGNED');

      await expect(w.service.deleteAccount(w.asUser(w.me), PASSWORD)).rejects.toMatchObject({
        response: {
          code: 'ACTIVE_TASK_IN_PROGRESS',
          details: { taskIds: [held.id], orderIds: [] },
        },
      });
      expect((await tx.user.findUniqueOrThrow({ where: { id: w.me.id } })).status).toBe('ACTIVE');
    });
  });

  it('refuses while a task the user requested is still open', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const waiting = await w.task(w.me.id, w.other.id, 'ASSIGNED');

      await expect(w.service.deleteAccount(w.asUser(w.me), PASSWORD)).rejects.toMatchObject({
        response: { code: 'ACTIVE_TASK_IN_PROGRESS', details: { taskIds: [waiting.id] } },
      });
    });
  });

  it('refuses while the wallet holds a balance', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      await tx.walletEntry.create({
        data: {
          userId: w.me.id,
          direction: 'CREDIT',
          amountMinor: 2500,
          type: 'ADJUSTMENT',
          balanceAfterMinor: 2500,
          note: 'spec',
        },
      });

      await expect(w.service.deleteAccount(w.asUser(w.me), PASSWORD)).rejects.toMatchObject({
        response: { code: 'WALLET_BALANCE_NOT_ZERO', details: { balanceMinor: 2500 } },
      });
      expect((await tx.user.findUniqueOrThrow({ where: { id: w.me.id } })).status).toBe('ACTIVE');
    });
  });

  it('refuses while a withdrawal is waiting to be paid', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      await tx.withdrawalRequest.create({
        data: { userId: w.me.id, amountMinor: 10000, status: 'REQUESTED' },
      });

      await expect(w.service.deleteAccount(w.asUser(w.me), PASSWORD)).rejects.toMatchObject({
        response: { code: 'WITHDRAWAL_PENDING' },
      });
    });
  });

  it('erases the person and keeps the transaction records', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const done = await w.task(w.me.id, w.other.id, 'COMPLETED');
      const decided = await tx.verificationSubmission.create({
        data: {
          userId: w.me.id,
          collegeId: w.college.id,
          rollNumber: 'ROLL-ME',
          department: 'CSE',
          yearOfStudy: 3,
          idCardUrl: `id_card/${w.me.id}/decided.jpg`,
          govtIdLast4: '1234',
          govtIdImageUrl: `govt_id/${w.me.id}/img.jpg`,
          govtIdImageExpiresAt: new Date(Date.now() + 86_400_000),
          status: 'VERIFIED',
          decidedAt: new Date(),
        },
      });
      const pending = await tx.verificationSubmission.create({
        data: {
          userId: w.me.id,
          collegeId: w.college.id,
          rollNumber: 'ROLL-ME',
          department: 'CSE',
          yearOfStudy: 3,
          idCardUrl: `id_card/${w.me.id}/pending.jpg`,
          status: 'PENDING',
        },
      });
      await tx.refreshToken.create({
        data: {
          userId: w.me.id,
          tokenHash: `spec-${w.me.id}`,
          familyId: w.me.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const { mobile, email } = w.me;

      const result = await w.service.deleteAccount(w.asUser(w.me), PASSWORD);

      expect(result.status).toBe('DEACTIVATED');

      const row = await tx.user.findUniqueOrThrow({ where: { id: w.me.id } });
      expect(row.status).toBe('DEACTIVATED');
      expect(row.name).toBe('Deleted user');
      expect(row.mobile).toBe(`deleted-${w.me.id}`);
      expect(row.email).toBe(`deleted-${w.me.id}@deleted.invalid`);
      expect(row.avatarUrl).toBeNull();
      expect(row.passwordHash).not.toBe(passwordHash);
      // The number and address are free for a new registration.
      expect(await tx.user.count({ where: { OR: [{ mobile }, { email }] } })).toBe(0);

      const profile = await tx.studentProfile.findUniqueOrThrow({ where: { userId: w.me.id } });
      expect(profile).toMatchObject({
        rollNumber: '',
        department: '',
        idCardUrl: null,
        govtIdLast4: null,
      });

      // The undecided submission is gone; the decided one keeps its decision only.
      expect(await tx.verificationSubmission.count({ where: { id: pending.id } })).toBe(0);
      const kept = await tx.verificationSubmission.findUniqueOrThrow({ where: { id: decided.id } });
      expect(kept).toMatchObject({
        status: 'VERIFIED',
        rollNumber: '',
        idCardUrl: '',
        govtIdLast4: null,
        govtIdImageUrl: null,
      });

      expect(await tx.refreshToken.count({ where: { userId: w.me.id, revokedAt: null } })).toBe(0);
      expect(
        (await tx.riderState.findUniqueOrThrow({ where: { userId: w.me.id } })).workModeOn,
      ).toBe(false);

      // FR-PRIV-05: the transaction record survives, still attached to the row.
      const task = await tx.task.findUniqueOrThrow({ where: { id: done.id } });
      expect(task.requesterId).toBe(w.me.id);

      // The audit entry outlives the erasure and carries no personal detail.
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'ACCOUNT_DELETED', targetId: w.me.id },
      });
      expect(JSON.stringify(audit.detail)).not.toContain(mobile);
      expect(audit.detail).toMatchObject({ requestedBy: 'SELF' });

      // Sessions, sockets and stored documents are dealt with.
      expect(w.auth.revokeAllSessions).toHaveBeenCalledWith(w.me.id);
      expect(w.gateway.disconnectUser).toHaveBeenCalledWith(w.me.id);
      expect(w.redis.removeRider).toHaveBeenCalledWith(w.college.id, w.me.id);
      expect(w.storage.deletePrivateObject.mock.calls.map((c) => c[0] as string).sort()).toEqual(
        [
          `govt_id/${w.me.id}/img.jpg`,
          `id_card/${w.me.id}/card.jpg`,
          `id_card/${w.me.id}/decided.jpg`,
          `id_card/${w.me.id}/pending.jpg`,
        ].sort(),
      );

      // The other student is untouched.
      const bystander = await tx.user.findUniqueOrThrow({ where: { id: w.other.id } });
      expect(bystander).toMatchObject({ status: 'ACTIVE', name: 'Ravi Other' });
    });
  });
});

describe('account routes', () => {
  it('are for students, and take no id from the request', () => {
    expect(Reflect.getMetadata('roles', AccountController)).toEqual(['STUDENT']);
    // Not gated on verification: an unverified student may still leave.
    expect(Reflect.getMetadata('requireVerified', AccountController)).toBeUndefined();
    expect(Reflect.getMetadata('path', AccountController.prototype.exportData)).toBe('export');
    expect(Reflect.getMetadata('path', AccountController.prototype.deleteAccount)).toBe('delete');
    expect(Reflect.getMetadata('__httpCode__', AccountController.prototype.deleteAccount)).toBe(
      200,
    );
  });
});
