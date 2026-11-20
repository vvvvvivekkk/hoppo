import { redisKeys, wsEvents } from '@hoppo/shared';
import { DispatchGateway } from '../dispatch.gateway';
import { DispatchService } from '../dispatch.service';

/**
 * Fakes for the dispatch and rider specs.
 *
 * Two rules shape them:
 *
 *  1. **The real classes run.** DispatchService, DispatchGateway and
 *     RiderService are the production ones; only the three edges are replaced
 *     — the database, Redis and the Socket.IO server.
 *
 *  2. **The database fake holds rows and honours `where`.** An earlier version
 *     answered `{ count: 1 }` to every `updateMany` whatever it was asked,
 *     which meant a spec could only notice a missing predicate by comparing
 *     the call's arguments to a copy of themselves. Mutation testing showed
 *     what that is worth: of twelve predicates deleted one at a time, eight
 *     left every test green. Here a write changes the rows its `where`
 *     matches and reports how many — so a conditional UPDATE that has lost a
 *     condition matches a row it should not have, and the spec fails on what
 *     happened next, the way production would.
 *
 * Nothing in here is specific to one spec. What a spec wants to be true, it
 * seeds as rows.
 */

export { wsEvents };

type Row = Record<string, any>;

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
 * Records every emit with the rooms it was addressed to. Mirrors the part of
 * Socket.IO's BroadcastOperator the gateway uses.
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

// ---------------------------------------------------------------------------
// Matching a Prisma `where` against a row
// ---------------------------------------------------------------------------

const OPERATORS = new Set(['equals', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'not']);

const isPlainObject = (v: unknown): v is Row =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** Dates compare by instant, everything else by identity. */
const comparable = (v: unknown): unknown => (v instanceof Date ? v.getTime() : v);

const same = (a: unknown, b: unknown): boolean => comparable(a ?? null) === comparable(b ?? null);

function matchesOperators(actual: unknown, ops: Row): boolean {
  return Object.entries(ops).every(([op, expected]) => {
    switch (op) {
      case 'equals':
        return same(actual, expected);
      case 'in':
        return (expected as unknown[]).some((e) => same(actual, e));
      case 'notIn':
        return !(expected as unknown[]).some((e) => same(actual, e));
      case 'not':
        return isPlainObject(expected) ? !matchesOperators(actual, expected) : !same(actual, expected);
      // SQL semantics: a comparison with NULL is never true.
      case 'lt':
        return actual != null && (comparable(actual) as number) < (comparable(expected) as number);
      case 'lte':
        return actual != null && (comparable(actual) as number) <= (comparable(expected) as number);
      case 'gt':
        return actual != null && (comparable(actual) as number) > (comparable(expected) as number);
      case 'gte':
        return actual != null && (comparable(actual) as number) >= (comparable(expected) as number);
      default:
        throw new Error(`fake database: unsupported where operator "${op}"`);
    }
  });
}

/**
 * Does `row` satisfy a Prisma `where`?
 *
 * Supports what the services under test send: equality (including `null`),
 * the comparison operators above, AND / OR / NOT, a relation filter matched
 * against a nested object on the row, and compound unique keys
 * (`taskId_round: { taskId, round }`). Anything else throws — a condition the
 * fake does not understand must never be mistaken for one that matched.
 */
