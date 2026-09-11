import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { resolvePortalCustomer } from '@/lib/portal-token';
import { logAudit } from '@/lib/audit';
import {
  PREF_KEYS, PREF_LABEL, PREF_DESCRIPTION, CONTACT_COLUMN,
  contactValue, companyValue, prefState, resolvePref,
  type PrefKey,
} from '@/lib/notification-prefs';
import { maskEmail } from '@/lib/approval-relink';
import { z, validateBody } from '@/lib/validate';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const PatchSchema = z.object({
  contactId: z.string().uuid(),
  key: z.enum(['status_emails', 'weekly_digest', 'estimate_reminders']),
  /** true/false set an explicit choice; null returns the contact to
   *  following the company setting — a real third option, not "off". */
  value: z.boolean().nullable(),
});

const CONTACT_SELECT = 'id, name, email, is_primary, notify_status_emails, weekly_digest, notify_estimate_reminders, prefs_updated_at, prefs_updated_via';
const COMPANY_SELECT = 'id, company_name, notify_status_emails, weekly_digest, notify_estimate_reminders';

/**
 * /api/portal/[token]/preferences (R6-11) — the customer's own email
 * preferences, behind the portal token.
 *
 * WHAT A HOLDER OF THE LINK MAY DO IS DELIBERATELY NARROW: flip one of
 * three toggles for one contact on their own company. They cannot add a
 * contact, change an address, or read one — every address comes back
 * masked, so the page is useful to the person who recognises their own
 * mailbox and useless as a directory to anyone else. A portal link gets
 * forwarded; that is the threat this shape is built around.
 *
 * Turning something OFF is always allowed, which is the right asymmetry
 * for an unsubscribe. Turning it on is equally allowed — the audience here
 * is the customer themselves — and every change is audit-logged with
 * `via: portal` so staff can see who actually made it.
 */
async function loadState(customerId: string) {
  const [{ data: company }, { data: contacts }] = await Promise.all([
    service.from('customers').select(COMPANY_SELECT).eq('id', customerId).maybeSingle(),
    service.from('external_contacts').select(CONTACT_SELECT).eq('customer_id', customerId).order('is_primary', { ascending: false }).order('name'),
  ]);
  const rows = (contacts || []).filter(c => String(c.email || '').trim());
  return {
    company: {
      name: company?.company_name || null,
      // What the company agreed to, for the "following your company
      // setting" line — the customer should see WHY a toggle reads as it
      // does, not just its state.
      settings: PREF_KEYS.map(key => ({
        key,
        label: PREF_LABEL[key],
        description: PREF_DESCRIPTION[key],
        on: resolvePref(key, { company: companyValue(key, company) }),
      })),
    },
    contacts: rows.map(c => ({
      id: c.id,
      name: c.name || null,
      maskedEmail: maskEmail(String(c.email)),
      isPrimary: !!c.is_primary,
      updatedAt: c.prefs_updated_at || null,
      updatedVia: c.prefs_updated_via || null,
      prefs: PREF_KEYS.map(key => ({
        key,
        label: PREF_LABEL[key],
        description: PREF_DESCRIPTION[key],
        state: prefState(key, { company: companyValue(key, company), contact: contactValue(key, c) }),
        on: resolvePref(key, { company: companyValue(key, company), contact: contactValue(key, c) }),
      })),
    })),
  };
}

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'po_portal_prefs_get', 120)) {
    return NextResponse.json({ error: 'Too many requests — try again later.' }, { status: 429 });
  }
  const customer = await resolvePortalCustomer(service, params.token);
  if (!customer) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  try {
    return NextResponse.json({ status: 'ready', ...(await loadState(customer.id)) });
  } catch (e: any) {
    console.error('portal preferences read failed:', e);
    return NextResponse.json({ error: 'Could not load your preferences just now.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'po_portal_prefs_set', 60)) {
    return NextResponse.json({ error: 'Too many requests — try again later.' }, { status: 429 });
  }
  const customer = await resolvePortalCustomer(service, params.token);
  if (!customer) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const { contactId, key, value } = parsed.data;

  try {
    // The contact must belong to THIS customer. Without this the token
    // would let anyone flip preferences for any contact in the system.
    const { data: contact } = await service
      .from('external_contacts')
      .select('id, customer_id, email')
      .eq('id', contactId)
      .maybeSingle();
    if (!contact || String(contact.customer_id || '') !== customer.id) {
      return NextResponse.json({ status: 'invalid' }, { status: 404 });
    }

    const column = CONTACT_COLUMN[key as PrefKey];
    const { error } = await service
      .from('external_contacts')
      .update({
        [column]: value,
        prefs_updated_at: new Date().toISOString(),
        prefs_updated_via: 'portal',
      })
      .eq('id', contactId);
    if (error) {
      return NextResponse.json({ error: 'Could not save that just now — try again shortly.' }, { status: 500 });
    }

    // Audited with no actor: nobody signed in, and recording the customer's
    // masked address is more honest than attributing it to a staff member.
    await logAudit(service, {
      actorId: null,
      table: 'external_contacts',
      recordId: contactId,
      action: 'customer_notification_pref_changed',
      detail: { key, value, via: 'portal', contact: maskEmail(String(contact.email || '')), company: customer.company_name },
    }).catch(() => undefined);

    return NextResponse.json({ status: 'ready', ...(await loadState(customer.id)) });
  } catch (e: any) {
    console.error('portal preferences write failed:', e);
    return NextResponse.json({ error: 'Could not save that just now — try again shortly.' }, { status: 500 });
  }
}
