import { PrismaClient } from '@prisma/client';
import { CollegeAdminService } from './college-admin.service';
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
 * FR-ADM-03 and FR-ORD-02 against PostgreSQL: the row lock, the fee-band
 * replacement, the audit rows and the tenancy checks, with real rows.
 * Everything is created inside a transaction that is rolled back.
 */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

async function world(tx: Tx) {
  const tag = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const collegeA = await makeCollege(tx, `${tag}-a`);
  const collegeB = await makeCollege(tx, `${tag}-b`);
  const adminA = await makeUser(tx, collegeA.id, 'ADMIN');
  const adminB = await makeUser(tx, collegeB.id, 'ADMIN');
  const as = (u: { id: string; collegeId: string | null }): AuthenticatedUser => ({
    userId: u.id,
    collegeId: u.collegeId,
    role: 'ADMIN',
    isVerified: false,
  });
  const prisma = prismaOver(tx) as never;
  const service = new CollegeAdminService(prisma, new AuditService(prisma), new TenantService());
  return { service, collegeA, collegeB, adminA: as(adminA), adminB: as(adminB) };
}

describe('college configuration against PostgreSQL (FR-ADM-03)', () => {
  jest.setTimeout(30_000);

  it('changes settings and fee bands, and audits before and after', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const result = await w.service.updateConfig(w.adminA, {
        feeIncrementMinor: 700,
        maxBroadcastRounds: 3, // already 3: not a change
        feeBands: [
          { minDistanceM: 1500, maxDistanceM: null, feeMinor: 4000 },
          { minDistanceM: 0, maxDistanceM: 1500, feeMinor: 2500 },
        ],
      });

      expect(result.changed.sort()).toEqual(['feeBands', 'feeIncrementMinor']);
      expect(result.config.feeIncrementMinor).toBe(700);

      const row = await tx.collegeConfig.findUniqueOrThrow({ where: { collegeId: w.collegeA.id } });
      expect(row.feeIncrementMinor).toBe(700);
      expect(row.maxBroadcastRounds).toBe(3);

      const bands = await tx.feeBand.findMany({
        where: { collegeId: w.collegeA.id },
        orderBy: { minDistanceM: 'asc' },
        select: { minDistanceM: true, maxDistanceM: true, feeMinor: true },
      });
      expect(bands).toEqual([
        { minDistanceM: 0, maxDistanceM: 1500, feeMinor: 2500 },
        { minDistanceM: 1500, maxDistanceM: null, feeMinor: 4000 },
      ]);

      const audit = await tx.auditLog.findMany({
        where: { collegeId: w.collegeA.id, action: 'COLLEGE_CONFIG_CHANGED' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].actorId).toBe(w.adminA.userId);
      expect(audit[0].detail).toEqual({
        before: {
          feeIncrementMinor: 500,
          feeBands: [
            { minDistanceM: 0, maxDistanceM: 1000, feeMinor: 2000 },
            { minDistanceM: 1000, maxDistanceM: null, feeMinor: 3000 },
          ],
        },
        after: {
          feeIncrementMinor: 700,
          feeBands: [
            { minDistanceM: 0, maxDistanceM: 1500, feeMinor: 2500 },
            { minDistanceM: 1500, maxDistanceM: null, feeMinor: 4000 },
          ],
        },
      });

      // The other college is untouched: same request, different token.
      const other = await tx.collegeConfig.findUniqueOrThrow({
        where: { collegeId: w.collegeB.id },
      });
      expect(other.feeIncrementMinor).toBe(500);
      expect(await tx.feeBand.count({ where: { collegeId: w.collegeB.id } })).toBe(2);
    });
  });

  it('writes nothing and audits nothing when the values are already in place', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const result = await w.service.updateConfig(w.adminA, { feeIncrementMinor: 500 });

      expect(result.changed).toEqual([]);
      expect(await tx.auditLog.count({ where: { collegeId: w.collegeA.id } })).toBe(0);
    });
  });

  it('rejects overlapping fee bands and leaves the stored ones alone', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      await expect(
        w.service.updateConfig(w.adminA, {
          feeBands: [
            { minDistanceM: 0, maxDistanceM: 1500, feeMinor: 2000 },
            { minDistanceM: 1000, maxDistanceM: null, feeMinor: 3000 },
          ],
        }),
      ).rejects.toMatchObject({ response: { code: 'FEE_BANDS_INVALID' } });

      expect(await tx.feeBand.count({ where: { collegeId: w.collegeA.id } })).toBe(2);
    });
  });
});

