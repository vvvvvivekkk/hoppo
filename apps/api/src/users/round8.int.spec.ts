import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { AccountService } from './account.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  type Tx,
  databaseUrl,
  inRolledBackTransaction,
  makeCollege,
  makeUser,
  prismaOver,
} from '../common/testing/rolled-back-transaction';

/**
 * Chat and account data: deletion removes the words of the messages a person
 * sent (and only those), and the export includes what they wrote and the
 * hours they were online as a rider. PostgreSQL, rolled back.
 */
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

const PASSWORD = 'correct horse battery';

async function world(tx: Tx) {
  const college = await makeCollege(tx, `${Date.now()}-${Math.round(Math.random() * 1e6)}`);
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const me = await makeUser(tx, college.id, 'STUDENT', { passwordHash, name: 'Asha Mine' });
  const other = await makeUser(tx, college.id, 'STUDENT', { name: 'Ravi Other' });

  const task = await tx.task.create({
    data: {
      collegeId: college.id,
      type: 'PEER_ERRAND',
      status: 'COMPLETED',
      requesterId: me.id,
      riderId: other.id,
      pickupLabel: 'Library',
      pickupLatitude: 17.3,
      pickupLongitude: 78.6,
      dropLabel: 'Hostel B',
      dropLatitude: 17.3,
      dropLongitude: 78.6,
      distanceM: 300,
      baseFeeMinor: 2000,
      feeMinor: 2000,
      assignedAt: new Date(),
      completedAt: new Date(),
    },
  });
  const room = await tx.chatRoom.create({
    data: {
      collegeId: college.id,
      type: 'TASK',
      taskId: task.id,
      isArchived: true,
      archivedAt: new Date(),
      members: { create: [{ userId: me.id }, { userId: other.id }] },
    },
  });
  const say = (senderId: string, body: string, minutesAgo: number, attachmentUrl?: string) =>
    tx.message.create({
      data: {
        roomId: room.id,
        senderId,
        body,
        attachmentUrl: attachmentUrl ?? null,
        attachmentType: attachmentUrl ? 'image/jpeg' : null,
        attachmentSizeBytes: attachmentUrl ? 1234 : null,
        sentAt: new Date(Date.now() - minutesAgo * 60_000),
      },
    });
  const mine1 = await say(me.id, 'I am in room 214, Hostel B. Call 98xxxxxx01', 30);
  const theirs = await say(other.id, 'On my way, Ravi here — 5 minutes', 29);
  const mine2 = await say(me.id, 'Photo of the gate', 28, `chat/${me.id}/gate.jpg`);

  const hour = (hoursAgo: number) => {
    const d = new Date(Date.now() - hoursAgo * 3_600_000);
    d.setMinutes(0, 0, 0);
    return d;
  };
  await tx.riderPresenceHour.createMany({
    data: [
      { collegeId: college.id, userId: me.id, hourStart: hour(5) },
      { collegeId: college.id, userId: me.id, hourStart: hour(4) },
      { collegeId: college.id, userId: other.id, hourStart: hour(4) },
    ],
  });

  const prisma = prismaOver(tx) as never;
  const service = new AccountService(
    prisma,
    { removeRider: jest.fn().mockResolvedValue(undefined) } as never,
    {
      deletePrivateObject: jest.fn().mockResolvedValue(true),
      deletePublicObject: jest.fn().mockResolvedValue(true),
      publicKeyFromUrl: () => null,
    } as never,
    new AuditService(prisma),
    { revokeAllSessions: jest.fn().mockResolvedValue(0) } as never,
    { disconnectUser: jest.fn() } as never,
  );
  const user: AuthenticatedUser = {
    userId: me.id,
    collegeId: college.id,
    role: 'STUDENT',
    isVerified: true,
  };
  return { service, user, me, other, task, room, mine1, mine2, theirs, hour };
}

type Export = {
  chatMessages: { id: string; sentAt: Date; taskId: string | null; body: string | null; deleted: boolean }[];
  riderPresenceHours: Date[];
};
type Deletion = { erased: string[]; retained: string[]; caveats: string[] };

