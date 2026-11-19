import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_VERIFIED_KEY } from '../decorators/require-verified.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * FR-SVER-01 / FR-SVER-07: the gate between a registered student and a
 * verified one.
 *
 * The error carries a machine-readable code so the mobile app can route the
 * student to the verification screen rather than showing a generic "forbidden"
 * message — which, for someone waiting on an administrator to approve their
 * ID card, would be actively confusing.
 */
@Injectable()
export class VerifiedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_VERIFIED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const user = context.switchToHttp().getRequest().user as AuthenticatedUser | undefined;
    if (!user) throw new ForbiddenException('Not authenticated');

    // @RequireVerified means "a verified student". A shop, administrator or
    // super-administrator login is not one, so it does not pass — this used
    // to wave every non-student role through, which made the gate only as
    // good as each controller remembering to add @Roles('STUDENT') as well.
    //
    // The one exception is a route that names the caller's role itself. A
    // handler-level @Roles('STUDENT', 'SHOP_OWNER', ...) under a class-level
    // @RequireVerified (GET /orders/:orderId) is an explicit statement that
    // those staff roles belong there, and student verification has no meaning
    // for them. A super administrator follows RolesGuard's rule: wherever any
    // staff role is listed, they may go too.
    if (user.role !== 'STUDENT') {
      const roles =
        this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
          context.getHandler(),
          context.getClass(),
        ]) ?? [];

      const explicitlyAllowed =
        user.role === 'SUPER_ADMIN'
          ? roles.some((role) => role !== 'STUDENT')
          : roles.includes(user.role);

      if (explicitlyAllowed) return true;

      throw new ForbiddenException({
        code: 'STUDENT_ACCOUNT_REQUIRED',
        message: 'This action is only available to verified student accounts.',
      });
    }

    if (!user.isVerified) {
      throw new ForbiddenException({
        code: 'VERIFICATION_REQUIRED',
        message:
          'Your student verification is not yet approved. You can browse shops, but ' +
          'ordering, work mode and posting unlock once an administrator approves your ID.',
      });
    }

    return true;
  }
}
