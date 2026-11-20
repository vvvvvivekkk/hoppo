import { ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PlatformService, isValidTimeZone } from './platform.service';
import { PlatformController } from './platform.controller';
import { AuditService } from '../audit/audit.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  type Tx,
  databaseUrl,
  inRolledBackTransaction,
  makeCollege,
  makeUser,
  prismaOver,
} from '../common/testing/rolled-back-transaction';

/** FR-TEN-01 and FR-ADM-07 against PostgreSQL. Rolled back; nothing persists. */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

async function world(tx: Tx) {
  const root = await makeUser(tx, null, 'SUPER_ADMIN');
  const auth = { revokeAllSessions: jest.fn().mockResolvedValue(2) };
  const gateway = { disconnectUser: jest.fn() };
  const prisma = prismaOver(tx) as never;
  const service = new PlatformService(
    prisma,
    new AuditService(prisma),
    auth as never,
    gateway as never,
  );
  const superAdmin: AuthenticatedUser = {
    userId: root.id,
    collegeId: null,
    role: 'SUPER_ADMIN',
    isVerified: false,
  };
  return { service, superAdmin, auth, gateway };
}

const tag = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

const collegeBody = (name: string) => ({
  name,
  address: '12 Campus Road',
  city: 'Warangal',
  state: 'Telangana',
  latitude: 17.98,
  longitude: 79.53,
});

describe('platform: colleges (FR-TEN-01)', () => {
  jest.setTimeout(30_000);

  it('creates a college with a 3 km default radius, a config row and fee bands', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const name = `Spec Institute ${tag()}`;

      const college = await w.service.createCollege(w.superAdmin, collegeBody(name));

      expect(college).toMatchObject({
        name,
        status: 'ACTIVE',
        timezone: 'Asia/Kolkata',
        serviceableRadiusM: 3000,
        counts: { admins: 0, students: 0, shopListings: 0 },
      });

      const config = await tx.collegeConfig.findUniqueOrThrow({ where: { collegeId: college.id } });
      expect(config.serviceableRadiusM).toBe(3000);
      const bands = await tx.feeBand.findMany({
        where: { collegeId: college.id },
        orderBy: { minDistanceM: 'asc' },
      });
      expect(bands.length).toBeGreaterThan(0);
      expect(bands[0].minDistanceM).toBe(0);
      expect(bands[bands.length - 1].maxDistanceM).toBeNull();

      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'COLLEGE_CREATED', targetId: college.id },
      });
      expect(audit.actorId).toBe(w.superAdmin.userId);
    });
  });

  it('honours a requested radius, and refuses a duplicate name or an unknown timezone', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const name = `Spec Institute ${tag()}`;

      const college = await w.service.createCollege(w.superAdmin, {
        ...collegeBody(name),
        serviceableRadiusM: 4500,
        timezone: 'Asia/Dubai',
      });
      expect(college).toMatchObject({ serviceableRadiusM: 4500, timezone: 'Asia/Dubai' });

      await expect(
        w.service.createCollege(w.superAdmin, collegeBody(name.toUpperCase())),
      ).rejects.toMatchObject({ response: { code: 'COLLEGE_NAME_TAKEN' } });

      await expect(
        w.service.createCollege(w.superAdmin, {
          ...collegeBody(`Other ${tag()}`),
          timezone: 'Mars/Olympus_Mons',
        }),
      ).rejects.toMatchObject({ response: { code: 'INVALID_TIMEZONE' } });
    });
  });

  it('deactivates and reactivates a college without deleting anything', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const college = await makeCollege(tx, tag());
      await makeUser(tx, college.id, 'STUDENT');

      const off = await w.service.setCollegeStatus(w.superAdmin, college.id, 'INACTIVE', 'Left');
      expect(off.status).toBe('INACTIVE');
      expect(await tx.user.count({ where: { collegeId: college.id } })).toBe(1);
      await expect(
        w.service.setCollegeStatus(w.superAdmin, college.id, 'INACTIVE', 'Again'),
      ).rejects.toMatchObject({ response: { code: 'ALREADY_INACTIVE' } });

      await expect(
        w.service.createCollegeAdmin(w.superAdmin, college.id, {
          name: 'Late Admin',
          mobile: '+919999900001',
          email: `late-${tag()}@example.test`,
          password: 'a-long-password',
        }),
      ).rejects.toMatchObject({ response: { code: 'COLLEGE_INACTIVE' } });

      const on = await w.service.setCollegeStatus(w.superAdmin, college.id, 'ACTIVE');
      expect(on.status).toBe('ACTIVE');

      const actions = await tx.auditLog.findMany({
        where: { targetId: college.id },
        select: { action: true },
      });
      expect(actions.map((a) => a.action).sort()).toEqual([
        'COLLEGE_ACTIVATED',
        'COLLEGE_DEACTIVATED',
      ]);
    });
  });
});

