import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { r2PresignGet } from '@/lib/r2';
import { getTemporaryLink } from '@/lib/dropbox';
import { CLIENT_FILES_R2_PREFIX } from '@/lib/client-files';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client-files/<id>?disposition=inline|attachment[&format=json]
 *
 * Opens or downloads one Client Files file (migration 379). A PDF or photo
 * with a current copy comes from R2 through a presigned link that carries
 * the real file name; anything else (print files, big files, copies not
 * made yet or older than Dropbox) comes straight from Dropbox through a
 * 4-hour link. Either way it is a redirect, so big files never pass through
 * this function. format=json returns { url } for the iPhone app, as
 * /api/storage/download does, plus the client folder and its matched
 * customer (the Graphics Builder fills the customer in from them). All
 * internal staff.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const id = params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const disposition = req.nextUrl.searchParams.get('disposition') === 'attachment' ? 'attachment' as const : 'inline' as const;

  const { data: row, error } = await createServiceClient().from('dropbox_client_files')
    .select('dropbox_id, name, ext, r2_path, copied_rev, rev, deleted_at, folder:dropbox_client_folders(name, customer:customers(id, company_name))')
    .eq('id', id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row || row.deleted_at) return NextResponse.json({ error: 'That file is no longer in Dropbox' }, { status: 404 });

  try {
    const fresh = !!row.r2_path && !!row.copied_rev && row.copied_rev === row.rev;
    const url = fresh
      ? await r2PresignGet(CLIENT_FILES_R2_PREFIX, row.r2_path!, { filename: row.name, disposition })
      : await getTemporaryLink(row.dropbox_id);
    if (req.nextUrl.searchParams.get('format') === 'json') {
      const folder: any = (row as any).folder;
      return NextResponse.json({
        url,
        name: row.name,
        ext: row.ext,
        client: folder ? { name: folder.name } : null,
        customer: folder?.customer ? { id: folder.customer.id, name: folder.customer.company_name } : null,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[client-files] open failed:', e?.message || e);
    return NextResponse.json({ error: e?.message || 'Could not open the file' }, { status: 502 });
  }
}
