import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { createContact, updateContact, deleteContact } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

/**
 * POST /api/prospects/contacts
 *
 * Create or update a CRM contact, and push the same change to NetSuite when
 * the prospect is linked to a NetSuite customer (skippable per call).
 *
 * Body: {
 *   prospectId: string;         // prospects.id (uuid)
 *   contactId?: string;         // prospect_contacts.id — present = update
 *   name: string;               // required; "First Last" (NetSuite splits it)
 *   title?, email?, phone?: string;
 *   is_decision_maker?: boolean;
 *   syncNetsuite?: boolean;     // default true; ignored when unlinked
 * }
 *
 * The local save is authoritative — a NetSuite failure never rolls it back.
 * The response carries netsuite: { pushed, error } so the UI can say "saved
 * in the CRM, but NetSuite said no" (usually a missing Lists > Contacts
 * permission on the integration role, or a single-word name where the
 * account requires a last name).
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const prospectId = String(body?.prospectId || '');
  const contactId = body?.contactId ? String(body.contactId) : null;
  const name = String(body?.name || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(prospectId)) return NextResponse.json({ error: 'prospectId required' }, { status: 400 });
  if (contactId && !/^[0-9a-f-]{36}$/i.test(contactId)) return NextResponse.json({ error: 'Invalid contactId' }, { status: 400 });
  if (!name) return NextResponse.json({ error: 'Contact name required' }, { status: 400 });

  const fields = {
    name,
    title: String(body?.title || '').trim() || null,
    email: String(body?.email || '').trim() || null,
    phone: String(body?.phone || '').trim() || null,
    is_decision_maker: !!body?.is_decision_maker,
  };

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: prospect } = await supabase.from('prospects').select('id, netsuite_id').eq('id', prospectId).maybeSingle();
  if (!prospect) return NextResponse.json({ error: 'Prospect not found' }, { status: 404 });

  let contact: any;
  if (contactId) {
    const { data, error } = await supabase.from('prospect_contacts')
      .update(fields).eq('id', contactId).eq('prospect_id', prospectId).select().single();
    if (error || !data) return NextResponse.json({ error: error?.message || 'Contact not found' }, { status: 400 });
    contact = data;
  } else {
    // Upsert on (prospect_id, name) — the same dedupe key the NetSuite bulk
    // sync uses, so re-adding a synced contact updates it instead of erroring.
    const { data, error } = await supabase.from('prospect_contacts')
      .upsert({ prospect_id: prospectId, ...fields }, { onConflict: 'prospect_id,name' }).select().single();
    if (error || !data) return NextResponse.json({ error: error?.message || 'Failed to save contact' }, { status: 500 });
    contact = data;
  }

  // ── NetSuite push (best effort, never rolls back the local save) ────────
  let netsuite: { pushed: boolean; error: string | null } = { pushed: false, error: null };
  if (body?.syncNetsuite !== false && prospect.netsuite_id) {
    const [firstName, ...rest] = name.split(/\s+/);
    const lastName = rest.join(' ') || undefined;
    const nsFields = {
      firstName,
      lastName,
      email: fields.email || undefined,
      phone: fields.phone || undefined,
      title: fields.title || undefined,
    };
    if (contact.netsuite_contact_id) {
      const r = await updateContact(String(contact.netsuite_contact_id), nsFields);
      netsuite = { pushed: r.success, error: r.error || null };
    } else {
      const r = await createContact({ companyId: String(prospect.netsuite_id), ...nsFields });
      if (r.success && r.internalId) {
        await supabase.from('prospect_contacts').update({ netsuite_contact_id: r.internalId }).eq('id', contact.id);
        contact.netsuite_contact_id = r.internalId;
      }
      netsuite = { pushed: r.success, error: r.error || null };
    }
  }

  return NextResponse.json({ success: true, contact, netsuite });
}

/**
 * DELETE /api/prospects/contacts?id=<prospect_contacts.id>
 *
 * Deletes a contact. When the contact is linked to a NetSuite contact, the
 * NetSuite record is deleted FIRST — a local-only delete would resurrect on
 * the next bulk contact sync — and a NetSuite failure (usually permissions)
 * aborts the whole delete so the two systems never diverge. A NetSuite 404
 * counts as already-deleted. Pass &netsuite=0 to skip the NetSuite side
 * deliberately (the sync-resurrection caveat then applies).
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const id = req.nextUrl.searchParams.get('id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const skipNetsuite = req.nextUrl.searchParams.get('netsuite') === '0';

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: contact } = await supabase.from('prospect_contacts')
    .select('id, name, netsuite_contact_id').eq('id', id).maybeSingle();
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

  let netsuiteDeleted = false;
  if (contact.netsuite_contact_id && !skipNetsuite) {
    const r = await deleteContact(String(contact.netsuite_contact_id));
    if (!r.success) {
      return NextResponse.json({
        error: `NetSuite refused the delete, so the contact was kept here too (deleting only locally would resurrect it on the next sync): ${r.error}`,
      }, { status: 502 });
    }
    netsuiteDeleted = true;
  }

  const { error } = await supabase.from('prospect_contacts').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true, netsuiteDeleted });
}
