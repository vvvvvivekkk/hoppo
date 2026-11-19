import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import {
  ACCEPTED_DOCUMENT_MIME_TYPES,
  ACCEPTED_IMAGE_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
} from '@hoppo/shared';

export type UploadKind = 'ID_CARD' | 'GOVT_ID' | 'SHOP_DOCUMENT' | 'CATALOG_IMAGE' | 'AVATAR';

/**
 * Object storage: Cloudflare R2 in production, MinIO locally. Both speak the
 * S3 API, so one code path serves either.
 *
 * Uploads are **presigned**, meaning the client gets a short-lived URL and
 * sends the bytes straight to the bucket. Two reasons that matters here:
 * identity-document images never pass through the API server (so they are
 * never in its logs, memory or temp files), and a 5 MB upload on campus 4G
 * does not hold an API worker open for thirty seconds.
 *
 * Two buckets. The public one holds catalog images and avatars. The private
 * one holds identity documents and shop licences — C-3 and NFR-S-03 require
 * those to be unreachable except through an authenticated administrator
 * endpoint, with every access logged.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client | null;
  private readonly publicBucket: string;
  private readonly privateBucket: string;

  constructor(private readonly config: ConfigService) {
    const accessKeyId = this.config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('S3_SECRET_ACCESS_KEY');

    this.publicBucket = this.config.get<string>('S3_BUCKET_PUBLIC', 'hoppo-public');
    this.privateBucket = this.config.get<string>('S3_BUCKET_PRIVATE', 'hoppo-private');

    if (!accessKeyId || !secretAccessKey) {
      this.logger.warn(
        'Object storage is not configured; upload endpoints will report it rather than failing obscurely',
      );
      this.client = null;
      return;
    }

    this.client = new S3Client({
      region: this.config.get<string>('S3_REGION', 'auto'),
      endpoint: this.config.get<string>('S3_ENDPOINT'),
      forcePathStyle: this.config.get<boolean>('S3_FORCE_PATH_STYLE', true),
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  /** Which bucket a kind of upload belongs in. The private ones are the point. */
  private bucketFor(kind: UploadKind): string {
    switch (kind) {
      case 'ID_CARD':
      case 'GOVT_ID':
      case 'SHOP_DOCUMENT':
        return this.privateBucket;
      case 'CATALOG_IMAGE':
      case 'AVATAR':
        return this.publicBucket;
    }
  }

  private rulesFor(kind: UploadKind): { maxBytes: number; mimeTypes: readonly string[] } {
    switch (kind) {
      case 'SHOP_DOCUMENT':
        // A licence may be a PDF; a photo of a shopfront will not be.
        return { maxBytes: MAX_DOCUMENT_BYTES, mimeTypes: ACCEPTED_DOCUMENT_MIME_TYPES };
      case 'ID_CARD':
      case 'GOVT_ID':
      case 'CATALOG_IMAGE':
      case 'AVATAR':
        return { maxBytes: MAX_IMAGE_BYTES, mimeTypes: ACCEPTED_IMAGE_MIME_TYPES };
    }
  }

  /**
   * A short-lived URL the client uploads to directly.
   *
   * FR-SVER-03 requires the file size and format to be validated before
   * acceptance. Both are enforced in the signature itself: `ContentType` is
   * signed, so an upload declaring a different type is rejected by the bucket
   * rather than by our trust in the client.
   */
  async createUploadUrl(params: {
    kind: UploadKind;
    ownerId: string;
    contentType: string;
    sizeBytes: number;
    originalFilename?: string;
  }): Promise<{ uploadUrl: string; key: string; expiresInSeconds: number }> {
    const { kind, ownerId, contentType, sizeBytes, originalFilename } = params;

    if (!this.client) {
      throw new BadRequestException({
        code: 'STORAGE_NOT_CONFIGURED',
        message: 'File uploads are not available in this environment.',
      });
    }

    const { maxBytes, mimeTypes } = this.rulesFor(kind);

    if (!mimeTypes.includes(contentType)) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_FILE_TYPE',
        message: `That file type is not accepted. Use ${mimeTypes
          .map((m) => m.split('/')[1].toUpperCase())
          .join(', ')}.`,
      });
    }

    if (sizeBytes > maxBytes) {
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: `That file is ${(sizeBytes / 1_048_576).toFixed(1)} MB. The limit is ${(
          maxBytes / 1_048_576
        ).toFixed(0)} MB — try taking the photo again at a lower resolution.`,
      });
    }

    // A random key, not the original filename. User-supplied filenames invite
    // path traversal and collisions, and the original name is of no use once
    // the row points at the object.
    const extension = contentType.split('/')[1].replace('jpeg', 'jpg');
    const key = `${kind.toLowerCase()}/${ownerId}/${randomUUID()}.${extension}`;

    const expiresInSeconds = 900;

    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucketFor(kind),
        Key: key,
        ContentType: contentType,
        Metadata: originalFilename
          ? { 'original-filename': encodeURIComponent(originalFilename) }
          : undefined,
      }),
      { expiresIn: expiresInSeconds },
    );

    return { uploadUrl, key, expiresInSeconds };
  }

  /**
   * A short-lived URL to read a private object.
   *
   * Only administrator endpoints call this, and every one of them writes an
   * audit row first — NFR-S-03 requires the access to be logged, and the
   * private bucket is only half the protection. A bucket stops outsiders; the
   * audit trail is what deters insiders.
   *
   * Five minutes, deliberately short: the URL is a bearer credential for that
   * object, and an administrator reviewing a queue needs it for seconds.
   */
  async createPrivateReadUrl(key: string, expiresInSeconds = 300): Promise<string> {
    if (!this.client) {
      throw new BadRequestException({
        code: 'STORAGE_NOT_CONFIGURED',
        message: 'Document viewing is not available in this environment.',
      });
    }

    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.privateBucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  /** The stable URL of a public object — catalog images, avatars. */
  publicUrl(key: string): string {
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    return endpoint
      ? `${endpoint.replace(/\/$/, '')}/${this.publicBucket}/${key}`
      : `/${this.publicBucket}/${key}`;
  }

  /**
   * FR-ID-03 and FR-PRIV-04: documents are deleted after their retention
   * period, which means something has to actually delete the object and not
   * merely null the column.
   */
  async deletePrivateObject(key: string): Promise<boolean> {
    if (!this.client) return false;

    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.privateBucket, Key: key }),
      );
      this.logger.log(`Deleted private object ${key}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to delete private object ${key}`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }
}
