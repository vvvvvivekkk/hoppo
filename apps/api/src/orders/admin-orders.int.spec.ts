import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AdminOrdersService } from './admin-orders.service';
import { AdminOrdersController } from './admin-orders.controller';
import { ShopSettlementsService } from './shop-settlements.service';
import { ShopSettlementsController } from './shop-settlements.controller';
import { OrdersService } from './orders.service';
import { TenantService } from '../common/tenant/tenant.service';
import { AuditService } from '../audit/audit.service';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * The administrator's order report and a shop's history, against PostgreSQL.
 *
 * The summary is raw SQL — FILTER aggregates, percentile_cont, a join — so a
 * mocked Prisma would prove nothing about it. And the two things most worth
 * proving, "an admin of one college cannot see another's" and "a day is the
 * college's day, not UTC's", are both properties of real queries on real rows.
 *
 * Nothing written here survives. Each test opens one transaction, creates
 * two brand-new colleges inside it with their own shops, people and orders,
 * runs the real services on that transaction, and rolls back. Because the
 * colleges are new, every count asserted below is exact: no other row in the
 * development database belongs to them.
 *
 * It needs the development database (DATABASE_URL, from the environment or
 * apps/api/.env) and fails, rather than skips, without one.
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

/** The day under report, as the college (Asia/Kolkata, UTC+5:30) sees it. */
const DAY = '2026-03-10';
/** An instant on DAY given as an Indian wall-clock time. */
const ist = (time: string, day = DAY) => new Date(`${day}T${time}:00+05:30`);
const plus = (at: Date, seconds: number) => new Date(at.getTime() + seconds * 1000);

interface OrderSeed {
  key: string;
  listingId: string;
  studentId: string;
  status: 'PLACED' | 'PREPARING' | 'COMPLETED' | 'CANCELLED';
  placedAt: Date;
  items: number;
  fee: number;
  platform: number;
  commission: number;
  method?: 'CASH' | 'WALLET';
  acceptedAfterS?: number;
  readyAfterS?: number;
  deliveredAfterReadyS?: number;
  cancelledBy?: 'STUDENT' | 'SHOP';
  taskStatus: 'CREATED' | 'UNFULFILLED' | 'COMPLETED' | 'CANCELLED';
  riderId?: string;
}

interface World {
  /** The open transaction, for a test that needs rows of its own. */
  tx: Tx;
  orders: OrdersService;
  studentA: string;
  riderA: string;
  report: AdminOrdersService;
  settlements: ShopSettlementsService;
  /** A counter-staff account of shop A1 (not its owner). */
  staffA1: AuthenticatedUser;
  adminA: AuthenticatedUser;
  adminB: AuthenticatedUser;
  ownerA1: AuthenticatedUser;
  collegeA: string;
  collegeB: string;
  listingA1: string;
  listingA2: string;
  listingB: string;
  /** Order ids and references by fixture key. */
  id: Record<string, string>;
  ref: Record<string, string>;
  /** Every mobile number and email created, to prove none of them leaks. */
  contacts: string[];
}

