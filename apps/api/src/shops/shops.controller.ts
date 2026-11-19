import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ShopsService } from './shops.service';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  BrowseShopsQueryDto,
  DistanceCheckDto,
  RegisterShopDto,
  RejectShopDto,
  SuspendShopDto,
  UpdateRadiusDto,
} from './dto/shops.dto';

/** Shop owner registration and self-service (D-02 .. D-07). */
@ApiTags('shops')
@Controller('shops')
export class ShopsController {
  constructor(private readonly shops: ShopsService) {}

  /**
   * D-03 / D-04: before committing to a registration, show the owner the
   * measured distance and whether it is inside the radius.
   *
   * Public, because it happens before the owner has an account. Rate limited
   * because each call may hit a paid geocoding API.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('distance-check')
  @HttpCode(200)
  @ApiOperation({ summary: 'Measure the geodesic distance to a college and check the radius' })
  checkDistance(@Body() dto: DistanceCheckDto) {
    return this.shops.checkDistance(dto);
  }

  /** FR-SHOP-01 .. FR-SHOP-09 */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Register a shop and create the owner account' })
  register(@Body() dto: RegisterShopDto) {
    return this.shops.register(dto);
  }

  /** D-07: the owner's own shops and their verification state. */
  @Roles('SHOP_OWNER', 'SHOP_STAFF')
  @Get('mine')
  @ApiOperation({ summary: 'Shops I manage' })
  myShops(@CurrentUser() user: AuthenticatedUser) {
    return this.shops.myShops(user);
  }
}

/**
 * Student-facing browse (S-10, S-11, S-12).
 *
 * Deliberately not behind @RequireVerified: FR-SVER-01 gives an unverified
 * student read-only access to shop catalogs, and taking that away would leave
 * someone waiting on an administrator with an empty app.
 */
@ApiTags('browse')
@Controller('browse')
export class BrowseController {
  constructor(private readonly shops: ShopsService) {}

  /** FR-CAT-06 */
  @Get('shops')
  @ApiOperation({ summary: 'Active shops at my college, filtered and sorted' })
  browse(@CurrentUser() user: AuthenticatedUser, @Query() query: BrowseShopsQueryDto) {
    return this.shops.browse(user, {
      category: query.category,
      q: query.q,
      sort: query.sort,
      openNow: query.openNow,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  /** FR-CAT-06: item search across every active shop in the college. */
  @Get('items')
  @ApiOperation({ summary: 'Search catalog items across my college' })
  searchItems(@CurrentUser() user: AuthenticatedUser, @Query('q') q: string) {
    return this.shops.searchItems(user, q ?? '');
  }

  @Get('shops/:listingId')
  @ApiOperation({ summary: 'One shop with its catalog' })
  shopDetail(@CurrentUser() user: AuthenticatedUser, @Param('listingId') listingId: string) {
    return this.shops.shopDetail(user, listingId);
  }
}

/** Administrator shop verification (A-05, A-06, A-09). */
@ApiTags('admin: shops')
@Controller('admin/shops')
@Roles('ADMIN')
export class AdminShopsController {
  constructor(private readonly shops: ShopsService) {}

  /** FR-SHOP-10 */
  @Get('queue')
  @ApiOperation({ summary: 'Shops awaiting verification, with distance and documents' })
  queue(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.shops.queue(user, limit ? Number(limit) : 25, cursor);
  }

  /** NFR-S-03: access is logged. */
  @Get(':listingId/documents/:documentId')
  @ApiOperation({ summary: 'A signed URL for one shop document (access is audited)' })
  viewDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.shops.viewDocument(user, listingId, documentId);
  }

  /** FR-SHOP-11 */
  @Post(':listingId/approve')
  @ApiOperation({ summary: 'Approve a shop for my college' })
  approve(@CurrentUser() user: AuthenticatedUser, @Param('listingId') listingId: string) {
    return this.shops.approve(user, listingId);
  }

  @Post(':listingId/reject')
  @ApiOperation({ summary: 'Reject a shop with a reason' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Body() dto: RejectShopDto,
  ) {
    return this.shops.reject(user, listingId, dto);
  }

  /** FR-SHOP-12 */
  @Post(':listingId/suspend')
  @ApiOperation({ summary: 'Suspend a shop, letting in-flight orders complete' })
  suspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Body() dto: SuspendShopDto,
  ) {
    return this.shops.suspend(user, listingId, dto);
  }
}

/** College configuration (A-09). */
@ApiTags('admin: college')
@Controller('admin/college')
@Roles('ADMIN')
export class AdminCollegeController {
  constructor(private readonly shops: ShopsService) {}

  /** FR-TEN-04, FR-TEN-05 */
  @Patch('radius')
  @ApiOperation({ summary: 'Change the serviceable radius (1 km to 5 km)' })
  updateRadius(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateRadiusDto) {
    return this.shops.updateRadius(user, dto);
  }

  /** FR-TEN-05: shops left outside a reduced radius. */
  @Get('radius/flagged')
  @ApiOperation({ summary: 'Approved shops now outside the radius, flagged for review' })
  flagged(@CurrentUser() user: AuthenticatedUser) {
    return this.shops.flaggedForRadiusReview(user);
  }
}
