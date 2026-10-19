import { describe, expect, it } from 'vitest';
import { compareUnits, currentMembers, unitKey, worksheetFilter } from './estimate-fleet';

const row = (id: string, unit: string | null, supersedes: string | null = null) => ({
  id, estimate_number: `EST-${id}`, unit_number: unit, vin: null, status: 'draft',
  customer_approved: false, netsuite_so_id: null, netsuite_so_number: null, grand_total: 100,
  supersedes_estimate_id: supersedes, created_at: '2026-10-19',
});

describe('fleet groups', () => {
  it('sorts unit numbers naturally', () => {
    expect(['10', '9', '101', 'A2'].sort(compareUnits)).toEqual(['9', '10', '101', 'A2']);
  });

  it('compares unit numbers without case or spaces', () => {
    expect(unitKey(' Unit 7 ')).toBe(unitKey('unit 7'));
  });

  it('shows each vehicle once: a revision replaces the estimate it supersedes', () => {
    const members = currentMembers([row('a', '102'), row('b', '101'), row('c', '102', 'a')] as any);
    expect(members.map(m => m.id)).toEqual(['b', 'c']);
    expect((members[0] as any).supersedes_estimate_id).toBeUndefined();
  });

  it('adds shared worksheets to the pinned ones', () => {
    expect(worksheetFilter('e1', [])).toBe('estimate_id.eq.e1');
    expect(worksheetFilter('e1', ['q1', 'q2'])).toBe('estimate_id.eq.e1,id.in.(q1,q2)');
  });
});
