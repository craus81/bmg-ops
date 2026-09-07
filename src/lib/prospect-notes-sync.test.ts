import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ createNote: vi.fn() }));

import { pushProspectNotes } from './prospect-notes-sync';
import { createNote } from '@/lib/netsuite';

interface FakeState {
  activities: any[];
  profiles: { id: string; full_name: string | null }[];
  readError: boolean;
  stamps: { id: string; netsuite_note_id: string }[];
}

function makeState(): FakeState {
  return { activities: [], profiles: [], readError: false, stamps: [] };
}

/** Generic filter-applying fake: the recorded eq/is/in constraints run
 *  against the state rows, so the tests prove the QUERY's selection
 *  semantics (auto flag, stamp, email_log_id, type list), not a re-coded
 *  copy of them. */
function fakeClient(state: FakeState): any {
  return {
    from(table: string) {
      const q: any = { table, op: 'select', eqs: {} as Record<string, any>, iss: {} as Record<string, any>, ins: {} as Record<string, any[]> };
      const api: any = {
        select() { return api; },
        update(patch: any) { q.op = 'update'; q.patch = patch; return api; },
        eq(c: string, v: any) { q.eqs[c] = v; return api; },
        is(c: string, v: any) { q.iss[c] = v; return api; },
        in(c: string, v: any[]) { q.ins[c] = v; return api; },
        order() { return api; },
        limit(n: number) { q.limit = n; return api; },
        then(resolve: (v: any) => void) { resolve(respond(state, q)); },
      };
      return api;
    },
  };
}

function respond(state: FakeState, q: any): { data: any; error: any } {
  if (q.op === 'update' && q.table === 'prospect_activities') {
    state.stamps.push({ id: q.eqs.id, netsuite_note_id: q.patch.netsuite_note_id });
    return { data: null, error: null };
  }
  if (q.table === 'prospect_activities') {
    if (state.readError) return { data: null, error: { message: 'column prospect_activities.auto does not exist' } };
    let rows = [...state.activities];
    for (const [c, v] of Object.entries(q.eqs)) rows = rows.filter(r => r[c] === v);
    for (const [c, v] of Object.entries(q.iss)) rows = rows.filter(r => (v === null ? r[c] == null : r[c] === v));
    for (const [c, v] of Object.entries(q.ins)) rows = rows.filter(r => (v as any[]).includes(r[c]));
    rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (q.limit) rows = rows.slice(0, q.limit);
    return { data: rows, error: null };
  }
  if (q.table === 'profiles') {
    return { data: state.profiles.filter(p => (q.ins['id'] || []).includes(p.id)), error: null };
  }
  return { data: [], error: null };
}

const human = (id: string, over: Record<string, any> = {}) => ({
  id, prospect_id: 'p1', type: 'note', summary: `note ${id}`, details: null,
  created_by: 'u1', created_at: '2026-08-01T10:00:00Z',
  auto: false, netsuite_note_id: null, email_log_id: null,
  ...over,
});

describe('pushProspectNotes — CRM notes → NetSuite user notes', () => {
  let state: FakeState;
  beforeEach(() => {
    state = makeState();
    state.profiles = [{ id: 'u1', full_name: 'Craig George' }];
    vi.mocked(createNote).mockReset();
    vi.mocked(createNote).mockResolvedValue({ success: true, internalId: '9001' });
  });

  it('pushes only human, unsynced, non-email-log rows — oldest first — and stamps ids back', async () => {
    state.activities = [
      human('a2', { type: 'call', summary: 'second call', created_at: '2026-08-02T10:00:00Z' }),
      human('a1', { summary: 'first note', details: 'the fine print' }),
      human('x1', { auto: true, summary: 'Added contact: Bob' }),            // logAuto row
      human('x2', { email_log_id: 'log-1', type: 'email' }),                 // send log
      human('x3', { type: 'status_change' }),                                // app event type
      human('x4', { netsuite_note_id: '77' }),                               // already synced
    ];

    const r = await pushProspectNotes(fakeClient(state), 'p1', '123');
    expect(r).toEqual({ pushed: 2, failed: 0, remaining: 0 });
    expect(vi.mocked(createNote)).toHaveBeenCalledTimes(2);

    const first = vi.mocked(createNote).mock.calls[0][0];
    expect(first.entityId).toBe('123');
    expect(first.title).toContain('Note 2026-08-01');
    expect(first.note).toContain('first note');
    expect(first.note).toContain('the fine print');
    expect(first.note).toContain('Craig George');
    const second = vi.mocked(createNote).mock.calls[1][0];
    expect(second.title).toContain('Call 2026-08-02');

    expect(state.stamps).toEqual([
      { id: 'a1', netsuite_note_id: '9001' },
      { id: 'a2', netsuite_note_id: '9001' },
    ]);
  });

  it('counts refusals without stamping them, so a retry re-attempts', async () => {
    state.activities = [human('a1'), human('a2', { created_at: '2026-08-02T10:00:00Z' })];
    vi.mocked(createNote)
      .mockResolvedValueOnce({ success: false, error: 'NetSuite 403: no Notes permission' })
      .mockResolvedValueOnce({ success: true, internalId: '9002' });

    const r = await pushProspectNotes(fakeClient(state), 'p1', '123');
    expect(r).toEqual({ pushed: 1, failed: 1, remaining: 0 });
    expect(state.stamps).toEqual([{ id: 'a2', netsuite_note_id: '9002' }]);
  });

  it('stamps the created-id-unknown sentinel when NetSuite returns no id (never stamp falsy)', async () => {
    state.activities = [human('a1')];
    vi.mocked(createNote).mockResolvedValue({ success: true });

    const r = await pushProspectNotes(fakeClient(state), 'p1', '123');
    expect(r.pushed).toBe(1);
    expect(state.stamps).toEqual([{ id: 'a1', netsuite_note_id: 'created-id-unknown' }]);
  });

  it('degrades to a no-op when the read fails (post-268 schema-cache grace)', async () => {
    state.readError = true;
    state.activities = [human('a1')];

    const r = await pushProspectNotes(fakeClient(state), 'p1', '123');
    expect(r).toEqual({ pushed: 0, failed: 0, remaining: 0 });
    expect(vi.mocked(createNote)).not.toHaveBeenCalled();
  });

  it('caps one drain at 50 and reports the remainder', async () => {
    state.activities = Array.from({ length: 53 }, (_, i) =>
      human(`a${String(i).padStart(2, '0')}`, { created_at: `2026-08-01T10:${String(i).padStart(2, '0')}:00Z` }));

    const r = await pushProspectNotes(fakeClient(state), 'p1', '123');
    expect(r).toEqual({ pushed: 50, failed: 0, remaining: 3 });
    expect(vi.mocked(createNote)).toHaveBeenCalledTimes(50);
    expect(state.stamps).toHaveLength(50);
  });
});
