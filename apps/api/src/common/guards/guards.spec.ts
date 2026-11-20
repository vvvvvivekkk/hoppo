import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { VerifiedGuard } from './verified.guard';
import { Roles } from '../decorators/roles.decorator';
import { RequireVerified } from '../decorators/require-verified.decorator';
import type { AuthenticatedUser } from '../types/authenticated-user';

/** A minimal ExecutionContext carrying a user on the request. */
function contextWith(user?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

/** A Reflector stubbed to return fixed metadata. */
function reflectorReturning(values: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (key: string) => values[key],
  } as unknown as Reflector;
}

const student: AuthenticatedUser = {
  userId: 'u1',
  collegeId: 'c1',
  role: 'STUDENT',
  isVerified: true,
};

describe('RolesGuard', () => {
  it('allows an endpoint with no @Roles to any authenticated user', () => {
    const guard = new RolesGuard(reflectorReturning({}));
    expect(guard.canActivate(contextWith(student))).toBe(true);
  });

  it('allows a public endpoint without a user', () => {
    const guard = new RolesGuard(reflectorReturning({ isPublic: true }));
    expect(guard.canActivate(contextWith(undefined))).toBe(true);
  });

  it('blocks a student from an ADMIN endpoint', () => {
    const guard = new RolesGuard(reflectorReturning({ roles: ['ADMIN'] }));
    expect(() => guard.canActivate(contextWith(student))).toThrow(ForbiddenException);
  });

  it('allows an admin on an ADMIN endpoint', () => {
    const guard = new RolesGuard(reflectorReturning({ roles: ['ADMIN'] }));
    expect(guard.canActivate(contextWith({ ...student, role: 'ADMIN' }))).toBe(true);
  });

  it('lets a super administrator past every role check', () => {
    const guard = new RolesGuard(reflectorReturning({ roles: ['SHOP_OWNER'] }));
    expect(guard.canActivate(contextWith({ ...student, role: 'SUPER_ADMIN' }))).toBe(true);
  });

  it('refuses a protected endpoint with no authenticated user', () => {
    const guard = new RolesGuard(reflectorReturning({ roles: ['ADMIN'] }));
    expect(() => guard.canActivate(contextWith(undefined))).toThrow(ForbiddenException);
  });

  // A route that lists only STUDENT is a student acting on their own
  // account. The platform owner is not a student: the blanket pass used to
  // let a super administrator reach POST /account/delete.
  it('does not let a super administrator onto a student-only endpoint', () => {
    const guard = new RolesGuard(reflectorReturning({ roles: ['STUDENT'] }));
    expect(() => guard.canActivate(contextWith({ ...student, role: 'SUPER_ADMIN' }))).toThrow(
      ForbiddenException,
    );
    // The student it is for still passes.
    expect(guard.canActivate(contextWith(student))).toBe(true);
  });

  it('lets a super administrator onto any endpoint that names a staff role', () => {
    for (const roles of [['ADMIN'], ['SHOP_OWNER', 'SHOP_STAFF'], ['STUDENT', 'ADMIN']]) {
      const guard = new RolesGuard(reflectorReturning({ roles }));
      expect(guard.canActivate(contextWith({ ...student, role: 'SUPER_ADMIN' }))).toBe(true);
    }
  });
});

