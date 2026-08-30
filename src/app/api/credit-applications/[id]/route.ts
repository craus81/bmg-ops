import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/**
 * GET /api/credit-applications/[id] — the full application (this is the
 * only route that ships tax_id / bank fields to the browser, one record at
 * a time as the reviewer opens it), plus non-authoritative prospect
 * matches. Matching happens at REVIEW time, never at ingest: contact_email
 * is attacker-supplied on a public form, so auto-linking would let a
 * hostile submitter bind fabricated PII to a real customer record. The
 * reviewer sees the candidates and explicitly confirms one via PATCH.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'credit_applications');
  if (auth.error) return auth.error;
  if (!z.string().uuid().safeParse(params.id).success) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const { data: app, error } = await service
    .from('credit_applications')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!app) return NextResponse.json({ error: 'Application not found' }, { status: 404 });

  // Candidate prospects by exact email or exact (case-insensitive) company
  // name. Display-only until the reviewer links one.
  const escaped = (app.company_name || '').replace(/[%_,()]/g, ' ').trim();
  let matches: any[] = [];
  try {
    const ors = [`email.ilike.${app.contact_email}`];
    if (escaped) ors.push(`company_name.ilike.${escaped}`);
    const { data: cand } = await service
      .from('prospects')
      .select('id, company_name, contact_name, email, netsuite_id')
      .or(ors.join(','))
      .limit(5);
    matches = cand || [];
  } catch { /* candidates are a convenience — never fail the read */ }

  let reviewerName: string | null = null;
  if (app.reviewed_by) {
    const { data: reviewer } = await service
      .from('profiles').select('full_name, email').eq('id', app.reviewed_by).maybeSingle();
    reviewerName = reviewer?.full_name || reviewer?.email || null;
  }

  return NextResponse.json({ application: app, prospectMatches: matches, reviewerName });
}

const PatchSchema = z.object({
  status: z.enum(['pending', 'approved', 'denied', 'more_info']).optional(),
  review_notes: z.string().trim().max(4000).optional(),
  /** Explicit reviewer-confirmed link; null unlinks. */
  prospectId: z.string().uuid().nullable().optional(),
}).refine(
  d => !(d.status && ['denied', 'more_info'].includes(d.status)) || !!d.review_notes?.trim(),
  { message: 'Notes are required to deny or request more info.' },
);

/**
 * PATCH /api/credit-applications/[id] — record the review decision
 * (stamps reviewed_by/reviewed_at, requires notes on deny / more-info —
 * enforced here, not just in the queue UI) and/or link a prospect the
 * reviewer confirmed. Audit-logged: net-terms decisions are money
 * decisions.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'credit_applications');
  if (auth.error) return auth.error;
  if (!z.string().uuid().safeParse(params.id).success) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const p = parsed.data;

  const patch: Record<string, unknown> = {};
  if (p.status) {
    patch.status = p.status;
    patch.reviewed_by = auth.user?.id ?? null;
    patch.reviewed_at = new Date().toISOString();
    if (p.review_notes !== undefined) patch.review_notes = p.review_notes;
  } else if (p.review_notes !== undefined) {
    patch.review_notes = p.review_notes;
  }
  if (p.prospectId !== undefined) {
    if (p.prospectId) {
      const { data: prospect } = await service
        .from('prospects').select('id').eq('id', p.prospectId).maybeSingle();
      if (!prospect) return NextResponse.json({ error: 'Prospect not found' }, { status: 404 });
    }
    patch.prospect_id = p.prospectId;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const { data: updated, error } = await service
    .from('credit_applications')
    .update(patch)
    .eq('id', params.id)
    .select('id, status, reviewed_by, reviewed_at, review_notes, prospect_id')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: 'Application not found' }, { status: 404 });

  await logAudit(service, {
    actorId: auth.user?.id ?? null,
    table: 'credit_applications',
    recordId: params.id,
    action: 'credit_application_review',
    detail: {
      ...(p.status ? { status: p.status } : {}),
      ...(p.review_notes ? { review_notes: p.review_notes.slice(0, 500) } : {}),
      ...(p.prospectId !== undefined ? { prospect_id: p.prospectId } : {}),
    },
  });

  return NextResponse.json({ success: true, application: updated });
}
