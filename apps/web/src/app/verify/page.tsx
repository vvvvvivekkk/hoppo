'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AuthShell, SignOutButton } from '@/components/shell';
import { Banner, Button, Card, Field, Select, Spinner } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { StorageUnavailableError, uploadFile } from '@/lib/upload';

type Status = 'UNSUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';

interface VerificationState {
  status: Status;
  submissionsUsed: number;
  submissionsAllowed: number;
  /** When the rolling window next frees an attempt, if the API said. */
  retryAt: string | null;
  latestSubmission: {
    submittedAt: string;
    rejectionReason: string | null;
    rejectionNote: string | null;
  } | null;
}

/**
 * S-07 to S-09: verification, all three states in one screen.
 *
 * One route rather than three because the student does not choose which state
 * they are in — the server does, and it can change while the screen is open.
 * Splitting it would mean redirect logic in three places and a race every
 * time an administrator decides.
 *
 * FR-SVER-05/06 cap resubmissions — as a rolling window, not for life: so
 * many in any so-many-day period, counted from the submissions themselves.
 * The count is shown before the form, not after a failure, because "you have
 * one attempt left" changes how carefully someone photographs their ID card.
 * And running out is worded as "not for now", because that is what it is:
 * the oldest submission ages out of the window and an attempt comes back.
 */
