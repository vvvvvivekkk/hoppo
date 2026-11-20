import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { wsEvents } from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { AccessTokenPayload } from '../common/types/authenticated-user';
import {
  SHOP_NOT_APPROVED_CODE,
  SHOP_NOT_APPROVED_MESSAGE,
  ShopAccessService,
  isShopRole,
} from '../common/access/shop-access.service';

/** L9: pings arriving faster than this, per socket, are ignored. */
const MIN_PING_GAP_MS = 2_000;

interface SocketUser {
  userId: string;
  collegeId: string | null;
  role: string;
}

/**
 * The real-time channel: task dispatch and chat on one connection (CI-2).
 *
 * Three design points worth stating:
 *
 * **Rooms, not socket lists.** Each connection joins `user:<id>` and
 * `college:<id>`. Addressing a message to a room means the Redis adapter
 * routes it to whichever API instance holds that socket, so a broadcast works
 * the same with one instance or ten. Keeping a map of sockets in memory would
 * work until the second instance started.
 *
 * **Authentication happens at connect.** A socket with no valid token is
 * disconnected immediately rather than being allowed to linger and send
 * events. The token is the same access token the REST API uses.
 *
 * **The gateway never decides anything.** It carries messages. Assignment,
 * state transitions and eligibility all live in DispatchService, so there is
 * one implementation of each rule rather than one per transport.
 *
 * Cross-instance fan-out is handled by RedisIoAdapter, attached in main.ts —
 * it has to be set on the Socket.IO server before any namespace exists, which
 * a gateway cannot do to itself.
 */
