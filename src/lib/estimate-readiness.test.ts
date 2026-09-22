import { describe, it, expect } from 'vitest';
import { summarizeEstimateReadiness, type EstimatePartRow } from './estimate-readiness';

const row = (over: Partial<EstimatePartRow>): EstimatePartRow => ({
  item_number: 'PART', description: null, needed: 1, allocated: 0, free: 0,
  usable: 0, on_hand: 0, on_order: 0, short: 0, state: 'available',
  allocatable: 0, pos: [], netsuite_item_id: null, uncatalogued: false,
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
