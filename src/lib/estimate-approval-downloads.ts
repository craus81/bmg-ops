/**
 * Download links for everything an estimate approval email carries — the
 * estimate PDF, the files the rep attached, the graphic proofs — served from
 * our own domain behind the approval token.
 *
 * Why: the email's attachments are the customer's copy, but corporate mail
 * filters strip or quarantine attachments, a forward from a phone may drop
 * them, and the approval page had no way to get the PDF at all. These links
 * work wherever the approval link works (same token, same expiry), so a
 * customer — or whoever they forwarded the email to — can always download
 * the exact set of files the estimate went out with.
 *
 * The set is pinned at send time: send-for-approval stores the picked
 * estimate_files ids on estimates.approval_file_ids (migration 368), so a
 * file added to the estimate later never appears on a link the customer
 * already holds.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { estimatePdfFilename } from './estimate-pdf';
import type { EstimateProofBlock } from './estimate-graphics';

export interface ApprovalDownload {
  name: string;
  url: string;
  kind: 'pdf' | 'file' | 'proof';
}

/** The three download URL shapes, relative to `appUrl` ('' for same-origin links on the approval page). */
export function approvalDownloadUrls(appUrl: string, token: string) {
  const base = `${appUrl}/api/approve/estimate/${encodeURIComponent(token)}`;
  return {
    pdf: `${base}/download/pdf`,
    file: (fileId: string) => `${base}/download/file/${encodeURIComponent(fileId)}`,
    proof: (fileId: string) => `${base}/proof/${encodeURIComponent(fileId)}?download=1`,
  };
}

/**
 * The download list for an estimate: the PDF first, then the files that
 * rode on the approval email, then the graphic proofs. Best-effort on the
 * file lookup — a storage hiccup drops those rows rather than the page.
 */
export async function loadApprovalDownloads(
  service: SupabaseClient<any, any, any>,
  estimate: { id: string; estimate_number?: string | null; approval_file_ids?: string[] | null },
  proofs: EstimateProofBlock[],
  appUrl: string,
  token: string,
): Promise<ApprovalDownload[]> {
  const urls = approvalDownloadUrls(appUrl, token);
  const out: ApprovalDownload[] = [{ name: estimatePdfFilename(estimate), url: urls.pdf, kind: 'pdf' }];

  const ids = (estimate.approval_file_ids || []).filter(Boolean);
  if (ids.length > 0) {
    try {
      const { data: rows } = await service
        .from('estimate_files')
        .select('id, file_name')
        .in('id', ids)
        .eq('estimate_id', estimate.id);
      const byId = new Map((rows || []).map((r: any) => [r.id, r.file_name as string]));
      for (const id of ids) {
        const name = byId.get(id);
        if (name) out.push({ name, url: urls.file(id), kind: 'file' });
      }
    } catch (err: any) {
      console.warn('[approval-downloads] estimate_files lookup failed:', err?.message || err);
    }
  }

  for (const block of proofs) {
    for (const f of block.files) out.push({ name: f.name, url: urls.proof(f.id), kind: 'proof' });
  }
  return out;
}

/**
 * A Content-Disposition that keeps the customer's filename: an ASCII
 * fallback for old clients plus the RFC 5987 UTF-8 form for everyone else.
 */
export function attachmentDisposition(filename: string): string {
  const clean = String(filename || 'download').replace(/[\r\n]+/g, ' ').trim() || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}
