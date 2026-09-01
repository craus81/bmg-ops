/**
 * Files a rep uploaded onto an estimate (estimate_files + R2 under the
 * 'estimate-files' prefix) and rides along on its customer emails —
 * pictures, spec sheets, anything the estimate itself doesn't carry.
 *
 * All three estimate email flows (send-for-approval, email-pdf, and the
 * quote follow-up) resolve their picked attachments through here, so
 * "does this file belong to this estimate?", the size cap, and the
 * selection order behave identically on every send.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MAX_ATTACHMENT_BYTES,
  fetchEmailAttachments,
  type EmailAttachment,
} from './email-attachments';

export const ESTIMATE_FILE_PREFIX = 'estimate-files';

export interface EstimateFileRow {
  id: string;
  file_name: string;
  file_size: number | null;
  file_type: string | null;
  storage_path: string;
}

type Fail = { ok: false; status: number; error: string };

/**
 * Resolve the compose screen's picked ids to rows on THIS estimate, in the
 * sender's selection order, with the declared sizes checked against the
 * budget. An id that isn't on the estimate is a hard error, never a silent
 * drop — the sender must never believe a file went out when it didn't.
 */
export async function loadEstimateAttachmentRows(
  supabase: SupabaseClient<any, any, any>,
  estimateId: string,
  fileIds: string[] | null | undefined,
): Promise<{ ok: true; rows: EstimateFileRow[] } | Fail> {
  const ids = [...new Set((fileIds || []).filter(Boolean))];
  if (ids.length === 0) return { ok: true, rows: [] };

  const { data, error } = await supabase
    .from('estimate_files')
    .select('id, file_name, content_type, size_bytes, storage_path')
    .in('id', ids)
    .eq('estimate_id', estimateId);
  if (error) {
    return { ok: false, status: 500, error: 'Could not load the selected attachments: ' + error.message };
  }

  const rows: EstimateFileRow[] = (data || []).map((r: any) => ({
    id: r.id,
    file_name: r.file_name,
    file_size: r.size_bytes ?? null,
    file_type: r.content_type ?? null,
    storage_path: r.storage_path,
  }));
  if (rows.length !== ids.length) {
    return { ok: false, status: 400, error: 'Some selected attachments do not belong to this estimate. Reload and try again.' };
  }
  rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  const declaredTotal = rows.reduce((sum, r) => sum + (r.file_size || 0), 0);
  if (declaredTotal > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false, status: 400,
      error: `Attachments total ${(declaredTotal / (1024 * 1024)).toFixed(1)}MB — the limit is ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB. Deselect some files.`,
    };
  }
  return { ok: true, rows };
}

/**
 * Fetch the bytes for resolved rows. Call it BEFORE minting tokens or
 * stamping the estimate as sent: a storage failure has to fail the whole
 * send, with the file named.
 *
 * `budgetBytes` is what's left after any auto-attached document (e.g. the
 * merged estimate PDF) has taken its share.
 */
export async function fetchEstimateAttachments(
  rows: EstimateFileRow[],
  budgetBytes?: number,
): Promise<{ ok: true; attachments: EmailAttachment[] } | Fail> {
  if (rows.length === 0) return { ok: true, attachments: [] };
  return fetchEmailAttachments(ESTIMATE_FILE_PREFIX, rows, budgetBytes);
}
