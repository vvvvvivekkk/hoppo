'use client';

import type { TokenPair, TokenStore } from '@hoppo/api-client';

const STORAGE_KEY = 'hoppo.tokens';

/**
 * Token storage for a browser console.
 *
 * `sessionStorage`, not `localStorage`, and the reasoning matters: these are
 * shared machines. The shop dashboard lives on a counter tablet anyone can
 * pick up, and the admin console runs on a desk in an office. Session storage
 * is scoped to the tab, so closing it ends the session — which is the
 * behaviour you want on a device that is not one person's.
 *
 * Neither is proof against a cross-site scripting bug; an httpOnly cookie
 * would be. That is a deliberate trade for Phase 1E, noted here rather than
 * left implicit: these are internal consoles behind a login, the API also
 * checks account status on every request, and moving to cookies means moving
 * refresh handling server-side. Worth doing before any real deployment.
 */
export function createTokenStore(onChange?: () => void): TokenStore {
  let cached: TokenPair | null = null;

  return {
    get() {
      if (cached) return cached;
      if (typeof window === 'undefined') return null;

      try {
        const raw = window.sessionStorage.getItem(STORAGE_KEY);
        cached = raw ? (JSON.parse(raw) as TokenPair) : null;
        return cached;
      } catch {
        // Storage can throw in private modes and locked-down browsers. An
        // unreadable store means "not logged in", not a crash.
        return null;
      }
    },

    set(tokens: TokenPair) {
      cached = tokens;
      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
      } catch {
        // In-memory only. The session lasts until reload rather than failing.
      }
      onChange?.();
    },

    clear() {
      cached = null;
      try {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* nothing to do */
      }
      onChange?.();
    },
  };
}
