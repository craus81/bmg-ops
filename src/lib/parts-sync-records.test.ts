// The parts syncs once FleetSuite's record wins (part 49, src/lib/fleetsuite-records.ts): the hourly sync
// (syncPartsIncremental), Sync from NetSuite on the Parts page (src/app/api/parts/sync) and looking a part up
// (findOrMirrorPart) keep the number, names, description, purchase price, vendor and labor hours FleetSuite has for a
// part, NetSuite's filling a blank one, and note what NetSuite has instead. While it's off, NetSuite's comes over
// FleetSuite's as it always has. And both syncs write their parts in groups naming the same columns, so a part
// NetSuite has no labor for keeps FleetSuite's whatever else is in its batch. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  /** A table, or 'table:update', or 'rpc', that answers with an error. */
  failing: new Set<string>(),
  /** A read that answers with an error, by its table and what it asked for ('select:…', 'eq:column', …). */
  failRead: null as null | ((table: string, asked: string[]) => boolean),
  upserts: [] as Array<{ table: string; rows: Row[] }>,
  rpcs: [] as Array<{ fn: string; args: Row }>,
  opened: 0,
  heartbeats: [] as Row[],
  netsuite: {
    items: [] as Row[],
    costs: [] as Row[] | null,
    found: {} as Record<string, Row>,
  },
  nextId: 1,
}));

vi.mock('@/lib/netsuite', () => ({
  suiteqlQueryAll: vi.fn(async (q: string) => {
    if (/i\.cost AS purchase_price\s+FROM item i/.test(q)) {
      if (h.netsuite.costs === null) throw new Error('SuiteQL timed out');
      return h.netsuite.costs;
    }
    if (q.includes('i.itemid AS item_number')) return h.netsuite.items;
    return [];
  }),
  findItems: vi.fn(async (pns: string[]) => Object.fromEntries(pns.map((pn) => [pn.toUpperCase(), h.netsuite.found[pn.toUpperCase()]]).filter(([, v]) => v))),
  updateCustomer: vi.fn(),
  patchEntityRecord: vi.fn(),
  updateItemFields: vi.fn(),
}));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async (_s: unknown, _t: string, result: Row) => { h.heartbeats.push(result); return { ok: true }; }) }));
vi.mock('@/lib/part-category-sweep', () => ({ runCategorySweep: vi.fn(async () => ({ applied: 0 })) }));
vi.mock('@/lib/api-auth', () => ({ requireAdmin: vi.fn(async () => ({ user: { id: 'a0000000-0000-4000-8000-000000000001' } })) }));

/**
 * Just enough of supabase-js and PostgREST, really applying the filters. An upsert of several rows writes every
 * column any of them names, null where a row hasn't got it, as PostgREST does: the bug upsertPartRows keeps clear of.
 */
