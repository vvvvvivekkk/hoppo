import { BadRequestException } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * FR-SVER-08: suspension "immediately terminat[es] active sessions". A
 * session is two things — refresh tokens, and any socket already open, which
 * was authenticated once at connect and would otherwise go on receiving
 * offers and chat. Both have to go.
 */
const admin: AuthenticatedUser = {
  userId: 'admin-a',
  collegeId: 'college-a',
  role: 'ADMIN',
  isVerified: false,
};

function build(target: Record<string, unknown> | null) {
  const tx = {
    user: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    riderState: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    chatRoom: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    chatMember: { updateMany: jest.fn() },
    task: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(target) },
    task: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const redis = { removeRider: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn(), recordInTransaction: jest.fn() };
  const auth = { revokeAllSessions: jest.fn().mockResolvedValue(3) };
  const gateway = { disconnectUser: jest.fn(), notifyTaskStatus: jest.fn() };

  const Ctor = VerificationService as unknown as new (...args: unknown[]) => VerificationService;
  const service = new Ctor(prisma, redis, audit, auth, new TenantService(), gateway);
  return { service, prisma, tx, redis, auth, gateway };
}

const activeStudent = {
  id: 'student-1',
  collegeId: 'college-a',
  role: 'STUDENT',
  status: 'ACTIVE',
  name: 'A Student',
  riderState: { activeTaskId: null, workModeOn: true },
};

describe('VerificationService.suspend', () => {
  it('revokes refresh tokens AND closes open sockets for the suspended student', async () => {
    const { service, tx, auth, gateway, redis } = build(activeStudent);

    const result = await service.suspend(admin, 'student-1', { reason: 'Fraudulent ID card' });

    // Conditional on the account still being an ACTIVE student.
    expect(tx.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'student-1', role: 'STUDENT', status: 'ACTIVE' },
        data: expect.objectContaining({ status: 'SUSPENDED' }),
      }),
    );
    expect(auth.revokeAllSessions).toHaveBeenCalledWith('student-1');
    expect(gateway.disconnectUser).toHaveBeenCalledTimes(1);
    expect(gateway.disconnectUser).toHaveBeenCalledWith('student-1');
    expect(redis.removeRider).toHaveBeenCalledWith('college-a', 'student-1');
    expect(result).toMatchObject({ status: 'SUSPENDED', sessionsRevoked: 3 });
  });

  it('closes sockets only after the suspension has been committed', async () => {
    const { service, prisma, gateway } = build(activeStudent);

    await service.suspend(admin, 'student-1', { reason: 'Fraudulent ID card' });

    const committed = prisma.$transaction.mock.invocationCallOrder[0];
    const dropped = gateway.disconnectUser.mock.invocationCallOrder[0];
    expect(dropped).toBeGreaterThan(committed);
  });

  it("does not touch sessions or sockets for another college's student (C-1)", async () => {
    const { service, auth, gateway, prisma } = build({ ...activeStudent, collegeId: 'college-b' });

    await expect(
      service.suspend(admin, 'student-1', { reason: 'Fraudulent ID card' }),
    ).rejects.toMatchObject({ response: { code: 'CROSS_TENANT_ACCESS' } });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auth.revokeAllSessions).not.toHaveBeenCalled();
    expect(gateway.disconnectUser).not.toHaveBeenCalled();
  });

  it('refuses to suspend a non-student account through this route', async () => {
    const { service, gateway } = build({ ...activeStudent, role: 'SHOP_OWNER' });

    await expect(
      service.suspend(admin, 'student-1', { reason: 'Fraudulent ID card' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.disconnectUser).not.toHaveBeenCalled();
  });
});

describe('VerificationService.reinstate', () => {
  it('reinstates a suspended student', async () => {
    const { service, tx } = build({ ...activeStudent, status: 'SUSPENDED' });

    await expect(service.reinstate(admin, 'student-1')).resolves.toMatchObject({
      status: 'ACTIVE',
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'student-1', role: 'STUDENT', status: 'SUSPENDED' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
  });

  it('refuses a non-student account, as suspend does', async () => {
    const { service, prisma } = build({ ...activeStudent, role: 'ADMIN', status: 'SUSPENDED' });

    await expect(service.reinstate(admin, 'student-1')).rejects.toMatchObject({
      response: { code: 'NOT_A_STUDENT' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
