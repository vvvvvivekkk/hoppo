import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { HANDOVER_OTP_LENGTH } from '@hoppo/shared';

export class SetWorkModeDto {
  @IsBoolean()
  enabled!: boolean;

  /** Required when turning work mode on, so the first broadcast can reach them. */
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;
}

export class AbandonTaskDto {
  @IsString()
  @MinLength(3, { message: 'Say briefly why you are returning this task' })
  @MaxLength(300)
  reason!: string;
}

export class ConfirmPickupDto {
  /** FR-DLV-11: optional proof photograph, for non-shop pickups. */
  @IsOptional()
  @IsString()
  proofImageKey?: string;
}

export class SubmitHandoverOtpDto {
  @Matches(new RegExp(`^\\d{${HANDOVER_OTP_LENGTH}}$`), {
    message: `The handover code is ${HANDOVER_OTP_LENGTH} digits`,
  })
  code!: string;
}

export class RiderPingDto {
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @Type(() => Number)
  @IsLongitude()
  longitude!: number;
}

export class EarningsQueryDto {
  @IsOptional()
  @IsString()
  period?: 'day' | 'week' | 'month' | 'all';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number = 30;
}
