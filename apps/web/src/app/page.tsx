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
  const { user, loading } = useApi();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    if (!user) {
      router.replace('/welcome');
      return;
    }

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

    const verification = user.studentProfile?.verificationStatus ?? 'UNSUBMITTED';
    router.replace(verification === 'VERIFIED' ? '/shops' : '/verify');
  }, [user, loading, router]);

  return (
    <AuthShell>
      <Spinner label="Starting Hoppo" />
    </AuthShell>
  );
}
