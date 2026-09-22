import { describe, it, expect } from 'vitest';
import { readableEntry, formatValue, labelFor } from './audit-readable';

describe('formatValue', () => {
  it('distinguishes empty from absent by saying (empty) for both, visibly', () => {
    expect(formatValue(null)).toBe('(empty)');
    expect(formatValue(undefined)).toBe('(empty)');
    expect(formatValue('')).toBe('(empty)');
    expect(formatValue('   ')).toBe('(empty)');
  });
  it('renders booleans as yes/no rather than true/false', () => {
    expect(formatValue(true)).toBe('yes');
    expect(formatValue(false)).toBe('no');
  });
  it('keeps zero as zero, not as empty', () => {
    // 0 is a real value — labor hours of 0 means "no labor", and rendering
    // it as (empty) would say the field was never set.
    expect(formatValue(0)).toBe('0');
  });
  it('renders an ISO instant as a readable date', () => {
    expect(formatValue('2026-09-12T15:04:00Z')).toMatch(/Sep/);
  });
  it('leaves a non-date string alone', () => {
    expect(formatValue('quoted')).toBe('quoted');
  });
  it('truncates a very long value instead of flooding the line', () => {
    const out = formatValue('x'.repeat(500));
    expect(out.length).toBeLessThan(140);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('labelFor', () => {
  it('uses the human label when there is one', () => {
    expect(labelFor('grand_total')).toEqual({ label: 'total', raw: false });
  });
  it('shows an unlabelled column rather than hiding the change', () => {
    // Dropping it would make the history quietly incomplete.
    expect(labelFor('some_new_column')).toEqual({ label: 'some new column', raw: true });
  });
});

describe('readableEntry', () => {
  it('reads a single-field update as a sentence', () => {
    const e = readableEntry('row_update', { changed: { status: { from: 'quoted', to: 'approved' } } }, 'Dana');
    expect(e.kind).toBe('update');
    expect(e.summary).toBe('Dana changed status');
    expect(e.changes).toEqual([{ field: 'status', label: 'status', from: 'quoted', to: 'approved', raw: false }]);
  });

  it('counts the rest when several fields moved', () => {
    const e = readableEntry('row_update', {
      changed: { status: { from: 'a', to: 'b' }, title: { from: 'x', to: 'y' }, notes: { from: null, to: 'hi' } },
    }, 'Dana');
    expect(e.summary).toBe('Dana changed status and 2 other fields');
    expect(e.changes).toHaveLength(3);
  });

  it('says System when nobody is attributed, rather than inventing a name', () => {
    const e = readableEntry('row_update', { changed: { status: { from: 'a', to: 'b' } } }, null);
    expect(e.summary).toBe('System changed status');
  });

  it('handles a delete', () => {
    expect(readableEntry('row_delete', { deleted: { id: '1' } }, 'Dana').summary).toBe('Dana deleted this record');
  });

  it('does NOT paraphrase an unfamiliar hand-written action', () => {
    // Guessing at an arbitrary detail blob and printing a confident
    // sentence is how a history starts lying.
    const e = readableEntry('estimate_below_floor_sent', { marginPct: 12, floorPct: 20 }, 'Dana');
    expect(e.kind).toBe('action');
    expect(e.summary).toBe('Dana — estimate below floor sent');
    expect(e.fallback).toContain('marginPct');
  });

  it('survives a detail that is not an object', () => {
    expect(readableEntry('row_update', 'nope', 'Dana').kind).toBe('action');
    expect(readableEntry('something', null, null).summary).toBe('System — something');
  });

  it('says so when an update recorded no fields', () => {
    const e = readableEntry('row_update', { changed: {} }, 'Dana');
    expect(e.summary).toContain('no field changes recorded');
  });
});
