import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The mirror talks to NetSuite (SuiteQL + the PDF RESTlet) and to R2; both
 * are stubbed so the run loop — the phase budgets, the ladder, the cursor,
 * the bulk writes, the probes — is exercised against an in-memory NetSuite
 * and a real-enough Supabase.
 *
 * `@/lib/system-health` is deliberately NOT mocked: `recordHeartbeat` and
 * its flight recorder run for real against the fake service, which is how
 * "exactly ONE heartbeat and ONE cron_runs row per run" becomes an assertion
 * rather than a promise.
 */
vi.mock('@/lib/netsuite', () => ({
  suiteqlQuery: vi.fn(),
  suiteqlQueryAll: vi.fn(),
  getNetSuitePdf: vi.fn(),
  callRestlet: vi.fn(),
  getAccountBalancesFromRestlet: vi.fn(),
  transactionUrl: () => '',
  isSuiteqlError: (err: unknown) => err instanceof Error && typeof (err as any).status === 'number',
}));
vi.mock('@/lib/restlet-probe', () => ({ pingRestlet: vi.fn() }));
vi.mock('@/lib/r2', () => ({
  r2Head: vi.fn(async () => false),
  r2GetBytes: vi.fn(async () => null),
  r2Upload: vi.fn(async () => ({ success: true })),
}));

import { getNetSuitePdf, suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { pingRestlet } from '@/lib/restlet-probe';
import { r2Upload } from '@/lib/r2';
import { HEALTH_MONITORS } from '@/lib/system-health';
import { makeFakeService, resetFakeIds, writesTo, type FakeService } from '@/lib/quickbooks/test-fake-service';
import {
  buildHeaderQuery,
  buildLinesQuery,
  classifyProbeError,
  FIRST_RUN_SINCE,
  HEADER_COLUMN_LADDER,
  mapNsHeader,
  NS_MIRROR_SYNC_TYPE,
  NS_PHASE_BUDGETS,
  nsPartyName,
  OPTIONAL_HEADER_COLUMNS,
  parseNsMirrorResume,
  runNetSuiteMirror,
} from './netsuite-mirror';

const suiteql = vi.mocked(suiteqlQuery);
const suiteqlAll = vi.mocked(suiteqlQueryAll);
const nsPdf = vi.mocked(getNetSuitePdf);
const ping = vi.mocked(pingRestlet);
const upload = vi.mocked(r2Upload);

// ── pure helpers ───────────────────────────────────────────────────────────

describe('SuiteQL shapes', () => {
  it('the header query covers both types, joins the customer for entityid, and never selects createdfrom', () => {
    const q = buildHeaderQuery('2026-01-05T00:00:00Z', null, ['balance', 'status_label', 'due']);
    expect(q).toContain("t.type IN ('CustInvc', 'CustCred')");
    expect(q).toContain('LEFT JOIN customer c ON c.id = t.entity');
    // NetSuite leaves companyname NULL on individual-type customers, so the
    // entity id has to come back on the same row or the fallback is a guess.
    expect(q).toContain('c.entityid AS party_entity_id');
    expect(q).toContain('c.companyname AS party_name');
    expect(q).toContain("TO_DATE('1/5/2026', 'MM/DD/YYYY')");
    expect(q).toContain('ORDER BY t.id DESC');
    expect(q).toContain('t.foreignamountunpaid AS balance');
    expect(q).toContain('BUILTIN.DF(t.status) AS status_label');
    // SELECTing createdfrom on a transaction header 500s on this account.
    expect(q).not.toContain('createdfrom');
  });

  it('the header cursor is interpolated only when it is an integer', () => {
    expect(buildHeaderQuery('2026-01-05T00:00:00Z', '900', [])).toContain('AND t.id < 900');
    expect(buildHeaderQuery('2026-01-05T00:00:00Z', "9); DROP TABLE x --", [])).not.toContain('DROP');
    expect(buildHeaderQuery('2026-01-05T00:00:00Z', null, [])).not.toContain('AND t.id <');
  });

  it('the ladder degrades richest-first and each rung is a real column expression', () => {
    expect(HEADER_COLUMN_LADDER.map(r => [...r])).toEqual([
      ['balance', 'status_label', 'due'],
      ['status_label', 'due'],
      ['due'],
      [],
    ]);
    for (const rung of HEADER_COLUMN_LADDER) {
      for (const col of rung) expect(OPTIONAL_HEADER_COLUMNS[col]).toBeTruthy();
    }
  });

  it('the line query keeps tax lines — the invoice total has to add up', () => {
    const q = buildLinesQuery(['11', '12']);
    expect(q).toContain('tl.transaction IN (11, 12)');
    expect(q).toContain("tl.mainline = 'F'");
    expect(q).toContain('tl.taxline');
    // The sales-order sync drops tax lines; the ledger stores them.
    expect(q).not.toContain("tl.taxline = 'F'");
  });
});

describe('nsPartyName', () => {
  it('prefers companyname, falls back to entityid, then to the internal id', () => {
    expect(nsPartyName({ party_name: 'Broadway Ford', party_entity_id: 'C123', party_external_id: 77 }))
      .toBe('Broadway Ford');
    expect(nsPartyName({ party_name: null, party_entity_id: 'Dana Whitfield', party_external_id: 77 }))
      .toBe('Dana Whitfield');
    expect(nsPartyName({ party_name: '  ', party_entity_id: '', party_external_id: 77 }))
      .toBe('Customer 77');
    expect(nsPartyName({ party_name: null, party_entity_id: null, party_external_id: null }))
      .toBe('Unknown customer');
  });
});

describe('classifyProbeError', () => {
  const err = (status: number) => Object.assign(new Error(`NetSuite SuiteQL error (${status}): {}`), { status });

  it('separates a missing grant from a query the app got wrong', () => {
    expect(classifyProbeError(err(403))).toBe('not_permitted');
    expect(classifyProbeError(err(401))).toBe('not_permitted');
    // A 400 is an engineering bug. Reporting it as a missing grant would
    // send the owner adding permissions that change nothing.
    expect(classifyProbeError(err(400))).toBe('query_shape_rejected');
    expect(classifyProbeError(err(429))).toBe('transient');
    expect(classifyProbeError(err(503))).toBe('transient');
    expect(classifyProbeError(new Error('fetch failed'))).toBe('transient');
    expect(classifyProbeError('nope')).toBe('unknown');
  });
});

describe('mapNsHeader', () => {
  const row = {
    id: 501, type: 'CustInvc', tranid: 'INV1042', trandate: '3/4/2026', duedate: '4/3/2026',
    otherrefnum: 'PO-99', status: 'A', status_label: 'Invoice : Open', memo: 'fleet upfit',
    total: '-1234.50', entity: 77, party_name: 'Broadway Ford', party_entity_id: 'C77',
    party_external_id: 77, lastmodifieddate: '2026-03-05T10:00:00Z', balance: '-400.00',
  };

  it('maps the header, absolutes the amounts and strips the status prefix', () => {
    const mapped = mapNsHeader(row, { balanceColumn: true });
    expect(mapped).toMatchObject({
      source: 'netsuite',
      external_id: 'CustInvc/501',
      external_ref: '501',
      doc_type: 'invoice',
      doc_number: 'INV1042',
      doc_date: '2026-03-04',
      due_date: '2026-04-03',
      po_number: 'PO-99',
      party_name: 'Broadway Ford',
      customer_netsuite_id: '77',
      status: 'A',
      status_label: 'Open',
      total: 1234.5,
      balance: 400,
      paid: false,
      post_cutover: false,
      import_run_id: null,
    });
  });

  it('CustCred becomes a credit memo and never reports paid', () => {
    const mapped = mapNsHeader({ ...row, id: 88, type: 'CustCred', status_label: 'Credit Memo : Open' }, { balanceColumn: true });
    expect(mapped.external_id).toBe('CustCred/88');
    expect(mapped.doc_type).toBe('credit_memo');
    expect(mapped.paid).toBeNull();
    expect(mapped.status_label).toBe('Open');
  });

  it('a paid invoice is recognised from either the status letter or the label', () => {
    expect(mapNsHeader({ ...row, status: 'B', status_label: undefined }, { balanceColumn: false }).paid).toBe(true);
    expect(mapNsHeader({ ...row, status: 'Z', status_label: 'Invoice : Paid In Full' }, { balanceColumn: false }).paid).toBe(true);
  });

  it('balance is NULL — never a copy of total — when SuiteQL refused the column', () => {
    const open = mapNsHeader({ ...row, balance: undefined }, { balanceColumn: false });
    expect(open.balance).toBeNull();
    expect(open.total).toBe(1234.5);
    // A paid invoice is the one case we can state without the column.
    const paid = mapNsHeader({ ...row, status: 'B', balance: undefined }, { balanceColumn: false });
    expect(paid.balance).toBe(0);
    // And a reported-but-absent balance stays unknown, not zero.
    expect(mapNsHeader({ ...row, balance: undefined }, { balanceColumn: true }).balance).toBeNull();
  });

  it('never emits first_seen_at or last_synced_at — upsertRows owns the provenance', () => {
    const mapped = mapNsHeader(row, { balanceColumn: true });
    expect('first_seen_at' in mapped).toBe(false);
    expect('last_synced_at' in mapped).toBe(false);
  });
});

describe('parseNsMirrorResume', () => {
  const base = { windowStartedAt: '2026-09-14T00:00:00Z', since: '2026-09-01T00:00:00Z', beforeId: '900', processed: 12 };

  it('accepts a well-formed cursor and the composite repair key', () => {
    expect(parseNsMirrorResume({ resume: base })).toEqual(base);
    expect(parseNsMirrorResume({
      resume: { ...base, tombstoneAfter: '500', repairAfter: { appliedExternalId: 'CustInvc/7', id: 'app-3' } },
    })).toEqual({ ...base, tombstoneAfter: '500', repairAfter: { appliedExternalId: 'CustInvc/7', id: 'app-3' } });
  });

  it('rejects nonsense rather than resuming from it', () => {
    expect(parseNsMirrorResume(null)).toBeNull();
    expect(parseNsMirrorResume({ resume: { ...base, beforeId: 'abc' } })).toBeNull();
    expect(parseNsMirrorResume({ resume: { ...base, since: 'not a date' } })).toBeNull();
    // A half-written repair key is dropped, not half-used.
    expect(parseNsMirrorResume({ resume: { ...base, repairAfter: { appliedExternalId: 'CustInvc/7' } } })?.repairAfter)
      .toBeUndefined();
  });
});

describe('NS_PHASE_BUDGETS', () => {
  it('leaves repair a floor inside the 240 s window and caps every other phase', () => {
    const capped = NS_PHASE_BUDGETS.headersMs + NS_PHASE_BUDGETS.tombstonesMs
      + NS_PHASE_BUDGETS.paymentsMs + NS_PHASE_BUDGETS.pdfsMs;
    expect(capped).toBe(225_000);
    expect(240_000 - capped).toBeGreaterThanOrEqual(15_000);
    // repair is the ONE phase with no default cap.
    expect(NS_PHASE_BUDGETS.repairMs).toBeUndefined();
  });
});

// ── in-memory NetSuite ─────────────────────────────────────────────────────

interface NsLine {
  line_id: number; item?: number | null; item_number?: string | null;
  description?: string; quantity?: string; rate?: string; netamount?: string; taxline?: 'T' | 'F';
  linesequencenumber?: number;
}
interface NsTxn {
  id: number; type: 'CustInvc' | 'CustCred'; tranid?: string; trandate?: string; duedate?: string;
  status?: string; label?: string; memo?: string; otherrefnum?: string; total?: string;
  entity?: number; companyname?: string | null; entityid?: string | null; balance?: string;
  lines?: NsLine[];
}
interface NsPayment {
  id: number; tranid?: string; trandate?: string; total?: string; memo?: string;
  entity?: number; companyname?: string | null; entityid?: string | null;
  /** previousdoc ids this payment was applied to. */
  applies?: { previousdoc: number; foreignamount: string }[];
}

interface NsWorld {
  txns: NsTxn[];
  payments?: NsPayment[];
  /** Reject `t.foreignamountunpaid` so the ladder has to drop `balance`. */
  refuseBalance?: boolean;
  /** Status of that rejection. 400 (a refused shape) unless a test says otherwise. */
  refuseBalanceStatus?: number;
  /** Status of the error the CustPymt probe throws; undefined = it succeeds. */
  paymentsProbeStatus?: number;
  /** Status the FIRST link table throws; undefined = it succeeds. */
  firstLinkTableStatus?: number;
  /** Ids the tombstone query should pretend no longer exist. */
  deletedIds?: number[];
  /** Throw this on the header query. */
  headerError?: Error;
}

const sqlError = (status: number, body = '{"o:errorDetails":[{"o:errorCode":"X","detail":"nope"}]}') =>
  Object.assign(new Error(`NetSuite SuiteQL error (${status}): ${body}`), { status });

function headerRow(t: NsTxn, cols: string[]): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: t.id, tranid: t.tranid ?? `T${t.id}`, trandate: t.trandate ?? '2026-03-04',
    otherrefnum: t.otherrefnum ?? null, status: t.status ?? 'A', memo: t.memo ?? null, type: t.type,
    total: t.total ?? '-100.00', party_external_id: t.entity ?? 77,
    party_name: t.companyname === undefined ? 'Broadway Ford' : t.companyname,
    party_entity_id: t.entityid === undefined ? 'C77' : t.entityid,
    lastmodifieddate: '2026-03-05T10:00:00Z',
  };
  if (cols.includes('balance')) row.balance = t.balance ?? '-100.00';
  if (cols.includes('status_label')) row.status_label = t.label ?? `${t.type === 'CustCred' ? 'Credit Memo' : 'Invoice'} : Open`;
  if (cols.includes('due')) row.duedate = t.duedate ?? '2026-04-03';
  return row;
}

