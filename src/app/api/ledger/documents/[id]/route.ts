import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, requireMoney } from '@/lib/api-auth';
import { isHistoryDocumentParent, isLedgerReader } from '@/lib/ledger/history';
import { r2Get, r2PresignGet } from '@/lib/r2';
import { LEDGER_R2_PREFIX, isSafeLedgerStoragePath, ledgerDocumentHeaders } from '@/lib/ledger/storage';

export const dynamic = 'force-dynamic';
// Streams a PDF or attachment out of R2 through the function. 60 s is the
// house default for a route that does real network work; declared, never
// inherited (the platform default is 10 s).
export const maxDuration = 60;

/**
 * GET /api/ledger/documents/[id] — the ONLY way ledger bytes leave R2.
 *
 * The `ledger` prefix is denied on the generic /api/storage routes
 * (src/lib/storage-guard.ts), so there is no "staff can read any non-denied
 * prefix" path into the QuickBooks/NetSuite history: every read is
 * record-scoped and role-gated here. The ledger reader tier (finance,
 * executive, admin, super admin) opens any stored document. Since
 * 2026-09-24 the rest of the money wall (sales) may open a document too, but
 * ONLY one attached to a pre-cutover QuickBooks sales document the history
 * lists show them (src/lib/ledger/history.ts) — so estimators can see a past
 * build's PDF while bills, payments and journals stay with the readers.
 *
 * Nothing here ever mints or persists a public URL: the default response
 * streams the object with `Cache-Control: private, no-store`, and
 * `?download=1` redirects to a 5-minute presigned GET that restores the real
 * filename. `storage_path` is RELATIVE to the prefix (src/lib/ledger/storage.ts).
 *
 * What is served inline is NOT the source's word for it: `content_type` comes
 * from QuickBooks/NetSuite (an `Attachable` carries whatever ContentType the
 * uploader chose), and an inline `text/html` from this origin would run as
 * the reader. `ledgerDocumentHeaders` allowlists the inline-safe types and
 * turns everything else into an octet-stream download.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireMoney(req);
  if (auth.error) return auth.error;
  const reader = isLedgerReader(getProfileRoles(auth.profile));

  const id = (params.id || '').trim();
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const service = createServiceClient();
  const { data: row, error } = await service
    .from('ledger_documents')
    .select('id, file_name, content_type, storage_path, status, size_bytes, entity_table, entity_row_id')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    // Migration 314 not applied on this deployment yet (PostgREST reports an
    // unknown table as PGRST205; the underlying Postgres code is 42P01).
    // Say so plainly instead of rendering a 500 nobody can act on.
    const code = (error as { code?: string }).code;
    if (code === 'PGRST205' || code === '42P01') {
      return NextResponse.json({ error: 'Ledger schema not deployed yet' }, { status: 503 });
    }
    console.error('ledger document read failed:', error);
    return NextResponse.json({ error: 'Could not read the document record' }, { status: 500 });
  }

  if (!row) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

  // Outside the reader tier, a document that isn't a history sales
  // document's answers exactly like a missing one: no hint that it exists.
  if (!reader) {
    let allowed = false;
    try {
      allowed = await isHistoryDocumentParent(service, row.entity_table ?? null, row.entity_row_id ?? null);
    } catch (err) {
      console.error('ledger document scope check failed:', err);
      return NextResponse.json({ error: 'Could not check access to the document' }, { status: 500 });
    }
    if (!allowed) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }

  const storagePath = row.storage_path ? String(row.storage_path) : '';
  if (row.status !== 'stored' || !storagePath) {
    // A pending / unsupported / failed row is a real state, not an error the
    // caller can retry away — name it so the viewer can say which.
    return NextResponse.json({ error: 'Document not stored yet', status: row.status }, { status: 409 });
  }

  // Only `ledgerStoragePath` writes this column, and it cannot produce a
  // traversing value — but this route is the single door for the whole
  // `ledger` prefix, so it checks the shape rather than trusting the row.
  if (!isSafeLedgerStoragePath(storagePath)) {
    console.error('ledger document has an unusable storage_path:', id);
    return NextResponse.json({ error: 'Document path is not usable' }, { status: 409 });
  }

  const fileName = String(row.file_name || 'document.pdf');

  if (req.nextUrl.searchParams.get('download') === '1') {
    try {
      const url = await r2PresignGet(LEDGER_R2_PREFIX, storagePath, {
        filename: fileName,
        disposition: 'attachment',
        expiresIn: 300,
      });
      return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
    } catch (err) {
      console.error('ledger document presign failed:', err);
      return NextResponse.json({ error: 'Could not mint a download link' }, { status: 502 });
    }
  }

  const got = await r2Get(LEDGER_R2_PREFIX, storagePath);
  if (!got.success || !got.body) {
    return NextResponse.json({ error: 'The document object could not be read from storage.' }, { status: 502 });
  }

  // size_bytes is what the importer recorded when it stored the object, so a
  // large PDF gets a progress bar instead of an unbounded spinner. Only sent
  // when it agrees with what R2 just reported — a stale row must not truncate
  // the stream or leave the browser waiting on bytes that never come.
  const headers = ledgerDocumentHeaders(fileName, row.content_type || got.contentType);
  const recorded = Number(row.size_bytes);
  if (Number.isFinite(recorded) && recorded > 0 && (!got.contentLength || got.contentLength === recorded)) {
    headers['Content-Length'] = String(recorded);
  }
  return new NextResponse(got.body as any, { headers });
}
