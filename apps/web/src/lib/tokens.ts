'use client';

import type { TokenPair, TokenStore } from '@hoppo/api-client';

const STORAGE_KEY = 'hoppo.student.tokens';

/**
 * Token storage for the student app.
 *
 * `localStorage`, where the consoles use `sessionStorage` — and the difference
 * is about whose device it is, not about convenience. A counter tablet is
 * shared, so a session that dies with the tab is the safe default there. A
 * student's phone is personal, and a food-delivery app that logs you out every
 * time you close the tab will not be used twice.
 *
 * The trade-off is the same one the consoles make and is worth stating plainly
 * rather than burying: anything that can run JavaScript on this origin can
 * read these tokens. An httpOnly cookie would not be readable, and is the
 * right answer before a real deployment — it means moving refresh handling
 * server-side, which is a Phase 2 change rather than a patch. Access tokens
 * are short-lived and refresh rotation detects reuse, so a stolen pair is
 * noisy rather than silent, but it is still a theft.
 */
export function createTokenStore(onChange?: () => void): TokenStore {
  let cached: TokenPair | null = null;

  return {
    get() {
      if (cached) return cached;
      if (typeof window === 'undefined') return null;

      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        cached = raw ? (JSON.parse(raw) as TokenPair) : null;
        return cached;
      } catch {
        // Private browsing and locked-down browsers throw here. Unreadable
        // means "not signed in", not a crash.
        return null;
      }
    },

    set(tokens: TokenPair) {
      cached = tokens;
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
      } catch {
        // In-memory only: the session lasts until reload rather than failing.
      }
      onChange?.();
    },

    clear() {
      cached = null;
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* nothing to do */
      }
      onChange?.();
    },
  };
}
