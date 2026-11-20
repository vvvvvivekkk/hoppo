import { PrismaClient } from '@prisma/client';
import { VerificationService } from './verification.service';
import { AdminStudentsController, VerificationController } from './verification.controller';
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

/** A-04 / FR-SVER-08: student directory, detail, suspend, reinstate. Rolled back. */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

async function world(tx: Tx) {
  const tag = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const a = await makeCollege(tx, `${tag}-a`);
  const b = await makeCollege(tx, `${tag}-b`);
  const adminA = await makeUser(tx, a.id, 'ADMIN', { name: 'Admin Of A' });
  const adminB = await makeUser(tx, b.id, 'ADMIN');
  const student = await makeUser(tx, a.id, 'STUDENT', { name: 'Meera Student' });
  const outsider = await makeUser(tx, b.id, 'STUDENT', { name: 'Meera Elsewhere' });
  for (const [u, roll] of [
    [student, 'A-ROLL-17'],
    [outsider, 'B-ROLL-17'],
  ] as const) {
    await tx.studentProfile.create({
      data: {
        userId: u.id,
        rollNumber: roll,
        department: 'CSE',
        yearOfStudy: 2,
        idCardUrl: 'id_card/secret-key.jpg',
        verificationStatus: 'VERIFIED',
      },
    });
  }
  const submission = await tx.verificationSubmission.create({
    data: {
      userId: student.id,
      collegeId: a.id,
      rollNumber: 'A-ROLL-17',
      department: 'CSE',
      yearOfStudy: 2,
      idCardUrl: 'id_card/secret-key.jpg',
      status: 'VERIFIED',
    },
  });

  const prisma = prismaOver(tx) as never;
  const Ctor = VerificationService as unknown as new (...args: unknown[]) => VerificationService;
  const service = new Ctor(
    prisma,
    { removeRider: jest.fn().mockResolvedValue(undefined) },
    new AuditService(prisma),
    { revokeAllSessions: jest.fn().mockResolvedValue(1) },
    new TenantService(),
    { disconnectUser: jest.fn(), notifyTaskStatus: jest.fn() },
  );
  const as = (u: { id: string; collegeId: string | null }): AuthenticatedUser => ({
    userId: u.id,
    collegeId: u.collegeId,
    role: 'ADMIN',
    isVerified: false,
  });
  return { service, student, outsider, submission, adminA: as(adminA), adminB: as(adminB) };
}

describe('admin student directory and detail against PostgreSQL', () => {
  jest.setTimeout(30_000);

  it("finds students of the administrator's own college only", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const byName = await w.service.listStudents(w.adminA, { q: 'meera' });
      expect(byName.items.map((s) => s.id)).toEqual([w.student.id]);
      expect(byName.items[0]).toMatchObject({
        name: 'Meera Student',
        status: 'ACTIVE',
        verificationStatus: 'VERIFIED',
        rollNumber: 'A-ROLL-17',
      });

      // The other college's roll number is simply not there to be found.
      expect((await w.service.listStudents(w.adminA, { q: 'B-ROLL' })).items).toEqual([]);
      expect(
        (await w.service.listStudents(w.adminB, { q: 'meera' })).items.map((s) => s.id),
      ).toEqual([w.outsider.id]);
      expect((await w.service.listStudents(w.adminA, { status: 'SUSPENDED' })).items).toEqual([]);
      await expect(w.service.listStudents(w.adminA, { status: 'BANNED' })).rejects.toMatchObject({
        response: { code: 'BAD_REQUEST' },
      });
    });
  });

  it('shows one student, with submission ids but no document keys', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const detail = await w.service.studentDetail(w.adminA, w.student.id);

      expect(detail.student).toMatchObject({ id: w.student.id, name: 'Meera Student' });
      expect(detail.suspension).toBeNull();
      expect(detail.profile).toMatchObject({
        rollNumber: 'A-ROLL-17',
        verificationStatus: 'VERIFIED',
      });
      expect(detail.submissions.map((s) => s.id)).toEqual([w.submission.id]);
      expect(detail.counts).toEqual({ orders: 0, tasksRequested: 0, tasksDelivered: 0 });
      expect(JSON.stringify(detail)).not.toContain('secret-key');
    });
  });

  it('suspend and reinstate say what, why, who and when; detail shows the suspension', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const suspended = await w.service.suspend(w.adminA, w.student.id, { reason: 'Forged ID' });
      expect(suspended).toMatchObject({
        status: 'SUSPENDED',
        reason: 'Forged ID',
        suspendedBy: { id: w.adminA.userId, name: 'Admin Of A' },
      });
      expect(suspended.suspendedAt).toBeInstanceOf(Date);

      const detail = await w.service.studentDetail(w.adminA, w.student.id);
      expect(detail.student.status).toBe('SUSPENDED');
      expect(detail.suspension).toMatchObject({
        reason: 'Forged ID',
        suspendedBy: { id: w.adminA.userId, name: 'Admin Of A' },
      });
      expect(detail.suspension!.suspendedAt).toEqual(suspended.suspendedAt);

      const reinstated = await w.service.reinstate(w.adminA, w.student.id);
      expect(reinstated).toMatchObject({
        status: 'ACTIVE',
        reinstatedBy: { id: w.adminA.userId, name: 'Admin Of A' },
      });
      expect(reinstated.reinstatedAt).toBeInstanceOf(Date);
      expect((await w.service.studentDetail(w.adminA, w.student.id)).suspension).toBeNull();
    });
  });

  it("refuses another college's administrator, and a non-student id (FR-TEN-03)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      await expect(w.service.studentDetail(w.adminB, w.student.id)).rejects.toMatchObject({
        response: { code: 'CROSS_TENANT_ACCESS' },
      });
      await expect(w.service.studentDetail(w.adminA, w.adminA.userId)).rejects.toMatchObject({
        response: { code: 'NOT_A_STUDENT' },
      });
    });
  });
});

describe('verification routes', () => {
  it('the student directory is for administrators', () => {
    expect(Reflect.getMetadata('roles', AdminStudentsController)).toEqual(['ADMIN']);
  });

  it('accepting the rider terms answers 200, like the other action POSTs', () => {
    expect(
      Reflect.getMetadata('__httpCode__', VerificationController.prototype.acceptRiderTerms),
    ).toBe(200);
  });
});
