import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { r2Get } from '@/lib/r2';
import { validateBody, z } from '@/lib/validate';
import {
  computeCalibration,
  parseScaleFactor,
  parseVectorArtboardDetailed,
  parseImageSize,
} from '@/lib/template-calibration';
import { auditTemplate, type AuditInput, type TemplateAudit } from '@/lib/calibration-audit';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const AuditSchema = z.object({
  // Same cursor pagination as /calibrate-templates: a library of thousands
  // can't be read inside one request's timeout.
  cursor: z.string().uuid().optional().nullable(),
  batchSize: z.number().int().positive().max(50).optional(),
});

async function fetchBytes(path: string | null): Promise<Uint8Array | null> {
  if (!path) return null;
  try {
    if (path.startsWith('http')) {
      const res = await fetch(path);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    }
    const r = await r2Get('vehicle-templates', path);
    if (!r.success || !r.body) return null;
    return new Uint8Array(await new Response(r.body).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * POST /api/admin/calibration-audit
 *
 * READ-ONLY. Re-derives each template's scale from its vector artboard and
 * preview, compares that to the scale the estimator is measuring with
 * today, and reports the evidence: which box the artboard came from, how
 * much of the preview the vehicle covers, and whether a person has ever
 * overridden the scale by hand. Writes nothing — the point is to find out
 * whether the library's square footages can be trusted before anybody
 * changes a number. Loop with nextCursor until it comes back null, then
 * summarize the batches client-side.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, AuditSchema);
  if (parsed.error) return parsed.error;
  const batchSize = parsed.data.batchSize ?? 20;

  // Retired templates are kept for quote history but nobody draws on them.
  let query = supabase
    .from('vehicle_templates')
    .select('id, name, make, model, year, variant, scale, px_per_in, overall_length_in, original_file_path, template_image_path, is_active')
    .order('id', { ascending: true })
    .limit(batchSize);
  if (parsed.data.cursor) query = query.gt('id', parsed.data.cursor);

  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const audits: TemplateAudit[] = [];

  for (const row of rows || []) {
    if (row.is_active === false) continue;
    const label = [row.year, row.make, row.model, row.variant].filter(Boolean).join(' ') || row.name;
    const scaleFactor = parseScaleFactor(row.scale);
    const [vec, img] = await Promise.all([
      fetchBytes(row.original_file_path),
      fetchBytes(row.template_image_path),
    ]);

    const artboard = vec ? parseVectorArtboardDetailed(vec) : null;
    const image = img ? parseImageSize(img) : null;
    const recomputed = vec && img ? computeCalibration(vec, img, scaleFactor) : null;

    const input: AuditInput = {
      id: row.id,
      label,
      storedPxPerIn: row.px_per_in == null ? null : Number(row.px_per_in),
      overallLengthIn: row.overall_length_in == null ? null : Number(row.overall_length_in),
      artboard,
      image,
      scaleFactor,
      recomputedPxPerIn: recomputed?.pxPerIn ?? null,
      letterboxed: recomputed?.reason === 'ok-letterboxed',
    };
    audits.push(auditTemplate(input));
  }

  const nextCursor = (rows || []).length === batchSize ? rows![rows!.length - 1].id : null;

  return NextResponse.json({ success: true, audits, nextCursor });
}
