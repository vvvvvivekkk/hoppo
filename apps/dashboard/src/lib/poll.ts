'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Poll an endpoint on an interval, with the behaviour a counter tablet needs.
 *
 * The API pushes order events over a WebSocket, and the dashboard should use
 * it. Polling is here as the floor rather than the plan: a tablet on campus
 * Wi-Fi drops its socket regularly, and a shop that stops seeing orders
 * because a socket died quietly is worse than a shop that fetches every few
 * seconds. The two are complementary — the socket makes it feel instant, the
 * poll makes it correct.
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

  const inFlight = useRef<Promise<T | null> | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback((): Promise<T | null> => {
    if (inFlight.current) return inFlight.current;

    const attempt = (async () => {
      try {
        const next = await fetcherRef.current();
        setData(next);
        setError(null);
        return next;
      } catch (e) {
        // Keep whatever was last shown; surface the error alongside it. A
        // momentary network blip must not blank a queue someone is reading.
        setError(e instanceof Error ? e : new Error(String(e)));
        return null;
      } finally {
        inFlight.current = null;
        setLoading(false);
      }
    })();

    inFlight.current = attempt;
    return attempt;
  }, []);

  /**
   * Fetch now, and mean it.
   *
   * The interval skips a tick while a request is in flight, which is right
   * for a timer and wrong for "I just accepted an order, show me the queue":
   * the request already in the air was sent *before* the action and returns
   * the queue as it was, so the card comes back with its Accept button live
   * for up to three seconds — long enough to tap it again and be told the
   * order is "already preparing". So this waits out whatever is in flight and
   * then asks afresh. Resolves to the new data, or null if that fetch failed.
   */
  const refresh = useCallback(async (): Promise<T | null> => {
    if (inFlight.current) await inFlight.current;
    return run();
  }, [run]);

  useEffect(() => {
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
  }, [run, intervalMs, ...deps]);

  return { data, error, loading, refresh };
}
