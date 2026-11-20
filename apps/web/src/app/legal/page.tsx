'use client';

import Link from 'next/link';
import { RIDER_TERMS_VERSION } from '@hoppo/shared';
import { AuthShell } from '@/components/shell';
import { Banner, Button, Card, Spinner } from '@/components/ui';
import { useApi } from '@/lib/api';
import {
  PrivacyAcceptance,
  PrivacyNoticeBody,
  usePrivacyNotice,
} from '@/components/privacy-notice';

/**
 * S-54: legal.
 *
 * The privacy notice in full, readable without an account (it is linked from
 * before sign-up) and, for someone signed in, which version they accepted —
 * with a button to accept the current one if they have not.
 *
 * Deliberately not behind the `Shell`: that is the signed-in frame, and it
 * would send a visitor who has not registered yet to the welcome screen
 * instead of letting them read what they are about to agree to.
 */
export default function Legal() {
  const { signedIn } = useApi();
  const { notice, error, loading, reload } = usePrivacyNotice();

  return (
    <AuthShell>
      <h1 className="text-2xl font-bold">{notice?.title ?? 'Privacy notice'}</h1>

      {loading && !notice && (
        <div className="mt-6">
          <Spinner label="Loading the notice" />
        </div>
      )}

      {error && !notice && (
        <div className="mt-6 space-y-3">
          <Banner tone="error">{error}</Banner>
          <Button className="w-full" onClick={reload}>
            Try again
          </Button>
        </div>
      )}

      {notice && (
        <>
          <Card className="mt-4 p-4">
            <PrivacyNoticeBody notice={notice} />
          </Card>

          {/* After the text, not before it: the button accepts what is above. */}
          {signedIn && (
            <div className="mt-4">
              <PrivacyAcceptance notice={notice} onOutdated={reload} />
            </div>
          )}
        </>
      )}

      <Card className="mt-4 p-4">
        <h2 className="font-bold">Rider terms</h2>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          The terms for delivering (version {RIDER_TERMS_VERSION}) are shown on the Earn screen,
          where you accept them before going online for the first time.
        </p>
      </Card>

      <div className="mt-8">
        <Link href={signedIn ? '/account' : '/welcome'} className="block">
          <Button tone="secondary" large className="w-full">
            Back
          </Button>
        </Link>
      </div>
    </AuthShell>
  );
}
