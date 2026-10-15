import type { SupabaseClient } from '@supabase/supabase-js';
import {
  listFolderRecursive, listFolderContinue, getMetadata, downloadFile, getThumbnail,
  DropboxCursorResetError, type DropboxListEntry, type DropboxListPage,
} from '@/lib/dropbox';
import { r2Upload, r2Delete } from '@/lib/r2';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { fetchAllRows } from '@/lib/fetch-all';
import { escapeIlike } from '@/lib/customer-dupes';
import {
  DEFAULT_CLIENT_FILES_ROOT, CLIENT_FILES_R2_PREFIX, extOf, kindOf, contentTypeFor,
  wantsThumbnail, copyKeyFor, thumbKeyFor, prepareCustomers, matchFolder,
} from '@/lib/client-files';

/**
 * Keeps dropbox_client_folders / dropbox_client_files (migration 379) in step
 * with Dropbox /OFFICE/Clients, every 10 minutes from /api/cron/client-files.
 * Owner ask 2026-10-15; the pure rules live in src/lib/client-files.ts.
 *
 * Each run, inside its time budget:
 *   1. List. The first run (and a weekly re-check) walks the whole folder
 *      with list_folder, a page at a time across as many runs as it takes,
 *      saving the cursor in sync_state. When a walk finishes, files it did
 *      not see are marked deleted and its final cursor becomes the change
 *      feed; every later run asks Dropbox only for what changed since.
 *   2. Match new or unsettled client folders to customers (once a day for
 *      the unsettled ones, straight away for new folders). A person's choice
 *      (confirmed / none) is never touched.
 *   3. Copy. PDFs and photos whose copy is missing or out of date go to R2
 *      (prefix client-files) with a thumbnail, newest first, a few at a time.
 *      Print files are never copied; downloads fetch them from Dropbox.
 *   4. Refresh per-folder counts if anything changed, and record the run.
 *
 * Nothing here writes to Dropbox.
 */

export const CLIENT_FILES_SYNC_TYPE = 'dropbox_client_files';

const DEFAULT_BUDGET_MS = 45_000;
/** Re-walk the whole folder this often, to catch anything the change feed missed. */
const FULL_RELIST_MS = 7 * 24 * 3600_000;
/** Re-try unsettled folder matches this often (new customers arrive). */
const REMATCH_MS = 24 * 3600_000;
const UPSERT_CHUNK = 500;
const COPY_BATCH = 16;
const COPY_CONCURRENCY = 4;
/** Leave this much of the budget for counts and the heartbeat. */
const TAIL_MS = 15_000;
/** Dropbox won't thumbnail photos bigger than this. */
const THUMB_MAX_BYTES = 20 * 1024 * 1024;

export interface ClientFilesState {
  root: string;
  /** Change-feed cursor, once a full walk has finished. */
  cursor: string | null;
  /** A full walk in progress. */
  full: { cursor: string | null; runId: string; startedAt: string; listed: number } | null;
  lastFullAt: string | null;
  lastMatchAt: string | null;
}

export function parseClientFilesState(raw: unknown, root: string): ClientFilesState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const fresh: ClientFilesState = { root, cursor: null, full: null, lastFullAt: null, lastMatchAt: null };
  // A different root is a different copy: start over.
  if (typeof r.root !== 'string' || r.root.toLowerCase() !== root.toLowerCase()) return fresh;
  const full = r.full && typeof r.full === 'object' && typeof r.full.runId === 'string'
    ? {
        cursor: typeof r.full.cursor === 'string' ? r.full.cursor : null,
        runId: r.full.runId,
        startedAt: typeof r.full.startedAt === 'string' ? r.full.startedAt : new Date().toISOString(),
        listed: Number(r.full.listed) || 0,
      }
    : null;
  return {
    root,
    cursor: typeof r.cursor === 'string' && r.cursor ? r.cursor : null,
    full,
    lastFullAt: typeof r.lastFullAt === 'string' ? r.lastFullAt : null,
    lastMatchAt: typeof r.lastMatchAt === 'string' ? r.lastMatchAt : null,
  };
}

/** Whether this run should be (or keep) walking the whole folder. */
export function needsFullWalk(st: ClientFilesState, now = Date.now()): boolean {
  if (st.full) return true;
  if (!st.cursor) return true;
  return !st.lastFullAt || now - new Date(st.lastFullAt).getTime() > FULL_RELIST_MS;
}

export interface ClientFilesSyncResult {
  mode: 'full' | 'changes';
  listed: number;
  upserted: number;
  deleted: number;
  newFolders: number;
  matched: { auto: number; suggested: number; unmatched: number } | null;
  copied: number;
  copiedBytes: number;
  copyFailed: number;
  /** A full walk is still under way; the next run continues it. */
  walking: boolean;
  error?: string;
  syncStateWrite?: HeartbeatResult;
}