function service() {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const asked: string[] = [];
    let values: Row | null = null;
    let upserting: { list: Row[]; onConflict: string } | null = null;
    let inserted: Row | null = null;
    let head = false;
    let limit = Infinity;
    let range: [number, number] | null = null;
    const rows = () => (h.tables[table] ??= []);
    const run = (): { data: any; error: { message: string } | null; count?: number } => {
      if (h.failing.has(table)) return { data: null, error: { message: `${table} said no` } };
      if (upserting) {
        const { list, onConflict } = upserting;
        const columns = [...new Set(list.flatMap((r) => Object.keys(r)))];
        return {
          data: list.map((row) => {
            const full = Object.fromEntries(columns.map((c) => [c, c in row ? row[c] : null]));
            const existing = rows().find((r) => r[onConflict] === full[onConflict]);
            if (existing) return Object.assign(existing, full);
            const made = { id: `p-${h.nextId++}`, ...full };
            rows().push(made);
            return made;
          }),
          error: null,
        };
      }
      if (inserted) {
        const row = { id: `log-${h.nextId++}`, ...inserted };
        rows().push(row);
        return { data: [row], error: null };
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (values) {
        if (h.failing.has(`${table}:update`)) return { data: null, error: { message: `${table} said no` } };
        for (const r of hit) Object.assign(r, values);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (h.failRead?.(table, asked)) return { data: null, error: { message: `${table} said no` } };
      if (head) return { data: null, error: null, count: hit.length };
      const list = range ? hit.slice(range[0], range[1] + 1) : hit;
      return { data: list.slice(0, limit).map((r) => ({ ...r })), error: null };
    };
    const q: any = {
      select: (c?: string, o?: { head?: boolean }) => { head = o?.head === true; asked.push(`select:${c ?? '*'}`); return q; },
      insert: (row: Row) => { inserted = row; return q; },
      update: (v: Row) => { values = v; return q; },
      upsert: (payload: Row | Row[], opts: { onConflict: string }) => {
        const list = Array.isArray(payload) ? payload : [payload];
        h.upserts.push({ table, rows: list });
        upserting = { list, onConflict: opts.onConflict };
        return q;
      },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); asked.push(`eq:${c}`); return q; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return q; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      not: (c: string, op: string, v: unknown) => {
        if (op === 'is') filters.push((r) => (r[c] ?? null) !== v);
        else filters.push((r) => !String(v).replace(/[()]/g, '').split(',').includes(String(r[c])));
        return q;
      },
      or: (expr: string) => {
        const conds = expr.split(',').map((c) => c.split('.'));
        filters.push((r) => conds.some(([c, op, a]) => (op === 'not' ? r[c] != null : op === 'gt' ? Number(r[c]) > Number(a) : String(r[c]) === a)));
        return q;
      },
      ilike: (c: string, v: string) => {
        filters.push((r) => String(r[c] ?? '').toLowerCase() === v.replace(/\\([%_\\])/g, '$1').toLowerCase());
        asked.push(`ilike:${c}`);
        return q;
      },
      order: () => q,
      limit: (n: number) => { limit = n; return q; },
      range: (a: number, b: number) => { range = [a, b]; return q; },
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      single: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error ?? (r.data?.length ? null : { message: 'no rows' }) }; },
      then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(run()).then(done, failed),
    };
    return q;
  };
  return {
    from,
    rpc: async (fn: string, args: Row) => {
      h.rpcs.push({ fn, args });
      if (h.failing.has('rpc')) return { data: null, error: { message: 'deadlock' } };
      return { data: { opened: h.opened, closed: 0 }, error: null };
    },
  };
}

vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service() }));

import { syncPartsIncremental, upsertPartRows } from './parts-sync';
import { findOrMirrorPart } from './parts-mirror';
import { POST } from '../app/api/parts/sync/route';

/** A part as FleetSuite's catalog has it. */
const part = (over: Row = {}): Row => ({
  id: `part-${over.netsuite_id ?? '5001'}`, netsuite_id: '5001', item_number: 'C4-RA24-3', display_name: 'Class III hitch receiver',
  description: 'Receiver for 2-inch shank, 6,000 lb', purchase_price: 12.5, vendor: 'CURT Manufacturing', labor_hours: 1.5,
  is_generic: false, sales_price: 99, catalog_override: null, source: 'netsuite', is_active: true, image_path: 'parts/c4-ra24-3.jpg', ...over,
});

/** An item as NetSuite has it, renamed and repriced since. */
const item = (over: Row = {}): Row => ({
  id: '5001', item_number: 'C4-RA24-3B', display_name: 'Hitch receiver', description: 'Receiver', itemtype: 'InvtPart', isinactive: 'F',
  purchase_price: '14.25', labor_hours: '2', class_name: 'Upfit Parts', department_name: null, vendor_name: 'Curt Mfg', istaxable: 'T', ...over,
});

const switchedOn = (on: boolean) => { h.tables.books_switches = [{ piece: 'fleetsuite_records', is_on: on }]; };
const partRow = (id = '5001') => h.tables.netsuite_parts.find((r) => r.netsuite_id === id)!;
const noted = () => h.rpcs.filter((r) => r.fn === 'note_record_differences').flatMap((r) => r.args.p);

beforeEach(() => {
  h.tables = { sync_state: [], netsuite_parts: [part()], record_differences: [] };
  h.failing = new Set();
  h.failRead = null;
  h.upserts = [];
  h.rpcs = [];
  h.opened = 0;
  h.heartbeats = [];
  h.netsuite = { items: [item()], costs: [{ id: '5001', purchase_price: '14.25' }], found: {} };
  switchedOn(true);
});