export function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;

  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === 'AND') return [expected].flat().every((w) => matchesWhere(row, w));
    if (key === 'OR') return (expected as Row[]).some((w) => matchesWhere(row, w));
    if (key === 'NOT') return ![expected].flat().some((w) => matchesWhere(row, w));

    if (!isPlainObject(expected)) return same(row[key], expected);

    if (Object.keys(expected).every((k) => OPERATORS.has(k))) {
      return matchesOperators(row[key], expected);
    }
    // A relation filter: `riderState: { workModeOn: true }`.
    if (isPlainObject(row[key])) return matchesWhere(row[key], expected);
    // A compound unique key: `taskId_round: { taskId, round }`.
    if (key.includes('_') && !(key in row)) return matchesWhere(row, expected);
    // A filter on a relation the row does not have matches nothing.
    return false;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && 'increment' in value) row[key] = (row[key] ?? 0) + value.increment;
    else if (isPlainObject(value) && 'decrement' in value) row[key] = (row[key] ?? 0) - value.decrement;
    else if (isPlainObject(value) && 'set' in value) row[key] = value.set;
    else row[key] = value;
  }
}

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  const keys = [orderBy ?? []].flat().flatMap((o) => Object.entries(o as Row));
  return [...rows].sort((a, b) => {
    for (const [field, direction] of keys) {
      const [x, y] = [comparable(a[field]) as number, comparable(b[field]) as number];
      if (x !== y) return (x < y ? -1 : 1) * (direction === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// The tiny SQL the services send raw
// ---------------------------------------------------------------------------

const camel = (column: string) => column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

type Token = { kind: 'word' | 'string' | 'param' | 'number' | 'symbol'; text: string };

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const pattern =
    /\s+|'((?:[^']|'')*)'|\$(\d+)|(\d+)|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_.]*)|(::[a-z]+)|(<=|>=|<>|\|\||[=<>(),+*-])/gy;
  let match: RegExpExecArray | null;
  let at = 0;
  while (at < sql.length) {
    pattern.lastIndex = at;
    match = pattern.exec(sql);
    if (!match) throw new Error(`fake database: cannot read SQL at "${sql.slice(at, at + 30)}"`);
    at = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ kind: 'string', text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: 'param', text: match[2] });
    else if (match[3] !== undefined) tokens.push({ kind: 'number', text: match[3] });
    else if (match[4] !== undefined) tokens.push({ kind: 'word', text: match[4] });
    else if (match[5] !== undefined) tokens.push({ kind: 'word', text: match[5] });
    else if (match[7] !== undefined) tokens.push({ kind: 'symbol', text: match[7] });
    // Whitespace and `::text` casts carry no meaning here.
  }
  return tokens;
}

type Expr = (row: Row) => unknown;

/**
 * A recursive-descent reader for the handful of statements the services send
 * with `$executeRaw` / `$queryRaw`:
 *
 *   UPDATE "t" SET col = expr, ... WHERE expr [RETURNING expr AS "alias", ...]
 *   SELECT expr AS "alias", ... FROM "t" WHERE expr
 *
 * with AND / OR / parentheses, comparisons, IS [NOT] NULL, `now()`, `+`,
 * string and number literals, `$n` parameters, and a scalar subquery
 * `(SELECT col FROM "t" WHERE expr)`.
 *
 * It exists so the WHERE clause of a raw conditional UPDATE is *evaluated*
 * against the rows, like every other write here. Anything it cannot read
 * throws, loudly — an unparsed condition must never count as satisfied.
 */
