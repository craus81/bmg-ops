'use client';

/**
 * The shared machinery of every public magic-link approval page
 * (/approve/estimate, /approve/quote, /approve/proof): the token fetch,
 * the status state machine (loading / invalid / expired / already-decided
 * / just-submitted screens), and the E-SIGN action card — agreement
 * checkbox, Accept, Request Changes with a required reason — including
 * the audit fields the routes record (time on page, delivery channel and
 * target from the link's ?via/?to params).
 *
 * Each page supplies only its DOCUMENT body and copy, so the flows can't
 * drift apart in how approval itself works — the drift this replaces was
 * real (three hand-copied state machines, agreement text in four places).
 * The body the customer reviews stays per-flow: estimates and wrap quotes
 * render different pricing models (the same split as the adapters feeding
 * src/lib/quote-document.ts), proofs render files.
 *
 * Both /approve/estimate and /approve/quote URLs live forever: 30-day
 * tokens are in the wild pointing at each.
 */

import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { AGREEMENT_TEXT } from '@/lib/approval-agreement';

type ApprovalStatus =
  | 'loading' | 'ready' | 'already_approved' | 'already_rejected'
  | 'expired' | 'invalid' | 'submitted_accepted' | 'submitted_rejected' | 'error';

export interface ApprovalShellCopy {
  invalid?: string;
  expired?: string;
  /** Accept button — 'Accept & Authorize Work' unless overridden. */
  acceptLabel?: string;
  /** Reject-submit button — 'Send to BMG' unless overridden. */
  rejectSendLabel?: string;
  rejectPlaceholder?: string;
  /** Headline on the just-accepted screen. */
  acceptedTitle?: string;
  /** Headline on the just-rejected screen. */
  rejectedTitle?: string;
}

export interface ApprovalShellProps {
  /** API path segment: GET/POST /api/approve/<kind>/<token>. */
  kind: 'estimate' | 'quote' | 'proof';
  /** Lowercase noun for the loading line ('Loading estimate...'). */
  noun: string;
  /** The sentence beside the checkbox, sent with the accept POST. Defaults
   *  to the canonical AGREEMENT_TEXT; the proof flow passes its own. */
  agreementText?: string;
  copy?: ApprovalShellCopy;
  /** Pluck this flow's payload out of the GET response body. */
  parsePayload: (json: any) => any;
  /** 'Estimate #123' / 'Wrap Quote WQ-9' / 'Job #55' — shown on the
   *  already-decided and just-submitted screens. */
  docLabel: (data: any) => string | null;
  /** Approval timestamp for the accepted screen (field name varies). */
  acceptedAt: (data: any) => string | null;
  /** Gate the Accept button on the payload (proofs: must have files). */
  canAccept?: (data: any) => boolean;
  /** The document body the customer reviews. */
  renderDocument: (data: any) => React.ReactNode;
}

