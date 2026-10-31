import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { MATERIAL_KINDS, cleanOptionName, groupMaterialOptions, type MaterialOption } from '@/lib/graphics-material-options';

export const dynamic = 'force-dynamic';

/**
 * Graphics job material drop-downs (migration 459). Reading is staff —
 * everyone who opens a graphics job needs the lists; adding and removing
 * is admin, since a change shows on every job screen.
 */

function getSupabase() {
  return createServiceClient();
}

async function loadLists() {
  const { data, error } = await getSupabase()
    .from('graphics_material_options')
    .select('id, kind, name, sort_order')
    .order('sort_order')
    .order('name');
  if (error) return { error: error.message };
  return { lists: groupMaterialOptions((data as MaterialOption[]) || []) };
}

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const res = await loadLists();
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json(res);
}

const AddSchema = z.object({
  kind: z.enum(MATERIAL_KINDS),
  name: z.string().min(1).max(120),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, AddSchema);
  if (parsed.error) return parsed.error;
  const name = cleanOptionName(parsed.data.name);
  if (!name) return NextResponse.json({ error: 'Type a name first.' }, { status: 400 });
  const kind = parsed.data.kind;

  const service = getSupabase();
  const { data: existing } = await service
    .from('graphics_material_options')
    .select('id, name, sort_order')
    .eq('kind', kind);
  const rows = (existing || []) as { id: string; name: string; sort_order: number }[];
  // Already on the list (any case): nothing to add, just hand back the lists.
  if (!rows.some(r => r.name.toLowerCase() === name.toLowerCase())) {
    const nextSort = rows.reduce((m, r) => Math.max(m, r.sort_order), 0) + 10;
    const { data: inserted, error } = await service
      .from('graphics_material_options')
      .insert({ kind, name, sort_order: nextSort, created_by: auth.user.id })
      .select('id')
      .single();
    // 23505 = someone added the same name a moment ago; that's fine.
    if (error && error.code !== '23505') return NextResponse.json({ error: error.message }, { status: 500 });
    if (inserted) {
      await logAudit(service, {
        actorId: auth.user.id,
        table: 'graphics_material_options',
        recordId: inserted.id,
        action: 'add',
        detail: { kind, name },
      });
    }
  }

  const res = await loadLists();
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json(res);
}

const RemoveSchema = z.object({ id: z.string().uuid() });

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, RemoveSchema);
  if (parsed.error) return parsed.error;

  const service = getSupabase();
  const { data: removed, error } = await service
    .from('graphics_material_options')
    .delete()
    .eq('id', parsed.data.id)
    .select('kind, name')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (removed) {
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'graphics_material_options',
      recordId: parsed.data.id,
      action: 'remove',
      detail: removed,
    });
  }

  const res = await loadLists();
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json(res);
}
