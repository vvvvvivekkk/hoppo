import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../common/tenant/tenant.service';
import { DispatchGateway } from '../dispatch/dispatch.gateway';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { MAX_CHAT_BODY_LENGTH, MAX_CLIENT_MESSAGE_ID_LENGTH } from './dto/chat.dto';

/**
 * The task statuses in which a delivery's chat accepts messages.
 *
 * FR-CHAT-08: "Task rooms shall be archived on task completion and shall not
 * accept new messages." So: from the moment a rider is assigned, until the
 * task ends. ESCALATED is included on purpose — the delivery has not been
 * completed, it has stalled at the door, and that is exactly when the two
 * people most need to reach each other. Before assignment there is no rider
 * to talk to; after COMPLETED or CANCELLED the room is read-only.
 */
const WRITABLE_TASK_STATUSES: readonly TaskStatus[] = ['ASSIGNED', 'PICKED_UP', 'ESCALATED'];

/** Who a party is, in a delivery's conversation. */
export type ChatRole = 'REQUESTER' | 'RIDER';

/**
 * Whether the shop's staff take part in a delivery's chat.
 *
 * FR-DLV-10 says the task room contains "the requester and the rider, and
 * additionally the shop for SHOP_ORDER tasks", and dispatch does add the
 * shop's staff as members of the room. This release nevertheless opens the
 * conversation to the requester and the rider only — screens S-19, S-28 and
 * S-30 are the student's and the rider's, the shop dashboard has no chat
 * screen yet, and letting more people read a private conversation is not a
 * thing to do by default. Raised for a decision in A2-DECISION-chat.md.
 * Turning this on is the whole of the change on the server.
 */
export const SHOP_TAKES_PART_IN_TASK_CHAT = false;

export type ChatState =
  /** No rider has accepted yet, so there is nobody to talk to. */
  | 'NOT_OPEN'
  /** A delivery is in progress: messages are accepted. */
  | 'OPEN'
  /** The delivery is over (FR-CHAT-08): history stays readable, nothing new. */
  | 'ARCHIVED';

const TASK_SELECT = {
  id: true,
  collegeId: true,
  status: true,
  requesterId: true,
  riderId: true,
  orderId: true,
  requester: { select: { id: true, name: true } },
  rider: { select: { id: true, name: true } },
  chatRoom: { select: { id: true, isArchived: true, archivedAt: true } },
} as const;

