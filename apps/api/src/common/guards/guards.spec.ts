import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { VerifiedGuard } from './verified.guard';
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

  it('does not apply student verification to staff roles', () => {
    const guard = new VerifiedGuard(reflectorReturning({ requireVerified: true }));
    expect(
      guard.canActivate(contextWith({ ...student, role: 'SHOP_OWNER', isVerified: false })),
    ).toBe(true);
    expect(
      guard.canActivate(contextWith({ ...student, role: 'ADMIN', isVerified: false })),
    ).toBe(true);
  });
});
