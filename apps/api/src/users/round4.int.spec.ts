import { PrismaClient } from '@prisma/client';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';
import { PlatformService } from './platform.service';
import { PlatformController } from './platform.controller';
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
 * S-50 profile editing, the export's delivery label, and password recovery
 * for administrators created by the super administrator. PostgreSQL, rolled
 * back; nothing persists.
 */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

type LooseAccount = {
  updateProfile(
    user: AuthenticatedUser,
    dto: Record<string, unknown>,
  ): Promise<{
    user: Record<string, unknown> | null;
  }>;
  exportData(user: AuthenticatedUser): Promise<{ orders: Record<string, unknown>[] }>;
};
type LoosePlatform = {
  createCollegeAdmin(
    user: AuthenticatedUser,
    collegeId: string,
    dto: Record<string, unknown>,
  ): Promise<{ id: string }>;
  setAdminPassword(
    user: AuthenticatedUser,
    adminId: string,
    password: string,
  ): Promise<Record<string, unknown>>;
};

const tag = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

async function accountWorld(tx: Tx) {
  const college = await makeCollege(tx, tag());
  const otherCollege = await makeCollege(tx, `${tag()}-other`);
  const me = await makeUser(tx, college.id, 'STUDENT', { name: 'Asha Before' });
  await tx.studentProfile.create({
    data: {
      userId: me.id,
      rollNumber: 'ROLL-1',
      department: 'CSE',
      yearOfStudy: 3,
      verificationStatus: 'VERIFIED',
    },
  });
  const prisma = prismaOver(tx) as never;
  const storage = {
    publicUrl: (key: string) => `https://cdn.example.test/hoppo-public/${key}`,
    publicKeyFromUrl: (url: string | null) =>
      url ? (url.split('/hoppo-public/')[1] ?? null) : null,
    deletePublicObject: jest.fn().mockResolvedValue(true),
    deletePrivateObject: jest.fn(),
  };
  const service = new AccountService(
    prisma,
    {} as never,
    storage as never,
    new AuditService(prisma),
    {} as never,
    {} as never,
  ) as unknown as LooseAccount;
  const user: AuthenticatedUser = {
    userId: me.id,
    collegeId: college.id,
    role: 'STUDENT',
    isVerified: true,
  };
  return { service, college, otherCollege, me, user, storage };
}

