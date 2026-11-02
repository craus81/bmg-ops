// Migration 499 switches stock counts off, a nineteenth books switch, and keeps
// each count of a location's stock: the items on it in the sheet's order, with
// NetSuite's count when each went on, what was counted and NetSuite's count when
// that was saved, one open count per item and location, held up by an item
// adjusted after it was counted, asked for as one, claimed by a press of
// Approve from a super admin who didn't ask, let go when NetSuite refuses it,
// kept when NetSuite posts it or when FleetSuite can't tell, turned down with
// why, withdrawn by whoever asked, finished with nothing to post, or stopped.
// This runs migrations 359, 466, 454 and 494 with 499 in an in-memory Postgres
// (PGlite) as the app's server login, the way /api/inventory/counts calls it.
// Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SWITCH_PIECES } from './books/switches';

const COUNT = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const JESSIE = 'a0000000-0000-4000-8000-000000000002';
const ZACH = 'a0000000-0000-4000-8000-000000000003';
const HITCH = 'b0000000-0000-4000-8000-000000000001';
const LADDER = 'b0000000-0000-4000-8000-000000000002';
const OFALLON = '1';
const WENTZVILLE = '7';

async function freshDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    -- What migrations 466, 454, 494 and 499 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    CREATE TABLE public.netsuite_parts (id UUID PRIMARY KEY);
    CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql AS 'SELECT false';
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}'), ('${JESSIE}'), ('${ZACH}');
    INSERT INTO public.netsuite_parts (id) VALUES ('${HITCH}'), ('${LADDER}');
  `);
  for (const file of [
    '359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '454-inventory-adjustments.sql', '494-inventory-adjustments-approved.sql',
    '499-stock-counts.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const call = async <T = any>(pg: PGlite, fn: string, p: unknown) =>
  (await pg.query<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

const ITEMS = {
  hitch: { netsuite_item_id: '5512', part_id: HITCH, item_number: ' HX-2200 ', display_name: ' Hitch receiver ', on_hand_start: 7 },
  ladder: { netsuite_item_id: '6101', part_id: LADDER, item_number: 'LR-48', display_name: 'Ladder rack', on_hand_start: 9 },
  sealant: { netsuite_item_id: '7300', item_number: 'SP-500', display_name: '', on_hand_start: 3.5 },
  toolbox: { netsuite_item_id: '8800', item_number: 'TB-12', on_hand_start: 0 },
};

/** Started the way /api/inventory/counts starts one: at O'Fallon, by Jessie, unless told otherwise. */
const start = (pg: PGlite, n: number, lines: unknown[], over: Record<string, unknown> = {}) => call(pg, 'stock_count_start', {
  id: COUNT(n), by: JESSIE, by_name: ' Jessie ', location_id: OFALLON, location_name: " O'Fallon ", what: ' Everything on hand ',
  count_date: '2026-09-15', lines, ...over,
});
const save = (pg: PGlite, n: number, lines: unknown[], over: Record<string, unknown> = {}) =>
  call(pg, 'stock_count_save', { id: COUNT(n), by: JESSIE, by_name: 'Jessie', lines, ...over });

type Row = Record<string, any>;
const countRow = async (pg: PGlite, n: number) => (await pg.query<Row>(`
  SELECT number::int AS number, location_id, location_name, what, count_date::text AS count_date, status, started_by, started_by_name,
    asked_by, asked_by_name, asked_at IS NOT NULL AS has_asked_at, sent_by, sent_by_name, sent_at IS NOT NULL AS has_sent_at,
    decided_by, decided_by_name, decided_at IS NOT NULL AS has_decided_at, turned_down_by_name, turned_down_at IS NOT NULL AS has_turned_down_at,
    why, netsuite_adjustment_id, netsuite_adjustment_number, error
  FROM stock_counts WHERE id = $1`, [COUNT(n)])).rows[0];
const lines = async (pg: PGlite, n: number) => (await pg.query<Row>(`
  SELECT netsuite_item_id, location_id, part_id, item_number, display_name, position, on_hand_start::float8 AS on_hand_start,
    counted::float8 AS counted, on_hand_then::float8 AS on_hand_then, counted_by, counted_by_name, counted_at IS NOT NULL AS has_counted_at,
    is_open
  FROM stock_count_lines WHERE count_id = $1 ORDER BY position`, [COUNT(n)])).rows;
const total = async (pg: PGlite, table: string) => (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
/** As though a line was counted this long ago. */
const countedAgo = (pg: PGlite, n: number, item: string, minutes: number) =>
  pg.query(`UPDATE stock_count_lines SET counted_at = now() - make_interval(mins => $3) WHERE count_id = $1 AND netsuite_item_id = $2`,
    [COUNT(n), item, minutes]);
const adjusted = (pg: PGlite, item: string, location: string, minutesAgo: number, by = 'Zach') => pg.query(`
  INSERT INTO inventory_adjustments (netsuite_item_id, item_number, location_id, mode, entered_qty, change, reason, created_by_name, created_at)
  VALUES ($1, 'X', $2, 'delta', -1, -1, 'Damaged', $3, now() - make_interval(mins => $4))`, [item, location, by, minutesAgo]);
const blocked = async (pg: PGlite, n: number) =>
  (await pg.query<{ r: any[] }>('SELECT stock_count_blocked($1) AS r', [COUNT(n)])).rows[0].r.map(({ at, ...rest }: Row): Row => ({ ...rest, hasAt: !!at }));

describe('migration 499: the switch', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it('adds Counts, off, and keeps every earlier piece', async () => {
    expect((await pg.query(`SELECT piece, is_on, changed_by FROM books_switches WHERE piece = 'stock_counts'`)).rows)
      .toEqual([{ piece: 'stock_counts', is_on: false, changed_by: null }]);
    // Every piece the app named then is one the column takes, and nothing else is (504 adds money screens).
    const then = SWITCH_PIECES.filter((piece) => piece !== 'money_screens');
    expect(then.at(-1)).toBe('stock_counts');
    expect(then).toHaveLength(19);
    for (const piece of then) await pg.query('INSERT INTO books_switches (piece) VALUES ($1) ON CONFLICT (piece) DO NOTHING', [piece]);
    expect(await total(pg, 'books_switches')).toBe(19);
    await expect(pg.query("INSERT INTO books_switches (piece) VALUES ('stock_count')")).rejects.toThrow('books_switches_piece_check');
  });
});

describe('migration 499: starting a count', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it("lists the items in the sheet's order, with NetSuite's count when each went on", async () => {
    const started = await start(pg, 1, [ITEMS.ladder, ITEMS.hitch, ITEMS.sealant]);
    expect(started.state).toBe('started');
    expect(started.count).toMatchObject({ id: COUNT(1), number: 1, status: 'counting', location_name: "O'Fallon", what: 'Everything on hand' });
    expect(await countRow(pg, 1)).toEqual({
      number: 1, location_id: OFALLON, location_name: "O'Fallon", what: 'Everything on hand', count_date: '2026-09-15', status: 'counting',
      started_by: JESSIE, started_by_name: 'Jessie', asked_by: null, asked_by_name: null, has_asked_at: false, sent_by: null, sent_by_name: null,
      has_sent_at: false, decided_by: null, decided_by_name: null, has_decided_at: false, turned_down_by_name: null, has_turned_down_at: false,
      why: null, netsuite_adjustment_id: null, netsuite_adjustment_number: null, error: null,
    });
    const blank = { counted: null, on_hand_then: null, counted_by: null, counted_by_name: null, has_counted_at: false, is_open: true, location_id: OFALLON };
    expect(await lines(pg, 1)).toEqual([
      { ...blank, netsuite_item_id: '6101', part_id: LADDER, item_number: 'LR-48', display_name: 'Ladder rack', position: 1, on_hand_start: 9 },
      { ...blank, netsuite_item_id: '5512', part_id: HITCH, item_number: 'HX-2200', display_name: 'Hitch receiver', position: 2, on_hand_start: 7 },
      { ...blank, netsuite_item_id: '7300', part_id: null, item_number: 'SP-500', display_name: null, position: 3, on_hand_start: 3.5 },
    ]);
  });

  it('keeps a press sent twice once', async () => {
    const again = await start(pg, 1, [ITEMS.toolbox], { what: 'Something else' });
    expect(again.state).toBe('same');
    expect(again.count).toMatchObject({ id: COUNT(1), what: 'Everything on hand' });
    expect(await total(pg, 'stock_counts')).toBe(1);
    expect(await total(pg, 'stock_count_lines')).toBe(3);
  });

  it('keeps an item on one open count per location, and numbers counts in turn', async () => {
    const other = await start(pg, 2, [ITEMS.toolbox, ITEMS.hitch, ITEMS.ladder], { by: ZACH });
    expect(other).toEqual({
      state: 'on_another',
      taken: [
        { netsuite_item_id: '5512', item_number: 'HX-2200', count_id: COUNT(1), number: 1 },
        { netsuite_item_id: '6101', item_number: 'LR-48', count_id: COUNT(1), number: 1 },
      ],
    });
    expect(await total(pg, 'stock_counts')).toBe(1);
    expect(await total(pg, 'stock_count_lines')).toBe(3);
    // The same shelf's items at Wentzville are another location's, and a start refused takes no number.
    const wentzville = await start(pg, 3, [ITEMS.hitch, ITEMS.toolbox], { location_id: WENTZVILLE, location_name: 'Wentzville' });
    expect([wentzville.state, wentzville.count.number]).toEqual(['started', 2]);
    expect((await start(pg, 4, [ITEMS.toolbox])).count.number).toBe(3);
    expect((await lines(pg, 3)).map((l) => [l.netsuite_item_id, l.location_id])).toEqual([['5512', WENTZVILLE], ['8800', WENTZVILLE]]);
  });

  it("refuses a start that's missing what it needs", async () => {
    await expect(start(pg, 9, [ITEMS.toolbox], { by: '' })).rejects.toThrow('needs who started it');
    await expect(start(pg, 9, [])).rejects.toThrow('needs an item to count');
    await expect(start(pg, 9, { a: 1 } as unknown as unknown[])).rejects.toThrow('needs an item to count');
    const many = Array.from({ length: 501 }, (_, i) => ({ netsuite_item_id: String(100000 + i), item_number: `P-${i}`, on_hand_start: 1 }));
    await expect(start(pg, 9, many)).rejects.toThrow('500 items at most');
    await expect(start(pg, 9, [ITEMS.toolbox, { ...ITEMS.toolbox, item_number: 'TB-12B' }])).rejects.toThrow('on the list twice');
    await expect(start(pg, 9, [{ ...ITEMS.toolbox, netsuite_item_id: 'TB12' }])).rejects.toThrow('needs its NetSuite id');
    await expect(start(pg, 9, [{ ...ITEMS.toolbox, item_number: ' ' }])).rejects.toThrow('needs its NetSuite id');
    await expect(start(pg, 9, [{ ...ITEMS.toolbox, on_hand_start: '4' }])).rejects.toThrow("NetSuite's count");
    await expect(start(pg, 9, [{ netsuite_item_id: '8801', item_number: 'TB-13' }])).rejects.toThrow("NetSuite's count");
    await expect(start(pg, 9, [{ ...ITEMS.toolbox, netsuite_item_id: '8802' }], { location_id: 'OF' })).rejects.toThrow('stock_counts_location_id_check');
    await expect(start(pg, 9, [{ ...ITEMS.toolbox, netsuite_item_id: '8802' }], { what: ' ' })).rejects.toThrow('stock_counts_what_check');
    await expect(start(pg, 9, [{ ...ITEMS.toolbox, netsuite_item_id: '8802' }], { location_name: '' })).rejects.toThrow('stock_counts_location_name_check');
    expect(await countRow(pg, 9)).toBeUndefined();
    // 500 is the most a count takes.
    expect((await start(pg, 10, many.slice(0, 500), { location_id: '9', location_name: 'Kansas City' })).state).toBe('started');
  });
});

describe('migration 499: adding items to a count', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await start(pg, 1, [ITEMS.ladder, ITEMS.hitch]);
    await start(pg, 2, [ITEMS.toolbox], { by: ZACH });
  });
  afterAll(async () => { await pg.close(); });

  it("puts new items after the ones on it, leaving the ones on it as they are", async () => {
    await save(pg, 1, [{ netsuite_item_id: '6101', counted: 8, on_hand_then: 9 }]);
    expect(await call(pg, 'stock_count_add', { id: COUNT(1), by: JESSIE, lines: [{ ...ITEMS.ladder, on_hand_start: 2 }, ITEMS.sealant] }))
      .toEqual({ state: 'added', added: 1 });
    expect((await lines(pg, 1)).map((l) => [l.item_number, l.position, l.on_hand_start, l.counted])).toEqual([
      ['LR-48', 1, 9, 8], ['HX-2200', 2, 7, null], ['SP-500', 3, 3.5, null],
    ]);
    expect(await call(pg, 'stock_count_add', { id: COUNT(1), by: JESSIE, lines: [ITEMS.hitch] })).toEqual({ state: 'added', added: 0 });
  });

  it("adds nothing when an item is on another open count there, or it'd go past 500", async () => {
    expect(await call(pg, 'stock_count_add', { id: COUNT(1), by: JESSIE, lines: [{ netsuite_item_id: '9100', item_number: 'BK-1', on_hand_start: 1 }, ITEMS.toolbox] }))
      .toEqual({ state: 'on_another', taken: [{ netsuite_item_id: '8800', item_number: 'TB-12', count_id: COUNT(2), number: 2 }] });
    expect(await lines(pg, 1)).toHaveLength(3);
    const many = Array.from({ length: 498 }, (_, i) => ({ netsuite_item_id: String(200000 + i), item_number: `Q-${i}`, on_hand_start: 0 }));
    expect(await call(pg, 'stock_count_add', { id: COUNT(1), by: JESSIE, lines: many })).toEqual({ state: 'too_many', on_it: 3 });
    expect(await lines(pg, 1)).toHaveLength(3);
    expect((await call(pg, 'stock_count_add', { id: COUNT(1), by: JESSIE, lines: many.slice(0, 497) })).added).toBe(497);
    expect((await lines(pg, 1)).at(-1)).toMatchObject({ item_number: 'Q-496', position: 500 });
  });

  it("adds only while it's being counted", async () => {
    await call(pg, 'stock_count_cancel', { id: COUNT(2), by: ZACH });
    expect(await call(pg, 'stock_count_add', { id: COUNT(2), by: ZACH, lines: [ITEMS.sealant] })).toEqual({ state: 'not_now', status: 'cancelled' });
    expect(await call(pg, 'stock_count_add', { id: COUNT(8), by: ZACH, lines: [ITEMS.sealant] })).toEqual({ state: 'gone' });
    await expect(call(pg, 'stock_count_add', { id: COUNT(1), lines: [ITEMS.sealant] })).rejects.toThrow('needs who added');
    await expect(call(pg, 'stock_count_add', { id: COUNT(1), by: JESSIE, lines: [] })).rejects.toThrow('needs an item to count');
  });
});

describe('migration 499: saving what was counted', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await start(pg, 1, [ITEMS.ladder, ITEMS.hitch, ITEMS.sealant]);
  });
  afterAll(async () => { await pg.close(); });

  it("keeps each count with NetSuite's count as it's saved, and who counted it", async () => {
    expect(await save(pg, 1, [{ netsuite_item_id: '6101', counted: 12, on_hand_then: 9 }, { netsuite_item_id: '5512', counted: 7, on_hand_then: 6 }]))
      .toEqual({ state: 'saved', saved: 2 });
    expect((await lines(pg, 1)).map((l) => [l.item_number, l.counted, l.on_hand_then, l.counted_by, l.counted_by_name, l.has_counted_at])).toEqual([
      ['LR-48', 12, 9, JESSIE, 'Jessie', true], ['HX-2200', 7, 6, JESSIE, 'Jessie', true], ['SP-500', null, null, null, null, false],
    ]);
  });

  it("keeps a count saved again as counted now, with NetSuite's count now, even when it's the same", async () => {
    await countedAgo(pg, 1, '6101', 60);
    expect(await save(pg, 1, [{ netsuite_item_id: '6101', counted: 12, on_hand_then: 10 }], { by: ZACH, by_name: 'Zach' }))
      .toEqual({ state: 'saved', saved: 1 });
    const recounted = (await pg.query<Row>(`SELECT counted::float8 AS counted, on_hand_then::float8 AS on_hand_then, counted_by, counted_by_name,
      counted_at > now() - interval '1 minute' AS just_now FROM stock_count_lines WHERE count_id = $1 AND netsuite_item_id = '6101'`, [COUNT(1)])).rows[0];
    expect(recounted).toEqual({ counted: 12, on_hand_then: 10, counted_by: ZACH, counted_by_name: 'Zach', just_now: true });
    expect(await save(pg, 1, [{ netsuite_item_id: '6101', counted: 11, on_hand_then: 10 }], { by: ZACH, by_name: ' ' }))
      .toEqual({ state: 'saved', saved: 1 });
    expect((await lines(pg, 1))[0]).toMatchObject({ counted: 11, on_hand_then: 10, counted_by: ZACH, counted_by_name: null });
    // The others are left as they were.
    expect((await lines(pg, 1))[1]).toMatchObject({ counted: 7, on_hand_then: 6, counted_by: JESSIE });
  });

  it('clears an item back to not counted, and keeps part counts to four places', async () => {
    expect(await save(pg, 1, [{ netsuite_item_id: '5512', counted: null, on_hand_then: 6 }, { netsuite_item_id: '7300', counted: 3.25, on_hand_then: 3.5 }]))
      .toEqual({ state: 'saved', saved: 2 });
    expect((await lines(pg, 1)).slice(1).map((l) => [l.counted, l.on_hand_then, l.counted_by, l.counted_by_name, l.has_counted_at])).toEqual([
      [null, null, null, null, false], [3.25, 3.5, JESSIE, 'Jessie', true],
    ]);
    await expect(save(pg, 1, [{ netsuite_item_id: '7300', counted: 3.12345, on_hand_then: 3.5 }])).rejects.toThrow('stock_count_lines_counted_check');
    await expect(save(pg, 1, [{ netsuite_item_id: '7300', counted: -1, on_hand_then: 3.5 }])).rejects.toThrow('stock_count_lines_counted_check');
    expect((await lines(pg, 1))[2].counted).toBe(3.25);
  });

  it("moves the count's day, and saves nothing when an item isn't on it", async () => {
    expect(await save(pg, 1, [], { count_date: '2026-09-16' })).toEqual({ state: 'saved', saved: 0 });
    expect((await countRow(pg, 1)).count_date).toBe('2026-09-16');
    expect(await save(pg, 1, [])).toEqual({ state: 'saved', saved: 0 });
    expect((await countRow(pg, 1)).count_date).toBe('2026-09-16');
    expect(await save(pg, 1, [{ netsuite_item_id: '5512', counted: 5, on_hand_then: 6 }, { netsuite_item_id: '8800', counted: 1, on_hand_then: 0 }], { count_date: '2026-09-20' }))
      .toEqual({ state: 'not_on_count', missing: ['8800'] });
    expect((await lines(pg, 1))[1].counted).toBeNull();
    expect((await countRow(pg, 1)).count_date).toBe('2026-09-16');
  });

  it("refuses a save that's missing what it needs", async () => {
    await expect(save(pg, 1, [], { by: null })).rejects.toThrow('needs who counted');
    await expect(save(pg, 1, { a: 1 } as unknown as unknown[])).rejects.toThrow('needs its lines');
    await expect(save(pg, 1, [{ netsuite_item_id: '5512', counted: 5 }])).rejects.toThrow("NetSuite's count as it's saved");
    await expect(save(pg, 1, [{ netsuite_item_id: '5512', counted: '5', on_hand_then: 6 }])).rejects.toThrow("NetSuite's count as it's saved");
    await expect(save(pg, 1, [{ netsuite_item_id: '5512', on_hand_then: 6 }])).rejects.toThrow("NetSuite's count as it's saved");
    await expect(save(pg, 1, [{ netsuite_item_id: 'HX', counted: 5, on_hand_then: 6 }])).rejects.toThrow("NetSuite's count as it's saved");
    await expect(save(pg, 1, [{ netsuite_item_id: '5512', counted: 5, on_hand_then: 6 }, { netsuite_item_id: '5512', counted: 4, on_hand_then: 6 }]))
      .rejects.toThrow('saved twice');
    expect((await lines(pg, 1))[1].counted).toBeNull();
    expect(await save(pg, 9, [])).toEqual({ state: 'gone' });
  });
});

describe('migration 499: what holds a count up', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await start(pg, 1, [ITEMS.ladder, ITEMS.hitch, ITEMS.sealant, ITEMS.toolbox]);
    await save(pg, 1, [
      { netsuite_item_id: '6101', counted: 8, on_hand_then: 9 },
      { netsuite_item_id: '5512', counted: 7, on_hand_then: 7 },
      { netsuite_item_id: '7300', counted: 3, on_hand_then: 3.5 },
      { netsuite_item_id: '8800', counted: 2, on_hand_then: 0 },
    ]);
    for (const item of ['6101', '5512', '7300', '8800']) await countedAgo(pg, 1, item, 60);
  });
  afterAll(async () => { await pg.close(); });

  it('holds up an item that differs and was adjusted with Adjust at the location after it was counted', async () => {
    expect(await blocked(pg, 1)).toEqual([]);
    await adjusted(pg, '6101', OFALLON, 90); // before it was counted
    await adjusted(pg, '7300', WENTZVILLE, 10); // at another location
    await adjusted(pg, '5512', OFALLON, 10); // it matches, so nothing is posted for it
    expect(await blocked(pg, 1)).toEqual([]);
    await adjusted(pg, '8800', OFALLON, 30, 'Valarie');
    await adjusted(pg, '8800', OFALLON, 5, 'Zach');
    await adjusted(pg, '6101', OFALLON, 20, 'Brian');
    expect(await blocked(pg, 1)).toEqual([
      { netsuite_item_id: '6101', item_number: 'LR-48', why: 'adjusted', by_name: 'Brian', hasAt: true },
      { netsuite_item_id: '8800', item_number: 'TB-12', why: 'adjusted', by_name: 'Zach', hasAt: true },
    ]);
  });

  it('holds up one with an adjustment asked for there, and one asked for and made after it was counted', async () => {
    const ask = (id: string, item: string, location: string, status: string, decidedMinutesAgo: number | null, by = 'Ashley') => pg.query(`
      INSERT INTO inventory_adjustment_asks (id, netsuite_item_id, item_number, location_id, mode, entered_qty, on_hand_then, change, reason, status,
        asked_by_name, asked_at, sent_at, decided_at, why)
      VALUES ($1, $2, 'X', $3, 'delta', -1, 5, -1, 'Damaged', $4, $5, now() - interval '2 hours',
        CASE WHEN $4 IN ('sending', 'unsure', 'made') THEN now() - interval '2 hours' END,
        CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(mins => $6::int) END,
        CASE WHEN $4 = 'turned_down' THEN 'No' END)`, [id, item, location, status, by, decidedMinutesAgo]);
    await ask(COUNT(50), '7300', WENTZVILLE, 'waiting', null); // another location's
    await ask(COUNT(51), '7300', OFALLON, 'turned_down', 10); // decided, and not made
    await ask(COUNT(52), '7300', OFALLON, 'made', 90); // made before it was counted
    expect((await blocked(pg, 1)).map((b) => b.netsuite_item_id)).toEqual(['6101', '8800']);
    await ask(COUNT(53), '7300', OFALLON, 'made', 15, 'Harold');
    expect((await blocked(pg, 1))[1]).toEqual({ netsuite_item_id: '7300', item_number: 'SP-500', why: 'adjusted', by_name: 'Harold', hasAt: true });
    await ask(COUNT(54), '6101', OFALLON, 'unsure', null, 'Damon');
    expect((await blocked(pg, 1))[0]).toEqual({ netsuite_item_id: '6101', item_number: 'LR-48', why: 'asked', by_name: 'Damon', hasAt: true });
    // Counted again since, it isn't held up by what came before.
    await save(pg, 1, [{ netsuite_item_id: '8800', counted: 3, on_hand_then: 1 }]);
    expect((await blocked(pg, 1)).map((b) => [b.netsuite_item_id, b.why])).toEqual([['6101', 'asked'], ['7300', 'adjusted']]);
    expect((await pg.query('SELECT stock_count_blocked($1) AS r', [COUNT(9)])).rows[0]).toEqual({ r: [] });
  });

  it("lists the differences to post, to four places, and none for an item that matches or isn't counted", async () => {
    await start(pg, 2, [{ netsuite_item_id: '9100', item_number: 'BK-1', on_hand_start: 1 }, { netsuite_item_id: '9200', item_number: 'BK-2', on_hand_start: 1 }]);
    await save(pg, 2, [{ netsuite_item_id: '9100', counted: 1.0001, on_hand_then: 1 }, { netsuite_item_id: '9200', counted: 1, on_hand_then: 1.00004 }]);
    const changes = async (n: number) => (await pg.query('SELECT stock_count_changes($1) AS r', [COUNT(n)])).rows[0];
    expect(await changes(1)).toEqual({ r: [
      { netsuite_item_id: '6101', item_number: 'LR-48', change: -1 },
      { netsuite_item_id: '7300', item_number: 'SP-500', change: -0.5 },
      { netsuite_item_id: '8800', item_number: 'TB-12', change: 2 },
    ] });
    expect(await changes(2)).toEqual({ r: [{ netsuite_item_id: '9100', item_number: 'BK-1', change: 0.0001 }] });
    expect(await changes(9)).toEqual({ r: [] });
  });
});

describe('migration 499: asking, finishing and stopping', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await start(pg, 1, [ITEMS.ladder, ITEMS.hitch]);
    await start(pg, 2, [ITEMS.sealant]);
    await start(pg, 3, [ITEMS.toolbox]);
  });
  afterAll(async () => { await pg.close(); });

  it("asks for nothing until something's counted, and for nothing when everything counted matches", async () => {
    expect((await call(pg, 'stock_count_ask', { id: COUNT(1), by: JESSIE })).state).toBe('none_counted');
    expect((await call(pg, 'stock_count_finish', { id: COUNT(1), by: JESSIE })).state).toBe('none_counted');
    await save(pg, 1, [{ netsuite_item_id: '6101', counted: 9, on_hand_then: 9 }]);
    expect((await call(pg, 'stock_count_ask', { id: COUNT(1), by: JESSIE })).state).toBe('no_differences');
    expect((await countRow(pg, 1)).status).toBe('counting');
    await save(pg, 1, [{ netsuite_item_id: '5512', counted: 5, on_hand_then: 7 }]);
    expect((await call(pg, 'stock_count_finish', { id: COUNT(1), by: JESSIE })).state).toBe('differences');
    expect((await countRow(pg, 1)).status).toBe('counting');
  });

  it("finishes a count that matches, posting nothing, and frees its items", async () => {
    await save(pg, 2, [{ netsuite_item_id: '7300', counted: 3.5, on_hand_then: 3.5 }]);
    const finished = await call(pg, 'stock_count_finish', { id: COUNT(2), by: CRAIG, by_name: ' Craig ' });
    expect(finished.state).toBe('finished');
    expect(await countRow(pg, 2)).toMatchObject({
      status: 'made', decided_by: CRAIG, decided_by_name: 'Craig', has_decided_at: true, has_sent_at: false, netsuite_adjustment_id: null, has_asked_at: false,
    });
    expect((await lines(pg, 2)).map((l) => l.is_open)).toEqual([false]);
    expect((await start(pg, 4, [ITEMS.sealant])).state).toBe('started');
    expect(await call(pg, 'stock_count_finish', { id: COUNT(2), by: CRAIG })).toMatchObject({ state: 'not_now', status: 'made' });
    expect(await save(pg, 2, [])).toEqual({ state: 'not_now', status: 'made' });
  });

  it("asks, holding what's counted, and won't while an item's held up", async () => {
    await adjusted(pg, '5512', OFALLON, 0);
    const held = await call(pg, 'stock_count_ask', { id: COUNT(1), by: JESSIE });
    expect(held.state).toBe('blocked');
    expect(held.blocked.map((b: Row) => b.item_number)).toEqual(['HX-2200']);
    expect((await countRow(pg, 1)).status).toBe('counting');
    await save(pg, 1, [{ netsuite_item_id: '5512', counted: 4, on_hand_then: 6 }]);
    const asked = await call(pg, 'stock_count_ask', { id: COUNT(1), by: JESSIE, by_name: ' Jessie ' });
    expect(asked.state).toBe('asked');
    expect(await countRow(pg, 1)).toMatchObject({ status: 'asked', asked_by: JESSIE, asked_by_name: 'Jessie', has_asked_at: true });
    expect(await save(pg, 1, [{ netsuite_item_id: '5512', counted: 3, on_hand_then: 6 }])).toEqual({ state: 'not_now', status: 'asked' });
    expect(await call(pg, 'stock_count_add', { id: COUNT(1), by: JESSIE, lines: [ITEMS.sealant] })).toEqual({ state: 'not_now', status: 'asked' });
    // Asking again isn't asking: a second press is told where it is.
    for (const fn of ['stock_count_ask', 'stock_count_finish', 'stock_count_cancel']) {
      expect(await call(pg, fn, { id: COUNT(1), by: ZACH })).toMatchObject({ state: 'not_now', status: 'asked' });
    }
    expect((await countRow(pg, 1)).asked_by).toBe(JESSIE);
    expect((await lines(pg, 1))[1].counted).toBe(4);
  });

  it("stops a count that's being counted, posting nothing, and frees its items", async () => {
    const stopped = await call(pg, 'stock_count_cancel', { id: COUNT(3), by: ZACH, by_name: 'Zach' });
    expect(stopped.state).toBe('cancelled');
    expect(await countRow(pg, 3)).toMatchObject({ status: 'cancelled', decided_by: ZACH, decided_by_name: 'Zach', has_decided_at: true });
    expect((await lines(pg, 3)).map((l) => l.is_open)).toEqual([false]);
    expect((await start(pg, 5, [ITEMS.toolbox])).state).toBe('started');
    expect(await call(pg, 'stock_count_cancel', { id: COUNT(3), by: ZACH })).toMatchObject({ state: 'not_now', status: 'cancelled' });
    for (const fn of ['stock_count_ask', 'stock_count_finish', 'stock_count_cancel']) {
      expect(await call(pg, fn, { id: COUNT(9), by: ZACH })).toEqual({ state: 'gone' });
      await expect(call(pg, fn, { id: COUNT(5) })).rejects.toThrow('needs who');
    }
  });
});

describe('migration 499: approving', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await start(pg, 1, [ITEMS.ladder, ITEMS.hitch, ITEMS.sealant]);
    await save(pg, 1, [
      { netsuite_item_id: '6101', counted: 12, on_hand_then: 9 },
      { netsuite_item_id: '5512', counted: 7, on_hand_then: 7 },
      { netsuite_item_id: '7300', counted: 3, on_hand_then: 3.5 },
    ]);
    await call(pg, 'stock_count_ask', { id: COUNT(1), by: JESSIE, by_name: 'Jessie' });
  });
  afterAll(async () => { await pg.close(); });

  it("is for a super admin who didn't ask, and claims it for one press", async () => {
    expect((await call(pg, 'stock_count_claim', { id: COUNT(1), by: JESSIE })).state).toBe('own');
    expect((await countRow(pg, 1)).status).toBe('asked');
    const claim = await call(pg, 'stock_count_claim', { id: COUNT(1), by: CRAIG, by_name: ' Craig ' });
    expect(claim.state).toBe('claimed');
    expect(claim.changes).toEqual([
      { netsuite_item_id: '6101', item_number: 'LR-48', change: 3 },
      { netsuite_item_id: '7300', item_number: 'SP-500', change: -0.5 },
    ]);
    expect(await countRow(pg, 1)).toMatchObject({ status: 'sending', sent_by: CRAIG, sent_by_name: 'Craig', has_sent_at: true, error: null });
    const again = await call(pg, 'stock_count_claim', { id: COUNT(1), by: ZACH });
    expect(again).toMatchObject({ state: 'not_now', status: 'sending' });
    expect(again.count.sent_by).toBe(CRAIG);
  });

  it("keeps not knowing, lets go back to wait with why, and claims again", async () => {
    expect(await call(pg, 'stock_count_unsure', { id: COUNT(1), error: ' ' })).toEqual({ unsure: true });
    expect(await countRow(pg, 1)).toMatchObject({ status: 'unsure', error: 'No answer from NetSuite' });
    expect(await call(pg, 'stock_count_unsure', { id: COUNT(1), error: 'again' })).toEqual({ unsure: false });
    expect(await call(pg, 'stock_count_claim', { id: COUNT(1), by: ZACH })).toMatchObject({ state: 'not_now', status: 'unsure' });
    expect(await call(pg, 'stock_count_let_go', { id: COUNT(1), error: ' NetSuite has no adjustment from this press. ' })).toEqual({ let_go: true });
    expect(await countRow(pg, 1)).toMatchObject({
      status: 'asked', sent_by: null, sent_by_name: null, has_sent_at: false, error: 'NetSuite has no adjustment from this press.', asked_by: JESSIE,
    });
    expect(await call(pg, 'stock_count_let_go', { id: COUNT(1), error: 'x' })).toEqual({ let_go: false });
    expect(await call(pg, 'stock_count_made', { id: COUNT(1), netsuite_adjustment_id: '4410' })).toEqual({ made: false });
    expect((await call(pg, 'stock_count_claim', { id: COUNT(1), by: ZACH, by_name: 'Zach' })).state).toBe('claimed');
    expect((await countRow(pg, 1)).error).toBeNull();
    expect(await call(pg, 'stock_count_let_go', { id: COUNT(1), error: '' })).toEqual({ let_go: true });
    expect((await countRow(pg, 1)).error).toBe('Not posted');
  });

  it("won't claim one whose item was adjusted after it was counted", async () => {
    await countedAgo(pg, 1, '7300', 30);
    await adjusted(pg, '7300', OFALLON, 10);
    const held = await call(pg, 'stock_count_claim', { id: COUNT(1), by: CRAIG });
    expect(held.state).toBe('blocked');
    expect(held.blocked.map((b: Row) => [b.item_number, b.why])).toEqual([['SP-500', 'adjusted']]);
    expect((await countRow(pg, 1)).status).toBe('asked');
  });

  it('turns it down with why, which the counters see until it is asked for again', async () => {
    await expect(call(pg, 'stock_count_turn_down', { id: COUNT(1), by: CRAIG, why: ' ' })).rejects.toThrow('needs why');
    await expect(call(pg, 'stock_count_turn_down', { id: COUNT(1), by: CRAIG, why: 'x'.repeat(301) })).rejects.toThrow('300 characters');
    await expect(call(pg, 'stock_count_turn_down', { id: COUNT(1), why: 'No' })).rejects.toThrow('needs who turned it down');
    expect((await call(pg, 'stock_count_turn_down', { id: COUNT(1), by: JESSIE, why: 'No' })).state).toBe('own');
    const down = await call(pg, 'stock_count_turn_down', { id: COUNT(1), by: CRAIG, by_name: 'Craig', why: ' Count the sealant again ' });
    expect(down.state).toBe('turned_down');
    expect(await countRow(pg, 1)).toMatchObject({
      status: 'counting', asked_by: null, asked_by_name: null, has_asked_at: false, why: 'Count the sealant again', turned_down_by_name: 'Craig',
      has_turned_down_at: true, error: null,
    });
    expect(await call(pg, 'stock_count_turn_down', { id: COUNT(1), by: CRAIG, why: 'No' })).toMatchObject({ state: 'not_now', status: 'counting' });
    await save(pg, 1, [{ netsuite_item_id: '7300', counted: 3, on_hand_then: 2.5 }]);
    expect((await call(pg, 'stock_count_ask', { id: COUNT(1), by: ZACH, by_name: 'Zach' })).state).toBe('asked');
    expect(await countRow(pg, 1)).toMatchObject({ asked_by: ZACH, why: null, turned_down_by_name: null, has_turned_down_at: false });
  });

  it('is withdrawn only by whoever asked', async () => {
    expect((await call(pg, 'stock_count_withdraw', { id: COUNT(1), by: JESSIE })).state).toBe('not_yours');
    await expect(call(pg, 'stock_count_withdraw', { id: COUNT(1) })).rejects.toThrow('needs who withdrew it');
    expect((await call(pg, 'stock_count_withdraw', { id: COUNT(1), by: ZACH })).state).toBe('withdrawn');
    expect(await countRow(pg, 1)).toMatchObject({ status: 'counting', asked_by: null, has_asked_at: false });
    expect(await call(pg, 'stock_count_withdraw', { id: COUNT(1), by: ZACH })).toMatchObject({ state: 'not_now', status: 'counting' });
    expect(await call(pg, 'stock_count_withdraw', { id: COUNT(9), by: ZACH })).toEqual({ state: 'gone' });
  });

  it("keeps NetSuite's adjustment once it's made, and frees the items", async () => {
    await call(pg, 'stock_count_ask', { id: COUNT(1), by: JESSIE, by_name: 'Jessie' });
    await call(pg, 'stock_count_claim', { id: COUNT(1), by: CRAIG, by_name: 'Craig' });
    await expect(call(pg, 'stock_count_made', { id: COUNT(1), netsuite_adjustment_id: 'INVADJ1' })).rejects.toThrow("NetSuite's id");
    await expect(call(pg, 'stock_count_made', { id: COUNT(1) })).rejects.toThrow("NetSuite's id");
    expect(await call(pg, 'stock_count_made', { id: COUNT(1), netsuite_adjustment_id: '4410', netsuite_number: ' INVADJ1042 ' })).toEqual({ made: true });
    expect(await countRow(pg, 1)).toMatchObject({
      status: 'made', netsuite_adjustment_id: '4410', netsuite_adjustment_number: 'INVADJ1042', decided_by: CRAIG, decided_by_name: 'Craig',
      has_decided_at: true, asked_by: JESSIE, has_sent_at: true, error: null,
    });
    expect((await lines(pg, 1)).map((l) => l.is_open)).toEqual([false, false, false]);
    expect(await call(pg, 'stock_count_made', { id: COUNT(1), netsuite_adjustment_id: '4411' })).toEqual({ made: false });
    expect((await countRow(pg, 1)).netsuite_adjustment_id).toBe('4410');
    expect(await call(pg, 'stock_count_claim', { id: COUNT(1), by: ZACH })).toMatchObject({ state: 'not_now', status: 'made' });
    expect(await call(pg, 'stock_count_claim', { id: COUNT(9), by: ZACH })).toEqual({ state: 'gone' });
    await expect(call(pg, 'stock_count_claim', { id: COUNT(1) })).rejects.toThrow('needs who approved');
    expect((await start(pg, 2, [ITEMS.ladder, ITEMS.sealant])).state).toBe('started');
  });

  it('keeps a made one from not knowing, and a not-known one from being made without a press', async () => {
    // Made from not knowing, as when NetSuite is asked and has it.
    await start(pg, 3, [ITEMS.toolbox]);
    await save(pg, 3, [{ netsuite_item_id: '8800', counted: 1, on_hand_then: 0 }]);
    await call(pg, 'stock_count_ask', { id: COUNT(3), by: JESSIE });
    await call(pg, 'stock_count_claim', { id: COUNT(3), by: CRAIG, by_name: 'Craig' });
    await call(pg, 'stock_count_unsure', { id: COUNT(3), error: 'NetSuite didn\'t answer.' });
    expect(await call(pg, 'stock_count_made', { id: COUNT(3), netsuite_adjustment_id: '4420' })).toEqual({ made: true });
    expect(await countRow(pg, 3)).toMatchObject({ status: 'made', netsuite_adjustment_id: '4420', netsuite_adjustment_number: null, decided_by: CRAIG, error: null });
  });

  it("holds what the table takes", async () => {
    const refused = (sql: string, match: RegExp | string) => expect(pg.query(sql, [COUNT(2)])).rejects.toThrow(match);
    await refused(`UPDATE stock_counts SET status = 'asked' WHERE id = $1`, 'stock_counts_check');
    await refused(`UPDATE stock_counts SET status = 'sending', asked_at = now() WHERE id = $1`, 'stock_counts_check');
    await refused(`UPDATE stock_counts SET status = 'made' WHERE id = $1`, 'stock_counts_check');
    await refused(`UPDATE stock_counts SET status = 'made', decided_at = now(), netsuite_adjustment_id = '1' WHERE id = $1`, 'stock_counts_check');
    await refused(`UPDATE stock_counts SET netsuite_adjustment_id = '1' WHERE id = $1`, 'stock_counts_check');
    await refused(`UPDATE stock_counts SET why = 'No' WHERE id = $1`, 'stock_counts_check');
    await refused(`UPDATE stock_counts SET status = 'paused' WHERE id = $1`, 'stock_counts_status_check');
    await refused(`UPDATE stock_count_lines SET counted = 1 WHERE count_id = $1`, 'stock_count_lines_check');
    await refused(`UPDATE stock_count_lines SET counted = 1, on_hand_then = 1 WHERE count_id = $1`, 'stock_count_lines_check');
    await refused(`UPDATE stock_count_lines SET position = 0 WHERE count_id = $1`, 'stock_count_lines_position_check');
    // An item on two open counts at a location can't be.
    await refused(`UPDATE stock_count_lines SET is_open = true WHERE count_id = '${COUNT(1)}' AND $1::uuid IS NOT NULL`, /stock_count_lines_one_open/);
    await refused(`UPDATE stock_counts SET number = 7 WHERE id = $1`, /number/);
  });

  it('lets only the server login near it', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        await expect(pg.query('SELECT * FROM stock_counts')).rejects.toThrow(/permission denied/);
        await expect(pg.query('SELECT * FROM stock_count_lines')).rejects.toThrow(/permission denied/);
        for (const fn of [
          'stock_count_start', 'stock_count_add', 'stock_count_save', 'stock_count_ask', 'stock_count_finish', 'stock_count_cancel',
          'stock_count_withdraw', 'stock_count_turn_down', 'stock_count_claim', 'stock_count_let_go', 'stock_count_unsure', 'stock_count_made',
          'stock_count_new_lines',
        ]) {
          await expect(call(pg, fn, { id: COUNT(5), by: CRAIG })).rejects.toThrow(/permission denied for function/);
        }
        for (const fn of ['stock_count_blocked', 'stock_count_changes']) {
          await expect(pg.query(`SELECT ${fn}($1)`, [COUNT(1)])).rejects.toThrow(/permission denied for function/);
        }
        await expect(pg.query(`SELECT stock_count_taken('1', ARRAY['5512'], NULL)`)).rejects.toThrow(/permission denied for function/);
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    await pg.exec('RESET ROLE');
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('stock_counts', 'stock_count_lines') ORDER BY relname`);
    expect(rls.rows).toEqual([{ relname: 'stock_count_lines', relrowsecurity: true }, { relname: 'stock_counts', relrowsecurity: true }]);
    await pg.exec('SET ROLE service_role');
  });
});
