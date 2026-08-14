'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useSearchParams } from 'next/navigation';

interface LoadState {
  status: 'loading' | 'ready' | 'already_approved' | 'already_rejected' | 'expired' | 'invalid' | 'submitted_accepted' | 'submitted_rejected' | 'error';
  estimate?: any;
  lines?: any[];
  message?: string;
}

// Keep this agreement text in sync with src/lib/magic-link-approval.ts AGREEMENT_TEXT
const AGREEMENT_TEXT =
  'By checking this box, I agree to the terms of this estimate and authorize BMG Fleet Installations to begin work. ' +
  'This action is legally binding and equivalent to a signed agreement under the U.S. E-SIGN Act.';

export default function EstimateApprovalPage() {
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
        const res = await fetch(`/api/approve/estimate/${encodeURIComponent(token)}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setState({ status: data.status || 'invalid', message: data.error });
          return;
        }
        setState({ status: data.status, estimate: data.estimate, lines: data.lines });
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
      const res = await fetch(`/api/approve/estimate/${encodeURIComponent(token)}`, {
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
      if (!res.ok) {
        setError(data.error || 'Submit failed');
        setSubmitting(false);
        return;
      }
      setState({ status: action === 'accept' ? 'submitted_accepted' : 'submitted_rejected', estimate: state.estimate, lines: state.lines });
    } catch (e: any) {
      setError(e?.message || 'Network error');
    }
    setSubmitting(false);
  };

  const subtotal = useMemo(
    () => (state.lines || []).reduce((s: number, l: any) => s + (l.line_total || l.unit_price * l.quantity || 0), 0),
    [state.lines]
  );

  if (state.status === 'loading') {
    return <Frame>Loading estimate...</Frame>;
  }
  if (state.status === 'invalid') {
    return <Frame>Invalid approval link. Please contact BMG Fleet Installations.</Frame>;
  }
  if (state.status === 'expired') {
    return <Frame>This approval link has expired. Please ask BMG Fleet Installations to re-send.</Frame>;
  }
  if (state.status === 'already_approved') {
    return <Frame><Accepted estimate={state.estimate} /></Frame>;
  }
  if (state.status === 'already_rejected') {
    return <Frame><Rejected estimate={state.estimate} /></Frame>;
  }
  if (state.status === 'error') {
    return <Frame>Something went wrong{state.message ? `: ${state.message}` : ''}. Please try again.</Frame>;
  }
  if (state.status === 'submitted_accepted') {
    return <Frame><Accepted estimate={state.estimate} justAccepted /></Frame>;
  }
  if (state.status === 'submitted_rejected') {
    return <Frame><Rejected estimate={state.estimate} justRejected /></Frame>;
  }

  const est = state.estimate;
  const lines = state.lines || [];

  return (
    <Frame>
      <div style={{ marginBottom: '18px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>
          BMG Fleet Installations
        </div>
        <div style={{ fontSize: '22px', fontWeight: 800, color: '#0f172a', marginTop: '4px' }}>Estimate #{est.estimate_number}</div>
        {est.title && <div style={{ fontSize: '14px', color: '#475569', marginTop: '2px' }}>{est.title}</div>}
        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>For {est.customer_name || 'customer'}</div>
      </div>

      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', marginBottom: '16px' }}>
        <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#64748b', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              <th style={{ paddingBottom: '8px' }}>Item</th>
              <th style={{ paddingBottom: '8px', textAlign: 'right' }}>Qty</th>
              <th style={{ paddingBottom: '8px', textAlign: 'right' }}>Rate</th>
              <th style={{ paddingBottom: '8px', textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l: any) => (
              <tr key={l.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                <td style={{ padding: '8px 0', color: '#0f172a' }}>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                    {l.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={l.image_url}
                        alt={l.item_number || 'Product'}
                        style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #e2e8f0', flexShrink: 0 }}
                      />
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{l.item_number || l.description || 'Item'}</div>
                      {l.description && l.description !== l.item_number && (
                        <div style={{ fontSize: '12px', color: '#475569' }}>{l.description}</div>
                      )}
                      {l.notes && <div style={{ fontSize: '11px', color: '#94a3b8', fontStyle: 'italic' }}>{l.notes}</div>}
                      {l.product_url && (
                        <a
                          href={l.product_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: '11px', color: '#2563eb', textDecoration: 'underline' }}
                        >View product ↗</a>
                      )}
                    </div>
                  </div>
                </td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>{l.quantity}</td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>${Number(l.unit_price).toFixed(2)}</td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>${Number(l.line_total || l.unit_price * l.quantity).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ borderTop: '2px solid #cbd5e1', marginTop: '10px', paddingTop: '10px', fontSize: '13px', color: '#0f172a' }}>
          <Row label="Subtotal" value={`$${subtotal.toFixed(2)}`} />
          {est.labor_total > 0 && <Row label={`Labor (${est.labor_hours_override ?? est.labor_hours} hrs @ $${est.labor_rate}/hr)`} value={`$${Number(est.labor_total).toFixed(2)}`} />}
          {!est.tax_exempt && est.tax_amount > 0 && <Row label={`Tax (${(est.tax_rate * 100).toFixed(2)}%)`} value={`$${Number(est.tax_amount).toFixed(2)}`} />}
          <Row label="Total" value={`$${Number(est.grand_total).toFixed(2)}`} bold />
        </div>
      </div>

      {est.install_instructions && (
        <Section title="Install Instructions">{est.install_instructions}</Section>
      )}
      {(est.on_site_contact_name || est.on_site_contact_phone) && (
        <Section title="On-site Contact">
          {est.on_site_contact_name}{est.on_site_contact_phone && ` · ${est.on_site_contact_phone}`}
        </Section>
      )}
      {est.delivery_preferences && <Section title="Delivery">{est.delivery_preferences}</Section>}
      {est.notes && <Section title="Notes">{est.notes}</Section>}

      {rejectMode ? (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', marginTop: '18px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a', marginBottom: '8px' }}>Request changes</div>
          <textarea
            rows={3}
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            placeholder="Tell us what needs to change…"
            style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px', fontFamily: 'inherit', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
            <button
              onClick={() => submit('reject')}
              disabled={submitting || !rejectReason.trim()}
              style={{ flex: 1, padding: '10px 14px', borderRadius: '10px', border: 'none', background: '#ef4444', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer', opacity: rejectReason.trim() && !submitting ? 1 : 0.5 }}
            >{submitting ? 'Submitting...' : 'Send to BMG'}</button>
            <button
              onClick={() => { setRejectMode(false); setRejectReason(''); }}
              style={{ padding: '10px 14px', borderRadius: '10px', border: '1px solid #cbd5e1', background: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
            >Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', marginTop: '18px' }}>
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
              disabled={!agreed || submitting}
              style={{ flex: 1, padding: '12px 14px', borderRadius: '10px', border: 'none', background: '#16a34a', color: '#fff', fontSize: '14px', fontWeight: 800, cursor: agreed && !submitting ? 'pointer' : 'not-allowed', opacity: agreed && !submitting ? 1 : 0.5 }}
            >{submitting ? 'Submitting...' : 'Accept & Authorize Work'}</button>
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

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontWeight: bold ? 800 : 400, fontSize: bold ? '15px' : '13px' }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: '14px', padding: '12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>{title}</div>
      <div style={{ fontSize: '13px', color: '#0f172a', whiteSpace: 'pre-wrap' }}>{children}</div>
    </div>
  );
}

function Accepted({ estimate, justAccepted }: { estimate?: any; justAccepted?: boolean }) {
  return (
    <div style={{ textAlign: 'center', padding: '20px 10px' }}>
      <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: '#dcfce7', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: '28px', color: '#16a34a' }}>✓</div>
      <div style={{ fontSize: '18px', fontWeight: 800, color: '#0f172a' }}>{justAccepted ? 'Thank you — work authorized' : 'Already approved'}</div>
      {estimate?.estimate_number && <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>Estimate #{estimate.estimate_number}</div>}
      {estimate?.customer_approved_at && (
        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '10px' }}>
          {new Date(estimate.customer_approved_at).toLocaleString()}
        </div>
      )}
      <Footer />
    </div>
  );
}

function Rejected({ estimate, justRejected }: { estimate?: any; justRejected?: boolean }) {
  return (
    <div style={{ textAlign: 'center', padding: '20px 10px' }}>
      <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: '24px', color: '#b91c1c' }}>!</div>
      <div style={{ fontSize: '18px', fontWeight: 800, color: '#0f172a' }}>
        {justRejected ? 'Thanks — we\u2019ll follow up' : 'Changes requested'}
      </div>
      {estimate?.estimate_number && <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>Estimate #{estimate.estimate_number}</div>}
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
