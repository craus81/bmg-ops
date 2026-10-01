import { describe, it, expect } from 'vitest';
import { summarizeEstimateReadiness, stockCheckKey, toRequestQty, type EstimatePartRow } from './estimate-readiness';

const row = (over: Partial<EstimatePartRow>): EstimatePartRow => ({
  item_number: 'PART', description: null, needed: 1, allocated: 0, free: 0,
  usable: 0, on_hand: 0, on_order: 0, short: 0, state: 'available',
  allocatable: 0, pos: [], netsuite_item_id: null, uncatalogued: false,
  requested: 0, to_request: 0,
  ...over,
});

// The banner is the whole point of the panel: one sentence a salesperson
// decides on. These pin the two ways it could lie.
describe('summarizeEstimateReadiness', () => {
  it('says reserved only when every checkable line is held', () => {
    expect(summarizeEstimateReadiness([
      row({ item_number: 'A', state: 'reserved' }),
      row({ item_number: 'B', state: 'reserved' }),
    ]).verdict).toBe('reserved');

    expect(summarizeEstimateReadiness([
      row({ item_number: 'A', state: 'reserved' }),
      row({ item_number: 'B', state: 'available' }),
    ]).verdict).toBe('ready');
  });

  it('one short line outranks everything else', () => {
    const s = summarizeEstimateReadiness([
      row({ item_number: 'A', state: 'reserved' }),
      row({ item_number: 'B', state: 'waiting' }),
      row({ item_number: 'C', state: 'short' }),
    ]);
    expect(s.verdict).toBe('short');
    expect(s).toMatchObject({ covered: 1, onOrder: 1, short: 1 });
  });

  it('waits on the ETA when the gap is covered by open POs', () => {
    expect(summarizeEstimateReadiness([
      row({ item_number: 'A', state: 'available' }),
      row({ item_number: 'B', state: 'waiting', pos: [{ tranid: 'PO1', vendor_name: 'Ranger', trandate: null, status_label: 'Open', eta_date: '2026-10-02', remaining: 3 }] }),
    ])).toMatchObject({ verdict: 'waiting', lastEta: '2026-10-02' });
  });

  it('reports the latest ETA, so the date shown is the realistic one', () => {
    const s = summarizeEstimateReadiness([
      row({ item_number: 'A', state: 'waiting', pos: [{ tranid: 'PO1', vendor_name: null, trandate: null, status_label: null, eta_date: '2026-10-02', remaining: 1 }] }),
      row({ item_number: 'B', state: 'waiting', pos: [{ tranid: 'PO2', vendor_name: null, trandate: null, status_label: null, eta_date: '2026-11-14', remaining: 1 }] }),
    ]);
    expect(s.lastEta).toBe('2026-11-14');
  });

  // An uncatalogued line is a line nobody checked. Folding it into either
  // verdict is the failure mode: called ready, it promises stock that was
  // never looked at; called short, every estimate with a custom line cries
  // wolf and the banner stops being read.
  it('counts unknown lines separately and lets the rest stand', () => {
    const s = summarizeEstimateReadiness([
      row({ item_number: 'A', state: 'available' }),
      row({ item_number: 'CUSTOM-BRACKET', state: 'unknown', uncatalogued: true }),
    ]);
    expect(s).toMatchObject({ verdict: 'ready', unknown: 1, covered: 1 });
  });

  it('is unknown, never ready, when nothing on the estimate could be checked', () => {
    expect(summarizeEstimateReadiness([
      row({ item_number: 'CUSTOM-1', state: 'unknown', uncatalogued: true }),
    ])).toMatchObject({ verdict: 'unknown', unknown: 1 });
  });

  it('an estimate with no parts at all is not a warning', () => {
    expect(summarizeEstimateReadiness([])).toMatchObject({ verdict: 'ready', unknown: 0 });
  });
});

// Graphics lines are billed work, not shelf stock (Craig, 2026-09-30): they
// must never reach the check, however the line spells the item.
describe('stockCheckKey', () => {
  it('skips the graphics items in any case', () => {
    for (const name of ['3M Vinyl', 'Graphics Install Labor', 'Graphics Removal', 'graphics removal', ' 3M VINYL ']) {
      expect(stockCheckKey(name)).toBeNull();
    }
  });

  it('skips blanks and the custom-line placeholder', () => {
    expect(stockCheckKey('')).toBeNull();
    expect(stockCheckKey(null)).toBeNull();
    expect(stockCheckKey('FS-CUSTOM')).toBeNull();
  });

  it('keeps real parts, keyed the way the panel looks them up', () => {
    expect(stockCheckKey('fea-0024')).toBe('FEA-0024');
    expect(stockCheckKey('Ranger : FBM-1072-BLK')).toBe('FBM-1072-BLK');
  });
});

// What the estimate's Request parts button fills in.
describe('toRequestQty', () => {
  it('asks for the shortfall less what is already requested', () => {
    expect(toRequestQty(row({ state: 'short', short: 12, needed: 12 }))).toBe(12);
    expect(toRequestQty(row({ state: 'short', short: 12, needed: 12, requested: 5 }))).toBe(7);
    expect(toRequestQty(row({ state: 'short', short: 3, needed: 3, requested: 3 }))).toBe(0);
  });

  it('asks for everything still uncovered on a line not in the catalog', () => {
    expect(toRequestQty(row({ state: 'unknown', uncatalogued: true, needed: 3 }))).toBe(3);
    expect(toRequestQty(row({ state: 'unknown', uncatalogued: true, needed: 3, on_order: 1, requested: 1 }))).toBe(1);
    expect(toRequestQty(row({ state: 'unknown', uncatalogued: true, needed: 3, requested: 4 }))).toBe(0);
  });

  it('asks for nothing on lines that are covered or on order', () => {
    for (const state of ['available', 'reserved', 'waiting'] as const) {
      expect(toRequestQty(row({ state, needed: 4, short: 0 }))).toBe(0);
    }
  });

  it('counts the lines with something left to request', () => {
    expect(summarizeEstimateReadiness([
      row({ item_number: 'A', state: 'short', to_request: 3 }),
      row({ item_number: 'B', state: 'short', to_request: 0, requested: 3 }),
      row({ item_number: 'C', state: 'unknown', to_request: 1 }),
    ]).toRequest).toBe(2);
  });
});
