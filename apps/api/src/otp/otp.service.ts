import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpPurpose } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import { AUTH_OTP_LENGTH, AUTH_OTP_TTL_SECONDS } from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One-time passwords for phone and email verification and password reset
 * (FR-AUTH-02, FR-AUTH-03, FR-AUTH-07).
 *
 * NFR-S-04: "OTP values shall be stored hashed, shall expire after a
 * configured period, and shall be single-use." All three are enforced here —
 * the code is hashed with Argon2id, `expiresAt` is set on issue, and
 * `consumedAt` is set on the first successful verification so a replay fails.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Issue a code to a mobile number or email address.
   *
   * In development, with no SMS provider configured, the code is written to
   * the server log instead of being sent. That is a deliberate convenience,
   * and the production config check refuses to start without MSG91_AUTH_KEY
   * precisely so it cannot leak into a live deployment.
   */
  async issue(params: { purpose: OtpPurpose; recipient: string }): Promise<{
    challengeId: string;
    expiresAt: Date;
    /** Only populated in development. Never returned in production. */
    devCode?: string;
  }> {
    const { purpose, recipient } = params;

    // randomInt uses the OS cryptographic source. Math.random() is predictable
    // from a few observed outputs and must never generate a credential.
    const code = String(randomInt(0, 10 ** AUTH_OTP_LENGTH)).padStart(AUTH_OTP_LENGTH, '0');
    const codeHash = await argon2.hash(code, { type: argon2.argon2id });
    const expiresAt = new Date(Date.now() + AUTH_OTP_TTL_SECONDS * 1000);

    // Invalidate any outstanding code for the same recipient and purpose, so
    // that requesting a new code reliably replaces the old one rather than
    // leaving two valid at once.
    await this.prisma.otpChallenge.updateMany({
      where: { recipient, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const challenge = await this.prisma.otpChallenge.create({
      data: { purpose, recipient, codeHash, expiresAt },
    });

    await this.deliver(recipient, code, purpose);

    const isProduction = this.config.get<string>('NODE_ENV') === 'production';

    return {
      challengeId: challenge.id,
      expiresAt,
      devCode: isProduction ? undefined : code,
    };
  }

  /**
   * Verify a code. Returns true once; a second attempt with the same code
   * fails because the challenge is consumed.
   */
  async verify(params: {
    challengeId: string;
    code: string;
    recipient?: string;
  }): Promise<boolean> {
    const { challengeId, code, recipient } = params;

    const challenge = await this.prisma.otpChallenge.findUnique({ where: { id: challengeId } });

    if (!challenge) {
      throw new BadRequestException({
        code: 'OTP_NOT_FOUND',
        message: 'That verification code request was not found. Request a new code.',
      });
    }

    if (recipient && challenge.recipient !== recipient) {
      // Prevents using a code issued to one number to verify another.
      throw new BadRequestException({
        code: 'OTP_RECIPIENT_MISMATCH',
        message: 'That code was issued for a different number.',
      });
    }

    if (challenge.consumedAt) {
      throw new BadRequestException({
        code: 'OTP_ALREADY_USED',
        message: 'That code has already been used. Request a new one.',
      });
    }

    if (challenge.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException({
        code: 'OTP_EXPIRED',
        message: 'That code has expired. Request a new one.',
      });
    }

    if (challenge.attempts >= challenge.maxAttempts) {
      throw new BadRequestException({
        code: 'OTP_ATTEMPTS_EXHAUSTED',
        message: 'Too many incorrect attempts. Request a new code.',
      });
    }

    const matches = await argon2.verify(challenge.codeHash, code);

    if (!matches) {
      // Count the failure before returning, so attempts cannot be retried
      // without limit.
      await this.prisma.otpChallenge.update({
        where: { id: challengeId },
        data: { attempts: { increment: 1 } },
      });
      return false;
    }

    // Single-use: consume on success.
    await this.prisma.otpChallenge.update({
      where: { id: challengeId },
      data: { consumedAt: new Date() },
    });

    return true;
  }

  /**
   * Send the code. MSG91 in production — chosen over Twilio for Indian
   * pricing and because it handles DLT template registration, which is
   * mandatory for commercial SMS in India.
   */
  private async deliver(recipient: string, code: string, purpose: OtpPurpose): Promise<void> {
    const authKey = this.config.get<string>('MSG91_AUTH_KEY');

    if (!authKey) {
      this.logger.warn(
        `[DEV] OTP for ${this.mask(recipient)} (${purpose}): ${code} — no SMS provider configured`,
      );
      return;
    }

    // Phase 1B ships the OTP lifecycle; the MSG91 HTTP call lands with the
    // rest of the external integrations. Until then a configured key still
    // logs, but loudly, so it cannot pass unnoticed.
    this.logger.warn(
      `MSG91 delivery not yet implemented; OTP for ${this.mask(recipient)} not sent`,
    );
  }

  /** Never log a full mobile number or email address. */
  private mask(recipient: string): string {
    if (recipient.includes('@')) {
      const [local, domain] = recipient.split('@');
      return `${local.slice(0, 2)}***@${domain}`;
    }
    return `${recipient.slice(0, 3)}***${recipient.slice(-2)}`;
  }
}
