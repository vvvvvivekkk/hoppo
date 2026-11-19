'use client';

import { ApiError } from '@hoppo/api-client';
import type { MyShop } from '@hoppo/api-client';
import { Banner, Card, Status } from '@/components/ui';

type Listing = MyShop['listings'][number];

/**
 * The API's ways of saying "this shop is not approved (yet)".
 *
 * These are refusals, but they are not errors: the owner did nothing wrong
 * and there is nothing to retry. `LISTING_NOT_ACTIVE` is what the catalog
 * service sends today; `SHOP_NOT_APPROVED` is the code the shop endpoints are
 * moving to. Both mean the same thing to the person at the counter — the
 * registration is still with the campus administrator.
 */
const AWAITING_APPROVAL_CODES = new Set(['SHOP_NOT_APPROVED', 'LISTING_NOT_ACTIVE']);

export function isAwaitingApproval(error: unknown): boolean {
  return error instanceof ApiError && AWAITING_APPROVAL_CODES.has(error.code);
}

/** The administrator's controlled list of reasons, in words (FR-SHOP-11). */
const REJECTION_REASONS: Record<string, string> = {
  ADDRESS_OUTSIDE_RADIUS: 'the address is outside the distance this college delivers to',
  LICENCE_INVALID: 'the licence is invalid or has expired',
  DOCUMENT_INCOMPLETE: 'the documents are incomplete',
  SUSPECTED_FORGERY: 'a document could not be accepted as genuine',
  OTHER: 'see the note from the administrator',
};

function rejectionReason(reason: string): string {
  return REJECTION_REASONS[reason] ?? reason.toLowerCase().replace(/_/g, ' ');
}

/**
 * D-07: where the registration stands, for a shop that cannot trade yet.
 *
 * `refused` is for the case where `/shops/mine` still says ACTIVE (or has not
 * been re-read) but the API has just refused the shop as not approved. The
 * refusal is the fresher fact, so the panel reads "awaiting approval" rather
 * than showing an active chip above an explanation of why nothing works.
 */
export function RegistrationStatus({
  shopName,
  listing,
  refused = false,
}: {
  shopName: string | undefined;
  listing: Listing;
  refused?: boolean;
}) {
  const status = refused && listing.status === 'ACTIVE' ? 'PENDING_VERIFICATION' : listing.status;

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-2xl font-bold">{shopName}</p>
            <p className="text-[var(--color-ink-faint)]">
              {listing.college.name} · {listing.distanceLabel} from campus
            </p>
          </div>
          <Status status={status} />
        </div>
      </Card>

      {status === 'PENDING_VERIFICATION' && (
        <Banner tone="warn">
          Your shop is waiting for a campus administrator to review it. Nothing is visible to
          students, and no orders can arrive, until it is approved. This page updates by itself
          when that happens.
        </Banner>
      )}

      {status === 'REJECTED' && (
        <Banner tone="error">
          This registration was rejected
          {listing.rejectionReason ? `: ${rejectionReason(listing.rejectionReason)}` : ''}.
          {listing.rejectionNote ? ` ${listing.rejectionNote}` : ''}
        </Banner>
      )}

      {status === 'SUSPENDED' && (
        <Banner tone="error">
          This shop has been suspended and is hidden from students. Contact your campus
          administrator.
        </Banner>
      )}
    </div>
  );
}
