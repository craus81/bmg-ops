import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Shared duplicate detection for customer/prospect creation (audit Stage 1
 * MAJOR: the guard was exact-name-only, client-side, and different on every
 * create path — phone and email were never checked, so the same company
 * typed with a different spelling became a second NetSuite customer that
 * splits spend history, statements, and estimate search).
 *
 * One rule, server-side, for every path: match on normalized company name,
 * email (case-insensitive), and phone digits (migration 238's generated
 * phone_digits column) across BOTH the CRM (`prospects`) and the NetSuite
 * mirror (`customers`) — a customer created from check-in/PO/graphics has
 * no prospects row until a sync backfills it, so checking one table alone
 * misses half the records.
 *
 * Deliberately NOT a unique constraint: NetSuite itself can hold two
 * same-named customers, and the sync upserts must keep working. This is a
 * guard with an explicit override (`force`), not a wall.
 */

export interface DupeMatch {
  source: 'prospects' | 'customers';
  id: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  netsuite_id: string | null;
  record_type?: string | null;
  matchedOn: ('name' | 'email' | 'phone')[];
}

/** The codebase's exact-case-insensitive-match idiom (escapes ilike wildcards). */
export function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

/** Trim, lowercase, collapse runs of whitespace. */
export function normalizeCompanyName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Digits only; null when too short to be a phone number (extensions,
 * partial entries). Matching compares the last 10 digits so +1-prefixed
 * and bare US numbers hit each other.
 */
export function phoneDigits(s: string | null | undefined): string | null {
  const d = (s || '').replace(/\D/g, '');
  return d.length >= 7 ? d : null;
}

export function last10(digits: string): string {
  return digits.length > 10 ? digits.slice(-10) : digits;
}

interface DupeQuery {
  companyName: string;
  email?: string | null;
  phone?: string | null;
  /** 'vendor' scopes the prospects check to vendor rows and skips the
   *  customers mirror (vendors never become NetSuite customers). */
  recordType?: string | null;
  excludeProspectId?: string | null;
}

const PROSPECT_COLS = 'id, company_name, contact_name, email, phone, netsuite_id, record_type';
const CUSTOMER_COLS = 'id, company_name, email, phone, netsuite_id';

export async function findCustomerDuplicates(
  service: SupabaseClient,
  q: DupeQuery,
): Promise<DupeMatch[]> {
  const isVendor = q.recordType === 'vendor';
  const name = q.companyName.trim();
  const email = (q.email || '').trim().toLowerCase();
  const digits = phoneDigits(q.phone);

  // Small separate queries instead of one .or(): ilike/eq values containing
  // commas or parens would break PostgREST's .or() filter syntax.
  const jobs: Promise<{ rows: any[]; source: 'prospects' | 'customers'; field: 'name' | 'email' | 'phone' }>[] = [];

  const run = (
    source: 'prospects' | 'customers',
    field: 'name' | 'email' | 'phone',
    build: () => PromiseLike<{ data: any[] | null }>,
  ) => {
    jobs.push(Promise.resolve(build()).then(r => ({ rows: r.data || [], source, field })));
  };

  const prospectsBase = () => {
    let b = service.from('prospects').select(PROSPECT_COLS).limit(5);
    // Same-type rows only: a vendor rep and a customer sharing a name are
    // different records by design (the CRM page guard's original rule).
    b = isVendor ? b.eq('record_type', 'vendor') : b.neq('record_type', 'vendor');
    if (q.excludeProspectId) b = b.neq('id', q.excludeProspectId);
    return b;
  };

  if (name) {
    run('prospects', 'name', () => prospectsBase().ilike('company_name', escapeIlike(name)));
    if (!isVendor) {
      run('customers', 'name', () =>
        service.from('customers').select(CUSTOMER_COLS).ilike('company_name', escapeIlike(name)).limit(5));
    }
  }
  if (email) {
    run('prospects', 'email', () => prospectsBase().ilike('email', escapeIlike(email)));
    if (!isVendor) {
      run('customers', 'email', () =>
        service.from('customers').select(CUSTOMER_COLS).ilike('email', escapeIlike(email)).limit(5));
    }
  }
  if (digits) {
    const tail = last10(digits);
    run('prospects', 'phone', () => prospectsBase().like('phone_digits', `%${tail}`));
    if (!isVendor) {
      run('customers', 'phone', () =>
        service.from('customers').select(CUSTOMER_COLS).like('phone_digits', `%${tail}`).limit(5));
    }
  }

  const results = await Promise.all(jobs);
  const byKey = new Map<string, DupeMatch>();
  for (const { rows, source, field } of results) {
    for (const row of rows) {
      const key = `${source}:${row.id}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.matchedOn.includes(field)) existing.matchedOn.push(field);
      } else {
        byKey.set(key, {
          source,
          id: String(row.id),
          company_name: row.company_name ?? null,
          email: row.email ?? null,
          phone: row.phone ?? null,
          netsuite_id: row.netsuite_id != null ? String(row.netsuite_id) : null,
          record_type: row.record_type ?? null,
          matchedOn: [field],
        });
      }
    }
  }

  // Name matches first (the strongest signal), then multi-field matches.
  return [...byKey.values()].sort((a, b) => {
    const aName = a.matchedOn.includes('name') ? 1 : 0;
    const bName = b.matchedOn.includes('name') ? 1 : 0;
    if (aName !== bName) return bName - aName;
    return b.matchedOn.length - a.matchedOn.length;
  });
}

/** One-line human description of why a match matched. */
export function describeMatch(m: DupeMatch): string {
  const what = m.matchedOn.map(f => f === 'name' ? 'same name' : f === 'email' ? 'same email' : 'same phone').join(', ');
  return `${m.company_name || m.email || m.phone || m.id} (${what})`;
}
