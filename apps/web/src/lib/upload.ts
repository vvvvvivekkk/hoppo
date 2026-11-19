'use client';

import { ApiError, type Endpoints } from '@hoppo/api-client';

export class StorageUnavailableError extends Error {
  constructor() {
    super('File uploads are not available in this environment.');
    this.name = 'StorageUnavailableError';
  }
}

/**
 * Upload a file straight to the bucket and return its key.
 *
 * Two steps, and the shape is deliberate (FR-SVER-03): the API hands back a
 * short-lived presigned URL, and the bytes go from the phone to the bucket
 * without passing through the API server. An ID-card photo therefore never
 * lands in the API's logs, memory or temp files — which is the point for a
 * document C-3 treats as private.
 *
 * `fetch` with a plain `PUT`, not `FormData`. A presigned PUT signs the
 * `Content-Type`, so the body has to be the raw file and the header has to
 * match what was signed, or the bucket rejects it. A multipart body would be
 * stored as a multipart envelope, which is the kind of mistake that only
 * shows up when an administrator opens the image and sees junk.
 */
export async function uploadFile(
  api: Endpoints,
  kind: 'ID_CARD' | 'GOVT_ID' | 'CATALOG_IMAGE' | 'AVATAR' | 'SHOP_DOCUMENT',
  file: File,
): Promise<string> {
  let presigned: { uploadUrl: string; key: string };

  try {
    presigned = await api.uploads.url({
      kind,
      contentType: file.type,
      sizeBytes: file.size,
      originalFilename: file.name,
    });
  } catch (error) {
    // Distinguish "this deployment has no bucket" from "your file is wrong",
    // because only the second is something the student can fix.
    if (error instanceof ApiError && error.code === 'STORAGE_NOT_CONFIGURED') {
      throw new StorageUnavailableError();
    }
    throw error;
  }

  const response = await fetch(presigned.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });

  if (!response.ok) {
    throw new Error(
      `The upload was refused (${response.status}). Try again, or use a smaller photo.`,
    );
  }

  return presigned.key;
}
