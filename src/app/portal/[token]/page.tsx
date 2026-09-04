'use client';

/**
 * Customer PO-status portal (migration 260) — the page behind the shared
 * link on a customer record. Read-only, no login: "which purchase orders
 * have you received from us, and where is each one?" A pared-down
 * graphics job board for the customer: one row per PO with a plain
 * stage, the lines and how many of each are installed (with the VINs),
 * the production jobs with tracking, invoice numbers, and a copy of the
 * PO document they sent.
 *
 * Fixed light styling, like the approval pages — this renders outside the
 * app's theme provider and on the customer's own devices.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import type { PortalData, PortalPo } from '@/lib/po-portal';

type PageStatus = 'loading' | 'ready' | 'invalid' | 'error';

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const page: React.CSSProperties = { minHeight: '100%', background: '#f3f4f6', color: '#1a2b36', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' };
const wrap: React.CSSProperties = { maxWidth: '960px', margin: '0 auto', padding: '20px 16px 48px' };
const card: React.CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: '14px', padding: '16px' };
const muted: React.CSSProperties = { fontSize: '12px', color: '#6b7280' };
const chip = (color: string): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '999px',
  fontSize: '12px', fontWeight: 800, background: `${color}1a`, border: `1px solid ${color}55`, color, whiteSpace: 'nowrap',
});

function Progress({ installed, ordered }: { installed: number; ordered: number }) {
  const pct = ordered > 0 ? Math.min(100, Math.round((installed / ordered) * 100)) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
      <div style={{ flex: 1, height: '8px', borderRadius: '999px', background: '#e5e7eb', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? '#16a34a' : '#3b82f6', transition: 'width .2s' }} />
      </div>
      <div style={{ fontSize: '12px', fontWeight: 700, color: '#374151', whiteSpace: 'nowrap' }}>{installed} / {ordered} installed</div>
    </div>
  );
}

function PoCard({ po, defaultOpen }: { po: PortalPo; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const done = po.stage.key === 'fulfilled' || po.stage.key === 'closed' || po.stage.key === 'cancelled';
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden', opacity: done && !open ? 0.85 : 1 }}>
      <button
        type="button"
        onClick={() => po.detail && setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: po.detail ? 'pointer' : 'default',
          padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px', alignItems: 'center', color: 'inherit',
        }}
        aria-expanded={open}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '16px', fontWeight: 800 }}>PO {po.poNumber}</div>
            <span style={chip(po.stage.color)}>
              {po.stage.label}{po.stage.detail ? <span style={{ fontWeight: 600, opacity: 0.85 }}>· {po.stage.detail}</span> : null}
            </span>
          </div>
          <div style={{ ...muted, marginTop: '4px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <span>Ordered {fmtDate(po.orderedDate || po.receivedAt)}</span>
            {po.requestedDeliveryDate && <span>Requested by {fmtDate(po.requestedDeliveryDate)}</span>}
            {po.shipTo && <span>Ship to {po.shipTo}</span>}
          </div>
          {po.detail && po.ordered > 0 && (
            <div style={{ marginTop: '8px', maxWidth: '420px' }}>
              <Progress installed={po.installed} ordered={po.ordered} />
            </div>
          )}
        </div>
        {po.detail && <div style={{ fontSize: '18px', color: '#9ca3af' }}>{open ? '▾' : '▸'}</div>}
      </button>

      {open && po.detail && (
        <div style={{ borderTop: '1px solid #e5e7eb', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Lines */}
          <div>
            <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: '#6b7280', marginBottom: '6px' }}>Items</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ color: '#6b7280', fontSize: '11px', textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px', fontWeight: 700 }}>Item</th>
                    <th style={{ padding: '6px 8px', fontWeight: 700 }}>Description</th>
                    <th style={{ padding: '6px 8px', fontWeight: 700, textAlign: 'right' }}>Ordered</th>
                    <th style={{ padding: '6px 8px', fontWeight: 700, textAlign: 'right' }}>Installed</th>
                  </tr>
                </thead>
                <tbody>
                  {po.lines.map(l => (
                    <LineRow key={l.id} line={l} />
                  ))}
                  {po.lines.length === 0 && (
                    <tr><td colSpan={4} style={{ padding: '8px', color: '#9ca3af' }}>Lines are still being entered.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Production jobs */}
          {po.jobs.length > 0 && (
            <div>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: '#6b7280', marginBottom: '6px' }}>Production</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {po.jobs.map(j => (
                  <div key={j.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', padding: '8px 10px', borderRadius: '10px', background: '#f9fafb', border: '1px solid #eef0f3' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 700 }}>{j.title}{j.jobNumber ? <span style={{ ...muted, marginLeft: '6px' }}>#{j.jobNumber}</span> : null}</div>
                      <div style={{ ...muted, display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        {j.dueDate && <span>Due {fmtDate(j.dueDate)}</span>}
                        {j.scheduledInstallDate && <span>Install {fmtDate(j.scheduledInstallDate)}</span>}
                        {j.trackingNumber && (
                          <span>
                            {j.carrier ? `${j.carrier} ` : ''}
                            {j.trackingUrl
                              ? <a href={j.trackingUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', fontWeight: 700 }}>{j.trackingNumber}</a>
                              : j.trackingNumber}
                          </span>
                        )}
                      </div>
                    </div>
                    <span style={chip(j.status === 'installed' || j.status === 'picked_up' ? '#16a34a' : j.status === 'shipped' ? '#2563eb' : '#3b82f6')}>{j.statusLabel}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Invoices + documents */}
          {(po.invoices.length > 0 || po.files.length > 0) && (
            <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', ...muted }}>
              {po.invoices.length > 0 && (
                <div>
                  <span style={{ fontWeight: 800, color: '#374151' }}>Invoiced: </span>
                  {po.invoices.map((i, idx) => (
                    <span key={idx}>{idx > 0 ? ', ' : ''}{i.number || 'pending'}{i.status === 'paid' ? ' (paid)' : ''}</span>
                  ))}
                </div>
              )}
              {po.files.length > 0 && (
                <div>
                  <span style={{ fontWeight: 800, color: '#374151' }}>Your PO: </span>
                  {po.files.map((f, idx) => (
                    <span key={idx}>{idx > 0 ? ', ' : ''}<a href={f.url} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', fontWeight: 700 }}>{f.name}</a></span>
                  ))}
                  <span style={{ marginLeft: '4px', color: '#9ca3af' }}>(links expire after an hour — reload for fresh ones)</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LineRow({ line }: { line: PortalPo['lines'][number] }) {
  const [showVehicles, setShowVehicles] = useState(false);
  const complete = line.quantity > 0 && line.installed >= line.quantity;
  return (
    <>
      <tr style={{ borderTop: '1px solid #f1f5f9' }}>
        <td style={{ padding: '8px', fontWeight: 700, whiteSpace: 'nowrap' }}>{line.partNumber}</td>
        <td style={{ padding: '8px', color: '#374151' }}>{line.description || '—'}</td>
        <td style={{ padding: '8px', textAlign: 'right' }}>{line.quantity}</td>
        <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 800, color: complete ? '#16a34a' : line.installed > 0 ? '#d97706' : '#6b7280' }}>{line.installed}</span>
          {line.vehicles.length > 0 && (
            <button type="button" onClick={() => setShowVehicles(v => !v)}
              style={{ marginLeft: '8px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: '6px', padding: '2px 8px', fontSize: '11px', fontWeight: 700, color: '#374151', cursor: 'pointer' }}>
              {showVehicles ? 'Hide' : 'Vehicles'}
            </button>
          )}
        </td>
      </tr>
      {showVehicles && (
        <tr>
          <td colSpan={4} style={{ padding: '0 8px 10px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '6px' }}>
              {line.vehicles.map((v, i) => (
                <div key={`${v.vin}-${i}`} style={{ padding: '6px 8px', borderRadius: '8px', background: '#f9fafb', border: '1px solid #eef0f3', fontSize: '12px' }}>
                  <div style={{ fontWeight: 700 }}>{v.label}</div>
                  <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#374151' }}>{v.vin}</div>
                  <div style={muted}>Installed {fmtDateTime(v.installedAt)}{v.location ? ` · ${v.location}` : ''}</div>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function PoPortalPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token || '';
  const [status, setStatus] = useState<PageStatus>('loading');
  const [data, setData] = useState<PortalData | null>(null);
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const [showOlder, setShowOlder] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/${encodeURIComponent(token)}`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setStatus(json.status === 'invalid' ? 'invalid' : 'error'); setMessage(json.error || ''); return; }
        setData(json); setStatus('ready');
      } catch (e: any) {
        if (!cancelled) { setStatus('error'); setMessage(e?.message || ''); }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!data) return [];
    if (!q) return data.pos;
    return data.pos.filter(p =>
      p.poNumber.toLowerCase().includes(q)
      || p.lines.some(l => l.partNumber.toLowerCase().includes(q) || (l.description || '').toLowerCase().includes(q) || l.vehicles.some(v => v.vin.toLowerCase().includes(q)))
      || p.jobs.some(j => (j.trackingNumber || '').toLowerCase().includes(q)),
    );
  }, [data, q]);
  const active = filtered.filter(p => p.status === 'open');
  const recentDone = filtered.filter(p => p.status !== 'open' && p.detail);
  const older = filtered.filter(p => !p.detail);

  if (status === 'loading') {
    return <div style={page}><div style={{ ...wrap, textAlign: 'center', paddingTop: '80px', color: '#6b7280' }}>Loading purchase orders…</div></div>;
  }
  if (status !== 'ready' || !data) {
    return (
      <div style={page}>
        <div style={{ ...wrap, maxWidth: '520px', paddingTop: '80px' }}>
          <div style={{ ...card, textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, marginBottom: '8px' }}>{status === 'invalid' ? 'This link is no longer active' : 'Something went wrong'}</div>
            <div style={muted}>{status === 'invalid' ? 'Ask your BMG contact for a fresh purchase-order status link.' : (message || 'Please try again in a moment.')}</div>
          </div>
        </div>
      </div>
    );
  }

  const tile = (label: string, value: number, color: string) => (
    <div style={{ ...card, padding: '12px 14px', flex: '1 1 140px' }}>
      <div style={{ fontSize: '24px', fontWeight: 900, color }}>{value}</div>
      <div style={muted}>{label}</div>
    </div>
  );

  return (
    <div style={page}>
      <div style={wrap}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
          <div>
            <div style={{ fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#6b7280' }}>Purchase order status</div>
            <h1 style={{ margin: '2px 0 0', fontSize: '24px', fontWeight: 900 }}>{data.company.name}</h1>
          </div>
          <div style={muted}>Updated {fmtDateTime(data.generatedAt)} · <button type="button" onClick={() => window.location.reload()} style={{ background: 'none', border: 'none', color: '#2563eb', fontWeight: 700, cursor: 'pointer', padding: 0, fontSize: '12px' }}>Refresh</button></div>
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
          {tile('Open', data.summary.open, '#1a2b36')}
          {tile('In production', data.summary.inProduction, '#3b82f6')}
          {tile('Installing', data.summary.installing, '#f59e0b')}
          {tile('Fulfilled (90 days)', data.summary.fulfilled90d, '#16a34a')}
        </div>

        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search PO number, item, VIN, or tracking number"
          style={{ width: '100%', padding: '11px 14px', borderRadius: '10px', border: '1px solid #d1d5db', fontSize: '14px', background: '#fff', marginBottom: '16px', boxSizing: 'border-box' }}
        />

        <section style={{ marginBottom: '22px' }}>
          <div style={{ fontSize: '13px', fontWeight: 800, color: '#374151', marginBottom: '8px' }}>Open purchase orders ({active.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {active.map(po => <PoCard key={po.id} po={po} defaultOpen={active.length <= 3} />)}
            {active.length === 0 && <div style={{ ...card, ...muted, textAlign: 'center' }}>{q ? 'No open purchase orders match your search.' : 'No open purchase orders right now.'}</div>}
          </div>
        </section>

        {recentDone.length > 0 && (
          <section style={{ marginBottom: '22px' }}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: '#374151', marginBottom: '8px' }}>Fulfilled in the last 90 days ({recentDone.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {recentDone.map(po => <PoCard key={po.id} po={po} defaultOpen={false} />)}
            </div>
          </section>
        )}

        {older.length > 0 && (
          <section style={{ marginBottom: '22px' }}>
            <button type="button" onClick={() => setShowOlder(s => !s)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '13px', fontWeight: 800, color: '#374151' }}>
              {showOlder ? '▾' : '▸'} Older purchase orders ({older.length})
            </button>
            {showOlder && (
              <div style={{ ...card, marginTop: '8px', padding: '6px 0' }}>
                {older.map(po => (
                  <div key={po.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '8px 14px', borderTop: '1px solid #f1f5f9', fontSize: '13px' }}>
                    <div><span style={{ fontWeight: 700 }}>PO {po.poNumber}</span> <span style={muted}>· {fmtDate(po.orderedDate || po.receivedAt)}</span></div>
                    <span style={chip(po.stage.color)}>{po.stage.label}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <div style={{ ...muted, textAlign: 'center', marginTop: '30px' }}>
          Questions about an order? Reply to any of our emails or contact your BMG representative.<br />
          This page is private to your company — please don&apos;t forward the link outside your team.
        </div>
      </div>
    </div>
  );
}