async function inRolledBackTransaction(body: (world: World) => Promise<void>): Promise<void> {
  let finished = false;

  const attempt = db.$transaction(
    async (tx: Tx) => {
      const tag = randomUUID().replace(/-/g, '').slice(0, 10);
      const contacts: string[] = [];
      let serial = 0;

      const college = (name: string) =>
        tx.college.create({
          data: {
            name: `A1 report spec ${name} ${tag}`,
            address: 'Test Road',
            city: 'Hyderabad',
            state: 'Telangana',
            latitude: 17.3,
            longitude: 78.6,
            timezone: 'Asia/Kolkata',
          },
          select: { id: true },
        });

      const person = async (
        collegeId: string,
        role: 'STUDENT' | 'ADMIN' | 'SHOP_OWNER',
        name: string,
      ) => {
        serial += 1;
        // Unique per run, recognisable, and never a dialable number.
        const mobile = `+9991${String(parseInt(tag.slice(0, 6), 16) % 1_000_000).padStart(6, '0')}${String(serial).padStart(2, '0')}`;
        const email = `a1-report-${tag}-${serial}@example.test`;
        contacts.push(mobile, email);
        const user = await tx.user.create({
          data: { collegeId, role, name, mobile, email, passwordHash: 'not-a-real-hash' },
          select: { id: true },
        });
        return user.id;
      };

      const shop = async (collegeId: string, name: string, ownerId?: string) => {
        serial += 1;
        const ownerMobile = `+9992${String(parseInt(tag.slice(0, 6), 16) % 1_000_000).padStart(6, '0')}${String(serial).padStart(2, '0')}`;
        const ownerEmail = `a1-report-shop-${tag}-${serial}@example.test`;
        contacts.push(ownerMobile, ownerEmail);
        const created = await tx.shop.create({
          data: {
            name,
            category: 'Food',
            ownerName: 'Owner',
            ownerMobile,
            ownerEmail,
            address: 'Shop Street',
            city: 'Hyderabad',
            state: 'Telangana',
            latitude: 17.301,
            longitude: 78.601,
            locationType: 'OFF_CAMPUS',
            ...(ownerId ? { staff: { create: { userId: ownerId, isOwner: true } } } : {}),
          },
          select: { id: true },
        });
        const listing = await tx.shopListing.create({
          data: { shopId: created.id, collegeId, distanceFromCollegeM: 400, status: 'ACTIVE' },
          select: { id: true },
        });
        return listing.id;
      };

      const a = await college('A');
      const b = await college('B');

      const adminAId = await person(a.id, 'ADMIN', 'Admin A');
      const adminBId = await person(b.id, 'ADMIN', 'Admin B');
      const ownerA1Id = await person(a.id, 'SHOP_OWNER', 'Owner A1');
      const studentA = await person(a.id, 'STUDENT', 'Asha Student');
      const riderA = await person(a.id, 'STUDENT', 'Ravi Rider');
      const studentB = await person(b.id, 'STUDENT', 'Bina Student');

      const listingA1 = await shop(a.id, `Tiffins ${tag}`, ownerA1Id);
      const listingA2 = await shop(a.id, `Juice ${tag}`);
      const listingB = await shop(b.id, `Other college cafe ${tag}`);

      const id: Record<string, string> = {};
      const ref: Record<string, string> = {};

      const order = async (collegeId: string, seed: OrderSeed) => {
        const acceptedAt =
          seed.acceptedAfterS !== undefined ? plus(seed.placedAt, seed.acceptedAfterS) : null;
        const readyAt =
          seed.readyAfterS !== undefined ? plus(seed.placedAt, seed.readyAfterS) : null;
        const deliveredAt =
          readyAt && seed.deliveredAfterReadyS !== undefined
            ? plus(readyAt, seed.deliveredAfterReadyS)
            : null;
        const reference = `T${tag.slice(0, 5).toUpperCase()}-${seed.key.toUpperCase()}`;
        const method = seed.method ?? 'CASH';

        const created = await tx.order.create({
          data: {
            collegeId,
            reference,
            studentId: seed.studentId,
            shopListingId: seed.listingId,
            status: seed.status,
            itemsSubtotalMinor: seed.items,
            deliveryFeeMinor: seed.fee,
            platformFeeMinor: seed.platform,
            totalMinor: seed.items + seed.fee + seed.platform,
            commissionMinor: seed.commission,
            paymentMethod: method,
            paymentStatus:
              method === 'CASH'
                ? 'NOT_REQUIRED'
                : seed.status === 'COMPLETED'
                  ? 'CAPTURED'
                  : 'HELD',
            dropLandmark: 'Hostel gate',
            dropLatitude: 17.302,
            dropLongitude: 78.602,
            placedAt: seed.placedAt,
            shopAcceptedAt: acceptedAt,
            readyAt,
            pickedUpAt: deliveredAt ? plus(deliveredAt, -120) : null,
            deliveredAt,
            completedAt: seed.status === 'COMPLETED' ? deliveredAt : null,
            cancelledAt: seed.status === 'CANCELLED' ? plus(seed.placedAt, 30) : null,
            cancelledBy: seed.cancelledBy ?? null,
            cancelledReason: seed.cancelledBy ? 'spec' : null,
            items: {
              create: {
                nameSnapshot: 'Masala Dosa',
                unitPriceMinor: seed.items,
                quantity: 1,
                lineTotalMinor: seed.items,
              },
            },
          },
          select: { id: true },
        });

        const task = await tx.task.create({
          data: {
            collegeId,
            type: 'SHOP_ORDER',
            status: seed.taskStatus,
            orderId: created.id,
            requesterId: seed.studentId,
            riderId: seed.riderId ?? null,
            pickupLabel: 'Shop',
            pickupLatitude: 17.301,
            pickupLongitude: 78.601,
            dropLabel: 'Boys Hostel B',
            dropLatitude: 17.302,
            dropLongitude: 78.602,
            distanceM: 640,
            baseFeeMinor: seed.fee,
            feeMinor: seed.fee,
            broadcastRound: seed.riderId ? 1 : 0,
            assignedAt: seed.riderId && acceptedAt ? plus(acceptedAt, 41) : null,
            deliveredAt,
            completedAt: seed.taskStatus === 'COMPLETED' ? deliveredAt : null,
          },
          select: { id: true },
        });

        id[seed.key] = created.id;
        ref[seed.key] = reference;
        return { orderId: created.id, taskId: task.id, acceptedAt, deliveredAt };
      };

      const done = { status: 'COMPLETED', taskStatus: 'COMPLETED' } as const;

      // College A, on DAY.
      const o1 = await order(a.id, {
        key: 'o1',
        listingId: listingA1,
        studentId: studentA,
        ...done,
        riderId: riderA,
        placedAt: ist('10:00'),
        items: 12000,
        fee: 2000,
        platform: 500,
        commission: 600,
        acceptedAfterS: 60,
        readyAfterS: 600,
        deliveredAfterReadyS: 300,
      });
      // 11:45 pm local: still DAY in India, though already past 18:00 UTC.
      const o2 = await order(a.id, {
        key: 'o2',
        listingId: listingA2,
        studentId: studentA,
        ...done,
        riderId: riderA,
        method: 'WALLET',
        placedAt: ist('23:45'),
        items: 8000,
        fee: 1500,
        platform: 500,
        commission: 400,
        acceptedAfterS: 120,
        readyAfterS: 300,
        deliveredAfterReadyS: 500,
      });
      await order(a.id, {
        key: 'o3',
        listingId: listingA1,
        studentId: studentA,
        status: 'CANCELLED',
        taskStatus: 'CANCELLED',
        cancelledBy: 'STUDENT',
        placedAt: ist('12:00'),
        items: 5000,
        fee: 2000,
        platform: 500,
        commission: 250,
      });
      await order(a.id, {
        key: 'o4',
        listingId: listingA1,
        studentId: studentA,
        status: 'CANCELLED',
        taskStatus: 'CANCELLED',
        cancelledBy: 'SHOP',
        placedAt: ist('13:00'),
        items: 7000,
        fee: 2000,
        platform: 500,
        commission: 350,
      });
      await order(a.id, {
        key: 'o5',
        listingId: listingA1,
        studentId: studentA,
        status: 'PREPARING',
        taskStatus: 'UNFULFILLED',
        placedAt: ist('14:00'),
        items: 9000,
        fee: 2000,
        platform: 500,
        commission: 450,
        acceptedAfterS: 200,
      });
      // 1 am local on DAY: the 9th in UTC. A UTC-day filter would drop it.
      await order(a.id, {
        key: 'o7',
        listingId: listingA1,
        studentId: studentA,
        status: 'PLACED',
        taskStatus: 'CREATED',
        placedAt: ist('01:00'),
        items: 3000,
        fee: 2000,
        platform: 500,
        commission: 150,
      });
      // 12:15 am the NEXT local day: still the 10th in UTC. Must be excluded.
      await order(a.id, {
        key: 'o6',
        listingId: listingA1,
        studentId: studentA,
        ...done,
        riderId: riderA,
        placedAt: ist('00:15', '2026-03-11'),
        items: 99000,
        fee: 2000,
        platform: 500,
        commission: 4950,
        acceptedAfterS: 10,
        readyAfterS: 20,
        deliveredAfterReadyS: 10,
      });
      // College B, same day.
      await order(b.id, {
        key: 'oB',
        listingId: listingB,
        studentId: studentB,
        ...done,
        placedAt: ist('10:30'),
        items: 44000,
        fee: 2000,
        platform: 500,
        commission: 2200,
        acceptedAfterS: 5,
        readyAfterS: 50,
        deliveredAfterReadyS: 5,
      });

      // How o1 found its rider, and what the ledger says about o1 and o2.
      await tx.broadcastLog.create({
        data: {
          taskId: o1.taskId,
          round: 1,
          radiusM: 1500,
          feeMinor: 2000,
          eligibleCount: 3,
          sentAt: o1.acceptedAt!,
          outcome: 'ACCEPTED',
          acceptedByUserId: riderA,
          resolvedAt: plus(o1.acceptedAt!, 41),
        },
      });
      await tx.walletEntry.create({
        data: {
          userId: riderA,
          direction: 'CREDIT',
          amountMinor: 2000,
          type: 'DELIVERY_FEE_EARNED',
          taskId: o1.taskId,
          orderId: o1.orderId,
          balanceAfterMinor: 0,
          note: 'Delivery fee — collected in cash',
          createdAt: o1.deliveredAt!,
        },
      });
      await tx.walletEntry.create({
        data: {
          userId: studentA,
          direction: 'CREDIT',
          amountMinor: 10000,
          type: 'ADJUSTMENT',
          balanceAfterMinor: 10000,
          note: 'spec funding',
          createdAt: ist('23:00'),
        },
      });
      await tx.walletEntry.create({
        data: {
          userId: studentA,
          direction: 'DEBIT',
          amountMinor: 10000,
          type: 'ORDER_HOLD',
          orderId: o2.orderId,
          balanceAfterMinor: 0,
          note: 'Held',
          createdAt: ist('23:45'),
        },
      });
      await tx.walletEntry.create({
        data: {
          userId: studentA,
          direction: 'DEBIT',
          amountMinor: 0,
          type: 'ORDER_CAPTURE',
          orderId: o2.orderId,
          balanceAfterMinor: 0,
          note: 'Captured',
          createdAt: o2.deliveredAt!,
        },
      });

      // The services see the open transaction as their whole database.
      const prisma = new Proxy(tx as object, {
        get(target, prop, receiver) {
          if (prop === '$transaction') return (fn: (client: Tx) => Promise<unknown>) => fn(tx);
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      const tenant = new TenantService();
      const orders = new OrdersService(
        prisma as never,
        tenant,
        new AuditService(prisma as never),
      );
      const report = new AdminOrdersService(prisma as never, tenant, orders);
      const settlements = new ShopSettlementsService(prisma as never, tenant);

      const staffA1Id = await person(a.id, 'SHOP_OWNER', 'Counter Staff A1');
      const a1 = await tx.shopListing.findUniqueOrThrow({
        where: { id: listingA1 },
        select: { shopId: true },
      });
      await tx.shopStaff.create({ data: { shopId: a1.shopId, userId: staffA1Id, isOwner: false } });

      const as = (userId: string, collegeId: string, role: AuthenticatedUser['role']) =>
        ({ userId, collegeId, role, isVerified: false, shopApproved: true }) as AuthenticatedUser;

      await body({
        tx,
        orders,
        studentA,
        riderA,
        report,
        settlements,
        staffA1: as(staffA1Id, a.id, 'SHOP_STAFF'),
        adminA: as(adminAId, a.id, 'ADMIN'),
        adminB: as(adminBId, b.id, 'ADMIN'),
        ownerA1: as(ownerA1Id, a.id, 'SHOP_OWNER'),
        collegeA: a.id,
        collegeB: b.id,
        listingA1,
        listingA2,
        listingB,
        id,
        ref,
        contacts,
      });

      finished = true;
      throw new Rollback();
    },
    { timeout: 60_000, maxWait: 15_000 },
  );

  await attempt.catch((error: unknown) => {
    if (!(error instanceof Rollback)) throw error;
  });
  if (!finished) throw new Error('the test body did not run to the end');
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    const response = http.getResponse();
    return {
      status: http.getStatus(),
      code: typeof response === 'object' ? (response as { code?: string }).code : undefined,
    };
  }
  throw new Error('expected the call to be refused');
}

const range = { from: DAY, to: DAY };
const keysOf = (w: World, items: { reference: string }[]) =>
  items.map((i) => Object.keys(w.ref).find((k) => w.ref[k] === i.reference));

jest.setTimeout(90_000);

// ===========================================================================
// Who may call it
// ===========================================================================

describe('the admin order routes are closed to everyone but administrators', () => {
  it('carries @Roles(ADMIN) on the controller, so every route inherits it', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminOrdersController)).toEqual(['ADMIN']);
  });

  it('refuses an account that belongs to no college', async () => {
    await inRolledBackTransaction(async (w) => {
      const adrift = { ...w.adminA, collegeId: null } as AuthenticatedUser;
      await expect(w.report.list(adrift, range)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

// ===========================================================================
// (a) List
// ===========================================================================

describe('GET /admin/orders', () => {
  it('lists my college for the local day, newest first — and nothing else', async () => {
    await inRolledBackTransaction(async (w) => {
      const page = await w.report.list(w.adminA, range);

      // o6 (12:15 am next local day) is out; o7 (1 am local, the 9th in UTC) is in.
      expect(keysOf(w, page.items)).toEqual(['o2', 'o5', 'o4', 'o3', 'o1', 'o7']);
      expect(page.nextCursor).toBeNull();
      expect(page.range).toEqual({ from: DAY, to: DAY, timezone: 'Asia/Kolkata' });
    });
  });

  it('shapes a row as the contract says', async () => {
    await inRolledBackTransaction(async (w) => {
      const page = await w.report.list(w.adminA, { ...range, q: w.ref.o1 });
      expect(page.items).toHaveLength(1);

      expect(page.items[0]).toMatchObject({
        id: w.id.o1,
        reference: w.ref.o1,
        status: 'COMPLETED',
        shop: { listingId: w.listingA1 },
        student: { name: 'Asha Student' },
        rider: { name: 'Ravi Rider' },
        itemsSubtotalMinor: 12000,
        deliveryFeeMinor: 2000,
        platformFeeMinor: 500,
        totalMinor: 14500,
        commissionMinor: 600,
        paymentMethod: 'CASH',
        paymentStatus: 'NOT_REQUIRED',
        taskStatus: 'COMPLETED',
        cancelledBy: null,
      });
      expect(page.items[0].placedAt.toISOString()).toBe('2026-03-10T04:30:00.000Z');
      expect(typeof page.items[0].totalLabel).toBe('string');
      // Exactly an id and a name for each person.
      expect(Object.keys(page.items[0].student).sort()).toEqual(['id', 'name']);
      expect(Object.keys(page.items[0].rider!).sort()).toEqual(['id', 'name']);
    });
  });

  it('filters by status, by shop listing, and by reference in any letter case', async () => {
    await inRolledBackTransaction(async (w) => {
      const cancelled = await w.report.list(w.adminA, { ...range, status: 'CANCELLED' });
      expect(keysOf(w, cancelled.items)).toEqual(['o4', 'o3']);

      const two = await w.report.list(w.adminA, { ...range, status: 'placed,PREPARING' });
      expect(keysOf(w, two.items)).toEqual(['o5', 'o7']);

      const juice = await w.report.list(w.adminA, { ...range, listingId: w.listingA2 });
      expect(keysOf(w, juice.items)).toEqual(['o2']);

      const found = await w.report.list(w.adminA, { q: w.ref.o3.toLowerCase().slice(2) });
      expect(keysOf(w, found.items)).toEqual(['o3']);

      // No date range at all: everything in my college, including the next day.
      const all = await w.report.list(w.adminA, {});
      expect(keysOf(w, all.items)).toHaveLength(7);
    });
  });

  it('pages with a cursor without repeating or skipping an order', async () => {
    await inRolledBackTransaction(async (w) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await w.report.list(w.adminA, { ...range, limit: '4', cursor });
        expect(page.items.length).toBeLessThanOrEqual(4);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBe(2);
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);

      // A junk limit is the default, not NaN and not unbounded.
      expect((await w.report.list(w.adminA, { ...range, limit: 'abc' })).items).toHaveLength(6);
      expect((await w.report.list(w.adminA, { ...range, limit: '-3' })).items).toHaveLength(1);
    });
  });

  it('answers bad input with its own error code', async () => {
    await inRolledBackTransaction(async (w) => {
      expect(await refusal(w.report.list(w.adminA, { from: '10-03-2026' }))).toEqual({
        status: 400,
        code: 'INVALID_DATE',
      });
      expect(await refusal(w.report.list(w.adminA, { from: '2026-03-11', to: DAY }))).toEqual({
        status: 400,
        code: 'INVALID_DATE_RANGE',
      });
      expect(await refusal(w.report.list(w.adminA, { status: 'SHIPPED' }))).toEqual({
        status: 400,
        code: 'INVALID_STATUS',
      });
      expect(await refusal(w.report.list(w.adminA, { cursor: randomUUID() }))).toEqual({
        status: 400,
        code: 'INVALID_CURSOR',
      });
      expect(await refusal(w.report.list(w.adminA, { listingId: randomUUID() }))).toEqual({
        status: 404,
        code: 'SHOP_NOT_FOUND',
      });
    });
  });
});

// ===========================================================================
// Tenancy
// ===========================================================================

describe('an administrator of one college cannot see another college', () => {
  it('list: each admin gets only their own college, whatever the query says', async () => {
    await inRolledBackTransaction(async (w) => {
      expect(keysOf(w, (await w.report.list(w.adminB, range)).items)).toEqual(['oB']);

      // A collegeId in the query is not a way in: it is ignored for an ADMIN.
      const sneaky = await w.report.list(w.adminA, { ...range, collegeId: w.collegeB });
      expect(keysOf(w, sneaky.items)).not.toContain('oB');
      expect(sneaky.items).toHaveLength(6);

      // Another college's order cannot be used as a cursor either.
      expect(await refusal(w.report.list(w.adminA, { cursor: w.id.oB }))).toEqual({
        status: 400,
        code: 'INVALID_CURSOR',
      });
    });
  });

  it("list: naming another college's shop listing is 403, not an empty page", async () => {
    await inRolledBackTransaction(async (w) => {
      expect(await refusal(w.report.list(w.adminA, { listingId: w.listingB }))).toEqual({
        status: 403,
        code: 'CROSS_TENANT_ACCESS',
      });
    });
  });

  it("detail: another college's order is 403", async () => {
    await inRolledBackTransaction(async (w) => {
      expect(await refusal(w.report.detail(w.adminA, w.id.oB))).toEqual({
        status: 403,
        code: 'CROSS_TENANT_ACCESS',
      });
      expect(await refusal(w.report.detail(w.adminB, w.id.o1))).toEqual({
        status: 403,
        code: 'CROSS_TENANT_ACCESS',
      });
      expect(await refusal(w.report.detail(w.adminA, randomUUID()))).toEqual({
        status: 404,
        code: 'ORDER_NOT_FOUND',
      });
    });
  });

  it("summary: college B's money is not in college A's figures, and the reverse", async () => {
    await inRolledBackTransaction(async (w) => {
      const a = await w.report.summary(w.adminA, { ...range, collegeId: w.collegeB });
      expect(a.ordersPlaced).toBe(6);
      expect(a.money.grossItemsMinor).toBe(20000);

      const b = await w.report.summary(w.adminB, range);
      expect(b.ordersPlaced).toBe(1);
      expect(b.money.grossItemsMinor).toBe(44000);
      expect(b.revenueByShop.map((s) => s.listingId)).toEqual([w.listingB]);
    });
  });

  it('a super administrator may name a college, or see all of them', async () => {
    await inRolledBackTransaction(async (w) => {
      const root = {
        userId: 'root',
        collegeId: null,
        role: 'SUPER_ADMIN',
        isVerified: false,
      } as AuthenticatedUser;
      const onlyB = await w.report.list(root, { ...range, collegeId: w.collegeB });
      expect(keysOf(w, onlyB.items)).toEqual(['oB']);
      expect((await w.report.detail(root, w.id.oB)).reference).toBe(w.ref.oB);
    });
  });
});

// ===========================================================================
// (b) Detail
// ===========================================================================

describe('GET /admin/orders/:orderId', () => {
  it('gives the timeline, items, task, broadcast rounds and ledger of a delivered order', async () => {
    await inRolledBackTransaction(async (w) => {
      const d = await w.report.detail(w.adminA, w.id.o1);

      expect(d.timeline.map((t) => t.event)).toEqual([
        'PLACED',
        'SHOP_ACCEPTED',
        'READY',
        'PICKED_UP',
        'DELIVERED',
        'COMPLETED',
      ]);
      expect(d.timeline[0].at.toISOString()).toBe('2026-03-10T04:30:00.000Z');
      expect(d.timeline[1].at.toISOString()).toBe('2026-03-10T04:31:00.000Z');

      expect(d.items).toEqual([
        {
          name: 'Masala Dosa',
          unitPriceMinor: 12000,
          quantity: 1,
          lineTotalMinor: 12000,
          note: null,
        },
      ]);
      expect(d.task).toMatchObject({ status: 'COMPLETED', feeMinor: 2000, distanceM: 640 });
      expect(d.dropLabel).toBe('Boys Hostel B');
      expect(d.rider).toMatchObject({ name: 'Ravi Rider' });

      expect(d.broadcast).toMatchObject({ roundsSent: 1, searches: 1, roundsInLatestSearch: 1 });
      expect(d.broadcast.rounds[0]).toMatchObject({
        round: 1,
        radiusM: 1500,
        eligibleCount: 3,
        outcome: 'ACCEPTED',
      });
      expect(d.broadcast.secondsToAcceptance).toBe(41);

      expect(d.walletEntries).toHaveLength(1);
      expect(d.walletEntries[0]).toMatchObject({
        type: 'DELIVERY_FEE_EARNED',
        direction: 'CREDIT',
        amountMinor: 2000,
        party: 'RIDER',
        user: { name: 'Ravi Rider' },
      });

      // The whole response must survive JSON (no BigInt from `seq`).
      expect(() => JSON.stringify(d)).not.toThrow();
    });
  });

  it("lists a wallet order's hold and capture in the order they were written, and no other order's rows", async () => {
    await inRolledBackTransaction(async (w) => {
      const d = await w.report.detail(w.adminA, w.id.o2);
      expect(d.walletEntries.map((e) => [e.type, e.party, e.amountMinor])).toEqual([
        ['ORDER_HOLD', 'STUDENT', 10000],
        ['ORDER_CAPTURE', 'STUDENT', 0],
      ]);
      expect(d.paymentStatus).toBe('CAPTURED');
    });
  });

  it('ends a cancelled order at CANCELLED, with who and why', async () => {
    await inRolledBackTransaction(async (w) => {
      const d = await w.report.detail(w.adminA, w.id.o4);
      expect(d.timeline.map((t) => t.event)).toEqual(['PLACED', 'CANCELLED']);
      expect(d).toMatchObject({ cancelledBy: 'SHOP', cancelledReason: 'spec', rider: null });
      expect(d.broadcast).toMatchObject({ roundsSent: 0, secondsToAcceptance: null });
      expect(d.walletEntries).toEqual([]);
    });
  });

  it('keeps the searches apart: every round is listed, acceptance is timed within the latest search', async () => {
    await inRolledBackTransaction(async (w) => {
      // o1's delivery, retold: the first search's round 1 was accepted and the
      // rider then abandoned it; the task went back into the pool and a second
      // search (cycle 2) found the rider who delivered.
      const task = await w.tx.task.findUniqueOrThrow({
        where: { orderId: w.id.o1 },
        select: { id: true, assignedAt: true },
      });
      const assignedAt = task.assignedAt!;
      const longAgo = new Date(assignedAt.getTime() - 900_000);

      await w.tx.broadcastLog.updateMany({
        where: { taskId: task.id, cycle: 1, round: 1 },
        data: { sentAt: longAgo, resolvedAt: new Date(longAgo.getTime() + 20_000) },
      });
      // Same task, same round number, different cycle: only possible because
      // the unique key is (task, cycle, round).
      await w.tx.broadcastLog.create({
        data: {
          taskId: task.id, cycle: 2, round: 1, radiusM: 1500, feeMinor: 2000, eligibleCount: 2,
          sentAt: new Date(assignedAt.getTime() - 90_000), outcome: 'EXPIRED',
          resolvedAt: new Date(assignedAt.getTime() - 30_000),
        },
      });
      await w.tx.broadcastLog.create({
        data: {
          taskId: task.id, cycle: 2, round: 2, radiusM: 2500, feeMinor: 2500, eligibleCount: 4,
          sentAt: new Date(assignedAt.getTime() - 30_000), outcome: 'ACCEPTED',
          resolvedAt: assignedAt,
        },
      });
      await w.tx.task.update({ where: { id: task.id }, data: { broadcastCycle: 2, broadcastRound: 2 } });

      const d = await w.report.detail(w.adminA, w.id.o1);

      expect(d.broadcast.rounds.map((r) => [r.cycle, r.round, r.outcome])).toEqual([
        [1, 1, 'ACCEPTED'],
        [2, 1, 'EXPIRED'],
        [2, 2, 'ACCEPTED'],
      ]);
      expect(d.broadcast).toMatchObject({ roundsSent: 3, searches: 2, roundsInLatestSearch: 2 });
      // From the second search's first round (90 s before assignment) — not
      // from the first search's round, which would say 900.
      expect(d.broadcast.secondsToAcceptance).toBe(90);
    });
  });

  it('orders the rounds by search first, then by round — whatever order the rows were written in', async () => {
    await inRolledBackTransaction(async (w) => {
      const task = await w.tx.task.findUniqueOrThrow({
        where: { orderId: w.id.o1 },
        select: { id: true, assignedAt: true },
      });
      const at = (secondsBefore: number) =>
        new Date(task.assignedAt!.getTime() - secondsBefore * 1000);
      const row = (cycle: number, round: number, sentAt: Date, outcome: 'EXPIRED' | 'ACCEPTED') =>
        w.tx.broadcastLog.create({
          data: {
            taskId: task.id, cycle, round, radiusM: 1500, feeMinor: 2000, eligibleCount: 1,
            sentAt, outcome, resolvedAt: sentAt,
          },
        });

      // The fixture already holds cycle 1 round 1. The rest go in out of
      // order on purpose: the second search's round 1 first, then the first
      // search's round 3, then its round 2. Neither insertion order nor
      // `round` alone gives the right sequence — sorting by round only would
      // put cycle 2's round 1 ahead of cycle 1's rounds 2 and 3.
      await row(2, 1, at(60), 'ACCEPTED');
      await row(1, 3, at(600), 'EXPIRED');
      await row(1, 2, at(700), 'EXPIRED');
      await w.tx.task.update({ where: { id: task.id }, data: { broadcastCycle: 2, broadcastRound: 1 } });

      const d = await w.report.detail(w.adminA, w.id.o1);

      expect(d.broadcast.rounds.map((r) => `${r.cycle}.${r.round}`)).toEqual([
        '1.1',
        '1.2',
        '1.3',
        '2.1',
      ]);
      expect(d.broadcast).toMatchObject({ roundsSent: 4, searches: 2, roundsInLatestSearch: 1 });
      // Timed inside the latest search: its only round went out 60 s before assignment.
      expect(d.broadcast.secondsToAcceptance).toBe(60);
    });
  });
});

// ===========================================================================
// (c) Summary
// ===========================================================================

describe('GET /admin/orders/summary', () => {
  it('counts, sums and medians for the local day', async () => {
    await inRolledBackTransaction(async (w) => {
      const s = await w.report.summary(w.adminA, range);

      expect(s.range).toEqual({ from: DAY, to: DAY, timezone: 'Asia/Kolkata' });
      expect(s.ordersPlaced).toBe(6);
      expect(s.byStatus).toEqual({
        PLACED: 1,
        SHOP_ACCEPTED: 0,
        PREPARING: 1,
        READY: 0,
        PICKED_UP: 0,
        DELIVERED: 0,
        COMPLETED: 2,
        CANCELLED: 2,
      });
      // 2 of 6, in basis points, rounded down: an integer, not 0.3333.
      expect(s.completionRateBps).toBe(3333);

      // Completed orders only: o1 + o2. The cancelled and unfinished ones add nothing.
      expect(s.money).toMatchObject({
        basis: 'COMPLETED',
        grossItemsMinor: 20000,
        deliveryFeesMinor: 3500,
        platformFeesMinor: 1000,
        commissionMinor: 1000,
        totalMinor: 24500,
      });
      for (const value of Object.values(s.money)) {
        if (typeof value === 'number') expect(Number.isInteger(value)).toBe(true);
      }

      expect(s.cancellations).toEqual({
        total: 2,
        byWho: { STUDENT: 1, SHOP: 1, ADMIN: 0, SYSTEM: 0 },
      });

      // placed→accepted: 60, 120, 200 seconds. ready→delivered: 300, 500.
      expect(s.timings).toEqual({
        medianPlacedToAcceptedSeconds: 120,
        medianReadyToDeliveredSeconds: 400,
        placedToAcceptedSampleSize: 3,
        readyToDeliveredSampleSize: 2,
      });

      expect(s.unfulfilledBroadcasts).toBe(1);
      expect(s.revenueByShop).toMatchObject([
        {
          listingId: w.listingA1,
          completedOrders: 1,
          grossItemsMinor: 12000,
          commissionMinor: 600,
        },
        { listingId: w.listingA2, completedOrders: 1, grossItemsMinor: 8000, commissionMinor: 400 },
      ]);
      expect(() => JSON.stringify(s)).not.toThrow();
    });
  });

  it('moves with the range: the next local day holds only the after-midnight order', async () => {
    await inRolledBackTransaction(async (w) => {
      const next = await w.report.summary(w.adminA, { from: '2026-03-11', to: '2026-03-11' });
      expect(next.ordersPlaced).toBe(1);
      expect(next.money.grossItemsMinor).toBe(99000);

      const both = await w.report.summary(w.adminA, { from: DAY, to: '2026-03-11' });
      expect(both.ordersPlaced).toBe(7);
      expect(both.money.grossItemsMinor).toBe(119000);
    });
  });

  it('is all zeros and nulls on a day with no orders, not an error', async () => {
    await inRolledBackTransaction(async (w) => {
      const empty = await w.report.summary(w.adminA, { from: '2025-01-01', to: '2025-01-01' });
      expect(empty.ordersPlaced).toBe(0);
      expect(empty.completionRateBps).toBe(0);
      expect(empty.money.totalMinor).toBe(0);
      expect(empty.timings.medianPlacedToAcceptedSeconds).toBeNull();
      expect(empty.revenueByShop).toEqual([]);

      expect(
        await refusal(w.report.summary(w.adminA, { from: '2024-01-01', to: '2026-03-10' })),
      ).toEqual({ status: 400, code: 'INVALID_DATE_RANGE' });
    });
  });
});

// ===========================================================================
// Privacy
// ===========================================================================

describe('no contact details leave through these routes (FR-PRIV-03)', () => {
  it('no mobile number or email of any student, rider or shop owner appears anywhere', async () => {
    await inRolledBackTransaction(async (w) => {
      const everything = JSON.stringify([
        await w.report.list(w.adminA, {}),
        await w.report.detail(w.adminA, w.id.o1),
        await w.report.detail(w.adminA, w.id.o2),
        await w.report.summary(w.adminA, range),
        await w.report.shopHistory(w.ownerA1, w.listingA1, {}),
      ]);

      expect(w.contacts.length).toBeGreaterThan(8);
      for (const contact of w.contacts) expect(everything).not.toContain(contact);
      expect(everything).not.toMatch(/"(mobile|email|ownerMobile|passwordHash|rollNumber)"/);
      // Nor where anyone is: no coordinates.
      expect(everything).not.toMatch(/[Ll]atitude|[Ll]ongitude/);
    });
  });
});

// ===========================================================================
// Shop history — D-10
// ===========================================================================

describe('GET /shops/:listingId/orders/history', () => {
  it('returns the finished orders the live queue no longer shows', async () => {
    await inRolledBackTransaction(async (w) => {
      const history = await w.report.shopHistory(w.ownerA1, w.listingA1, {});

      // Completed and cancelled by default; o5 (PREPARING) and o7 (PLACED) are live.
      expect(keysOf(w, history.items)).toEqual(['o6', 'o4', 'o3', 'o1']);
      expect(history.listingId).toBe(w.listingA1);

      const row = history.items.find((i) => i.id === w.id.o1)!;
      expect(row).toMatchObject({
        status: 'COMPLETED',
        itemsSubtotalMinor: 12000,
        commissionMinor: 600,
        netToShopMinor: 11400,
        paymentMethod: 'CASH',
        taskStatus: 'COMPLETED',
        student: { name: 'Asha Student' },
        rider: { name: 'Ravi Rider' },
      });
      expect(row.items[0]).toMatchObject({ name: 'Masala Dosa', quantity: 1 });
      // The shop is not shown the student's side of the money.
      expect(row).not.toHaveProperty('totalMinor');
      expect(row).not.toHaveProperty('deliveryFeeMinor');
      expect(row).not.toHaveProperty('paymentStatus');

      // The live queue, for contrast: none of these four.
      const live = await new OrdersService(
        (w.report as unknown as { prisma: never }).prisma,
        new TenantService(),
        {} as never,
      ).shopQueue(w.ownerA1, w.listingA1);
      expect(live.items.map((i) => i.reference).sort()).toEqual([w.ref.o5, w.ref.o7].sort());
    });
  });

  it('filters by date and status, and pages', async () => {
    await inRolledBackTransaction(async (w) => {
      const day = await w.report.shopHistory(w.ownerA1, w.listingA1, range);
      expect(keysOf(w, day.items)).toEqual(['o4', 'o3', 'o1']);

      const cancelled = await w.report.shopHistory(w.ownerA1, w.listingA1, { status: 'CANCELLED' });
      expect(keysOf(w, cancelled.items)).toEqual(['o4', 'o3']);

      const first = await w.report.shopHistory(w.ownerA1, w.listingA1, { limit: '3' });
      expect(first.items).toHaveLength(3);
      const second = await w.report.shopHistory(w.ownerA1, w.listingA1, {
        limit: '3',
        cursor: first.nextCursor!,
      });
      expect(keysOf(w, second.items)).toEqual(['o1']);
      expect(second.nextCursor).toBeNull();
    });
  });

  it('is for the staff of that listing, and administrators of that college, only', async () => {
    await inRolledBackTransaction(async (w) => {
      // The owner of shop A1 does not manage shop A2.
      expect(await refusal(w.report.shopHistory(w.ownerA1, w.listingA2, {}))).toEqual({
        status: 403,
        code: 'NOT_SHOP_STAFF',
      });
      // Nor a shop in another college — refused on tenancy before staff is even checked.
      expect(await refusal(w.report.shopHistory(w.ownerA1, w.listingB, {}))).toEqual({
        status: 403,
        code: 'CROSS_TENANT_ACCESS',
      });
      expect(await refusal(w.report.shopHistory(w.adminB, w.listingA1, {}))).toEqual({
        status: 403,
        code: 'CROSS_TENANT_ACCESS',
      });

      const asAdmin = await w.report.shopHistory(w.adminA, w.listingA2, {});
      expect(keysOf(w, asAdmin.items)).toEqual(['o2']);
    });
  });
});

// ===========================================================================
// An administrator's refund, on real rows (FR-ADM-04)
// ===========================================================================

/**
 * The unit spec shows the method's logic against a stand-in. This runs it
 * where the guarantees it leans on actually live: the advisory lock, the
 * partial unique index that allows one ORDER_RELEASE per order, the CHECK on
 * the balance, and the audit table.
 */
describe('OrdersService.adminCancelInTransaction against PostgreSQL', () => {
  /** A wallet-paid order out for delivery, with its hold on the ledger. */
  async function pickedUpWalletOrder(w: World) {
    const placedAt = new Date('2026-04-02T06:00:00.000Z');
    const order = await w.tx.order.create({
      data: {
        collegeId: w.collegeA,
        reference: `TADM-${randomUUID().slice(0, 8).toUpperCase()}`,
        studentId: w.studentA,
        shopListingId: w.listingA1,
        status: 'PICKED_UP',
        itemsSubtotalMinor: 6000,
        deliveryFeeMinor: 2000,
        platformFeeMinor: 500,
        totalMinor: 8500,
        commissionMinor: 300,
        paymentMethod: 'WALLET',
        paymentStatus: 'HELD',
        placedAt,
        pickedUpAt: new Date(placedAt.getTime() + 900_000),
      },
      select: { id: true },
    });
    await w.tx.task.create({
      data: {
        collegeId: w.collegeA,
        type: 'SHOP_ORDER',
        status: 'ESCALATED',
        orderId: order.id,
        requesterId: w.studentA,
        riderId: w.riderA,
        pickupLabel: 'Shop',
        pickupLatitude: 17.301,
        pickupLongitude: 78.601,
        dropLabel: 'Boys Hostel B',
        dropLatitude: 17.302,
        dropLongitude: 78.602,
        distanceM: 640,
        baseFeeMinor: 2000,
        feeMinor: 2000,
        broadcastRound: 1,
        assignedAt: placedAt,
      },
    });
    // Fund the wallet, then hold the order's total. The fixture student's
    // ledger already ends at 0 (o2's hold), so these stack on top of it.
    const stamp = (seconds: number) => new Date(Date.UTC(2026, 3, 2, 5, 0, seconds));
    await w.tx.walletEntry.create({
      data: {
        userId: w.studentA, direction: 'CREDIT', amountMinor: 10000, type: 'ADJUSTMENT',
        balanceAfterMinor: 10000, note: 'spec funding', createdAt: stamp(0),
      },
    });
    await w.tx.walletEntry.create({
      data: {
        userId: w.studentA, direction: 'DEBIT', amountMinor: 8500, type: 'ORDER_HOLD',
        orderId: order.id, balanceAfterMinor: 1500, note: 'Held', createdAt: stamp(1),
      },
    });
    return order.id;
  }

  const cancel = (w: World, orderId: string) =>
    w.orders.adminCancelInTransaction(w.tx, {
      orderId,
      adminUserId: w.adminA.userId,
      reason: 'Rider could not reach the student.',
    });

  it('cancels, refunds the hold in full once, and leaves the task to the caller', async () => {
    await inRolledBackTransaction(async (w) => {
      const orderId = await pickedUpWalletOrder(w);

      expect(await cancel(w, orderId)).toEqual({
        outcome: 'CANCELLED', refundedMinor: 8500, studentId: w.studentA,
      });

      const order = await w.tx.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order).toMatchObject({
        status: 'CANCELLED', cancelledBy: 'ADMIN', paymentStatus: 'REFUNDED',
        cancelledReason: 'Rider could not reach the student.',
      });

      const ledger = await w.tx.walletEntry.findMany({
        where: { orderId }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }],
      });
      expect(ledger.map((e) => [e.type, e.direction, e.amountMinor, e.balanceAfterMinor])).toEqual([
        ['ORDER_HOLD', 'DEBIT', 8500, 1500],
        ['ORDER_RELEASE', 'CREDIT', 8500, 10000],
      ]);

      // The task is the caller's row: untouched.
      const task = await w.tx.task.findUniqueOrThrow({ where: { orderId } });
      expect(task.status).toBe('ESCALATED');

      // FR-ADM-06: who did it, against the order, in this transaction.
      const audit = await w.tx.auditLog.findMany({
        where: { targetType: 'order', targetId: orderId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: w.adminA.userId, action: 'WALLET_ADJUSTED' });

      // And the administrator's own report shows the same story.
      const detail = await w.report.detail(w.adminA, orderId);
      expect(detail.walletEntries.map((e) => e.type)).toEqual(['ORDER_HOLD', 'ORDER_RELEASE']);
      expect(detail.timeline[detail.timeline.length - 1].event).toBe('CANCELLED');
    });
  });

  it('a second call refunds nothing: the order is no longer PICKED_UP', async () => {
    await inRolledBackTransaction(async (w) => {
      const orderId = await pickedUpWalletOrder(w);

      await cancel(w, orderId);
      expect(await cancel(w, orderId)).toEqual({ outcome: 'STATE_CHANGED' });

      expect(await w.tx.walletEntry.count({ where: { orderId, type: 'ORDER_RELEASE' } })).toBe(1);
    });
  });

  it('does not cancel an order that has just been delivered', async () => {
    await inRolledBackTransaction(async (w) => {
      const orderId = await pickedUpWalletOrder(w);
      await w.tx.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });

      expect(await cancel(w, orderId)).toEqual({ outcome: 'STATE_CHANGED' });

      const order = await w.tx.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order).toMatchObject({ status: 'DELIVERED', paymentStatus: 'HELD' });
      expect(await w.tx.walletEntry.count({ where: { orderId, type: 'ORDER_RELEASE' } })).toBe(0);
    });
  });

  it('reports an unknown order rather than throwing', async () => {
    await inRolledBackTransaction(async (w) => {
      expect(await cancel(w, randomUUID())).toEqual({ outcome: 'ORDER_NOT_FOUND' });
    });
  });
});

