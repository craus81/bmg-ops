'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

/**
 * Vendor scorecards (R5-11): per-vendor reality from what the system
 * already watches — actual lead times (po_receipts), promises kept
 * (po_eta_events), slips, short lines, spend, and price drift. Each vendor
 * drills into recent POs and the receipt history receiving never had.
 * History accrues from each capture's ship date — labeled, not hidden.
 */

interface VendorRow {
  vendor: string; poCount: number; spend: number;
  medianLeadDays: number | null; leadSamples: number;
  avgPromiseMissDays: number | null; promiseSamples: number;
  slipCount: number; etaEvents: number; avgSlipDays: number | null;
  shortShipLines: number; receivedLines: number;
}
interface Scorecards {
  days: number; since: string; vendors: VendorRow[];
  receiptsSince: string | null; etaSince: string | null;
}
interface Detail {
  vendor: string; days: number;
  pos: { id: string; tranid: string | null; trandate: string | null; status: string | null; total: number; eta: string | null; firstReceipt: string | null }[];
  receipts: { poTranid: string; item: string; description: string | null; quantity: number; receivedAt: string; note: string | null }[];
  priceDrift: { item: string; buys: number; firstRate: number; lastRate: number; driftPct: number }[];
}

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function VendorScorecardsPage() {
  const router = useRouter();
  const { user, isAdmin, isSales, hasFeature, loading: authLoading } = useAuth();
  const [days, setDays] = useState(180);
  const [data, setData] = useState<Scorecards | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/vendors?days=${d}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setData(body);
    } catch (e: any) {
      setError(e?.message || 'Report failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) return;
    if (!isAdmin && !isSales && !hasFeature('reports') && !hasFeature('parts_ordering')) { router.push('/home'); return; }
    load(days);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load after auth
  }, [authLoading, user]);

  const openDetail = async (vendor: string) => {
    if (detailFor === vendor) { setDetailFor(null); setDetail(null); return; }
    setDetailFor(vendor);
    setDetail(null);
    try {
      const res = await fetch(`/api/reports/vendors?vendor=${encodeURIComponent(vendor)}&days=${days}`);
      const body = await res.json();
      if (res.ok) setDetail(body);
    } catch { /* the panel shows loading state until closed */ }
  };

  const cell: React.CSSProperties = { padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: '12.5px' };
  const th: React.CSSProperties = { padding: '10px 12px', fontWeight: 700, whiteSpace: 'nowrap', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'left' };

  const missColor = (v: number | null) => v == null ? 'var(--text-muted)' : v > 2 ? '#ef4444' : v < -0.5 ? '#22c55e' : 'var(--text-primary)';

  return (
    <div style={{ maxWidth: '1100px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Vendor Scorecards</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Per-vendor reality: actual lead times, promises kept vs slipped, short lines, spend, and price drift.
        Click a vendor for its recent POs and receipt history.
      </div>

      <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
        {[90, 180, 365].map(d => (
          <button key={d} onClick={() => { setDays(d); setDetailFor(null); setDetail(null); load(d); }} style={{
            padding: '7px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            background: days === d ? 'rgba(96,165,250,0.15)' : 'var(--card)',
            border: `1px solid ${days === d ? '#3b82f6' : 'var(--border)'}`,
            color: days === d ? '#60a5fa' : 'var(--text-secondary)',
          }}>{d} days</button>
        ))}
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: '13px', marginBottom: '12px' }}>{error}</div>}
      {loading && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>}

      {data && !loading && (
        <>
          <div style={{ fontSize: '11px', color: '#f59e0b', marginBottom: '10px' }}>
            {data.receiptsSince ? `Receipts recorded since ${data.receiptsSince}` : 'No receipts recorded yet'}
            {' · '}
            {data.etaSince ? `ETA promises tracked since ${data.etaSince}` : 'no ETA promises tracked yet'}
            {' — early lead-time and promise numbers are thin until history accrues; blanks mean no data, not a perfect vendor.'}
          </div>

          <div style={{ overflowX: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Vendor</th>
                  <th style={{ ...th, textAlign: 'right' }}>POs</th>
                  <th style={{ ...th, textAlign: 'right' }}>Spend</th>
                  <th style={{ ...th, textAlign: 'right' }}>Median lead</th>
                  <th style={{ ...th, textAlign: 'right' }}>Vs promise</th>
                  <th style={{ ...th, textAlign: 'right' }}>ETA slips</th>
                  <th style={{ ...th, textAlign: 'right' }}>Short lines</th>
                </tr>
              </thead>
              <tbody>
                {data.vendors.map(v => (
                  <tr key={v.vendor} onClick={() => openDetail(v.vendor)} style={{ cursor: 'pointer', background: detailFor === v.vendor ? 'rgba(96,165,250,0.06)' : undefined }} title="Show recent POs and receipt history">
                    <td style={{ ...cell, fontWeight: 700, color: '#60a5fa' }}>{v.vendor}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{v.poCount}</td>
                    <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtMoney(v.spend)}</td>
                    <td style={{ ...cell, textAlign: 'right' }} title={`${v.leadSamples} received PO${v.leadSamples !== 1 ? 's' : ''} sampled`}>
                      {v.medianLeadDays != null ? `${v.medianLeadDays}d` : '—'}
                    </td>
                    <td style={{ ...cell, textAlign: 'right', fontWeight: 700, color: missColor(v.avgPromiseMissDays) }}
                        title={v.promiseSamples > 0 ? `${v.promiseSamples} PO${v.promiseSamples !== 1 ? 's' : ''} with a first promise and a final receipt` : 'No PO has both a tracked promise and a final receipt yet'}>
                      {v.avgPromiseMissDays == null ? '—'
                        : v.avgPromiseMissDays > 0.5 ? `${v.avgPromiseMissDays}d late`
                        : v.avgPromiseMissDays < -0.5 ? `${Math.abs(v.avgPromiseMissDays)}d early` : 'on time'}
                    </td>
                    <td style={{ ...cell, textAlign: 'right', color: v.slipCount > 0 ? '#f59e0b' : 'var(--text-muted)' }}
                        title={v.avgSlipDays != null ? `avg slip ${v.avgSlipDays} days` : undefined}>
                      {v.slipCount || '—'}
                    </td>
                    <td style={{ ...cell, textAlign: 'right', color: v.shortShipLines > 0 ? '#ef4444' : 'var(--text-muted)' }}
                        title={v.receivedLines > 0 ? `${v.shortShipLines} of ${v.receivedLines} received lines came in short` : undefined}>
                      {v.shortShipLines || '—'}
                    </td>
                  </tr>
                ))}
                {data.vendors.length === 0 && (
                  <tr><td colSpan={7} style={{ ...cell, color: 'var(--text-muted)', textAlign: 'center' }}>No vendor POs in this window.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {detailFor && (
            <div style={{ marginTop: '14px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <div style={{ fontSize: '14px', fontWeight: 800 }}>{detailFor}</div>
                <button onClick={() => { setDetailFor(null); setDetail(null); }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '13px' }}>Close</button>
              </div>
              {!detail && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>}
              {detail && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '14px' }}>
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '6px' }}>Recent POs</div>
                    <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
                      {detail.pos.map(p => (
                        <div key={p.id} style={{ padding: '6px 8px', borderRadius: '8px', background: 'var(--subtle-bg)', marginBottom: '4px', fontSize: '12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                            <b>{p.tranid || '—'}</b>
                            <span style={{ color: 'var(--text-secondary)' }}>{fmtMoney(p.total)}</span>
                          </div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                            {p.trandate || '—'} · {p.status || '—'}
                            {p.eta ? ` · ETA ${p.eta}` : ''}
                            {p.firstReceipt ? ` · first receipt ${p.firstReceipt}` : ' · nothing received'}
                          </div>
                        </div>
                      ))}
                      {detail.pos.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No POs in this window.</div>}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '6px' }}>Receipt history</div>
                    <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
                      {detail.receipts.map((r, i) => (
                        <div key={i} style={{ padding: '6px 8px', borderRadius: '8px', background: 'var(--subtle-bg)', marginBottom: '4px', fontSize: '12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                            <b>{r.quantity}× {r.item}</b>
                            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{String(r.receivedAt).slice(0, 10)}</span>
                          </div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>PO {r.poTranid}{r.note ? ` · ${r.note}` : ''}</div>
                        </div>
                      ))}
                      {detail.receipts.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No receipts recorded for this vendor yet.</div>}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '6px' }}>Price drift (repeat buys)</div>
                    {detail.priceDrift.map(d => (
                      <div key={d.item} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '5px 8px', borderRadius: '8px', background: 'var(--subtle-bg)', marginBottom: '4px', fontSize: '12px' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.item} <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>×{d.buys}</span></span>
                        <span style={{ whiteSpace: 'nowrap' }}>
                          ${d.firstRate} → ${d.lastRate}
                          <b style={{ marginLeft: '5px', color: d.driftPct > 0 ? '#ef4444' : '#22c55e' }}>{d.driftPct > 0 ? '+' : ''}{d.driftPct}%</b>
                        </span>
                      </div>
                    ))}
                    {detail.priceDrift.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No repeat-buy price changes in this window.</div>}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
