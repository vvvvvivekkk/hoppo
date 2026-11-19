import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ShopApprovalGuard } from './shop-approval.guard';
import { RolesGuard } from './roles.guard';
import { VerifiedGuard } from './verified.guard';
import { AllowUnapprovedShop } from '../decorators/allow-unapproved-shop.decorator';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';
import { RequireVerified } from '../decorators/require-verified.decorator';
import { clampPageLimit } from '../pagination';
import type { AuthenticatedUser } from '../types/authenticated-user';
import { AuthController } from '../../auth/auth.controller';
import {
  AdminShopsController,
  BrowseController,
  ShopsController,
} from '../../shops/shops.controller';
import { VerificationController } from '../../verification/verification.controller';

/**
 * "A fake shop owner can use student features."
 *
 * POST /shops/register is public and creates a SHOP_OWNER account. These
 * tests run the role-related guards in the order AppModule registers them,
 * against real decorator metadata, for an owner whose shop nobody has
 * approved.
 */
type Handler = (...args: never[]) => unknown;

function contextFor(cls: object, handler: Handler, user?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

const reflector = new Reflector();
// The order in AppModule, after authentication and throttling.
const chain = [
  new ShopApprovalGuard(reflector),
  new RolesGuard(reflector),
  new VerifiedGuard(reflector),
];

function attempt(cls: object, handler: Handler, user?: AuthenticatedUser): true | string {
  const context = contextFor(cls, handler, user);
  try {
    for (const guard of chain) {
      if (!guard.canActivate(context)) return 'DENIED';
    }
    return true;
  } catch (e) {
    if (!(e instanceof ForbiddenException)) throw e;
    const body = e.getResponse() as { code?: string; message?: string };
    return body.code ?? 'ROLE_REFUSED';
  }
}

const pendingOwner: AuthenticatedUser = {
  userId: 'owner-1',
  collegeId: 'college-a',
  role: 'SHOP_OWNER',
  isVerified: false,
  shopApproved: false,
};
const approvedOwner: AuthenticatedUser = { ...pendingOwner, shopApproved: true };

// Shapes of controllers this lane does not own, declared locally so the test
// does not depend on another lane's file.
@Roles('STUDENT')
@RequireVerified()
class StudentOnly {
  act(): void {}
}

@Roles('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')
class ShopConsole {
  act(): void {}
}

class AnyAuthenticated {
  act(): void {}

  @Public()
  open(): void {}

  @AllowUnapprovedShop()
  status(): void {}
}

describe('ShopApprovalGuard: an unapproved shop account', () => {
  it('may read its own registration status, who-am-I, and log out', () => {
    expect(attempt(ShopsController, ShopsController.prototype.myShops, pendingOwner)).toBe(true);
    expect(attempt(AuthController, AuthController.prototype.me, pendingOwner)).toBe(true);
    expect(attempt(AuthController, AuthController.prototype.logout, pendingOwner)).toBe(true);
  });

  it('is refused the college-wide browse endpoints with SHOP_NOT_APPROVED', () => {
    const browse = BrowseController.prototype;
    for (const handler of [
      browse.browse,
      browse.searchItems,
      browse.deliveryPoints,
      browse.shopDetail,
    ]) {
      expect(attempt(BrowseController, handler, pendingOwner)).toBe('SHOP_NOT_APPROVED');
    }
  });

  it('is refused student, shop-console and undecorated endpoints alike', () => {
    expect(attempt(StudentOnly, StudentOnly.prototype.act, pendingOwner)).toBe('SHOP_NOT_APPROVED');
    expect(attempt(ShopConsole, ShopConsole.prototype.act, pendingOwner)).toBe('SHOP_NOT_APPROVED');
    expect(attempt(AnyAuthenticated, AnyAuthenticated.prototype.act, pendingOwner)).toBe(
      'SHOP_NOT_APPROVED',
    );
    expect(
      attempt(VerificationController, VerificationController.prototype.myStatus, pendingOwner),
    ).toBe('SHOP_NOT_APPROVED');
  });

  it('is treated as unapproved when the flag is missing altogether', () => {
    const noFlag: AuthenticatedUser = { ...pendingOwner };
    delete noFlag.shopApproved;
    expect(attempt(AnyAuthenticated, AnyAuthenticated.prototype.act, noFlag)).toBe(
      'SHOP_NOT_APPROVED',
    );
    expect(
      attempt(AnyAuthenticated, AnyAuthenticated.prototype.act, {
        ...noFlag,
        role: 'SHOP_STAFF',
      }),
    ).toBe('SHOP_NOT_APPROVED');
  });

  it('is not stopped by this guard on public or explicitly allowed routes', () => {
    expect(attempt(AnyAuthenticated, AnyAuthenticated.prototype.open, pendingOwner)).toBe(true);
    expect(attempt(AnyAuthenticated, AnyAuthenticated.prototype.status, pendingOwner)).toBe(true);
  });
});

describe('ShopApprovalGuard: everybody else', () => {
  it('lets an approved shop account reach its console and the browse endpoints', () => {
    expect(attempt(ShopConsole, ShopConsole.prototype.act, approvedOwner)).toBe(true);
    expect(attempt(BrowseController, BrowseController.prototype.browse, approvedOwner)).toBe(true);
  });

  it('still keeps an approved shop account out of student features', () => {
    // RolesGuard refuses first here; VerifiedGuard would refuse too.
    expect(attempt(StudentOnly, StudentOnly.prototype.act, approvedOwner)).toBe('ROLE_REFUSED');
    expect(
      attempt(VerificationController, VerificationController.prototype.submit, approvedOwner),
    ).toBe('ROLE_REFUSED');
  });

  it('does not affect students or administrators', () => {
    const student: AuthenticatedUser = {
      userId: 's1',
      collegeId: 'college-a',
      role: 'STUDENT',
      isVerified: true,
    };
    const admin: AuthenticatedUser = { ...student, userId: 'a1', role: 'ADMIN' };

    expect(attempt(StudentOnly, StudentOnly.prototype.act, student)).toBe(true);
    expect(attempt(BrowseController, BrowseController.prototype.browse, student)).toBe(true);
    expect(attempt(AdminShopsController, AdminShopsController.prototype.queue, admin)).toBe(true);
    expect(attempt(AdminShopsController, AdminShopsController.prototype.queue, student)).toBe(
      'ROLE_REFUSED',
    );
    expect(attempt(AdminShopsController, AdminShopsController.prototype.queue, approvedOwner)).toBe(
      'ROLE_REFUSED',
    );
  });
});

describe('clampPageLimit', () => {
  it('falls back to the default for anything that is not a whole number', () => {
    for (const raw of [undefined, null, '', 'abc', 'NaN', '12.5', 'Infinity', Number.NaN]) {
      expect(clampPageLimit(raw)).toBe(25);
    }
  });

  it('clamps to 1..100', () => {
    expect(clampPageLimit('0')).toBe(1);
    expect(clampPageLimit('-7')).toBe(1);
    expect(clampPageLimit('1')).toBe(1);
    expect(clampPageLimit('100')).toBe(100);
    expect(clampPageLimit('101')).toBe(100);
    expect(clampPageLimit('999999999')).toBe(100);
    expect(clampPageLimit(40)).toBe(40);
  });
});
