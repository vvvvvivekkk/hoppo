import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus as DbOrderStatus, PaymentMethod, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import {
  computeOrderTotals,
  formatDistance,
  formatMinor,
  ORDER_REFERENCE_LENGTH,
  ORDER_REFERENCE_PREFIX,
  OrderEvent,
  OrderStatus,
  TaskEvent,
  TaskStatus,
  assertOrderTransition,
  assertTaskTransition,
  isStudentCancellable,
  quoteFee,
  resolveOpenState,
  DEFAULT_TIMEZONE,
  type FeeBand,
} from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../common/tenant/tenant.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { clampPageLimit } from '../common/pagination';
import {
  orderStateChanged,
  resolveOrderTransition,
  resolveTaskTransition,
} from './order-transition';
import { WALLET_HEAD_ORDER, readWalletHead } from '../wallet/wallet-ledger';
import type {
  AcceptOrderDto,
  CancelOrderDto,
  PlaceOrderDto,
  QuoteOrderDto,
  RejectOrderDto,
} from './dto/orders.dto';

/**
 * Page size for "my orders" when the client does not ask for one: 20, as it
 * was before the limit was validated. The shared helper defaults to 25, so
 * the value is passed explicitly rather than inherited — clamping untrusted
 * input was the fix; changing what an existing client gets by default was not.
 */
