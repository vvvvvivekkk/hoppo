import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CONFIG_LIMITS as L, FEE_BAND_LIMITS } from '../college-config.rules';

export class FeeBandDto {
  @IsInt()
  @Min(0)
  @Max(FEE_BAND_LIMITS.maxDistanceM)
  minDistanceM!: number;

  /** Exclusive upper bound; null on the last band only. */
  @ValidateIf((_o, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(FEE_BAND_LIMITS.maxDistanceM)
  maxDistanceM!: number | null;

  @IsInt()
  @Min(0)
  @Max(FEE_BAND_LIMITS.maxFeeMinor)
  feeMinor!: number;
}

/**
 * FR-ADM-03. Every field optional — a PATCH carries only what changes. The
 * bounds come from CONFIG_LIMITS so the DTO, the service and the `limits`
 * block of the GET response cannot disagree.
 *
 * `serviceableRadiusM` is not declared, so the validation pipe rejects it:
 * the radius is changed through PATCH /admin/college/radius (FR-TEN-05).
 */
export class UpdateCollegeConfigDto {
  @IsOptional()
  @IsInt()
  @Min(L.acceptanceWindowSeconds.min)
  @Max(L.acceptanceWindowSeconds.max)
  acceptanceWindowSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(L.maxBroadcastRounds.min)
  @Max(L.maxBroadcastRounds.max)
  maxBroadcastRounds?: number;

  @IsOptional()
  @IsInt()
  @Min(L.initialProximityM.min)
  @Max(L.initialProximityM.max)
  initialProximityM?: number;

  @IsOptional()
  @IsInt()
  @Min(L.proximityIncrementM.min)
  @Max(L.proximityIncrementM.max)
  proximityIncrementM?: number;

  @IsOptional()
  @IsInt()
  @Min(L.feeIncrementMinor.min)
  @Max(L.feeIncrementMinor.max)
  feeIncrementMinor?: number;

  @IsOptional()
  @IsInt()
  @Min(L.dispatchLeadMinutes.min)
  @Max(L.dispatchLeadMinutes.max)
  dispatchLeadMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(L.workModeIdleTimeoutMinutes.min)
  @Max(L.workModeIdleTimeoutMinutes.max)
  workModeIdleTimeoutMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(L.riderPingIntervalSeconds.min)
  @Max(L.riderPingIntervalSeconds.max)
  riderPingIntervalSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(L.shopAcceptWindowSeconds.min)
  @Max(L.shopAcceptWindowSeconds.max)
  shopAcceptWindowSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(L.maxOtpAttempts.min)
  @Max(L.maxOtpAttempts.max)
  maxOtpAttempts?: number;

  @IsOptional()
  @IsInt()
  @Min(L.platformFeeMinor.min)
  @Max(L.platformFeeMinor.max)
  platformFeeMinor?: number;

  @IsOptional()
  @IsInt()
  @Min(L.commissionBps.min)
  @Max(L.commissionBps.max)
  commissionBps?: number;

  @IsOptional()
  @IsInt()
  @Min(L.minWithdrawalMinor.min)
  @Max(L.minWithdrawalMinor.max)
  minWithdrawalMinor?: number;

  @IsOptional()
  @IsInt()
  @Min(L.maxVerificationSubmissions.min)
  @Max(L.maxVerificationSubmissions.max)
  maxVerificationSubmissions?: number;

  @IsOptional()
  @IsInt()
  @Min(L.verificationWindowDays.min)
  @Max(L.verificationWindowDays.max)
  verificationWindowDays?: number;

  @IsOptional()
  @IsInt()
  @Min(L.abandonmentBanThreshold.min)
  @Max(L.abandonmentBanThreshold.max)
  abandonmentBanThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(L.abandonmentWindowDays.min)
  @Max(L.abandonmentWindowDays.max)
  abandonmentWindowDays?: number;

  @IsOptional()
  @IsInt()
  @Min(L.abandonmentBanHours.min)
  @Max(L.abandonmentBanHours.max)
  abandonmentBanHours?: number;

  @IsOptional()
  @IsInt()
  @Min(L.chatRetentionDays.min)
  @Max(L.chatRetentionDays.max)
  chatRetentionDays?: number;

  @IsOptional()
  @IsInt()
  @Min(L.reportHideThreshold.min)
  @Max(L.reportHideThreshold.max)
  reportHideThreshold?: number;

  /** The complete new list; it replaces the existing bands. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(FEE_BAND_LIMITS.minBands)
  @ArrayMaxSize(FEE_BAND_LIMITS.maxBands)
  @ValidateNested({ each: true })
  @Type(() => FeeBandDto)
  feeBands?: FeeBandDto[];
}

/** FR-ORD-02 / A-10 */
export class CreateDeliveryPointDto {
  @IsString()
  @MinLength(2, { message: 'Give the delivery point a name' })
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsLatitude({ message: 'Place the point on the map' })
  latitude!: number;

  @IsLongitude({ message: 'Place the point on the map' })
  longitude!: number;
}

export class UpdateDeliveryPointDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Give the delivery point a name' })
  @MaxLength(100)
  name?: string;

  /** A string, or null to clear it. */
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;
}

export class ReorderDeliveryPointsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique({ message: 'Each delivery point may appear once' })
  @IsUUID('all', { each: true })
  pointIds!: string[];
}
