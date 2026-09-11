import { describe, it, expect } from 'vitest';
import { lastTouchOf, daysSince, touchLabel, QUIET_DAYS } from './quiet-leads';

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