describe('GET /account/export: what the caller wrote in chat, and when they rode', () => {
  jest.setTimeout(30_000);

  it("includes the caller's own messages and presence hours, and nobody else's", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const data = (await w.service.exportData(w.user)) as unknown as Export;

      expect(data.chatMessages).toEqual([
        {
          id: w.mine1.id,
          sentAt: w.mine1.sentAt,
          taskId: w.task.id,
          body: 'I am in room 214, Hostel B. Call 98xxxxxx01',
          deleted: false,
        },
        { id: w.mine2.id, sentAt: w.mine2.sentAt, taskId: w.task.id, body: 'Photo of the gate', deleted: false },
      ]);
      expect(data.riderPresenceHours).toEqual([w.hour(5), w.hour(4)]);

      // The other side of the conversation is not the caller's to export.
      const text = JSON.stringify(data);
      expect(text).not.toContain('On my way');
      expect(text).not.toContain(w.theirs.id);
      expect(text).not.toContain(w.other.id);
      // Nor the storage key of an attachment.
      expect(text).not.toContain('gate.jpg');
    });
  });
});

describe('POST /account/delete: chat', () => {
  jest.setTimeout(30_000);

  it("removes the words and attachments of the person's own messages, keeps the rows, and leaves the other party's alone", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const result = (await w.service.deleteAccount(w.user, PASSWORD)) as unknown as Deletion;

      const after = await tx.message.findMany({
        where: { roomId: w.room.id },
        orderBy: { sentAt: 'asc' },
      });
      // Three rows still: the conversation keeps its shape.
      expect(after.map((m) => m.id)).toEqual([w.mine1.id, w.theirs.id, w.mine2.id]);

      for (const id of [w.mine1.id, w.mine2.id]) {
        const row = after.find((m) => m.id === id)!;
        expect(row.body).toBeNull();
        expect(row.attachmentUrl).toBeNull();
        expect(row.attachmentType).toBeNull();
        expect(row.attachmentSizeBytes).toBeNull();
        expect(row.deletedAt).toBeInstanceOf(Date);
        // That it was sent, by whom and when, is kept.
        expect(row.senderId).toBe(w.me.id);
      }
      expect(after.find((m) => m.id === w.mine1.id)!.sentAt).toEqual(w.mine1.sentAt);

      const theirs = after.find((m) => m.id === w.theirs.id)!;
      expect(theirs).toMatchObject({ body: 'On my way, Ravi here — 5 minutes', deletedAt: null });

      // The words are gone from the table, not merely hidden.
      const residue = JSON.stringify(await tx.message.findMany({ where: { senderId: w.me.id } }));
      expect(residue).not.toContain('room 214');
      expect(residue).not.toContain('gate');

      // The room and its membership are untouched.
      expect(await tx.chatMember.count({ where: { roomId: w.room.id } })).toBe(2);

      // And the response says exactly this.
      expect(result.erased).toContain('the text and attachments of chat messages you sent');
      expect(result.retained).toContain(
        'chat messages you sent (that each was sent, and when — not its text)',
      );
      expect(result.retained).toContain('hours in which you were online as a rider');
      expect(result.retained).not.toContain('ratings and chat messages you wrote');
      expect(result.caveats.join(' ')).toMatch(/keep their place in the conversation, without their text/);

      // Presence hours are kept, as the response says.
      expect(await tx.riderPresenceHour.count({ where: { userId: w.me.id } })).toBe(2);
    });
  });

  it('also empties a message the person had already deleted, without re-stamping it', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const earlier = new Date('2026-01-01T00:00:00Z');
      await tx.message.update({ where: { id: w.mine1.id }, data: { deletedAt: earlier } });

      await w.service.deleteAccount(w.user, PASSWORD);

      const row = await tx.message.findUniqueOrThrow({ where: { id: w.mine1.id } });
      // Hidden before, but its words were still stored: now they are gone.
      expect(row.body).toBeNull();
      // Its deletion time is the original one.
      expect(row.deletedAt).toEqual(earlier);
    });
  });
});
