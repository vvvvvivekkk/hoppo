'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useApi } from '@/lib/api';

/**
 * Navigation, by role.
 *
 * A college administrator works inside one college; a super administrator
 * works across all of them and owns the platform pages (colleges and their
 * administrators — A-16, A-18). So the two see different menus: an ADMIN is
 * never shown the platform pages, and a SUPER_ADMIN is not shown Settings,
 * because radius, fees and delivery points belong to "my college" and a super
 * administrator has none (the API refuses them there).
 */
const COLLEGE_NAV = [
  { href: '/', label: 'Overview' },
  { href: '/orders', label: 'Orders' },
  { href: '/escalations', label: 'Escalations' },
  { href: '/students', label: 'Students' },
  { href: '/shops', label: 'Shops' },
  { href: '/settings', label: 'Settings' },
  { href: '/audit', label: 'Audit log' },
];

const PLATFORM_NAV = [
  { href: '/', label: 'Overview' },
  { href: '/platform', label: 'Colleges' },
  { href: '/orders', label: 'Orders' },
  { href: '/escalations', label: 'Escalations' },
  { href: '/students', label: 'Students' },
  { href: '/shops', label: 'Shops' },
  { href: '/audit', label: 'Audit log' },
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

  const isSuper = user?.role === 'SUPER_ADMIN';
  const NAV = isSuper ? PLATFORM_NAV : COLLEGE_NAV;

  // The menu hiding a page is not what keeps someone off it; typing the
  // address would still get there. These pages are answered here, before any
  // of them asks the API for something it will refuse.
  const wrongRolePage =
    !isSuper && pathname.startsWith('/platform')
      ? 'This page is for platform administrators. Your account manages one college, and its settings are under Settings.'
      : isSuper && pathname.startsWith('/settings')
        ? 'College settings belong to a college administrator. A platform account has no college of its own; open a college under Colleges instead.'
        : null;

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--color-line)] bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
          <span className="font-black tracking-tight">Hoppo Admin</span>

          <nav className="flex flex-wrap gap-1" aria-label="Main">
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

      <main className="mx-auto max-w-7xl px-4 py-5">
        {wrongRolePage ? (
          <div
            role="status"
            className="rounded-md border-l-4 border-[var(--color-pending)] bg-[var(--color-pending-bg)] px-3 py-2 text-sm font-medium text-[var(--color-pending)]"
          >
            {wrongRolePage}
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
