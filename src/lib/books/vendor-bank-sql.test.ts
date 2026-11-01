// Migration 490 keeps vendor bank numbers for ACH: each set entered for a
// vendor waits for a call-back, once per press and one set waiting per
// vendor; a call-back that reads other numbers counts a try and the third
// refuses them; a super admin who didn't enter them confirms them, replacing
// the vendor's confirmed set before; and a set waiting is refused, or one
// confirmed removed, with why. Only a set waiting or confirmed keeps its
// locked numbers, the database holds nothing but locked ones, and no note
// holds an account number. This runs the migration in an in-memory Postgres
// (PGlite) as the app's server login, the way /api/pay-vendors/bank calls
// it. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const ROW = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const HAROLD = 'a0000000-0000-4000-8000-000000000002';

async function freshDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    -- What migration 490 points at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}'), ('${HAROLD}');
  `);
  const sql = readFileSync(path.resolve(__dirname, '../../../migrations/490-vendor-bank-numbers-kept-encrypted.sql'), 'utf8');
  await pg.exec(sql);
  await pg.exec(sql); // must be safe to re-run
  await pg.exec('SET ROLE service_role');
  return pg;
}

const call = async <T = any>(pg: PGlite, fn: string, p: unknown) =>
  (await pg.query<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

type Row = Record<string, any>;
const row = async (pg: PGlite, id: string) => (await pg.query<Row>('SELECT * FROM vendor_bank_accounts WHERE id = $1', [id])).rows[0];
const fails = async (pg: PGlite, sql: string, params: unknown[] = []) => {
  await expect(pg.query(sql, params)).rejects.toThrow();
};

/** Locked numbers, shaped as src/lib/vendor-bank-lock.ts makes them (made up: nothing opens them). */
const LOCKED = (n: number) => `v1.0a1b2c3d.${'A'.repeat(15)}${n % 10}.${'B'.repeat(22)}.${'C'.repeat(70)}${n}`;
const SEAL = `0a1b2c3d.${'D'.repeat(43)}`;
const entry = (id: string, vendor: string, over: Row = {}) => ({
  id, vendor_netsuite_id: vendor, vendor_name: '  Ozark Sign Supply ', routing_number: '123456780', account_last4: '6789',
  account_type: 'checking', name_on_account: ' Ozark Sign Supply ', source: ' ACH form emailed by Dana at Ozark, 10/30 ',
  account_locked: LOCKED(Number(id.slice(-3))), by: CRAIG, ...over,
});
const callBack = (id: string, by = HAROLD) => ({ id, by, called_phone: ' 636-555-0142 ', spoke_with: ' Dana in accounts ', confirm_seal: SEAL });

let pg: PGlite;
beforeAll(async () => { pg = await freshDb(); });
afterAll(async () => { await pg.close(); });

describe('entering a vendor\'s bank numbers', () => {
  it('keeps them waiting for a call-back, once per press, one set waiting a vendor', async () => {
    expect(await call(pg, 'vendor_bank_enter', entry(ROW(1), '31'))).toEqual({ state: 'entered', fresh: true });
    expect(await row(pg, ROW(1))).toMatchObject({
      vendor_netsuite_id: '31', vendor_name: 'Ozark Sign Supply', routing_number: '123456780', account_last4: '6789', account_type: 'checking',
      name_on_account: 'Ozark Sign Supply', source: 'ACH form emailed by Dana at Ozark, 10/30', account_locked: LOCKED(1), status: 'pending',
      tries: 0, entered_by: CRAIG, confirmed_by: null, confirm_seal: null, ended_at: null,
    });

    // The same press again is the same entry; its id on another vendor isn't.
    expect(await call(pg, 'vendor_bank_enter', entry(ROW(1), '31'))).toEqual({ state: 'entered', fresh: false });
    expect(await call(pg, 'vendor_bank_enter', entry(ROW(1), '52'))).toEqual({ state: 'taken' });
    // Another set for a vendor with one waiting waits for that one to be confirmed or refused.
    expect(await call(pg, 'vendor_bank_enter', entry(ROW(2), '31', { account_last4: '1111' }))).toEqual({ state: 'waiting' });
    expect(await row(pg, ROW(2))).toBeUndefined();
    expect((await pg.query('SELECT 1 FROM vendor_bank_accounts')).rows).toHaveLength(1);
  });

  it('keeps nothing but locked numbers, and no account number in a note', async () => {
    const bad = async (over: Row) => {
      await expect(call(pg, 'vendor_bank_enter', entry(ROW(900), '77', over))).rejects.toThrow();
      expect(await row(pg, ROW(900))).toBeUndefined();
    };
    await bad({ account_locked: '123456789012' });
    await bad({ account_locked: `v1.0a1b2c3d.${'A'.repeat(16)}.${'B'.repeat(22)}.123 456` });
    await bad({ account_locked: null });
    await bad({ account_locked: `x${LOCKED(900)}` });
    await bad({ account_locked: `v1.0a1b2c3d.${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(39)}` });
    await bad({ routing_number: '12345678' });
    await bad({ account_last4: '12345' });
    await bad({ account_type: 'money_market' });
    await bad({ name_on_account: 'Ozark Sign Supply Co. X' });
    await bad({ name_on_account: '   ' });
    await bad({ source: 'Their form says account 98765432' });
    await bad({ source: '' });
    await bad({ source: 'x'.repeat(301) });
    await bad({ vendor_netsuite_id: 'V31' });
    // A phone written out is fine, and so is a name of 22 characters.
    expect(await call(pg, 'vendor_bank_enter', entry(ROW(901), '78', { source: 'Called 636-555-0142 to ask for it' })))
      .toMatchObject({ state: 'entered' });
    expect(await call(pg, 'vendor_bank_enter', entry(ROW(902), '79', { name_on_account: 'Ozark Sign Supply Co X' })))
      .toMatchObject({ state: 'entered' });
  });
});

describe('a call-back that reads other numbers', () => {
  it('counts a try, and the third refuses them', async () => {
    await call(pg, 'vendor_bank_enter', entry(ROW(10), '40'));
    // Whoever entered them doesn't count tries on them.
    expect(await call(pg, 'vendor_bank_mismatch', { id: ROW(10), by: CRAIG })).toEqual({ state: 'same_person' });
    expect(await call(pg, 'vendor_bank_mismatch', { id: ROW(10) })).toEqual({ state: 'same_person' });
    expect((await row(pg, ROW(10))).tries).toBe(0);

    expect(await call(pg, 'vendor_bank_mismatch', { id: ROW(10), by: HAROLD })).toEqual({ state: 'tried', tries: 1 });
    expect(await call(pg, 'vendor_bank_mismatch', { id: ROW(10), by: HAROLD })).toEqual({ state: 'tried', tries: 2 });
    expect(await row(pg, ROW(10))).toMatchObject({ status: 'pending', tries: 2, account_locked: LOCKED(10) });
    expect(await call(pg, 'vendor_bank_mismatch', { id: ROW(10), by: HAROLD })).toEqual({ state: 'refused', tries: 3 });
    expect(await row(pg, ROW(10))).toMatchObject({
      status: 'refused', tries: 3, account_locked: null, ended_by: HAROLD,
      ended_why: "The numbers read on three call-backs didn't match what was entered.",
    });
    expect((await row(pg, ROW(10))).ended_at).not.toBeNull();

    // Refused, they're done with: no more tries, and no confirming.
    expect(await call(pg, 'vendor_bank_mismatch', { id: ROW(10), by: HAROLD })).toEqual({ state: 'refused' });
    expect(await call(pg, 'vendor_bank_confirm', callBack(ROW(10)))).toEqual({ state: 'refused' });
    expect(await call(pg, 'vendor_bank_mismatch', { id: ROW(999), by: HAROLD })).toEqual({ state: 'gone' });
    // The vendor's numbers can be entered again.
    expect(await call(pg, 'vendor_bank_enter', entry(ROW(11), '40'))).toEqual({ state: 'entered', fresh: true });
  });
});

describe('confirming on a call-back', () => {
  it('takes a super admin who didn\'t enter them, and replaces the vendor\'s confirmed numbers before', async () => {
    await call(pg, 'vendor_bank_enter', entry(ROW(20), '52'));
    expect(await call(pg, 'vendor_bank_confirm', callBack(ROW(20), CRAIG))).toEqual({ state: 'same_person' });
    expect(await call(pg, 'vendor_bank_confirm', { ...callBack(ROW(20)), by: null })).toEqual({ state: 'same_person' });
    expect((await row(pg, ROW(20))).status).toBe('pending');

    expect(await call(pg, 'vendor_bank_confirm', callBack(ROW(20)))).toEqual({ state: 'confirmed', replaced: null });
    const first = await row(pg, ROW(20));
    expect(first).toMatchObject({
      status: 'confirmed', confirmed_by: HAROLD, called_phone: '636-555-0142', spoke_with: 'Dana in accounts', confirm_seal: SEAL,
      account_locked: LOCKED(20), ended_at: null,
    });
    expect(first.confirmed_at).not.toBeNull();
    expect(await call(pg, 'vendor_bank_confirm', callBack(ROW(20)))).toEqual({ state: 'confirmed' });

    // Another vendor's confirmed numbers stay as they are.
    await call(pg, 'vendor_bank_enter', entry(ROW(22), '53'));
    expect(await call(pg, 'vendor_bank_confirm', callBack(ROW(22)))).toEqual({ state: 'confirmed', replaced: null });

    // New numbers for the vendor wait beside the confirmed ones, and replace them once they're confirmed.
    expect(await call(pg, 'vendor_bank_enter', entry(ROW(21), '52', { by: HAROLD, account_last4: '4321' }))).toMatchObject({ fresh: true });
    expect((await row(pg, ROW(20))).status).toBe('confirmed');
    expect(await call(pg, 'vendor_bank_confirm', callBack(ROW(21), CRAIG))).toEqual({ state: 'confirmed', replaced: ROW(20) });
    expect(await row(pg, ROW(20))).toMatchObject({ status: 'replaced', account_locked: null, confirm_seal: null, ended_by: CRAIG, confirmed_by: HAROLD });
    expect((await row(pg, ROW(20))).ended_at).not.toBeNull();
    expect(await row(pg, ROW(21))).toMatchObject({ status: 'confirmed', confirmed_by: CRAIG, account_last4: '4321' });
    expect((await row(pg, ROW(22))).status).toBe('confirmed');
    expect((await pg.query("SELECT id FROM vendor_bank_accounts WHERE vendor_netsuite_id = '52' AND status = 'confirmed'")).rows)
      .toEqual([{ id: ROW(21) }]);
    expect(await call(pg, 'vendor_bank_confirm', callBack(ROW(20)))).toEqual({ state: 'replaced' });
    expect(await call(pg, 'vendor_bank_confirm', callBack(ROW(998)))).toEqual({ state: 'gone' });

    // Not even the server's login keeps two sets confirmed for a vendor.
    await call(pg, 'vendor_bank_enter', entry(ROW(23), '52'));
    await fails(pg, `UPDATE vendor_bank_accounts SET status = 'confirmed', confirm_seal = $1, confirmed_by = $2, confirmed_at = now(),
                     called_phone = '636-555-0142', spoke_with = 'Dana' WHERE id = $3`, [SEAL, HAROLD, ROW(23)]);
    expect((await row(pg, ROW(23))).status).toBe('pending');
  });

  it('keeps the call-back with a confirmation, and the seal only while confirmed', async () => {
    await call(pg, 'vendor_bank_enter', entry(ROW(30), '60'));
    const confirm = async (over: Row) => {
      await expect(call(pg, 'vendor_bank_confirm', { ...callBack(ROW(30)), ...over })).rejects.toThrow();
      expect((await row(pg, ROW(30))).status).toBe('pending');
    };
    await confirm({ confirm_seal: null });
    await confirm({ confirm_seal: 'not a seal' });
    await confirm({ called_phone: '  ' });
    await confirm({ spoke_with: null });
    await confirm({ spoke_with: 'Dana, who read 98765432' });

    // Not even the server's login can keep a seal on numbers waiting, or confirm them as whoever entered them.
    await fails(pg, `UPDATE vendor_bank_accounts SET confirm_seal = $1 WHERE id = $2`, [SEAL, ROW(30)]);
    await fails(pg, `UPDATE vendor_bank_accounts SET status = 'confirmed', confirm_seal = $1, confirmed_by = $2, confirmed_at = now(),
                     called_phone = '636-555-0142', spoke_with = 'Dana' WHERE id = $3`, [SEAL, CRAIG, ROW(30)]);
    // Or keep locked numbers on a set that's done with, end a set still waiting, or count a fourth try.
    await fails(pg, `UPDATE vendor_bank_accounts SET status = 'refused', ended_at = now(), ended_why = 'Typo' WHERE id = $1`, [ROW(30)]);
    await fails(pg, 'UPDATE vendor_bank_accounts SET ended_at = now() WHERE id = $1', [ROW(30)]);
    await fails(pg, 'UPDATE vendor_bank_accounts SET tries = 4 WHERE id = $1', [ROW(30)]);
    expect((await row(pg, ROW(30))).status).toBe('pending');
  });
});

describe('refusing and removing', () => {
  it('refuses numbers waiting and removes confirmed ones, with why, their locked numbers gone', async () => {
    await call(pg, 'vendor_bank_enter', entry(ROW(40), '70'));
    expect(await call(pg, 'vendor_bank_end', { id: ROW(40), by: HAROLD, status: 'removed', why: 'Wrong one' })).toEqual({ state: 'pending' });
    expect(await call(pg, 'vendor_bank_end', { id: ROW(40), by: CRAIG, status: 'refused', why: '  Ozark says they never changed banks.  ' }))
      .toEqual({ state: 'refused' });
    expect(await row(pg, ROW(40))).toMatchObject({
      status: 'refused', account_locked: null, confirm_seal: null, ended_by: CRAIG, ended_why: 'Ozark says they never changed banks.',
    });
    expect(await call(pg, 'vendor_bank_end', { id: ROW(40), by: CRAIG, status: 'refused', why: 'Again' })).toEqual({ state: 'refused' });

    await call(pg, 'vendor_bank_enter', entry(ROW(41), '70'));
    await call(pg, 'vendor_bank_confirm', callBack(ROW(41)));
    expect(await call(pg, 'vendor_bank_end', { id: ROW(41), by: CRAIG, status: 'refused', why: 'Too late' })).toEqual({ state: 'confirmed' });
    expect(await call(pg, 'vendor_bank_end', { id: ROW(41), by: CRAIG, status: 'removed', why: 'They want checks again.' }))
      .toEqual({ state: 'removed' });
    expect(await row(pg, ROW(41))).toMatchObject({
      status: 'removed', account_locked: null, confirm_seal: null, ended_by: CRAIG, ended_why: 'They want checks again.', confirmed_by: HAROLD,
    });
    expect(await call(pg, 'vendor_bank_end', { id: ROW(997), by: CRAIG, status: 'removed', why: 'Gone' })).toEqual({ state: 'gone' });
  });

  it('takes a why with no account number in it, and nothing but refusing or removing', async () => {
    await call(pg, 'vendor_bank_enter', entry(ROW(50), '80'));
    for (const why of ['', '   ', 'The real one is 98765432', 'y'.repeat(301)]) {
      await expect(call(pg, 'vendor_bank_end', { id: ROW(50), by: CRAIG, status: 'refused', why })).rejects.toThrow();
    }
    await expect(call(pg, 'vendor_bank_end', { id: ROW(50), by: CRAIG, status: 'refused' })).rejects.toThrow();
    await expect(call(pg, 'vendor_bank_end', { id: ROW(50), by: CRAIG, why: 'No' })).rejects.toThrow('refuses or removes, not nothing');
    await expect(call(pg, 'vendor_bank_end', { id: ROW(50), by: CRAIG, status: 'confirmed', why: 'No' })).rejects.toThrow('not confirmed');
    expect(await row(pg, ROW(50))).toMatchObject({ status: 'pending', account_locked: LOCKED(50) });
  });
});

describe('who can reach them', () => {
  it('is the server\'s login only', async () => {
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${role}`);
      await fails(pg, 'SELECT * FROM vendor_bank_accounts');
      for (const fn of ['vendor_bank_enter', 'vendor_bank_mismatch', 'vendor_bank_confirm', 'vendor_bank_end']) {
        await fails(pg, `SELECT ${fn}('{}'::jsonb)`);
      }
    }
    await pg.exec('RESET ROLE; SET ROLE service_role');
    expect((await pg.query('SELECT count(*)::int AS n FROM vendor_bank_accounts')).rows[0]).toMatchObject({ n: expect.any(Number) });
    // Nor through PUBLIC, and behind row security even so.
    const reach = await pg.query<{ role: string; fn: string; t: boolean; e: boolean }>(`
      SELECT r.role, f.fn, has_table_privilege(r.role, 'public.vendor_bank_accounts', 'SELECT') AS t,
             has_function_privilege(r.role, 'public.' || f.fn || '(jsonb)', 'EXECUTE') AS e
      FROM unnest(ARRAY['anon', 'authenticated']) AS r(role),
           unnest(ARRAY['vendor_bank_enter', 'vendor_bank_mismatch', 'vendor_bank_confirm', 'vendor_bank_end']) AS f(fn)`);
    expect(reach.rows.filter((x) => x.t || x.e)).toEqual([]);
    expect(reach.rows).toHaveLength(8);
    expect((await pg.query(`SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.vendor_bank_accounts'::regclass`)).rows).toEqual([{ on: true }]);
  });
});
