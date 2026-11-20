import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { presenceHour, recordRiderPresence } from '../dispatch/rider-presence';
import { buildDispatch } from '../dispatch/test/fakes';
import { RiderPresenceQueryDto } from './dto/presence.dto';
import { RiderPresenceController } from './presence.controller';
import { MAX_PRESENCE_RANGE_HOURS, RiderPresenceService } from './presence.service';
import { RiderService } from './rider.service';

/**
 * FR-ADM-05, "active riders by hour": what is written, by which paths, and
 * what the dashboard is told.
 *
 * The real gateway, RiderService and RiderPresenceService over the in-memory
 * database (../dispatch/test/fakes), with the table's primary key declared —
 * so an insert that repeats (rider, hour) fails unless it is the kind that
 * skips duplicates, as it would in PostgreSQL.
 */

beforeAll(() => {
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

const rider: AuthenticatedUser = { userId: 'rider-1', collegeId: 'col-1', role: 'STUDENT', isVerified: true };
const admin: AuthenticatedUser = { userId: 'admin-1', collegeId: 'col-1', role: 'ADMIN', isVerified: true };
const foreignAdmin: AuthenticatedUser = { userId: 'admin-9', collegeId: 'col-2', role: 'ADMIN', isVerified: true };
const superAdmin: AuthenticatedUser = { userId: 'root', collegeId: null, role: 'SUPER_ADMIN', isVerified: true };

const utc = (iso: string) => new Date(iso);

function build() {
  const ctx = buildDispatch();
  ctx.prisma.$unique('riderPresenceHour', ['userId', 'hourStart']);
  ctx.prisma.$seed('collegeConfig', [{ collegeId: 'col-1', riderPingIntervalSeconds: 15 }]);

  const tenant = new TenantService();
  const Rider = RiderService as unknown as new (...args: unknown[]) => RiderService;
  const riders = new Rider(ctx.prisma, ctx.redis, { record: jest.fn() }, {}, tenant, ctx.service, ctx.gateway);
  const presence = new RiderPresenceService(ctx.prisma, tenant);

  const rows = () =>
    ctx.prisma
      .$rows('riderPresenceHour')
      .map((r: any) => `${r.collegeId} ${r.userId} ${r.hourStart.toISOString()}`);

  return { ...ctx, riders, presence, rows };
}

/** The clock, for the code under test. */
function at(iso: string) {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'], now: utc(iso) });
}
afterEach(() => jest.useRealTimers());

// ===========================================================================
// The hour
// ===========================================================================

describe('presenceHour', () => {
  it.each([
    ['2026-11-20T10:00:00.000Z', '2026-11-20T10:00:00.000Z'],
    ['2026-11-20T10:00:00.001Z', '2026-11-20T10:00:00.000Z'],
    ['2026-11-20T10:59:59.999Z', '2026-11-20T10:00:00.000Z'],
    ['2026-11-20T23:30:00.000Z', '2026-11-20T23:00:00.000Z'],
  ])('%s belongs to the hour starting %s', (instant, hour) => {
    expect(presenceHour(utc(instant))).toEqual(utc(hour));
  });

  it('is a UTC hour, not an Indian one', () => {
    // 10:15 IST is 04:45 UTC. Truncating in local time would give 04:30 UTC —
    // which the table's on-the-hour CHECK refuses.
    expect(presenceHour(utc('2026-11-20T10:15:00+05:30'))).toEqual(utc('2026-11-20T04:00:00.000Z'));
  });
});

// ===========================================================================
// The write
// ===========================================================================

describe('recordRiderPresence', () => {
  it('writes one row for the rider\'s college and the current hour', async () => {
    const world = build();

    await recordRiderPresence(world.prisma, 'col-1', 'rider-1', utc('2026-11-20T10:42:07.123Z'));

    expect(world.rows()).toEqual(['col-1 rider-1 2026-11-20T10:00:00.000Z']);
  });

  it('is idempotent: any number of calls in one hour leave one row', async () => {
    const world = build();

    for (const minute of ['00', '15', '59']) {
      await recordRiderPresence(world.prisma, 'col-1', 'rider-1', utc(`2026-11-20T10:${minute}:00Z`));
    }

    expect(world.rows()).toHaveLength(1);
  });

  it('is idempotent under concurrent pings — the database decides, there is no read first', async () => {
    // A socket ping and an HTTP ping at the same instant, on two instances.
    const world = build();
    const when = utc('2026-11-20T10:42:00Z');

    await Promise.all(
      Array.from({ length: 12 }, () => recordRiderPresence(world.prisma, 'col-1', 'rider-1', when)),
    );

    expect(world.rows()).toEqual(['col-1 rider-1 2026-11-20T10:00:00.000Z']);
    // The repeats were *skipped* by the database, not refused by it: a plain
    // INSERT would leave one row too, but only by failing eleven times —
    // eleven warnings in the log, and an aborted transaction for any caller
    // that had one open.
    expect(Logger.prototype.warn).not.toHaveBeenCalledWith(expect.stringMatching(/presence/i));
    for (const call of world.prisma.riderPresenceHour.createMany.mock.results) {
      await expect(call.value).resolves.toEqual({ count: expect.any(Number) });
    }
    // Nothing is looked up to decide whether to insert.
    expect(world.prisma.riderPresenceHour.findFirst).not.toHaveBeenCalled();
    expect(world.prisma.riderPresenceHour.findUnique).not.toHaveBeenCalled();
    expect(world.prisma.riderPresenceHour.count).not.toHaveBeenCalled();
  });

  it('writes a new row when the hour turns, and one per rider', async () => {
    const world = build();

    await recordRiderPresence(world.prisma, 'col-1', 'rider-1', utc('2026-11-20T10:59:59Z'));
    await recordRiderPresence(world.prisma, 'col-1', 'rider-1', utc('2026-11-20T11:00:00Z'));
    await recordRiderPresence(world.prisma, 'col-1', 'rider-2', utc('2026-11-20T11:00:01Z'));

    expect(world.rows()).toEqual([
      'col-1 rider-1 2026-11-20T10:00:00.000Z',
      'col-1 rider-1 2026-11-20T11:00:00.000Z',
      'col-1 rider-2 2026-11-20T11:00:00.000Z',
    ]);
  });

  it('stores presence only — no position', async () => {
    const world = build();

    await recordRiderPresence(world.prisma, 'col-1', 'rider-1', utc('2026-11-20T10:42:00Z'));

    const { id: _id, ...row } = world.prisma.$rows('riderPresenceHour')[0];
    expect(Object.keys(row).sort()).toEqual(['collegeId', 'hourStart', 'userId']);
  });

  it('never throws: a statistic must not fail a ping', async () => {
    const world = build();
    world.prisma.riderPresenceHour.createMany.mockRejectedValue(new Error('relation does not exist'));

    await expect(recordRiderPresence(world.prisma, 'col-1', 'rider-1')).resolves.toBeUndefined();
  });
});

// ===========================================================================
// The paths that write it
// ===========================================================================

describe('going online', () => {
  it('records the rider as present in this hour', async () => {
    at('2026-11-20T10:42:00Z');
    const world = build();
    world.prisma.$seed('studentProfile', [
      { userId: 'rider-1', verificationStatus: 'VERIFIED', riderTermsAcceptedAt: new Date(), riderTermsVersion: 'CURRENT' },
    ]);
    // Whatever the current terms version is, this rider has accepted it.
    const { RIDER_TERMS_VERSION } = jest.requireActual('@hoppo/shared');
    world.prisma.$rows('studentProfile')[0].riderTermsVersion = RIDER_TERMS_VERSION;

    await world.riders.setWorkMode(rider, { enabled: true, latitude: 17.42, longitude: 78.65 } as never);

    expect(world.rows()).toEqual(['col-1 rider-1 2026-11-20T10:00:00.000Z']);
  });

  it('records nothing when going offline', async () => {
    at('2026-11-20T10:42:00Z');
    const world = build();
    world.prisma.$seed('riderState', [{ userId: 'rider-1', workModeOn: true, activeTaskId: null }]);

    await world.riders.setWorkMode(rider, { enabled: false } as never);

    expect(world.rows()).toEqual([]);
  });
});

describe('the HTTP ping', () => {
  function online(lastPingAt: string | null) {
    const world = build();
    world.prisma.$seed('riderState', [
      { userId: 'rider-1', workModeOn: true, lastPingAt: lastPingAt ? utc(lastPingAt) : null },
    ]);
    return world;
  }

  it('records the first ping of a new hour', async () => {
    at('2026-11-20T11:00:05Z');
    const world = online('2026-11-20T10:59:50Z');

    await world.riders.ping(rider, 17.42, 78.65);

    expect(world.rows()).toEqual(['col-1 rider-1 2026-11-20T11:00:00.000Z']);
  });

  it('records a rider with no earlier ping at all', async () => {
    at('2026-11-20T11:20:00Z');
    const world = online(null);

    await world.riders.ping(rider, 17.42, 78.65);

    expect(world.rows()).toEqual(['col-1 rider-1 2026-11-20T11:00:00.000Z']);
  });

  it('does not insert again for later pings in the same hour', async () => {
    at('2026-11-20T11:00:05Z');
    const world = online('2026-11-20T10:59:50Z');

    await world.riders.ping(rider, 17.42, 78.65);
    for (const second of [20, 35, 50]) {
      jest.setSystemTime(utc(`2026-11-20T11:00:${second}Z`));
      await world.riders.ping(rider, 17.42, 78.65);
    }

    expect(world.rows()).toHaveLength(1);
    // One INSERT for the hour, not one per ping.
    expect(world.prisma.riderPresenceHour.createMany).toHaveBeenCalledTimes(1);
  });

  it('records nothing for a rider who is offline', async () => {
    at('2026-11-20T11:00:05Z');
    const world = online('2026-11-20T10:59:50Z');
    world.prisma.$rows('riderState')[0].workModeOn = false;

    await expect(world.riders.ping(rider, 17.42, 78.65)).rejects.toMatchObject({ status: 409 });

    expect(world.rows()).toEqual([]);
  });
});

describe('the socket ping', () => {
  const body = { latitude: 17.42, longitude: 78.65 };

  function online() {
    const world = build();
    world.prisma.$seed('riderState', [{ userId: 'rider-1', workModeOn: true, lastPingAt: null }]);
    const socket = () => ({
      data: { user: { userId: 'rider-1', collegeId: 'col-1', role: 'STUDENT' } } as Record<string, any>,
    });
    return { ...world, socket };
  }

  it('records the rider on the first ping of the connection', async () => {
    at('2026-11-20T10:42:00Z');
    const world = online();

    expect(await world.gateway.handleRiderPing(world.socket() as never, body)).toEqual({ ok: true });

    expect(world.rows()).toEqual(['col-1 rider-1 2026-11-20T10:00:00.000Z']);
  });

  it('inserts once an hour per socket, however many pings arrive', async () => {
    at('2026-11-20T10:00:00Z');
    const world = online();
    const client = world.socket();

    // A ping every fifteen seconds for an hour and a bit.
    for (let seconds = 0; seconds <= 3_630; seconds += 15) {
      jest.setSystemTime(new Date(utc('2026-11-20T10:00:00Z').getTime() + seconds * 1000));
      expect(await world.gateway.handleRiderPing(client as never, body)).toEqual({ ok: true });
    }

    expect(world.rows()).toEqual([
      'col-1 rider-1 2026-11-20T10:00:00.000Z',
      'col-1 rider-1 2026-11-20T11:00:00.000Z',
    ]);
    expect(world.prisma.riderPresenceHour.createMany).toHaveBeenCalledTimes(2);
  });

  it('leaves one row when the rider reconnects, or is on two devices, in the same hour', async () => {
    at('2026-11-20T10:42:00Z');
    const world = online();

    await world.gateway.handleRiderPing(world.socket() as never, body);
    await world.gateway.handleRiderPing(world.socket() as never, body);
    await world.riders.ping(rider, 17.42, 78.65);

    expect(world.rows()).toHaveLength(1);
  });

  it('records nothing for a ping that is refused', async () => {
    at('2026-11-20T10:42:00Z');
    const world = online();

    await world.gateway.handleRiderPing(world.socket() as never, { latitude: 9000, longitude: 0 });
    world.prisma.$rows('riderState')[0].workModeOn = false;
    await world.gateway.handleRiderPing(world.socket() as never, body);

    expect(world.rows()).toEqual([]);
  });
});

// ===========================================================================
// What the dashboard is told
// ===========================================================================

describe('GET /admin/riders/presence', () => {
  /** col-1: three riders across 10:00-12:00 UTC; col-2: one rider at 10:00. */
  function recorded() {
    const world = build();
    const seen = (collegeId: string, userId: string, hour: string) => ({
      collegeId,
      userId,
      hourStart: utc(`2026-11-20T${hour}:00:00Z`),
    });
    world.prisma.$seed('riderPresenceHour', [
      seen('col-1', 'rider-1', '09'),
      seen('col-1', 'rider-1', '10'),
      seen('col-1', 'rider-2', '10'),
      seen('col-1', 'rider-3', '10'),
      seen('col-1', 'rider-1', '12'),
      seen('col-2', 'rider-x', '10'),
    ]);
    return world;
  }

  const counts = (result: { hours: { hourStart: Date; activeRiders: number }[] }) =>
    result.hours.map((h) => [h.hourStart.toISOString().slice(11, 16), h.activeRiders]);

  it('counts the riders present in each hour of the range, zero where there were none', async () => {
    const world = recorded();

    const result = await world.presence.byHour(admin, '2026-11-20T10:00:00Z', '2026-11-20T13:00:00Z');

    expect(counts(result)).toEqual([
      ['10:00', 3],
      ['11:00', 0],
      ['12:00', 1],
    ]);
    expect(result.distinctRiders).toBe(3);
    expect(result.peak).toEqual({ hourStart: utc('2026-11-20T10:00:00Z'), activeRiders: 3 });
  });

  it('includes `from` and excludes `to`', async () => {
    const world = recorded();

    const result = await world.presence.byHour(admin, '2026-11-20T09:00:00Z', '2026-11-20T10:00:00Z');

    expect(counts(result)).toEqual([['09:00', 1]]);
    // The riders of the 10:00 hour are outside the range altogether.
    expect(result.distinctRiders).toBe(1);
    expect(result.peak).toEqual({ hourStart: utc('2026-11-20T09:00:00Z'), activeRiders: 1 });
  });

  it('widens a range that cuts through an hour to whole hours', async () => {
    const world = recorded();

    const result = await world.presence.byHour(admin, '2026-11-20T10:20:00Z', '2026-11-20T12:05:00Z');

    expect(result.from).toEqual(utc('2026-11-20T10:00:00Z'));
    expect(result.to).toEqual(utc('2026-11-20T13:00:00Z'));
    expect(counts(result)).toEqual([
      ['10:00', 3],
      ['11:00', 0],
      ['12:00', 1],
    ]);
  });

  it('accepts a range given in the college\'s own time zone', async () => {
    const world = recorded();

    // 15:30-16:30 IST is 10:00-11:00 UTC.
    const result = await world.presence.byHour(admin, '2026-11-20T15:30:00+05:30', '2026-11-20T16:30:00+05:30');

    expect(counts(result)).toEqual([['10:00', 3]]);
  });

  it('counts only the administrator\'s own college', async () => {
    const world = recorded();
    const range = ['2026-11-20T10:00:00Z', '2026-11-20T11:00:00Z'] as const;

    expect(counts(await world.presence.byHour(admin, ...range))).toEqual([['10:00', 3]]);
    expect(counts(await world.presence.byHour(foreignAdmin, ...range))).toEqual([['10:00', 1]]);
    expect((await world.presence.byHour(foreignAdmin, ...range)).distinctRiders).toBe(1);
  });

  it('gives a super administrator every college together', async () => {
    const world = recorded();

    const result = await world.presence.byHour(superAdmin, '2026-11-20T10:00:00Z', '2026-11-20T11:00:00Z');

    expect(counts(result)).toEqual([['10:00', 4]]);
  });

  it('says since when presence has been recorded, so "not recorded" is not read as "nobody"', async () => {
    const world = recorded();

    const result = await world.presence.byHour(admin, '2026-11-19T00:00:00Z', '2026-11-19T02:00:00Z');

    expect(counts(result)).toEqual([
      ['00:00', 0],
      ['01:00', 0],
    ]);
    expect(result.recordedSince).toEqual(utc('2026-11-20T09:00:00Z'));
    expect(result.peak).toBeNull();
  });

  it('reports recordedSince as null for a college with no presence at all', async () => {
    const world = build();

    const result = await world.presence.byHour(admin, '2026-11-20T10:00:00Z', '2026-11-20T11:00:00Z');

    expect(result).toMatchObject({ recordedSince: null, distinctRiders: 0, peak: null });
    expect(counts(result)).toEqual([['10:00', 0]]);
  });

  it('never says who', async () => {
    const world = recorded();

    const result = await world.presence.byHour(admin, '2026-11-20T09:00:00Z', '2026-11-20T13:00:00Z');

    expect(JSON.stringify(result)).not.toMatch(/rider-\d/);
  });

  it.each([
    ['`to` equal to `from`', '2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z', 'INVALID_RANGE'],
    ['`to` before `from`', '2026-11-20T10:00:00Z', '2026-11-20T09:00:00Z', 'INVALID_RANGE'],
    ['more than 92 days', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', 'RANGE_TOO_LONG'],
  ])('refuses %s', async (_name, from, to, code) => {
    const world = recorded();

    await expect(world.presence.byHour(admin, from, to)).rejects.toMatchObject({
      status: 400,
      response: { code },
    });
    expect(world.prisma.riderPresenceHour.groupBy).not.toHaveBeenCalled();
  });

  it('allows exactly the longest range', async () => {
    const world = build();
    const from = utc('2026-01-01T00:00:00Z');
    const to = new Date(from.getTime() + MAX_PRESENCE_RANGE_HOURS * 3_600_000);

    const result = await world.presence.byHour(admin, from.toISOString(), to.toISOString());

    expect(result.hours).toHaveLength(MAX_PRESENCE_RANGE_HOURS);
  });
});

describe('RiderPresenceQueryDto', () => {
  const errorsFor = async (query: object) =>
    (await validate(plainToInstance(RiderPresenceQueryDto, query))).map((e) => e.property).sort();

  it('accepts two ISO date-times', async () => {
    expect(await errorsFor({ from: '2026-11-20T00:00:00+05:30', to: '2026-11-21T00:00:00+05:30' })).toEqual([]);
  });

  it.each([
    ['both missing', {}, ['from', 'to']],
    ['`to` missing', { from: '2026-11-20T00:00:00Z' }, ['to']],
    ['not a date', { from: 'yesterday', to: '2026-11-21T00:00:00Z' }, ['from']],
    ['an impossible date', { from: '2026-02-30T00:00:00Z', to: '2026-11-21T00:00:00Z' }, ['from']],
  ])('refuses %s', async (_name, query, properties) => {
    expect(await errorsFor(query)).toEqual(properties);
  });
});

describe('RiderPresenceController', () => {
  function guardAllows(user: AuthenticatedUser): boolean {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => RiderPresenceController.prototype.byHour,
      getClass: () => RiderPresenceController,
    } as unknown as ExecutionContext;
    return new RolesGuard(new Reflector()).canActivate(context);
  }

  it('is restricted to ADMIN', () => {
    expect(Reflect.getMetadata(ROLES_KEY, RiderPresenceController)).toEqual(['ADMIN']);
    expect(guardAllows(admin)).toBe(true);
    expect(guardAllows(superAdmin)).toBe(true);
  });

  it.each(['STUDENT', 'SHOP_OWNER', 'SHOP_STAFF'] as const)('refuses a %s', (role) => {
    expect(() => guardAllows({ ...rider, role })).toThrow(ForbiddenException);
  });
});