/** Which optional columns a query text is asking for. */
function columnsOf(query: string): string[] {
  const cols: string[] = [];
  if (query.includes('t.foreignamountunpaid')) cols.push('balance');
  if (query.includes('BUILTIN.DF(t.status) AS status_label')) cols.push('status_label');
  if (query.includes('t.duedate AS duedate')) cols.push('due');
  return cols;
}

function installNetSuite(world: NsWorld): void {
  const beforeIdOf = (q: string) => {
    const m = q.match(/AND t\.id < (\d+)/);
    return m ? Number(m[1]) : null;
  };

  suiteql.mockImplementation(async (query: string, limit = 1000) => {
    if (query.includes("t.type = 'CustPymt'") && query.includes('FETCH FIRST 1 ROWS ONLY')) {
      if (world.paymentsProbeStatus) throw sqlError(world.paymentsProbeStatus);
      return { items: [{ id: 1 }] };
    }
    if (query.includes('FROM nexttransactionlinelink FETCH FIRST 1 ROWS ONLY')) {
      if (world.firstLinkTableStatus) throw sqlError(world.firstLinkTableStatus);
      return { items: [] };
    }
    if (query.includes('FROM previoustransactionlinelink FETCH FIRST 1 ROWS ONLY')) {
      return { items: [] };
    }
    if (query.includes("t.type IN ('CustInvc', 'CustCred')") && query.includes('ORDER BY t.id DESC')) {
      if (world.headerError) throw world.headerError;
      const cols = columnsOf(query);
      if (world.refuseBalance && cols.includes('balance')) throw sqlError(world.refuseBalanceStatus ?? 400);
      const before = beforeIdOf(query);
      const rows = world.txns
        .filter(t => before == null || t.id < before)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      return { items: rows.map(t => headerRow(t, cols)) };
    }
    if (query.includes("t.type = 'CustPymt'") && query.includes('ORDER BY t.id DESC')) {
      const before = beforeIdOf(query);
      const rows = (world.payments || [])
        .filter(p => before == null || p.id < before)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      return {
        items: rows.map(p => ({
          id: p.id, tranid: p.tranid ?? `PMT${p.id}`, trandate: p.trandate ?? '2026-03-10',
          memo: p.memo ?? null, total: p.total ?? '250.00', party_external_id: p.entity ?? 77,
          party_name: p.companyname === undefined ? 'Broadway Ford' : p.companyname,
          party_entity_id: p.entityid === undefined ? 'C77' : p.entityid,
          lastmodifieddate: '2026-03-11T10:00:00Z',
        })),
      };
    }
    throw new Error(`unexpected suiteqlQuery: ${query.slice(0, 120)}`);
  });

  suiteqlAll.mockImplementation(async (query: string) => {
    if (query.includes('FROM transactionline tl')) {
      const ids = (query.match(/tl\.transaction IN \(([^)]*)\)/)?.[1] || '')
        .split(',').map(s => Number(s.trim())).filter(Boolean);
      const out: any[] = [];
      for (const id of ids) {
        const txn = world.txns.find(t => t.id === id);
        for (const l of txn?.lines || []) {
          out.push({
            txn_id: id, line_id: l.line_id, linesequencenumber: l.linesequencenumber ?? 1,
            item: l.item ?? null, item_number: l.item_number ?? null, description: l.description ?? null,
            quantity: l.quantity ?? '1', rate: l.rate ?? '-10.00', netamount: l.netamount ?? '-10.00',
            taxline: l.taxline ?? 'F',
          });
        }
      }
      return out;
    }
    if (query.includes('SELECT t.id, t.status') && query.includes('t.id IN (')) {
      const ids = (query.match(/t\.id IN \(([^)]*)\)/)?.[1] || '')
        .split(',').map(s => Number(s.trim())).filter(Boolean);
      const withLabel = query.includes('BUILTIN.DF');
      return ids
        .filter(id => !(world.deletedIds || []).includes(id))
        .map(id => {
          const txn = world.txns.find(t => t.id === id);
          return {
            id,
            status: txn?.status ?? 'A',
            ...(withLabel ? { label: txn?.label ?? 'Invoice : Open' } : {}),
          };
        });
    }
    if (/FROM (next|previous)transactionlinelink/.test(query) && query.includes('nextdoc IN')) {
      const ids = (query.match(/nextdoc IN \(([^)]*)\)/)?.[1] || '')
        .split(',').map(s => Number(s.trim())).filter(Boolean);
      const out: any[] = [];
      for (const id of ids) {
        const payment = (world.payments || []).find(p => p.id === id);
        for (const a of payment?.applies || []) {
          out.push({ previousdoc: a.previousdoc, nextdoc: id, foreignamount: a.foreignamount, linktype: 'Payment' });
        }
      }
      return out;
    }
    throw new Error(`unexpected suiteqlQueryAll: ${query.slice(0, 120)}`);
  });
}

/**
 * The fake service, plus a record of the `.in()` / `.or()` filters every
 * query built — the only way to assert "the lookup is chunked at 100" and
 * "the repair cursor is a composite keyset" without reaching into the
 * implementation.
 */
