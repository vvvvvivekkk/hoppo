import { PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_EXPORT_ROW_CAP,
  AuditLogController,
} from './audit.controller';
import { csvCell, csvLine } from './csv';
import { TenantService } from '../common/tenant/tenant.service';
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
 * A-15: the audit log as a CSV file. The CSV rules are tested on their own;
 * the route is tested against PostgreSQL (rolled back) with a stand-in for
 * the HTTP response that records what was sent.
 */

/** RFC 4180 reader, written independently of the writer under test. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

describe('CSV cells', () => {
  it('quotes every cell and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(csvCell('')).toBe('""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(new Date('2026-11-20T05:00:00.000Z'))).toBe('"2026-11-20T05:00:00.000Z"');
    expect(csvCell({ reason: 'x' })).toBe('"{""reason"":""x""}"');
  });

  it.each(['=1+1', '+1+1', '-1+1', '@SUM(A1)', '=HYPERLINK("http://evil","x")', '\t=1', '\r=1'])(
    'neutralises a cell a spreadsheet would run as a formula: %j',
    (value) => {
      const cell = csvCell(value);
      // Still quoted, and the content now starts with an apostrophe.
      expect(cell.startsWith(`"'`)).toBe(true);
      expect(parseCsv(cell)[0][0]).toBe(`'${value}`);
    },
  );

  it('leaves ordinary text alone, including a minus or @ that is not first', () => {
    for (const value of ['a=b', 'user@example.test', 're-activated', '2026-11-20', ' =1']) {
      expect(parseCsv(csvCell(value))[0][0]).toBe(value);
    }
  });

  it('round-trips awkward values through an independent parser, one record per line', () => {
    const cells = ['a,b', 'say "hi"', 'two\r\nlines', '', '{"k":"v, w"}'];
    const text = csvLine(cells) + csvLine(['next']);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(parseCsv(text)).toEqual([cells, ['next']]);
  });
});

const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
afterAll(() => db.$disconnect());

function fakeResponse() {
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const state = { status: 0, ended: false };
  const res = {
    status: (code: number) => {
      state.status = code;
      return res;
    },
    setHeader: (name: string, value: string) => {
      if (chunks.length > 0) throw new Error(`header ${name} set after the body started`);
      headers[name.toLowerCase()] = value;
    },
    write: (chunk: string) => {
      if (state.ended) throw new Error('write after end');
      chunks.push(chunk);
      return true;
    },
    end: () => {
      state.ended = true;
    },
  };
  return { res: res as unknown as Response, headers, chunks, state, body: () => chunks.join('') };
}

async function world(tx: Tx) {
  const tag = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const a = await makeCollege(tx, `${tag}-a`);
  const b = await makeCollege(tx, `${tag}-b`);
  const adminA = await makeUser(tx, a.id, 'ADMIN', { name: 'Admin, "A"' });
  const adminB = await makeUser(tx, b.id, 'ADMIN');
  const entry = (
    collegeId: string,
    actorId: string | null,
    action: string,
    targetId: string,
    minutesAgo: number,
    extra: { detail?: object; userAgent?: string } = {},
  ) =>
    tx.auditLog.create({
      data: {
        collegeId,
        actorId,
        action,
        targetType: 'user',
        targetId,
        detail: extra.detail,
        userAgent: extra.userAgent ?? null,
        ipAddress: '203.0.113.9',
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
      },
    });
  await entry(a.id, adminA.id, 'STUDENT_SUSPENDED', 'student-1', 30, {
    detail: { reason: '=HYPERLINK("http://evil.example","click")' },
    userAgent: '@SUM(1+1)',
  });
  await entry(a.id, null, 'TASK_ESCALATED', 'task-1', 20);
  await entry(a.id, adminA.id, 'STUDENT_REINSTATED', 'student-1', 10, {
    detail: { note: 'said "sorry", twice\nsecond line' },
  });
  await entry(b.id, adminB.id, 'SHOP_APPROVED', 'listing-9', 5);

  const controller = new AuditLogController(prismaOver(tx) as never, new TenantService());
  const as = (
    u: { id: string; collegeId: string | null },
    role: 'ADMIN' | 'SUPER_ADMIN' = 'ADMIN',
  ): AuthenticatedUser => ({ userId: u.id, collegeId: u.collegeId, role, isVerified: false });
  return { controller, a, b, adminA, adminB, as };
}

describe('GET /admin/audit-log/export against PostgreSQL', () => {
  jest.setTimeout(30_000);

  it("streams the administrator's own college as CSV, newest first, with a header row", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const out = fakeResponse();

      await w.controller.export(w.as(w.adminA), {}, out.res);

      expect(out.state).toEqual({ status: 200, ended: true });
      expect(out.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(out.headers['content-disposition']).toMatch(
        /^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      expect(out.headers['cache-control']).toBe('no-store');
      expect(out.headers).toMatchObject({
        'x-total-rows': '3',
        'x-exported-rows': '3',
        'x-row-cap': String(AUDIT_EXPORT_ROW_CAP),
        'x-truncated': 'false',
      });

      const rows = parseCsv(out.body());
      expect(rows[0]).toEqual([...AUDIT_EXPORT_COLUMNS]);
      const data = rows.slice(1);
      expect(data.map((r) => r[1])).toEqual([
        'STUDENT_REINSTATED',
        'TASK_ESCALATED',
        'STUDENT_SUSPENDED',
      ]);
      // Every row has every column, whatever was inside the cells.
      expect(data.every((r) => r.length === AUDIT_EXPORT_COLUMNS.length)).toBe(true);
      // Only this college (column 8), and none of the other college's rows.
      expect(new Set(data.map((r) => r[7]))).toEqual(new Set([w.a.id]));
      expect(out.body()).not.toContain('listing-9');
      expect(out.body()).not.toContain(w.b.id);

      // Quoting: a name with a comma and quotes, a detail with quotes and a newline.
      expect(data[0][5]).toBe('Admin, "A"');
      expect(JSON.parse(data[0][10])).toEqual({ note: 'said "sorry", twice\nsecond line' });
      // A system action has an empty actor, not the text "null".
      expect(data[1].slice(4, 7)).toEqual(['', '', '']);
      expect(data[1][10]).toBe('');
    });
  });

  it('neutralises formula-looking values that came from users', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const out = fakeResponse();

      await w.controller.export(w.as(w.adminA), { action: 'STUDENT_SUSPENDED' }, out.res);

      const [, row] = parseCsv(out.body());
      // The user agent began with "@": it now begins with an apostrophe.
      expect(row[9]).toBe(`'@SUM(1+1)`);
      // The detail is JSON, which starts with "{", so it is not a formula —
      // and the "=HYPERLINK" inside it is inert text within the JSON.
      expect(row[10].startsWith('{')).toBe(true);
      expect(JSON.parse(row[10])).toEqual({
        reason: '=HYPERLINK("http://evil.example","click")',
      });
      // No cell of the file starts with a formula character.
      for (const cells of parseCsv(out.body())) {
        for (const cell of cells) expect(/^[=+\-@\t\r]/.test(cell)).toBe(false);
      }
    });
  });

  it('applies the same filters as the list, and cannot be pointed at another college', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);

      const filtered = fakeResponse();
      await w.controller.export(w.as(w.adminA), { targetId: 'student-1' }, filtered.res);
      expect(parseCsv(filtered.body()).slice(1).map((r) => r[1])).toEqual([
        'STUDENT_REINSTATED',
        'STUDENT_SUSPENDED',
      ]);
      // The list, asked the same question, names the same rows.
      const listed = await w.controller.list(w.as(w.adminA), { targetId: 'student-1' });
      expect(listed.items.map((i) => i.action)).toEqual(['STUDENT_REINSTATED', 'STUDENT_SUSPENDED']);

      // College B's administrator asking for college A gets college B.
      const forced = fakeResponse();
      await w.controller.export(w.as(w.adminB), { collegeId: w.a.id }, forced.res);
      const rows = parseCsv(forced.body()).slice(1);
      expect(rows.map((r) => r[3])).toEqual(['listing-9']);
      expect(forced.headers['x-total-rows']).toBe('1');

      // And filtering on college A's target finds nothing: header row only.
      const empty = fakeResponse();
      await w.controller.export(w.as(w.adminB), { targetId: 'student-1' }, empty.res);
      expect(parseCsv(empty.body())).toEqual([[...AUDIT_EXPORT_COLUMNS]]);
      expect(empty.headers).toMatchObject({ 'x-total-rows': '0', 'x-exported-rows': '0' });
      expect(empty.state.ended).toBe(true);
    });
  });

  it('rejects a bad date range before sending anything', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const out = fakeResponse();

      await expect(
        w.controller.export(w.as(w.adminA), { from: '2026-11-21', to: '2026-11-20' }, out.res),
      ).rejects.toMatchObject({ response: { code: 'INVALID_DATE_RANGE' } });

      expect(out.chunks).toEqual([]);
      expect(out.headers).toEqual({});
      expect(out.state.ended).toBe(false);
    });
  });

  it('stops at the row cap, keeps the newest, and says it was truncated', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const w = await world(tx);
      const extra = 25;
      const base = Date.now() - 86_400_000;
      await tx.auditLog.createMany({
        data: Array.from({ length: AUDIT_EXPORT_ROW_CAP + extra }, (_, i) => ({
          collegeId: w.a.id,
          actorId: null,
          action: 'LOGIN_SUCCEEDED',
          targetType: 'bulk',
          // Zero-padded so the order is checkable: higher number = newer.
          targetId: `bulk-${String(i).padStart(6, '0')}`,
          createdAt: new Date(base + i * 1000),
        })),
      });
      const out = fakeResponse();

      await w.controller.export(w.as(w.adminA), { targetType: 'bulk' }, out.res);

      expect(out.headers).toMatchObject({
        'x-total-rows': String(AUDIT_EXPORT_ROW_CAP + extra),
        'x-exported-rows': String(AUDIT_EXPORT_ROW_CAP),
        'x-truncated': 'true',
      });
      const rows = parseCsv(out.body()).slice(1);
      expect(rows).toHaveLength(AUDIT_EXPORT_ROW_CAP);
      // Newest first: the first row is the last one created, and the oldest
      // `extra` rows are the ones left out.
      expect(rows[0][3]).toBe(`bulk-${String(AUDIT_EXPORT_ROW_CAP + extra - 1).padStart(6, '0')}`);
      expect(rows[rows.length - 1][3]).toBe(`bulk-${String(extra).padStart(6, '0')}`);
      // Each row once: batching neither repeats nor skips at a batch boundary.
      expect(new Set(rows.map((r) => r[3])).size).toBe(AUDIT_EXPORT_ROW_CAP);
      // Written in more than one piece: it was streamed, not built whole.
      expect(out.chunks.length).toBeGreaterThan(AUDIT_EXPORT_ROW_CAP);
    });
  });
});

describe('the export route', () => {
  it('is a GET under the administrators-only audit controller', () => {
    const handler = AuditLogController.prototype.export;
    expect(Reflect.getMetadata('roles', AuditLogController)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata('path', handler)).toBe('export');
    expect(Reflect.getMetadata('method', handler)).toBe(0); // RequestMethod.GET
  });
});
