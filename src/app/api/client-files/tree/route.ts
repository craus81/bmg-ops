import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateSearchParams, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { buildFolderTree, type TreeFile } from '@/lib/client-files-tree';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  /** One client folder (dropbox_client_folders.id). */
  folder: z.string().uuid(),
  /** files=1: also list every file (for a zip), optionally only those under `sub`. */
  files: z.enum(['1']).optional(),
  /** A sub-folder below the client folder, as the tree names it ("Chevy Express/PRINT"). */
  sub: z.string().max(500).optional(),
});

/**
 * GET /api/client-files/tree?folder=<id>[&files=1&sub=<path>]
 *
 * A client folder's sub-folders with how many files and bytes each holds,
 * for the per-folder "Zip" buttons (Craig, 2026-10-16). With files=1 it also
 * returns the files themselves (id, name, size, path inside the folder) so
 * the browser can zip them (src/lib/client-files-zip.ts). All staff.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = validateSearchParams(req, Schema);
  if (parsed.error) return parsed.error;
  const { folder, files, sub } = parsed.data;
  const service = createServiceClient();

  const { data: f, error: fErr } = await service.from('dropbox_client_folders')
    .select('id, name').eq('id', folder).is('deleted_at', null).maybeSingle();
  if (fErr) return NextResponse.json({ error: fErr.message }, { status: 500 });
  if (!f) return NextResponse.json({ error: 'That folder is no longer in Dropbox' }, { status: 404 });

  const { data, error } = await fetchAllRows<TreeFile>((from, to) =>
    service.from('dropbox_client_files')
      .select('id, name, size_bytes, rel_path')
      .eq('folder_id', folder)
      .is('deleted_at', null)
      .order('rel_path')
      .order('id')
      .range(from, to),
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const tree = buildFolderTree(data, sub);
  return NextResponse.json({
    folder: { id: f.id, name: f.name },
    ...tree,
    ...(files ? {} : { files: undefined }),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
