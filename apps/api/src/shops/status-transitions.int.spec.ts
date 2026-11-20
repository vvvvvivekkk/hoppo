import { PrismaClient } from '@prisma/client';
import { ShopsService } from './shops.service';
import { VerificationService } from '../verification/verification.service';
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
 * Two administrators pressing the same button at once.
 *
 * Each of these actions used to read the status, check it, and then UPDATE by
 * id alone. The request that lost the race had already passed its check, so
 * it applied the change a second time and wrote a second audit entry. The
 * status is now part of the UPDATE's own WHERE.
 *
 * The race is reproduced deterministically: the service is given a database
 * whose first read of the row is *stale* (it reports the status as it was
 * before the other administrator's request committed), which is exactly what
 * the losing request sees. PostgreSQL, rolled back.
 */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

const tag = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

/** A PrismaService stand-in whose `model.findUnique` reports a stale `status`. */
function withStaleRead(
  tx: Tx,
  model: 'shopListing' | 'user' | 'verificationSubmission',
  status: string,
) {
  const base = prismaOver(tx) as Record<string, unknown>;
  const real = base[model] as {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
  };
  const stale = new Proxy(real as object, {
    get(target, prop, receiver) {
      if (prop === 'findUnique') {
        return async (args: unknown) => {
          const row = await real.findUnique(args);
          return row && 'status' in row ? { ...row, status } : row;
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return new Proxy(base, {
    get(target, prop) {
      return prop === model ? stale : target[prop as string];
    },
  }) as never;
}

async function shopWorld(tx: Tx, status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED') {
  const college = await makeCollege(tx, tag());
  const adminRow = await makeUser(tx, college.id, 'ADMIN');
  const owner = await makeUser(tx, college.id, 'SHOP_OWNER');
  const shop = await tx.shop.create({
    data: {
      name: `Spec Shop ${tag()}`,
      category: 'STATIONERY',
      ownerName: 'Owner',
      ownerMobile: owner.mobile,
      ownerEmail: owner.email,
      address: '4 Market Lane',
      city: 'Hyderabad',
      state: 'Telangana',
      latitude: 17.305,
      longitude: 78.619,
      locationType: 'OFF_CAMPUS',
    },
  });
  const listing = await tx.shopListing.create({
    data: {
      shopId: shop.id,
      collegeId: college.id,
      distanceFromCollegeM: 500,
      status,
      closureNote: status === 'SUSPENDED' ? 'Hygiene complaint' : null,
    },
  });
  const admin: AuthenticatedUser = {
    userId: adminRow.id,
    collegeId: college.id,
    role: 'ADMIN',
    isVerified: false,
  };
  const serviceSeeing = (staleStatus?: string) => {
    const prisma = staleStatus
      ? withStaleRead(tx, 'shopListing', staleStatus)
      : (prismaOver(tx) as never);
    const Ctor = ShopsService as unknown as new (...args: unknown[]) => ShopsService;
    return new Ctor(prisma, {}, {}, new AuditService(prismaOver(tx) as never), new TenantService());
  };
  const auditCount = (action: string) =>
    tx.auditLog.count({ where: { action, targetId: listing.id } });
  const row = () => tx.shopListing.findUniqueOrThrow({ where: { id: listing.id } });
  return { listing, admin, serviceSeeing, auditCount, row };
}

describe('shop status changes are one conditional UPDATE', () => {
  jest.setTimeout(30_000);

  it('reinstate: the second of two concurrent requests gets 409 and writes no audit row', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await shopWorld(tx, 'SUSPENDED');

      // The winner.
      await w.serviceSeeing().reinstate(w.admin, w.listing.id);
      expect(await w.auditCount('SHOP_REINSTATED')).toBe(1);

      // The loser: it read SUSPENDED before the winner committed.
      await expect(
        w.serviceSeeing('SUSPENDED').reinstate(w.admin, w.listing.id),
      ).rejects.toMatchObject({ status: 409, response: { code: 'NOT_SUSPENDED' } });

      expect(await w.auditCount('SHOP_REINSTATED')).toBe(1);
      expect(await w.row()).toMatchObject({ status: 'ACTIVE', closureNote: null });
    });
  });

  it('suspend: the loser gets 409 and does not overwrite the reason on record', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await shopWorld(tx, 'ACTIVE');

      await w.serviceSeeing().suspend(w.admin, w.listing.id, { reason: 'First reason' });

      await expect(
        w.serviceSeeing('ACTIVE').suspend(w.admin, w.listing.id, { reason: 'Second reason' }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'NOT_ACTIVE' } });

      expect(await w.auditCount('SHOP_SUSPENDED')).toBe(1);
      expect(await w.row()).toMatchObject({ status: 'SUSPENDED', closureNote: 'First reason' });
    });
  });

  it('approve and reject: a listing is decided once, whichever arrives second', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await shopWorld(tx, 'PENDING_VERIFICATION');

      await w.serviceSeeing().approve(w.admin, w.listing.id);

      const conflict = { status: 409, response: { code: 'ALREADY_DECIDED' } };
      await expect(
        w.serviceSeeing('PENDING_VERIFICATION').reject(w.admin, w.listing.id, {
          reason: 'DOCUMENT_INCOMPLETE',
        }),
      ).rejects.toMatchObject(conflict);
      await expect(
        w.serviceSeeing('PENDING_VERIFICATION').approve(w.admin, w.listing.id),
      ).rejects.toMatchObject(conflict);

      expect(await w.auditCount('SHOP_APPROVED')).toBe(1);
      expect(await w.auditCount('SHOP_REJECTED')).toBe(0);
      expect(await w.row()).toMatchObject({ status: 'ACTIVE', rejectionReason: null });
    });
  });
});

