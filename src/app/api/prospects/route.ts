import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff, requireAdmin } from '@/lib/api-auth';
import { deleteCustomer, deactivateCustomer } from '@/lib/netsuite';
import { logAudit } from '@/lib/audit';
import { validateBody, z } from '@/lib/validate';
import { findCustomerDuplicates } from '@/lib/customer-dupes';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// DELETE can make two sequential NetSuite calls (delete, then the
// deactivate fallback), each with a 25s client timeout — give the function
// room beyond the platform default.
export const maxDuration = 60;

const ProspectFields = {
  company_name: z.string().trim().max(200),
  contact_name: z.string().max(120).optional().nullable(),
  title: z.string().max(120).optional().nullable(),
  email: z.string().email().max(254).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  address: z.string().max(300).optional().nullable(),
  city: z.string().max(120).optional().nullable(),
  state: z.string().max(40).optional().nullable(),
  zip: z.string().max(20).optional().nullable(),
  website: z.string().max(500).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  source: z.string().max(40).optional(),
  lead_source: z.string().max(120).optional().nullable(),
  created_by: z.string().uuid().optional().nullable(),
} as const;

const CreateProspectSchema = z.object({
  ...ProspectFields,
  record_type: z.enum(['customer', 'vendor']).optional(),
  location_count: z.number().int().min(1).max(10_000).optional(),
  /** Skip the duplicate guard — set only after a human saw the matches. */
  force: z.boolean().optional().default(false),
  /**
   * "Add Record" for an existing NetSuite customer (the ns- record pages):
   * creates the CRM row LINKED, with the identity fields copied from the
   * customers-mirror row this id names — never from the client. Skips the
   * duplicate guard (the "duplicate" it would find is the customer itself)
   * and instead refuses when a CRM row already carries this netsuite_id.
   */
  fromNetsuiteCustomerId: z.union([z.string().max(40), z.number()]).optional().nullable(),
});
// No .passthrough() (Round 3, §7.2.5 — it let any staff caller write ANY
// prospects column, netsuite_id included, unaudited): unknown keys are now
// a loud 400, and the NetSuite identity fields are handled explicitly
// below (admin + audit), never spread into the update.
const UpdateProspectSchema = z
  .object({
    id: z.string().uuid(),
    company_name: z.string().trim().max(200).optional(),
    contact_name: ProspectFields.contact_name,
    title: ProspectFields.title,
    email: ProspectFields.email,
    phone: ProspectFields.phone,
    address: ProspectFields.address,
    city: ProspectFields.city,
    state: ProspectFields.state,
    zip: ProspectFields.zip,
    website: ProspectFields.website,
    notes: ProspectFields.notes,
    source: ProspectFields.source,
    lead_source: ProspectFields.lead_source,
    lead_source_other: z.string().max(120).optional().nullable(),
    record_type: z.enum(['customer', 'vendor']).optional(),
    location_count: z.number().int().min(1).max(10_000).optional(),
    created_by: ProspectFields.created_by,
    /** Re-pointing the NetSuite linkage is admin-only and audit-logged. */
    netsuite_id: z.string().max(40).optional().nullable(),
  })
  .strict();

/** GET /api/prospects — list all prospects */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const { data, error } = await supabase
    .from('prospects')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ prospects: data });
}

/** POST /api/prospects — create a new prospect */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, CreateProspectSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  // "Add Record" mode: the identity comes from the customers mirror, never
  // the client (the browser used to insert netsuite_id directly — migration
  // 254's trigger closes that; this is the sanctioned path).
  if (body.fromNetsuiteCustomerId) {
    const nsId = String(body.fromNetsuiteCustomerId);
    const { data: mirror } = await supabase
      .from('customers')
      .select('id, netsuite_id, netsuite_url, company_name, entity_id, email, phone, address')
      .eq('netsuite_id', nsId)
      .maybeSingle();
    if (!mirror) {
      return NextResponse.json({ error: 'No NetSuite customer with that id is in the local mirror.' }, { status: 404 });
    }
    const { data: already } = await supabase
      .from('prospects').select('id').eq('netsuite_id', nsId).limit(1).maybeSingle();
    if (already) {
      return NextResponse.json({ error: 'This NetSuite customer already has a CRM record.', prospectId: already.id }, { status: 409 });
    }
    const { data, error } = await supabase
      .from('prospects')
      .insert({
        company_name: mirror.company_name || mirror.entity_id || 'Unknown',
        email: mirror.email || null,
        phone: mirror.phone || null,
        address: mirror.address || null,
        status: 'converted',
        netsuite_id: mirror.netsuite_id,
        netsuite_url: mirror.netsuite_url || null,
        created_by: body.created_by || auth.user.id,
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, prospect: data });
  }

  // Shared duplicate guard (audit Stage 1: this path previously had NO
  // check of any kind). 409 carries the matches; a deliberate re-submit
  // with force:true proceeds. This is now ENFORCED for the browser create
  // paths too — they insert through here, so a failed pre-flight can no
  // longer slip an unchecked create past the guard (Round 3, §7.2.5).
  if (!body.force) {
    const matches = await findCustomerDuplicates(supabase, {
      companyName: body.company_name,
      email: body.email,
      phone: body.phone,
      recordType: body.record_type,
    });
    if (matches.length > 0) {
      return NextResponse.json({
        error: 'A record with the same name, email, or phone already exists.',
        matches,
      }, { status: 409 });
    }
  }

  const { data, error } = await supabase
    .from('prospects')
    .insert({
      company_name: body.company_name,
      contact_name: body.contact_name || null,
      title: body.title || null,
      email: body.email || null,
      phone: body.phone || null,
      address: body.address || null,
      city: body.city || null,
      state: body.state || null,
      zip: body.zip || null,
      website: body.website || null,
      notes: body.notes || null,
      source: body.source || 'manual',
      lead_source: body.lead_source || null,
      record_type: body.record_type || 'customer',
      location_count: body.location_count || 1,
      created_by: body.created_by || auth.user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, prospect: data });
}

