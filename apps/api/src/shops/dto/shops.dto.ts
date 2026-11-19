import { LocationType, RejectionReason, ShopDocumentType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
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
  ValidateNested,
} from 'class-validator';
import { RADIUS_MAX_M, RADIUS_MIN_M } from '@hoppo/shared';

const E164 = /^\+[1-9]\d{7,14}$/;

const normaliseMobile = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const cleaned = value.replace(/[\s\-()]/g, '');
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
  if (/^0[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
};

/**
 * D-03 / D-04: check the distance before committing to a registration.
 *
 * Separate from registration on purpose. The owner needs to see "you are
 * 4.1 km away, the limit is 3 km" before uploading four documents, not after.
 */
export class DistanceCheckDto {
  @IsString()
  @IsNotEmpty({ message: 'Select the college this shop will serve' })
  collegeId!: string;

  /** Either an address to geocode, or explicit coordinates from the map pin. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude({ message: 'Invalid latitude' })
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude({ message: 'Invalid longitude' })
  longitude?: number;
}

export class ShopDocumentInputDto {
  @IsEnum(ShopDocumentType)
  docType!: ShopDocumentType;

  /** The object key returned by the presigned upload. */
  @IsString()
  @IsNotEmpty()
  fileKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sizeBytes?: number;
}

/** D-02 .. D-06: the whole registration wizard, submitted at once. */
export class RegisterShopDto {
  // --- Shop ---------------------------------------------------------------
  @IsString()
  @MinLength(2, { message: 'Enter the shop name' })
  @MaxLength(150)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @IsString()
  @IsNotEmpty({ message: 'Select a category' })
  @MaxLength(50)
  category!: string;

  // --- Owner --------------------------------------------------------------
  @IsString()
  @MinLength(2, { message: 'Enter the owner name' })
  @MaxLength(100)
  ownerName!: string;

  @Transform(normaliseMobile)
  @Matches(E164, { message: 'Enter a valid mobile number' })
  ownerMobile!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Enter a valid email address' })
  ownerEmail!: string;

  @IsString()
  @MinLength(10, { message: 'Use at least 10 characters' })
  @MaxLength(128)
  password!: string;

  // --- Location -----------------------------------------------------------
  @IsString()
  @MinLength(5, { message: 'Enter the full address' })
  @MaxLength(300)
  address!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter a 6-digit pincode' })
  pincode?: string;

  /**
   * FR-SHOP-04: the coordinates the owner confirmed on the map. Required
   * rather than derived, because a geocoded road centre is not accurate
   * enough to decide a 3 km threshold on.
   */
  @Type(() => Number)
  @IsLatitude({ message: 'Confirm the shop location on the map' })
  latitude!: number;

  @Type(() => Number)
  @IsLongitude({ message: 'Confirm the shop location on the map' })
  longitude!: number;

  @IsOptional()
  pinAdjusted?: boolean;

  /** FR-SHOP-03 */
  @IsEnum(LocationType, { message: 'Say whether the shop is on campus or off campus' })
  locationType!: LocationType;

  @IsString()
  @IsNotEmpty({ message: 'Select the college this shop will serve' })
  collegeId!: string;

  // --- Compliance ---------------------------------------------------------
  @IsOptional()
  @IsString()
  @Matches(/^\d{14}$/, { message: 'An FSSAI licence number is 14 digits' })
  fssaiLicenceNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, {
    message: 'Enter a valid 15-character GSTIN',
  })
  gstin?: string;

  // --- Documents ----------------------------------------------------------
  /** FR-SHOP-08 */
  @IsArray()
  @ArrayMinSize(1, { message: 'Upload at least the shop licence and a frontage photo' })
  @ValidateNested({ each: true })
  @Type(() => ShopDocumentInputDto)
  documents!: ShopDocumentInputDto[];
}

export class RejectShopDto {
  @IsEnum(RejectionReason, { message: 'Select a rejection reason' })
  reason!: RejectionReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SuspendShopDto {
  @IsString()
  @MinLength(5, { message: 'Record why this shop is being suspended' })
  @MaxLength(500)
  reason!: string;
}

/** FR-TEN-04 */
export class UpdateRadiusDto {
  @Type(() => Number)
  @IsInt()
  @Min(RADIUS_MIN_M, { message: `The radius must be at least ${RADIUS_MIN_M / 1000} km` })
  @Max(RADIUS_MAX_M, { message: `The radius may not exceed ${RADIUS_MAX_M / 1000} km` })
  serviceableRadiusM!: number;
}

/** FR-CAT-06 */
export class BrowseShopsQueryDto {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  @IsEnum(['distance', 'rating', 'prepTime'] as unknown as object, {
    message: 'sort must be distance, rating or prepTime',
  })
  sort?: 'distance' | 'rating' | 'prepTime';

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  openNow?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 30;

  @IsOptional()
  @IsString()
  cursor?: string;
}
