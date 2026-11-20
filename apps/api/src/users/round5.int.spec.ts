import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';
import { PlatformService } from './platform.service';
import { AuthService } from '../auth/auth.service';
import { readMe } from '../auth/me';
import { AuditService } from '../audit/audit.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { PRIVACY_NOTICE_VERSION } from '../common/legal/privacy-notice';
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
 * Audit round 5: college deactivation ends sessions, account deletion leaves
 * no personal residue it can remove and says exactly what it did, the
 * deletion route is for students only, and privacy acceptance lives on the
 * account. PostgreSQL, rolled back; nothing persists.
 */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

const tag = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

const session = (tx: Tx, userId: string, label: string) =>
  tx.refreshToken.create({
    data: {
      userId,
      tokenHash: `spec-${label}-${userId}-${tag()}`,
      familyId: `${label}-${userId}`,
      ipAddress: '203.0.113.7',
      userAgent: 'SpecPhone/1.0',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

describe('deactivating a college ends its sessions (FR-ADM-07)', () => {
  jest.setTimeout(30_000);

  it('revokes every refresh token of the college and disconnects each account, after commit', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const root = await makeUser(tx, null, 'SUPER_ADMIN');
      const closing = await makeCollege(tx, `${tag()}-closing`);
      const open = await makeCollege(tx, `${tag()}-open`);
      const student = await makeUser(tx, closing.id, 'STUDENT');
      const admin = await makeUser(tx, closing.id, 'ADMIN');
      const bystander = await makeUser(tx, open.id, 'STUDENT');
      await session(tx, student.id, 'phone');
      await session(tx, student.id, 'laptop');
      await session(tx, admin.id, 'console');
      await session(tx, bystander.id, 'phone');
      await session(tx, root.id, 'console');

      const order: string[] = [];
      const gateway = { disconnectUser: jest.fn((id: string) => order.push(`disconnect:${id}`)) };
      const base = prismaOver(tx) as Record<string, unknown>;
      const prisma = new Proxy(base, {
        get(target, prop) {
          if (prop === '$transaction') {
            return async (fn: (client: Tx) => Promise<unknown>) => {
              const result = await fn(tx);
              order.push('commit');
              return result;
            };
          }
          return target[prop as string];
        },
      });
      const service = new PlatformService(
        prisma as never,
        new AuditService(prisma as never),
        { revokeAllSessions: jest.fn() } as never,
        gateway as never,
      );
      const superAdmin: AuthenticatedUser = {
        userId: root.id,
        collegeId: null,
        role: 'SUPER_ADMIN',
        isVerified: false,
      };

      const result = await service.setCollegeStatus(superAdmin, closing.id, 'INACTIVE', 'Closing');
      expect(result.status).toBe('INACTIVE');

      const live = (userId: string) =>
        tx.refreshToken.count({ where: { userId, revokedAt: null } });
      expect(await live(student.id)).toBe(0);
      expect(await live(admin.id)).toBe(0);
      // Nobody outside the college loses a session.
      expect(await live(bystander.id)).toBe(1);
      expect(await live(root.id)).toBe(1);

      expect(gateway.disconnectUser.mock.calls.map((c) => c[0]).sort()).toEqual(
        [student.id, admin.id].sort(),
      );
      // Sockets are dropped only once the deactivation has committed.
      expect(order[0]).toBe('commit');
      expect(order.slice(1).every((step) => step.startsWith('disconnect:'))).toBe(true);

      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'COLLEGE_DEACTIVATED', targetId: closing.id },
      });
      expect(audit.detail).toMatchObject({ reason: 'Closing', sessionsRevoked: 3, accounts: 2 });

      // Reactivating does not resurrect the revoked sessions or touch sockets.
      gateway.disconnectUser.mockClear();
      await service.setCollegeStatus(superAdmin, closing.id, 'ACTIVE');
      expect(await live(student.id)).toBe(0);
      expect(gateway.disconnectUser).not.toHaveBeenCalled();
    });
  });
});

