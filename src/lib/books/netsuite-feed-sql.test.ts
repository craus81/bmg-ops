// Books → NetSuite feed (src/app/api/admin/books/netsuite-feed,
// src/lib/books/netsuite-feed.ts) on migration 477's netsuite_sends, in an
// in-memory Postgres (PGlite) as the app's server login: what the table keeps
// and refuses, a send kept by the recorder from start to answer, the feed's
// summary, its list of sends to look for and its pages, and noting that a
// super admin looked for one in NetSuite. The reads and writes are built the
// way supabase-js builds them, PostgREST's or/and filters included. Made-up
// data.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';

const CRAIG = 'c0000000-0000-4000-8000-000000000001';
const JESSIE = 'b2c3d4e5-0000-4000-8000-00000000000a';
const ZACH = 'c0000000-0000-4000-8000-000000000003';

let roles = ['admin', 'super_admin'];
vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => roles.includes(r));
      return booksAllows(access, need) ? { ...{ user: { id: CRAIG, email: 'craig@example.com' }, profile: { full_name: 'Craig' } }, access } : { error: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) };
    }),
  };
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));

import { GET, POST } from '../../app/api/admin/books/netsuite-feed/route';
import { feedOutcome, readSends, readSummary, readToLook } from '@/lib/books/netsuite-feed';
import { NO_ANSWER_MS, netsuiteFetch, setSendWriter } from '@/lib/netsuite-sends';

const REST = 'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest';
const UI = 'https://1234567_SB1.app.netsuite.com/app';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let pg: PGlite;
/** A table whose reads and writes fail, as when the database can't be reached. */
let failing: string | null = null;
/** Runs just before a change is made, as another super admin's would. */
let beforeUpdate: (() => Promise<unknown>) | null = null;

/** A time as PostgREST gives it, an ISO string. */
const asApi = (rows: Array<Record<string, unknown>>) =>
  rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])));