/**
 * Chat between the two people on a delivery (FR-DLV-10, FR-CHAT-04,
 * FR-CHAT-08; screens S-19, S-28, S-30).
 *
 * One rule runs through all of it: **who may read or write is asked of the
 * database on every call.** A socket that was a party to a task when it
 * connected is not thereby a party now — a rider can abandon, be suspended,
 * or simply have been somebody else's rider all along — so nothing about
 * membership is remembered between messages or taken from what the client
 * says. `authorise` is that question, and every public method starts with it.
 *
 * The room itself, and who is in it, are dispatch's: it creates the room
 * when a rider accepts, and marks a rider who abandons as having left. This
 * service never adds anyone to a room.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly gateway: DispatchGateway,
  ) {}

  // =======================================================================
  // Finding the conversation
  // =======================================================================

  /** The task that carries an order — the student's screens know the order. */
  async taskIdForOrder(user: AuthenticatedUser, orderId: string): Promise<string> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { collegeId: true, task: { select: { id: true } } },
    });

    this.tenant.assertSameTenant(user, order, 'Order');

    if (!order!.task) {
      throw new ConflictException({
        code: 'CHAT_NOT_OPEN',
        message: 'There is no delivery for this order to chat about.',
      });
    }
    return order!.task.id;
  }

  // =======================================================================
  // Who is asking
  // =======================================================================

  /**
   * Is this user, right now, a party to this task's conversation?
   *
   * Read from the database, every time:
   *  - the task is in the caller's college (C-1);
   *  - the caller is the task's requester, or the rider it is assigned to
   *    *now* — not one who held it earlier;
   *  - once a room exists, the caller is a member of it who has not left.
   *    (Dispatch keeps that list; this is a second lock on the same door,
   *    so that a mistake in either one alone does not open it.)
   */
  private async authorise(user: AuthenticatedUser, taskId: string) {
    const row = await this.prisma.task.findUnique({ where: { id: taskId }, select: TASK_SELECT });
    const task = this.tenant.assertSameTenant(user, row, 'Task');

    const role: ChatRole | null =
      task.requesterId === user.userId ? 'REQUESTER' : task.riderId === user.userId ? 'RIDER' : null;

    if (role === null) throw this.notAParty();

    if (task.chatRoom) {
      const membership = await this.prisma.chatMember.findFirst({
        where: { roomId: task.chatRoom.id, userId: user.userId, leftAt: null },
        select: { userId: true },
      });
      if (!membership) throw this.notAParty();
    }

    return { task, role };
  }

  private stateOf(task: { status: string; chatRoom: { isArchived: boolean } | null }): ChatState {
    if (!task.chatRoom) return 'NOT_OPEN';
    if (task.chatRoom.isArchived || !WRITABLE_TASK_STATUSES.includes(task.status as TaskStatus)) {
      return 'ARCHIVED';
    }
    return 'OPEN';
  }

  /** The two people in the conversation, as the screens need to show them. */
  private describe(task: AuthorisedTask, role: ChatRole) {
    const state = this.stateOf(task);
    return {
      taskId: task.id,
      orderId: task.orderId,
      roomId: task.chatRoom?.id ?? null,
      state,
      canSend: state === 'OPEN',
      // Read access outlives the delivery (FR-CHAT-08: "the parties shall
      // retain read access"). The SRS configures no retention period, so
      // none is applied — see A2-DECISION-chat.md.
      archivedAt: task.chatRoom?.archivedAt ?? null,
      you: role,
      participants: [
        { userId: task.requester.id, name: task.requester.name, role: 'REQUESTER' as ChatRole },
        ...(task.rider
          ? [{ userId: task.rider.id, name: task.rider.name, role: 'RIDER' as ChatRole }]
          : []),
      ],
    };
  }

  // =======================================================================
  // Reading
  // =======================================================================

  /**
   * A page of the conversation, newest first.
   *
   * Paged backwards from `before` (a message id) because a chat screen opens
   * on the latest messages and loads older ones as it is scrolled up.
   */
  async history(user: AuthenticatedUser, taskId: string, limit = 50, before?: string) {
    const { task, role } = await this.authorise(user, taskId);
    const room = this.describe(task, role);

    if (!task.chatRoom) return { room, messages: [], nextCursor: null };

    if (before) {
      // The cursor must be a message of *this* room. Prisma would otherwise
      // start from wherever a foreign id happens to sort, and a 400 is more
      // use to a client than a page from the wrong place.
      const anchor = await this.prisma.message.findFirst({
        where: { id: before, roomId: task.chatRoom.id },
        select: { id: true },
      });
      if (!anchor) {
        throw new BadRequestException({
          code: 'INVALID_CURSOR',
          message: '`before` is not a message in this conversation.',
        });
      }
    }

    const rows = await this.prisma.message.findMany({
      where: { roomId: task.chatRoom.id },
      // `id` breaks a tie between two messages in the same millisecond, so
      // a page boundary that falls between them is stable.
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      select: MESSAGE_SELECT,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      room,
      messages: page.map((message) => this.present(message, task)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  // =======================================================================
  // Writing
  // =======================================================================

  /**
   * Send a message. Used by the REST route and by the socket handler alike,
   * so there is one implementation of every rule.
   */
  async send(user: AuthenticatedUser, taskId: string, input: { body: unknown; clientMessageId: unknown }) {
    // Validated here rather than only in the DTO: the socket has no
    // validation pipe in front of it.
    const { body, clientMessageId } = this.validate(input);

    const { task, role } = await this.authorise(user, taskId);

    if (!task.chatRoom) {
      throw new ConflictException({
        code: 'CHAT_NOT_OPEN',
        message: 'Chat opens when a rider accepts this delivery.',
      });
    }
    // A readable answer for the usual case. Not the guard — the conditional
    // UPDATE below is.
    if (this.stateOf(task) !== 'OPEN') throw this.archived();

    const roomId = task.chatRoom.id;
    const now = new Date();

    const { message, created } = await this.prisma.$transaction(async (tx) => {
      /**
       * ADR-001: one conditional UPDATE decides whether the room still takes
       * messages, and it is the first write.
       *
       * Completion, abandonment, suspension and an administrator's
       * resolution all archive the room with an UPDATE of this same row. So
       * either this statement runs first — and the message belongs to a
       * conversation that was open — or the archive does, this matches no
       * row, and nothing is stored. A check of `is_archived` followed by an
       * insert would let a message land in a room archived in between.
       */
      const open = await tx.chatRoom.updateMany({
        where: {
          id: roomId,
          isArchived: false,
          task: { id: taskId, status: { in: [...WRITABLE_TASK_STATUSES] } },
        },
        data: { lastMessageAt: now },
      });
      if (open.count !== 1) throw this.archived();

      /**
       * FR-CHAT-04: stored once however often it is sent.
       *
       * `(sender_id, client_message_id)` is unique, and this is INSERT … ON
       * CONFLICT DO NOTHING on it. A retry after a timeout, a message queued
       * offline and flushed twice on reconnect, the REST call and the socket
       * racing each other: the first insert writes the row, the rest write
       * nothing, and all of them go on to read back the same row. No "does
       * it exist?" read comes first, so there is nothing to race.
       */
      const inserted = await tx.message.createMany({
        data: [{ roomId, senderId: user.userId, body, clientMessageId, sentAt: now }],
        skipDuplicates: true,
      });

      const stored = await tx.message.findUniqueOrThrow({
        where: { senderId_clientMessageId: { senderId: user.userId, clientMessageId } },
        select: { ...MESSAGE_SELECT, roomId: true },
      });

      // The id was used before, for a message in another conversation. That
      // is a client bug, and answering with a message from a different room
      // would be worse than refusing.
      if (stored.roomId !== roomId) {
        throw new ConflictException({
          code: 'CLIENT_MESSAGE_ID_REUSED',
          message: 'That clientMessageId was already used for a message in another conversation.',
        });
      }

      return { message: stored, created: inserted.count === 1 };
    });

    const presented = this.present(message, task);

    // Only a message that was actually stored now is announced: a retry must
    // not make the other person's phone buzz twice. To both parties' own
    // rooms (the sender's other devices included), and nobody else's.
    if (created) {
      this.gateway.sendChatMessage(this.recipients(task), {
        ...presented,
        taskId: task.id,
        orderId: task.orderId,
        roomId,
      });
    }

    this.logger.debug(`Chat message ${message.id} on task ${taskId} by ${role}${created ? '' : ' (duplicate)'}`);

    return { message: presented, duplicate: !created };
  }

  // =======================================================================
  // Shapes, rules and refusals
  // =======================================================================

  private recipients(task: AuthorisedTask): string[] {
    return [task.requesterId, ...(task.riderId ? [task.riderId] : [])];
  }

  private present(message: StoredMessage, task: AuthorisedTask) {
    const deleted = message.deletedAt != null;
    return {
      id: message.id,
      senderId: message.senderId,
      senderRole: (message.senderId === task.requesterId ? 'REQUESTER' : 'RIDER') as ChatRole,
      // A deleted message keeps its place in the conversation and loses its
      // words (account deletion scrubs bodies — FR-PRIV-05).
      body: deleted ? null : message.body,
      deleted,
      clientMessageId: message.clientMessageId,
      sentAt: message.sentAt,
    };
  }

  private validate(input: { body: unknown; clientMessageId: unknown }) {
    const body = typeof input?.body === 'string' ? input.body.trim() : '';
    const clientMessageId = typeof input?.clientMessageId === 'string' ? input.clientMessageId : '';

    if (body.length < 1 || body.length > MAX_CHAT_BODY_LENGTH) {
      throw new BadRequestException({
        code: 'INVALID_MESSAGE',
        message: `A message must be between 1 and ${MAX_CHAT_BODY_LENGTH} characters.`,
      });
    }
    if (
      clientMessageId.length < 8 ||
      clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(clientMessageId)
    ) {
      throw new BadRequestException({
        code: 'INVALID_CLIENT_MESSAGE_ID',
        message: 'clientMessageId must be 8 to 64 letters, digits, hyphens or underscores.',
      });
    }
    return { body, clientMessageId };
  }

  private notAParty(): ForbiddenException {
    return new ForbiddenException({
      code: 'NOT_A_PARTY',
      message: 'Only the person who placed this order and the rider delivering it can use its chat.',
    });
  }

  private archived(): ConflictException {
    return new ConflictException({
      code: 'CHAT_ARCHIVED',
      message: 'This delivery is over, so its chat no longer accepts messages. You can still read it.',
    });
  }
}

const MESSAGE_SELECT = {
  id: true,
  senderId: true,
  body: true,
  clientMessageId: true,
  sentAt: true,
  deletedAt: true,
} as const;

interface StoredMessage {
  id: string;
  senderId: string;
  body: string | null;
  clientMessageId: string | null;
  sentAt: Date;
  deletedAt: Date | null;
}

interface AuthorisedTask {
  id: string;
  status: string;
  requesterId: string;
  riderId: string | null;
  orderId: string | null;
  requester: { id: string; name: string };
  rider: { id: string; name: string } | null;
  chatRoom: { id: string; isArchived: boolean; archivedAt: Date | null } | null;
}
