import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { formatMinuteOfDay } from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import type {
  BulkAvailabilityDto,
  CreateCategoryDto,
  CreateItemDto,
  SetHoursDto,
  TemporaryClosureDto,
  UpdateCategoryDto,
  UpdateItemDto,
} from './dto/catalog.dto';

/**
 * Catalog management, for the shop dashboard (D-11, D-12, D-13).
 *
 * Everything here hangs off a *listing* rather than a shop, because
 * FR-SHOP-13 requires a separate catalog per college. A shop serving two
 * colleges keeps two menus, and that falls out of the model (ADR-008) rather
 * than needing special handling.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tenant: TenantService,
  ) {}

  /**
   * Confirm the caller may manage this listing, and that it is in a state
   * where management makes sense.
   *
   * Two separate checks: the listing is in the caller's college (tenancy),
   * and the caller is staff of that shop (ownership). A shop owner at the
   * same college is still not allowed to edit a different shop's menu, which
   * tenancy alone would not catch.
   */
  private async assertCanManage(
    user: AuthenticatedUser,
    listingId: string,
    opts: { requireActive?: boolean } = {},
  ) {
    const listing = await this.prisma.shopListing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        collegeId: true,
        shopId: true,
        status: true,
        shop: { select: { staff: { select: { userId: true } } } },
      },
    });

    this.tenant.assertSameTenant(user, listing, 'Shop listing');

    const isStaff = listing!.shop.staff.some((s) => s.userId === user.userId);
    const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';

    if (!isStaff && !isAdmin) {
      throw new ForbiddenException({
        code: 'NOT_SHOP_STAFF',
        message: 'You do not manage this shop.',
      });
    }

    // FR-CAT-01 / FR-CAT-02 say "an active shop shall be able to...". A
    // pending shop may still prepare its menu — being able to set up before
    // approval is useful and harmless, since nothing is visible to students
    // until the listing is ACTIVE. A rejected or suspended one may not.
    if (listing!.status === 'REJECTED' || listing!.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: 'LISTING_NOT_EDITABLE',
        message: `This shop is ${listing!.status.toLowerCase()} and its catalog cannot be changed.`,
      });
    }

    if (opts.requireActive && listing!.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'LISTING_NOT_ACTIVE',
        message: 'This shop is not yet approved.',
      });
    }

    return listing!;
  }

  // =======================================================================
  // Categories — FR-CAT-01
  // =======================================================================

  async listCatalog(user: AuthenticatedUser, listingId: string) {
    await this.assertCanManage(user, listingId);

    const [categories, uncategorised, hours, listing] = await Promise.all([
      this.prisma.catalogCategory.findMany({
        where: { shopListingId: listingId },
        select: {
          id: true,
          name: true,
          sortOrder: true,
          items: {
            where: { isDeleted: false },
            select: {
              id: true,
              name: true,
              description: true,
              priceMinor: true,
              prepMinutes: true,
              imageUrl: true,
              isAvailable: true,
              sortOrder: true,
            },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.catalogItem.findMany({
        where: { shopListingId: listingId, categoryId: null, isDeleted: false },
        select: {
          id: true,
          name: true,
          description: true,
          priceMinor: true,
          prepMinutes: true,
          imageUrl: true,
          isAvailable: true,
          sortOrder: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.shopHours.findMany({
        where: { shopListingId: listingId },
        select: { id: true, dayOfWeek: true, openMinute: true, closeMinute: true },
        orderBy: [{ dayOfWeek: 'asc' }, { openMinute: 'asc' }],
      }),
      this.prisma.shopListing.findUnique({
        where: { id: listingId },
        select: { status: true, temporarilyClosedUntil: true, closureNote: true },
      }),
    ]);

    return {
      listingId,
      status: listing?.status,
      temporarilyClosedUntil: listing?.temporarilyClosedUntil ?? null,
      closureNote: listing?.closureNote ?? null,
      categories,
      uncategorised,
      hours: hours.map((h) => ({
        ...h,
        openLabel: formatMinuteOfDay(h.openMinute),
        closeLabel: formatMinuteOfDay(h.closeMinute),
        crossesMidnight: h.closeMinute <= h.openMinute,
      })),
    };
  }

  async createCategory(user: AuthenticatedUser, listingId: string, dto: CreateCategoryDto) {
    await this.assertCanManage(user, listingId);

    return this.prisma.catalogCategory.create({
      data: {
        shopListingId: listingId,
        name: dto.name.trim(),
        sortOrder: dto.sortOrder ?? 0,
      },
      select: { id: true, name: true, sortOrder: true },
    });
  }

  async updateCategory(
    user: AuthenticatedUser,
    listingId: string,
    categoryId: string,
    dto: UpdateCategoryDto,
  ) {
    await this.assertCanManage(user, listingId);

    const existing = await this.prisma.catalogCategory.findFirst({
      where: { id: categoryId, shopListingId: listingId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Category not found');

    return this.prisma.catalogCategory.update({
      where: { id: categoryId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
      select: { id: true, name: true, sortOrder: true },
    });
  }

  /**
   * Deleting a category does not delete its items — they become
   * uncategorised. Cascading would silently remove a menu, and an accidental
   * category deletion should not cost a shop its whole catalog.
   */
  async deleteCategory(user: AuthenticatedUser, listingId: string, categoryId: string) {
    await this.assertCanManage(user, listingId);

    const existing = await this.prisma.catalogCategory.findFirst({
      where: { id: categoryId, shopListingId: listingId },
      select: { id: true, _count: { select: { items: true } } },
    });
    if (!existing) throw new NotFoundException('Category not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.catalogItem.updateMany({
        where: { categoryId },
        data: { categoryId: null },
      });
      await tx.catalogCategory.delete({ where: { id: categoryId } });
    });

    return {
      deleted: true,
      itemsUncategorised: existing._count.items,
      message:
        existing._count.items > 0
          ? `Category removed. ${existing._count.items} item${
              existing._count.items === 1 ? '' : 's'
            } kept and moved to uncategorised.`
          : 'Category removed.',
    };
  }

  // =======================================================================
  // Items — FR-CAT-02, FR-CAT-03
  // =======================================================================

  async createItem(user: AuthenticatedUser, listingId: string, dto: CreateItemDto) {
    await this.assertCanManage(user, listingId);

    if (dto.categoryId) {
      const category = await this.prisma.catalogCategory.findFirst({
        where: { id: dto.categoryId, shopListingId: listingId },
        select: { id: true },
      });
      if (!category) {
        throw new BadRequestException({
          code: 'CATEGORY_NOT_FOUND',
          message: 'That category does not belong to this shop.',
        });
      }
    }

    return this.prisma.catalogItem.create({
      data: {
        shopListingId: listingId,
        categoryId: dto.categoryId ?? null,
        name: dto.name.trim(),
        description: dto.description?.trim() ?? null,
        priceMinor: dto.priceMinor,
        prepMinutes: dto.prepMinutes,
        imageUrl: dto.imageKey ? this.storage.publicUrl(dto.imageKey) : null,
        isAvailable: dto.isAvailable ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
      select: {
        id: true,
        name: true,
        description: true,
        priceMinor: true,
        prepMinutes: true,
        imageUrl: true,
        isAvailable: true,
        categoryId: true,
        sortOrder: true,
      },
    });
  }

  async updateItem(
    user: AuthenticatedUser,
    listingId: string,
    itemId: string,
    dto: UpdateItemDto,
  ) {
    await this.assertCanManage(user, listingId);

    const existing = await this.prisma.catalogItem.findFirst({
      where: { id: itemId, shopListingId: listingId, isDeleted: false },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Item not found');

    if (dto.categoryId) {
      const category = await this.prisma.catalogCategory.findFirst({
        where: { id: dto.categoryId, shopListingId: listingId },
        select: { id: true },
      });
      if (!category) {
        throw new BadRequestException({
          code: 'CATEGORY_NOT_FOUND',
          message: 'That category does not belong to this shop.',
        });
      }
    }

    return this.prisma.catalogItem.update({
      where: { id: itemId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() ?? null } : {}),
        ...(dto.priceMinor !== undefined ? { priceMinor: dto.priceMinor } : {}),
        ...(dto.prepMinutes !== undefined ? { prepMinutes: dto.prepMinutes } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.imageKey !== undefined
          ? { imageUrl: dto.imageKey ? this.storage.publicUrl(dto.imageKey) : null }
          : {}),
        ...(dto.isAvailable !== undefined ? { isAvailable: dto.isAvailable } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
      select: {
        id: true,
        name: true,
        description: true,
        priceMinor: true,
        prepMinutes: true,
        imageUrl: true,
        isAvailable: true,
        categoryId: true,
        sortOrder: true,
      },
    });
  }

  /** FR-CAT-03 */
  async setAvailability(user: AuthenticatedUser, listingId: string, dto: BulkAvailabilityDto) {
    await this.assertCanManage(user, listingId);

    const result = await this.prisma.catalogItem.updateMany({
      // Scoped to this listing, so a crafted request cannot flip another
      // shop's items by passing their ids.
      where: { id: { in: dto.itemIds }, shopListingId: listingId, isDeleted: false },
      data: { isAvailable: dto.isAvailable },
    });

    return {
      updated: result.count,
      isAvailable: dto.isAvailable,
      message: `${result.count} item${result.count === 1 ? '' : 's'} marked ${
        dto.isAvailable ? 'available' : 'unavailable'
      }.`,
    };
  }

  /**
   * FR-CAT-01 allows deleting an item, but a hard delete would break the
   * order history that points at it — a receipt from last month must still
   * resolve. So deletion is a flag, and order items additionally snapshot the
   * name and price at the time of ordering.
   */
  async deleteItem(user: AuthenticatedUser, listingId: string, itemId: string) {
    await this.assertCanManage(user, listingId);

    const existing = await this.prisma.catalogItem.findFirst({
      where: { id: itemId, shopListingId: listingId, isDeleted: false },
      select: { id: true, name: true },
    });
    if (!existing) throw new NotFoundException('Item not found');

    await this.prisma.catalogItem.update({
      where: { id: itemId },
      data: { isDeleted: true, isAvailable: false },
    });

    return {
      deleted: true,
      message: `"${existing.name}" removed from the menu. Past orders still show it.`,
    };
  }

  // =======================================================================
  // Hours and closure — FR-CAT-04, FR-CAT-05
  // =======================================================================

  /**
   * Replace the whole week at once, which is how the dashboard edits it
   * (D-13) and avoids a half-saved schedule.
   */
  async setHours(user: AuthenticatedUser, listingId: string, dto: SetHoursDto) {
    await this.assertCanManage(user, listingId);

    // A window of zero length is almost certainly a mistake, and would make
    // the shop permanently closed on that day with no visible reason.
    for (const row of dto.hours) {
      if (row.openMinute === row.closeMinute) {
        throw new BadRequestException({
          code: 'EMPTY_HOURS_WINDOW',
          message:
            `Day ${row.dayOfWeek} opens and closes at the same time ` +
            `(${formatMinuteOfDay(row.openMinute)}). Remove the row instead.`,
        });
      }
    }

    // Overlapping windows on one day are contradictory rather than harmful,
    // but they make "when does it reopen" meaningless, so they are refused.
    const byDay = new Map<number, { openMinute: number; closeMinute: number }[]>();
    for (const row of dto.hours) {
      const list = byDay.get(row.dayOfWeek) ?? [];
      list.push(row);
      byDay.set(row.dayOfWeek, list);
    }

    for (const [day, windows] of byDay) {
      const sameDay = windows
        .filter((w) => w.closeMinute > w.openMinute)
        .sort((a, b) => a.openMinute - b.openMinute);

      for (let i = 1; i < sameDay.length; i += 1) {
        if (sameDay[i].openMinute < sameDay[i - 1].closeMinute) {
          throw new BadRequestException({
            code: 'OVERLAPPING_HOURS',
            message: `Two opening windows overlap on day ${day}.`,
          });
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.shopHours.deleteMany({ where: { shopListingId: listingId } });
      if (dto.hours.length > 0) {
        await tx.shopHours.createMany({
          data: dto.hours.map((h) => ({
            shopListingId: listingId,
            dayOfWeek: h.dayOfWeek,
            openMinute: h.openMinute,
            closeMinute: h.closeMinute,
          })),
        });
      }
    });

    const saved = await this.prisma.shopHours.findMany({
      where: { shopListingId: listingId },
      select: { id: true, dayOfWeek: true, openMinute: true, closeMinute: true },
      orderBy: [{ dayOfWeek: 'asc' }, { openMinute: 'asc' }],
    });

    return {
      hours: saved.map((h) => ({
        ...h,
        openLabel: formatMinuteOfDay(h.openMinute),
        closeLabel: formatMinuteOfDay(h.closeMinute),
        crossesMidnight: h.closeMinute <= h.openMinute,
      })),
      message:
        saved.length === 0
          ? 'Hours cleared. The shop will show as closed until hours are set.'
          : 'Opening hours saved.',
    };
  }

  /** FR-CAT-04: close now, reopen at a stated time. */
  async setTemporaryClosure(
    user: AuthenticatedUser,
    listingId: string,
    dto: TemporaryClosureDto,
  ) {
    await this.assertCanManage(user, listingId);

    const reopenAt = new Date(dto.reopenAt);

    if (reopenAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'REOPEN_IN_PAST',
        message: 'The reopening time must be in the future.',
      });
    }

    // A fortnight is the point at which this stops being "temporary" and the
    // shop should be asking an administrator to suspend the listing instead.
    const maxMs = 14 * 86_400_000;
    if (reopenAt.getTime() - Date.now() > maxMs) {
      throw new BadRequestException({
        code: 'CLOSURE_TOO_LONG',
        message:
          'A temporary closure can run for at most 14 days. For longer, contact your ' +
          'campus administrator.',
      });
    }

    await this.prisma.shopListing.update({
      where: { id: listingId },
      data: { temporarilyClosedUntil: reopenAt, closureNote: dto.note ?? null },
    });

    return {
      temporarilyClosedUntil: reopenAt,
      note: dto.note ?? null,
      message: `Shown as closed to students until ${reopenAt.toLocaleString('en-IN')}.`,
    };
  }

  async clearTemporaryClosure(user: AuthenticatedUser, listingId: string) {
    await this.assertCanManage(user, listingId);

    await this.prisma.shopListing.update({
      where: { id: listingId },
      data: { temporarilyClosedUntil: null, closureNote: null },
    });

    return { message: 'Reopened. The shop now follows its normal opening hours.' };
  }
}