/** A read of a table, or a change to one, built the way supabase-js builds it and run against the database. */
function from(table: string) {
  let columns = '*';
  let head = false;
  let single = false;
  let returning: string | null = null;
  let write: { kind: 'insert' | 'upsert' | 'update'; rows: Array<Record<string, unknown>> } | null = null;
  const where: string[] = [];
  const values: unknown[] = [];
  const orders: string[] = [];
  let range: [number, number] | null = null;
  let limit: number | null = null;
  const param = (value: unknown) => {
    values.push(value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value);
    return `$${values.length}`;
  };
  const column = (col: string) => {
    if (!/^[a-z_]+$/.test(col)) throw new Error(`No column ${col}`);
    return col;
  };
  const condition = (col: string, op: string, value: unknown) => {
    switch (op) {
      case 'eq': return `${column(col)} = ${param(value)}`;
      case 'lt': return `${column(col)} < ${param(value)}`;
      case 'gte': return `${column(col)} >= ${param(value)}`;
      case 'like': return `${column(col)} LIKE ${param(String(value).replace(/\*/g, '%'))}`;
      case 'is':
        if (value !== null && value !== 'null') throw new Error('only is null');
        return `${column(col)} IS NULL`;
      default: throw new Error(`No ${op} filter`);
    }
  };
  /** PostgREST's or(…) and and(…) filters: conditions joined at the top level, groups inside. */
  const logic = (text: string, joiner: 'OR' | 'AND'): string => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      else if (text[i] === ',' && depth === 0) {
        parts.push(text.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(text.slice(start));
    return `(${parts.map((part) => {
      const group = part.match(/^(and|or)\((.*)\)$/);
      if (group) return logic(group[2], group[1] === 'and' ? 'AND' : 'OR');
      const [, col, op, value] = part.match(/^([^.]+)\.([^.]+)\.(.*)$/) ?? [];
      if (!col) throw new Error(`Can't read the filter ${part}`);
      return condition(col, op, value);
    }).join(` ${joiner} `)})`;
  };
  const run = async (): Promise<{ data: any; error: { message: string } | null; count?: number | null }> => {
    if (failing === table) return { data: null, error: { message: `${table} failed` }, count: null };
    const filter = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    try {
      if (write?.kind === 'update') {
        await beforeUpdate?.();
        const sets = Object.entries(write.rows[0]).map(([col, value]) => `${column(col)} = ${param(value)}`);
        const r = await pg.query<Record<string, unknown>>(
          `UPDATE ${table} SET ${sets.join(', ')}${filter}${returning ? ` RETURNING ${returning}` : ''}`, values,
        );
        return { data: returning ? asApi(r.rows) : null, error: null };
      }
      if (write) {
        const cols = Object.keys(write.rows[0]).map(column);
        const placed = write.rows.map((row) => `(${cols.map((col) => param(row[col] ?? null)).join(', ')})`);
        const merge = write.kind === 'upsert' ? ` ON CONFLICT (id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}` : '';
        await pg.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${placed.join(', ')}${merge}`, values);
        return { data: null, error: null };
      }
      if (head) {
        const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}${filter}`, values);
        return { data: null, error: null, count: r.rows[0].n };
      }
      const r = await pg.query<Record<string, unknown>>(
        `SELECT ${columns} FROM ${table}${filter}${orders.length ? ` ORDER BY ${orders.join(', ')}` : ''}`
          + `${range ? ` LIMIT ${range[1] - range[0] + 1} OFFSET ${range[0]}` : ''}${limit !== null ? ` LIMIT ${limit}` : ''}`,
        values,
      );
      const data = asApi(r.rows);
      if (single) {
        return data.length > 1 ? { data: null, error: { message: 'More than one row' } } : { data: data[0] ?? null, error: null };
      }
      return { data, error: null };
    } catch (e: any) {
      return { data: null, error: { message: e.message } };
    }
  };
  const query: any = {
    select: (cols: string, opts?: { count?: string; head?: boolean }) => {
      if (write) returning = cols;
      else {
        columns = cols;
        head = !!opts?.head;
      }
      return query;
    },
    insert: (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
      write = { kind: 'insert', rows: Array.isArray(rows) ? rows : [rows] };
      return query;
    },
    upsert: (row: Record<string, unknown>, opts?: { onConflict?: string }) => {
      if (opts?.onConflict !== 'id') throw new Error('only on id');
      write = { kind: 'upsert', rows: [row] };
      return query;
    },
    update: (row: Record<string, unknown>) => { write = { kind: 'update', rows: [row] }; return query; },
    eq: (col: string, value: unknown) => { where.push(condition(col, 'eq', value)); return query; },
    is: (col: string, value: null) => { where.push(condition(col, 'is', value)); return query; },
    lt: (col: string, value: unknown) => { where.push(condition(col, 'lt', value)); return query; },
    gte: (col: string, value: unknown) => { where.push(condition(col, 'gte', value)); return query; },
    in: (col: string, list: unknown[]) => { where.push(`${column(col)} = ANY(${param(list)})`); return query; },
    or: (filters: string) => { where.push(logic(filters, 'OR')); return query; },
    order: (col: string, opts?: { ascending?: boolean }) => {
      orders.push(`${column(col)} ${opts?.ascending === false ? 'DESC' : 'ASC'}`);
      return query;
    },
    range: (start: number, end: number) => { range = [start, end]; return query; },
    limit: (n: number) => { limit = n; return query; },
    maybeSingle: () => { single = true; return query; },
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
  };
  return query;
}
const service = { from };

/** A send as the recorder keeps it; an answered one is answered two seconds on. */
async function send(n: number, row: Record<string, unknown> & { started_at: string }) {
  const full: Record<string, unknown> = {
    id: ID(n),
    method: 'POST',
    action: 'create',
    record_type: 'invoice',
    ...(row.outcome ? { finished_at: new Date(Date.parse(row.started_at) + 2000).toISOString() } : {}),
    ...row,
  };
  const cols = Object.keys(full);
  await pg.query(`INSERT INTO netsuite_sends (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => full[c]));
}

