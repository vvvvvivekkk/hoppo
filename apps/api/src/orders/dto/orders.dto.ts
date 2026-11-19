import { PaymentMethod, TaskType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MAX_CART_ITEM_QUANTITY } from '@hoppo/shared';

export class CartLineDto {
  @IsString()
  @IsNotEmpty()
  catalogItemId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CART_ITEM_QUANTITY, { message: `At most ${MAX_CART_ITEM_QUANTITY} of one item` })
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

/**
 * FR-ORD-03: the student is shown the full breakdown before confirming. This
 * endpoint produces that breakdown without creating anything, so the cart
 * screen and the checkout screen agree on the number.
 */
export class QuoteOrderDto {
  @IsString()
  @IsNotEmpty()
  listingId!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Your cart is empty' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CartLineDto)
  lines!: CartLineDto[];

  /** FR-ORD-02: a configured campus point, or a free-text landmark. */
  @IsOptional()
  @IsString()
  deliveryPointId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  dropLandmark?: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  dropLatitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  dropLongitude?: number;
}

export class PlaceOrderDto extends QuoteOrderDto {
  @IsEnum(PaymentMethod, { message: 'Choose a payment method' })
  paymentMethod!: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  studentNote?: string;

  /**
   * FR-ORD-03: the total the student actually saw and agreed to. The server
   * recomputes it and refuses the order if they disagree, so a price change
   * between quote and confirm cannot silently charge more than was shown.
   */
  @Type(() => Number)
  @IsInt()
  expectedTotalMinor!: number;
}

export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/** FR-SHP-02 */
export class AcceptOrderDto {
  /**
   * The shop may revise the stated preparation time on acceptance, and that
   * number drives when the rider is dispatched (FR-DLV-01), so it is not
   * cosmetic.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(240)
  prepMinutes?: number;
}

export class RejectOrderDto {
  @IsString()
  @MinLength(3, { message: 'Say briefly why the order is being rejected' })
  @MaxLength(300)
  reason!: string;
}

/** FR-ORD-07, FR-ORD-08 */
export class CreateTaskDto {
  @IsEnum(TaskType, { message: 'Task type must be PARCEL_PICKUP or PEER_ERRAND' })
  type!: Exclude<TaskType, 'SHOP_ORDER'>;

  @IsString()
  @IsNotEmpty({ message: 'Where should the rider collect from?' })
  @MaxLength(200)
  pickupLabel!: string;

  @Type(() => Number)
  @IsLatitude()
  pickupLatitude!: number;

  @Type(() => Number)
  @IsLongitude()
  pickupLongitude!: number;

  @IsOptional()
  @IsString()
  dropDeliveryPointId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  dropLabel?: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  dropLatitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  dropLongitude?: number;

  @IsString()
  @IsNotEmpty({ message: 'Describe what is being collected' })
  @MaxLength(500)
  description!: string;

  /** FR-ORD-07 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  collectionRef?: string;

  /** FR-ORD-08: what the requester will reimburse the rider for the goods. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5_000_000)
  reimbursementMinor?: number;
}

/** FR-DLV-07: the three choices offered when no rider was found. */
export class UnfulfilledChoiceDto {
  @IsEnum(['KEEP_WAITING', 'COLLECT_IN_PERSON', 'CANCEL'] as unknown as object, {
    message: 'Choose KEEP_WAITING, COLLECT_IN_PERSON or CANCEL',
  })
  choice!: 'KEEP_WAITING' | 'COLLECT_IN_PERSON' | 'CANCEL';
}
