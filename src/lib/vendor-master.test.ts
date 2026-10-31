import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { matchVendor, syncVendors, vendorKey } from './vendor-master';
import { suiteqlQuery } from './netsuite';
import { HEALTH_MONITORS, recordHeartbeat } from '@/lib/system-health';

vi.mock('./netsuite', () => ({ suiteqlQuery: vi.fn() }));
vi.mock('@/lib/system-health', async (actual) => ({
  ...(await actual<typeof import('@/lib/system-health')>()),
  recordHeartbeat: vi.fn(async () => ({ ok: true })),
}));

const master = [
  { company_name: 'Grimco Inc', entity_id: 'GRIMCO' },
  { company_name: 'Fellers', entity_id: 'FELLERS' },
  { company_name: 'General Formulations', entity_id: 'GENFORM' },
];

describe('vendorKey', () => {
  it('collapses the spelling differences that split one vendor into three', () => {
    expect(vendorKey('  GRIMCO ')).toBe('grimco');
    expect(vendorKey('Grimco, Inc.')).toBe('grimco inc');
    expect(vendorKey(null)).toBe('');
  });
});

describe('matchVendor', () => {
  it('matches on company name or entity id, case- and punctuation-insensitively', () => {
    expect(matchVendor('grimco inc', master)?.entity_id).toBe('GRIMCO');
    expect(matchVendor('GRIMCO', master)?.entity_id).toBe('GRIMCO');
    expect(matchVendor('Fellers', master)?.entity_id).toBe('FELLERS');
  });

  it('resolves a unique prefix but refuses a blank or unknown name', () => {
    expect(matchVendor('Grimco', master)?.entity_id).toBe('GRIMCO');
    expect(matchVendor('', master)).toBeNull();
    expect(matchVendor('Nobody Supply Co', master)).toBeNull();
  });
});

