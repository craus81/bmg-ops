import { describe, it, expect } from 'vitest';
import { groupDigests, digestSubject, type DigestQueueRow } from './staff-email-digest';

const row = (over: Partial<DigestQueueRow>): DigestQueueRow => ({
  id: 'r', user_id: 'u1', type: 'vehicle_complete', title: 'T', body: null, url: '/v/1',
  created_at: '2026-09-28T15:00:00Z', ...over,
});

describe('groupDigests', () => {
  it('makes one digest per person, items oldest first', () => {
    const out = groupDigests([
      row({ id: 'b', title: 'Second', created_at: '2026-09-28T16:00:00Z' }),
      row({ id: 'a', title: 'First', created_at: '2026-09-28T14:00:00Z' }),
      row({ id: 'c', user_id: 'u2', title: 'Other' }),
    ]);
    expect(out).toHaveLength(2);
    const u1 = out.find(d => d.userId === 'u1')!;
    expect(u1.items.map(i => i.title)).toEqual(['First', 'Second']);
    expect(u1.rowIds).toEqual(['a', 'b']);
  });

  it('collapses exact repeats but still marks every row', () => {
    const out = groupDigests([
      row({ id: 'a', title: 'Same', url: '/x' }),
      row({ id: 'b', title: 'Same', url: '/x', created_at: '2026-09-28T16:00:00Z' }),
      row({ id: 'c', title: 'Same', url: '/y', created_at: '2026-09-28T17:00:00Z' }),
    ]);
    expect(out[0].items).toHaveLength(2);
    expect(out[0].rowIds).toEqual(['a', 'b', 'c']);
  });
});

describe('digestSubject', () => {
  it('pluralizes', () => {
    expect(digestSubject(1)).toBe("[BMG Fleet] Today's alerts: 1 update");
    expect(digestSubject(3)).toBe("[BMG Fleet] Today's alerts: 3 updates");
  });
});
