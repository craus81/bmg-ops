/**
 * "Brief me" — one server call that gathers what you need to know about a
 * customer before you pick up the phone (R6-13, audit line 415b).
 *
 * Design rule, and the reason most of this file is shape rather than
 * queries: EVERY SECTION CAN FAIL INDEPENDENTLY, AND A FAILURE IS
 * `unknown`, NEVER ZERO. A brief that says "A/R: $0" when NetSuite was
 * unreachable is worse than no brief — it is the one number the person is
 * about to repeat to the customer. So each section carries its own status,
 * the prose is told never to turn an unknown into a figure, and the raw
 * facts ride back alongside the prose so the numbers can be checked.
 *
 * The model writes the summary. If it can't (no key, an API error, a
 * refusal), `factLines()` produces the same brief deterministically from
 * the facts — plainer, but never absent and never invented.
 */

export type SectionStatus = 'ok' | 'unknown' | 'skipped';

export interface Section {
  status: SectionStatus;
  /** Why, when the status isn't 'ok'. Shown to the reader verbatim. */
  reason?: string;
}

export interface BriefEstimate {
  number: string;
  title: string | null;
  status: string;
  ageDays: number;
  total: number | null;
  expiresInDays: number | null;
}

export interface BriefInvoice {
  number: string;
  unpaid: number;
  daysPastDue: number;
}

export interface BriefVehicle {
  vin: string;
  description: string;
  stage: string;
  promisedBack: string | null;
  daysOverdue: number | null;
}

export interface BriefActivity {
  type: string;
  summary: string;
  at: string;
}

export interface BriefFacts {
  customer: {
    name: string;
    prospectId: string | null;
    customerId: string | null;
    netsuiteId: string | null;
    entityId: string | null;
    email: string | null;
    phone: string | null;
  };
  estimates: Section & { open: BriefEstimate[] };
  ar: Section & { openTotal: number | null; pastDue: number | null; oldestDaysPastDue: number | null; invoices: BriefInvoice[] };
  vehicles: Section & { inShop: BriefVehicle[] };
  emails: Section & { sent90: number | null; failed90: number | null; lastFailure: { to: string; status: string; at: string } | null };
  threads: Section & { open: number | null; unread: number | null; lastInboundAt: string | null };
  activities: Section & { recent: BriefActivity[] };
  spend: Section & { lastYear: number | null; ytd: number | null; lastOrderDate: string | null };
  /** When the facts were gathered (ISO). */
  generatedAt: string;
}

export const RECENT_ACTIVITY_LIMIT = 5;
export const OPEN_ESTIMATE_STATUSES = ['draft', 'sent'] as const;
export const EMAIL_WINDOW_DAYS = 90;
/** Cap what rides to the model and what the sheet renders. */
export const MAX_LISTED = 8;

const money = (n: number): string =>
  '$' + Math.round(n).toLocaleString('en-US');

const dayDiff = (a: number, b: number): number => Math.round((a - b) / 86_400_000);

/** Whole days between an ISO timestamp and `now`; null when unparseable. */
export function ageInDays(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? dayDiff(now, t) : null;
}

/** Days until a date (negative = past); null when unparseable. */
export function daysUntil(date: string | null | undefined, now = Date.now()): number | null {
  if (!date) return null;
  const s = String(date);
  const t = Date.parse(s.includes('T') ? s : `${s}T00:00:00`);
  return Number.isFinite(t) ? dayDiff(t, now) : null;
}

/**
 * The deterministic brief: one line per section, straight from the facts.
 * This is what renders when the model is unavailable, and it is also what
 * the model is given as the raw material — so the two can't disagree about
 * whether a number exists.
 *
 * An `unknown` section says so in words. It never contributes a figure.
 */
