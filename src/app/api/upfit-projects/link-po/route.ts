import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { findPoByNumber } from '@/lib/parts-email-scan';

export const dynamic = 'force-dynamic';

/**
 * Link/unlink a vendor PO to an upfit project by hand (migration 267).
 *
 * create-po links queue-born POs automatically; this route exists for the
 * rest — a PO cut directly in NetSuite arrives via the 2-hourly sync with
 * no purchase_requests rows, so nothing else can tie it to its project.
 * POST resolves the PO (by mirror row id, or by number through the same
 * exact/digits matcher the ETA email scan uses) and inserts the join row;
 * DELETE removes one link by its row id. Both drop a timeline note so the
 * project history says who changed the wiring.
 *
 * Writes run on the service role — upfit_project_pos has no authenticated
 * write policy, keeping source/created_by provenance on every row.
 */

const LinkSchema = z.object({
  projectId: z.string().uuid(),
  poId: z.string().uuid().optional(),
  poNumber: z.string().trim().min(1).max(60).optional(),
}).refine(b => b.poId || b.poNumber, { message: 'Send poId or poNumber.' });

const service = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, LinkSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const supabase = service();

  const { data: project } = await supabase
    .from('upfit_projects')
    .select('id, project_name, netsuite_vendor_po_id')
    .eq('id', body.projectId)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }

  // Resolve to a mirror row. The number path reuses the email scan's
  // matcher so "376" / "PO-376" / "PO376" all land on the same PO.
  let poRowId: string | null = body.poId || null;
  if (!poRowId && body.poNumber) {
    const match = await findPoByNumber(supabase, body.poNumber);
    poRowId = match?.id || null;
  }
  if (!poRowId) {
    return NextResponse.json({
      error: `No synced vendor PO matches "${body.poNumber}". POs sync from NetSuite every couple of hours — if it was just created, try again after the next sync.`,
    }, { status: 404 });
  }
  const { data: po } = await supabase
    .from('netsuite_vendor_pos')
    .select('id, netsuite_id, tranid, vendor_name, status_label, eta_date')
    .eq('id', poRowId)
    .maybeSingle();
  if (!po) {
    return NextResponse.json({ error: 'Vendor PO not found.' }, { status: 404 });
  }

  const { data: inserted, error: linkErr } = await supabase
    .from('upfit_project_pos')
    .upsert({
      project_id: project.id,
      po_id: po.id,
      po_number: po.tranid || null,
      source: 'manual',
      created_by: auth.user.id,
    }, { onConflict: 'project_id,po_id', ignoreDuplicates: true })
    .select('id');
  if (linkErr) {
    return NextResponse.json({ error: linkErr.message }, { status: 500 });
  }
  const alreadyLinked = !inserted || inserted.length === 0;

  if (!alreadyLinked) {
    // First PO still wins the legacy scalar columns — a manual link on a
    // project with no PO yet lights up the readers that predate the join
    // table (page header, ETA email matching) exactly like create-po does.
    if (!project.netsuite_vendor_po_id && po.netsuite_id) {
      await supabase.from('upfit_projects')
        .update({ netsuite_vendor_po_id: po.netsuite_id, netsuite_vendor_po_number: po.tranid || null })
        .eq('id', project.id)
        .is('netsuite_vendor_po_id', null);
    }
    await supabase.from('upfit_project_notes').insert({
      project_id: project.id,
      note_type: 'parts_order',
      content: `Linked vendor PO ${po.tranid || po.netsuite_id}${po.vendor_name ? ` (${po.vendor_name})` : ''}`,
      created_by: auth.user.id,
    });
  }

  return NextResponse.json({
    success: true,
    alreadyLinked,
    linkId: alreadyLinked ? null : inserted![0].id,
    po: { id: po.id, tranid: po.tranid, vendor_name: po.vendor_name, status_label: po.status_label, eta_date: po.eta_date },
  });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const id = req.nextUrl.searchParams.get('id') || '';
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Send the link row id as ?id=' }, { status: 400 });
  }
  const supabase = service();

  const { data: link } = await supabase
    .from('upfit_project_pos')
    .select('id, project_id, po_number')
    .eq('id', id)
    .maybeSingle();
  if (!link) {
    return NextResponse.json({ error: 'Link not found — it may already be removed.' }, { status: 404 });
  }

  const { error: delErr } = await supabase.from('upfit_project_pos').delete().eq('id', id);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }
  await supabase.from('upfit_project_notes').insert({
    project_id: link.project_id,
    note_type: 'parts_order',
    content: `Unlinked vendor PO ${link.po_number || ''}`.trim(),
    created_by: auth.user.id,
  });

  return NextResponse.json({ success: true });
}
