/**
 * A copy of every estimate file in the customer's own Dropbox client folder
 * (Craig, 2026-10-22, thread "Approval email pictures on the estimate"):
 *
 *   <client folder>/Estimates/<EST number>/<file name>
 *
 * FleetSuite's own copy (estimate_files + R2) stays the real one: the
 * estimate's Pictures & files section and Client Files' "From Estimates"
 * folder read it whether or not Dropbox has a copy. A customer with no
 * Dropbox folder linked yet is simply skipped; the Client Files cron
 * (copyPendingEstimateFiles) copies their files once someone links one.
 * Removing a file from the estimate leaves the Dropbox copy alone.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { r2GetBytes } from './r2';
import { uploadFile } from './dropbox';
import { ESTIMATE_FILE_PREFIX } from './estimate-attachments';
import { normalizeCompanyName } from './customer-dupes';
import { dropboxPathPart } from './dropbox-path';

export { dropboxPathPart };

type Db = SupabaseClient<any, any, any>;

/** A failed copy is tried again after this long (a fixed setting needs no hammering). */
export const DROPBOX_RETRY_MS = 60 * 60 * 1000;

export interface LinkedFolder { id: string; name: string; path_lower: string; file_count?: number | null }


/**
 * Which of a customer's linked folders gets the copy. Most customers have
 * one. Masterack-style customers also have their end customers' folders
 * linked, so the folder named like the customer wins, then the biggest.
 */
export function pickCustomerFolder(folders: LinkedFolder[], companyName: string | null | undefined): LinkedFolder | null {
  if (folders.length === 0) return null;
  const want = normalizeCompanyName(companyName || '');
  const named = want ? folders.find(f => normalizeCompanyName(f.name) === want) : undefined;
  if (named) return named;
  return [...folders].sort((a, b) => (b.file_count || 0) - (a.file_count || 0) || a.name.localeCompare(b.name))[0];
}

/** Where the copy goes: path_lower keeps the existing folders' own case in Dropbox. */
export function estimateFileDropboxPath(folder: Pick<LinkedFolder, 'path_lower'>, estimateNumber: string, fileName: string): string {
  return `${folder.path_lower.replace(/\/+$/, '')}/Estimates/${dropboxPathPart(estimateNumber)}/${dropboxPathPart(fileName)}`;
}

interface PendingFile {
  id: string;
  file_name: string;
  storage_path: string;
  estimate: { id: string; estimate_number: string | null; customer_id: string | null; customer: { company_name: string | null } | null } | null;
}

const PENDING_SELECT = 'id, file_name, storage_path, estimate:estimates(id, estimate_number, customer_id, customer:customers(company_name))';

async function foldersFor(db: Db, customerIds: string[]): Promise<Map<string, LinkedFolder[]>> {
  const out = new Map<string, LinkedFolder[]>();
  if (customerIds.length === 0) return out;
  const { data, error } = await db.from('dropbox_client_folders')
    .select('id, name, path_lower, file_count, customer_id')
    .in('customer_id', customerIds)
    .is('deleted_at', null);
  if (error) throw new Error(error.message);
  for (const f of (data || []) as (LinkedFolder & { customer_id: string })[]) {
    const list = out.get(f.customer_id) || [];
    list.push(f);
    out.set(f.customer_id, list);
  }
  return out;
}

export type CopyOutcome = 'copied' | 'no_folder' | 'failed';

async function copyOne(db: Db, f: PendingFile, folders: LinkedFolder[]): Promise<CopyOutcome> {
  const est = f.estimate;
  const folder = pickCustomerFolder(folders, est?.customer?.company_name);
  if (!est || !folder) return 'no_folder';
  const now = new Date().toISOString();
  try {
    const file = await r2GetBytes(ESTIMATE_FILE_PREFIX, f.storage_path);
    if (!file) throw new Error("FleetSuite's copy of the file could not be read.");
    const saved = await uploadFile(estimateFileDropboxPath(folder, est.estimate_number || est.id, f.file_name), file.bytes);
    await db.from('estimate_files')
      .update({ dropbox_path: saved.pathDisplay, dropbox_copied_at: now, dropbox_error: null, dropbox_tried_at: now })
      .eq('id', f.id);
    return 'copied';
  } catch (e: any) {
    await db.from('estimate_files')
      .update({ dropbox_error: String(e?.message || e).slice(0, 500), dropbox_tried_at: now })
      .eq('id', f.id);
    return 'failed';
  }
}

/** Copy one estimate file now (right after it is uploaded). Never throws. */
export async function copyEstimateFileToDropbox(db: Db, fileId: string): Promise<CopyOutcome> {
  try {
    const { data, error } = await db.from('estimate_files').select(PENDING_SELECT).eq('id', fileId).maybeSingle();
    if (error || !data) return 'failed';
    const f = data as unknown as PendingFile;
    if (!f.estimate?.customer_id) return 'no_folder';
    const folders = await foldersFor(db, [f.estimate.customer_id]);
    return await copyOne(db, f, folders.get(f.estimate.customer_id) || []);
  } catch (e: any) {
    console.error('[estimate-file-dropbox] copy failed:', e?.message || e);
    return 'failed';
  }
}

/**
 * The catch-up, run by the Client Files cron: files not in Dropbox yet,
 * least recently tried first. A file whose customer has no folder linked is
 * only stamped as looked at (no error), so it comes round again within the
 * hour and is copied once someone links a folder.
 */
export async function copyPendingEstimateFiles(db: Db, opts: { deadline: number; max?: number }): Promise<{ copied: number; failed: number; waiting: number }> {
  const max = opts.max ?? 25;
  const retryBefore = new Date(Date.now() - DROPBOX_RETRY_MS).toISOString();
  const { data, error } = await db.from('estimate_files')
    .select(PENDING_SELECT)
    .is('dropbox_path', null)
    .or(`dropbox_tried_at.is.null,dropbox_tried_at.lt.${retryBefore}`)
    .order('dropbox_tried_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  const rows = (data || []) as unknown as PendingFile[];
  const customerIds = [...new Set(rows.map(r => r.estimate?.customer_id).filter((x): x is string => !!x))];
  const folders = await foldersFor(db, customerIds);

  let copied = 0;
  let failed = 0;
  const noFolder: string[] = [];
  for (const f of rows) {
    const list = f.estimate?.customer_id ? folders.get(f.estimate.customer_id) : undefined;
    if (!list?.length) { noFolder.push(f.id); continue; }
    if (copied + failed >= max || Date.now() > opts.deadline) continue;
    const out = await copyOne(db, f, list);
    if (out === 'copied') copied++;
    else if (out === 'failed') failed++;
  }
  const now = new Date().toISOString();
  for (let i = 0; i < noFolder.length; i += 100) {
    await db.from('estimate_files').update({ dropbox_tried_at: now }).in('id', noFolder.slice(i, i + 100));
  }
  return { copied, failed, waiting: noFolder.length };
}
