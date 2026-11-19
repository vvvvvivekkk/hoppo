import { SetMetadata } from '@nestjs/common';

export const REQUIRE_VERIFIED_KEY = 'requireVerified';

/**
 * FR-SVER-01: a student with status PENDING_VERIFICATION may read shop
 * catalogs but may not place orders, enable work mode, or post to the
 * community. FR-SVER-07 opens all of that on approval.
 *
 * Applied to every endpoint behind that gate, so the rule lives in one place
 * rather than as a repeated `if (!user.isVerified) throw ...` in each service.
 */
export const RequireVerified = () => SetMetadata(REQUIRE_VERIFIED_KEY, true);
