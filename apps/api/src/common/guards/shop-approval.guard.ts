import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_UNAPPROVED_SHOP_KEY } from '../decorators/allow-unapproved-shop.decorator';
import {
  SHOP_NOT_APPROVED_CODE,
  SHOP_NOT_APPROVED_MESSAGE,
  isShopRole,
} from '../access/shop-access.service';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * FR-SHOP-09 / FR-SHOP-11: a shop account does nothing until an administrator
 * has approved one of its listings.
 *
 * POST /shops/register is public and creates a SHOP_OWNER account for
 * whichever college the caller names. Without this guard that account could
 * log in and use every endpoint open to "any authenticated user of the
 * college" — browse, search, delivery points, uploads, the socket — before
 * anybody had looked at the registration. A made-up shop was a free pass into
 * a college.
 *
 * Applied globally and refusing by default: a new endpoint is closed to
 * unapproved shop accounts unless it carries @AllowUnapprovedShop. Runs
 * before RolesGuard so the caller gets the code that explains the refusal
 * (and that the dashboard can route on) instead of a generic role error.
 */
@Injectable()
export class ShopApprovalGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const user = context.switchToHttp().getRequest().user as AuthenticatedUser | undefined;
    // No user on a non-public route is the authentication guard's refusal to
    // make; this guard only has an opinion about shop accounts.
    if (!user || !isShopRole(user.role)) return true;

    // Strictly `=== true`: an AuthenticatedUser built without the flag is
    // treated as unapproved rather than waved through.
    if (user.shopApproved === true) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_UNAPPROVED_SHOP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;

    throw new ForbiddenException({
      code: SHOP_NOT_APPROVED_CODE,
      message: SHOP_NOT_APPROVED_MESSAGE,
    });
  }
}
