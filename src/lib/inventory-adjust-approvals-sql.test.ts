// Migration 494 switches approving inventory adjustments off, a sixteenth books
// switch, and keeps each adjustment asked for with Adjust once it's on: the
// change worked out against NetSuite's count when it was asked, one waiting
// per item and location, claimed by a press of Approve from a super admin who
// didn't ask, let go when NetSuite refuses it, kept when NetSuite posts it or
// when FleetSuite can't tell, settled by hand, turned down with why, or
// withdrawn by whoever asked. This runs migration 359 with 466 and 494 in an
// in-memory Postgres (PGlite) as the app's server login, asking the way
// /api/inventory/adjust does (src/lib/inventory-adjust-approvals.ts). Made-up
// data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { askFromRow, askPayload, workOutAsk } from './inventory-adjust-approvals';
import { SWITCH_PIECES } from './books/switches';

const ASK = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const JESSIE = 'a0000000-0000-4000-8000-000000000002';
const ZACH = 'a0000000-0000-4000-8000-000000000003';
const HITCH = 'b0000000-0000-4000-8000-000000000001';
const LADDER = 'b0000000-0000-4000-8000-000000000002';

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
    -- What migrations 466 and 494 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    CREATE TABLE public.netsuite_parts (id UUID PRIMARY KEY);
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}'), ('${JESSIE}'), ('${ZACH}');
    INSERT INTO public.netsuite_parts (id) VALUES ('${HITCH}'), ('${LADDER}');
  `);
  for (const file of ['359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '494-inventory-adjustments-approved.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const call = async <T = any>(pg: PGlite, fn: string, p: unknown) =>
  (await pg.query<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

/** Asked for the way /api/inventory/adjust asks: the hitch receiver at O'Fallon unless told otherwise. */
const asked = (id: string, over: Partial<Parameters<typeof askPayload>[0]> = {}) => askPayload({
  id, by: JESSIE, byName: ' Jessie ', partId: HITCH, netsuiteItemId: '5512', itemNumber: ' HX-2200 ', locationId: '1',
  mode: 'delta', qty: -2, onHand: 7, reason: 'Damaged', note: ' Box crushed on delivery ', ...over,
});
const ask = (pg: PGlite, id: string, over: Partial<Parameters<typeof askPayload>[0]> = {}) =>
  call(pg, 'inventory_adjustment_ask', asked(id, over));

type Row = Record<string, any>;
const row = async (pg: PGlite, id: string) => (await pg.query<Row>(`
  SELECT id, part_id, netsuite_item_id, item_number, location_id, mode, entered_qty::float8 AS entered_qty,
    on_hand_then::float8 AS on_hand_then, change::float8 AS change, reason, note, status, asked_by, asked_by_name,
    sent_by, sent_by_name, sent_at IS NOT NULL AS has_sent_at, decided_by, decided_by_name, decided_at IS NOT NULL AS has_decided_at,
    why, netsuite_adjustment_number, error, warning
  FROM inventory_adjustment_asks WHERE id = $1`, [id])).rows[0];
const count = async (pg: PGlite) => (await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM inventory_adjustment_asks')).rows[0].n;
/** Every row but these, to show a function changed only the one it was asked about. */
const others = async (pg: PGlite, ...ids: string[]) => (await pg.query<Row>(
  `SELECT *, to_jsonb(updated_at) #>> '{}' AS seen FROM inventory_adjustment_asks WHERE NOT (id = ANY($1::uuid[])) ORDER BY id`, [ids])).rows;