describe('syncVendors', () => {
  const query = vi.mocked(suiteqlQuery);
  const heartbeat = vi.mocked(recordHeartbeat);
  type Row = Record<string, unknown>;
  /**
   * netsuite_vendors as the copy takes it: each upsert's rows, or an error to answer with. Once FleetSuite's record
   * wins (`on`), the vendors FleetSuite has (`mine`) are read first, and what NetSuite has instead is noted.
   * `switchError` is the switch's read failing.
   */
  const copy = (
    error: { message: string } | null = null,
    opts: { on?: boolean; mine?: Row[]; unread?: boolean; noteError?: string; switchError?: string } = {},
  ) => {
    const upserts: Array<{ rows: Row[]; opts: unknown }> = [];
    const notes: Array<{ fn: string; p: Row[] }> = [];
    const chain = (answer: () => { data: unknown; error: { message: string } | null }) => {
      const q: any = { eq: () => q, order: () => q, range: async () => answer() };
      return q;
    };
    const service = {
      from: (table: string) => {
        if (table === 'books_switches') {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => (opts.switchError
            ? { data: null, error: { message: opts.switchError } }
            : { data: opts.on ? { is_on: true } : null, error: null }) }) }) };
        }
        if (table === 'record_differences') return { select: () => chain(() => ({ data: [], error: null })) };
        expect(table).toBe('netsuite_vendors');
        return {
          upsert: async (rows: Row[], o: unknown) => { upserts.push({ rows, opts: o }); return { error }; },
          select: () => chain(() => (opts.unread ? { data: null, error: { message: 'netsuite_vendors timed out' } } : { data: opts.mine ?? [], error: null })),
        };
      },
      rpc: async (fn: string, args: { p: Row[] }) => {
        notes.push({ fn, p: args.p });
        return opts.noteError ? { data: null, error: { message: opts.noteError } } : { data: { opened: args.p.length, closed: 0 }, error: null };
      },
    };
    return { service: service as any, upserts, notes };
  };

  beforeEach(() => {
    query.mockReset();
    heartbeat.mockClear();
  });

  it("copies NetSuite's vendors with their terms, and writes the heartbeat System Health watches", async () => {
    query.mockResolvedValueOnce({ items: [
      { id: 101, entityid: 'ACME', companyname: 'Acme Supply Co', email: 'ap@acme.example', phone: '555-0100', isinactive: 'F', termsname: 'Net 30' },
      { id: 102, entityid: 'WIDGET', companyname: null, email: null, phone: null, isinactive: 'T', termsname: null },
    ] } as any);
    const { service, upserts } = copy();
    expect(await syncVendors(service)).toEqual({ fetched: 2, upserted: 2, syncStateWrite: { ok: true } });
    expect(String(query.mock.calls[0][0])).toContain('LEFT JOIN term t ON t.id = v.terms');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].opts).toEqual({ onConflict: 'netsuite_id' });
    expect(upserts[0].rows).toEqual([
      { netsuite_id: '101', entity_id: 'ACME', company_name: 'Acme Supply Co', email: 'ap@acme.example', phone: '555-0100', terms: 'Net 30', is_inactive: false, synced_at: expect.any(String) },
      { netsuite_id: '102', entity_id: 'WIDGET', company_name: 'WIDGET', email: null, phone: null, terms: null, is_inactive: true, synced_at: expect.any(String) },
    ]);
    expect(heartbeat).toHaveBeenCalledWith(service, 'netsuite_vendors', { fetched: 2, upserted: 2 }, { startedAt: expect.any(Number), records: 2 });
  });

  it("copies the list without terms when NetSuite won't join them, 500 vendors at a time", async () => {
    query.mockRejectedValueOnce(new Error('Invalid search query'));
    query.mockResolvedValueOnce({ items: Array.from({ length: 501 }, (_, i) => ({ id: 200 + i, entityid: `V${i}`, isinactive: 'F' })) } as any);
    const { service, upserts } = copy();
    expect(await syncVendors(service)).toMatchObject({ fetched: 501, upserted: 501 });
    expect(String(query.mock.calls[1][0])).not.toContain('term');
    expect(upserts.map((u) => u.rows.length)).toEqual([500, 1]);
    expect(upserts[0].rows[0]).toMatchObject({ netsuite_id: '200', company_name: 'V0', terms: null });
  });

  it('keeps a failed copy in the heartbeat, so System Health shows it', async () => {
    query.mockRejectedValue(new Error('NetSuite SuiteQL error (403): permission'));
    const failed = copy();
    expect(await syncVendors(failed.service)).toMatchObject({ fetched: 0, upserted: 0, error: 'NetSuite SuiteQL error (403): permission' });
    expect(heartbeat).toHaveBeenLastCalledWith(failed.service, 'netsuite_vendors', { fetched: 0, upserted: 0, error: 'NetSuite SuiteQL error (403): permission' }, { startedAt: expect.any(Number), records: 0 });

    query.mockReset();
    query.mockResolvedValueOnce({ items: [{ id: 101, entityid: 'ACME', isinactive: 'F' }] } as any);
    const refused = copy({ message: 'netsuite_vendors is read-only' });
    expect(await syncVendors(refused.service)).toMatchObject({ fetched: 1, upserted: 0, error: 'netsuite_vendors is read-only' });
    expect(heartbeat).toHaveBeenLastCalledWith(refused.service, 'netsuite_vendors', { fetched: 1, upserted: 0, error: 'netsuite_vendors is read-only' }, { startedAt: expect.any(Number), records: 0 });
  });

  describe("once FleetSuite's record wins", () => {
    const NETSUITE = [
      { id: 101, entityid: 'ACME', companyname: 'Acme Supply Company', email: 'ap@acme.example', phone: '555-0100', isinactive: 'T', termsname: 'Net 45' },
      { id: 102, entityid: 'WIDGET', companyname: 'Widget Works', email: null, phone: '555-0122', isinactive: 'F', termsname: null },
    ];
    const MINE = [{ netsuite_id: '101', company_name: 'Acme Supply Co', email: null, phone: '(555) 0100', terms: 'Net 30' }];

    it("keeps the name, email and phone FleetSuite has, NetSuite's filling a blank, and notes what NetSuite has instead", async () => {
      query.mockResolvedValueOnce({ items: NETSUITE } as any);
      const { service, upserts, notes } = copy(null, { on: true, mine: MINE });
      expect(await syncVendors(service)).toEqual({ fetched: 2, upserted: 2, changedInNetsuite: 1, syncStateWrite: { ok: true } });
      expect(upserts[0].rows).toEqual([
        // Its terms and whether it's inactive still come from NetSuite.
        { netsuite_id: '101', entity_id: 'ACME', company_name: 'Acme Supply Co', email: 'ap@acme.example', phone: '(555) 0100', terms: 'Net 45', is_inactive: true, synced_at: expect.any(String) },
        // One FleetSuite hasn't got comes in as NetSuite has it.
        { netsuite_id: '102', entity_id: 'WIDGET', company_name: 'Widget Works', email: null, phone: '555-0122', terms: null, is_inactive: false, synced_at: expect.any(String) },
      ]);
      expect(notes).toEqual([{ fn: 'note_record_differences', p: [
        { kind: 'vendor', netsuite_id: '101', name: 'Acme Supply Co', field: 'name', fleetsuite: 'Acme Supply Co', netsuite: 'Acme Supply Company', differs: true },
      ] }]);
      expect(heartbeat).toHaveBeenCalledWith(service, 'netsuite_vendors', { fetched: 2, upserted: 2, changedInNetsuite: 1 }, { startedAt: expect.any(Number), records: 2 });
    });

    it("keeps FleetSuite's email and phone where NetSuite has others, or none", async () => {
      query.mockResolvedValueOnce({ items: [
        { id: 103, entityid: 'FELLERS', companyname: 'Fellers', email: 'orders@fellers.example', phone: null, isinactive: 'F', termsname: 'Net 30' },
      ] } as any);
      const { service, upserts, notes } = copy(null, { on: true, mine: [{ netsuite_id: '103', company_name: 'Fellers', email: 'ap@fellers.example', phone: '314-555-0199' }] });
      expect(await syncVendors(service)).toMatchObject({ fetched: 1, upserted: 1, changedInNetsuite: 2 });
      expect(upserts[0].rows[0]).toMatchObject({ company_name: 'Fellers', email: 'ap@fellers.example', phone: '314-555-0199', terms: 'Net 30' });
      expect(notes[0].p.map((s) => [s.field, s.netsuite])).toEqual([['email', 'orders@fellers.example'], ['phone', null]]);
    });

    it("writes nothing when it can't read FleetSuite's vendors, so none is written over", async () => {
      query.mockResolvedValueOnce({ items: NETSUITE } as any);
      const { service, upserts, notes } = copy(null, { on: true, unread: true });
      expect(await syncVendors(service)).toMatchObject({ fetched: 2, upserted: 0, error: "Couldn't read FleetSuite's vendors: netsuite_vendors timed out" });
      expect(upserts).toEqual([]);
      expect(notes).toEqual([]);
    });

    it("writes nothing when it can't tell whether FleetSuite's record wins, rather than take it for off", async () => {
      query.mockResolvedValueOnce({ items: NETSUITE } as any);
      const { service, upserts, notes } = copy(null, { mine: MINE, switchError: 'books_switches timed out' });
      expect(await syncVendors(service)).toMatchObject({
        fetched: 2, upserted: 0, error: "Couldn't tell whether FleetSuite's record wins: books_switches timed out",
      });
      expect(upserts).toEqual([]);
      expect(notes).toEqual([]);
    });

    it("says so when what NetSuite has instead can't be noted, for the next copy to see again", async () => {
      query.mockResolvedValueOnce({ items: NETSUITE } as any);
      const { service, upserts } = copy(null, { on: true, mine: MINE, noteError: 'deadlock' });
      expect(await syncVendors(service)).toMatchObject({ fetched: 2, upserted: 2, error: "Couldn't note what NetSuite has instead: deadlock" });
      expect(upserts[0].rows[0]).toMatchObject({ company_name: 'Acme Supply Co' });
    });

    it("copies NetSuite's over FleetSuite's while it's off, reading nothing of FleetSuite's", async () => {
      query.mockResolvedValueOnce({ items: NETSUITE } as any);
      const { service, upserts, notes } = copy(null, { on: false, mine: MINE });
      expect(await syncVendors(service)).toEqual({ fetched: 2, upserted: 2, syncStateWrite: { ok: true } });
      expect(upserts[0].rows[0]).toMatchObject({ company_name: 'Acme Supply Company', email: 'ap@acme.example', phone: '555-0100' });
      expect(notes).toEqual([]);
    });
  });

  it('runs in the two-hour NetSuite sync, and System Health watches it on that schedule', () => {
    const cron = readFileSync(join(__dirname, '../app/api/cron/netsuite-sync/route.ts'), 'utf8');
    expect(cron).toContain('results.vendors = await syncVendors(supabase);');
    expect(HEALTH_MONITORS.find((m) => m.syncType === 'netsuite_vendors')).toEqual({ syncType: 'netsuite_vendors', label: 'NetSuite vendor list sync', intervalMinutes: 120 });
  });
});
