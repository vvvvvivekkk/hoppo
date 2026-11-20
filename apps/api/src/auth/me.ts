import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

type Reader = Pick<PrismaService, 'user' | 'auditLog'> | Prisma.TransactionClient;

/** FR-PRIV-01: which privacy notice this person last accepted, and when. */
export async function readPrivacyAcceptance(
  prisma: Reader,
  userId: string,
): Promise<{ version: string; acceptedAt: Date } | null> {
  const acceptance = await prisma.auditLog.findFirst({
    where: { action: 'PRIVACY_NOTICE_ACCEPTED', targetType: 'user', targetId: userId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, detail: true },
  });
  const version = (acceptance?.detail as { version?: unknown } | null)?.version;
  return acceptance && typeof version === 'string'
    ? { version, acceptedAt: acceptance.createdAt }
    : null;
}

/**
 * The body of GET /auth/me: the caller's own record.
 *
 * Shared so that a route which changes the profile can answer with exactly
 * what /auth/me would now say, rather than a second, slightly different shape.
 */
export async function readMe(prisma: Reader, userId: string) {
  const record = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      mobile: true,
      email: true,
      role: true,
      status: true,
      avatarUrl: true,
      createdAt: true,
      college: { select: { id: true, name: true, shortName: true } },
      studentProfile: {
        select: {
          rollNumber: true,
          department: true,
          yearOfStudy: true,
          verificationStatus: true,
          verifiedAt: true,
          riderTermsAcceptedAt: true,
          // Deliberately absent: idCardUrl, govtIdLast4. C-3 and NFR-S-03
          // keep identity documents off every student-facing response.
        },
      },
      riderState: {
        select: { workModeOn: true, activeTaskId: true, barredUntil: true },
      },
    },
  });

  if (!record) return { user: record };

  return { user: { ...record, privacyNotice: await readPrivacyAcceptance(prisma, userId) } };
}
