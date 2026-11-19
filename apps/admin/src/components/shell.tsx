'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useApi } from '@/lib/api';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/students', label: 'Students' },
  { href: '/shops', label: 'Shops' },
  { href: '/settings', label: 'Settings' },
];

export function Shell({ children }: { children: ReactNode }) {
  const { user, loading, signedIn, logout } = useApi();
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === '/login';

  useEffect(() => {
    if (loading) return;
    if (!signedIn && !isLogin) router.replace('/login');
    if (signedIn && isLogin) router.replace('/');
  }, [loading, signedIn, isLogin, router]);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center text-[var(--color-ink-faint)]">
        Loading…
      </main>
    );
  }

  if (isLogin) return <main className="min-h-screen">{children}</main>;
  if (!signedIn) return null;

  /**
   * An administrator is scoped to one college and a super administrator to
   * none (FR-TEN-02). Showing which, prominently, matters: every approval on
   * these screens applies to one tenant, and an operator who manages two
   * colleges in two tabs needs to see at a glance which one they are in.
   */
  const scope = user?.college?.name ?? 'All colleges (super administrator)';

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--color-line)] bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-2">
          <span className="font-black tracking-tight">Hoppo Admin</span>

          <nav className="flex gap-1" aria-label="Main">
            {NAV.map((item) => {
              const active =
                item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`tap flex items-center rounded-md px-3 text-sm font-medium ${
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

          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="rounded-md bg-[var(--color-surface-sunken)] px-2 py-1 font-semibold">
              {scope}
            </span>
            <span className="hidden text-[var(--color-ink-faint)] sm:inline">{user?.name}</span>
            <button
              onClick={() => void logout()}
              className="tap rounded-md px-2 font-medium text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-sunken)]"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-5">{children}</main>
    </div>
  );
}
