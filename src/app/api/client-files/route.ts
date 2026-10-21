import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateSearchParams, z } from '@/lib/validate';
import { searchWords, looseSearchRegex } from '@/lib/loose-search';
import { CLIENT_FILE_KINDS } from '@/lib/client-files';
import { CLIENT_FILE_ITEM_SELECT, toClientFileItem, type ClientFileItem } from '@/lib/client-file-item';
import { CLIENT_FILES_SYNC_TYPE } from '@/lib/client-files-sync';
import { escapeIlike } from '@/lib/customer-dupes';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  /** Words anywhere in the path under Clients: client folder, sub-folders, file name. */
  q: z.string().trim().max(120).optional(),
  kind: z.enum(CLIENT_FILE_KINDS as [string, ...string[]]).optional(),
  /** One client folder (dropbox_client_folders.id). */
  folder: z.string().uuid().optional(),
  /** With folder: only files under this sub-folder ("Chevy Express/PRINT"), at any depth. */
  sub: z.string().max(500).optional(),
  /** Every folder linked to one customer (customers.id) — the customer page. */
  customer: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type { ClientFileItem } from '@/lib/client-file-item';

/**
 * GET /api/client-files — search the Client Files copy of Dropbox
 * /OFFICE/Clients (migration 379). All internal staff (Craig, 2026-10-15).
 *
 * Every typed word must appear somewhere in the file's path under Clients,
 * with the forgiving matching every search box uses (src/lib/loose-search.ts),
 * so "home depot partition" finds Home Depot/…/Home Depot Partition
 * Stickers.eps however the words are split across folders. Newest first,
 * id as the unique tiebreaker so "Load more" never repeats a row.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = validateSearchParams(req, Schema);
  if (parsed.error) return parsed.error;
  const { q, kind, folder, customer } = parsed.data;
  const sub = (parsed.data.sub || '').replace(/^\/+|\/+$/g, '');
  const limit = parsed.data.limit ?? 50;
  const offset = parsed.data.offset ?? 0;
  const service = createServiceClient();

  try {
    let folderIds: string[] | null = null;
    if (customer) {
      const { data, error } = await service.from('dropbox_client_folders')
        .select('id').eq('customer_id', customer).is('deleted_at', null);
      if (error) throw new Error(error.message);
      folderIds = (data || []).map((f: { id: string }) => f.id);
      if (folderIds.length === 0) {
        return NextResponse.json({ files: [], total: 0, hasMore: false, folders: 0 });
      }
    }

    // Searching inside one sub-folder of the folder browser (Craig, 2026-10-21).
    let subPrefix: string | null = null;
    if (folder && sub) {
      const { data: f, error } = await service.from('dropbox_client_folders')
        .select('path_lower').eq('id', folder).maybeSingle();
      if (error) throw new Error(error.message);
      if (f) subPrefix = `${f.path_lower}/${sub.toLowerCase()}/`;
    }

    let query = service.from('dropbox_client_files')
      .select(
        CLIENT_FILE_ITEM_SELECT,
        { count: 'exact' },
      )
      .is('deleted_at', null)
      .order('server_modified', { ascending: false, nullsFirst: false })
      .order('id')
      .range(offset, offset + limit - 1);
    if (kind) query = query.eq('kind', kind);
    if (folder) query = query.eq('folder_id', folder);
    if (subPrefix) query = query.like('path_lower', `${escapeIlike(subPrefix)}%`);
    if (folderIds) query = query.in('folder_id', folderIds);
    for (const word of searchWords(q).slice(0, 8)) {
      const re = looseSearchRegex(word);
      if (re) query = query.filter('rel_path', 'imatch', re);
    }

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    const files: ClientFileItem[] = (data || []).map(toClientFileItem);

    // How fresh the copy is, for the page header (first page only).
    let sync: { lastRunAt: string | null; walking: boolean; error: string | null } | undefined;
    if (offset === 0) {
      const { data: st } = await service.from('sync_state')
        .select('last_synced_at, last_result').eq('sync_type', CLIENT_FILES_SYNC_TYPE).maybeSingle();
      const lr = (st?.last_result || {}) as Record<string, any>;
      sync = {
        lastRunAt: st?.last_synced_at ?? null,
        walking: !lr.cursor || !!lr.full,
        error: typeof lr.error === 'string' ? lr.error : null,
      };
    }

    return NextResponse.json({
      files,
      total: count ?? files.length,
      hasMore: count != null ? offset + files.length < count : files.length === limit,
      ...(folderIds ? { folders: folderIds.length } : {}),
      ...(sync ? { sync } : {}),
    });
  } catch (e: any) {
    console.error('[client-files] search failed:', e?.message || e);
    return NextResponse.json({ error: e?.message || 'Search failed' }, { status: 500 });
  }
}