interface FolderRow { id: string; dropbox_id: string; path_lower: string }

export async function syncClientFiles(
  service: SupabaseClient,
  opts?: { deadline?: number },
): Promise<ClientFilesSyncResult> {
  const startedAt = Date.now();
  const deadline = opts?.deadline ?? startedAt + DEFAULT_BUDGET_MS;
  const root = (process.env.DROPBOX_CLIENT_FILES_PATH || '').trim() || DEFAULT_CLIENT_FILES_ROOT;
  const rootLower = root.replace(/\/+$/, '').toLowerCase();

  const { data: stateRow } = await service
    .from('sync_state')
    .select('last_result')
    .eq('sync_type', CLIENT_FILES_SYNC_TYPE)
    .maybeSingle();
  const st = parseClientFilesState(stateRow?.last_result, root);

  const result: ClientFilesSyncResult = {
    mode: needsFullWalk(st) ? 'full' : 'changes',
    listed: 0, upserted: 0, deleted: 0, newFolders: 0, matched: null,
    copied: 0, copiedBytes: 0, copyFailed: 0, walking: false,
  };
  let stage = 'folders';
  let changed = false;

  try {
    // Live client folders by their lowercase path, to file each file under one.
    const { data: folderRows, error: folderErr } = await fetchAllRows<FolderRow>((from, to) =>
      service.from('dropbox_client_folders').select('id, dropbox_id, path_lower')
        .is('deleted_at', null).order('id').range(from, to));
    if (folderErr) throw new Error(folderErr.message);
    const folderByPath = new Map(folderRows.map(f => [f.path_lower, f.id]));

    // ── 1. List ──
    stage = 'list';
    const runId = st.full?.runId ?? `run-${startedAt}`;
    const applyPage = async (page: DropboxListPage, fullRun: string | null) => {
      result.listed += page.entries.length;
      const out = await applyEntries(service, page.entries, { rootLower, root, folderByPath, runId: fullRun });
      result.upserted += out.upserted;
      result.deleted += out.deleted;
      result.newFolders += out.newFolders;
      if (out.upserted || out.deleted || out.newFolders) changed = true;
    };

    if (result.mode === 'full') {
      if (!st.full) st.full = { cursor: null, runId, startedAt: new Date(startedAt).toISOString(), listed: 0 };
      let hasMore = true;
      while (hasMore && Date.now() < deadline - TAIL_MS) {
        const page = st.full.cursor ? await listFolderContinue(st.full.cursor) : await listFolderRecursive(root);
        await applyPage(page, st.full.runId);
        st.full.cursor = page.cursor;
        st.full.listed += page.entries.length;
        hasMore = page.has_more;
      }
      if (!hasMore) {
        // The walk is complete: whatever it never saw is gone.
        stage = 'sweep';
        result.deleted += await sweepUnlisted(service, st.full.runId);
        st.cursor = st.full.cursor;
        st.lastFullAt = st.full.startedAt;
        st.full = null;
        changed = true;
      } else {
        result.walking = true;
      }
    } else {
      let hasMore = true;
      while (hasMore && Date.now() < deadline - TAIL_MS) {
        const page = await listFolderContinue(st.cursor!);
        await applyPage(page, null);
        st.cursor = page.cursor;
        hasMore = page.has_more;
      }
    }

    // Save the cursor now, so a run killed while copying keeps its place.
    await recordHeartbeat(service, CLIENT_FILES_SYNC_TYPE, { ...st, phase: 'listed', run: result }, { touchLastSyncedAt: false });

    // ── 2. Match folders to customers ──
    stage = 'match';
    const matchDue = result.newFolders > 0 || !st.lastMatchAt
      || Date.now() - new Date(st.lastMatchAt).getTime() > REMATCH_MS;
    if (matchDue && !result.walking && Date.now() < deadline - TAIL_MS - 20_000) {
      result.matched = await matchFolders(service);
      st.lastMatchAt = new Date().toISOString();
      if (result.matched.auto || result.matched.suggested) changed = true;
    }

    // ── 3. Copy PDFs and photos ──
    stage = 'copy';
    const copy = await copyPending(service, deadline - TAIL_MS);
    result.copied = copy.copied;
    result.copiedBytes = copy.bytes;
    result.copyFailed = copy.failed;
    if (copy.copied) changed = true;

    // ── 4. Counts ──
    if (changed) {
      stage = 'counts';
      const { error } = await service.rpc('refresh_dropbox_client_folder_stats');
      if (error) throw new Error(error.message);
    }
  } catch (err: any) {
    if (err instanceof DropboxCursorResetError) {
      // Dropbox can no longer answer from that cursor: walk the folder again.
      st.cursor = null;
      st.full = null;
      result.error = `${stage}: Dropbox asked for a fresh listing; the next run starts one`;
    } else {
      result.error = `${stage}: ${err?.message || String(err)}`.slice(0, 500);
    }
    console.error('[client-files-sync]', result.error);
  }

  const { syncStateWrite: _ignored, ...run } = result;
  result.syncStateWrite = await recordHeartbeat(
    service, CLIENT_FILES_SYNC_TYPE,
    { ...st, run, ...(result.error ? { error: result.error } : {}) },
    { touchLastSyncedAt: !result.error, startedAt, records: result.listed + result.copied },
  );
  return result;
}

