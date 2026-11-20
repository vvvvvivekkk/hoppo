import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedUser } from '../types/authenticated-user';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles on the endpoint means any authenticated user may call it.
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as AuthenticatedUser | undefined;
    if (!user) throw new ForbiddenException('Not authenticated');

    // A super administrator passes every *staff* role check. They create
    // tenants and manage administrators, so gating them per-endpoint would
    // mean listing SUPER_ADMIN on nearly every admin and shop route.
    //
    // They do not pass a route that lists only STUDENT. Those routes are a
    // student acting on their own account — placing an order, exporting or
    // deleting "my" data — and the platform owner is not a student: the old
    // blanket pass let a super administrator reach POST /account/delete and
    // close the platform's own account. This is the same rule VerifiedGuard
    // applies.
    if (user.role === 'SUPER_ADMIN' && required.some((role) => role !== 'STUDENT')) return true;

    if (!required.includes(user.role)) {
      throw new ForbiddenException(
        `This action requires one of: ${required.join(', ')}`,
      );
    }

    return true;
  }
}
