import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { EscalationQueueQueryDto, ResolveEscalationDto } from './dto/escalation.dto';
import { EscalationsService } from './escalations.service';

/**
 * The administrator's escalated-task queue (FR-ADM-04, screen A-08).
 *
 * `@Roles` is on the controller rather than each method, so an endpoint added
 * here is restricted by default rather than open by default. The college is
 * never taken from the request: the service scopes every read and checks
 * every single task through TenantService (C-1).
 *
 * It lives in the rider module because resolving an escalation as delivered
 * *is* a delivery being settled — the same function the rider's handover code
 * runs — and that function belongs to RiderService.
 */
@ApiTags('admin: escalations')
@Controller('admin/escalations')
@Roles('ADMIN')
export class EscalationsController {
  constructor(private readonly escalations: EscalationsService) {}

  @Get()
  @ApiOperation({ summary: 'Escalated tasks for my college, longest-waiting first' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: EscalationQueueQueryDto) {
    return this.escalations.list(user, query.limit, query.cursor);
  }

  @Get(':taskId')
  @ApiOperation({ summary: 'One escalated task, including how it was resolved' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('taskId') taskId: string) {
    return this.escalations.detail(user, taskId);
  }

  /**
   * A resolution settles or cancels a delivery; it is not something to do
   * thirty times a minute. Per administrator, like every other limit here.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':taskId/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve an escalated task as delivered or not delivered, with a note' })
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId') taskId: string,
    @Body() dto: ResolveEscalationDto,
  ) {
    return this.escalations.resolve(user, taskId, dto);
  }
}
