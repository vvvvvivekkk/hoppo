import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import type { OrderStatus, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { StorageService } from '../storage/storage.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { DispatchGateway } from '../dispatch/dispatch.gateway';
import { readWalletHead } from '../wallet/wallet-ledger';
import { readMe } from '../auth/me';
import type { UpdateProfileDto } from './dto/account.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/** A rider is still responsible for a task in any of these states. */
export const RIDER_OPEN_TASK_STATUSES: TaskStatus[] = [
  'ASSIGNED',
  'PICKED_UP',
  'DELIVERED',
  'ESCALATED',
];

/** A requester's task that has not reached an end state. */
export const REQUESTER_OPEN_TASK_STATUSES: TaskStatus[] = [
  'CREATED',
  'BROADCASTING',
  'ASSIGNED',
  'PICKED_UP',
  'DELIVERED',
  'ESCALATED',
];

export const OPEN_ORDER_STATUSES: OrderStatus[] = [
  'PLACED',
  'SHOP_ACCEPTED',
  'PREPARING',
  'READY',
  'PICKED_UP',
  'DELIVERED',
];

export const ERASED_ON_DELETION = [
  'name',
  'mobile',
  'email',
  'avatar',
  'rollNumber',
  'department',
  'identity documents',
  'device tokens',
  'sessions',
] as const;

export const RETAINED_ON_DELETION = ['orders', 'tasks', 'wallet entries', 'audit log'] as const;

/**
 * FR-PRIV-05: "A student shall be able to request export of their personal
 * data and deletion of their account, subject to retention of transaction
 * records required for settlement and dispute resolution."
 *
 * Both operations take the user id from the token and nothing else. There is
 * no id in either request, so there is no way to ask for somebody else's
 * data — and every query below filters on that one id.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly gateway: DispatchGateway,
  ) {}

  // =======================================================================
  // Profile (S-50)
  // =======================================================================

  /**
   * Change the display name and/or the profile photo.
   *
   * Everything else on the profile is somebody's proof of something:
   *  - mobile was verified by OTP (FR-AUTH-02) and email is tied to the
   *    college's domain and uniqueness rules (FR-AUTH-03/04) — changing
   *    either needs the same verification again, which this route does not do;
   *  - roll number, department and year are what an administrator checked
   *    against the ID card (FR-SVER-02) — they change only through a new
   *    verification submission.
   * Each is refused with its own code so a client can say why.
   *
   * A name change is audited with the old and new value: the name is what
   * shops and riders see, and an administrator should be able to tell that
   * a verified account now shows a different one.
   */
  async updateProfile(user: AuthenticatedUser, dto: UpdateProfileDto) {
    if (dto.email !== undefined || dto.mobile !== undefined) {
      const field = dto.email !== undefined ? 'email' : 'mobile';
      throw new BadRequestException({
        code: field === 'email' ? 'EMAIL_CHANGE_NOT_SUPPORTED' : 'MOBILE_CHANGE_NOT_SUPPORTED',
        message:
          field === 'email'
            ? 'Your email address cannot be changed here: a new address has to be verified first.'
            : 'Your mobile number cannot be changed here: a new number has to be verified first.',
        details: { field },
      });
    }

    for (const field of ['rollNumber', 'department', 'yearOfStudy'] as const) {
      if (dto[field] !== undefined) {
        throw new BadRequestException({
          code: 'VERIFIED_FIELD_NOT_EDITABLE',
          message:
            'Your roll number, department and year come from your verified college ID. ' +
            'To correct them, submit your verification again.',
          details: { field },
        });
      }
    }

    if (dto.name === undefined && dto.avatarKey === undefined) {
      throw new BadRequestException({
        code: 'EMPTY_UPDATE',
        message: 'Send a name or a photo to change.',
      });
    }

    const userId = user.userId;
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, avatarUrl: true },
    });
    if (!current) throw new ForbiddenException('Account not found');

    const data: { name?: string; avatarUrl?: string | null } = {};
    const changed: Record<string, { from: string | null; to: string | null }> = {};

    if (dto.name !== undefined && dto.name !== current.name) {
      data.name = dto.name;
      changed.name = { from: current.name, to: dto.name };
    }

    if (dto.avatarKey !== undefined) {
      let avatarUrl: string | null = null;
      if (dto.avatarKey !== null) {
        // Only a key the upload endpoint issued to this user for an avatar:
        // `avatar/<their id>/<uuid>.<ext>`. Anything else would let the
        // profile point at another person's file, or at a private document.
        const expected = new RegExp(`^avatar/${userId}/[A-Za-z0-9-]+\\.(jpg|png|webp)$`);
        if (!expected.test(dto.avatarKey)) {
          throw new BadRequestException({
            code: 'AVATAR_KEY_INVALID',
            message: 'That photo was not uploaded for your profile. Upload it again.',
          });
        }
        avatarUrl = this.storage.publicUrl(dto.avatarKey);
      }
      if (avatarUrl !== current.avatarUrl) {
        data.avatarUrl = avatarUrl;
        changed.avatar = { from: current.avatarUrl, to: avatarUrl };
      }
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data });
        await this.audit.recordInTransaction(tx, {
          actorId: userId,
          collegeId: user.collegeId,
          action: AuditAction.PROFILE_UPDATED,
          targetType: 'user',
          targetId: userId,
          detail: changed,
        });
      });
    }

    // Exactly what GET /auth/me now returns.
    return readMe(this.prisma, userId);
  }

  // =======================================================================
  // Export
  // =======================================================================

  /**
   * Everything held about the caller, as JSON.
   *
   * What is deliberately absent: document images and their storage keys (the
   * export is a file that will sit in a downloads folder), and every other
   * person — the rider or requester on a task, a wallet counterparty, the
   * administrator who decided a verification. Their data is not the
   * caller's to export.
   */
  async exportData(user: AuthenticatedUser) {
    const userId = user.userId;

    const [
      account,
      acceptance,
      submissions,
      orders,
      tasksRequested,
      tasksDelivered,
      walletEntries,
      withdrawals,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          mobile: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          college: { select: { id: true, name: true } },
          studentProfile: {
            select: {
              rollNumber: true,
              department: true,
              yearOfStudy: true,
              verificationStatus: true,
              verifiedAt: true,
              govtIdType: true,
              govtIdLast4: true,
              riderTermsVersion: true,
              riderTermsAcceptedAt: true,
            },
          },
        },
      }),
      this.prisma.auditLog.findFirst({
        where: {
          action: AuditAction.PRIVACY_NOTICE_ACCEPTED,
          targetType: 'user',
          targetId: userId,
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, detail: true },
      }),
      this.prisma.verificationSubmission.findMany({
        where: { userId },
        select: {
          id: true,
          status: true,
          submittedAt: true,
          decidedAt: true,
          rejectionReason: true,
          rejectionNote: true,
          rollNumber: true,
          department: true,
          yearOfStudy: true,
          govtIdType: true,
          govtIdLast4: true,
        },
        orderBy: { submittedAt: 'asc' },
      }),
      this.prisma.order.findMany({
        where: { studentId: userId },
        select: {
          id: true,
          reference: true,
          status: true,
          placedAt: true,
          itemsSubtotalMinor: true,
          deliveryFeeMinor: true,
          platformFeeMinor: true,
          totalMinor: true,
          paymentMethod: true,
          dropLandmark: true,
          deliveryPointId: true,
          studentNote: true,
          shopListing: { select: { shop: { select: { name: true } } } },
          items: {
            select: { nameSnapshot: true, quantity: true, unitPriceMinor: true, note: true },
          },
        },
        orderBy: { placedAt: 'asc' },
      }),
      this.prisma.task.findMany({
        where: { requesterId: userId },
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
          completedAt: true,
          pickupLabel: true,
          dropLabel: true,
          description: true,
          feeMinor: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.task.findMany({
        where: { riderId: userId },
        select: {
          id: true,
          type: true,
          status: true,
          assignedAt: true,
          completedAt: true,
          pickupLabel: true,
          dropLabel: true,
          feeMinor: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.walletEntry.findMany({
        where: { userId },
        select: {
          id: true,
          createdAt: true,
          direction: true,
          type: true,
          amountMinor: true,
          balanceAfterMinor: true,
          taskId: true,
          orderId: true,
          note: true,
        },
        orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }],
      }),
      this.prisma.withdrawalRequest.findMany({
        where: { userId },
        select: { id: true, status: true, amountMinor: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const version = (acceptance?.detail as { version?: unknown } | null)?.version;

    // An order delivered to a campus point has no landmark text; its label is
    // the point's name. The order row holds only the id (there is no foreign
    // key), so the names are looked up — within the caller's own college, and
    // including points that have since been retired.
    const pointIds = [...new Set(orders.map((o) => o.deliveryPointId).filter((id) => id !== null))];
    const points =
      pointIds.length > 0 && user.collegeId
        ? await this.prisma.deliveryPoint.findMany({
            where: { id: { in: pointIds }, collegeId: user.collegeId },
            select: { id: true, name: true },
          })
        : [];
    const pointName = new Map(points.map((p) => [p.id, p.name]));

    await this.audit.record({
      actorId: userId,
      collegeId: user.collegeId,
      action: AuditAction.DATA_EXPORTED,
      targetType: 'user',
      targetId: userId,
    });

    const { studentProfile, ...accountFields } = account ?? { studentProfile: null };

    return {
      exportedAt: new Date(),
      formatVersion: 1,
      account: {
        ...accountFields,
        privacyNotice:
          acceptance && typeof version === 'string'
            ? { version, acceptedAt: acceptance.createdAt }
            : null,
      },
      studentProfile,
      verificationSubmissions: submissions,
      orders: orders.map(
        ({ shopListing, items, placedAt, dropLandmark, deliveryPointId, ...order }) => ({
          ...order,
          createdAt: placedAt,
          shopName: shopListing.shop.name,
          deliveryLabel:
            (deliveryPointId ? pointName.get(deliveryPointId) : undefined) ?? dropLandmark,
          items: items.map((item) => ({
            name: item.nameSnapshot,
            quantity: item.quantity,
            unitPriceMinor: item.unitPriceMinor,
            note: item.note,
          })),
        }),
      ),
      tasksRequested,
      tasksDelivered,
      walletEntries,
      withdrawals: withdrawals.map(({ createdAt, ...w }) => ({ ...w, requestedAt: createdAt })),
    };
  }

  // =======================================================================
  // Deletion
  // =======================================================================

  /**
   * Close the account and erase what identifies the person.
   *
   * Refused while something is still owed in either direction: a task in
   * flight (someone is waiting on this person, or this person on a rider), a
   * wallet balance (money that would be stranded), or a withdrawal an
   * administrator has yet to pay.
   *
   * What goes: name, mobile, email, avatar, roll number, department,
   * identity-document references (and the objects themselves, best effort),
   * device tokens, sessions. What stays, per FR-PRIV-05: orders, tasks,
   * wallet entries and the audit log — they still reference this row, which
   * is why the row is scrubbed and DEACTIVATED rather than removed.
   */
  async deleteAccount(user: AuthenticatedUser, password: string) {
    const userId = user.userId;

    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, collegeId: true, passwordHash: true },
    });

    if (!account || !(await argon2.verify(account.passwordHash, password).catch(() => false))) {
      throw new ForbiddenException({
        code: 'PASSWORD_INCORRECT',
        message: 'That password is not correct.',
      });
    }

    const deletedAt = new Date();

    const documentKeys = await this.prisma.$transaction(async (tx) => {
      // Lock the account row so the checks and the scrub see one state.
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;

      const [ridingTasks, ownTasks, ownOrders] = await Promise.all([
        tx.task.findMany({
          where: { riderId: userId, status: { in: RIDER_OPEN_TASK_STATUSES } },
          select: { id: true },
        }),
        tx.task.findMany({
          where: { requesterId: userId, status: { in: REQUESTER_OPEN_TASK_STATUSES } },
          select: { id: true },
        }),
        tx.order.findMany({
          where: { studentId: userId, status: { in: OPEN_ORDER_STATUSES } },
          select: { id: true },
        }),
      ]);

      if (ridingTasks.length + ownTasks.length + ownOrders.length > 0) {
        throw new ConflictException({
          code: 'ACTIVE_TASK_IN_PROGRESS',
          message:
            'You have a delivery or an order still in progress. Your account can be deleted ' +
            'once it is completed or cancelled.',
          details: {
            taskIds: [...new Set([...ridingTasks, ...ownTasks].map((t) => t.id))],
            orderIds: ownOrders.map((o) => o.id),
          },
        });
      }

      const pendingWithdrawals = await tx.withdrawalRequest.count({
        where: { userId, status: { in: ['REQUESTED', 'APPROVED'] } },
      });
      if (pendingWithdrawals > 0) {
        throw new ConflictException({
          code: 'WITHDRAWAL_PENDING',
          message:
            'You have a withdrawal that has not been paid yet. Your account can be deleted ' +
            'once it has been settled.',
        });
      }

      const { balanceMinor } = await readWalletHead(tx, userId);
      if (balanceMinor !== 0) {
        throw new ConflictException({
          code: 'WALLET_BALANCE_NOT_ZERO',
          message:
            balanceMinor > 0
              ? 'Your wallet still holds money. Withdraw it before deleting your account.'
              : 'Your wallet has an amount outstanding. Contact your campus administrator.',
          details: { balanceMinor },
        });
      }

      // The storage keys to remove once the transaction has committed.
      const [profile, submissions] = await Promise.all([
        tx.studentProfile.findUnique({ where: { userId }, select: { idCardUrl: true } }),
        tx.verificationSubmission.findMany({
          where: { userId },
          select: { idCardUrl: true, govtIdImageUrl: true },
        }),
      ]);
      const keys = [
        profile?.idCardUrl,
        ...submissions.flatMap((s) => [s.idCardUrl, s.govtIdImageUrl]),
      ].filter((k): k is string => typeof k === 'string' && k.length > 0);

      // Unique placeholders: `mobile` and `email` are UNIQUE NOT NULL, and
      // replacing them frees the real number and address to register again.
      const marker = `deleted-${userId}`;

      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'DEACTIVATED',
          name: 'Deleted user',
          mobile: marker,
          email: `${marker}@deleted.invalid`,
          // Not a valid hash of anything, so no password can ever match it.
          passwordHash: `deleted:${randomBytes(24).toString('hex')}`,
          avatarUrl: null,
          mobileVerifiedAt: null,
          emailVerifiedAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });

      await tx.studentProfile.updateMany({
        where: { userId },
        data: {
          rollNumber: '',
          department: '',
          idCardUrl: null,
          govtIdType: null,
          govtIdLast4: null,
        },
      });

      // A submission nobody decided is not a record of anything: remove it,
      // so it does not sit in the administrator's queue for a closed account.
      await tx.verificationSubmission.deleteMany({ where: { userId, status: 'PENDING' } });
      // Decided ones keep the decision (FR-SVER-09) and lose the personal part.
      await tx.verificationSubmission.updateMany({
        where: { userId },
        data: {
          rollNumber: '',
          department: '',
          idCardUrl: '',
          govtIdLast4: null,
          govtIdImageUrl: null,
          govtIdImageExpiresAt: null,
        },
      });

      await tx.deviceToken.deleteMany({ where: { userId } });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: deletedAt },
      });
      await tx.riderState.updateMany({
        where: { userId },
        data: { workModeOn: false, lastLatitude: null, lastLongitude: null, lastPingAt: null },
      });

      // The entry names no personal detail: it must outlive the erasure.
      await this.audit.recordInTransaction(tx, {
        actorId: userId,
        collegeId: account.collegeId,
        action: AuditAction.ACCOUNT_DELETED,
        targetType: 'user',
        targetId: userId,
        detail: { requestedBy: 'SELF', documentsErased: keys.length },
      });

      return keys;
    });

    // After the commit: nothing below can be rolled back, and none of it may
    // undo a deletion that has already happened.
    await this.auth.revokeAllSessions(userId);
    if (account.collegeId) {
      await this.redis
        .removeRider(account.collegeId, userId)
        .catch((e: unknown) => this.logger.warn(`Could not clear rider ${userId}: ${String(e)}`));
    }
    this.gateway.disconnectUser(userId);

    let documentsRemoved = 0;
    for (const key of new Set(documentKeys)) {
      const removed = await this.storage.deletePrivateObject(key).catch(() => false);
      if (removed) documentsRemoved += 1;
    }
    if (documentsRemoved < new Set(documentKeys).size) {
      // The references are gone either way; the objects are now orphans that
      // the storage retention job has to collect.
      this.logger.warn(
        `Account ${userId} deleted; ${new Set(documentKeys).size - documentsRemoved} document object(s) could not be removed from storage`,
      );
    }

    return {
      status: 'DEACTIVATED' as const,
      deletedAt,
      erased: ERASED_ON_DELETION,
      retained: RETAINED_ON_DELETION,
      message:
        'Your account has been deleted. Records of past orders, deliveries and wallet entries ' +
        'are kept without your personal details, as needed for settlement and disputes.',
    };
  }
}
