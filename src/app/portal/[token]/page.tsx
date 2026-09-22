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
import type { PortalAction } from '@/lib/portal-actions';

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

interface BillingData {
  balance: number;
  pastDue: number;
  invoiceCount: number;
  aging: Record<string, number>;
  invoices: { id: string; tranid: string; date: string | null; dueDate: string | null; po: string | null; total: number; unpaid: number; daysPastDue: number }[];
}
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const AGING_LABELS: [string, string][] = [
  ['current', 'Current'], ['d1_30', '1–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90plus', '90+ days'],
];

/** Billing section (R5-14): balance, aging, open invoices with PDF links,
 *  statement download/email, and a per-invoice question box that lands in
 *  the BMG inbox. Own fetch + states so a billing hiccup never takes down
 *  the PO board above it. */
function BillingSection({ token }: { token: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [askFor, setAskFor] = useState<string | null>(null); // invoice id
  const [askText, setAskText] = useState('');
  const [askDone, setAskDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/${encodeURIComponent(token)}/billing`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setState('error'); return; }
        setBilling(json);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const emailStatement = async () => {
    setBusy('email');
    setNotice(null);
    try {
      const res = await fetch(`/api/portal/${encodeURIComponent(token)}/statement`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      setNotice(res.ok
        ? `Statement sent to ${json.sentTo} with ${json.attached} PDF${json.attached !== 1 ? 's' : ''} attached.`
        : (json.error || 'Could not email the statement — try again shortly.'));
    } catch {
      setNotice('Could not email the statement — try again shortly.');
    }
    setBusy(null);
  };

  const sendQuestion = async (inv: BillingData['invoices'][number]) => {
    if (askText.trim().length < 3) return;
    setBusy(inv.id);
    try {
      const res = await fetch(`/api/portal/${encodeURIComponent(token)}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: inv.id, invoiceNumber: inv.tranid, message: askText.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) { setAskDone(inv.id); setAskFor(null); setAskText(''); }
      else setNotice(json.error || 'Could not send your question — try again shortly.');
    } catch {
      setNotice('Could not send your question — try again shortly.');
    }
    setBusy(null);
  };

  if (state === 'loading') {
    return <section style={{ marginBottom: '22px' }}><div style={{ ...card, ...muted, textAlign: 'center' }}>Loading billing…</div></section>;
  }
  if (state === 'error' || !billing) {
    return (
      <section style={{ marginBottom: '22px' }}>
        <div style={{ ...card, ...muted, textAlign: 'center' }}>Billing is temporarily unavailable — the purchase-order board below still works.</div>
      </section>
    );
  }

  const linkBtn: React.CSSProperties = {
    padding: '8px 14px', borderRadius: '9px', fontSize: '12px', fontWeight: 800,
    background: '#1a2b36', color: '#fff', border: 'none', cursor: 'pointer', textDecoration: 'none', display: 'inline-block',
  };

  return (
    <section style={{ marginBottom: '22px' }}>
      <div style={{ fontSize: '13px', fontWeight: 800, color: '#374151', marginBottom: '8px' }}>Billing</div>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <div style={muted}>Current balance</div>
            <div style={{ fontSize: '28px', fontWeight: 900 }}>{usd(billing.balance)}</div>
            {billing.pastDue > 0.005 && (
              <div style={{ fontSize: '13px', fontWeight: 800, color: '#b91c1c' }}>{usd(billing.pastDue)} past due</div>
            )}
          </div>
          {billing.invoiceCount > 0 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              <a href={`/api/portal/${encodeURIComponent(token)}/statement`} style={linkBtn}>Download statement (PDF)</a>
              <button type="button" onClick={emailStatement} disabled={busy === 'email'}
                style={{ ...linkBtn, background: '#fff', color: '#1a2b36', border: '1px solid #d1d5db', opacity: busy === 'email' ? 0.6 : 1 }}>
                {busy === 'email' ? 'Sending…' : 'Email me this statement'}
              </button>
            </div>
          )}
        </div>
        {notice && <div style={{ fontSize: '12px', color: '#374151', marginTop: '8px', fontWeight: 600 }}>{notice}</div>}

        {billing.invoiceCount === 0 ? (
          <div style={{ ...muted, marginTop: '10px' }}>No open invoices — you&apos;re all paid up.</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '12px 0' }}>
              {AGING_LABELS.filter(([key]) => (billing.aging[key] || 0) > 0.005).map(([key, label]) => (
                <span key={key} style={chip(key === 'current' ? '#16a34a' : key === 'd1_30' ? '#f59e0b' : '#dc2626')}>
                  {label}: {usd(billing.aging[key])}
                </span>
              ))}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ fontSize: '11px', textTransform: 'uppercase', color: '#6b7280', textAlign: 'left' }}>
                    <th style={{ padding: '7px 8px' }}>Invoice</th>
                    <th style={{ padding: '7px 8px' }}>Date</th>
                    <th style={{ padding: '7px 8px' }}>Due</th>
                    <th style={{ padding: '7px 8px', textAlign: 'right' }}>Amount</th>
                    <th style={{ padding: '7px 8px', textAlign: 'right' }}>Open</th>
                    <th style={{ padding: '7px 8px' }} />
                  </tr>
                </thead>
                <tbody>
                  {billing.invoices.map(inv => (
                    <BillingRowGroup key={inv.id} inv={inv} token={token}
                      asking={askFor === inv.id} askText={askText} setAskText={setAskText}
                      onToggleAsk={() => { setAskFor(prev => prev === inv.id ? null : inv.id); setAskText(''); }}
                      onSend={() => sendQuestion(inv)} sending={busy === inv.id} sent={askDone === inv.id} />
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ ...muted, marginTop: '8px' }}>
              Amounts are open balances as of {fmtDateTime(new Date().toISOString())}. Payments applied in the last day may not show yet.
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function BillingRowGroup({ inv, token, asking, askText, setAskText, onToggleAsk, onSend, sending, sent }: {
  inv: BillingData['invoices'][number]; token: string;
  asking: boolean; askText: string; setAskText: (v: string) => void;
  onToggleAsk: () => void; onSend: () => void; sending: boolean; sent: boolean;
}) {
  const td: React.CSSProperties = { padding: '7px 8px', borderTop: '1px solid #e5e7eb' };
  return (
    <>
      <tr>
        <td style={{ ...td, fontWeight: 800 }}>{inv.tranid}{inv.po ? <span style={{ ...muted, marginLeft: '6px' }}>PO {inv.po}</span> : null}</td>
        <td style={td}>{fmtDate(inv.date)}</td>
        <td style={{ ...td, color: inv.daysPastDue > 0 ? '#b91c1c' : undefined, fontWeight: inv.daysPastDue > 0 ? 800 : 400 }}>
          {fmtDate(inv.dueDate)}{inv.daysPastDue > 0 ? ` · ${inv.daysPastDue}d late` : ''}
        </td>
        <td style={{ ...td, textAlign: 'right' }}>{usd(inv.total)}</td>
        <td style={{ ...td, textAlign: 'right', fontWeight: 800 }}>{usd(inv.unpaid)}</td>
        <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
          <a href={`/api/portal/${encodeURIComponent(token)}/invoice-pdf?id=${encodeURIComponent(inv.id)}`}
            target="_blank" rel="noopener noreferrer"
            style={{ color: '#2563eb', fontWeight: 800, textDecoration: 'none', marginRight: '10px' }}>PDF</a>
          <button type="button" onClick={onToggleAsk}
            style={{ background: 'none', border: 'none', color: '#2563eb', fontWeight: 700, cursor: 'pointer', padding: 0, fontSize: '12px' }}>
            {sent ? 'Sent ✓' : asking ? 'Cancel' : 'Question?'}
          </button>
        </td>
      </tr>
      {asking && (
        <tr>
          <td colSpan={6} style={{ ...td, background: '#f9fafb' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
              <textarea value={askText} onChange={e => setAskText(e.target.value)} rows={2}
                placeholder={`Your question about invoice ${inv.tranid}…`}
                style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '13px', fontFamily: 'inherit', resize: 'vertical' }} />
              <button type="button" onClick={onSend} disabled={sending || askText.trim().length < 3}
                style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, background: '#1a2b36', color: '#fff', border: 'none', cursor: 'pointer', opacity: sending || askText.trim().length < 3 ? 0.5 : 1 }}>
                {sending ? 'Sending…' : 'Send to BMG'}
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Action Center (R6-11) — every approval still waiting on this customer,
 * pinned above everything else so three scattered asks read as one list.
 *
 * A live row gets the real Review & Approve button. A dead one gets no
 * button at all: the link genuinely does not work, and a button that
 * lands on "this link has expired" is a worse lie than no button. (The
 * fresh-link request fills that gap — R6-11 item 2.)
 */
function ActionCenter({ actions, token }: { actions: PortalAction[]; token: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});
  if (actions.length === 0) return null;

  const requestFresh = async (a: PortalAction) => {
    const key = `${a.kind}-${a.id}`;
    setBusy(key);
    try {
      const res = await fetch(`/api/portal/${encodeURIComponent(token)}/fresh-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: a.kind, id: a.id }),
      });
      const json = await res.json().catch(() => ({}));
      // The server's message is the only text shown — it is written to be
      // true for every outcome, including the ones that sent nothing.
      setNotice(n => ({ ...n, [key]: json.message || 'We could not issue a new link just now — please try again shortly.' }));
    } catch {
      setNotice(n => ({ ...n, [key]: 'We could not reach the server — please try again shortly.' }));
    } finally {
      setBusy(null);
    }
  };

  const waiting = actions.filter(a => a.state === 'awaiting').length;
  const expired = actions.length - waiting;
  return (
    <section style={{ ...card, borderColor: '#fbbf24', borderWidth: '2px', background: '#fffbeb', marginBottom: '14px', padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div style={{ fontSize: '14px', fontWeight: 900, color: '#92400e' }}>Action needed</div>
        <div style={{ ...muted, color: '#92400e' }}>
          {waiting > 0 && <>{waiting} waiting on your approval</>}
          {waiting > 0 && expired > 0 && <> · </>}
          {expired > 0 && <>{expired} with an expired link</>}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {actions.map(a => (
          <div key={`${a.kind}-${a.id}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', background: '#fff', border: '1px solid #fde68a', borderRadius: '10px', padding: '10px 12px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: 700 }}>
                {a.ref}
                {a.title ? <span style={{ fontWeight: 500, color: '#374151' }}> — {a.title}</span> : null}
              </div>
              <div style={{ ...muted, display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <span>{a.kindLabel}</span>
                {a.sentAt && <span>Sent {fmtDate(a.sentAt)}</span>}
                {a.remindedAt && <span>Reminded {fmtDate(a.remindedAt)}</span>}
                {a.total != null && <span>{usd(a.total)}</span>}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {a.state === 'awaiting' && a.approveUrl ? (
                <a href={a.approveUrl} target="_blank" rel="noopener noreferrer"
                  style={{ padding: '7px 14px', borderRadius: '8px', background: '#2563eb', color: '#fff', fontSize: '12px', fontWeight: 800, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                  {a.actionLabel}
                </a>
              ) : notice[`${a.kind}-${a.id}`] ? (
                <span style={{ ...muted, maxWidth: '320px', textAlign: 'right' }}>{notice[`${a.kind}-${a.id}`]}</span>
              ) : (
                <>
                  <span style={chip('#9ca3af')}>Link expired</span>
                  {/* No link is shown here, ever: the new one is emailed to
                      the address already on file, which is the channel the
                      approval token's security rests on. This page can be
                      forwarded — its own footer asks that it isn't. */}
                  <button type="button" disabled={busy === `${a.kind}-${a.id}`} onClick={() => requestFresh(a)}
                    style={{ padding: '7px 14px', borderRadius: '8px', background: '#fff', border: '1px solid #2563eb', color: '#2563eb', fontSize: '12px', fontWeight: 800, cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap', opacity: busy === `${a.kind}-${a.id}` ? 0.6 : 1 }}>
                    {busy === `${a.kind}-${a.id}` ? 'Sending…' : 'Email me a fresh link'}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface PrefRow { key: string; label: string; description: string; state: string; on: boolean }
interface PrefContact { id: string; name: string | null; maskedEmail: string; isPrimary: boolean; prefs: PrefRow[] }
interface PrefState { company: { name: string | null; settings: { key: string; label: string; description: string; on: boolean }[] }; contacts: PrefContact[] }

/**
 * Email preferences (R6-11) — what each person at this company has agreed
 * to receive, changeable here.
 *
 * Addresses arrive MASKED from the server and are never editable: this
 * page can be forwarded, so it has to be useful to someone who recognises
 * their own mailbox and useless as a contact directory to anyone else.
 *
 * Three states per row, not two. "Following your company setting" is real
 * and is what a contact who has never touched this page is in — showing it
 * as a plain off (or on) would claim a decision nobody made.
 */
function PreferencesSection({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PrefState | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || status !== 'idle') return;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch(`/api/portal/${encodeURIComponent(token)}/preferences`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { setStatus('error'); setError(json.error || ''); return; }
        setState(json); setStatus('ready');
      } catch (e: any) { setStatus('error'); setError(e?.message || ''); }
    })();
  }, [open, status, token]);

  const set = async (contactId: string, key: string, value: boolean | null) => {
    const mark = `${contactId}-${key}`;
    setBusy(mark); setError(null);
    try {
      const res = await fetch(`/api/portal/${encodeURIComponent(token)}/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, key, value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not save that — try again shortly.'); return; }
      // The server returns the whole recomputed state, so the page can
      // never drift from what was actually stored.
      setState(json);
    } catch (e: any) {
      setError(e?.message || 'Could not save that — try again shortly.');
    } finally { setBusy(null); }
  };

  const pill = (active: boolean): React.CSSProperties => ({
    padding: '5px 11px', borderRadius: '999px', fontSize: '11px', fontWeight: 800, cursor: 'pointer',
    border: `1px solid ${active ? '#2563eb' : '#d1d5db'}`,
    background: active ? '#2563eb' : '#fff',
    color: active ? '#fff' : '#6b7280',
  });

  return (
    <section style={{ marginBottom: '22px' }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '13px', fontWeight: 800, color: '#374151' }}>
        {open ? '▾' : '▸'} Email preferences
      </button>
      {open && (
        <div style={{ ...card, marginTop: '8px' }}>
          {status === 'loading' && <div style={muted}>Loading…</div>}
          {status === 'error' && <div style={muted}>We couldn&apos;t load your preferences{error ? ` (${error})` : ''} — try again in a moment.</div>}
          {status === 'ready' && state && (
            <>
              <div style={{ ...muted, marginBottom: '12px', lineHeight: 1.5 }}>
                These control the automatic emails we send. Turning something off here never affects
                an email a person at BMG sends you directly.
              </div>
              {state.contacts.length === 0 && (
                <div style={muted}>We don&apos;t have any email contacts on file for your company yet.</div>
              )}
              {state.contacts.map(c => (
                <div key={c.id} style={{ borderTop: '1px solid #f1f5f9', paddingTop: '10px', marginTop: '10px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700 }}>
                    {c.name || 'Contact'}{c.isPrimary ? <span style={{ ...muted, fontWeight: 600 }}> · main contact</span> : null}
                  </div>
                  <div style={{ ...muted, marginBottom: '8px' }}>{c.maskedEmail}</div>
                  {c.prefs.map(pref => (
                    <div key={pref.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', padding: '6px 0' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: '12px', fontWeight: 600 }}>{pref.label}</div>
                        <div style={muted}>
                          {pref.description}
                          {(pref.state === 'inherit_on' || pref.state === 'inherit_off') && (
                            <> · following your company setting ({pref.on ? 'on' : 'off'})</>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', opacity: busy === `${c.id}-${pref.key}` ? 0.5 : 1 }}>
                        <button type="button" disabled={!!busy} onClick={() => set(c.id, pref.key, true)} style={pill(pref.state === 'on')}>On</button>
                        <button type="button" disabled={!!busy} onClick={() => set(c.id, pref.key, false)} style={pill(pref.state === 'off')}>Off</button>
                        <button type="button" disabled={!!busy} onClick={() => set(c.id, pref.key, null)}
                          style={pill(pref.state === 'inherit_on' || pref.state === 'inherit_off')}>Company default</button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              {error && <div style={{ ...muted, color: '#b91c1c', marginTop: '10px' }}>{error}</div>}
            </>
          )}
        </div>
      )}
    </section>
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

        <ActionCenter actions={data.actions || []} token={token} />

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
          {tile('Open', data.summary.open, '#1a2b36')}
          {tile('In production', data.summary.inProduction, '#3b82f6')}
          {tile('Installing', data.summary.installing, '#f59e0b')}
          {tile('Fulfilled (90 days)', data.summary.fulfilled90d, '#16a34a')}
        </div>

        <BillingSection token={token} />

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

        {/* Estimates (R3-17 remainder): where each quote stands — sent /
            approved / expired — with a live Review & Approve link while one
            is waiting on the customer. */}
        {(data.estimates || []).length > 0 && (
          <section style={{ marginBottom: '22px' }}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: '#374151', marginBottom: '8px' }}>Your estimates ({data.estimates.length})</div>
            <div style={{ ...card, padding: '6px 0' }}>
              {data.estimates.map((e, idx) => (
                <div key={`${e.number || 'est'}-${idx}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', padding: '10px 14px', borderTop: idx > 0 ? '1px solid #f1f5f9' : 'none', fontSize: '13px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>
                      {e.number || 'Estimate'}{e.title ? <span style={{ fontWeight: 500, color: '#374151' }}> — {e.title}</span> : null}
                    </div>
                    <div style={{ ...muted, display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                      <span>Sent {fmtDate(e.sentAt)}</span>
                      {e.total != null && <span>{e.total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</span>}
                      {e.decidedAt && <span>{e.state === 'changes_requested' ? 'Responded' : 'Approved'} {fmtDate(e.decidedAt)}</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={chip(e.color)}>{e.stateLabel}</span>
                    {e.approveUrl && (
                      <a href={e.approveUrl} target="_blank" rel="noopener noreferrer"
                        style={{ padding: '6px 12px', borderRadius: '8px', background: '#2563eb', color: '#fff', fontSize: '12px', fontWeight: 800, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                        Review &amp; approve
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <PreferencesSection token={token} />

        <div style={{ ...muted, textAlign: 'center', marginTop: '30px' }}>
          Questions about an order? Reply to any of our emails or contact your BMG representative.<br />
          This page is private to your company — please don&apos;t forward the link outside your team.
        </div>
      </div>
    </div>
  );
}
