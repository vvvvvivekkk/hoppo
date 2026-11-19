import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LocationType, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import {
  DEFAULT_TIMEZONE,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
  formatDistance,
  isRadiusInPermittedRange,
  resolveOpenState,
} from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { GeocodingService } from '../geocoding/geocoding.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { TenantService } from '../common/tenant/tenant.service';
import { clampPageLimit } from '../common/pagination';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import type {
  DistanceCheckDto,
  RegisterShopDto,
  RejectShopDto,
  SuspendShopDto,
  UpdateRadiusDto,
} from './dto/shops.dto';

@Injectable()
export class ShopsService {
  private readonly logger = new Logger(ShopsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly geocoding: GeocodingService,
    private readonly audit: AuditService,
    private readonly tenant: TenantService,
  ) {}

  /**
   * A college's IANA timezone, which is what shop opening hours are expressed
   * in (R-18). Falls back to the Indian default rather than to the server's
   * zone, because falling back to the server's zone is the bug this exists to
   * prevent.
   */
  private async collegeTimeZone(collegeId: string): Promise<string> {
    const college = await this.prisma.college.findUnique({
      where: { id: collegeId },
      select: { timezone: true },
    });
    return college?.timezone ?? DEFAULT_TIMEZONE;
  }

  // =======================================================================
  // Distance check (D-03, D-04) — FR-SHOP-05, FR-SHOP-06
  // =======================================================================

  /**
   * Measure the distance to the college and say whether it is within range.
   *
   * Called before registration so the owner sees the answer before uploading
   * documents. FR-SHOP-06 requires the measured distance *and* the permitted
   * limit to be shown on rejection, so both are always returned — a bare "too
   * far" tells the owner nothing they can act on.
   */
  async checkDistance(dto: DistanceCheckDto) {
    const college = await this.prisma.college.findUnique({
      where: { id: dto.collegeId },
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        status: true,
        config: { select: { serviceableRadiusM: true } },
      },
    });

    if (!college || college.status !== 'ACTIVE') {
      throw new NotFoundException({
        code: 'COLLEGE_NOT_FOUND',
        message: 'That college is not available.',
      });
    }

    let latitude = dto.latitude;
    let longitude = dto.longitude;
    let formattedAddress: string | undefined;
    let needsPinConfirmation = false;

    if (latitude === undefined || longitude === undefined) {
      if (!dto.address) {
        throw new BadRequestException({
          code: 'LOCATION_REQUIRED',
          message: 'Provide either an address or the coordinates from the map pin.',
        });
      }

      const geocoded = await this.geocoding.geocode(dto.address);
      latitude = geocoded.latitude;
      longitude = geocoded.longitude;
      formattedAddress = geocoded.formattedAddress;
      needsPinConfirmation = this.geocoding.needsPinConfirmation(geocoded.precision);
    }

    // C-2: the geodesic calculation happens in the database, in one place.
    const distanceM = await this.prisma.geodesicDistanceM(
      { latitude: college.latitude, longitude: college.longitude },
      { latitude, longitude },
    );

    const radiusM = college.config?.serviceableRadiusM ?? 3000;
    const withinRadius = distanceM <= radiusM;

