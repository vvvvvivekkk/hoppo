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
  login(identifier: string, password: string): Promise<void>;
  /** Registration returns tokens, so it signs the student straight in. */
  adoptSession(tokens: TokenPair): Promise<void>;
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
  // parallel refreshes tripping the API's token-reuse detection — which on a
  // phone matters more than on a desktop, because several screens can come
  // back from sleep and refetch at the same instant.
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
      // A 401 is the normal state before sign-in, not something to log.
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
  }, [api]);

  const value = useMemo<ApiContextValue>(
    () => ({
      api,
      client: clientRef.current!,
      user,
      loading,
      signedIn: user !== null,
      login,
      adoptSession,
      logout,
      refreshUser,
    }),
    [api, user, loading, login, adoptSession, logout, refreshUser],
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
