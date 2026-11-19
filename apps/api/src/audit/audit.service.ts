import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Action names, as constants so a typo does not create a second category. */
export const AuditAction = {
  // Authentication
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  SESSIONS_REVOKED: 'SESSIONS_REVOKED',
  // Student verification (FR-SVER-09)
  VERIFICATION_SUBMITTED: 'VERIFICATION_SUBMITTED',
  VERIFICATION_APPROVED: 'VERIFICATION_APPROVED',
  VERIFICATION_REJECTED: 'VERIFICATION_REJECTED',
  STUDENT_SUSPENDED: 'STUDENT_SUSPENDED',
  STUDENT_REINSTATED: 'STUDENT_REINSTATED',
  // Documents (NFR-S-03: every access logged)
  IDENTITY_DOCUMENT_VIEWED: 'IDENTITY_DOCUMENT_VIEWED',
  IDENTITY_DOCUMENT_DELETED: 'IDENTITY_DOCUMENT_DELETED',
  // Shops
  SHOP_APPROVED: 'SHOP_APPROVED',
  SHOP_REJECTED: 'SHOP_REJECTED',
  SHOP_SUSPENDED: 'SHOP_SUSPENDED',
  // Tasks and money
  TASK_ESCALATED: 'TASK_ESCALATED',
  TASK_RESOLVED: 'TASK_RESOLVED',
  WITHDRAWAL_MARKED_PAID: 'WITHDRAWAL_MARKED_PAID',
  WALLET_ADJUSTED: 'WALLET_ADJUSTED',
  // Configuration
  COLLEGE_CONFIG_CHANGED: 'COLLEGE_CONFIG_CHANGED',
  COLLEGE_CREATED: 'COLLEGE_CREATED',
  RADIUS_CHANGED: 'RADIUS_CHANGED',
  // Moderation
  CONTENT_REMOVED: 'CONTENT_REMOVED',
  CONVERSATION_VIEWED: 'CONVERSATION_VIEWED',
} as const;

export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  /** Null for system-initiated actions such as a dispatcher timeout. */
  actorId: string | null;
  collegeId: string | null;
  action: AuditActionType;
  targetType: string;
  targetId: string;
  detail?: Prisma.InputJsonValue;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * FR-ADM-06: "Every administrative action affecting a user, shop, order, or
 * wallet shall be recorded in an append-only audit log."
 * FR-SVER-09: an immutable entry per verification decision.
 *
 * The table is append-only in the database too — a trigger refuses UPDATE and
 * DELETE (ADR-007). This service is the only thing that writes to it.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write an audit entry.
   *
   * Deliberately swallows its own errors. An audit write failing must not fail
   * the action it was describing — an administrator's approval should not be
   * rolled back because the log was briefly unavailable. The failure is logged
   * at error level so it is still visible.
   *
   * Where the audit entry genuinely must be atomic with the action, use
   * `recordInTransaction` instead and let it fail the transaction.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: this.toRow(entry) });
    } catch (error) {
      this.logger.error(
        `Failed to write audit entry ${entry.action} for ${entry.targetType}:${entry.targetId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Write an audit entry inside a caller's transaction, so the entry and the
   * change it describes either both land or neither does. Used for decisions
   * where a missing audit row would be a compliance problem rather than an
   * inconvenience — verification decisions and wallet adjustments.
   */
  async recordInTransaction(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({ data: this.toRow(entry) });
  }

  private toRow(entry: AuditEntry): Prisma.AuditLogCreateInput {
    return {
      actor: entry.actorId ? { connect: { id: entry.actorId } } : undefined,
      collegeId: entry.collegeId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      detail: entry.detail,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
    };
  }
}
