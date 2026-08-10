import { describe, it, expect } from 'vitest';
import { classifySoMatch } from './sales-order-sync';

// SO→estimate matching is the whole point of N3 — pin the precedence and,
// critically, the otherrefnum guard: that field is free text where customer
// PO numbers also live, and a loose match would attach an SO to the wrong
// estimate (the roadmap's named risk).
describe('classifySoMatch', () => {
  it('createdfrom wins over everything', () => {
    expect(classifySoMatch({ createdfrom: '12345', otherrefnum: 'EST-2608-041', memo: 'FleetSuite Estimate #EST-2608-042' }))
      .toEqual({ source: 'createdfrom', nsEstimateId: '12345' });
  });

  it('otherrefnum matches estimate-number shapes, old and new', () => {
    expect(classifySoMatch({ otherrefnum: 'EST-2608-041' }))
      .toEqual({ source: 'otherrefnum', estimateNumber: 'EST-2608-041' });
    expect(classifySoMatch({ otherrefnum: 'est-2608-k3qx' }))
      .toEqual({ source: 'otherrefnum', estimateNumber: 'EST-2608-K3QX' });
  });

  it('otherrefnum REFUSES customer PO numbers (the collision risk)', () => {
    expect(classifySoMatch({ otherrefnum: '4500012345' })).toBeNull();
    expect(classifySoMatch({ otherrefnum: 'PO-88123' })).toBeNull();
    expect(classifySoMatch({ otherrefnum: 'ESTIMATE 41' })).toBeNull();
  });

  it('memo is the weakest signal, only when nothing stronger exists', () => {
    expect(classifySoMatch({ memo: 'Fleet Upfit\nFleetSuite Estimate #EST-2608-041' }))
      .toEqual({ source: 'memo', estimateNumber: 'EST-2608-041' });
    expect(classifySoMatch({ otherrefnum: 'EST-2608-040', memo: 'FleetSuite Estimate #EST-2608-041' }))
      .toEqual({ source: 'otherrefnum', estimateNumber: 'EST-2608-040' });
  });

  it('non-numeric createdfrom falls through instead of matching garbage', () => {
    expect(classifySoMatch({ createdfrom: 'Estimate #EST-1', otherrefnum: 'EST-2608-041' }))
      .toEqual({ source: 'otherrefnum', estimateNumber: 'EST-2608-041' });
  });

  it('returns null when no key matches', () => {
    expect(classifySoMatch({})).toBeNull();
    expect(classifySoMatch({ memo: 'rush job for Acme' })).toBeNull();
  });
});