const get = async (params = '') => {
  const res = await GET(new NextRequest(`https://go.bmgfleet.com/api/admin/books/netsuite-feed${params ? `?${params}` : ''}`));
  return { status: res.status, body: await res.json() };
};
const post = async (body: unknown) => {
  const res = await POST(new NextRequest('https://go.bmgfleet.com/api/admin/books/netsuite-feed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};
const ids = (sends: Array<{ id: string }>) => sends.map((s) => s.id);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    CREATE TABLE public.profiles (id UUID PRIMARY KEY, full_name TEXT);
    CREATE TABLE public.audit_log (
      id BIGSERIAL PRIMARY KEY, actor_id UUID, table_name TEXT, record_id TEXT, action TEXT, detail JSONB
    );
  `);
  await pg.exec(readFileSync(path.resolve(__dirname, '../../../migrations/477-netsuite-sends.sql'), 'utf8'));
  await pg.query('INSERT INTO profiles (id, full_name) VALUES ($1, $2), ($3, $4), ($5, $6)', [CRAIG, 'Craig', JESSIE, 'Jessie', ZACH, 'Zach']);
  await pg.exec('SET ROLE service_role');
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(() => {
  vi.stubEnv('NETSUITE_ACCOUNT_ID', '1234567_SB1');
  roles = ['admin', 'super_admin'];
  failing = null;
  beforeUpdate = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('netsuite_sends (migration 477)', () => {
  it('keeps only what a send can be', async () => {
    const at = ago(HOUR);
    const bad: Array<Record<string, unknown>> = [
      { method: 'GET' },
      { action: 'read' },
      { record_type: '' },
      { outcome: 'took', finished_at: null },
      { finished_at: at },
      { outcome: 'maybe', finished_at: at },
      { made_id: '9001a' },
      { http_status: 600 },
      { error: 'x'.repeat(601) },
      { doc_ref: 'x'.repeat(121) },
      { looked_by: CRAIG },
      { looked_at: at, looked_note: 'x'.repeat(301) },
    ];
    for (const [i, fields] of bad.entries()) {
      await expect(send(900 + i, { started_at: at, ...fields }), JSON.stringify(fields)).rejects.toThrow(/violates check constraint/);
    }
    expect((await pg.query('SELECT id FROM netsuite_sends')).rows).toEqual([]);
  });

  it("is the server's alone: row security on, and no reading or writing it signed in", async () => {
    expect((await pg.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'netsuite_sends'")).rows).toEqual([{ relrowsecurity: true }]);
    for (const role of ['authenticated', 'anon']) {
      await pg.exec(`SET ROLE ${role}`);
      try {
        await expect(pg.query('SELECT id FROM netsuite_sends')).rejects.toThrow(/permission denied/);
        await expect(pg.query(`INSERT INTO netsuite_sends (id, method, action, record_type) VALUES ('${ID(990)}', 'POST', 'create', 'invoice')`))
          .rejects.toThrow(/permission denied/);
      } finally {
        await pg.exec('SET ROLE service_role');
      }
    }
  });

  it("makes the row when the answer lands before the start, and the late start can't change it", async () => {
    const started = ago(MIN);
    const row = { id: ID(980), started_at: started, method: 'POST', action: 'create', record_type: 'vendorBill', made_type: 'vendorBill', doc_ref: 'A-1001' };
    expect(await service.from('netsuite_sends').upsert(
      { ...row, finished_at: new Date().toISOString(), outcome: 'took', http_status: 204, made_id: '3101', error: null },
      { onConflict: 'id' },
    )).toEqual({ data: null, error: null });
    const late = await service.from('netsuite_sends').insert(row);
    expect(late.error?.message).toMatch(/duplicate key/);
    expect((await pg.query('SELECT outcome, made_id FROM netsuite_sends WHERE id = $1', [ID(980)])).rows).toEqual([{ outcome: 'took', made_id: '3101' }]);
    await pg.query('DELETE FROM netsuite_sends WHERE id = $1', [ID(980)]);
  });

  it("keeps what someone found when their profile goes", async () => {
    await send(981, { started_at: ago(DAY), outcome: 'unsure', http_status: 502, looked_at: ago(HOUR), looked_by: ZACH, looked_note: 'Not there' });
    await pg.exec('RESET ROLE');
    try {
      await pg.query('DELETE FROM profiles WHERE id = $1', [ZACH]);
    } finally {
      await pg.exec('SET ROLE service_role');
    }
    const { rows } = await pg.query<{ looked_by: string | null; looked_note: string; looked: boolean }>(
      'SELECT looked_by, looked_note, looked_at IS NOT NULL AS looked FROM netsuite_sends WHERE id = $1', [ID(981)],
    );
    expect(rows).toEqual([{ looked_by: null, looked_note: 'Not there', looked: true }]);
    await pg.query('DELETE FROM netsuite_sends WHERE id = $1', [ID(981)]);
  });

  it('holds a send FleetSuite makes, kept by the recorder from start to answer, without its body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VITEST', '');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204, headers: { Location: `${REST}/record/v1/invoice/9301` } })));
    setSendWriter(undefined);
    const answer = await netsuiteFetch(`${REST}/record/v1/invoice`, {
      method: 'POST', body: JSON.stringify({ externalId: 'fleetsuite-inv-77', memo: 'Private', entity: { id: '4001' } }),
    });
    expect(answer.status).toBe(204);
    const { rows } = await pg.query<Record<string, unknown>>(
      `SELECT method, action, record_type, record_id, made_type, made_id, doc_ref, outcome, http_status, error, user_id,
              finished_at >= started_at AS answered
       FROM netsuite_sends WHERE doc_ref = 'fleetsuite-inv-77'`,
    );
    expect(rows).toEqual([{
      method: 'POST', action: 'create', record_type: 'invoice', record_id: null, made_type: 'invoice', made_id: '9301',
      doc_ref: 'fleetsuite-inv-77', outcome: 'took', http_status: 204, error: null, user_id: null, answered: true,
    }]);
    expect(warn).not.toHaveBeenCalled();
    const all = (await pg.query('SELECT * FROM netsuite_sends WHERE doc_ref = $1', ['fleetsuite-inv-77'])).rows;
    expect(JSON.stringify(all)).not.toContain('Private');
    await pg.query("DELETE FROM netsuite_sends WHERE doc_ref = 'fleetsuite-inv-77'");
  });

  it("still sends when the table can't keep it, and says so only in the log", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VITEST', '');
    const answer = new Response(null, { status: 204 });
    vi.stubGlobal('fetch', vi.fn(async () => answer));
    setSendWriter(undefined);
    failing = 'netsuite_sends';
    expect(await netsuiteFetch(`${REST}/record/v1/invoice/9302`, { method: 'PATCH', body: '{}' })).toBe(answer);
    expect(warn).toHaveBeenCalledWith("[netsuite-sends] couldn't keep a send:", 'netsuite_sends failed');
    failing = null;
    expect((await pg.query("SELECT id FROM netsuite_sends WHERE record_id = '9302'")).rows).toEqual([]);
  });
});

describe('Books → NetSuite feed', () => {
  beforeAll(async () => {
    await send(1, { started_at: ago(HOUR), made_type: 'invoice', made_id: '9001', doc_ref: 'INV-1001', outcome: 'took', http_status: 204, user_id: JESSIE });
    await send(2, {
      started_at: ago(2 * HOUR), record_type: 'vendorBill', made_type: 'vendorBill', doc_ref: 'A-1001', outcome: 'refused', http_status: 400,
      error: 'Invalid account reference key •••.',
    });
    await send(3, {
      started_at: ago(3 * HOUR), method: 'PATCH', action: 'change', record_type: 'salesOrder', record_id: '4521', outcome: 'unsure',
      http_status: 503, error: 'Service unavailable', user_id: JESSIE,
    });
    await send(4, { started_at: ago(10 * MIN), action: 'change', record_type: 'item', record_id: '812' });
    await send(5, { started_at: ago(MIN), record_type: 'journalEntry', made_type: 'journalEntry', doc_ref: 'fleetsuite-je-41' });
    await send(6, {
      started_at: ago(DAY), method: 'PATCH', action: 'change', record_type: 'customer', record_id: '3001', outcome: 'unsure', http_status: 502,
      looked_at: ago(20 * HOUR), looked_by: CRAIG, looked_note: 'It was changed',
    });
    await send(7, { started_at: ago(8 * DAY), action: 'transform', record_type: 'salesOrder', record_id: '4400', made_type: 'invoice', made_id: '9100', outcome: 'took', http_status: 204 });
    await send(8, { started_at: ago(4 * HOUR), action: 'script', record_type: 'script', outcome: 'took', http_status: 200 });
    await send(9, { started_at: ago(5 * HOUR), method: 'DELETE', action: 'delete', record_type: 'contact', record_id: '88', outcome: 'took', http_status: 204 });
    await send(10, { started_at: ago(6 * HOUR), record_type: 'inventoryItem', made_type: 'inventoryItem', made_id: '815', outcome: 'took', http_status: 204 });
  });

  afterAll(async () => {
    await pg.query('DELETE FROM netsuite_sends WHERE id = ANY($1)', [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(ID)]);
  });

  it('is for whoever opens the books, and noting a look is not the CPA\'s', async () => {
    roles = ['admin'];
    expect((await get()).status).toBe(403);
    roles = ['cpa'];
    expect((await get()).status).toBe(200);
    expect((await post({ id: ID(3) })).status).toBe(403);
    expect((await pg.query('SELECT looked_at FROM netsuite_sends WHERE id = $1', [ID(3)])).rows).toEqual([{ looked_at: null }]);
  });

  it("shows the last week's count, the sends to look for, and every send newest first with what NetSuite answered", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ show: 'all', kind: null, page: 0, more: false, summary: { days: 7, took: 4, refused: 1, unsure: 3 } });
    expect(body.kinds.map((k: { key: string }) => k.key)).toContain('inventoryAdjustment');
    expect(ids(body.toLook)).toEqual([ID(4), ID(3)]);
    expect(ids(body.sends)).toEqual([5, 4, 1, 2, 3, 8, 9, 10, 6, 7].map(ID));
    const shown = Object.fromEntries(body.sends.map((s: { id: string }) => [s.id, s]));
    expect(shown[ID(1)]).toEqual({
      id: ID(1), at: expect.any(String), answeredAt: expect.any(String), what: 'New invoice', outcome: 'took', status: 204, error: null,
      docRef: 'INV-1001', netsuiteId: '9001', link: `${UI}/accounting/transactions/custinvc.nl?id=9001`, who: 'Jessie', looked: null,
    });
    expect(shown[ID(2)]).toMatchObject({ what: 'New bill', outcome: 'refused', error: 'Invalid account reference key •••.', netsuiteId: null, link: null, who: null });
    expect(shown[ID(3)]).toMatchObject({
      what: 'Change to a sales order', outcome: 'unsure', status: 503, netsuiteId: '4521', link: `${UI}/accounting/transactions/salesord.nl?id=4521`, who: 'Jessie',
    });
    expect(shown[ID(4)]).toMatchObject({ what: 'Change to an item', outcome: 'no_answer', answeredAt: null, link: `${UI}/common/item/item.nl?id=812` });
    expect(shown[ID(5)]).toMatchObject({ what: 'New journal entry', outcome: 'sending', docRef: 'fleetsuite-je-41', link: null });
    expect(shown[ID(6)]).toMatchObject({
      what: 'Change to a customer', outcome: 'unsure', link: `${UI}/common/entity/custjob.nl?id=3001`,
      looked: { at: expect.any(String), by: 'Craig', note: 'It was changed' },
    });
    expect(shown[ID(7)]).toMatchObject({ what: 'Invoice from a sales order', netsuiteId: '9100', link: `${UI}/accounting/transactions/custinvc.nl?id=9100` });
    expect(shown[ID(8)]).toMatchObject({ what: 'Request to the item script', link: null });
    expect(shown[ID(9)]).toMatchObject({ what: 'Deletion of a contact', netsuiteId: '88', link: null });
    expect(shown[ID(10)]).toMatchObject({ what: 'New item', link: `${UI}/common/item/item.nl?id=815` });
  });

  it('narrows the list to what NetSuite answered and to a kind of record, both at once', async () => {
    expect(ids((await get('show=took')).body.sends)).toEqual([1, 8, 9, 10, 7].map(ID));
    expect(ids((await get('show=refused')).body.sends)).toEqual([ID(2)]);
    expect(ids((await get('show=unsure')).body.sends)).toEqual([4, 3, 6].map(ID));
    expect(ids((await get('kind=item')).body.sends)).toEqual([4, 8, 10].map(ID));
    expect(ids((await get('kind=salesOrder')).body.sends)).toEqual([3, 7].map(ID));
    expect(ids((await get('kind=vendorBill&show=refused')).body.sends)).toEqual([ID(2)]);
    const both = await get('show=unsure&kind=item');
    expect(both.body).toMatchObject({ show: 'unsure', kind: 'item' });
    expect(ids(both.body.sends)).toEqual([ID(4)]);
    // The summary and the sends to look for stay whole.
    expect(both.body.summary).toMatchObject({ took: 4, refused: 1, unsure: 3 });
    expect(ids(both.body.toLook)).toEqual([ID(4), ID(3)]);
    const unknown = await get('show=maybe&kind=salesOrder%27%3B');
    expect(unknown.body).toMatchObject({ show: 'all', kind: null });
    expect(unknown.body.sends).toHaveLength(10);
  });

  it('pages 50 at a time, newest first, sends kept at the same moment in a steady order', async () => {
    const at = ago(2 * DAY);
    for (let n = 100; n < 145; n++) await send(n, { started_at: at, outcome: 'took', http_status: 204 });
    try {
      const first = await get();
      const second = await get('page=1');
      expect(first.body.sends).toHaveLength(50);
      expect(first.body.more).toBe(true);
      expect(second.body).toMatchObject({ page: 1, more: false });
      expect(second.body.sends).toHaveLength(5);
      const all = [...ids(first.body.sends), ...ids(second.body.sends)];
      const same = Array.from({ length: 45 }, (_, i) => ID(144 - i));
      expect(all).toEqual([5, 4, 1, 2, 3, 8, 9, 10, 6].map(ID).concat(same, [ID(7)]));
      expect((await get('page=-3')).body).toMatchObject({ page: 0, more: true });
      expect((await get('page=99999')).body).toMatchObject({ page: 1000, more: false, sends: [] });
    } finally {
      await pg.query('DELETE FROM netsuite_sends WHERE id = ANY($1)', [Array.from({ length: 45 }, (_, i) => ID(100 + i))]);
    }
  });

  it('counts a send without an answer as never heard back only once more than five minutes have gone, everywhere alike', async () => {
    const db = service as unknown as SupabaseClient;
    const now = new Date();
    const started_at = new Date(now.getTime() - NO_ANSWER_MS).toISOString();
    await send(150, { started_at, record_type: 'creditMemo', made_type: 'creditMemo' });
    try {
      const at = async (when: Date) => ({
        outcome: feedOutcome({ outcome: null, started_at }, when),
        toLook: ids(await readToLook(db, when)).includes(ID(150)),
        listed: ids((await readSends(db, { now: when, filter: 'unsure', kind: null, page: 0 })).rows).includes(ID(150)),
        counted: (await readSummary(db, when)).unsure,
      });
      expect(await at(now)).toEqual({ outcome: 'sending', toLook: false, listed: false, counted: 3 });
      expect(await at(new Date(now.getTime() + 1))).toEqual({ outcome: 'no_answer', toLook: true, listed: true, counted: 4 });
    } finally {
      await pg.query('DELETE FROM netsuite_sends WHERE id = $1', [ID(150)]);
    }
  });

  it("says plainly when the sends can't be read, and shows them without names when names can't be", async () => {
    failing = 'netsuite_sends';
    const broken = await get();
    expect(broken.status).toBe(500);
    expect(broken.body.error).toMatch(/^Couldn't (count|read) the sends.*: netsuite_sends failed$/);
    failing = 'profiles';
    const nameless = await get();
    expect(nameless.status).toBe(200);
    expect(nameless.body.sends).toHaveLength(10);
    expect(nameless.body.sends.every((s: { who: string | null }) => s.who === null)).toBe(true);
  });

  it('notes who looked for a send in NetSuite and what they found, once, and it leaves the list', async () => {
    expect(await post({ id: 'not-a-send' })).toMatchObject({ status: 400 });
    expect(await post({ id: ID(3), note: 'x'.repeat(301) })).toMatchObject({ status: 400 });
    expect(await post({ id: ID(999) })).toEqual({ status: 404, body: { error: "There's no such send." } });
    expect(await post({ id: ID(1) })).toEqual({ status: 409, body: { error: "NetSuite took this one, so there's nothing to look for." } });
    expect(await post({ id: ID(2) })).toEqual({ status: 409, body: { error: "NetSuite refused this one, so there's nothing to look for." } });
    expect(await post({ id: ID(5) })).toEqual({ status: 409, body: { error: "It's still on its way to NetSuite. Look again in a few minutes." } });
    expect(await post({ id: ID(6) })).toEqual({ status: 409, body: { error: 'Someone has already looked at this one.' } });
    failing = 'netsuite_sends';
    expect(await post({ id: ID(3) })).toEqual({ status: 500, body: { error: "Couldn't read the send: netsuite_sends failed" } });
    failing = null;
    expect((await pg.query('SELECT id FROM audit_log')).rows).toEqual([]);

    const looked = await post({ id: ID(3), note: '  SO4521 was changed in NetSuite  ' });
    expect(looked).toEqual({ status: 200, body: { id: ID(3), lookedAt: expect.any(String) } });
    expect((await pg.query('SELECT looked_by, looked_note, looked_at IS NOT NULL AS looked FROM netsuite_sends WHERE id = $1', [ID(3)])).rows)
      .toEqual([{ looked_by: CRAIG, looked_note: 'SO4521 was changed in NetSuite', looked: true }]);
    expect((await pg.query('SELECT actor_id, table_name, record_id, action, detail FROM audit_log')).rows).toEqual([{
      actor_id: CRAIG, table_name: 'netsuite_sends', record_id: ID(3), action: 'look_at_send', detail: { note: 'SO4521 was changed in NetSuite' },
    }]);
    expect(await post({ id: ID(3) })).toEqual({ status: 409, body: { error: 'Someone has already looked at this one.' } });

    const after = await get();
    expect(ids(after.body.toLook)).toEqual([ID(4)]);
    expect(after.body.sends.find((s: { id: string }) => s.id === ID(3)).looked).toEqual({ at: expect.any(String), by: 'Craig', note: 'SO4521 was changed in NetSuite' });

    // Someone else gets there between the read and the note: nothing is noted twice.
    beforeUpdate = () => pg.query('UPDATE netsuite_sends SET looked_at = now() WHERE id = $1', [ID(4)]);
    expect(await post({ id: ID(4), note: 'Not there' })).toEqual({ status: 409, body: { error: 'Someone has already looked at this one.' } });
    expect((await pg.query('SELECT looked_by, looked_note FROM netsuite_sends WHERE id = $1', [ID(4)])).rows).toEqual([{ looked_by: null, looked_note: null }]);
    expect((await pg.query('SELECT id FROM audit_log')).rows).toHaveLength(1);
    beforeUpdate = null;

    // A send that never heard back can be looked at too, and an empty note isn't kept.
    await pg.query('UPDATE netsuite_sends SET looked_at = NULL WHERE id = $1', [ID(4)]);
    expect(await post({ id: ID(4), note: '   ' })).toMatchObject({ status: 200 });
    expect((await pg.query('SELECT looked_by, looked_note FROM netsuite_sends WHERE id = $1', [ID(4)])).rows).toEqual([{ looked_by: CRAIG, looked_note: null }]);
    expect(ids((await get()).body.toLook)).toEqual([]);
  });
});
