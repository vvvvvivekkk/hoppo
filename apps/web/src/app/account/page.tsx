'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { AccountDeletion } from '@hoppo/api-client';
import { AuthShell, Shell, SignOutButton } from '@/components/shell';
import { Banner, Button, Card, Spinner } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { AccountData } from '@/components/account-data';
import { PrivacyAcceptance, usePrivacyNotice } from '@/components/privacy-notice';
import { NameForm, PasswordForm } from '@/components/profile-forms';

/**
 * S-49, S-50, S-54, S-55: who you are, what you can change, the legal notice,
 * and your data.
 *
 * What can be changed is short on purpose: the name, and the password. The
 * mobile number and email are fixed in Phase 1 (the API refuses a change to
 * either), and the roll number, department and year belong to verification.
 * Those are shown read-only with the reason beside them, rather than behind
 * an edit button that would only produce a refusal.
 *
 * There is no photo upload here. A profile photo goes through file storage,
 * and a deployment without storage configured cannot take one; rather than
 * show a control that fails, the screen shows a photo when the account has
 * one and otherwise does not mention it.
 */
export default function Account() {
  const { user, loading, dropSession } = useApi();
  const cart = useCart();
  /** Set once the account has been deleted; from then on there is no user. */
  const [deleted, setDeleted] = useState<AccountDeletion | null>(null);
  /** Which of the two small forms is open. One at a time, on a phone. */
  const [editing, setEditing] = useState<'name' | 'password' | null>(null);
  /** The API's confirmation after a password change. */
  const [passwordChanged, setPasswordChanged] = useState<string | null>(null);
  // The current notice, to tell whether this account has accepted *it* and
  // not merely some earlier version. A public route; quiet if it fails.
  const privacy = usePrivacyNotice();

  // Checked before anything that needs a user. After deletion the session is
  // gone, and the Shell would otherwise whisk the student to the welcome
  // screen before they had read what was erased and what was kept.
  if (deleted) {
    return (
      <AuthShell>
        <h1 className="text-2xl font-bold">Your account has been deleted</h1>
        <div className="mt-4">
          <Banner tone="success">{deleted.message}</Banner>
        </div>
        {/* Every line below is the API's own wording, shown as it came. The
            headings are deliberately bare: "Kept" and not "kept without your
            details", because one of the things kept is the audit log, and the
            caveats say plainly that old entries may still hold a name or an
            IP address. A tidier heading here would promise more than was done. */}
        <Card className="mt-4 p-4 text-sm">
          <h2 className="font-semibold">Erased</h2>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--color-ink-soft)]">
            {deleted.erased.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <h2 className="mt-4 font-semibold">Kept</h2>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--color-ink-soft)]">
            {deleted.retained.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          {/* ID photos and the profile photo live in file storage, outside
              the database, and removing them can fail on its own. The counts
              say whether it did. Optional-chained for an API build from
              before the field existed. */}
          {deleted.storedFiles && deleted.storedFiles.expected > 0 && (
            <>
              <h2 className="mt-4 font-semibold">Stored files</h2>
              <p
                className={`mt-1 ${
                  deleted.storedFiles.removed < deleted.storedFiles.expected
                    ? 'font-semibold text-[var(--color-waiting)]'
                    : 'text-[var(--color-ink-soft)]'
                }`}
              >
                {deleted.storedFiles.removed < deleted.storedFiles.expected
                  ? `${deleted.storedFiles.removed} of ${deleted.storedFiles.expected} stored files (ID photos and profile photo) were removed. Some stored files could not be removed.`
                  : `${deleted.storedFiles.removed} of ${deleted.storedFiles.expected} stored files (ID photos and profile photo) were removed.`}
              </p>
            </>
          )}

          {(deleted.caveats ?? []).length > 0 && (
            <>
              <h2 className="mt-4 font-semibold">What deletion could not do</h2>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--color-ink-soft)]">
                {deleted.caveats.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
        </Card>
        <Link href="/welcome" className="mt-8 block">
          <Button large tone="secondary" className="w-full">
            Close
          </Button>
        </Link>
      </AuthShell>
    );
  }

  // The Shell holds the content back while the session loads and sends a
  // signed-out visitor to /welcome, so by the time anything below is on
  // screen there is a user. This only satisfies the hooks-before-returns rule.
  if (loading || !user) {
    return (
      <Shell title="Account">
        <Spinner />
      </Shell>
    );
  }

  const profile = user.studentProfile;
  // The roll number, department and year are only real once a submission has
  // been made. Before that the profile row holds placeholders — an empty roll
  // number and "year 1" — and showing those as "from your verification"
  // presents made-up details as the student's own.
  const hasDetails =
    profile !== null && profile.verificationStatus !== 'UNSUBMITTED' && profile.rollNumber !== '';

  return (
    <Shell title="Account">
      <Card className="p-5">
        <div className="flex items-start gap-3">
          {/* Shown when the account has one; there is no upload here (see
              the note at the top of this file). */}
          {user.avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- a signed bucket URL, not a static asset next/image could optimise
            <img
              src={user.avatarUrl}
              alt=""
              className="h-12 w-12 shrink-0 rounded-full object-cover"
            />
          )}
          <p className="min-w-0 flex-1 text-xl font-bold">{user.name}</p>
          {profile?.verificationStatus === 'VERIFIED' && (
            <span className="shrink-0 rounded-full bg-[var(--color-ready-bg)] px-3 py-1 text-xs font-bold text-[var(--color-ready)]">
              Verified student
            </span>
          )}
        </div>
        <p className="mt-1 text-[var(--color-ink-soft)]">{user.mobile}</p>
        <p className="text-[var(--color-ink-soft)]">{user.email}</p>
        {user.college && (
          <p className="mt-2 text-sm text-[var(--color-ink-faint)]">{user.college.name}</p>
        )}
        <p className="mt-3 text-sm text-[var(--color-ink-faint)]">
          Your mobile number and email are fixed for now: Hoppo does not yet have a way to confirm a
          new one.
        </p>

        {passwordChanged && editing === null && (
          <div className="mt-3">
            <Banner tone="success">{passwordChanged}</Banner>
          </div>
        )}

        {editing === 'name' && <NameForm user={user} onDone={() => setEditing(null)} />}

        {editing === 'password' && (
          <PasswordForm
            onDone={(message) => {
              setPasswordChanged(message || null);
              setEditing(null);
            }}
          />
        )}

        {editing === null && (
          <div className="mt-3 flex gap-2">
            {/* The profile route is for student accounts; the password route
                is for everyone. */}
            {user.role === 'STUDENT' && (
              <Button
                tone="secondary"
                className="flex-1"
                onClick={() => {
                  setPasswordChanged(null);
                  setEditing('name');
                }}
              >
                Edit name
              </Button>
            )}
            <Button
              tone="secondary"
              className="flex-1"
              onClick={() => {
                setPasswordChanged(null);
                setEditing('password');
              }}
            >
              Change password
            </Button>
          </div>
        )}
      </Card>

      {/* A shop owner or administrator signed in here has the wrong app. */}
      {user.role !== 'STUDENT' && (
        <div className="mt-3">
          <Banner tone="warn">
            This account is a {user.role.toLowerCase().replace(/_/g, ' ')}.{' '}
            {user.role === 'SHOP_OWNER' || user.role === 'SHOP_STAFF'
              ? 'The shop dashboard is a separate app, on port 3001.'
              : 'The admin console is a separate app, on port 3002.'}
          </Banner>
        </div>
      )}

      {profile && (
        <Card className="mt-3 p-5">
          <p className="font-bold">Student details</p>
          <dl className="mt-2 space-y-1 text-sm">
            {hasDetails && (
              <>
                <Row label="Roll number" value={profile.rollNumber} />
                <Row label="Department" value={profile.department} />
                <Row label="Year" value={`Year ${profile.yearOfStudy}`} />
              </>
            )}
            <Row
              label="Verification"
              value={
                profile.verificationStatus === 'VERIFIED'
                  ? `Verified${
                      profile.verifiedAt
                        ? ` on ${new Date(profile.verifiedAt).toLocaleDateString('en-IN', {
                            dateStyle: 'medium',
                          })}`
                        : ''
                    }`
                  : profile.verificationStatus === 'UNSUBMITTED'
                    ? 'Not started'
                    : profile.verificationStatus === 'PENDING'
                      ? 'Being checked'
                      : 'Not accepted'
              }
            />
            <Row
              label="Rider terms"
              value={
                profile.riderTermsAcceptedAt
                  ? `Accepted ${new Date(profile.riderTermsAcceptedAt).toLocaleDateString('en-IN', {
                      dateStyle: 'medium',
                    })}`
                  : 'Not accepted'
              }
            />
          </dl>
          {hasDetails ? (
            <p className="mt-3 text-sm text-[var(--color-ink-faint)]">
              These cannot be edited here: they came from your verification
              {profile.verificationStatus === 'VERIFIED' ? '' : ' submission'}, which an
              administrator checks against your ID card. Changing them means submitting your
              verification again.
            </p>
          ) : (
            <Link
              href="/verify"
              className="mt-3 block text-sm font-semibold text-[var(--color-accent)] underline"
            >
              Verify your student ID to fill these in
            </Link>
          )}
        </Card>
      )}

      <Card className="mt-3 p-5">
        <p className="font-bold">Privacy</p>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          What Hoppo keeps about you, why, and for how long.
        </p>
        <Link
          href="/legal"
          className="mt-2 block text-sm font-semibold text-[var(--color-accent)] underline"
        >
          Read the privacy notice
        </Link>
        {/* Says which version was accepted, or invites accepting the current
            one. Not a gate: nothing is refused for lack of it. */}
        {privacy.notice && (
          <div className="mt-3">
            <PrivacyAcceptance notice={privacy.notice} onOutdated={privacy.reload} />
          </div>
        )}
      </Card>

      {/* The export and delete routes are for student accounts only. */}
      {user.role === 'STUDENT' && (
        <AccountData
          onDeleted={(result) => {
            setDeleted(result);
            // The server has already ended every session, so there is nothing
            // to tell it — a sign-out request would only be refused. This
            // drops what the phone still holds: the tokens and the cart.
            cart.clear();
            void dropSession();
          }}
        />
      )}

      <Card className="mt-3 p-5">
        <p className="font-bold">Not built yet</p>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          Honest list, so nothing here looks broken: chat with your rider, the community board,
          wallet withdrawals, ratings, and push notifications. All Phase 2.
        </p>
      </Card>

      <div className="mt-6 pb-safe">
        <SignOutButton />
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--color-ink-faint)]">{label}</dt>
      <dd className="text-right font-semibold capitalize">{value}</dd>
    </div>
  );
}
