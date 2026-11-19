import { GovtIdType, RejectionReason } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class SubmitVerificationDto {
  @IsString()
  @MinLength(2, { message: 'Enter your roll or enrolment number' })
  @MaxLength(40)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  rollNumber!: string;

  @IsString()
  @MinLength(2, { message: 'Enter your department' })
  @MaxLength(100)
  department!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(6, { message: 'Year of study must be between 1 and 6' })
  yearOfStudy!: number;

  /**
   * FR-SVER-02: a photograph of the front of the college identity card.
   * The client uploads to the private bucket first and passes the key here,
   * so the image bytes never travel through this endpoint.
   */
  @IsString()
  @IsNotEmpty({ message: 'Upload a photo of your college ID card' })
  idCardUrl!: string;

  /**
   * Section 11. Optional, because FR-ID-01 is the recommended path: the
   * college ID card plus a verified mobile number is sufficient to establish
   * college membership, which is the actual requirement. A second document is
   * requested only where a college asks for one for riders handling cash.
   */
  @IsOptional()
  @IsEnum(GovtIdType)
  govtIdType?: GovtIdType;

  /**
   * FR-ID-02 / FR-ID-03: the last four characters only. Never the full
   * number. A database check constraint caps this column at four characters,
   * so even a client that ignores this validator cannot store more.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{4}$/, { message: 'Enter only the last 4 characters of the document' })
  govtIdLast4?: string;

  /**
   * FR-ID-03, used only where a college mandates Aadhaar: a *masked* image
   * with the first eight digits obscured. Deleted within 24 hours of the
   * administrator's decision by a scheduled job.
   */
  @IsOptional()
  @IsString()
  govtIdImageUrl?: string;

  /** FR-ID-03: explicit consent is required before any such image is kept. */
  @IsOptional()
  consentGiven?: boolean;
}

export class ApproveVerificationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectVerificationDto {
  /** FR-SVER-05: mandatory, and from the controlled list. */
  @IsEnum(RejectionReason, { message: 'Select a rejection reason' })
  reason!: RejectionReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SuspendStudentDto {
  @IsString()
  @MinLength(5, { message: 'Record why this account is being suspended' })
  @MaxLength(500)
  reason!: string;
}

export class VerificationQueueQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;

  @IsOptional()
  @IsString()
  cursor?: string;
}
