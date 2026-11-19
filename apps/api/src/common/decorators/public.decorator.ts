import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks an endpoint as reachable without a token.
 *
 * Authentication is applied globally and endpoints opt *out*, rather than
 * applied per-controller and endpoints opting in. The difference matters: a
 * new endpoint that forgets this decorator is merely inconvenient, whereas a
 * new endpoint that forgets to add a guard is a data leak. Making the safe
 * case the default is the whole point.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
