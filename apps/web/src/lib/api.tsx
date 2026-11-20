'use client';

import {
  ApiClient,
  ApiError,
  endpoints,
  type AuthUser,
  type Endpoints,
  type TokenPair,
} from '@hoppo/api-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { clearSessionEnd, readSessionEnd, writeSessionEnd } from './session-end';
import { createTokenStore } from './tokens';

interface ApiContextValue {
  api: Endpoints;
  /** The underlying client, for the socket handshake's token read. */
  client: ApiClient;
  user: AuthUser | null;
  loading: boolean;
  /**
   * True while `loading` is being held because the server cannot be reached
   * and there is a stored session whose owner is not yet known. The app is
   * retrying; a screen can say so instead of spinning without a word.
   */
  serverUnreachable: boolean;
  signedIn: boolean;
  /**
   * Set when the server has said this account is suspended or closed.
   *
   * It has to live here rather than on `user`, because there is no user: the
   * API's JWT guard refuses a suspended account with a 401 before `/auth/me`
   * ever runs, so the client is signed out and `user.status` is never seen.
   * Without this flag a suspended student was dropped on the welcome screen
   * with no explanation.
   */
  accountBlocked: AccountBlocked | null;
  /**
   * Set, to the API's own sentence, when the session ended because the
   * student's college has been deactivated on Hoppo.
   *
   * The same situation as `accountBlocked` — signed out by the server, no
   * user left to read a reason from — but it is the college that is blocked
   * and not the person, so it is kept apart: telling a student "your account
   * has been suspended" when their college was switched off would be untrue,
   * and would send them to argue a suspension that does not exist.
   */
  collegeInactive: string | null;
  login(identifier: string, password: string): Promise<void>;
  /** Registration returns tokens, so it signs the student straight in. */
  adoptSession(tokens: TokenPair): Promise<void>;
  logout(): Promise<void>;
  refreshUser(): Promise<void>;
  /**
   * Take a user the API has just returned as the signed-in one.
   *
   * For the routes that answer with the `/auth/me` body (a profile edit) or
   * with one field of it (accepting the privacy notice). The server has
   * already said what the account now looks like; asking again would be a
   * second request for the same answer, with a window in between where the
   * screen shows the old name.
   */
  adoptUser(user: AuthUser): void;
  /**
   * Forget the session on this device without asking the server anything —
   * for when the server has already ended it (an account just deleted), and
   * a sign-out request could only be refused.
   */
  dropSession(): Promise<void>;
}

export type AccountBlocked = 'SUSPENDED' | 'DEACTIVATED';

/** Which kind of block an error describes, or null if it is something else. */
export function blockedReason(error: unknown): AccountBlocked | null {
  return error instanceof ApiError ? error.accountBlocked : null;
}

/** The API's explanation when an error says the college is deactivated. */
export function collegeInactiveReason(error: unknown): string | null {
  return error instanceof ApiError && error.status === 403 && error.code === 'COLLEGE_INACTIVE'
    ? error.message
    : null;
}

/** How often, at most, coming back to the tab re-reads the signed-in user. */
const FOCUS_REFRESH_MIN_GAP_MS = 15_000;