class SqlReader {
  private at = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly params: unknown[],
    /** The rows of a table, by its SQL name — for a scalar subquery. */
    private readonly rowsOf: (table: string) => Row[] = () => [],
  ) {}

  peek(offset = 0): Token | undefined {
    return this.tokens[this.at + offset];
  }

  isWord(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.kind === 'word' && t.text.toUpperCase() === word;
  }

  isSymbol(symbol: string): boolean {
    const t = this.peek();
    return t?.kind === 'symbol' && t.text === symbol;
  }

  takeWord(word?: string): string {
    const t = this.tokens[this.at++];
    if (t?.kind !== 'word' || (word && t.text.toUpperCase() !== word)) {
      throw new Error(`fake database: expected ${word ?? 'a name'} in SQL, found "${t?.text}"`);
    }
    return t.text;
  }

  takeSymbol(symbol: string): void {
    const t = this.tokens[this.at++];
    if (t?.kind !== 'symbol' || t.text !== symbol) {
      throw new Error(`fake database: expected "${symbol}" in SQL, found "${t?.text}"`);
    }
  }

  done(): boolean {
    return this.at >= this.tokens.length;
  }

  expression(): Expr {
    let left = this.conjunction();
    while (this.isWord('OR')) {
      this.takeWord();
      const [a, b] = [left, this.conjunction()];
      left = (row) => Boolean(a(row)) || Boolean(b(row));
    }
    return left;
  }

  private conjunction(): Expr {
    let left = this.comparison();
    while (this.isWord('AND')) {
      this.takeWord();
      const [a, b] = [left, this.comparison()];
      left = (row) => Boolean(a(row)) && Boolean(b(row));
    }
    return left;
  }

  private comparison(): Expr {
    const left = this.sum();

    if (this.isWord('IS')) {
      this.takeWord();
      const negated = this.isWord('NOT');
      if (negated) this.takeWord();
      this.takeWord('NULL');
      return (row) => (left(row) == null) !== negated;
    }

    if (this.isWord('IN')) {
      this.takeWord();
      this.takeSymbol('(');
      const options = [this.sum()];
      while (this.isSymbol(',')) {
        this.takeSymbol(',');
        options.push(this.sum());
      }
      this.takeSymbol(')');
      return (row) => options.some((o) => same(left(row), o(row)));
    }

    const operator = this.peek();
    if (operator?.kind === 'symbol' && ['=', '<', '>', '<=', '>=', '<>'].includes(operator.text)) {
      this.at++;
      const right = this.sum();
      return (row) => {
        const [x, y] = [comparable(left(row)), comparable(right(row))];
        // SQL: any comparison with NULL is not true.
        if (x == null || y == null) return false;
        switch (operator.text) {
          case '=':
            return x === y;
          case '<>':
            return x !== y;
          case '<':
            return (x as number) < (y as number);
          case '>':
            return (x as number) > (y as number);
          case '<=':
            return (x as number) <= (y as number);
          default:
            return (x as number) >= (y as number);
        }
      };
    }

    return left;
  }

  private sum(): Expr {
    let left = this.primary();
    while (this.isSymbol('+')) {
      this.takeSymbol('+');
      const [a, b] = [left, this.primary()];
      left = (row) => (a(row) as number) + (b(row) as number);
    }
    return left;
  }

  private primary(): Expr {
    const t = this.tokens[this.at++];
    if (!t) throw new Error('fake database: SQL ended early');

    if (t.kind === 'symbol' && t.text === '(') {
      // A scalar subquery: `(SELECT col FROM "t" WHERE expr)`. Its columns
      // are the inner table's; it yields the first matching row's value, or
      // NULL when there is none — and a comparison with NULL is not true.
      if (this.isWord('SELECT')) {
        this.takeWord('SELECT');
        const value = this.sum();
        this.takeWord('FROM');
        const table = this.takeWord();
        this.takeWord('WHERE');
        const where = this.expression();
        this.takeSymbol(')');
        return () => {
          const match = this.rowsOf(table).find((row) => Boolean(where(row)));
          return match ? value(match) : null;
        };
      }
      const inner = this.expression();
      this.takeSymbol(')');
      return inner;
    }
    if (t.kind === 'param') {
      const value = this.params[Number(t.text) - 1];
      return () => value;
    }
    if (t.kind === 'string') return () => t.text;
    if (t.kind === 'number') return () => Number(t.text);
    if (t.kind === 'word') {
      if (t.text.toUpperCase() === 'NULL') return () => null;
      if (t.text.toLowerCase() === 'now') {
        this.takeSymbol('(');
        this.takeSymbol(')');
        return () => new Date();
      }
      return (row) => row[camel(t.text)];
    }
    throw new Error(`fake database: unexpected "${t.text}" in SQL`);
  }

  /** `expr [AS "alias"], ...` up to a keyword or the end. */
  projection(): { alias: string; value: Expr }[] {
    const columns: { alias: string; value: Expr }[] = [];
    do {
      if (columns.length > 0) this.takeSymbol(',');
      const first = this.peek();
      const value = this.expression();
      let alias = first?.kind === 'word' ? camel(first.text) : `column${columns.length}`;
      if (this.isWord('AS')) {
        this.takeWord();
        alias = this.takeWord();
      }
      columns.push({ alias, value });
    } while (this.isSymbol(','));
    return columns;
  }
}

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

