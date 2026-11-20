import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { WalletStatementService, maskUpiId } from './wallet-statement.service';
import { WalletController } from './wallet.controller';
import { TenantService } from '../common/tenant/tenant.service';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * The wallet statement and rider earnings, against PostgreSQL.
 *
 * Both are window-function SQL over the ledger (`LAG ... OVER`), so only a
 * real database can say whether they are right. Each test builds a new
 * college with its own students and a short, hand-written ledger inside one
 * transaction, runs the real service on it, and rolls back. Nothing is kept.
 *
 * Needs the development database (DATABASE_URL or apps/api/.env); fails,
 * rather than skips, without one.
 */
function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [join(process.cwd(), '.env'), join(process.cwd(), '..', '..', '.env')]) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const match = /^DATABASE_URL=["']?([^"'\r\n]+)["']?\s*$/m.exec(text);
    if (match) return match[1];
  }
  throw new Error('DATABASE_URL is not set and no .env provides it; this spec needs PostgreSQL');
}

class Rollback extends Error {}
const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(async () => {
  await db.$disconnect();
});

type Tx = Prisma.TransactionClient;

const DAY = '2026-03-10';
/** An instant given as Indian wall-clock time (the fixture college is Asia/Kolkata). */
const ist = (time: string, day = DAY) => new Date(`${day}T${time}:00+05:30`);

interface World {
  tx: Tx;
  wallet: WalletStatementService;
  rider: AuthenticatedUser;
  other: AuthenticatedUser;
  /** Ledger entry ids by fixture key. */
  entry: Record<string, string>;
  orderReference: string;
}

