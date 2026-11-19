'use client';

import { wsEvents } from '@hoppo/shared';
import type { ApiClient, TaskOffer } from '@hoppo/api-client';
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

/**
 * The realtime connection (CI-2).
 *
 * This is how a task offer reaches a rider inside the three seconds NFR-P-02
 * asks for, and how an order status change reaches the student watching the
 * tracking screen. Polling could not do the first: FR-DLV-03 gives a rider a
 * 60-second window, and a poll frequent enough to be useful would mean every
 * online rider hitting the API every few seconds all day.
 *
 * Five behaviours, each there for a reason found while building the parked
 * Expo app and carried over:
 *
 *  - **The token is re-read on every reconnection attempt**, not captured
 *    once. `auth` as a callback is what makes that happen. The gateway
 *    verifies the token at connect time only, so an open socket survives its
 *    token expiring — but a reconnect after a long gap would hand over the
 *    stale one and be rejected, and the app would look broken while every
 *    ordinary request still worked.
 *  - **Reconnection is automatic with backoff** (NFR-R-05). A phone moving
 *    between campus Wi-Fi and 4G drops the socket constantly.
 *  - **An offer that arrives after its expiry is dropped.** A reconnect can
 *    deliver a queued offer whose window has already closed, and a countdown
 *    starting at zero just invites a tap that fails.
 *  - **A kick by the server is recovered from by hand.** socket.io-client
 *    reconnects on its own after a network drop, but deliberately not after
 *    the server closes the socket (`io server disconnect`) — and that is
 *    exactly what the gateway does to an expired token. Access tokens last
 *    fifteen minutes, so without this every socket would die for good within
 *    a quarter of an hour of a reconnect. The recovery makes one ordinary
 *    authenticated request, which is what triggers the client's token
 *    refresh, and then connects again with the new token.
 *  - **Handlers are read through a ref.** A screen that re-renders every
 *    second (every countdown does) would otherwise tear down and rebuild the
 *    socket on each tick.
 */
export interface SocketHandlers {
  onOffer?: (offer: TaskOffer) => void;
  /**
   * The offer is no longer open. `won` says whether this rider is the one who
   * got it. Losers are sent `winnerUserId: null` — who beat them is not their
   * business — so comparing ids is not a way to tell. `won` is optional only
   * because an older API build did not send it.
   */
  onOfferWithdrawn?: (payload: {
    taskId: string;
    winnerUserId: string | null;
    won?: boolean;
  }) => void;
  /**
   * Two different messages share this event name, so the payload is a union
   * and a handler has to narrow before reading `taskId`. See
   * `isWorkModeDisabled`.
   */
  onTaskStatus?: (payload: TaskStatusEvent) => void;
  onOrderStatus?: (payload: { orderId: string; status: string } & Record<string, unknown>) => void;
  /** FR-DLV-12: the handover code, to the requester's device only. */
  onHandoverCode?: (payload: {
    taskId: string;
    code: string;
    orderReference: string | null;
  }) => void;
}

/** A task moved to a new status. Broadcast to the whole college. */
export type TaskStatusChange = { taskId: string; status: string } & Record<string, unknown>;

/**
 * FR-WM-06: the server took this rider offline after too long without a
 * position update. Sent on the task-status event, to that rider only, and
 * carries no task at all.
 */
export interface WorkModeDisabled {
  type: 'WORK_MODE_DISABLED';
  reason: 'IDLE_TIMEOUT';
  afterMinutes: number;
}

export type TaskStatusEvent = TaskStatusChange | WorkModeDisabled;

export function isWorkModeDisabled(payload: TaskStatusEvent): payload is WorkModeDisabled {
  return (payload as { type?: unknown }).type === 'WORK_MODE_DISABLED';
}

/**
 * How long to wait before each recovery from a server-side kick. Three tries
 * and then stop: a kick that survives a fresh token is not about the token
 * (the account was suspended, or the server is refusing everyone), and
 * hammering it helps nobody. Polling carries the screen in the meantime.
 */
const KICK_RETRY_DELAYS_MS = [300, 3_000, 12_000];
/** A connection that lasts this long was a real one; forget earlier kicks. */
const STABLE_AFTER_MS = 30_000;

function socketOrigin(apiBaseUrl: string): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured;
  // The REST base URL carries the /api/v1 prefix; the socket namespace sits
  // at the origin.
  return apiBaseUrl.replace(/\/api\/v1\/?$/, '');
}

