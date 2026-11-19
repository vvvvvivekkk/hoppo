import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class CreateItemDto {
  @IsString()
  @MinLength(1, { message: 'Enter the item name' })
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /**
   * Minor units — paise. ₹120.50 is 12050. FR-PAY-07.
   * The dashboard converts from rupees before sending, so the API never
   * receives a decimal and never has to round one.
   */
  @Type(() => Number)
  @IsInt({ message: 'Price must be a whole number of paise' })
  @Min(0)
  @Max(10_000_000, { message: 'That price looks wrong — the maximum is ₹1,00,000' })
  priceMinor!: number;

  /** Feeds the dispatch lead time in FR-DLV-01, so it is not cosmetic. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240, { message: 'Preparation time cannot exceed 4 hours' })
  prepMinutes!: number;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  imageKey?: string;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceMinor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240)
  prepMinutes?: number;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  imageKey?: string;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/** FR-CAT-03: bulk availability toggling, for the dashboard's bulk actions (D-11). */
export class BulkAvailabilityDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  itemIds!: string[];

  @IsBoolean()
  isAvailable!: boolean;
}

export class HoursRowDto {
  /** 0 = Sunday .. 6 = Saturday */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  /**
   * Minutes from midnight. 540 = 09:00. A close at or before the open means
   * the window crosses midnight, which the open-state resolver handles.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  openMinute!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  closeMinute!: number;
}

/** FR-CAT-04: the whole week is replaced at once, which is how D-13 edits it. */
export class SetHoursDto {
  @IsArray()
  @ArrayMaxSize(21, { message: 'At most three opening windows per day' })
  @ValidateNested({ each: true })
  @Type(() => HoursRowDto)
  hours!: HoursRowDto[];
}

/** FR-CAT-04 */
export class TemporaryClosureDto {
  @IsISO8601({}, { message: 'Give the expected reopening time as an ISO 8601 timestamp' })
  reopenAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
