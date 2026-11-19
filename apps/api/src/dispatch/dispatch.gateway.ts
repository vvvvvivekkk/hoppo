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
      select: { id: true, collegeId: true, role: true, status: true },
    });

    if (!user || user.status !== 'ACTIVE') {
      this.logger.debug(`Socket rejected: account ${payload.sub} is not active`);
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

    if (
      typeof body?.latitude !== 'number' ||
      typeof body?.longitude !== 'number' ||
      !Number.isFinite(body.latitude) ||
      !Number.isFinite(body.longitude)
    ) {
      return { ok: false, reason: 'INVALID_POSITION' };
    }

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

  /** FR-DLV-03: to every eligible rider at once. */
  sendOffer(collegeId: string, riderIds: string[], offer: Record<string, unknown>): void {
    if (riderIds.length === 0) return;

    for (const riderId of riderIds) {
      this.server?.to(`user:${riderId}`).emit(wsEvents.TASK_OFFER, offer);
    }
  }

  /** FR-DLV-05: withdraw from everyone except the winner. */
  withdrawOffer(collegeId: string, taskId: string, winnerUserId: string): void {
    this.server?.to(`college:${collegeId}`).emit(wsEvents.TASK_OFFER_WITHDRAWN, {
      taskId,
      // The winner's client uses this to tell "you got it" from "too slow".
      winnerUserId,
    });
  }

  notifyTaskStatus(
    collegeId: string,
    taskId: string,
    status: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.server?.to(`college:${collegeId}`).emit(wsEvents.TASK_STATUS_CHANGED, {
      taskId,
      status,
      ...extra,
    });
  }

  notifyOrderStatus(
    collegeId: string,
    orderId: string,
    status: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.server?.to(`college:${collegeId}`).emit(wsEvents.ORDER_STATUS_CHANGED, {
      orderId,
      status,
      ...extra,
    });
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
