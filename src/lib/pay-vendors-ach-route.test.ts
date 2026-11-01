// /api/pay-vendors/ach (src/lib/ach-file.ts): super admins only; how a bank
// account's file starts kept switched on or off, BMG's account for the
// offsetting debit typed and kept only locked; a file made only while paying
// vendors is switched on, from an approved run's ACH payments made in
// NetSuite, each paid to the vendor's numbers confirmed on a call-back as
// they open with the key, with its own letter for the day, locked to its id;
// downloaded only while its vendors' numbers are still the ones confirmed;
// marked sent, or set aside with why; every alert to the other super admins
// and whoever's copied on new alerts, with no amounts; and an account number
// never in an answer, an audit or an alert but the file itself. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const MAKER = 'd0000000-0000-4000-8000-000000000001';
const OTHER = 'd0000000-0000-4000-8000-000000000002';
const WATCHER = 'd0000000-0000-4000-8000-000000000003';
const STAFF = 'd0000000-0000-4000-8000-000000000004';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    userId: '',
    roles: [] as string[],
    on: true,
    superAdmins: [] as string[],
    watchers: [] as string[],
    tables: {} as Record<string, Record<string, any>[]>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    rpcErrors: {} as Record<string, string>,
    /** Answers a function gives first, before it answers as migration 491 has it. */
    rpcFirst: {} as Record<string, unknown[]>,
  };
  const rows = (table: string) => (state.tables[table] ??= []);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // An in-memory stand-in for the tables the route reads.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    const sorts: Array<[string, boolean]> = [];
    let limit = Infinity;
    // Postgres refuses an id that isn't a uuid, as every table's id here is.
    let refused: string | null = null;
    const run = () => {
      if (refused) return { data: null, error: { message: refused } };
      const matched = rows(table).filter((r) => filters.every((f) => f(r)));
      const sorted = [...matched].sort((a, b) => {
        for (const [c, up] of sorts) {
          const d = String(a[c]).localeCompare(String(b[c]), 'en', { numeric: true });
          if (d !== 0) return up ? d : -d;
        }
        return 0;
      });
      return { data: sorted.slice(0, limit).map((r) => structuredClone(r)), error: null };
    };
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => {
        if (c === 'id' && !UUID.test(String(v))) refused = `invalid input syntax for type uuid: "${String(v)}"`;
        filters.push((r) => r[c] === v);
        return builder;
      },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      order: (c: string, o?: { ascending?: boolean }) => { sorts.push([c, o?.ascending !== false]); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      maybeSingle: async () => {
        const r = run();
        return { data: (r.data as any[] | null)?.[0] ?? null, error: r.error };
      },
      upsert: async (row: Record<string, any>, opts: { onConflict: string }) => {
        const at = rows(table).findIndex((r) => r[opts.onConflict] === row[opts.onConflict]);
        if (at >= 0) rows(table)[at] = structuredClone(row);
        else rows(table).push(structuredClone(row));
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  // Migration 491's functions, as it has them, on the in-memory tables.
  const files = () => rows('vendor_ach_files');
  const inFiles = () => rows('vendor_ach_file_payments');
  const now = () => new Date().toISOString();
  const ok = (data: unknown) => ({ data, error: null });
  const rpcs: Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }> = {
    vendor_ach_file_save: ({ p }) => {
      if (files().some((f) => f.id === p.id)) return ok({ state: 'made_already' });
      const run = rows('vendor_payment_runs').find((r) => r.id === p.run_id);
      if (!run || !['approved', 'done'].includes(run.status) || run.bank_account_netsuite_id !== p.bank_account_netsuite_id || run.company !== p.company) {
        return ok({ state: 'run' });
      }
      let count = 0;
      let total = 0;
      for (const i of p.payments ?? []) {
        const why = (w: string) => ok({ state: 'payment', payment_id: i.payment_id, why: w });
        const pay = rows('vendor_payment_run_payments').find((x) => x.id === i.payment_id);
        if (!pay || pay.run_id !== run.id || pay.method !== 'ach' || pay.vendor_netsuite_id !== i.vendor_netsuite_id) return why('not_ach');
        if (pay.status !== 'made') return why('not_made');
        if (Number(pay.total_cents) !== i.cents) return why('cents');
        if (inFiles().some((fp) => fp.payment_id === pay.id && fp.live)) return why('in_file');
        const set = rows('vendor_bank_accounts').find((s) => s.id === i.bank_account_id);
        if (!set || set.status !== 'confirmed' || set.vendor_netsuite_id !== pay.vendor_netsuite_id || set.routing_number !== i.routing_number
          || set.account_last4 !== i.account_last4 || set.account_type !== i.account_type || set.name_on_account !== i.name_on_account) return why('bank');
        count += 1;
        total += Number(pay.total_cents);
      }
      if (count === 0 || count !== p.entry_count || total !== p.total_cents) return ok({ state: 'totals' });
      if (files().some((f) => f.destination === p.destination && f.origin === p.origin && f.created_on === p.created_on && f.modifier === p.modifier)) {
        return ok({ state: 'modifier_taken' });
      }
      files().push({
        id: p.id, company: p.company, bank_account_netsuite_id: p.bank_account_netsuite_id, run_id: p.run_id, destination: p.destination, origin: p.origin,
        created_on: p.created_on, created_time: p.created_time, modifier: p.modifier, effective_date: p.effective_date, entry_count: count,
        total_cents: total, entry_hash: p.entry_hash, file_name: p.file_name, file_locked: p.file_locked, status: 'made', made_by: p.by, made_at: now(),
        downloads: 0, downloaded_by: null, downloaded_at: null, sent_by: null, sent_at: null, set_aside_by: null, set_aside_at: null, set_aside_why: null,
      });
      p.payments.forEach((i: Record<string, any>, n: number) => inFiles().push({
        file_id: p.id, payment_id: i.payment_id, position: n + 1, vendor_netsuite_id: i.vendor_netsuite_id, vendor_name: i.vendor_name?.trim() || null,
        bank_account_id: i.bank_account_id, routing_number: i.routing_number, account_last4: i.account_last4, account_type: i.account_type,
        name_on_account: i.name_on_account, cents: i.cents, live: true,
      }));
      return ok({ state: 'made' });
    },
    vendor_ach_file_downloaded: ({ p }) => {
      const f = files().find((x) => x.id === p.id);
      if (!f) return ok({ state: 'gone' });
      if (f.status !== 'made') return ok({ state: f.status });
      const changed = inFiles().filter((fp) => fp.file_id === f.id).sort((a, b) => a.position - b.position)
        .find((fp) => rows('vendor_bank_accounts').find((s) => s.id === fp.bank_account_id)?.status !== 'confirmed');
      if (changed) return ok({ state: 'bank', vendor_name: changed.vendor_name || `Vendor ${changed.vendor_netsuite_id}` });
      Object.assign(f, { downloads: f.downloads + 1, downloaded_by: p.by, downloaded_at: now() });
      return ok({ state: 'downloaded', downloads: f.downloads });
    },
    vendor_ach_file_sent: ({ p }) => {
      const f = files().find((x) => x.id === p.id);
      if (!f) return ok({ state: 'gone' });
      if (f.status === 'sent') return ok({ state: 'sent_already' });
      if (f.status !== 'made') return ok({ state: f.status });
      Object.assign(f, { status: 'sent', sent_by: p.by, sent_at: now(), file_locked: null });
      return ok({ state: 'sent' });
    },
    vendor_ach_file_set_aside: ({ p }) => {
      const f = files().find((x) => x.id === p.id);
      if (!f) return ok({ state: 'gone' });
      if (f.status === 'set_aside') return ok({ state: 'set_aside_already' });
      const was = f.status;
      Object.assign(f, { status: 'set_aside', set_aside_by: p.by, set_aside_at: now(), set_aside_why: p.why.trim(), file_locked: null });
      for (const fp of inFiles()) if (fp.file_id === f.id) fp.live = false;
      return ok({ state: 'set_aside', was });
    },
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, structuredClone(args)]);
      if (state.rpcErrors[fn]) return { data: null, error: { message: state.rpcErrors[fn] } };
      const first = state.rpcFirst[fn]?.shift();
      if (first !== undefined) return { data: first, error: null };
      return rpcs[fn] ? rpcs[fn](args) : { data: null, error: { message: `nothing answers ${fn}` } };
    },
  };
  return { state, service };
});

