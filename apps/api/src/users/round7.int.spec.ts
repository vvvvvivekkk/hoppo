import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { AccountService } from './account.service';
import { PlatformService } from './platform.service';
import { AuthService } from '../auth/auth.service';
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
 * Audit round 6 findings: the deletion response's "erased" list has to be
 * true of every table, the re-activation audit entry keeps its reason, and a
 * refresh cannot rotate across a college's deactivation. PostgreSQL, rolled back.
 */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

const tag = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
const PASSWORD = 'correct horse battery';

async function deletionWorld(tx: Tx) {
  const college = await makeCollege(tx, tag());
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const me = await makeUser(tx, college.id, 'STUDENT', { passwordHash, name: 'Asha Mine' });
  const other = await makeUser(tx, college.id, 'STUDENT');
  await tx.studentProfile.create({
    data: {
      userId: me.id,
      rollNumber: 'ROLL-1',
      department: 'CSE',
      yearOfStudy: 3,
      verificationStatus: 'REJECTED',
    },
  });
  const prisma = prismaOver(tx) as never;
  const service = new AccountService(
    prisma,
    { removeRider: jest.fn().mockResolvedValue(undefined) } as never,
    {
      deletePrivateObject: jest.fn().mockResolvedValue(true),
      deletePublicObject: jest.fn().mockResolvedValue(true),
      publicKeyFromUrl: () => null,
    } as never,
    new AuditService(prisma),
    { revokeAllSessions: jest.fn().mockResolvedValue(0) } as never,
    { disconnectUser: jest.fn() } as never,
  );
  const user: AuthenticatedUser = {
    userId: me.id,
    collegeId: college.id,
    role: 'STUDENT',
    isVerified: false,
  };
  return { service, college, me, other, user };
}

type DeletionResult = { erased: string[]; retained: string[]; caveats: string[] };

