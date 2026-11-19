'use client';

import {
  ApiClient,
  ApiError,
  endpoints,
  type AuthUser,
  type Endpoints,
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
  user: AuthUser | null;
  loading: boolean;
  signedIn: boolean;
  login(identifier: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refreshUser(): Promise<void>;
}

const ApiContext = createContext<ApiContextValue | null>(null);

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export function ApiProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authVersion, setAuthVersion] = useState(0);

  // One client for the lifetime of the app. Rebuilding it per render would
  // throw away the in-flight refresh promise, and that promise is what stops
  // parallel refreshes tripping the API's token-reuse detection.
  const clientRef = useRef<ApiClient | null>(null);

  if (!clientRef.current) {
    const tokens = createTokenStore(() => setAuthVersion((v) => v + 1));
    clientRef.current = new ApiClient({
      baseUrl: API_URL,
      tokens,
      onAuthFailure: () => setUser(null),
    });
  }

  const api = useMemo(() => endpoints(clientRef.current!), []);

  const refreshUser = useCallback(async () => {
    try {
      const { user: me } = await api.auth.me();
      setUser(me);
    } catch (error) {
      // A 401 here means no session, which is the normal state before login
      // and not worth surfacing as an error.
      if (!(error instanceof ApiError && error.isAuthFailure)) {
        console.error('Could not load the signed-in user', error);
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser, authVersion]);

  const login = useCallback(
    async (identifier: string, password: string) => {
      const tokens = await api.auth.login(identifier, password);
      await clientRef.current!.setTokens(tokens);
      await refreshUser();
    },
    [api, refreshUser],
  );

  const logout = useCallback(async () => {
    try {
      // Revoke this device's refresh token server-side, so closing the tab is
      // not the only thing standing between the next person and the session.
      await api.auth.logout(clientRef.current!.currentRefreshToken());
    } catch {
      // Logging out locally matters more than the server acknowledging it.
    }
    await clientRef.current!.clearTokens();
    setUser(null);
  }, [api]);

  const value = useMemo<ApiContextValue>(
    () => ({ api, user, loading, signedIn: user !== null, login, logout, refreshUser }),
    [api, user, loading, login, logout, refreshUser],
  );

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiContextValue {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error('useApi must be used inside an ApiProvider');
  return ctx;
}

/**
 * Turn any thrown value into something worth showing a user.
 *
 * NFR-U-05: an error should say what went wrong and what to do next. The API
 * already writes messages that way, so the job here is mostly to not lose
 * them — and to have something sensible for the cases that never reached the
 * API at all.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isRateLimited) {
      return 'Too many attempts just now. Wait a moment and try again.';
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
