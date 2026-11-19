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

  /**
   * FR-SVER-08: the account itself is suspended or closed, as opposed to the
   * session merely having expired. Null for every other error.
   */
  get accountBlocked(): 'SUSPENDED' | 'DEACTIVATED' | null {
    if (this.code === 'ACCOUNT_SUSPENDED') return 'SUSPENDED';
    if (this.code === 'ACCOUNT_DEACTIVATED') return 'DEACTIVATED';
    return null;
  }

  /** FR-SVER-01: the caller is registered but not yet verified. */
  get needsVerification(): boolean {
    return this.code === 'VERIFICATION_REQUIRED';
  }

  /** FR-DLV-04: another rider won the task. Not an error to apologise for. */
  get isAlreadyTaken(): boolean {
    return this.code === 'ALREADY_TAKEN';
  }

  /**
   * FR-DLV-04: an accept that lost for a reason other than another rider
   * winning — the offer lapsed, was never this rider's, or the task moved on.
   * The offer card should be dropped, not retried. `ALREADY_TAKEN` is kept
   * apart under `isAlreadyTaken` because it reads differently ("too slow").
   */
  get isOfferGone(): boolean {
    return [
      'OFFER_EXPIRED',
      'NOT_OFFERED_TO_YOU',
      'NOT_YET_OFFERED',
      'OFFER_CLOSED',
      'TASK_CANCELLED',
      'TASK_FINISHED',
    ].includes(this.code);
  }

  /**
   * The order moved on between the screen loading and the button being
   * pressed (409). Reload the order and show its real state rather than an
   * error.
   */
  get isStaleState(): boolean {
    return this.code === 'ORDER_STATE_CHANGED' || this.code === 'ORDER_NOT_READY';
  }

  /** FR-SVER-08: boolean form of `accountBlocked`. */
  get isAccountBlocked(): boolean {
    return this.accountBlocked !== null;
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
