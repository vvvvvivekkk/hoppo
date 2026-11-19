import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RiderService } from './rider.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireVerified } from '../common/decorators/require-verified.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  AbandonTaskDto,
  ConfirmPickupDto,
  RiderPingDto,
  SetWorkModeDto,
  SubmitHandoverOtpDto,
} from './dto/rider.dto';

/**
 * The rider half of the student app (S-24 .. S-32).
 *
 * FR-SVER-01 bars an unverified student from work mode, so the whole
 * controller is gated.
 *
 * H6: `@RequireVerified()` alone is not that gate. VerifiedGuard waves through
 * every role that is not STUDENT — staff are "not subject to student
 * verification" — so on its own it let a shop owner, shop staff or admin
 * account go online, accept tasks and be paid for deliveries, having never
 * been verified as anything. Riders are verified students (FR-WM-01), and
 * `@Roles('STUDENT')` is what says so. The two decorators are a pair: one
 * picks the role, the other checks that role's verification.
 */
@ApiTags('rider')
@Controller('rider')
@Roles('STUDENT')
@RequireVerified()
export class RiderController {
  constructor(private readonly rider: RiderService) {}

  /** FR-WM-08: the Work tab. */
  @Get('status')
  @ApiOperation({ summary: 'Work mode state, active task, and earnings totals' })
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.rider.workStatus(user);
  }

  /** FR-WM-01, FR-WM-05 */
  @Post('work-mode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Go online or offline' })
  setWorkMode(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetWorkModeDto) {
    return this.rider.setWorkMode(user, dto);
  }

  /**
   * FR-WM-03. Normally this goes over the WebSocket, since it happens every
   * fifteen seconds; this is the fallback when the socket is down.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('ping')
  @HttpCode(200)
  @ApiOperation({ summary: 'Report position (HTTP fallback for the socket)' })
  ping(@CurrentUser() user: AuthenticatedUser, @Body() dto: RiderPingDto) {
    return this.rider.ping(user, dto.latitude, dto.longitude);
  }

  /**
   * FR-DLV-04: first accept wins.
   *
   * Rate limited per NFR-S-06, but generously and *per rider* rather than per
   * IP — see UserThrottlerGuard. A rider in a busy spell sees many offers,
   * and a duplicate accept is harmless because the conditional UPDATE makes
   * the second one a no-op rather than a second assignment.
   */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('tasks/:taskId/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Accept a task offer' })
  accept(@CurrentUser() user: AuthenticatedUser, @Param('taskId') taskId: string) {
    return this.rider.acceptTask(user, taskId);
  }

  /** FR-DLV-08 */
  @Post('tasks/:taskId/abandon')
  @HttpCode(200)
  @ApiOperation({ summary: 'Return an accepted task to the pool, before pickup' })
  abandon(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId') taskId: string,
    @Body() dto: AbandonTaskDto,
  ) {
    return this.rider.abandonTask(user, taskId, dto);
  }

  @Get('tasks/:taskId')
  @ApiOperation({ summary: 'The active task, with what to pay and collect' })
  taskDetail(@CurrentUser() user: AuthenticatedUser, @Param('taskId') taskId: string) {
    return this.rider.activeTaskDetail(user, taskId);
  }

  /** FR-DLV-11, FR-DLV-12 */
  @Post('tasks/:taskId/pickup')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm pickup, which issues the handover code' })
  pickup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId') taskId: string,
    @Body() dto: ConfirmPickupDto,
  ) {
    return this.rider.confirmPickup(user, taskId, dto);
  }

  /** FR-DLV-13, FR-DLV-14 */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('tasks/:taskId/handover')
  @HttpCode(200)
  @ApiOperation({ summary: 'Enter the handover code to complete the delivery' })
  handover(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId') taskId: string,
    @Body() dto: SubmitHandoverOtpDto,
  ) {
    return this.rider.submitHandoverCode(user, taskId, dto);
  }
}

/**
 * The requester's side of the handover (S-19).
 *
 * H6: students only, for the reason given on RiderController. Only a student
 * places an order or posts an errand, so only a student is ever a requester.
 */
@ApiTags('tasks')
@Controller('tasks')
@Roles('STUDENT')
@RequireVerified()
export class TasksController {
  constructor(private readonly rider: RiderService) {}

  /** FR-DLV-12: shown to the requester only. */
  @Get(':taskId/handover-code')
  @ApiOperation({ summary: 'Whether a handover code is live for my task' })
  handoverCode(@CurrentUser() user: AuthenticatedUser, @Param('taskId') taskId: string) {
    return this.rider.handoverCodeForRequester(user, taskId);
  }

  /**
   * FR-DLV-12 recovery: a lost code cannot be retrieved, only replaced,
   * because only its hash is stored.
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':taskId/handover-code/reissue')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a new handover code, invalidating the old one' })
  reissueHandoverCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId') taskId: string,
  ) {
    return this.rider.reissueHandoverCode(user, taskId);
  }
}