// ── Listing ──

interface ApplyContext {
  root: string;
  rootLower: string;
  folderByPath: Map<string, string>;
  /** Set during a full walk: stamps every row it sees. */
  runId: string | null;
}

/** The client folder key (lowercase path) an item sits under, or null for the root itself or a loose file. */
function clientFolderKey(pathLower: string, rootLower: string): { key: string; top: boolean } | null {
  if (!pathLower.startsWith(rootLower + '/')) return null;
  const rel = pathLower.slice(rootLower.length + 1);
  if (!rel) return null;
  const slash = rel.indexOf('/');
  if (slash < 0) return { key: `${rootLower}/${rel}`, top: true };
  return { key: `${rootLower}/${rel.slice(0, slash)}`, top: false };
}

export async function applyEntries(
  service: SupabaseClient,
  entries: DropboxListEntry[],
  ctx: ApplyContext,
): Promise<{ upserted: number; deleted: number; newFolders: number }> {
  let deleted = 0;
  let newFolders = 0;
  const now = new Date().toISOString();

  // Deletions first, so a file deleted and re-added in one page ends up live.
  const gone = entries.filter(e => e.tag === 'deleted').map(e => e.path_lower);
  if (gone.length > 0) {
    deleted += await markDeleted(service, gone);
    for (const p of gone) {
      if (!clientFolderKey(p, ctx.rootLower)?.top || !ctx.folderByPath.has(p)) continue;
      const { error } = await service.from('dropbox_client_folders').update({ deleted_at: now, updated_at: now })
        .eq('path_lower', p).is('deleted_at', null);
      if (error) throw new Error(`folder delete: ${error.message}`);
      ctx.folderByPath.delete(p);
    }
  }

  // Client folders (the first level under the root). Nested folders aren't stored.
  const folderRows = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    if (e.tag !== 'folder') continue;
    const loc = clientFolderKey(e.path_lower, ctx.rootLower);
    if (!loc?.top) continue;
    folderRows.set(e.id, folderRow(e, ctx.runId, now));
  }
  newFolders += await upsertFolders(service, [...folderRows.values()], ctx.folderByPath);

  // Files. A file whose client folder we haven't stored yet (its folder came
  // in an earlier change we missed) gets the folder looked up first.
  const files = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    if (e.tag !== 'file') continue;
    const loc = clientFolderKey(e.path_lower, ctx.rootLower);
    if (!loc) continue;
    let folderId: string | null = null;
    if (!loc.top) {
      folderId = ctx.folderByPath.get(loc.key) ?? null;
      if (!folderId) {
        const meta = await getMetadata(loc.key);
        if (meta?.tag === 'folder') {
          newFolders += await upsertFolders(service, [folderRow(meta, null, now)], ctx.folderByPath);
          folderId = ctx.folderByPath.get(loc.key) ?? null;
        }
      }
    }
    const relPath = e.path_display.slice(ctx.rootLower.length + 1);
    const row: Record<string, unknown> = {
      dropbox_id: e.id,
      folder_id: folderId,
      path_lower: e.path_lower,
      path_display: e.path_display,
      rel_path: relPath,
      name: e.name,
      ext: extOf(e.name),
      kind: kindOf(e.name),
      size_bytes: e.size,
      server_modified: e.server_modified || null,
      rev: e.rev || null,
      deleted_at: null,
      updated_at: now,
    };
    if (ctx.runId) row.listed_run = ctx.runId;
    files.set(e.id, row); // one row per id: a page can name a file twice
  }
  const rows = [...files.values()];
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await service.from('dropbox_client_files')
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'dropbox_id' });
    if (error) throw new Error(`file upsert: ${error.message}`);
  }
  return { upserted: rows.length, deleted, newFolders };
}

