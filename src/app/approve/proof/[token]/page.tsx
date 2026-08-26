'use client';

/**
 * Public graphics-proof approval page — magic-link, no login. The approval
 * machinery (state machine, agreement + accept/reject actions, terminal
 * screens) lives in ApprovalPageShell, shared with /approve/estimate and
 * /approve/quote; this file renders only the proof files and passes the
 * proof-specific agreement copy. This URL must live forever: 30-day
 * tokens are in the wild.
 */

import ApprovalPageShell, { ApprovalHeader } from '@/components/ApprovalPageShell';

// Proof-specific E-SIGN copy — approving artwork for production, not
// authorizing quoted work (src/lib/approval-agreement.ts is the default).
const PROOF_AGREEMENT_TEXT =
  'By checking this box, I approve this graphic proof and authorize BMG Fleet Installations to produce and install it as shown. ' +
  'This action is legally binding and equivalent to a signed agreement under the U.S. E-SIGN Act.';

export default function ProofApprovalPage() {
  return (
    <ApprovalPageShell
      kind="proof"
      noun="proof"
      agreementText={PROOF_AGREEMENT_TEXT}
      copy={{
        invalid: 'This approval link is no longer valid. If a newer email was sent, please use that one — otherwise contact BMG Fleet Installations.',
        acceptLabel: 'Approve Proof',
        rejectSendLabel: 'Send change request',
        rejectPlaceholder: 'What would you like changed on this proof?',
        acceptedTitle: 'Thanks — proof approved',
        rejectedTitle: 'Thanks — we’ll revise',
      }}
      parsePayload={json => ({ job: json.job, files: json.files || [] })}
      docLabel={d => d?.job?.job_number ? `Job #${d.job.job_number}` : null}
      acceptedAt={d => d?.job?.customer_approved_at || null}
      canAccept={d => (d?.files || []).length > 0}
      renderDocument={d => <ProofDocument job={d.job} files={d.files} />}
    />
  );
}

function ProofDocument({ job, files }: { job: any; files: { id: string; file_name: string; url: string; is_pdf: boolean }[] }) {
  return (
    <>
      <ApprovalHeader title={`Proof: ${job.title || job.part_number || `Job #${job.job_number}`}`}>
        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
          {job.customer ? `For ${job.customer}` : ''}
          {job.quantity ? ` · Qty: ${job.quantity}` : ''}
          {job.part_number ? ` · Part: ${job.part_number}` : ''}
        </div>
      </ApprovalHeader>

      {files.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '18px' }}>
          {files.map(f => (
            <div key={f.id} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '12px' }}>
              {f.is_pdf ? (
                <a href={f.url} target="_blank" rel="noopener noreferrer" style={{
                  display: 'block', padding: '12px 16px', background: '#0f172a', color: '#fff',
                  borderRadius: '10px', textAlign: 'center', textDecoration: 'none', fontWeight: 700, fontSize: '13px',
                }}>
                  Open {f.file_name} (PDF) ↗
                </a>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.url} alt={f.file_name} style={{ width: '100%', borderRadius: '8px', display: 'block' }} />
              )}
              <div style={{ marginTop: '6px', fontSize: '11px', color: '#64748b' }}>{f.file_name}</div>
            </div>
          ))}
        </div>
      ) : job.proof_url ? (
        <div style={{ marginBottom: '18px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '12px' }}>
          <a href={job.proof_url} target="_blank" rel="noopener noreferrer" style={{
            display: 'block', padding: '12px 16px', background: '#0f172a', color: '#fff',
            borderRadius: '10px', textAlign: 'center', textDecoration: 'none', fontWeight: 700, fontSize: '13px',
          }}>
            Open proof ↗
          </a>
        </div>
      ) : (
        <div style={{ marginBottom: '18px', padding: '12px', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '12px', color: '#92400e', fontSize: '13px' }}>
          No proof file attached yet. Please contact BMG Fleet Installations.
        </div>
      )}

      {job.notes && (
        <div style={{ marginBottom: '18px', padding: '12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', fontSize: '13px', whiteSpace: 'pre-wrap' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>Notes</div>
          {job.notes}
        </div>
      )}
    </>
  );
}
