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
import { DispatchGateway } from '../dispatch/dispatch.gateway';
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
    // Injected directly: VerificationModule imports DispatchModule, which
    // exports the gateway and depends on nothing in this module.
    private readonly gateway: DispatchGateway,
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

    const allowed = config?.maxVerificationSubmissions ?? 3;

    // When the rolling window next frees an attempt: the oldest submission
    // still inside it, plus the window. Null while attempts remain. The same
    // computation submit() puts in SUBMISSION_LIMIT_REACHED's details, so the
    // date on the screen and the date in the refusal cannot disagree.
    let retryAt: Date | null = null;
    if (used >= allowed) {
      const oldest = await this.prisma.verificationSubmission.findFirst({
        where: { userId: user.userId, submittedAt: { gte: windowStart } },
        orderBy: { submittedAt: 'asc' },
        select: { submittedAt: true },
      });
      retryAt = oldest ? new Date(oldest.submittedAt.getTime() + windowDays * 86_400_000) : null;
    }

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
      submissionsAllowed: allowed,
      retryAt,
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

    const released = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: studentId },
        data: {
          status: 'SUSPENDED',
          suspendedAt: new Date(),
          suspendedReason: dto.reason,
        },
      });

      /**
       * Cancel the in-flight assignment by returning the task to the pool.
       * The task keeps its history; the rider is simply detached.
       *
       * M9: this used to set the task BROADCASTING with `offerExpiresAt`
       * null and no `dispatchDueAt`. Neither dispatcher tick matches that:
       * the first looks for CREATED with a due time, the second for
       * BROADCASTING with an expiry. The task sat in a state that says "on
       * offer" while being offered to nobody, forever, and the student's
       * food went cold with the app showing "finding a rider".
       *
       * It now does exactly what abandonment does — CREATED, due now, round
       * 0, base fee (R-08: a task returning to the pool is a fresh search) —
       * which the dispatch-due tick picks up within five seconds. CREATED
       * with `rider_id` NULL also satisfies task_rider_presence_matches_status.
       *
       * ADR-001: found by `rider_id` and status in the UPDATE's own WHERE,
       * not by an `activeTaskId` read before the transaction began. A rider
       * who accepted a task between that read and this write would otherwise
       * keep it, suspended.
       */
      const returnedToPool = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "task"
        SET rider_id = NULL,
            status = 'CREATED',
            assigned_at = NULL,
            broadcast_round = 0,
            fee_minor = base_fee_minor,
            current_proximity_m = NULL,
            offer_expires_at = NULL,
            dispatch_due_at = now(),
            updated_at = now()
        WHERE rider_id = ${studentId}
          AND status = 'ASSIGNED'
        RETURNING id
      `;

      // Only a task not yet picked up can safely return to the pool. One
      // already carrying goods needs a human, so it escalates instead. It
      // keeps its rider_id (the CHECK requires one while ESCALATED, and the
      // administrator needs to know who has the goods).
      const escalated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "task"
        SET status = 'ESCALATED',
            escalated_at = now(),
            resolution_note = ${`Rider suspended mid-delivery: ${dto.reason}`},
            updated_at = now()
        WHERE rider_id = ${studentId}
          AND status IN ('PICKED_UP', 'DELIVERED')
        RETURNING id
      `;

      // As abandonment does: the task room was for this rider. Archived, and
      // the rider marked as having left; the next accept re-opens it.
      const returnedIds = returnedToPool.map((t) => t.id);
      if (returnedIds.length > 0) {
        const rooms = await tx.chatRoom.findMany({
          where: { taskId: { in: returnedIds } },
          select: { id: true },
        });
        const roomIds = rooms.map((r) => r.id);
        await tx.chatRoom.updateMany({
          where: { id: { in: roomIds } },
          data: { isArchived: true, archivedAt: new Date() },
        });
        await tx.chatMember.updateMany({
          where: { roomId: { in: roomIds }, userId: studentId, leftAt: null },
          data: { leftAt: new Date() },
        });
      }

      // Disable work mode and release whatever the rider held. After the
      // task updates, so the two rows change together or not at all.
      await tx.riderState.updateMany({
        where: { userId: studentId },
        data: { workModeOn: false, activeTaskId: null },
      });

      const releasedTaskId = returnedIds[0] ?? escalated[0]?.id ?? null;

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: student!.collegeId,
        action: AuditAction.STUDENT_SUSPENDED,
        targetType: 'user',
        targetId: studentId,
        detail: {
          reason: dto.reason,
          releasedTaskId,
          returnedToPoolTaskIds: returnedIds,
          escalatedTaskIds: escalated.map((t) => t.id),
        },
      });

      return { releasedTaskId, returnedIds, escalatedIds: escalated.map((t) => t.id) };
    });

    const activeTaskId = released.releasedTaskId;

    // Terminate sessions. The JWT strategy also rejects a suspended account on
    // every request, so this is belt and braces — but revoking the refresh
    // tokens is what stops a new access token being minted.
    const revoked = await this.auth.revokeAllSessions(studentId);

    // Remove from the dispatch pool so no further offers reach them.
    if (student!.collegeId) {
      await this.redis.removeRider(student!.collegeId, studentId);
    }

    // FR-SVER-08, "immediately terminating active sessions": a socket is
    // authenticated once, at connect, so one opened before the suspension
    // would keep receiving task offers and chat until it happened to
    // reconnect. Revoking tokens does not reach it; closing it does.
    this.gateway.disconnectUser(studentId);

    // M7-consistent: the people each affected task belongs to are told,
    // individually. The suspended rider is not among them — their sockets
    // have just been closed.
    for (const taskId of released.returnedIds) {
      this.gateway.notifyTaskStatus(await this.taskAudience(taskId), taskId, 'CREATED', {
        reason: 'RIDER_REMOVED',
      });
    }
    for (const taskId of released.escalatedIds) {
      this.gateway.notifyTaskStatus(
        (await this.taskAudience(taskId)).filter((id) => id !== studentId),
        taskId,
        'ESCALATED',
        { reason: 'RIDER_SUSPENDED' },
      );
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

  /**
   * Who a task's status is the business of: the requester, and the shop's
   * staff for a shop order. Mirrors DispatchService.taskAudience.
   */
  private async taskAudience(taskId: string): Promise<string[]> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        requesterId: true,
        riderId: true,
        order: {
          select: {
            shopListing: { select: { shop: { select: { staff: { select: { userId: true } } } } } },
          },
        },
      },
    });
    if (!task) return [];

    return [
      ...new Set([
        task.requesterId,
        ...(task.riderId ? [task.riderId] : []),
        ...(task.order?.shopListing.shop.staff.map((s) => s.userId) ?? []),
      ]),
    ];
  }

  async reinstate(user: AuthenticatedUser, studentId: string) {
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, collegeId: true, role: true, status: true },
    });

    this.tenant.assertSameTenant(user, student, 'Student');

    // The mirror of suspend(): this route acts on student accounts only.
    if (student!.role !== 'STUDENT') {
      throw new BadRequestException({
        code: 'NOT_A_STUDENT',
        message: 'Only student accounts are reinstated this way.',
      });
    }

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
