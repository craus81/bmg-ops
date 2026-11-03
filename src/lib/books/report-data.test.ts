import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { builderAsk, loadReports, monthsFor, postingOf, type LoadedReports } from './report-data';

describe('the report builder’s months that move with the calendar', () => {
  it('works each out from last month', () => {
    expect(monthsFor('picked', '2026-10-01')).toBeNull();
    expect(monthsFor('year_to_date', '2026-10-01')).toEqual({ from: '2026-01-01', to: '2026-10-01' });
    expect(monthsFor('last_month', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(monthsFor('last_year', '2026-10-01')).toEqual({ from: '2025-01-01', to: '2025-12-01' });
    expect(monthsFor('last_12_months', '2026-10-01')).toEqual({ from: '2025-11-01', to: '2026-10-01' });
  });

  it('takes the last quarter that has ended, the one last month ends when it ends one', () => {
    const quarter = (last: string) => monthsFor('last_quarter', last);
    expect(quarter('2026-10-01')).toEqual({ from: '2026-07-01', to: '2026-09-01' });
    expect(quarter('2026-11-01')).toEqual({ from: '2026-07-01', to: '2026-09-01' });
    expect(quarter('2026-09-01')).toEqual({ from: '2026-07-01', to: '2026-09-01' });
    expect(quarter('2026-12-01')).toEqual({ from: '2026-10-01', to: '2026-12-01' });
    expect(quarter('2026-06-01')).toEqual({ from: '2026-04-01', to: '2026-06-01' });
    // In January or February, it's the year before's last.
    expect(quarter('2027-01-01')).toEqual({ from: '2026-10-01', to: '2026-12-01' });
    expect(quarter('2027-02-01')).toEqual({ from: '2026-10-01', to: '2026-12-01' });
    expect(quarter('2027-03-01')).toEqual({ from: '2027-01-01', to: '2027-03-01' });
  });

  it('has December end the year: last year is the one that just ended', () => {
    expect(monthsFor('last_year', '2026-12-01')).toEqual({ from: '2026-01-01', to: '2026-12-01' });
    expect(monthsFor('last_year', '2027-01-01')).toEqual({ from: '2026-01-01', to: '2026-12-01' });
    expect(monthsFor('year_to_date', '2026-12-01')).toEqual({ from: '2026-01-01', to: '2026-12-01' });
    expect(monthsFor('last_12_months', '2026-12-01')).toEqual({ from: '2026-01-01', to: '2026-12-01' });
  });

  it('starts no earlier than January 2025', () => {
    expect(monthsFor('last_12_months', '2025-06-01')).toEqual({ from: '2025-01-01', to: '2025-06-01' });
    expect(monthsFor('last_year', '2025-06-01')).toEqual({ from: '2025-01-01', to: '2025-01-01' });
    expect(monthsFor('last_quarter', '2025-02-01')).toEqual({ from: '2025-01-01', to: '2025-01-01' });
    expect(monthsFor('last_quarter', '2025-04-01')).toEqual({ from: '2025-01-01', to: '2025-03-01' });
    expect(monthsFor('year_to_date', '2025-01-01')).toEqual({ from: '2025-01-01', to: '2025-01-01' });
  });
});

describe('the report a request asks the builder for', () => {
  const loaded = { through: '2026-11-01', lastMonth: '2026-10-01' } as LoadedReports;
  const ask = (query: string) => builderAsk(new URLSearchParams(query), loaded);

  it('opens on the year to date by division, a line for each account', () => {
    expect(ask('')).toEqual({
      rows: 'account', months: 'year_to_date', from: '2026-01-01', to: '2026-10-01', by: 'division', division: null, location: null,
    });
  });

  it('takes the lines, columns, months and filters asked for', () => {
    expect(ask('rows=vendor&by=quarter&months=last_year&division=graphics&location=own:denver')).toEqual({
      rows: 'vendor', months: 'last_year', from: '2025-01-01', to: '2025-12-01', by: 'quarter', division: 'graphics', location: 'own:denver',
    });
    expect(ask('rows=customer&from=2026-03&to=2026-05')).toMatchObject({ rows: 'customer', months: 'picked', from: '2026-03-01', to: '2026-05-01' });
    // Only a start picked: the end is last month.
    expect(ask('from=2025-06')).toMatchObject({ months: 'picked', from: '2025-06-01', to: '2026-10-01' });
    // A month that moves with the calendar wins over months picked with it.
    expect(ask('months=last_month&from=2025-06&to=2025-08')).toMatchObject({ months: 'last_month', from: '2026-10-01', to: '2026-10-01' });
  });

  it('falls back for what it has none of', () => {
    expect(ask('rows=items&by=week&months=soon')).toMatchObject({ rows: 'account', by: 'division', months: 'year_to_date' });
    // Months it can't cover are none picked.
    expect(ask('from=2024-06&to=2027-01')).toMatchObject({ months: 'year_to_date', from: '2026-01-01', to: '2026-10-01' });
    expect(ask('months=picked&from=2026-09&to=2026-02')).toMatchObject({ months: 'picked', from: '2026-01-01', to: '2026-02-01' });
    expect(ask('division=&location=')).toMatchObject({ division: null, location: null });
  });
});

describe('how the last posting run went', () => {
  it('is nothing before it has run', () => {
    expect(postingOf(null)).toBeNull();
  });

  it('says when it ran, what went wrong and whether it stopped for time', () => {
    const at = '2026-11-02T17:48:00Z';
    expect(postingOf({ last_result: null, updated_at: at })).toEqual({ at, error: null, partial: false });
    expect(postingOf({ last_result: { posted: 3 }, updated_at: at })).toEqual({ at, error: null, partial: false });
    expect(postingOf({ last_result: { partial: true }, updated_at: at })).toEqual({ at, error: null, partial: true });
    expect(postingOf({ last_result: { error: 'Deadlock', partial: false }, updated_at: at })).toEqual({ at, error: 'Deadlock', partial: false });
  });
});

describe('the months the reports open on', () => {
  afterEach(() => { vi.useRealTimers(); });
  // Just enough of supabase-js for loadReports: one company, no accounts, nothing posted or copied yet.
  const service = {
    from: (table: string) => {
      const rows = table === 'gl_companies' ? [{ id: 'c2', code: 'BMG', name: 'BMG', legal_name: null, netsuite_subsidiary_id: '2' }] : [];
      const q: any = {
        select: () => q, order: () => q, eq: () => q,
        range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(done, failed),
      };
      return q;
    },
    rpc: async (name: string) => ({ data: name === 'gl_netsuite_totals' ? {} : [], error: null }),
  } as unknown as SupabaseClient;
  const months = async (at: string) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at));
    const loaded = await loadReports(service, null) as LoadedReports;
    return { through: loaded.through, lastMonth: loaded.lastMonth };
  };

  it("are O'Fallon's: the evening of the 31st is still that month", async () => {
    // 10:30 PM CDT on October 31: UTC is in November already.
    expect(await months('2026-11-01T03:30:00Z')).toEqual({ through: '2026-10-01', lastMonth: '2026-09-01' });
    expect(await months('2026-11-01T05:30:00Z')).toEqual({ through: '2026-11-01', lastMonth: '2026-10-01' });
    // New Year's Eve, then New Year's Day.
    expect(await months('2027-01-01T03:00:00Z')).toEqual({ through: '2026-12-01', lastMonth: '2026-11-01' });
    expect(await months('2027-01-01T06:30:00Z')).toEqual({ through: '2027-01-01', lastMonth: '2026-12-01' });
  });
});
