import { describe, it, expect } from 'vitest';
import { buildUsageReport, weightedPercentile, median, type ClientEventRow } from './client-events-report';

const row = (over: Partial<ClientEventRow> & { kind: string }): ClientEventRow => ({
  id: over.id || Math.random().toString(36).slice(2),
  page: '/tracking', form_id: null, detail: {}, role: 'admin', session_id: 's1', created_at: '2026-09-10T10:00:00Z',
  ...over,
});

describe('weightedPercentile', () => {
  it('weights sampled rows and refuses to guess under 5 samples', () => {
    expect(weightedPercentile([[100, 1], [200, 1]], 0.95)).toBeNull();
    // one page_timing row (weight 4) + one slow_page (weight 1) = 5 samples
    expect(weightedPercentile([[100, 4], [5000, 1]], 0.5)).toBe(100);
    expect(weightedPercentile([[100, 4], [5000, 1]], 0.95)).toBe(5000);
  });
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
  });
});

describe('buildUsageReport', () => {
  it('dedupes errors by masked message + page and counts sessions, not rows', () => {
    const r = buildUsageReport([
      row({ kind: 'error', detail: { message: 'boom', count: 3 }, session_id: 'a', created_at: '2026-09-10T10:00:00Z' }),
      row({ kind: 'error', detail: { message: 'boom', count: 1, stack: '/x.js:1:1' }, session_id: 'a', created_at: '2026-09-11T10:00:00Z' }),
      row({ kind: 'error', detail: { message: 'boom' }, session_id: 'b', role: null }),
      row({ kind: 'error', detail: { message: 'boom' }, page: '/estimates', session_id: 'b' }),
    ]);
    expect(r.errors).toHaveLength(2);
    const top = r.errors[0];
    expect(top.page).toBe('/tracking');
    expect(top.count).toBe(5);
    expect(top.sessions).toBe(2);
    expect(top.lastSeen).toBe('2026-09-11T10:00:00Z');
    expect(top.roles).toEqual(['admin', 'unknown']);
    expect(top.sampleStack).toBe('/x.js:1:1');
  });

  it('forms: three independent counts by distinct attempt, never a derived unknown', () => {
    const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const r = buildUsageReport([
      row({ kind: 'form_start', form_id: 'vehicle_checkin', detail: { attempt_id: a } }),
      row({ kind: 'form_start', form_id: 'vehicle_checkin', detail: { attempt_id: a } }), // beacon delivered twice
      row({ kind: 'form_submit', form_id: 'vehicle_checkin', detail: { attempt_id: a, seconds_open: 40 } }),
      row({ kind: 'form_abandon', form_id: 'vehicle_checkin', detail: { attempt_id: b, seconds_open: 12, exit: 'navigate', step: 1 } }),
      // a submit whose start beacon was lost: submitted > started is legal
      row({ kind: 'form_submit', form_id: 'booking', detail: { attempt_id: b, seconds_open: 9 } }),
    ]);
    const vc = r.forms.find(f => f.formId === 'vehicle_checkin')!;
    expect(vc).toMatchObject({ started: 1, submitted: 1, abandoned: 1, submitRatio: 1, medianSecondsSubmitted: 40, medianSecondsAbandoned: 12 });
    expect(vc.exits).toEqual({ navigate: 1 });
    expect(vc.lastStep).toEqual({ '1': 1 });
    expect(Object.keys(vc)).not.toContain('unknown');
    const bk = r.forms.find(f => f.formId === 'booking')!;
    expect(bk).toMatchObject({ started: 0, submitted: 1, submitRatio: null });
  });

  it('slow pages: weighted p50/p95, hard vs soft split, too-few-samples → null', () => {
    const rows: ClientEventRow[] = [
      row({ kind: 'page_timing', page: '/estimates', detail: { ms: 800, weight: 4, nav: 'hard' } }),
      row({ kind: 'slow_page', page: '/estimates', detail: { ms: 6000, weight: 1, nav: 'soft' } }),
    ];
    const r = buildUsageReport(rows);
    const all = r.slowPages.find(p => p.page === '/estimates' && p.nav === 'all')!;
    expect(all.samples).toBe(5);
    expect(all.p50).toBe(800);
    expect(all.p95).toBe(6000);
    expect(all.slowCount).toBe(1);
    const soft = r.slowPages.find(p => p.page === '/estimates' && p.nav === 'soft')!;
    expect(soft.p95).toBeNull(); // one sample is not a percentile
    expect(soft.max).toBe(6000);
  });

  it('slow api: failures = 5xx or network, per templated route + method', () => {
    const r = buildUsageReport([
      row({ kind: 'api_slow', detail: { route: '/api/estimates/:id', method: 'POST', ms: 5000, status: 200, failed: false }, session_id: 'a' }),
      row({ kind: 'api_slow', detail: { route: '/api/estimates/:id', method: 'POST', ms: 120, status: 502, failed: false }, session_id: 'b' }),
      row({ kind: 'api_slow', detail: { route: '/api/estimates/:id', method: 'POST', ms: 30, status: null, failed: true }, session_id: 'b' }),
      row({ kind: 'api_slow', detail: { route: '/api/estimates/:id', method: 'GET', ms: 4500, status: 200, failed: false } }),
    ]);
    const post = r.slowApi.find(a => a.method === 'POST')!;
    expect(post).toMatchObject({ route: '/api/estimates/:id', count: 3, sessions: 2, failures: 2, maxMs: 5000, p95: null });
    expect(r.slowApi[0]).toBe(post); // failures sort first
  });

  it('totals include queue overflow drops and distinct sessions', () => {
    const r = buildUsageReport([
      row({ kind: 'queue_overflow', detail: { dropped: 7 }, session_id: 'a' }),
      row({ kind: 'queue_overflow', detail: { dropped: 2 }, session_id: 'b' }),
    ]);
    expect(r.totals).toEqual({ rows: 2, sessions: 2, byKind: { queue_overflow: 2 }, queueDropped: 9 });
  });
});
