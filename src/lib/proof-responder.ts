/**
 * Who answered a proof. Proof emails go one per recipient with the
 * person's own address on the link (?to=…&own=1), so the address IS the
 * reader; a reader the email was forwarded to can type their name instead.
 * Older shared links named only the first recipient, so those stay
 * unknown rather than naming the wrong person.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type Db = SupabaseClient<any, any, any>;

/** "Name (address)" when a name is known, else the bare address. */
export function formatResponder(name: string | null | undefined, address: string): string {
  const n = (name || '').trim();
  return n && n.toLowerCase() !== address.toLowerCase() ? `${n} (${address})` : address;
}

/** The responder to record, or null when the link can't say. Lookups are
 *  best-effort: a failed one still records the address. */
export async function resolveProofResponder(
  db: Db,
  input: { ownLink?: boolean | null; deliveryTarget?: string | null; typedName?: string | null },
): Promise<string | null> {
  const typed = (input.typedName || '').trim();
  const address = (input.deliveryTarget || '').trim();
  if (!input.ownLink || !address) return null;
  if (typed) return `${typed} (forwarded from ${address})`;
  if (!address.includes('@')) return address;
  let name: string | null = null;
  try {
    const { data: contact } = await db
      .from('external_contacts').select('name').ilike('email', address).limit(1).maybeSingle();
    name = contact?.name || null;
    if (!name) {
      const { data: prof } = await db
        .from('profiles').select('full_name').ilike('email', address).limit(1).maybeSingle();
      name = prof?.full_name || null;
    }
  } catch { /* the address alone still says who */ }
  return formatResponder(name, address);
}
