import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import { RiderController, TasksController } from './rider.controller';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { REQUIRE_VERIFIED_KEY } from '../common/decorators/require-verified.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * H6: who may call the rider and requester endpoints at all.
 *
 * `@RequireVerified()` is not a role gate — VerifiedGuard passes every role
 * that is not STUDENT, because staff are not subject to student
 * verification. On its own it let a shop or admin account call these
 * endpoints. `@Roles('STUDENT')` is what closes that, and it is a decorator:
 * easy to drop in a refactor, invisible when missing. So it is pinned here
 * twice — the metadata, and the real RolesGuard reading it off the real
 * controller class.
 *
 * Before the fix neither controller carried @Roles, so the metadata is
 * undefined and RolesGuard ("no @Roles means any authenticated user") lets
 * every role through. Every test below fails on that.
 */

function userWith(role: UserRole): AuthenticatedUser {
  return { userId: 'u1', collegeId: 'c1', role, isVerified: true };
}

/** The real guard, the real Reflector, the real controller class and method. */
function guardAllows(controller: object, handlerName: string, role: UserRole): boolean {
  const handler = (controller as { prototype: Record<string, () => unknown> }).prototype[handlerName];
  expect(typeof handler).toBe('function');

  const context = {
    switchToHttp: () => ({ getRequest: () => ({ user: userWith(role) }) }),
    getHandler: () => handler,
    getClass: () => controller,
  } as unknown as ExecutionContext;

  return new RolesGuard(new Reflector()).canActivate(context);
}

const NON_STUDENT_ROLES: UserRole[] = ['SHOP_OWNER', 'SHOP_STAFF', 'ADMIN'];

describe('TasksController — the requester side of the handover (H6)', () => {
  it('is restricted to STUDENT', () => {
    expect(Reflect.getMetadata(ROLES_KEY, TasksController)).toEqual(['STUDENT']);
  });

  it('still requires verification as well', () => {
    expect(Reflect.getMetadata(REQUIRE_VERIFIED_KEY, TasksController)).toBe(true);
  });

  it.each(NON_STUDENT_ROLES)('refuses a %s the handover-code endpoints', (role) => {
    for (const handler of ['handoverCode', 'reissueHandoverCode']) {
      expect(() => guardAllows(TasksController, handler, role)).toThrow(ForbiddenException);
    }
  });

  it('admits a student to both endpoints', () => {
    expect(guardAllows(TasksController, 'handoverCode', 'STUDENT')).toBe(true);
    expect(guardAllows(TasksController, 'reissueHandoverCode', 'STUDENT')).toBe(true);
  });

  it('has no handler that overrides the class-level restriction', () => {
    // getAllAndOverride prefers handler metadata, so a stray method-level
    // @Roles would silently widen one endpoint.
    for (const handler of ['handoverCode', 'reissueHandoverCode']) {
      expect(Reflect.getMetadata(ROLES_KEY, TasksController.prototype[handler as never])).toBeUndefined();
    }
  });
});

describe('RiderController — work mode and deliveries (H6)', () => {
  const HANDLERS = ['status', 'setWorkMode', 'ping', 'accept', 'abandon', 'taskDetail', 'pickup', 'handover'];

  it('is restricted to STUDENT', () => {
    expect(Reflect.getMetadata(ROLES_KEY, RiderController)).toEqual(['STUDENT']);
  });

  it.each(NON_STUDENT_ROLES)('refuses a %s every rider endpoint', (role) => {
    for (const handler of HANDLERS) {
      expect(() => guardAllows(RiderController, handler, role)).toThrow(ForbiddenException);
    }
  });

  it('admits a student to every rider endpoint', () => {
    for (const handler of HANDLERS) {
      expect(guardAllows(RiderController, handler, 'STUDENT')).toBe(true);
    }
  });
});
