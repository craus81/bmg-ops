// Differences vs NetSuite (src/app/api/admin/books/differences): whether the
// month it shows is closed in FleetSuite's books (Books → Months,
// src/lib/books/months.ts), so the page can say NetSuite's changes in it wait.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-auth', () => ({ requireBooks: vi.fn(async () => ({ user: { id: 'u-craig' }, access: 'read' })) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET } from '../../app/api/admin/books/differences/route';

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let errors: Record<string, { message: string }>;

/** Just enough of supabase-js for the route: the columns selected, equality filters, and the first row for maybeSingle. */
function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let columns: string[] = [];
  const pick = (r: Row) => Object.fromEntries(columns.map((c) => [c, r[c]]));
  const result = () => (errors[table]
    ? { data: null, error: errors[table] }
    : { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).map(pick), error: null });
  const q: any = {
    select: (list: string) => { columns = list.split(',').map((c) => c.trim()); return q; },
    order: () => q,
    eq: (col: string, value: unknown) => { filters.push((r) => r[col] === value); return q; },
    range: async (from: number, to: number) => {
      const r = result();
      return { ...r, data: r.data && r.data.slice(from, to + 1) };
    },
    maybeSingle: async () => {
      const r = result();
      return { ...r, data: r.data ? r.data[0] ?? null : null };
    },
    then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(result()).then(done, failed),
  };
  return q;
}
const service = {
  from: query,
  rpc: async (name: string) => (name === 'gl_books_difference_documents'
    ? { data: { counts: {}, documents: [] }, error: null }
    : { data: name === 'gl_books_differences' ? {} : null, error: null }),
};

const get = async (params = '') => {
  const res = await GET(new NextRequest(`https://go.bmgfleet.com/api/admin/books/differences${params ? `?${params}` : ''}`));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-03-15T15:00:00Z'));
  tables = {
    gl_companies: [
      { id: 'c1', code: '1084', name: '1084', netsuite_subsidiary_id: '5' },
      { id: 'c2', code: 'BMG', name: 'BMG', netsuite_subsidiary_id: '2' },
    ],
    // Made-up: BMG's January and February 2027 closed; 1084's February open, its January closed.
    gl_periods: [
      { company_id: 'c2', period_start: '2027-01-01', status: 'closed' },
      { company_id: 'c2', period_start: '2027-02-01', status: 'closed' },
      { company_id: 'c1', period_start: '2027-01-01', status: 'closed' },
      { company_id: 'c1', period_start: '2027-02-01', status: 'open' },
    ],
  };
  errors = {};
});
afterEach(() => { vi.useRealTimers(); });

describe('Differences vs NetSuite: a month closed in the books', () => {
  it("says whether the company's month shown is closed in FleetSuite's books", async () => {
    // Last month by default.
    expect((await get()).body).toMatchObject({ company: 'BMG', month: '2027-02-01', closed: true });
    expect((await get('month=2027-01')).body).toMatchObject({ month: '2027-01-01', closed: true });
    expect((await get('month=2027-03')).body).toMatchObject({ month: '2027-03-01', closed: false });
    expect((await get('company=1084')).body).toMatchObject({ company: '1084', month: '2027-02-01', closed: false });
    expect((await get('company=1084&month=2027-01')).body).toMatchObject({ company: '1084', closed: true });
    // Nothing has posted to a month nor closed it: no row.
    tables.gl_periods = [];
    expect((await get()).body.closed).toBe(false);
  });

  it("says what failed when it can't read whether the month is closed", async () => {
    errors = { gl_periods: { message: 'gl_periods is down' } };
    expect(await get()).toEqual({ status: 500, body: { error: 'gl_periods is down' } });
  });
});
