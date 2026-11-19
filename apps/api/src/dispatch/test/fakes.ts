import { wsEvents } from '@hoppo/shared';
import { DispatchGateway } from '../dispatch.gateway';
import { DispatchService } from '../dispatch.service';

/**
 * Fakes for the dispatch and rider specs.
 *
 * These specs exist to pin behaviour that a code review accepted but nothing
 * executed. Two rules follow from that, and the fakes are built around them:
 *
 *  1. **The real classes run.** DispatchService and DispatchGateway are the
 *     production ones; only the three edges are replaced — the database, Redis
 *     and the Socket.IO server. An assertion about "who was told" is therefore
 *     an assertion about what the real gateway handed the real socket layer.
 *
 *  2. **The fakes do not know which implementation they are serving.** The
 *     Prisma fake answers any model and any method, so the same spec runs
 *     against the code before a fix and after it — which is the only way to
 *     show a spec fails on the old behaviour rather than on a missing mock.
 */

// ---------------------------------------------------------------------------
// Socket.IO server
// ---------------------------------------------------------------------------

export interface Emission {
  /** Every room the emit was addressed to. */
  rooms: string[];
  /** Rooms excluded with `.except()`. */
  except: string[];
  event: string;
  payload: any;
}

/**
 * Records every emit with the rooms it was addressed to.
 *
 * Mirrors the part of Socket.IO's BroadcastOperator the gateway uses:
 * `to`/`in` take a room or a list and accumulate, `except` excludes, `emit`
 * sends, `disconnectSockets` closes.
 */
export class FakeServer {
  readonly emissions: Emission[] = [];
  readonly disconnectedRooms: string[] = [];

  to(room: string | string[]) {
    return this.operator([room].flat(), []);
  }

  in(room: string | string[]) {
    return this.to(room);
  }

  private operator(rooms: string[], except: string[]) {
    return {
      to: (more: string | string[]) => this.operator([...rooms, ...[more].flat()], except),
      in: (more: string | string[]) => this.operator([...rooms, ...[more].flat()], except),
      except: (less: string | string[]) => this.operator(rooms, [...except, ...[less].flat()]),
      emit: (event: string, payload: unknown) => {
        this.emissions.push({ rooms, except, event, payload });
        return true;
      },
      disconnectSockets: () => {
        this.disconnectedRooms.push(...rooms);
      },
    };
  }

  /** Emissions of one event. */
  of(event: string): Emission[] {
    return this.emissions.filter((e) => e.event === event);
  }

  /** Every room one event was addressed to, flattened. */
  roomsFor(event: string): string[] {
    return this.of(event).flatMap((e) => e.rooms);
  }

  /** Emissions of any event that went to a `college:` room. */
  toCollegeRooms(): Emission[] {
    return this.emissions.filter((e) => e.rooms.some((r) => r.startsWith('college:')));
  }
}

export { wsEvents };

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

/**
 * What an unconfigured call returns, by method name. Chosen so that a
 * conditional write "matches one row" unless a spec says otherwise — the
 * interesting case in every spec is the one it configures explicitly.
 */
function defaultResult(method: string): unknown {
  switch (method) {
    case 'findMany':
      return [];
    case 'findUnique':
    case 'findFirst':
      return null;
    case 'count':
      return 0;
    case 'updateMany':
    case 'deleteMany':
    case 'createMany':
      return { count: 1 };
    default:
      // create / update / upsert / findUniqueOrThrow: a row with an id.
      return { id: 'fake-row' };
  }
}

/**
 * A Prisma stand-in: `prisma.<anyModel>.<anyMethod>` is a jest mock, created
 * on first touch and stable afterwards, so a spec can configure a call before
 * the code makes it and inspect it after.
 *
 * `$transaction(fn)` runs `fn` with the same object. That is deliberate: a
 * write made inside a transaction and one made outside it land on the same
 * mock, so "was this row ever deleted?" has one place to look.
 */
export function fakePrisma(): any {
  const models = new Map<string, Record<string, jest.Mock>>();

  const model = (name: string) => {
    if (!models.has(name)) {
      const methods: Record<string, jest.Mock> = {};
      models.set(
        name,
        new Proxy(methods, {
          get(target, method: string) {
            if (!(method in target)) {
              target[method] = jest.fn().mockResolvedValue(defaultResult(method));
            }
            return target[method];
          },
        }),
      );
    }
    return models.get(name)!;
  };

  const root: Record<string, unknown> = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };

  const prisma: any = new Proxy(root, {
    get(target, prop: string | symbol) {
      // Not thenable: `await prisma` must not try to call a mock named "then".
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (prop in target) return target[prop];
      return model(prop);
    },
  });

  root.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));

  return prisma;
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * RedisService, with the handful of raw-client commands the dispatcher uses
 * for the offered-riders set. `offered` is what SMEMBERS / SISMEMBER answer
 * from; leave it null for "no such key".
 */
export function fakeRedis(opts: { offered?: string[] | null } = {}) {
  const state = { offered: opts.offered ?? null };

  const pipeline = () => {
    const queued: (() => [null, unknown])[] = [];
    const chain: any = {
      del: jest.fn(() => (queued.push(() => [null, 1]), chain)),
      sadd: jest.fn((_key: string, ...members: string[]) => {
        client.saddCalls.push(members);
        return queued.push(() => [null, members.length]), chain;
      }),
      expire: jest.fn(() => (queued.push(() => [null, 1]), chain)),
      exists: jest.fn(() => (queued.push(() => [null, state.offered === null ? 0 : 1]), chain)),
      sismember: jest.fn((_key: string, member: string) => {
        return queued.push(() => [null, state.offered?.includes(member) ? 1 : 0]), chain;
      }),
      exec: jest.fn(async () => queued.map((run) => run())),
    };
    return chain;
  };

  const client = {
    saddCalls: [] as string[][],
    smembers: jest.fn(async () => state.offered ?? []),
    multi: jest.fn(pipeline),
  };

  return {
    state,
    client,
    findRidersNear: jest.fn().mockResolvedValue([]),
    getBusyRiders: jest.fn().mockResolvedValue([]),
    markRiderBusy: jest.fn().mockResolvedValue(undefined),
    markRiderFree: jest.fn().mockResolvedValue(undefined),
    removeRider: jest.fn().mockResolvedValue(undefined),
    setRiderPosition: jest.fn().mockResolvedValue(undefined),
    acquireLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * A real gateway and a real dispatcher over the fakes.
 *
 * The constructors are called through a loose signature because the specs
 * that use this are also run against older revisions of these classes, whose
 * parameter lists differ; an arity mismatch must not be what fails there.
 */
export function buildDispatch(opts: { offered?: string[] | null; shopApproved?: boolean } = {}) {
  const prisma = fakePrisma();
  const redis = fakeRedis({ offered: opts.offered });
  const server = new FakeServer();
  const shopAccess = { hasApprovedShop: jest.fn().mockResolvedValue(opts.shopApproved ?? true) };
  const jwt = { verifyAsync: jest.fn() };
  const config = { getOrThrow: jest.fn().mockReturnValue('test-secret') };

  const Gateway = DispatchGateway as unknown as new (...args: unknown[]) => DispatchGateway;
  const gateway = new Gateway(jwt, config, prisma, redis, shopAccess);
  gateway.server = server as never;

  const Service = DispatchService as unknown as new (...args: unknown[]) => DispatchService;
  const service = new Service(prisma, redis, gateway);

  return { prisma, redis, server, gateway, service, jwt, shopAccess };
}
