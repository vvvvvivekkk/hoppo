import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { AuditAction } from './audit.service';
import { csvLine } from './csv';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../common/tenant/tenant.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { clampPageLimit } from '../common/pagination';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

export interface AuditLogQuery {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  collegeId?: string;
  limit?: string;
  cursor?: string;
}

/** The most rows one export will contain. Newest first, so the cap drops the oldest. */
export const AUDIT_EXPORT_ROW_CAP = 10_000;
const AUDIT_EXPORT_BATCH = 500;

export const AUDIT_EXPORT_COLUMNS = [
  'createdAt',
  'action',
  'targetType',
  'targetId',
  'actorId',
  'actorName',
  'actorRole',
  'collegeId',
  'ipAddress',
  'userAgent',
  'detail',
] as const;

function parseInstant(raw: string | undefined, name: string): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException({
      code: 'INVALID_DATE_RANGE',
      message: `"${name}" is not a date. Use an ISO date such as 2026-11-20 or 2026-11-20T09:30:00Z.`,
    });
  }
  return parsed;
}

/**
 * FR-ADM-06 / A-15: the audit log, for reading.
 *
 * There is deliberately nothing here but GET. The table is append-only in the
 * database (a trigger refuses UPDATE and DELETE), entries are written by
 * AuditService from the code that performs each action, and no HTTP route
 * creates, edits or removes one.
 *
 * C-1: an administrator's query is always pinned to their own college by
 * `tenant.scope()`. Entries recorded against no college (session revocations,
 * platform actions) are therefore visible to a super administrator only.
 */
@ApiTags('admin: audit')
@Controller('admin/audit-log')
@Roles('ADMIN')
export class AuditLogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
  ) {}

  /**
   * The filter for a query — shared by the list and the export, so the
   * export can never be scoped differently from the screen it was made from.
   *
   * C-1: `tenant.scope(user)` is spread last among the college terms, so an
   * administrator's own college overwrites any `collegeId` in the query.
   */
  private whereFor(user: AuthenticatedUser, query: AuditLogQuery): Prisma.AuditLogWhereInput {
    const from = parseInstant(query.from, 'from');
    const to = parseInstant(query.to, 'to');
    if (from && to && from.getTime() >= to.getTime()) {
      throw new BadRequestException({
        code: 'INVALID_DATE_RANGE',
        message: '"from" must be earlier than "to".',
      });
    }

    const where: Prisma.AuditLogWhereInput = {
      // Only a super administrator may choose a college; for everyone else
      // the scope below overwrites whatever was asked for.
      ...(user.role === 'SUPER_ADMIN' && query.collegeId ? { collegeId: query.collegeId } : {}),
      ...this.tenant.scope(user),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }
        : {}),
    };

    return where;
  }

  /** The action names that can appear, for the filter control. */
  @Get('actions')
  @ApiOperation({ summary: 'Known audit action names' })
  actions() {
    return { actions: Object.values(AuditAction).sort() };
  }

  @Get()
  @ApiOperation({ summary: 'Audit entries for my college, newest first, filterable' })
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: AuditLogQuery) {
    const where = this.whereFor(user, query);

    const limit = clampPageLimit(query.limit);

    const rows = await this.prisma.auditLog.findMany({
      where,
      select: {
        id: true,
        createdAt: true,
        action: true,
        targetType: true,
        targetId: true,
        collegeId: true,
        detail: true,
        ipAddress: true,
        userAgent: true,
        actor: { select: { id: true, name: true, role: true } },
      },
      // `id` breaks ties between entries written in the same millisecond, so
      // the cursor never skips or repeats one.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * A-15 "exportable": the filtered list as a CSV file.
   *
   * Same role, same filters and the same tenancy scope as the list above —
   * it is built from the same `whereFor`. Read-only like everything else here.
   *
   * Streamed in batches rather than built in memory, and capped: an audit
   * log only grows, and an unbounded export is an easy way to hold a
   * connection and a large result set open. The cap and whether it was hit
   * are reported in headers, which are sent before the first row, so they
   * come from a count taken up front.
   */
  @Get('export')
  @ApiOperation({ summary: 'The filtered audit entries as CSV (capped)' })
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AuditLogQuery,
    @Res() res: Response,
  ): Promise<void> {
    // Validation and scoping happen before any header is written, so a bad
    // date range is still an ordinary JSON 400.
    const where = this.whereFor(user, query);
    const total = await this.prisma.auditLog.count({ where });
    const exported = Math.min(total, AUDIT_EXPORT_ROW_CAP);

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Total-Rows', String(total));
    res.setHeader('X-Exported-Rows', String(exported));
    res.setHeader('X-Row-Cap', String(AUDIT_EXPORT_ROW_CAP));
    res.setHeader('X-Truncated', String(total > AUDIT_EXPORT_ROW_CAP));

    res.write(csvLine(AUDIT_EXPORT_COLUMNS));

    let written = 0;
    let cursor: string | undefined;

    while (written < exported) {
      const batch = await this.prisma.auditLog.findMany({
        where,
        select: {
          id: true,
          createdAt: true,
          action: true,
          targetType: true,
          targetId: true,
          collegeId: true,
          detail: true,
          ipAddress: true,
          userAgent: true,
          actor: { select: { id: true, name: true, role: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: Math.min(AUDIT_EXPORT_BATCH, exported - written),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;

      for (const row of batch) {
        res.write(
          csvLine([
            row.createdAt,
            row.action,
            row.targetType,
            row.targetId,
            row.actor?.id ?? '',
            row.actor?.name ?? '',
            row.actor?.role ?? '',
            row.collegeId ?? '',
            row.ipAddress ?? '',
            row.userAgent ?? '',
            row.detail === null ? '' : JSON.stringify(row.detail),
          ]),
        );
      }

      written += batch.length;
      cursor = batch[batch.length - 1].id;
    }

    res.end();
  }
}