export default function ApprovalPageShell({
  kind,
  noun,
  agreementText = AGREEMENT_TEXT,
  copy,
  parsePayload,
  docLabel,
  acceptedAt,
  canAccept,
  renderDocument,
}: ApprovalShellProps) {
  const params = useParams<{ token: string }>();
  const searchParams = useSearchParams();
  const token = params?.token || '';
  const deliveryChannel = searchParams?.get('via') === 'sms' ? 'sms_link' : 'email_link';
  const deliveryTarget = searchParams?.get('to') || null;

  const [status, setStatus] = useState<ApprovalStatus>('loading');
  const [data, setData] = useState<any>(null);
  const [message, setMessage] = useState<string | undefined>(undefined);
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
        const res = await fetch(`/api/approve/${kind}/${encodeURIComponent(token)}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setStatus(json.status || 'invalid');
          setMessage(json.error);
          return;
        }
        setStatus(json.status);
        setData(parsePayload(json));
      } catch (e: any) {
        if (!cancelled) { setStatus('error'); setMessage(e?.message); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one fetch per token; parsePayload is a stable page-level function
  }, [kind, token]);

  const submit = async (action: 'accept' | 'reject') => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const timeOnPageSeconds = Math.round((Date.now() - pageLoadedAt.current) / 1000);
    try {
      const res = await fetch(`/api/approve/${kind}/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          timeOnPageSeconds,
          deliveryChannel,
          deliveryTarget,
          reason: action === 'reject' ? rejectReason.trim() : undefined,
          // The exact sentence the customer checked — frozen into the
          // signed snapshot server-side.
          agreementText: action === 'accept' ? agreementText : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Submit failed');
        setSubmitting(false);
        return;
      }
      setStatus(action === 'accept' ? 'submitted_accepted' : 'submitted_rejected');
    } catch (e: any) {
      setError(e?.message || 'Network error');
    }
    setSubmitting(false);
  };

  if (status === 'loading') return <Frame>Loading {noun}...</Frame>;
  if (status === 'invalid') return <Frame>{copy?.invalid || 'Invalid approval link. Please contact BMG Fleet Installations.'}</Frame>;
  if (status === 'expired') return <Frame>{copy?.expired || 'This approval link has expired. Please ask BMG Fleet Installations to re-send.'}</Frame>;
  if (status === 'error') return <Frame>Something went wrong{message ? `: ${message}` : ''}. Please try again.</Frame>;
  if (status === 'already_approved' || status === 'submitted_accepted') {
    return (
      <Frame>
        <Decided
          tone="accepted"
          title={status === 'submitted_accepted' ? (copy?.acceptedTitle || 'Thank you — work authorized') : 'Already approved'}
          docLabel={docLabel(data)}
          timestamp={acceptedAt(data)}
        />
      </Frame>
    );
  }
  if (status === 'already_rejected' || status === 'submitted_rejected') {
    return (
      <Frame>
        <Decided
          tone="rejected"
          title={status === 'submitted_rejected' ? (copy?.rejectedTitle || 'Thanks — we’ll follow up') : 'Changes requested'}
          docLabel={docLabel(data)}
          timestamp={null}
        />
      </Frame>
    );
  }

  const acceptable = canAccept ? canAccept(data) : true;

  return (
    <Frame>
      {renderDocument(data)}

      {rejectMode ? (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', marginTop: '18px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a', marginBottom: '8px' }}>Request changes</div>
          <textarea
            rows={3}
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            placeholder={copy?.rejectPlaceholder || 'Tell us what needs to change…'}
            style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px', fontFamily: 'inherit', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
            <button
              onClick={() => submit('reject')}
              disabled={submitting || !rejectReason.trim()}
              style={{ flex: 1, padding: '10px 14px', borderRadius: '10px', border: 'none', background: '#ef4444', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer', opacity: rejectReason.trim() && !submitting ? 1 : 0.5 }}
            >{submitting ? 'Submitting...' : (copy?.rejectSendLabel || 'Send to BMG')}</button>
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
            <span style={{ fontSize: '12px', color: '#0f172a', lineHeight: 1.5 }}>{agreementText}</span>
          </label>
          <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
            <button
              onClick={() => submit('accept')}
              disabled={!agreed || submitting || !acceptable}
              style={{ flex: 1, padding: '12px 14px', borderRadius: '10px', border: 'none', background: '#16a34a', color: '#fff', fontSize: '14px', fontWeight: 800, cursor: agreed && !submitting && acceptable ? 'pointer' : 'not-allowed', opacity: agreed && !submitting && acceptable ? 1 : 0.5 }}
            >{submitting ? 'Submitting...' : (copy?.acceptLabel || 'Accept & Authorize Work')}</button>
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

/** The already-decided / just-submitted screens. */
function Decided({ tone, title, docLabel, timestamp }: {
  tone: 'accepted' | 'rejected'; title: string; docLabel: string | null; timestamp: string | null;
}) {
  const accepted = tone === 'accepted';
  return (
    <div style={{ textAlign: 'center', padding: '20px 10px' }}>
      <div style={{
        width: '56px', height: '56px', borderRadius: '50%',
        background: accepted ? '#dcfce7' : '#fef2f2',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 12px', fontSize: accepted ? '28px' : '24px',
        color: accepted ? '#16a34a' : '#b91c1c',
      }}>{accepted ? '✓' : '!'}</div>
      <div style={{ fontSize: '18px', fontWeight: 800, color: '#0f172a' }}>{title}</div>
      {docLabel && <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>{docLabel}</div>}
      {timestamp && (
        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '10px' }}>
          {new Date(timestamp).toLocaleString()}
        </div>
      )}
      <Footer />
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: 'calc(100vh / var(--ts))', background: '#f1f5f9', padding: '20px 16px' }}>
      <div style={{ maxWidth: '640px', margin: '0 auto', background: '#fff', borderRadius: '14px', padding: '22px', border: '1px solid #e2e8f0' }}>
        {children}
      </div>
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

/** Company + doc-title header the estimate and quote bodies share. */
export function ApprovalHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '18px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>
        BMG Fleet Installations
      </div>
      <div style={{ fontSize: '22px', fontWeight: 800, color: '#0f172a', marginTop: '4px' }}>{title}</div>
      {children}
    </div>
  );
}

/** Right-aligned money row in a totals block. */
export function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontWeight: bold ? 800 : 400, fontSize: bold ? '15px' : '13px' }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** Titled gray info card (install instructions, notes, …). */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: '14px', padding: '12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>{title}</div>
      <div style={{ fontSize: '13px', color: '#0f172a', whiteSpace: 'pre-wrap' }}>{children}</div>
    </div>
  );
}
