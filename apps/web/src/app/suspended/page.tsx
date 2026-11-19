'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AuthShell, SignOutButton } from '@/components/shell';
import { Banner } from '@/components/ui';
import { useApi } from '@/lib/api';

/**
 * FR-SVER-08: a suspended account, turned away.
 *
 * No retry and no appeal form, because neither exists in the API yet —
 * reinstatement is an administrator action (A-03). Saying so plainly beats a
 * button that does nothing.
 *
 * Which of the two states it is comes from the provider's `accountBlocked`
 * flag, not from `user.status`: the API refuses a suspended account's token
 * before it will describe the account, so by the time anyone is sent here
 * `user` is null. Reading the status off the user made this whole screen
 * unreachable.
 */
export default function Suspended() {
  const { user, loading, accountBlocked } = useApi();
  const router = useRouter();

  const blocked = accountBlocked ?? (user && user.status !== 'ACTIVE' ? user.status : null);

  // Opened directly (a bookmark, the back button after being reinstated) by
  // an account that is not on hold: telling it that it is would be false.
  useEffect(() => {
    if (!loading && !blocked) router.replace('/');
  }, [loading, blocked, router]);

  return (
    <AuthShell>
      <h1 className="text-2xl font-bold">Your account is on hold</h1>
      <div className="mt-4">
        <Banner tone="error">
          {blocked === 'DEACTIVATED'
            ? 'This account has been closed.'
            : 'This account has been suspended, so ordering and deliveries are paused.'}
        </Banner>
      </div>
      <p className="mt-4 text-[var(--color-ink-soft)]">
        Your college&apos;s Hoppo administrator can lift this. Contact them directly — there is
        nothing to do here.
      </p>
      <div className="mt-8">
        <SignOutButton />
      </div>
    </AuthShell>
  );
}
