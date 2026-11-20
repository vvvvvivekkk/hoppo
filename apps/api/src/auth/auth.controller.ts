import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import { privacyNotice } from '../common/legal/privacy-notice';
import { readMe } from './me';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AllowUnapprovedShop } from '../common/decorators/allow-unapproved-shop.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  AcceptPrivacyNoticeDto,
  ChangePasswordDto,
  LoginDto,
  LogoutDto,
  RefreshDto,
  RegisterDto,
  RequestMobileOtpDto,
  RequestPasswordResetDto,
  ResetPasswordDto,
  VerifyMobileOtpDto,
} from './dto/auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  /** Session details for the audit log, taken from the request. */
  private ctx(req: Request) {
    return {
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    };
  }

  /**
   * FR-AUTH-01: the college list the signup screen picks from.
   * Public, because it is needed before anyone has an account.
   */
  @Public()
  @Get('colleges')
  @ApiOperation({ summary: 'Active colleges available for registration' })
  async colleges(@Query('q') query?: string) {
    const colleges = await this.prisma.college.findMany({
      where: {
        status: 'ACTIVE',
        ...(query
          ? {
              OR: [
                { name: { contains: query, mode: 'insensitive' as const } },
                { shortName: { contains: query, mode: 'insensitive' as const } },
                { city: { contains: query, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      // Only what a signup screen needs. Coordinates and contact details are
      // not public information.
      select: { id: true, name: true, shortName: true, city: true, state: true, emailDomain: true },
      orderBy: { name: 'asc' },
      take: 50,
    });

    return { colleges };
  }

  /**
   * FR-AUTH-02, step 1.
   * NFR-S-06 requires rate limiting on OTP issue — each request costs money
   * and an unlimited endpoint is an SMS-bill attack.
   */
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('mobile/request-otp')
  @ApiOperation({ summary: 'Send a verification code to a mobile number' })
  requestMobileOtp(@Body() dto: RequestMobileOtpDto) {
    return this.auth.requestMobileOtp(dto);
  }

  /** FR-AUTH-02, step 2. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mobile/verify-otp')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm a mobile verification code' })
  verifyMobileOtp(@Body() dto: VerifyMobileOtpDto) {
    return this.auth.verifyMobileOtp(dto.challengeId, dto.code);
  }

  /** FR-AUTH-01: create the account, after the mobile number is verified. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Register a student account' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, this.ctx(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log in with a mobile number or email and password' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, this.ctx(req));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, this.ctx(req));
  }

  /** FR-AUTH-05. Open to an unapproved shop account: anyone may sign out. */
  @AllowUnapprovedShop()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log out of this device, or all devices' })
  logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: LogoutDto,
    @Req() req: Request,
  ) {
    return this.auth.logout(
      user.userId,
      { refreshToken: dto.refreshToken, allDevices: dto.allDevices },
      this.ctx(req),
    );
  }

  /** FR-AUTH-07 */
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('password/request-reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a password reset code' })
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.auth.requestPasswordReset(dto.mobile);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set a new password using a reset code' })
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.auth.resetPassword(dto, this.ctx(req));
  }

  /**
   * Who am I — used by every client on launch to restore session state.
   *
   * Open to an unapproved shop account, which needs it to restore its session
   * and reach the "awaiting approval" screen. It returns the caller's own
   * record and nothing about the college beyond its name.
   */
  @AllowUnapprovedShop()
  @Get('me')
  @ApiOperation({ summary: 'The authenticated user' })
  async me(@CurrentUser() user: AuthenticatedUser) {
    return readMe(this.prisma, user.userId);
  }

  /**
   * Change my password while signed in (S-50).
   *
   * The current password is required: a signed-in session alone — a phone
   * left unlocked — must not be enough to take the account over. Every
   * existing session is ended and a fresh token pair returned, so the device
   * that made the change carries on and every other device has to log in
   * with the new password.
   */
  @AllowUnapprovedShop()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/change')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change my password; ends my other sessions' })
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    return this.auth.changePassword(user.userId, dto, this.ctx(req));
  }
}

/**
 * FR-PRIV-01: the privacy notice shown at registration.
 *
 * Public, because it is read before anyone has an account.
 */
@ApiTags('legal')
@Controller('legal')
export class LegalController {
  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Accept the current notice after registration: for accounts that predate
   * the notice, and for everyone when its version changes.
   *
   * Any signed-in role, including a shop account still awaiting approval.
   */
  @AllowUnapprovedShop()
  @Post('privacy-notice/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record my acceptance of the current privacy notice' })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AcceptPrivacyNoticeDto,
    @Req() req: Request,
  ) {
    return this.auth.acceptPrivacyNotice(user, dto.version, {
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @Public()
  @Get('privacy-notice')
  @ApiOperation({ summary: 'The current privacy notice and its version' })
  privacyNotice() {
    return privacyNotice({
      PRIVACY_GRIEVANCE_NAME: this.config.get<string>('PRIVACY_GRIEVANCE_NAME'),
      PRIVACY_GRIEVANCE_EMAIL: this.config.get<string>('PRIVACY_GRIEVANCE_EMAIL'),
      PRIVACY_ACCEPTANCE_REQUIRED: this.config.get<string>('PRIVACY_ACCEPTANCE_REQUIRED'),
    });
  }
}