function recordingService(seed: Record<string, any[]> = {}) {
  const base = makeFakeService(seed);
  const inCalls: { table: string; col: string; values: any[] }[] = [];
  const orCalls: { table: string; expr: string }[] = [];
  let step = 0;
  let clock = 0;
  const from = (table: string) => {
    if (step > 0) clock += step;
    const q = base.from(table);
    const nativeIn = q.in.bind(q);
    q.in = (col: string, values: any[]) => { inCalls.push({ table, col, values }); return nativeIn(col, values); };
    const nativeOr = q.or.bind(q);
    q.or = (expr: string) => { orCalls.push({ table, expr }); return nativeOr(expr); };
    return q;
  };
  const service = { ...base, from } as unknown as FakeService;
  return {
    service,
    inCalls,
    orCalls,
    /**
     * Advance a mocked Date.now by `ms` on every query, so a phase deadline
     * can be crossed mid-pass without a real wait. Returns the spy — restore
     * it rather than calling vi.restoreAllMocks(), which would also wipe the
     * in-memory NetSuite.
     */
    tick: (startMs: number, ms: number) => {
      clock = startMs;
      step = ms;
      return vi.spyOn(Date, 'now').mockImplementation(() => clock);
    },
  };
}

const lastResultOf = (service: FakeService) =>
  (service.tables['sync_state'] || []).find(r => r.sync_type === NS_MIRROR_SYNC_TYPE)?.last_result;

/** Any string `error` one level down is what reddens System Health. */
function nestedErrorKeys(payload: any): string[] {
  const out: string[] = [];
  if (typeof payload?.error === 'string' && payload.error) out.push('error');
  for (const [key, value] of Object.entries(payload || {})) {
    if (value && typeof value === 'object' && typeof (value as any).error === 'string' && (value as any).error) {
      out.push(`${key}.error`);
    }
  }
  return out;
}

const DEADLINE = () => Date.now() + 240_000;

const invoice = (id: number, extra: Partial<NsTxn> = {}): NsTxn => ({
  id, type: 'CustInvc', tranid: `INV${id}`,
  lines: [{ line_id: id * 10, item: 5, item_number: 'PARENT : PART-A', quantity: '2', rate: '-25.00', netamount: '-50.00' }],
  ...extra,
});