describe('delivery points against PostgreSQL (FR-ORD-02)', () => {
  jest.setTimeout(30_000);

  it('creates, lists inactive points, reorders, and never deletes', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const near = { latitude: 17.3046, longitude: 78.6189 };

      const gate = await w.service.createDeliveryPoint(w.adminA, { name: 'Main Gate', ...near });
      const library = await w.service.createDeliveryPoint(w.adminA, { name: 'Library', ...near });
      expect([gate.sortOrder, library.sortOrder]).toEqual([1, 2]);

      await expect(
        w.service.createDeliveryPoint(w.adminA, { name: 'main gate', ...near }),
      ).rejects.toMatchObject({ response: { code: 'DELIVERY_POINT_NAME_TAKEN' } });

      await expect(
        w.service.createDeliveryPoint(w.adminA, { name: 'Far', latitude: 18.5, longitude: 78.6 }),
      ).rejects.toMatchObject({ response: { code: 'DELIVERY_POINT_TOO_FAR' } });

      const retired = await w.service.setDeliveryPointActive(w.adminA, gate.id, false);
      expect(retired.isActive).toBe(false);
      // Retired, not removed: the row is still there for the orders that used it.
      expect(await tx.deliveryPoint.count({ where: { id: gate.id } })).toBe(1);

      const listed = await w.service.listDeliveryPoints(w.adminA);
      expect(listed.points.map((p) => [p.name, p.isActive])).toEqual([
        ['Main Gate', false],
        ['Library', true],
      ]);

      const reordered = await w.service.reorderDeliveryPoints(w.adminA, [library.id, gate.id]);
      expect(reordered.points.map((p) => [p.name, p.sortOrder])).toEqual([
        ['Library', 1],
        ['Main Gate', 2],
      ]);

      const actions = await tx.auditLog.findMany({
        where: { collegeId: w.collegeA.id },
        select: { action: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(actions.map((a) => a.action).sort()).toEqual([
        'DELIVERY_POINTS_REORDERED',
        'DELIVERY_POINT_CREATED',
        'DELIVERY_POINT_CREATED',
        'DELIVERY_POINT_DEACTIVATED',
      ]);
    });
  });

  it("refuses another college's administrator on every write (FR-TEN-03)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const point = await w.service.createDeliveryPoint(w.adminA, {
        name: 'Hostel A',
        latitude: 17.3046,
        longitude: 78.6189,
      });

      const crossTenant = { response: { code: 'CROSS_TENANT_ACCESS' } };
      await expect(
        w.service.updateDeliveryPoint(w.adminB, point.id, { name: 'Taken over' }),
      ).rejects.toMatchObject(crossTenant);
      await expect(
        w.service.setDeliveryPointActive(w.adminB, point.id, false),
      ).rejects.toMatchObject(crossTenant);
      await expect(w.service.reorderDeliveryPoints(w.adminB, [point.id])).rejects.toMatchObject({
        response: { code: 'REORDER_MISMATCH' },
      });

      // And B's list does not show it.
      expect((await w.service.listDeliveryPoints(w.adminB)).points).toEqual([]);

      const row = await tx.deliveryPoint.findUniqueOrThrow({ where: { id: point.id } });
      expect(row).toMatchObject({ name: 'Hostel A', isActive: true, sortOrder: 1 });
    });
  });
});
