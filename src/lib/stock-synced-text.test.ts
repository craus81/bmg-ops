import { describe, it, expect } from 'vitest';
import { syncedText } from './stock-synced-text';

describe('syncedText', () => {
  it('says when the time is unknown', () => {
    expect(syncedText(null)).toBe('Last sync time unknown');
    expect(syncedText('not a date')).toBe('Last sync time unknown');
  });
  it('shows only the time for a sync today', () => {
    const now = new Date(2026, 9, 30, 15, 0);
    const out = syncedText(new Date(2026, 9, 30, 14, 14).toISOString(), now);
    expect(out.startsWith('Last sync ')).toBe(true);
    expect(out).toMatch(/2:14/);
    expect(out).not.toMatch(/Oct/);
  });
  it('adds the date for an older sync', () => {
    const now = new Date(2026, 9, 31, 9, 0);
    expect(syncedText(new Date(2026, 9, 30, 14, 14).toISOString(), now)).toMatch(/Oct 30/);
  });
});
