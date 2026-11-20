import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { REQUIRE_VERIFIED_KEY } from '../common/decorators/require-verified.decorator';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { buildDispatch, wsEvents } from '../dispatch/test/fakes';
import { codeOf, seedChatRoom, seedRider, seedTask } from '../dispatch/test/world';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService, SHOP_TAKES_PART_IN_TASK_CHAT } from './chat.service';
import { SendChatMessageDto } from './dto/chat.dto';

/**
 * Chat between the student who placed an order and the rider delivering it.
 *
 * The real ChatService, ChatGateway and DispatchGateway over the in-memory
 * database (../dispatch/test/fakes), which evaluates every `where` and
 * enforces the unique key a re-sent message collides on. "Who may read and
 * write" is tested by changing the rows and asking again, because that is
 * the claim: membership is whatever the database says at that moment.
 */

beforeAll(() => {
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

const person = (userId: string, collegeId = 'col-1', role: AuthenticatedUser['role'] = 'STUDENT') =>
  ({ userId, collegeId, role, isVerified: true }) as AuthenticatedUser;

const student = person('student-1');
const rider = person('rider-1');
const bystander = person('student-2');
const shopStaff = person('staff-1', 'col-1', 'SHOP_STAFF');
const outsider = person('student-9', 'col-2');

let nextClientId = 0;
/** A fresh client message id, as a client would mint one per message. */
const freshId = () => `client-msg-${String(++nextClientId).padStart(4, '0')}`;
const say = (body: string, clientMessageId = freshId()) => ({ body, clientMessageId });

/**
 * student-1's order, being delivered by rider-1: ASSIGNED, with the room and
 * members that dispatch creates on accept (the shop's staff included).
 */
function delivery(task: Record<string, unknown> = {}) {
  const ctx = buildDispatch();
  ctx.prisma.$unique('message', ['senderId', 'clientMessageId']);

  const world = seedTask(
    ctx.prisma,
    {
      status: 'ASSIGNED',
      riderId: 'rider-1',
      broadcastRound: 1,
      requester: { id: 'student-1', name: 'Asha' },
      rider: { id: 'rider-1', name: 'Ravi' },
      ...task,
    },
    { status: 'READY' },
  );
  seedRider(ctx.prisma, 'rider-1', { activeTaskId: 'task-1' });
  const room = seedChatRoom(ctx.prisma, world.task, ['student-1', 'rider-1', 'staff-1', 'owner-1']);

  const chat = new ChatService(ctx.prisma, new TenantService(), ctx.gateway);
  const messages = () => ctx.prisma.$rows('message');
  const sent = () => ctx.server.of(wsEvents.MESSAGE_NEW);

  return { ...ctx, chat, task: world.task, order: world.order!, room, messages, sent };
}

type World = ReturnType<typeof delivery>;

/** Refused, and nothing stored or announced. */
async function refused(world: World, call: Promise<unknown>, code: string) {
  const before = world.messages().length;
  expect(await codeOf(call)).toBe(code);
  expect(world.messages()).toHaveLength(before);
  expect(world.sent()).toEqual([]);
}

// ===========================================================================
// Who may read and write
// ===========================================================================

describe('who is a party to a delivery\'s chat', () => {
  it('lets the student who placed the order and the rider delivering it talk', async () => {
    const world = delivery();

    await world.chat.send(student, 'task-1', say('Are you near the gate?'));
    await world.chat.send(rider, 'task-1', say('Two minutes.'));

    const page = await world.chat.history(student, 'task-1');
    expect(page.messages.map((m) => [m.senderRole, m.body])).toEqual([
      ['RIDER', 'Two minutes.'],
      ['REQUESTER', 'Are you near the gate?'],
    ]);
    expect((await world.chat.history(rider, 'task-1')).messages).toHaveLength(2);
  });

  it.each([
    ['another student of the same college', bystander],
    ['a student of another college', outsider],
  ])('refuses %s, to read and to write', async (_name, who) => {
    const world = delivery();
    const code = who === outsider ? 'CROSS_TENANT_ACCESS' : 'NOT_A_PARTY';

    await refused(world, world.chat.history(who, 'task-1'), code);
    await refused(world, world.chat.send(who, 'task-1', say('hello')), code);
  });

  it('refuses the shop\'s staff, though dispatch lists them as members of the room', async () => {
    // FR-DLV-10 puts the shop in the room; this release does not open the
    // conversation to it (see SHOP_TAKES_PART_IN_TASK_CHAT and
    // A2-DECISION-chat.md). Being in chat_member is necessary, not sufficient.
    expect(SHOP_TAKES_PART_IN_TASK_CHAT).toBe(false);
    const world = delivery();
    expect(world.prisma.$rows('chatMember').map((m: any) => m.userId)).toContain('staff-1');

    await refused(world, world.chat.history(shopStaff, 'task-1'), 'NOT_A_PARTY');
    await refused(world, world.chat.send(shopStaff, 'task-1', say('Order is packed')), 'NOT_A_PARTY');
  });

  it('refuses a rider who is no longer the task\'s rider', async () => {
    // rider-1 abandoned; rider-2 holds it now. rider-1 was a party a minute ago.
    const world = delivery();
    await world.chat.send(rider, 'task-1', say('On my way'));
    world.server.emissions.length = 0;

    world.task.riderId = 'rider-2';

    await refused(world, world.chat.send(rider, 'task-1', say('Still me?')), 'NOT_A_PARTY');
    await refused(world, world.chat.history(rider, 'task-1'), 'NOT_A_PARTY');
  });

  it('refuses a member dispatch has marked as having left the room', async () => {
    const world = delivery();
    world.prisma.$rows('chatMember').find((m: any) => m.userId === 'rider-1').leftAt = new Date();

    await refused(world, world.chat.send(rider, 'task-1', say('hello')), 'NOT_A_PARTY');
    await refused(world, world.chat.history(rider, 'task-1'), 'NOT_A_PARTY');
  });

  it('refuses the task\'s rider if dispatch never made them a member', async () => {
    // Both locks are needed: named on the task *and* a member of the room.
    const world = delivery();
    const members = world.prisma.$rows('chatMember');
    members.splice(members.findIndex((m: any) => m.userId === 'rider-1'), 1);

    await refused(world, world.chat.send(rider, 'task-1', say('hello')), 'NOT_A_PARTY');
  });

  it('asks the database every time: nothing about an earlier message carries over', async () => {
    const world = delivery();

    await world.chat.send(rider, 'task-1', say('one'));
    await world.chat.send(rider, 'task-1', say('two'));

    // Once per message for the task, once per message for the membership.
    expect(world.prisma.task.findUnique).toHaveBeenCalledTimes(2);
    expect(world.prisma.chatMember.findFirst).toHaveBeenCalledTimes(2);
  });

  it('answers 404 for a task that does not exist', async () => {
    const world = delivery();

    await expect(world.chat.history(student, 'no-such-task')).rejects.toMatchObject({ status: 404 });
  });
});

// ===========================================================================
// When the conversation is open
// ===========================================================================

describe('when a delivery\'s chat accepts messages', () => {
  it('is not open before a rider has accepted: nobody to talk to', async () => {
    const ctx = buildDispatch();
    seedTask(ctx.prisma, { status: 'BROADCASTING', broadcastRound: 1, requester: { id: 'student-1', name: 'Asha' }, rider: null });
    const chat = new ChatService(ctx.prisma, new TenantService(), ctx.gateway);

    const page = await chat.history(student, 'task-1');
    expect(page).toMatchObject({ room: { state: 'NOT_OPEN', canSend: false, roomId: null }, messages: [], nextCursor: null });
    expect(page.room.participants).toEqual([{ userId: 'student-1', name: 'Asha', role: 'REQUESTER' }]);

    expect(await codeOf(chat.send(student, 'task-1', say('anyone?')))).toBe('CHAT_NOT_OPEN');
    expect(ctx.prisma.$rows('message')).toEqual([]);
  });

  it.each(['ASSIGNED', 'PICKED_UP', 'ESCALATED'])('is open while the task is %s', async (status) => {
    const world = delivery({ status });

    const result = await world.chat.send(student, 'task-1', say('hello'));

    expect(result.duplicate).toBe(false);
    expect((await world.chat.history(rider, 'task-1')).room).toMatchObject({ state: 'OPEN', canSend: true });
  });

  it.each(['COMPLETED', 'CANCELLED'])('is read-only once the task is %s (FR-CHAT-08)', async (status) => {
    const world = delivery();
    await world.chat.send(rider, 'task-1', say('Delivered, thanks!'));
    world.server.emissions.length = 0;
    Object.assign(world.task, { status });
    Object.assign(world.room, { isArchived: true, archivedAt: new Date() });

    for (const who of [student, rider]) {
      await refused(world, world.chat.send(who, 'task-1', say('one more thing')), 'CHAT_ARCHIVED');
      // The parties keep read access.
      const page = await world.chat.history(who, 'task-1');
      expect(page.room).toMatchObject({ state: 'ARCHIVED', canSend: false });
      expect(page.room.archivedAt).toBeInstanceOf(Date);
      expect(page.messages.map((m) => m.body)).toEqual(['Delivered, thanks!']);
    }
  });

  describe('a message racing the end of the delivery', () => {
    /**
     * The sender's read says the chat is open. Before the write, the
     * delivery ends. The message must not land in an archived room — and
     * what stops it is the conditional UPDATE on the room, not the check.
     */
    function endsUnderneath(world: World, change: () => void) {
      const asRead = { ...world.task, chatRoom: { ...world.room } };
      change();
      world.prisma.$staleRead('task', asRead);
    }

    it('is refused when the room was archived in between — `isArchived: false`', async () => {
      const world = delivery();
      endsUnderneath(world, () => Object.assign(world.room, { isArchived: true, archivedAt: new Date() }));

      await refused(world, world.chat.send(rider, 'task-1', say('too late')), 'CHAT_ARCHIVED');
      expect(world.room.lastMessageAt).toBeUndefined();
    });

    it('is refused when the task ended in between — the task\'s status, in the same UPDATE', async () => {
      // The task is COMPLETED but the room's own flag has not been set: only
      // the status, checked inside the UPDATE, says the conversation is over.
      const world = delivery();
      endsUnderneath(world, () => Object.assign(world.task, { status: 'COMPLETED' }));

      await refused(world, world.chat.send(rider, 'task-1', say('too late')), 'CHAT_ARCHIVED');
    });

    it('stores nothing if the transaction fails after the room was touched', async () => {
      const world = delivery();
      world.prisma.message.createMany.mockRejectedValueOnce(new Error('connection lost'));

      await expect(world.chat.send(rider, 'task-1', say('hello'))).rejects.toThrow('connection lost');

      expect(world.messages()).toEqual([]);
      expect(world.room.lastMessageAt).toBeUndefined();
      expect(world.sent()).toEqual([]);
    });
  });
});

// ===========================================================================
// Sending
// ===========================================================================

describe('sending a message', () => {
  it('stores it and returns it', async () => {
    const world = delivery();

    const { message, duplicate } = await world.chat.send(student, 'task-1', say('  At the back gate  ', 'client-abc-123'));

    expect(duplicate).toBe(false);
    expect(message).toMatchObject({
      senderId: 'student-1',
      senderRole: 'REQUESTER',
      body: 'At the back gate',
      deleted: false,
      clientMessageId: 'client-abc-123',
    });
    expect(message.sentAt).toBeInstanceOf(Date);
    expect(world.messages()).toEqual([
      expect.objectContaining({ roomId: 'room-1', senderId: 'student-1', body: 'At the back gate' }),
    ]);
    expect(world.room.lastMessageAt).toBeInstanceOf(Date);
  });

  it('delivers it to the two parties\' own rooms, and to nobody else', async () => {
    const world = delivery();

    const { message } = await world.chat.send(student, 'task-1', say('At the back gate'));

    const events = world.sent();
    expect(events).toHaveLength(1);
    // The sender too: their other devices show it.
    expect([...events[0]!.rooms].sort()).toEqual(['user:rider-1', 'user:student-1']);
    expect(events[0]!.payload).toEqual({ ...message, taskId: 'task-1', orderId: 'order-1', roomId: 'room-1' });
    // Not the shop's staff, though they are in chat_member; not the college.
    expect(world.server.emissions.flatMap((e) => e.rooms)).not.toContain('user:staff-1');
    expect(world.server.toCollegeRooms()).toEqual([]);
  });

  describe('stored once however often it is sent (FR-CHAT-04)', () => {
    it('returns the same message for a retry, and does not announce it twice', async () => {
      const world = delivery();
      const text = say('On my way', 'client-retry-01');

      const first = await world.chat.send(rider, 'task-1', text);
      const again = await world.chat.send(rider, 'task-1', text);

      expect(again.duplicate).toBe(true);
      expect(again.message).toEqual(first.message);
      expect(world.messages()).toHaveLength(1);
      expect(world.sent()).toHaveLength(1);
    });

    it('keeps the first body if a retry carries different words', async () => {
      const world = delivery();

      await world.chat.send(rider, 'task-1', say('On my way', 'client-retry-02'));
      const again = await world.chat.send(rider, 'task-1', say('Something else', 'client-retry-02'));

      expect(again.message.body).toBe('On my way');
      expect(world.messages()).toHaveLength(1);
    });

    it('stores one row when the same message is sent many times at once', async () => {
      // The socket and the REST fallback, a reconnect flushing its queue twice.
      const world = delivery();
      const text = say('On my way', 'client-burst-01');

      const results = await Promise.all(Array.from({ length: 8 }, () => world.chat.send(rider, 'task-1', text)));

      expect(world.messages()).toHaveLength(1);
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
      expect(world.sent()).toHaveLength(1);
    });

    it('lets two different people use the same client id', async () => {
      const world = delivery();

      await world.chat.send(rider, 'task-1', say('from the rider', 'client-same-01'));
      const other = await world.chat.send(student, 'task-1', say('from the student', 'client-same-01'));

      expect(other.duplicate).toBe(false);
      expect(world.messages()).toHaveLength(2);
    });

    it('refuses an id already used by this person in another conversation', async () => {
      const world = delivery();
      world.prisma.$seed('message', [
        { id: 'elsewhere', roomId: 'room-other', senderId: 'rider-1', body: 'other chat', clientMessageId: 'client-used-01', sentAt: new Date(0), deletedAt: null },
      ]);

      await refused(world, world.chat.send(rider, 'task-1', say('hello', 'client-used-01')), 'CLIENT_MESSAGE_ID_REUSED');
      expect(world.messages().map((m: any) => m.id)).toEqual(['elsewhere']);
      // And the room was not marked as having a new message.
      expect(world.room.lastMessageAt).toBeUndefined();
    });
  });

  describe('what a message may be', () => {
    it.each([
      ['empty', ''],
      ['only spaces', '    '],
      ['longer than 2000 characters', 'x'.repeat(2001)],
      ['not text', 42],
      ['missing', undefined],
    ])('refuses a body that is %s', async (_name, body) => {
      const world = delivery();

      await refused(world, world.chat.send(student, 'task-1', { body, clientMessageId: freshId() }), 'INVALID_MESSAGE');
    });

    it.each([
      ['missing', undefined],
      ['too short', 'abc'],
      ['longer than 64 characters', 'a'.repeat(65)],
      ['carrying other characters', 'client msg; drop table'],
    ])('refuses a clientMessageId that is %s', async (_name, clientMessageId) => {
      const world = delivery();

      await refused(world, world.chat.send(student, 'task-1', { body: 'hello', clientMessageId }), 'INVALID_CLIENT_MESSAGE_ID');
    });

    it('accepts exactly 2000 characters', async () => {
      const world = delivery();

      const { message } = await world.chat.send(student, 'task-1', say('x'.repeat(2000)));

      expect(message.body).toHaveLength(2000);
    });

    it('stores markup as the text it is', async () => {
      const world = delivery();
      const text = '<img src=x onerror=alert(1)>';

      const { message } = await world.chat.send(student, 'task-1', say(text));

      expect(message.body).toBe(text);
    });

    it('validates before it asks who is asking: a stranger\'s malformed message reads nothing', async () => {
      const world = delivery();

      await refused(world, world.chat.send(bystander, 'task-1', { body: '', clientMessageId: freshId() }), 'INVALID_MESSAGE');
      expect(world.prisma.task.findUnique).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// History
// ===========================================================================

describe('history', () => {
  async function withMessages(count: number) {
    const world = delivery();
    const t0 = Date.parse('2026-11-20T10:00:00Z');
    world.prisma.$seed(
      'message',
      Array.from({ length: count }, (_, i) => ({
        id: `m-${String(i + 1).padStart(2, '0')}`,
        roomId: 'room-1',
        senderId: i % 2 ? 'rider-1' : 'student-1',
        body: `message ${i + 1}`,
        clientMessageId: `seed-client-${i + 1}`,
        sentAt: new Date(t0 + i * 1000),
        deletedAt: null,
      })),
    );
    world.prisma.$seed('message', [
      { id: 'other-room', roomId: 'room-other', senderId: 'student-1', body: 'a different chat', clientMessageId: 'seed-other', sentAt: new Date(t0 + 500), deletedAt: null },
    ]);
    return world;
  }

  it('returns this conversation\'s messages, newest first, and no other room\'s', async () => {
    const world = await withMessages(3);

    const page = await world.chat.history(student, 'task-1');

    expect(page.messages.map((m) => m.id)).toEqual(['m-03', 'm-02', 'm-01']);
    expect(page.nextCursor).toBeNull();
  });

  it('pages backwards with a cursor, without repeating or dropping a message', async () => {
    const world = await withMessages(5);

    const first = await world.chat.history(rider, 'task-1', 2);
    expect(first.messages.map((m) => m.id)).toEqual(['m-05', 'm-04']);
    expect(first.nextCursor).toBe('m-04');

    const second = await world.chat.history(rider, 'task-1', 2, first.nextCursor!);
    expect(second.messages.map((m) => m.id)).toEqual(['m-03', 'm-02']);

    const third = await world.chat.history(rider, 'task-1', 2, second.nextCursor!);
    expect(third.messages.map((m) => m.id)).toEqual(['m-01']);
    expect(third.nextCursor).toBeNull();
  });

  it('refuses a cursor that is not a message of this conversation', async () => {
    const world = await withMessages(3);

    expect(await codeOf(world.chat.history(student, 'task-1', 50, 'other-room'))).toBe('INVALID_CURSOR');
    expect(await codeOf(world.chat.history(student, 'task-1', 50, 'no-such-message'))).toBe('INVALID_CURSOR');
  });

  it('says who is in the conversation and which of them is asking', async () => {
    const world = await withMessages(1);

    const { room } = await world.chat.history(rider, 'task-1');

    expect(room).toEqual({
      taskId: 'task-1',
      orderId: 'order-1',
      roomId: 'room-1',
      state: 'OPEN',
      canSend: true,
      archivedAt: null,
      you: 'RIDER',
      participants: [
        { userId: 'student-1', name: 'Asha', role: 'REQUESTER' },
        { userId: 'rider-1', name: 'Ravi', role: 'RIDER' },
      ],
    });
  });

  it('keeps a deleted message\'s place and withholds its words', async () => {
    const world = await withMessages(2);
    Object.assign(world.messages().find((m: any) => m.id === 'm-01'), { deletedAt: new Date(), body: 'still in the row' });

    const page = await world.chat.history(student, 'task-1');

    expect(page.messages.find((m) => m.id === 'm-01')).toMatchObject({ body: null, deleted: true });
    expect(page.messages.find((m) => m.id === 'm-02')).toMatchObject({ body: 'message 2', deleted: false });
  });
});

describe('finding the conversation from an order', () => {
  it('leads the student from their order to the same chat', async () => {
    const world = delivery();
    world.order.task = { id: 'task-1' };

    expect(await world.chat.taskIdForOrder(student, 'order-1')).toBe('task-1');
  });

  it('refuses an order of another college before saying anything about it', async () => {
    const world = delivery();

    expect(await codeOf(world.chat.taskIdForOrder(outsider, 'order-1'))).toBe('CROSS_TENANT_ACCESS');
  });

  it('answers 404 for an order that does not exist', async () => {
    const world = delivery();

    await expect(world.chat.taskIdForOrder(student, 'no-such-order')).rejects.toMatchObject({ status: 404 });
  });
});

// ===========================================================================
// The REST door
// ===========================================================================

describe('ChatController', () => {
  const HANDLERS = ['taskHistory', 'sendToTask', 'orderHistory', 'sendToOrder'] as const;

  function guardAllows(handlerName: (typeof HANDLERS)[number], user: AuthenticatedUser): boolean {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => ChatController.prototype[handlerName],
      getClass: () => ChatController,
    } as unknown as ExecutionContext;
    return new RolesGuard(new Reflector()).canActivate(context);
  }

  it('is for verified students', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ChatController)).toEqual(['STUDENT']);
    expect(Reflect.getMetadata(REQUIRE_VERIFIED_KEY, ChatController)).toBe(true);
    for (const handler of HANDLERS) expect(guardAllows(handler, student)).toBe(true);
  });

  it.each(['SHOP_OWNER', 'SHOP_STAFF', 'ADMIN'] as const)('refuses a %s every route', (role) => {
    for (const handler of HANDLERS) {
      expect(() => guardAllows(handler, { ...student, role })).toThrow(ForbiddenException);
    }
  });
});

describe('SendChatMessageDto', () => {
  const errorsFor = async (body: object) =>
    (await validate(plainToInstance(SendChatMessageDto, body))).map((e) => e.property).sort();

  it('accepts a message with a client id, and trims it', async () => {
    expect(await errorsFor({ body: 'hello', clientMessageId: 'client-abc-123' })).toEqual([]);
    expect(plainToInstance(SendChatMessageDto, { body: '  hi  ', clientMessageId: 'client-abc-123' }).body).toBe('hi');
  });

  it.each([
    ['an empty body', { body: '', clientMessageId: 'client-abc-123' }, ['body']],
    ['a body of spaces', { body: '   ', clientMessageId: 'client-abc-123' }, ['body']],
    ['a body over the limit', { body: 'x'.repeat(2001), clientMessageId: 'client-abc-123' }, ['body']],
    ['no client id', { body: 'hello' }, ['clientMessageId']],
    ['a client id with spaces', { body: 'hello', clientMessageId: 'client abc 123' }, ['clientMessageId']],
  ])('refuses %s', async (_name, body, properties) => {
    expect(await errorsFor(body)).toEqual(properties);
  });
});

// ===========================================================================
// The socket door
// ===========================================================================

describe('message:new over the socket', () => {
  function connected(as: 'student-1' | 'rider-1' | 'staff-1' | 'student-2' = 'rider-1') {
    const world = delivery();
    const account = (id: string, role = 'STUDENT') => ({
      id,
      collegeId: 'col-1',
      role,
      status: 'ACTIVE',
      college: { status: 'ACTIVE' },
      studentProfile: role === 'STUDENT' ? { verificationStatus: 'VERIFIED' } : null,
    });
    // seedRider has already created rider-1's user row; complete it.
    Object.assign(world.prisma.$rows('user').find((u: any) => u.id === 'rider-1'), account('rider-1'));
    world.prisma.$seed('user', [account('student-1'), account('student-2'), account('staff-1', 'SHOP_STAFF')]);

    const gateway = new ChatGateway(world.chat, world.prisma);
    // As DispatchGateway.handleConnection leaves it.
    const client = { data: { user: { userId: as, collegeId: 'col-1', role: 'STUDENT' } } as Record<string, any> };
    const send = (payload: Record<string, unknown>) => gateway.handleSend(client as never, payload as never);
    const account$ = (id: string) => world.prisma.$rows('user').find((u: any) => u.id === id);

    return { ...world, gateway, client, send, account: account$ };
  }

  it('stores the message, acknowledges it, and delivers it to both parties', async () => {
    const world = connected('rider-1');

    const ack = await world.send({ taskId: 'task-1', ...say('Outside the hostel') });

    expect(ack).toMatchObject({ ok: true, duplicate: false, message: { body: 'Outside the hostel', senderRole: 'RIDER' } });
    expect(world.messages()).toHaveLength(1);
    expect([...world.sent()[0]!.rooms].sort()).toEqual(['user:rider-1', 'user:student-1']);
  });

  it('finds the conversation from an order id', async () => {
    const world = connected('student-1');
    world.order.task = { id: 'task-1' };

    const ack = await world.send({ orderId: 'order-1', ...say('Which gate?') });

    expect(ack).toMatchObject({ ok: true, message: { senderRole: 'REQUESTER' } });
  });

  it('refuses a socket that never authenticated', async () => {
    const world = connected();
    world.client.data = {};

    expect(await world.send({ taskId: 'task-1', ...say('hello') })).toMatchObject({ ok: false, code: 'NOT_AUTHENTICATED' });
    expect(world.messages()).toEqual([]);
  });

  it.each([
    ['a student who is not on the task', 'student-2', 'NOT_A_PARTY'],
    ['the shop\'s staff', 'staff-1', 'NOT_A_PARTY'],
  ] as const)('refuses %s with the same code as REST', async (_name, as, code) => {
    const world = connected(as);

    expect(await world.send({ taskId: 'task-1', ...say('hello') })).toMatchObject({ ok: false, code });
    expect(world.messages()).toEqual([]);
    expect(world.sent()).toEqual([]);
  });

  describe('a socket that was fine when it connected', () => {
    /**
     * The connection was authenticated once, perhaps hours ago. Each message
     * is checked against the account as it is *now* — the same standard the
     * REST routes get from the JWT strategy on every request.
     */
    it.each([
      ['the account has since been suspended', (w: ReturnType<typeof connected>) => (w.account('rider-1').status = 'SUSPENDED'), 'ACCOUNT_NOT_ACTIVE'],
      ['the college has since been deactivated', (w: ReturnType<typeof connected>) => (w.account('rider-1').college = { status: 'INACTIVE' }), 'COLLEGE_INACTIVE'],
      ['the verification has since been withdrawn', (w: ReturnType<typeof connected>) => (w.account('rider-1').studentProfile = { verificationStatus: 'REJECTED' }), 'VERIFICATION_REQUIRED'],
      ['the rider has since abandoned the task', (w: ReturnType<typeof connected>) => (w.task.riderId = null), 'NOT_A_PARTY'],
      ['the delivery has since completed', (w: ReturnType<typeof connected>) => Object.assign(w.room, { isArchived: true }), 'CHAT_ARCHIVED'],
    ])('is refused once %s', async (_name, change, code) => {
      const world = connected('rider-1');
      expect(await world.send({ taskId: 'task-1', ...say('first') })).toMatchObject({ ok: true });
      world.server.emissions.length = 0;

      change(world);

      expect(await world.send({ taskId: 'task-1', ...say('second') })).toMatchObject({ ok: false, code });
      expect(world.messages()).toHaveLength(1);
      expect(world.sent()).toEqual([]);
    });

    it('does not take the role or college from what the socket remembers', async () => {
      const world = connected('staff-1');
      // The socket claims to be a student of this college. The database says staff.
      world.client.data.user = { userId: 'staff-1', collegeId: 'col-1', role: 'STUDENT' };

      expect(await world.send({ taskId: 'task-1', ...say('hello') })).toMatchObject({ ok: false, code: 'NOT_A_PARTY' });
    });
  });

  it.each([
    ['neither a task nor an order', { ...say('hello') }, 'INVALID_MESSAGE'],
    ['an empty body', { taskId: 'task-1', body: '', clientMessageId: 'client-abc-123' }, 'INVALID_MESSAGE'],
    ['no client id', { taskId: 'task-1', body: 'hello' }, 'INVALID_CLIENT_MESSAGE_ID'],
    ['no payload at all', undefined, 'INVALID_MESSAGE'],
  ])('refuses a payload with %s', async (_name, payload, code) => {
    const world = connected();

    expect(await world.send(payload as never)).toMatchObject({ ok: false, code });
    expect(world.messages()).toEqual([]);
  });

  it('acknowledges a retry as a duplicate and announces it once', async () => {
    const world = connected('rider-1');
    const text = { taskId: 'task-1', ...say('On my way', 'client-sock-retry') };

    const first = await world.send(text);
    const again = await world.send(text);

    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect((again as any).message).toEqual((first as any).message);
    expect(world.sent()).toHaveLength(1);
  });

  it('drops a flood from one socket before it costs a query', async () => {
    const world = connected('rider-1');
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);

    for (let i = 0; i < 10; i++) {
      expect(await world.send({ taskId: 'task-1', ...say(`message ${i}`) })).toMatchObject({ ok: true });
    }
    const reads = world.prisma.user.findUnique.mock.calls.length;

    expect(await world.send({ taskId: 'task-1', ...say('one too many') })).toMatchObject({ ok: false, code: 'TOO_MANY_MESSAGES' });
    expect(world.prisma.user.findUnique.mock.calls.length).toBe(reads);
    expect(world.messages()).toHaveLength(10);

    // Ten seconds later the window has moved on.
    now.mockReturnValue(1_800_000_000_000 + 10_000);
    expect(await world.send({ taskId: 'task-1', ...say('and again') })).toMatchObject({ ok: true });
    now.mockRestore();
  });

  it('does not leak an unexpected error to the client', async () => {
    const world = connected('rider-1');
    world.prisma.user.findUnique.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

    const ack = await world.send({ taskId: 'task-1', ...say('hello') });

    expect(ack).toEqual({ ok: false, code: 'INTERNAL_ERROR', message: 'The message could not be sent.' });
  });
});