async function inRolledBackTransaction(body: (world: World) => Promise<void>): Promise<void> {
  let finished = false;
  const attempt = db.$transaction(
    async (tx: Tx) => {
      const tag = randomUUID().replace(/-/g, '').slice(0, 10);
      const college = await tx.college.create({
        data: {
          name: `A1 wallet spec ${tag}`, address: 'Test Road', city: 'Hyderabad',
          state: 'Telangana', latitude: 17.3, longitude: 78.6, timezone: 'Asia/Kolkata',
        },
        select: { id: true },
      });
      let serial = 0;
      const student = async (name: string) => {
        serial += 1;
        const user = await tx.user.create({
          data: {
            collegeId: college.id, role: 'STUDENT', name,
            mobile: `+9993${String(parseInt(tag.slice(0, 6), 16) % 1_000_000).padStart(6, '0')}${String(serial).padStart(2, '0')}`,
            email: `a1-wallet-${tag}-${serial}@example.test`, passwordHash: 'not-a-real-hash',
          },
          select: { id: true },
        });
        return user.id;
      };
      const riderId = await student('Ravi Rider');
      const otherId = await student('Someone Else');

      // One real order, so a ledger line has a reference to show.
      const shop = await tx.shop.create({
        data: {
          name: `Shop ${tag}`, category: 'Food', ownerName: 'Owner',
          ownerMobile: `+9994${tag.slice(0, 8)}`, ownerEmail: `a1-wallet-shop-${tag}@example.test`,
          address: 'Shop Street', city: 'Hyderabad', state: 'Telangana',
          latitude: 17.301, longitude: 78.601, locationType: 'OFF_CAMPUS',
        },
        select: { id: true },
      });
      const listing = await tx.shopListing.create({
        data: { shopId: shop.id, collegeId: college.id, distanceFromCollegeM: 400, status: 'ACTIVE' },
        select: { id: true },
      });
      const orderReference = `TWAL-${tag.slice(0, 6).toUpperCase()}`;
      const order = await tx.order.create({
        data: {
          collegeId: college.id, reference: orderReference, studentId: riderId,
          shopListingId: listing.id, status: 'CANCELLED', itemsSubtotalMinor: 1500,
          deliveryFeeMinor: 2000, platformFeeMinor: 500, totalMinor: 4000, commissionMinor: 0,
          paymentMethod: 'WALLET', paymentStatus: 'REFUNDED', placedAt: ist('23:30'),
        },
        select: { id: true },
      });

      const entry: Record<string, string> = {};
      const write = async (
        key: string,
        userId: string,
        data: {
          at: Date; type: Prisma.WalletEntryCreateInput['type'];
          direction: 'CREDIT' | 'DEBIT'; amount: number; balanceAfter: number; orderId?: string;
        },
      ) => {
        const row = await tx.walletEntry.create({
          data: {
            userId, direction: data.direction, amountMinor: data.amount, type: data.type,
            orderId: data.orderId ?? null, balanceAfterMinor: data.balanceAfter,
            note: `spec ${key}`, createdAt: data.at,
          },
          select: { id: true },
        });
        entry[key] = row.id;
      };

      // The rider's ledger. Balance after each line is on the right.
      await write('funding', riderId, { at: ist('20:00', '2026-03-09'), type: 'ADJUSTMENT', direction: 'CREDIT', amount: 5000, balanceAfter: 5000 });
      // A cash delivery: a statement line, the balance does not move (ADR-006).
      await write('cashFee', riderId, { at: ist('09:00'), type: 'DELIVERY_FEE_EARNED', direction: 'CREDIT', amount: 2000, balanceAfter: 5000 });
      // Written in the SAME millisecond as the fee: only `seq` orders these two.
      await write('reimbursement', riderId, { at: ist('09:00'), type: 'ERRAND_REIMBURSEMENT', direction: 'CREDIT', amount: 3000, balanceAfter: 5000 });
      // A wallet-paid delivery: this one does raise the balance.
      await write('walletFee', riderId, { at: ist('14:00'), type: 'DELIVERY_FEE_EARNED', direction: 'CREDIT', amount: 2500, balanceAfter: 7500 });
      await write('hold', riderId, { at: ist('23:30'), type: 'ORDER_HOLD', direction: 'DEBIT', amount: 4000, balanceAfter: 3500, orderId: order.id });
      // Just after midnight: the next local day.
      await write('release', riderId, { at: ist('00:20', '2026-03-11'), type: 'ORDER_RELEASE', direction: 'CREDIT', amount: 4000, balanceAfter: 7500, orderId: order.id });
      // Somebody else's money, on the same day.
      await write('others', otherId, { at: ist('10:00'), type: 'ADJUSTMENT', direction: 'CREDIT', amount: 99000, balanceAfter: 99000 });

      const prisma = new Proxy(tx as object, {
        get(target, prop, receiver) {
          if (prop === '$transaction') return (fn: (client: Tx) => Promise<unknown>) => fn(tx);
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      const as = (userId: string) =>
        ({ userId, collegeId: college.id, role: 'STUDENT', isVerified: true }) as AuthenticatedUser;

      await body({
        tx,
        wallet: new WalletStatementService(prisma as never, new TenantService()),
        rider: as(riderId),
        other: as(otherId),
        entry,
        orderReference,
      });
      finished = true;
      throw new Rollback();
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
  await attempt.catch((error: unknown) => {
    if (!(error instanceof Rollback)) throw error;
  });
  if (!finished) throw new Error('the test body did not run to the end');
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    return { status: http.getStatus(), code: (http.getResponse() as { code?: string }).code };
  }
  throw new Error('expected the call to be refused');
}

const day = { from: DAY, to: DAY };
const keysOf = (w: World, entries: { id: string }[]) =>
  entries.map((e) => Object.keys(w.entry).find((k) => w.entry[k] === e.id));

jest.setTimeout(90_000);

describe('the wallet routes', () => {
  it('are for students, and the class carries the role so new routes inherit it', () => {
    expect(Reflect.getMetadata(ROLES_KEY, WalletController)).toEqual(['STUDENT']);
  });

  it('offer nothing but reads', () => {
    const methods = Object.getOwnPropertyNames(WalletController.prototype).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['earnings', 'statement', 'withdrawals']);
    // Nest stores the HTTP verb as metadata: 0 is GET.
    for (const m of methods) {
      expect(Reflect.getMetadata('method', WalletController.prototype[m as 'statement'])).toBe(0);
    }
  });
});

describe('GET /wallet/statement (FR-PAY-04)', () => {
  it('reads like a statement: opening balance, each entry oldest first with the balance after it, closing balance', async () => {
    await inRolledBackTransaction(async (w) => {
      const s = await w.wallet.statement(w.rider, day);

      expect(s.range).toEqual({ from: DAY, to: DAY, timezone: 'Asia/Kolkata' });
      expect(s.openingBalanceMinor).toBe(5000);
      // The two 09:00 lines share a millisecond; they come back in the order written.
      expect(keysOf(w, s.entries)).toEqual(['cashFee', 'reimbursement', 'walletFee', 'hold']);
      expect(s.entries.map((e) => [e.type, e.direction, e.amountMinor, e.balanceChangeMinor, e.balanceAfterMinor])).toEqual([
        ['DELIVERY_FEE_EARNED', 'CREDIT', 2000, 0, 5000],
        ['ERRAND_REIMBURSEMENT', 'CREDIT', 3000, 0, 5000],
        ['DELIVERY_FEE_EARNED', 'CREDIT', 2500, 2500, 7500],
        ['ORDER_HOLD', 'DEBIT', 4000, -4000, 3500],
      ]);
      expect(s.entries.map((e) => e.affectsBalance)).toEqual([false, false, true, true]);
      expect(s.closingBalanceMinor).toBe(3500);
      // The release after midnight is outside the day but inside the wallet.
      expect(s.currentBalanceMinor).toBe(7500);

      // The running balance is consistent: opening + changes = closing.
      const moved = s.entries.reduce((sum, e) => sum + e.balanceChangeMinor, 0);
      expect(s.openingBalanceMinor + moved).toBe(s.closingBalanceMinor);

      expect(s.entries[3]).toMatchObject({ orderReference: w.orderReference, note: 'spec hold' });
      expect(() => JSON.stringify(s)).not.toThrow();
    });
  });

  it('puts an entry on the local day it happened, not the UTC day', async () => {
    await inRolledBackTransaction(async (w) => {
      // 00:20 IST on the 11th is 18:50 UTC on the 10th.
      const next = await w.wallet.statement(w.rider, { from: '2026-03-11', to: '2026-03-11' });
      expect(keysOf(w, next.entries)).toEqual(['release']);
      expect(next).toMatchObject({ openingBalanceMinor: 3500, closingBalanceMinor: 7500 });
      expect(next.entries[0].balanceChangeMinor).toBe(4000);
    });
  });

  it('with no dates, is the whole ledger from a zero opening balance', async () => {
    await inRolledBackTransaction(async (w) => {
      const all = await w.wallet.statement(w.rider, {});
      expect(keysOf(w, all.entries)).toEqual(['funding', 'cashFee', 'reimbursement', 'walletFee', 'hold', 'release']);
      expect(all).toMatchObject({ openingBalanceMinor: 0, closingBalanceMinor: 7500 });
      expect(all.entries[0].balanceChangeMinor).toBe(5000);
    });
  });

  it('pages forward without repeating or dropping a line, even across the same-millisecond pair', async () => {
    await inRolledBackTransaction(async (w) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await w.wallet.statement(w.rider, { limit: '1', cursor });
        expect(page.entries).toHaveLength(1);
        seen.push(page.entries[0].id);
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 20);

      expect(seen.map((id) => Object.keys(w.entry).find((k) => w.entry[k] === id))).toEqual([
        'funding', 'cashFee', 'reimbursement', 'walletFee', 'hold', 'release',
      ]);
    });
  });

  it("shows only the caller's own ledger; another user's entry is not even a valid page marker", async () => {
    await inRolledBackTransaction(async (w) => {
      const mine = await w.wallet.statement(w.rider, {});
      expect(keysOf(w, mine.entries)).not.toContain('others');

      const theirs = await w.wallet.statement(w.other, {});
      expect(keysOf(w, theirs.entries)).toEqual(['others']);
      expect(theirs.currentBalanceMinor).toBe(99000);

      expect(await refusal(w.wallet.statement(w.rider, { cursor: w.entry.others }))).toEqual({
        status: 400, code: 'INVALID_CURSOR',
      });
      expect(await refusal(w.wallet.statement(w.rider, { from: 'yesterday' }))).toEqual({
        status: 400, code: 'INVALID_DATE',
      });
    });
  });
});

describe('GET /wallet/earnings (S-24)', () => {
  it('separates what was collected in cash from what was added to the wallet', async () => {
    await inRolledBackTransaction(async (w) => {
      const e = await w.wallet.earnings(w.rider, day);

      expect(e).toMatchObject({
        range: { from: DAY, to: DAY, timezone: 'Asia/Kolkata' },
        deliveries: 2,
        feesEarnedMinor: 4500,
        collectedInCashMinor: 2000,
        creditedToWalletMinor: 2500,
        reimbursedDirectlyMinor: 3000,
      });
      // The two halves are the whole.
      expect(e.collectedInCashMinor + e.creditedToWalletMinor).toBe(e.feesEarnedMinor);

      expect(e.wallet).toMatchObject({
        balanceMinor: 7500,
        minWithdrawalMinor: 10000,
        meetsMinimum: false,
        pendingWithdrawals: 0,
        pendingWithdrawalMinor: 0,
      });
      expect(e.withdrawals.status).toBe('NOT_AVAILABLE');
    });
  });

  it('is zeros for someone who has delivered nothing, and for a day with no deliveries', async () => {
    await inRolledBackTransaction(async (w) => {
      expect(await w.wallet.earnings(w.other, day)).toMatchObject({
        deliveries: 0, feesEarnedMinor: 0, collectedInCashMinor: 0, creditedToWalletMinor: 0,
        wallet: { balanceMinor: 99000, meetsMinimum: true },
      });
      expect(await w.wallet.earnings(w.rider, { from: '2026-03-11', to: '2026-03-11' })).toMatchObject({
        deliveries: 0, feesEarnedMinor: 0,
      });
    });
  });
});

describe('GET /wallet/withdrawals', () => {
  it("lists the caller's own requests, newest first, with the destination masked", async () => {
    await inRolledBackTransaction(async (w) => {
      await w.tx.withdrawalRequest.create({
        data: {
          userId: w.rider.userId, amountMinor: 2000, status: 'PAID', bankAccountLast4: '4321',
          bankIfsc: 'HDFC0001234', payoutReference: 'UTR123', createdAt: ist('10:00'), handledAt: ist('18:00'),
        },
      });
      await w.tx.withdrawalRequest.create({
        data: { userId: w.rider.userId, amountMinor: 3000, status: 'REQUESTED', upiId: 'ravi.kumar@okaxis', createdAt: ist('12:00') },
      });
      await w.tx.withdrawalRequest.create({
        data: { userId: w.other.userId, amountMinor: 50000, status: 'REQUESTED', upiId: 'someone@okbank' },
      });

      const list = await w.wallet.withdrawals(w.rider, {});

      expect(list.items.map((i) => [i.amountMinor, i.status])).toEqual([[3000, 'REQUESTED'], [2000, 'PAID']]);
      expect(list.items[0].destination).toEqual({ bankAccountLast4: null, upiIdMasked: 'ra********@okaxis' });
      expect(list.items[1]).toMatchObject({
        destination: { bankAccountLast4: '4321', upiIdMasked: null }, payoutReference: 'UTR123',
      });
      expect(list.canRequest).toBe(false);

      const everything = JSON.stringify(list);
      expect(everything).not.toContain('ravi.kumar');
      expect(everything).not.toContain('HDFC0001234');
      expect(everything).not.toContain('someone@okbank');

      // The pending one shows up beside the balance.
      expect((await w.wallet.earnings(w.rider, day)).wallet).toMatchObject({
        pendingWithdrawals: 1, pendingWithdrawalMinor: 3000,
      });
    });
  });
});

describe('reading the wallet writes nothing', () => {
  it('leaves the ledger and the withdrawal table exactly as they were', async () => {
    await inRolledBackTransaction(async (w) => {
      const count = async () => [
        await w.tx.walletEntry.count({ where: { userId: w.rider.userId } }),
        await w.tx.withdrawalRequest.count({ where: { userId: w.rider.userId } }),
      ];
      const before = await count();

      await w.wallet.statement(w.rider, {});
      await w.wallet.earnings(w.rider, day);
      await w.wallet.withdrawals(w.rider, {});

      expect(await count()).toEqual(before);
    });
  });
});

describe('maskUpiId', () => {
  it('keeps two characters and the handle, hides the rest', () => {
    expect(maskUpiId('ravi.kumar@okaxis')).toBe('ra********@okaxis');
    expect(maskUpiId('ab@upi')).toBe('ab***@upi');
    expect(maskUpiId('a@upi')).toBe('a***@upi');
    expect(maskUpiId(null)).toBeNull();
  });
});