describe('VerifiedGuard', () => {
  it('ignores endpoints without @RequireVerified (FR-SVER-01: browsing stays open)', () => {
    const guard = new VerifiedGuard(reflectorReturning({}));
    expect(guard.canActivate(contextWith({ ...student, isVerified: false }))).toBe(true);
  });

  it('blocks an unverified student from a gated endpoint', () => {
    const guard = new VerifiedGuard(reflectorReturning({ requireVerified: true }));
    expect(() => guard.canActivate(contextWith({ ...student, isVerified: false }))).toThrow(
      ForbiddenException,
    );
  });

  it('returns a code the mobile app can route on, not a bare 403', () => {
    const guard = new VerifiedGuard(reflectorReturning({ requireVerified: true }));
    try {
      guard.canActivate(contextWith({ ...student, isVerified: false }));
      fail('expected a ForbiddenException');
    } catch (e) {
      const body = (e as ForbiddenException).getResponse() as Record<string, string>;
      expect(body.code).toBe('VERIFICATION_REQUIRED');
    }
  });

  it('allows a verified student through (FR-SVER-07)', () => {
    const guard = new VerifiedGuard(reflectorReturning({ requireVerified: true }));
    expect(guard.canActivate(contextWith({ ...student, isVerified: true }))).toBe(true);
  });

  // A5 item 2. @RequireVerified means "a verified student"; it used to let
  // every non-student role through, so the gate was only as strong as each
  // controller remembering to pair it with @Roles('STUDENT').
  it.each(['SHOP_OWNER', 'SHOP_STAFF', 'ADMIN', 'SUPER_ADMIN'] as const)(
    'refuses a %s on a gated endpoint that does not name that role',
    (role) => {
      const guard = new VerifiedGuard(reflectorReturning({ requireVerified: true }));
      const call = () => guard.canActivate(contextWith({ ...student, role, isVerified: false }));
      expect(call).toThrow(ForbiddenException);
      try {
        call();
      } catch (e) {
        const body = (e as ForbiddenException).getResponse() as Record<string, string>;
        expect(body.code).toBe('STUDENT_ACCOUNT_REQUIRED');
      }
    },
  );

  it('refuses a staff role on a gated endpoint restricted to students', () => {
    const guard = new VerifiedGuard(
      reflectorReturning({ requireVerified: true, roles: ['STUDENT'] }),
    );
    expect(() =>
      guard.canActivate(contextWith({ ...student, role: 'SHOP_OWNER', isVerified: false })),
    ).toThrow(ForbiddenException);
    // RolesGuard lets a super administrator past @Roles('STUDENT'); this guard
    // is what stops them placing orders or going on shift as a rider.
    expect(() =>
      guard.canActivate(contextWith({ ...student, role: 'SUPER_ADMIN', isVerified: false })),
    ).toThrow(ForbiddenException);
  });

  it('lets a staff role through only where the route names that role', () => {
    const guard = new VerifiedGuard(
      reflectorReturning({ requireVerified: true, roles: ['STUDENT', 'SHOP_OWNER', 'ADMIN'] }),
    );
    const as = (role: AuthenticatedUser['role']) =>
      guard.canActivate(contextWith({ ...student, role, isVerified: false }));

    expect(as('SHOP_OWNER')).toBe(true);
    expect(as('ADMIN')).toBe(true);
    // Wherever a staff role is named, a super administrator may go too.
    expect(as('SUPER_ADMIN')).toBe(true);
    // Not named, so not allowed.
    expect(() => as('SHOP_STAFF')).toThrow(ForbiddenException);
    // And naming staff roles does not loosen the rule for students.
    expect(() => as('STUDENT')).toThrow(ForbiddenException);
  });
});

/**
 * The guards against real decorator metadata, not a stubbed Reflector.
 *
 * `Reflector.getAllAndOverride([handler, class])` returns the first value
 * that is defined, so a handler-level @Roles REPLACES the class-level list
 * (it does not merge with it). The orders controller relies on exactly that
 * for GET /orders/:orderId; this pins the behaviour for both guards.
 */
describe('class-level and handler-level @Roles under @RequireVerified', () => {
  @Roles('STUDENT')
  @RequireVerified()
  class StudentThings {
    place(): void {}

    @Roles('STUDENT', 'SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')
    detail(): void {}
  }

  const reflector = new Reflector();
  const roles = new RolesGuard(reflector);
  const verified = new VerifiedGuard(reflector);

  const run = (handler: 'place' | 'detail', user: AuthenticatedUser): boolean => {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => StudentThings.prototype[handler],
      getClass: () => StudentThings,
    } as unknown as ExecutionContext;
    return roles.canActivate(context) && verified.canActivate(context);
  };

  const shopOwner: AuthenticatedUser = { ...student, role: 'SHOP_OWNER', isVerified: false };

  it('the handler-level list overrides the class-level one', () => {
    expect(run('detail', shopOwner)).toBe(true);
    expect(run('detail', { ...shopOwner, role: 'ADMIN' })).toBe(true);
    expect(run('detail', { ...shopOwner, role: 'SUPER_ADMIN' })).toBe(true);
  });

  it('a handler without its own list keeps the class-level restriction', () => {
    expect(() => run('place', shopOwner)).toThrow(ForbiddenException);
    expect(() => run('place', { ...shopOwner, role: 'ADMIN' })).toThrow(ForbiddenException);
    expect(() => run('place', { ...shopOwner, role: 'SUPER_ADMIN' })).toThrow(ForbiddenException);
  });

  it('students are still held to verification on both', () => {
    expect(run('place', student)).toBe(true);
    expect(run('detail', student)).toBe(true);
    expect(() => run('place', { ...student, isVerified: false })).toThrow(ForbiddenException);
    expect(() => run('detail', { ...student, isVerified: false })).toThrow(ForbiddenException);
  });
});