beforeEach(() => {
  resetFakeIds();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  delete process.env.LEDGER_PDFS_ENABLED;
  delete process.env.NETSUITE_PDF_RESTLET_URL;
  ping.mockResolvedValue({ reachable: true, version: '2026-09-15.1' });
  nsPdf.mockResolvedValue({ success: false, error: 'not configured' });
  upload.mockResolvedValue({ success: true } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── the run ────────────────────────────────────────────────────────────────

describe('runNetSuiteMirror — headers, lines, parties and documents', () => {
  it('mirrors a page into ledger_invoices + lines + a pending PDF row, and drains', async () => {
    installNetSuite({
      txns: [
        invoice(501, { total: '-1234.50', balance: '-400.00' }),
        { id: 502, type: 'CustCred', tranid: 'CM7', total: '-99.00', balance: '-99.00', label: 'Credit Memo : Open',
          lines: [{ line_id: 5020, item: null, item_number: null, netamount: '-99.00', taxline: 'T' }] },
      ],
      paymentsProbeStatus: 403,
    });
    const { service } = recordingService({ customers: [{ id: 'cust-1', netsuite_id: '77', active: true }] });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.error).toBeUndefined();
    expect(result.modified).toBe(2);
    expect(result.synced).toBe(2);
    expect(result.lines).toBe(2);
    expect(result.droppedColumns).toEqual([]);

    const invoices = service.tables['ledger_invoices'];
    expect(invoices.map(r => r.external_id).sort()).toEqual(['CustCred/502', 'CustInvc/501']);
    const inv = invoices.find(r => r.external_id === 'CustInvc/501');
    expect(inv.total).toBe(1234.5);
    expect(inv.balance).toBe(400);
    expect(inv.customer_id).toBe('cust-1');
    expect(inv.ledger_customer_id).toBeTruthy();
    expect(inv.last_synced_at).toBeTruthy();
    expect(inv.first_seen_at).toBeUndefined();

    // Lines: the tax line survives as line_kind 'tax', magnitudes absolute.
    const lines = service.tables['ledger_invoice_lines'];
    expect(lines).toHaveLength(2);
    expect(lines.find(l => l.line_external_id === '5010')).toMatchObject({
      line_kind: 'item', item_number: 'PART-A', quantity: 2, unit_price: 25, amount: 50,
    });
    expect(lines.find(l => l.line_external_id === '5020')).toMatchObject({ line_kind: 'tax', amount: 99 });
    expect(invoices.every(r => r.lines_synced_at)).toBe(true);

    // Pending PDF rows: file_name from the tranid, parented at the invoice
    // row upsertRows just returned.
    const docs = service.tables['ledger_documents'];
    expect(docs).toHaveLength(2);
    const doc = docs.find(d => d.external_id === 'pdf:CustInvc/501');
    expect(doc).toMatchObject({
      source: 'netsuite', kind: 'pdf', entity_table: 'ledger_invoices', entity_type: 'CustInvc',
      external_ref: '501', file_name: 'INV501.pdf', status: 'pending',
      // Known at queue time and constant — the column describes the object
      // phase (4) will upload, so it must not stay NULL for the whole
      // NetSuite half of the ledger.
      content_type: 'application/pdf',
    });
    expect(doc.entity_row_id).toBe(inv.id);
    expect(doc.storage_path ?? null).toBeNull();

    // The party is mirrored once and graded from customers.netsuite_id.
    const party = service.tables['ledger_customers'];
    expect(party).toHaveLength(1);
    expect(party[0]).toMatchObject({
      external_id: 'customer/77', display_name: 'Broadway Ford', cleaned_name: 'Broadway Ford',
      match_status: 'exact', customer_id: 'cust-1', customer_netsuite_id: '77',
    });
  });

  it('an individual-type customer (no companyname) keeps its entityid as the party name', async () => {
    installNetSuite({
      txns: [invoice(600, { companyname: null, entityid: 'Dana Whitfield' })],
      paymentsProbeStatus: 403,
    });
    const { service } = recordingService();

    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(service.tables['ledger_invoices'][0].party_name).toBe('Dana Whitfield');
    expect(service.tables['ledger_customers'][0].display_name).toBe('Dana Whitfield');
  });

  it('a refused balance column drops off the ladder, is reported, and never becomes total', async () => {
    installNetSuite({
      txns: [invoice(700, { total: '-500.00', status: 'A' })],
      refuseBalance: true,
      paymentsProbeStatus: 403,
    });
    const { service } = recordingService();

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.droppedColumns).toEqual(['balance']);
    // The ladder DID settle — on a narrower rung, which is a working mirror.
    expect(result.columnsSettled).toBe(true);
    const inv = service.tables['ledger_invoices'][0];
    expect(inv.total).toBe(500);
    expect(inv.balance).toBeNull();
  });

  it('a throttle on the richest rung fails the run — it is not evidence the column is refused', async () => {
    // Stepping down the ladder on a 429 would record "SuiteQL refused
    // foreignamountunpaid" permanently, warn about a column this account
    // accepts, and write NULL over a whole page of correct balances.
    installNetSuite({
      txns: [invoice(710, { total: '-500.00' })],
      refuseBalance: true,
      refuseBalanceStatus: 429,
      paymentsProbeStatus: 403,
    });
    const { service } = recordingService();

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.error).toContain('429');
    expect(result.droppedColumns).toEqual([]);
    expect(result.columnsSettled).toBe(false);
    // Nothing was written on a run that never got an accepted page.
    expect(service.tables['ledger_invoices'] ?? []).toHaveLength(0);
  });

  it('a refused header query settles NOTHING — an empty droppedColumns is not proof of access', async () => {
    // The Connections row gates its green "accepted in full" on
    // `columnsSettled`, not on `droppedColumns.length === 0`: a first run
    // whose header query 403s publishes an empty list too.
    installNetSuite({ txns: [], headerError: sqlError(403), paymentsProbeStatus: 403 });
    const { service } = recordingService();

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.error).toContain('403');
    expect(result.droppedColumns).toEqual([]);
    expect(result.columnsSettled).toBe(false);
    expect(lastResultOf(service).columnsSettled).toBe(false);
  });

  it('drops NetSuite\'s own card and bank columns at intake, on every row it writes', async () => {
    // The sanitizer's key lists are QuickBooks PascalCase; SuiteQL hands back
    // `ccnumber` (the PAN) and `ccsecuritycode` (the CVV) in lowercase, and
    // all four `raw` columns below are SELECT-able by is_ledger_reader().
    // Owner requirement 11: DROPPED at intake, not masked.
    installNetSuite({
      txns: [invoice(9500, { lines: [{ line_id: 95001, item: 5, item_number: 'PART-A' }] })],
      payments: [{ id: 9600, applies: [{ previousdoc: 9500, foreignamount: '-10.00' }] }],
    });
    const card = { ccnumber: '4111111111111111', ccsecuritycode: '123', accountnumber: '000123456789' };
    const taint = (rows: any[]) => rows.map(r => ({ ...r, ...card }));
    const pages = suiteql.getMockImplementation()!;
    suiteql.mockImplementation(async (...args: any[]) => {
      const out: any = await (pages as any)(...args);
      return out?.items ? { ...out, items: taint(out.items) } : out;
    });
    const all = suiteqlAll.getMockImplementation()!;
    suiteqlAll.mockImplementation(async (...args: any[]) => taint(await (all as any)(...args)));
    const { service } = recordingService();

    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    // The rows really landed — "no digits" proves nothing over an empty run.
    expect(service.tables['ledger_invoices']).toHaveLength(1);
    expect(service.tables['ledger_invoice_lines']).toHaveLength(1);
    expect(service.tables['ledger_payments']).toHaveLength(1);
    expect(service.tables['ledger_payment_applications']).toHaveLength(1);

    const everything = JSON.stringify({ writes: service.writes, tables: service.tables });
    expect(everything).not.toMatch(/\d{13,19}/);
    expect(everything).not.toMatch(/ccnumber|ccsecuritycode|accountnumber/);
  });

  it('a duplicated customers.netsuite_id resolves to NULL and is counted with a sample', async () => {
    installNetSuite({ txns: [invoice(800)], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      customers: [
        { id: 'cust-a', netsuite_id: '77', active: true },
        { id: 'cust-b', netsuite_id: '77', active: true },
      ],
    });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.customers).toEqual({ duplicateNetsuiteIds: 1, samples: ['77'] });
    expect(service.tables['ledger_invoices'][0].customer_id).toBeNull();
    // Unresolved parties stay OUT of the review queue and retry every run.
    expect(service.tables['ledger_customers'][0]).toMatchObject({
      match_status: 'pending', match_reason: 'duplicate netsuite_id in customers',
    });
  });

  it('re-running is idempotent: no duplicate rows, and a stored PDF is not re-queued', async () => {
    installNetSuite({ txns: [invoice(900)], paymentsProbeStatus: 403 });
    const { service } = recordingService();

    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });
    service.tables['ledger_documents'][0].status = 'stored';
    service.tables['ledger_documents'][0].storage_path = 'netsuite/CustInvc/900/INV900.pdf';
    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(service.tables['ledger_invoices']).toHaveLength(1);
    expect(service.tables['ledger_invoice_lines']).toHaveLength(1);
    expect(service.tables['ledger_documents']).toHaveLength(1);
    expect(service.tables['ledger_documents'][0].status).toBe('stored');
  });

  it('writes the cursor per page and exactly ONE heartbeat + cron_runs row per run', async () => {
    // Exactly one full page, so the header loop stops on its own budget with
    // the window still open rather than draining.
    const txns = Array.from({ length: 200 }, (_, i) => invoice(1000 + i));
    installNetSuite({ txns, paymentsProbeStatus: 403 });
    const { service } = recordingService();

    const result = await runNetSuiteMirror(service as any, {
      deadline: DEADLINE(),
      phaseBudgets: { headersMs: 0 },
    });

    expect(result.partial).toBe(true);
    expect(result.resume).toMatchObject({ beforeId: '1000', processed: 200 });
    expect(result.error).toBeUndefined();

    // One cursor write per page + the single heartbeat.
    expect(writesTo(service, 'sync_state')).toHaveLength(2);
    expect(service.tables['cron_runs']).toHaveLength(1);
    expect(service.tables['cron_runs'][0].outcome).toBe('ok');
    // A partial run must not advance the data watermark.
    const row = service.tables['sync_state'][0];
    expect(row.last_synced_at).toBeUndefined();
    // …and must not redden the board.
    expect(nestedErrorKeys(row.last_result)).toEqual([]);
  });

  it('a drained window stamps last_synced_at with the time the window OPENED', async () => {
    installNetSuite({ txns: [invoice(1200)], paymentsProbeStatus: 403 });
    const { service } = recordingService();

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.partial).toBe(false);
    expect(result.resume).toBeUndefined();
    const row = service.tables['sync_state'][0];
    expect(row.last_synced_at).toBeTruthy();
    expect(new Date(row.last_synced_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('a SuiteQL rejection on the header query fails the run and keeps the cursor intact', async () => {
    installNetSuite({ txns: [], headerError: sqlError(403), paymentsProbeStatus: 403 });
    const { service } = recordingService({
      sync_state: [{
        sync_type: NS_MIRROR_SYNC_TYPE,
        last_synced_at: '2026-09-01T00:00:00Z',
        last_result: { resume: { windowStartedAt: '2026-09-10T00:00:00Z', since: '2026-08-01T00:00:00Z', beforeId: '5000', processed: 3 } },
      }],
    });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.error).toContain('403');
    expect(result.partial).toBe(false);
    expect(result.resume?.beforeId).toBe('5000');
    expect(service.tables['cron_runs'][0].outcome).toBe('error');
  });

  it('a failed line insert leaves lines_synced_at NULL — the stamp goes on only after the children land', async () => {
    // `replaceChildren` DELETEs the parent's children and then inserts them.
    // When the insert half fails the delete has already landed, so stamping
    // anyway would leave the invoice claiming synced lines while having
    // none — and `idx_ledger_invoices_lines_pending` (WHERE lines_synced_at
    // IS NULL) is the only queue that could ever find it again.
    installNetSuite({ txns: [invoice(1400)], paymentsProbeStatus: 403 });
    const { service } = recordingService();
    service.failWritesOn.add('ledger_invoice_lines:insert');

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(service.tables['ledger_invoice_lines']).toHaveLength(0);
    expect(service.tables['ledger_invoices'][0].lines_synced_at ?? null).toBeNull();
    // A Supabase write failure IS a real failure — it says so out loud.
    expect(result.error).toContain('ledger_invoice_lines insert');
  });

  it('a page whose every row failed to write keeps the cursor instead of stepping past it', async () => {
    // `upsertRows` already retried row by row, so an empty `ids` means the
    // page is genuinely unwritten — a statement timeout on the big table, an
    // RLS problem, a value Postgres refuses. The tiny sync_state upsert would
    // still succeed, so advancing here walks the whole history one page per
    // run, writing nothing and never revisiting those transactions.
    installNetSuite({ txns: [invoice(1500), invoice(1501)], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      sync_state: [{
        sync_type: NS_MIRROR_SYNC_TYPE,
        last_result: { resume: { windowStartedAt: '2026-09-13T00:00:00Z', since: '2026-08-01T00:00:00Z', beforeId: '5000', processed: 4 } },
      }],
    });
    service.failWritesOn.add('ledger_invoices');

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.synced).toBe(0);
    expect(result.error).toContain('ledger_invoices');
    expect(result.resume?.beforeId).toBe('5000');
    expect(lastResultOf(service)?.resume?.beforeId).toBe('5000');
  });

  it('…and a FIRST page that wrote nothing carries no beforeId at all — "0" would fake a drained window', async () => {
    // '0' means "nothing below": the next run would read one empty page, call
    // the window drained and stamp the watermark past everything this run
    // failed to write. Absent means "retry this window from the top".
    installNetSuite({ txns: [invoice(1600)], paymentsProbeStatus: 403 });
    const { service } = recordingService();
    service.failWritesOn.add('ledger_invoices');

    const first = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });
    expect(first.resume).toBeTruthy();
    expect(first.resume?.beforeId).toBeUndefined();
    expect(service.tables['sync_state'][0].last_synced_at).toBeUndefined();

    service.failWritesOn.clear();
    const second = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(second.synced).toBe(1);
    const headers = suiteql.mock.calls.map(c => String(c[0]))
      .filter(q => q.includes("t.type IN ('CustInvc', 'CustCred')"));
    expect(headers.every(q => !q.includes('AND t.id <'))).toBe(true);
    expect(service.tables['sync_state'][0].last_synced_at).toBeTruthy();
  });

  it('a resume carrying only a secondary cursor opens a FRESH header window, not a spent one', async () => {
    // A tombstone sweep is a full-table pass on a 20 s budget, so on a mirror
    // of any size a run ends mid-sweep. Pinning the header window to the
    // closed one for as long as that takes would fetch one empty page per run
    // while new and edited NetSuite invoices went unmirrored for hours.
    installNetSuite({ txns: [invoice(1800)], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      sync_state: [{
        sync_type: NS_MIRROR_SYNC_TYPE,
        last_synced_at: '2026-09-10T00:00:00Z',
        last_result: {
          resume: {
            windowStartedAt: '2026-08-01T00:00:00Z', since: '2026-07-01T00:00:00Z',
            beforeId: '400', processed: 9, windowClosed: true, tombstoneAfter: '2500',
          },
        },
      }],
    });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    const headers = suiteql.mock.calls.map(c => String(c[0]))
      .filter(q => q.includes("t.type IN ('CustInvc', 'CustCred')"));
    expect(headers.every(q => !q.includes('AND t.id < 400'))).toBe(true);
    // Opened from the WATERMARK minus the one-day overlap, not from the
    // closed window's own `since`.
    expect(headers[0]).toContain("TO_DATE('9/9/2026', 'MM/DD/YYYY')");
    expect(result.synced).toBe(1);
  });

  it('a party that stops resolving loses the whole match, not just its status', async () => {
    // `customers.netsuite_id` was cleared or duplicated. Leaving the stale
    // customer_id behind would point the ledger row at the old account while
    // it claimed to be ungraded.
    installNetSuite({ txns: [invoice(1700)], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      ledger_customers: [{
        id: 'lc-1', source: 'netsuite', external_id: 'customer/77', external_ref: '77',
        display_name: 'Broadway Ford', cleaned_name: 'Broadway Ford', match_status: 'exact',
        customer_id: 'cust-old', customer_netsuite_id: '77', matched_at: '2026-01-01T00:00:00Z',
      }],
    });

    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(service.tables['ledger_customers'][0]).toMatchObject({
      match_status: 'pending',
      match_reason: 'no customers row for netsuite_id 77',
      customer_id: null,
      customer_netsuite_id: null,
      matched_at: null,
    });
    expect(service.tables['ledger_invoices'][0].customer_id).toBeNull();
  });

  it('never touches ledger_import_runs, ledger_import_events, or the app tables the ledger must not write', async () => {
    installNetSuite({ txns: [invoice(1300)], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      fleet_checkins: [{ id: 'c1', paid_at: null }],
      scan_logs: [{ id: 's1' }],
      customers: [{ id: 'cust-1', netsuite_id: '77', total_spend: 42 }],
    });

    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    for (const table of ['ledger_import_runs', 'ledger_import_events', 'fleet_checkins', 'scan_logs', 'customers']) {
      expect(writesTo(service, table), table).toEqual([]);
    }
    expect(service.tables['customers'][0].total_spend).toBe(42);
  });
});

