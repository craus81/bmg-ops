import { describe, it, expect } from 'vitest';
import { groupArrivals, rowsToClose, type InboundLike, type ArrivalLinks } from './arrival-groups';

const row = (id: string, source_type: InboundLike['source_type'], source_id: string | null, extra: Partial<InboundLike> = {}): InboundLike => ({
  id, source_type, source_id, expected_date: null, need_back_date: null, vin: null, netsuite_so_number: null, vehicle_desc: id, ...extra,
});
const links = (g: Record<string, string> = {}, u: Record<string, string> = {}): ArrivalLinks => ({
  graphicsEstimate: new Map(Object.entries(g)),
  upfitEstimate: new Map(Object.entries(u)),
});

describe('groupArrivals', () => {
  it('folds a graphics job and the SO from the same estimate into one van', () => {
    const rows = [
      row('gfx', 'graphics_job', 'job1', { expected_date: '2026-10-27' }),
      row('so', 'sales_order', 'est1', { netsuite_so_number: '1182' }),
    ];
    const groups = groupArrivals(rows, links({ job1: 'est1' }));
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map(r => r.id)).toEqual(['so', 'gfx']);
    expect(groups[0].lead.id).toBe('so');
    // No drop-off booked: the install date stands in.
    expect(groups[0].arrivalDate).toBe('2026-10-27');
    expect(groups[0].hasDropoff).toBe(false);
  });

  it('arrives on the drop-off date and flags an install booked before it', () => {
    const rows = [
      row('gfx', 'graphics_job', 'job1', { expected_date: '2026-10-29' }),
      row('so', 'sales_order', 'est1', { expected_date: '2026-10-30', netsuite_so_number: '1185' }),
    ];
    const [g] = groupArrivals(rows, links({ job1: 'est1' }));
    expect(g.arrivalDate).toBe('2026-10-30');
    expect(g.hasDropoff).toBe(true);
    expect(g.installs.map(i => i.date)).toEqual(['2026-10-29']);
    expect(g.installBeforeArrival).toBe(true);
  });

  it('joins an upfit to the SO by SO number and rows by VIN', () => {
    const rows = [
      row('so', 'sales_order', 'est1', { netsuite_so_number: '1182', vin: '1ftbw2cm5pka00001', expected_date: '2026-10-26' }),
      row('up', 'upfit_project', 'p1', { netsuite_so_number: ' 1182 ', expected_date: '2026-10-26', need_back_date: '2026-11-02' }),
      row('so2', 'sales_order', 'est2', { vin: '1FTBW2CM5PKA00001' }),
    ];
    const groups = groupArrivals(rows, links());
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(3);
    expect(groups[0].needBack).toBe('2026-11-02');
  });

  it('never merges on customer name and leaves manual rows alone', () => {
    const rows = [
      row('a', 'sales_order', 'est1', { expected_date: '2026-10-26' }),
      row('b', 'sales_order', 'est2', { expected_date: '2026-10-26' }),
      row('m', 'manual', null, { expected_date: '2026-10-26' }),
    ];
    expect(groupArrivals(rows, links())).toHaveLength(3);
  });

  it('keeps one row per graphics job when one estimate covers several vans', () => {
    const rows = [
      row('so', 'sales_order', 'est1', { netsuite_so_number: '1190' }),
      row('u14', 'graphics_job', 'j14', { expected_date: '2026-10-28' }),
      row('u15', 'graphics_job', 'j15', { expected_date: '2026-10-29' }),
    ];
    const groups = groupArrivals(rows, links({ j14: 'est1', j15: 'est1' }));
    expect(groups.map(g => g.lead.id)).toEqual(['u14', 'u15']);
    expect(groups.every(g => g.shared.map(r => r.id).join() === 'so')).toBe(true);
  });

  it('sorts by arrival day with undated vans last', () => {
    const rows = [
      row('none', 'sales_order', 'e0'),
      row('late', 'sales_order', 'e1', { expected_date: '2026-11-03' }),
      row('soon', 'sales_order', 'e2', { expected_date: '2026-10-26' }),
    ];
    expect(groupArrivals(rows, links()).map(g => g.key)).toEqual(['soon', 'late', 'none']);
  });
});

describe('rowsToClose', () => {
  it('closes all of a van\'s rows', () => {
    const rows = [
      row('gfx', 'graphics_job', 'job1'),
      row('so', 'sales_order', 'est1'),
    ];
    const groups = groupArrivals(rows, links({ job1: 'est1' }));
    expect(rowsToClose(groups[0], groups).map(r => r.id).sort()).toEqual(['gfx', 'so']);
  });

  it('keeps a shared SO open until the last van of the estimate arrives', () => {
    const rows = [
      row('so', 'sales_order', 'est1'),
      row('u14', 'graphics_job', 'j14'),
      row('u15', 'graphics_job', 'j15'),
    ];
    const l = links({ j14: 'est1', j15: 'est1' });
    const groups = groupArrivals(rows, l);
    expect(rowsToClose(groups[0], groups).map(r => r.id)).toEqual(['u14']);
    // After U14 arrives, U15 is the last van on that SO.
    const left = groupArrivals(rows.filter(r => r.id !== 'u14'), l);
    expect(rowsToClose(left[0], left).map(r => r.id).sort()).toEqual(['so', 'u15']);
  });
});
