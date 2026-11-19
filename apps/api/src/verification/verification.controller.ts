import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { VerificationService } from './verification.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  ApproveVerificationDto,
  RejectVerificationDto,
  SubmitVerificationDto,
  SuspendStudentDto,
  VerificationQueueQueryDto,
} from './dto/verification.dto';

/**
 * The student's own view of their verification (S-07, S-08, S-09).
 *
 * @Roles('STUDENT') on the controller: identity verification and rider terms
 * exist only for student accounts. Without it these were open to any
 * signed-in role and relied on "no student profile" turning into a 404.
 */
@ApiTags('verification')
@Controller('verification')
@Roles('STUDENT')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get('me')
  @ApiOperation({ summary: 'My verification status and what it unlocks' })
  myStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.verification.myStatus(user);
  }

  /** FR-SVER-02 */
  @Post('submit')
  @ApiOperation({ summary: 'Submit identity details for verification' })
  submit(@CurrentUser() user: AuthenticatedUser, @Body() dto: SubmitVerificationDto) {
    return this.verification.submit(user, dto);
  }

  /** FR-WM-02 */
  @Post('rider-terms/accept')
  @ApiOperation({ summary: 'Accept the rider terms of service' })
  acceptRiderTerms(@CurrentUser() user: AuthenticatedUser) {
    return this.verification.acceptRiderTerms(user);
  }
}

/**
 * The administrator's queue (A-03, A-04).
 *
 * @Roles on the controller rather than each method, so a new endpoint added
 * here is restricted by default rather than open by default.
 */
@ApiTags('admin: verification')
@Controller('admin/verification')
@Roles('ADMIN')
export class AdminVerificationController {
  constructor(private readonly verification: VerificationService) {}

  /** FR-SVER-04, FR-ADM-01 */
  @Get('queue')
  @ApiOperation({ summary: 'Pending student verifications for my college' })
  queue(@CurrentUser() user: AuthenticatedUser, @Query() query: VerificationQueueQueryDto) {
    return this.verification.queue(user, query.limit, query.cursor);
  }

  /** NFR-S-03: every document access is logged. */
  @Get(':id/documents')
  @ApiOperation({ summary: 'View the submitted documents (access is audited)' })
  viewDocument(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.verification.viewDocument(user, id);
  }

  /** FR-SVER-05 */
  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a verification submission' })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ApproveVerificationDto,
  ) {
    return this.verification.approve(user, id, dto);
  }

  /** FR-SVER-05: the reason is mandatory and from a controlled list. */
  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a verification submission with a reason' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectVerificationDto,
  ) {
    return this.verification.reject(user, id, dto);
  }

  /** FR-SVER-08 */
  @Post('students/:studentId/suspend')
  @ApiOperation({ summary: 'Suspend a student, ending sessions and releasing any task' })
  suspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('studentId') studentId: string,
    @Body() dto: SuspendStudentDto,
  ) {
    return this.verification.suspend(user, studentId, dto);
  }

  @Post('students/:studentId/reinstate')
  @ApiOperation({ summary: 'Lift a suspension' })
  reinstate(@CurrentUser() user: AuthenticatedUser, @Param('studentId') studentId: string) {
    return this.verification.reinstate(user, studentId);
  }
}
