'use client';

/**
 * Purchasing → Vendor POs: every vendor PO in the NetSuite mirror, newest
 * first, so the POs made from the queue have a home besides the job pages
 * (Craig, 2026-10-20). Lines show what each one holds; a line ordered with
 * Create PO gets Undo, which takes the part off the PO in NetSuite and puts
 * its requests back in the queue (/api/purchase-requests/undo-po).
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useDialog } from '@/components/DialogProvider';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import { trackingUrl } from '@/lib/tracking-url';

interface LineRequest {
  id: string;
  quantity: number;
  ordered_match: string | null;
  upfit_projects?: { id: string; project_name: string | null; netsuite_so_number: string | null } | null;
  estimates?: { id: string; estimate_number: string | null; customer_name: string | null } | null;
}

interface PoLine {
  id: string;
  item_number: string;
  description: string | null;
  quantity: number;
  quantity_received: number;
  rate: number | null;
  requests: LineRequest[];
}

interface VendorPo {
  id: string;
  tranid: string | null;
  vendor_name: string | null;
  trandate: string | null;
  status: string | null;
  status_label: string | null;
  total: number | null;
  eta_date: string | null;
  tracking_number: string | null;
  carrier: string | null;
  made_in_fleetsuite: boolean;
  url: string | null;
  lines: PoLine[];
}

type Dialog = ReturnType<typeof useDialog>;

/** The Undo question, shared with the On order list. */
export async function confirmPoUndo(dialog: Dialog, p: { quantity: number; itemNumber: string; poNumber: string | null; onlyLine?: boolean }): Promise<boolean> {
  const po = p.poNumber ? `PO ${p.poNumber}` : 'the PO';
  const text = [
    `Take ${p.quantity}× ${p.itemNumber} off ${po}?`,
    p.onlyLine === true
      ? `It's the only part on ${po}, so the PO gets closed in NetSuite. The record and number stay.`
      : p.onlyLine === false
        ? `It comes off ${po} in NetSuite. The other parts stay.`
        : `It comes off ${po} in NetSuite and the other parts stay. If it's the only part, the PO gets closed instead.`,
    'The request goes back in the queue with no vendor picked, so you can choose the right one.',
    'If the vendor already has the PO, let them know. FleetSuite doesn’t email them about this.',
  ].join('\n\n');
  return dialog.confirm(text, { title: 'Undo this part', confirmLabel: 'Undo', destructive: true });
}

export async function runPoUndo(ids: string[]): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/purchase-requests/undo-po', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) return { ok: false, error: body.error || `HTTP ${res.status}` };
    const po = body.poNumber ? `PO ${body.poNumber}` : 'the PO';
    const what = body.outcome === 'closed' ? `${po} is closed in NetSuite`
      : body.outcome === 'reduced' ? `the quantity on ${po} is lowered in NetSuite`
      : body.outcome === 'gone' ? `it was already off ${po} in NetSuite`
      : `it's off ${po} in NetSuite`;
    return { ok: true, message: `Done: ${what}, and the part is back in the request queue.` };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'unknown error' };
  }
}

const FILTERS = [
  ['open', 'Open'],
  ['received', 'Received'],
  ['closed', 'Closed'],
  ['all', 'All'],
] as const;

function statusColor(status: string | null): string {
  const s = String(status || '').toUpperCase();
  if (s === 'F' || s === 'G') return '#4ade80';
  if (s === 'C' || s === 'H') return theme.textMuted;
  return '#60a5fa';
}

