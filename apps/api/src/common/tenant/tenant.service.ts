import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Constraint C-1: "All data access shall be scoped by college_id. No query may
 * return records belonging to another tenant."
 *
 * A guard cannot enforce this alone. A guard runs before the handler and knows
 * who is calling, but it does not know which college the *requested resource*
 * belongs to without fetching it — and fetching it is the handler's job. So
 * tenancy is enforced in two halves:
 *
 *   1. **List queries** filter on the college from the token. `scope()` builds
 *      that filter, so no call site writes `collegeId` by hand and none can
 *      forget it.
 *
 *   2. **Single-resource reads** fetch, then check. `assertSameTenant()` does
 *      the check and throws the response FR-TEN-03 asks for.
 *
 * The rule for reviewers is short enough to hold in your head: every Prisma
 * query in a feature module either spreads `scope(user)` into its `where`, or
 * passes its result through `assertSameTenant`. There is no third option.
 */
@Injectable()
export class TenantService {
  /**
   * The `where` fragment that scopes a query to the caller's college.
   *
   * A super administrator is unscoped, because they operate across tenants by
   * definition (FR-ADM-07). Every other role is pinned to one college.
   *
   * Usage:
   *   prisma.order.findMany({ where: { ...tenant.scope(user), status: 'PLACED' } })
   */
  scope(user: AuthenticatedUser): { collegeId?: string } {
    if (user.role === 'SUPER_ADMIN') return {};

    if (!user.collegeId) {
      // The database check constraint makes this unreachable, but an
      // unreachable branch that fails loudly is better than one that returns
      // an unscoped query if the constraint is ever dropped.
      throw new ForbiddenException('Account is not attached to a college');
    }

    return { collegeId: user.collegeId };
  }

  /** The caller's college id, for writes that must set it explicitly. */
  requireCollegeId(user: AuthenticatedUser): string {
    if (!user.collegeId) {
      throw new ForbiddenException('This action requires an account attached to a college');
    }
    return user.collegeId;
  }

  /**
   * FR-TEN-03: "The system shall reject any request in which the authenticated
   * user's college_id differs from that of the requested resource, returning
   * an authorisation error."
   *
   * Note it returns 403 rather than 404. The SRS asks for an authorisation
   * error, and that is the right call here: these are opaque UUIDs, so there
   * is no id to enumerate, and a 403 tells an honest caller with a stale link
   * something true. Where ids were sequential this would leak existence and
   * 404 would be better.
   */
  assertSameTenant<T extends { collegeId: string | null }>(
    user: AuthenticatedUser,
    resource: T | null,
    resourceName = 'Resource',
  ): T {
    if (!resource) {
      throw new NotFoundException(`${resourceName} not found`);
    }

    if (user.role === 'SUPER_ADMIN') return resource;

    if (resource.collegeId !== user.collegeId) {
      throw new ForbiddenException({
        code: 'CROSS_TENANT_ACCESS',
        message: `${resourceName} belongs to a different college`,
      });
    }

    return resource;
  }

  /**
   * The same check for a resource that reaches its college indirectly — an
   * order item through its order, a catalog item through its shop listing.
   */
  assertSameTenantVia(
    user: AuthenticatedUser,
    resourceCollegeId: string | null | undefined,
    resourceName = 'Resource',
  ): void {
    if (user.role === 'SUPER_ADMIN') return;

    if (resourceCollegeId === null || resourceCollegeId === undefined) {
      throw new NotFoundException(`${resourceName} not found`);
    }

    if (resourceCollegeId !== user.collegeId) {
      throw new ForbiddenException({
        code: 'CROSS_TENANT_ACCESS',
        message: `${resourceName} belongs to a different college`,
      });
    }
  }

  /** True when this user owns the row, or is staff who may act on it anyway. */
  isOwnerOrStaff(user: AuthenticatedUser, ownerUserId: string): boolean {
    if (user.userId === ownerUserId) return true;
    return user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
  }

  assertOwnerOrStaff(user: AuthenticatedUser, ownerUserId: string, what = 'this resource'): void {
    if (!this.isOwnerOrStaff(user, ownerUserId)) {
      throw new ForbiddenException(`You do not have permission to act on ${what}`);
    }
  }
}
