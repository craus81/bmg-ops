import { describe, it, expect } from 'vitest';
import { lastTouchOf, daysSince, touchLabel, QUIET_DAYS, loadQuietLeads } from './quiet-leads';

const NOW = Date.parse('2026-09-11T12:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('lastTouchOf', () => {
  it('prefers a logged activity — that is what a touch IS', () => {
    const t = lastTouchOf(
      { updated_at: ago(1), created_at: ago(200) },
      { prospect_id: 'p', summary: 'Called Dana', created_at: ago(40) },
    );
    expect(t).toEqual({ at: ago(40), source: 'activity', summary: 'Called Dana' });
  });

  it('falls back to the record edit and SAYS so — an edit is not contact', () => {
    const t = lastTouchOf({ updated_at: ago(3), created_at: ago(200) }, null);
    expect(t.source).toBe('record_updated');
    expect(t.at).toBe(ago(3));
  });

  it('falls back again to creation when the record was never edited', () => {
    expect(lastTouchOf({ created_at: ago(90) }).source).toBe('created');
  });

  it('is unknown rather than now when the record carries no dates at all', () => {
    expect(lastTouchOf({})).toEqual({ at: null, source: 'unknown', summary: null });
  });
});

describe('daysSince', () => {
  it('counts whole days', () => {
    expect(daysSince(ago(45), NOW)).toBe(45);
  });
  it('is null, not 0, with nothing to measure — an unmeasured lead is not a fresh one', () => {
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince('nonsense', NOW)).toBeNull();
  });
});

describe('touchLabel', () => {
  it('quotes the activity when one dated the row', () => {
    expect(touchLabel({ at: ago(5), source: 'activity', summary: 'Emailed pricing' }))
      .toBe('Last touch: Emailed pricing');
  });

  it('never lets a record edit read as contact', () => {
    expect(touchLabel({ at: ago(5), source: 'record_updated', summary: null }))
      .toMatch(/No contact ever logged/);
    expect(touchLabel({ at: ago(5), source: 'created', summary: null }))
      .toMatch(/No contact ever logged/);
  });

  it('says nothing is on record when nothing is', () => {
    expect(touchLabel({ at: null, source: 'unknown', summary: null })).toBe('No date on record');
  });
});

describe('QUIET_DAYS', () => {
  it('matches the dashboard tile it replaces, so the count and the queue agree', () => {
    expect(QUIET_DAYS).toBe(30);
  });
});

/**
 * A Supabase stand-in that really applies the filters the query builds, so
 * these tests fail if the `auto` filter is dropped rather than merely
 * asserting the call was made.
 */
function fakeService(tables: Record<string, any[]>, failOn?: string) {
  const build = (table: string) => {
    let rows = [...(tables[table] || [])];
    // PostgREST treats each extra .order() as a TIEBREAKER, not a re-sort —
    // collect the keys and compare in order, or a test can pass for the
    // wrong reason.
    const keys: Array<[string, number]> = [];
    const sorted = () => [...rows].sort((a, b) => {
      for (const [c, dir] of keys) {
        const x = String(a[c] ?? ''), y = String(b[c] ?? '');
        if (x !== y) return (x < y ? -1 : 1) * dir;
      }
      return 0;
    });
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { rows = rows.filter(r => r[c] === v); return q; },
      neq: (c: string, v: any) => { rows = rows.filter(r => r[c] !== v); return q; },
      gte: (c: string, v: any) => { rows = rows.filter(r => String(r[c]) >= String(v)); return q; },
      is: (c: string, v: any) => { rows = rows.filter(r => (r[c] ?? null) === v); return q; },
      in: (c: string, vs: any[]) => { rows = rows.filter(r => vs.includes(r[c])); return q; },
      order: (c: string, o?: { ascending?: boolean }) => { keys.push([c, o?.ascending === false ? -1 : 1]); return q; },
      range: (from: number, to: number) => Promise.resolve(
        table === failOn
          ? { data: null, error: { message: 'connection reset' } }
          : { data: sorted().slice(from, to + 1), error: null },
      ),
      then: (res: any) => Promise.resolve({ data: sorted(), error: null }).then(res),
    };
    return q;
  };
  return { from: build } as any;
}

const lead = (id: string, over: Record<string, any> = {}) => ({
  id, company_name: `Co ${id}`, status: 'active', is_hot: false, created_by: null,
  created_at: ago(400), updated_at: ago(400), netsuite_id: null, record_type: 'prospect', ...over,
});
const act = (id: string, prospect_id: string, days: number, over: Record<string, any> = {}) => ({
  id, prospect_id, summary: 'Called about the wrap', created_at: ago(days), auto: false, ...over,
});

describe('loadQuietLeads — an app-logged row is not a touch', () => {
  it('a lead whose only recent activity is auto stays in the queue', async () => {
    // Nobody has called Acme in 90 days; yesterday someone added a contact,
    // which logAuto recorded. Before the `auto` filter this row vanished.
    const svc = fakeService({
      prospects: [lead('p1')],
      prospect_activities: [
        act('a1', 'p1', 90),
        act('a2', 'p1', 1, { auto: true, summary: 'Added to NetSuite as customer #4821' }),
      ],
      estimates: [],
    });
    const leads = await loadQuietLeads(svc, { now: NOW });
    expect(leads.map(l => l.id)).toEqual(['p1']);
    expect(leads[0].daysQuiet).toBe(90);
  });

  it('quotes the human touch, never the app event, as the last touch', async () => {
    const svc = fakeService({
      prospects: [lead('p1')],
      prospect_activities: [
        act('a1', 'p1', 90),
        act('a2', 'p1', 40, { auto: true, summary: 'Added to the email-campaign list' }),
      ],
      estimates: [],
    });
    const [row] = await loadQuietLeads(svc, { now: NOW });
    expect(row.lastTouch.source).toBe('activity');
    expect(row.lastTouch.summary).toBe('Called about the wrap');
    expect(touchLabel(row.lastTouch)).toBe('Last touch: Called about the wrap');
  });

  it('a real recent touch still takes the lead OUT of the queue', async () => {
    const svc = fakeService({
      prospects: [lead('p1')],
      prospect_activities: [act('a1', 'p1', 3)],
      estimates: [],
    });
    expect(await loadQuietLeads(svc, { now: NOW })).toEqual([]);
  });

  it('a failed activity read throws instead of reporting every lead as quiet', async () => {
    // The dangerous shape: swallowing the error leaves `touchedRecently`
    // empty, so leads someone spoke to yesterday all read as untouched.
    const svc = fakeService({
      prospects: [lead('p1'), lead('p2')],
      prospect_activities: [act('a1', 'p1', 1)],
      estimates: [],
    }, 'prospect_activities');
    await expect(loadQuietLeads(svc, { now: NOW })).rejects.toThrow(/connection reset/);
  });
});