vi.mock('@/lib/api-auth', () => ({
  requireSuperAdmin: vi.fn(async () => (h.state.roles.includes('super_admin')
    ? { user: { id: h.state.userId }, profile: { roles: h.state.roles } }
    : { error: new Response('Forbidden', { status: 403 }) })),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/notify', () => ({
  getSuperAdminIds: vi.fn(async (exclude?: string | null) => h.state.superAdmins.filter((id) => id !== exclude)),
  notifyMany: vi.fn(async () => {}),
}));
vi.mock('@/lib/new-alert-watchers', () => ({ newAlertWatcherIds: vi.fn(async () => h.state.watchers) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/books/switches', () => ({ switchIsOn: vi.fn(async () => h.state.on) }));
vi.mock('@/lib/books/bank-accounts', () => {
  const companies = [{ code: 'BMG', name: 'BMG Fleet Installations', id: 'c1', subsidiaryId: '1' }];
  return {
    readBankCompanies: vi.fn(async () => companies),
    readBankAccounts: vi.fn(async () => [{ netsuiteId: '211', number: '10100', name: 'Operating Checking' }, { netsuiteId: '214', number: '10200', name: 'Payroll' }]),
    companyNamed: (list: typeof companies, code: string | null) => list.find((c) => c.code === code) ?? (code ? null : list[0] ?? null),
  };
});

const { state } = h;

import { logAudit } from '@/lib/audit';
import { notifyMany } from '@/lib/notify';
import { GET, POST } from '../app/api/pay-vendors/ach/route';
import { KEY_MISSING, bankKey, confirmSeal, lockNumbers, lockOffset, openFile, openOffset, type BankKey } from './vendor-bank-lock';
import { buildAchFile, type AchSetup } from './ach-file';
import type { BankNumbers } from './vendor-bank';

const RAW = Buffer.alloc(32, 7).toString('base64');
const OTHER_RAW = Buffer.alloc(32, 9).toString('base64');
const keyOf = (raw: string) => (bankKey(raw) as { key: BankKey }).key;
const KEY = keyOf(RAW);

const RUN = 'e0000000-0000-4000-8000-000000000001';
const PAY = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SET = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FILE = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// November 4, 2026, 9:15 in the morning at BMG (Central Standard Time).
const NOW = '2026-11-04T15:15:00.000Z';

const GATEWAY: BankNumbers = { routing: '071200004', account: '88001234', type: 'savings' };
const DELTA: BankNumbers = { routing: '123456780', account: '4455669012', type: 'checking' };
const OFFSET: BankNumbers = { routing: '081999994', account: '7700012345', type: 'checking' };

const SETUP_ROW = {
  bank_account_netsuite_id: '211', company: 'BMG', destination: '081999994', destination_name: 'FIRST BANK', origin: '1431234567',
  origin_name: 'BMG FLEET INSTALLATIONS', odfi: '08199999', company_name: 'BMG FLEET INSTAL', company_id: '1431234567', entry_description: 'VENDOR PAY',
  sec_code: 'CCD', addenda: true, balanced: false, line_ending: 'crlf', offset_routing: null, offset_last4: null, offset_type: null, offset_locked: null,
  updated_by: OTHER, updated_at: '2026-11-02T15:00:00.000Z',
};
const SETUP: AchSetup = {
  destination: '081999994', destinationName: 'FIRST BANK', origin: '1431234567', originName: 'BMG FLEET INSTALLATIONS', odfi: '08199999',
  companyName: 'BMG FLEET INSTAL', companyId: '1431234567', entryDescription: 'VENDOR PAY', secCode: 'CCD', addenda: true, balanced: false, lineEnding: 'crlf',
};
const TYPED = {
  action: 'setup', company: 'BMG', accountId: '211', destination: '081 999 994', destinationName: 'First Bank', origin: '1431234567',
  originName: 'BMG Fleet Installations', odfi: '08199999', companyName: 'BMG Fleet Instal', companyId: '1431234567', entryDescription: 'Vendor pay',
  secCode: 'CCD', addenda: true, balanced: false, lineEnding: 'crlf',
};

/** A vendor's numbers confirmed on a call-back, as migration 490 keeps them, locked with `key`. */
const setRow = (id: string, vendorId: string, vendorName: string, numbers: BankNumbers, name: string, over: Record<string, unknown> = {}, key = KEY) => ({
  id, vendor_netsuite_id: vendorId, vendor_name: vendorName, routing_number: numbers.routing, account_last4: numbers.account.slice(-4),
  account_type: numbers.type, name_on_account: name, status: 'confirmed', account_locked: lockNumbers(key, numbers, vendorId, id),
  confirm_seal: confirmSeal(key, vendorId, id), ...over,
});
const bill = (id: string, number: string, cents: number) => ({ bill_netsuite_id: id, number, date: '2026-10-06', due_date: '2026-11-05', open_cents: cents, cents });
const payment = (n: number, vendorId: string, vendorName: string, method: string, status: string, cents: number, bills: unknown[], over: Record<string, unknown> = {}) => ({
  id: PAY(n), run_id: RUN, position: n, vendor_netsuite_id: vendorId, vendor_name: vendorName, method, bills, total_cents: cents, status,
  netsuite_payment_id: status === 'made' ? String(8300 + n) : null, netsuite_number: status === 'made' ? `${1050 + n}` : null, ...over,
});

const get = (query: string) => GET(new NextRequest(`https://app.test/api/pay-vendors/ach?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/pay-vendors/ach', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const as = (userId: string, roles: string[] = ['super_admin']) => { state.userId = userId; state.roles = roles; };
const rpcNames = () => state.rpcs.map(([fn]) => fn);
const audits = () => vi.mocked(logAudit).mock.calls.map(([, entry]) => entry as any);
const alerts = () => vi.mocked(notifyMany).mock.calls.map(([to, alert]) => ({ to, ...(alert as any) }));
const files = () => state.tables.vendor_ach_files ?? [];
const make = (over: Record<string, unknown> = {}) => post({ action: 'make', id: FILE(1), runId: RUN, paymentIds: [PAY(2), PAY(3)], ...over });

/** Everything an answer, the audits, the alerts and the tables said but the locked copies, to look through for account numbers. */
const said = (answer: unknown) => [JSON.stringify(answer), JSON.stringify(audits()), JSON.stringify(alerts()), JSON.stringify(state.tables)].join('\n');

/** The file made from Gateway's and Delta's payments, as the route should make it. */
const expectedFile = (modifier = 'A') => buildAchFile({
  setup: SETUP, offset: null, createdDay: '2026-11-04', createdTime: '0915', modifier, effectiveDate: '2026-11-06',
  payees: [
    { ...GATEWAY, cents: 245000, name: 'Gateway Steel Inc', reference: '1052', bills: [{ number: 'GS-209', cents: 245000 }] },
    { ...DELTA, cents: 7500, name: 'Delta Lighting LLC', reference: '1053', bills: [{ number: 'DL-3', cents: 5000 }, { number: 'DL-4', cents: 2500 }] },
  ],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.mocked(logAudit).mockClear();
  vi.mocked(notifyMany).mockReset().mockResolvedValue(undefined);
  vi.stubEnv('VENDOR_BANK_KEY', RAW);
  as(MAKER);
  state.on = true;
  state.superAdmins = [MAKER, OTHER];
  state.watchers = [WATCHER, OTHER];
  state.rpcs.length = 0;
  state.rpcErrors = {};
  state.rpcFirst = {};
  state.tables = {
    profiles: [{ id: MAKER, full_name: 'Pat Admin' }, { id: OTHER, full_name: 'Lee Owner' }, { id: WATCHER, full_name: 'Sam Watcher' }],
    vendor_payment_runs: [{
      id: RUN, company: 'BMG', bank_account_netsuite_id: '211', bank_account_name: '10100 Operating Checking', pay_date: '2026-11-06', memo: 'November run',
      status: 'approved',
    }],
    vendor_payment_run_payments: [
      payment(1, '31', 'Ozark Hose & Fitting', 'check', 'made', 141240, [bill('7001', 'B-4410', 141240)]),
      payment(2, '47', 'Gateway Steel', 'ach', 'made', 245000, [bill('7003', 'GS-209', 245000)]),
      payment(3, '60', 'Delta Lighting', 'ach', 'made', 7500, [bill('7005', 'DL-3', 5000), bill('7006', 'DL-4', 2500)]),
      payment(4, '52', 'Acme Fasteners', 'ach', 'to_make', 30000, [bill('7004', 'AF-17', 30000)]),
    ],
    vendor_bank_accounts: [
      setRow(SET(1), '47', 'Gateway Steel', GATEWAY, 'Gateway Steel Inc'),
      setRow(SET(3), '60', 'Delta Lighting', DELTA, 'Delta Lighting LLC'),
    ],
    vendor_ach_setups: [structuredClone(SETUP_ROW)],
    vendor_ach_files: [],
    vendor_ach_file_payments: [],
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('who can use it', () => {
  it('is super admins only, to read and to change', async () => {
    as(STAFF, ['admin', 'accounting']);
    expect((await get('company=BMG')).status).toBe(403);
    expect((await get(`run=${RUN}`)).status).toBe(403);
    expect((await get(`download=${FILE(1)}`)).status).toBe(403);
    expect((await make()).status).toBe(403);
    expect((await post(TYPED)).status).toBe(403);
    expect(state.rpcs).toEqual([]);
  });
});

describe('how First Bank takes the file', () => {
  it("shows each of the company's bank accounts and how its file starts, switched on or off", async () => {
    state.on = false;
    const res = await get('company=BMG');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ company: 'BMG', keyProblem: null, switchedOn: false });
    expect(body.accounts).toEqual([
      {
        netsuiteId: '211', name: '10100 Operating Checking',
        setup: {
          destination: '081999994', destinationName: 'FIRST BANK', origin: '1431234567', originName: 'BMG FLEET INSTALLATIONS', odfi: '08199999',
          companyName: 'BMG FLEET INSTAL', companyId: '1431234567', entryDescription: 'VENDOR PAY', secCode: 'CCD', addenda: true, balanced: false,
          lineEnding: 'crlf', offset: null, offsetProblem: null, problems: [], updatedBy: 'Lee Owner', updatedAt: '2026-11-02T15:00:00.000Z',
        },
      },
      { netsuiteId: '214', name: '10200 Payroll', setup: null },
    ]);
  });

  it('keeps it as the file has it, switched off too, and audits it', async () => {
    state.on = false;
    const res = await post({ ...TYPED, accountId: '214', origin: '081999994', lineEnding: 'lf', addenda: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.setup).toMatchObject({ destination: '081999994', destinationName: 'FIRST BANK', companyName: 'BMG FLEET INSTAL', entryDescription: 'VENDOR PAY', addenda: false, lineEnding: 'lf', updatedBy: 'Pat Admin' });
    const kept = state.tables.vendor_ach_setups.find((r) => r.bank_account_netsuite_id === '214');
    expect(kept).toMatchObject({
      company: 'BMG', destination: '081999994', destination_name: 'FIRST BANK', origin: '081999994', origin_name: 'BMG FLEET INSTALLATIONS', odfi: '08199999',
      company_name: 'BMG FLEET INSTAL', company_id: '1431234567', entry_description: 'VENDOR PAY', sec_code: 'CCD', addenda: false, balanced: false,
      line_ending: 'lf', offset_routing: null, offset_locked: null, updated_by: MAKER,
    });
    expect(audits()).toEqual([{
      actorId: MAKER, table: 'vendor_ach_setups', recordId: '214', action: 'ach_setup',
      detail: expect.objectContaining({ destination: '081999994', origin: '081999994', balanced: false, offset_last4: null }),
    }]);
  });

  it('says every problem with how it is typed, and keeps nothing', async () => {
    const res = await post({ ...TYPED, destination: '081999995', companyName: 'BMG FLEET INSTALLATIONS', secCode: 'WEB' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.problems).toEqual([
      "First Bank's routing number: 081999995 isn't a routing number: its last digit doesn't check, so a digit is likely wrong.",
      'The company name takes 16 characters at most: the file has room for no more.',
      'Pick CCD, paying businesses, or PPD, paying people, as First Bank set BMG up.',
    ]);
    expect(body.error).toBe(body.problems[0]);
    expect(state.tables.vendor_ach_setups).toEqual([SETUP_ROW]);
    expect(audits()).toEqual([]);
  });

  it("takes only the company's own bank accounts", async () => {
    const res = await post({ ...TYPED, accountId: '999' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("That isn't one of BMG Fleet Installations's bank accounts in Books.");
    expect((await post({ ...TYPED, company: '1084' })).status).toBe(404);
  });

  it("says what's wrong with how a file starts as it's kept, and makes no file from it", async () => {
    state.tables.vendor_ach_setups[0].company_name = 'BMG FLEET INSTALLATIONS';
    const setup = (await (await get('company=BMG')).json()).accounts[0].setup;
    expect(setup.problems).toEqual(['The company name takes 16 characters at most: the file has room for no more.']);
    const res = await make();
    expect(res.status).toBe(409);
    expect((await res.json()).error)
      .toBe('How First Bank takes the file: The company name takes 16 characters at most: the file has room for no more. Nothing was made.');
    expect(rpcNames()).toEqual([]);
  });

  it("keeps BMG's account for a balanced file only locked, to that bank account, showing its last four digits", async () => {
    const res = await post({ ...TYPED, balanced: true, offset: { routing: '081999994', account: '7700 0123-45', accountAgain: '7700012345', type: 'checking' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.setup).toMatchObject({ balanced: true, offset: { routing: '081999994', last4: '2345', type: 'checking' }, offsetProblem: null });
    const kept = state.tables.vendor_ach_setups[0];
    expect(kept).toMatchObject({ balanced: true, offset_routing: '081999994', offset_last4: '2345', offset_type: 'checking' });
    expect(openOffset(KEY, kept.offset_locked, '211')).toEqual({ numbers: OFFSET });
    expect(openOffset(KEY, kept.offset_locked, '214')).toEqual({ problem: 'broken' });
    expect(audits()[0].detail).toMatchObject({ offset_routing: '081999994', offset_last4: '2345', offset_type: 'checking' });
    expect(audits()[0].detail).not.toHaveProperty('offset_locked');
    expect(said(body).replace(kept.offset_locked, '')).not.toContain('0012345');

    // Saved again with nothing typed for it, the account kept stays.
    expect((await post({ ...TYPED, balanced: true, entryDescription: 'BMG PAY' })).status).toBe(200);
    expect(state.tables.vendor_ach_setups[0]).toMatchObject({ entry_description: 'BMG PAY', offset_locked: kept.offset_locked });
    // Not balanced, it goes.
    expect((await post(TYPED)).status).toBe(200);
    expect(state.tables.vendor_ach_setups[0]).toMatchObject({ balanced: false, offset_routing: null, offset_last4: null, offset_locked: null });
  });

  it("needs BMG's account, typed right, and the key, for a balanced file", async () => {
    const offset = { routing: '081999994', account: '7700012345', accountAgain: '7700012345', type: 'checking' };
    let res = await post({ ...TYPED, balanced: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("A balanced file needs BMG's account the payments come from: type it under How First Bank takes the file.");
    res = await post({ ...TYPED, balanced: true, offset: { ...offset, accountAgain: '7700012346', type: 'money' } });
    expect(res.status).toBe(400);
    expect((await res.json()).problems).toEqual(["The account number typed again isn't the same.", 'Pick checking or savings.']);
    res = await post({ ...TYPED, balanced: true, offset: { ...offset, routing: '081999995', account: '12', accountAgain: '12' } });
    expect((await res.json()).problems).toEqual([
      "081999995 isn't a routing number: its last digit doesn't check, so a digit is likely wrong.",
      'An account number has 4 to 17 digits; that has 2.',
    ]);
    vi.stubEnv('VENDOR_BANK_KEY', '');
    res = await post({ ...TYPED, balanced: true, offset });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(KEY_MISSING);
    expect(state.tables.vendor_ach_setups).toEqual([SETUP_ROW]);
  });

  it("says when BMG's account kept doesn't open with the key, or was changed outside FleetSuite", async () => {
    state.tables.vendor_ach_setups[0] = {
      ...SETUP_ROW, balanced: true, offset_routing: OFFSET.routing, offset_last4: '2345', offset_type: 'checking',
      offset_locked: lockOffset(keyOf(OTHER_RAW), OFFSET, '211'),
    };
    let setup = (await (await get('company=BMG')).json()).accounts[0].setup;
    expect(setup.offsetProblem).toBe("BMG's account for the offsetting debit: These were locked with another key than VENDOR_BANK_KEY holds now: put that key back, or enter them again.");
    for (const changed of [{ offset_last4: '9999' }, { offset_routing: '071200004' }, { offset_type: 'savings' }]) {
      state.tables.vendor_ach_setups[0] = {
        ...SETUP_ROW, balanced: true, offset_routing: OFFSET.routing, offset_last4: '2345', offset_type: 'checking',
        offset_locked: lockOffset(KEY, OFFSET, '211'), ...changed,
      };
      setup = (await (await get('company=BMG')).json()).accounts[0].setup;
      expect(setup.offsetProblem, JSON.stringify(changed)).toBe("BMG's account for the offsetting debit isn't what's locked, so it was changed outside FleetSuite: type it again.");
    }
  });
});

describe("a run's ACH payments", () => {
  it('shows each with the numbers it pays to, as their last four digits, and why one is not ready', async () => {
    state.tables.vendor_payment_run_payments.push(payment(5, '77', 'Midwest Wire', 'ach', 'made', 1200, [bill('7008', 'MW-1', 1200)]));
    state.tables.vendor_bank_accounts.push(setRow(SET(5), '77', 'Midwest Wire', DELTA, 'Midwest Wire', { routing_number: '071200004' }));
    const res = await get(`run=${RUN}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({
      run: { id: RUN, company: 'BMG', accountId: '211', accountName: '10100 Operating Checking', status: 'approved', payDate: '2026-11-06' },
      keyProblem: null, pays: { day: '2026-11-06', text: 'Friday, November 6' }, files: [], switchedOn: true,
    });
    expect(body.setup).toMatchObject({ secCode: 'CCD', problems: [] });
    expect(body.payments.map((p: any) => [p.vendorName, p.totalCents, p.bank?.last4 ?? null, p.why])).toEqual([
      ['Gateway Steel', 245000, '1234', null],
      ['Delta Lighting', 7500, '9012', null],
      ['Acme Fasteners', 30000, null, 'Goes in a file once its bill payment is made in NetSuite.'],
      ['Midwest Wire', 1200, '9012', "What these show isn't what's locked, so they were changed outside FleetSuite: enter them again."],
    ]);
    expect(body.payments[0]).toMatchObject({ number: '1052', bank: { routing: '071200004', type: 'savings', nameOnAccount: 'Gateway Steel Inc' }, fileId: null });
    expect(said(body)).not.toContain('88001234');

    state.tables.vendor_bank_accounts = state.tables.vendor_bank_accounts.filter((s) => s.vendor_netsuite_id !== '60');
    const again = await (await get(`run=${RUN}`)).json();
    expect(again.payments[1].why).toBe('No bank numbers are confirmed on a call-back for Delta Lighting: enter them under Vendor bank numbers.');
    state.tables.vendor_payment_run_payments.find((p) => p.id === PAY(3))!.vendor_name = null;
    const unnamed = await (await get(`run=${RUN}`)).json();
    expect(unnamed.payments[1]).toMatchObject({
      vendorName: 'Vendor 60', why: 'No bank numbers are confirmed on a call-back for Vendor 60: enter them under Vendor bank numbers.',
    });
  });

  it("is shown once a run's approved", async () => {
    state.tables.vendor_payment_runs[0].status = 'waiting';
    expect((await get(`run=${RUN}`)).status).toBe(409);
    expect((await get('run=nope')).status).toBe(404);
  });

  it('says a payment dropped from the run is, and when the key is missing or paying vendors is switched off', async () => {
    state.tables.vendor_payment_run_payments.find((p) => p.id === PAY(4))!.status = 'dropped';
    state.on = false;
    vi.stubEnv('VENDOR_BANK_KEY', '');
    const body = await (await get(`run=${RUN}`)).json();
    expect(body).toMatchObject({ keyProblem: KEY_MISSING, switchedOn: false });
    expect(body.payments[2]).toMatchObject({ vendorName: 'Acme Fasteners', why: 'Dropped from the run.' });
    expect((await (await get('company=BMG')).json()).keyProblem).toBe(KEY_MISSING);
  });

  it("lists them, and puts them in the file, in the run's order", async () => {
    state.tables.vendor_payment_run_payments.find((p) => p.id === PAY(2))!.position = 3;
    state.tables.vendor_payment_run_payments.find((p) => p.id === PAY(3))!.position = 2;
    const body = await (await get(`run=${RUN}`)).json();
    expect(body.payments.map((p: any) => p.vendorName)).toEqual(['Delta Lighting', 'Gateway Steel', 'Acme Fasteners']);
    expect((await make()).status).toBe(200);
    const saved = state.rpcs.find(([fn]) => fn === 'vendor_ach_file_save')![1].p;
    expect(saved.payments.map((p: any) => p.payment_id)).toEqual([PAY(3), PAY(2)]);
  });

  it('lists the files made from it oldest first, each with its payments in order', async () => {
    expect((await make({ id: FILE(2) })).status).toBe(200);
    expect((await post({ action: 'set_aside', fileId: FILE(2), reason: 'Made too soon' })).status).toBe(200);
    vi.setSystemTime(new Date('2026-11-04T15:20:00.000Z'));
    expect((await make({ id: FILE(1) })).status).toBe(200);
    // However the table hands them back.
    state.tables.vendor_ach_file_payments.reverse();
    const body = await (await get(`run=${RUN}`)).json();
    expect(body.files.map((f: any) => [f.id, f.modifier, f.status])).toEqual([[FILE(2), 'A', 'set_aside'], [FILE(1), 'B', 'made']]);
    for (const f of body.files) {
      expect(f.payments).toEqual([
        { vendorName: 'Gateway Steel', cents: 245000, last4: '1234', type: 'savings' },
        { vendorName: 'Delta Lighting', cents: 7500, last4: '9012', type: 'checking' },
      ]);
    }
  });
});

describe('making the file', () => {
  it("pays each to the vendor's numbers confirmed now, locked to the file, and tells the other super admins", async () => {
    const res = await make();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true, id: FILE(1), made: true, fileName: 'ACH-BMG-2026-11-04-A.txt', pays: { day: '2026-11-06', text: 'Friday, November 6' },
    });
    const built = expectedFile();
    const saved = state.rpcs.find(([fn]) => fn === 'vendor_ach_file_save')![1].p;
    expect(saved).toMatchObject({
      id: FILE(1), company: 'BMG', bank_account_netsuite_id: '211', run_id: RUN, destination: '081999994', origin: '1431234567', created_on: '2026-11-04',
      created_time: '0915', modifier: 'A', effective_date: '2026-11-06', entry_count: 2, total_cents: 252500, entry_hash: built.entryHash,
      file_name: 'ACH-BMG-2026-11-04-A.txt', by: MAKER,
    });
    expect(saved.payments).toEqual([
      {
        payment_id: PAY(2), vendor_netsuite_id: '47', vendor_name: 'Gateway Steel', bank_account_id: SET(1), routing_number: '071200004', account_last4: '1234',
        account_type: 'savings', name_on_account: 'Gateway Steel Inc', cents: 245000,
      },
      {
        payment_id: PAY(3), vendor_netsuite_id: '60', vendor_name: 'Delta Lighting', bank_account_id: SET(3), routing_number: '123456780', account_last4: '9012',
        account_type: 'checking', name_on_account: 'Delta Lighting LLC', cents: 7500,
      },
    ]);
    // What's locked is the file, opened only by its own id: each vendor's whole numbers are in it, and nowhere else.
    expect(openFile(KEY, files()[0].file_locked, FILE(1))).toEqual({ text: built.text });
    expect(openFile(KEY, files()[0].file_locked, FILE(2))).toEqual({ problem: 'broken' });
    expect(built.text).toContain('88001234');
    expect(said(body).replace(files()[0].file_locked, '')).not.toMatch(/88001234|4455669012/);

    expect(audits()).toEqual([{
      actorId: MAKER, table: 'vendor_ach_files', recordId: FILE(1), action: 'make',
      detail: {
        run_id: RUN, file_name: 'ACH-BMG-2026-11-04-A.txt', effective_date: '2026-11-06', entries: 2,
        vendors: [
          { vendor_id: '47', vendor: 'Gateway Steel', routing: '071200004', account_ending: '1234', type: 'savings' },
          { vendor_id: '60', vendor: 'Delta Lighting', routing: '123456780', account_ending: '9012', type: 'checking' },
        ],
      },
    }]);
    expect(alerts()).toEqual([{
      to: [OTHER, WATCHER],
      type: 'books_ach_file_made',
      title: 'ACH file made: ACH-BMG-2026-11-04-A.txt',
      body: 'Pat Admin made the ACH file ACH-BMG-2026-11-04-A.txt from the payment run from 10100 Operating Checking dated Friday, November 6, '
        + "paying 2 vendors by ACH. Once it's uploaded, First Bank pays it on Friday, November 6.",
      url: `/admin/pay-vendors?run=${RUN}`,
      channels: ['in_app', 'push', 'email'],
    }]);
    expect(JSON.stringify(alerts())).not.toMatch(/\$|2,525|2525/);
  });

  it("is made only while paying vendors is switched on, with the key, and how First Bank takes it set", async () => {
    state.on = false;
    let res = await make();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Paying vendors is switched off until it moves into FleetSuite during 2027. No ACH file was made.');
    state.on = true;
    vi.stubEnv('VENDOR_BANK_KEY', '');
    expect((await make()).status).toBe(503);
    vi.stubEnv('VENDOR_BANK_KEY', RAW);
    state.tables.vendor_ach_setups = [];
    res = await make();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Set up how First Bank takes the ACH file from 10100 Operating Checking first, under ACH file for First Bank. Nothing was made.');
    state.tables.vendor_ach_setups = [{ ...SETUP_ROW, balanced: true }];
    res = await make();
    expect((await res.json()).error).toBe("A balanced file needs BMG's account the payments come from: type it under How First Bank takes the file. Nothing was made.");
    expect(rpcNames()).toEqual([]);
  });

  it("debits BMG's account kept for a balanced file, for what it pays", async () => {
    state.tables.vendor_ach_setups = [{
      ...SETUP_ROW, balanced: true, offset_routing: OFFSET.routing, offset_last4: '2345', offset_type: 'checking', offset_locked: lockOffset(KEY, OFFSET, '211'),
    }];
    expect((await make()).status).toBe(200);
    const text = (openFile(KEY, files()[0].file_locked, FILE(1)) as { text: string }).text;
    const lines = text.split('\r\n');
    expect(lines[1].slice(1, 4)).toBe('200');
    expect(lines.find((l) => l.startsWith('627'))).toMatch(/^6270819999947700012345\s+0000252500/);
  });

  it("takes only this run's ACH payments made in NetSuite and not in a file", async () => {
    // Midwest Wire's is still being sent to NetSuite; River Bolt's is made without NetSuite's bill payment known.
    state.tables.vendor_payment_run_payments.push(
      payment(5, '77', 'Midwest Wire', 'ach', 'sending', 1200, [bill('7008', 'MW-1', 1200)], { netsuite_payment_id: '8305' }),
      payment(6, '78', 'River Bolt', 'ach', 'made', 900, [bill('7009', 'RB-2', 900)], { netsuite_payment_id: null }),
    );
    for (const ids of [[PAY(1)], [PAY(2), PAY(4)], [PAY(2), PAY(9)], [PAY(2), PAY(5)], [PAY(2), PAY(6)]]) {
      const res = await make({ paymentIds: ids });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Only this run's ACH payments made in NetSuite go in its ACH file. Nothing was made.");
    }
    expect((await make({ paymentIds: [PAY(2)] })).status).toBe(200);
    const res = await make({ id: FILE(2), paymentIds: [PAY(2), PAY(3)] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Gateway Steel is in an ACH file already: reload. Nothing was made.');
    state.tables.vendor_payment_runs[0].status = 'waiting';
    const waiting = await make({ id: FILE(3), paymentIds: [PAY(3)] });
    expect(waiting.status).toBe(409);
    expect((await waiting.json()).error).toBe("Its ACH file is made once it's approved. Nothing was made.");
  });

  it("needs each vendor's numbers confirmed, as they're locked", async () => {
    state.tables.vendor_bank_accounts = [
      setRow(SET(1), '47', 'Gateway Steel', GATEWAY, 'Gateway Steel Inc', {}, keyOf(OTHER_RAW)),
      setRow(SET(3), '60', 'Delta Lighting', DELTA, 'Delta Lighting LLC', { status: 'pending' }),
    ];
    const res = await make();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.problems).toEqual([
      'Gateway Steel: These were locked with another key than VENDOR_BANK_KEY holds now: put that key back, or enter them again.',
      'Delta Lighting: no bank numbers are confirmed on a call-back.',
    ]);
    expect(body.error).toBe(`${body.problems[0]} Nothing was made.`);
    expect(rpcNames()).toEqual([]);
  });

  it("needs each vendor's numbers to show what's locked", async () => {
    state.tables.vendor_bank_accounts.find((s) => s.id === SET(3))!.routing_number = '071200004';
    const res = await make();
    expect(res.status).toBe(409);
    expect((await res.json()).problems).toEqual([
      "Delta Lighting: What these show isn't what's locked, so they were changed outside FleetSuite: enter them again.",
    ]);
    expect(rpcNames()).toEqual([]);
  });

  it("gives it the next letter free for the day, and the next again when another file takes it the same moment", async () => {
    state.tables.vendor_ach_files.push({ id: FILE(9), destination: '081999994', origin: '1431234567', created_on: '2026-11-04', modifier: 'A', run_id: 'other' });
    state.rpcFirst.vendor_ach_file_save = [{ state: 'modifier_taken' }];
    const res = await make();
    expect(res.status).toBe(200);
    expect((await res.json()).fileName).toBe('ACH-BMG-2026-11-04-C.txt');
    expect(state.rpcs.map(([, a]) => a.p.modifier)).toEqual(['B', 'C']);
    expect(openFile(KEY, files().find((f) => f.id === FILE(1))!.file_locked, FILE(1))).toEqual({ text: expectedFile('C').text });
  });

  it('stops at 36 files a day', async () => {
    for (const [i, m] of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].entries()) {
      state.tables.vendor_ach_files.push({ id: FILE(100 + i), destination: '081999994', origin: '1431234567', created_on: '2026-11-04', modifier: m });
    }
    const res = await make();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('36 ACH files were made for First Bank today already, as many as a day takes: make this one tomorrow. Nothing was made.');
  });

  it('starts again at A each day', async () => {
    state.tables.vendor_ach_files.push({ id: FILE(9), destination: '081999994', origin: '1431234567', created_on: '2026-11-03', modifier: 'A', run_id: 'other' });
    expect((await (await make()).json()).fileName).toBe('ACH-BMG-2026-11-04-A.txt');
  });

  it('pays a run whose day has passed on the next banking day', async () => {
    state.tables.vendor_payment_runs[0].pay_date = '2026-11-03';
    expect((await (await make()).json()).pays).toEqual({ day: '2026-11-05', text: 'Thursday, November 5' });
    expect(state.rpcs.find(([fn]) => fn === 'vendor_ach_file_save')![1].p.effective_date).toBe('2026-11-05');
  });

  it('is one file for the same press twice, and tells once', async () => {
    expect((await make()).status).toBe(200);
    const again = await make();
    expect(await again.json()).toEqual({ success: true, id: FILE(1), made: false });
    expect(files()).toHaveLength(1);
    expect(audits()).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
  });

  it("says why the table didn't take a payment, and tells nobody", async () => {
    for (const [why, text] of [
      ['not_made', "Delta Lighting's bill payment isn't made in NetSuite yet. Nothing was made."],
      ['bank', "Delta Lighting's bank numbers changed since the page read them: reload. Nothing was made."],
      ['in_file', "Delta Lighting's payment is in another ACH file already: reload. Nothing was made."],
    ]) {
      state.rpcFirst.vendor_ach_file_save = [{ state: 'payment', payment_id: PAY(3), why }];
      const res = await make();
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(text);
    }
    state.rpcErrors.vendor_ach_file_save = 'connection reset';
    expect((await make()).status).toBe(500);
    expect(audits()).toEqual([]);
    expect(alerts()).toEqual([]);
  });

  it('says what the table said when it kept no file, and tells nobody', async () => {
    // Pressed twice the same moment: the other press made it.
    state.rpcFirst.vendor_ach_file_save = [{ state: 'made_already' }];
    expect(await (await make()).json()).toEqual({ success: true, id: FILE(1), made: false });
    state.rpcFirst.vendor_ach_file_save = [{ state: 'run' }];
    let res = await make();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The run isn't approved or paid from this bank account any more: reload. Nothing was made.");
    state.rpcFirst.vendor_ach_file_save = [{ state: 'totals' }];
    res = await make();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("The file wasn't kept (totals): reload. Nothing was made.");
    expect(audits()).toEqual([]);
    expect(alerts()).toEqual([]);
  });

  it('never tells whoever made it, and tells nobody when nobody else is to be told', async () => {
    state.watchers = [WATCHER, MAKER];
    expect((await make()).status).toBe(200);
    expect(alerts().map((a) => a.to)).toEqual([[OTHER, WATCHER]]);
    state.superAdmins = [MAKER];
    state.watchers = [MAKER];
    vi.mocked(notifyMany).mockClear();
    expect((await post({ action: 'set_aside', fileId: FILE(1), reason: 'Made twice' })).status).toBe(200);
    expect(notifyMany).not.toHaveBeenCalled();
  });
});

