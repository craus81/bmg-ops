import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { logAudit } from '@/lib/audit';
import { backupDownloadUrl } from '@/lib/books/backups';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/admin/books/backups/download?id= — one backup of FleetSuite's
 * books (docs/books.md "Backups"): { url, fileName }, a link to its zip in
 * BMG's private file storage that works for five minutes. The page fetches
 * the link without the session, so R2's CORS rule applies and the zip never
 * passes through here (src/lib/use-file-download.ts). The generic storage
 * routes refuse books-backups/ (src/lib/storage-guard.ts); this is the one
 * way to a backup, super admins only, since a backup holds every table of
 * the books. Audited.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const id = req.nextUrl.searchParams.get('id')?.trim() || '';
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Which backup?' }, { status: 400 });
  const service = createServiceClient();
  try {
    const link = await backupDownloadUrl(service, id);
    if (!link) return NextResponse.json({ error: 'That backup has no file to download.' }, { status: 404 });
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'books_backups',
      recordId: id,
      action: 'download_books_backup',
      detail: { file: link.fileName },
    });
    return NextResponse.json(link, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