function shortDate(d: string | null): string {
  if (!d) return '';
  return new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function VendorPosTab({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const router = useRouter();
  const dialog = useDialog();
  const { canSeeMoney } = useAuth();
  const [status, setStatus] = useState<(typeof FILTERS)[number][0]>('open');
  const [onlyFleetsuite, setOnlyFleetsuite] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<VendorPo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ status });
      if (onlyFleetsuite) params.set('fleetsuite', '1');
      if (query) params.set('q', query);
      const res = await fetch(`/api/purchase-requests/vendor-pos?${params}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`);
      setPos(body.pos || []);
    } catch (e: any) {
      setError(`Couldn’t load vendor POs: ${e?.message || 'unknown error'}`);
    } finally {
      setLoading(false);
    }
  }, [status, onlyFleetsuite, query]);

  useEffect(() => { load(); }, [load]);

  const undo = async (po: VendorPo, line: PoLine, created: LineRequest[]) => {
    const quantity = created.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    const ok = await confirmPoUndo(dialog, {
      quantity, itemNumber: line.item_number, poNumber: po.tranid,
      onlyLine: po.lines.length === 1,
    });
    if (!ok) return;
    setBusyLine(line.id);
    setNotice(null);
    const res = await runPoUndo(created.map(r => r.id));
    setBusyLine(null);
    if (!res.ok) { await dialog.alert(`Undo failed: ${res.error}`); return; }
    setNotice(res.message);
    onChanged();
    await load();
  };

  const chip = (on: boolean) => ({
    padding: '5px 11px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
    background: on ? 'rgba(96,165,250,0.14)' : 'transparent',
    border: `1px solid ${on ? 'rgba(96,165,250,0.4)' : theme.border}`,
    color: on ? '#60a5fa' : theme.textSecondary,
  });

  return (
    <div>
      <div style={{ fontSize: '12px', color: theme.textSecondary, marginBottom: '12px' }}>
        Every vendor PO, newest first: the ones made here and the ones keyed straight into NetSuite.
        {isAdmin && ' A part put on the wrong PO with Create PO has an Undo on its line.'}
      </div>

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '14px' }}>
        {FILTERS.map(([key, label]) => (
          <button key={key} onClick={() => setStatus(key)} style={chip(status === key)}>{label}</button>
        ))}
        <button onClick={() => setOnlyFleetsuite(v => !v)} style={chip(onlyFleetsuite)}>Made in FleetSuite</button>
        <input id="vendor-po-search" value={q} onChange={e => setQ(e.target.value)} placeholder="PO #, vendor or part"
          style={{ flex: '1 1 160px', minWidth: 0, padding: '6px 10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px' }} />
      </div>

      {notice && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 14px', marginBottom: '14px', background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.3)', borderRadius: '12px' }}>
          <div style={{ flex: 1, fontSize: '12px', color: 'var(--text-body)' }}>{notice}</div>
          <button onClick={() => setNotice(null)} title="Dismiss"
            style={{ background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer', fontSize: '13px', padding: 0 }}>✕</button>
        </div>
      )}
      {error && <div style={{ fontSize: '12px', color: '#f87171', marginBottom: '12px' }}>{error}</div>}
      {loading && pos.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}
      {!loading && !error && pos.length === 0 && (
        <div style={{ padding: '28px', textAlign: 'center', border: `1px dashed ${theme.border}`, borderRadius: '14px', color: theme.textMuted, fontSize: '13px' }}>
          No vendor POs match{query ? ` “${query}”` : ''} here.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', opacity: loading && pos.length > 0 ? 0.6 : 1 }}>
        {pos.map(po => {
          const numbers = (po.tracking_number || '').split(/[,;\s]+/).filter(Boolean);
          return (
            <div key={po.id} style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap', borderBottom: `1px solid ${theme.border}`, background: 'var(--subtle-bg)' }}>
                <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    PO {po.tranid || '—'}
                    {po.url && (
                      <a href={po.url} target="_blank" rel="noreferrer" style={{ marginLeft: '8px', fontSize: '11px', color: '#60a5fa', fontWeight: 700 }}>NetSuite ↗</a>
                    )}
                  </div>
                  <div style={{ fontSize: '11px', color: theme.textSecondary }}>
                    {[po.vendor_name, shortDate(po.trandate), canSeeMoney && po.total != null ? `$${Number(po.total).toFixed(2)}` : null, po.eta_date ? `ETA ${shortDate(po.eta_date)}` : null].filter(Boolean).join(' · ')}
                  </div>
                  {numbers.length > 0 && (
                    <div style={{ fontSize: '11px' }}>
                      {numbers.map(n => (
                        <a key={n} href={trackingUrl(n, po.carrier)} target="_blank" rel="noreferrer" style={{ color: '#60a5fa', fontWeight: 700, marginRight: '8px' }}>
                          {po.carrier ? `${po.carrier} ` : ''}{n} ↗
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {po.made_in_fleetsuite && (
                    <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 7px', borderRadius: '4px', background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.3)', color: '#a78bfa', whiteSpace: 'nowrap' }}>
                      MADE IN FLEETSUITE
                    </span>
                  )}
                  <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 7px', borderRadius: '4px', border: `1px solid ${theme.border}`, color: statusColor(po.status), whiteSpace: 'nowrap', textTransform: 'uppercase' }}>
                    {po.status_label || po.status || 'syncing'}
                  </span>
                </div>
              </div>
              {po.lines.length === 0 && (
                <div style={{ padding: '10px 14px', fontSize: '12px', color: theme.textMuted }}>No lines synced yet.</div>
              )}
              {po.lines.map(line => {
                const created = line.requests.filter(r => !r.ordered_match);
                const received = Number(line.quantity_received) > 0;
                const forJobs = line.requests.map(r => r.upfit_projects || r.estimates).filter(Boolean);
                return (
                  <div key={line.id} style={{ padding: '9px 14px', borderTop: `1px solid ${theme.border}`, display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{line.item_number}</div>
                      {line.description && <div style={{ fontSize: '11px', color: theme.textSecondary }}>{line.description}</div>}
                      {line.requests.map(r => r.upfit_projects ? (
                        <button key={r.id} onClick={() => router.push(deepLinks.upfitProject(r.upfit_projects!.id))}
                          style={{ display: 'block', background: 'none', border: 'none', padding: 0, color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>
                          {r.upfit_projects.project_name || 'Upfit project'}{r.upfit_projects.netsuite_so_number ? ` · SO ${r.upfit_projects.netsuite_so_number}` : ''}
                        </button>
                      ) : r.estimates ? (
                        <button key={r.id} onClick={() => router.push(deepLinks.estimate(r.estimates!.id))}
                          style={{ display: 'block', background: 'none', border: 'none', padding: 0, color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>
                          Estimate {r.estimates.estimate_number || ''}{r.estimates.customer_name ? ` · ${r.estimates.customer_name}` : ''}
                        </button>
                      ) : null)}
                      {line.requests.length > 0 && forJobs.length === 0 && <div style={{ fontSize: '11px', color: theme.textMuted }}>stock</div>}
                    </div>
                    <div style={{ fontSize: '11px', color: theme.textSecondary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {Number(line.quantity)} ordered · {Number(line.quantity_received) || 0} received
                      {canSeeMoney && line.rate != null ? ` · $${Number(line.rate).toFixed(2)}` : ''}
                    </div>
                    {isAdmin && created.length > 0 && (
                      received ? (
                        <span style={{ fontSize: '10px', color: theme.textMuted }}>Received, so no Undo. Use a vendor return in NetSuite.</span>
                      ) : (
                        <button onClick={() => undo(po, line, created)} disabled={busyLine !== null}
                          title="Wrong part or wrong vendor: take it off this PO and put it back in the queue"
                          style={{ padding: '4px 10px', borderRadius: '6px', background: 'transparent', border: '1px solid rgba(248,113,113,0.5)', color: '#f87171', fontSize: '11px', fontWeight: 700, cursor: busyLine ? 'wait' : 'pointer' }}>
                          {busyLine === line.id ? 'Undoing…' : 'Undo'}
                        </button>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {pos.length === 100 && (
        <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '10px' }}>Showing the newest 100. Search to find an older one.</div>
      )}
    </div>
  );
}