describe('the hourly parts sync', () => {
  it("keeps FleetSuite's part and notes what NetSuite has instead", async () => {
    h.opened = 6;
    const result = await syncPartsIncremental(service() as any);
    expect(partRow()).toMatchObject({
      item_number: 'C4-RA24-3', display_name: 'Class III hitch receiver', description: 'Receiver for 2-inch shank, 6,000 lb',
      purchase_price: 12.5, vendor: 'CURT Manufacturing', labor_hours: 1.5,
      // What only NetSuite keeps still comes, and FleetSuite's own columns are left alone.
      item_type: 'InvtPart', ns_class: 'Upfit Parts', is_taxable: true, sales_price: 99, image_path: 'parts/c4-ra24-3.jpg', catalog: 'upfit',
    });
    expect(noted().filter((s) => s.differs).map((s) => [s.field, s.fleetsuite, s.netsuite])).toEqual([
      ['item_number', 'C4-RA24-3', 'C4-RA24-3B'], ['display_name', 'Class III hitch receiver', 'Hitch receiver'],
      ['description', 'Receiver for 2-inch shank, 6,000 lb', 'Receiver'], ['purchase_price', '12.5', '14.25'],
      ['vendor', 'CURT Manufacturing', 'Curt Mfg'], ['labor_hours', '1.5', '2'],
    ]);
    expect(noted()[0]).toMatchObject({ kind: 'item', netsuite_id: '5001', name: 'C4-RA24-3' });
    expect(result).toMatchObject({ upserted: 1, changedInNetsuite: 6 });
    expect(h.heartbeats).toEqual([expect.objectContaining({ changedInNetsuite: 6 })]);
  });

  it("fills FleetSuite's blanks with NetSuite's, and files the part by the number it keeps", async () => {
    h.tables.netsuite_parts = [part({ item_number: '06N5TR', display_name: '06N5TR', description: '06N5TR', purchase_price: 0, vendor: null, labor_hours: null })];
    h.netsuite.items = [item({ item_number: 'ZZ-100', class_name: '' })];
    await syncPartsIncremental(service() as any);
    expect(partRow()).toMatchObject({
      item_number: '06N5TR', display_name: 'Hitch receiver', description: 'Receiver', purchase_price: 14.25, vendor: 'Curt Mfg', labor_hours: 2,
      catalog: 'graphics',
    });
    expect(noted().filter((s) => s.differs).map((s) => s.field)).toEqual(['item_number']);
  });

  it("brings in an item FleetSuite hasn't got as NetSuite has it, noting nothing", async () => {
    h.netsuite.items = [item({ id: '5009' })];
    expect(await syncPartsIncremental(service() as any)).toMatchObject({ upserted: 1, changedInNetsuite: 0 });
    expect(partRow('5009')).toMatchObject({ item_number: 'C4-RA24-3B', display_name: 'Hitch receiver', purchase_price: 14.25, vendor: 'Curt Mfg', labor_hours: 2 });
    expect(h.rpcs).toEqual([]);
  });

  it("writes NetSuite's over FleetSuite's while it's off, as it always has, noting nothing", async () => {
    switchedOn(false);
    const result = await syncPartsIncremental(service() as any);
    expect(partRow()).toMatchObject({ item_number: 'C4-RA24-3B', display_name: 'Hitch receiver', description: 'Receiver', purchase_price: 14.25, vendor: 'Curt Mfg', labor_hours: 2 });
    expect(h.rpcs).toEqual([]);
    expect(result).not.toHaveProperty('changedInNetsuite');
  });

  it("stops rather than write over FleetSuite's when it can't tell whether it's on, or can't read FleetSuite's parts", async () => {
    h.failing.add('books_switches');
    await expect(syncPartsIncremental(service() as any)).rejects.toThrow("Couldn't tell whether FleetSuite's record wins: books_switches said no");
    h.failing = new Set();
    // FleetSuite's records are the read of the parts that asks for their numbers.
    h.failRead = (table, asked) => table === 'netsuite_parts' && asked.some((a) => a.startsWith('select:') && a.includes('item_number'));
    await expect(syncPartsIncremental(service() as any)).rejects.toThrow("Couldn't read FleetSuite's items: netsuite_parts said no");
    h.failRead = null;
    expect(partRow()).toMatchObject({ item_number: 'C4-RA24-3', purchase_price: 12.5 });
    expect(h.upserts).toEqual([]);
    expect(h.heartbeats).toEqual([]);
  });

  it("fails the run when what NetSuite has instead can't be noted, so the items are read again", async () => {
    h.failing.add('rpc');
    await expect(syncPartsIncremental(service() as any)).rejects.toThrow("Couldn't note what NetSuite has instead: deadlock");
    expect(h.heartbeats).toEqual([]);
    // FleetSuite's was kept all the same.
    expect(partRow()).toMatchObject({ item_number: 'C4-RA24-3', purchase_price: 12.5 });
  });

  it('keeps FleetSuite’s labor on a part NetSuite has none for, whatever else is in its batch', async () => {
    switchedOn(false);
    h.tables.netsuite_parts = [part(), part({ id: 'part-5002', netsuite_id: '5002', item_number: 'C4-RA24-4', labor_hours: 0.75 })];
    h.netsuite.items = [item({ item_number: 'C4-RA24-3' }), item({ id: '5002', item_number: 'C4-RA24-4', labor_hours: null })];
    expect(await syncPartsIncremental(service() as any)).toMatchObject({ upserted: 2 });
    expect(partRow().labor_hours).toBe(2);
    expect(partRow('5002').labor_hours).toBe(0.75);
    expect(h.upserts.map((u) => u.rows.map((r) => r.netsuite_id))).toEqual([['5001'], ['5002']]);
  });
});