// ===========================================================================
// Shop settlement statement — D-14
// ===========================================================================

describe('GET /shops/:listingId/settlements', () => {
  /** A completed order at shop A1 that the fixture does not already hold. */
  async function completedOrder(
    w: World,
    seed: { key: string; method: 'CASH' | 'WALLET'; items: number; commission: number; placedAt: Date; completedAt: Date },
  ) {
    const order = await w.tx.order.create({
      data: {
        collegeId: w.collegeA,
        reference: `TSET-${seed.key}-${randomUUID().slice(0, 6).toUpperCase()}`,
        studentId: w.studentA,
        shopListingId: w.listingA1,
        status: 'COMPLETED',
        itemsSubtotalMinor: seed.items,
        deliveryFeeMinor: 2000,
        platformFeeMinor: 500,
        totalMinor: seed.items + 2500,
        commissionMinor: seed.commission,
        paymentMethod: seed.method,
        paymentStatus: seed.method === 'CASH' ? 'NOT_REQUIRED' : 'CAPTURED',
        placedAt: seed.placedAt,
        completedAt: seed.completedAt,
      },
      select: { id: true, reference: true },
    });
    return order;
  }

  it('closes the routes to counter staff at the guard, and names owner and admin only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ShopSettlementsController)).toEqual(['SHOP_OWNER', 'ADMIN']);
  });

  it('totals the period from completed orders, split by how the student paid', async () => {
    await inRolledBackTransaction(async (w) => {
      // The fixture gives shop A1 one completed cash order on DAY (o1: 12000,
      // commission 600), two cancelled ones and one still being prepared.
      const wallet = await completedOrder(w, {
        key: 'W', method: 'WALLET', items: 8000, commission: 400,
        placedAt: ist('15:00'), completedAt: ist('15:40'),
      });

      const s = await w.settlements.statement(w.ownerA1, w.listingA1, range);

      expect(s.range).toEqual({ from: DAY, to: DAY, timezone: 'Asia/Kolkata' });
      expect(s.basis).toEqual({ status: 'COMPLETED', date: 'completedAt' });
      expect(s.totals).toMatchObject({
        ordersDelivered: 2,
        grossItemsMinor: 20000,
        commissionMinor: 1000,
        netEarningsMinor: 19000,
        effectiveCommissionBps: 500,
      });
      expect(s.byPaymentMethod.cash).toMatchObject({
        orders: 1, grossItemsMinor: 12000, commissionMinor: 600, alreadyReceivedByShopMinor: 12000,
      });
      expect(s.byPaymentMethod.heldByPlatform).toMatchObject({
        orders: 1, grossItemsMinor: 8000, commissionMinor: 400, owedToShopMinor: 7600,
      });
      // Platform holds 8000 and keeps 400 of it; the shop owes 600 on its cash sale.
      expect(s.position).toMatchObject({
        platformOwesShopMinor: 7600,
        shopOwesPlatformMinor: 600,
        netPayableToShopMinor: 7000,
      });

      // The lines are those two orders and add up to the totals.
      expect(s.lines.map((l) => l.reference)).toEqual([wallet.reference, w.ref.o1]);
      expect(s.lines[0]).toMatchObject({
        paymentMethod: 'WALLET', itemsSubtotalMinor: 8000, commissionMinor: 400,
        netToShopMinor: 7600, settledBy: 'PLATFORM',
      });
      expect(s.lines[1]).toMatchObject({
        paymentMethod: 'CASH', itemsSubtotalMinor: 12000, commissionMinor: 600,
        netToShopMinor: 11400, settledBy: 'CASH_AT_COUNTER',
      });
      expect(s.lines.reduce((sum, l) => sum + l.itemsSubtotalMinor, 0)).toBe(s.totals.grossItemsMinor);
      expect(s.lines.reduce((sum, l) => sum + l.commissionMinor, 0)).toBe(s.totals.commissionMinor);

      // Every figure is a whole number of paise.
      const numbers = JSON.stringify(s).match(/Minor":(-?[\d.]+)/g) ?? [];
      expect(numbers.length).toBeGreaterThan(10);
      for (const n of numbers) expect(n).not.toContain('.');
    });
  });

  it('pays nothing out and stores nothing about where to pay', async () => {
    await inRolledBackTransaction(async (w) => {
      const before = await w.tx.walletEntry.count();
      const s = await w.settlements.statement(w.ownerA1, w.listingA1, range);

      expect(s.payout.status).toBe('NOT_AVAILABLE');
      expect(await w.tx.walletEntry.count()).toBe(before);
      expect(await w.tx.withdrawalRequest.count({ where: { userId: w.ownerA1.userId } })).toBe(0);
      expect(JSON.stringify(s)).not.toMatch(/bank|ifsc|upi|account/i);
    });
  });

  it('dates an order by when it was completed, not when it was placed', async () => {
    await inRolledBackTransaction(async (w) => {
      // Placed at 11:50 pm on DAY, handed over at 12:10 am the next day.
      const late = await completedOrder(w, {
        key: 'L', method: 'CASH', items: 5000, commission: 250,
        placedAt: ist('23:50'), completedAt: ist('00:10', '2026-03-11'),
      });

      const day = await w.settlements.statement(w.ownerA1, w.listingA1, range);
      expect(day.lines.map((l) => l.reference)).not.toContain(late.reference);
      expect(day.totals.ordersDelivered).toBe(1);

      const next = await w.settlements.statement(w.ownerA1, w.listingA1, {
        from: '2026-03-11', to: '2026-03-11',
      });
      // o6 (placed and completed just after midnight) and the late one.
      expect(next.lines.map((l) => l.reference).sort()).toEqual([late.reference, w.ref.o6].sort());
      expect(next.totals).toMatchObject({ ordersDelivered: 2, grossItemsMinor: 104000 });
    });
  });

  it('leaves out cancelled and unfinished orders, and other shops', async () => {
    await inRolledBackTransaction(async (w) => {
      // A row that should not exist but could after a bad data fix: cancelled,
      // yet carrying a completion time inside the period. The statement goes
      // by status as well as by date, so it must not be paid on.
      const ghost = await completedOrder(w, {
        key: 'G', method: 'WALLET', items: 70000, commission: 3500,
        placedAt: ist('16:00'), completedAt: ist('16:30'),
      });
      await w.tx.order.update({
        where: { id: ghost.id },
        data: { status: 'CANCELLED', cancelledAt: ist('16:31'), cancelledBy: 'ADMIN' },
      });

      const s = await w.settlements.statement(w.ownerA1, w.listingA1, { from: DAY, to: '2026-03-11' });

      // Of o1..o7 at shop A1: only o1 and o6 completed. o2 is another shop's.
      expect(s.lines.map((l) => l.reference).sort()).toEqual([w.ref.o1, w.ref.o6].sort());
      expect(s.totals).toMatchObject({ ordersDelivered: 2, grossItemsMinor: 111000, commissionMinor: 5550 });
      // All cash: the platform holds nothing, the shop owes the commission.
      expect(s.position).toMatchObject({
        platformOwesShopMinor: 0, shopOwesPlatformMinor: 5550, netPayableToShopMinor: -5550,
      });
    });
  });

  it('is zeros on a period with no deliveries, and pages its lines', async () => {
    await inRolledBackTransaction(async (w) => {
      const empty = await w.settlements.statement(w.ownerA1, w.listingA1, {
        from: '2025-01-01', to: '2025-01-31',
      });
      expect(empty.totals).toMatchObject({ ordersDelivered: 0, grossItemsMinor: 0, effectiveCommissionBps: 0 });
      expect(empty.position.netPayableToShopMinor).toBe(0);
      expect(empty.lines).toEqual([]);

      const wide = { from: DAY, to: '2026-03-11' };
      const first = await w.settlements.statement(w.ownerA1, w.listingA1, { ...wide, limit: '1' });
      expect(first.lines).toHaveLength(1);
      // Totals describe the whole period, not the page.
      expect(first.totals.ordersDelivered).toBe(2);
      const second = await w.settlements.statement(w.ownerA1, w.listingA1, {
        ...wide, limit: '1', cursor: first.nextCursor!,
      });
      expect(second.lines).toHaveLength(1);
      expect(second.lines[0].orderId).not.toBe(first.lines[0].orderId);
      expect(second.nextCursor).toBeNull();

      expect(
        await refusal(w.settlements.statement(w.ownerA1, w.listingA1, { ...wide, cursor: w.id.oB })),
      ).toEqual({ status: 400, code: 'INVALID_CURSOR' });
      expect(
        await refusal(w.settlements.statement(w.ownerA1, w.listingA1, { from: 'last week' })),
      ).toEqual({ status: 400, code: 'INVALID_DATE' });
    });
  });

  it("is for the shop's owner and its college's administrator only", async () => {
    await inRolledBackTransaction(async (w) => {
      // Counter staff of this very shop: can work the queue, cannot see the money.
      expect(await refusal(w.settlements.statement(w.staffA1, w.listingA1, range))).toEqual({
        status: 403, code: 'NOT_SHOP_OWNER',
      });
      // The owner of A1 has no claim on shop A2, or on a shop in another college.
      expect(await refusal(w.settlements.statement(w.ownerA1, w.listingA2, range))).toEqual({
        status: 403, code: 'NOT_SHOP_STAFF',
      });
      expect(await refusal(w.settlements.statement(w.ownerA1, w.listingB, range))).toEqual({
        status: 403, code: 'CROSS_TENANT_ACCESS',
      });
      expect(await refusal(w.settlements.statement(w.adminB, w.listingA1, range))).toEqual({
        status: 403, code: 'CROSS_TENANT_ACCESS',
      });
      expect(await refusal(w.settlements.statement(w.adminA, randomUUID(), range))).toEqual({
        status: 404, code: 'SHOP_NOT_FOUND',
      });

      const asAdmin = await w.settlements.statement(w.adminA, w.listingA2, range);
      expect(asAdmin.totals).toMatchObject({ ordersDelivered: 1, grossItemsMinor: 8000 });
      // o2 was paid from the wallet: the platform owes that shop 8000 - 400.
      expect(asAdmin.position.netPayableToShopMinor).toBe(7600);
    });
  });
});
