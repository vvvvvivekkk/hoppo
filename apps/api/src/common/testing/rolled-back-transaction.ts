import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Support for specs that must run real SQL (raw statements, row locks, CHECK
 * constraints) without leaving anything behind.
 *
 * `inRolledBackTransaction` opens one interactive transaction, hands the body
 * a stand-in for PrismaService backed by that transaction, and always rolls
 * back. A service under test that calls `prisma.$transaction(fn)` simply runs
 * `fn` on the same transaction.
 *
 * Used only by `*.int.spec.ts` files. It needs the development database
 * (DATABASE_URL, from the environment or apps/api/.env) and fails loudly
 * without one: a test that silently did not run is worse than a red one.
 */
export type Tx = Prisma.TransactionClient;

export function databaseUrl(): string {
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

/** What a service is given in place of PrismaService. */
export function prismaOver(tx: Tx): unknown {
  return new Proxy(tx as object, {
    get(target, prop, receiver) {
      if (prop === '$transaction') return (fn: (client: Tx) => Promise<unknown>) => fn(tx);
      if (prop === 'geodesicDistanceM') {
        // PrismaService's helper, which the transaction client does not have.
        return async (
          a: { latitude: number; longitude: number },
          b: { latitude: number; longitude: number },
        ) => {
          const rows = await tx.$queryRaw<{ m: number }[]>`
            SELECT hoppo_geodesic_distance_m(
              ${a.latitude}::double precision, ${a.longitude}::double precision,
              ${b.latitude}::double precision, ${b.longitude}::double precision
            ) AS m`;
          return Math.round(rows[0].m);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

export async function inRolledBackTransaction(
  db: PrismaClient,
  body: (tx: Tx) => Promise<void>,
): Promise<void> {
  let finished = false;
  let outcome: unknown = null;

  try {
    await db.$transaction(
      async (tx) => {
        await body(tx);
        finished = true;
        throw new Rollback();
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
  } catch (error) {
    outcome = error;
  }

  // Anything other than our own rollback is the real failure: rethrow it as
  // itself so the report shows the assertion or database error that happened.
  if (!(outcome instanceof Rollback)) throw outcome ?? new Error('The transaction committed');
  if (!finished) throw new Error('The transaction body did not run to its end');
}

/** A throwaway college with its config row and fee bands, inside `tx`. */
export async function makeCollege(tx: Tx, tag: string) {
  const college = await tx.college.create({
    data: {
      name: `A5 spec college ${tag}`,
      address: '1 Spec Road',
      city: 'Hyderabad',
      state: 'Telangana',
      latitude: 17.3045,
      longitude: 78.6188,
    },
  });
  await tx.collegeConfig.create({ data: { collegeId: college.id } });
  await tx.feeBand.createMany({
    data: [
      { collegeId: college.id, minDistanceM: 0, maxDistanceM: 1000, feeMinor: 2000 },
      { collegeId: college.id, minDistanceM: 1000, maxDistanceM: null, feeMinor: 3000 },
    ],
  });
  return college;
}

let serial = 0;

/** A throwaway user inside `tx`, with a mobile and email unique to this call. */
export async function makeUser(
  tx: Tx,
  collegeId: string | null,
  role: 'STUDENT' | 'ADMIN' | 'SUPER_ADMIN' | 'SHOP_OWNER',
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  serial += 1;
  const unique = `${Date.now()}${process.pid}${serial}`;
  return tx.user.create({
    data: {
      collegeId,
      role,
      name: `A5 spec ${role} ${serial}`,
      // Not a dialable number: the +999 prefix is unassigned.
      mobile: `+999${unique.slice(-11)}`,
      email: `a5-spec-${unique}@example.test`,
      passwordHash: 'not-a-real-hash',
      ...overrides,
    },
  });
}
