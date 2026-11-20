'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Spinner } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useCart } from '@/lib/cart';

/**
 * The app shell: a slim header and a bottom tab bar.
 *
 * The tab bar is at the bottom because that is where a thumb is. The SRS's
 * UI-1 asks for bottom navigation for exactly this reason, and it is the one
 * piece of layout that should not be reconsidered on a phone.
 *
 * The content area carries bottom padding equal to the bar's height plus the
 * iPhone home-indicator inset, so the last item in a list is reachable rather
 * than sitting under the bar.
 *
 * It is also the route guard. Every screen wrapped in a `Shell` is a
 * signed-in screen, so this is the one place that can say "not signed in,
 * go to the welcome screen" for all of them. Before it did, each screen
 * improvised: the shops list showed an API error under a verify banner, the
 * orders list said "No orders yet" to somebody with no account. The page's
 * own content is held back until the session is known, so nothing renders
 * against a user who turns out not to exist.
 */
const TABS = [
  { href: '/shops', label: 'Shops', icon: '🏪' },
  { href: '/orders', label: 'Orders', icon: '📦' },
  { href: '/rider', label: 'Earn', icon: '🛵' },
  { href: '/account', label: 'Account', icon: '👤' },
];

export function Shell({
  children,
  title,
  back,
  action,
}: {
  children: ReactNode;
  title?: string;
  /** Show a back arrow to this route instead of the title row's default. */
  back?: string;
  action?: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { itemCount } = useCart();
  const { user, loading, accountBlocked } = useApi();

  const signedOut = !loading && !user;

  useEffect(() => {
    if (!signedOut) return;
    // A suspended account has no user either, and "your account is on hold"
    // is a different message from "please sign in".
    router.replace(accountBlocked ? '/suspended' : '/welcome');
  }, [signedOut, accountBlocked, router]);

  return (
    <div className="mx-auto min-h-dvh max-w-2xl bg-[var(--color-surface-sunken)]">
      {/* Header and tab bar are navigation, not content: left out of a
          printed or saved page (the receipt) so the paper holds only the page. */}
      <header className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-white/95 backdrop-blur print:hidden">
        <div className="flex items-center gap-2 px-3 py-2">
          {back !== undefined && (
            <button
              type="button"
              onClick={() => (back ? router.push(back) : router.back())}
              aria-label="Go back"
              className="tap -ml-1 rounded-xl px-3 text-xl text-[var(--color-ink-soft)]"
            >
              ←
            </button>
          )}
          <span className="flex-1 truncate text-lg font-bold">{title ?? 'Hoppo'}</span>
          {action}
        </div>
      </header>

      <main className="px-3 pb-28 pt-3">
        {loading ? (
          <Spinner label="Loading" />
        ) : signedOut ? (
          <Spinner label="Taking you to sign in" />
        ) : (
          children
        )}
      </main>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-10 mx-auto max-w-2xl border-t border-[var(--color-line)] bg-white print:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <ul className="flex">
          {TABS.map((tab) => {
            const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
            return (
              <li key={tab.href} className="flex-1">
                <Link
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  className={`tap flex flex-col items-center justify-center gap-0.5 py-2 text-xs font-semibold ${
                    active ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink-faint)]'
                  }`}
                >
                  <span aria-hidden className="relative text-lg leading-none">
                    {tab.icon}
                    {tab.href === '/shops' && itemCount > 0 && (
                      <span className="absolute -right-2.5 -top-1 rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] font-bold leading-4 text-white">
                        {itemCount}
                      </span>
                    )}
                  </span>
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/** A bare centred frame for the screens that come before sign-in. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      {children}
    </div>
  );
}

/**
 * Hard-sign-out link, used by the account screen and by the dead ends
 * (suspended, verification rejected with no attempts left) where it is the
 * only action left.
 */
export function SignOutButton() {
  const { logout } = useApi();
  const { clear } = useCart();
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={async () => {
        // Signing out is the one moment the cart is certainly finished with.
        // Left behind, it greets whoever signs in next on this phone.
        clear();
        await logout();
        router.replace('/');
      }}
      className="tap w-full rounded-xl border-2 border-[var(--color-line)] bg-white px-5 font-semibold text-[var(--color-ink)]"
    >
      Sign out
    </button>
  );
}