/**
 * An in-memory database with Prisma's shape.
 *
 * `prisma.<model>.<method>` is a jest mock wrapped round a real
 * implementation over that model's rows, so a spec can both rely on the
 * behaviour and inspect (or, sparingly, override) a call.
 *
 * - `prisma.$seed(model, rows)` puts rows in. They are stored *by reference*,
 *   so a task row whose `order` is the same object as a row in the `order`
 *   table stays in step with it, the way a join would.
 * - Reads return shallow copies: a service holding a row it read earlier does
 *   not see later writes to it — which is exactly the stale read that the
 *   conditional UPDATEs exist to survive. `prisma.$staleRead(model, row)`
 *   makes the *next* `findUnique` on a model return a row the table no longer
 *   agrees with, which is what "somebody else committed in between" is.
 * - `$transaction` rolls every table back if its callback throws, and
 *   transactions run one at a time.
 * - `$executeRaw` / `$queryRaw` evaluate the SQL's WHERE against the rows
 *   (see SqlReader). The advisory wallet lock is recorded in `$locks`.
 */
export function fakePrisma(): any {
  const tables = new Map<string, Row[]>();
  const models = new Map<string, Record<string, jest.Mock>>();
  const staleReads = new Map<string, Row[]>();
  /** Unique keys, per model: an insert that repeats one is refused. */
  const uniques = new Map<string, string[][]>();
  const locks: string[] = [];
  let nextId = 1;

  const table = (name: string): Row[] => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  const implementations = (name: string): Record<string, (args: any) => unknown> => {
    const find = (where: Row | undefined) => table(name).filter((row) => matchesWhere(row, where));
    /** The existing row a new one would collide with on a declared unique key. */
    const collision = (data: Row): Row | undefined =>
      (uniques.get(name) ?? [])
        .map((fields) => table(name).find((row) => fields.every((f) => same(row[f], data[f]))))
        .find(Boolean);

    const insert = (data: Row) => {
      // As PostgreSQL does (P2002 through Prisma): a duplicate key fails the
      // INSERT. Only for models a spec has declared a key on with `$unique`.
      if (collision(data)) {
        throw new Error(`fake database: Unique constraint failed on ${name}`);
      }
      const row = { id: `${name}-${nextId++}`, ...data };
      table(name).push(row);
      return row;
    };

    return {
      findUnique: ({ where }) => {
        const stale = staleReads.get(name)?.shift();
        if (stale) return { ...stale };
        const [row] = find(where);
        return row ? { ...row } : null;
      },
      findUniqueOrThrow: ({ where }) => {
        const [row] = find(where);
        if (!row) throw new Error(`fake database: no ${name} matches ${JSON.stringify(where)}`);
        return { ...row };
      },
      findFirst: ({ where, orderBy } = {}) => {
        const [row] = sortRows(find(where), orderBy);
        return row ? { ...row } : null;
      },
      findMany: ({ where, orderBy, take, cursor, skip } = {}) => {
        let rows = sortRows(find(where), orderBy);
        // Cursor pagination as Prisma does it: start at the row the cursor
        // names (which must be in the result), then skip.
        if (cursor) {
          const at = rows.findIndex((row) => matchesWhere(row, cursor));
          rows = at === -1 ? [] : rows.slice(at);
        }
        return rows
          .slice(skip ?? 0)
          .slice(0, take ?? undefined)
          .map((row) => ({ ...row }));
      },
      count: ({ where } = {}) => find(where).length,
      // `groupBy` with `_count` of a field — as much of it as is used.
      groupBy: ({ by, where, _count }) => {
        const groups = new Map<string, { key: Row; rows: Row[] }>();
        for (const row of find(where)) {
          const key = Object.fromEntries((by as string[]).map((field) => [field, row[field]]));
          const id = JSON.stringify((by as string[]).map((field) => comparable(row[field])));
          if (!groups.has(id)) groups.set(id, { key, rows: [] });
          groups.get(id)!.rows.push(row);
        }
        return [...groups.values()].map(({ key, rows }) => ({
          ...key,
          ...(_count
            ? {
                _count: Object.fromEntries(
                  Object.keys(_count).map((field) => [field, rows.filter((r) => r[field] != null).length]),
                ),
              }
            : {}),
        }));
      },
      create: ({ data }) => ({ ...insert(data) }),
      createMany: ({ data, skipDuplicates }) => {
        let count = 0;
        for (const item of [data].flat() as Row[]) {
          // ON CONFLICT DO NOTHING. A duplicate is a collision on a declared
          // unique key; for a model with none declared, a row already
          // carrying every value the new one would.
          const duplicate = uniques.has(name) ? collision(item) !== undefined : find(item).length > 0;
          if (skipDuplicates && duplicate) continue;
          insert(item);
          count++;
        }
        return { count };
      },
      update: ({ where, data }) => {
        const [row] = find(where);
        // As Prisma does (P2025): an `update` that matches nothing throws.
        if (!row) throw new Error(`fake database: no ${name} to update for ${JSON.stringify(where)}`);
        applyData(row, data);
        return { ...row };
      },
      updateMany: ({ where, data }) => {
        const rows = find(where);
        for (const row of rows) applyData(row, data);
        return { count: rows.length };
      },
      upsert: ({ where, update, create }) => {
        const [row] = find(where);
        if (!row) return { ...insert(create) };
        applyData(row, update);
        return { ...row };
      },
      deleteMany: ({ where } = {}) => {
        const doomed = new Set(find(where));
        tables.set(name, table(name).filter((row) => !doomed.has(row)));
        return { count: doomed.size };
      },
    };
  };

  const model = (name: string) => {
    if (!models.has(name)) {
      const impl = implementations(name);
      const methods: Record<string, jest.Mock> = {};
      models.set(
        name,
        new Proxy(methods, {
          get(target, method: string) {
            if (!(method in target)) {
              const run = impl[method];
              target[method] = jest.fn(async (args: any) => {
                if (!run) throw new Error(`fake database: ${name}.${method} is not implemented`);
                return run(args);
              });
            }
            return target[method];
          },
        }),
      );
    }
    return models.get(name)!;
  };

  /** Run one raw statement against the rows. */
  const raw = (strings: TemplateStringsArray | string[], values: unknown[]): { count: number; rows: Row[] } => {
    const sql = strings.reduce((text, part, i) => `${text}$${i}${part}`);

    if (/pg_advisory_xact_lock/.test(sql)) {
      locks.push(String(values[0]));
      return { count: 1, rows: [] };
    }

    // SQL names tables in snake_case; the models here are camelCase.
    const reader = new SqlReader(tokenize(sql), values, (name) => table(camel(name)));
    const project = (columns: { alias: string; value: Expr }[], row: Row) =>
      Object.fromEntries(columns.map((c) => [c.alias, c.value(row)]));

    if (reader.isWord('UPDATE')) {
      reader.takeWord('UPDATE');
      const rows = table(camel(reader.takeWord()));
      reader.takeWord('SET');

      const assignments: { column: string; value: Expr }[] = [];
      do {
        if (assignments.length > 0) reader.takeSymbol(',');
        const column = camel(reader.takeWord());
        reader.takeSymbol('=');
        assignments.push({ column, value: reader.expression() });
      } while (reader.isSymbol(','));

      reader.takeWord('WHERE');
      const where = reader.expression();
      const returning = reader.isWord('RETURNING') ? (reader.takeWord(), reader.projection()) : null;
      if (!reader.done()) throw new Error(`fake database: unread SQL after "${reader.peek()?.text}"`);

      const matched = rows.filter((row) => Boolean(where(row)));
      for (const row of matched) {
        // Every right-hand side sees the row as it was, as in SQL.
        const next = assignments.map((a) => [a.column, a.value(row)] as const);
        for (const [column, value] of next) row[column] = value;
      }
      return { count: matched.length, rows: returning ? matched.map((row) => project(returning, row)) : [] };
    }

    if (reader.isWord('SELECT')) {
      reader.takeWord('SELECT');
      const columns = reader.projection();
      reader.takeWord('FROM');
      const rows = table(camel(reader.takeWord()));
      reader.takeWord('WHERE');
      const where = reader.expression();
      if (!reader.done()) throw new Error(`fake database: unread SQL after "${reader.peek()?.text}"`);

      const matched = rows.filter((row) => Boolean(where(row)));
      return { count: matched.length, rows: matched.map((row) => project(columns, row)) };
    }

    throw new Error(`fake database: cannot run SQL: ${sql.trim().slice(0, 60)}`);
  };

  const root: Record<string, unknown> = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => raw(strings, values).count),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => raw(strings, values).rows),
    $locks: locks,
    $seed: <T extends Row>(name: string, rows: T[]): T[] => {
      table(name).push(...rows);
      return rows;
    },
    $rows: (name: string): Row[] => table(name),
    /** Declare a unique key on a model, e.g. `$unique('riderPresenceHour', ['userId', 'hourStart'])`. */
    $unique: (name: string, fields: string[]) => {
      uniques.set(name, [...(uniques.get(name) ?? []), fields]);
    },
    $staleRead: (name: string, row: Row) => {
      staleReads.set(name, [...(staleReads.get(name) ?? []), row]);
    },
  };

  const prisma: any = new Proxy(root, {
    get(target, prop: string | symbol) {
      // Not thenable: `await prisma` must not go looking for a model "then".
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (prop in target) return target[prop];
      return model(prop);
    },
  });

  // Transactions run one at a time. Two that interleaved here would see each
  // other's uncommitted writes, and a rollback would undo both — neither of
  // which a real database allows. Serialising them is the honest
  // approximation: it cannot reproduce a race (that is what the live
  // harnesses in apps/api/test are for), but it never invents one either.
  let queue: Promise<unknown> = Promise.resolve();

  root.$transaction = jest.fn((fn: (tx: unknown) => unknown) => {
    const run = queue.then(() => transact(fn));
    queue = run.catch(() => undefined);
    return run;
  });

  const transact = async (fn: (tx: unknown) => unknown) => {
    // Remember every row, by identity and by content, so a throw puts both
    // the membership of each table and the contents of each row back.
    const before = [...tables].map(
      ([name, rows]) => [name, rows.map((row) => [row, { ...row }] as const)] as const,
    );
    try {
      return await fn(prisma);
    } catch (error) {
      for (const [name, rows] of before) {
        tables.set(
          name,
          rows.map(([row, copy]) => {
            for (const key of Object.keys(row)) delete row[key];
            return Object.assign(row, copy);
          }),
        );
      }
      for (const name of tables.keys()) {
        if (!before.some(([known]) => known === name)) tables.set(name, []);
      }
      throw error;
    }
  };

  return prisma;
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * RedisService over in-memory sets with TTLs — enough of the raw client for
 * the offered-riders set. `down()` makes every raw-client command reject, the
 * way an unreachable Redis does.
 */