export function factLines(f: BriefFacts): string[] {
  const lines: string[] = [];
  const say = (label: string, s: Section, ok: () => string) => {
    if (s.status === 'skipped') return;
    if (s.status === 'unknown') {
      lines.push(`${label}: unavailable${s.reason ? ` — ${s.reason}` : ''} (not zero — this could not be read).`);
      return;
    }
    lines.push(`${label}: ${ok()}`);
  };

  say('Open estimates', f.estimates, () => {
    if (f.estimates.open.length === 0) return 'none open.';
    const parts = f.estimates.open.slice(0, MAX_LISTED).map(e => {
      const bits = [`${e.number}`, `${e.status}`, `${e.ageDays}d old`];
      if (e.total != null) bits.push(money(e.total));
      if (e.expiresInDays != null) bits.push(e.expiresInDays < 0 ? `EXPIRED ${-e.expiresInDays}d ago` : `expires in ${e.expiresInDays}d`);
      return bits.join(', ');
    });
    const more = f.estimates.open.length - parts.length;
    return `${f.estimates.open.length} — ${parts.join('; ')}${more > 0 ? `; +${more} more` : ''}.`;
  });

  say('A/R', f.ar, () => {
    if (!f.ar.openTotal) return 'nothing open.';
    const bits = [`${money(f.ar.openTotal)} open`];
    if (f.ar.pastDue) bits.push(`${money(f.ar.pastDue)} past due`);
    if (f.ar.oldestDaysPastDue != null && f.ar.oldestDaysPastDue > 0) bits.push(`oldest ${f.ar.oldestDaysPastDue}d`);
    return bits.join(', ') + '.';
  });

  say('In the shop', f.vehicles, () => {
    if (f.vehicles.inShop.length === 0) return 'no vehicles.';
    const parts = f.vehicles.inShop.slice(0, MAX_LISTED).map(v => {
      const bits = [v.description || v.vin, v.stage];
      if (v.daysOverdue != null && v.daysOverdue > 0) bits.push(`${v.daysOverdue}d PAST promised-back`);
      else if (v.promisedBack) bits.push(`due back ${v.promisedBack}`);
      return bits.join(' — ');
    });
    const more = f.vehicles.inShop.length - parts.length;
    return `${f.vehicles.inShop.length} — ${parts.join('; ')}${more > 0 ? `; +${more} more` : ''}.`;
  });

  say('Email', f.emails, () => {
    const sent = f.emails.sent90 ?? 0;
    if (sent === 0) return `nothing sent in ${EMAIL_WINDOW_DAYS} days.`;
    const failed = f.emails.failed90 ?? 0;
    let s = `${sent} sent in ${EMAIL_WINDOW_DAYS} days`;
    if (failed > 0) {
      s += `, ${failed} did NOT arrive`;
      if (f.emails.lastFailure) s += ` (last: ${f.emails.lastFailure.to}, ${f.emails.lastFailure.status})`;
    }
    return s + '.';
  });

  say('Threads', f.threads, () => {
    const open = f.threads.open ?? 0;
    if (open === 0) return 'none open.';
    const unread = f.threads.unread ?? 0;
    return `${open} open${unread > 0 ? `, ${unread} unread` : ''}${f.threads.lastInboundAt ? `, last inbound ${f.threads.lastInboundAt.slice(0, 10)}` : ''}.`;
  });

  say('Spend', f.spend, () => {
    const bits: string[] = [];
    if (f.spend.lastYear != null) bits.push(`${money(f.spend.lastYear)} last year`);
    if (f.spend.ytd != null) bits.push(`${money(f.spend.ytd)} YTD`);
    if (f.spend.lastOrderDate) bits.push(`last order ${f.spend.lastOrderDate}`);
    return bits.length ? bits.join(', ') + '.' : 'no synced spend figures on this record.';
  });

  say('Last activity', f.activities, () => {
    if (f.activities.recent.length === 0) return 'nothing logged.';
    return f.activities.recent
      .slice(0, 3)
      .map(a => `${a.at.slice(0, 10)} ${a.type} — ${a.summary}`)
      .join('; ') + '.';
  });

  return lines;
}

/** Sections that couldn't be read. The UI names them so a short brief is not mistaken for a quiet account. */
export function unknownSections(f: BriefFacts): string[] {
  const out: string[] = [];
  const check = (label: string, s: Section) => { if (s.status === 'unknown') out.push(label); };
  check('open estimates', f.estimates);
  check('A/R', f.ar);
  check('vehicles in the shop', f.vehicles);
  check('email delivery', f.emails);
  check('threads', f.threads);
  check('spend history', f.spend);
  check('activity log', f.activities);
  return out;
}

export const BRIEF_SYSTEM_PROMPT = `You write a pre-call brief for a BMG Fleet staff member who is about to phone a customer. You are given verified facts gathered from the company's own systems.

RULES — these are not style preferences:
1. Use ONLY the facts given. Never add a number, name, date or event that is not in them.
2. A fact line that says "unavailable" means the system could not be read. Say it is unavailable. NEVER report it as zero, none, clean, current or fine.
3. If a section says "none" or "nothing", that IS a real answer — report it as such.
4. Ten lines maximum, one short line each, no preamble, no sign-off, no markdown headings.
5. Lead with anything that needs action or is awkward: an overdue invoice, a vehicle past its promised-back date, an estimate about to expire, an email that did not arrive.
6. Start each line with a short bold label, e.g. "**Money:**".
7. Do not invent a recommendation about pricing, credit or legal exposure.
8. Plain sentences a person can read aloud. No tables.`;

/** The user message for the model: the facts, and nothing else. */
export function buildBriefPrompt(f: BriefFacts): string {
  const unknown = unknownSections(f);
  return [
    `Customer: ${f.customer.name}`,
    '',
    'Facts:',
    ...factLines(f).map(l => `- ${l}`),
    '',
    unknown.length
      ? `Could not be read (report as unavailable, never as zero): ${unknown.join(', ')}.`
      : 'Every section was read successfully.',
    '',
    'Write the brief.',
  ].join('\n');
}