const ApiContext = createContext<ApiContextValue | null>(null);

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export function ApiProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authVersion, setAuthVersion] = useState(0);
  const [accountBlocked, setAccountBlocked] = useState<AccountBlocked | null>(null);
  const [collegeInactive, setCollegeInactive] = useState<string | null>(null);

  // One client for the lifetime of the app. Rebuilding it per render would
  // throw away the in-flight refresh promise, and that promise is what stops
  // parallel refreshes tripping the API's token-reuse detection — which on a
  // phone matters more than on a desktop, because several screens can come
  // back from sleep and refetch at the same instant.
  const clientRef = useRef<ApiClient | null>(null);

  /**
   * True while this provider is itself clearing the tokens (sign-out, a
   * deleted account). Every other clear is the client's, on a refusal.
   */
  const ownClear = useRef(false);

  /**
   * Record why the server ended the session, if the error says: to storage
   * first, so a reload at this instant still finds it, then to state.
   * Called for every refusal that reaches this provider, whichever request
   * it came from.
   */
  const noteSessionEnd = (error: unknown) => {
    const blocked = blockedReason(error);
    if (blocked) {
      writeSessionEnd({ kind: blocked });
      setAccountBlocked(blocked);
    }
    const inactive = collegeInactiveReason(error);
    if (inactive) {
      writeSessionEnd({ kind: 'COLLEGE_INACTIVE', message: inactive });
      setCollegeInactive(inactive);
    }
  };

  if (!clientRef.current) {
    const tokens = createTokenStore(() => {
      // The client clears the tokens when the server refuses the session,
      // and only afterwards calls `onAuthFailure` with the reason. Reacting
      // to the clear itself announced "signed out" in the gap between the
      // two — no user, no reason yet — and the route guard, seeing exactly
      // that, sent a suspended student to the welcome screen. Whether the
      // explanation then caught up was a matter of timing.
      //
      // So a clear made by the client is not announced here at all. Its
      // `onAuthFailure` follows on every path, and sets the reason and the
      // signed-out state in one step, with nothing in between to observe.
      // New tokens, and a clear this provider made itself, are announced.
      if (clientRef.current && !clientRef.current.hasSession() && !ownClear.current) return;
      setAuthVersion((v) => v + 1);
    });
    clientRef.current = new ApiClient({
      baseUrl: API_URL,
      tokens,
      onAuthFailure: (error) => {
        // Any request can be the one that discovers a suspension or a
        // deactivated college, not only `/auth/me` — a rider mid-poll finds
        // out from `/rider/status`. Reason and sign-out together.
        noteSessionEnd(error);
        setUser(null);
        setLoading(false);
        setServerUnreachable(false);
      },
    });
  }

  // A reason left by an earlier page load in this tab. Read once, on mount
  // (the server render has no storage), and before the first `/auth/me` is
  // sent, so that every screen deciding where a signed-out visitor belongs
  // already has it by the time `loading` turns false.
  useEffect(() => {
    const ended = readSessionEnd();
    if (ended?.kind === 'COLLEGE_INACTIVE') setCollegeInactive(ended.message);
    else if (ended) setAccountBlocked(ended.kind);
  }, []);

  const api = useMemo(() => endpoints(clientRef.current!), []);

  /** How many `/auth/me` reads are in the air. */
  const meInFlight = useRef(0);

  // For the retry below: the latest user without re-creating `refreshUser`,
  // the pending timer, and how many attempts have failed in a row.
  const userRef = useRef<AuthUser | null>(null);
  userRef.current = user;
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttempt = useRef(0);
  const refreshUserRef = useRef<() => Promise<void>>(async () => {});
  const [serverUnreachable, setServerUnreachable] = useState(false);

  const refreshUser = useCallback(async () => {
    // No tokens means no session, and there is nothing to ask the server.
    // Belt and braces with the token store's guard against the same loop.
    if (!clientRef.current!.hasSession()) {
      // Unless a read is still in the air, in which case it is that read's
      // refusal that just cleared the tokens, and it has not yet said why.
      // The client clears the tokens first and reports the reason a moment
      // later; announcing "signed out" in between sent a student whose
      // account was suspended, or whose college was deactivated, to the
      // welcome screen a beat before the explanation arrived — and the
      // welcome screen is where they stayed. Let that read finish: it sets
      // the reason and the signed-out state together.
      if (meInFlight.current > 0) return;
      setUser(null);
      setLoading(false);
      setServerUnreachable(false);
      return;
    }

    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }

    let retrying = false;
    meInFlight.current += 1;
    try {
      const { user: me } = await api.auth.me();
      // An answer that was already on its way when another request's refusal
      // ended the session. It describes an account as of a moment ago; the
      // tokens it was fetched with are gone. Adopting it would sign the
      // student back in with nothing to back it, and — worse — wipe the
      // reason just recorded, so that the next request's bare 401 would drop
      // them on the welcome screen unexplained.
      if (!clientRef.current!.hasSession()) return;
      setUser(me);
      retryAttempt.current = 0;
      setServerUnreachable(false);
      // The server has just described a live account: whatever ended an
      // earlier session in this tab is over.
      clearSessionEnd();
      setAccountBlocked(null);
      setCollegeInactive(null);
    } catch (error) {
      noteSessionEnd(error);

      if (error instanceof ApiError && error.isAuthFailure) {
        // A 401 is the normal state before sign-in, not something to log.
        setUser(null);
      } else {
        // The server could not be reached, which says nothing about whether
        // the session is still good. Keep whoever was signed in: this runs
        // every time the tab regains focus, and a phone coming out of a lift
        // must not be thrown back to the welcome screen.
        console.warn('Could not load the signed-in user', error);

        // The harder case: nobody is known yet (a page load, or the moment
        // after sign-in) and the server did not answer. There are tokens, so
        // this is very probably a signed-in student on a bad connection, or
        // an API that is restarting. Calling that "signed out" sent them to
        // the welcome screen with a perfectly good session in storage. So
        // the question stays open — `loading` holds — and is asked again,
        // a little less often each time, until the server says who they are
        // or says the session is over.
        if (userRef.current === null && clientRef.current!.hasSession()) {
          retrying = true;
          const delay = Math.min(1000 * 2 ** retryAttempt.current, 8000);
          retryAttempt.current += 1;
          setLoading(true);
          setServerUnreachable(true);
          retryTimer.current = setTimeout(() => void refreshUserRef.current(), delay);
        }
      }
    } finally {
      meInFlight.current -= 1;
      if (!retrying) {
        setLoading(false);
        setServerUnreachable(false);
      }
    }
  }, [api]);
  refreshUserRef.current = refreshUser;

  // The provider lives as long as the app, but a pending retry should not
  // outlive it in tests or on a hot reload.
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  useEffect(() => {
    void refreshUser();
  }, [refreshUser, authVersion]);

  // Verification is decided by an administrator, somewhere else, at a time
  // the student cannot see. Re-reading the user when the tab comes back is
  // what lets "approved" show up without a reload — the usual pattern is
  // submit, switch to another app, come back later. Throttled, because focus
  // and visibility both fire on one return and some browsers fire them often.
  const lastFocusRefresh = useRef(0);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      if (!clientRef.current!.hasSession()) return;

      const now = Date.now();
      if (now - lastFocusRefresh.current < FOCUS_REFRESH_MIN_GAP_MS) return;
      lastFocusRefresh.current = now;

      void refreshUser();
    };

    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [refreshUser]);

  const login = useCallback(
    async (identifier: string, password: string) => {
      let tokens: TokenPair;
      try {
        tokens = await api.auth.login(identifier, password);
      } catch (error) {
        // Sign-in is where a suspended student usually finds out. Record it
        // so the sign-in screen can hand over to /suspended, then let the
        // error through for everything else that reads it.
        noteSessionEnd(error);
        throw error;
      }
      clearSessionEnd();
      setAccountBlocked(null);
      setCollegeInactive(null);
      await clientRef.current!.setTokens(tokens);
      await refreshUser();
    },
    [api, refreshUser],
  );

  const adoptSession = useCallback(
    async (tokens: TokenPair) => {
      await clientRef.current!.setTokens(tokens);
      await refreshUser();
    },
    [refreshUser],
  );

  const dropSession = useCallback(async () => {
    ownClear.current = true;
    try {
      await clientRef.current!.clearTokens();
    } finally {
      ownClear.current = false;
    }
    clearSessionEnd();
    setUser(null);
    setAccountBlocked(null);
    setCollegeInactive(null);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout(clientRef.current!.currentRefreshToken());
    } catch {
      // Signing out locally matters more than the server acknowledging it.
    }
    // Last, so that a refusal of the request above (a suspended account's
    // sign-out is refused like everything else) cannot leave a reason behind
    // after the student has deliberately signed out.
    await dropSession();
  }, [api, dropSession]);

  const adoptUser = useCallback((next: AuthUser) => setUser(next), []);

  const value = useMemo<ApiContextValue>(
    () => ({
      api,
      client: clientRef.current!,
      user,
      loading,
      signedIn: user !== null,
      serverUnreachable,
      accountBlocked,
      collegeInactive,
      login,
      adoptSession,
      logout,
      refreshUser,
      adoptUser,
      dropSession,
    }),
    [
      api,
      user,
      loading,
      serverUnreachable,
      accountBlocked,
      collegeInactive,
      login,
      adoptSession,
      logout,
      refreshUser,
      adoptUser,
      dropSession,
    ],
  );

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiContextValue {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error('useApi must be used inside an ApiProvider');
  return ctx;
}

/**
 * Turn any thrown value into something worth showing a student.
 *
 * NFR-U-05 asks that an error say what went wrong and what to do next. The API
 * writes its messages that way, so the job here is mostly not to lose them.
 * The three cases below are the ones where a phone needs different words than
 * the API's: a rate limit, a lost connection, and a race another student won.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isRateLimited) {
      return 'Too many attempts just now. Wait a moment and try again.';
    }
    if (error.isAlreadyTaken) {
      return 'Someone else took this one first.';
    }
    if (error.status === 0) {
      return 'No connection. Check your network and try again.';
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
