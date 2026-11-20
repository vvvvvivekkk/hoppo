import { PrismaClient } from '@prisma/client';
import { AuditLogController } from './audit.controller';
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

/** FR-ADM-06 / A-15: the audit log viewer against PostgreSQL. Rolled back. */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

async function world(tx: Tx) {
  const tag = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const a = await makeCollege(tx, `${tag}-a`);
  const b = await makeCollege(tx, `${tag}-b`);
  const adminA = await makeUser(tx, a.id, 'ADMIN');
  const adminB = await makeUser(tx, b.id, 'ADMIN');

  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  const entry = (
    collegeId: string | null,
    actorId: string | null,
    action: string,
    targetType: string,
    targetId: string,
    minutesAgo: number,
  ) =>
    tx.auditLog.create({
      data: { collegeId, actorId, action, targetType, targetId, createdAt: at(minutesAgo) },
    });

  // College A: four entries, oldest first. College B: one. No college: one.
  await entry(a.id, adminA.id, 'SHOP_APPROVED', 'shop_listing', 'listing-1', 40);
  await entry(a.id, adminA.id, 'SHOP_SUSPENDED', 'shop_listing', 'listing-1', 30);
  await entry(a.id, null, 'TASK_ESCALATED', 'task', 'task-1', 20);
  await entry(a.id, adminA.id, 'STUDENT_SUSPENDED', 'user', 'student-1', 10);
  await entry(b.id, adminB.id, 'SHOP_APPROVED', 'shop_listing', 'listing-9', 5);
  await entry(null, adminA.id, 'SESSIONS_REVOKED', 'user', adminA.id, 1);

  const controller = new AuditLogController(prismaOver(tx) as never, new TenantService());
  const as = (
    u: { id: string; collegeId: string | null },
    role: 'ADMIN' | 'SUPER_ADMIN' = 'ADMIN',
  ): AuthenticatedUser => ({ userId: u.id, collegeId: u.collegeId, role, isVerified: false });

  return { controller, a, b, adminA, adminB, as, at };
}

describe('GET /admin/audit-log against PostgreSQL', () => {
  jest.setTimeout(30_000);

  it("shows an administrator their own college's entries only, newest first", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const page = await w.controller.list(w.as(w.adminA), {});

      expect(page.items.map((i) => i.action)).toEqual([
        'STUDENT_SUSPENDED',
        'TASK_ESCALATED',
        'SHOP_SUSPENDED',
        'SHOP_APPROVED',
      ]);
      expect(new Set(page.items.map((i) => i.collegeId))).toEqual(new Set([w.a.id]));
      expect(page.items[0].actor).toMatchObject({ id: w.adminA.id, role: 'ADMIN' });
      // A system action has no actor.
      expect(page.items[1].actor).toBeNull();
      expect(page.nextCursor).toBeNull();
    });
  });

  it("cannot be pointed at another college, by filter or by someone else's ids", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const asB = w.as(w.adminB);

      // ?collegeId= is ignored for an ADMIN.
      const forced = await w.controller.list(asB, { collegeId: w.a.id });
      expect(forced.items.map((i) => i.targetId)).toEqual(['listing-9']);

      // Filtering on college A's target or actor returns nothing.
      expect((await w.controller.list(asB, { targetId: 'listing-1' })).items).toEqual([]);
      expect((await w.controller.list(asB, { actorId: w.adminA.id })).items).toEqual([]);
    });
  });

  it('filters by action, target, actor and date range', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const asA = w.as(w.adminA);
      const actions = async (query: Record<string, string>) =>
        (await w.controller.list(asA, query)).items.map((i) => i.action);

      expect(await actions({ action: 'SHOP_SUSPENDED' })).toEqual(['SHOP_SUSPENDED']);
      expect(await actions({ targetType: 'shop_listing', targetId: 'listing-1' })).toEqual([
        'SHOP_SUSPENDED',
        'SHOP_APPROVED',
      ]);
      expect(await actions({ actorId: w.adminA.id })).toEqual([
        'STUDENT_SUSPENDED',
        'SHOP_SUSPENDED',
        'SHOP_APPROVED',
      ]);
      // from inclusive, to exclusive: 35..15 minutes ago holds two entries.
      expect(await actions({ from: w.at(35).toISOString(), to: w.at(15).toISOString() })).toEqual([
        'TASK_ESCALATED',
        'SHOP_SUSPENDED',
      ]);
    });
  });

  it('pages with a cursor without repeating or skipping', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const asA = w.as(w.adminA);

      const first = await w.controller.list(asA, { limit: '3' });
      expect(first.items).toHaveLength(3);
      expect(first.nextCursor).toBe(first.items[2].id);

      const second = await w.controller.list(asA, { limit: '3', cursor: first.nextCursor! });
      expect(second.items.map((i) => i.action)).toEqual(['SHOP_APPROVED']);
      expect(second.nextCursor).toBeNull();
    });
  });

  it('lets a super administrator see every college, or choose one', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const root = await makeUser(tx, null, 'SUPER_ADMIN');
      const asRoot = w.as(root, 'SUPER_ADMIN');

      const onlyB = await w.controller.list(asRoot, { collegeId: w.b.id });
      expect(onlyB.items.map((i) => i.targetId)).toEqual(['listing-9']);

      // Entries recorded against no college are theirs alone to see.
      const sessions = await w.controller.list(asRoot, {
        action: 'SESSIONS_REVOKED',
        targetId: w.adminA.id,
      });
      expect(sessions.items).toHaveLength(1);
      expect(
        (await w.controller.list(w.as(w.adminA), { action: 'SESSIONS_REVOKED' })).items,
      ).toEqual([]);
    });
  });

  it('rejects a date it cannot read, and a range that runs backwards', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const asA = w.as(w.adminA);

      await expect(w.controller.list(asA, { from: 'yesterday-ish' })).rejects.toMatchObject({
        response: { code: 'INVALID_DATE_RANGE' },
      });
      await expect(
        w.controller.list(asA, { from: '2026-11-21', to: '2026-11-20' }),
      ).rejects.toMatchObject({ response: { code: 'INVALID_DATE_RANGE' } });
    });
  });
});

describe('audit log routes', () => {
  it('are read-only and restricted to administrators', () => {
    expect(Reflect.getMetadata('roles', AuditLogController)).toEqual(['ADMIN']);

    // Every method that is a route (has a path), whatever it is called.
    const proto = AuditLogController.prototype as unknown as Record<string, object>;
    const handlers = Object.getOwnPropertyNames(AuditLogController.prototype).filter(
      (name) => name !== 'constructor' && Reflect.getMetadata('path', proto[name]) !== undefined,
    );
    expect(handlers.sort()).toEqual(['actions', 'export', 'list']);
    for (const name of handlers) {
      const handler = (AuditLogController.prototype as unknown as Record<string, object>)[name];
      // RequestMethod.GET === 0: there is no POST, PATCH, PUT or DELETE.
      expect(Reflect.getMetadata('method', handler)).toBe(0);
    }
  });

  it('lists the known action names for the filter', () => {
    const controller = new AuditLogController({} as never, new TenantService());
    const { actions } = controller.actions();
    expect(actions).toEqual([...actions].sort());
    expect(actions).toEqual(
      expect.arrayContaining(['COLLEGE_CONFIG_CHANGED', 'SHOP_REINSTATED', 'ACCOUNT_DELETED']),
    );
  });
});
