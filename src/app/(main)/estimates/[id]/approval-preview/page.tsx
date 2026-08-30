'use client';

/**
 * Staff preview of the customer's estimate approval page — the same
 * document (EstimateApprovalDocument) in the same frame, with the
 * accept/reject card replaced by a notice.
 *
 * Why a separate page rather than opening the customer's link: that link
 * carries the approval token, and anyone holding it can accept. Opening it
 * to "just look" risks recording a real E-SIGN acceptance — staff IP, staff
 * user-agent — against the customer's name. So the token never reaches a
 * client (stripApprovalSecrets in the estimates route), and this page reads
 * the document by estimate id through a requireStaff endpoint instead.
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ApprovalFrame } from '@/components/ApprovalPageShell';
import EstimateApprovalDocument from '@/components/EstimateApprovalDocument';

interface ApprovalView {
  estimate: any;
  lines: any[];
  graphics: any[];
  proofs?: any[];
  decided: 'approved' | 'rejected' | null;
  sentAt: string | null;
}

export default function EstimateApprovalPreviewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id || '';

  const [view, setView] = useState<ApprovalView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/estimates/${encodeURIComponent(id)}/approval-preview`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(json.error === 'not_found' ? 'Estimate not found.' : (json.error || 'Failed to load')); return; }
        setView(json);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Network error');
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (error) return <ApprovalFrame>{error}</ApprovalFrame>;
  if (!view) return <ApprovalFrame>Loading preview…</ApprovalFrame>;

  const state = view.decided === 'approved'
    ? 'The customer has already approved this — their link now shows the accepted screen.'
    : view.decided === 'rejected'
      ? 'The customer requested changes — their link now shows the changes-requested screen.'
      : view.sentAt
        ? `Sent ${new Date(view.sentAt).toLocaleString()}. Their link is live.`
        : 'Not sent yet — this is what the customer will see.';

  return (
    <ApprovalFrame>
      <div style={{
        background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px',
        padding: '12px 14px', marginBottom: '16px',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 800, color: '#1d4ed8' }}>
          Staff preview — read only
        </div>
        <div style={{ fontSize: '12px', color: '#1e3a8a', marginTop: '4px', lineHeight: 1.5 }}>
          This is the page the customer gets from the email&apos;s <b>Review &amp; Approve</b> button.
          They also see an agreement checkbox with <b>Accept &amp; Authorize Work</b> and{' '}
          <b>Request Changes</b> below the document; those are left off here so a look
          can&apos;t become a signed acceptance in the customer&apos;s name.
        </div>
        <div style={{ fontSize: '11px', color: '#1e40af', marginTop: '6px', fontWeight: 600 }}>
          {state}
        </div>
      </div>

      <EstimateApprovalDocument estimate={view.estimate} lines={view.lines} graphics={view.graphics} proofs={view.proofs || []} />

      <div style={{ marginTop: '18px', textAlign: 'center' }}>
        <button
          onClick={() => router.push('/estimates')}
          style={{
            padding: '10px 16px', borderRadius: '10px', border: '1px solid #cbd5e1',
            background: '#fff', color: '#0f172a', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
          }}
        >
          Back to estimates
        </button>
      </div>
    </ApprovalFrame>
  );
}
