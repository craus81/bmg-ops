import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Customer-friendly status language — no internal jargon.
const VEHICLE_STATUS: Record<string, { label: string; color: string }> = {
  received: { label: 'Received', color: '#94a3b8' },
  in_progress: { label: 'In progress', color: '#60a5fa' },
  stuck_parts: { label: 'Waiting on parts', color: '#fbbf24' },
  stuck_graphics: { label: 'Waiting on graphics', color: '#fbbf24' },
  complete: { label: 'Ready for pickup', color: '#22c55e' },
  shipped: { label: 'Shipped', color: '#22c55e' },
};

const GRAPHICS_STATUS: Record<string, string> = {
  flagged: 'Received', received: 'Received', designing: 'In design', revision: 'In design',
  printing: 'In production', outgassing: 'In production', cutting: 'In production', packing: 'In production',
  ready: 'Ready', ready_to_pickup: 'Ready for pickup', shipped: 'Shipped',
  picked_up: 'Picked up', installed: 'Installed', cancelled: 'Cancelled',
};
const GRAPHICS_ACTIVE = ['flagged', 'received', 'designing', 'revision', 'printing', 'outgassing', 'cutting', 'packing', 'ready'];

const vehicleView = (v: any) => ({
  id: v.id,
  vin: v.vin,
  label: [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || `VIN …${String(v.vin || '').slice(-8)}`,
  status: v.status,
  statusLabel: VEHICLE_STATUS[v.status]?.label || v.status,
  statusColor: VEHICLE_STATUS[v.status]?.color || '#94a3b8',
  checkedInAt: v.created_at,
  updatedAt: v.updated_at,
  completedAt: v.qc_completed_at,
  photos: [] as { url: string; takenAt: string | null }[],
});

/**
 * GET /api/customer/portal — everything a customer's login should see,
 * scoped automatically by profiles.customer_netsuite_id → their synced
 * customers row → name-matched vehicles and graphics orders. Service-role
 * on the server keeps RLS closed; the scoping happens right here. Admins
 * can pass ?customerId=<netsuite_id> to preview any customer's portal.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const roles: string[] = auth.profile?.roles?.length ? auth.profile.roles : [auth.profile?.role];
  const isAdmin = roles.includes('admin');
  const isCustomer = roles.includes('customer');
  if (!isCustomer && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const previewId = req.nextUrl.searchParams.get('customerId')?.trim() || '';
  let customerNetsuiteId: string | null = null;
  if (isAdmin && previewId) {
    customerNetsuiteId = previewId;
  } else {
    const { data: profile } = await service
      .from('profiles')
      .select('customer_netsuite_id')
      .eq('id', auth.user!.id)
      .maybeSingle();
    customerNetsuiteId = profile?.customer_netsuite_id || null;
  }
  if (!customerNetsuiteId) {
    return NextResponse.json({ linked: false, vehicles: { active: [], recent: [], history: [] }, graphics: { active: [], recent: [] } });
  }

  const { data: customer } = await service
    .from('customers')
    .select('netsuite_id, company_name, entity_id')
    .eq('netsuite_id', customerNetsuiteId)
    .maybeSingle();
  if (!customer) {
    return NextResponse.json({ linked: false, vehicles: { active: [], recent: [], history: [] }, graphics: { active: [], recent: [] } });
  }

  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [vehiclesRes, graphicsRes] = await Promise.all([
    service
      .from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, status, customer_name, created_at, updated_at, qc_completed_at')
      .ilike('customer_name', customer.company_name)
      .order('updated_at', { ascending: false })
      .limit(500),
    service
      .from('graphics_jobs')
      .select('id, title, job_number, status, customer, tracking_number, carrier, scheduled_install_date, created_at, updated_at')
      .ilike('customer', customer.company_name)
      .neq('status', 'cancelled')
      .order('updated_at', { ascending: false })
      .limit(200),
  ]);

  const vehicles = (vehiclesRes.data || []).map(vehicleView);
  const active = vehicles.filter(v => ['received', 'in_progress', 'stuck_parts', 'stuck_graphics'].includes(v.status));
  const done = vehicles.filter(v => ['complete', 'shipped'].includes(v.status));
  const recent = done.filter(v => (v.completedAt || v.updatedAt) >= monthAgo);
  const history = done.filter(v => (v.completedAt || v.updatedAt) < monthAgo).slice(0, 100);

  // Completion photos only — progress/damage shots are internal working
  // material, finished-work photos are the customer's deliverable proof.
  const photoTargets = [...active, ...recent];
  if (photoTargets.length > 0) {
    const ids = photoTargets.map(v => v.id);
    const photos: { vehicle_id: string; storage_path: string; taken_at: string | null }[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await service
        .from('vehicle_photos')
        .select('vehicle_id, storage_path, taken_at')
        .in('vehicle_id', ids.slice(i, i + 200))
        .eq('photo_type', 'completion')
        .order('taken_at', { ascending: false });
      photos.push(...((data || []) as typeof photos));
    }
    const r2Base = process.env.NEXT_PUBLIC_R2_PUBLIC_URL || '';
    const photoUrl = (path: string) => r2Base ? `${r2Base}/photos/${path}` : `/api/storage?bucket=photos&path=${encodeURIComponent(path)}`;
    const byVehicle = new Map<string, { url: string; takenAt: string | null }[]>();
    for (const p of photos) {
      const arr = byVehicle.get(p.vehicle_id) || [];
      if (arr.length < 6) arr.push({ url: photoUrl(p.storage_path), takenAt: p.taken_at });
      byVehicle.set(p.vehicle_id, arr);
    }
    for (const v of photoTargets) v.photos = byVehicle.get(v.id) || [];
  }

  const graphicsView = (g: any) => ({
    id: g.id,
    title: g.title || `Order ${g.job_number || ''}`.trim(),
    jobNumber: g.job_number,
    status: g.status,
    statusLabel: GRAPHICS_STATUS[g.status] || g.status,
    trackingNumber: g.tracking_number,
    carrier: g.carrier,
    scheduledInstallDate: g.scheduled_install_date,
    updatedAt: g.updated_at,
  });
  const graphicsActive = (graphicsRes.data || []).filter(g => GRAPHICS_ACTIVE.includes(g.status)).map(graphicsView);
  const graphicsRecent = (graphicsRes.data || [])
    .filter(g => !GRAPHICS_ACTIVE.includes(g.status) && g.updated_at >= monthAgo)
    .map(graphicsView);

  return NextResponse.json({
    linked: true,
    companyName: customer.company_name,
    vehicles: { active, recent, history },
    graphics: { active: graphicsActive, recent: graphicsRecent },
  });
}
