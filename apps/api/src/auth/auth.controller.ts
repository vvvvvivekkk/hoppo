import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AllowUnapprovedShop } from '../common/decorators/allow-unapproved-shop.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
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
    const record = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        id: true,
        name: true,
        mobile: true,
        email: true,
        role: true,
        status: true,
        avatarUrl: true,
        createdAt: true,
        college: { select: { id: true, name: true, shortName: true } },
        studentProfile: {
          select: {
            rollNumber: true,
            department: true,
            yearOfStudy: true,
            verificationStatus: true,
            verifiedAt: true,
            riderTermsAcceptedAt: true,
            // Deliberately absent: idCardUrl, govtIdLast4. C-3 and NFR-S-03
            // keep identity documents off every student-facing response.
          },
        },
        riderState: {
          select: { workModeOn: true, activeTaskId: true, barredUntil: true },
        },
      },
    });

    return { user: record };
  }
}
