import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { RiderPresenceQueryDto } from './dto/presence.dto';
import { RiderPresenceService } from './presence.service';

/**
 * Rider supply for the operational dashboard (FR-ADM-05, screen A-14).
 *
 * `@Roles` on the controller, so anything added here is administrator-only
 * by default; the college comes from the token through TenantService.
 */
@ApiTags('admin: riders')
@Controller('admin/riders')
@Roles('ADMIN')
export class RiderPresenceController {
  constructor(private readonly presence: RiderPresenceService) {}

  @Get('presence')
  @ApiOperation({ summary: 'Active riders by hour for my college, over a date range' })
  byHour(@CurrentUser() user: AuthenticatedUser, @Query() query: RiderPresenceQueryDto) {
    return this.presence.byHour(user, query.from, query.to);
  }
}
