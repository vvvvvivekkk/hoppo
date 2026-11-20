import { ApiError, NetworkError, type ApiErrorBody } from './errors';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn?: string;
}

/**
 * Where tokens live. Deliberately an interface rather than a hard-coded
 * localStorage call: the web consoles keep tokens in memory plus a cookie,
 * and the mobile app uses secure storage. The client should not know which.
 */
export interface TokenStore {
  get(): TokenPair | null;
  set(tokens: TokenPair): void | Promise<void>;
  clear(): void | Promise<void>;
}

export interface ApiClientOptions {
  baseUrl: string;
  tokens: TokenStore;
  /**
   * Called when the session is unrecoverable, so the UI can send them to login.
   *
   * Handed the error that ended it when there is one, because "your session
   * expired" and "your account was suspended" need different screens: the
   * API's JWT guard answers a suspended account with a 401 carrying
   * `ACCOUNT_SUSPENDED`, and without the error here the UI could only treat
   * both as a plain sign-out.
   */
  onAuthFailure?: (error?: ApiError) => void;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Skip the Authorization header — used for login and registration. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

/**
 * The HTTP client.
 *
 * Two behaviours worth knowing about:
 *
 * **Refresh is serialised.** When an access token expires, several requests
 * in flight will all get a 401 at once. Without coordination each would
 * independently try to refresh, and because refresh tokens rotate with reuse
 * detection (ADR in the API), the second one to arrive would look like a
 * replayed token and revoke the entire session. So the first 401 starts a
 * refresh and every other caller waits on that same promise.
 *
 * **A failed refresh is final.** It means the session is genuinely gone, so
 * the tokens are cleared and `onAuthFailure` fires once rather than the UI
 * looping.
 */
export class ApiClient {
  private refreshInFlight: Promise<boolean> | null = null;

  /**
   * Why the last refresh was refused, when the API said. A refresh refused
   * because of the account (`ACCOUNT_UNAVAILABLE`) or its college
   * (`COLLEGE_INACTIVE`) explains the sign-out better than the expired 401
   * that triggered it, so `onAuthFailure` is handed this instead.
   */
  private refreshRefusal: ApiError | null = null;

  constructor(private readonly options: ApiClientOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /**
   * Store a fresh token pair — after a login, or after a registration that
   * returns one.
   *
   * Exposed as a method so callers do not reach into `options.tokens`. The
   * client owns the refresh lifecycle, so it should own the writes too.
   */
  async setTokens(tokens: TokenPair): Promise<void> {
    await this.options.tokens.set(tokens);
  }

  async clearTokens(): Promise<void> {
    await this.options.tokens.clear();
  }

  hasSession(): boolean {
    return this.options.tokens.get() !== null;
  }

  /** The current refresh token, for a logout that revokes just this device. */
  currentRefreshToken(): string | undefined {
    return this.options.tokens.get()?.refreshToken;
  }

  /**
   * The current access token, for the Socket.IO handshake.
   *
   * Read fresh on every reconnection attempt rather than captured once: the
   * gateway verifies the token at connect time only, so a socket that opened
   * with a valid token keeps working as that token expires — but a reconnect
   * an hour later, after a phone came out of a tunnel, would hand over the
   * expired one and be rejected. Refresh has usually happened by then via an
   * ordinary request, so re-reading is all it takes.
   */
  currentAccessToken(): string | undefined {
    return this.options.tokens.get()?.accessToken;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, opts);

    // One retry, and only after a successful refresh.
    if (response.status === 401 && !opts.anonymous) {
      const refreshed = await this.refreshOnce();
      if (refreshed) {
        const retried = await this.send(path, opts);
        return this.unwrap<T>(retried);
      }

      await this.options.tokens.clear();

      try {
        return await this.unwrap<T>(response);
      } catch (error) {
        // The refresh route can refuse for five reasons (AuthService.refresh).
        // Three are about the token — REFRESH_INVALID, REFRESH_REUSED,
        // REFRESH_EXPIRED — and mean only "log in again", which the request's
        // own 401 already says. Two are about the account or its college —
        // ACCOUNT_UNAVAILABLE and COLLEGE_INACTIVE — and logging in again
        // will not help; those are what the UI needs, so they are reported
        // in place of the 401. (ACCOUNT_SUSPENDED / ACCOUNT_DEACTIVATED are
        // covered too, should the refresh route ever answer with them.)
        const refusal = this.refreshRefusal;
        this.refreshRefusal = null;
        const explains =
          refusal !== null && (refusal.isAccountUnavailable || refusal.code === 'COLLEGE_INACTIVE');
        this.options.onAuthFailure?.(
          explains ? refusal : error instanceof ApiError ? error : undefined,
        );
        throw error;
      }
    }

    // FR-ADM-07: a deactivated college's users are answered 403
    // COLLEGE_INACTIVE on every request. It is a 403, so it never reaches the
    // branch above, but it means the same as a suspended account's 401: the
    // session is over and refreshing cannot help (the refresh is refused with
    // the same code). End it the same way. An anonymous request (login) has
    // no session to end and just gets the error.
    if (response.status === 403 && !opts.anonymous) {
      try {
        return await this.unwrap<T>(response);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'COLLEGE_INACTIVE') {
          await this.options.tokens.clear();
          this.options.onAuthFailure?.(error);
        }
        throw error;
      }
    }

    return this.unwrap<T>(response);
  }

  private async send(path: string, opts: RequestOptions): Promise<Response> {
    const url = new URL(`${this.options.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);

    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (!opts.anonymous) {
      const token = this.options.tokens.get()?.accessToken;
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    try {
      return await fetch(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal,
      });
    } catch (error) {
      // A timeout or a dropped connection. NFR-U-05 wants an error that says
      // what the user can do next, and "check your connection" is that.
      const message =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'The request timed out. Check your connection and try again.'
          : 'Could not reach the server. Check your connection and try again.';
      throw new NetworkError(message);
    }
  }

  private async unwrap<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;

    if (!response.ok) {
      const body = (parsed ?? {}) as ApiErrorBody;
      throw new ApiError(
        response.status,
        body.code ?? 'ERROR',
        body.message ?? response.statusText,
        body.details,
      );
    }

    return parsed as T;
  }

  /**
   * Refresh the token pair, at most once concurrently.
   *
   * The shared promise is the important part — see the class comment. Without
   * it, parallel refreshes trip the API's reuse detection and log the user out
   * for being correct.
   */
  private refreshOnce(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const current = this.options.tokens.get();
      this.refreshRefusal = null;
      if (!current?.refreshToken) return false;

      try {
        const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
          this.refreshRefusal = new ApiError(
            response.status,
            body?.code ?? 'ERROR',
            body?.message ?? response.statusText,
            body?.details,
          );
          return false;
        }

        this.refreshRefusal = null;
        const tokens = (await response.json()) as TokenPair;
        await this.options.tokens.set(tokens);
        return true;
      } catch {
        return false;
      } finally {
        // Cleared in a microtask so concurrent callers still see this promise.
        setTimeout(() => {
          this.refreshInFlight = null;
        }, 0);
      }
    })();

    return this.refreshInFlight;
  }

  get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>(path, { method: 'GET', query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  /** Login and registration, which must not send a stale Authorization header. */
  anonymousPost<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body, anonymous: true });
  }
}
