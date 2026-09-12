import { describe, it, expect } from 'vitest';
import {
  RECENTS_KEY, RECENTS_MAX,
  canOpenKind, quickActionsFor, describeResult, buildRecent,
  readRecents, pushRecent, clearRecents, visibleRecents,
  shortcutLabel, isPaletteChord,
  type PaletteAccess, type RecentRecord,
} from './command-palette';

// A localStorage stand-in. Deliberately stores strings only, so a test can
// plant corrupt JSON the way a real device would carry it.
function fakeStore(seed?: string) {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set(RECENTS_KEY, seed);
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    raw: () => map.get(RECENTS_KEY) ?? null,
  };
}

const NOBODY: PaletteAccess = {
  isAdmin: false, isSales: false, isGraphicsProduction: false,
  isInstaller: false, isShopTech: false, isFieldTech: false,
  hasFeature: () => false,
};
const access = (over: Partial<PaletteAccess> = {}): PaletteAccess => ({ ...NOBODY, ...over });
const withFeatures = (...keys: string[]) =>
  access({ hasFeature: (k: any) => keys.includes(String(k)) });

describe('canOpenKind', () => {
  it('mirrors each destination page gate', () => {
    expect(canOpenKind('purchase_orders', withFeatures('purchase_orders'))).toBe(true);
    expect(canOpenKind('purchase_orders', withFeatures('graphics'))).toBe(false);
    // Either check-in feature reaches the board.
    expect(canOpenKind('vehicles', withFeatures('fleet_checkin'))).toBe(true);
    expect(canOpenKind('vehicles', withFeatures('in_shop'))).toBe(true);
    expect(canOpenKind('quotes', access({ isGraphicsProduction: true }))).toBe(true);
    expect(canOpenKind('invoices', access({ isSales: true }))).toBe(true);
    expect(canOpenKind('invoices', withFeatures('estimates'))).toBe(false);
  });

  it('refuses a kind it does not know rather than waving it through', () => {
    expect(canOpenKind('payroll_runs', access({ isAdmin: true, hasFeature: () => true }))).toBe(false);
  });
});

describe('quickActionsFor', () => {
  const prospect = { id: '11111111-1111-1111-1111-111111111111', company_name: 'Acme', email: 'ap@acme.test' };

  it('offers log call / new estimate / email on a real CRM record', () => {
    const keys = quickActionsFor('customers', prospect, withFeatures('prospects', 'estimates')).map(a => a.key);
    expect(keys).toEqual(['log_call', 'new_estimate', 'email']);
  });

  it('never offers a prospects-keyed action on an ns- mirror row', () => {
    // /api/prospects/log-call validates a uuid, and there is no prospects row
    // to start an estimate against — both could only fail.
    const mirror = { id: 'ns-48210', company_name: 'Acme', email: 'ap@acme.test' };
    const keys = quickActionsFor('customers', mirror, withFeatures('prospects', 'estimates')).map(a => a.key);
    expect(keys).toEqual(['email']);
  });

  it('drops Email when the row carries no address', () => {
    const keys = quickActionsFor('customers', { ...prospect, email: '   ' }, withFeatures('prospects', 'estimates')).map(a => a.key);
    expect(keys).toEqual(['log_call', 'new_estimate']);
  });

  it('drops New estimate for a viewer without the estimates feature', () => {
    const keys = quickActionsFor('customers', prospect, withFeatures('prospects')).map(a => a.key);
    expect(keys).toEqual(['log_call', 'email']);
  });

  it('addresses the compose screen to the row’s email', () => {
    const email = quickActionsFor('customers', prospect, withFeatures('prospects'))
      .find(a => a.key === 'email');
    expect(email && 'url' in email ? email.url : '')
      .toBe('/admin/prospects/11111111-1111-1111-1111-111111111111?compose=1&to=ap%40acme.test');
  });

  it('links a vehicle pick list per visit, not per VIN', () => {
    const v = { id: 'checkin-9', vin: '1FTBW3XM6PKA12345' };
    const a = quickActionsFor('vehicles', v, access({ isShopTech: true }))[0];
    expect(a.key).toBe('pick_list');
    expect('url' in a ? a.url : '').toBe('/vehicles/1FTBW3XM6PKA12345/pick-list?visit=checkin-9');
  });

  it('withholds the pick list from a role the page bounces, and from a VIN-less row', () => {
    expect(quickActionsFor('vehicles', { id: 'c1', vin: 'VIN123' }, withFeatures('in_shop'))).toEqual([]);
    expect(quickActionsFor('vehicles', { id: 'c1', vin: '' }, access({ isAdmin: true }))).toEqual([]);
  });

  it('offers Invoice only on a shipped graphics job', () => {
    const shipped = { id: 'g1', status: 'shipped' };
    expect(quickActionsFor('graphics_jobs', shipped, access({ isSales: true })).map(a => a.key)).toEqual(['create_invoice']);
    expect(quickActionsFor('graphics_jobs', { id: 'g1', status: 'printing' }, access({ isSales: true }))).toEqual([]);
    expect(quickActionsFor('graphics_jobs', shipped, withFeatures('graphics'))).toEqual([]);
  });

  it('offers the PDF for estimates and quotes to the viewers who can hold them', () => {
    expect(quickActionsFor('estimates', { id: 'e1' }, withFeatures('estimates')).map(a => a.key)).toEqual(['pdf']);
    expect(quickActionsFor('estimates', { id: 'e1' }, withFeatures('graphics'))).toEqual([]);
    expect(quickActionsFor('quotes', { id: 'q1' }, access({ isSales: true })).map(a => a.key)).toEqual(['pdf']);
    expect(quickActionsFor('quotes', { id: 'q1' }, NOBODY)).toEqual([]);
  });

  it('offers nothing on a customer PO — receiving runs against a different table', () => {
    const po = { id: 'po1', po_number: '4471', customer: 'Acme' };
    expect(quickActionsFor('purchase_orders', po, access({ isAdmin: true, hasFeature: () => true }))).toEqual([]);
  });

  it('offers nothing for a null item', () => {
    expect(quickActionsFor('customers', null, access({ isAdmin: true, hasFeature: () => true }))).toEqual([]);
  });
});

