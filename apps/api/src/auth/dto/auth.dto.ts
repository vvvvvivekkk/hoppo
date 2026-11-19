import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Request shapes, with validation attached.
 *
 * NFR-S-07: "All user-supplied input shall be validated and encoded on output
 * to prevent injection and cross-site scripting." These decorators are the
 * validation half, applied automatically by the global ValidationPipe, which
 * also strips any property not declared here — so an attacker cannot smuggle
 * `role: 'ADMIN'` into a registration body.
 */

/** E.164: a plus sign, a country code, then the number. +919346375528 */
const E164 = /^\+[1-9]\d{7,14}$/;

const normaliseMobile = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  // Accept what people actually type — spaces, dashes, brackets — and
  // normalise rather than rejecting. A bare 10-digit Indian number gets +91.
  const cleaned = value.replace(/[\s\-()]/g, '');
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
  if (/^0[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
};

const lowercaseTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RequestMobileOtpDto {
  @Transform(normaliseMobile)
  @Matches(E164, {
    message: 'Enter a valid mobile number, for example 9346375528 or +919346375528',
  })
  mobile!: string;
}

export class VerifyMobileOtpDto {
  @IsString()
  @IsNotEmpty()
  challengeId!: string;

  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code!: string;
}

export class RegisterDto {
  @IsString()
  @MinLength(2, { message: 'Enter your full name' })
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @Transform(normaliseMobile)
  @Matches(E164, { message: 'Enter a valid mobile number' })
  mobile!: string;

  @Transform(lowercaseTrim)
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(255)
  email!: string;

  /**
   * Long rather than complicated. Length is the property that actually
   * resists guessing; forced symbol classes mostly produce "Password1!".
   */
  @IsString()
  @MinLength(10, { message: 'Use at least 10 characters' })
  @MaxLength(128)
  password!: string;

  @IsString()
  @IsNotEmpty({ message: 'Select your college' })
  collegeId!: string;

  /**
   * FR-AUTH-02: the mobile number must be verified by OTP *before* the
   * registration is submitted. The client proves it by passing the consumed
   * challenge id.
   */
  @IsString()
  @IsNotEmpty({ message: 'Verify your mobile number first' })
  mobileOtpChallengeId!: string;
}

export class LoginDto {
  /** Mobile number or email address — one field, so the UI needs one box. */
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.includes('@')
      ? trimmed.toLowerCase()
      : (normaliseMobile({ value: trimmed }) as string);
  })
  identifier!: string;

  @IsString()
  @IsNotEmpty({ message: 'Enter your password' })
  password!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class RequestPasswordResetDto {
  @Transform(normaliseMobile)
  @Matches(E164, { message: 'Enter a valid mobile number' })
  mobile!: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  challengeId!: string;

  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code!: string;

  @IsString()
  @MinLength(10, { message: 'Use at least 10 characters' })
  @MaxLength(128)
  newPassword!: string;
}

export class LogoutDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;

  /** FR-AUTH-05: sign out on all devices. */
  @IsOptional()
  allDevices?: boolean;
}
