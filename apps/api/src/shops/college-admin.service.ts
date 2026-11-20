import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { DeliveryPoint, Prisma } from '@prisma/client';
import { RADIUS_MAX_M } from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  CONFIG_LIMITS,
  EDITABLE_CONFIG_FIELDS,
  FEE_BAND_LIMITS,
  type EditableConfigField,
  type FeeBandInput,
  configValueProblem,
  feeBandsProblem,
  normaliseFeeBands,
} from './college-config.rules';
import type {
  CreateDeliveryPointDto,
  UpdateCollegeConfigDto,
  UpdateDeliveryPointDto,
} from './dto/college-admin.dto';

/** A delivery point may sit anywhere the serviceable radius could ever reach. */
export const DELIVERY_POINT_MAX_DISTANCE_M = RADIUS_MAX_M;

/**
 * FR-ADM-03: the settings an administrator keeps for their own college, and
 * FR-ORD-02: the campus delivery points students choose from.
 *
 * C-1 throughout. Configuration has no id in the request at all — the college
 * is the one on the token. Delivery points are fetched and then passed
 * through `assertSameTenant`, so another college's point is a 403, and list
 * queries filter on the token's college.
 */
@Injectable()
export class CollegeAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenant: TenantService,
  ) {}

  // =======================================================================
  // Configuration — FR-ADM-03
  // =======================================================================

  async getConfig(user: AuthenticatedUser) {
    const collegeId = this.tenant.requireCollegeId(user);
    return this.readConfig(this.prisma, collegeId);
  }

  private async readConfig(client: Prisma.TransactionClient | PrismaService, collegeId: string) {
    const [row, bands] = await Promise.all([
      client.collegeConfig.findUnique({ where: { collegeId } }),
      client.feeBand.findMany({
        where: { collegeId },
        select: { minDistanceM: true, maxDistanceM: true, feeMinor: true },
        orderBy: { minDistanceM: 'asc' },
      }),
    ]);

    if (!row) {
      throw new NotFoundException({
        code: 'COLLEGE_CONFIG_MISSING',
        message: 'This college has no configuration yet. Contact the platform administrator.',
      });
    }

    const config: Record<string, number> = { serviceableRadiusM: row.serviceableRadiusM };
    for (const field of EDITABLE_CONFIG_FIELDS) config[field] = row[field];

    return {
      collegeId,
      updatedAt: row.updatedAt,
      config,
      feeBands: bands,
      limits: { ...CONFIG_LIMITS, feeBands: FEE_BAND_LIMITS },
    };
  }

  /**
   * Apply a partial update, and record exactly what changed.
   *
   * Read, compare and write happen in one transaction with the config row
   * locked, so the `before` in the audit entry is the value this change
   * actually replaced — two administrators saving at once produce two honest
   * entries rather than two entries claiming the same `before`.
   */
  async updateConfig(user: AuthenticatedUser, dto: UpdateCollegeConfigDto) {
    const collegeId = this.tenant.requireCollegeId(user);

    const requested: Partial<Record<EditableConfigField, number>> = {};
    for (const field of EDITABLE_CONFIG_FIELDS) {
      const value = (dto as Record<string, unknown>)[field];
      if (value === undefined) continue;
      const problem = configValueProblem(field, value);
      if (problem) throw new BadRequestException({ code: 'BAD_REQUEST', message: problem });
      requested[field] = value as number;
    }

    let requestedBands: FeeBandInput[] | undefined;
    if (dto.feeBands !== undefined) {
      const problem = feeBandsProblem(dto.feeBands);
      if (problem) throw new BadRequestException({ code: 'FEE_BANDS_INVALID', message: problem });
      requestedBands = normaliseFeeBands(dto.feeBands);
    }

    if (Object.keys(requested).length === 0 && requestedBands === undefined) {
      throw new BadRequestException({
        code: 'EMPTY_UPDATE',
        message: 'Send at least one setting to change.',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      // Serialise concurrent saves for this college.
      await tx.$queryRaw`SELECT college_id FROM college_config WHERE college_id = ${collegeId} FOR UPDATE`;

      const current = await this.readConfig(tx, collegeId);

      const before: Record<string, Prisma.InputJsonValue> = {};
      const after: Record<string, Prisma.InputJsonValue> = {};
      const data: Partial<Record<EditableConfigField, number>> = {};

      for (const [field, value] of Object.entries(requested) as [EditableConfigField, number][]) {
        if (current.config[field] === value) continue;
        before[field] = current.config[field];
        after[field] = value;
        data[field] = value;
      }

      const bandsChanged =
        requestedBands !== undefined &&
        JSON.stringify(requestedBands) !== JSON.stringify(current.feeBands);

      if (bandsChanged) {
        before.feeBands = current.feeBands as unknown as Prisma.InputJsonValue;
        after.feeBands = requestedBands as unknown as Prisma.InputJsonValue;
      }

      const changed = Object.keys(after);
      if (changed.length === 0) return { ...current, changed };

      if (Object.keys(data).length > 0) {
        await tx.collegeConfig.update({ where: { collegeId }, data });
      }

      if (bandsChanged) {
        // Replaced wholesale: the bands only mean something as a set, and an
        // order stores the fee it was charged, not a pointer to a band.
        await tx.feeBand.deleteMany({ where: { collegeId } });
        await tx.feeBand.createMany({
          data: requestedBands!.map((band) => ({ collegeId, ...band })),
        });
      }

      // FR-ADM-06: in the same transaction, so a change without its audit
      // entry cannot exist.
      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId,
        action: AuditAction.COLLEGE_CONFIG_CHANGED,
        targetType: 'college_config',
        targetId: collegeId,
        detail: { before, after },
      });

      return { ...(await this.readConfig(tx, collegeId)), changed };
    });
  }

  // =======================================================================
  // Delivery points — FR-ORD-02, A-10
  // =======================================================================

  /** Every point of the college, retired ones included. */
  async listDeliveryPoints(user: AuthenticatedUser) {
    const collegeId = this.tenant.requireCollegeId(user);
    return { points: await this.pointsOf(this.prisma, collegeId) };
  }

  private async pointsOf(client: Prisma.TransactionClient | PrismaService, collegeId: string) {
    const points = await client.deliveryPoint.findMany({
      where: { collegeId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    if (points.length === 0) return [];

    const usage = await client.order.groupBy({
      by: ['deliveryPointId'],
      where: { collegeId, deliveryPointId: { in: points.map((p) => p.id) } },
      _count: { _all: true },
    });
    const counts = new Map(usage.map((u) => [u.deliveryPointId, u._count._all]));

    return points.map((p) => this.shapePoint(p, counts.get(p.id) ?? 0));
  }

  private shapePoint(point: DeliveryPoint, orderCount: number) {
    return {
      id: point.id,
      name: point.name,
      description: point.description,
      latitude: point.latitude,
      longitude: point.longitude,
      isActive: point.isActive,
      sortOrder: point.sortOrder,
      orderCount,
      createdAt: point.createdAt,
      updatedAt: point.updatedAt,
    };
  }

  private async shapeWithCount(point: DeliveryPoint) {
    const orderCount = await this.prisma.order.count({
      where: { collegeId: point.collegeId, deliveryPointId: point.id },
    });
    return this.shapePoint(point, orderCount);
  }

  /** Fetch one point and prove it is the caller's college's (FR-TEN-03). */
  private async ownPoint(user: AuthenticatedUser, pointId: string): Promise<DeliveryPoint> {
    this.tenant.requireCollegeId(user);
    const point = await this.prisma.deliveryPoint.findUnique({ where: { id: pointId } });
    return this.tenant.assertSameTenant(user, point, 'Delivery point');
  }

  private async assertNameFree(collegeId: string, name: string, exceptId?: string) {
    const clash = await this.prisma.deliveryPoint.findFirst({
      where: {
        collegeId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        code: 'DELIVERY_POINT_NAME_TAKEN',
        message: 'Another delivery point at this college already has that name.',
      });
    }
  }

  /** A drop point must be on or near the campus it belongs to. */
  private async assertNearCollege(collegeId: string, latitude: number, longitude: number) {
    const college = await this.prisma.college.findUnique({
      where: { id: collegeId },
      select: { latitude: true, longitude: true },
    });
    if (!college) throw new NotFoundException('College not found');

    const distanceM = await this.prisma.geodesicDistanceM(college, { latitude, longitude });
    if (distanceM > DELIVERY_POINT_MAX_DISTANCE_M) {
      throw new BadRequestException({
        code: 'DELIVERY_POINT_TOO_FAR',
        message: `That point is ${distanceM} m from the college. Delivery points must be within ${DELIVERY_POINT_MAX_DISTANCE_M} m.`,
        details: { distanceM, limitM: DELIVERY_POINT_MAX_DISTANCE_M },
      });
    }
  }

  async createDeliveryPoint(user: AuthenticatedUser, dto: CreateDeliveryPointDto) {
    const collegeId = this.tenant.requireCollegeId(user);
    const name = dto.name.trim();

    await this.assertNameFree(collegeId, name);
    await this.assertNearCollege(collegeId, dto.latitude, dto.longitude);

    const point = await this.prisma.$transaction(async (tx) => {
      const last = await tx.deliveryPoint.aggregate({
        where: { collegeId },
        _max: { sortOrder: true },
      });

      const created = await tx.deliveryPoint.create({
        data: {
          collegeId,
          name,
          description: dto.description?.trim() || null,
          latitude: dto.latitude,
          longitude: dto.longitude,
          sortOrder: (last._max.sortOrder ?? 0) + 1,
        },
      });

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId,
        action: AuditAction.DELIVERY_POINT_CREATED,
        targetType: 'delivery_point',
        targetId: created.id,
        detail: { name: created.name, latitude: created.latitude, longitude: created.longitude },
      });

      return created;
    });

    return this.shapePoint(point, 0);
  }

  async updateDeliveryPoint(user: AuthenticatedUser, pointId: string, dto: UpdateDeliveryPointDto) {
    const point = await this.ownPoint(user, pointId);

    const data: Prisma.DeliveryPointUpdateInput = {};
    const before: Record<string, Prisma.InputJsonValue | null> = {};
    const after: Record<string, Prisma.InputJsonValue | null> = {};
    const set = <K extends 'name' | 'description' | 'latitude' | 'longitude'>(
      key: K,
      value: DeliveryPoint[K],
    ) => {
      if (point[key] === value) return;
      before[key] = point[key];
      after[key] = value;
      (data as Record<string, unknown>)[key] = value;
    };

    if (dto.name !== undefined) set('name', dto.name.trim());
    if (dto.description !== undefined) set('description', dto.description?.trim() || null);
    if (dto.latitude !== undefined) set('latitude', dto.latitude);
    if (dto.longitude !== undefined) set('longitude', dto.longitude);

    if (
      dto.name === undefined &&
      dto.description === undefined &&
      dto.latitude === undefined &&
      dto.longitude === undefined
    ) {
      throw new BadRequestException({
        code: 'EMPTY_UPDATE',
        message: 'Send at least one field to change.',
      });
    }

    if (Object.keys(after).length === 0) return this.shapeWithCount(point);

    if ('name' in after) await this.assertNameFree(point.collegeId, after.name as string, point.id);
    if ('latitude' in after || 'longitude' in after) {
      await this.assertNearCollege(
        point.collegeId,
        dto.latitude ?? point.latitude,
        dto.longitude ?? point.longitude,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.deliveryPoint.update({ where: { id: point.id }, data });
      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: point.collegeId,
        action: AuditAction.DELIVERY_POINT_UPDATED,
        targetType: 'delivery_point',
        targetId: point.id,
        detail: { before, after } as Prisma.InputJsonValue,
      });
      return row;
    });

    return this.shapeWithCount(updated);
  }

  /**
   * Retire or restore a point. There is no delete: an order keeps the id of
   * the point it was delivered to, and removing the row would leave that
   * history pointing at nothing. A retired point disappears from the
   * student's picker at once (the browse query filters on `isActive`).
   */
  async setDeliveryPointActive(user: AuthenticatedUser, pointId: string, isActive: boolean) {
    const point = await this.ownPoint(user, pointId);

    if (point.isActive === isActive) {
      throw new ConflictException({
        code: isActive ? 'ALREADY_ACTIVE' : 'ALREADY_INACTIVE',
        message: isActive
          ? 'That delivery point is already active.'
          : 'That delivery point is already inactive.',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.deliveryPoint.update({ where: { id: point.id }, data: { isActive } });
      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: point.collegeId,
        action: isActive
          ? AuditAction.DELIVERY_POINT_ACTIVATED
          : AuditAction.DELIVERY_POINT_DEACTIVATED,
        targetType: 'delivery_point',
        targetId: point.id,
        detail: { name: point.name },
      });
      return row;
    });

    return this.shapeWithCount(updated);
  }

  /**
   * Set the display order. The list must name every point of the college
   * exactly once — a partial list would leave the rest in an order nobody
   * chose, and an id from another college must not be writable through here.
   */
  async reorderDeliveryPoints(user: AuthenticatedUser, pointIds: string[]) {
    const collegeId = this.tenant.requireCollegeId(user);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.deliveryPoint.findMany({
        where: { collegeId },
        select: { id: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });

      const own = new Set(existing.map((p) => p.id));
      const given = new Set(pointIds);
      const complete =
        given.size === pointIds.length &&
        given.size === own.size &&
        pointIds.every((id) => own.has(id));

      if (!complete) {
        throw new BadRequestException({
          code: 'REORDER_MISMATCH',
          message:
            'The list must contain every delivery point of this college exactly once. ' +
            'Reload the list and try again.',
          details: { expected: own.size, received: pointIds.length },
        });
      }

      for (const [index, id] of pointIds.entries()) {
        // `collegeId` in the WHERE as well: belt and braces for C-1.
        await tx.deliveryPoint.updateMany({
          where: { id, collegeId },
          data: { sortOrder: index + 1 },
        });
      }

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId,
        action: AuditAction.DELIVERY_POINTS_REORDERED,
        targetType: 'college',
        targetId: collegeId,
        detail: { before: existing.map((p) => p.id), after: pointIds },
      });

      return { points: await this.pointsOf(tx, collegeId) };
    });
  }
}
