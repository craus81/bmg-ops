// The words Books → Backups shows for each backup: its size, how long it
// ran and what it holds (src/lib/books/backup-words.ts).
import { describe, it, expect } from 'vitest';
import { BACKUPS_LISTED, fileSize, holdsWords, tookWords } from './backup-words';
import { BACKUPS_LISTED as LISTED_BY_THE_RUN } from './backups';

describe('Books → Backups words', () => {
  it('says a size in bytes, KB or MB', () => {
    expect(fileSize(1)).toBe('1 byte');
    expect(fileSize(900)).toBe('900 bytes');
    expect(fileSize(1024)).toBe('1 KB');
    expect(fileSize(48_213)).toBe('47 KB');
    expect(fileSize(1024 * 1024 - 1)).toBe('1024 KB');
    expect(fileSize(1024 * 1024)).toBe('1.0 MB');
    expect(fileSize(3_500_000)).toBe('3.3 MB');
  });

  it('says how long a backup ran, in seconds and then minutes', () => {
    expect(tookWords('2026-11-03T08:11:00Z', '2026-11-03T08:11:01Z')).toBe('1 second');
    expect(tookWords('2026-11-03T08:11:00Z', '2026-11-03T08:11:48.4Z')).toBe('48 seconds');
    expect(tookWords('2026-11-03T08:11:00Z', '2026-11-03T08:12:00Z')).toBe('1 minute');
    expect(tookWords('2026-11-03T08:11:00Z', '2026-11-03T08:13:05Z')).toBe('2 minutes 5 seconds');
    expect(tookWords('2026-11-03T08:11:00Z', '2026-11-03T08:10:00Z')).toBe('0 seconds');
  });

  it('says what a backup holds, leaving out what a failed one never counted', () => {
    expect(holdsWords({ bytes: 1_258_291, tables: 90, rows: 41_200, entries: 3_100, lines: 9_800 }))
      .toBe('1.2 MB · 90 tables · 41,200 rows · 3,100 entries · 9,800 lines');
    expect(holdsWords({ bytes: null, tables: 1, rows: 1, entries: 1, lines: 0 })).toBe('1 table · 1 row · 1 entry · 0 lines');
    expect(holdsWords({ bytes: null, tables: null, rows: null, entries: null, lines: null })).toBe('');
  });

  it('lists the same number of backups the run reads', () => {
    expect(BACKUPS_LISTED).toBe(60);
    expect(LISTED_BY_THE_RUN).toBe(BACKUPS_LISTED);
  });
});
