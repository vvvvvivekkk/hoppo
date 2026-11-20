'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import Link from 'next/link';
import { AuthShell, SessionLoading, SignOutButton } from '@/components/shell';
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
 *
 * The same screen serves a deactivated college (`collegeInactive`), which
 * ends the session in the same way for a different reason.
 */
export default function Suspended() {
  const { user, loading, accountBlocked, collegeInactive } = useApi();
  const router = useRouter();

  const blocked = accountBlocked ?? (user && user.status !== 'ACTIVE' ? user.status : null);

  // Opened directly (a bookmark, the back button after being reinstated) by
  // an account that is not on hold: telling it that it is would be false.
  useEffect(() => {
    if (!loading && !blocked && !collegeInactive) router.replace('/');
  }, [loading, blocked, collegeInactive, router]);

  // Not while the account is still being looked up. The reason on screen may
  // be a stored one, from before an administrator lifted it; if there is a
  // session, the server is about to say whether it still applies, and showing
  // "your account is on hold" for that half second would be a claim nobody
  // has checked.
  //
  // Nor when there turns out to be no reason at all: the effect above is
  // already sending this visitor away, and the screen must not say "on hold"
  // to them on the way out.
  if (loading || (!blocked && !collegeInactive)) {
    return (
      <AuthShell>
        <SessionLoading />
      </AuthShell>
    );
  }

  // The college, not the student. Checked first and worded apart: nothing is
  // wrong with this person's account, and saying "suspended" would send them
  // to ask about a suspension that does not exist. The sentence in the banner
  // is the API's own.
  if (collegeInactive && !blocked) {
    return (
      <AuthShell>
        <h1 className="text-2xl font-bold">Hoppo is not available at your college</h1>
        <div className="mt-4">
          <Banner tone="error">{collegeInactive}</Banner>
        </div>
        <p className="mt-4 text-[var(--color-ink-soft)]">
          This is about the college, not about you: your account has not been suspended. While the
          college is inactive nobody there can sign in, order or deliver.
        </p>
        <TryAgain what="If the college has been switched back on since" />
      </AuthShell>
    );
  }

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
        {blocked === 'DEACTIVATED'
          ? 'A closed account cannot be reopened from here.'
          : 'Your college\u2019s Hoppo administrator can lift this. Contact them directly.'}
      </p>
      {/* A closed account stays closed, so there is nothing to try again. */}
      {blocked === 'DEACTIVATED' ? (
        <div className="mt-8">
          <SignOutButton />
        </div>
      ) : (
        <TryAgain what="If it has been lifted since" />
      )}
    </AuthShell>
  );
}

/**
 * The way back in.
 *
 * What this screen shows is what the server said last time, kept so that a
 * reload does not lose it. It cannot know that an administrator has since
 * reinstated the account. Without this link the only exits were "Sign out"
 * and typing /login by hand, under copy that said nothing could be done —
 * which stopped being true the moment the hold was lifted. Signing in asks
 * the server afresh: it either works, or says again why not.
 */
function TryAgain({ what }: { what: string }) {
  return (
    <div className="mt-8 space-y-3">
      <p className="text-sm text-[var(--color-ink-soft)]">{what}, signing in again will work.</p>
      <Link
        href="/login"
        className="tap flex w-full items-center justify-center rounded-xl bg-[var(--color-accent)] px-5 font-semibold text-white"
      >
        Try signing in again
      </Link>
      <SignOutButton />
    </div>
  );
}
