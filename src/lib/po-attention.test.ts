import { describe, it, expect } from 'vitest';
import { needsAttention, flagUpdate, clearedNoteBody, flaggedByLine, CLEAR_ATTENTION, ATTENTION_NOTE_MAX } from './po-attention';

const now = new Date('2026-10-21T14:12:00Z');

describe('po attention flag', () => {
  it('is set only when attention_at is', () => {
    expect(needsAttention(null)).toBe(false);
    expect(needsAttention({ attention_note: 'x' })).toBe(false);
    expect(needsAttention({ attention_at: now.toISOString() })).toBe(true);
  });

  it('flags with who and when, trimming the note', () => {
    expect(flagUpdate('  Missing part ', { id: 'u1', name: 'Valarie' }, null, now)).toEqual({
      attention_at: now.toISOString(), attention_note: 'Missing part', attention_by: 'u1', attention_by_name: 'Valarie',
    });
  });

  it('allows no note and caps a long one', () => {
    expect(flagUpdate('   ', { id: 'u1', name: 'V' }, null, now).attention_note).toBeNull();
    expect(flagUpdate('x'.repeat(500), { id: 'u1', name: 'V' }, null, now).attention_note).toHaveLength(ATTENTION_NOTE_MAX);
  });

  it('editing the note keeps the original flagger and time', () => {
    const existing = { attention_at: '2026-10-19T20:40:00Z', attention_note: 'old', attention_by: 'u0', attention_by_name: 'Craig' };
    expect(flagUpdate('new', { id: 'u1', name: 'Valarie' }, existing, now)).toEqual({ ...existing, attention_note: 'new' });
  });

  it('clears every field', () => {
    expect(Object.values(CLEAR_ATTENTION).every(v => v === null)).toBe(true);
  });

  it('writes a history note on Done', () => {
    expect(clearedNoteBody({ attention_note: 'Missing part', attention_by_name: 'Valarie' })).toBe('✓ Done: Missing part (flagged by Valarie)');
    expect(clearedNoteBody({})).toBe('✓ Done: cleared the needs-attention flag');
  });

  it('says who flagged it', () => {
    expect(flaggedByLine({})).toBe('');
    expect(flaggedByLine({ attention_at: now.toISOString(), attention_by_name: 'Valarie' })).toMatch(/^Flagged by Valarie · /);
    expect(flaggedByLine({ attention_at: now.toISOString() })).toMatch(/^Flagged by someone · /);
  });
});