describe('runNetSuiteMirror — tombstones', () => {
  it('marks rows NetSuite no longer returns as deleted, and voids the ones whose label says so', async () => {
    installNetSuite({
      txns: [invoice(2001), invoice(2002, { label: 'Invoice : Voided' })],
      deletedIds: [2003],
      paymentsProbeStatus: 403,
    });
    const { service } = recordingService({
      ledger_invoices: [{
        id: 'gone-1', source: 'netsuite', external_id: 'CustInvc/2003', external_ref: '2003',
        doc_type: 'invoice', doc_date: '2026-01-01', deleted_at: null, voided: false,
      }],
    });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.tombstoned).toBe(1);
    expect(result.voided).toBe(1);
    const gone = service.tables['ledger_invoices'].find(r => r.external_ref === '2003');
    expect(gone.deleted_at).toBeTruthy();
    // Never a physical delete.
    expect(service.tables['ledger_invoices']).toHaveLength(3);
    expect(service.tables['ledger_invoices'].find(r => r.external_ref === '2002').voided).toBe(true);
    expect(service.tables['ledger_invoices'].find(r => r.external_ref === '2001').voided).toBeFalsy();
  });

  it('does not sweep while the window is still draining', async () => {
    const txns = Array.from({ length: 200 }, (_, i) => invoice(3000 + i));
    installNetSuite({ txns, deletedIds: [9999], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      ledger_invoices: [{
        id: 'gone-2', source: 'netsuite', external_id: 'CustInvc/9999', external_ref: '9999',
        doc_type: 'invoice', doc_date: '2026-01-01', deleted_at: null, voided: false,
      }],
    });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE(), phaseBudgets: { headersMs: 0 } });

    expect(result.tombstoned).toBe(0);
    expect(service.tables['ledger_invoices'].find(r => r.id === 'gone-2').deleted_at).toBeNull();
  });

  it('a batch where NOTHING came back is read as a narrowed role, not as deleted history', async () => {
    // A subsidiary or segment restriction answers with an empty set rather
    // than an error. Believing it would soft-delete the entire mirror, 150
    // rows at a time, with no error and no cap.
    installNetSuite({ txns: [], deletedIds: [2101, 2102], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      ledger_invoices: [2101, 2102].map(ref => ({
        id: `inv-${ref}`, source: 'netsuite', external_id: `CustInvc/${ref}`, external_ref: String(ref),
        doc_type: 'invoice', doc_date: '2026-01-01', deleted_at: null, voided: false,
      })),
    });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.tombstoned).toBe(0);
    expect(service.tables['ledger_invoices'].every(r => r.deleted_at === null)).toBe(true);
    expect(result.tombstones?.problem).toContain('narrowed SuiteQL role');
    // Unfinished, but not a fault — and it must not redden the board.
    expect(result.partial).toBe(true);
    expect(nestedErrorKeys(lastResultOf(service))).toEqual([]);
  });

  it('a transaction NetSuite returns again is UN-tombstoned — absence was never proof of deletion', async () => {
    // The sweep infers deletion from absence, and a narrowed SuiteQL role
    // answers with a smaller row set rather than an error, so the inference
    // can be wrong. Nothing else could undo it: the sweep only enumerates
    // `deleted_at IS NULL`, and PostgREST's upsert sets only the columns it
    // is sent — the row would stay hidden from every reader while
    // `last_synced_at` kept moving.
    installNetSuite({ txns: [invoice(2500)], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      ledger_invoices: [{
        id: 'inv-2500', source: 'netsuite', external_id: 'CustInvc/2500', external_ref: '2500',
        doc_type: 'invoice', doc_date: '2026-01-01', deleted_at: '2026-09-01T00:00:00Z', voided: false,
      }],
    });

    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(service.tables['ledger_invoices']).toHaveLength(1);
    expect(service.tables['ledger_invoices'][0].deleted_at).toBeNull();
    expect(service.tables['ledger_invoices'][0].last_synced_at).toBeTruthy();
  });

  it('…but a batch that really is gone IS tombstoned once another batch proves the query returns rows', async () => {
    const alive = 3151;
    installNetSuite({
      txns: [],
      deletedIds: Array.from({ length: 150 }, (_, i) => 3001 + i),
      paymentsProbeStatus: 403,
    });
    const { service } = recordingService({
      ledger_invoices: [...Array.from({ length: 150 }, (_, i) => 3001 + i), alive].map(ref => ({
        id: `inv-${ref}`, source: 'netsuite', external_id: `CustInvc/${ref}`, external_ref: String(ref),
        doc_type: 'invoice', doc_date: '2026-01-01', deleted_at: null, voided: false,
      })),
    });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    // Batch 1 (150 ids, all missing) is HELD; batch 2 returns a live id, so
    // the held batch is applied.
    expect(result.tombstoned).toBe(150);
    expect(result.tombstones).toBeUndefined();
    expect(service.tables['ledger_invoices'].find(r => r.external_ref === String(alive)).deleted_at).toBeNull();
  });
});

