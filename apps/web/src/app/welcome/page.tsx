'use client';

import Link from 'next/link';
import { AuthShell } from '@/components/shell';
import { Button } from '@/components/ui';

/** S-02 */
export default function Welcome() {
  return (
    <AuthShell>
      <div className="text-center">
        <p className="text-5xl" aria-hidden>
          🛵
        </p>
        <h1 className="mt-4 text-3xl font-bold">Hoppo</h1>
        <p className="mt-3 text-[var(--color-ink-soft)]">
          Order from shops near your college. Delivered by students on campus, for a fee you can see
          before you order.
        </p>
      </div>

      <div className="mt-10 space-y-3">
        <Link href="/signup" className="block">
          <Button large className="w-full">
            Create an account
          </Button>
        </Link>
        <Link href="/login" className="block">
          <Button large tone="secondary" className="w-full">
            I already have one
          </Button>
        </Link>
      </div>

      <p className="mt-8 text-center text-sm text-[var(--color-ink-faint)]">
        You will need a student ID card from a college Hoppo covers.
      </p>
      <p className="mt-3 text-center text-sm">
        <Link href="/legal" className="text-[var(--color-ink-soft)] underline">
          Privacy notice
        </Link>
      </p>
    </AuthShell>
  );
}
