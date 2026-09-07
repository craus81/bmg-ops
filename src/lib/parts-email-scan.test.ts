import { describe, it, expect, vi, beforeEach } from 'vitest';

// applyEmailToPo's module pulls the whole scan pipeline; stub the heavy
// mailbox/AI/storage deps and the notifier so the ETA-propagation logic
// under test runs against a plain fake Supabase client.
vi.mock('@/lib/google-dwd', () => ({
  dwdConfigured: () => false,
  getDelegatedGmail: vi.fn(),
  getMessagePlainText: vi.fn(),
  getHeader: vi.fn(),
}));
vi.mock('@/lib/google', () => ({ getPdfAttachments: vi.fn() }));
vi.mock('@/lib/anthropic', () => ({ callAnthropicWithRetry: vi.fn() }));
vi.mock('@/lib/r2', () => ({ r2Upload: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notifyMany: vi.fn(async () => ({})) }));

import { applyEmailToPo, type MatchedPo } from './parts-email-scan';
import { notifyMany } from '@/lib/notify';

/**
 * Fake PostgREST client covering exactly the queries applyEmailToPo makes.
 * State is plain rows; writes are recorded for assertions.
 */
interface FakeState {
  /** upfit_project_pos rows */
  links: { project_id: string; po_id: string }[];
  /** upfit_projects rows */
  projects: {
    id: string; project_name: string | null; netsuite_vendor_po_number: string | null;
    parts_eta: string | null; assigned_to: string | null; created_by: string | null;
  }[];
  /** netsuite_vendor_pos rows the joins embed */
  pos: { id: string; eta_date: string | null; status: string | null }[];
  /** purchase_requests rows (for the notify fan-out read) */
  requests: { id: string; requested_by: string | null; source_project_id: string | null; ordered_po_id: string }[];
  writes: {
    poUpdates: any[];
    projUpdates: { id: string; patch: any }[];
    notes: any[];
  };
}

function makeState(): FakeState {
  return { links: [], projects: [], pos: [], requests: [], writes: { poUpdates: [], projUpdates: [], notes: [] } };
}

function fakeClient(state: FakeState): any {
  return {
    from(table: string) {
      const q: any = { table, filters: {} as Record<string, any>, select: '', op: 'select' };
      const api: any = {
        select(cols: string) { q.select = cols; return api; },
        update(patch: any) { q.op = 'update'; q.patch = patch; return api; },
        insert(row: any) { q.op = 'insert'; q.patch = row; return api; },
        eq(col: string, val: any) { q.filters[col] = val; return api; },
        in(col: string, vals: any[]) { q.filters[`in:${col}`] = vals; return api; },
        not() { return api; },
        order() { return api; },
        ilike() { return api; },
        limit() { return api; },
        range(from: number) { q.rangeFrom = from; return api; },
        maybeSingle() { q.single = true; return api; },
        then(resolve: (v: any) => void) { resolve(respond(state, q)); },
      };
      return api;
    },
  };
}

function respond(state: FakeState, q: any): { data: any; error: null } {
  if (q.op === 'update') {
    if (q.table === 'netsuite_vendor_pos') state.writes.poUpdates.push(q.patch);
    if (q.table === 'upfit_projects') state.writes.projUpdates.push({ id: q.filters.id, patch: q.patch });
    return { data: null, error: null };
  }
  if (q.op === 'insert') {
    if (q.table === 'upfit_project_notes') state.writes.notes.push(q.patch);
    return { data: null, error: null };
  }
  if (q.table === 'upfit_project_pos') {
    if (q.filters.po_id) {
      return { data: state.links.filter(l => l.po_id === q.filters.po_id).map(l => ({ project_id: l.project_id })), error: null };
    }
    const ids: string[] = q.filters['in:project_id'] || [];
    const rows = state.links.filter(l => ids.includes(l.project_id));
    if (q.select.includes('po:')) {
      return {
        data: rows.map(l => ({ project_id: l.project_id, po: state.pos.find(p => p.id === l.po_id) || null })),
        error: null,
      };
    }
    return { data: rows.map(l => ({ project_id: l.project_id })), error: null };
  }
  if (q.table === 'upfit_projects') {
    if (q.filters['in:id']) {
      return { data: state.projects.filter(p => (q.filters['in:id'] as string[]).includes(p.id)), error: null };
    }
    // The paginated scalar scan — return everything on the first page.
    return { data: q.rangeFrom > 0 ? [] : state.projects.filter(p => p.netsuite_vendor_po_number != null), error: null };
  }
  if (q.table === 'purchase_requests') {
    return { data: state.requests.filter(r => r.ordered_po_id === q.filters.ordered_po_id), error: null };
  }
  return { data: [], error: null };
}

const PO1: MatchedPo = { id: 'po-1', tranid: 'PO376', vendor_name: 'Ranger Design', eta_date: '2026-10-01', tracking_number: null };
const email = (eta: string | null) => ({
  vendor_name: 'Ranger Design', po_number: 'PO376', ship_date: null,
  eta_date: eta, tracking_number: null, carrier: null,
});

