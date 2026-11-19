import { SetMetadata } from '@nestjs/common';

export const ALLOW_UNAPPROVED_SHOP_KEY = 'allowUnapprovedShop';

/**
 * Marks an endpoint a shop account may call before any of its listings has
 * been approved by an administrator.
 *
 * Shop registration is public and creates an account immediately (FR-SHOP-01),
 * so a shop login proves nothing until an administrator has approved a
 * listing (FR-SHOP-11). ShopApprovalGuard therefore refuses an unapproved shop
 * account everywhere, and endpoints opt *in* with this decorator — the same
 * safe-by-default shape as @Public. The list is meant to stay very short: the
 * owner's own registration status, who-am-I, and logout.
 */
export const AllowUnapprovedShop = () => SetMetadata(ALLOW_UNAPPROVED_SHOP_KEY, true);
