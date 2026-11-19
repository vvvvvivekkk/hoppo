/**
 * The API's error shape, as produced by AllExceptionsFilter.
 *
 * Every error carries a machine-readable `code` alongside the human message,
 * which is what lets a client branch on meaning rather than on string
 * matching. `VERIFICATION_REQUIRED` routes a student to the verification
 * screen; `ALREADY_TAKEN` on a task offer is a normal outcome of a race and
 * should read as "too slow", not as a failure.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  path?: string;
  timestamp?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The session is gone or the account is no longer usable. */
  get isAuthFailure(): boolean {
    return (
      this.status === 401 ||
      ['ACCOUNT_SUSPENDED', 'ACCOUNT_DEACTIVATED', 'REFRESH_INVALID', 'REFRESH_REUSED'].includes(
        this.code,
      )
    );
  }

  /** FR-SVER-01: the caller is registered but not yet verified. */
  get needsVerification(): boolean {
    return this.code === 'VERIFICATION_REQUIRED';
  }

  /** FR-DLV-04: another rider won the task. Not an error to apologise for. */
  get isAlreadyTaken(): boolean {
    return this.code === 'ALREADY_TAKEN';
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * Worth retrying as-is. A 5xx or a network blip may succeed on a second
   * attempt; a 4xx will not, because the request itself is the problem.
   */
  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 0;
  }
}

export class NetworkError extends ApiError {
  constructor(message: string) {
    super(0, 'NETWORK_ERROR', message);
    this.name = 'NetworkError';
  }
}
