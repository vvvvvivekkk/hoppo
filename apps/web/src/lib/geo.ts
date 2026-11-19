'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type GeoState =
  | { kind: 'idle' }
  | { kind: 'asking' }
  | { kind: 'granted'; latitude: number; longitude: number; accuracyM: number; at: number }
  | { kind: 'denied' }
  | { kind: 'unavailable'; reason: string };

/**
 * The rider's position, from the browser.
 *
 * This is the one place the web app is genuinely weaker than a native app,
 * and it is worth being precise about why rather than pretending otherwise:
 *
 *  - **Only while the tab is open and visible.** `watchPosition` stops when
 *    a browser tab is backgrounded or the phone is locked. A native app can
 *    register for background location; a web page cannot. So a rider who
 *    pockets their phone stops reporting, and FR-WM-06's idle timeout will
 *    eventually take them offline.
 *  - **Requires HTTPS**, except on localhost. On a plain-HTTP deployment the
 *    geolocation API simply is not there, which is a deployment error worth
 *    reporting clearly rather than as "permission denied".
 *  - **Accuracy varies wildly.** Wi-Fi positioning indoors on a campus can be
 *    off by a hundred metres, which matters because dispatch ranks riders by
 *    distance. The accuracy figure is surfaced so a rider can see when their
 *    fix is poor.
 *
 * The watch runs while the rider is online **or has asked to go online**.
 * The second half matters: work mode cannot be switched on without a fix, so
 * a watch that only started once work mode was on could never produce the
 * fix that switching it on needs. `request()` is the "I want to go online"
 * signal, and `release()` withdraws it if going online did not happen.
 *
 * `watchPosition` rather than repeated `getCurrentPosition`: the browser
 * coalesces updates and reuses a warm GPS fix, which costs far less battery
 * than asking cold every fifteen seconds.
 */
export function useRiderPosition(active: boolean): {
  state: GeoState;
  /** Ask for a fix now. Safe to call again after a refusal or a timeout. */
  request: () => void;
  /** Withdraw a `request()` that did not end in going online. */
  release: () => void;
} {
  const [state, setState] = useState<GeoState>({ kind: 'idle' });
  /** The rider asked for a fix, whether or not work mode is on yet. */
  const [requested, setRequested] = useState(false);
  /** Bumped by each request so a dead watch (refused, timed out) restarts. */
  const [attempt, setAttempt] = useState(0);
  const watchId = useRef<number | null>(null);

  const request = useCallback(() => {
    setRequested(true);
    setAttempt((n) => n + 1);
  }, []);

  const release = useCallback(() => setRequested(false), []);

  // Work mode already on when the page loads counts as wanting a fix: the
  // rider is online as far as the server knows, and without a watch no ping
  // is ever sent and the idle sweep takes them offline.
  const watching = active || requested;

  useEffect(() => {
    if (!watching) return;

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({
        kind: 'unavailable',
        reason:
          'This browser is not reporting location. On a phone that usually means the page is not on HTTPS.',
      });
      return;
    }

    // Keep a fix we already have: a retry should not blank the accuracy line
    // or stop pings while the new watch warms up.
    setState((current) => (current.kind === 'granted' ? current : { kind: 'asking' }));

    watchId.current = navigator.geolocation.watchPosition(
      (position) =>
        setState({
          kind: 'granted',
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: position.coords.accuracy,
          at: position.timestamp,
        }),
      (err) => {
        setState((current) => {
          if (err.code === err.PERMISSION_DENIED) return { kind: 'denied' };
          // A timeout or a lost signal after a good fix is not a reason to
          // throw the fix away — the watch keeps running and will report
          // again. Only say "unavailable" when there is nothing to fall back on.
          if (current.kind === 'granted') return current;
          return {
            kind: 'unavailable',
            reason:
              err.code === err.TIMEOUT
                ? 'Could not get a location fix. Step outside or near a window and try again.'
                : 'Location is unavailable on this device right now.',
          };
        });
      },
      {
        enableHighAccuracy: true,
        // A fix up to 30 seconds old is fine — dispatch tolerates that, and
        // refusing cached fixes means waking the GPS for every poll.
        maximumAge: 30_000,
        timeout: 20_000,
      },
    );

    return () => {
      if (watchId.current !== null) {
        navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
      }
    };
    // `state.kind` is deliberately not a dependency. It used to be, which
    // tore the watch down and rebuilt it on every transition — including the
    // one from "asking" to "granted" that the watch itself had just caused.
  }, [watching, attempt]);

  // Going offline releases the GPS (the cleanup above) and forgets the fix.
  // Holding a watch open for a rider who is not working is a battery
  // complaint with no upside.
  useEffect(() => {
    if (!watching) setState({ kind: 'idle' });
  }, [watching]);

  return { state, request, release };
}
