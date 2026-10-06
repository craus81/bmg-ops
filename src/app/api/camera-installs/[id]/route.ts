import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff, getProfileRoles } from '@/lib/api-auth';
import { isAdminRole } from '@/lib/features';
import { validateBody, z } from '@/lib/validate';
import { CAMERA_INSTALL_SELECT, cameraInstallFields, findCheckinId, imeiConflicts, withInstallerName } from '@/lib/camera-install-server';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const IdSchema = z.string().uuid();

async function load(id: string) {
  const { data } = await service.from('camera_installs').select(CAMERA_INSTALL_SELECT).eq('id', id).maybeSingle();
  return data ? withInstallerName(data) : null;
}

/** GET /api/camera-installs/[id] */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const { id } = params;
  if (!IdSchema.safeParse(id).success) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const install = await load(id);
  if (!install) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ install });
}

const UpdateSchema = z.object({
  customer_id: z.string().uuid().nullable().optional(),
  customer_name: z.string().trim().min(1).max(200),
  contact_name: z.string().trim().max(200).nullable().optional(),
  contact_phone: z.string().trim().max(40).nullable().optional(),
  contact_email: z.string().trim().max(200).nullable().optional(),
  vin: z.string().trim().length(17),
  vehicle_year: z.string().trim().max(8).nullable().optional(),
  vehicle_make: z.string().trim().max(100).nullable().optional(),
  vehicle_model: z.string().trim().max(100).nullable().optional(),
  odometer: z.number().int().min(0).max(9_999_999).nullable().optional(),
  license_plate: z.string().trim().max(20).nullable().optional(),
  camera_imei: z.string().trim().max(32),
  go9b_imei: z.string().trim().max(32),
  notes: z.string().trim().max(2000).nullable().optional(),
  allowDuplicate: z.boolean().optional(),
});

/** The tech who did the install, or an admin. */
function canEdit(auth: { user: any; profile?: any }, row: { installed_by: string | null }) {
  return row.installed_by === auth.user?.id || isAdminRole(getProfileRoles(auth.profile));
}

/** PATCH /api/camera-installs/[id] — correct an install (full replace of the editable fields). */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const { id } = params;
  if (!IdSchema.safeParse(id).success) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const existing = await load(id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canEdit(auth, existing)) return NextResponse.json({ error: 'Only the tech who did this install or an admin can change it.' }, { status: 403 });

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;
  const fields = cameraInstallFields(parsed.data);
  if ('error' in fields) return NextResponse.json({ error: fields.error }, { status: 400 });

  if (!parsed.data.allowDuplicate) {
    const conflict = await imeiConflicts(service, fields.values, id);
    if (conflict) return NextResponse.json({ error: conflict, duplicate: true }, { status: 409 });
  }

  const checkinId = fields.values.vin === existing.vin
    ? (existing.checkin_id || await findCheckinId(service, fields.values.vin))
    : await findCheckinId(service, fields.values.vin);

  const { data, error } = await service
    .from('camera_installs')
    .update({ ...fields.values, checkin_id: checkinId, updated_by: auth.user!.id, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(CAMERA_INSTALL_SELECT)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ install: withInstallerName(data) });
}

/** DELETE /api/camera-installs/[id] — admins only (a mistaken entry). */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!isAdminRole(getProfileRoles(auth.profile))) return NextResponse.json({ error: 'Only an admin can delete an install.' }, { status: 403 });
  const { id } = params;
  if (!IdSchema.safeParse(id).success) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { error } = await service.from('camera_installs').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
