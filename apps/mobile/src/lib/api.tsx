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
import { createTokenStore, loadStoredTokens } from './tokens';

interface Value {
  api: Endpoints;
  client: ApiClient;
  user: AuthUser | null;
  loading: boolean;
  signedIn: boolean;
  /** FR-SVER-07: what the student can actually do right now. */
  isVerified: boolean;
  setTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void>;
  login(identifier: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refreshUser(): Promise<void>;
}

const Ctx = createContext<Value | null>(null);

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export function ApiProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  const clientRef = useRef<ApiClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new ApiClient({
      baseUrl: API_URL,
      tokens: createTokenStore(() => setVersion((v) => v + 1)),
      onAuthFailure: () => setUser(null),
      // A phone on campus 4G is slower than a desk. Twenty seconds is the
      // web default; thirty avoids timing out a request that would have
      // succeeded, which on a flaky connection is the common case.
      timeoutMs: 30_000,
    });
  }

  const api = useMemo(() => endpoints(clientRef.current!), []);

  const refreshUser = useCallback(async () => {
    try {
      const { user: me } = await api.auth.me();
      setUser(me);
    } catch (error) {
      if (!(error instanceof ApiError && error.isAuthFailure)) {
        console.warn('Could not load the signed-in user', error);
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Tokens come out of SecureStore asynchronously, so the first request has to
  // wait for them or it goes out unauthenticated and the app bounces to the
  // welcome screen on every cold start.
  useEffect(() => {
    void (async () => {
      const stored = await loadStoredTokens();
      if (!stored) {
        setLoading(false);
        return;
      }
      await refreshUser();
    })();
  }, [refreshUser]);

  useEffect(() => {
    if (version === 0) return;
    void refreshUser();
  }, [version, refreshUser]);

  const setTokens = useCallback(
    async (tokens: { accessToken: string; refreshToken: string }) => {
      await clientRef.current!.setTokens(tokens);
      await refreshUser();
    },
    [refreshUser],
  );

  const login = useCallback(
    async (identifier: string, password: string) => {
      const tokens = await api.auth.login(identifier, password);
      await setTokens(tokens);
    },
    [api, setTokens],
  );

  const logout = useCallback(async () => {
    try {
      await api.auth.logout(clientRef.current!.currentRefreshToken());
    } catch {
      // Clearing locally matters more than the server acknowledging it.
    }
    await clientRef.current!.clearTokens();
    setUser(null);
  }, [api]);

  const value = useMemo<Value>(
    () => ({
      api,
      client: clientRef.current!,
      user,
      loading,
      signedIn: user !== null,
      isVerified: user?.studentProfile?.verificationStatus === 'VERIFIED',
      setTokens,
      login,
      logout,
      refreshUser,
    }),
    [api, user, loading, setTokens, login, logout, refreshUser],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApi(): Value {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApi must be used inside an ApiProvider');
  return ctx;
}

/**
 * NFR-U-05: say what went wrong and what to do next.
 *
 * The API already writes its messages that way, so this mostly keeps them —
 * with phone-specific wording for the failures that never reached the API.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK_ERROR') {
      return 'No connection. Check your network and try again.';
    }
    if (error.isRateLimited) {
      return 'Too many attempts just now. Wait a moment and try again.';
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
