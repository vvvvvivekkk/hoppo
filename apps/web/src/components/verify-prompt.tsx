'use client';

import Link from 'next/link';
import { Button, Card } from '@/components/ui';
import { useApi } from '@/lib/api';

/**
 * Whether this account may place an order, and why not.
 *
 * Mirrors the API's `unlocked` object (FR-SVER-01): browsing is open to an
 * unverified student, ordering and riding are not. Read from `/auth/me`, which
 * the provider has already fetched, rather than calling `/verification/me` on
 * every screen that needs to know.
 */
export function useCanOrder(): {
  canOrder: boolean;
  status: 'UNSUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
  /**
   * True until the signed-in user is known. While it is, `canOrder` is false
   * because nothing is known yet, not because the answer is no — a caller
   * that treats the two alike flashes "verify your ID" at a verified student
   * on every page load.
   */
  loading: boolean;
} {
  const { user, loading } = useApi();
  const status = user?.studentProfile?.verificationStatus ?? 'UNSUBMITTED';
  return {
    canOrder: !loading && status === 'VERIFIED',
    status,
    loading: loading || user === null,
  };
}

/**
 * The prompt an unverified student sees while browsing.
 *
 * Worded by state, because the three states need different things from the
 * reader: start, wait, or fix and resubmit. One generic "please verify" would
 * tell a student whose submission is already in the queue to do it again.
 */
export function VerifyPrompt({ compact = false }: { compact?: boolean }) {
  const { canOrder, status, loading } = useCanOrder();
  // Nothing while the account is still loading (or there is none): the prompt
  // is a statement about this student's ID, and until we know who they are
  // there is nothing true to say.
  if (loading || canOrder) return null;

  const copy =
    status === 'PENDING'
      ? {
          title: 'Verification in progress',
          body: 'Have a look around while an administrator checks your ID. You can order as soon as it is approved.',
          action: 'Check the status',
        }
      : status === 'REJECTED'
        ? {
            title: 'Your ID needs another look',
            body: 'Your last submission was not accepted. Browsing still works; ordering needs an approved ID.',
            action: 'Try again',
          }
        : {
            title: 'Verify to start ordering',
            body: 'Browsing is open to everyone. Placing an order needs an approved student ID, which takes a photo and a few details.',
            action: 'Verify my ID',
          };

  if (compact) {
    return (
      <Link
        href="/verify"
        className="mb-3 flex items-center gap-3 rounded-xl border-l-4 border-[var(--color-waiting)] bg-[var(--color-waiting-bg)] px-4 py-3"
      >
        <span className="min-w-0 flex-1 text-sm font-semibold text-[var(--color-waiting)]">
          {copy.title}
        </span>
        <span aria-hidden className="font-bold text-[var(--color-waiting)]">
          →
        </span>
      </Link>
    );
  }

  return (
    <Card tone="waiting" className="mb-3 p-4">
      <p className="font-bold">{copy.title}</p>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{copy.body}</p>
      <Link href="/verify" className="mt-3 block">
        <Button className="w-full">{copy.action}</Button>
      </Link>
    </Card>
  );
}