describe('runNetSuiteMirror — payments probe and mirror', () => {
  it('reports a missing grant as not permitted, without pretending it is a bug', async () => {
    installNetSuite({ txns: [invoice(4001)], paymentsProbeStatus: 403 });
    const { service } = recordingService();

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.capabilities.payments).toEqual({
      permitted: false, linkTable: null, reason: 'not permitted — see docs/netsuite-ledger-grants.md',
    });
    expect(result.payments).toEqual({
      permitted: false, reason: 'not permitted — see docs/netsuite-ledger-grants.md',
    });
    expect(service.tables['ledger_payments'] ?? []).toHaveLength(0);
    // 'not permitted' is an expected state, not a fault — it must not redden.
    expect(nestedErrorKeys(lastResultOf(service))).toEqual([]);
  });

  it('carries the last run\'s verdict forward when the run never reaches the probe', async () => {
    // The header query fails, so the probe never runs. Publishing a blank
    // "not permitted" here would send the owner re-granting a permission
    // that is already in place.
    installNetSuite({ txns: [], headerError: sqlError(403) });
    const { service } = recordingService({
      sync_state: [{
        sync_type: NS_MIRROR_SYNC_TYPE,
        last_synced_at: '2026-09-13T00:00:00Z',
        last_result: {
          droppedColumns: ['balance'],
          capabilities: { payments: { permitted: true, linkTable: 'nexttransactionlinelink', reason: null } },
        },
      }],
    });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.error).toContain('403');
    expect(result.capabilities.payments).toEqual({
      permitted: true, linkTable: 'nexttransactionlinelink', reason: null,
    });
    // And the ladder's verdict is not re-asserted from a run that never asked.
    expect(result.droppedColumns).toEqual(['balance']);
  });

  it('reports "not probed yet" on a very first run that never gets to ask', async () => {
    installNetSuite({ txns: [], headerError: sqlError(500) });
    const { service } = recordingService();

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.capabilities.payments.reason).toContain('not probed yet');
  });

  it('a 400 on the link table is a query-shape bug, never a grant, and falls through to the other name', async () => {
    installNetSuite({ txns: [], payments: [], firstLinkTableStatus: 400 });
    const { service } = recordingService();

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.capabilities.payments).toMatchObject({
      permitted: true, linkTable: 'previoustransactionlinelink', reason: null,
    });
  });

  it('mirrors payments and takes BOTH halves of the application key from the resolved row', async () => {
    installNetSuite({
      txns: [
        invoice(5001, { lines: [] }),
        { id: 5002, type: 'CustCred', tranid: 'CM5002', total: '-40.00', lines: [] },
      ],
      payments: [{
        id: 6001, tranid: 'PMT6001', trandate: '2026-03-10', total: '340.00',
        applies: [
          { previousdoc: 5001, foreignamount: '-300.00' },
          { previousdoc: 5002, foreignamount: '-40.00' },
          // A previousdoc the mirror has not reached yet.
          { previousdoc: 5999, foreignamount: '-10.00' },
        ],
      }],
    });
    const { service } = recordingService({ customers: [{ id: 'cust-1', netsuite_id: '77' }] });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.capabilities.payments).toMatchObject({ permitted: true, linkTable: 'nexttransactionlinelink' });
    expect(result.payments).toEqual({ mirrored: 1, applications: 3 });

    const payment = service.tables['ledger_payments'][0];
    expect(payment).toMatchObject({
      external_id: 'CustPymt/6001', direction: 'in', party_kind: 'customer',
      payment_date: '2026-03-10', total: 340, customer_id: 'cust-1',
    });
    expect(payment.applications_synced_at).toBeTruthy();

    const apps = service.tables['ledger_payment_applications'];
    const invoiceApp = apps.find(a => a.applied_external_id === 'CustInvc/5001');
    expect(invoiceApp).toMatchObject({ applied_kind: 'invoice', amount: 300 });
    expect(invoiceApp.applied_invoice_id).toBeTruthy();

    // A credit-memo previousdoc must never be written as `credit_memo` +
    // 'CustInvc/<id>' — that pair matches nothing and stays NULL forever.
    const creditApp = apps.find(a => a.applied_kind === 'credit_memo');
    expect(creditApp.applied_external_id).toBe('CustCred/5002');
    expect(creditApp.applied_invoice_id).toBeTruthy();

    // The not-yet-mirrored target keeps the provisional shape and a NULL
    // target — "not mirrored yet", never "unapplied".
    const pending = apps.find(a => a.applied_external_id === 'CustInvc/5999');
    expect(pending).toMatchObject({ applied_kind: 'invoice', applied_invoice_id: null, amount: 10 });
  });

  it('a failed applications insert leaves applications_synced_at NULL', async () => {
    // Same rule as the invoice lines, same reason: `replaceChildren` has
    // already DELETEd, so a stamp over a failed insert hides the payment from
    // `idx_ledger_payments_apps_pending` (WHERE applications_synced_at IS
    // NULL) for good.
    installNetSuite({
      txns: [invoice(5100, { lines: [] })],
      payments: [{ id: 6100, applies: [{ previousdoc: 5100, foreignamount: '-100.00' }] }],
    });
    const { service } = recordingService();
    service.failWritesOn.add('ledger_payment_applications:insert');

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(service.tables['ledger_payment_applications'] ?? []).toHaveLength(0);
    expect(service.tables['ledger_payments'][0].applications_synced_at ?? null).toBeNull();
    expect(result.error).toContain('ledger_payment_applications insert');
  });

  it('stamps paid_on from the last application, but only on invoices the source calls paid', async () => {
    installNetSuite({
      txns: [invoice(7001, { status: 'B', label: 'Invoice : Paid In Full', lines: [] })],
      payments: [{ id: 7100, trandate: '2026-03-12', applies: [{ previousdoc: 7001, foreignamount: '-100.00' }] }],
    });
    const { service } = recordingService();

    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(service.tables['ledger_invoices'][0]).toMatchObject({ paid: true, paid_on: '2026-03-12' });
  });

  it('keeps the LATEST paid_on when a later page carries an older payment for the same invoice', async () => {
    // Payments are walked newest-first, 100 to a page, so an invoice settled
    // by two payments meets its OLDER one on a later page. The per-page max
    // is not the invoice's max: an unguarded write walks the date backwards
    // and leaves the backfill's own archive wrong, with nothing to correct it.
    installNetSuite({
      txns: [invoice(7001, { status: 'B', label: 'Invoice : Paid In Full', lines: [] })],
      payments: [
        // Page 1 (ids 7101-7200, newest first): the LATER payment.
        { id: 7200, trandate: '2026-06-01', applies: [{ previousdoc: 7001, foreignamount: '-60.00' }] },
        ...Array.from({ length: 99 }, (_, i) => ({ id: 7101 + i, trandate: '2026-05-01', applies: [] })),
        // Page 2: the EARLIER payment against the same invoice.
        { id: 7000, trandate: '2026-01-01', applies: [{ previousdoc: 7001, foreignamount: '-40.00' }] },
      ],
    });
    const { service } = recordingService();

    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(service.tables['ledger_invoices'][0]).toMatchObject({ paid: true, paid_on: '2026-06-01' });
  });

  it('a capped payments pass saves its place, holds the watermark, and the next run resumes BELOW it', async () => {
    // 30 s of paging cannot reach a decade of payments. Without a cursor the
    // next run re-pages the same newest 100 forever — and the moment the
    // header window drains, everything older leaves scope for good.
    installNetSuite({ txns: [], payments: Array.from({ length: 150 }, (_, i) => ({ id: 6001 + i })) });
    const { service } = recordingService();

    // Burn the whole payments budget on the first page.
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const pages = suiteql.getMockImplementation()!;
    suiteql.mockImplementation(async (...args: any[]) => {
      const out: any = await (pages as any)(...args);
      if (String(args[0]).includes("t.type = 'CustPymt'") && String(args[0]).includes('ORDER BY t.id DESC')) {
        now += 40_000;
      }
      return out;
    });

    const first = await runNetSuiteMirror(service as any, { deadline: 1_000_000 + 3_600_000 });

    expect(first.payments).toEqual({ mirrored: 100, applications: 0 });
    expect(first.partial).toBe(true);
    expect(first.resume?.paymentsBeforeId).toBe('6051');
    // The header window drained, but advancing last_synced_at now would put
    // payments 6001-6050 permanently out of the next window.
    expect(service.tables['sync_state'][0].last_synced_at).toBeUndefined();

    const second = await runNetSuiteMirror(service as any, { deadline: 1_000_000 + 3_600_000 });

    const payQueries = suiteql.mock.calls
      .map(c => String(c[0]))
      .filter(q => q.includes("t.type = 'CustPymt'") && q.includes('ORDER BY t.id DESC'));
    expect(payQueries.some(q => q.includes('AND t.id < 6051'))).toBe(true);
    expect(second.payments).toEqual({ mirrored: 50, applications: 0 });
    expect(service.tables['ledger_payments']).toHaveLength(150);
    // Drained: the cursor is cleared and the watermark finally moves.
    expect(second.resume?.paymentsBeforeId).toBeUndefined();
    expect(service.tables['sync_state'][0].last_synced_at).toBeTruthy();
  });

  it('drops a stale payments cursor when the grant is gone — it must not pin the window open', async () => {
    installNetSuite({ txns: [], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      sync_state: [{
        sync_type: NS_MIRROR_SYNC_TYPE,
        last_result: {
          resume: {
            windowStartedAt: '2026-09-13T00:00:00Z', since: '2026-08-01T00:00:00Z',
            beforeId: '0', processed: 4, paymentsBeforeId: '6051',
          },
        },
      }],
    });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.resume).toBeUndefined();
    expect(service.tables['sync_state'][0].last_synced_at).toBeTruthy();
  });
});

