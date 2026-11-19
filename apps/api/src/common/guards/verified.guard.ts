import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_VERIFIED_KEY } from '../decorators/require-verified.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
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

    // Staff roles are not subject to student verification.
    if (user.role !== 'STUDENT') return true;

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
