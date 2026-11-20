'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AuthShell } from '@/components/shell';
import { Button } from '@/components/ui';
import { useApi } from '@/lib/api';

/**
 * S-02: the first screen, and where a signed-out visitor is sent.
 *
 * Which makes it the place a student lands when the server ends their
 * session — and for two of the reasons that happens (the account was
 * suspended, the college was deactivated) "welcome, create an account" is the
 * wrong thing to say. The reason is reported by whichever request discovered
 * it, and can arrive just after the redirect here. So this screen checks too,
 * and hands over to the one that explains.
 */
export default function Welcome() {
  const { accountBlocked, collegeInactive } = useApi();
  const router = useRouter();

  useEffect(() => {
    if (accountBlocked || collegeInactive) router.replace('/suspended');
  }, [accountBlocked, collegeInactive, router]);

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
