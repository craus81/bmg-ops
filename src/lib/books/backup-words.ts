import type { BackupRecord } from './backups';

/**
 * Words and numbers Books → Backups shows (src/app/(main)/admin/books/backups),
 * apart from src/lib/books/backups.ts so the page doesn't carry the server's
 * code. docs/books.md "Backups".
 */

/** Backups the page lists, newest first. */
export const BACKUPS_LISTED = 60;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** 900 → "900 bytes", 48_213 → "47 KB", 3_500_000 → "3.3 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return plural(bytes, 'byte', 'bytes');
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How long a backup ran: "48 seconds", "2 minutes 5 seconds". */
export function tookWords(startedAt: string, finishedAt: string): string {
  const seconds = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return plural(seconds, 'second', 'seconds');
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${plural(minutes, 'minute', 'minutes')}${rest ? ` ${plural(rest, 'second', 'seconds')}` : ''}`;
}

/** What a backup holds, in one line: "1.2 MB · 90 tables · 41,200 rows · 3,100 entries · 9,800 lines". */
export function holdsWords(b: Pick<BackupRecord, 'bytes' | 'tables' | 'rows' | 'entries' | 'lines'>): string {
  return [
    b.bytes !== null ? fileSize(b.bytes) : null,
    b.tables !== null ? plural(b.tables, 'table', 'tables') : null,
    b.rows !== null ? plural(b.rows, 'row', 'rows') : null,
    b.entries !== null ? plural(b.entries, 'entry', 'entries') : null,
    b.lines !== null ? plural(b.lines, 'line', 'lines') : null,
  ].filter(Boolean).join(' · ');
}
