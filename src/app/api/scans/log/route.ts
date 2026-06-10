import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logScan, resolveScannerCompany } from '@/lib/scan-log';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  vin: z.string().trim().min(5).max(17),
  vehicle_year: z.string().trim().max(8).optional().nullable(),
  vehicle_make: z.string().trim().max(100).optional().nullable(),
  vehicle_model: z.string().trim().max(100).optional().nullable(),
  vehicle_trim: z.string().trim().max(100).optional().nullable(),
  body_class: z.string().trim().max(100).optional().nullable(),
  part_number: z.string().trim().max(120).optional().nullable(),
  part_description: z.string().trim().max(500).optional().nullable(),
  billable_customer: z.string().trim().max(200).optional().nullable(),
  unit_number: z.string().trim().max(60).optional().nullable(),
  serial_number: z.string().trim().max(64).optional().nullable(),
  imei: z.string().trim().max(32).optional().nullable(),
  iccid: z.string().trim().max(32).optional().nullable(),
  location_id: z.string().uuid().optional().nullable(),
  location_name: z.string().trim().max(200).optional().nullable(),
});

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Unified scan-logging endpoint. Every scan (admin, BMG field installer, CNI
 * installer free-scan) writes through here so the logic — validation, dedup,
 * company stamping — lives in one place. The CNI job flow uses the same logScan
 * helper from its own route, where it also drives job/VIN completion.
 *
 * The company is derived from the signed-in account, never trusted from the
 * client.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  // Only approved internal staff or CNI installers may log scans.
  const { data: profile } = await service
    .from('profiles').select('role, roles, status').eq('id', auth.user.id).single();
  if (!profile || profile.status !== 'approved') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const roles: string[] = profile.roles?.length ? profile.roles : (profile.role ? [profile.role] : []);
  if (roles.includes('customer') && roles.length === 1) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const company = await resolveScannerCompany(service, auth.user.id);
  const result = await logScan(service, auth.user.id, company, parsed.data);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ success: true, scanLogId: result.scanLogId });
}
