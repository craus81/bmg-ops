/**
 * Which emails an estimate file went out on (estimate_files.sent_on,
 * migration 425), as the estimate's Pictures & files section tags it.
 * Pure and client-safe; the send routes write through
 * recordEstimateFilesSent in estimate-attachments.ts.
 */

export type EstimateFileSendKind = 'approval' | 'email_pdf' | 'follow_up' | 'review';

export const SEND_KIND_LABELS: Record<EstimateFileSendKind, string> = {
  approval: 'Sent for approval',
  email_pdf: 'Emailed with PDF',
  follow_up: 'Sent in follow-up',
  review: 'Sent for review',
};

export interface FileSend { kind: EstimateFileSendKind; at: string }

/** "10/21" in the viewer's time zone. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
}

/** "Sent for approval 10/21", once per kind and day, oldest first. */
export function sentTags(sentOn: FileSend[] | null | undefined): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(sentOn) ? sentOn : []) {
    const label = SEND_KIND_LABELS[s?.kind];
    if (!label) continue;
    const tag = `${label} ${shortDate(s.at)}`.trim();
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}
