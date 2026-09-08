import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { blockedFromChecking, packProgress, packSummaryNote, type PackItem } from '@/lib/pack-checklist';
import { packingListFromJob } from '@/lib/packing-list-pdf';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Digital pack & ship checklist (R6-4). Built from the SAME lines the
 * packing-list PDF assembles (packingListFromJob), so the sheet on screen
 * and the sheet in the printer can never disagree.
 *
 * The control: a packer cannot verify their own line. Checked here with a
 * readable message, and again by a database CHECK so no future call site
 * can skip it.
 */

const toItem = (r: any): PackItem => ({
  id: r.id,
  lineIndex: r.line_index,
  partNumber: r.part_number,
  description: r.description,
  quantityExpected: r.quantity_expected != null ? Number(r.quantity_expected) : null,
  quantityPacked: r.quantity_packed != null ? Number(r.quantity_packed) : null,
  packedBy: r.packed_by,
  packedAt: r.packed_at,
  checkedBy: r.checked_by,
  checkedAt: r.checked_at,
  photoPath: r.photo_path,
  notes: r.notes,
});

const SELECT = 'id, line_index, part_number, description, quantity_expected, quantity_packed, packed_by, packed_at, checked_by, checked_at, photo_path, notes';

async function loadItems(jobId: string) {
  const { data, error } = await service
    .from('graphics_pack_items').select(SELECT)
    .eq('graphics_job_id', jobId).order('line_index');
  if (error) throw new Error(error.message);
  return (data || []).map(toItem);
}

/** Names for the stamps, so the bench sees people not UUIDs. */
async function loadNames(items: PackItem[]) {
  const ids = [...new Set(items.flatMap(i => [i.packedBy, i.checkedBy]).filter(Boolean))] as string[];
  if (ids.length === 0) return {};
  const { data } = await service.from('profiles').select('id, full_name').in('id', ids);
  return Object.fromEntries((data || []).map((p: any) => [p.id, p.full_name || 'Someone']));
}

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, z.object({ jobId: z.string().uuid() }));
  if (q.error) return q.error;

  try {
    const items = await loadItems(q.data.jobId);
    return NextResponse.json({
      items,
      names: await loadNames(items),
      progress: packProgress(items),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to load the checklist' }, { status: 500 });
  }
}

/**
 * Build (or top up) the checklist from the job's packing-list lines.
 * Existing rows are left alone — regenerating must never erase a stamp
 * somebody already earned.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, z.object({ jobId: z.string().uuid() }));
  if (parsed.error) return parsed.error;
  const { jobId } = parsed.data;

  const { data: job } = await service.from('graphics_jobs').select('*').eq('id', jobId).maybeSingle();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { lines } = packingListFromJob(job as any);
  const existing = await loadItems(jobId);
  const haveIndexes = new Set(existing.map(i => i.lineIndex));

  const toInsert = lines
    .map((l, idx) => ({ l, idx }))
    .filter(({ idx }) => !haveIndexes.has(idx))
    .map(({ l, idx }) => ({
      graphics_job_id: jobId,
      line_index: idx,
      part_number: l.partNumber || null,
      description: l.description || null,
      quantity_expected: l.quantity ?? null,
    }));

  if (toInsert.length > 0) {
    const { error } = await service.from('graphics_pack_items').insert(toInsert);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const items = await loadItems(jobId);
  return NextResponse.json({ items, names: await loadNames(items), progress: packProgress(items), added: toInsert.length });
}

const PatchSchema = z.object({
  itemId: z.string().uuid(),
  action: z.enum(['pack', 'unpack', 'check', 'photo', 'note']),
  quantityPacked: z.number().min(0).max(100000).nullable().optional(),
  photoPath: z.string().max(500).nullable().optional(),
  notes: z.string().max(500).optional(),
});

export async function PATCH(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const { itemId, action, quantityPacked, photoPath, notes } = parsed.data;

  const { data: row } = await service.from('graphics_pack_items').select(`${SELECT}, graphics_job_id`).eq('id', itemId).maybeSingle();
  if (!row) return NextResponse.json({ error: 'Line not found' }, { status: 404 });
  const item = toItem(row);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { updated_at: now };

  switch (action) {
    case 'pack':
      patch.packed_by = auth.user.id;
      patch.packed_at = now;
      patch.quantity_packed = quantityPacked ?? item.quantityExpected ?? null;
      break;
    case 'unpack':
      // Undoing a pack clears the verification with it — a signature on a
      // line that was re-opened means nothing.
      patch.packed_by = null;
      patch.packed_at = null;
      patch.quantity_packed = null;
      patch.checked_by = null;
      patch.checked_at = null;
      break;
    case 'check': {
      const blocked = blockedFromChecking(item, auth.user.id);
      if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });
      patch.checked_by = auth.user.id;
      patch.checked_at = now;
      break;
    }
    case 'photo':
      patch.photo_path = photoPath ?? null;
      patch.photo_uploaded_by = photoPath ? auth.user.id : null;
      patch.photo_uploaded_at = photoPath ? now : null;
      break;
    case 'note':
      patch.notes = notes?.trim() || null;
      break;
  }

  const { error } = await service.from('graphics_pack_items').update(patch).eq('id', itemId);
  if (error) {
    // The database CHECK is the last line of defence for the two-person
    // rule; translate it rather than leaking a constraint name.
    if (String(error.message).includes('pack_check_is_second_person')) {
      return NextResponse.json({ error: 'Someone else has to verify what you packed.' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const items = await loadItems(row.graphics_job_id);
  const progress = packProgress(items);

  // Stamp the activity feed the moment the last line is verified — once.
  if (action === 'check' && progress.complete) {
    await service.from('graphics_status_history').insert({
      job_id: row.graphics_job_id,
      from_status: null,
      to_status: 'packing',
      changed_by: auth.user.id,
      note: packSummaryNote(progress),
    });
  }

  return NextResponse.json({ items, names: await loadNames(items), progress });
}
