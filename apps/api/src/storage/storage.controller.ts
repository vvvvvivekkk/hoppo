import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { StorageService } from './storage.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateUploadUrlDto } from './dto/upload.dto';

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
    return this.storage.createUploadUrl({
      kind: dto.kind,
      ownerId: user.userId,
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      originalFilename: dto.originalFilename,
    });
  }
}