describe('PATCH /account/profile against PostgreSQL (S-50)', () => {
  jest.setTimeout(30_000);

  it('changes the name, audits that it changed, and answers like GET /auth/me', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await accountWorld(tx);

      const result = await w.service.updateProfile(w.user, { name: 'Asha After' });

      expect(result.user).toMatchObject({
        id: w.me.id,
        name: 'Asha After',
        mobile: w.me.mobile,
        email: w.me.email,
        role: 'STUDENT',
        studentProfile: { rollNumber: 'ROLL-1', verificationStatus: 'VERIFIED' },
        privacyNotice: null,
      });
      expect((await tx.user.findUniqueOrThrow({ where: { id: w.me.id } })).name).toBe('Asha After');

      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'PROFILE_UPDATED', targetId: w.me.id },
      });
      // That it changed — not from what, nor to what: this row can never be
      // erased, so it must not hold a name.
      expect(audit.detail).toEqual({ changed: ['name'] });
      expect(JSON.stringify(audit)).not.toContain('Asha');
    });
  });

  it('writes and audits nothing when the name is unchanged', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await accountWorld(tx);

      const result = await w.service.updateProfile(w.user, { name: 'Asha Before' });

      expect(result.user).toMatchObject({ name: 'Asha Before' });
      expect(await tx.auditLog.count({ where: { targetId: w.me.id } })).toBe(0);
    });
  });

  it.each([
    [{ email: 'new@example.test' }, 'EMAIL_CHANGE_NOT_SUPPORTED'],
    [{ mobile: '+919812345678' }, 'MOBILE_CHANGE_NOT_SUPPORTED'],
    [{ rollNumber: 'ROLL-2' }, 'VERIFIED_FIELD_NOT_EDITABLE'],
    [{ department: 'ECE' }, 'VERIFIED_FIELD_NOT_EDITABLE'],
    [{ yearOfStudy: 4 }, 'VERIFIED_FIELD_NOT_EDITABLE'],
    [{ name: 'Sneaky', email: 'new@example.test' }, 'EMAIL_CHANGE_NOT_SUPPORTED'],
    [{}, 'EMPTY_UPDATE'],
  ])('refuses %j with %s and changes nothing', async (body, code) => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await accountWorld(tx);

      await expect(w.service.updateProfile(w.user, body)).rejects.toMatchObject({
        status: 400,
        response: { code },
      });

      const row = await tx.user.findUniqueOrThrow({
        where: { id: w.me.id },
        include: { studentProfile: true },
      });
      expect(row).toMatchObject({ name: 'Asha Before', mobile: w.me.mobile, email: w.me.email });
      expect(row.studentProfile).toMatchObject({
        rollNumber: 'ROLL-1',
        department: 'CSE',
        yearOfStudy: 3,
      });
    });
  });

  it("accepts only an avatar key issued to this user's own avatar uploads", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await accountWorld(tx);
      const mine = `avatar/${w.me.id}/3f2b6c1e-0d0a-4b7e-9d1c-1a2b3c4d5e6f.png`;

      for (const key of [
        'avatar/someone-else/3f2b6c1e-0d0a-4b7e-9d1c-1a2b3c4d5e6f.png',
        `id_card/${w.me.id}/3f2b6c1e-0d0a-4b7e-9d1c-1a2b3c4d5e6f.png`,
        `avatar/${w.me.id}/../../id_card/x.png`,
        'https://evil.example/x.png',
        `avatar/${w.me.id}/x.svg`,
      ]) {
        await expect(w.service.updateProfile(w.user, { avatarKey: key })).rejects.toMatchObject({
          response: { code: 'AVATAR_KEY_INVALID' },
        });
      }
      expect((await tx.user.findUniqueOrThrow({ where: { id: w.me.id } })).avatarUrl).toBeNull();

      const set = await w.service.updateProfile(w.user, { avatarKey: mine });
      expect(set.user).toMatchObject({
        avatarUrl: `https://cdn.example.test/hoppo-public/${mine}`,
      });

      const cleared = await w.service.updateProfile(w.user, { avatarKey: null });
      expect(cleared.user).toMatchObject({ avatarUrl: null });
      // The photo itself is removed, not only the pointer to it.
      expect(w.storage.deletePublicObject).toHaveBeenCalledTimes(1);
      expect(w.storage.deletePublicObject).toHaveBeenCalledWith(mine);
    });
  });

  it('is a student route with no id in it', () => {
    const handler = (AccountController.prototype as unknown as Record<string, object>)
      .updateProfile;
    expect(Reflect.getMetadata('roles', AccountController)).toEqual(['STUDENT']);
    expect(Reflect.getMetadata('path', handler)).toBe('profile');
    expect(Reflect.getMetadata('method', handler)).toBe(4); // RequestMethod.PATCH
  });
});

describe('GET /account/export: where an order was delivered', () => {
  jest.setTimeout(30_000);

  it("labels a campus-point order with the point's name, and a landmark order with its text", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await accountWorld(tx);
      const owner = await makeUser(tx, w.college.id, 'SHOP_OWNER');
      const shop = await tx.shop.create({
        data: {
          name: 'Spec Canteen',
          category: 'FOOD',
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
          collegeId: w.college.id,
          distanceFromCollegeM: 500,
          status: 'ACTIVE',
        },
      });
      // Retired since the order: its name must still be reported.
      const point = await tx.deliveryPoint.create({
        data: {
          collegeId: w.college.id,
          name: 'Girls Hostel Block C',
          latitude: 17.3,
          longitude: 78.6,
          isActive: false,
        },
      });
      // Same-named trap in another college: must never be the one read.
      const foreign = await tx.deliveryPoint.create({
        data: {
          collegeId: w.otherCollege.id,
          name: 'Another campus',
          latitude: 17.3,
          longitude: 78.6,
        },
      });

      const order = (reference: string, where: Record<string, unknown>) =>
        tx.order.create({
          data: {
            collegeId: w.college.id,
            reference,
            studentId: w.me.id,
            shopListingId: listing.id,
            status: 'COMPLETED',
            itemsSubtotalMinor: 10000,
            deliveryFeeMinor: 2000,
            totalMinor: 12000,
            paymentMethod: 'CASH',
            ...where,
          },
        });
      const unique = tag();
      await order(`SPEC-${unique}-1`, { deliveryPointId: point.id });
      await order(`SPEC-${unique}-2`, { dropLandmark: 'Behind the canteen' });
      await order(`SPEC-${unique}-3`, { deliveryPointId: foreign.id });

      const data = await w.service.exportData(w.user);

      const labels = Object.fromEntries(data.orders.map((o) => [o.reference, o.deliveryLabel]));
      expect(labels).toEqual({
        [`SPEC-${unique}-1`]: 'Girls Hostel Block C',
        [`SPEC-${unique}-2`]: 'Behind the canteen',
        // A point id from another college resolves to nothing (C-1).
        [`SPEC-${unique}-3`]: null,
      });
      // The internal id is not part of the export.
      expect(JSON.stringify(data)).not.toContain(point.id);
    });
  });
});