describe('runNetSuiteMirror — PDFs', () => {
  const withGate = () => ({ app_settings: [{ key: 'ledger', value: { pdfs_enabled_at: '2026-09-01T00:00:00Z' } }] });

  it('skips the whole phase with a named reason while the R2 privacy flip is unverified', async () => {
    installNetSuite({ txns: [invoice(8001)], paymentsProbeStatus: 403 });
    const { service } = recordingService();

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.pdfs.skipped).toBe('LEDGER_PDFS_ENABLED off — docs/r2-private-flip.md');
    expect(nsPdf).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('distinguishes "the gate is shut" from "the gate could not be read"', async () => {
    // pdf-gate.ts returns `readError` precisely so no downstream surface
    // prints the first as a fact when the second is true (R7-1). The
    // heartbeat is exactly such a downstream: Connections and the runbook
    // both quote it. Writes are blocked either way.
    process.env.NETSUITE_PDF_RESTLET_URL = 'https://restlet.example/pdf';
    installNetSuite({ txns: [invoice(8010)], paymentsProbeStatus: 403 });
    const { service } = recordingService();
    service.failReadsOn.add('app_settings');

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.pdfs.skipped).toMatch(/^Could not read the PDF gate — /);
    expect(result.pdfs.skipped).not.toContain('LEDGER_PDFS_ENABLED off');
    expect(nsPdf).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    // The row phase (1) queued is untouched: `attempts` is left to the
    // column default rather than spent on a gate we could not read.
    expect(service.tables['ledger_documents'][0].status).toBe('pending');
    expect(service.tables['ledger_documents'][0].attempts ?? 0).toBe(0);
  });

  it('says so plainly when the RESTlet URL is not configured, instead of burning every row\'s attempts', async () => {
    installNetSuite({ txns: [invoice(8050)], paymentsProbeStatus: 403 });
    const { service } = recordingService(withGate());

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.pdfs.skipped).toContain('NETSUITE_PDF_RESTLET_URL');
    expect(nsPdf).not.toHaveBeenCalled();
    expect(service.tables['ledger_documents'][0].status).toBe('pending');
    expect(service.tables['ledger_documents'][0].attempts ?? 0).toBe(0);
  });

  it('stores an invoice PDF under the relative ledger key and keeps the RESTlet filename', async () => {
    process.env.NETSUITE_PDF_RESTLET_URL = 'https://restlet.example/pdf';
    installNetSuite({ txns: [invoice(8100)], paymentsProbeStatus: 403 });
    nsPdf.mockResolvedValue({ success: true, pdfBase64: Buffer.from('%PDF-1.4').toString('base64'), filename: 'Invoice_INV8100.pdf' });
    const { service } = recordingService(withGate());

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.pdfs.stored).toBe(1);
    expect(nsPdf).toHaveBeenCalledWith('invoice', '8100', { timeoutMs: 40_000 });
    const doc = service.tables['ledger_documents'][0];
    expect(doc).toMatchObject({
      status: 'stored',
      file_name: 'Invoice_INV8100.pdf',
      storage_path: 'netsuite/CustInvc/8100/Invoice_INV8100.pdf',
    });
    // Relative to the prefix, never a URL.
    expect(doc.storage_path.startsWith('ledger/')).toBe(false);
    expect(doc.sha256).toBeTruthy();
  });

  it('parks credit-memo PDFs at needs_restlet while an older script is deployed, and releases them after the re-upload', async () => {
    process.env.NETSUITE_PDF_RESTLET_URL = 'https://restlet.example/pdf';
    installNetSuite({
      txns: [{ id: 8200, type: 'CustCred', tranid: 'CM8200', lines: [] }],
      paymentsProbeStatus: 403,
    });
    ping.mockResolvedValue({ reachable: true, version: '2026-09-10.1' });
    const { service } = recordingService(withGate());

    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(service.tables['ledger_documents'][0]).toMatchObject({
      status: 'needs_restlet',
      error: 'needs the PDF RESTlet update — see docs/netsuite-ledger-grants.md',
    });
    expect(nsPdf).not.toHaveBeenCalled();

    // The owner re-uploads the script; the next run releases the row.
    ping.mockResolvedValue({ reachable: true, version: '2026-09-15.1' });
    nsPdf.mockResolvedValue({ success: true, pdfBase64: Buffer.from('%PDF-1.4').toString('base64'), filename: 'CreditMemo_CM8200.pdf' });
    const second = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(nsPdf).toHaveBeenCalledWith('creditMemo', '8200', { timeoutMs: 40_000 });
    expect(second.pdfs.stored).toBe(1);
    expect(service.tables['ledger_documents'][0].status).toBe('stored');
  });

  it('an unreachable RESTlet skips the phase — it never parks credit memos or spends an attempt', async () => {
    // "The deployed script is old" and "nothing answered" are different
    // facts. Reporting the second as the first tells the owner to re-upload a
    // script that is already current, and carrying on into the invoice queue
    // burns every row's three attempts against the same dead endpoint —
    // three runs (six hours) and they are `failed`, which nothing re-queues.
    process.env.NETSUITE_PDF_RESTLET_URL = 'https://restlet.example/pdf';
    installNetSuite({
      txns: [
        { id: 8500, type: 'CustCred', tranid: 'CM8500', lines: [] },
        invoice(8501, { lines: [] }),
      ],
      paymentsProbeStatus: 403,
    });
    ping.mockResolvedValue({ reachable: false, error: 'connect ETIMEDOUT' });
    const { service } = recordingService(withGate());

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.pdfs.skipped).toBe('PDF RESTlet unreachable — connect ETIMEDOUT');
    expect(nsPdf).not.toHaveBeenCalled();
    expect(service.tables['ledger_documents']).toHaveLength(2);
    for (const doc of service.tables['ledger_documents']) {
      expect(doc.status).toBe('pending');
      expect(doc.attempts ?? 0).toBe(0);
      expect(doc.error ?? null).toBeNull();
    }
  });

  it('a queue window it has already tried this run is not "done" — more rows sit below the limit', async () => {
    // The read is capped at 12. When every row in that window fails
    // transiently they stay `pending` and come back identical, so treating
    // the emptied filter as "finished" would report the rows below them
    // dealt with when they were never attempted.
    process.env.NETSUITE_PDF_RESTLET_URL = 'https://restlet.example/pdf';
    installNetSuite({ txns: [], paymentsProbeStatus: 403 });
    const pending = Array.from({ length: 14 }, (_, i) => ({
      id: `doc-${String(i).padStart(2, '0')}`, source: 'netsuite', kind: 'pdf', status: 'pending',
      attempts: 0, external_id: `pdf:CustInvc/${9000 + i}`, external_ref: String(9000 + i),
      entity_type: 'CustInvc', entity_table: 'ledger_invoices', file_name: `INV${9000 + i}.pdf`,
      first_seen_at: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    nsPdf.mockResolvedValue({ success: false, error: 'RCRD_DSNT_EXIST' });
    const { service } = recordingService({ ...withGate(), ledger_documents: pending });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(nsPdf).toHaveBeenCalledTimes(12);
    expect(service.tables['ledger_documents'].filter(d => (d.attempts ?? 0) === 0)).toHaveLength(2);
    expect(result.partial).toBe(true);
    // Unfinished is not a fault: it must not redden the board.
    expect(nestedErrorKeys(lastResultOf(service))).toEqual([]);
  });

  it('a run that already failed on auth does not spend the pending rows\' attempts on the same outage', async () => {
    // The PDF RESTlet authenticates with the SAME NetSuite credentials as
    // the header query, so a 401 there means a 401 here. Three such runs
    // (six hours) would park every pending document at `failed`, which
    // `queuePdfDocuments` never re-queues — an outage would cost us those
    // PDFs permanently. Phase (4) is guarded by `!error` like (2) and (3).
    process.env.NETSUITE_PDF_RESTLET_URL = 'https://restlet.example/pdf';
    installNetSuite({ txns: [], headerError: sqlError(401), paymentsProbeStatus: 403 });
    const { service } = recordingService({
      ...withGate(),
      ledger_documents: [{
        id: 'doc-1', source: 'netsuite', kind: 'pdf', status: 'pending', attempts: 0,
        external_id: 'pdf:CustInvc/8400', external_ref: '8400', entity_type: 'CustInvc',
        entity_table: 'ledger_invoices', file_name: 'INV8400.pdf', first_seen_at: '2026-03-01T00:00:00Z',
      }],
    });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.error).toContain('401');
    expect(nsPdf).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
    expect(service.tables['ledger_documents'][0]).toMatchObject({ status: 'pending', attempts: 0 });
    // Not a "skipped" state either — the gate is open, the run simply never
    // got to the phase.
    expect(result.pdfs.skipped).toBeUndefined();
  });

  it('a RESTlet failure retries twice and only then gives up', async () => {
    process.env.NETSUITE_PDF_RESTLET_URL = 'https://restlet.example/pdf';
    installNetSuite({ txns: [invoice(8300)], paymentsProbeStatus: 403 });
    nsPdf.mockResolvedValue({ success: false, error: 'PERMISSION_VIOLATION' });
    const { service } = recordingService(withGate());

    for (let i = 0; i < 3; i++) await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    const doc = service.tables['ledger_documents'][0];
    expect(doc.attempts).toBe(3);
    expect(doc.status).toBe('failed');
    expect(doc.error).toContain('PERMISSION_VIOLATION');
  });
});

