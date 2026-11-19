import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Injects the authenticated user into a handler parameter:
 *
 *   findMyOrders(@CurrentUser() user: AuthenticatedUser) { ... }
 *
 * Reading it from the request object by hand works too, but this keeps the
 * type attached and makes it obvious at the signature which handlers depend
 * on who is calling.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthenticatedUser;
  },
);