describe('downloading, sending and setting aside', () => {
  beforeEach(async () => {
    expect((await make()).status).toBe(200);
    vi.mocked(logAudit).mockClear();
    vi.mocked(notifyMany).mockClear();
    state.rpcs.length = 0;
  });

  it('downloads the file as it was made, counted, never kept by a browser', async () => {
    const res = await get(`download=${FILE(1)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=us-ascii');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="ACH-BMG-2026-11-04-A.txt"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe(expectedFile().text);
    expect(files()[0]).toMatchObject({ downloads: 1, downloaded_by: MAKER });
    expect(audits()).toEqual([{
      actorId: MAKER, table: 'vendor_ach_files', recordId: FILE(1), action: 'download', detail: { file_name: 'ACH-BMG-2026-11-04-A.txt', downloads: 1 },
    }]);
    const shown = await (await get(`run=${RUN}`)).json();
    expect(shown.files[0]).toMatchObject({ fileName: 'ACH-BMG-2026-11-04-A.txt', status: 'made', downloads: 1, downloadedBy: 'Pat Admin', late: false, problem: null });
    expect(shown.payments[0].fileId).toBe(FILE(1));
  });

  it("isn't downloaded switched off, or once a vendor's numbers in it are replaced", async () => {
    state.on = false;
    expect((await get(`download=${FILE(1)}`)).status).toBe(403);
    state.on = true;
    state.tables.vendor_bank_accounts.find((s) => s.id === SET(3))!.status = 'replaced';
    const res = await get(`download=${FILE(1)}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Delta Lighting's bank numbers were replaced or removed since this file was made, so it isn't downloaded: "
      + "set it aside, and make a new one if they're still to be paid by ACH.");
    expect(files()[0].downloads).toBe(0);
    const shown = await (await get(`run=${RUN}`)).json();
    expect(shown.files[0].problem).toBe("Delta Lighting's bank numbers were replaced or removed since it was made: set it aside, and make a new one if they're still to be paid by ACH.");
    expect(shown.payments[1]).toMatchObject({ fileId: FILE(1), why: null });
  });

  it("isn't downloaded when it doesn't open with the key", async () => {
    vi.stubEnv('VENDOR_BANK_KEY', OTHER_RAW);
    const res = await get(`download=${FILE(1)}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('This file was locked with another key than VENDOR_BANK_KEY holds now: put that key back, or set it aside and make a new one.');
    expect(rpcNames()).toEqual([]);
    expect((await get(`download=${FILE(8)}`)).status).toBe(404);
    expect((await get('download=nope')).status).toBe(404);
    // Its payments are still in it, whatever's wrong with their numbers now.
    const shown = await (await get(`run=${RUN}`)).json();
    expect(shown.payments[0]).toMatchObject({ fileId: FILE(1), why: null });
    vi.stubEnv('VENDOR_BANK_KEY', '');
    const none = await get(`download=${FILE(1)}`);
    expect(none.status).toBe(503);
    expect((await none.json()).error).toBe(KEY_MISSING);
  });

  it("isn't downloaded when it was marked sent the same moment", async () => {
    state.rpcFirst.vendor_ach_file_downloaded = [{ state: 'sent' }];
    const res = await get(`download=${FILE(1)}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("It's marked sent to First Bank.");
    expect(audits()).toEqual([]);
  });

  it('is marked sent once, its locked copy gone, and not downloaded after', async () => {
    const res = await post({ action: 'sent', fileId: FILE(1) });
    expect(res.status).toBe(200);
    expect(files()[0]).toMatchObject({ status: 'sent', sent_by: MAKER, file_locked: null });
    expect(audits()).toEqual([{ actorId: MAKER, table: 'vendor_ach_files', recordId: FILE(1), action: 'sent', detail: { file_name: 'ACH-BMG-2026-11-04-A.txt' } }]);
    const again = await post({ action: 'sent', fileId: FILE(1) });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("It's marked sent to First Bank already.");
    const download = await get(`download=${FILE(1)}`);
    expect(download.status).toBe(409);
    expect((await download.json()).error).toBe("It's marked sent to First Bank. Only a file waiting to be uploaded is downloaded.");
    expect(alerts()).toEqual([]);
    state.tables.vendor_bank_accounts.find((s) => s.id === SET(3))!.status = 'replaced';
    expect((await (await get(`run=${RUN}`)).json()).files[0]).toMatchObject({ status: 'sent', problem: null });
  });

  it('is set aside with why, its payments let go, and tells the other super admins', async () => {
    const res = await post({ action: 'set_aside', fileId: FILE(1), reason: "  Delta's numbers changed before it was uploaded  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, was: 'made' });
    expect(files()[0]).toMatchObject({ status: 'set_aside', set_aside_why: "Delta's numbers changed before it was uploaded", file_locked: null });
    expect(state.tables.vendor_ach_file_payments.every((fp) => !fp.live)).toBe(true);
    expect(audits()).toEqual([{
      actorId: MAKER, table: 'vendor_ach_files', recordId: FILE(1), action: 'set_aside',
      detail: { file_name: 'ACH-BMG-2026-11-04-A.txt', was: 'made', why: "Delta's numbers changed before it was uploaded" },
    }]);
    expect((await (await get(`run=${RUN}`)).json()).payments.map((p: any) => p.fileId)).toEqual([null, null, null]);
    expect(alerts()).toEqual([{
      to: [OTHER, WATCHER],
      type: 'books_ach_file_set_aside',
      title: 'ACH file set aside: ACH-BMG-2026-11-04-A.txt',
      body: "Pat Admin set aside the ACH file ACH-BMG-2026-11-04-A.txt: Delta's numbers changed before it was uploaded. Its payments can go in a new file.",
      url: `/admin/pay-vendors?run=${RUN}`,
      channels: ['in_app', 'push', 'email'],
    }]);
    const again = await post({ action: 'set_aside', fileId: FILE(1), reason: 'Again' });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("It's set aside already.");
    // Its payments go in a new file.
    expect((await make({ id: FILE(2) })).status).toBe(200);
    expect(files().map((f) => [f.id, f.modifier, f.status])).toEqual([[FILE(1), 'A', 'set_aside'], [FILE(2), 'B', 'made']]);
  });

  it('says a file set aside after it was sent may have been paid', async () => {
    await post({ action: 'sent', fileId: FILE(1) });
    const res = await post({ action: 'set_aside', fileId: FILE(1), reason: 'First Bank returned it' });
    expect(await res.json()).toEqual({ success: true, was: 'sent' });
    expect(alerts()[0].body).toBe('Pat Admin set aside the ACH file ACH-BMG-2026-11-04-A.txt, which was marked sent to First Bank: First Bank returned it. '
      + "Its payments can go in a new file, so check with First Bank that it didn't pay this one, or they're paid twice.");
  });

  it('ends the why in the alert with one stop', async () => {
    expect((await post({ action: 'set_aside', fileId: FILE(1), reason: 'Made twice by mistake.' })).status).toBe(200);
    expect(alerts()[0].body).toBe('Pat Admin set aside the ACH file ACH-BMG-2026-11-04-A.txt: Made twice by mistake. Its payments can go in a new file.');
  });

  it('says when the file went before it was set aside, and tells nobody', async () => {
    state.rpcFirst.vendor_ach_file_set_aside = [{ state: 'gone' }];
    const res = await post({ action: 'set_aside', fileId: FILE(1), reason: 'Made twice' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('FleetSuite has no such ACH file: reload.');
    expect(audits()).toEqual([]);
    expect(alerts()).toEqual([]);
  });

  it('takes a why with no account number in it', async () => {
    for (const reason of ['', '   ', 'Account 4455669012 was closed', 'y'.repeat(301)]) {
      const res = await post({ action: 'set_aside', fileId: FILE(1), reason });
      expect(res.status).toBe(400);
    }
    expect(files()[0].status).toBe('made');
    expect(rpcNames()).toEqual([]);
    expect((await post({ action: 'set_aside', fileId: FILE(8), reason: 'Gone' })).status).toBe(404);
  });

  it('says when its day to be paid has come before it was uploaded', async () => {
    vi.setSystemTime(new Date('2026-11-06T15:00:00.000Z'));
    const shown = await (await get(`run=${RUN}`)).json();
    expect(shown.files[0].late).toBe(true);
    expect(shown.pays).toEqual({ day: '2026-11-09', text: 'Monday, November 9' });
    // Once it's uploaded, it isn't.
    expect((await post({ action: 'sent', fileId: FILE(1) })).status).toBe(200);
    expect((await (await get(`run=${RUN}`)).json()).files[0].late).toBe(false);
  });
});