describe('college administrators and password recovery (FR-ADM-07, FR-AUTH-07)', () => {
  jest.setTimeout(30_000);

  async function platformWorld(tx: Tx) {
    const root = await makeUser(tx, null, 'SUPER_ADMIN');
    const college = await makeCollege(tx, tag());
    const auth = { revokeAllSessions: jest.fn().mockResolvedValue(2) };
    const gateway = { disconnectUser: jest.fn() };
    const prisma = prismaOver(tx) as never;
    const service = new PlatformService(
      prisma,
      new AuditService(prisma),
      auth as never,
      gateway as never,
    ) as unknown as LoosePlatform;
    const superAdmin: AuthenticatedUser = {
      userId: root.id,
      collegeId: null,
      role: 'SUPER_ADMIN',
      isVerified: false,
    };
    const newAdmin = () =>
      service.createCollegeAdmin(superAdmin, college.id, {
        name: 'New Admin',
        mobile: `+9199${String(Date.now()).slice(-8)}`,
        email: `admin-${tag()}@example.test`,
        password: 'the-first-password',
      });
    return { service, superAdmin, college, auth, gateway, newAdmin };
  }

  it('marks a new administrator’s mobile verified, so password reset can reach them', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await platformWorld(tx);

      const admin = await w.newAdmin();

      const row = await tx.user.findUniqueOrThrow({ where: { id: admin.id } });
      // AuthService.requestPasswordReset sends a code only when this is set.
      expect(row.mobileVerifiedAt).toBeInstanceOf(Date);

      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'ADMIN_CREATED', targetId: admin.id },
      });
      expect(audit.detail).toMatchObject({ mobileVouchedBy: w.superAdmin.userId });
    });
  });

  it('lets the super administrator set an administrator’s password, ending their sessions', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await platformWorld(tx);
      const admin = await w.newAdmin();
      const before = (await tx.user.findUniqueOrThrow({ where: { id: admin.id } })).passwordHash;
      await tx.user.update({
        where: { id: admin.id },
        data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() + 600_000) },
      });

      const result = await w.service.setAdminPassword(
        w.superAdmin,
        admin.id,
        'a-replacement-password',
      );

      const row = await tx.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(row.passwordHash).not.toBe(before);
      expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
      // The lock-out that made this necessary is lifted with it.
      expect(row).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
      expect(w.auth.revokeAllSessions).toHaveBeenCalledWith(admin.id);
      expect(w.gateway.disconnectUser).toHaveBeenCalledWith(admin.id);
      expect(result).toMatchObject({ id: admin.id, sessionsRevoked: 2 });
      expect(result).not.toHaveProperty('passwordHash');

      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'ADMIN_PASSWORD_SET', targetId: admin.id },
      });
      expect(audit.actorId).toBe(w.superAdmin.userId);
      // Who and when — never the password or its hash.
      expect(JSON.stringify(audit)).not.toContain('a-replacement-password');
      expect(JSON.stringify(audit)).not.toContain(row.passwordHash);
    });
  });

  it('will not set the password of a student or a super administrator, nor for a college admin', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await platformWorld(tx);
      const student = await makeUser(tx, w.college.id, 'STUDENT');
      const admin = await w.newAdmin();
      const hashOf = async (id: string) =>
        (await tx.user.findUniqueOrThrow({ where: { id } })).passwordHash;
      const studentHash = await hashOf(student.id);
      const adminHash = await hashOf(admin.id);

      for (const id of [student.id, w.superAdmin.userId]) {
        await expect(
          w.service.setAdminPassword(w.superAdmin, id, 'a-replacement-password'),
        ).rejects.toMatchObject({ response: { code: 'NOT_AN_ADMIN' } });
      }

      // Another administrator of the same college may not do it either.
      const peer = await makeUser(tx, w.college.id, 'ADMIN');
      await expect(
        w.service.setAdminPassword(
          { userId: peer.id, collegeId: w.college.id, role: 'ADMIN', isVerified: false },
          admin.id,
          'a-replacement-password',
        ),
      ).rejects.toMatchObject({ status: 403 });

      expect(await hashOf(student.id)).toBe(studentHash);
      expect(await hashOf(admin.id)).toBe(adminHash);
      expect(w.auth.revokeAllSessions).not.toHaveBeenCalled();
    });
  });

  it('the route is under the SUPER_ADMIN-only controller and answers 200', () => {
    const handler = (PlatformController.prototype as unknown as Record<string, object>)
      .setAdminPassword;
    expect(Reflect.getMetadata('roles', PlatformController)).toEqual(['SUPER_ADMIN']);
    expect(Reflect.getMetadata('path', handler)).toBe('admins/:userId/password');
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(200);
  });
});
