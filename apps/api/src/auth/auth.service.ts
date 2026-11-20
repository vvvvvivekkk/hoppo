import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from '../otp/otp.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { PRIVACY_NOTICE_VERSION, acceptedPrivacyVersion } from '../common/legal/privacy-notice';
import { readPrivacyAcceptance } from './me';
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
} from '../common/types/authenticated-user';
import type {
  LoginDto,
  RegisterDto,
  RequestMobileOtpDto,
  ResetPasswordDto,
} from './dto/auth.dto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export interface SessionContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
  ) {}

  // =======================================================================
  // Registration (FR-AUTH-01 .. FR-AUTH-04)
  // =======================================================================

  /** FR-AUTH-02: step one of registration — prove the number is reachable. */
  async requestMobileOtp(dto: RequestMobileOtpDto) {
    // FR-AUTH-04: tell the caller early that the number is taken, rather than
    // after they have filled in the whole form. This does disclose that a
    // number is registered, which is a deliberate trade: the same fact is
    // already discoverable from the login screen, and the alternative is a
    // materially worse signup experience.
    const existing = await this.prisma.user.findUnique({
      where: { mobile: dto.mobile },
      select: { id: true, status: true },
    });

    if (existing && existing.status === 'ACTIVE') {
      throw new BadRequestException({
        code: 'MOBILE_ALREADY_REGISTERED',
        message: 'That mobile number is already registered. Try logging in instead.',
      });
    }

    const { challengeId, expiresAt, devCode } = await this.otp.issue({
      purpose: 'PHONE_VERIFY',
      recipient: dto.mobile,
    });

    return { challengeId, expiresAt, devCode };
  }

  async verifyMobileOtp(challengeId: string, code: string) {
    const ok = await this.otp.verify({ challengeId, code });
    if (!ok) {
      throw new BadRequestException({
        code: 'OTP_INCORRECT',
        message: 'That code is not correct. Check it and try again.',
      });
    }
    return { verified: true, challengeId };
  }

  /**
   * FR-AUTH-01: create the account.
   *
   * The new account is deliberately *not* verified. FR-SVER-01 puts it in
   * PENDING_VERIFICATION with read-only catalog access until an administrator
   * approves the ID card.
   */
  async register(dto: RegisterDto, ctx: SessionContext): Promise<TokenPair & { userId: string }> {
    // FR-PRIV-01: checked first, so a stale or missing acceptance is refused
    // before anything is created.
    const privacyVersion = acceptedPrivacyVersion(dto.privacyNoticeVersion, {
      PRIVACY_ACCEPTANCE_REQUIRED: this.config.get<string>('PRIVACY_ACCEPTANCE_REQUIRED'),
    });

    // The mobile OTP must have been issued for this number and consumed.
    const challenge = await this.prisma.otpChallenge.findUnique({
      where: { id: dto.mobileOtpChallengeId },
    });

    if (
      !challenge ||
      challenge.purpose !== 'PHONE_VERIFY' ||
      challenge.recipient !== dto.mobile ||
      !challenge.consumedAt
    ) {
      throw new BadRequestException({
        code: 'MOBILE_NOT_VERIFIED',
        message: 'Verify your mobile number before completing registration.',
      });
    }

    // A consumed challenge should not be reusable indefinitely — otherwise one
    // verification could be replayed to create accounts days later.
    const consumedAgeMs = Date.now() - challenge.consumedAt.getTime();
    if (consumedAgeMs > 30 * 60 * 1000) {
      throw new BadRequestException({
        code: 'MOBILE_VERIFICATION_STALE',
        message: 'That verification has expired. Verify your mobile number again.',
      });
    }

    const college = await this.prisma.college.findUnique({
      where: { id: dto.collegeId },
      select: { id: true, name: true, status: true, emailDomain: true },
    });

    if (!college || college.status !== 'ACTIVE') {
      throw new BadRequestException({
        code: 'COLLEGE_NOT_AVAILABLE',
        message: 'That college is not available for registration.',
      });
    }

    // FR-AUTH-03: where a college has registered an email domain, only
    // addresses on that domain may register.
    if (college.emailDomain) {
      const domain = dto.email.split('@')[1]?.toLowerCase();
      if (domain !== college.emailDomain.toLowerCase()) {
        throw new BadRequestException({
          code: 'EMAIL_DOMAIN_MISMATCH',
          message: `${college.name} requires an @${college.emailDomain} email address.`,
        });
      }
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    // FR-AUTH-04 is enforced by unique constraints on mobile and email; a
    // collision surfaces as P2002 and the exception filter turns it into a
    // readable 409. Checking first would still race, so the constraint is the
    // real guarantee.
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          collegeId: college.id,
          role: 'STUDENT',
          name: dto.name,
          mobile: dto.mobile,
          email: dto.email,
          passwordHash,
          mobileVerifiedAt: new Date(),
          // FR-PRIV-01: version and timestamp, on the account itself.
          ...(privacyVersion
            ? { privacyNoticeVersion: privacyVersion, privacyNoticeAcceptedAt: new Date() }
            : {}),
        },
      });

      // FR-SVER-01: starts unverified, with read-only access.
      await tx.studentProfile.create({
        data: {
          userId: created.id,
          rollNumber: '',
          department: '',
          yearOfStudy: 1,
          verificationStatus: 'UNSUBMITTED',
        },
      });

      await tx.riderReliability.create({ data: { userId: created.id } });

      // FR-PRIV-01: the acceptance is also an entry in the append-only audit
      // log — the columns say what the account's current state is, the log
      // says that it happened. Same transaction, so neither exists alone.
      if (privacyVersion) {
        await this.audit.recordInTransaction(tx, {
          actorId: created.id,
          collegeId: created.collegeId,
          action: AuditAction.PRIVACY_NOTICE_ACCEPTED,
          targetType: 'user',
          targetId: created.id,
          detail: { version: privacyVersion, at: 'REGISTRATION' },
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
        });
      }

      return created;
    });

    this.logger.log(`Registered student ${user.id} at college ${college.id}`);

    const tokens = await this.issueTokens(
      { id: user.id, collegeId: user.collegeId, role: user.role, isVerified: false },
      ctx,
    );

    return { ...tokens, userId: user.id };
  }

  // =======================================================================
  // Login (FR-AUTH-05, FR-AUTH-06)
  // =======================================================================

  async login(dto: LoginDto, ctx: SessionContext): Promise<TokenPair> {
    const isEmail = dto.identifier.includes('@');

    const user = await this.prisma.user.findUnique({
      where: isEmail ? { email: dto.identifier } : { mobile: dto.identifier },
      select: {
        id: true,
        collegeId: true,
        role: true,
        status: true,
        passwordHash: true,
        failedLoginCount: true,
        lockedUntil: true,
        studentProfile: { select: { verificationStatus: true } },
        college: { select: { status: true } },
      },
    });

    // The same message whether the account is missing or the password is
    // wrong. Distinguishing them would let anyone enumerate registered
    // numbers from the login screen.
    const genericFailure = new UnauthorizedException({
      code: 'INVALID_CREDENTIALS',
      message: 'That mobile number or password is not correct.',
    });

    if (!user) {
      // Hash a dummy value so a missing account takes about as long as a
      // wrong password. Without this, response time reveals which numbers
      // are registered.
      await argon2.hash('timing-equalisation-placeholder', { type: argon2.argon2id });
      throw genericFailure;
    }

    // FR-AUTH-06: locked accounts are refused before the password is checked.
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new UnauthorizedException({
        code: 'ACCOUNT_LOCKED',
        message: `Too many incorrect attempts. Try again in ${minutes} minute${
          minutes === 1 ? '' : 's'
        }, or reset your password.`,
      });
    }

    if (user.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This account has been suspended. Contact your campus administrator.',
      });
    }

    if (user.status === 'DEACTIVATED') {
      throw new ForbiddenException({
        code: 'ACCOUNT_DEACTIVATED',
        message: 'This account has been closed.',
      });
    }

    const passwordOk = await argon2.verify(user.passwordHash, dto.password);

    if (!passwordOk) {
      await this.recordFailedLogin(user.id, user.failedLoginCount, user.collegeId, ctx);
      throw genericFailure;
    }

    // FR-ADM-07: after the password is known to be right, so this does not
    // tell a stranger which college a number belongs to.
    if (user.college?.status === 'INACTIVE') {
      throw new ForbiddenException({
        code: 'COLLEGE_INACTIVE',
        message: 'This college is not currently active on Hoppo.',
      });
    }

    // Success clears the counter — FR-AUTH-06 says *consecutive* failures.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    await this.audit.record({
      actorId: user.id,
      collegeId: user.collegeId,
      action: AuditAction.LOGIN_SUCCEEDED,
      targetType: 'user',
      targetId: user.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return this.issueTokens(
      {
        id: user.id,
        collegeId: user.collegeId,
        role: user.role,
        isVerified: user.studentProfile?.verificationStatus === 'VERIFIED',
      },
      ctx,
    );
  }

  /** FR-AUTH-06: lock after the configured number of consecutive failures. */
  private async recordFailedLogin(
    userId: string,
    currentCount: number,
    collegeId: string | null,
    ctx: SessionContext,
  ): Promise<void> {
    const maxAttempts = this.config.get<number>('AUTH_MAX_FAILED_ATTEMPTS', 5);
    const lockoutMinutes = this.config.get<number>('AUTH_LOCKOUT_MINUTES', 15);

    const nextCount = currentCount + 1;
    const shouldLock = nextCount >= maxAttempts;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: nextCount,
        lockedUntil: shouldLock ? new Date(Date.now() + lockoutMinutes * 60_000) : null,
      },
    });

    await this.audit.record({
      actorId: userId,
      collegeId,
      action: shouldLock ? AuditAction.ACCOUNT_LOCKED : AuditAction.LOGIN_FAILED,
      targetType: 'user',
      targetId: userId,
      detail: { attempt: nextCount, maxAttempts },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    if (shouldLock) {
      this.logger.warn(`Account ${userId} locked after ${nextCount} failed attempts`);
    }
  }

  // =======================================================================
  // Tokens (FR-AUTH-05)
  // =======================================================================

  /**
   * Issue an access/refresh pair.
   *
   * The access token is short-lived and stateless — it is checked by signature
   * on every request. The refresh token is long-lived and *stateful*: it is a
   * row in `refresh_token`, which is what makes logout and "sign out
   * everywhere" possible. A purely stateless JWT cannot be revoked, and
   * FR-AUTH-05 requires revocation.
   *
   * Only a SHA-256 digest of the refresh token is stored. SHA-256 rather than
   * Argon2 here because the lookup is by token — we need to find the row from
   * the token, which a salted hash cannot do — and the token is 48 bytes of
   * cryptographic randomness, so there is no low-entropy guess to slow down.
   */
  private async issueTokens(
    user: { id: string; collegeId: string | null; role: string; isVerified: boolean },
    ctx: SessionContext,
    familyId?: string,
  ): Promise<TokenPair> {
    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      cid: user.collegeId,
      role: user.role as AccessTokenPayload['role'],
      ver: user.isVerified,
    };

    const family = familyId ?? randomUUID();

    const refreshPayload: RefreshTokenPayload = { sub: user.id, fam: family };

    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL', '15m');
    const refreshTtl = this.config.get<string>('JWT_REFRESH_TTL', '30d');

    // expiresIn is given in seconds rather than as "15m". The underlying
    // library's types only accept a narrow set of string literals, and a
    // number is both accepted and unambiguous.
    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: Math.floor(this.ttlToMs(accessTtl) / 1000),
    });

    // The refresh token carries an unguessable random component as well as
    // the JWT, so that a stolen signing key alone does not mint usable
    // refresh tokens against existing rows.
    const refreshSecretPart = randomBytes(48).toString('base64url');
    const refreshJwt = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: Math.floor(this.ttlToMs(refreshTtl) / 1000),
    });
    const refreshToken = `${refreshJwt}.${refreshSecretPart}`;

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        familyId: family,
        userAgent: ctx.userAgent ?? null,
        ipAddress: ctx.ipAddress ?? null,
        expiresAt: new Date(Date.now() + this.ttlToMs(refreshTtl)),
      },
    });

    return { accessToken, refreshToken, expiresIn: accessTtl };
  }

  /**
   * Exchange a refresh token for a new pair, rotating the old one.
   *
   * Rotation with reuse detection: each refresh token may be used once. If a
   * token that has already been used is presented again, that means either a
   * client bug or a stolen token being replayed — and we cannot tell which, so
   * the whole family is revoked and the user has to log in again. Losing a
   * session is a far better outcome than leaving a thief with a valid one.
   */
  async refresh(refreshToken: string, ctx: SessionContext): Promise<TokenPair> {
    let payload: RefreshTokenPayload;

    try {
      const jwtPart = refreshToken.split('.').slice(0, 3).join('.');
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(jwtPart, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException({
        code: 'REFRESH_INVALID',
        message: 'Your session has expired. Please log in again.',
      });
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
    });

    if (!stored) {
      // A validly signed token with no row means it was already rotated away
      // and the row deleted, or it was never ours. Revoke the family.
      await this.revokeFamily(payload.fam);
      throw new UnauthorizedException({
        code: 'REFRESH_INVALID',
        message: 'Your session has expired. Please log in again.',
      });
    }

    // Why the session ended, before whether the token was reused.
    //
    // Suspending a student, deactivating an administrator or a college all
    // revoke the account's refresh tokens. Without this, the next refresh
    // from that person's own phone reached the reuse branch below: it was
    // answered "ended for security reasons" and logged as a possible token
    // theft, and the app could not tell the user they had been suspended.
    // The codes are the ones the JWT strategy uses for the same states, so
    // a client needs one rule for both.
    const owner = await this.prisma.user.findUnique({
      where: { id: stored.userId },
      select: { status: true, college: { select: { status: true } } },
    });

    if (owner && owner.status !== 'ACTIVE') {
      await this.revokeFamily(stored.familyId);
      throw new UnauthorizedException(
        owner.status === 'SUSPENDED'
          ? {
              code: 'ACCOUNT_SUSPENDED',
              message: 'This account has been suspended. Contact your campus administrator.',
            }
          : { code: 'ACCOUNT_DEACTIVATED', message: 'This account has been closed.' },
      );
    }

    if (owner?.college?.status === 'INACTIVE') {
      await this.revokeFamily(stored.familyId);
      throw new ForbiddenException({
        code: 'COLLEGE_INACTIVE',
        message: 'This college is not currently active on Hoppo.',
      });
    }

    if (stored.revokedAt) {
      this.logger.warn(
        `Refresh token reuse detected for user ${stored.userId}; revoking family ${stored.familyId}`,
      );
      await this.revokeFamily(stored.familyId);
      await this.audit.record({
        actorId: stored.userId,
        collegeId: null,
        action: AuditAction.SESSIONS_REVOKED,
        targetType: 'user',
        targetId: stored.userId,
        detail: { reason: 'REFRESH_TOKEN_REUSE', familyId: stored.familyId },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedException({
        code: 'REFRESH_REUSED',
        message: 'Your session was ended for security reasons. Please log in again.',
      });
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException({
        code: 'REFRESH_EXPIRED',
        message: 'Your session has expired. Please log in again.',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: stored.userId },
      select: {
        id: true,
        collegeId: true,
        role: true,
        status: true,
        studentProfile: { select: { verificationStatus: true } },
        college: { select: { status: true } },
      },
    });

    if (!user || user.status !== 'ACTIVE') {
      await this.revokeFamily(stored.familyId);
      throw new UnauthorizedException({
        code: 'ACCOUNT_UNAVAILABLE',
        message: 'This account is no longer active.',
      });
    }

    // FR-ADM-07: a deactivated tenant's users get no new tokens. Without this
    // a session opened before the deactivation could be refreshed for thirty
    // days, each new access token refused by the JWT strategy one request
    // later — locked out in effect, but still being issued credentials.
    if (user.college?.status === 'INACTIVE') {
      await this.revokeFamily(stored.familyId);
      throw new ForbiddenException({
        code: 'COLLEGE_INACTIVE',
        message: 'This college is not currently active on Hoppo.',
      });
    }

    // Mark the presented token used, then issue a new one in the same family.
    //
    // One conditional statement: the token must still be unused, and its
    // owner's college (if it has one) must still be ACTIVE, at the moment of
    // the write. The checks above read that state earlier; a college
    // deactivated, or the same token presented twice, in between would
    // otherwise still be handed a new pair.
    //
    // What this does and does not guarantee. The statement locks only this
    // refresh_token row; the college is read, not locked. So:
    //  - once the deactivation has committed, this matches nothing — always;
    //  - if the deactivation has already revoked this row but not committed,
    //    this waits on the row and then matches nothing;
    //  - if the deactivation is in flight and has not reached this row yet,
    //    this still sees the college as ACTIVE and rotates. The pair it
    //    mints is then either revoked by that same deactivation or, if the
    //    insert below lands after its revoke, survives as a row that can do
    //    nothing: the next refresh and every request are refused with
    //    COLLEGE_INACTIVE. Closing that last gap would take a lock on the
    //    college row around the rotation and the insert; it is left open
    //    deliberately, as the token it leaves behind is inert.
    const rotated = await this.prisma.refreshToken.updateMany({
      where: {
        id: stored.id,
        revokedAt: null,
        user: { OR: [{ collegeId: null }, { college: { status: 'ACTIVE' } }] },
      },
      data: { revokedAt: new Date() },
    });

    if (rotated.count === 0) {
      throw new UnauthorizedException({
        code: 'REFRESH_INVALID',
        message: 'Your session has expired. Please log in again.',
      });
    }

    return this.issueTokens(
      {
        id: user.id,
        collegeId: user.collegeId,
        role: user.role,
        isVerified: user.studentProfile?.verificationStatus === 'VERIFIED',
      },
      ctx,
      stored.familyId,
    );
  }

  /** FR-AUTH-05: logout, optionally on every device. */
  async logout(
    userId: string,
    opts: { refreshToken?: string; allDevices?: boolean },
    ctx: SessionContext,
  ): Promise<{ revoked: number }> {
    if (opts.allDevices) {
      const result = await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await this.audit.record({
        actorId: userId,
        collegeId: null,
        action: AuditAction.SESSIONS_REVOKED,
        targetType: 'user',
        targetId: userId,
        detail: { reason: 'USER_LOGOUT_ALL', count: result.count },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return { revoked: result.count };
    }

    if (opts.refreshToken) {
      const result = await this.prisma.refreshToken.updateMany({
        where: { tokenHash: this.hashToken(opts.refreshToken), userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { revoked: result.count };
    }

    return { revoked: 0 };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** FR-SVER-08: suspension must terminate active sessions immediately. */
  async revokeAllSessions(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  // =======================================================================
  // Password reset (FR-AUTH-07)
  // =======================================================================

  async requestPasswordReset(mobile: string) {
    const user = await this.prisma.user.findUnique({
      where: { mobile },
      select: { id: true, mobileVerifiedAt: true },
    });

    // Always answer the same way, whether or not the number is registered.
    // Otherwise this endpoint becomes an account-enumeration oracle.
    const uniformResponse = {
      message: 'If that number is registered, a reset code has been sent to it.',
    };

    if (!user || !user.mobileVerifiedAt) {
      this.logger.log('Password reset requested for an unregistered or unverified number');
      return uniformResponse;
    }

    const { challengeId, devCode } = await this.otp.issue({
      purpose: 'PASSWORD_RESET',
      recipient: mobile,
    });

    return { ...uniformResponse, challengeId, devCode };
  }

  async resetPassword(dto: ResetPasswordDto, ctx: SessionContext) {
    const challenge = await this.prisma.otpChallenge.findUnique({
      where: { id: dto.challengeId },
      select: { recipient: true, purpose: true },
    });

    if (!challenge || challenge.purpose !== 'PASSWORD_RESET') {
      throw new BadRequestException({
        code: 'RESET_INVALID',
        message: 'That reset request was not found. Start again.',
      });
    }

    const ok = await this.otp.verify({ challengeId: dto.challengeId, code: dto.code });
    if (!ok) {
      throw new BadRequestException({
        code: 'OTP_INCORRECT',
        message: 'That code is not correct. Check it and try again.',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { mobile: challenge.recipient },
      select: { id: true, collegeId: true },
    });

    if (!user) {
      throw new BadRequestException({
        code: 'RESET_INVALID',
        message: 'That reset request is no longer valid.',
      });
    }

    const passwordHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      });

      // A password reset ends every existing session. If the reset was a
      // recovery from compromise, leaving the attacker's sessions alive would
      // defeat the point.
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await this.audit.record({
      actorId: user.id,
      collegeId: user.collegeId,
      action: AuditAction.PASSWORD_RESET,
      targetType: 'user',
      targetId: user.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return { message: 'Your password has been changed. Please log in.' };
  }

  // =======================================================================
  // Signed-in password change (S-50)
  // =======================================================================

  /**
   * Change the password of a signed-in account.
   *
   * Ends every session the account has — including the one making the
   * request — and issues a new pair for the caller. "Other devices are
   * signed out" is then true by construction, rather than depending on
   * working out which refresh token belongs to this device.
   */
  async changePassword(
    userId: string,
    dto: { currentPassword: string; newPassword: string },
    ctx: SessionContext,
  ): Promise<TokenPair & { sessionsRevoked: number; message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        collegeId: true,
        role: true,
        passwordHash: true,
        studentProfile: { select: { verificationStatus: true } },
      },
    });

    const currentOk =
      user !== null &&
      (await argon2.verify(user.passwordHash, dto.currentPassword).catch(() => false));

    if (!user || !currentOk) {
      throw new ForbiddenException({
        code: 'PASSWORD_INCORRECT',
        message: 'Your current password is not correct.',
      });
    }

    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException({
        code: 'PASSWORD_UNCHANGED',
        message: 'Choose a password different from your current one.',
      });
    }

    const passwordHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });

    const revoked = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      });
      const result = await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: userId,
        collegeId: user.collegeId,
        action: AuditAction.PASSWORD_CHANGED,
        targetType: 'user',
        targetId: userId,
        detail: { sessionsRevoked: result.count },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      return result.count;
    });

    const tokens = await this.issueTokens(
      {
        id: user.id,
        collegeId: user.collegeId,
        role: user.role,
        isVerified: user.studentProfile?.verificationStatus === 'VERIFIED',
      },
      ctx,
    );

    return {
      ...tokens,
      sessionsRevoked: revoked,
      message: 'Password changed. Your other devices have been signed out.',
    };
  }

  // =======================================================================
  // Privacy notice acceptance after registration (FR-PRIV-01)
  // =======================================================================

  /**
   * Record that a signed-in user accepts the current notice.
   *
   * Recorded exactly as registration records it — the two columns on the
   * account plus a PRIVACY_NOTICE_ACCEPTED audit row — so /auth/me and the
   * data export read one kind of record. Accepting a version already
   * accepted returns the existing acceptance and writes nothing.
   */
  async acceptPrivacyNotice(
    user: { userId: string; collegeId: string | null },
    version: string,
    ctx: SessionContext,
  ): Promise<{ version: string; acceptedAt: Date }> {
    if (version !== PRIVACY_NOTICE_VERSION) {
      throw new ConflictException({
        code: 'PRIVACY_NOTICE_OUTDATED',
        message: 'The privacy notice has been updated. Please read the current version.',
        details: { currentVersion: PRIVACY_NOTICE_VERSION },
      });
    }

    const existing = await readPrivacyAcceptance(this.prisma, user.userId);
    if (existing?.version === version) return existing;

    const acceptedAt = new Date();

    // One transaction: the columns on the account (its current state) and
    // the audit entry (the record that it happened) land together or not at
    // all. recordInTransaction rather than record(), which swallows a failed
    // write — "accepted" must not be reported unless it was stored.
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.userId },
        data: { privacyNoticeVersion: version, privacyNoticeAcceptedAt: acceptedAt },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: user.collegeId,
        action: AuditAction.PRIVACY_NOTICE_ACCEPTED,
        targetType: 'user',
        targetId: user.userId,
        detail: { version, at: 'IN_APP' },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
    });

    return { version, acceptedAt };
  }

  // =======================================================================
  // Helpers
  // =======================================================================

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** "15m", "30d", "12h", "900s" into milliseconds. */
  private ttlToMs(ttl: string): number {
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) throw new Error(`Cannot parse TTL: ${ttl}`);

    const value = Number(match[1]);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return value * multipliers[unit];
  }
}
