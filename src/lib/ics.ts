/**
 * iCalendar (RFC 5545) generation for the installer schedule feed (R6-8).
 *
 * Hand-rolled rather than pulled in: the whole surface here is one VEVENT
 * shape, and the parts that actually go wrong in the wild are the parts a
 * library would hide from us —
 *
 *  - DTEND ON AN ALL-DAY EVENT IS EXCLUSIVE. A job running the 3rd to the
 *    5th ends at DTEND=20260906. Off by one and every job in the
 *    installer's calendar is a day short, which is exactly the kind of
 *    quiet wrong that gets someone to a site on the wrong day.
 *  - CRLF, not LF. Some clients tolerate LF; enough do not.
 *  - Lines fold at 75 OCTETS, not characters, and a continuation starts
 *    with a space.
 *  - Backslash, semicolon, comma and newline must be escaped in text values,
 *    and a job title with a comma in it is completely ordinary.
 */

export interface IcsEvent {
  /** Stable across regenerations: the client replaces rather than duplicates. */
  uid: string;
  /** All-day start, YYYY-MM-DD. */
  start: string;
  /** All-day end INCLUSIVE, YYYY-MM-DD. Converted to the exclusive DTEND. */
  end: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  /** Show the time as free rather than busy. Set it for events that mark a
   *  date without booking it — a deadline the crew should see but which
   *  must not make them look unavailable. Cancelled events are always free. */
  transparent?: boolean;
  /** Bumped when the event changes, so clients accept the update. */
  sequence?: number;
  /** Last-modified instant, ISO. */
  updatedAt?: string | null;
}

const CRLF = '\r\n';

/** RFC 5545 §3.3.11 text escaping. Order matters: backslash first. */
export function escapeText(value: string): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Fold to 75 octets per line with a leading space on continuations. Counts
 *  BYTES, since a folded multi-byte character would corrupt the value. */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a UTF-8 sequence: back off to a lead byte.
    while (end > start && end < bytes.length && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuations spend one octet on the leading space
  }
  return out.join(`${CRLF} `);
}

/** YYYY-MM-DD → YYYYMMDD. */
export const icsDate = (ymd: string): string => String(ymd).slice(0, 10).replace(/-/g, '');

/** The day AFTER an inclusive end date — what DTEND must carry. */
export function exclusiveEnd(inclusiveEnd: string): string {
  const t = Date.parse(`${String(inclusiveEnd).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return icsDate(inclusiveEnd);
  return icsDate(new Date(t + 86_400_000).toISOString());
}

/** ISO instant → YYYYMMDDTHHMMSSZ. */
export function icsStamp(iso?: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  const d = Number.isNaN(t) ? new Date() : new Date(t);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function buildEvent(e: IcsEvent, now = new Date().toISOString()): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART;VALUE=DATE:${icsDate(e.start)}`,
    // Exclusive: an event ending ON the 5th carries DTEND of the 6th.
    `DTEND;VALUE=DATE:${exclusiveEnd(e.end)}`,
    `SUMMARY:${escapeText(e.summary)}`,
    `SEQUENCE:${e.sequence ?? 0}`,
    `STATUS:${e.status || 'CONFIRMED'}`,
    `TRANSP:${e.transparent || e.status === 'CANCELLED' ? 'TRANSPARENT' : 'OPAQUE'}`,
  ];
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  if (e.updatedAt) lines.push(`LAST-MODIFIED:${icsStamp(e.updatedAt)}`);
  lines.push('END:VEVENT');
  return lines;
}

export interface CalendarOptions {
  /** Shown as the calendar's name in most clients. */
  name: string;
  /** Refresh hint. Clients treat it as advice, not a contract. */
  refreshMinutes?: number;
  now?: string;
}

export function buildCalendar(events: IcsEvent[], opts: CalendarOptions): string {
  const refresh = opts.refreshMinutes ?? 60;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BMG Fleet//FleetSuite CNI//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(opts.name)}`,
    `NAME:${escapeText(opts.name)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refresh}M`,
    `X-PUBLISHED-TTL:PT${refresh}M`,
    ...events.flatMap(e => buildEvent(e, opts.now)),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
