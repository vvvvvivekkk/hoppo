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
 * `watchPosition` rather than repeated `getCurrentPosition`: the browser
 * coalesces updates and reuses a warm GPS fix, which costs far less battery
 * than asking cold every fifteen seconds.
 */
export function useRiderPosition(active: boolean): {
  state: GeoState;
  request: () => void;
} {
  const [state, setState] = useState<GeoState>({ kind: 'idle' });
  const watchId = useRef<number | null>(null);

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({
        kind: 'unavailable',
        reason:
          'This browser is not reporting location. On a phone that usually means the page is not on HTTPS.',
      });
      return;
    }
    setState({ kind: 'asking' });
  }, []);

  useEffect(() => {
    if (!active || state.kind === 'idle' || state.kind === 'unavailable') return;
    if (watchId.current !== null) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;

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
        setState(
          err.code === err.PERMISSION_DENIED
            ? { kind: 'denied' }
            : {
                kind: 'unavailable',
                reason:
                  err.code === err.TIMEOUT
                    ? 'Could not get a location fix. Step outside or near a window and try again.'
                    : 'Location is unavailable on this device right now.',
              },
        );
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
  }, [active, state.kind]);

  // Going offline releases the GPS. Holding a watch open for a rider who is
  // not working is a battery complaint with no upside.
  useEffect(() => {
    if (active) return;
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    setState({ kind: 'idle' });
  }, [active]);

  return { state, request };
}
