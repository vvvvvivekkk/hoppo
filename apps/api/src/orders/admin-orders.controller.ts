import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOrdersService } from './admin-orders.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * The administrator's view of orders (A-02, A-07; FR-ADM-05; SRS §12.3).
 *
 * @Roles('ADMIN') on the class, so a route added here later is closed by
 * default. A super administrator passes every role check (RolesGuard). The
 * role only says "an administrator"; *which college's* orders is decided in
 * the service from the token, never from the request.
 *
 * Query parameters are read one by one rather than through a DTO: every one
 * of them is optional free text that the service validates and answers with
 * its own error code (INVALID_DATE, INVALID_STATUS ...), which is more useful
 * to a console than a generic validation failure.
 */
@ApiTags('admin orders')
@Controller('admin/orders')
@Roles('ADMIN')
export class AdminOrdersController {
  constructor(private readonly report: AdminOrdersService) {}

  @Get()
  @ApiOperation({ summary: 'Orders for my college, filtered and paginated' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string | string[],
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('listingId') listingId?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('collegeId') collegeId?: string,
  ) {
    return this.report.list(user, { status, from, to, listingId, q, limit, cursor, collegeId });
  }

  // Declared before ':orderId'. Nest matches routes in declaration order, and
  // the other way round "summary" would be looked up as an order id.
  @Get('summary')
  @ApiOperation({ summary: 'Counts, money and timings for a date range (FR-ADM-05)' })
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('collegeId') collegeId?: string,
  ) {
    return this.report.summary(user, { from, to, collegeId });
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'One order with its timeline, items, task and ledger entries' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('orderId') orderId: string) {
    return this.report.detail(user, orderId);
  }
}