export function fakeRedis() {
  const sets = new Map<string, Set<string>>();
  const ttls = new Map<string, number>();
  let failing = false;
  /** How many more raw-client calls fail as if the connection had dropped. */
  let failingCalls = 0;
  /** Commands that currently fail *inside* a pipeline, and for how many more calls. */
  const failingCommands = new Map<string, number>();

  const guard = () => {
    if (failingCalls > 0) {
      failingCalls--;
      throw new Error('read ECONNRESET');
    }
    if (failing) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
  };

  const pipeline = () => {
    const queued: { command: string; run: () => unknown }[] = [];
    const queue = (command: string, run: () => unknown) => (queued.push({ command, run }), chain);
    const chain: any = {
      del: (key: string) => queue('del', () => (ttls.delete(key), sets.delete(key) ? 1 : 0)),
      sadd: (key: string, ...members: string[]) =>
        queue('sadd', () => {
          if (!sets.has(key)) sets.set(key, new Set());
          for (const member of members) sets.get(key)!.add(member);
          return members.length;
        }),
      expire: (key: string, seconds: number) =>
        queue('expire', () => (sets.has(key) ? (ttls.set(key, seconds), 1) : 0)),
      exists: (key: string) => queue('exists', () => (sets.has(key) ? 1 : 0)),
      sismember: (key: string, member: string) =>
        queue('sismember', () => (sets.get(key)?.has(member) ? 1 : 0)),
      // As ioredis does: `exec` rejects only when the connection is gone. A
      // command that fails on the server does not reject — it comes back as
      // `[error, null]` in its own slot, and the commands around it still ran.
      exec: async () => {
        guard();
        return queued.map(({ command, run }) => {
          const left = failingCommands.get(command) ?? 0;
          if (left > 0) {
            failingCommands.set(command, left - 1);
            return [new Error(`READONLY You can't write against a read only replica. (${command})`), null];
          }
          return [null, run()];
        });
      },
    };
    return chain;
  };

  return {
    sets,
    ttls,
    /** Make Redis unreachable (or reachable again). */
    down: (isDown = true) => {
      failing = isDown;
    },
    /** Drop the connection for the next `calls` raw-client calls, then recover. */
    downFor: (calls: number) => {
      failingCalls = calls;
    },
    /**
     * Make one command fail *inside* pipelines — reported per entry, with
     * `exec` itself resolving — for the next `times` uses. `times = 0` heals.
     */
    failCommand: (command: string, times = Number.POSITIVE_INFINITY) => {
      failingCommands.set(command, times);
    },
    /**
     * Record `riderIds` as having been offered `taskId` in the search that
     * began at `search` (the task's `firstBroadcastAt`), as a broadcast
     * would. Without `search` the entries are plain — a list written by hand
     * for a task the dispatcher never broadcast.
     */
    offer: (taskId: string, riderIds: string[], search?: Date | null) => {
      const key = redisKeys.offeredRiders(taskId);
      const prefix = search ? `${search.getTime()}:` : '';
      if (!sets.has(key)) sets.set(key, new Set());
      for (const member of ['-', ...riderIds]) sets.get(key)!.add(`${prefix}${member}`);
      ttls.set(key, 86_400);
    },
    /**
     * Who one search of a task is recorded as offered to, without the
     * sentinel; null if that search has no record. `search` is the task's
     * `firstBroadcastAt` — omit it for a plain, unstamped list.
     */
    offeredTo: (taskId: string, search?: Date | null): string[] | null => {
      const prefix = search ? `${search.getTime()}:` : '';
      const members = sets.get(redisKeys.offeredRiders(taskId));
      if (!members?.has(`${prefix}-`)) return null;
      return [...members]
        .filter((m) => m.startsWith(prefix))
        .map((m) => m.slice(prefix.length))
        .filter((m) => m !== '-' && !m.includes(':'))
        .sort();
    },
    client: {
      smembers: jest.fn(async (key: string) => {
        guard();
        return [...(sets.get(key) ?? [])];
      }),
      multi: jest.fn(pipeline),
    },
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
 * that use this are also run against other revisions of these classes, whose
 * parameter lists differ; an arity mismatch must not be what fails there.
 */
export function buildDispatch(opts: { shopApproved?: boolean } = {}) {
  const prisma = fakePrisma();
  const redis = fakeRedis();
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