/** As though the press of Approve started this long ago. */
const sentAgo = (pg: PGlite, id: string, minutes: number) =>
  pg.query(`UPDATE inventory_adjustment_asks SET sent_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, minutes]);

describe('migration 494', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it('starts approving adjustments switched off, a sixteenth piece', async () => {
    expect((await pg.query(`SELECT piece, is_on, changed_by FROM books_switches WHERE piece = 'adjustment_approvals'`)).rows)
      .toEqual([{ piece: 'adjustment_approvals', is_on: false, changed_by: null }]);
    // Every piece the app named then is one the column takes, and nothing else is (497 adds FleetSuite's own numbers).
    const then = SWITCH_PIECES.filter((piece) => piece !== 'own_numbers');
    expect(then).toHaveLength(16);
    await pg.exec('BEGIN');
    try {
      for (const piece of then) await pg.query('INSERT INTO books_switches (piece) VALUES ($1) ON CONFLICT (piece) DO NOTHING', [piece]);
      expect((await pg.query('SELECT count(*)::int AS n FROM books_switches')).rows[0]).toEqual({ n: 16 });
    } finally {
      await pg.exec('ROLLBACK');
    }
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
    const checks = (await pg.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%piece%'`)).rows;
    expect(checks).toHaveLength(1);
  });

  it('keeps an adjustment asked for, working out its change, once per press', async () => {
    const first = await ask(pg, ASK(1));
    expect(first.state).toBe('asked');
    expect(askFromRow(first.ask)).toMatchObject({
      id: ASK(1), netsuiteItemId: '5512', itemNumber: 'HX-2200', locationId: '1', mode: 'delta', enteredQty: -2, onHandThen: 7, change: -2,
      reason: 'Damaged', note: 'Box crushed on delivery', status: 'waiting', askedBy: JESSIE, askedByName: 'Jessie', sentAt: null, decidedAt: null,
    });
    expect(await row(pg, ASK(1))).toMatchObject({
      part_id: HITCH, entered_qty: -2, on_hand_then: 7, change: -2, status: 'waiting', has_sent_at: false, has_decided_at: false, why: null, error: null,
    });

    // The same press sent again is the one kept, whatever it says this time.
    const again = await ask(pg, ASK(1), { qty: -5, note: 'Another note' });
    expect(again.state).toBe('same');
    expect(again.ask).toMatchObject({ id: ASK(1), change: -2, note: 'Box crushed on delivery' });

    // Another for the same shelf waits for that one, and nothing is kept.
    const second = await ask(pg, ASK(2), { by: ZACH, byName: 'Zach', mode: 'count', qty: 9 });
    expect(second.state).toBe('waiting');
    expect(second.ask).toMatchObject({ id: ASK(1), status: 'waiting' });
    expect(await row(pg, ASK(2))).toBeUndefined();

    // A shelf count is the count less NetSuite's count then; another item, or the same one somewhere else, is its own shelf.
    const counted = await ask(pg, ASK(3), {
      by: ZACH, byName: '', partId: LADDER, netsuiteItemId: '6140', itemNumber: 'LR-48', mode: 'count', qty: 12, onHand: 9, reason: 'Count correction', note: '  ',
    });
    expect(counted.state).toBe('asked');
    expect(await row(pg, ASK(3))).toMatchObject({ mode: 'count', entered_qty: 12, on_hand_then: 9, change: 3, note: null, asked_by_name: null });
    expect((await ask(pg, ASK(4), { locationId: '7', qty: 4, onHand: 0, reason: 'Found', note: null, partId: null })).state).toBe('asked');
    expect(await row(pg, ASK(4))).toMatchObject({ location_id: '7', change: 4, part_id: null, note: null });
    // A count down to nothing is a change too.
    const emptied = workOutAsk('count', 0, 3);
    expect(emptied).toEqual({ change: -3, after: 0 });
    expect((await ask(pg, ASK(5), { netsuiteItemId: '6141', itemNumber: 'LR-60', mode: 'count', qty: 0, onHand: 3 })).state).toBe('asked');
    expect(await row(pg, ASK(5))).toMatchObject({ change: -3, entered_qty: 0 });
    expect(await count(pg)).toBe(4);
  });

  it("refuses one that isn't whole, and keeps nothing of it", async () => {
    const before = await count(pg);
    const refused = async (over: Partial<Parameters<typeof askPayload>[0]>, why: RegExp) =>
      expect(ask(pg, ASK(90), { netsuiteItemId: '7000', ...over })).rejects.toThrow(why);
    await refused({ by: '' }, /needs who asked/);
    await expect(call(pg, 'inventory_adjustment_ask', { ...asked(ASK(90)), by: undefined })).rejects.toThrow(/needs who asked/);
    // Nothing to change, a part of one, below the shelf, or a count below none.
    await refused({ qty: 0 }, /check constraint/);
    await refused({ mode: 'count', qty: 7, onHand: 7 }, /check constraint/);
    await refused({ qty: 1.5 }, /check constraint/);
    await refused({ mode: 'count', qty: 12, onHand: 9.5 }, /check constraint/);
    await refused({ mode: 'count', qty: 12.5, onHand: 9.5 }, /check constraint/);
    await refused({ qty: -8, onHand: 7 }, /check constraint/);
    await refused({ mode: 'count', qty: -1, onHand: 0 }, /check constraint/);
    // What it's on and why.
    await refused({ reason: 'Stolen' }, /check constraint/);
    await refused({ note: 'x'.repeat(501) }, /check constraint/);
    await refused({ netsuiteItemId: 'HX-2200' }, /check constraint/);
    await refused({ locationId: "O'Fallon" }, /check constraint/);
    await refused({ itemNumber: '   ' }, /check constraint/);
    await refused({ itemNumber: 'x'.repeat(301) }, /check constraint/);
    await refused({ mode: 'set' as never }, /check constraint/);
    await refused({ byName: 'x'.repeat(201) }, /check constraint/);
    await refused({ partId: 'b0000000-0000-4000-8000-000000000099' }, /foreign key/);
    await refused({ by: 'a0000000-0000-4000-8000-000000000099' }, /foreign key/);
    expect(await count(pg)).toBe(before);
    // Adjust's own rules say the same, before anything is asked.
    expect(workOutAsk('count', 12, 9.5)).toEqual({
      error: "NetSuite shows 9.5 on hand, which isn't a whole number, so a shelf count can't be asked for. Add or remove a whole number instead.",
    });
    expect(workOutAsk('delta', -8, 7)).toEqual({ error: "That would leave -1 on hand. NetSuite can't go below 0. Check the count." });
    expect(workOutAsk('delta', 2, 9.5)).toEqual({ change: 2, after: 11.5 });
  });

  it("is claimed by a press of Approve from someone who didn't ask, and let go when NetSuite refuses it", async () => {
    const untouched = await others(pg, ASK(1));
    await expect(call(pg, 'inventory_adjustment_claim', { id: ASK(1) })).rejects.toThrow(/needs who approved/);
    expect(await call(pg, 'inventory_adjustment_claim', { id: ASK(1), by: JESSIE, by_name: 'Jessie' })).toMatchObject({ state: 'own', ask: { status: 'waiting' } });
    expect(await call(pg, 'inventory_adjustment_claim', { id: ASK(99), by: CRAIG })).toEqual({ state: 'gone' });

    const claimed = await call(pg, 'inventory_adjustment_claim', { id: ASK(1), by: CRAIG, by_name: ' Craig ' });
    expect(claimed).toMatchObject({ state: 'claimed', ask: { id: ASK(1), status: 'sending', sent_by: CRAIG, sent_by_name: 'Craig', error: null } });
    expect(await row(pg, ASK(1))).toMatchObject({ status: 'sending', has_sent_at: true, has_decided_at: false });
    // A second press, or one from whoever asked, finds it being posted.
    expect(await call(pg, 'inventory_adjustment_claim', { id: ASK(1), by: ZACH })).toMatchObject({ state: 'sending' });
    expect(await call(pg, 'inventory_adjustment_claim', { id: ASK(1), by: JESSIE })).toMatchObject({ state: 'sending' });
    // While it's being posted nobody turns it down, withdraws it, or asks another for the shelf.
    expect(await call(pg, 'inventory_adjustment_turn_down', { id: ASK(1), by: ZACH, why: 'Recount first' })).toMatchObject({ state: 'sending' });
    expect(await call(pg, 'inventory_adjustment_withdraw', { id: ASK(1), by: JESSIE })).toMatchObject({ state: 'sending' });
    expect((await ask(pg, ASK(6))).state).toBe('waiting');

    // NetSuite refused: back to wait, keeping why, and nobody holds it.
    expect(await call(pg, 'inventory_adjustment_let_go', { id: ASK(1), error: ' NetSuite refused the adjustment (400): Invalid account ' }))
      .toEqual({ let_go: true });
    expect(await row(pg, ASK(1))).toMatchObject({
      status: 'waiting', sent_by: null, sent_by_name: null, has_sent_at: false, error: 'NetSuite refused the adjustment (400): Invalid account',
    });
    expect(await call(pg, 'inventory_adjustment_let_go', { id: ASK(1), error: 'again' })).toEqual({ let_go: false });
    expect(await call(pg, 'inventory_adjustment_unsure', { id: ASK(1), error: 'again' })).toEqual({ unsure: false });
    expect(await call(pg, 'inventory_adjustment_made', { id: ASK(1), netsuite_number: 'INVADJ9' })).toEqual({ made: false });
    expect((await row(pg, ASK(1))).status).toBe('waiting');
    expect(await others(pg, ASK(1))).toEqual(untouched);

    // A let go with no reason still says it wasn't posted; the next claim clears it.
    await call(pg, 'inventory_adjustment_claim', { id: ASK(1), by: CRAIG });
    expect(await call(pg, 'inventory_adjustment_let_go', { id: ASK(1), error: '  ' })).toEqual({ let_go: true });
    expect((await row(pg, ASK(1))).error).toBe('Not posted');
    await call(pg, 'inventory_adjustment_claim', { id: ASK(1), by: CRAIG });
    expect((await row(pg, ASK(1))).error).toBeNull();
    await call(pg, 'inventory_adjustment_let_go', { id: ASK(1), error: 'x'.repeat(2100) });
    expect((await row(pg, ASK(1))).error).toHaveLength(2000);
  });

  it('keeps the adjustment NetSuite posted, and then the shelf is free', async () => {
    const untouched = await others(pg, ASK(1));
    await call(pg, 'inventory_adjustment_claim', { id: ASK(1), by: CRAIG, by_name: 'Craig' });
    expect(await call(pg, 'inventory_adjustment_made', { id: ASK(1), netsuite_number: ' INVADJ1042 ', warning: '  ' })).toEqual({ made: true });
    expect(await row(pg, ASK(1))).toMatchObject({
      status: 'made', netsuite_adjustment_number: 'INVADJ1042', decided_by: CRAIG, decided_by_name: 'Craig', has_decided_at: true,
      sent_by: CRAIG, has_sent_at: true, error: null, warning: null,
    });
    expect(await call(pg, 'inventory_adjustment_made', { id: ASK(1), netsuite_number: 'INVADJ1043' })).toEqual({ made: false });
    expect((await row(pg, ASK(1))).netsuite_adjustment_number).toBe('INVADJ1042');
    for (const fn of ['inventory_adjustment_claim', 'inventory_adjustment_withdraw']) {
      expect(await call(pg, fn, { id: ASK(1), by: JESSIE })).toMatchObject({ state: 'made' });
    }
    expect(await call(pg, 'inventory_adjustment_turn_down', { id: ASK(1), by: ZACH, why: 'Too late' })).toMatchObject({ state: 'made' });
    const already = await call(pg, 'inventory_adjustment_settle', { id: ASK(1), by: ZACH, made: false });
    expect(already).toMatchObject({ state: 'made' });
    expect(already.settled).toBeUndefined();
    expect(await others(pg, ASK(1))).toEqual(untouched);

    // Made: another can be asked for the hitch receiver at O'Fallon now. Posted without a number, and with a warning, it's kept so.
    expect((await ask(pg, ASK(6), { qty: 1, onHand: 5, reason: 'Found', note: null })).state).toBe('asked');
    await call(pg, 'inventory_adjustment_claim', { id: ASK(6), by: ZACH, by_name: 'Zach' });
    expect(await call(pg, 'inventory_adjustment_made', { id: ASK(6), warning: "Posted in NetSuite, but FleetSuite couldn't save it to the history: down" }))
      .toEqual({ made: true });
    expect(await row(pg, ASK(6))).toMatchObject({
      status: 'made', netsuite_adjustment_number: null, decided_by: ZACH, warning: "Posted in NetSuite, but FleetSuite couldn't save it to the history: down",
    });
  });

  it("keeps one FleetSuite couldn't tell about, for a super admin to settle", async () => {
    // The ladder rack's count: NetSuite didn't answer.
    await call(pg, 'inventory_adjustment_claim', { id: ASK(3), by: CRAIG, by_name: 'Craig' });
    expect(await call(pg, 'inventory_adjustment_unsure', { id: ASK(3), error: "Couldn't reach NetSuite: fetch failed" })).toEqual({ unsure: true });
    expect(await row(pg, ASK(3))).toMatchObject({ status: 'unsure', has_sent_at: true, error: "Couldn't reach NetSuite: fetch failed", has_decided_at: false });
    expect(await call(pg, 'inventory_adjustment_unsure', { id: ASK(3), error: 'again' })).toEqual({ unsure: false });
    // Nobody approves it again, turns it down or withdraws it, and the shelf stays held.
    expect(await call(pg, 'inventory_adjustment_claim', { id: ASK(3), by: JESSIE })).toMatchObject({ state: 'unsure' });
    expect(await call(pg, 'inventory_adjustment_turn_down', { id: ASK(3), by: JESSIE, why: 'No' })).toMatchObject({ state: 'unsure' });
    expect(await call(pg, 'inventory_adjustment_withdraw', { id: ASK(3), by: ZACH })).toMatchObject({ state: 'unsure' });
    expect((await ask(pg, ASK(7), { partId: LADDER, netsuiteItemId: '6140', itemNumber: 'LR-48' })).state).toBe('waiting');

    // Settling says who, and whether NetSuite has it, as true or false.
    await expect(call(pg, 'inventory_adjustment_settle', { id: ASK(3), made: true })).rejects.toThrow(/needs who settled it/);
    for (const made of ['yes', 1, null, undefined]) {
      await expect(call(pg, 'inventory_adjustment_settle', { id: ASK(3), by: CRAIG, made })).rejects.toThrow(/says whether NetSuite has it/);
    }
    expect(await call(pg, 'inventory_adjustment_settle', { id: ASK(99), by: CRAIG, made: true })).toEqual({ state: 'gone' });
    const untouched = await others(pg, ASK(3));
    const settled = await call(pg, 'inventory_adjustment_settle', { id: ASK(3), by: JESSIE, by_name: ' Jessie ', made: true, netsuite_number: ' INVADJ1050 ' });
    expect(settled).toMatchObject({ state: 'made', settled: true, ask: { status: 'made', netsuite_adjustment_number: 'INVADJ1050', decided_by: JESSIE } });
    expect(await row(pg, ASK(3))).toMatchObject({ status: 'made', decided_by: JESSIE, decided_by_name: 'Jessie', sent_by: CRAIG, error: null, has_decided_at: true });
    expect(await others(pg, ASK(3))).toEqual(untouched);

    // A press still posting can't be settled until it's been longer than one takes; then "it isn't in NetSuite" puts it back to wait.
    expect((await ask(pg, ASK(7), { partId: LADDER, netsuiteItemId: '6140', itemNumber: 'LR-48', mode: 'count', qty: 11, onHand: 12 })).state).toBe('asked');
    await call(pg, 'inventory_adjustment_claim', { id: ASK(7), by: CRAIG, by_name: 'Craig' });
    const early = await call(pg, 'inventory_adjustment_settle', { id: ASK(7), by: ZACH, made: false });
    expect(early).toMatchObject({ state: 'not_yet', ask: { status: 'sending' } });
    expect(early.settled).toBeUndefined();
    await sentAgo(pg, ASK(7), 4);
    expect(await call(pg, 'inventory_adjustment_settle', { id: ASK(7), by: ZACH, made: false })).toMatchObject({ state: 'not_yet' });
    await sentAgo(pg, ASK(7), 6);
    const back = await call(pg, 'inventory_adjustment_settle', { id: ASK(7), by: ZACH, by_name: ' Zach ', made: false });
    expect(back).toMatchObject({ state: 'waiting', settled: true, ask: { status: 'waiting', sent_by: null, sent_at: null, error: 'Not in NetSuite, said Zach' } });
    expect(await row(pg, ASK(7))).toMatchObject({ status: 'waiting', has_sent_at: false, has_decided_at: false, decided_by: null });
    // Waiting, there's nothing to settle; settled without a name, it says a super admin did.
    const nothing = await call(pg, 'inventory_adjustment_settle', { id: ASK(7), by: ZACH, made: true });
    expect(nothing).toMatchObject({ state: 'waiting' });
    expect(nothing.settled).toBeUndefined();
    await call(pg, 'inventory_adjustment_claim', { id: ASK(7), by: CRAIG });
    await call(pg, 'inventory_adjustment_unsure', { id: ASK(7), error: '' });
    expect((await row(pg, ASK(7))).error).toBe('No answer from NetSuite');
    await call(pg, 'inventory_adjustment_settle', { id: ASK(7), by: ZACH, made: false });
    expect((await row(pg, ASK(7))).error).toBe('Not in NetSuite, said a super admin');
    // Settled as made after more than five minutes, with no number.
    await call(pg, 'inventory_adjustment_claim', { id: ASK(7), by: CRAIG });
    await sentAgo(pg, ASK(7), 30);
    expect(await call(pg, 'inventory_adjustment_settle', { id: ASK(7), by: JESSIE, made: true })).toMatchObject({ state: 'made', ask: { netsuite_adjustment_number: null } });
  });

  it('is turned down with why by a super admin who didn\'t ask, or withdrawn by whoever asked', async () => {
    // The hitch receiver at the van: Jessie asked.
    await expect(call(pg, 'inventory_adjustment_turn_down', { id: ASK(4), why: 'Recount' })).rejects.toThrow(/needs who turned it down/);
    for (const why of [undefined, '', '   ', 'x'.repeat(301)]) {
      await expect(call(pg, 'inventory_adjustment_turn_down', { id: ASK(4), by: CRAIG, why })).rejects.toThrow(/needs why, 300 characters at most/);
    }
    expect(await call(pg, 'inventory_adjustment_turn_down', { id: ASK(4), by: JESSIE, why: 'Mine' })).toMatchObject({ state: 'own' });
    expect(await call(pg, 'inventory_adjustment_turn_down', { id: ASK(99), by: CRAIG, why: 'Gone' })).toEqual({ state: 'gone' });
    const untouched = await others(pg, ASK(4));
    const down = await call(pg, 'inventory_adjustment_turn_down', { id: ASK(4), by: CRAIG, by_name: ' Craig ', why: '  Count the van again first  ' });
    expect(down).toMatchObject({ state: 'turned_down', ask: { status: 'turned_down', why: 'Count the van again first', decided_by: CRAIG } });
    expect(await row(pg, ASK(4))).toMatchObject({ status: 'turned_down', decided_by_name: 'Craig', has_decided_at: true, has_sent_at: false });
    expect(await others(pg, ASK(4))).toEqual(untouched);
    expect(await call(pg, 'inventory_adjustment_turn_down', { id: ASK(4), by: ZACH, why: 'Again' })).toMatchObject({ state: 'turned_down' });
    expect(await call(pg, 'inventory_adjustment_claim', { id: ASK(4), by: CRAIG })).toMatchObject({ state: 'turned_down' });
    expect(await call(pg, 'inventory_adjustment_withdraw', { id: ASK(4), by: JESSIE })).toMatchObject({ state: 'turned_down' });
    expect((await row(pg, ASK(4))).why).toBe('Count the van again first');
    // Turned down, the shelf is free again.
    expect((await ask(pg, ASK(8), { locationId: '7', qty: 3, onHand: 0, reason: 'Found', note: null })).state).toBe('asked');

    // Withdrawn: only by whoever asked, and only while it waits.
    await expect(call(pg, 'inventory_adjustment_withdraw', { id: ASK(8) })).rejects.toThrow(/needs who withdrew it/);
    expect(await call(pg, 'inventory_adjustment_withdraw', { id: ASK(8), by: CRAIG })).toMatchObject({ state: 'not_yours', ask: { status: 'waiting' } });
    expect(await call(pg, 'inventory_adjustment_withdraw', { id: ASK(99), by: JESSIE })).toEqual({ state: 'gone' });
    const left = await others(pg, ASK(8));
    expect(await call(pg, 'inventory_adjustment_withdraw', { id: ASK(8), by: JESSIE, by_name: ' Jessie ' }))
      .toMatchObject({ state: 'withdrawn', ask: { status: 'withdrawn', decided_by: JESSIE, decided_by_name: 'Jessie' } });
    expect(await others(pg, ASK(8))).toEqual(left);
    expect(await call(pg, 'inventory_adjustment_withdraw', { id: ASK(8), by: JESSIE })).toMatchObject({ state: 'withdrawn' });
    expect(await call(pg, 'inventory_adjustment_claim', { id: ASK(8), by: CRAIG })).toMatchObject({ state: 'withdrawn' });
  });

  it('outlives whoever asked and the part, and then anyone approves it', async () => {
    expect((await ask(pg, ASK(9), { by: ZACH, byName: 'Zach', partId: LADDER, netsuiteItemId: '6150', itemNumber: 'LR-72', qty: 1, onHand: 1 })).state).toBe('asked');
    await pg.exec('RESET ROLE');
    await pg.query('DELETE FROM profiles WHERE id = $1', [ZACH]);
    await pg.query('DELETE FROM netsuite_parts WHERE id = $1', [LADDER]);
    await pg.exec('SET ROLE service_role');
    expect(await row(pg, ASK(9))).toMatchObject({ asked_by: null, asked_by_name: 'Zach', part_id: null, status: 'waiting' });
    expect(await row(pg, ASK(3))).toMatchObject({ part_id: null, status: 'made' });
    // Nobody can withdraw it now, but a super admin can still approve it or turn it down.
    expect(await call(pg, 'inventory_adjustment_withdraw', { id: ASK(9), by: CRAIG })).toMatchObject({ state: 'not_yours' });
    expect(await call(pg, 'inventory_adjustment_claim', { id: ASK(9), by: CRAIG })).toMatchObject({ state: 'claimed' });
  });

  it('keeps each one where it can be, even written straight to the table', async () => {
    const refused = (sql: string, id: string, why = /check constraint/) => expect(pg.query(sql, [id])).rejects.toThrow(why);
    // The LR-60 count, waiting.
    await refused(`UPDATE inventory_adjustment_asks SET status = 'made' WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET status = 'sending' WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET status = 'turned_down', decided_at = now() WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET status = 'withdrawn' WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET status = 'done' WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET change = 2 WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET on_hand_then = 2 WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET why = repeat('x', 301) WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET netsuite_adjustment_number = repeat('x', 61) WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET warning = repeat('x', 2001) WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET error = repeat('x', 2001) WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET sent_by_name = repeat('x', 201) WHERE id = $1`, ASK(5));
    await refused(`UPDATE inventory_adjustment_asks SET decided_by_name = repeat('x', 201) WHERE id = $1`, ASK(5));
    // The hitch receiver found at O'Fallon, a change of one: a change entered is the change.
    await refused(`UPDATE inventory_adjustment_asks SET change = 3 WHERE id = $1`, ASK(6));
    await refused(`UPDATE inventory_adjustment_asks SET sent_at = NULL WHERE id = $1`, ASK(1));
    await refused(`UPDATE inventory_adjustment_asks SET decided_at = NULL WHERE id = $1`, ASK(4));
    await refused(`UPDATE inventory_adjustment_asks SET why = ' ' WHERE id = $1`, ASK(4));
    // Two open for one shelf can't be: the van's hitch receiver turned down can wait again, but then the one withdrawn there can't.
    await pg.query(`UPDATE inventory_adjustment_asks SET status = 'waiting', decided_at = NULL, why = NULL WHERE id = $1`, [ASK(4)]);
    await refused(`UPDATE inventory_adjustment_asks SET status = 'waiting', decided_at = NULL WHERE id = $1`, ASK(8), /inventory_adjustment_asks_one_open/);
    for (const status of ['sending', 'unsure']) {
      await refused(`UPDATE inventory_adjustment_asks SET status = '${status}', sent_at = now() WHERE id = $1`, ASK(8), /inventory_adjustment_asks_one_open/);
    }
  });

  it('lets only the server login near it', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        await expect(pg.query('SELECT * FROM inventory_adjustment_asks')).rejects.toThrow(/permission denied/);
        for (const fn of [
          'inventory_adjustment_ask', 'inventory_adjustment_claim', 'inventory_adjustment_let_go', 'inventory_adjustment_unsure',
          'inventory_adjustment_made', 'inventory_adjustment_settle', 'inventory_adjustment_turn_down', 'inventory_adjustment_withdraw',
        ]) {
          await expect(call(pg, fn, { id: ASK(5), by: CRAIG })).rejects.toThrow(/permission denied for function/);
        }
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    await pg.exec('RESET ROLE');
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'inventory_adjustment_asks'`);
    expect(rls.rows).toEqual([{ relname: 'inventory_adjustment_asks', relrowsecurity: true }]);
    await pg.exec('SET ROLE service_role');
  });
});