export default function Verify() {
  const { api, user, refreshUser } = useApi();
  const router = useRouter();

  const [state, setState] = useState<VerificationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // What the rest of the app currently believes, read through a ref so that
  // correcting it below does not re-create `load` and fetch twice.
  const knownStatus = useRef(user?.studentProfile?.verificationStatus);
  knownStatus.current = user?.studentProfile?.verificationStatus;

  const load = useCallback(async () => {
    try {
      const res = await api.verification.me();
      setState({
        status: res.status,
        submissionsUsed: res.submissionsUsed,
        submissionsAllowed: res.submissionsAllowed,
        retryAt: res.retryAt ?? null,
        latestSubmission: res.latestSubmission
          ? {
              submittedAt: res.latestSubmission.submittedAt,
              rejectionReason: res.latestSubmission.rejectionReason,
              rejectionNote: res.latestSubmission.rejectionNote,
            }
          : null,
      });
      if (res.status === 'VERIFIED') {
        await refreshUser();
        router.replace('/shops');
      } else if (res.status !== knownStatus.current) {
        // This screen has just learned something the account in context does
        // not know yet — submitted, or rejected while it was open. Every
        // other screen words its verify prompt from that copy.
        void refreshUser();
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [api, refreshUser, router]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a submission is pending, re-check on a slow interval. An
  // administrator approving in the console should not require the student to
  // know to pull to refresh.
  useEffect(() => {
    if (state?.status !== 'PENDING') return;
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [state?.status, load]);

  if (loading) {
    return (
      <AuthShell>
        <Spinner label="Checking your verification" />
      </AuthShell>
    );
  }

  if (!state) {
    return (
      <AuthShell>
        <Banner tone="error">{error ?? 'Could not load your verification status.'}</Banner>
        <Button className="mt-6 w-full" onClick={() => void load()}>
          Try again
        </Button>
      </AuthShell>
    );
  }

  const attemptsLeft = state.submissionsAllowed - state.submissionsUsed;

  if (state.status === 'PENDING') {
    return (
      <AuthShell>
        <p className="text-center text-5xl" aria-hidden>
          ⏳
        </p>
        <h1 className="mt-4 text-center text-2xl font-bold">We are checking your ID</h1>
        <p className="mt-2 text-center text-[var(--color-ink-soft)]">
          Submitted{' '}
          {state.latestSubmission
            ? new Date(state.latestSubmission.submittedAt).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })
            : 'just now'}
          . An administrator at {user?.college?.name ?? 'your college'} reviews this by hand, so it
          is usually hours rather than minutes.
        </p>
        <p className="mt-6 text-center text-sm text-[var(--color-ink-faint)]">
          This page updates itself — you can leave it open or come back later.
        </p>
        {/* Browsing is unlocked while this is pending (FR-SVER-01), so the
            waiting screen is not a dead end. */}
        <div className="mt-8 space-y-3">
          <Link href="/shops" className="block">
            <Button large className="w-full">
              Look at the shops meanwhile
            </Button>
          </Link>
          <SignOutButton />
        </div>
      </AuthShell>
    );
  }

  if (state.status === 'REJECTED' && attemptsLeft <= 0) {
    return (
      <AuthShell>
        <h1 className="text-2xl font-bold">We could not verify you</h1>
        <div className="mt-4">
          <Banner tone="error">
            {state.latestSubmission?.rejectionReason
              ? state.latestSubmission.rejectionReason.replace(/_/g, ' ').toLowerCase()
              : 'Your submission was not accepted.'}
          </Banner>
        </div>
        {state.latestSubmission?.rejectionNote && (
          <Card className="mt-4 p-4">
            <p className="text-sm font-semibold text-[var(--color-ink-faint)]">
              From the administrator
            </p>
            <p className="mt-1">{state.latestSubmission.rejectionNote}</p>
          </Card>
        )}
        {/* Not "all attempts used, contact an administrator": the limit is a
            rolling window, so that was telling people a door was shut for
            good when it reopens by itself. */}
        <p className="mt-4 text-[var(--color-ink-soft)]">
          You have used all {state.submissionsAllowed} attempts allowed for now. The limit covers a
          set number of days, so{' '}
          {state.retryAt
            ? `you can submit again after ${new Date(state.retryAt).toLocaleDateString('en-IN', {
                dateStyle: 'medium',
              })}.`
            : 'more attempts open up as your earlier submissions age out of it.'}{' '}
          If it is urgent, contact your college&apos;s Hoppo administrator directly.
        </p>
        <div className="mt-8 space-y-3">
          <Link href="/shops" className="block">
            <Button tone="secondary" large className="w-full">
              Look at the shops meanwhile
            </Button>
          </Link>
          <SignOutButton />
        </div>
      </AuthShell>
    );
  }

  return (
    <SubmitForm
      state={state}
      attemptsLeft={attemptsLeft}
      onSubmitted={() => {
        // The account in context still says "unsubmitted" at this point, and
        // every other screen reads it from there — the shops list would go on
        // saying "Verify to start ordering" to someone who just did.
        void refreshUser();
        void load();
      }}
    />
  );
}

function SubmitForm({
  state,
  attemptsLeft,
  onSubmitted,
}: {
  state: VerificationState;
  attemptsLeft: number;
  onSubmitted: () => void;
}) {
  const { api } = useApi();

  const [rollNumber, setRollNumber] = useState('');
  const [department, setDepartment] = useState('');
  const [yearOfStudy, setYearOfStudy] = useState('1');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageDown, setStorageDown] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;

    setError(null);
    setBusy(true);

    try {
      const idCardUrl = await uploadFile(api, 'ID_CARD', file);
      await api.verification.submit({
        rollNumber: rollNumber.trim(),
        department: department.trim(),
        yearOfStudy: Number(yearOfStudy),
        idCardUrl,
      });
      onSubmitted();
    } catch (e) {
      if (e instanceof StorageUnavailableError) {
        setStorageDown(true);
      } else {
        setError(describeError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="text-2xl font-bold">
        {state.status === 'REJECTED' ? 'Try again' : 'Verify you are a student'}
      </h1>
      <p className="mt-1 text-[var(--color-ink-soft)]">
        Hoppo only works inside a college, so every account is checked against a student ID card.
      </p>

      {state.status === 'REJECTED' && state.latestSubmission?.rejectionReason && (
        <div className="mt-4">
          <Banner tone="warn">
            Last time: {state.latestSubmission.rejectionReason.replace(/_/g, ' ').toLowerCase()}
            {state.latestSubmission.rejectionNote
              ? ` — ${state.latestSubmission.rejectionNote}`
              : ''}
          </Banner>
        </div>
      )}

      {/* FR-SVER-05: say how many attempts are left before the form, not after. */}
      <p className="mt-4 text-sm font-semibold text-[var(--color-ink-faint)]">
        {attemptsLeft === 1
          ? 'This is your last attempt for now — check the photo is readable before you send it.'
          : `${attemptsLeft} of ${state.submissionsAllowed} attempts left for now.`}
      </p>

      {storageDown && (
        <div className="mt-4">
          <Banner tone="error">
            This deployment has no file storage configured, so the ID photo cannot be uploaded. An
            administrator can verify you from the admin console instead, or the seeded accounts in
            the repository are already verified for development.
          </Banner>
        </div>
      )}

      <form onSubmit={submit} className="mt-6 space-y-4">
        {error && <Banner tone="error">{error}</Banner>}

        <Field
          label="Roll or enrolment number"
          value={rollNumber}
          onChange={(e) => setRollNumber(e.target.value)}
          autoCapitalize="characters"
          required
        />
        <Field
          label="Department"
          placeholder="Computer Science and Engineering"
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          required
        />
        <Select
          label="Year of study"
          value={yearOfStudy}
          onChange={(e) => setYearOfStudy(e.target.value)}
        >
          {[1, 2, 3, 4, 5, 6].map((y) => (
            <option key={y} value={y}>
              Year {y}
            </option>
          ))}
        </Select>

        <div>
          <span className="mb-1 block font-semibold">Photo of your college ID card</span>
          <span className="mb-2 block text-sm text-[var(--color-ink-faint)]">
            The front, with your name and roll number readable. JPEG or PNG, up to 5 MB.
          </span>
          <input
            type="file"
            // `capture` opens the camera directly on a phone, which is what
            // most students will use, while still allowing the gallery.
            accept="image/jpeg,image/png"
            capture="environment"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
            className="tap w-full rounded-xl border-2 border-dashed border-[var(--color-line)] bg-white px-4 py-3"
          />
          {file && (
            <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
              {file.name} — {(file.size / 1_048_576).toFixed(1)} MB
            </p>
          )}
        </div>

        <Card className="p-4">
          <p className="text-sm text-[var(--color-ink-soft)]">
            Your ID photo goes to a private store that only your college&apos;s administrators can
            open, and every time one is opened it is logged. It is not shown to shops or to other
            students.
          </p>
        </Card>

        <Button type="submit" large loading={busy} disabled={!file} className="w-full">
          Send for review
        </Button>
      </form>

      <div className="mt-8 space-y-3">
        <Link href="/shops" className="block">
          <Button tone="secondary" large className="w-full">
            Look around first
          </Button>
        </Link>
        <SignOutButton />
      </div>
    </AuthShell>
  );
}
