import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { escapeIlike } from '@/lib/customer-dupes';
import type { CameraInstall } from '@/lib/camera-install';
import { CAMERA_INSTALL_SELECT, cameraInstallFields, findCheckinId, imeiConflicts, withInstallerName } from '@/lib/camera-install-server';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/camera-installs — every camera install, newest first.
 * Optional ?customer= (exact name) and ?q= (VIN, IMEI, customer or plate).
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const customer = req.nextUrl.searchParams.get('customer')?.trim() || '';
  const q = (req.nextUrl.searchParams.get('q') || '').trim().slice(0, 60);

  const { data, error } = await fetchAllRows<any>((from, to) => {
    let query = service.from('camera_installs').select(CAMERA_INSTALL_SELECT);
    if (customer) query = query.eq('customer_name', customer);
    if (q) {
      const e = escapeIlike(q).replace(/[,()]/g, ' ');
      query = query.or([
        `vin.ilike.%${e}%`, `camera_imei.ilike.%${e}%`, `go9b_imei.ilike.%${e}%`,
        `customer_name.ilike.%${e}%`, `license_plate.ilike.%${e}%`,
      ].join(','));
    }
    return query.order('installed_at', { ascending: false }).order('id').range(from, to);
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ installs: (data || []).map(withInstallerName) });
}

const CreateSchema = z.object({
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
  /** Save even though an IMEI is already on another install (device moved). */
  allowDuplicate: z.boolean().optional(),
});

/**
 * POST /api/camera-installs — save one vehicle's camera install.
 * Re-checks both IMEIs (15 digits + Luhn) and refuses an IMEI already
 * recorded on a different VIN unless the tech confirms (409 → allowDuplicate).
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, CreateSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const fields = cameraInstallFields(body);
  if ('error' in fields) return NextResponse.json({ error: fields.error }, { status: 400 });

  if (!body.allowDuplicate) {
    const conflict = await imeiConflicts(service, fields.values, null);
    if (conflict) return NextResponse.json({ error: conflict, duplicate: true }, { status: 409 });
  }

  const checkinId = await findCheckinId(service, fields.values.vin);
  const { data, error } = await service
    .from('camera_installs')
    .insert({
      ...fields.values,
      checkin_id: checkinId,
      installed_by: auth.user!.id,
      updated_by: auth.user!.id,
    })
    .select(CAMERA_INSTALL_SELECT)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ install: withInstallerName(data) as CameraInstall });
}