describe('account deletion: what is left behind', () => {
  jest.setTimeout(30_000);

  const PASSWORD = 'correct horse battery';

  async function world(tx: Tx, storageConfigured: boolean) {
    const college = await makeCollege(tx, tag());
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const me = await makeUser(tx, college.id, 'STUDENT', {
      passwordHash,
      name: 'Asha Mine',
      avatarUrl: 'https://cdn.example.test/hoppo-public/avatar/me/photo.png',
    });
    const other = await makeUser(tx, college.id, 'STUDENT', { name: 'Ravi Other' });
    await tx.studentProfile.create({
      data: {
        userId: me.id,
        rollNumber: 'ROLL-1',
        department: 'CSE',
        yearOfStudy: 3,
        idCardUrl: `id_card/${me.id}/card.jpg`,
        verificationStatus: 'VERIFIED',
      },
    });

    const storage = {
      deletePrivateObject: jest.fn().mockResolvedValue(storageConfigured),
      deletePublicObject: jest.fn().mockResolvedValue(storageConfigured),
      publicKeyFromUrl: (url: string | null) =>
        url ? (url.split('/hoppo-public/')[1] ?? null) : null,
    };
    const prisma = prismaOver(tx) as never;
    const service = new AccountService(
      prisma,
      { removeRider: jest.fn().mockResolvedValue(undefined) } as never,
      storage as never,
      new AuditService(prisma),
      { revokeAllSessions: jest.fn().mockResolvedValue(0) } as never,
      { disconnectUser: jest.fn() } as never,
    );
    const user: AuthenticatedUser = {
      userId: me.id,
      collegeId: college.id,
      role: 'STUDENT',
      isVerified: true,
    };
    return { service, storage, college, me, other, user };
  }

  it('removes sessions outright, the free text the person typed, and the photo itself', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx, true);
      await session(tx, w.me.id, 'phone');
      const revoked = await session(tx, w.me.id, 'old');
      await tx.refreshToken.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
      await session(tx, w.other.id, 'phone');

      const taskOf = (requesterId: string, description: string) =>
        tx.task.create({
          data: {
            collegeId: w.college.id,
            type: 'PEER_ERRAND',
            status: 'COMPLETED',
            requesterId,
            pickupLabel: 'Stationery shop',
            pickupLatitude: 17.3,
            pickupLongitude: 78.6,
            dropLabel: 'Hostel B',
            dropLatitude: 17.3,
            dropLongitude: 78.6,
            distanceM: 300,
            baseFeeMinor: 2000,
            feeMinor: 2000,
            description,
            completedAt: new Date(),
          },
        });
      const mine = await taskOf(w.me.id, 'Ask for Asha, room 214, call 98xxxxxx01');
      const theirs = await taskOf(w.other.id, 'Ravi will be at the gate');

      const withdrawal = await tx.withdrawalRequest.create({
        data: {
          userId: w.me.id,
          amountMinor: 10000,
          status: 'PAID',
          bankAccountLast4: '4321',
          bankIfsc: 'HDFC0001234',
          upiId: 'asha@upi',
        },
      });
      const theirWithdrawal = await tx.withdrawalRequest.create({
        data: { userId: w.other.id, amountMinor: 10000, status: 'PAID', upiId: 'ravi@upi' },
      });

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
      const orderOf = (studentId: string, note: string) =>
        tx.order.create({
          data: {
            collegeId: w.college.id,
            reference: `SPEC-${tag()}`,
            studentId,
            shopListingId: listing.id,
            status: 'COMPLETED',
            itemsSubtotalMinor: 10000,
            deliveryFeeMinor: 2000,
            totalMinor: 12000,
            paymentMethod: 'CASH',
            studentNote: note,
          },
        });
      const myOrder = await orderOf(w.me.id, 'I am allergic to peanuts — Asha');
      const theirOrder = await orderOf(w.other.id, 'Extra spicy');

      const result = (await w.service.deleteAccount(w.user, PASSWORD)) as unknown as {
        erased: string[];
        retained: string[];
        caveats: string[];
        storedFiles: { expected: number; removed: number };
      };

      // Sessions: rows gone, revoked or not — they held an IP and a device.
      expect(await tx.refreshToken.count({ where: { userId: w.me.id } })).toBe(0);
      expect(await tx.refreshToken.count({ where: { userId: w.other.id } })).toBe(1);

      // Free text on rows that are otherwise kept.
      expect(
        (await tx.order.findUniqueOrThrow({ where: { id: myOrder.id } })).studentNote,
      ).toBeNull();
      expect((await tx.task.findUniqueOrThrow({ where: { id: mine.id } })).description).toBeNull();
      expect(
        await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawal.id } }),
      ).toMatchObject({
        bankAccountLast4: null,
        bankIfsc: null,
        upiId: null,
        amountMinor: 10000,
        status: 'PAID',
      });
      // The rows themselves, and their money, are still there.
      expect((await tx.order.findUniqueOrThrow({ where: { id: myOrder.id } })).totalMinor).toBe(
        12000,
      );

      // Nobody else's rows are touched.
      expect((await tx.order.findUniqueOrThrow({ where: { id: theirOrder.id } })).studentNote).toBe(
        'Extra spicy',
      );
      expect((await tx.task.findUniqueOrThrow({ where: { id: theirs.id } })).description).toBe(
        'Ravi will be at the gate',
      );
      expect(
        (await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: theirWithdrawal.id } })).upiId,
      ).toBe('ravi@upi');

      // The photo object is deleted, not only the URL nulled.
      expect(w.storage.deletePublicObject).toHaveBeenCalledWith('avatar/me/photo.png');
      expect(result.storedFiles).toEqual({ expected: 2, removed: 2 });

      // Nothing of the person is left anywhere this transaction can see.
      const leftovers = JSON.stringify({
        user: await tx.user.findUniqueOrThrow({ where: { id: w.me.id } }),
        profile: await tx.studentProfile.findUnique({ where: { userId: w.me.id } }),
        orders: await tx.order.findMany({ where: { studentId: w.me.id } }),
        tasks: await tx.task.findMany({ where: { requesterId: w.me.id } }),
        withdrawals: await tx.withdrawalRequest.findMany({ where: { userId: w.me.id } }),
        audit: await tx.auditLog.findMany({ where: { targetId: w.me.id } }),
      });
      for (const personal of [
        'Asha',
        w.me.mobile,
        w.me.email,
        'ROLL-1',
        'asha@upi',
        'HDFC0001234',
        '4321',
        'room 214',
        'peanuts',
        'photo.png',
        '203.0.113.7',
      ]) {
        expect(leftovers).not.toContain(personal);
      }

      // The response says what was done, in the terms it was done.
      expect(result.erased).toEqual(
        expect.arrayContaining([
          'name',
          'notes written on your orders',
          'descriptions written on your tasks',
          'bank and UPI details on your withdrawal requests',
          'sessions, with their IP addresses and device details',
          'profile photo reference',
        ]),
      );
      expect(result.retained).toEqual(
        expect.arrayContaining(['audit log entries', 'ratings you wrote']),
      );
      // It does not claim the audit log was cleaned.
      expect(result.caveats.join(' ')).toMatch(/Audit log entries cannot be altered/);
      expect(result.caveats.join(' ')).not.toMatch(/could not be removed/);
    });
  });

  it('says so when the stored files could not be removed', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx, false);

      const result = (await w.service.deleteAccount(w.user, PASSWORD)) as unknown as {
        erased: string[];
        caveats: string[];
        storedFiles: { expected: number; removed: number };
      };

      expect(result.storedFiles).toEqual({ expected: 2, removed: 0 });
      expect(result.caveats.join(' ')).toMatch(/2 stored file\(s\).*could not be removed/);
      // It claims the reference, which is true, and never the file.
      expect(result.erased).toContain('profile photo reference');
      expect(result.erased).not.toContain('avatar');
      expect(result.erased).not.toContain('identity documents');
      expect((await tx.user.findUniqueOrThrow({ where: { id: w.me.id } })).avatarUrl).toBeNull();
    });
  });

  it.each(['SUPER_ADMIN', 'ADMIN', 'SHOP_OWNER'] as const)(
    'refuses to delete a %s account, whatever the password',
    async (role) => {
      await inRolledBackTransaction(db, async (tx) => {
        const w = await world(tx, true);
        const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
        const staff = await makeUser(tx, role === 'SUPER_ADMIN' ? null : w.college.id, role, {
          passwordHash,
          name: 'Staff Person',
        });
        await session(tx, staff.id, 'console');

        await expect(
          w.service.deleteAccount(
            { userId: staff.id, collegeId: staff.collegeId, role, isVerified: false },
            PASSWORD,
          ),
        ).rejects.toMatchObject({
          status: 403,
          response: { code: 'ACCOUNT_DELETION_NOT_AVAILABLE' },
        });

        const row = await tx.user.findUniqueOrThrow({ where: { id: staff.id } });
        expect(row).toMatchObject({ status: 'ACTIVE', name: 'Staff Person', mobile: staff.mobile });
        expect(await tx.refreshToken.count({ where: { userId: staff.id } })).toBe(1);
      });
    },
  );

  it('goes by the role on the request as well: a non-student token is refused outright', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx, true);

      // The row is a student's; the caller presents as an administrator.
      await expect(
        w.service.deleteAccount({ ...w.user, role: 'ADMIN' }, PASSWORD),
      ).rejects.toMatchObject({ response: { code: 'ACCOUNT_DELETION_NOT_AVAILABLE' } });
      expect((await tx.user.findUniqueOrThrow({ where: { id: w.me.id } })).status).toBe('ACTIVE');
    });
  });

  it('refuses when the token says STUDENT but the account is not one', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx, true);
      const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
      const admin = await makeUser(tx, w.college.id, 'ADMIN', { passwordHash });

      await expect(
        w.service.deleteAccount(
          { userId: admin.id, collegeId: w.college.id, role: 'STUDENT', isVerified: true },
          PASSWORD,
        ),
      ).rejects.toMatchObject({ response: { code: 'ACCOUNT_DELETION_NOT_AVAILABLE' } });
      expect((await tx.user.findUniqueOrThrow({ where: { id: admin.id } })).status).toBe('ACTIVE');
    });
  });
});