describe('describeResult', () => {
  it('names each kind the way its result row does', () => {
    expect(describeResult('purchase_orders', { po_number: '4471', customer: 'Acme' }))
      .toEqual({ label: 'PO #4471', sub: 'Acme' });
    expect(describeResult('vehicles', { vin: '1FT', vehicle_year: 2024, vehicle_make: 'Ford', vehicle_model: 'Transit', customer_name: 'Acme' }))
      .toEqual({ label: '2024 Ford Transit', sub: 'VIN 1FT · Acme' });
    expect(describeResult('graphics_jobs', { job_number: '812', title: 'Door decals', customer: 'Acme' }))
      .toEqual({ label: '#812 Door decals', sub: 'Acme' });
    expect(describeResult('customers', { company_name: 'Acme', contact_name: 'Dana' }))
      .toEqual({ label: 'Acme', sub: 'Dana' });
    expect(describeResult('quotes', { quote_number: 'WQ-9', customer_name: 'Acme', vehicle_description: 'Sprinter' }))
      .toEqual({ label: 'Quote WQ-9', sub: 'Acme · Sprinter' });
  });

  it('falls back to the VIN when a check-in has no year/make/model', () => {
    expect(describeResult('vehicles', { vin: '1FT' })).toEqual({ label: 'VIN 1FT', sub: null });
  });

  it('returns null when there is nothing to call the record', () => {
    expect(describeResult('purchase_orders', { po_number: '' })).toBeNull();
    expect(describeResult('messages', { body: 'hi' })).toBeNull();
    expect(describeResult('customers', null)).toBeNull();
  });
});

describe('buildRecent', () => {
  it('builds an entry from a result row and its destination', () => {
    const r = buildRecent('customers', { id: 'p1', company_name: 'Acme' }, '/admin/prospects/p1', 1000);
    expect(r).toEqual({ kind: 'customers', id: 'p1', label: 'Acme', sub: null, url: '/admin/prospects/p1', at: 1000 });
  });

  it('never records a direct message', () => {
    // Bodies would sit in a shared tablet's localStorage.
    expect(buildRecent('messages', { id: 'm1', conversation_id: 'c1', body: 'the payroll numbers are' }, '/messages?conversation=c1')).toBeNull();
  });

  it('refuses an entry with no id, no destination, or an unknown kind', () => {
    expect(buildRecent('customers', { company_name: 'Acme' }, '/admin/prospects/p1')).toBeNull();
    expect(buildRecent('customers', { id: 'p1', company_name: 'Acme' }, '/')).toBeNull();
    expect(buildRecent('payroll_runs', { id: 'x', company_name: 'Acme' }, '/payroll')).toBeNull();
  });
});

