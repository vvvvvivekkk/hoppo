import { VerificationService } from './verification.service';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * GET /verification/me: `retryAt` tells a student who has used every
 * attempt in the rolling window (FR-SVER-06) when the next one opens.
 */
const DAY = 86_400_000;

const student: AuthenticatedUser = {
  userId: 'student-1',
  collegeId: 'college-a',
  role: 'STUDENT',
  isVerified: false,
};

function build(opts: {
  submittedDaysAgo: number[];
  config?: { maxVerificationSubmissions: number; verificationWindowDays: number } | null;
}) {
  const now = Date.now();
  const submissions = opts.submittedDaysAgo
    .map((d) => ({ submittedAt: new Date(now - d * DAY) }))
    .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());

  type Where = { userId: string; submittedAt?: { gte: Date } };
  const inWindow = (where: Where) =>
    submissions.filter((s) => !where.submittedAt || s.submittedAt >= where.submittedAt.gte);

  const prisma = {
    studentProfile: {
      findUnique: jest.fn().mockResolvedValue({
        verificationStatus: 'REJECTED',
        verifiedAt: null,
        rollNumber: '21CS001',
        department: 'CSE',
        yearOfStudy: 3,
      }),
    },
    collegeConfig: { findUnique: jest.fn().mockResolvedValue(opts.config ?? null) },
    verificationSubmission: {
      count: jest.fn(async (args: { where: Where }) => inWindow(args.where).length),
      findFirst: jest.fn(
        async (args: { where: Where; orderBy: { submittedAt: 'asc' | 'desc' } }) => {
          const rows = inWindow(args.where);
          if (rows.length === 0) return null;
          return args.orderBy.submittedAt === 'asc' ? rows[0] : rows[rows.length - 1];
        },
      ),
    },
  };

  const Ctor = VerificationService as unknown as new (...args: unknown[]) => VerificationService;
  const service = new Ctor(prisma, {}, {}, {}, new TenantService(), {});
  return { service, submissions };
}

/** Read loosely so the spec also compiles where the field did not exist yet. */
async function status(service: VerificationService) {
  return (await service.myStatus(student)) as Record<string, unknown>;
}

describe('VerificationService.myStatus: retryAt', () => {
  it('is null while attempts remain', async () => {
    const { service } = build({ submittedDaysAgo: [1, 2] });

    const result = await status(service);

    expect(result).toMatchObject({ submissionsUsed: 2, submissionsAllowed: 3 });
    expect(result.retryAt).toBeNull();
  });

  it('is null for a student who has never submitted', async () => {
    const { service } = build({ submittedDaysAgo: [] });
    expect((await status(service)).retryAt).toBeNull();
  });

  it('is the oldest submission in the window plus the window, once attempts run out', async () => {
    const { service, submissions } = build({ submittedDaysAgo: [1, 3, 5] });

    const result = await status(service);

    expect(result).toMatchObject({ submissionsUsed: 3, submissionsAllowed: 3 });
    const oldest = submissions[0].submittedAt.getTime();
    expect(result.retryAt).toEqual(new Date(oldest + 7 * DAY));
    // In the future, and it serialises to the ISO string the client reads.
    expect((result.retryAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.parse(JSON.stringify(result)).retryAt).toBe(
      new Date(oldest + 7 * DAY).toISOString(),
    );
  });

  it('ignores submissions that have already left the window', async () => {
    // Four ever, but one is 9 days old: only three count, and the date comes
    // from the oldest of those three (6 days ago), not from the expired one.
    const { service, submissions } = build({ submittedDaysAgo: [9, 6, 2, 1] });

    const result = await status(service);

    expect(result.submissionsUsed).toBe(3);
    expect(result.retryAt).toEqual(new Date(submissions[1].submittedAt.getTime() + 7 * DAY));
  });

  it("uses the college's own limit and window", async () => {
    const { service, submissions } = build({
      submittedDaysAgo: [10, 4],
      config: { maxVerificationSubmissions: 2, verificationWindowDays: 14 },
    });

    const result = await status(service);

    expect(result).toMatchObject({ submissionsUsed: 2, submissionsAllowed: 2 });
    expect(result.retryAt).toEqual(new Date(submissions[0].submittedAt.getTime() + 14 * DAY));
  });
});