function folderRow(e: { id: string; name: string; path_lower: string }, runId: string | null, now: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    dropbox_id: e.id, path_lower: e.path_lower, name: e.name, deleted_at: null, updated_at: now,
  };
  if (runId) row.listed_run = runId;
  return row;
}

/** Upsert client folders by Dropbox id (a rename keeps its customer link); returns how many are new. */
async function upsertFolders(
  service: SupabaseClient,
  rows: Record<string, unknown>[],
  folderByPath: Map<string, string>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const known = new Set(folderByPath.values());
  let fresh = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { data, error } = await service.from('dropbox_client_folders')
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'dropbox_id' })
      .select('id, path_lower');
    if (error) throw new Error(`folder upsert: ${error.message}`);
    for (const f of (data || []) as { id: string; path_lower: string }[]) {
      if (!known.has(f.id)) fresh++;
      // A renamed folder's old path no longer points at it.
      for (const [p, id] of folderByPath) if (id === f.id && p !== f.path_lower) folderByPath.delete(p);
      folderByPath.set(f.path_lower, f.id);
    }
  }
  return fresh;
}

/**
 * Mark files deleted: those at the given paths, and, for a path that was no
 * file (a deleted folder), everything under it. Drops their R2 copies.
 */
async function markDeleted(service: SupabaseClient, paths: string[]): Promise<number> {
  const now = new Date().toISOString();
  type Gone = { path_lower: string; r2_path: string | null; thumb_path: string | null };
  const hit = new Set<string>();
  let n = 0;
  for (let i = 0; i < paths.length; i += 50) {
    const { data, error } = await service.from('dropbox_client_files')
      .update({ deleted_at: now, updated_at: now })
      .in('path_lower', paths.slice(i, i + 50)).is('deleted_at', null)
      .select('path_lower, r2_path, thumb_path');
    if (error) throw new Error(`delete: ${error.message}`);
    for (const r of (data || []) as Gone[]) hit.add(r.path_lower);
    n += (data || []).length;
    await dropCopies((data || []) as Gone[]);
  }
  for (const p of paths) {
    if (hit.has(p)) continue;
    const { data, error } = await service.from('dropbox_client_files')
      .update({ deleted_at: now, updated_at: now })
      .like('path_lower', `${escapeIlike(p)}/%`).is('deleted_at', null)
      .select('path_lower, r2_path, thumb_path');
    if (error) throw new Error(`delete: ${error.message}`);
    n += (data || []).length;
    await dropCopies((data || []) as Gone[]);
  }
  return n;
}

/** After a full walk: files and folders it never saw are gone from Dropbox. */
async function sweepUnlisted(service: SupabaseClient, runId: string): Promise<number> {
  const now = new Date().toISOString();
  const unseen = `listed_run.is.null,listed_run.neq.${runId}`;
  const { data, error } = await service.from('dropbox_client_files')
    .update({ deleted_at: now, updated_at: now })
    .is('deleted_at', null).or(unseen)
    .select('r2_path, thumb_path');
  if (error) throw new Error(`sweep: ${error.message}`);
  await dropCopies((data || []) as { r2_path: string | null; thumb_path: string | null }[]);
  const { error: folderErr } = await service.from('dropbox_client_folders')
    .update({ deleted_at: now, updated_at: now })
    .is('deleted_at', null).or(unseen);
  if (folderErr) throw new Error(`folder sweep: ${folderErr.message}`);
  return (data || []).length;
}

async function dropCopies(rows: { r2_path: string | null; thumb_path: string | null }[]): Promise<void> {
  for (const r of rows) {
    for (const p of [r.r2_path, r.thumb_path]) {
      if (p) await r2Delete(CLIENT_FILES_R2_PREFIX, p).catch(() => undefined);
    }
  }
}

// ── Matching ──

