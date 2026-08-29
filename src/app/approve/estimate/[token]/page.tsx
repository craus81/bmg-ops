'use client';

/**
 * Public estimate approval page — magic-link, no login. The approval
 * machinery (state machine, agreement + accept/reject actions, terminal
 * screens) lives in ApprovalPageShell, shared with /approve/quote and
 * /approve/proof; this file renders only the estimate document body.
 * This URL must live forever: 30-day tokens are in the wild.
 */

import ApprovalPageShell from '@/components/ApprovalPageShell';
import EstimateApprovalDocument from '@/components/EstimateApprovalDocument';
import { AGREEMENT_TEXT, COMBINED_AGREEMENT_TEXT } from '@/lib/approval-agreement';

export default function EstimateApprovalPage() {
  return (
    <ApprovalPageShell
      kind="estimate"
      noun="estimate"
      // When the document carries graphic proofs from linked graphics
      // jobs, one checkbox approves design + price together — and the
      // server propagates the acceptance onto those jobs.
      agreementText={d => (d?.proofs?.length ? COMBINED_AGREEMENT_TEXT : AGREEMENT_TEXT)}
      parsePayload={json => ({ estimate: json.estimate, lines: json.lines || [], graphics: json.graphics || [], proofs: json.proofs || [] })}
      docLabel={d => d?.estimate?.estimate_number ? `Estimate #${d.estimate.estimate_number}` : null}
      acceptedAt={d => d?.estimate?.customer_approved_at || null}
      renderDocument={d => <EstimateApprovalDocument estimate={d.estimate} lines={d.lines} graphics={d.graphics} proofs={d.proofs} />}
    />
  );
}
