import { ForbiddenException } from '@nestjs/common';
import { StorageController } from './storage.controller';
import type { StorageService, UploadKind } from './storage.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * POST /uploads/url hands out a credential to write into a bucket. Which
 * kinds a caller may ask for depends on what kind of account it is.
 */
const ALL_KINDS: UploadKind[] = ['ID_CARD', 'GOVT_ID', 'SHOP_DOCUMENT', 'CATALOG_IMAGE', 'AVATAR'];

function build() {
  const createUploadUrl = jest
    .fn()
    .mockResolvedValue({
      uploadUrl: 'https://bucket.example/put',
      key: 'k',
      expiresInSeconds: 900,
    });
  const controller = new StorageController({ createUploadUrl } as unknown as StorageService);
  return { controller, createUploadUrl };
}

const as = (role: AuthenticatedUser['role']): AuthenticatedUser => ({
  userId: `${role.toLowerCase()}-1`,
  collegeId: role === 'SUPER_ADMIN' ? null : 'college-a',
  role,
  isVerified: role === 'STUDENT',
  ...(role === 'SHOP_OWNER' || role === 'SHOP_STAFF' ? { shopApproved: true } : {}),
});

const body = (kind: UploadKind) => ({ kind, contentType: 'image/png', sizeBytes: 1024 });

/** Which of the five kinds a role is actually given a URL for. */
async function grantedKinds(role: AuthenticatedUser['role']): Promise<UploadKind[]> {
  const granted: UploadKind[] = [];
  for (const kind of ALL_KINDS) {
    const { controller, createUploadUrl } = build();
    let refused: unknown = null;
    try {
      await controller.createUploadUrl(as(role), body(kind));
    } catch (e) {
      refused = e;
    }

    if (refused === null) {
      expect(createUploadUrl).toHaveBeenCalledTimes(1);
      granted.push(kind);
    } else {
      // A refusal is a 403 with the code, and no URL was minted.
      expect(refused).toBeInstanceOf(ForbiddenException);
      expect((refused as ForbiddenException).getResponse()).toMatchObject({
        code: 'UPLOAD_KIND_NOT_ALLOWED',
      });
      expect(createUploadUrl).not.toHaveBeenCalled();
    }
  }
  return granted;
}

describe('POST /uploads/url: upload kinds by role', () => {
  it('a student may upload identity documents and an avatar, nothing of a shop', async () => {
    expect(await grantedKinds('STUDENT')).toEqual(['ID_CARD', 'GOVT_ID', 'AVATAR']);
  });

  it.each(['SHOP_OWNER', 'SHOP_STAFF'] as const)(
    'a %s may upload shop documents, catalog images and an avatar, no identity documents',
    async (role) => {
      expect(await grantedKinds(role)).toEqual(['SHOP_DOCUMENT', 'CATALOG_IMAGE', 'AVATAR']);
    },
  );

  it.each(['ADMIN', 'SUPER_ADMIN'] as const)('a %s may upload nothing', async (role) => {
    expect(await grantedKinds(role)).toEqual([]);
  });

  it('keys an allowed upload to the caller, never to an id from the request', async () => {
    const { controller, createUploadUrl } = build();

    await controller.createUploadUrl(as('STUDENT'), {
      ...body('ID_CARD'),
      originalFilename: 'card.png',
    });

    expect(createUploadUrl).toHaveBeenCalledWith({
      kind: 'ID_CARD',
      ownerId: 'student-1',
      contentType: 'image/png',
      sizeBytes: 1024,
      originalFilename: 'card.png',
    });
  });
});
