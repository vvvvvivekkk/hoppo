import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { StorageService, type UploadKind } from './storage.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateUploadUrlDto } from './dto/upload.dto';

/**
 * Which kinds of upload each role has any business making.
 *
 * A presigned URL is a credential to write into a bucket, and the key it
 * returns is later submitted somewhere as "my ID card" or "my shop licence".
 * Before this map any signed-in account could mint any kind: a student could
 * write into the shop-document prefix of the private bucket, and a shop login
 * could mint identity-document keys.
 *
 * A role that is absent may upload nothing. Administrators are absent on
 * purpose: nothing in the consoles uploads a file — they only read documents,
 * through the audited signed-URL endpoints.
 *
 * Shop registration is unaffected. It is public, happens before the owner has
 * an account, and so cannot use this endpoint at all; the dashboard submits
 * placeholder keys and documents are collected after approval.
 */
export const UPLOAD_KINDS_BY_ROLE: Partial<Record<UserRole, readonly UploadKind[]>> = {
  STUDENT: ['ID_CARD', 'GOVT_ID', 'AVATAR'],
  SHOP_OWNER: ['SHOP_DOCUMENT', 'CATALOG_IMAGE', 'AVATAR'],
  SHOP_STAFF: ['SHOP_DOCUMENT', 'CATALOG_IMAGE', 'AVATAR'],
};

@ApiTags('uploads')
@Controller('uploads')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  /**
   * Hand the client a short-lived URL to upload to directly.
   *
   * Rate limited because each call is a credential to write into our bucket.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('url')
  @ApiOperation({ summary: 'Get a presigned URL to upload a file' })
  createUploadUrl(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUploadUrlDto) {
    const allowed = UPLOAD_KINDS_BY_ROLE[user.role] ?? [];
    if (!allowed.includes(dto.kind)) {
      throw new ForbiddenException({
        code: 'UPLOAD_KIND_NOT_ALLOWED',
        message: 'Your account cannot upload that kind of file.',
      });
    }

    return this.storage.createUploadUrl({
      kind: dto.kind,
      ownerId: user.userId,
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      originalFilename: dto.originalFilename,
    });
  }
}
