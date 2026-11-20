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
  /**
   * Why the visitor is on the login screen when they did not ask to be: the
   * account was suspended mid-session, the session ran out, or the account
   * belongs in a different app. Null when there is nothing to explain.
   */
  notice: string | null;
}

const ApiContext = createContext<ApiContextValue | null>(null);

/**
 * Who this console is for. Anyone else can hold a perfectly valid Hoppo
 * session and still have no business here: every endpoint the screens call
 * would answer 403, and the visitor would be left reading "This action
 * requires one of: ..." on a page that half-rendered. So the role is checked
 * once, at the door.
 */
const ALLOWED_ROLES: readonly AuthUser['role'][] = ['ADMIN', 'SUPER_ADMIN'];

function wrongAppMessage(role: AuthUser['role']): string {
  if (role === 'STUDENT') {
    return 'This is the admin console, and that is a student account. Students order and deliver in the Hoppo app, not here.';
  }
  return 'This is the admin console, and that is a shop account. Shop owners and staff sign in to the shop dashboard.';
}

/** FR-SVER-08: the session ended because of the account, not the clock. */
function blockedMessage(kind: 'SUSPENDED' | 'DEACTIVATED'): string {
  return kind === 'SUSPENDED'
    ? 'This account has been suspended, so you have been signed out. Contact whoever manages your Hoppo access.'
    : 'This account has been closed, so you have been signed out.';
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export function ApiProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authVersion, setAuthVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  // Whether somebody was signed in, readable from callbacks that outlive the
  // render they were created in (the client below is built exactly once).
  const signedInRef = useRef(false);
  signedInRef.current = user !== null;

  // One client for the lifetime of the app. Rebuilding it per render would
  // throw away the in-flight refresh promise, and that promise is what stops
  // parallel refreshes tripping the API's token-reuse detection.
  const clientRef = useRef<ApiClient | null>(null);

  if (!clientRef.current) {
    const tokens = createTokenStore(() => setAuthVersion((v) => v + 1));
    clientRef.current = new ApiClient({
      baseUrl: API_URL,
      tokens,
      onAuthFailure: (error) => {
        // The API answers a suspended or closed account with a 401, which is
        // indistinguishable from an expired session unless the code is read.
        // Without this the operator is dropped on the login screen with no
        // idea why, and signs in again only to be refused.
        const blocked = error?.accountBlocked ?? null;
        if (blocked) setNotice(blockedMessage(blocked));
        // `leaving`: a refused revoke on the way out is not news to anyone.
        else if (signedInRef.current && !leaving.current) {
          setNotice('Your session has ended. Sign in again to carry on.');
        }
        setUser(null);
      },
    });
  }

  const api = useMemo(() => endpoints(clientRef.current!), []);

  /**
   * End the session in this tab now, and tell the server afterwards.
   *
   * It used to be the other way round — `await` the server's revoke, then
   * clear the tokens — which made signing out exactly as slow as the API: a
   * busy server (or one that never answers, up to the client's 20 s timeout)
   * left a session sitting in a tab whose screen already said it was over.
   * It could not fail silently, since a thrown revoke was caught and the
   * tokens cleared anyway, but it could take that long.
   *
   * The revoke is started first because the client reads the access token as
   * it builds the request, synchronously inside the call, so the request
   * already carries its Authorization header by the time the store is
   * emptied on the next line. Nothing waits for the answer.
   */
  const leaving = useRef(false);
  const dropSession = useCallback(async () => {
    const client = clientRef.current!;
    if (client.hasSession()) {
      leaving.current = true;
      const revoke = api.auth.logout(client.currentRefreshToken());
      void revoke
        .catch(() => {
          // The session is gone here whatever the server made of the revoke.
        })
        .finally(() => {
          leaving.current = false;
        });
    }
    await client.clearTokens();
  }, [api]);

  // One /auth/me at a time. A login stores the tokens (which notifies the
  // effect below) and then asks for the user itself, so without this the same
  // question is asked twice in parallel on every sign-in.
  const refreshInFlight = useRef<Promise<void> | null>(null);

  const refreshUser = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;

    const run = (async () => {
      // No tokens means no session, and there is nothing to ask the server.
      // Belt and braces with the token store's guard against the same loop.
      if (!clientRef.current!.hasSession()) {
        setUser(null);
        setLoading(false);
        return;
      }

      try {
        const { user: me } = await api.auth.me();

        if (!ALLOWED_ROLES.includes(me.role)) {
          // The right password for the wrong app. Say so, and do not keep the
          // session: a signed-in tab that can do nothing is worse than a
          // login screen that explains itself.
          setNotice(wrongAppMessage(me.role));
          await dropSession();
          setUser(null);
          return;
        }

        setUser(me);
      } catch (error) {
        if (error instanceof ApiError && error.accountBlocked) {
          setNotice(blockedMessage(error.accountBlocked));
        } else if (!(error instanceof ApiError && error.isAuthFailure)) {
          // A 401 here means no session, which is the normal state before
          // login and not worth surfacing as an error.
          console.error('Could not load the signed-in user', error);
        }
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();

    refreshInFlight.current = run;
    void run.finally(() => {
      if (refreshInFlight.current === run) refreshInFlight.current = null;
    });
    return run;
  }, [api, dropSession]);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser, authVersion]);

  const login = useCallback(
    async (identifier: string, password: string) => {
      setNotice(null);
      const tokens = await api.auth.login(identifier, password);
      await clientRef.current!.setTokens(tokens);
      await refreshUser();
    },
    [api, refreshUser],
  );

  const logout = useCallback(async () => {
    // Revoke this device's refresh token server-side, so closing the tab is
    // not the only thing standing between the next person and the session —
    // but sign out here first; see dropSession.
    await dropSession();
    setUser(null);
    // Signing out on purpose needs no explanation on the login screen.
    setNotice(null);
  }, [dropSession]);

  const value = useMemo<ApiContextValue>(
    () => ({ api, user, loading, signedIn: user !== null, login, logout, refreshUser, notice }),
    [api, user, loading, login, logout, refreshUser, notice],
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