/**
 * Hold a socket open for as long as the component is mounted and signed in.
 *
 * Returns whether it is currently connected, so a screen can say so. That
 * matters on the rider screen in particular: a rider whose socket is down is
 * not receiving offers, and showing "reconnecting" is the difference between
 * a quiet evening and a bug report.
 *
 * `settled` is false until the first connection attempt has finished one way
 * or the other. Before that the socket is not "reconnecting", it is
 * connecting for the first time, and a screen that says "Reconnecting…" for
 * the first half second of every page load teaches people to ignore it.
 */
export function useSocket(
  client: ApiClient,
  enabled: boolean,
  handlers: SocketHandlers,
): { connected: boolean; settled: boolean; socket: Socket | null } {
  const [connected, setConnected] = useState(false);
  const [settled, setSettled] = useState(false);
  // State rather than a ref so that callers re-render with the live socket.
  const [socket, setSocket] = useState<Socket | null>(null);

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    const socket = io(`${socketOrigin(client.baseUrl)}/rt`, {
      // A callback, not a value: called again on every reconnection attempt,
      // so a refreshed token is picked up without rebuilding the socket.
      auth: (cb: (data: { token: string | undefined }) => void) =>
        cb({ token: client.currentAccessToken() }),
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 10_000,
    });

    setSocket(socket);

    let disposed = false;
    let kicks = 0;
    let kickTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;

    socket.on('connect', () => {
      setConnected(true);
      setSettled(true);
      // Not `kicks = 0` here: the gateway accepts the transport and then
      // closes it, so a rejected socket still fires `connect` first. Only a
      // connection that stays up counts as recovered.
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        kicks = 0;
      }, STABLE_AFTER_MS);
    });

    socket.on('connect_error', () => {
      setConnected(false);
      setSettled(true);
    });

    socket.on('disconnect', (reason) => {
      setConnected(false);
      setSettled(true);
      if (stableTimer) clearTimeout(stableTimer);

      // Every other reason is a transport problem, and the library is
      // already reconnecting with backoff.
      if (reason !== 'io server disconnect') return;
      if (kicks >= KICK_RETRY_DELAYS_MS.length) return;

      const delay = KICK_RETRY_DELAYS_MS[kicks];
      kicks += 1;

      kickTimer = setTimeout(() => {
        void (async () => {
          if (disposed) return;
          try {
            // Any authenticated request does: a 401 on it is what makes the
            // client refresh the token pair. The answer itself is not used.
            await client.get('/auth/me');
          } catch {
            // Offline, or the session is genuinely over. The check below
            // tells the two apart.
          }
          // Signed out (refresh failed, or the account was suspended): the
          // client has cleared its tokens and there is nothing to connect as.
          if (disposed || !client.hasSession()) return;
          socket.connect();
        })();
      }, delay);
    });

    socket.on(wsEvents.TASK_OFFER, (offer: TaskOffer) => {
      if (new Date(offer.expiresAt).getTime() <= Date.now()) return;
      handlersRef.current.onOffer?.(offer);
    });
    socket.on(wsEvents.TASK_OFFER_WITHDRAWN, (p) => handlersRef.current.onOfferWithdrawn?.(p));
    socket.on(wsEvents.TASK_STATUS_CHANGED, (p) => handlersRef.current.onTaskStatus?.(p));
    socket.on(wsEvents.ORDER_STATUS_CHANGED, (p) => handlersRef.current.onOrderStatus?.(p));
    socket.on(wsEvents.HANDOVER_CODE_ISSUED, (p) => handlersRef.current.onHandoverCode?.(p));

    return () => {
      disposed = true;
      if (kickTimer) clearTimeout(kickTimer);
      if (stableTimer) clearTimeout(stableTimer);
      socket.removeAllListeners();
      socket.disconnect();
      setSocket(null);
      setConnected(false);
      setSettled(false);
    };
  }, [client, enabled]);

  return { connected, settled, socket };
}

/** FR-WM-03: report position over the open socket rather than as a request. */
export function sendPing(socket: Socket | null, latitude: number, longitude: number): boolean {
  if (!socket?.connected) return false;
  socket.emit(wsEvents.RIDER_PING, { latitude, longitude });
  return true;
}
