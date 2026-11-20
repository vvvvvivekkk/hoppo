import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ShopSettlementsService } from './shop-settlements.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * D-14: a shop's settlement statement.
 *
 * @Roles names the owner and the administrator; SHOP_STAFF is left out on
 * purpose, so counter staff are refused by the guard before the service is
 * reached. The role only says "a shop owner" — whether it is the owner of
 * THIS shop is checked in the service against the shop's staff list. An
 * unapproved shop account is already refused by the global ShopApprovalGuard.
 *
 * One GET and nothing else: there is no endpoint here that pays anyone or
 * stores where to pay them.
 */
@ApiTags('shop settlements')
@Controller('shops/:listingId/settlements')
@Roles('SHOP_OWNER', 'ADMIN')
export class ShopSettlementsController {
  constructor(private readonly settlements: ShopSettlementsService) {}

  @Get()
  @ApiOperation({
    summary: 'Settlement statement for a period: totals, position and per-order lines',
  })
  statement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.settlements.statement(user, listingId, { from, to, limit, cursor });
  }
}
