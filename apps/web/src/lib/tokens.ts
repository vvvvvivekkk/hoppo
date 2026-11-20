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
 *
 * **Two tabs share this one key**, and that shapes three things below:
 *
 *  - `get()` reads storage every time rather than trusting a copy made when
 *    the tab loaded. The API rotates the refresh token on every refresh, so
 *    the moment another tab refreshes, a remembered pair is a revoked pair —
 *    and presenting it is treated by the server as a replay.
 *  - A `storage` event (fired in every *other* tab when the key changes)
 *    tells the provider, so a sign-out or a sign-in in one tab shows in the
 *    rest without waiting for their next request to fail.
 *  - `clear()` looks before it deletes. The server lets exactly one of two
 *    simultaneous refreshes win; the loser is told its token is invalid and
 *    the client then clears the store. If the winner has already written a
 *    new pair, deleting it would sign the winner out at its next reload for
 *    having been correct. So a pair that arrived from another tab is kept,
 *    for that one refusal, and adopted. `forceClear()` is the unconditional one, for a
 *    deliberate sign-out.
 */
/**
 * How long after first sparing another tab's pair `clear()` goes on sparing
 * it. Long enough to cover every request that was waiting on the same failed
 * refresh (they all report within a few milliseconds of each other); short
 * enough that a pair which is genuinely dead is gone within a retry or two.
 */
const REPRIEVE_WINDOW_MS = 500;

/** What changed the stored pair: this tab, or another one. */
export type TokenChangeSource = 'this-tab' | 'other-tab';

export type WebTokenStore = TokenStore & {
  /** Delete the pair whatever it is. For a deliberate sign-out. */
  forceClear(): void;
};

function parsePair(raw: string | null): TokenPair | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TokenPair>;
    return typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string'
      ? (parsed as TokenPair)
      : null;
  } catch {
    // Something else wrote junk under the key. That is "not signed in".
    return null;
  }
}

export function createTokenStore(onChange?: (source: TokenChangeSource) => void): WebTokenStore {
  let cached: TokenPair | null = null;
  /**
   * Whether the cached pair made it into storage. When a write fails (private
   * browsing) the cache is all there is, and an empty storage must not be
   * read as "another tab signed out".
   */
  let persisted = true;
  /** False until the first read, which is this tab finding its own session. */
  let initialised = false;
  /**
   * Refresh tokens that reached storage from another tab while this one was
   * open, and those of them `clear()` has already declined to delete once.
   */
  const fromOtherTab = new Set<string>();
  /** When each such token was first spared by `clear()`. */
  const sparedAt = new Map<string, number>();

  function read(): TokenPair | null {
    if (typeof window === 'undefined') return cached;

    let stored: TokenPair | null;
    try {
      stored = parsePair(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      // Private browsing and locked-down browsers throw here. Unreadable
      // means "whatever this tab remembers", not a crash.
      return cached;
    }

    if (stored) {
      // A pair this tab did not write, appearing after it had started: some
      // other tab signed in or refreshed. (The pair found at start-up is
      // this tab's own session, left by its previous page load.)
      if (initialised && stored.refreshToken !== cached?.refreshToken) {
        fromOtherTab.add(stored.refreshToken);
      }
      cached = stored;
      persisted = true;
    } else if (persisted) {
      // Storage is readable and empty, and our pair had been written there:
      // another tab removed it.
      cached = null;
    }
    initialised = true;
    return cached;
  }

  function remove(): boolean {
    // Clearing an empty store is not a change, and must not announce one.
    // It used to: a signed-out visitor's /auth/me returned 401, the client
    // cleared the (already empty) tokens, that notified the provider, the
    // provider refetched /auth/me, and round it went — over 17,000 requests
    // in three minutes from one idle tab on the welcome screen. Only a real
    // browser found it; typecheck, build and the API walk all passed.
    let hadTokens = cached !== null;
    try {
      hadTokens = hadTokens || window.localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      /* unreadable storage: fall back to what was cached */
    }
    if (!hadTokens) return false;

    cached = null;
    persisted = true;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to do */
    }
    return true;
  }

  if (typeof window !== 'undefined') {
    // Fired only in tabs other than the one that wrote. `key === null` is
    // `localStorage.clear()`, which takes this key with it.
    window.addEventListener('storage', (event) => {
      if (event.storageArea !== window.localStorage) return;
      if (event.key !== null && event.key !== STORAGE_KEY) return;

      // Not compared against the cache: a `get()` between the other tab's
      // write and this event has already brought the cache up to date, and
      // the provider would then never hear that anything happened.
      if (event.key === STORAGE_KEY && event.oldValue === event.newValue) return;
      read();
      onChange?.('other-tab');
    });
  }

  return {
    get() {
      return read();
    },

    set(tokens: TokenPair) {
      cached = tokens;
      initialised = true;
      // Ours now, however it first arrived.
      fromOtherTab.delete(tokens.refreshToken);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
        persisted = true;
      } catch {
        // In-memory only: the session lasts until reload rather than failing.
        persisted = false;
      }
      onChange?.('this-tab');
    },

    clear() {
      // The client calls this when the server has refused the session. Look
      // first. If the pair in storage came from another tab, it is very
      // likely not the one that was just refused: the usual way to get here
      // with such a pair is to have lost a simultaneous refresh to the tab
      // that wrote it. Deleting it would sign that tab out for winning.
      //
      // So such a pair is spared — for one refusal. The store is not told
      // which token a failed refresh carried, so it cannot be certain; if
      // the spared pair really is dead, the next request is refused too,
      // `clear()` is called again, and this time it goes. A few extra round
      // trips in the rare wrong case, against a lost session in the common
      // one.
      //
      // "One refusal" is a short window rather than one call, because one
      // failed refresh produces several calls: every request that was
      // waiting on it reports the failure separately, in the same instant.
      const stored = read();
      if (stored && fromOtherTab.has(stored.refreshToken)) {
        const first = sparedAt.get(stored.refreshToken);
        if (first === undefined) sparedAt.set(stored.refreshToken, Date.now());
        if (first === undefined || Date.now() - first < REPRIEVE_WINDOW_MS) return;
      }

      if (remove()) onChange?.('this-tab');
    },

    forceClear() {
      if (remove()) onChange?.('this-tab');
    },
  };
}
