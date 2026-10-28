'use client';

/**
 * Public approval page for a fleet order sent in one email (migration 412,
 * Craig 2026-10-19). Magic link, no login. Lists every vehicle of the
 * order with its own estimate; the customer opens any of them in full,
 * approves vehicles one at a time, or approves every open one at once,
 * ticking the E-SIGN box once. Each approval is POSTed to that vehicle's
 * own /api/approve/estimate/[token], so it is recorded, checked against
 * what was sent and snapshotted on its own estimate exactly like a single
 * approval, and each can become its own sales order. Changes are requested
 * per vehicle from its estimate page.
 *
 * The same page serves several of one customer's estimates picked together
 * on the Estimates list (`batch`, Craig 2026-10-28): different jobs, so it
 * says "estimates", lists what each is for, and leaves the items to each
 * estimate's own page.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { ApprovalFrame, ApprovalHeader } from '@/components/ApprovalPageShell';
import EstimateApprovalDocument from '@/components/EstimateApprovalDocument';
import { AGREEMENT_TEXT, COMBINED_AGREEMENT_TEXT } from '@/lib/approval-agreement';
import { LEGAL } from '@/lib/legal';

type VehicleState = 'open' | 'approved' | 'rejected' | 'expired';

interface Vehicle {
  token: string;
  estimateNumber: string;
  title?: string | null;
  vehicle?: string | null;
  unitNumber: string | null;
  stockNumber?: string | null;
  vin: string | null;
  grandTotal: number;
  state: VehicleState;
  decidedAt: string | null;
}

interface Payload {
  batch?: boolean;
  anyProofs?: boolean;
  customerName: string | null;
  title: string | null;
  vehicle: string | null;
  vehicles: Vehicle[];
  shown: { token: string; estimate: any; lines: any[]; graphics: any[]; proofs: any[]; downloads: any[] };
}

const money = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function FleetApprovalPage() {
  const params = useParams<{ token: string }>();
  const searchParams = useSearchParams();
  const token = params?.token || '';
  const via = searchParams?.get('via') === 'sms' ? 'sms' : 'email';
  const deliveryTarget = searchParams?.get('to') || null;
  // One email per person since 2026-10-21 (?own=1): the link's ?to is the
  // reader, and a forwarded reader can say who they are, as on a single
  // estimate's page (ApprovalPageShell).
  const ownLink = searchParams?.get('own') === '1' && !!deliveryTarget;
  const linkQuery = `?via=${via}${deliveryTarget ? `&to=${encodeURIComponent(deliveryTarget)}` : ''}${ownLink ? '&own=1' : ''}`;
  const [notMe, setNotMe] = useState(false);
  const [typedName, setTypedName] = useState('');

  const [status, setStatus] = useState<'loading' | 'ready' | 'invalid' | 'expired' | 'error'>('loading');
  const [data, setData] = useState<Payload | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pageLoadedAt = useRef<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/approve/fleet/${encodeURIComponent(token)}`);
        const json = await res.json();
        if (cancelled) return;
        if (json.status === 'single') {
          // This vehicle was sent again on its own since: its own page.
          window.location.replace(`/approve/estimate/${encodeURIComponent(token)}${linkQuery}`);
          return;
        }
        if (!res.ok) { setStatus(json.status === 'expired' ? 'expired' : json.status === 'error' ? 'error' : 'invalid'); return; }
        setData(json);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one fetch per token
  }, [token]);

  if (status === 'loading') return <ApprovalFrame><div style={{ color: '#475569', fontSize: '14px' }}>Loading your estimates...</div></ApprovalFrame>;
  if (status !== 'ready' || !data) {
    const title = status === 'expired' ? 'This link has expired' : status === 'error' ? 'Something went wrong' : 'This link is no longer active';
    return (
      <ApprovalFrame>
        <div style={{ textAlign: 'center', padding: '6px 0' }}>
          <div style={{ fontSize: '18px', fontWeight: 800, color: '#0f172a' }}>{title}</div>
          <div style={{ fontSize: '13px', color: '#475569', marginTop: '14px' }}>
            Need a new link? Email <a href={`mailto:${LEGAL.contactEmail}`} style={{ color: '#1d4ed8', fontWeight: 700 }}>{LEGAL.contactEmail}</a> or reply to the email we sent you.
          </div>
        </div>
      </ApprovalFrame>
    );
  }

  const { vehicles } = data;
  const open = vehicles.filter(v => v.state === 'open');
  const approvedCount = vehicles.filter(v => v.state === 'approved').length;
  const orderTotal = vehicles.reduce((sum, v) => sum + v.grandTotal, 0);
  const shownTotal = Number(data.shown.estimate?.grand_total) || 0;
  const allSame = vehicles.every(v => Math.abs(v.grandTotal - shownTotal) < 0.005);
  // The same sentence each vehicle's own page shows (and its accept route
  // stamps): the order shares one graphics job, so its proofs ride on all.
  const batch = !!data.batch;
  const agreement = (batch ? data.anyProofs : data.shown.proofs?.length) ? COMBINED_AGREEMENT_TEXT : AGREEMENT_TEXT;
  const nameOf = (v: Vehicle) => (batch ? `#${v.estimateNumber}` : `Unit ${v.unitNumber || '?'} (#${v.estimateNumber})`);

  const approve = async (list: Vehicle[]) => {
    if (busy) return;
    if (!agreed) { setError('Tick the box above first.'); return; }
    setError(null);
    setBusy(list.length === 1 ? list[0].token : 'all');
    const failures: string[] = [];
    for (const v of list) {
      try {
        const res = await fetch(`/api/approve/estimate/${encodeURIComponent(v.token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'accept',
            timeOnPageSeconds: Math.round((Date.now() - pageLoadedAt.current) / 1000),
            deliveryChannel: via === 'sms' ? 'sms_link' : 'email_link',
            deliveryTarget,
            ownLink,
            responder: ownLink && notMe && typedName.trim() ? typedName.trim() : undefined,
            agreementText: agreement,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok || json.error === 'Already approved') {
          setData(d => d && ({ ...d, vehicles: d.vehicles.map(x => (x.token === v.token ? { ...x, state: 'approved', decidedAt: new Date().toISOString() } : x)) }));
        } else {
          failures.push(`${nameOf(v)}: ${json.error || 'could not be approved'}`);
        }
      } catch {
        failures.push(`${nameOf(v)}: network error, try again`);
      }
    }
    if (failures.length) setError(failures.join('\n'));
    setBusy(null);
  };

  const td: React.CSSProperties = { padding: '10px 6px', borderTop: '1px solid #e2e8f0', fontSize: '13px', verticalAlign: 'middle' };

  return (
    <ApprovalFrame>
      <ApprovalHeader title={batch ? `${vehicles.length} estimates for your approval` : `Estimates for ${vehicles.length} vehicles`}>
        {data.customerName && <div style={{ fontSize: '13px', color: '#64748b', marginTop: '2px' }}>Prepared for {data.customerName}</div>}
        {!batch && (data.title || data.vehicle) && (
          <div style={{ fontSize: '12px', color: '#334155', marginTop: '6px', fontWeight: 600 }}>
            {[data.title, data.vehicle].filter(Boolean).join(' · ')}
          </div>
        )}
      </ApprovalHeader>

      {open.length === 0 && (
        <div style={{ padding: '12px 14px', background: approvedCount ? '#dcfce7' : '#f8fafc', border: `1px solid ${approvedCount ? '#86efac' : '#e2e8f0'}`, borderRadius: '12px', fontSize: '14px', fontWeight: 700, color: '#14532d', marginBottom: '14px' }}>
          {approvedCount === vehicles.length
            ? `Thank you. All ${vehicles.length} ${batch ? 'estimates' : 'vehicles'} are approved and work is authorized.`
            : `Thank you. Nothing is left to approve here.`}
        </div>
      )}

      <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '2px' }}>{batch ? 'Estimates' : 'Vehicles in this order'}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
        <tbody>
          {vehicles.map(v => (
            <tr key={v.token}>
              <td style={{ ...td, paddingLeft: 0 }}>
                <div style={{ fontWeight: 800, color: '#0f172a' }}>{batch ? `#${v.estimateNumber}` : `Unit ${v.unitNumber || '?'}`}</div>
                {batch && (v.title || v.vehicle || v.unitNumber || v.stockNumber) && (
                  <div style={{ fontSize: '12px', color: '#334155', overflowWrap: 'anywhere' }}>
                    {[v.title, v.vehicle, v.unitNumber ? `Unit ${v.unitNumber}` : null, v.stockNumber ? `Stock ${v.stockNumber}` : null].filter(Boolean).join(' · ')}
                  </div>
                )}
                {!batch && v.stockNumber && (
                  <div style={{ fontSize: '12px', color: '#334155', overflowWrap: 'anywhere' }}>Stock {v.stockNumber}</div>
                )}
                <div style={{ fontSize: '11px', color: '#64748b' }}>
                  {batch ? '' : `#${v.estimateNumber} · `}<a href={`/approve/estimate/${encodeURIComponent(v.token)}${linkQuery}`} style={{ color: '#1d4ed8', fontWeight: 600 }}>Open the estimate</a>
                </div>
                {v.vin && <div style={{ fontSize: '11px', color: '#64748b', fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>VIN {v.vin}</div>}
              </td>
              <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700 }}>{money(v.grandTotal)}</td>
              <td style={{ ...td, textAlign: 'right', paddingRight: 0, width: '1%', whiteSpace: 'nowrap' }}>
                {v.state === 'approved' ? (
                  <span style={{ fontSize: '12px', fontWeight: 800, color: '#16a34a' }}>✓ Approved</span>
                ) : v.state === 'rejected' ? (
                  <span style={{ fontSize: '12px', fontWeight: 700, color: '#b45309' }}>Changes requested</span>
                ) : v.state === 'expired' ? (
                  <span style={{ fontSize: '12px', fontWeight: 700, color: '#64748b' }}>Link expired</span>
                ) : (
                  <button
                    onClick={() => approve([v])}
                    disabled={!!busy}
                    style={{ padding: '7px 12px', borderRadius: '8px', border: '1px solid #16a34a', background: '#fff', color: '#16a34a', fontSize: '12px', fontWeight: 800, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy && busy !== v.token ? 0.5 : 1 }}
                  >{busy === v.token ? 'Approving…' : 'Approve'}</button>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <td style={{ ...td, paddingLeft: 0, fontWeight: 800, borderTop: '2px solid #cbd5e1' }}>{batch ? `Total (${vehicles.length} estimates)` : `Order total (${vehicles.length} vehicles)`}</td>
            <td style={{ ...td, textAlign: 'right', fontWeight: 800, borderTop: '2px solid #cbd5e1', whiteSpace: 'nowrap' }}>{money(orderTotal)}</td>
            <td style={{ ...td, borderTop: '2px solid #cbd5e1' }} />
          </tr>
        </tbody>
      </table>

      {open.length > 0 && ownLink && (
        <div style={{ marginTop: '16px', fontSize: '12px', color: '#475569' }}>
          {notMe ? (
            <label style={{ display: 'block' }}>
              <span style={{ fontWeight: 700, color: '#0f172a' }}>Your name</span>
              <input
                value={typedName}
                onChange={e => setTypedName(e.target.value)}
                placeholder="So BMG knows who is responding"
                maxLength={120}
                style={{ display: 'block', width: '100%', marginTop: '4px', padding: '8px 10px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px', fontFamily: 'inherit' }}
              />
            </label>
          ) : (
            <>
              Responding as <strong style={{ color: '#0f172a', overflowWrap: 'anywhere' }}>{deliveryTarget}</strong>
              {' · '}
              <button
                onClick={() => setNotMe(true)}
                style={{ padding: 0, border: 'none', background: 'none', color: '#1d4ed8', fontSize: '12px', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
              >Not you?</button>
            </>
          )}
        </div>
      )}

      {open.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', marginTop: '16px' }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={agreed} onChange={e => { setAgreed(e.target.checked); setError(null); }} style={{ marginTop: '2px', flexShrink: 0 }} />
            <span style={{ fontSize: '12px', color: '#0f172a', lineHeight: 1.5 }}>
              {agreement}
            </span>
          </label>
          <div style={{ fontSize: '11px', color: '#64748b', marginTop: '6px', paddingLeft: '23px' }}>
            {batch
              ? 'Tick once. It covers each estimate you approve here, and each approval is recorded on its own estimate.'
              : <>Tick once. It covers each vehicle you approve here, and each approval is recorded on that vehicle&apos;s own estimate.</>}
          </div>
          <button
            onClick={() => approve(open)}
            disabled={!agreed || !!busy}
            style={{ width: '100%', marginTop: '14px', padding: '12px 14px', borderRadius: '10px', border: 'none', background: '#16a34a', color: '#fff', fontSize: '14px', fontWeight: 800, cursor: agreed && !busy ? 'pointer' : 'not-allowed', opacity: agreed && !busy ? 1 : 0.5 }}
          >
            {busy === 'all' ? 'Approving…' : approvedCount > 0 ? `Approve the other ${open.length}` : `Approve all ${open.length}`}
          </button>
          <div style={{ fontSize: '12px', color: '#64748b', marginTop: '8px', textAlign: 'center' }}>
            {batch ? 'To ask for changes on one, open that estimate.' : 'To ask for changes on one vehicle, open its estimate.'}
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: '12px', padding: '10px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '10px', color: '#b91c1c', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}

      {!batch && <div style={{ marginTop: '22px', paddingTop: '14px', borderTop: '1px solid #e2e8f0' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
          {allSame
            ? 'What each vehicle gets'
            : `Unit ${data.shown.estimate?.unit_number || '?'}'s estimate (not every vehicle is priced the same; open each one to see it)`}
        </div>
        <EstimateApprovalDocument
          estimate={data.shown.estimate}
          lines={data.shown.lines}
          graphics={data.shown.graphics}
          proofs={data.shown.proofs}
          downloads={data.shown.downloads}
        />
      </div>}

      <div style={{ textAlign: 'center', marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e2e8f0', fontSize: '11px', color: '#94a3b8' }}>
        BMG Fleet Installations LLC · FleetSuite
      </div>
    </ApprovalFrame>
  );
}