/** PUT /api/prospects — update a prospect */
export async function PUT(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateProspectSchema);
  if (parsed.error) return parsed.error;
  const { id, netsuite_id, ...fields } = parsed.data;

  // Re-pointing the NetSuite linkage decides which REAL NetSuite customer a
  // later delete destroys and where money documents attach — admin-only,
  // and the old → new pair lands in the audit log (Round 3, §7.2.5).
  const relink = 'netsuite_id' in parsed.data;
  if (relink) {
    const adminAuth = await requireAdmin(req);
    if (adminAuth.error) {
      return NextResponse.json(
        { error: 'Changing the NetSuite linkage needs an admin.' },
        { status: 403 },
      );
    }
    const { data: before } = await supabase
      .from('prospects').select('netsuite_id, company_name').eq('id', id).maybeSingle();
    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'prospects',
      recordId: id,
      action: 'prospect_netsuite_relink',
      detail: {
        company_name: before?.company_name || null,
        from: before?.netsuite_id || null,
        to: netsuite_id || null,
      },
    });
  }

  const { data, error } = await supabase
    .from('prospects')
    .update(relink ? { ...fields, netsuite_id: netsuite_id || null } : fields)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, prospect: data });
}

/**
 * DELETE /api/prospects — delete a record, propagating to NetSuite.
 *
 * Owner decision 2026-08-30: a deletion in FleetSuite deletes in NetSuite.
 * Before this, deleting a linked record removed only the prospects row —
 * the NetSuite customer and the local customers mirror survived, and the
 * next sync resurrected the row (both syncs upsert prospects keyed on
 * netsuite_id).
 *
 * For a linked record: try the NetSuite DELETE first; NetSuite refuses
 * when the customer has transactions, so fall back to marking it inactive
 * — both syncs filter isinactive = 'F', so an inactive customer stops
 * flowing back. If NetSuite can do neither, the local rows are kept and
 * the caller gets the error: deleting locally anyway would recreate the
 * exact resurrection bug this closes.
 *
 * Unlinked leads stay staff-deletable (a rep can remove their own typo);
 * deleting a linked record destroys/deactivates a real NetSuite customer,
 * so it needs an admin (#680 precedent).
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { data: row } = await supabase
    .from('prospects')
    .select('id, company_name, netsuite_id, record_type')
    .eq('id', id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: 'Record not found' }, { status: 404 });

  let netsuite: 'deleted' | 'deactivated' | null = null;
  let mirror: 'deleted' | 'kept_inactive' | null = null;
  let filesOnMirror = 0;
  if (row.netsuite_id) {
    const adminAuth = await requireAdmin(req);
    if (adminAuth.error) {
      return NextResponse.json({
        error: 'This record is linked to a NetSuite customer — deleting it also deletes (or deactivates) the NetSuite record, which needs an admin.',
      }, { status: 403 });
    }

    const del = await deleteCustomer(String(row.netsuite_id));
    if (del.success) {
      netsuite = 'deleted';
    } else {
      // Almost always "has transactions" — deactivate instead.
      const deact = await deactivateCustomer(String(row.netsuite_id));
      if (!deact.success) {
        return NextResponse.json({
          error: `NetSuite refused to delete (${del.error}) and to deactivate (${deact.error}). Nothing was removed — fix the NetSuite side first, or unlink the record.`,
        }, { status: 502 });
      }
      netsuite = 'deactivated';
    }

    // The mirror row would resurrect the CRM record on the next sync run
    // that still sees the customer cached — remove it with the prospect.
    // CHECKED now (Round 3, §7.2.5): wrap_quotes / fleet_checkins FKs have
    // no ON DELETE clause, so a customer with quotes or visits blocks the
    // delete — previously that failure was silent and the stale row lived
    // on. Count the customer_files that ride on the mirror first, so the
    // response can say what the cascade took (W-9s, tax certificates).
    const { data: mirrorRow } = await supabase
      .from('customers').select('id').eq('netsuite_id', row.netsuite_id).maybeSingle();
    if (mirrorRow) {
      const { count } = await supabase
        .from('customer_files')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', mirrorRow.id);
      filesOnMirror = count || 0;
      const { error: mirrorErr } = await supabase
        .from('customers').delete().eq('id', mirrorRow.id);
      if (mirrorErr) {
        // FK-blocked (quotes / check-ins reference it). The NetSuite side is
        // already deleted/deactivated so nothing resurrects via sync — mark
        // the survivor inactive so pickers stop offering it, and say so.
        await supabase.from('customers').update({ active: false }).eq('id', mirrorRow.id);
        mirror = 'kept_inactive';
        filesOnMirror = 0; // nothing cascaded — the row survived
      } else {
        mirror = 'deleted';
      }
    }
  }

  const { error } = await supabase.from('prospects').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'prospects',
    recordId: id,
    action: 'prospect_delete',
    detail: {
      company_name: row.company_name,
      netsuite_id: row.netsuite_id || null,
      netsuite: netsuite || 'not_linked',
      mirror: mirror || 'not_linked',
      files_deleted: filesOnMirror,
    },
  });

  return NextResponse.json({ success: true, netsuite, mirror, filesDeleted: filesOnMirror });
}