    return {
      college: { id: college.id, name: college.name },
      latitude,
      longitude,
      formattedAddress,
      distanceM,
      distanceLabel: formatDistance(distanceM),
      radiusM,
      radiusLabel: formatDistance(radiusM),
      withinRadius,
      // FR-SHOP-04: a coarse geocode must be confirmed before it is trusted.
      needsPinConfirmation,
      message: withinRadius
        ? `${formatDistance(distanceM)} from ${college.name} — within the ${formatDistance(
            radiusM,
          )} serviceable radius.`
        : `${formatDistance(distanceM)} from ${college.name}, which is beyond the ${formatDistance(
            radiusM,
          )} serviceable radius. This shop cannot be registered for this college.`,
    };
  }

  // =======================================================================
  // Registration — FR-SHOP-01 .. FR-SHOP-09
  // =======================================================================

  async register(dto: RegisterShopDto) {
    const college = await this.prisma.college.findUnique({
      where: { id: dto.collegeId },
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        status: true,
        config: { select: { serviceableRadiusM: true } },
      },
    });

    if (!college || college.status !== 'ACTIVE') {
      throw new NotFoundException({
        code: 'COLLEGE_NOT_FOUND',
        message: 'That college is not available for shop registration.',
      });
    }

    const radiusM = college.config?.serviceableRadiusM ?? 3000;

    // FR-SHOP-05: compute the geodesic distance.
    const distanceM = await this.prisma.geodesicDistanceM(
      { latitude: college.latitude, longitude: college.longitude },
      { latitude: dto.latitude, longitude: dto.longitude },
    );

    // FR-SHOP-06: reject, showing the measured distance and the limit.
    if (distanceM > radiusM) {
      throw new BadRequestException({
        code: 'OUTSIDE_SERVICEABLE_RADIUS',
        message: `This shop is ${formatDistance(distanceM)} from ${
          college.name
        }, beyond the ${formatDistance(radiusM)} serviceable radius.`,
        details: { distanceM, radiusM, collegeName: college.name },
      });
    }

    const docTypes = new Set(dto.documents.map((d) => d.docType));

    // FR-SHOP-07: an on-campus shop needs a permit from the college authority.
    if (dto.locationType === LocationType.ON_CAMPUS && !docTypes.has('CAMPUS_PERMIT')) {
      throw new BadRequestException({
        code: 'CAMPUS_PERMIT_REQUIRED',
        message:
          'A shop inside the campus needs a letter or permit from the college authority. ' +
          'Upload it as the campus permit document.',
      });
    }

    // FR-SHOP-08: a frontage photograph showing the signboard is required, as
    // it is the one document that ties the licence to a real, visible shop.
    if (!docTypes.has('FRONTAGE_PHOTO')) {
      throw new BadRequestException({
        code: 'FRONTAGE_PHOTO_REQUIRED',
        message: 'Upload at least one photograph of the shop frontage showing the signboard.',
      });
    }

    if (!docTypes.has('ESTABLISHMENT_LICENCE')) {
      throw new BadRequestException({
        code: 'LICENCE_REQUIRED',
        message: 'Upload the shop establishment licence or registration certificate.',
      });
    }

    // A platform carrying prepared food is an e-commerce food business
    // operator under FSSAI rules, and each shop needs its own licence on file.
    // Enforced at registration rather than discovered at an inspection.
    const sellsFood = dto.category.toUpperCase() === 'FOOD';
    if (sellsFood && !dto.fssaiLicenceNumber) {
      throw new BadRequestException({
        code: 'FSSAI_REQUIRED',
        message:
          'A shop selling prepared food must provide its FSSAI licence number. ' +
          'Delivering food without one exposes both the shop and the platform.',
      });
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    const result = await this.prisma.$transaction(async (tx) => {
      // The owner's account. A shop owner belongs to the college their shop
      // serves, which satisfies the tenancy check constraint.
      const owner = await tx.user.create({
        data: {
          collegeId: college.id,
          role: 'SHOP_OWNER',
          name: dto.ownerName,
          mobile: dto.ownerMobile,
          email: dto.ownerEmail,
          passwordHash,
        },
      });

      const shop = await tx.shop.create({
        data: {
          name: dto.name,
          category: dto.category.toUpperCase(),
          ownerName: dto.ownerName,
          ownerMobile: dto.ownerMobile,
          ownerEmail: dto.ownerEmail,
          address: dto.address,
          city: dto.city,
          state: dto.state,
          pincode: dto.pincode ?? null,
          latitude: dto.latitude,
          longitude: dto.longitude,
          pinAdjusted: dto.pinAdjusted ?? false,
          locationType: dto.locationType,
          fssaiLicenceNumber: dto.fssaiLicenceNumber ?? null,
          gstin: dto.gstin ?? null,
        },
      });

      await tx.shopStaff.create({
        data: { shopId: shop.id, userId: owner.id, isOwner: true },
      });

      // FR-SHOP-09: not visible to students until approved.
      const listing = await tx.shopListing.create({
        data: {
          shopId: shop.id,
          collegeId: college.id,
          distanceFromCollegeM: distanceM,
          status: 'PENDING_VERIFICATION',
        },
      });

      await tx.shopDocument.createMany({
        data: dto.documents.map((d) => ({
          shopId: shop.id,
          docType: d.docType,
          fileUrl: d.fileKey,
          fileName: d.fileName ?? null,
          mimeType: d.mimeType ?? null,
          sizeBytes: d.sizeBytes ?? null,
        })),
      });

      return { owner, shop, listing };
    });

    this.logger.log(
      `Shop ${result.shop.id} registered for college ${college.id} at ${distanceM} m`,
    );

    return {
      shopId: result.shop.id,
      listingId: result.listing.id,
      ownerId: result.owner.id,
      status: result.listing.status,
      distanceM,
      distanceLabel: formatDistance(distanceM),
      message:
        'Submitted for verification. Your shop will appear to students once a campus ' +
        'administrator approves it.',
    };
  }

  /** D-07: the owner's own view while waiting, and after. */
  async myShops(user: AuthenticatedUser) {
    const staffRows = await this.prisma.shopStaff.findMany({
      where: { userId: user.userId },
      select: { shopId: true, isOwner: true },
    });

    if (staffRows.length === 0) return { shops: [] };

    const shops = await this.prisma.shop.findMany({
      where: { id: { in: staffRows.map((s) => s.shopId) } },
      select: {
        id: true,
        name: true,
        category: true,
        address: true,
        city: true,
        latitude: true,
        longitude: true,
        locationType: true,
        fssaiLicenceNumber: true,
        gstin: true,
        listings: {
          select: {
            id: true,
            collegeId: true,
            status: true,
            distanceFromCollegeM: true,
            submittedAt: true,
            approvedAt: true,
            rejectionReason: true,
            rejectionNote: true,
            flaggedForRadiusReviewAt: true,
            temporarilyClosedUntil: true,
            closureNote: true,
            ratingSum: true,
            ratingCount: true,
            college: { select: { id: true, name: true, shortName: true } },
            _count: { select: { items: true, orders: true } },
          },
        },
        documents: {
          // The owner may see that a document is on file, and its type, but
          // not retrieve it — the file key is a pointer into the private
          // bucket and only administrator endpoints resolve it.
          select: { id: true, docType: true, fileName: true, uploadedAt: true },
        },
      },
    });

    return {
      shops: shops.map((shop) => ({
        ...shop,
        listings: shop.listings.map((l) => ({
          ...l,
          distanceLabel: formatDistance(l.distanceFromCollegeM),
          averageRating: l.ratingCount > 0 ? l.ratingSum / l.ratingCount : null,
        })),
      })),
    };
  }

  // =======================================================================
  // Administrator verification — FR-SHOP-10 .. FR-SHOP-12
  // =======================================================================

  /** FR-SHOP-10, FR-ADM-01, FR-ADM-02 */
  async queue(user: AuthenticatedUser, requestedLimit = 25, cursor?: string) {
    // Clamped here as well as in the controller: `take: limit + 1` must never
    // see NaN or an unbounded number, whoever the caller is.
    const limit = clampPageLimit(requestedLimit);

    const where: Prisma.ShopListingWhereInput = {
      ...this.tenant.scope(user),
      status: 'PENDING_VERIFICATION',
    };

    const rows = await this.prisma.shopListing.findMany({
      where,
      select: {
        id: true,
        status: true,
        distanceFromCollegeM: true,
        submittedAt: true,
        college: {
          select: { id: true, name: true, latitude: true, longitude: true, config: { select: { serviceableRadiusM: true } } },
        },
        shop: {
          select: {
            id: true,
            name: true,
            category: true,
            ownerName: true,
            ownerMobile: true,
            ownerEmail: true,
            address: true,
            city: true,
            latitude: true,
            longitude: true,
            pinAdjusted: true,
            locationType: true,
            fssaiLicenceNumber: true,
            gstin: true,
            documents: {
              select: {
                id: true,
                docType: true,
                fileName: true,
                mimeType: true,
                sizeBytes: true,
                uploadedAt: true,
              },
            },
          },
        },
      },
      orderBy: { submittedAt: 'asc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      // FR-ADM-02: everything needed for a decision without navigating away —
      // the distance computation, the map pin, and the document list (A-05).
      items: page.map((row) => ({
        listingId: row.id,
        submittedAt: row.submittedAt,
        shop: row.shop,
        distanceM: row.distanceFromCollegeM,
        distanceLabel: formatDistance(row.distanceFromCollegeM),
        radiusM: row.college.config?.serviceableRadiusM ?? 3000,
        withinRadius:
          row.distanceFromCollegeM <= (row.college.config?.serviceableRadiusM ?? 3000),
        collegePin: { latitude: row.college.latitude, longitude: row.college.longitude },
        shopPin: { latitude: row.shop.latitude, longitude: row.shop.longitude },
        // A pin the owner never adjusted came straight from a geocoder, which
        // is worth knowing when the distance is close to the limit.
        pinWasAdjusted: row.shop.pinAdjusted,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      total: await this.prisma.shopListing.count({ where }),
    };
  }

  /** NFR-S-03: a signed, short-lived URL, and the access is logged. */
  async viewDocument(user: AuthenticatedUser, listingId: string, documentId: string) {
    const listing = await this.prisma.shopListing.findUnique({
      where: { id: listingId },
      select: { id: true, collegeId: true, shopId: true },
    });

    this.tenant.assertSameTenant(user, listing, 'Shop listing');

    const document = await this.prisma.shopDocument.findFirst({
      where: { id: documentId, shopId: listing!.shopId },
      select: { id: true, docType: true, fileUrl: true, fileName: true },
    });

    if (!document) throw new NotFoundException('Document not found');

    await this.audit.record({
      actorId: user.userId,
      collegeId: listing!.collegeId,
      action: AuditAction.IDENTITY_DOCUMENT_VIEWED,
      targetType: 'shop_document',
      targetId: documentId,
      detail: { shopId: listing!.shopId, docType: document.docType },
    });

    const url = this.storage.isConfigured
      ? await this.storage.createPrivateReadUrl(document.fileUrl)
      : null;

    return {
      documentId: document.id,
      docType: document.docType,
      fileName: document.fileName,
      url,
      expiresInSeconds: 300,
      ...(url ? {} : { note: 'Object storage is not configured in this environment.' }),
    };
  }

  /** FR-SHOP-11 (approve) */
  async approve(user: AuthenticatedUser, listingId: string) {
    const listing = await this.prisma.shopListing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        collegeId: true,
        shopId: true,
        status: true,
        distanceFromCollegeM: true,
        college: { select: { config: { select: { serviceableRadiusM: true } } } },
      },
    });

    this.tenant.assertSameTenant(user, listing, 'Shop listing');

    if (listing!.status !== 'PENDING_VERIFICATION') {
      throw new ConflictException({
        code: 'ALREADY_DECIDED',
        message: `That shop is already ${listing!.status.toLowerCase().replace(/_/g, ' ')}.`,
      });
    }

    // Re-check the radius at the moment of approval. The radius may have been
    // reduced since the shop applied (FR-TEN-04), and approving something now
    // out of range would create exactly the inconsistency FR-TEN-05 is about.
    const radiusM = listing!.college.config?.serviceableRadiusM ?? 3000;
    if (listing!.distanceFromCollegeM > radiusM) {
      throw new BadRequestException({
        code: 'OUTSIDE_CURRENT_RADIUS',
        message:
          `This shop is ${formatDistance(listing!.distanceFromCollegeM)} away, but the ` +
          `serviceable radius is now ${formatDistance(radiusM)}. Reject it, or widen the radius first.`,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.shopListing.update({
        where: { id: listingId },
        data: {
          status: 'ACTIVE',
          approvedByUserId: user.userId,
          approvedAt: new Date(),
          flaggedForRadiusReviewAt: null,
        },
      });

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: listing!.collegeId,
        action: AuditAction.SHOP_APPROVED,
        targetType: 'shop_listing',
        targetId: listingId,
        detail: { shopId: listing!.shopId, distanceM: listing!.distanceFromCollegeM },
      });
    });

    return {
      listingId,
      status: 'ACTIVE',
      message: 'Shop approved. It is now visible to students and can receive orders.',
    };
  }

  /** FR-SHOP-11 (reject) */
  async reject(user: AuthenticatedUser, listingId: string, dto: RejectShopDto) {
    const listing = await this.prisma.shopListing.findUnique({
      where: { id: listingId },
      select: { id: true, collegeId: true, shopId: true, status: true },
    });

    this.tenant.assertSameTenant(user, listing, 'Shop listing');

    if (listing!.status !== 'PENDING_VERIFICATION') {
      throw new ConflictException({
        code: 'ALREADY_DECIDED',
        message: 'That shop has already been decided.',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.shopListing.update({
        where: { id: listingId },
        data: {
          status: 'REJECTED',
          rejectionReason: dto.reason,
          rejectionNote: dto.note ?? null,
        },
      });

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: listing!.collegeId,
        action: AuditAction.SHOP_REJECTED,
        targetType: 'shop_listing',
        targetId: listingId,
        detail: { shopId: listing!.shopId, reason: dto.reason, note: dto.note ?? null },
      });
    });

    return { listingId, status: 'REJECTED', reason: dto.reason };
  }

  /**
   * FR-SHOP-12: "immediately hide it from students and block new orders while
   * permitting in-flight orders to complete."
   *
   * That last clause is the important one. Suspension hides the listing and
   * stops new orders; it deliberately does not touch orders already placed,
   * because a student who has paid and is waiting should still get their food.
   */
  async suspend(user: AuthenticatedUser, listingId: string, dto: SuspendShopDto) {
    const listing = await this.prisma.shopListing.findUnique({
      where: { id: listingId },
      select: { id: true, collegeId: true, shopId: true, status: true },
    });

    this.tenant.assertSameTenant(user, listing, 'Shop listing');

    if (listing!.status !== 'ACTIVE') {
      throw new ConflictException({
        code: 'NOT_ACTIVE',
        message: 'Only an active shop can be suspended.',
      });
    }

    const inFlight = await this.prisma.order.count({
      where: {
        shopListingId: listingId,
        status: { in: ['PLACED', 'SHOP_ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP'] },
      },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.shopListing.update({
        where: { id: listingId },
        data: { status: 'SUSPENDED', closureNote: dto.reason },
      });

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: listing!.collegeId,
        action: AuditAction.SHOP_SUSPENDED,
        targetType: 'shop_listing',
        targetId: listingId,
        detail: { shopId: listing!.shopId, reason: dto.reason, inFlightOrders: inFlight },
      });
    });

    return {
      listingId,
      status: 'SUSPENDED',
      inFlightOrders: inFlight,
      message:
        inFlight > 0
          ? `Shop hidden and new orders blocked. ${inFlight} order${
              inFlight === 1 ? '' : 's'
            } already in progress will be allowed to complete.`
          : 'Shop hidden and new orders blocked.',
    };
  }

  // =======================================================================
  // Radius administration — FR-TEN-04, FR-TEN-05
  // =======================================================================

  /**
   * The college's current serviceable radius, with the permitted range.
   *
   * Scoped by the college on the token (C-1): there is no id in the request
   * to tamper with. A super administrator belongs to no college, so
   * `requireCollegeId` refuses them — the same as the PATCH below.
   */
  async currentRadius(user: AuthenticatedUser) {
    const collegeId = this.tenant.requireCollegeId(user);

    const config = await this.prisma.collegeConfig.findUnique({
      where: { collegeId },
      select: { serviceableRadiusM: true },
    });

    // The same fallback every other reader of the radius uses.
    const serviceableRadiusM = config?.serviceableRadiusM ?? 3000;

    return {
      collegeId,
      serviceableRadiusM,
      serviceableRadiusLabel: formatDistance(serviceableRadiusM),
      minRadiusM: RADIUS_MIN_M,
      maxRadiusM: RADIUS_MAX_M,
    };
  }

  /**
   * FR-TEN-04 lets an administrator change the radius within 1 km to 5 km.
   * FR-TEN-05 is the interesting half: shops already approved under a wider
   * radius stay active, but are flagged for review rather than silently
   * dropped. A shop that has been trading for a month should not vanish
   * because somebody moved a slider.
   */
  async updateRadius(user: AuthenticatedUser, dto: UpdateRadiusDto) {
    const collegeId = this.tenant.requireCollegeId(user);

    if (!isRadiusInPermittedRange(dto.serviceableRadiusM)) {
      throw new BadRequestException({
        code: 'RADIUS_OUT_OF_RANGE',
        message: 'The serviceable radius must be between 1 km and 5 km.',
      });
    }

    const config = await this.prisma.collegeConfig.findUnique({
      where: { collegeId },
      select: { serviceableRadiusM: true },
    });

    const previousRadiusM = config?.serviceableRadiusM ?? 3000;

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.collegeConfig.update({
        where: { collegeId },
        data: { serviceableRadiusM: dto.serviceableRadiusM },
      });

      let flaggedCount = 0;

      // FR-TEN-05: only when the radius shrinks, and only for shops that are
      // now outside it.
      if (dto.serviceableRadiusM < previousRadiusM) {
        const flagged = await tx.shopListing.updateMany({
          where: {
            collegeId,
            status: 'ACTIVE',
            distanceFromCollegeM: { gt: dto.serviceableRadiusM },
          },
          data: { flaggedForRadiusReviewAt: new Date() },
        });
        flaggedCount = flagged.count;
      } else {
        // Widening clears flags that no longer apply.
        await tx.shopListing.updateMany({
          where: {
            collegeId,
            flaggedForRadiusReviewAt: { not: null },
            distanceFromCollegeM: { lte: dto.serviceableRadiusM },
          },
          data: { flaggedForRadiusReviewAt: null },
        });
      }

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId,
        action: AuditAction.RADIUS_CHANGED,
        targetType: 'college_config',
        targetId: collegeId,
        detail: {
          previousRadiusM,
          newRadiusM: dto.serviceableRadiusM,
          shopsFlaggedForReview: flaggedCount,
        },
      });

      return { flaggedCount };
    });

    return {
      collegeId,
      previousRadiusM,
      serviceableRadiusM: dto.serviceableRadiusM,
      shopsFlaggedForReview: result.flaggedCount,
      message:
        result.flaggedCount > 0
          ? `Radius set to ${formatDistance(dto.serviceableRadiusM)}. ${
              result.flaggedCount
            } already-approved shop${result.flaggedCount === 1 ? '' : 's'} ${
              result.flaggedCount === 1 ? 'is' : 'are'
            } now outside it. ${
              result.flaggedCount === 1 ? 'It stays' : 'They stay'
            } active and ${
              result.flaggedCount === 1 ? 'is' : 'are'
            } flagged for your review.`
          : `Radius set to ${formatDistance(dto.serviceableRadiusM)}.`,
    };
  }

  /** The shops flagged by a radius reduction, for the administrator to act on. */
  async flaggedForRadiusReview(user: AuthenticatedUser) {
    const listings = await this.prisma.shopListing.findMany({
      where: { ...this.tenant.scope(user), flaggedForRadiusReviewAt: { not: null } },
      select: {
        id: true,
        distanceFromCollegeM: true,
        flaggedForRadiusReviewAt: true,
        status: true,
        college: { select: { config: { select: { serviceableRadiusM: true } } } },
        shop: { select: { id: true, name: true, category: true, address: true } },
        _count: { select: { orders: true } },
      },
      orderBy: { distanceFromCollegeM: 'desc' },
    });

    return {
      items: listings.map((l) => ({
        listingId: l.id,
        shop: l.shop,
        status: l.status,
        distanceM: l.distanceFromCollegeM,
        distanceLabel: formatDistance(l.distanceFromCollegeM),
        currentRadiusM: l.college.config?.serviceableRadiusM ?? 3000,
        overByM: l.distanceFromCollegeM - (l.college.config?.serviceableRadiusM ?? 3000),
        lifetimeOrders: l._count.orders,
        flaggedAt: l.flaggedForRadiusReviewAt,
      })),
    };
  }

  // =======================================================================
  // Student-facing browse — FR-CAT-06
  // =======================================================================

  /**
   * FR-CAT-06: shops filtered by category, sorted by distance, rating or
   * preparation time, within the student's own college.
   *
   * FR-SVER-01 allows an unverified student to browse, so this endpoint is
   * deliberately not behind the verification gate.
   */
  async browse(
    user: AuthenticatedUser,
    opts: {
      category?: string;
      q?: string;
      sort?: 'distance' | 'rating' | 'prepTime';
      openNow?: boolean;
      limit?: number;
      cursor?: string;
    },
  ) {
    const collegeId = this.tenant.requireCollegeId(user);
    const limit = opts.limit ?? 30;

    const where: Prisma.ShopListingWhereInput = {
      collegeId,
      // FR-SHOP-09 / FR-SHOP-12: only ACTIVE listings are visible at all.
      status: 'ACTIVE',
      ...(opts.category ? { shop: { category: opts.category.toUpperCase() } } : {}),
      ...(opts.q
        ? {
            OR: [
              { shop: { name: { contains: opts.q, mode: 'insensitive' } } },
              { items: { some: { name: { contains: opts.q, mode: 'insensitive' }, isDeleted: false } } },
            ],
          }
        : {}),
    };

    // The college's timezone decides what "open now" means (R-18). One extra
    // lookup rather than threading it through every row.
    const timeZone = await this.collegeTimeZone(collegeId);

    const listings = await this.prisma.shopListing.findMany({
      where,
      select: {
        id: true,
        distanceFromCollegeM: true,
        temporarilyClosedUntil: true,
        closureNote: true,
        ratingSum: true,
        ratingCount: true,
        shop: { select: { id: true, name: true, category: true, locationType: true } },
        hours: { select: { dayOfWeek: true, openMinute: true, closeMinute: true } },
        items: {
          where: { isAvailable: true, isDeleted: false },
          select: { prepMinutes: true },
        },
      },
      orderBy:
        opts.sort === 'rating'
          ? [{ ratingCount: 'desc' }, { ratingSum: 'desc' }]
          : { distanceFromCollegeM: 'asc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });

    const hasMore = listings.length > limit;
    const page = hasMore ? listings.slice(0, limit) : listings;
    const now = new Date();

    let shaped = page.map((l) => {
      const openState = resolveOpenState({
        rows: l.hours,
        now,
        timeZone,
        temporarilyClosedUntil: l.temporarilyClosedUntil,
      });

      // The typical preparation time across the menu, which is what a student
      // comparing shops actually wants rather than the fastest single item.
      const prepTimes = l.items.map((i) => i.prepMinutes).sort((a, b) => a - b);
      const medianPrep =
        prepTimes.length > 0 ? prepTimes[Math.floor(prepTimes.length / 2)] : null;

      return {
        listingId: l.id,
        shop: l.shop,
        distanceM: l.distanceFromCollegeM,
        distanceLabel: formatDistance(l.distanceFromCollegeM),
        averageRating: l.ratingCount > 0 ? Number((l.ratingSum / l.ratingCount).toFixed(1)) : null,
        ratingCount: l.ratingCount,
        medianPrepMinutes: medianPrep,
        itemCount: l.items.length,
        // FR-CAT-05: a closed shop is shown as closed, not hidden.
        isOpen: openState.isOpen,
        closedReason: openState.isOpen ? null : openState.reason,
        opensInMinutes: openState.opensInMinutes ?? null,
        closureNote: l.temporarilyClosedUntil ? l.closureNote : null,
      };
    });

    // Preparation time is derived per-row, so it cannot be an ORDER BY.
    if (opts.sort === 'prepTime') {
      shaped = shaped.sort(
        (a, b) => (a.medianPrepMinutes ?? 9999) - (b.medianPrepMinutes ?? 9999),
      );
    }

    if (opts.openNow) {
      shaped = shaped.filter((s) => s.isOpen);
    }

    return {
      items: shaped,
      nextCursor: hasMore && opts.sort !== 'prepTime' ? page[page.length - 1].id : null,
    };
  }

  /** S-12: one shop, with its catalog grouped by category. */
  async shopDetail(user: AuthenticatedUser, listingId: string) {
    const listing = await this.prisma.shopListing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        collegeId: true,
        status: true,
        distanceFromCollegeM: true,
        temporarilyClosedUntil: true,
        closureNote: true,
        ratingSum: true,
        ratingCount: true,
        college: { select: { timezone: true } },
        shop: {
          select: {
            id: true,
            name: true,
            category: true,
            locationType: true,
            address: true,
            fssaiLicenceNumber: true,
          },
        },
        hours: {
          select: { dayOfWeek: true, openMinute: true, closeMinute: true },
          orderBy: [{ dayOfWeek: 'asc' }, { openMinute: 'asc' }],
        },
        categories: {
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
        },
        // Items filed under no category. A shop that never set categories up
        // has its whole menu here, and returning only `categories` made such
        // a shop look empty to every student who opened it. Same shape and
        // the same filter as the categorised items above.
        items: {
          where: { isDeleted: false, categoryId: null },
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
    });

    this.tenant.assertSameTenant(user, listing, 'Shop');

    // Nobody opens a listing that is not approved by direct link, except the
    // people who legitimately need to see it before approval: the shop's own
    // owner and staff, and administrators. This used to exempt every
    // non-student role, which let any shop owner in the college read a
    // competitor's pending or suspended listing.
    if (listing!.status !== 'ACTIVE') {
      const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
      const worksHere =
        !isAdmin &&
        (user.role === 'SHOP_OWNER' || user.role === 'SHOP_STAFF') &&
        (await this.prisma.shopStaff.findUnique({
          where: { shopId_userId: { shopId: listing!.shop.id, userId: user.userId } },
          select: { userId: true },
        })) !== null;

      if (!isAdmin && !worksHere) {
        throw new NotFoundException({ code: 'SHOP_NOT_AVAILABLE', message: 'Shop not found' });
      }
    }

    const openState = resolveOpenState({
      rows: listing!.hours,
      now: new Date(),
      timeZone: listing!.college.timezone,
      temporarilyClosedUntil: listing!.temporarilyClosedUntil,
    });

    return {
      listingId: listing!.id,
      shop: listing!.shop,
      distanceM: listing!.distanceFromCollegeM,
      distanceLabel: formatDistance(listing!.distanceFromCollegeM),
      averageRating:
        listing!.ratingCount > 0
          ? Number((listing!.ratingSum / listing!.ratingCount).toFixed(1))
          : null,
      ratingCount: listing!.ratingCount,
      isOpen: openState.isOpen,
      closedReason: openState.isOpen ? null : openState.reason,
      opensInMinutes: openState.opensInMinutes ?? null,
      closureNote: listing!.temporarilyClosedUntil ? listing!.closureNote : null,
      hours: listing!.hours,
      categories: listing!.categories,
      uncategorised: listing!.items,
    };
  }

  /** FR-CAT-06: search catalog items across every active shop in the college. */
  async searchItems(user: AuthenticatedUser, query: string, limit = 40) {
    const collegeId = this.tenant.requireCollegeId(user);

    if (query.trim().length < 2) {
      throw new BadRequestException({
        code: 'QUERY_TOO_SHORT',
        message: 'Type at least two characters to search.',
      });
    }

    const timeZone = await this.collegeTimeZone(collegeId);

    const items = await this.prisma.catalogItem.findMany({
      where: {
        isDeleted: false,
        name: { contains: query, mode: 'insensitive' },
        shopListing: { collegeId, status: 'ACTIVE' },
      },
      select: {
        id: true,
        name: true,
        description: true,
        priceMinor: true,
        prepMinutes: true,
        imageUrl: true,
        isAvailable: true,
        shopListing: {
          select: {
            id: true,
            distanceFromCollegeM: true,
            temporarilyClosedUntil: true,
            shop: { select: { id: true, name: true, category: true } },
            hours: { select: { dayOfWeek: true, openMinute: true, closeMinute: true } },
          },
        },
      },
      take: limit,
      orderBy: { name: 'asc' },
    });

    const now = new Date();

    return {
      query,
      items: items.map((item) => {
        const openState = resolveOpenState({
          rows: item.shopListing.hours,
          now,
          timeZone,
          temporarilyClosedUntil: item.shopListing.temporarilyClosedUntil,
        });

        return {
          id: item.id,
          name: item.name,
          description: item.description,
          priceMinor: item.priceMinor,
          prepMinutes: item.prepMinutes,
          imageUrl: item.imageUrl,
          isAvailable: item.isAvailable,
          listingId: item.shopListing.id,
          shop: item.shopListing.shop,
          distanceM: item.shopListing.distanceFromCollegeM,
          distanceLabel: formatDistance(item.shopListing.distanceFromCollegeM),
          shopIsOpen: openState.isOpen,
        };
      }),
    };
  }

  /**
   * The college's delivery points, for the checkout drop-point picker.
   *
   * The order endpoints have always accepted a `deliveryPointId`, and the
   * seed has always created points — but nothing listed them, so a student
   * had no way to learn an id and the picker could not be built. Found while
   * writing that screen.
   *
   * Scoped to the caller's college like everything else (C-1), and inactive
   * points are filtered out here rather than hidden in the UI, so a point an
   * administrator retires stops being orderable immediately.
   */
  async deliveryPoints(user: AuthenticatedUser) {
    const collegeId = this.tenant.requireCollegeId(user);

    const points = await this.prisma.deliveryPoint.findMany({
      where: { collegeId, isActive: true },
      select: {
        id: true,
        name: true,
        description: true,
        latitude: true,
        longitude: true,
        sortOrder: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    return { points };
  }
}
