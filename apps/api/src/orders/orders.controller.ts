import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MY_ORDERS_DEFAULT_LIMIT, OrdersService } from './orders.service';
import { AdminOrdersService } from './admin-orders.service';
import { clampPageLimit } from '../common/pagination';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequireVerified } from '../common/decorators/require-verified.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  AcceptOrderDto,
  CancelOrderDto,
  PlaceOrderDto,
  QuoteOrderDto,
  RejectOrderDto,
  UnfulfilledChoiceDto,
} from './dto/orders.dto';

/**
 * Student ordering (S-14 .. S-22).
 *
 * @RequireVerified on the controller: FR-SVER-01 bars an unverified student
 * from placing orders, and putting it here means a new endpoint added to this
 * controller is gated by default rather than by remembering.
 *
 * @Roles('STUDENT') on the controller for the same reason. Without it the
 * RolesGuard treats these endpoints as open to any signed-in account, so a
 * shop or administrator login could quote and place orders. A rider is a
 * student, so riders are unaffected.
 */
@ApiTags('orders')
@Controller('orders')
@Roles('STUDENT')
@RequireVerified()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** FR-ORD-03: the breakdown shown before confirmation. */
  @Post('quote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Price a cart without placing it' })
  quote(@CurrentUser() user: AuthenticatedUser, @Body() dto: QuoteOrderDto) {
    return this.orders.quote(user, dto);
  }

  /** FR-ORD-04, FR-ORD-06 */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  @ApiOperation({ summary: 'Place an order' })
  place(@CurrentUser() user: AuthenticatedUser, @Body() dto: PlaceOrderDto) {
    return this.orders.place(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'My orders, most recent first' })
  myOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    // The raw query string is untrusted: "abc" becomes NaN and a very large
    // number becomes an unbounded read. clampPageLimit turns anything that
    // is not a whole number into the default and caps the rest at 1..100.
    return this.orders.myOrders(user, clampPageLimit(limit, MY_ORDERS_DEFAULT_LIMIT), cursor);
  }

  // Overrides the class-level role list (RolesGuard reads the handler before
  // the class). OrdersService.orderDetail deliberately serves the shop's
  // staff and the college's administrators as well as the student, and does
  // its own ownership and tenancy checks; restricting this one route to
  // STUDENT would lock them out of an order they are entitled to see.
  @Roles('STUDENT', 'SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')
  @Get(':orderId')
  @ApiOperation({ summary: 'One order, with live task and rider state' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('orderId') orderId: string) {
    return this.orders.orderDetail(user, orderId);
  }

  /**
   * S-21: a draft cart from a past order, priced from today's menu. A GET
   * because it changes nothing — no order is placed and nothing is reserved.
   */
  @Get(':orderId/reorder')
  @ApiOperation({ summary: 'A draft cart from a past order, at current prices and availability' })
  reorder(@CurrentUser() user: AuthenticatedUser, @Param('orderId') orderId: string) {
    return this.orders.reorderDraft(user, orderId);
  }

  /** FR-ORD-05 */
  @Post(':orderId/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an order, free before preparation begins' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.orders.cancelByStudent(user, orderId, dto);
  }

  /** FR-DLV-07 */
  @Post(':orderId/unfulfilled')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decide what to do when no rider was found' })
  resolveUnfulfilled(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: UnfulfilledChoiceDto,
  ) {
    return this.orders.resolveUnfulfilled(user, orderId, dto.choice);
  }
}

/** The shop dashboard's order queue (D-08, D-09). */
@ApiTags('shop orders')
@Controller('shops/:listingId/orders')
@Roles('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')
export class ShopOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly report: AdminOrdersService,
  ) {}

  /**
   * D-10: orders that are over. The queue below only ever holds orders still
   * in play; a completed or cancelled one is found here, a page at a time.
   */
  @Get('history')
  @ApiOperation({ summary: 'Completed and cancelled orders for this shop, paginated' })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Query('status') status?: string | string[],
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.report.shopHistory(user, listingId, { status, from, to, limit, cursor });
  }

  /** FR-SHP-01 */
  @Get()
  @ApiOperation({ summary: 'Live order queue in arrival order' })
  queue(@CurrentUser() user: AuthenticatedUser, @Param('listingId') listingId: string) {
    return this.orders.shopQueue(user, listingId);
  }

  /** FR-SHP-02, FR-SHP-03 */
  @Post(':orderId/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Accept an order, optionally revising the preparation time' })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: AcceptOrderDto,
  ) {
    return this.orders.acceptOrder(user, orderId, dto);
  }

  /** FR-SHP-04 */
  @Post(':orderId/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject an order with a reason' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: RejectOrderDto,
  ) {
    return this.orders.rejectOrder(user, orderId, dto);
  }

  /** FR-SHP-05 */
  @Post(':orderId/ready')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark an order packed and ready, unlocking rider pickup' })
  ready(@CurrentUser() user: AuthenticatedUser, @Param('orderId') orderId: string) {
    return this.orders.markReady(user, orderId);
  }
}
