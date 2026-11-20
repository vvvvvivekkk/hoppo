import { PrismaClient } from '@prisma/client';
import { ShopsService } from './shops.service';
import { AdminShopsController } from './shops.controller';
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

/** A-06 / FR-SHOP-12: shop detail, suspend and reinstate. Rolled back. */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

async function world(tx: Tx) {
  const tag = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const a = await makeCollege(tx, `${tag}-a`);
  const b = await makeCollege(tx, `${tag}-b`);
  const adminA = await makeUser(tx, a.id, 'ADMIN', { name: 'Admin Of A' });
  const adminB = await makeUser(tx, b.id, 'ADMIN');
  const owner = await makeUser(tx, a.id, 'SHOP_OWNER', { name: 'Owner Person' });

  const shop = await tx.shop.create({
    data: {
      name: `Spec Canteen ${tag}`,
      category: 'FOOD',
      ownerName: 'Owner Person',
      ownerMobile: owner.mobile,
      ownerEmail: owner.email,
      address: '4 Market Lane',
      city: 'Hyderabad',
      state: 'Telangana',
      latitude: 17.305,
      longitude: 78.619,
      locationType: 'OFF_CAMPUS',
      fssaiLicenceNumber: '12345678901234',
      staff: { create: { userId: owner.id, isOwner: true } },
      documents: {
        create: { docType: 'FRONTAGE_PHOTO', fileUrl: 'shop_document/secret-key.jpg' },
      },
    },
  });
  const listing = await tx.shopListing.create({
    data: {
      shopId: shop.id,
      collegeId: a.id,
      distanceFromCollegeM: 800,
      status: 'ACTIVE',
      approvedByUserId: adminA.id,
      approvedAt: new Date(),
    },
  });

  const prisma = prismaOver(tx) as never;
  const Ctor = ShopsService as unknown as new (...args: unknown[]) => ShopsService;
  const service = new Ctor(prisma, {}, {}, new AuditService(prisma), new TenantService());
  const as = (u: { id: string; collegeId: string | null }): AuthenticatedUser => ({
    userId: u.id,
    collegeId: u.collegeId,
    role: 'ADMIN',
    isVerified: false,
  });
  return { service, listing, shop, owner, a, b, adminA: as(adminA), adminB: as(adminB) };
}

describe('admin shop detail, suspend and reinstate against PostgreSQL', () => {
  jest.setTimeout(30_000);

  it('reports status, who approved, the owner and the documents — without file keys', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const detail = await w.service.adminDetail(w.adminA, w.listing.id);

      expect(detail).toMatchObject({
        listingId: w.listing.id,
        status: 'ACTIVE',
        distanceM: 800,
        withinRadius: true,
        approval: { approvedBy: { id: w.adminA.userId, name: 'Admin Of A' } },
        rejection: null,
        suspension: null,
        counts: { catalogItems: 0, orders: 0, inFlightOrders: 0 },
      });
      expect(detail.staff).toEqual([
        { userId: w.owner.id, name: 'Owner Person', isOwner: true, status: 'ACTIVE' },
      ]);
      expect(detail.documents).toHaveLength(1);
      expect(detail.documents[0]).toMatchObject({ docType: 'FRONTAGE_PHOTO' });
      // NFR-S-03: the storage key is only ever resolved by the audited route.
      expect(JSON.stringify(detail)).not.toContain('secret-key');
    });
  });

  it('suspend then reinstate: each says what, why, who and when; detail follows', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const suspended = await w.service.suspend(w.adminA, w.listing.id, {
        reason: 'Hygiene complaint',
      });
      expect(suspended).toMatchObject({
        status: 'SUSPENDED',
        reason: 'Hygiene complaint',
        suspendedBy: { id: w.adminA.userId, name: 'Admin Of A' },
        inFlightOrders: 0,
      });
      expect(suspended.suspendedAt).toBeInstanceOf(Date);

      const whileSuspended = await w.service.adminDetail(w.adminA, w.listing.id);
      expect(whileSuspended.suspension).toMatchObject({
        reason: 'Hygiene complaint',
        suspendedBy: { id: w.adminA.userId },
      });
      expect(whileSuspended.suspension!.suspendedAt).toBeInstanceOf(Date);

      const reinstated = await w.service.reinstate(w.adminA, w.listing.id);
      expect(reinstated).toMatchObject({
        status: 'ACTIVE',
        reinstatedBy: { id: w.adminA.userId, name: 'Admin Of A' },
      });

      const row = await tx.shopListing.findUniqueOrThrow({ where: { id: w.listing.id } });
      // The suspension reason does not linger as the shop's closure message.
      expect(row).toMatchObject({ status: 'ACTIVE', closureNote: null });
      expect((await w.service.adminDetail(w.adminA, w.listing.id)).suspension).toBeNull();

      const actions = await tx.auditLog.findMany({
        where: { targetId: w.listing.id },
        select: { action: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(actions.map((x) => x.action).sort()).toEqual(['SHOP_REINSTATED', 'SHOP_SUSPENDED']);

      await expect(w.service.reinstate(w.adminA, w.listing.id)).rejects.toMatchObject({
        response: { code: 'NOT_SUSPENDED' },
      });
    });
  });

  it("refuses another college's administrator (FR-TEN-03), and lists nothing to them", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      await w.service.suspend(w.adminA, w.listing.id, { reason: 'Hygiene complaint' });

      const crossTenant = { response: { code: 'CROSS_TENANT_ACCESS' } };
      await expect(w.service.adminDetail(w.adminB, w.listing.id)).rejects.toMatchObject(
        crossTenant,
      );
      await expect(w.service.reinstate(w.adminB, w.listing.id)).rejects.toMatchObject(crossTenant);

      expect((await w.service.adminList(w.adminB, {})).items).toEqual([]);
      const own = await w.service.adminList(w.adminA, { status: 'SUSPENDED' });
      expect(own.items.map((i) => i.listingId)).toEqual([w.listing.id]);
      expect((await w.service.adminList(w.adminA, { status: 'ACTIVE' })).items).toEqual([]);

      const row = await tx.shopListing.findUniqueOrThrow({ where: { id: w.listing.id } });
      expect(row.status).toBe('SUSPENDED');
    });
  });

  it('routes: the list and queue are not shadowed by :listingId, reinstate answers 200', () => {
    const proto = AdminShopsController.prototype;
    expect(Reflect.getMetadata('roles', AdminShopsController)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata('path', proto.reinstate)).toBe(':listingId/reinstate');
    expect(Reflect.getMetadata('__httpCode__', proto.reinstate)).toBe(200);
    // Nest matches in declaration order: the literal routes come first.
    const order = Object.getOwnPropertyNames(proto);
    expect(order.indexOf('queue')).toBeLessThan(order.indexOf('detail'));
    expect(order.indexOf('list')).toBeLessThan(order.indexOf('detail'));
  });
});