describe('Sync from NetSuite on the Parts page', () => {
  const press = async () => {
    const res = await POST(new NextRequest('http://localhost/api/parts/sync', { method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' } }));
    return { status: res.status, json: await res.json() };
  };

  it("keeps FleetSuite's part and says how many NetSuite newly has something else for", async () => {
    h.opened = 6;
    const { status, json } = await press();
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, synced: 1, changedInNetsuite: 6 });
    expect(partRow()).toMatchObject({ item_number: 'C4-RA24-3', display_name: 'Class III hitch receiver', purchase_price: 12.5, vendor: 'CURT Manufacturing', labor_hours: 1.5, image_path: 'parts/c4-ra24-3.jpg' });
    expect(noted().filter((s) => s.differs).map((s) => s.field)).toEqual(['item_number', 'display_name', 'description', 'purchase_price', 'vendor', 'labor_hours']);
  });

  it("leaves FleetSuite's purchase price unlooked at when NetSuite's costs couldn't be read", async () => {
    h.netsuite.costs = null;
    // Listed before, and not closed by a price the sync never read.
    h.tables.record_differences = [{ id: 'o1', kind: 'item', netsuite_id: '5001', field: 'purchase_price', status: 'open' }];
    const { json } = await press();
    expect(json.success).toBe(true);
    expect(partRow().purchase_price).toBe(12.5);
    expect(noted().map((s) => s.field)).not.toContain('purchase_price');
  });

  it("writes NetSuite's over FleetSuite's while it's off, as it always has", async () => {
    switchedOn(false);
    const { json } = await press();
    expect(json).not.toHaveProperty('changedInNetsuite');
    expect(partRow()).toMatchObject({ item_number: 'C4-RA24-3B', purchase_price: 14.25, vendor: 'Curt Mfg', labor_hours: 2 });
    expect(h.rpcs).toEqual([]);
  });

  it("stops when it can't tell whether it's on, writing nothing", async () => {
    h.failing.add('books_switches');
    const { status, json } = await press();
    expect(status).toBe(500);
    expect(json.error).toBe("Couldn't tell whether FleetSuite's record wins: books_switches said no");
    expect(h.upserts).toEqual([]);
  });

  it("still syncs, FleetSuite's kept, when what NetSuite has instead can't be noted, and says so", async () => {
    h.failing.add('rpc');
    const { status, json } = await press();
    expect(status).toBe(200);
    expect(json.changedInNetsuiteError).toBe("Couldn't note what NetSuite has instead: deadlock");
    expect(json).not.toHaveProperty('changedInNetsuite');
    expect(partRow()).toMatchObject({ item_number: 'C4-RA24-3', purchase_price: 12.5 });
  });
});

describe('looking a part up', () => {
  const found = { id: 5001, name: 'C4-RA24-3B', displayName: 'Hitch receiver', description: 'Receiver', type: 'InvtPart' };

  it('finds the part FleetSuite has for the NetSuite item under its own number, never writing over it', async () => {
    h.netsuite.found = { 'C4-RA24-3B': found };
    const result = await findOrMirrorPart(service() as any, 'C4-RA24-3B');
    expect(result).toMatchObject({ mirrored: false, part: { item_number: 'C4-RA24-3', display_name: 'Class III hitch receiver' } });
    expect(h.upserts).toEqual([]);
    expect(partRow()).toMatchObject({ item_number: 'C4-RA24-3', description: 'Receiver for 2-inch shank, 6,000 lb' });
  });

  it('brings it back as it is when it was put away', async () => {
    h.tables.netsuite_parts = [part({ is_active: false })];
    h.netsuite.found = { 'C4-RA24-3B': found };
    const result = await findOrMirrorPart(service() as any, 'c4-ra24-3b');
    expect(result).toMatchObject({ mirrored: true, part: { item_number: 'C4-RA24-3', is_active: true } });
    expect(partRow()).toMatchObject({ item_number: 'C4-RA24-3', display_name: 'Class III hitch receiver', is_active: true });
    expect(h.upserts).toEqual([]);
  });

  it("mirrors NetSuite's item in while it's off, or when FleetSuite hasn't got it", async () => {
    h.netsuite.found = { 'C4-RA24-3B': found };
    switchedOn(false);
    expect(await findOrMirrorPart(service() as any, 'C4-RA24-3B')).toMatchObject({ mirrored: true, part: { item_number: 'C4-RA24-3B' } });
    switchedOn(true);
    h.tables.netsuite_parts = [];
    expect(await findOrMirrorPart(service() as any, 'C4-RA24-3B')).toMatchObject({ mirrored: true, part: { item_number: 'C4-RA24-3B' } });
  });

  it("mirrors nothing when it can't tell whether it's on, or can't read FleetSuite's part", async () => {
    h.netsuite.found = { 'C4-RA24-3B': found };
    h.failing.add('books_switches');
    expect(await findOrMirrorPart(service() as any, 'C4-RA24-3B')).toEqual({
      part: null, mirrored: false, error: "Couldn't tell whether FleetSuite's record wins: books_switches said no",
    });
    expect(h.upserts).toEqual([]);
    expect(partRow().item_number).toBe('C4-RA24-3');
    h.failing = new Set();
    h.failRead = (table, asked) => table === 'netsuite_parts' && asked.includes('eq:netsuite_id');
    expect(await findOrMirrorPart(service() as any, 'C4-RA24-3B')).toEqual({ part: null, mirrored: false, error: 'netsuite_parts said no' });
    expect(h.upserts).toEqual([]);
  });
});

describe('writing synced parts', () => {
  it('writes them 200 at a time, in groups naming the same columns', async () => {
    const rows = Array.from({ length: 401 }, (_, i) => ({ netsuite_id: String(6000 + i), item_number: `P-${i}`, ...(i % 2 ? { labor_hours: 1 } : {}) }));
    expect(await upsertPartRows(service() as any, rows)).toBe(401);
    expect(h.upserts.map((u) => u.rows.length)).toEqual([200, 1, 200]);
    for (const u of h.upserts) expect(new Set(u.rows.map((r) => Object.keys(r).sort().join(','))).size).toBe(1);
  });

  it("throws when a batch can't be written", async () => {
    h.failing.add('netsuite_parts');
    await expect(upsertPartRows(service() as any, [{ netsuite_id: '6000' }])).rejects.toThrow('Failed to upsert batch: netsuite_parts said no');
  });
});
