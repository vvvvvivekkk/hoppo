import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_DOCUMENT_BYTES } from '@hoppo/shared';
import type { UploadKind } from '../storage.service';

const KINDS: UploadKind[] = ['ID_CARD', 'GOVT_ID', 'SHOP_DOCUMENT', 'CATALOG_IMAGE', 'AVATAR'];

export class CreateUploadUrlDto {
  @IsIn(KINDS, { message: `kind must be one of: ${KINDS.join(', ')}` })
  kind!: UploadKind;

  @IsString()
  contentType!: string;

  /**
   * Declared up front so an oversized file is refused before the client
   * spends a minute uploading it on campus 4G, rather than after.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DOCUMENT_BYTES * 4, { message: 'That file is far too large' })
  sizeBytes!: number;

  @IsOptional()
  @IsString()
  originalFilename?: string;
}
