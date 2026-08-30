import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { sha256Hex } from '@/lib/magic-link-approval';
import { r2GetBytes } from '@/lib/r2';
import type { FeatureKey } from '@/lib/features';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/signed-documents?type=estimate|wrap_quote|proof&id=<uuid>
 *
 * The read side of the E-SIGN record (audit Round 2 item 11). Every
 * approval froze an HTML snapshot into the private signed-documents R2
 * prefix with a sha256 (uploadSignedDocument) — and nothing could ever
 * read one back, which is exactly what a dispute needs. This returns the
 * snapshot plus an integrity verdict: the bytes are re-hashed and compared
 * against the hash stored at approval time, so a tampered or swapped
 * object shows up as verified:false rather than passing silently.
 *
 * Gated per record type on the same feature keys as the records
 * themselves; the snapshot HTML is rendered client-side inside a
 * sandboxed iframe, never as a live page.
 */
const TYPES: Record<string, {
  table: string;
  feature: FeatureKey;
  select: string;
  label: (row: any) => string;
  approvedAt: (row: any) => string | null;
}> = {
  estimate: {
    table: 'estimates',
    feature: 'estimates',
    select: 'id, estimate_number, customer_name, customer_approved_at, customer_approved_via, signed_document_storage_path, signed_document_hash',
    label: r => `Estimate ${r.estimate_number}${r.customer_name ? ` — ${r.customer_name}` : ''}`,
    approvedAt: r => r.customer_approved_at,
  },
  wrap_quote: {
    table: 'wrap_quotes',
    feature: 'estimates',
    select: 'id, quote_number, customer, accepted_at, signed_document_storage_path, signed_document_hash',
    label: r => `Wrap quote ${r.quote_number}${(r.customer as any)?.name ? ` — ${(r.customer as any).name}` : ''}`,
    approvedAt: r => r.accepted_at,
  },
  proof: {
    table: 'graphics_jobs',
    feature: 'graphics',
    select: 'id, job_number, customer, customer_approved_at, signed_document_storage_path, signed_document_hash',
    label: r => `Proof approval ${r.job_number || ''}${r.customer ? ` — ${r.customer}` : ''}`.trim(),
    approvedAt: r => r.customer_approved_at,
  },
};

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type') || '';
  const id = searchParams.get('id') || '';
  const spec = TYPES[type];
  if (!spec) return NextResponse.json({ error: 'Unknown document type' }, { status: 400 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const auth = await requireFeature(req, spec.feature);
  if (auth.error) return auth.error;

  const { data: row } = await supabase
    .from(spec.table)
    .select(spec.select)
    .eq('id', id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: 'Record not found' }, { status: 404 });
  if (!(row as any).signed_document_storage_path) {
    return NextResponse.json({ error: 'No signed snapshot exists for this record — it predates the E-SIGN capture, or was approved outside the magic-link flow.' }, { status: 404 });
  }

  // Stored as the full R2 key (`signed-documents/<name>.html`, r2Upload's
  // returned key) — split back into the prefix/path shape r2Get expects.
  const stored = String((row as any).signed_document_storage_path);
  const slash = stored.indexOf('/');
  const prefix = slash > 0 ? stored.slice(0, slash) : 'signed-documents';
  const path = slash > 0 ? stored.slice(slash + 1) : stored;
  const got = await r2GetBytes(prefix, path, MAX_SNAPSHOT_BYTES);
  if (!got) {
    return NextResponse.json({ error: 'The snapshot object could not be read from storage.' }, { status: 502 });
  }

  const html = got.bytes.toString('utf8');
  const storedHash = (row as any).signed_document_hash || null;
  // The hash was computed on the utf8 HTML string at approval time
  // (uploadSignedDocument) — re-derive it the same way.
  const verified = !!storedHash && sha256Hex(html) === storedHash;

  return NextResponse.json({
    success: true,
    label: spec.label(row),
    approvedAt: spec.approvedAt(row),
    storagePath: stored,
    hash: storedHash,
    verified,
    html,
  });
}
