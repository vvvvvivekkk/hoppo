import { io, type Socket } from 'socket.io-client';
import { wsEvents } from '@hoppo/shared';
import type { TaskOffer } from '@hoppo/api-client';

/**
 * The realtime connection (CI-2).
 *
 * This is how a task offer reaches a rider inside the three seconds NFR-P-02
 * asks for. Polling could not do it: FR-DLV-03 gives a rider a 60-second
 * window to accept, and a poll frequent enough to be useful would mean every
 * online rider hitting the API every few seconds all day.
 *
 * Two behaviours worth stating:
 *
 *  - **Reconnection is automatic with backoff** (NFR-R-05). A phone moving
 *    between campus Wi-Fi and 4G drops the socket regularly, and a rider
 *    mid-delivery must not have to restart the app.
 *  - **An offer that arrives after its expiry is dropped.** A reconnect can
 *    deliver a queued offer whose window has already closed, and showing a
 *    countdown that is already at zero just invites a tap that fails.
 */
export interface SocketHandlers {
  onOffer?: (offer: TaskOffer) => void;
  onOfferWithdrawn?: (payload: { taskId: string; winnerUserId: string }) => void;
  onTaskStatus?: (payload: { taskId: string; status: string } & Record<string, unknown>) => void;
  onOrderStatus?: (payload: { orderId: string; status: string } & Record<string, unknown>) => void;
  /** FR-DLV-12: the handover code, to the requester's device only. */
  onHandoverCode?: (payload: { taskId: string; code: string; orderReference: string | null }) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export function connectSocket(
  apiBaseUrl: string,
  accessToken: string,
  handlers: SocketHandlers,
): Socket {
  // The gateway lives on the /rt namespace, and the base URL includes the
  // REST prefix, which has to come off.
  const origin = apiBaseUrl.replace(/\/api\/v1\/?$/, '');

  const socket = io(`${origin}/rt`, {
    auth: { token: accessToken },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10_000,
  });

  socket.on('connect', () => handlers.onConnectionChange?.(true));
  socket.on('disconnect', () => handlers.onConnectionChange?.(false));
  socket.on('connect_error', () => handlers.onConnectionChange?.(false));

  socket.on(wsEvents.TASK_OFFER, (offer: TaskOffer) => {
    // Drop an offer whose window has already closed — a reconnect can deliver
    // a stale one, and a countdown starting at zero is worse than nothing.
    if (new Date(offer.expiresAt).getTime() <= Date.now()) return;
    handlers.onOffer?.(offer);
  });

  socket.on(wsEvents.TASK_OFFER_WITHDRAWN, (payload) => handlers.onOfferWithdrawn?.(payload));
  socket.on(wsEvents.TASK_STATUS_CHANGED, (payload) => handlers.onTaskStatus?.(payload));
  socket.on(wsEvents.ORDER_STATUS_CHANGED, (payload) => handlers.onOrderStatus?.(payload));
  socket.on(wsEvents.HANDOVER_CODE_ISSUED, (payload) => handlers.onHandoverCode?.(payload));

  return socket;
}

/** FR-WM-03: report position over the open socket rather than as a request. */
export function sendPing(socket: Socket, latitude: number, longitude: number): void {
  socket.emit(wsEvents.RIDER_PING, { latitude, longitude });
}
