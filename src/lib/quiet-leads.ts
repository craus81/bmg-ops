/**
 * The quiet-lead triage queue (R6-9): active leads nobody has touched, with
 * everything needed to decide their fate in one row.
 *
 * "Days since last touch" means a TOUCH. The dashboard tile that preceded
 * this measured `prospects.updated_at`, which moves on any edit at all —
 * a sync writing a phone number, someone fixing a typo — so a lead could
 * look freshly worked when nobody had spoken to them in months. Here the
 * signal is the latest row in prospect_activities (call, email, note,
 * meeting, quote sent), and each row says WHICH signal dated it, because
 * "no activity ever recorded, falling back to when the record was created"
 * is a different fact from "last called on the 3rd".
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/** Untouched this long and the lead needs a decision, not more waiting. */
export const QUIET_DAYS = 30;

export type TouchSource = 'activity' | 'record_updated' | 'created' | 'unknown';

export interface LastTouch {
  at: string | null;
  source: TouchSource;
  /** The activity's own summary, when that is what dated it. */
  summary: string | null;
}

export interface QuietLead {
  id: string;
  companyName: string;
  status: string;
  isHot: boolean;
  /** The app has no owner field; the creator is the only ownership signal. */
  createdById: string | null;
  createdByName: string | null;
  lastTouch: LastTouch;
  daysQuiet: number | null;
  /** Quotes still waiting on this lead — a quiet lead WITH one is a different
   *  conversation from a quiet lead with nothing outstanding. */
  openQuoteCount: number;
  netsuiteId: string | null;
}

export interface ActivityRow {
  prospect_id: string;
  summary?: string | null;
  created_at: string;
}

/**
 * The most recent real touch, and what dated it. Activities win; the record's
 * own timestamps are a fallback that says so rather than passing itself off
 * as contact.
 */
export function lastTouchOf(
  prospect: { updated_at?: string | null; created_at?: string | null },
  latestActivity?: ActivityRow | null,
): LastTouch {
  if (latestActivity?.created_at) {
    return { at: latestActivity.created_at, source: 'activity', summary: latestActivity.summary || null };
  }
  if (prospect.updated_at) return { at: prospect.updated_at, source: 'record_updated', summary: null };
  if (prospect.created_at) return { at: prospect.created_at, source: 'created', summary: null };
  return { at: null, source: 'unknown', summary: null };
}

/** Whole days since the last touch; null when there is nothing to measure. */
export function daysSince(at: string | null | undefined, now: number = Date.now()): number | null {
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

/** How a row explains its own date, so the list never implies contact it has no record of. */
export function touchLabel(touch: LastTouch): string {
  switch (touch.source) {
    case 'activity': return touch.summary ? `Last touch: ${touch.summary}` : 'Last logged touch';
    case 'record_updated': return 'No contact ever logged — dated from the last edit to the record';
    case 'created': return 'No contact ever logged — dated from when the record was created';
    default: return 'No date on record';
  }
}

export interface LoadOptions {
  /** Minimum quiet days to qualify. */
  days?: number;
  now?: number;
}

/**
 * Every active, unconverted lead quiet for `days` or more, worst first.
 *
 * Records deliberately parked as `nurturing` or closed as `lost` stay out:
 * the queue exists to make someone touch, park, or close each row, and a row
 * already parked is a decision already made.
 */
export async function loadQuietLeads(
  service: SupabaseClient,
  opts: LoadOptions = {},
): Promise<QuietLead[]> {
  const days = opts.days ?? QUIET_DAYS;
  const now = opts.now ?? Date.now();

  const cutoffIso = new Date(now - days * 86_400_000).toISOString();

  // prospects grows without bound, so the read paginates with a unique
  // tiebreaker (the PostgREST 1000-row cap is silent).
  const { data: rows, error } = await fetchAllRows<any>((from, to) =>
    service
      .from('prospects')
      .select('id, company_name, status, is_hot, created_by, created_at, updated_at, netsuite_id, record_type')
      .eq('status', 'active')
      .neq('record_type', 'vendor')
      .order('id')
      .range(from, to),
  );
  if (error) throw new Error(error.message);
  const prospects = rows || [];
  if (prospects.length === 0) return [];

  // Pass 1 — who has been touched RECENTLY. Time-bounded and unfiltered by
  // id: thirty days of CRM activity is a small read, where pulling every
  // activity ever logged for every active lead is not (a busy lead carries
  // years of rows, and those are exactly the leads this queue does not want).
  const touchedRecently = new Set<string>();
  const { data: recent } = await fetchAllRows<{ prospect_id: string }>((from, to) =>
    service
      .from('prospect_activities')
      .select('prospect_id')
      .gte('created_at', cutoffIso)
      .order('id')
      .range(from, to),
  );
  for (const a of recent || []) touchedRecently.add(a.prospect_id);

  const candidates = prospects.filter((p: any) => !touchedRecently.has(p.id));
  if (candidates.length === 0) return [];

  // Pass 2 — the last touch for the quiet ones only, so the row can say what
  // it was and when. Newest-first; first seen per lead wins.
  const latest = new Map<string, ActivityRow>();
  const ids = candidates.map((p: any) => p.id);
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data: acts } = await fetchAllRows<ActivityRow>((from, to) =>
      service
        .from('prospect_activities')
        .select('prospect_id, summary, created_at')
        .in('prospect_id', slice)
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to),
    );
    for (const a of acts || []) {
      if (!latest.has(a.prospect_id)) latest.set(a.prospect_id, a);
    }
  }

  // Open quotes per lead, so a row shows whether something is outstanding.
  const openQuotes = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data: ests } = await fetchAllRows<{ prospect_id: string; id: string }>((from, to) =>
      service
        .from('estimates')
        .select('prospect_id, id')
        .in('prospect_id', slice)
        .eq('status', 'sent')
        .order('id')
        .range(from, to),
    );
    for (const e of ests || []) {
      if (!e.prospect_id) continue;
      openQuotes.set(e.prospect_id, (openQuotes.get(e.prospect_id) || 0) + 1);
    }
  }

  const leads: QuietLead[] = [];
  for (const p of candidates) {
    const lastTouch = lastTouchOf(p, latest.get(p.id));
    const quiet = daysSince(lastTouch.at, now);
    // No date at all means we cannot say it is quiet — it is unmeasured, and
    // dropping it is better than inventing a number to sort it by.
    if (quiet == null || quiet < days) continue;
    leads.push({
      id: p.id,
      companyName: p.company_name || '—',
      status: p.status,
      isHot: !!p.is_hot,
      createdById: p.created_by || null,
      createdByName: null,
      lastTouch,
      daysQuiet: quiet,
      openQuoteCount: openQuotes.get(p.id) || 0,
      netsuiteId: p.netsuite_id || null,
    });
  }

  leads.sort((a, b) => (b.daysQuiet || 0) - (a.daysQuiet || 0) || a.companyName.localeCompare(b.companyName));

  const nameIds = [...new Set(leads.map(l => l.createdById).filter(Boolean))] as string[];
  if (nameIds.length > 0) {
    const { data: people } = await service.from('profiles').select('id, full_name').in('id', nameIds);
    const names = new Map((people || []).map((r: any) => [r.id, r.full_name]));
    for (const l of leads) l.createdByName = l.createdById ? names.get(l.createdById) || null : null;
  }

  return leads;
}
