import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { AuditAction } from './audit.service';
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

  /** The action names that can appear, for the filter control. */
  @Get('actions')
  @ApiOperation({ summary: 'Known audit action names' })
  actions() {
    return { actions: Object.values(AuditAction).sort() };
  }

  @Get()
  @ApiOperation({ summary: 'Audit entries for my college, newest first, filterable' })
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: AuditLogQuery) {
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
}
