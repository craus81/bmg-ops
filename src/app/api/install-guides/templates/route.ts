import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import {
  templateFromGuide, guideFromTemplate, rankTemplates, templateSummary,
  parseVehicleDesc, type GuideLike,
} from '@/lib/guide-templates';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const GUIDE_COLS = 'id, title, customer_name, vehicle_desc, scale, units, fraction_denominator, '
  + 'pages, sections, is_template, template_name, template_year, template_make, template_model, '
  + 'graphics_job_id, cni_job_id, fleet_checkin_id, created_at, updated_at';

const ListSchema = z.object({
  /** Rank against this vehicle. Free text; parsed server-side. */
  vehicleDesc: z.string().trim().max(200).optional(),
  year: z.string().trim().max(8).optional(),
  make: z.string().trim().max(60).optional(),
  model: z.string().trim().max(120).optional(),
});

const SaveSchema = z.object({
  action: z.literal('save_as_template'),
  guideId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  year: z.string().trim().max(8).optional().nullable(),
  make: z.string().trim().max(60).optional().nullable(),
  model: z.string().trim().max(120).optional().nullable(),
});

const NewSchema = z.object({
  action: z.literal('new_from_template'),
  templateId: z.string().uuid(),
  title: z.string().trim().max(200).optional().nullable(),
  customerName: z.string().trim().max(200).optional().nullable(),
  vehicleDesc: z.string().trim().max(200).optional().nullable(),
  graphicsJobId: z.string().uuid().optional().nullable(),
  cniJobId: z.string().uuid().optional().nullable(),
  fleetCheckinId: z.string().uuid().optional().nullable(),
});

const BodySchema = z.union([SaveSchema, NewSchema]);

/**
 * GET /api/install-guides/templates — templates, ranked for a vehicle.
 *
 * Every template is returned, ranked, never filtered: a coordinator who
 * knows the Sprinter template is the right starting point for an odd
 * build must still be able to reach it. Non-matches sort last and carry
 * their reason.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = validateSearchParams(req, ListSchema);
  if (parsed.error) return parsed.error;
  const q = parsed.data;

  const { data, error } = await supabase
    .from('install_guides')
    .select(GUIDE_COLS)
    .eq('is_template', true)
    .order('template_make')
    .order('template_model')
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Explicit fields win; the free-text line only fills what they leave out.
  const parsedDesc = parseVehicleDesc(q.vehicleDesc);
  const vehicle = {
    year: q.year || parsedDesc.year,
    make: q.make || parsedDesc.make,
    model: q.model || parsedDesc.model,
  };

  const ranked = rankTemplates((data || []) as GuideLike[], vehicle).map(m => ({
    id: m.template.id,
    name: m.template.template_name || m.template.title,
    year: m.template.template_year,
    make: m.template.template_make,
    model: m.template.template_model,
    score: m.score,
    reason: m.reason,
    summary: templateSummary(m.template),
  }));

  return NextResponse.json({ success: true, templates: ranked, vehicle });
}

/** POST — save a guide as a template, or start a guide from one. */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, BodySchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  if (body.action === 'save_as_template') {
    const { data: guide, error } = await supabase
      .from('install_guides').select(GUIDE_COLS).eq('id', body.guideId).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!guide) return NextResponse.json({ error: 'Guide not found' }, { status: 404 });

    // The vehicle: what they typed, else parsed from the guide's own line.
    const fallback = parseVehicleDesc((guide as any).vehicle_desc);
    const row = templateFromGuide(guide as GuideLike, body.name, {
      year: body.year || fallback.year,
      make: body.make || fallback.make,
      model: body.model || fallback.model,
    });

    const { data: created, error: insErr } = await supabase
      .from('install_guides')
      .insert({ ...row, created_by: auth.user.id })
      .select('id, template_name')
      .single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    return NextResponse.json({ success: true, templateId: created.id, name: created.template_name });
  }

  // new_from_template
  const { data: template, error } = await supabase
    .from('install_guides').select(GUIDE_COLS).eq('id', body.templateId).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!template) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  if (!(template as any).is_template) {
    return NextResponse.json({ error: 'That guide is not a template.' }, { status: 400 });
  }

  const row = guideFromTemplate(template as GuideLike, {
    title: body.title,
    customerName: body.customerName,
    vehicleDesc: body.vehicleDesc,
    graphicsJobId: body.graphicsJobId,
    cniJobId: body.cniJobId,
    fleetCheckinId: body.fleetCheckinId,
  });

  const { data: created, error: insErr } = await supabase
    .from('install_guides')
    .insert({ ...row, created_by: auth.user.id })
    .select('id')
    .single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  return NextResponse.json({ success: true, guideId: created.id });
}
