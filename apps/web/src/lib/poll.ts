'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Poll an endpoint on an interval, with the behaviour a phone needs.
 *
 * The API pushes order and task events over a WebSocket, and this app uses
 * it. Polling is the floor rather than the plan: a phone walking across
 * campus hands off between access points and drops its socket constantly, and
 * a student watching a tracking screen that silently stopped updating is
 * worse than one that refetches every few seconds. The two are
 * complementary — the socket makes it instant, the poll makes it correct.
 *
 * Three details that matter:
 *
 *  - Polling pauses when the tab is hidden, so a dashboard left open on a
 *    background tab stops making requests, and resumes with an immediate
 *    fetch rather than waiting out the interval.
 *  - A failed poll does not clear the last good data. A momentary network
 *    blip should not blank the queue an operator is reading from.
 *  - Overlapping requests are skipped rather than queued, so a slow response
 *    cannot build up a backlog.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
  /**
   * False means "do not fetch at all": no timer and no first request. For a
   * screen that has to wait for something — sign-in, verification — before
   * the endpoint will answer with anything but a refusal. `loading` is only
   * meaningful while this is true.
   */
  enabled = true,
) {
  const [data, setData] = useState<T | null>(null);
  /**
   * Normalised to `Error | null` rather than left as `unknown`.
   *
   * `unknown` forces every call site to narrow before it can render, and
   * `{error && <Banner/>}` with an `unknown` left-hand side has type
   * `unknown` — which React 19's types reject as a child. Normalising here
   * means one conversion instead of one per screen.
   */
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const inFlight = useRef(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const next = await fetcherRef.current();
      setData(next);
      setError(null);
    } catch (e) {
      // Keep whatever was last shown; surface the error alongside it. A
      // momentary network blip must not blank a screen someone is reading.
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      void run();
      timer = setInterval(() => void run(), intervalMs);
    };

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, intervalMs, enabled, ...deps]);

  return { data, error, loading, refresh: run };
}