async function studentWorld(tx: Tx, status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED') {
  const college = await makeCollege(tx, tag());
  const adminRow = await makeUser(tx, college.id, 'ADMIN');
  const student = await makeUser(tx, college.id, 'STUDENT', {
    status,
    suspendedAt: status === 'SUSPENDED' ? new Date() : null,
    suspendedReason: status === 'SUSPENDED' ? 'First reason' : null,
  });
  await tx.studentProfile.create({
    data: {
      userId: student.id,
      rollNumber: 'ROLL-1',
      department: 'CSE',
      yearOfStudy: 2,
      verificationStatus: 'PENDING',
    },
  });
  const submission = await tx.verificationSubmission.create({
    data: {
      userId: student.id,
      collegeId: college.id,
      rollNumber: 'ROLL-1',
      department: 'CSE',
      yearOfStudy: 2,
      idCardUrl: 'id_card/x.jpg',
      status: 'PENDING',
    },
  });
  const admin: AuthenticatedUser = {
    userId: adminRow.id,
    collegeId: college.id,
    role: 'ADMIN',
    isVerified: false,
  };
  const auth = { revokeAllSessions: jest.fn().mockResolvedValue(0) };
  const gateway = { disconnectUser: jest.fn(), notifyTaskStatus: jest.fn() };
  const serviceSeeing = (model?: 'user' | 'verificationSubmission', staleStatus?: string) => {
    const prisma =
      model && staleStatus ? withStaleRead(tx, model, staleStatus) : (prismaOver(tx) as never);
    const Ctor = VerificationService as unknown as new (...args: unknown[]) => VerificationService;
    return new Ctor(
      prisma,
      { removeRider: jest.fn().mockResolvedValue(undefined) },
      new AuditService(prismaOver(tx) as never),
      auth,
      new TenantService(),
      gateway,
    );
  };
  const account = () => tx.user.findUniqueOrThrow({ where: { id: student.id } });
  return { student, submission, admin, serviceSeeing, account, auth, gateway };
}

describe('student status changes are one conditional UPDATE', () => {
  jest.setTimeout(30_000);

  it('suspend: the loser gets 409, keeps the first reason, and ends no sessions twice', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await studentWorld(tx, 'ACTIVE');

      await w.serviceSeeing().suspend(w.admin, w.student.id, { reason: 'First reason' });
      w.auth.revokeAllSessions.mockClear();
      w.gateway.disconnectUser.mockClear();

      await expect(
        w.serviceSeeing('user', 'ACTIVE').suspend(w.admin, w.student.id, { reason: 'Second' }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'NOT_ACTIVE' } });

      expect(await w.account()).toMatchObject({
        status: 'SUSPENDED',
        suspendedReason: 'First reason',
      });
      expect(
        await tx.auditLog.count({ where: { action: 'STUDENT_SUSPENDED', targetId: w.student.id } }),
      ).toBe(1);
      expect(w.auth.revokeAllSessions).not.toHaveBeenCalled();
      expect(w.gateway.disconnectUser).not.toHaveBeenCalled();
    });
  });

  it('reinstate: the loser gets 409 and one audit row exists', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await studentWorld(tx, 'SUSPENDED');

      await w.serviceSeeing().reinstate(w.admin, w.student.id);

      await expect(
        w.serviceSeeing('user', 'SUSPENDED').reinstate(w.admin, w.student.id),
      ).rejects.toMatchObject({ status: 409, response: { code: 'NOT_SUSPENDED' } });

      expect(
        await tx.auditLog.count({
          where: { action: 'STUDENT_REINSTATED', targetId: w.student.id },
        }),
      ).toBe(1);
    });
  });

  it('a deleted (DEACTIVATED) account cannot be suspended, so it cannot be "reinstated" to ACTIVE', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await studentWorld(tx, 'DEACTIVATED');

      await expect(
        w.serviceSeeing().suspend(w.admin, w.student.id, { reason: 'Any reason' }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'NOT_ACTIVE' } });
      await expect(w.serviceSeeing().reinstate(w.admin, w.student.id)).rejects.toMatchObject({
        status: 409,
        response: { code: 'NOT_SUSPENDED' },
      });

      expect((await w.account()).status).toBe('DEACTIVATED');
    });
  });

  it('a verification submission is decided once: approve then a concurrent reject', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await studentWorld(tx, 'ACTIVE');

      await w.serviceSeeing().approve(w.admin, w.submission.id, {});

      await expect(
        w.serviceSeeing('verificationSubmission', 'PENDING').reject(w.admin, w.submission.id, {
          reason: 'DOCUMENT_INCOMPLETE',
        }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'ALREADY_DECIDED' } });

      const decided = await tx.verificationSubmission.findUniqueOrThrow({
        where: { id: w.submission.id },
      });
      expect(decided).toMatchObject({ status: 'VERIFIED', rejectionReason: null });
      // The student stays verified: the losing rejection did not flip the profile.
      const profile = await tx.studentProfile.findUniqueOrThrow({
        where: { userId: w.student.id },
      });
      expect(profile.verificationStatus).toBe('VERIFIED');
      expect(
        await tx.auditLog.count({
          where: { targetId: w.submission.id, action: 'VERIFICATION_REJECTED' },
        }),
      ).toBe(0);
    });
  });
});
