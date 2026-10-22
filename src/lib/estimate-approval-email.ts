/**
 * The approval email's wording around the estimate document (Craig,
 * 2026-10-21, thread "Estimate email attachment and approval link"): the
 * email attaches nothing, repeats Review & Approve at the top with a
 * Download PDF link, says who else got a copy, and says forwarding works.
 */

/** The small line under the approval button: the expiry, and who else got
 *  a copy (each person gets their own email, so nobody sees the others in
 *  the To line). */
export function approvalCtaNote(expiryDays: number, others: string[]): string {
  const expiry = `Approve or request changes on the next page. This link expires in ${expiryDays} days.`;
  return others.length > 0 ? `${expiry} Also sent to ${others.join(', ')}.` : expiry;
}

/** What the approval email adds around the estimate document: the button
 *  again at the top with the Download PDF link under it, the downloads
 *  section's heading, and the line on forwarding. */
export function approvalEmailExtras(fleet: boolean, pdfUrl: string) {
  return {
    ctaTop: fleet ? { downloadUrl: null } : { downloadUrl: pdfUrl, downloadLabel: 'Download PDF' },
    attachmentsTitle: 'Downloads',
    forwardNote: 'Need someone else to sign off? Forward this email. Anyone you send it to can open Review & Approve, download the PDF, and approve or request changes.',
  };
}
