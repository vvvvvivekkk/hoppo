import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TenantService } from './tenant.service';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Constraint C-1 is the single most important security property in this
 * system: a student at one college must never see another college's data.
 * These tests exist because that property is easy to break silently and
 * impossible to notice from the outside until it matters.
 */
describe('TenantService', () => {
  let tenant: TenantService;

  const student = (collegeId: string | null = 'college-a'): AuthenticatedUser => ({
    userId: 'u-student',
    collegeId,
    role: 'STUDENT',
    isVerified: true,
  });

  const admin = (collegeId: string | null = 'college-a'): AuthenticatedUser => ({
    userId: 'u-admin',
    collegeId,
    role: 'ADMIN',
    isVerified: true,
  });

  const superAdmin = (): AuthenticatedUser => ({
    userId: 'u-super',
    collegeId: null,
    role: 'SUPER_ADMIN',
    isVerified: true,
  });

  beforeEach(() => {
    tenant = new TenantService();
  });

  describe('scope', () => {
    it('pins an ordinary user to their own college', () => {
      expect(tenant.scope(student('college-a'))).toEqual({ collegeId: 'college-a' });
      expect(tenant.scope(admin('college-b'))).toEqual({ collegeId: 'college-b' });
    });

    it('leaves a super administrator unscoped (FR-ADM-07)', () => {
      expect(tenant.scope(superAdmin())).toEqual({});
    });

    it('refuses rather than returning an unscoped query when college is missing', () => {
      // The database check constraint makes this unreachable. If it is ever
      // dropped, this must fail closed — an empty scope here would return
      // every college's rows.
      expect(() => tenant.scope(student(null))).toThrow(ForbiddenException);
    });
  });

  describe('assertSameTenant', () => {
    it('allows a resource in the caller’s own college', () => {
      const resource = { collegeId: 'college-a', id: 'r1' };
      expect(tenant.assertSameTenant(student('college-a'), resource)).toBe(resource);
    });

    it('rejects a resource from another college (FR-TEN-03)', () => {
      const resource = { collegeId: 'college-b', id: 'r1' };
      expect(() => tenant.assertSameTenant(admin('college-a'), resource)).toThrow(
        ForbiddenException,
      );
    });

    it('reports a cross-tenant attempt with a machine-readable code', () => {
      const resource = { collegeId: 'college-b', id: 'r1' };
      try {
        tenant.assertSameTenant(admin('college-a'), resource, 'Order');
        fail('expected a ForbiddenException');
      } catch (e) {
        const body = (e as ForbiddenException).getResponse() as Record<string, string>;
        expect(body.code).toBe('CROSS_TENANT_ACCESS');
        expect(body.message).toContain('Order');
      }
    });

    it('404s a missing resource rather than 403', () => {
      expect(() => tenant.assertSameTenant(admin(), null, 'Shop')).toThrow(NotFoundException);
    });

    it('lets a super administrator across tenants', () => {
      const resource = { collegeId: 'college-z', id: 'r1' };
      expect(tenant.assertSameTenant(superAdmin(), resource)).toBe(resource);
    });

    it('rejects a resource with a null college for an ordinary user', () => {
      // A row with no college cannot be proven to belong to this caller.
      expect(() => tenant.assertSameTenant(student('college-a'), { collegeId: null })).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('assertSameTenantVia', () => {
    it('allows a matching indirect college', () => {
      expect(() => tenant.assertSameTenantVia(student('college-a'), 'college-a')).not.toThrow();
    });

    it('rejects a mismatched indirect college', () => {
      expect(() => tenant.assertSameTenantVia(student('college-a'), 'college-b')).toThrow(
        ForbiddenException,
      );
    });

    it('treats an undefined college as not found', () => {
      expect(() => tenant.assertSameTenantVia(student('college-a'), undefined)).toThrow(
        NotFoundException,
      );
    });
  });

  describe('ownership', () => {
    it('lets a user act on their own row', () => {
      expect(tenant.isOwnerOrStaff(student(), 'u-student')).toBe(true);
    });

    it('does not let one student act on another’s row', () => {
      expect(tenant.isOwnerOrStaff(student(), 'someone-else')).toBe(false);
      expect(() => tenant.assertOwnerOrStaff(student(), 'someone-else')).toThrow(
        ForbiddenException,
      );
    });

    it('lets an administrator act on a student’s row', () => {
      expect(tenant.isOwnerOrStaff(admin(), 'u-student')).toBe(true);
    });
  });
});
