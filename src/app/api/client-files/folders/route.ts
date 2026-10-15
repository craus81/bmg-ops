import { NextRequest, NextResponse } from 'next/server';
import { requireStaff, requireAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { looseOrFilter } from '@/lib/loose-search';
import { fetchAllRows } from '@/lib/fetch-all';
import { deepLinks } from '@/lib/deep-links';
import { matchFolder, prepareCustomers } from '@/lib/client-files';

export const dynamic = 'force-dynamic';

const ListSchema = z.object({
  /** review = the close calls waiting for a person; linked; unlinked; all. */
  show: z.enum(['review', 'linked', 'unlinked', 'all']).optional(),
  q: z.string().trim().max(100).optional(),
  /** Folders linked to (or suggested for) one customer — the customer page. */
  customer: z.string().uuid().optional(),
});

const FOLDER_COLS = 'id, name, customer_id, match_status, match_score, candidates, matched_at, file_count, total_bytes, latest_modified, customer:customers(id, company_name, netsuite_id)';

function shape(f: any) {
  return {
    id: f.id,
    name: f.name,
    status: f.match_status as string,
    score: f.match_score != null ? Number(f.match_score) : null,
    candidates: Array.isArray(f.candidates) ? f.candidates : [],
    fileCount: f.file_count ?? 0,
    totalBytes: Number(f.total_bytes) || 0,
    latestModified: f.latest_modified,
    customer: f.customer ? {
      id: f.customer.id,
      name: f.customer.company_name,
      link: f.customer.netsuite_id ? deepLinks.customerByNetsuiteId(f.customer.netsuite_id) : null,
    } : null,
  };
}

/**
 * GET /api/client-files/folders — Dropbox client folders and the customer
 * each is matched to (migration 379), for the "Check matches" list on the
 * Client Files page and the customer page. All internal staff may look.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = validateSearchParams(req, ListSchema);
  if (parsed.error) return parsed.error;
  const { show = 'review', q, customer } = parsed.data;
  const service = createServiceClient();

  try {
    if (customer) {
      // Linked folders, plus folders still waiting where this customer is a candidate.
      const [linked, waiting] = await Promise.all([
        service.from('dropbox_client_folders').select(FOLDER_COLS)
          .eq('customer_id', customer).is('deleted_at', null).order('name'),
        service.from('dropbox_client_folders').select(FOLDER_COLS)
          .eq('match_status', 'suggested').is('deleted_at', null)
          .contains('candidates', JSON.stringify([{ customer_id: customer }])),
      ]);
      if (linked.error) throw new Error(linked.error.message);
      if (waiting.error) throw new Error(waiting.error.message);
      return NextResponse.json({
        linked: (linked.data || []).map(shape),
        suggested: (waiting.data || []).map(shape),
      });
    }

    const { data, error } = await fetchAllRows<any>((from, to) => {
      let query = service.from('dropbox_client_folders').select(FOLDER_COLS)
        .is('deleted_at', null).order('name').order('id').range(from, to);
      if (show === 'review') query = query.eq('match_status', 'suggested');
      if (show === 'linked') query = query.not('customer_id', 'is', null);
      if (show === 'unlinked') query = query.is('customer_id', null);
      const filter = looseOrFilter(['name'], q);
      if (filter) query = query.or(filter);
      return query;
    });
    if (error) throw new Error(error.message);

    const { data: all } = await service.from('dropbox_client_folders')
      .select('match_status').is('deleted_at', null);
    const counts: Record<string, number> = { auto: 0, confirmed: 0, suggested: 0, unmatched: 0, none: 0 };
    for (const r of (all || []) as { match_status: string }[]) counts[r.match_status] = (counts[r.match_status] || 0) + 1;

    return NextResponse.json({ folders: data.map(shape), counts });
  } catch (e: any) {
    console.error('[client-files] folders failed:', e?.message || e);
    return NextResponse.json({ error: e?.message || 'Could not load folders' }, { status: 500 });
  }
}

const SetSchema = z.object({
  folderId: z.string().uuid(),
  /** link = this customer; none = no customer for this folder; reset = forget the choice and match again. */
  action: z.enum(['link', 'none', 'reset']),
  customerId: z.string().uuid().optional(),
});

/**
 * POST /api/client-files/folders — an admin settles a folder's customer.
 * A person's choice sticks: the sync never re-matches confirmed or none.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, SetSchema);
  if (parsed.error) return parsed.error;
  const { folderId, action, customerId } = parsed.data;
  const service = createServiceClient();
  const now = new Date().toISOString();

  try {
    const { data: folder, error: fErr } = await service.from('dropbox_client_folders')
      .select('id, name').eq('id', folderId).maybeSingle();
    if (fErr) throw new Error(fErr.message);
    if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });

    let patch: Record<string, unknown>;
    if (action === 'link') {
      if (!customerId) return NextResponse.json({ error: 'Pick a customer' }, { status: 400 });
      const { data: cust } = await service.from('customers').select('id').eq('id', customerId).maybeSingle();
      if (!cust) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
      patch = { customer_id: customerId, match_status: 'confirmed', matched_at: now, matched_by: auth.user.id };
    } else if (action === 'none') {
      patch = { customer_id: null, match_status: 'none', matched_at: now, matched_by: auth.user.id };
    } else {
      const { data: customers, error: cErr } = await fetchAllRows<{ id: string; company_name: string | null; active: boolean | null }>((from, to) =>
        service.from('customers').select('id, company_name, active')
          .not('company_name', 'is', null).order('id').range(from, to));
      if (cErr) throw new Error(cErr.message);
      const m = matchFolder(folder.name, prepareCustomers(customers.map(c => ({ id: c.id, name: c.company_name || '', active: c.active }))));
      patch = {
        customer_id: m.customerId, match_status: m.status, match_score: m.score, candidates: m.candidates,
        matched_at: m.status === 'auto' ? now : null, matched_by: null,
      };
    }

    const { data, error } = await service.from('dropbox_client_folders')
      .update({ ...patch, updated_at: now }).eq('id', folderId).select(FOLDER_COLS).single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ folder: shape(data) });
  } catch (e: any) {
    console.error('[client-files] folder update failed:', e?.message || e);
    return NextResponse.json({ error: e?.message || 'Could not save' }, { status: 500 });
  }
}
