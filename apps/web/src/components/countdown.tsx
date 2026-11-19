'use client';

import { useEffect, useState } from 'react';

/**
 * Seconds remaining until an instant, recomputed every second.
 *
 * Counts against a wall-clock target rather than decrementing a number. A
 * decrementing counter drifts whenever the tab is throttled — and mobile
 * browsers throttle background timers hard — so a 60-second offer window
 * would still read "18 seconds left" after the server had already withdrawn
 * it. Comparing against `expiresAt` cannot drift.
 *
 * The server's clock is the one that matters, and this uses the phone's. A
 * phone whose clock is wrong will show a wrong countdown; the accept call is
 * still judged by the server, so the consequence is a confusing number, not
 * a wrong outcome.
 */
export function useCountdown(expiresAt: string | null | undefined): number {
  const [remaining, setRemaining] = useState(() => secondsUntil(expiresAt));

  useEffect(() => {
    setRemaining(secondsUntil(expiresAt));
    if (!expiresAt) return;

    const timer = setInterval(() => setRemaining(secondsUntil(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return remaining;
}

function secondsUntil(at: string | null | undefined): number {
  if (!at) return 0;
  return Math.max(0, Math.ceil((new Date(at).getTime() - Date.now()) / 1000));
}

/** A bar that empties as the window closes. */
export function CountdownBar({ remaining, total }: { remaining: number; total: number }) {
  const fraction = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
  const urgent = remaining <= 10;

  return (
    <div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={remaining}
        aria-label="Time left to accept"
      >
        <div
          className={`h-full transition-[width] duration-1000 ease-linear ${
            urgent ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-accent)]'
          }`}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      {/* The number as well as the bar: NFR-U-04's no-colour-alone rule applies
          to urgency too, and "9" is unambiguous where a red bar is not. */}
      <p
        aria-live="polite"
        className={`mt-1 text-center text-sm font-bold ${
          urgent ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-soft)]'
        }`}
      >
        {remaining > 0 ? `${remaining}s to decide` : 'Window closed'}
      </p>
    </div>
  );
}