@WebSocketGateway({
  namespace: '/rt',
  cors: { origin: true, credentials: true },
  // NFR-R-05: clients reconnect with backoff and resynchronise. A generous
  // disconnect timeout avoids tearing down a session when a phone switches
  // from campus Wi-Fi to 4G mid-delivery.
  pingInterval: 25_000,
  pingTimeout: 20_000,
})
export class DispatchGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(DispatchGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly shopAccess: ShopAccessService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.headers.authorization as string | undefined)?.replace(/^Bearer /, '');

    if (!token) {
      this.logger.debug('Socket rejected: no token');
      client.disconnect(true);
      return;
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      this.logger.debug('Socket rejected: invalid token');
      client.disconnect(true);
      return;
    }

    // Same reasoning as the HTTP strategy: a signed token does not prove the
    // account is still in good standing, and FR-SVER-08 requires suspension
    // to take effect immediately.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        collegeId: true,
        role: true,
        status: true,
        college: { select: { status: true } },
      },
    });

    if (!user || user.status !== 'ACTIVE') {
      this.logger.debug(`Socket rejected: account ${payload.sub} is not active`);
      client.disconnect(true);
      return;
    }

    // FR-ADM-07: a deactivated tenant's users are locked out at once. Their
    // own accounts are still ACTIVE and their tokens still valid, so the user
    // status above says nothing — HTTP refuses them in the JWT strategy
    // (COLLEGE_INACTIVE), and until this check the socket did not: they
    // could connect, sit in their college's room, and go on receiving offers
    // and chat from a college that had been switched off. Read from the
    // database at connect, never from the token. A super administrator has
    // no college and is unaffected.
    //
    // This closes new connections. Sockets already open when a college is
    // deactivated are closed by whoever deactivates it, through
    // `disconnectUser`.
    if (user.college?.status === 'INACTIVE') {
      this.logger.debug(`Socket rejected: ${user.id}'s college is inactive`);
      // The same code the HTTP API answers with, said before the door closes.
      client.emit('exception', {
        code: 'COLLEGE_INACTIVE',
        message: 'This college is not currently active on Hoppo.',
      });
      client.disconnect(true);
      return;
    }

    // A shop account is ACTIVE from the moment the public registration form
    // is submitted, long before an administrator approves the shop. HTTP
    // refuses such an account everything but its own registration status
    // (ShopApprovalGuard); without the same rule here it could open this
    // channel and sit in `user:<id>` and the college room of whichever
    // college it named on the form. Answered by the same ShopAccessService
    // the HTTP side uses, so the two cannot drift apart.
    //
    // Checked at connect only. Nothing un-approves a shop account today
    // (a SUSPENDED listing still counts as approved), so there is no path
    // that needs an open socket re-checked.
    if (isShopRole(user.role) && !(await this.shopAccess.hasApprovedShop(user.id))) {
      this.logger.debug(`Socket rejected: shop account ${user.id} has no approved shop`);
      // Said before the door closes, so the dashboard can show "awaiting
      // approval" rather than a bare disconnect it would retry forever.
      // `exception` is the event Nest's own WebSocket error filter uses.
      client.emit('exception', {
        code: SHOP_NOT_APPROVED_CODE,
        message: SHOP_NOT_APPROVED_MESSAGE,
      });
      client.disconnect(true);
      return;
    }

    const socketUser: SocketUser = {
      userId: user.id,
      collegeId: user.collegeId,
      role: user.role,
    };
    client.data.user = socketUser;

    await client.join(`user:${user.id}`);
    if (user.collegeId) {
      // C-1 holds here too: a socket only ever joins its own college's room,
      // so a college-wide message cannot reach another tenant.
      await client.join(`college:${user.collegeId}`);
    }

    this.logger.debug(`Socket connected: ${user.id} (${user.role})`);
  }

  handleDisconnect(client: Socket): void {
    const user = client.data.user as SocketUser | undefined;
    if (user) this.logger.debug(`Socket disconnected: ${user.userId}`);
  }

  // =======================================================================
  // Inbound
  // =======================================================================

  /**
   * FR-WM-03: the rider's device reports its position at a configurable
   * interval.
   *
   * Over the socket rather than as an HTTP request because it happens every
   * fifteen seconds per online rider, and the connection is already open.
   * It writes to Redis only — see ADR-002 — with the database row updated far
   * less often, for audit.
   */
  @SubscribeMessage(wsEvents.RIDER_PING)
  async handleRiderPing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { latitude: number; longitude: number },
  ): Promise<{ ok: boolean; reason?: string }> {
    const user = client.data.user as SocketUser | undefined;
    if (!user?.collegeId) return { ok: false, reason: 'NOT_AUTHENTICATED' };

    // L9: this handler is reachable by any authenticated socket, and what it
    // writes feeds the proximity query. `Number.isFinite` alone let through
    // latitude 9000, which GEOADD rejects with an error that surfaced as an
    // unhandled exception — and a string or NaN would have poisoned the audit
    // columns. The bounds are the same ones the database CHECKs elsewhere.
    if (
      typeof body?.latitude !== 'number' ||
      typeof body?.longitude !== 'number' ||
      !Number.isFinite(body.latitude) ||
      !Number.isFinite(body.longitude) ||
      body.latitude < -90 ||
      body.latitude > 90 ||
      body.longitude < -180 ||
      body.longitude > 180
    ) {
      return { ok: false, reason: 'INVALID_POSITION' };
    }

    // Each accepted ping costs two database reads, a database write and a
    // Redis transaction. The configured interval is fifteen seconds, so
    // anything faster than one per two seconds is a bug or abuse; it is
    // dropped before it touches either store. Kept on the socket rather than
    // in Redis because the point is to make a flood free to ignore.
    const nowMs = Date.now();
    const lastAcceptedMs = client.data.lastPingAcceptedMs as number | undefined;
    if (lastAcceptedMs !== undefined && nowMs - lastAcceptedMs < MIN_PING_GAP_MS) {
      return { ok: false, reason: 'TOO_FREQUENT' };
    }
    client.data.lastPingAcceptedMs = nowMs;

    const state = await this.prisma.riderState.findUnique({
      where: { userId: user.userId },
      select: { workModeOn: true },
    });

    if (!state?.workModeOn) return { ok: false, reason: 'WORK_MODE_OFF' };

    const config = await this.prisma.collegeConfig.findUnique({
      where: { collegeId: user.collegeId },
      select: { riderPingIntervalSeconds: true },
    });

    const intervalSeconds = config?.riderPingIntervalSeconds ?? 15;

    await this.redis.setRiderPosition({
      collegeId: user.collegeId,
      userId: user.userId,
      latitude: body.latitude,
      longitude: body.longitude,
      // Three missed pings before the position is considered stale.
      ttlSeconds: intervalSeconds * 3,
    });

    // The database copy is for audit and the admin console, not for the
    // proximity query, so it is written on the same tick but can afford to be
    // a plain update rather than anything clever.
    await this.prisma.riderState.update({
      where: { userId: user.userId },
      data: {
        lastLatitude: body.latitude,
        lastLongitude: body.longitude,
        lastPingAt: new Date(),
      },
    });

    return { ok: true };
  }

  // =======================================================================
  // Outbound
  // =======================================================================

  /**
   * FR-DLV-03: to every eligible rider at once.
   *
   * The payload is passed through untouched — every field the dispatcher
   * builds reaches the rider, including the cash amounts they must front.
   */
  sendOffer(riderIds: string[], offer: Record<string, unknown>): void {
    if (riderIds.length === 0) return;

    for (const riderId of riderIds) {
      this.server?.to(`user:${riderId}`).emit(wsEvents.TASK_OFFER, offer);
    }
  }

  /**
   * FR-DLV-05: withdraw the offer from the riders who were shown it.
   *
   * M7: this used to go to the whole `college:<id>` room with the winner's
   * user id in it, so every connected account in the college — students
   * browsing shops, shop staff — learned which rider took which task. Now it
   * goes only to the riders who were offered the task, and nobody is told
   * who won: the winner's copy carries their own id and everyone else's
   * carries null. `winnerUserId !== myId` therefore still means "too slow"
   * on a client written against the old payload.
   *
   * `offeredRiderIds` is null when the offered set could not be read (Redis
   * down). The withdrawal still has to reach the losers' screens, so that one
   * case falls back to the college room — carrying a task id and nothing
   * about any person.
   */
  withdrawOffer(
    collegeId: string,
    taskId: string,
    winnerUserId: string,
    offeredRiderIds: string[] | null,
  ): void {
    this.server
      ?.to(`user:${winnerUserId}`)
      .emit(wsEvents.TASK_OFFER_WITHDRAWN, { taskId, winnerUserId, won: true });

    const lost = { taskId, winnerUserId: null, won: false };

    if (offeredRiderIds === null) {
      this.server
        ?.to(`college:${collegeId}`)
        .except(`user:${winnerUserId}`)
        .emit(wsEvents.TASK_OFFER_WITHDRAWN, lost);
      return;
    }

    for (const riderId of offeredRiderIds) {
      if (riderId === winnerUserId) continue;
      this.server?.to(`user:${riderId}`).emit(wsEvents.TASK_OFFER_WITHDRAWN, lost);
    }
  }

  /**
   * A task changed state — told to the people the task belongs to.
   *
   * M7: addressed to `user:<id>` rooms, never the college room. The payload
   * names the rider and can carry an escalation reason; neither is the
   * business of every account in the college. The caller supplies the
   * audience (requester, rider, shop staff) because the gateway decides
   * nothing and looks nothing up.
   */
  notifyTaskStatus(
    recipientUserIds: readonly string[],
    taskId: string,
    status: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.emitToUsers(recipientUserIds, wsEvents.TASK_STATUS_CHANGED, {
      taskId,
      status,
      ...extra,
    });
  }

  /** As notifyTaskStatus: the student, the shop's staff, and the rider if any. */
  notifyOrderStatus(
    recipientUserIds: readonly string[],
    orderId: string,
    status: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.emitToUsers(recipientUserIds, wsEvents.ORDER_STATUS_CHANGED, {
      orderId,
      status,
      ...extra,
    });
  }

  /**
   * One emit to several user rooms. Socket.IO takes the union of the rooms,
   * so a user who is both requester and shop staff gets the event once per
   * socket rather than once per role.
   */
  private emitToUsers(
    userIds: readonly string[],
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const rooms = [...new Set(userIds)].filter(Boolean).map((id) => `user:${id}`);
    if (rooms.length === 0) return;
    this.server?.to(rooms).emit(event, payload);
  }

  /**
   * FR-SVER-08: suspension terminates active sessions immediately.
   *
   * Authentication happens once, at connect, so a socket opened before the
   * suspension would otherwise keep receiving offers and chat until the
   * phone happened to reconnect. Addressed by room, so the Redis adapter
   * closes the sockets on whichever instance holds them.
   */
  disconnectUser(userId: string): void {
    this.server?.in(`user:${userId}`).disconnectSockets(true);
  }

  /** FR-SHP-01: the shop dashboard's audible alert. */
  notifyShopIncomingOrder(staffUserIds: string[], order: Record<string, unknown>): void {
    for (const userId of staffUserIds) {
      this.server?.to(`user:${userId}`).emit(wsEvents.ORDER_INCOMING, order);
    }
  }

  /**
   * FR-DLV-12: the handover code, to the requester's device only.
   *
   * Addressed to `user:<requesterId>` rather than the college room, because
   * a code broadcast to the college would let any rider complete any
   * delivery — which is the one thing the code exists to prevent.
   */
  sendHandoverCode(
    requesterUserId: string,
    payload: { taskId: string; code: string; orderReference: string | null },
  ): void {
    this.server?.to(`user:${requesterUserId}`).emit(wsEvents.HANDOVER_CODE_ISSUED, payload);
  }

  /** FR-WM-06 */
  notifyWorkModeDisabled(userId: string, afterMinutes: number): void {
    this.server?.to(`user:${userId}`).emit(wsEvents.TASK_STATUS_CHANGED, {
      type: 'WORK_MODE_DISABLED',
      reason: 'IDLE_TIMEOUT',
      afterMinutes,
    });
  }

  /** How many sockets a user has open. Used by tests and the admin console. */
  async socketCountForUser(userId: string): Promise<number> {
    const sockets = await this.server?.in(`user:${userId}`).fetchSockets();
    return sockets?.length ?? 0;
  }
}