describe('/account/* is for students: the guard chain', () => {
  const guard = new RolesGuard(new Reflector());
  const reach = (handler: object, role: AuthenticatedUser['role']) =>
    guard.canActivate({
      switchToHttp: () => ({
        getRequest: () => ({ user: { userId: 'u', collegeId: null, role, isVerified: false } }),
      }),
      getHandler: () => handler,
      getClass: () => AccountController,
    } as unknown as ExecutionContext);

  it.each(['deleteAccount', 'exportData', 'updateProfile'] as const)(
    '%s admits a student and refuses every other role, the super administrator included',
    (name) => {
      const handler = AccountController.prototype[name];
      expect(reach(handler, 'STUDENT')).toBe(true);
      for (const role of ['SUPER_ADMIN', 'ADMIN', 'SHOP_OWNER', 'SHOP_STAFF'] as const) {
        expect(() => reach(handler, role)).toThrow(ForbiddenException);
      }
    },
  );
});

describe('privacy acceptance lives on the account (FR-PRIV-01)', () => {
  jest.setTimeout(30_000);

  function authOver(tx: Tx) {
    const prisma = prismaOver(tx) as never;
    return new AuthService(
      prisma,
      {} as never,
      { get: () => undefined, getOrThrow: () => 'x' } as never,
      {} as never,
      new AuditService(prisma),
    );
  }

  it('accepting in the app writes both columns and the audit row, and /auth/me reads them', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const college = await makeCollege(tx, tag());
      const me = await makeUser(tx, college.id, 'STUDENT');
      expect((await readMe(tx, me.id)).user).toMatchObject({ privacyNotice: null });

      const result = await authOver(tx).acceptPrivacyNotice(
        { userId: me.id, collegeId: college.id },
        PRIVACY_NOTICE_VERSION,
        { ipAddress: '10.0.0.9', userAgent: 'spec' },
      );

      const row = await tx.user.findUniqueOrThrow({ where: { id: me.id } });
      expect(row.privacyNoticeVersion).toBe(PRIVACY_NOTICE_VERSION);
      expect(row.privacyNoticeAcceptedAt).toBeInstanceOf(Date);
      expect(result).toEqual({
        version: PRIVACY_NOTICE_VERSION,
        acceptedAt: row.privacyNoticeAcceptedAt,
      });
      expect(
        await tx.auditLog.count({ where: { action: 'PRIVACY_NOTICE_ACCEPTED', targetId: me.id } }),
      ).toBe(1);

      expect((await readMe(tx, me.id)).user).toMatchObject({
        privacyNotice: { version: PRIVACY_NOTICE_VERSION, acceptedAt: row.privacyNoticeAcceptedAt },
      });

      // Accepting again changes neither the columns nor the log.
      const again = await authOver(tx).acceptPrivacyNotice(
        { userId: me.id, collegeId: college.id },
        PRIVACY_NOTICE_VERSION,
        {},
      );
      expect(again.acceptedAt).toEqual(row.privacyNoticeAcceptedAt);
      expect(
        await tx.auditLog.count({ where: { action: 'PRIVACY_NOTICE_ACCEPTED', targetId: me.id } }),
      ).toBe(1);
    });
  });

  it('/auth/me reads the columns themselves, with the audit log only as a fallback', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const college = await makeCollege(tx, tag());
      const acceptedAt = new Date('2026-06-01T10:00:00Z');

      // Columns set, no audit row at all.
      const byColumns = await makeUser(tx, college.id, 'STUDENT', {
        privacyNoticeVersion: '2026-06-01',
        privacyNoticeAcceptedAt: acceptedAt,
      });
      expect((await readMe(tx, byColumns.id)).user).toMatchObject({
        privacyNotice: { version: '2026-06-01', acceptedAt },
      });

      // An acceptance from before the columns existed: audit row only.
      const byAudit = await makeUser(tx, college.id, 'STUDENT');
      await tx.auditLog.create({
        data: {
          actorId: byAudit.id,
          collegeId: college.id,
          action: 'PRIVACY_NOTICE_ACCEPTED',
          targetType: 'user',
          targetId: byAudit.id,
          detail: { version: '2025-01-01', at: 'REGISTRATION' },
          createdAt: acceptedAt,
        },
      });
      expect((await readMe(tx, byAudit.id)).user).toMatchObject({
        privacyNotice: { version: '2025-01-01', acceptedAt },
      });

      // When both exist, the account's columns win.
      await tx.user.update({
        where: { id: byAudit.id },
        data: { privacyNoticeVersion: '2026-06-01', privacyNoticeAcceptedAt: new Date() },
      });
      expect((await readMe(tx, byAudit.id)).user).toMatchObject({
        privacyNotice: { version: '2026-06-01' },
      });
    });
  });
});