describe('applyEmailToPo — multi-PO ETA propagation (migration 267)', () => {
  let state: FakeState;
  beforeEach(() => {
    state = makeState();
    vi.mocked(notifyMany).mockClear();
  });

  it('updates a join-linked project to the new ETA and pings its people', async () => {
    state.links = [{ project_id: 'p1', po_id: 'po-1' }];
    state.projects = [{ id: 'p1', project_name: 'Van 12', netsuite_vendor_po_number: null, parts_eta: '2026-10-01', assigned_to: 'u-a', created_by: 'u-b' }];
    state.pos = [{ id: 'po-1', eta_date: '2026-10-01', status: 'B' }];

    const result = await applyEmailToPo(fakeClient(state), email('2026-10-05') as any, PO1, 'test');
    expect(result).toBe('applied');
    expect(state.writes.projUpdates).toEqual([{ id: 'p1', patch: { parts_eta: '2026-10-05' } }]);
    expect(state.writes.notes).toHaveLength(1);
    expect(state.writes.notes[0].content).toContain('PO376');
    expect(state.writes.notes[0].content).toContain('2026-10-05');
    expect(vi.mocked(notifyMany)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyMany).mock.calls[0][0].sort()).toEqual(['u-a', 'u-b']);
  });

  it('keeps the project ETA at the latest OPEN linked PO when another PO gates', async () => {
    state.links = [{ project_id: 'p1', po_id: 'po-1' }, { project_id: 'p1', po_id: 'po-2' }];
    state.projects = [{ id: 'p1', project_name: 'Van 12', netsuite_vendor_po_number: null, parts_eta: '2026-10-10', assigned_to: 'u-a', created_by: null }];
    state.pos = [
      { id: 'po-1', eta_date: '2026-10-01', status: 'B' },
      { id: 'po-2', eta_date: '2026-10-10', status: 'B' },
    ];

    await applyEmailToPo(fakeClient(state), email('2026-10-05') as any, PO1, 'test');
    // parts_eta already 2026-10-10 (PO #2 gates) — no write, but the PO
    // moved, so the note and the ping still happen.
    expect(state.writes.projUpdates).toEqual([]);
    expect(state.writes.notes).toHaveLength(1);
    expect(state.writes.notes[0].content).toContain('project waits for 2026-10-10');
    expect(vi.mocked(notifyMany)).toHaveBeenCalledTimes(1);
  });

  it('ignores closed POs when computing the project ETA', async () => {
    state.links = [{ project_id: 'p1', po_id: 'po-1' }, { project_id: 'p1', po_id: 'po-2' }];
    state.projects = [{ id: 'p1', project_name: null, netsuite_vendor_po_number: null, parts_eta: '2026-12-01', assigned_to: null, created_by: null }];
    state.pos = [
      { id: 'po-1', eta_date: '2026-10-01', status: 'B' },
      { id: 'po-2', eta_date: '2026-12-01', status: 'F' }, // Fully Billed — done
    ];

    await applyEmailToPo(fakeClient(state), email('2026-10-05') as any, PO1, 'test');
    expect(state.writes.projUpdates).toEqual([{ id: 'p1', patch: { parts_eta: '2026-10-05' } }]);
  });

  it('falls back to the scalar first-PO match for projects with no join rows', async () => {
    state.projects = [{ id: 'p2', project_name: 'Truck 4', netsuite_vendor_po_number: 'PO-376', parts_eta: null, assigned_to: null, created_by: null }];

    await applyEmailToPo(fakeClient(state), email('2026-10-05') as any, PO1, 'test');
    expect(state.writes.projUpdates).toEqual([{ id: 'p2', patch: { parts_eta: '2026-10-05' } }]);
  });

  it('drops a stale scalar match when the project has join rows to other POs', async () => {
    // p3's scalar still names PO376, but its join rows say only po-9 —
    // e.g. staff deliberately unlinked PO376. The join table governs.
    state.links = [{ project_id: 'p3', po_id: 'po-9' }];
    state.projects = [{ id: 'p3', project_name: null, netsuite_vendor_po_number: 'PO376', parts_eta: null, assigned_to: null, created_by: null }];
    state.pos = [{ id: 'po-9', eta_date: null, status: 'B' }];

    await applyEmailToPo(fakeClient(state), email('2026-10-05') as any, PO1, 'test');
    expect(state.writes.projUpdates).toEqual([]);
    expect(state.writes.notes).toEqual([]);
    expect(vi.mocked(notifyMany)).not.toHaveBeenCalled();
  });

  it('writes and pings nothing when a vendor re-sends an already-reflected date', async () => {
    state.links = [{ project_id: 'p1', po_id: 'po-1' }];
    state.projects = [{ id: 'p1', project_name: null, netsuite_vendor_po_number: null, parts_eta: '2026-10-01', assigned_to: 'u-a', created_by: null }];
    state.pos = [{ id: 'po-1', eta_date: '2026-10-01', status: 'B' }];

    // Same date the PO already carries: etaChanged is false.
    const result = await applyEmailToPo(fakeClient(state), email('2026-10-01') as any, PO1, 'test');
    expect(result).toBe('applied'); // the PO row itself is still refreshed
    expect(state.writes.projUpdates).toEqual([]);
    expect(state.writes.notes).toEqual([]);
    expect(vi.mocked(notifyMany)).not.toHaveBeenCalled();
  });
});
