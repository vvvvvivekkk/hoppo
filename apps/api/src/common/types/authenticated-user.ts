import type { UserRole } from '@prisma/client';

/**
 * What the JWT guard puts on the request after validating a token.
 *
 * `collegeId` is read from the *token*, never from the request body or a
 * query parameter. NFR-S-05: the client is never trusted to scope data by
 * college or by role. If the college came from the request, any student could
 * read another college's orders by changing one field.
 */
export interface AuthenticatedUser {
  userId: string;
  /** Null only for a SUPER_ADMIN, who belongs to no college. */
  collegeId: string | null;
  role: UserRole;
  /** True when the student's identity verification has been approved. */
  isVerified: boolean;
  /**
   * For SHOP_OWNER / SHOP_STAFF: true once an administrator has approved a
   * listing of a shop this account belongs to. Read from the database on
   * every request, never from the token. Absent for other roles, and
   * ShopApprovalGuard treats absent as "not approved".
   */
  shopApproved?: boolean;
  /** Token family, so a refresh rotation can revoke the whole chain. */
  familyId?: string;
}

/** The shape of the signed access token payload. */
export interface AccessTokenPayload {
  sub: string;
  cid: string | null;
  role: UserRole;
  ver: boolean;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  sub: string;
  fam: string;
  iat?: number;
  exp?: number;
}
