import { Injectable } from '@nestjs/common';
import type { ShopStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Listing states that mean "an administrator approved this shop".
 *
 * SUSPENDED counts: a listing only becomes SUSPENDED from ACTIVE, and
 * FR-SHOP-12 requires a suspended shop's in-flight orders to complete, which
 * its staff cannot do if they are locked out of the API. What a suspended
 * shop may still do is decided by the endpoints (new orders are blocked, the
 * listing is hidden); this list only decides whether the account has ever
 * been vouched for. PENDING_VERIFICATION and REJECTED have not.
 */
export const APPROVED_LISTING_STATUSES: readonly ShopStatus[] = ['ACTIVE', 'SUSPENDED'];

export const SHOP_NOT_APPROVED_CODE = 'SHOP_NOT_APPROVED';

export const SHOP_NOT_APPROVED_MESSAGE =
  'Your shop has not been approved by a campus administrator yet. ' +
  'You can check the status of your registration; everything else unlocks on approval.';

/** The roles whose access depends on a shop having been approved. */
export function isShopRole(role: UserRole | string): boolean {
  return role === 'SHOP_OWNER' || role === 'SHOP_STAFF';
}

/**
 * The one place that answers "has anybody approved the shop this account
 * belongs to?". Used by the JWT strategy for HTTP and by the socket
 * middleware for the real-time channel, so the two cannot drift apart.
 */
@Injectable()
export class ShopAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * True when the user is on the staff of at least one shop with at least
   * one approved listing. One indexed lookup (shop_staff has an index on
   * user_id), and only ever made for shop accounts.
   */
  async hasApprovedShop(userId: string): Promise<boolean> {
    const row = await this.prisma.shopStaff.findFirst({
      where: {
        userId,
        shop: { listings: { some: { status: { in: [...APPROVED_LISTING_STATUSES] } } } },
      },
      select: { shopId: true },
    });
    return row !== null;
  }
}
