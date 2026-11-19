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
import { createTokenStore } from './tokens';

interface ApiContextValue {
  api: Endpoints;
  /** The underlying client, for the socket handshake's token read. */
  client: ApiClient;
  user: AuthUser | null;
  loading: boolean;
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
  login(identifier: string, password: string): Promise<void>;
  /** Registration returns tokens, so it signs the student straight in. */
  adoptSession(tokens: TokenPair): Promise<void>;
  logout(): Promise<void>;
  refreshUser(): Promise<void>;
}

export type AccountBlocked = 'SUSPENDED' | 'DEACTIVATED';

/** Which kind of block an error describes, or null if it is something else. */
export function blockedReason(error: unknown): AccountBlocked | null {
  return error instanceof ApiError ? error.accountBlocked : null;
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

  // One client for the lifetime of the app. Rebuilding it per render would
  // throw away the in-flight refresh promise, and that promise is what stops
  // parallel refreshes tripping the API's token-reuse detection — which on a
  // phone matters more than on a desktop, because several screens can come
  // back from sleep and refetch at the same instant.
  const clientRef = useRef<ApiClient | null>(null);

  if (!clientRef.current) {
    const tokens = createTokenStore(() => setAuthVersion((v) => v + 1));
    clientRef.current = new ApiClient({
      baseUrl: API_URL,
      tokens,
      onAuthFailure: (error) => {
        // Any request can be the one that discovers a suspension, not only
        // `/auth/me` — a rider mid-poll finds out from `/rider/status`.
        const blocked = blockedReason(error);
        if (blocked) setAccountBlocked(blocked);
        setUser(null);
      },
    });
  }

  const api = useMemo(() => endpoints(clientRef.current!), []);

  const refreshUser = useCallback(async () => {
    // No tokens means no session, and there is nothing to ask the server.
    // Belt and braces with the token store's guard against the same loop.
    if (!clientRef.current!.hasSession()) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      const { user: me } = await api.auth.me();
      setUser(me);
      setAccountBlocked(null);
    } catch (error) {
      const blocked = blockedReason(error);
      if (blocked) setAccountBlocked(blocked);

      if (error instanceof ApiError && error.isAuthFailure) {
        // A 401 is the normal state before sign-in, not something to log.
        setUser(null);
      } else {
        // The server could not be reached, which says nothing about whether
        // the session is still good. Keep whoever was signed in: this runs
        // every time the tab regains focus, and a phone coming out of a lift
        // must not be thrown back to the welcome screen.
        console.warn('Could not load the signed-in user', error);
      }
    } finally {
      setLoading(false);
    }
  }, [api]);

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
        const blocked = blockedReason(error);
        if (blocked) setAccountBlocked(blocked);
        throw error;
      }
      setAccountBlocked(null);
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

  const logout = useCallback(async () => {
    try {
      await api.auth.logout(clientRef.current!.currentRefreshToken());
    } catch {
      // Signing out locally matters more than the server acknowledging it.
    }
    await clientRef.current!.clearTokens();
    setUser(null);
    setAccountBlocked(null);
  }, [api]);

  const value = useMemo<ApiContextValue>(
    () => ({
      api,
      client: clientRef.current!,
      user,
      loading,
      signedIn: user !== null,
      accountBlocked,
      login,
      adoptSession,
      logout,
      refreshUser,
    }),
    [api, user, loading, accountBlocked, login, adoptSession, logout, refreshUser],
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