describe('account deletion: the erased list is true of every table', () => {
  jest.setTimeout(30_000);

  it('removes the OTP challenges that hold the real mobile number and email address', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await deletionWorld(tx);
      const challenge = (recipient: string, purpose: 'PHONE_VERIFY' | 'PASSWORD_RESET', used: boolean) =>
        tx.otpChallenge.create({
          data: {
            purpose,
            recipient,
            codeHash: 'not-a-real-hash',
            expiresAt: new Date(Date.now() + 600_000),
            consumedAt: used ? new Date() : null,
          },
        });
      await challenge(w.me.mobile, 'PHONE_VERIFY', true); // from registration
      await challenge(w.me.mobile, 'PASSWORD_RESET', false);
      await challenge(w.me.email, 'PASSWORD_RESET', true);
      const theirs = await challenge(w.other.mobile, 'PHONE_VERIFY', true);
      const { mobile, email } = w.me;

      const result = (await w.service.deleteAccount(w.user, PASSWORD)) as unknown as DeletionResult;

      // The table itself, by the real values — not the (already scrubbed) user row.
      expect(await tx.otpChallenge.count({ where: { recipient: mobile } })).toBe(0);
      expect(await tx.otpChallenge.count({ where: { recipient: email } })).toBe(0);
      const everywhere = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM otp_challenge WHERE recipient IN (${mobile}, ${email})
      `;
      expect(Number(everywhere[0].n)).toBe(0);

      // Somebody else's challenge is not this deletion's business.
      expect(await tx.otpChallenge.count({ where: { id: theirs.id } })).toBe(1);

      expect(result.erased).toContain('mobile number');
      expect(result.erased).toContain('email address');
      expect(result.erased).toContain(
        'verification codes sent to your mobile number or email address',
      );
    });
  });

  it('blanks the government ID type and the rejection note on decided submissions', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await deletionWorld(tx);
      const decided = await tx.verificationSubmission.create({
        data: {
          userId: w.me.id,
          collegeId: w.college.id,
          rollNumber: 'ROLL-1',
          department: 'CSE',
          yearOfStudy: 3,
          idCardUrl: `id_card/${w.me.id}/card.jpg`,
          govtIdType: 'PASSPORT',
          govtIdLast4: '9876',
          status: 'REJECTED',
          rejectionReason: 'NAME_MISMATCH',
          rejectionNote: 'Card says Asha K. Mine, account says Asha Mine',
          decidedAt: new Date(),
        },
      });

      const result = (await w.service.deleteAccount(w.user, PASSWORD)) as unknown as DeletionResult;

      const row = await tx.verificationSubmission.findUniqueOrThrow({ where: { id: decided.id } });
      expect(row.govtIdType).toBeNull();
      expect(row.govtIdLast4).toBeNull();
      expect(row.rejectionNote).toBeNull();
      // The decision itself (FR-SVER-09) is kept.
      expect(row).toMatchObject({ status: 'REJECTED', rejectionReason: 'NAME_MISMATCH' });
      expect(row.decidedAt).toBeInstanceOf(Date);
      expect(JSON.stringify(row)).not.toContain('Asha');

      expect(result.erased).toContain('government ID type and last four characters');
      expect(result.erased).toContain(
        'notes an administrator wrote when rejecting a verification submission',
      );
    });
  });

  it('says that community posts, comments and reports are kept, and does not claim them erased', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await deletionWorld(tx);

      const result = (await w.service.deleteAccount(w.user, PASSWORD)) as unknown as DeletionResult;

      expect(result.retained).toContain('community posts, comments and reports you wrote');
      expect(result.caveats.join(' ')).toMatch(/community posts, comments and reports you wrote are kept/);
      expect(result.erased.join(' ')).not.toMatch(/post|comment|report/i);
    });
  });
});

describe('college re-activation keeps its reason in the audit log', () => {
  jest.setTimeout(30_000);

  it('records { reason } for both directions when one is given', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const root = await makeUser(tx, null, 'SUPER_ADMIN');
      const college = await makeCollege(tx, tag());
      const prisma = prismaOver(tx) as never;
      const service = new PlatformService(
        prisma,
        new AuditService(prisma),
        { revokeAllSessions: jest.fn() } as never,
        { disconnectUser: jest.fn() } as never,
      );
      const superAdmin: AuthenticatedUser = {
        userId: root.id,
        collegeId: null,
        role: 'SUPER_ADMIN',
        isVerified: false,
      };

      await service.setCollegeStatus(superAdmin, college.id, 'INACTIVE', 'Contract lapsed');
      await service.setCollegeStatus(superAdmin, college.id, 'ACTIVE', 'Contract renewed');

      const detailOf = async (action: string) =>
        (await tx.auditLog.findFirstOrThrow({ where: { action, targetId: college.id } })).detail;
      expect(await detailOf('COLLEGE_DEACTIVATED')).toMatchObject({ reason: 'Contract lapsed' });
      expect(await detailOf('COLLEGE_ACTIVATED')).toEqual({ reason: 'Contract renewed' });

      // With no reason there is nothing to record, and nothing is invented.
      await service.setCollegeStatus(superAdmin, college.id, 'INACTIVE', 'Again');
      await service.setCollegeStatus(superAdmin, college.id, 'ACTIVE');
      const all = await tx.auditLog.findMany({
        where: { action: 'COLLEGE_ACTIVATED', targetId: college.id },
        select: { detail: true },
      });
      expect(all.map((a) => a.detail).filter((d) => d === null)).toHaveLength(1);
    });
  });
});

describe('refresh cannot rotate across a deactivation (the write is conditional)', () => {
  jest.setTimeout(30_000);

  const TOKEN = 'header.payload.signature.random-part';
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');

  /**
   * The losing side of the race: this request read the user (college ACTIVE)
   * before the deactivation committed. Reproduced by giving the service a
   * database whose user read reports the college as still ACTIVE.
   */
  async function world(tx: Tx, opts: { staleCollegeRead: boolean }) {
    const college = await makeCollege(tx, tag());
    const user = await makeUser(tx, college.id, 'STUDENT');
    const stored = await tx.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hash(TOKEN),
        familyId: `family-${user.id}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const base = prismaOver(tx) as Record<string, unknown>;
    const realUser = base.user as { findUnique(a: unknown): Promise<Record<string, unknown> | null> };
    const staleUser = new Proxy(realUser as object, {
      get(target, prop, receiver) {
        if (prop === 'findUnique' && opts.staleCollegeRead) {
          return async (args: unknown) => {
            const row = await realUser.findUnique(args);
            return row && 'college' in row ? { ...row, college: { status: 'ACTIVE' } } : row;
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const prisma = new Proxy(base, {
      get: (target, prop) => (prop === 'user' ? staleUser : target[prop as string]),
    });

    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: user.id, fam: stored.familyId }),
      signAsync: jest.fn().mockResolvedValue('new.access.token'),
    };
    const config = {
      get: (_k: string, fallback?: unknown) => fallback,
      getOrThrow: () => 'a-secret-that-is-long-enough-for-tests',
    };
    const service = new AuthService(
      prisma as never,
      jwt as never,
      config as never,
      {} as never,
      new AuditService(prismaOver(tx) as never),
    );
    const liveTokens = () => tx.refreshToken.count({ where: { userId: user.id, revokedAt: null } });
    return { service, college, user, stored, jwt, liveTokens };
  }

  it('a college deactivated after the read: no new pair, the old token is not rotated', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx, { staleCollegeRead: true });
      // The deactivation commits between this request's read and its write.
      await tx.college.update({ where: { id: w.college.id }, data: { status: 'INACTIVE' } });

      await expect(w.service.refresh(TOKEN, {})).rejects.toMatchObject({
        status: 401,
        response: { code: 'REFRESH_INVALID' },
      });

      expect(w.jwt.signAsync).not.toHaveBeenCalled();
      // Exactly the one row there was; nothing new was minted.
      expect(await tx.refreshToken.count({ where: { userId: w.user.id } })).toBe(1);
      // And that row was not consumed: the conditional UPDATE matched nothing,
      // so the refusal did not rotate the token on its way out.
      const old = await tx.refreshToken.findUniqueOrThrow({ where: { id: w.stored.id } });
      expect(old.revokedAt).toBeNull();
    });
  });

  it('the same token presented twice at once: only one of them rotates', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx, { staleCollegeRead: false });
      // The other request has already used the token; this one read it earlier.
      await w.service.refresh(TOKEN, {});
      expect(await w.liveTokens()).toBe(1);

      // A second service whose read of the token row is stale (still unused).
      const staleToken = { ...w.stored, revokedAt: null };
      const realRt = (prismaOver(tx) as Record<string, unknown>).refreshToken as object;
      const prisma = new Proxy(prismaOver(tx) as Record<string, unknown>, {
        get: (target, prop) =>
          prop === 'refreshToken'
            ? new Proxy(realRt, {
                get: (t, p, r) =>
                  p === 'findUnique' ? async () => staleToken : (Reflect.get(t, p, r) as unknown),
              })
            : target[prop as string],
      });
      const second = new AuthService(
        prisma as never,
        {
          verifyAsync: jest.fn().mockResolvedValue({ sub: w.user.id, fam: w.stored.familyId }),
          signAsync: jest.fn().mockResolvedValue('second.access.token'),
        } as never,
        { get: (_k: string, f?: unknown) => f, getOrThrow: () => 'x'.repeat(40) } as never,
        {} as never,
        new AuditService(prismaOver(tx) as never),
      );

      await expect(second.refresh(TOKEN, {})).rejects.toMatchObject({ status: 401 });
      // Still one live token: the loser minted nothing.
      expect(await w.liveTokens()).toBe(1);
    });
  });

  it('an ordinary refresh still rotates: old token used, one new one live', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx, { staleCollegeRead: false });

      await expect(w.service.refresh(TOKEN, {})).resolves.toMatchObject({
        accessToken: 'new.access.token',
      });

      const old = await tx.refreshToken.findUniqueOrThrow({ where: { id: w.stored.id } });
      expect(old.revokedAt).toBeInstanceOf(Date);
      expect(await w.liveTokens()).toBe(1);
    });
  });

  it('a super administrator, who has no college, still rotates', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const root = await makeUser(tx, null, 'SUPER_ADMIN');
      const stored = await tx.refreshToken.create({
        data: {
          userId: root.id,
          tokenHash: hash(TOKEN),
          familyId: `family-${root.id}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const service = new AuthService(
        prismaOver(tx) as never,
        {
          verifyAsync: jest.fn().mockResolvedValue({ sub: root.id, fam: stored.familyId }),
          signAsync: jest.fn().mockResolvedValue('root.access.token'),
        } as never,
        { get: (_k: string, f?: unknown) => f, getOrThrow: () => 'x'.repeat(40) } as never,
        {} as never,
        new AuditService(prismaOver(tx) as never),
      );

      await expect(service.refresh(TOKEN, {})).resolves.toMatchObject({
        accessToken: 'root.access.token',
      });
    });
  });
});
