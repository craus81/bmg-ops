/**
 * Shared attachment budget + byte-fetching for customer email sends
 * (docs/customer-email-standard.md).
 *
 * One definition of the cap, used by every compose flow's server side and
 * mirrored by EmailComposeModal's default — two flows drifting to two
 * different limits is how "it let me attach it but the send failed"
 * happens.
 */

import { r2Get } from './r2';

// Total attachment budget per email. Resend caps messages at 40MB, but
// plenty of corporate inboxes bounce well before that — 20MB is the safe
// ceiling, enforced against declared sizes up front and actual bytes after
// fetching (upload rows can carry a null size).
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const attachmentLimitMb = () => Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));

export async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface StoredAttachment {
  file_name: string;
  file_size?: number | null;
  file_type?: string | null;
  storage_path: string;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/**
 * Pull attachment bytes out of R2, re-checking the real size as they land.
 * Returns an error instead of throwing so callers can fail the send BEFORE
 * minting tokens or stamping records — a file that can't be fetched must
 * never become a half-sent email.
 */
export async function fetchEmailAttachments(
  bucketPrefix: string,
  rows: StoredAttachment[],
  budgetBytes = MAX_ATTACHMENT_BYTES,
): Promise<{ ok: true; attachments: EmailAttachment[] } | { ok: false; status: number; error: string }> {
  const attachments: EmailAttachment[] = [];
  let fetchedTotal = 0;
  for (const row of rows) {
    const result = await r2Get(bucketPrefix, row.storage_path);
    if (!result.success || !result.body) {
      return {
        ok: false, status: 502,
        error: `Could not fetch attachment "${row.file_name}" from storage: ${result.error || 'unknown error'}`,
      };
    }
    const content = await streamToBuffer(result.body);
    fetchedTotal += content.byteLength;
    if (fetchedTotal > budgetBytes) {
      return {
        ok: false, status: 400,
        error: `Attachments exceed the ${Math.round(budgetBytes / (1024 * 1024))}MB limit ("${row.file_name}" pushed it over). Deselect some files.`,
      };
    }
    attachments.push({
      filename: row.file_name,
      content,
      contentType: row.file_type || result.contentType || undefined,
    });
  }
  return { ok: true, attachments };
}
