'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useApi } from '@/lib/api';

const NAV = [
  { href: '/orders', label: 'Orders' },
  { href: '/history', label: 'History' },
  { href: '/catalog', label: 'Menu' },
  { href: '/hours', label: 'Hours' },
];

const PUBLIC_PATHS = ['/login', '/register'];

/**
 * The frame around every page: navigation, and the gate in front of it.
 *
 * The gate is here rather than in each page so that a page added later is
 * protected by default. Forgetting to wrap a new page is then a navigation
 * oddity rather than a leak.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { user, loading, signedIn, logout } = useApi();
  const pathname = usePathname();
  const router = useRouter();

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  useEffect(() => {
    if (loading) return;
    if (!signedIn && !isPublic) router.replace('/login');
    if (signedIn && pathname === '/login') router.replace('/orders');
  }, [loading, signedIn, isPublic, pathname, router]);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-[var(--color-ink-faint)]">Loading…</p>
      </main>
    );
  }

  if (isPublic) return <main className="min-h-screen">{children}</main>;
  if (!signedIn) return null;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2">
          <span className="mr-2 text-xl font-black tracking-tight">Hoppo</span>

          <nav className="flex gap-1" aria-label="Main">
            {NAV.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`tap flex items-center rounded-xl px-5 text-lg font-semibold ${
                    active
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-sunken)]'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-right text-sm leading-tight text-[var(--color-ink-faint)] sm:block">
              {user?.name}
              <br />
              {user?.college?.shortName ?? user?.college?.name}
            </span>
            <button
              onClick={() => void logout()}
              className="tap rounded-xl px-4 font-semibold text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-sunken)]"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
