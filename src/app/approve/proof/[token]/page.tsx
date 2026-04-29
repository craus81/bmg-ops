'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'next/navigation';

interface LoadState {
  status: 'loading' | 'ready' | 'already_approved' | 'already_rejected' | 'expired' | 'invalid' | 'submitted_accepted' | 'submitted_rejected' | 'error';
  job?: any;
  files?: { id: string; file_name: string; url: string; is_pdf: boolean }[];
  message?: string;
}

// Mirrors src/lib/magic-link-approval.ts AGREEMENT_TEXT (customer-facing copy adjusted).
const AGREEMENT_TEXT =
  'By checking this box, I approve this graphic proof and authorize BMG Fleet Installations to produce and install it as shown. ' +
  'This action is legally binding and equivalent to a signed agreement under the U.S. E-SIGN Act.';

export default function ProofApprovalPage() {
  const params = useParams<{ token: string }>();
  const searchParams = useSearchParams();
  const token = params?.token || '';
  const deliveryChannel = searchParams?.get('via') === 'sms' ? 'sms_link' : 'email_link';
  const deliveryTarget = searchParams?.get('to') || null;

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pageLoadedAt = useRef<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/approve/proof/${encodeURIComponent(token)}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) { setState({ status: data.status || 'invalid', message: data.error }); return; }
        setState({ status: data.status, job: data.job, files: data.files });
      } catch (e: any) {
        if (!cancelled) setState({ status: 'error', message: e?.message });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (action: 'accept' | 'reject') => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const timeOnPageSeconds = Math.round((Date.now() - pageLoadedAt.current) / 1000);
    try {
      const res = await fetch(`/api/approve/proof/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          timeOnPageSeconds,
          deliveryChannel,
          deliveryTarget,
          reason: action === 'reject' ? rejectReason.trim() : undefined,
          agreementText: action === 'accept' ? AGREEMENT_TEXT : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Submit failed'); setSubmitting(false); return; }
      setState({ status: action === 'accept' ? 'submitted_accepted' : 'submitted_rejected', job: state.job, files: state.files });
    } catch (e: any) { setError(e?.message || 'Network error'); }
    setSubmitting(false);
  };

  if (state.status === 'loading') return <Frame>Loading proof...</Frame>;
  if (state.status === 'invalid') return <Frame>This approval link is no longer valid. If a newer email was sent, please use that one — otherwise contact BMG Fleet Installations.</Frame>;
  if (state.status === 'expired') return <Frame>This approval link has expired. Please ask BMG Fleet Installations to re-send.</Frame>;
  if (state.status === 'already_approved') return <Frame><Accepted job={state.job} /></Frame>;
  if (state.status === 'already_rejected') return <Frame><Rejected job={state.job} /></Frame>;
  if (state.status === 'error') return <Frame>Something went wrong{state.message ? `: ${state.message}` : ''}.</Frame>;
  if (state.status === 'submitted_accepted') return <Frame><Accepted job={state.job} justAccepted /></Frame>;
  if (state.status === 'submitted_rejected') return <Frame><Rejected job={state.job} justRejected /></Frame>;

  const job = state.job;
  const files = state.files || [];

  return (
    <Frame>
      <div style={{ marginBottom: '18px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>
          BMG Fleet Installations
        </div>
        <div style={{ fontSize: '22px', fontWeight: 800, color: '#0f172a', marginTop: '4px' }}>
          Proof: {job.title || job.part_number || `Job #${job.job_number}`}
        </div>
        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
          {job.customer ? `For ${job.customer}` : ''}
          {job.quantity ? ` · Qty: ${job.quantity}` : ''}
          {job.part_number ? ` · Part: ${job.part_number}` : ''}
        </div>
      </div>

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

      {rejectMode ? (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a', marginBottom: '8px' }}>Request changes</div>
          <textarea
            rows={3}
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            placeholder="What would you like changed on this proof?"
            style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px', fontFamily: 'inherit', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
            <button
              onClick={() => submit('reject')}
              disabled={submitting || !rejectReason.trim()}
              style={{ flex: 1, padding: '10px 14px', borderRadius: '10px', border: 'none', background: '#ef4444', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer', opacity: rejectReason.trim() && !submitting ? 1 : 0.5 }}
            >{submitting ? 'Submitting...' : 'Send change request'}</button>
            <button
              onClick={() => { setRejectMode(false); setRejectReason(''); }}
              style={{ padding: '10px 14px', borderRadius: '10px', border: '1px solid #cbd5e1', background: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
            >Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px' }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={agreed}
              onChange={e => setAgreed(e.target.checked)}
              style={{ marginTop: '2px', flexShrink: 0 }}
            />
            <span style={{ fontSize: '12px', color: '#0f172a', lineHeight: 1.5 }}>{AGREEMENT_TEXT}</span>
          </label>
          <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
            <button
              onClick={() => submit('accept')}
              disabled={!agreed || submitting || files.length === 0}
              style={{ flex: 1, padding: '12px 14px', borderRadius: '10px', border: 'none', background: '#16a34a', color: '#fff', fontSize: '14px', fontWeight: 800, cursor: agreed && !submitting && files.length > 0 ? 'pointer' : 'not-allowed', opacity: agreed && !submitting && files.length > 0 ? 1 : 0.5 }}
            >{submitting ? 'Submitting...' : 'Approve Proof'}</button>
            <button
              onClick={() => setRejectMode(true)}
              disabled={submitting}
              style={{ padding: '12px 14px', borderRadius: '10px', border: '1px solid #cbd5e1', background: '#fff', color: '#0f172a', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
            >Request Changes</button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: '12px', padding: '10px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '10px', color: '#b91c1c', fontSize: '12px' }}>
          {error}
        </div>
      )}

      <Footer />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#f1f5f9', padding: '20px 16px' }}>
      <div style={{ maxWidth: '640px', margin: '0 auto', background: '#fff', borderRadius: '14px', padding: '22px', border: '1px solid #e2e8f0' }}>
        {children}
      </div>
    </div>
  );
}

function Accepted({ job, justAccepted }: { job?: any; justAccepted?: boolean }) {
  return (
    <div style={{ textAlign: 'center', padding: '20px 10px' }}>
      <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: '#dcfce7', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: '28px', color: '#16a34a' }}>✓</div>
      <div style={{ fontSize: '18px', fontWeight: 800, color: '#0f172a' }}>{justAccepted ? 'Thanks — proof approved' : 'Already approved'}</div>
      {job?.job_number && <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>Job #{job.job_number}</div>}
      {job?.customer_approved_at && (
        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '10px' }}>
          {new Date(job.customer_approved_at).toLocaleString()}
        </div>
      )}
      <Footer />
    </div>
  );
}

function Rejected({ job, justRejected }: { job?: any; justRejected?: boolean }) {
  return (
    <div style={{ textAlign: 'center', padding: '20px 10px' }}>
      <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: '24px', color: '#b91c1c' }}>!</div>
      <div style={{ fontSize: '18px', fontWeight: 800, color: '#0f172a' }}>{justRejected ? 'Thanks — we\u2019ll revise' : 'Changes requested'}</div>
      {job?.job_number && <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>Job #{job.job_number}</div>}
      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <div style={{ textAlign: 'center', marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e2e8f0', fontSize: '11px', color: '#94a3b8' }}>
      BMG Fleet Installations LLC · FleetSuite
    </div>
  );
}