describe('platform: college administrators (FR-ADM-07)', () => {
  jest.setTimeout(30_000);

  it('creates an ADMIN attached to the college, then deactivates and reactivates it', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const college = await makeCollege(tx, tag());
      const email = `admin-${tag()}@example.test`;

      const admin = await w.service.createCollegeAdmin(w.superAdmin, college.id, {
        name: 'New Admin',
        mobile: `+9199${String(Date.now()).slice(-8)}`,
        email,
        password: 'a-long-password',
      });

      expect(admin).toMatchObject({ collegeId: college.id, status: 'ACTIVE', email });
      expect(admin).not.toHaveProperty('passwordHash');
      const row = await tx.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(row.role).toBe('ADMIN');
      expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);

      const detail = await w.service.collegeDetail(w.superAdmin, college.id);
      expect(detail.admins.map((a) => a.id)).toEqual([admin.id]);
      expect(detail.counts.admins).toBe(1);

      const off = await w.service.setAdminStatus(w.superAdmin, admin.id, 'DEACTIVATED', 'Left');
      expect(off.status).toBe('DEACTIVATED');
      expect(w.auth.revokeAllSessions).toHaveBeenCalledWith(admin.id);
      expect(w.gateway.disconnectUser).toHaveBeenCalledWith(admin.id);

      const on = await w.service.setAdminStatus(w.superAdmin, admin.id, 'ACTIVE');
      expect(on.status).toBe('ACTIVE');

      const actions = await tx.auditLog.findMany({
        where: { targetId: admin.id },
        select: { action: true },
      });
      expect(actions.map((a) => a.action).sort()).toEqual([
        'ADMIN_CREATED',
        'ADMIN_DEACTIVATED',
        'ADMIN_REACTIVATED',
      ]);
    });
  });

  it('will not deactivate a student, a shop owner or a super administrator this way', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const college = await makeCollege(tx, tag());
      const student = await makeUser(tx, college.id, 'STUDENT');
      const owner = await makeUser(tx, college.id, 'SHOP_OWNER');

      for (const id of [student.id, owner.id, w.superAdmin.userId]) {
        await expect(
          w.service.setAdminStatus(w.superAdmin, id, 'DEACTIVATED', 'Wrong route'),
        ).rejects.toMatchObject({ response: { code: 'NOT_AN_ADMIN' } });
      }
      expect((await tx.user.findUniqueOrThrow({ where: { id: student.id } })).status).toBe(
        'ACTIVE',
      );
      expect(w.auth.revokeAllSessions).not.toHaveBeenCalled();
    });
  });

  it('refuses a college administrator on every method, whatever college they name', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const mine = await makeCollege(tx, `${tag()}-mine`);
      const theirs = await makeCollege(tx, `${tag()}-theirs`);
      const adminRow = await makeUser(tx, mine.id, 'ADMIN');
      const victim = await makeUser(tx, theirs.id, 'ADMIN');
      const admin: AuthenticatedUser = {
        userId: adminRow.id,
        collegeId: mine.id,
        role: 'ADMIN',
        isVerified: false,
      };
      const before = await tx.college.count();

      const attempts = [
        () => w.service.listColleges(admin),
        () => w.service.collegeDetail(admin, theirs.id),
        () => w.service.createCollege(admin, collegeBody(`Rogue ${tag()}`)),
        () => w.service.setCollegeStatus(admin, theirs.id, 'INACTIVE', 'Rival'),
        () =>
          w.service.createCollegeAdmin(admin, mine.id, {
            name: 'Friend',
            mobile: '+919999900002',
            email: `friend-${tag()}@example.test`,
            password: 'a-long-password',
          }),
        () => w.service.setAdminStatus(admin, victim.id, 'DEACTIVATED', 'Rival'),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toBeInstanceOf(ForbiddenException);
      }

      expect(await tx.college.count()).toBe(before);
      expect((await tx.college.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe(
        'ACTIVE',
      );
      expect((await tx.user.findUniqueOrThrow({ where: { id: victim.id } })).status).toBe('ACTIVE');
    });
  });
});

describe('platform routes', () => {
  it('admit a super administrator only', () => {
    expect(Reflect.getMetadata('roles', PlatformController)).toEqual(['SUPER_ADMIN']);

    const guard = new RolesGuard(new Reflector());
    const contextFor = (role: AuthenticatedUser['role']) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ user: { userId: 'u', collegeId: 'c', role, isVerified: false } }),
        }),
        getHandler: () => PlatformController.prototype.createCollege,
        getClass: () => PlatformController,
      }) as unknown as ExecutionContext;

    expect(guard.canActivate(contextFor('SUPER_ADMIN'))).toBe(true);
    for (const role of ['ADMIN', 'SHOP_OWNER', 'SHOP_STAFF', 'STUDENT'] as const) {
      expect(() => guard.canActivate(contextFor(role))).toThrow(ForbiddenException);
    }
  });

  it('knows a real timezone from a made-up one', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});
