'use client';

/**
 * Why the server ended the session, kept where a reload cannot lose it.
 *
 * A suspended account and a deactivated college both end the same way: the
 * API refuses the token, the client throws the tokens away, and there is no
 * signed-in user left to read a reason from. The reason therefore has to be
 * held somewhere else, and React state alone was not enough — it does not
 * survive a reload, and the student who reloads at that moment (or whose
 * redirect to the welcome screen wins a race with the explanation) is left on
 * "Create an account" with no idea why they were signed out.
 *
 * `sessionStorage`, not `localStorage`: this is a fact about what just
 * happened in this tab, not a setting. It should not follow the student into
 * a tab opened next week, after an administrator has reinstated them. It is
 * written the moment a refusal carrying one of these codes is seen, and
 * removed on a successful sign-in or an explicit sign-out.
 */
export type SessionEnd =
  | { kind: 'SUSPENDED' | 'DEACTIVATED' }
  /** `message` is the API's own sentence, shown as it came. */
  | { kind: 'COLLEGE_INACTIVE'; message: string };

const STORAGE_KEY = 'hoppo.student.sessionEnd';

export function readSessionEnd(): SessionEnd | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionEnd> & { message?: unknown };
    if (parsed.kind === 'SUSPENDED' || parsed.kind === 'DEACTIVATED') return { kind: parsed.kind };
    if (parsed.kind === 'COLLEGE_INACTIVE' && typeof parsed.message === 'string') {
      return { kind: 'COLLEGE_INACTIVE', message: parsed.message };
    }
    return null;
  } catch {
    // Unreadable storage means "no reason on record", never a crash.
    return null;
  }
}

export function writeSessionEnd(end: SessionEnd): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(end));
  } catch {
    /* in-memory only: the provider's state still carries it until a reload */
  }
}

export function clearSessionEnd(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
