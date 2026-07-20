import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const DOC_COLUMNS = ['w9_file_path', 'insurance_cert_path', 'direct_deposit_file_path'] as const;

const Schema = z.object({
  column: z.enum(DOC_COLUMNS),
  // R2 key under the cni-docs prefix; the client uploads first via the
  // presign flow, then registers the path here.
  path: z.string().trim().min(1).max(500),
  // Only meaningful with insurance_cert_path.
  insuranceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const DOC_LABELS: Record<(typeof DOC_COLUMNS)[number], string> = {
  w9_file_path: 'W-9',
  insurance_cert_path: 'insurance certificate',
  direct_deposit_file_path: 'direct deposit form',
};

const isComplete = (row: Record<string, unknown> | null) =>
  !!row && DOC_COLUMNS.every(c => !!row[c]);

/**
 * Installer self-service: register an uploaded compliance document on the
 * caller's own cni_profiles row. When the upload completes the full set
 * (W-9 + insurance + direct deposit), admins get notified once.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['installer']);
  if (auth.error) return auth.error;
  const userId = auth.user!.id;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  // Installers may only register files they uploaded into their own folder.
  if (!body.path.startsWith(`${userId}/`)) {
    return NextResponse.json({ error: 'Invalid document path' }, { status: 400 });
  }

  const { data: existing } = await service
    .from('cni_profiles')
    .select('id, w9_file_path, insurance_cert_path, direct_deposit_file_path')
    .eq('user_id', userId)
    .maybeSingle();
  const wasComplete = isComplete(existing);

  const patch: Record<string, unknown> = { [body.column]: body.path, updated_at: new Date().toISOString() };
  if (body.column === 'insurance_cert_path' && body.insuranceExpiry) {
    patch.insurance_expiry = body.insuranceExpiry;
  }

  const { error: saveErr } = existing
    ? await service.from('cni_profiles').update(patch).eq('user_id', userId)
    : await service.from('cni_profiles').insert({ user_id: userId, ...patch });
  if (saveErr) {
    return NextResponse.json({ error: `Failed to save: ${saveErr.message}` }, { status: 500 });
  }

  const nowComplete = isComplete({ ...(existing || {}), ...patch });

  if (nowComplete && !wasComplete) {
    // Fire-and-forget style but awaited so serverless doesn't kill it.
    try {
      const [{ data: profile }, { data: admins }] = await Promise.all([
        service.from('profiles').select('full_name, company_id').eq('id', userId).single(),
        service.from('profiles')
          .select('id, role, roles')
          .or('role.eq.admin,roles.cs.{admin}')
          .eq('status', 'approved'),
      ]);
      let companyName: string | null = null;
      if (profile?.company_id) {
        const { data: company } = await service
          .from('companies').select('name').eq('id', profile.company_id).maybeSingle();
        companyName = company?.name || null;
      }
      const name = profile?.full_name || 'An installer';
      const who = companyName && companyName !== name ? `${name} (${companyName})` : name;
      const adminIds = (admins || []).map(a => a.id);
      if (adminIds.length > 0) {
        await notifyMany(adminIds, {
          type: 'cni_docs_complete',
          title: `Compliance docs complete: ${name}`,
          body: `${who} has uploaded all compliance documents — W-9, insurance certificate, and direct deposit form are on file.`,
          url: `/admin/cni/installers/${userId}`,
          channels: ['in_app', 'push', 'email'],
          forceChannels: true,
        });
      }
    } catch (err) {
      // The document is saved either way — never fail the upload over a
      // notification hiccup.
      console.error('cni_docs_complete notify failed:', err);
    }
  }

  return NextResponse.json({
    success: true,
    complete: nowComplete,
    uploaded: DOC_LABELS[body.column],
  });
}