async function matchFolders(service: SupabaseClient): Promise<{ auto: number; suggested: number; unmatched: number }> {
  const counts = { auto: 0, suggested: 0, unmatched: 0 };
  const { data: folders, error } = await fetchAllRows<{
    id: string; dropbox_id: string; path_lower: string; name: string;
    customer_id: string | null; match_status: string; candidates: unknown;
  }>((from, to) =>
    service.from('dropbox_client_folders')
      .select('id, dropbox_id, path_lower, name, customer_id, match_status, candidates')
      .is('deleted_at', null)
      .or('match_status.in.(unmatched,suggested),and(match_status.eq.auto,customer_id.is.null)')
      .order('id').range(from, to));
  if (error) throw new Error(error.message);
  if (folders.length === 0) return counts;

  const { data: customers, error: custErr } = await fetchAllRows<{ id: string; company_name: string | null; active: boolean | null }>((from, to) =>
    service.from('customers').select('id, company_name, active')
      .not('company_name', 'is', null).order('id').range(from, to));
  if (custErr) throw new Error(custErr.message);
  const prepared = prepareCustomers(customers.map(c => ({ id: c.id, name: c.company_name || '', active: c.active })));

  const now = new Date().toISOString();
  const updates: Record<string, unknown>[] = [];
  for (const f of folders) {
    const m = matchFolder(f.name, prepared);
    counts[m.status]++;
    const same = m.status === f.match_status && m.customerId === f.customer_id
      && JSON.stringify(m.candidates) === JSON.stringify(f.candidates);
    if (same) continue;
    updates.push({
      id: f.id, dropbox_id: f.dropbox_id, path_lower: f.path_lower, name: f.name,
      customer_id: m.customerId, match_status: m.status, match_score: m.score,
      candidates: m.candidates, matched_at: m.status === 'auto' ? now : null, updated_at: now,
    });
  }
  for (let i = 0; i < updates.length; i += UPSERT_CHUNK) {
    const { error: upErr } = await service.from('dropbox_client_folders')
      .upsert(updates.slice(i, i + UPSERT_CHUNK), { onConflict: 'id' });
    if (upErr) throw new Error(`match save: ${upErr.message}`);
  }
  return counts;
}

// ── Copying ──

interface CopyRow {
  id: string;
  dropbox_id: string;
  ext: string;
  rev: string | null;
  size_bytes: number;
  kind: string;
  copy_failed_rev: string | null;
  copy_attempts: number;
}

async function copyPending(service: SupabaseClient, stopAt: number): Promise<{ copied: number; bytes: number; failed: number }> {
  const out = { copied: 0, bytes: 0, failed: 0 };
  const tried = new Set<string>();
  while (Date.now() < stopAt) {
    const { data, error } = await service.from('dropbox_client_files')
      .select('id, dropbox_id, ext, rev, size_bytes, kind, copy_failed_rev, copy_attempts')
      .eq('needs_copy', true)
      .order('server_modified', { ascending: false, nullsFirst: false })
      .order('id')
      .limit(COPY_BATCH + tried.size);
    if (error) throw new Error(error.message);
    const batch = ((data || []) as CopyRow[]).filter(r => !tried.has(r.id)).slice(0, COPY_BATCH);
    if (batch.length === 0) break;
    for (let i = 0; i < batch.length && Date.now() < stopAt; i += COPY_CONCURRENCY) {
      const slice = batch.slice(i, i + COPY_CONCURRENCY);
      slice.forEach(r => tried.add(r.id));
      const results = await Promise.all(slice.map(r => copyOne(service, r)));
      for (const r of results) {
        if (r.ok) { out.copied++; out.bytes += r.bytes; } else out.failed++;
      }
    }
  }
  return out;
}

async function copyOne(service: SupabaseClient, row: CopyRow): Promise<{ ok: boolean; bytes: number }> {
  try {
    const file = await downloadFile(row.dropbox_id);
    const key = copyKeyFor(row.dropbox_id, row.ext);
    const up = await r2Upload(CLIENT_FILES_R2_PREFIX, key, file.buffer, contentTypeFor(row.ext));
    if (!up.success) throw new Error(up.error || 'R2 upload failed');

    let thumbPath: string | null = null;
    if (wantsThumbnail(row.ext) && (row.kind === 'pdf' || row.size_bytes <= THUMB_MAX_BYTES)) {
      try {
        const thumb = await getThumbnail(row.dropbox_id, 'w256h256');
        const t = await r2Upload(CLIENT_FILES_R2_PREFIX, thumbKeyFor(row.dropbox_id), thumb.buffer, 'image/png');
        if (t.success) thumbPath = thumbKeyFor(row.dropbox_id);
      } catch {
        // No thumbnail is fine: the list shows a file-type tile instead.
      }
    }

    const { error } = await service.from('dropbox_client_files').update({
      r2_path: key,
      copied_rev: file.rev || row.rev,
      thumb_path: thumbPath,
      copy_error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (error) throw new Error(error.message);
    return { ok: true, bytes: file.buffer.byteLength };
  } catch (err: any) {
    const attempts = row.copy_failed_rev === row.rev ? row.copy_attempts + 1 : 1;
    await service.from('dropbox_client_files').update({
      copy_failed_rev: row.rev,
      copy_attempts: attempts,
      copy_error: String(err?.message || err).slice(0, 300),
      updated_at: new Date().toISOString(),
    }).eq('id', row.id);
    return { ok: false, bytes: 0 };
  }
}
