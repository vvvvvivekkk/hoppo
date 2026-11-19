'use client';

import { AuthShell, SignOutButton } from '@/components/shell';
import { Banner } from '@/components/ui';
import { useApi } from '@/lib/api';

/**
 * FR-SVER-08: a suspended account, turned away.
 *
 * No retry and no appeal form, because neither exists in the API yet —
 * reinstatement is an administrator action (A-03). Saying so plainly beats a
 * button that does nothing.
 */
export default function Suspended() {
  const { user } = useApi();

  return (
    <AuthShell>
      <h1 className="text-2xl font-bold">Your account is on hold</h1>
      <div className="mt-4">
        <Banner tone="error">
          {user?.status === 'DEACTIVATED'
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