describe('recents storage', () => {
  const rec = (id: string, at: number): RecentRecord =>
    ({ kind: 'customers', id, label: `Cust ${id}`, sub: null, url: `/admin/prospects/${id}`, at });

  it('round-trips newest first', () => {
    const s = fakeStore();
    pushRecent(rec('a', 1), s);
    pushRecent(rec('b', 2), s);
    expect(readRecents(s).map(r => r.id)).toEqual(['b', 'a']);
  });

  it('re-opening a record moves it to the front instead of duplicating it', () => {
    const s = fakeStore();
    pushRecent(rec('a', 1), s);
    pushRecent(rec('b', 2), s);
    pushRecent(rec('a', 3), s);
    expect(readRecents(s).map(r => r.id)).toEqual(['a', 'b']);
  });

  it(`keeps at most ${RECENTS_MAX}`, () => {
    const s = fakeStore();
    for (let i = 0; i < RECENTS_MAX + 5; i++) pushRecent(rec(`r${i}`, i), s);
    const rows = readRecents(s);
    expect(rows).toHaveLength(RECENTS_MAX);
    expect(rows[0].id).toBe(`r${RECENTS_MAX + 4}`);
  });

  it('reads corrupt, non-array or non-JSON storage as empty rather than throwing', () => {
    expect(readRecents(fakeStore('not json'))).toEqual([]);
    expect(readRecents(fakeStore('{"a":1}'))).toEqual([]);
    expect(readRecents(fakeStore(''))).toEqual([]);
    expect(readRecents(null)).toEqual([]);
  });

  it('drops malformed rows and any message row planted by an older build', () => {
    const s = fakeStore(JSON.stringify([
      { kind: 'customers', id: 'p1', label: 'Acme', sub: null, url: '/admin/prospects/p1', at: 5 },
      { kind: 'messages', id: 'm1', label: 'DM', sub: null, url: '/messages?conversation=c1', at: 9 },
      { kind: 'customers', id: '', label: 'x', sub: null, url: '/x', at: 4 },
      { kind: 'customers', id: 'p2', label: 'B', sub: null, url: '/admin/prospects/p2', at: Number.NaN },
      'nope',
    ]));
    expect(readRecents(s).map(r => r.id)).toEqual(['p1']);
  });

  it('a write that throws (quota, blocked storage) does not throw at the caller', () => {
    const s = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); }, removeItem: () => {} };
    expect(() => pushRecent(rec('a', 1), s)).not.toThrow();
    expect(pushRecent(rec('a', 1), s).map(r => r.id)).toEqual(['a']);
  });

  it('pushing nothing leaves the list alone', () => {
    const s = fakeStore();
    pushRecent(rec('a', 1), s);
    expect(pushRecent(null, s).map(r => r.id)).toEqual(['a']);
  });

  it('clears', () => {
    const s = fakeStore();
    pushRecent(rec('a', 1), s);
    clearRecents(s);
    expect(readRecents(s)).toEqual([]);
  });
});

describe('visibleRecents', () => {
  it('hides a record whose feature the viewer no longer holds', () => {
    const rows: RecentRecord[] = [
      { kind: 'customers', id: 'p1', label: 'Acme', sub: null, url: '/admin/prospects/p1', at: 2 },
      { kind: 'graphics_jobs', id: 'g1', label: '#1', sub: null, url: '/graphics/g1', at: 1 },
    ];
    expect(visibleRecents(rows, withFeatures('prospects')).map(r => r.id)).toEqual(['p1']);
    expect(visibleRecents(rows, withFeatures('prospects', 'graphics')).map(r => r.id)).toEqual(['p1', 'g1']);
    expect(visibleRecents(rows, NOBODY)).toEqual([]);
  });
});

describe('keyboard', () => {
  it('labels the chord for the platform', () => {
    expect(shortcutLabel('MacIntel')).toBe('⌘K');
    expect(shortcutLabel('iPhone')).toBe('⌘K');
    expect(shortcutLabel('Win32')).toBe('Ctrl K');
    expect(shortcutLabel(null)).toBe('Ctrl K');
  });

  it('matches Cmd+K and Ctrl+K only', () => {
    const ev = (o: any) => ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
    expect(isPaletteChord(ev({ metaKey: true }))).toBe(true);
    expect(isPaletteChord(ev({ ctrlKey: true }))).toBe(true);
    expect(isPaletteChord(ev({ key: 'K', ctrlKey: true }))).toBe(true);
    expect(isPaletteChord(ev({}))).toBe(false);
    expect(isPaletteChord(ev({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteChord(ev({ key: 'j', metaKey: true }))).toBe(false);
  });
});
