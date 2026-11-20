import { HttpException, Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { wsEvents } from '@hoppo/shared';
import type { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ChatService } from './chat.service';

/** Messages a socket may send in any ten seconds. Matches the REST limit of 60 a minute. */
const MAX_MESSAGES_PER_WINDOW = 10;
const WINDOW_MS = 10_000;

interface SocketUser {
  userId: string;
  collegeId: string | null;
  role: string;
}

type SendAck =
  | { ok: true; message: unknown; duplicate: boolean }
  | { ok: false; code: string; message: string };

/**
 * Chat over the real-time channel: the inbound half.
 *
 * The same `/rt` namespace as dispatch — "dispatch and chat on one
 * connection" (CI-2) — so a phone holds one socket, and the connection is
 * authenticated once, by DispatchGateway.handleConnection, which leaves the
 * user on `client.data.user`. This gateway adds one inbound event to that
 * connection and nothing else. Outbound messages go through
 * DispatchGateway.sendChatMessage, to `user:<id>` rooms.
 *
 * It decides nothing. What the socket knew at connect is who is *calling*;
 * whether that person may speak in this conversation is ChatService's
 * question, put to the database for every single message. A socket is not
 * trusted to still be a party because it was one a minute ago.
 */
@WebSocketGateway({ namespace: '/rt', cors: { origin: true, credentials: true } })
export class ChatGateway {
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chat: ChatService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Client -> server: `message:new` with
   * `{ taskId | orderId, body, clientMessageId }`, acknowledged with the
   * stored message or a refusal. The server's own `message:new` to both
   * parties follows (the sender's included, for their other devices).
   */
  @SubscribeMessage(wsEvents.MESSAGE_NEW)
  async handleSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { taskId?: unknown; orderId?: unknown; body?: unknown; clientMessageId?: unknown },
  ): Promise<SendAck> {
    const socketUser = client.data.user as SocketUser | undefined;
    if (!socketUser) {
      return { ok: false, code: 'NOT_AUTHENTICATED', message: 'This connection is not signed in.' };
    }

    // A flood is dropped before it costs a query.
    const now = Date.now();
    const recent = ((client.data.chatSentAt as number[] | undefined) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_MESSAGES_PER_WINDOW) {
      client.data.chatSentAt = recent;
      return { ok: false, code: 'TOO_MANY_MESSAGES', message: 'You are sending messages too quickly.' };
    }
    client.data.chatSentAt = [...recent, now];

    try {
      const user = await this.currentUser(socketUser.userId);

      const taskId =
        typeof payload?.taskId === 'string'
          ? payload.taskId
          : typeof payload?.orderId === 'string'
            ? await this.chat.taskIdForOrder(user, payload.orderId)
            : null;

      if (!taskId) {
        return { ok: false, code: 'INVALID_MESSAGE', message: 'Say which delivery: taskId or orderId.' };
      }

      const result = await this.chat.send(user, taskId, {
        body: payload.body,
        clientMessageId: payload.clientMessageId,
      });
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) {
        const response = error.getResponse();
        const detail = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {};
        return {
          ok: false,
          code: typeof detail.code === 'string' ? detail.code : `HTTP_${error.getStatus()}`,
          message: typeof detail.message === 'string' ? detail.message : error.message,
        };
      }
      this.logger.error('Chat send failed', error instanceof Error ? error.stack : String(error));
      return { ok: false, code: 'INTERNAL_ERROR', message: 'The message could not be sent.' };
    }
  }

  /**
   * The caller as the database knows them *now*.
   *
   * The socket was authenticated when it connected, which may have been
   * hours ago. The HTTP routes get this for free — the JWT strategy re-reads
   * the user on every request — and a message over the socket must not be
   * held to a lower standard than the same message over REST: a suspended
   * account, a deactivated college, an unverified or non-student account are
   * all refused here, per message.
   */
  private async currentUser(userId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        collegeId: true,
        role: true,
        status: true,
        college: { select: { status: true } },
        studentProfile: { select: { verificationStatus: true } },
      },
    });

    const refusal = (code: string, message: string) => new SocketRefusal(code, message);

    if (!user || user.status !== 'ACTIVE') throw refusal('ACCOUNT_NOT_ACTIVE', 'This account is not active.');
    if (user.college?.status === 'INACTIVE') {
      throw refusal('COLLEGE_INACTIVE', 'This college is not currently active on Hoppo.');
    }
    if (user.role !== 'STUDENT') {
      throw refusal('NOT_A_PARTY', 'Only the two people on a delivery can use its chat.');
    }
    if (user.studentProfile?.verificationStatus !== 'VERIFIED') {
      throw refusal('VERIFICATION_REQUIRED', 'Your student verification is not yet approved.');
    }

    return {
      userId: user.id,
      collegeId: user.collegeId,
      role: user.role as UserRole,
      isVerified: true,
    };
  }
}

/** A refusal with a code, shaped like the API's HTTP errors so one catch handles both. */
class SocketRefusal extends HttpException {
  constructor(code: string, message: string) {
    super({ code, message }, 403);
  }
}
