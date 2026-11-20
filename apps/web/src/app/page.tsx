'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useApi } from '@/lib/api';
import { AuthShell } from '@/components/shell';
import { Spinner } from '@/components/ui';

/**
 * S-01: the gate.
 *
 * Every launch lands here and is routed by account state rather than by
 * remembering where the student was last. The order of the checks is the
 * point — a suspended account is turned away before its verification status
 * is consulted, because FR-SVER-08 takes effect immediately and a suspended
 * student being shown "resubmit your ID" would be a lie.
 *
 * The verification status comes from `/auth/me`, which the provider has
 * already fetched, so this is a redirect rather than another round trip.
 */
export default function Gate() {
  const { user, loading, accountBlocked, collegeInactive } = useApi();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    // First, and before the signed-out check, because a suspended account
    // *is* signed out: the API refuses its token outright, so there is no
    // user to read a status from. The flag is the only trace of why.
    if (accountBlocked || collegeInactive) {
      router.replace('/suspended');
      return;
    }

    if (!user) {
      router.replace('/welcome');
      return;
    }

    // Belt and braces: the API does not currently return a non-active user
    // from /auth/me, but if it ever does, the answer is the same screen.
    if (user.status !== 'ACTIVE') {
      router.replace('/suspended');
      return;
    }

    // A shop owner or administrator who lands here has the wrong app. Say so
    // rather than showing them an empty student home.
    if (user.role !== 'STUDENT') {
      router.replace('/account');
      return;
    }

    // Everybody lands on the shops list, verified or not.
    //
    // FR-SVER-01 unlocks browsing while verification is pending — the API's
    // own `unlocked` object says `browseShops: true` for an unverified
    // student — and only ordering, riding, chat and the community board wait
    // for approval. An earlier version of this gate sent anyone unverified
    // straight to /verify with no way past it, which was stricter than the
    // API and worse product: asking for somebody's student ID before they
    // have seen a single shop is asking them to trust a blank screen. The
    // prompt to verify rides along on the shops list instead, and checkout
    // is where the hard stop lives.
    router.replace('/shops');
  }, [user, loading, accountBlocked, collegeInactive, router]);

  return (
    <AuthShell>
      <Spinner label="Starting Hoppo" />
    </AuthShell>
  );
}