export const MY_ORDERS_DEFAULT_LIMIT = 20;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly audit: AuditService,
  ) {}

  // =======================================================================
  // Quoting — FR-ORD-01, FR-ORD-03, FR-ORD-10
  // =======================================================================

  /**
   * Price a cart without creating anything.
   *
   * The same computation runs again inside `place`, and the student's agreed
   * total is compared against it. Pricing twice is deliberate: a quote is a
   * read, and trusting a client-supplied total would let anyone set their own
   * price.
   */
  async quote(user: AuthenticatedUser, dto: QuoteOrderDto) {
    const collegeId = this.tenant.requireCollegeId(user);
    const context = await this.loadOrderContext(collegeId, dto);

    return {
      listingId: context.listing.id,
      shop: context.listing.shop,
      lines: context.lines.map((l) => ({
        catalogItemId: l.item.id,
        name: l.item.name,
        unitPriceMinor: l.item.priceMinor,
        quantity: l.quantity,
        lineTotalMinor: l.lineTotalMinor,
        note: l.note ?? null,
      })),
      drop: context.drop,
      distanceM: context.distanceM,
      distanceLabel: formatDistance(context.distanceM),
      totals: {
        ...context.totals,
        itemsSubtotalLabel: formatMinor(context.totals.itemsSubtotalMinor),
        deliveryFeeLabel: formatMinor(context.totals.deliveryFeeMinor),
        platformFeeLabel: formatMinor(context.totals.platformFeeMinor),
        totalLabel: formatMinor(context.totals.totalMinor),
      },
      // The slowest item sets the pace: a thali and a chai are ready when the
      // thali is ready, not when the chai is.
      estimatedPrepMinutes: context.maxPrepMinutes,
      shopIsOpen: context.isOpen,
      closedReason: context.closedReason,
    };
  }

  /**
   * Everything needed to price and place an order, validated once.
   *
   * Shared by `quote` and `place` so the two cannot drift — a quote that
   * accepted a cart the placement then rejected would be a confusing bug.
   */
  private async loadOrderContext(collegeId: string, dto: QuoteOrderDto) {
    const listing = await this.prisma.shopListing.findUnique({
      where: { id: dto.listingId },
      select: {
        id: true,
        collegeId: true,
        status: true,
        temporarilyClosedUntil: true,
        shop: { select: { id: true, name: true, latitude: true, longitude: true } },
        hours: { select: { dayOfWeek: true, openMinute: true, closeMinute: true } },
        college: {
          select: {
            timezone: true,
            config: {
              select: {
                platformFeeMinor: true,
                commissionBps: true,
                dispatchLeadMinutes: true,
                feeIncrementMinor: true,
              },
            },
            feeBands: {
              select: { minDistanceM: true, maxDistanceM: true, feeMinor: true },
              orderBy: { minDistanceM: 'asc' },
            },
          },
        },
      },
    });

    if (!listing || listing.collegeId !== collegeId) {
      throw new NotFoundException({ code: 'SHOP_NOT_FOUND', message: 'Shop not found' });
    }

    if (listing.status !== 'ACTIVE') {
      throw new BadRequestException({
        code: 'SHOP_NOT_AVAILABLE',
        message: 'That shop is not currently taking orders.',
      });
    }

    // FR-CAT-05: a closed shop cannot accept orders.
    const openState = resolveOpenState({
      rows: listing.hours,
      now: new Date(),
      timeZone: listing.college.timezone ?? DEFAULT_TIMEZONE,
      temporarilyClosedUntil: listing.temporarilyClosedUntil,
    });

    // FR-ORD-01: items must all come from this one shop. Rather than trusting
    // the client's listingId, every item is fetched *scoped to the listing* —
    // so an item from elsewhere simply is not found.
    const itemIds = dto.lines.map((l) => l.catalogItemId);
    const items = await this.prisma.catalogItem.findMany({
      where: { id: { in: itemIds }, shopListingId: listing.id, isDeleted: false },
      select: {
        id: true,
        name: true,
        priceMinor: true,
        prepMinutes: true,
        isAvailable: true,
      },
    });

    const itemsById = new Map(items.map((i) => [i.id, i]));

    const missing = itemIds.filter((id) => !itemsById.has(id));
    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'ITEMS_NOT_IN_SHOP',
        message:
          'Your cart contains items that are not on this shop’s menu. ' +
          'A cart can only hold items from one shop.',
        details: { missing },
      });
    }

    const unavailable = items.filter((i) => !i.isAvailable);
    if (unavailable.length > 0) {
      throw new BadRequestException({
        code: 'ITEMS_UNAVAILABLE',
        message: `${unavailable.map((i) => i.name).join(', ')} ${
          unavailable.length === 1 ? 'is' : 'are'
        } no longer available. Remove ${unavailable.length === 1 ? 'it' : 'them'} to continue.`,
        details: { unavailable: unavailable.map((i) => ({ id: i.id, name: i.name })) },
      });
    }

    const lines = dto.lines.map((line) => {
      const item = itemsById.get(line.catalogItemId)!;
      return {
        item,
        quantity: line.quantity,
        note: line.note,
        lineTotalMinor: item.priceMinor * line.quantity,
      };
    });

    // FR-ORD-02: either a configured campus point or a free-text landmark.
    const drop = await this.resolveDropPoint(collegeId, dto);

    // The delivery distance is shop to drop point, measured geodesically by
    // the database like every other distance in the system (C-2).
    const distanceM = await this.prisma.geodesicDistanceM(
      { latitude: listing.shop.latitude, longitude: listing.shop.longitude },
      { latitude: drop.latitude, longitude: drop.longitude },
    );

    // FR-ORD-10
    const bands: FeeBand[] = listing.college.feeBands.map((b) => ({
      minDistanceM: b.minDistanceM,
      maxDistanceM: b.maxDistanceM,
      feeMinor: b.feeMinor,
    }));

    const feeQuote = quoteFee({ bands, distanceM });

    if (bands.length === 0) {
      throw new BadRequestException({
        code: 'FEE_BANDS_NOT_CONFIGURED',
        message:
          'Delivery pricing is not set up for your college yet. Contact your campus administrator.',
      });
    }

    const totals = computeOrderTotals({
      lineTotals: lines.map((l) => l.lineTotalMinor),
      deliveryFeeMinor: feeQuote.baseFeeMinor,
      platformFeeMinor: listing.college.config?.platformFeeMinor ?? 0,
      commissionBps: listing.college.config?.commissionBps ?? 0,
    });

    return {
      listing,
      lines,
      drop,
      distanceM,
      totals,
      feeQuote,
      maxPrepMinutes: Math.max(...lines.map((l) => l.item.prepMinutes)),
      isOpen: openState.isOpen,
      closedReason: openState.isOpen ? null : openState.reason,
      config: listing.college.config,
    };
  }

  /** FR-ORD-02 */
  private async resolveDropPoint(collegeId: string, dto: QuoteOrderDto) {
    if (dto.deliveryPointId) {
      const point = await this.prisma.deliveryPoint.findFirst({
        where: { id: dto.deliveryPointId, collegeId, isActive: true },
        select: { id: true, name: true, latitude: true, longitude: true },
      });

      if (!point) {
        throw new BadRequestException({
          code: 'DELIVERY_POINT_NOT_FOUND',
          message: 'That delivery point is not available. Choose another.',
        });
      }

      return {
        deliveryPointId: point.id,
        label: point.name,
        landmark: null as string | null,
        latitude: point.latitude,
        longitude: point.longitude,
      };
    }

    // A free-text landmark still needs coordinates, because the fee band and
    // the rider's proximity both depend on where the drop actually is.
    if (dto.dropLandmark && dto.dropLatitude !== undefined && dto.dropLongitude !== undefined) {
      return {
        deliveryPointId: null as string | null,
        label: dto.dropLandmark,
        landmark: dto.dropLandmark,
        latitude: dto.dropLatitude,
        longitude: dto.dropLongitude,
      };
    }

    throw new BadRequestException({
      code: 'DROP_POINT_REQUIRED',
      message:
        'Choose a campus delivery point, or give a landmark together with its location on the map.',
    });
  }

  // =======================================================================
  // Placement — FR-ORD-04, FR-ORD-06
  // =======================================================================

  async place(user: AuthenticatedUser, dto: PlaceOrderDto) {
    const collegeId = this.tenant.requireCollegeId(user);

    // No payment gateway exists yet. An ONLINE order would be created
    // PENDING, never collected, and still credit the rider's wallet on
    // completion — money paid out that nobody paid in. Refuse it here, before
    // any pricing work, until a gateway can actually take the payment.
    if (dto.paymentMethod === PaymentMethod.ONLINE) {
      throw new BadRequestException({
        code: 'ONLINE_PAYMENT_UNAVAILABLE',
        message:
          'Online payment is not available yet. Choose cash on delivery or your wallet instead.',
      });
    }
    const context = await this.loadOrderContext(collegeId, dto);

    if (!context.isOpen) {
      throw new BadRequestException({
        code: 'SHOP_CLOSED',
        message:
          context.closedReason === 'TEMPORARILY_CLOSED'
            ? 'That shop has closed temporarily. Try again later.'
            : 'That shop is closed right now.',
      });
    }

    // FR-ORD-03: refuse if the total moved between the quote and the confirm.
    // Without this, a price change in the seconds between screens would charge
    // the student something they never agreed to.
    if (dto.expectedTotalMinor !== context.totals.totalMinor) {
      throw new ConflictException({
        code: 'PRICE_CHANGED',
        message:
          `The total changed from ${formatMinor(dto.expectedTotalMinor)} to ` +
          `${formatMinor(context.totals.totalMinor)} while you were ordering. ` +
          'Check your cart and confirm again.',
        details: {
          shownTotalMinor: dto.expectedTotalMinor,
          currentTotalMinor: context.totals.totalMinor,
        },
      });
    }

    if (dto.paymentMethod === PaymentMethod.WALLET) {
      // FR-PAY-06: the amount is held on placement. The wallet is not funded
      // in Phase 1 beyond rider earnings, so refuse clearly rather than
      // creating an order that can never be paid for.
      //
      // This read is a courtesy only: it fails fast without opening a
      // transaction. It decides nothing — two placements can both pass it —
      // so the same check runs again under the wallet lock below, and that
      // one is the guarantee.
      const balance = await this.walletBalance(user.userId);
      if (balance < context.totals.totalMinor) {
        throw this.insufficientWalletBalance(balance, context.totals.totalMinor);
      }
    }

    const leadMinutes = context.config?.dispatchLeadMinutes ?? 7;

    const result = await this.withReferenceRetry((reference) =>
      this.prisma.$transaction(async (tx) => {
      // Taken before anything is written, so every wallet-writing transaction
      // acquires its locks in the same order (wallet first, rows after).
      if (dto.paymentMethod === PaymentMethod.WALLET) {
        await this.lockWallet(tx, user.userId);
      }

      const order = await tx.order.create({
        data: {
          collegeId,
          reference,
          studentId: user.userId,
          shopListingId: context.listing.id,
          status: DbOrderStatus.PLACED,
          itemsSubtotalMinor: context.totals.itemsSubtotalMinor,
          deliveryFeeMinor: context.totals.deliveryFeeMinor,
          platformFeeMinor: context.totals.platformFeeMinor,
          totalMinor: context.totals.totalMinor,
          commissionMinor: context.totals.commissionMinor,
          paymentMethod: dto.paymentMethod,
          paymentStatus:
            dto.paymentMethod === PaymentMethod.CASH
              ? 'NOT_REQUIRED'
              : dto.paymentMethod === PaymentMethod.WALLET
                ? 'HELD'
                : 'PENDING',
          deliveryPointId: context.drop.deliveryPointId,
          dropLandmark: context.drop.landmark,
          dropLatitude: context.drop.latitude,
          dropLongitude: context.drop.longitude,
          studentNote: dto.studentNote ?? null,
          statedPrepMinutes: context.maxPrepMinutes,
          items: {
            create: context.lines.map((l) => ({
              catalogItemId: l.item.id,
              // Snapshot name and price, so a later menu edit cannot rewrite
              // an old receipt.
              nameSnapshot: l.item.name,
              unitPriceMinor: l.item.priceMinor,
              quantity: l.quantity,
              lineTotalMinor: l.lineTotalMinor,
              note: l.note ?? null,
            })),
          },
        },
        select: { id: true, reference: true, status: true, placedAt: true },
      });

      // FR-ORD-06: a delivery task is created alongside the order, in CREATED.
      // It has no dispatchDueAt yet — the shop has not said how long the food
      // will take, so there is nothing to count back from (FR-DLV-01).
      const task = await tx.task.create({
        data: {
          collegeId,
          type: 'SHOP_ORDER',
          status: TaskStatus.CREATED,
          orderId: order.id,
          requesterId: user.userId,
          pickupLabel: context.listing.shop.name,
          pickupLatitude: context.listing.shop.latitude,
          pickupLongitude: context.listing.shop.longitude,
          dropLabel: context.drop.label,
          dropLatitude: context.drop.latitude,
          dropLongitude: context.drop.longitude,
          distanceM: context.distanceM,
          baseFeeMinor: context.feeQuote.baseFeeMinor,
          feeMinor: context.feeQuote.baseFeeMinor,
        },
        select: { id: true, status: true },
      });

      // FR-PAY-06: hold the wallet amount as a ledger entry.
      if (dto.paymentMethod === PaymentMethod.WALLET) {
        // Re-read and re-check under the lock. Between the courtesy check
        // above and here another placement may have spent the same money;
        // with the lock held, this read is the latest entry and nothing can
        // append after it until this transaction ends. Throwing rolls back
        // the order and task created above.
        const { balanceMinor: balance, nextCreatedAt } = await readWalletHead(tx, user.userId);
        if (balance < context.totals.totalMinor) {
          throw this.insufficientWalletBalance(balance, context.totals.totalMinor);
        }

        await tx.walletEntry.create({
          data: {
            userId: user.userId,
            direction: 'DEBIT',
            amountMinor: context.totals.totalMinor,
            type: 'ORDER_HOLD',
            orderId: order.id,
            balanceAfterMinor: balance - context.totals.totalMinor,
            // Strictly after the entry this balance was read from, so the
            // ledger has one unambiguous latest row (see wallet-ledger.ts).
            createdAt: nextCreatedAt,
            note: `Held for order ${reference}`,
          },
        });
      }

      return { order, task };
      }),
    );

    this.logger.log(
      `Order ${result.order.reference} placed by ${user.userId} at listing ` +
        `${context.listing.id}, task ${result.task.id} created (lead ${leadMinutes}m)`,
    );

    return {
      orderId: result.order.id,
      reference: result.order.reference,
      status: result.order.status,
      taskId: result.task.id,
      placedAt: result.order.placedAt,
      totals: {
        ...context.totals,
        totalLabel: formatMinor(context.totals.totalMinor),
      },
      estimatedPrepMinutes: context.maxPrepMinutes,
      message: `Order ${result.order.reference} sent to ${context.listing.shop.name}.`,
    };
  }

  /**
   * A short, human-readable reference, read aloud across a counter.
   *
   * The alphabet excludes O/0 and I/1, the characters people mishear and
   * mistype. 32 characters divides 256 exactly, so mapping a random byte with
   * `% 32` introduces no bias.
   *
   * Seven characters, not five. Five gives a space of 32^5, about 33.5
   * million — which sounds ample until you do the birthday arithmetic: at a
   * few tens of thousands of orders a year, a collision is not unlikely but
   * near-certain. Seven gives 32^7, about 34 billion, which puts the
   * probability back into the territory where the retry below is cold code.
   *
   * The unique constraint on the column remains the actual guarantee; this
   * only decides how often it fires.
   */
  private generateReference(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(ORDER_REFERENCE_LENGTH);
    let out = '';
    for (const b of bytes) out += alphabet[b % alphabet.length];
    return `${ORDER_REFERENCE_PREFIX}-${out}`;
  }

  /**
   * Insert an order, retrying on a reference collision.
   *
   * A collision is a unique-constraint violation (P2002) on
   * `order.reference`. Without a retry the student sees "duplicate order
   * reference, please retry" and has to re-confirm a cart they already
   * confirmed — for a problem that is entirely ours and entirely automatic to
   * fix. Three attempts, because the chance of three consecutive collisions
   * is not worth a fourth branch.
   */
  private async withReferenceRetry<T>(
    attempt: (reference: string) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (let tries = 0; tries < 3; tries += 1) {
      const reference = this.generateReference();
      try {
        return await attempt(reference);
      } catch (error) {
        const isReferenceCollision =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          ((error.meta?.target as string[] | undefined) ?? []).some((t) =>
            t.includes('reference'),
          );

        if (!isReferenceCollision) throw error;

        this.logger.warn(`Order reference ${reference} collided; retrying`);
        lastError = error;
      }
    }

    throw lastError;
  }

  // =======================================================================
  // Student views and cancellation — FR-ORD-05
  // =======================================================================

  async myOrders(user: AuthenticatedUser, requestedLimit?: number, cursor?: string) {
    // Clamped here as well as in the controller, so a caller that is not the
    // controller cannot ask for an unbounded page either.
    const limit = clampPageLimit(requestedLimit, MY_ORDERS_DEFAULT_LIMIT);

    const orders = await this.prisma.order.findMany({
      where: { ...this.tenant.scope(user), studentId: user.userId },
      select: {
        id: true,
        reference: true,
        status: true,
        totalMinor: true,
        placedAt: true,
        completedAt: true,
        cancelledAt: true,
        shopListing: { select: { id: true, shop: { select: { id: true, name: true } } } },
        items: { select: { nameSnapshot: true, quantity: true } },
        task: { select: { id: true, status: true, riderId: true } },
      },
      orderBy: { placedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = orders.length > limit;
    const page = hasMore ? orders.slice(0, limit) : orders;

    return {
      items: page.map((o) => ({
        ...o,
        totalLabel: formatMinor(o.totalMinor),
        canCancel: isStudentCancellable(o.status as OrderStatus),
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /** S-19: the live tracking screen. */
  async orderDetail(user: AuthenticatedUser, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        collegeId: true,
        reference: true,
        status: true,
        studentId: true,
        itemsSubtotalMinor: true,
        deliveryFeeMinor: true,
        platformFeeMinor: true,
        totalMinor: true,
        paymentMethod: true,
        paymentStatus: true,
        dropLandmark: true,
        studentNote: true,
        statedPrepMinutes: true,
        expectedReadyAt: true,
        placedAt: true,
        shopAcceptedAt: true,
        readyAt: true,
        pickedUpAt: true,
        deliveredAt: true,
        completedAt: true,
        cancelledAt: true,
        cancelledBy: true,
        cancelledReason: true,
        shopListing: {
          select: {
            id: true,
            shop: { select: { id: true, name: true, ownerMobile: true } },
          },
        },
        items: {
          select: {
            nameSnapshot: true,
            unitPriceMinor: true,
            quantity: true,
            lineTotalMinor: true,
            note: true,
          },
        },
        task: {
          select: {
            id: true,
            status: true,
            feeMinor: true,
            broadcastRound: true,
            offerExpiresAt: true,
            assignedAt: true,
            pickedUpAt: true,
            rider: {
              select: {
                id: true,
                name: true,
                riderReliability: { select: { ratingSum: true, ratingCount: true, tasksCompleted: true } },
              },
            },
          },
        },
      },
    });

    this.tenant.assertSameTenant(user, order, 'Order');

    // The student who placed it, the shop's staff, or an administrator.
    const isStudent = order!.studentId === user.userId;
    const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
    const isShopStaff =
      user.role === 'SHOP_OWNER' || user.role === 'SHOP_STAFF'
        ? await this.isStaffOfListing(user.userId, order!.shopListing.id)
        : false;
    const isRider = order!.task?.rider?.id === user.userId;

    if (!isStudent && !isAdmin && !isShopStaff && !isRider) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_ORDER',
        message: 'You do not have access to this order.',
      });
    }

    const rider = order!.task?.rider;

    return {
      ...order!,
      collegeId: undefined,
      totalLabel: formatMinor(order!.totalMinor),
      canCancel: isStudent && isStudentCancellable(order!.status as OrderStatus),
      rider: rider
        ? {
            id: rider.id,
            name: rider.name,
            // FR-TRST-02: the rider's rating and completed count are shown.
            // FR-PRIV-03: their mobile number is not — contact goes through
            // in-app chat.
            averageRating:
              (rider.riderReliability?.ratingCount ?? 0) > 0
                ? Number(
                    (
                      rider.riderReliability!.ratingSum / rider.riderReliability!.ratingCount
                    ).toFixed(1),
                  )
                : null,
            completedTasks: rider.riderReliability?.tasksCompleted ?? 0,
          }
        : null,
      // FR-DLV-12: the handover code is shown to the requester only, and only
      // once the goods are picked up.
      handoverCodeAvailable: order!.task?.status === 'PICKED_UP' && isStudent,
    };
  }

  private async isStaffOfListing(userId: string, listingId: string): Promise<boolean> {
    const listing = await this.prisma.shopListing.findUnique({
      where: { id: listingId },
      select: { shop: { select: { staff: { select: { userId: true } } } } },
    });
    return listing?.shop.staff.some((s) => s.userId === userId) ?? false;
  }

  /** FR-ORD-05 */
  async cancelByStudent(user: AuthenticatedUser, orderId: string, dto: CancelOrderDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        collegeId: true,
        studentId: true,
        status: true,
        reference: true,
        paymentMethod: true,
        totalMinor: true,
        task: { select: { id: true, status: true } },
      },
    });

    this.tenant.assertSameTenant(user, order, 'Order');

    if (order!.studentId !== user.userId) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_ORDER',
        message: 'You can only cancel your own orders.',
      });
    }

    // FR-ORD-05: free cancellation at PLACED or SHOP_ACCEPTED, and not once
    // preparation has begun — at that point the shop has committed ingredients.
    if (!isStudentCancellable(order!.status as OrderStatus)) {
      throw new ConflictException({
        code: 'TOO_LATE_TO_CANCEL',
        message:
          order!.status === 'PREPARING'
            ? 'The shop has already started preparing this order, so it can no longer be cancelled.'
            : `This order is ${order!.status.toLowerCase().replace(/_/g, ' ')} and cannot be cancelled.`,
      });
    }

    await this.transitionOrderAndTask({
      orderId: order!.id,
      taskId: order!.task?.id ?? null,
      orderEvent: OrderEvent.STUDENT_CANCELLED,
      taskEvent: TaskEvent.REQUESTER_CANCELLED,
      orderData: {
        cancelledAt: new Date(),
        cancelledBy: 'STUDENT',
        cancelledReason: dto.reason ?? 'Cancelled by student',
      },
      releaseWalletHold: order!.paymentMethod === PaymentMethod.WALLET,
      walletAmountMinor: order!.totalMinor,
      userId: order!.studentId,
      reference: order!.reference,
    });

    // Say what actually happened to the money. A wallet order had its total
    // held at placement and has just had it released; a cash order never
    // moved any money at all.
    const releasedMinor = order!.paymentMethod === PaymentMethod.WALLET ? order!.totalMinor : 0;

    return {
      orderId,
      status: 'CANCELLED',
      refundedMinor: releasedMinor,
      message:
        releasedMinor > 0
          ? `Order cancelled. ${formatMinor(releasedMinor)} has been returned to your wallet.`
          : 'Order cancelled. You have not been charged.',
    };
  }

  // =======================================================================
  // Unfulfilled orders — FR-DLV-07
  // =======================================================================

  /**
   * FR-DLV-07: "Where all broadcast rounds are exhausted, the system shall
   * notify the requester and the shop, and shall offer the requester the
   * choice to continue waiting, to collect in person, or to cancel with a
   * full refund."
   *
   * Appendix A gives UNFULFILLED no way out at all, so these three
   * transitions were added to the state machine — see resolution R-06.
   */
  async resolveUnfulfilled(
    user: AuthenticatedUser,
    orderId: string,
    choice: 'KEEP_WAITING' | 'COLLECT_IN_PERSON' | 'CANCEL',
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        collegeId: true,
        studentId: true,
        status: true,
        reference: true,
        paymentMethod: true,
        totalMinor: true,
        deliveryFeeMinor: true,
        task: { select: { id: true, status: true } },
      },
    });

    this.tenant.assertSameTenant(user, order, 'Order');

    if (order!.studentId !== user.userId) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_ORDER',
        message: 'Only the person who placed this order can decide.',
      });
    }

    if (order!.task?.status !== 'UNFULFILLED') {
      throw new ConflictException({
        code: 'NOT_UNFULFILLED',
        message: 'This order is not waiting on a decision.',
      });
    }

    const taskId = order!.task.id;

    if (choice === 'KEEP_WAITING') {
      // R-08: back into the pool at round 0 with the base fee, because this
      // is a fresh search rather than a continuation of a failed one.
      await this.prisma.$transaction(async (tx) => {
        const task = await tx.task.findUnique({
          where: { id: taskId },
          select: { baseFeeMinor: true },
        });

        assertTaskTransition(TaskStatus.UNFULFILLED, TaskEvent.REQUESTER_KEEPS_WAITING);

        // Conditional for the same reason as the two branches below: a
        // "keep waiting" racing a "cancel" must not put a cancelled, refunded
        // task back into the dispatch pool.
        const moved = await tx.task.updateMany({
          where: { id: taskId, status: 'UNFULFILLED' },
          data: {
            status: 'CREATED',
            broadcastRound: 0,
            feeMinor: task?.baseFeeMinor ?? 0,
            currentProximityM: null,
            offerExpiresAt: null,
            dispatchDueAt: new Date(),
          },
        });
        if (moved.count === 0) throw this.alreadyDecided();

        // The rounds that found nobody are closed as EXPIRED, not deleted.
        // broadcast_log is the record FR-DLV-09 / FR-ADM-05 report from, and
        // its trigger refuses DELETE outright — so the delete that used to be
        // here failed the whole transaction whenever a PENDING row existed,
        // and "keep waiting" never took effect.
        await tx.broadcastLog.updateMany({
          where: { taskId, outcome: 'PENDING' },
          data: { outcome: 'EXPIRED', resolvedAt: new Date() },
        });
      });

      return {
        orderId,
        choice,
        message: 'Looking for a rider again. We will let you know as soon as one accepts.',
      };
    }

    if (choice === 'COLLECT_IN_PERSON') {
      // There is nothing to collect until the shop has packed it. Riders are
      // called before the food is ready (FR-DLV-01), so a task can run out of
      // rounds while the order is still PREPARING; completing it then would
      // close an order the student has not received.
      if (order!.status !== 'READY') {
        throw this.notReadyToCollect();
      }

      const paidFromWallet = order!.paymentMethod === PaymentMethod.WALLET;
      const refundsFeeToWallet = paidFromWallet && order!.deliveryFeeMinor > 0;

      // FR-DLV-07: no rider delivered it, so no delivery fee is due. The
      // refund is of the fee only — the food was made and is being collected.
      await this.prisma.$transaction(async (tx) => {
        // Locked for any wallet order, not only one with a fee to refund: the
        // capture entry below is a ledger write too.
        if (paidFromWallet) await this.lockWallet(tx, order!.studentId);

        assertTaskTransition(TaskStatus.UNFULFILLED, TaskEvent.REQUESTER_COLLECTED_IN_PERSON);
        assertOrderTransition(OrderStatus.READY, OrderEvent.COLLECTED_IN_PERSON);

        // The two conditional updates decide; the checks above this
        // transaction only choose the error message. A second request, or a
        // parallel "cancel", finds the task no longer UNFULFILLED, matches
        // zero rows, and is turned away before any refund is written.
        const taskMoved = await tx.task.updateMany({
          where: { id: taskId, status: 'UNFULFILLED' },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            resolutionNote: 'Collected in person by the requester; no rider was found.',
          },
        });
        if (taskMoved.count === 0) throw this.alreadyDecided();

        const orderMoved = await tx.order.updateMany({
          where: { id: orderId, status: DbOrderStatus.READY },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            // The delivery fee is refunded; the items are not.
            deliveryFeeMinor: 0,
            totalMinor: { decrement: order!.deliveryFeeMinor },
            // The order is complete, so what remains of the hold is now the
            // shop's: HELD becomes CAPTURED, exactly as on a rider-delivered
            // order. Cash stays NOT_REQUIRED.
            ...(paidFromWallet ? { paymentStatus: 'CAPTURED' as const } : {}),
          },
        });
        if (orderMoved.count === 0) throw this.notReadyToCollect();

        if (refundsFeeToWallet) {
          const { balanceMinor: balance, nextCreatedAt } = await readWalletHead(tx, order!.studentId);
          await tx.walletEntry.create({
            data: {
              userId: order!.studentId,
              direction: 'CREDIT',
              amountMinor: order!.deliveryFeeMinor,
              type: 'ORDER_RELEASE',
              orderId,
              balanceAfterMinor: balance + order!.deliveryFeeMinor,
              // Strictly after the entry this balance was read from, so the
              // ledger has one unambiguous latest row (see wallet-ledger.ts).
              createdAt: nextCreatedAt,
              note: `Delivery fee refunded on ${order!.reference}; collected in person`,
            },
          });
        }

        // FR-PAY-06: the capture. The money left the wallet when the hold was
        // written at placement, so this is a zero-amount marker that closes
        // the hold rather than a second debit — the same entry the rider's
        // completion path writes for a delivered order. Without it the ledger
        // shows a hold that was never either captured or released.
        if (paidFromWallet) {
          const head = await readWalletHead(tx, order!.studentId);
          await tx.walletEntry.create({
            data: {
              userId: order!.studentId,
              direction: 'DEBIT',
              amountMinor: 0,
              type: 'ORDER_CAPTURE',
              orderId,
              balanceAfterMinor: head.balanceMinor,
              createdAt: head.nextCreatedAt,
              note: `Captured for order ${order!.reference}; collected in person`,
            },
          });
        }
      });

      // Only a wallet order has paid the fee already and can have it
      // refunded. On a cash order nothing has been paid yet: the fee is simply
      // dropped from what is owed, and saying "refunded" would send the
      // student looking for money that never left their hands.
      const refundedFeeMinor = refundsFeeToWallet ? order!.deliveryFeeMinor : 0;
      const dueAtShopMinor = paidFromWallet ? 0 : order!.totalMinor - order!.deliveryFeeMinor;

      return {
        orderId,
        choice,
        refundedFeeMinor,
        message:
          refundedFeeMinor > 0
            ? `Collect your order from the shop. The ${formatMinor(
                refundedFeeMinor,
              )} delivery fee has been returned to your wallet.`
            : paidFromWallet
              ? 'Collect your order from the shop. It is already paid for.'
              : `Collect your order from the shop and pay ${formatMinor(
                  dueAtShopMinor,
                )} there. No delivery fee is charged.`,
      };
    }

    // CANCEL — FR-DLV-07 full refund.
    const refundsToWallet = order!.paymentMethod === PaymentMethod.WALLET;

    await this.prisma.$transaction(async (tx) => {
      if (refundsToWallet) await this.lockWallet(tx, order!.studentId);

      assertTaskTransition(TaskStatus.UNFULFILLED, TaskEvent.REQUESTER_CANCELLED);

      // ADR-001 applied to refunds: the status read at the top of this method
      // is stale by now, so it is the WHERE clause that decides. Two parallel
      // cancels both read UNFULFILLED; only one of these updates matches a
      // row, and the other stops here having refunded nothing.
      const taskMoved = await tx.task.updateMany({
        where: { id: taskId, status: 'UNFULFILLED' },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      if (taskMoved.count === 0) throw this.alreadyDecided();

      // An order whose task ran out of riders is still with the shop. Any
      // other status means something else finished or cancelled it first.
      const orderMoved = await tx.order.updateMany({
        where: {
          id: orderId,
          status: {
            in: [DbOrderStatus.SHOP_ACCEPTED, DbOrderStatus.PREPARING, DbOrderStatus.READY],
          },
        },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: 'STUDENT',
          cancelledReason: 'No rider was available; cancelled by the student with a full refund.',
          // The hold is released in full just below; see transitionOrderAndTask.
          ...(refundsToWallet ? { paymentStatus: 'REFUNDED' as const } : {}),
        },
      });
      if (orderMoved.count === 0) throw this.orderStateChanged();

      if (refundsToWallet) {
        const { balanceMinor: balance, nextCreatedAt } = await readWalletHead(tx, order!.studentId);
        await tx.walletEntry.create({
          data: {
            userId: order!.studentId,
            direction: 'CREDIT',
            amountMinor: order!.totalMinor,
            type: 'ORDER_RELEASE',
            orderId,
            balanceAfterMinor: balance + order!.totalMinor,
            // Strictly after the entry this balance was read from, so the
            // ledger has one unambiguous latest row (see wallet-ledger.ts).
            createdAt: nextCreatedAt,
            note: `Full refund on ${order!.reference}; no rider available`,
          },
        });
      }
    });

    // A refund is only a refund if money was held. A cash order pays at the
    // door, so cancelling it returns nothing — and must not claim to.
    const refundedMinor = refundsToWallet ? order!.totalMinor : 0;

    return {
      orderId,
      choice,
      refundedMinor,
      message:
        refundedMinor > 0
          ? `Order cancelled and ${formatMinor(refundedMinor)} refunded in full to your wallet.`
          : 'Order cancelled. You had not paid anything, so there is nothing to refund.',
    };
  }

  // =======================================================================
  // Shop order handling — FR-SHP-01 .. FR-SHP-06
  // =======================================================================

  /** FR-SHP-01: the live queue (D-08). */
  async shopQueue(user: AuthenticatedUser, listingId: string) {
    await this.assertShopAccess(user, listingId);

    const config = await this.prisma.collegeConfig.findFirst({
      where: { college: { shopListings: { some: { id: listingId } } } },
      select: { shopAcceptWindowSeconds: true },
    });

    const windowSeconds = config?.shopAcceptWindowSeconds ?? 300;

    const orders = await this.prisma.order.findMany({
      where: {
        // assertShopAccess has already checked the listing's college; the
        // scope is repeated on the query itself so that this read obeys the
        // tenancy rule on its own, not by virtue of a check made elsewhere.
        ...this.tenant.scope(user),
        shopListingId: listingId,
        status: { in: ['PLACED', 'SHOP_ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP'] },
      },
      select: {
        id: true,
        reference: true,
        status: true,
        itemsSubtotalMinor: true,
        totalMinor: true,
        paymentMethod: true,
        dropLandmark: true,
        studentNote: true,
        statedPrepMinutes: true,
        expectedReadyAt: true,
        placedAt: true,
        shopAcceptedAt: true,
        readyAt: true,
        student: { select: { id: true, name: true } },
        items: {
          select: { nameSnapshot: true, quantity: true, unitPriceMinor: true, note: true },
        },
        task: {
          select: {
            id: true,
            status: true,
            rider: { select: { id: true, name: true } },
          },
        },
      },
      // FR-SHP-01: arrival order.
      orderBy: { placedAt: 'asc' },
    });

    const now = Date.now();

    return {
      listingId,
      acceptWindowSeconds: windowSeconds,
      items: orders.map((o) => ({
        ...o,
        itemsSubtotalLabel: formatMinor(o.itemsSubtotalMinor),
        // FR-SHP-02: how long is left to accept. The shop UI shows this as a
        // countdown, and the sweep cancels the order when it runs out.
        acceptSecondsRemaining:
          o.status === 'PLACED'
            ? Math.max(
                0,
                Math.floor((o.placedAt.getTime() + windowSeconds * 1000 - now) / 1000),
              )
            : null,
        // ADR-003: the rider's pickup button unlocks when the order is READY.
        // The shop's "confirm handover" is a permission grant, not a state
        // write, and this flag is what the dashboard shows it for.
        awaitingRiderPickup: o.status === 'READY' && o.task?.status === 'ASSIGNED',
      })),
    };
  }

  /** FR-SHP-02, FR-SHP-03 */
  async acceptOrder(user: AuthenticatedUser, orderId: string, dto: AcceptOrderDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        collegeId: true,
        shopListingId: true,
        status: true,
        reference: true,
        statedPrepMinutes: true,
        placedAt: true,
        task: { select: { id: true, status: true } },
        shopListing: {
          select: {
            college: {
              select: {
                config: {
                  select: { dispatchLeadMinutes: true, shopAcceptWindowSeconds: true },
                },
              },
            },
          },
        },
      },
    });

    this.tenant.assertSameTenant(user, order, 'Order');
    await this.assertShopAccess(user, order!.shopListingId);

    if (order!.status !== 'PLACED') {
      throw new ConflictException({
        code: 'NOT_AWAITING_ACCEPTANCE',
        message: `That order is already ${order!.status.toLowerCase().replace(/_/g, ' ')}.`,
      });
    }

    const windowSeconds = order!.shopListing.college.config?.shopAcceptWindowSeconds ?? 300;
    if (order!.placedAt.getTime() + windowSeconds * 1000 < Date.now()) {
      throw new ConflictException({
        code: 'ACCEPT_WINDOW_EXPIRED',
        message: 'The acceptance window for this order has passed and it has been cancelled.',
      });
    }

    const prepMinutes = dto.prepMinutes ?? order!.statedPrepMinutes ?? 15;
    const leadMinutes = order!.shopListing.college.config?.dispatchLeadMinutes ?? 7;

    const now = new Date();
    const expectedReadyAt = new Date(now.getTime() + prepMinutes * 60_000);

    /**
     * FR-DLV-01: broadcast when the remaining preparation time drops below
     * the lead threshold, so the rider arrives near the ready time rather
     * than standing at the counter.
     *
     * If the food takes less time than the lead, there is nothing to wait
     * for — dispatch is due immediately.
     */
    const dispatchDueAt = new Date(
      Math.max(now.getTime(), expectedReadyAt.getTime() - leadMinutes * 60_000),
    );

    await this.prisma.$transaction(async (tx) => {
      // FR-SHP-03: acceptance flows straight through to PREPARING.
      assertOrderTransition(order!.status as OrderStatus, OrderEvent.SHOP_ACCEPTED);
      assertOrderTransition(OrderStatus.SHOP_ACCEPTED, OrderEvent.PREPARATION_STARTED);

      // Conditional on PLACED. The check further up read the status before
      // this transaction began; a student cancel or the accept-window sweep
      // can land in between, and an unconditional write here would bring a
      // cancelled — and already refunded — order back to life.
      const accepted = await tx.order.updateMany({
        where: { id: orderId, status: DbOrderStatus.PLACED },
        data: {
          status: DbOrderStatus.PREPARING,
          shopAcceptedAt: now,
          statedPrepMinutes: prepMinutes,
          expectedReadyAt,
        },
      });
      if (accepted.count === 0) throw this.orderStateChanged();

      if (order!.task) {
        // Same guard on the task: only one that is still waiting may be
        // scheduled for dispatch. A cancelled task given a dispatchDueAt
        // would be ignored by the dispatcher today, but should not depend on
        // that.
        const scheduled = await tx.task.updateMany({
          where: { id: order!.task.id, status: 'CREATED' },
          data: { dispatchDueAt },
        });
        if (scheduled.count === 0) throw this.orderStateChanged();
      }
    });

    this.logger.log(
      `Order ${order!.reference} accepted, prep ${prepMinutes}m, dispatch due ${dispatchDueAt.toISOString()}`,
    );

    return {
      orderId,
      status: 'PREPARING',
      prepMinutes,
      expectedReadyAt,
      dispatchDueAt,
      message: `Accepted. A rider will be called at about ${dispatchDueAt.toLocaleTimeString(
        'en-IN',
      )}, ${leadMinutes} minutes before the order is due.`,
    };
  }

  /** FR-SHP-04 */
  async rejectOrder(user: AuthenticatedUser, orderId: string, dto: RejectOrderDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        collegeId: true,
        shopListingId: true,
        status: true,
        studentId: true,
        reference: true,
        paymentMethod: true,
        totalMinor: true,
        task: { select: { id: true, status: true } },
      },
    });

    this.tenant.assertSameTenant(user, order, 'Order');
    await this.assertShopAccess(user, order!.shopListingId);

    if (order!.status !== 'PLACED') {
      throw new ConflictException({
        code: 'NOT_AWAITING_ACCEPTANCE',
        message: 'That order can no longer be rejected.',
      });
    }

    await this.transitionOrderAndTask({
      orderId: order!.id,
      taskId: order!.task?.id ?? null,
      orderEvent: OrderEvent.SHOP_REJECTED,
      taskEvent: TaskEvent.SHOP_CANCELLED,
      orderData: {
        cancelledAt: new Date(),
        cancelledBy: 'SHOP',
        cancelledReason: dto.reason,
      },
      // FR-SHP-04: any held wallet amount is released.
      releaseWalletHold: order!.paymentMethod === PaymentMethod.WALLET,
      walletAmountMinor: order!.totalMinor,
      userId: order!.studentId,
      reference: order!.reference,
    });

    return {
      orderId,
      status: 'CANCELLED',
      // What went back to the student's wallet: the held total for a wallet
      // order, nothing for cash. The shop sees a number, not a guess.
      refundedMinor: order!.paymentMethod === PaymentMethod.WALLET ? order!.totalMinor : 0,
      message: 'Order rejected and the student notified.',
    };
  }

  /** FR-SHP-05 */
  async markReady(user: AuthenticatedUser, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        collegeId: true,
        shopListingId: true,
        status: true,
        reference: true,
        task: { select: { id: true, status: true } },
      },
    });

    this.tenant.assertSameTenant(user, order, 'Order');
    await this.assertShopAccess(user, order!.shopListingId);

    // An order that is no longer PREPARING — cancelled a moment ago, or
    // already marked ready from a second tablet — is a lost race, not a
    // server fault: resolveOrderTransition answers it with 409 rather than
    // letting the state machine's bare Error surface as a 500.
    const nextStatus = resolveOrderTransition(
      order!.status as OrderStatus,
      OrderEvent.MARKED_READY,
    );

    // Conditional on the status the transition was computed from, so an
    // administrator's cancel landing between the read and this write is not
    // overwritten with READY.
    const marked = await this.prisma.order.updateMany({
      where: { id: orderId, status: order!.status },
      data: { status: nextStatus as DbOrderStatus, readyAt: new Date() },
    });
    if (marked.count === 0) throw this.orderStateChanged();

    return {
      orderId,
      status: nextStatus,
      // ADR-003: this is a permission grant, not a state write on the task.
      message:
        order!.task?.status === 'ASSIGNED'
          ? 'Marked ready. The rider can now confirm pickup.'
          : 'Marked ready. Waiting for a rider to be assigned.',
    };
  }

  // =======================================================================
  // Shared transition helper
  // =======================================================================

  /**
   * Move an order and its task together, inside one transaction.
   *
   * Cancellation touches two state machines and possibly the ledger. Doing
   * that in three separate writes would leave a cancelled order with a live
   * task if the second one failed, and the task would then be broadcast for
   * an order that no longer exists.
   *
   * Each status write is a conditional UPDATE (ADR-001). The status is read
   * only to ask the state machine where the event leads; whether this caller
   * is the one that gets to make the move is decided by the WHERE clause.
   * Two cancels arriving together both read PLACED, one update matches a row
   * and the other matches none — and the loser throws before the ledger is
   * touched, which is what keeps a hold from being released twice.
   */
  private async transitionOrderAndTask(params: {
    orderId: string;
    taskId: string | null;
    orderEvent: OrderEvent;
    taskEvent: TaskEvent;
    orderData: Prisma.OrderUpdateManyMutationInput;
    releaseWalletHold: boolean;
    walletAmountMinor: number;
    userId: string;
    reference: string;
  }): Promise<void> {
    const {
      orderId,
      taskId,
      orderEvent,
      taskEvent,
      orderData,
      releaseWalletHold,
      walletAmountMinor,
      userId,
      reference,
    } = params;

    await this.prisma.$transaction(async (tx) => {
      // Wallet lock first, before any row is written, so that every
      // wallet-writing transaction takes its locks in the same order.
      if (releaseWalletHold) await this.lockWallet(tx, userId);

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (!order) throw new NotFoundException('Order not found');

      // Requests that lose a race queue on the wallet lock above, so by the
      // time they read the order here it is already CANCELLED and the state
      // machine has no move for it. That is the same lost race the
      // conditional UPDATE below reports, so it gets the same 409 — thrown
      // from the state machine's own Error it would reach the caller as a
      // 500. This only words the refusal; the UPDATE still decides.
      const nextOrderStatus = resolveOrderTransition(order.status as OrderStatus, orderEvent);

      const orderMoved = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: {
          ...orderData,
          status: nextOrderStatus as DbOrderStatus,
          // A released hold is money returned, and the order has to say so:
          // left at HELD, a cancelled order would claim to be sitting on
          // funds the ledger shows were given back. Written in the same
          // UPDATE as the status, so the two cannot disagree. Cash orders
          // never held anything and keep NOT_REQUIRED.
          ...(releaseWalletHold ? { paymentStatus: 'REFUNDED' as const } : {}),
        },
      });
      if (orderMoved.count === 0) throw this.orderStateChanged();

      if (taskId) {
        const task = await tx.task.findUnique({
          where: { id: taskId },
          select: { status: true },
        });

        // A task that has already moved on (a rider picked it up between the
        // read and here) must not be forced backwards. The state machine
        // refuses, and refusing is correct: the cancellation is too late.
        if (task) {
          const nextTaskStatus = resolveTaskTransition(task.status as TaskStatus, taskEvent);

          // Conditional on the status just read: a rider accepting in the
          // gap (ADR-001's own UPDATE) changes it, this matches nothing, and
          // the whole cancellation rolls back rather than cancelling a task
          // someone is now carrying.
          const taskMoved = await tx.task.updateMany({
            where: { id: taskId, status: task.status },
            data: { status: nextTaskStatus as never, cancelledAt: new Date() },
          });
          if (taskMoved.count === 0) throw this.orderStateChanged();
        }
      }

      // FR-SHP-04 / FR-PAY-06: release the hold as a compensating entry. The
      // ledger is append-only (ADR-007), so a release is a new credit rather
      // than an edit to the original debit.
      if (releaseWalletHold) {
        const { balanceMinor: balance, nextCreatedAt } = await readWalletHead(tx, userId);
        await tx.walletEntry.create({
          data: {
            userId,
            direction: 'CREDIT',
            amountMinor: walletAmountMinor,
            type: 'ORDER_RELEASE',
            orderId,
            balanceAfterMinor: balance + walletAmountMinor,
            // Strictly after the entry this balance was read from, so the
            // ledger has one unambiguous latest row (see wallet-ledger.ts).
            createdAt: nextCreatedAt,
            note: `Hold released for cancelled order ${reference}`,
          },
        });
      }
    });
  }

  /**
   * May this user act on this shop listing's orders?
   *
   * Tenancy is checked first and for everyone. An administrator's authority
   * stops at their own college (FR-TEN-03), so the listing's college is
   * loaded and compared before the role is even looked at; only a super
   * administrator, who works across tenants by definition, passes
   * assertSameTenant unconditionally. Returning early for ADMIN before this
   * check is what once let an admin of one college read another's queue.
   */
  private async assertShopAccess(user: AuthenticatedUser, listingId: string): Promise<void> {
    const listing = await this.prisma.shopListing.findUnique({
      where: { id: listingId },
      select: {
        collegeId: true,
        shop: { select: { staff: { select: { userId: true } } } },
      },
    });

    this.tenant.assertSameTenant(user, listing, 'Shop');

    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return;

    const isStaff = listing!.shop.staff.some((s) => s.userId === user.userId);
    if (!isStaff) {
      throw new ForbiddenException({
        code: 'NOT_SHOP_STAFF',
        message: 'You do not manage this shop.',
      });
    }
  }

  // =======================================================================
  // Conflict responses
  // =======================================================================

  /**
   * A conditional UPDATE matched no row: the order moved on between this
   * request reading it and trying to change it. 409 rather than 400 because
   * the request was well-formed — it simply lost a race — and the right move
   * for the client is to reload and look again.
   */
  private orderStateChanged(): ConflictException {
    // One definition, shared with the state-machine translation, so a lost
    // race reads the same whichever of the two noticed it.
    return orderStateChanged();
  }

  /** The unfulfilled-order choice was already made by a parallel request. */
  private alreadyDecided(): ConflictException {
    return new ConflictException({
      code: 'NOT_UNFULFILLED',
      message: 'This order is not waiting on a decision.',
    });
  }

  private notReadyToCollect(): ConflictException {
    return new ConflictException({
      code: 'ORDER_NOT_READY',
      message:
        'The shop has not finished preparing this order yet. You can collect it once it is marked ready.',
    });
  }

  private insufficientWalletBalance(balanceMinor: number, totalMinor: number): BadRequestException {
    return new BadRequestException({
      code: 'INSUFFICIENT_WALLET_BALANCE',
      message: `Your wallet has ${formatMinor(balanceMinor)}, and this order is ${formatMinor(
        totalMinor,
      )}. Choose cash on delivery instead.`,
    });
  }

  // =======================================================================
  // Wallet balance helpers
  // =======================================================================

  /**
   * Serialise every writer to one user's wallet for the rest of the
   * transaction.
   *
   * The ledger has no balance row to lock: the balance is whatever the latest
   * entry says, and each new entry is computed from it. Two transactions that
   * both read the same "latest" entry both write a balance derived from it,
   * and one of the two movements silently vanishes from the running total —
   * or, at placement, the same money is held twice.
   *
   * An advisory lock is a lock on a number rather than on a row, which is
   * what is needed when the thing being protected is "the next row" and does
   * not exist yet. The `_xact_` variant is released automatically at commit
   * or rollback, so it cannot leak. The key must be byte-for-byte the same
   * expression everywhere the wallet is written (rider.service.ts uses it
   * too); a different prefix would be a different lock and protect nothing.
   *
   * Call it first, before the transaction writes anything, and read the
   * balance only afterwards. $executeRaw rather than $queryRaw because the
   * function returns `void`, which Prisma cannot deserialise as a result
   * column.
   */
  private async lockWallet(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wallet:' || ${userId}))`;
  }

  /**
   * The current balance, read from the last ledger entry rather than summed.
   *
   * Each entry carries `balanceAfterMinor`, so the balance is one indexed
   * read. Summing the whole ledger would be correct but gets slower with every
   * transaction, and the carried balance also makes a mismatch visible.
   */
  async walletBalance(userId: string): Promise<number> {
    const last = await this.prisma.walletEntry.findFirst({
      where: { userId },
      // createdAt alone can tie at millisecond precision; the shared order
      // adds a tie-break so the same row is "latest" on every read.
      orderBy: [...WALLET_HEAD_ORDER],
      select: { balanceAfterMinor: true },
    });
    return last?.balanceAfterMinor ?? 0;
  }
}
