'use client';

import Link from 'next/link';
import { Shell, SignOutButton } from '@/components/shell';
import { Banner, Card, Spinner } from '@/components/ui';
import { useApi } from '@/lib/api';

/** S-28: who you are, and the little that can be changed in Phase 1. */
export default function Account() {
  const { user, loading } = useApi();

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
        <p className="text-xl font-bold">{user.name}</p>
        <p className="mt-1 text-[var(--color-ink-soft)]">{user.mobile}</p>
        <p className="text-[var(--color-ink-soft)]">{user.email}</p>
        {user.college && (
          <p className="mt-2 text-sm text-[var(--color-ink-faint)]">{user.college.name}</p>
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
              These came from your verification
              {profile.verificationStatus === 'VERIFIED' ? '' : ' submission'}. Changing them means
              resubmitting, which an administrator has to approve.
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
