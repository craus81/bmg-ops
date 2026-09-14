import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { describeMatch, findCustomerDuplicates, type DupeMatch } from '@/lib/customer-dupes';

/**
 * Matching QuickBooks customers to FleetSuite's `customers` rows.
 *
 * NAME COLLISION, STATED ONCE: `src/lib/customer-match.ts` already exists —
 * the graded `matchCustomer`/`resolvePoCustomer` matcher that runs one query
 * per lookup. It is READ-ONLY for this work and nothing here changes it. Its
 * RULES are re-expressed in memory below, because a per-row DB matcher would
 * be one round trip per QuickBooks customer and this realm has thousands.
 *
 * The "double names" problem (owner item 6): QuickBooks display names like
 * "Broadway Ford Broadway Ford" are one customer whose company name was also
 * stuffed into the first/last name fields. NetSuite has it once. So the
 * cleanup runs first and the graded match runs over the cleaned name.
 */

export interface CustomerIndexRow {
  id: string;
  netsuite_id: string;
  company_name: string | null;
  entity_id: string | null;
  email: string | null;
  phone_digits: string | null;
}

/** Trim, collapse whitespace, normalise the punctuation people vary on. */
function normalize(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The name to match on.
 *
 * `CompanyName` wins whenever QuickBooks has one — it is the field that was
 * NOT doubled. Otherwise DisplayName is cleaned: the ' (deleted)' suffix
 * QuickBooks appends to inactive records goes, a 'Customer:Job' name is cut
 * at the first colon (the parent is the customer; the job is a sub-record),
 * and then the doubled-phrase collapse runs.
 *
 * The collapse is deliberately narrow: an EVEN token count whose first half
 * equals its second half, case-insensitively. 'Ford Ford Dealership' has
 * three tokens and is left alone — collapsing on any repeated token would
 * rename real companies.
 */
export function cleanQboName(displayName: string, companyName?: string | null): string {
  const company = normalize(String(companyName ?? ''));
  if (company) return company;

  let name = normalize(String(displayName ?? ''));
  name = name.replace(/\s*\(deleted\)\s*$/i, '');
  const colon = name.indexOf(':');
  if (colon > 0) name = name.slice(0, colon);
  name = normalize(name.replace(/,/g, ' '));
  if (!name) return '';

  const tokens = name.split(' ').filter(Boolean);
  if (tokens.length >= 2 && tokens.length % 2 === 0) {
    const half = tokens.length / 2;
    const first = tokens.slice(0, half).join(' ');
    const second = tokens.slice(half).join(' ');
    if (first.toLowerCase() === second.toLowerCase()) return first;
  }
  return tokens.join(' ');
}

/**
 * Every active NetSuite-linked customer, once per chunk.
 *
 * `fetchAllRows` with a unique `id` tiebreaker: `customers` is well past
 * PostgREST's silent 1000-row cap, and a truncated index would grade
 * thousands of QuickBooks customers as unmatched.
 */
export async function loadCustomerIndex(service: SupabaseClient): Promise<CustomerIndexRow[]> {
  const { data, error } = await fetchAllRows<CustomerIndexRow>((from, to) =>
    service
      .from('customers')
      .select('id, netsuite_id, company_name, entity_id, email, phone_digits')
      .eq('active', true)
      .not('netsuite_id', 'is', null)
      .order('id')
      .range(from, to),
  );
  if (error) throw new Error(`Could not load the customer index: ${error.message}`);
  return data;
}

export type MatchGrade =
  | { status: 'exact' | 'cleaned'; customer: CustomerIndexRow; reason: string }
  | { status: 'ambiguous'; candidates: CustomerIndexRow[]; reason: string }
  | { status: 'unmatched' };

const lc = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();

/**
 * `matchCustomer`'s graded ladder, run in memory over the index.
 *
 * Strictest first — exact company_name, exact entity_id, unambiguous prefix,
 * unambiguous substring — and MORE THAN ONE hit at any step is `ambiguous`,
 * never a guess. This feeds financial history: attaching ten years of
 * invoices to the wrong customer is worse than leaving them in a queue.
 *
 * Each rung is tried on the RAW display name first, then on the cleaned one,
 * so a name that needed no cleanup grades `exact` and a doubled one grades
 * `cleaned` — the distinction the owner's report is built around.
 *
 * Duplicate `netsuite_id` values in the index (the migration-264 warning
 * path) grade ambiguous: two app rows claiming the same NetSuite customer
 * is a data problem a human resolves, not one an importer picks a side in.
 */
export function gradeInMemory(
  index: CustomerIndexRow[],
  party: { displayName: string; cleanedName: string },
): MatchGrade {
  const attempts: { name: string; status: 'exact' | 'cleaned' }[] = [];
  const raw = normalize(party.displayName);
  const cleaned = normalize(party.cleanedName);
  if (raw) attempts.push({ name: raw, status: 'exact' });
  if (cleaned && lc(cleaned) !== lc(raw)) attempts.push({ name: cleaned, status: 'cleaned' });
  if (attempts.length === 0) return { status: 'unmatched' };

  const settle = (
    hits: CustomerIndexRow[],
    status: 'exact' | 'cleaned',
    reason: string,
  ): MatchGrade | null => {
    if (hits.length === 0) return null;
    const distinctNs = new Set(hits.map(h => h.netsuite_id));
    if (hits.length === 1) return { status, customer: hits[0], reason };
    // Two app rows claiming the same NetSuite customer is a data problem a
    // human resolves (the migration-264 warning path), not one to pick a
    // side in — so it grades ambiguous with that reason rather than the
    // generic one below.
    if (distinctNs.size === 1 && hits.length > 1) {
      return { status: 'ambiguous', candidates: hits, reason: `${hits.length} customer rows share NetSuite id ${hits[0].netsuite_id}` };
    }
    return { status: 'ambiguous', candidates: hits.slice(0, 10), reason };
  };

  for (const { name, status } of attempts) {
    const needle = lc(name);
    if (!needle) continue;

    const byCompany = index.filter(c => lc(c.company_name) === needle);
    const r1 = settle(byCompany, status, `company name matches "${name}"`);
    if (r1) return r1;

    const byEntity = index.filter(c => lc(c.entity_id) === needle);
    const r2 = settle(byEntity, status, `NetSuite entity id matches "${name}"`);
    if (r2) return r2;

    const byPrefix = index.filter(c => lc(c.company_name).startsWith(needle));
    const r3 = settle(byPrefix, status, `company name starts with "${name}"`);
    if (r3) return r3;

    const bySub = index.filter(c => lc(c.company_name).includes(needle));
    const r4 = settle(bySub, status, `company name contains "${name}"`);
    if (r4) return r4;
  }

  return { status: 'unmatched' };
}

export interface CandidateSet {
  candidates: DupeMatch[];
  described: string[];
}

/**
 * Suggestions for a row the grader could not settle — name, email and phone,
 * through the shared duplicate finder.
 *
 * **`customers` ROWS ONLY.** `findCustomerDuplicates` searches BOTH tables
 * and its `prospects` half runs unconditionally, but a prospects id is NOT a
 * `customers.id` and `ledger_customers.customer_id` is
 * `REFERENCES customers(id)`. Offering one as a candidate would 23503 the
 * moment the reviewer clicked the answer the queue proposed. So a prospects
 * hit is resolved to its `customers` row by `netsuite_id` when it has one
 * and DROPPED otherwise — every DupeMatch that leaves here carries a
 * `customers.id`.
 */
export async function candidatesFor(
  service: SupabaseClient,
  party: { cleanedName: string; email?: string | null; phone?: string | null },
): Promise<CandidateSet> {
  const hits = await findCustomerDuplicates(service, {
    companyName: party.cleanedName,
    email: party.email ?? null,
    phone: party.phone ?? null,
  });

  const direct = hits.filter(m => m.source === 'customers');
  const prospectNsIds = [
    ...new Set(
      hits
        .filter(m => m.source === 'prospects' && m.netsuite_id)
        .map(m => String(m.netsuite_id)),
    ),
  ].slice(0, 100);

  const resolved: DupeMatch[] = [];
  if (prospectNsIds.length > 0) {
    const { data } = await service
      .from('customers')
      .select('id, company_name, email, phone, netsuite_id')
      .in('netsuite_id', prospectNsIds);
    for (const row of data || []) {
      const from = hits.find(m => m.source === 'prospects' && String(m.netsuite_id) === String(row.netsuite_id));
      resolved.push({
        source: 'customers',
        id: String(row.id),
        company_name: row.company_name ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        netsuite_id: row.netsuite_id != null ? String(row.netsuite_id) : null,
        matchedOn: from?.matchedOn ?? ['name'],
      });
    }
  }

  const byId = new Map<string, DupeMatch>();
  for (const m of [...direct, ...resolved]) byId.set(m.id, m);
  const candidates = [...byId.values()].slice(0, 10);
  return { candidates, described: candidates.map(describeMatch) };
}