describe('runNetSuiteMirror — phase (5) repair', () => {
  const seedFor = (apps: any[], invoices: any[] = [], payments: any[] = []) => ({
    ledger_payments: [
      { id: 'pay-1', source: 'netsuite', external_id: 'CustPymt/6001', external_ref: '6001' },
      ...payments,
    ],
    ledger_invoices: invoices,
    ledger_payment_applications: apps,
  });

  it('rewrites a provisional invoice key to the credit memo it actually points at, and counts it', async () => {
    installNetSuite({ txns: [], paymentsProbeStatus: 403 });
    const { service } = recordingService(seedFor(
      [{
        id: 'app-1', payment_id: 'pay-1', applied_kind: 'invoice', applied_external_id: 'CustInvc/5002',
        applied_invoice_id: null, applied_bill_id: null, amount: 40,
      }],
      [{
        id: 'inv-cm', source: 'netsuite', external_id: 'CustCred/5002', external_ref: '5002',
        doc_type: 'credit_memo', doc_date: '2026-03-01', deleted_at: null, voided: false,
      }],
    ));

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.repaired).toBe(1);
    expect(service.tables['ledger_payment_applications'][0]).toMatchObject({
      applied_kind: 'credit_memo',
      applied_external_id: 'CustCred/5002',
      applied_invoice_id: 'inv-cm',
    });
  });

  it('leaves a still-unmirrored target NULL for the next run and never touches a QuickBooks application', async () => {
    installNetSuite({ txns: [], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      ...seedFor(
        [
          { id: 'app-1', payment_id: 'pay-1', applied_kind: 'invoice', applied_external_id: 'CustInvc/5999', applied_invoice_id: null, applied_bill_id: null },
          { id: 'app-2', payment_id: 'pay-qbo', applied_kind: 'invoice', applied_external_id: 'Invoice/5002', applied_invoice_id: null, applied_bill_id: null },
        ],
        [{
          id: 'inv-cm', source: 'netsuite', external_id: 'CustCred/5002', external_ref: '5002',
          doc_type: 'credit_memo', doc_date: '2026-03-01', deleted_at: null, voided: false,
        }],
        [{ id: 'pay-qbo', source: 'quickbooks', external_id: 'Payment/12', external_ref: '12' }],
      ),
    });

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.repaired).toBe(0);
    const apps = service.tables['ledger_payment_applications'];
    expect(apps.find(a => a.id === 'app-1').applied_invoice_id).toBeNull();
    // The QuickBooks row shares the '5002' id in a DIFFERENT namespace; the
    // mirror must not resolve it against a NetSuite invoice.
    expect(apps.find(a => a.id === 'app-2')).toMatchObject({
      applied_kind: 'invoice', applied_external_id: 'Invoice/5002', applied_invoice_id: null,
    });
  });

  it('deletes the provisional row instead of failing when the correct pair already exists', async () => {
    installNetSuite({ txns: [], paymentsProbeStatus: 403 });
    const { service } = recordingService(seedFor(
      [
        { id: 'app-good', payment_id: 'pay-1', applied_kind: 'credit_memo', applied_external_id: 'CustCred/5002', applied_invoice_id: 'inv-cm', applied_bill_id: null },
        { id: 'app-dupe', payment_id: 'pay-1', applied_kind: 'invoice', applied_external_id: 'CustInvc/5002', applied_invoice_id: null, applied_bill_id: null },
      ],
      [{
        id: 'inv-cm', source: 'netsuite', external_id: 'CustCred/5002', external_ref: '5002',
        doc_type: 'credit_memo', doc_date: '2026-03-01', deleted_at: null, voided: false,
      }],
    ));
    // The fake has no unique index; make the update raise the real 23505.
    const nativeFrom = service.from;
    (service as any).from = (table: string) => {
      const q = nativeFrom(table);
      if (table !== 'ledger_payment_applications') return q;
      const nativeUpdate = q.update.bind(q);
      q.update = (row: any) => {
        const chain = nativeUpdate(row);
        if (row.applied_invoice_id) {
          chain.eq = () => ({ then: (res: any) => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }).then(res) });
        }
        return chain;
      };
      return q;
    };

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    expect(result.repaired).toBe(1);
    expect(service.tables['ledger_payment_applications'].map(a => a.id)).toEqual(['app-good']);
  });

  it('paginates past 1000 rows and looks the targets up in chunks of 100', async () => {
    installNetSuite({ txns: [], paymentsProbeStatus: 403 });
    const apps = Array.from({ length: 1100 }, (_, i) => ({
      id: `app-${String(i).padStart(4, '0')}`,
      payment_id: 'pay-1',
      applied_kind: 'invoice',
      applied_external_id: `CustInvc/${9000 + i}`,
      applied_invoice_id: null,
      applied_bill_id: null,
    }));
    const invoices = apps.map((a, i) => ({
      id: `inv-${i}`, source: 'netsuite', external_id: a.applied_external_id, external_ref: String(9000 + i),
      doc_type: 'invoice', doc_date: '2026-03-01', deleted_at: null, voided: false,
    }));
    const { service, inCalls } = recordingService(seedFor(apps, invoices));

    const result = await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    // A plain select would have stopped silently at 1000 and left 100 rows
    // looking unapplied forever.
    expect(result.repaired).toBe(1100);
    const lookups = inCalls.filter(c => c.table === 'ledger_invoices' && c.col === 'external_ref');
    expect(lookups.length).toBe(11);
    expect(Math.max(...lookups.map(c => c.values.length))).toBeLessThanOrEqual(100);
  });

  it('bounds the ENUMERATION too, and a truncated one keeps the cursor instead of restarting', async () => {
    // `fetchAllRows` has no time or size limit of its own and this predicate
    // has no source scope, so on a backfill the read alone can walk tens of
    // thousands of rows before the first per-chunk deadline check. The
    // callback checks the clock; and because a truncated enumeration
    // examines NO row, the saved cursor has to survive it.
    installNetSuite({ txns: [], paymentsProbeStatus: 403 });
    const apps = Array.from({ length: 1100 }, (_, i) => ({
      id: `app-${String(i).padStart(4, '0')}`, payment_id: 'pay-1', applied_kind: 'invoice',
      applied_external_id: `CustInvc/${20000 + i}`, applied_invoice_id: null, applied_bill_id: null,
    }));
    const entry = { appliedExternalId: 'CustInvc/10000', id: 'app-9999' };
    const { service, tick, orCalls } = recordingService({
      ...seedFor(apps, []),
      sync_state: [{
        sync_type: NS_MIRROR_SYNC_TYPE,
        last_result: {
          resume: {
            windowStartedAt: '2026-09-10T00:00:00Z', since: '2026-08-01T00:00:00Z',
            beforeId: '0', processed: 0, repairAfter: entry,
          },
        },
      }],
    });

    // 10 s of clock per query against a 5 s repair budget: the phase's
    // second enumeration page is already past its deadline.
    const clock = tick(1_000_000, 10_000);
    const result = await runNetSuiteMirror(service as any, {
      deadline: 1_000_000 + 3_600_000,
      phaseBudgets: { repairMs: 5_000 },
    });
    clock.mockRestore();

    expect(result.partial).toBe(true);
    expect(result.repaired).toBe(0);
    // ONE enumeration page, not the two an unbounded `fetchAllRows` would
    // have run over 1,100 rows: the callback stopped on the clock.
    expect(orCalls.filter(c => c.table === 'ledger_payment_applications')).toHaveLength(1);
    // Not undefined, and not reset to the head — the previous run's place.
    expect(result.resume?.repairAfter).toEqual(entry);
    expect(nestedErrorKeys(lastResultOf(service))).toEqual([]);
  });

  it('a deadline mid-pass reports partial with a COMPOSITE repairAfter, and the next run resumes past it', async () => {
    installNetSuite({ txns: [], paymentsProbeStatus: 403 });
    // Two applications share one applied_external_id, which is exactly why
    // the cursor cannot be that id alone.
    const apps = [
      ...Array.from({ length: 100 }, (_, i) => ({
        id: `app-${String(i).padStart(4, '0')}`, payment_id: 'pay-1', applied_kind: 'invoice',
        applied_external_id: `CustInvc/${9000 + i}`, applied_invoice_id: null, applied_bill_id: null,
      })),
      { id: 'app-0099b', payment_id: 'pay-2', applied_kind: 'invoice', applied_external_id: 'CustInvc/9099', applied_invoice_id: null, applied_bill_id: null },
      { id: 'app-0100', payment_id: 'pay-1', applied_kind: 'invoice', applied_external_id: 'CustInvc/9100', applied_invoice_id: null, applied_bill_id: null },
    ];
    const invoices = apps.map((a, i) => ({
      id: `inv-${i}`, source: 'netsuite', external_id: a.applied_external_id,
      external_ref: a.applied_external_id.split('/')[1], doc_type: 'invoice',
      doc_date: '2026-03-01', deleted_at: null, voided: false,
    }));
    const seed = seedFor(apps, invoices, [{ id: 'pay-2', source: 'netsuite', external_id: 'CustPymt/6002', external_ref: '6002' }]);

    const first = recordingService(seed);
    // 1 s of clock per query: the repair phase's 60 s budget then expires
    // after the first 100-row chunk, mid-pass.
    const clock = first.tick(1_000_000, 1_000);
    const result = await runNetSuiteMirror(first.service as any, {
      deadline: 1_000_000 + 3_600_000,
      phaseBudgets: { repairMs: 60_000 },
    });
    clock.mockRestore();

    expect(result.partial).toBe(true);
    expect(result.repaired).toBe(100);
    expect(result.resume?.repairAfter).toEqual({ appliedExternalId: 'CustInvc/9099', id: 'app-0099' });
    // The header window drained and its watermark moved, so the resume says
    // so: it is carrying the repair cursor only, and the next run must open a
    // fresh window rather than re-fetch a spent one.
    expect(result.resume?.windowClosed).toBe(true);
    // A partial pass is not a fault.
    expect(nestedErrorKeys(lastResultOf(first.service))).toEqual([]);

    // The resumed run must use the composite keyset — a plain
    // `.gt('applied_external_id', …)` would skip app-0099b, the sibling
    // sharing that id.
    const second = await runNetSuiteMirror(first.service as any, { deadline: DEADLINE() });
    expect(second.error).toBeUndefined();
    const keyset = first.orCalls.filter(c => c.table === 'ledger_payment_applications');
    expect(keyset.length).toBeGreaterThan(0);
    expect(keyset[keyset.length - 1].expr).toBe(
      'applied_external_id.gt.CustInvc/9099,and(applied_external_id.eq.CustInvc/9099,id.gt.app-0099)',
    );
    expect(second.repaired).toBe(2);
    expect(second.resume?.repairAfter).toBeUndefined();
    expect(first.service.tables['ledger_payment_applications'].every(a => a.applied_invoice_id)).toBe(true);
  });
});

describe('the schedule and the health monitor', () => {
  it('runs at :35 on even hours, a minute nothing else in EITHER scheduler claims', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'));
    const mine = vercel.crons.find((c: any) => c.path === '/api/cron/ledger-netsuite-mirror');
    expect(mine?.schedule).toBe('35 */2 * * *');
    // CLAUDE.md: a shared cron minute saturated Supabase into 504s once. The
    // fallback workflow mirrors these schedules from GitHub Actions, so the
    // minute has to be free there too.
    const fallback = readFileSync(join(process.cwd(), '.github/workflows/cron-fallback.yml'), 'utf8');
    const fallbackMinutes = [...fallback.matchAll(/- cron: '([^']+)'/g)]
      .flatMap(m => m[1].trim().split(/\s+/)[0].split(','));
    expect(fallbackMinutes).not.toContain('35');
  });

  it('has ONE health monitor, on the interval the cron actually fires at', () => {
    const monitors = HEALTH_MONITORS.filter(m => m.syncType === NS_MIRROR_SYNC_TYPE);
    expect(monitors).toHaveLength(1);
    expect(monitors[0].intervalMinutes).toBe(120);
    expect(monitors[0].label).toContain('NetSuite ledger mirror');
  });
});

describe('the mirror is the only writer of its sync_state row', () => {
  it('starts its first window at FIRST_RUN_SINCE, not at the sync_state default', async () => {
    installNetSuite({ txns: [], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      // The row a previous PARTIAL run created: last_synced_at is the column
      // DEFAULT, not a watermark. Reading it as one would skip 2015-2019.
      sync_state: [{ sync_type: NS_MIRROR_SYNC_TYPE, last_synced_at: '2020-01-01T00:00:00Z', last_result: {} }],
    });

    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    const query = suiteql.mock.calls.map(c => String(c[0])).find(q => q.includes("t.type IN ('CustInvc', 'CustCred')"))!;
    const expected = new Date(Date.parse(FIRST_RUN_SINCE) - 86_400_000);
    expect(query).toContain(`TO_DATE('${expected.getUTCMonth() + 1}/${expected.getUTCDate()}/${expected.getUTCFullYear()}'`);
  });

  it('honours the owner override in app_settings.ledger.netsuite_since', async () => {
    installNetSuite({ txns: [], paymentsProbeStatus: 403 });
    const { service } = recordingService({
      app_settings: [{ key: 'ledger', value: { netsuite_since: '2024-06-10T00:00:00Z' } }],
    });

    await runNetSuiteMirror(service as any, { deadline: DEADLINE() });

    const query = suiteql.mock.calls.map(c => String(c[0])).find(q => q.includes("t.type IN ('CustInvc', 'CustCred')"))!;
    expect(query).toContain("TO_DATE('6/9/2024', 'MM/DD/YYYY')");
  });
});
