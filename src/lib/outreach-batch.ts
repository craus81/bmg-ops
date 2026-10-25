import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { chicagoDay } from './exec-metrics';
import { getProfileRoles } from './api-auth';
import { loadUnsubscribed, normalizeEmail } from './email-unsubscribe';
import {
  fetchDotFleets, searchTrade, hasGoogleKey, TRADE_SEARCHES, SEARCH_CENTRES,
  type OutreachCandidate,
} from './outreach-sources';

/**
 * The Monday Outreach batch (migration 438): 25 new companies for every rep
 * with the Sales role, about half fleets and half trade contractors, nearest
 * first. "New" means BMG has no record of them: not a customer, not a
 * prospect (matched by company name, phone or email), never handed out
 * before, and not an address that unsubscribed.
 *
 * Topping up is idempotent: a rep who already has 25 this week gets none,
 * one with 20 gets 5, so a manual "Find companies now" after the cron only
 * fills gaps.
 */

export const BATCH_SIZE = 25;
/** Google searches per run: each is about $0.035, and one run rarely needs
 *  more than a few. */
const MAX_TRADE_SEARCHES = 16;

/** The Monday (America/Chicago) of the week `at` falls in, as YYYY-MM-DD. */
export function weekOf(at: Date = new Date()): string {
  const day = chicagoDay(at);
  const d = new Date(`${day}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const SUFFIX = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|lp|llp|pc|the|and|of)\b/g;

/** "The Acme Plumbing Co., LLC" and "ACME PLUMBING" are the same company. */
export function companyKey(name: string | null | undefined): string {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
    .replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}

export const phoneKey = (phone: string | null | undefined): string => {
  const d = String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? d : '';
};

export interface KnownCompanies {
  names: Set<string>;
  phones: Set<string>;
  emails: Set<string>;
  sourceIds: Set<string>;
}

/** True when nothing we know already matches this candidate. */
export function isNewCompany(c: OutreachCandidate, known: KnownCompanies): boolean {
  if (known.sourceIds.has(`${c.source}:${c.sourceId}`)) return false;
  const name = companyKey(c.companyName);
  if (name && known.names.has(name)) return false;
  const legal = companyKey(String((c.facts as any)?.legalName || ''));
  if (legal && known.names.has(legal)) return false;
  const phone = phoneKey(c.phone);
  if (phone && known.phones.has(phone)) return false;
  if (c.email && known.emails.has(normalizeEmail(c.email))) return false;
  return true;
}

/** Add a candidate to the known set, so the same company found twice in one
 *  run (two searches, or DOT and Google) is handed out once. */
export function remember(c: OutreachCandidate, known: KnownCompanies): void {
  known.sourceIds.add(`${c.source}:${c.sourceId}`);
  const name = companyKey(c.companyName);
  if (name) known.names.add(name);
  const phone = phoneKey(c.phone);
  if (phone) known.phones.add(phone);
  if (c.email) known.emails.add(normalizeEmail(c.email));
}

/** Nearest first; among equals, bigger fleets first. */
export const byNearest = (a: OutreachCandidate, b: OutreachCandidate): number =>
  a.miles - b.miles || (b.fleetSize || 0) - (a.fleetSize || 0) || a.companyName.localeCompare(b.companyName);

/**
 * Deal candidates out round-robin so each rep gets an even share of the
 * nearest ones. `need` is how many each rep still needs from this pool.
 */
export function dealOut<T>(pool: T[], need: Map<string, number>): Map<string, T[]> {
  const out = new Map<string, T[]>([...need.keys()].map(k => [k, []]));
  const reps = [...need.keys()];
  let i = 0;
  for (const item of pool) {
    const open = reps.filter(r => (out.get(r)!.length) < (need.get(r) || 0));
    if (open.length === 0) break;
    const rep = open[i % open.length];
    out.get(rep)!.push(item);
    i++;
  }
  return out;
}

export async function loadKnownCompanies(service: SupabaseClient): Promise<KnownCompanies> {
  const known: KnownCompanies = { names: new Set(), phones: new Set(), emails: new Set(), sourceIds: new Set() };
  const prospects = await fetchAllRows<any>((from, to) =>
    service.from('prospects').select('id, company_name, phone, email').order('id').range(from, to));
  if (prospects.error) throw new Error(`Could not read Customers and Prospects: ${prospects.error.message}`);
  for (const p of prospects.data) {
    const n = companyKey(p.company_name);
    if (n) known.names.add(n);
    const ph = phoneKey(p.phone);
    if (ph) known.phones.add(ph);
    if (p.email) known.emails.add(normalizeEmail(p.email));
  }
  const targets = await fetchAllRows<any>((from, to) =>
    service.from('outreach_targets').select('id, source, source_id, company_name, phone').order('id').range(from, to));
  if (targets.error) throw new Error(`Could not read the outreach list: ${targets.error.message}`);
  for (const t of targets.data) {
    known.sourceIds.add(`${t.source}:${t.source_id}`);
    const n = companyKey(t.company_name);
    if (n) known.names.add(n);
    const ph = phoneKey(t.phone);
    if (ph) known.phones.add(ph);
  }
  return known;
}

export interface SalesRep { id: string; name: string }

export async function loadSalesReps(service: SupabaseClient): Promise<SalesRep[]> {
  const { data, error } = await service.from('profiles')
    .select('id, full_name, role, roles, status, deactivated').eq('status', 'approved');
  if (error) throw new Error(`Could not read users: ${error.message}`);
  return (data || [])
    .filter((p: any) => !p.deactivated && getProfileRoles(p).includes('sales'))
    .map((p: any) => ({ id: p.id, name: p.full_name || 'Sales rep' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface FillResult {
  weekOf: string;
  reps: { id: string; name: string; had: number; added: number }[];
  fleetsFound: number;
  tradesFound: number;
  tradeSearches: number;
  problems: string[];
}

/** Top every Sales rep up to BATCH_SIZE for this week. */
export async function fillWeek(service: SupabaseClient, at: Date = new Date()): Promise<FillResult> {
  const week = weekOf(at);
  const reps = await loadSalesReps(service);
  const result: FillResult = { weekOf: week, reps: [], fleetsFound: 0, tradesFound: 0, tradeSearches: 0, problems: [] };
  if (reps.length === 0) {
    result.problems.push('Nobody has the Sales role, so there is nobody to give companies to.');
    return result;
  }

  const { data: thisWeek, error } = await service.from('outreach_targets')
    .select('rep_id, kind').eq('week_of', week).in('rep_id', reps.map(r => r.id));
  if (error) throw new Error(`Could not read this week's list: ${error.message}`);
  const had = new Map(reps.map(r => [r.id, { fleet: 0, trade: 0 }]));
  for (const t of thisWeek || []) {
    const h = had.get((t as any).rep_id);
    if (h) h[(t as any).kind === 'trade' ? 'trade' : 'fleet']++;
  }

  const google = hasGoogleKey();
  if (!google) result.problems.push('Trade contractors need a Google Maps API key (GOOGLE_MAPS_API_KEY in Vercel). This week is fleets only until it is added.');

  // Half and half (fleets get the odd one), or all fleets with no key.
  const tradeNeed = new Map<string, number>();
  const fleetNeed = new Map<string, number>();
  for (const r of reps) {
    const h = had.get(r.id)!;
    const missing = Math.max(0, BATCH_SIZE - h.fleet - h.trade);
    const tradeTarget = google ? Math.floor(BATCH_SIZE / 2) : 0;
    const t = Math.min(missing, Math.max(0, tradeTarget - h.trade));
    tradeNeed.set(r.id, t);
    fleetNeed.set(r.id, missing - t);
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

  const known = await loadKnownCompanies(service);
  const assigned = new Map<string, OutreachCandidate[]>(reps.map(r => [r.id, []]));

  // Trades first, so a short Google week can be made up with fleets.
  if (sum(tradeNeed) > 0) {
    const pool: OutreachCandidate[] = [];
    const weekNo = Math.floor(Date.parse(`${week}T00:00:00Z`) / (7 * 86400000));
    for (let i = 0; i < MAX_TRADE_SEARCHES && pool.length < sum(tradeNeed); i++) {
      const search = TRADE_SEARCHES[(weekNo + i) % TRADE_SEARCHES.length];
      const centre = SEARCH_CENTRES[(weekNo * 3 + i) % SEARCH_CENTRES.length];
      try {
        const found = await searchTrade(search, centre);
        result.tradeSearches++;
        for (const c of found.sort(byNearest)) {
          if (!isNewCompany(c, known)) continue;
          remember(c, known);
          pool.push(c);
        }
      } catch (err: any) {
        result.problems.push(err.message);
        break;
      }
    }
    result.tradesFound = pool.length;
    const dealt = dealOut(pool, tradeNeed);
    for (const r of reps) {
      const got = dealt.get(r.id) || [];
      assigned.get(r.id)!.push(...got);
      // Whatever Google couldn't fill, fleets make up.
      fleetNeed.set(r.id, (fleetNeed.get(r.id) || 0) + (tradeNeed.get(r.id) || 0) - got.length);
    }
  }

  if (sum(fleetNeed) > 0) {
    try {
      const fleets = (await fetchDotFleets()).sort(byNearest);
      const pool: OutreachCandidate[] = [];
      for (const c of fleets) {
        if (pool.length >= sum(fleetNeed)) break;
        if (!isNewCompany(c, known)) continue;
        remember(c, known);
        pool.push(c);
      }
      result.fleetsFound = pool.length;
      const dealt = dealOut(pool, fleetNeed);
      for (const r of reps) assigned.get(r.id)!.push(...(dealt.get(r.id) || []));
    } catch (err: any) {
      result.problems.push(err.message);
    }
  }

  // Unsubscribed addresses stay off the list (their company can stay, minus
  // the email, so the rep can still call).
  const all = [...assigned.values()].flat();
  const unsub = await loadUnsubscribed(service, all.map(c => c.email || ''));
  const rows = reps.flatMap(r => (assigned.get(r.id) || []).map(c => ({
    source: c.source,
    source_id: c.sourceId,
    kind: c.kind,
    company_name: c.companyName,
    trade: c.trade,
    street: c.street,
    city: c.city,
    state: c.state,
    zip: c.zip,
    miles: c.miles,
    phone: c.phone,
    email: c.email && !unsub.has(normalizeEmail(c.email)) ? c.email : null,
    website: c.website,
    fleet_size: c.fleetSize,
    facts: c.facts,
    rep_id: r.id,
    week_of: week,
    status: 'new',
  })));

  if (rows.length > 0) {
    const { error: insErr } = await service.from('outreach_targets')
      .upsert(rows, { onConflict: 'source,source_id', ignoreDuplicates: true });
    if (insErr) throw new Error(`Could not save the list: ${insErr.message}`);
  }

  for (const r of reps) {
    const h = had.get(r.id)!;
    result.reps.push({ id: r.id, name: r.name, had: h.fleet + h.trade, added: (assigned.get(r.id) || []).length });
  }
  return result;
}
