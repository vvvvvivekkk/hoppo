import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RADIUS_MAX_M, RADIUS_MIN_M } from '@hoppo/shared';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const E164 = /^\+[1-9]\d{7,14}$/;

const normaliseMobile = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const cleaned = value.replace(/[\s\-()]/g, '');
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
  if (/^0[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
};

/** FR-TEN-01 */
export class CreateCollegeDto {
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'Enter the college name' })
  @MaxLength(150)
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  shortName?: string;

  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Enter the full address' })
  @MaxLength(300)
  address!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state!: string;

  @IsLatitude({ message: 'Invalid latitude' })
  latitude!: number;

  @IsLongitude({ message: 'Invalid longitude' })
  longitude!: number;

  /** FR-TEN-01: default 3 km; FR-TEN-04: 1 km to 5 km. */
  @IsOptional()
  @IsInt()
  @Min(RADIUS_MIN_M, { message: `The radius must be at least ${RADIUS_MIN_M / 1000} km` })
  @Max(RADIUS_MAX_M, { message: `The radius may not exceed ${RADIUS_MAX_M / 1000} km` })
  serviceableRadiusM?: number;

  /** IANA zone name, e.g. Asia/Kolkata (R-18). */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  /** FR-AUTH-03: restricts student signup to this domain. No "@". */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @Matches(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
    message: 'Enter a domain such as college.edu.in',
  })
  emailDomain?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @Transform(normaliseMobile)
  @Matches(E164, { message: 'Enter a valid contact phone number' })
  contactPhone?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Enter a valid contact email address' })
  contactEmail?: string;
}

export class ReasonDto {
  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Record why (at least 5 characters)' })
  @MaxLength(500)
  reason!: string;
}

/** FR-ADM-07 */
export class CreateCollegeAdminDto {
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'Enter the administrator’s name' })
  @MaxLength(100)
  name!: string;

  @Transform(normaliseMobile)
  @Matches(E164, { message: 'Enter a valid mobile number' })
  mobile!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Enter a valid email address' })
  email!: string;

  /** The first password, set by the super administrator and handed over. */
  @IsString()
  @MinLength(10, { message: 'Use at least 10 characters' })
  @MaxLength(128)
  password!: string;
}

export class SetAdminPasswordDto {
  @IsString()
  @MinLength(10, { message: 'Use at least 10 characters' })
  @MaxLength(128)
  password!: string;
}
