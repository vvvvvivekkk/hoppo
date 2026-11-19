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
 * Four behaviours, each there for a reason found while building the parked
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
 *  - **Handlers are read through a ref.** A screen that re-renders every
 *    second (every countdown does) would otherwise tear down and rebuild the
 *    socket on each tick.
 */
export interface SocketHandlers {
  onOffer?: (offer: TaskOffer) => void;
  onOfferWithdrawn?: (payload: { taskId: string; winnerUserId: string }) => void;
  onTaskStatus?: (payload: { taskId: string; status: string } & Record<string, unknown>) => void;
  onOrderStatus?: (payload: { orderId: string; status: string } & Record<string, unknown>) => void;
  /** FR-DLV-12: the handover code, to the requester's device only. */
  onHandoverCode?: (payload: {
    taskId: string;
    code: string;
    orderReference: string | null;
  }) => void;
}

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
 */
export function useSocket(
  client: ApiClient,
  enabled: boolean,
  handlers: SocketHandlers,
): { connected: boolean; socket: Socket | null } {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }

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

    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    socket.on(wsEvents.TASK_OFFER, (offer: TaskOffer) => {
      if (new Date(offer.expiresAt).getTime() <= Date.now()) return;
      handlersRef.current.onOffer?.(offer);
    });
    socket.on(wsEvents.TASK_OFFER_WITHDRAWN, (p) => handlersRef.current.onOfferWithdrawn?.(p));
    socket.on(wsEvents.TASK_STATUS_CHANGED, (p) => handlersRef.current.onTaskStatus?.(p));
    socket.on(wsEvents.ORDER_STATUS_CHANGED, (p) => handlersRef.current.onOrderStatus?.(p));
    socket.on(wsEvents.HANDOVER_CODE_ISSUED, (p) => handlersRef.current.onHandoverCode?.(p));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [client, enabled]);

  return { connected, socket: socketRef.current };
}

/** FR-WM-03: report position over the open socket rather than as a request. */
export function sendPing(socket: Socket | null, latitude: number, longitude: number): boolean {
  if (!socket?.connected) return false;
  socket.emit(wsEvents.RIDER_PING, { latitude, longitude });
  return true;
}
