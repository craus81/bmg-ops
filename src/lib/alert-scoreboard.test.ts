import { describe, it, expect } from 'vitest';
import { bulkReadKeys, scoreRows, BULK_THRESHOLD } from './alert-scoreboard';

const at = (min: number) => new Date(Date.parse('2026-09-12T09:00:00Z') + min * 60_000).toISOString();

describe('bulkReadKeys', () => {
  it('flags a group at the threshold', () => {
    const rows = Array.from({ length: BULK_THRESHOLD }, () => ({ user_id: 'u1', read_at: at(10) }));
    expect(bulkReadKeys(rows).has(`u1|${at(10)}`)).toBe(true);
  });
  it('leaves a group below the threshold alone', () => {
    const rows = Array.from({ length: BULK_THRESHOLD - 1 }, () => ({ user_id: 'u1', read_at: at(10) }));
    expect(bulkReadKeys(rows).size).toBe(0);
  });
  it('does not merge two different people who happened to read at the same instant', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => ({ user_id: 'u1', read_at: at(10) })),
      ...Array.from({ length: 3 }, () => ({ user_id: 'u2', read_at: at(10) })),
    ];
    expect(bulkReadKeys(rows).size).toBe(0);
  });
  it('ignores unread rows', () => {
    expect(bulkReadKeys([{ user_id: 'u1', read_at: null }]).size).toBe(0);
  });
});

describe('scoreRows', () => {
  it('counts a genuine read and its latency', () => {
    const [row] = scoreRows([
      { user_id: 'u1', type: 'quote_followup', created_at: at(0), read_at: at(30) },
    ]);
    expect(row.sent).toBe(1);
    expect(row.read).toBe(1);
    expect(row.bulkCleared).toBe(0);
    expect(row.medianMinutesToRead).toBe(30);
    expect(row.ignoredRate).toBe(0);
  });

  it('counts a mark-all-read as cleared, not read', () => {
    const rows = Array.from({ length: BULK_THRESHOLD }, () => ({
      user_id: 'u1', type: 'graphics_status', created_at: at(0), read_at: at(5),
    }));
    const [row] = scoreRows(rows);
    expect(row.read).toBe(0);
    expect(row.bulkCleared).toBe(BULK_THRESHOLD);
    // Cleared in bulk counts as ignored — that is the whole point of the report.
    expect(row.ignoredRate).toBe(1);
    // And a bulk clear contributes no latency, so the median stays unknown.
    expect(row.medianMinutesToRead).toBeNull();
  });

  it('reports an unread median as null rather than zero', () => {
    const [row] = scoreRows([
      { user_id: 'u1', type: 'proof_stale', created_at: at(0), read_at: null },
    ]);
    expect(row.medianMinutesToRead).toBeNull();
    expect(row.unread).toBe(1);
    expect(row.ignoredRate).toBe(1);
  });

  it('discards a negative latency instead of scoring it as instant', () => {
    // read_at before created_at is bad data, and averaging it in would
    // flatter every median it touches.
    const [row] = scoreRows([
      { user_id: 'u1', type: 'proof_sent', created_at: at(10), read_at: at(0) },
    ]);
    expect(row.read).toBe(1);
    expect(row.medianMinutesToRead).toBeNull();
  });

  it('names an unregistered type instead of hiding it', () => {
    const [row] = scoreRows([
      { user_id: 'u1', type: 'mystery_alert', created_at: at(0), read_at: null },
    ]);
    expect(row.unregistered).toBe(true);
    expect(row.label).toBe('mystery_alert');
    expect(row.areaLabel).toBe('Unrecognised');
  });

  it('resolves a registered type to its registry label', () => {
    const [row] = scoreRows([
      { user_id: 'u1', type: 'quote_followup', created_at: at(0), read_at: null },
    ]);
    expect(row.unregistered).toBe(false);
    expect(row.label).toBe('Quote needs a follow-up');
  });

  it('ranks a high-volume ignored type above a tiny one that is also ignored', () => {
    const many = Array.from({ length: 40 }, () => ({ user_id: 'u1', type: 'noisy', created_at: at(0), read_at: null }));
    const few = [{ user_id: 'u1', type: 'rare', created_at: at(0), read_at: null }];
    expect(scoreRows([...few, ...many])[0].type).toBe('noisy');
  });

  it('takes the middle value for an even number of reads', () => {
    const [row] = scoreRows([
      { user_id: 'a', type: 't', created_at: at(0), read_at: at(10) },
      { user_id: 'b', type: 't', created_at: at(0), read_at: at(20) },
    ]);
    expect(row.medianMinutesToRead).toBe(15);
  });
});
