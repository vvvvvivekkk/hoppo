import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlatformService } from './platform.service';
import {
  CreateCollegeAdminDto,
  CreateCollegeDto,
  ReasonDto,
  SetAdminPasswordDto,
} from './dto/platform.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * Tenant management (A-16, A-18; FR-TEN-01, FR-ADM-07).
 *
 * @Roles('SUPER_ADMIN') on the class: RolesGuard admits a super administrator
 * everywhere, but it admits nobody else to a route that lists only that role
 * — a college ADMIN gets 403 here.
 */
@ApiTags('platform')
@Controller('platform')
@Roles('SUPER_ADMIN')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('colleges')
  @ApiOperation({ summary: 'Every college tenant, active or not' })
  colleges(@CurrentUser() user: AuthenticatedUser) {
    return this.platform.listColleges(user);
  }

  /** FR-TEN-01 */
  @Post('colleges')
  @ApiOperation({ summary: 'Create a college tenant with its default configuration' })
  createCollege(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCollegeDto) {
    return this.platform.createCollege(user, dto);
  }

  @Get('colleges/:collegeId')
  @ApiOperation({ summary: 'One college with its administrators' })
  college(
    @CurrentUser() user: AuthenticatedUser,
    @Param('collegeId', ParseUUIDPipe) collegeId: string,
  ) {
    return this.platform.collegeDetail(user, collegeId);
  }

  /** FR-ADM-07 */
  @Post('colleges/:collegeId/deactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Deactivate a college tenant (data is kept)' })
  deactivateCollege(
    @CurrentUser() user: AuthenticatedUser,
    @Param('collegeId', ParseUUIDPipe) collegeId: string,
    @Body() dto: ReasonDto,
  ) {
    return this.platform.setCollegeStatus(user, collegeId, 'INACTIVE', dto.reason);
  }

  @Post('colleges/:collegeId/activate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reactivate a college tenant' })
  activateCollege(
    @CurrentUser() user: AuthenticatedUser,
    @Param('collegeId', ParseUUIDPipe) collegeId: string,
  ) {
    return this.platform.setCollegeStatus(user, collegeId, 'ACTIVE');
  }

  /** FR-ADM-07: "assign administrators to them". */
  @Post('colleges/:collegeId/admins')
  @ApiOperation({ summary: 'Create an administrator account for a college' })
  createAdmin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('collegeId', ParseUUIDPipe) collegeId: string,
    @Body() dto: CreateCollegeAdminDto,
  ) {
    return this.platform.createCollegeAdmin(user, collegeId, dto);
  }

  @Post('admins/:userId/deactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Deactivate a college administrator, ending their sessions' })
  deactivateAdmin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReasonDto,
  ) {
    return this.platform.setAdminStatus(user, userId, 'DEACTIVATED', dto.reason);
  }

  @Post('admins/:userId/reactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reactivate a college administrator' })
  reactivateAdmin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.platform.setAdminStatus(user, userId, 'ACTIVE');
  }

  @Post('admins/:userId/password')
  @HttpCode(200)
  @ApiOperation({ summary: "Set a college administrator's password, ending their sessions" })
  setAdminPassword(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetAdminPasswordDto,
  ) {
    return this.platform.setAdminPassword(user, userId, dto.password);
  }
}
