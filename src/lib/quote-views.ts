/**
 * Quote open tracking (R6-9) — the rules behind "Viewed 3×, last Tue 9:14am"
 * and the alerts that ride on it.
 *
 * The hard part is not recording the open; the approval GET already runs
 * server-side. It is deciding whether a fetch was a PERSON.
 *
 * Corporate mail security opens every link in every email — Microsoft Safe
 * Links, Proofpoint URL Defense, Mimecast and friends all fetch the URL to
 * scan it, typically within seconds of delivery. Reporting that to a rep as
 * "your customer just opened the quote" would send them to call somebody who
 * has not looked at anything, and once a buy signal has lied twice nobody
 * believes it again. So every fetch is recorded (it happened), and only the
 * ones that look like a person raise an alert.
 *
 * Each classification records WHICH signal decided it, so a later change to
 * this heuristic can be judged against what the old one actually said,
 * rather than re-tuned on a hunch.
 */

/** Opens closer together than this are one view — a refresh is not two reads. */
export const DEDUPE_MINUTES = 30;

/** A fresh look after this many quiet days is the re-open worth a call. */
export const REOPEN_QUIET_DAYS = 5;

/** Sent this long ago with nobody looking = worth checking the address. */
export const NEVER_OPENED_DAYS = 3;

/**
 * Anything arriving within this long of the send is indistinguishable from a
 * link scanner, so it is recorded as `unverified` rather than claimed as a
 * person. A genuinely eager customer who clicks in the first two minutes is
 * miscounted as unverified — that costs a chip; the reverse costs a phone
 * call to somebody who never looked.
 */
export const SCANNER_WINDOW_SECONDS = 120;

export type ViewerKind = 'human' | 'bot' | 'unverified';

export interface ViewClassification {
  kind: ViewerKind;
  /** The reason, stored alongside the row. */
  signal: string;
}

/** Substrings that appear in the UA of things that are definitely not people. */
const BOT_UA = [
  'bot', 'crawler', 'spider', 'slurp', 'preview', 'scanner', 'monitor',
  'curl/', 'wget', 'python-requests', 'okhttp', 'java/', 'go-http-client',
  'headlesschrome', 'phantomjs', 'apache-httpclient', 'libwww',
  'proofpoint', 'mimecast', 'barracuda', 'symantec', 'forcepoint',
  'microsoft office', 'ms-office', 'skypeuripreview', 'bingpreview',
  'slackbot', 'whatsapp', 'facebookexternalhit', 'twitterbot', 'linkedinbot',
  'google-safebrowsing', 'urlpreview',
];

export function classifyViewer(
  userAgent: string | null | undefined,
  opts: { secondsSinceSent?: number | null } = {},
): ViewClassification {
  const ua = String(userAgent || '').trim();

  // A fetch with no user agent at all is not a browser. Every real one sends
  // something.
  if (!ua) return { kind: 'bot', signal: 'no_user_agent' };

  const lower = ua.toLowerCase();
  const hit = BOT_UA.find(p => lower.includes(p));
  if (hit) return { kind: 'bot', signal: `scanner_user_agent:${hit}` };

  // Every mainstream browser still sends a Mozilla/5.0 prefix, three decades
  // on. Something claiming otherwise is a script.
  if (!lower.startsWith('mozilla/')) return { kind: 'bot', signal: 'non_browser_user_agent' };

  const secs = opts.secondsSinceSent;
  if (typeof secs === 'number' && secs >= 0 && secs < SCANNER_WINDOW_SECONDS) {
    // Browser-shaped, but too soon to tell apart from a scanner that spoofs
    // a browser UA — which the better ones do.
    return { kind: 'unverified', signal: 'within_scanner_window' };
  }

  return { kind: 'human', signal: 'browser_user_agent' };
}

export interface QuoteViewRow {
  viewed_at: string;
  viewer_kind?: ViewerKind | string | null;
  ip_address?: string | null;
  user_agent?: string | null;
}

export interface ViewSummary {
  /** Opens we are willing to call a person. This is the number reps see. */
  humanCount: number;
  firstHumanAt: string | null;
  lastHumanAt: string | null;
  /** Recorded but not counted as people — surfaced separately, never blended. */
  machineCount: number;
}

export function summarizeViews(views: QuoteViewRow[]): ViewSummary {
  const humans = (views || [])
    .filter(v => v.viewer_kind === 'human')
    .map(v => v.viewed_at)
    .filter(Boolean)
    .sort();
  return {
    humanCount: humans.length,
    firstHumanAt: humans[0] || null,
    lastHumanAt: humans[humans.length - 1] || null,
    machineCount: (views || []).length - humans.length,
  };
}

/** "Viewed 3×, last Tue 9:14am" — null when nobody has looked. */
export function viewLabel(summary: ViewSummary, locale?: string): string | null {
  if (summary.humanCount === 0) return null;
  const last = summary.lastHumanAt
    ? new Date(summary.lastHumanAt).toLocaleString(locale, {
        weekday: 'short', hour: 'numeric', minute: '2-digit',
      })
    : null;
  return `Viewed ${summary.humanCount}×${last ? `, last ${last}` : ''}`;
}

/** Is this open a re-open after a quiet spell — the buy signal? */
export function isReopen(previousHumanAt: string | null | undefined, viewedAt: string): boolean {
  if (!previousHumanAt) return false;
  const prev = Date.parse(previousHumanAt);
  const now = Date.parse(viewedAt);
  if (Number.isNaN(prev) || Number.isNaN(now)) return false;
  return now - prev >= REOPEN_QUIET_DAYS * 86_400_000;
}

/**
 * Has this quote been sitting unopened long enough to suspect the address?
 * A quote nobody has EVER opened, not one that went quiet after a look.
 *
 * `trackingStartedAt` is when this app began recording opens at all. For a
 * quote sent BEFORE that, "nobody opened it" is unknown rather than false —
 * we were not watching — and saying otherwise would be a confident claim
 * about a period with no data. Pass null only where that distinction cannot
 * matter.
 */
export function neverOpenedDue(
  sentAt: string | null | undefined,
  summary: ViewSummary,
  alreadyNotifiedAt: string | null | undefined,
  now: number = Date.now(),
  trackingStartedAt?: string | null,
): boolean {
  if (alreadyNotifiedAt) return false;
  if (summary.humanCount > 0) return false;
  const sent = sentAt ? Date.parse(sentAt) : NaN;
  if (Number.isNaN(sent)) return false;
  if (trackingStartedAt !== undefined) {
    const started = trackingStartedAt ? Date.parse(trackingStartedAt) : NaN;
    // No start marker = we cannot establish the window, so we say nothing.
    if (Number.isNaN(started) || sent < started) return false;
  }
  return now - sent >= NEVER_OPENED_DAYS * 86_400_000;
}
