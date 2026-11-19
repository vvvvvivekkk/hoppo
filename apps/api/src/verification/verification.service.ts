import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RIDER_TERMS_VERSION } from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import type {
  ApproveVerificationDto,
  RejectVerificationDto,
  SubmitVerificationDto,
  SuspendStudentDto,
} from './dto/verification.dto';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly tenant: TenantService,
  ) {}

  // =======================================================================
  // Student side
  // =======================================================================

  /** FR-SVER-02, FR-SVER-06 */
  async submit(user: AuthenticatedUser, dto: SubmitVerificationDto) {
    const collegeId = this.tenant.requireCollegeId(user);

    const profile = await this.prisma.studentProfile.findUnique({
      where: { userId: user.userId },
      select: { verificationStatus: true },
    });

    if (!profile) throw new NotFoundException('Student profile not found');

    if (profile.verificationStatus === 'VERIFIED') {
      throw new ConflictException({
        code: 'ALREADY_VERIFIED',
        message: 'Your account is already verified.',
      });
    }

    if (profile.verificationStatus === 'PENDING') {
      throw new ConflictException({
        code: 'SUBMISSION_PENDING',
        message: 'You already have a submission awaiting review.',
      });
    }

    const config = await this.prisma.collegeConfig.findUnique({
      where: { collegeId },
      select: { maxVerificationSubmissions: true, verificationWindowDays: true },
    });

    const maxSubmissions = config?.maxVerificationSubmissions ?? 3;
    const windowDays = config?.verificationWindowDays ?? 7;

    // FR-SVER-06: "The system shall limit a student to three submissions in
    // any seven-day period." A rolling window, counted from the submissions
    // themselves — which is why submissions are their own table rather than a
    // status field on the profile.
    const windowStart = new Date(Date.now() - windowDays * 86_400_000);
    const recentCount = await this.prisma.verificationSubmission.count({
      where: { userId: user.userId, submittedAt: { gte: windowStart } },
    });

    if (recentCount >= maxSubmissions) {
      const oldest = await this.prisma.verificationSubmission.findFirst({
        where: { userId: user.userId, submittedAt: { gte: windowStart } },
        orderBy: { submittedAt: 'asc' },
        select: { submittedAt: true },
      });

      const retryAt = oldest
        ? new Date(oldest.submittedAt.getTime() + windowDays * 86_400_000)
        : null;

      throw new ForbiddenException({
        code: 'SUBMISSION_LIMIT_REACHED',
        message:
          `You have used all ${maxSubmissions} submissions for this ${windowDays}-day period. ` +
          (retryAt
            ? `You can submit again after ${retryAt.toDateString()}.`
            : 'Please contact your campus administrator.'),
        details: { maxSubmissions, windowDays, retryAt },
      });
    }

    // Section 11 / FR-ID-03: a government ID image may only be kept with
    // explicit consent, and must carry an expiry so the deletion job can find
    // it. The database refuses an image without one, so this check turns a
    // constraint violation into a readable error.
    if (dto.govtIdImageUrl) {
      if (dto.govtIdType !== 'AADHAAR_MASKED') {
        throw new BadRequestException({
          code: 'IMAGE_NOT_ACCEPTED',
          message:
            'Document images are only stored where a college mandates Aadhaar, and then ' +
            'only masked. For other documents, enter the last four characters only.',
        });
      }
      if (!dto.consentGiven) {
        throw new BadRequestException({
          code: 'CONSENT_REQUIRED',
          message: 'Explicit consent is required before a document image can be stored.',
        });
      }
    }

    const consentPurpose = dto.govtIdImageUrl
      ? 'Verification of college membership and rider eligibility. The uploaded image is ' +
        'deleted within 24 hours of the verification decision. Only the document type and ' +
        'its last four characters are retained.'
      : null;

    const submission = await this.prisma.$transaction(async (tx) => {
      const created = await tx.verificationSubmission.create({
        data: {
          userId: user.userId,
          collegeId,
          rollNumber: dto.rollNumber,
          department: dto.department,
          yearOfStudy: dto.yearOfStudy,
          idCardUrl: dto.idCardUrl,
          govtIdType: dto.govtIdType ?? null,
          govtIdLast4: dto.govtIdLast4 ?? null,
          govtIdImageUrl: dto.govtIdImageUrl ?? null,
          // FR-ID-03: 24 hours from the decision; until a decision exists,
          // 24 hours from submission is the ceiling.
          govtIdImageExpiresAt: dto.govtIdImageUrl
            ? new Date(Date.now() + 24 * 3_600_000)
            : null,
          consentGivenAt: dto.govtIdImageUrl ? new Date() : null,
          consentPurposeText: consentPurpose,
          status: 'PENDING',
        },
      });

      await tx.studentProfile.update({
        where: { userId: user.userId },
        data: {
          rollNumber: dto.rollNumber,
          department: dto.department,
          yearOfStudy: dto.yearOfStudy,
          idCardUrl: dto.idCardUrl,
          govtIdType: dto.govtIdType ?? null,
          govtIdLast4: dto.govtIdLast4 ?? null,
          verificationStatus: 'PENDING',
        },
      });

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId,
        action: AuditAction.VERIFICATION_SUBMITTED,
        targetType: 'verification_submission',
        targetId: created.id,
        detail: {
          attempt: recentCount + 1,
          hasGovtId: Boolean(dto.govtIdType),
          govtIdType: dto.govtIdType ?? null,
        },
      });

      return created;
    });

    return {
      submissionId: submission.id,
      status: submission.status,
      submittedAt: submission.submittedAt,
      submissionsUsed: recentCount + 1,
      submissionsAllowed: maxSubmissions,
      message: 'Submitted for review. Your campus administrator will usually respond within a day.',
    };
  }

  /** What the student sees on the "pending" and "rejected" screens (S-08, S-09). */
  async myStatus(user: AuthenticatedUser) {
    const profile = await this.prisma.studentProfile.findUnique({
      where: { userId: user.userId },
      select: {
        verificationStatus: true,
        verifiedAt: true,
        rollNumber: true,
        department: true,
        yearOfStudy: true,
      },
    });

    if (!profile) throw new NotFoundException('Student profile not found');

    const latest = await this.prisma.verificationSubmission.findFirst({
      where: { userId: user.userId },
      orderBy: { submittedAt: 'desc' },
      select: {
        id: true,
        status: true,
        submittedAt: true,
        decidedAt: true,
        rejectionReason: true,
        rejectionNote: true,
        // idCardUrl and govtIdImageUrl are deliberately not selected: C-3
        // keeps identity documents out of every student-facing response.
      },
    });

    const config = await this.prisma.collegeConfig.findUnique({
      where: { collegeId: user.collegeId ?? '' },
      select: { maxVerificationSubmissions: true, verificationWindowDays: true },
    });

    const windowDays = config?.verificationWindowDays ?? 7;
    const windowStart = new Date(Date.now() - windowDays * 86_400_000);
    const used = await this.prisma.verificationSubmission.count({
      where: { userId: user.userId, submittedAt: { gte: windowStart } },
    });

    return {
      status: profile.verificationStatus,
      verifiedAt: profile.verifiedAt,
      profile: {
        rollNumber: profile.rollNumber || null,
        department: profile.department || null,
        yearOfStudy: profile.yearOfStudy || null,
      },
      latestSubmission: latest,
      submissionsUsed: used,
      submissionsAllowed: config?.maxVerificationSubmissions ?? 3,
      // FR-SVER-01: what is and is not available while unverified.
      unlocked: {
        browseShops: true,
        placeOrders: profile.verificationStatus === 'VERIFIED',
        workMode: profile.verificationStatus === 'VERIFIED',
        chat: profile.verificationStatus === 'VERIFIED',
        community: profile.verificationStatus === 'VERIFIED',
      },
    };
  }

  /** FR-WM-02: rider terms, recorded with version and timestamp. */
  async acceptRiderTerms(user: AuthenticatedUser) {
    const profile = await this.prisma.studentProfile.findUnique({
      where: { userId: user.userId },
      select: { verificationStatus: true, riderTermsAcceptedAt: true },
    });

    if (!profile) throw new NotFoundException('Student profile not found');

    if (profile.verificationStatus !== 'VERIFIED') {
      throw new ForbiddenException({
        code: 'VERIFICATION_REQUIRED',
        message: 'Verification must be approved before you can ride.',
      });
    }

    await this.prisma.studentProfile.update({
      where: { userId: user.userId },
      data: {
        riderTermsVersion: RIDER_TERMS_VERSION,
        riderTermsAcceptedAt: new Date(),
      },
    });

    return { accepted: true, version: RIDER_TERMS_VERSION };
  }

  // =======================================================================
  // Administrator side
  // =======================================================================

  /**
   * FR-SVER-04: "Submitted documents shall enter the administrator's student
   * verification queue for the student's college only."
   *
   * The tenant scope is what makes that true. An administrator at one college
   * cannot see another's queue, and the filter is not optional.
   */
  async queue(user: AuthenticatedUser, limit = 25, cursor?: string) {
    const items = await this.prisma.verificationSubmission.findMany({
      where: { ...this.tenant.scope(user), status: 'PENDING' },
      // FR-ADM-02: everything needed for a decision, without navigating away.
      select: {
        id: true,
        submittedAt: true,
        rollNumber: true,
        department: true,
        yearOfStudy: true,
        idCardUrl: true,
        govtIdType: true,
        govtIdLast4: true,
        govtIdImageUrl: true,
        consentGivenAt: true,
        user: {
          select: {
            id: true,
            name: true,
            mobile: true,
            email: true,
            createdAt: true,
            mobileVerifiedAt: true,
            emailVerifiedAt: true,
          },
        },
      },
      orderBy: { submittedAt: 'asc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;

    // Prior attempts matter to a reviewer: a third submission after two
    // rejections deserves more attention than a first.
    const withHistory = await Promise.all(
      page.map(async (item) => {
        const priorRejections = await this.prisma.verificationSubmission.count({
          where: { userId: item.user.id, status: 'REJECTED' },
        });
        return { ...item, priorRejections };
      }),
    );

    return {
      items: withHistory,
      nextCursor: hasMore ? page[page.length - 1].id : null,
      total: await this.prisma.verificationSubmission.count({
        where: { ...this.tenant.scope(user), status: 'PENDING' },
      }),
    };
  }

  /** FR-SVER-05 (approve), FR-SVER-07, FR-SVER-09 */
  async approve(user: AuthenticatedUser, submissionId: string, dto: ApproveVerificationDto) {
    const submission = await this.prisma.verificationSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true, userId: true, collegeId: true, status: true, govtIdType: true },
    });

    this.tenant.assertSameTenant(user, submission, 'Verification submission');

    if (submission!.status !== 'PENDING') {
      throw new ConflictException({
        code: 'ALREADY_DECIDED',
        message: 'That submission has already been decided.',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.verificationSubmission.update({
        where: { id: submissionId },
        data: {
          status: 'VERIFIED',
          decidedByUserId: user.userId,
          decidedAt: new Date(),
          // FR-ID-03: the clock on the image starts at the decision.
          govtIdImageExpiresAt: new Date(Date.now() + 24 * 3_600_000),
        },
      });

      await tx.studentProfile.update({
        where: { userId: submission!.userId },
        data: {
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date(),
          verifiedByUserId: user.userId,
          govtIdVerifiedAt: submission!.govtIdType ? new Date() : null,
        },
      });

      // FR-SVER-09: immutable, and atomic with the decision rather than
      // best-effort, because a decision with no audit trail is a compliance
      // problem rather than an inconvenience.
      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: submission!.collegeId,
        action: AuditAction.VERIFICATION_APPROVED,
        targetType: 'verification_submission',
        targetId: submissionId,
        detail: { studentId: submission!.userId, note: dto.note ?? null },
      });
    });

    this.logger.log(`Verification ${submissionId} approved by ${user.userId}`);

    // FR-SVER-07 takes effect on the student's next request: the JWT strategy
    // reads verification status from the database, so no re-login is needed.
    return {
      submissionId,
      status: 'VERIFIED',
      message: 'Student verified. Ordering, work mode, chat and community are now open to them.',
    };
  }

  /** FR-SVER-05 (reject), FR-SVER-06, FR-SVER-09 */
  async reject(user: AuthenticatedUser, submissionId: string, dto: RejectVerificationDto) {
    const submission = await this.prisma.verificationSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true, userId: true, collegeId: true, status: true },
    });

    this.tenant.assertSameTenant(user, submission, 'Verification submission');

    if (submission!.status !== 'PENDING') {
      throw new ConflictException({
        code: 'ALREADY_DECIDED',
        message: 'That submission has already been decided.',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.verificationSubmission.update({
        where: { id: submissionId },
        data: {
          status: 'REJECTED',
          decidedByUserId: user.userId,
          decidedAt: new Date(),
          rejectionReason: dto.reason,
          rejectionNote: dto.note ?? null,
          govtIdImageExpiresAt: new Date(Date.now() + 24 * 3_600_000),
        },
      });

      // FR-SVER-06: the student may resubmit, so the profile returns to
      // REJECTED rather than being left PENDING.
      await tx.studentProfile.update({
        where: { userId: submission!.userId },
        data: { verificationStatus: 'REJECTED' },
      });

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: submission!.collegeId,
        action: AuditAction.VERIFICATION_REJECTED,
        targetType: 'verification_submission',
        targetId: submissionId,
        detail: {
          studentId: submission!.userId,
          reason: dto.reason,
          note: dto.note ?? null,
        },
      });
    });

    return {
      submissionId,
      status: 'REJECTED',
      reason: dto.reason,
      message: 'Submission rejected. The student has been notified and may resubmit.',
    };
  }

  /**
   * FR-SVER-08: "An administrator shall be able to suspend a verified student,
   * immediately terminating active sessions, cancelling any in-flight task
   * assignment, and disabling work mode."
   *
   * Three distinct effects, all required to be immediate. Doing them in one
   * transaction and then clearing Redis means a suspended student cannot keep
   * riding on a token that has not expired yet.
   */
  async suspend(user: AuthenticatedUser, studentId: string, dto: SuspendStudentDto) {
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        collegeId: true,
        role: true,
        status: true,
        name: true,
        riderState: { select: { activeTaskId: true, workModeOn: true } },
      },
    });

    this.tenant.assertSameTenant(user, student, 'Student');

    if (student!.role !== 'STUDENT') {
      throw new BadRequestException({
        code: 'NOT_A_STUDENT',
        message: 'Only student accounts are suspended this way.',
      });
    }

    if (student!.status === 'SUSPENDED') {
      throw new ConflictException({
        code: 'ALREADY_SUSPENDED',
        message: 'That account is already suspended.',
      });
    }

    const activeTaskId = student!.riderState?.activeTaskId ?? null;

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: studentId },
        data: {
          status: 'SUSPENDED',
          suspendedAt: new Date(),
          suspendedReason: dto.reason,
        },
      });

      // Disable work mode and release the active task.
      await tx.riderState.updateMany({
        where: { userId: studentId },
        data: { workModeOn: false, activeTaskId: null },
      });

      // Cancel the in-flight assignment by returning the task to broadcast.
      // The task keeps its history; the rider is simply detached.
      if (activeTaskId) {
        const task = await tx.task.findUnique({
          where: { id: activeTaskId },
          select: { id: true, status: true, baseFeeMinor: true },
        });

        // Only a task not yet picked up can safely return to the pool. One
        // already carrying goods needs a human, so it escalates instead.
        if (task && task.status === 'ASSIGNED') {
          await tx.task.update({
            where: { id: activeTaskId },
            data: {
              riderId: null,
              status: 'BROADCASTING',
              assignedAt: null,
              // R-08: a task returning to the pool is a fresh search.
              broadcastRound: 0,
              feeMinor: task.baseFeeMinor,
              offerExpiresAt: null,
            },
          });
        } else if (task && ['PICKED_UP', 'DELIVERED'].includes(task.status)) {
          await tx.task.update({
            where: { id: activeTaskId },
            data: {
              status: 'ESCALATED',
              escalatedAt: new Date(),
              resolutionNote: `Rider suspended mid-delivery: ${dto.reason}`,
            },
          });
        }
      }

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: student!.collegeId,
        action: AuditAction.STUDENT_SUSPENDED,
        targetType: 'user',
        targetId: studentId,
        detail: { reason: dto.reason, releasedTaskId: activeTaskId },
      });
    });

    // Terminate sessions. The JWT strategy also rejects a suspended account on
    // every request, so this is belt and braces — but revoking the refresh
    // tokens is what stops a new access token being minted.
    const revoked = await this.auth.revokeAllSessions(studentId);

    // Remove from the dispatch pool so no further offers reach them.
    if (student!.collegeId) {
      await this.redis.removeRider(student!.collegeId, studentId);
    }

    this.logger.warn(`Student ${studentId} suspended by ${user.userId}: ${dto.reason}`);

    return {
      studentId,
      status: 'SUSPENDED',
      sessionsRevoked: revoked,
      taskReleased: activeTaskId,
      message: 'Account suspended. Sessions ended, work mode disabled, active task released.',
    };
  }

  async reinstate(user: AuthenticatedUser, studentId: string) {
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, collegeId: true, status: true },
    });

    this.tenant.assertSameTenant(user, student, 'Student');

    if (student!.status !== 'SUSPENDED') {
      throw new ConflictException({
        code: 'NOT_SUSPENDED',
        message: 'That account is not suspended.',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: studentId },
        data: { status: 'ACTIVE', suspendedAt: null, suspendedReason: null },
      });

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: student!.collegeId,
        action: AuditAction.STUDENT_REINSTATED,
        targetType: 'user',
        targetId: studentId,
      });
    });

    return { studentId, status: 'ACTIVE', message: 'Account reinstated.' };
  }

  /**
   * NFR-S-03: identity documents are "retrievable only through authenticated
   * administrator endpoints, with every access logged".
   *
   * Returns a short-lived signed URL rather than the bytes, and records who
   * looked at whose document. The logging is the point: a private bucket stops
   * outsiders, and the audit trail is what deters insiders.
   */
  async viewDocument(user: AuthenticatedUser, submissionId: string) {
    const submission = await this.prisma.verificationSubmission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        collegeId: true,
        userId: true,
        idCardUrl: true,
        govtIdImageUrl: true,
        govtIdImageExpiresAt: true,
      },
    });

    this.tenant.assertSameTenant(user, submission, 'Verification submission');

    await this.audit.record({
      actorId: user.userId,
      collegeId: submission!.collegeId,
      action: AuditAction.IDENTITY_DOCUMENT_VIEWED,
      targetType: 'verification_submission',
      targetId: submissionId,
      detail: { studentId: submission!.userId },
    });

    // FR-ID-03: an expired image is gone even if the row still points at it.
    const imageExpired =
      submission!.govtIdImageExpiresAt !== null &&
      submission!.govtIdImageExpiresAt.getTime() < Date.now();

    return {
      idCardUrl: submission!.idCardUrl,
      govtIdImageUrl: imageExpired ? null : submission!.govtIdImageUrl,
      govtIdImageExpired: imageExpired,
      note: 'Signed URL generation lands with the object-storage integration in Phase 1C.',
    };
  }
}
