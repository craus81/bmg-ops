'use client';

/**
 * Drop ship from vendor on an estimate's sales order (Craig, 2026-10-23,
 * thread "Drop-ship orders for in-stock parts"). Lists the order's part
 * lines live from NetSuite (in-stock ones too), takes the vendor, cost per
 * part, ship-to address (the order's own to start) and PO number ending,
 * and makes the linked NetSuite drop ship PO via
 * /api/estimates/[id]/drop-ship. Then offers the PO PDF and the vendor email
 * screen; nothing is sent until someone presses Send.
 */

import { useEffect, useMemo, useState } from 'react';
import { closeOnEscape } from '@/lib/modal-escape';
import { growTextarea, useDialog } from '@/components/DialogProvider';
import { deepLinks } from '@/lib/deep-links';
import { cleanPoSuffix, customerAbbrev } from '@/lib/po-number';
import { EMPTY_SHIP_TO, shipToLines, type DropShipLine, type ShipTo } from '@/lib/drop-ship';
import NetsuiteVendorSearch from '@/components/NetsuiteVendorSearch';
import EmailComposeModal, { type EmailComposeFields } from '@/components/EmailComposeModal';

interface Props {
  estimateId: string;
  soLabel: string;
  onClose: () => void;
}

type Line = DropShipLine & { lastVendor: { id: string; name: string } | null; cost: number | null; onHand: number | null };

interface Earlier {
  id: string;
  purchase_order_id: string | null;
  purchase_order_number: string | null;
  vendor_name: string | null;
  ship_to: ShipTo | null;
  lines: { itemNumber: string; quantity: number }[];
  emailed_at: string | null;
  emailed_to: string[] | null;
}

interface Made {
  id: string | null;
  purchaseOrderId: string;
  purchaseOrderNumber: string | null;
  netsuiteUrl: string;
  lines: { itemNumber: string; quantity: number }[];
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function DropShipModal({ estimateId, soLabel, onClose }: Props) {
  const dialog = useDialog();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [so, setSo] = useState<{ soNumber: string; customerName: string; pendingApproval: boolean; lines: Line[]; dropShips: Earlier[] } | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [cost, setCost] = useState<Record<number, string>>({});
  const [vendor, setVendor] = useState<{ id: string; name: string } | null>(null);
  const [pickingVendor, setPickingVendor] = useState(false);
  const [shipTo, setShipTo] = useState<ShipTo>(EMPTY_SHIP_TO);
  const [editingShipTo, setEditingShipTo] = useState(false);
  const [suffix, setSuffix] = useState('');
  const [memo, setMemo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ made: Made[]; warnings: string[]; vendorEmail: string | null } | null>(null);
  const [emailing, setEmailing] = useState<{ id: string; poLabel: string; to: string } | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/estimates/${estimateId}/drop-ship`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not read the sales order');
      setSo(data);
      setShipTo({ ...EMPTY_SHIP_TO, ...(data.shipTo || {}) });
      const c: Record<number, string> = {};
      for (const l of data.lines as Line[]) c[l.line] = l.cost != null ? String(l.cost) : '';
      setCost(c);
      setSuffix(customerAbbrev(data.customerName));
      // Start with the only open part line ticked: the usual case is one part.
      const open = (data.lines as Line[]).filter(l => !l.blocked);
      setPicked(open.length === 1 ? { [open[0].line]: true } : {});
      const v = open.find(l => l.lastVendor)?.lastVendor;
      if (v) setVendor(v);
    } catch (e: any) {
      setError(e?.message || 'Could not read the sales order');
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per open
  useEffect(() => { load(); }, []);

  const lines = useMemo(() => so?.lines ?? [], [so]);
  const picks = lines.filter(l => picked[l.line] && !l.blocked);
  const total = picks.reduce((s, l) => s + (Number(cost[l.line]) || 0) * l.quantity, 0);
  const shipToOk = !!(shipTo.name && shipTo.address && shipTo.city && shipTo.state && shipTo.zip);
  const invalid = picks.length === 0 || !vendor || !shipToOk || !!so?.pendingApproval;

  const toggle = (l: Line) => {
    setPicked(p => {
      const next = { ...p, [l.line]: !p[l.line] };
      // The first part picked brings its last vendor along.
      if (!vendor && next[l.line] && l.lastVendor) setVendor(l.lastVendor);
      return next;
    });
  };

  const submit = async () => {
    if (!vendor) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/estimates/${estimateId}/drop-ship`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          picks: picks.map(l => ({ line: l.line, rate: Number(cost[l.line]) > 0 ? Number(cost[l.line]) : null })),
          vendorNetsuiteId: vendor.id,
          vendorName: vendor.name,
          shipTo,
          memo: memo.trim() || null,
          poSuffix: cleanPoSuffix(suffix) || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not make the drop ship PO');
      setDone({ made: data.dropShips || [], warnings: data.warnings || [], vendorEmail: data.vendorEmail || null });
    } catch (e: any) {
      setError(e?.message || 'Could not make the drop ship PO');
    } finally {
      setSubmitting(false);
    }
  };

  const emailBody = (fields: EmailComposeFields, preview: boolean) => JSON.stringify({
    dropShipId: emailing?.id,
    emails: fields.emails,
    bccSelf: fields.bccSelf,
    cc: fields.cc,
    message: fields.message,
    preview,
  });

  const pdfLink = (poId: string, poNumber: string | null) => {
    const name = deepLinks.poPdfFileName(poNumber, poId);
    return deepLinks.pdfViewer(deepLinks.netsuitePdf('purchaseOrder', poId, name), { name });
  };

  const title = `Drop ship from vendor · ${so?.soNumber ? `SO ${so.soNumber}` : soLabel}`;
  const cell: React.CSSProperties = { padding: '8px', borderTop: '1px solid var(--border)', fontSize: '13px', verticalAlign: 'top' };
  const num: React.CSSProperties = { ...cell, textAlign: 'right', whiteSpace: 'nowrap' };
  const head: React.CSSProperties = { padding: '8px', fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap' };
  const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 700, color: 'var(--text-label)' };
  const input: React.CSSProperties = { padding: '8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg, var(--card))', color: 'var(--text)', fontSize: '13px' };
  const btn = (bg: string, fg: string, border = 'none'): React.CSSProperties => ({
    padding: '10px 16px', borderRadius: '10px', border, background: bg, color: fg, fontWeight: 800, fontSize: '13px', cursor: 'pointer', textDecoration: 'none', display: 'inline-block',
  });
  const errorBox: React.CSSProperties = { padding: '10px 12px', borderRadius: '10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444', fontSize: '13px', fontWeight: 700, whiteSpace: 'pre-wrap' };
  const warnBox: React.CSSProperties = { padding: '10px 12px', borderRadius: '10px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)', color: '#f59e0b', fontSize: '13px', fontWeight: 700 };

  const shipField = (key: keyof ShipTo, text: string, opts?: { wide?: boolean; placeholder?: string }) => (
    <label style={{ ...label, gridColumn: opts?.wide ? '1 / -1' : undefined }}>
      {text}
      <input id={`drop-ship-${key}`} value={shipTo[key]} placeholder={opts?.placeholder} maxLength={150}
        onChange={e => setShipTo(s => ({ ...s, [key]: e.target.value }))} style={input} />
    </label>
  );

  const earlierRows = (so?.dropShips || []).filter(d => d.purchase_order_id);

  return (
    <>
      <div ref={closeOnEscape(emailing ? undefined : onClose)} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        zIndex: 1050, padding: '20px', overflowY: 'auto',
      }}>
        <div role="dialog" aria-label={title} onClick={e => e.stopPropagation()} style={{
          background: 'var(--card)', borderRadius: '14px', maxWidth: '820px', width: '100%',
          border: '1px solid var(--border)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)', margin: 'auto 0',
          padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '18px', fontWeight: 800 }}>{title}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                The vendor ships straight to the customer. Our stock is not touched.
              </div>
            </div>
            <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: '8px', width: '32px', height: '32px', cursor: 'pointer' }}>✕</button>
          </div>

          {loading && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Reading the sales order from NetSuite…</div>}
          {error && <div style={errorBox}>{error}</div>}
          {sentNote && <div style={{ fontSize: '13px', fontWeight: 700, color: '#22c55e' }}>{sentNote}</div>}

          {!loading && so && !done && (
            <>
              {earlierRows.length > 0 && (
                <div style={{ fontSize: '12px', color: 'var(--text-label)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {earlierRows.map(d => (
                    <div key={d.id} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <span>
                        Drop ship <strong>PO {d.purchase_order_number || d.purchase_order_id}</strong>
                        {d.vendor_name ? ` · ${d.vendor_name}` : ''} · {(d.lines || []).map(l => `${l.quantity}× ${l.itemNumber}`).join(', ')}
                        {d.emailed_at ? ` · emailed ${new Date(d.emailed_at).toLocaleDateString('en-US')}` : ' · not emailed yet'}
                      </span>
                      <a href={pdfLink(d.purchase_order_id!, d.purchase_order_number)} style={{ color: '#60a5fa', fontWeight: 700 }}>PO PDF</a>
                      <button onClick={() => setEmailing({ id: d.id, poLabel: d.purchase_order_number || d.purchase_order_id!, to: '' })}
                        style={{ background: 'none', border: 'none', padding: 0, color: '#22c55e', fontWeight: 700, cursor: 'pointer', fontSize: '12px' }}>
                        Email vendor…
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {so.pendingApproval && (
                <div style={errorBox}>This sales order is Pending Approval in NetSuite. NetSuite only makes drop ship POs for approved orders: approve it there first.</div>
              )}

              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '10px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '560px' }}>
                  <thead>
                    <tr>
                      <th style={head} aria-label="Pick" />
                      <th style={{ ...head, textAlign: 'left' }}>Part</th>
                      <th style={head}>Qty</th>
                      <th style={head}>On hand</th>
                      <th style={head}>Cost each</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map(l => (
                      <tr key={l.line} style={{ opacity: l.blocked ? 0.55 : 1 }}>
                        <td style={cell}>
                          <input type="checkbox" id={`drop-ship-pick-${l.line}`} aria-label={`Drop ship ${l.itemNumber || `line ${l.line}`}`}
                            checked={!!picked[l.line] && !l.blocked} disabled={!!l.blocked} onChange={() => toggle(l)} />
                        </td>
                        <td style={cell}>
                          <label htmlFor={`drop-ship-pick-${l.line}`} style={{ fontWeight: 700, cursor: l.blocked ? 'default' : 'pointer' }}>{l.itemNumber || `Line ${l.line}`}</label>
                          {l.description && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{l.description}</div>}
                          {l.blocked && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{l.blocked}</div>}
                        </td>
                        <td style={num}>{l.quantity}</td>
                        <td style={num}>{l.onHand ?? '-'}</td>
                        <td style={num}>
                          {!l.blocked ? (
                            <input aria-label={`Cost each, ${l.itemNumber || `line ${l.line}`}`} type="number" min={0} step="any" inputMode="decimal"
                              value={cost[l.line] ?? ''} placeholder="NetSuite's"
                              onChange={e => setCost(c => ({ ...c, [l.line]: e.target.value }))}
                              style={{ width: '90px', textAlign: 'right', padding: '6px', borderRadius: '6px', background: 'var(--input-bg, var(--card))', color: 'var(--text)', border: '1px solid var(--border)' }} />
                          ) : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                The whole line quantity goes on the PO. Cost starts at the last price we paid; blank uses NetSuite&apos;s.
              </div>

              <div style={label}>
                Vendor
                {vendor && !pickingVendor ? (
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text)' }}>{vendor.name || `Vendor #${vendor.id}`}</span>
                    <button onClick={() => setPickingVendor(true)} style={{ ...btn('transparent', 'var(--text-label)', '1px solid var(--border)'), padding: '5px 10px', fontSize: '12px' }}>Change vendor</button>
                  </div>
                ) : (
                  <NetsuiteVendorSearch autoFocus={pickingVendor} onSelect={v => { setVendor({ id: v.id, name: v.companyName || v.entityId }); setPickingVendor(false); }} />
                )}
              </div>

              <div style={label}>
                Ship to
                {!editingShipTo ? (
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ ...input, minWidth: '220px', fontWeight: 500, lineHeight: 1.5, color: shipToOk ? 'var(--text)' : '#ef4444' }}>
                      {shipToLines(shipTo).length > 0 ? shipToLines(shipTo).map((t, i) => <div key={i}>{t}</div>) : 'No ship-to address on the sales order'}
                    </div>
                    <button onClick={() => setEditingShipTo(true)} style={{ ...btn('transparent', 'var(--text-label)', '1px solid var(--border)'), padding: '5px 10px', fontSize: '12px' }}>Change address</button>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
                    {shipField('name', 'Company or name', { wide: true })}
                    {shipField('attention', 'Attention (optional)')}
                    {shipField('phone', 'Phone (optional)')}
                    {shipField('address', 'Street', { wide: true })}
                    {shipField('address2', 'Suite, unit (optional)', { wide: true })}
                    {shipField('city', 'City')}
                    {shipField('state', 'State', { placeholder: 'MO' })}
                    {shipField('zip', 'ZIP')}
                  </div>
                )}
                {!shipToOk && <span style={{ color: '#ef4444', fontWeight: 700 }}>The ship-to needs a name, street, city, state and ZIP.</span>}
                <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>Starts as the sales order&apos;s ship-to. A change goes on the PO only.</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
                <label style={label}>
                  PO number ending
                  <input id="drop-ship-suffix" value={suffix} maxLength={20} placeholder="HOSEMATE" onChange={e => setSuffix(e.target.value.toUpperCase())} style={input} />
                  <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{cleanPoSuffix(suffix) ? `PO###-${cleanPoSuffix(suffix)}` : 'NetSuite’s number'}</span>
                </label>
                <label style={label}>
                  Memo on the PO (optional)
                  <textarea id="drop-ship-memo" value={memo} rows={2} maxLength={500}
                    placeholder={`Drop ship to ${so.customerName || 'customer'} for SO ${so.soNumber}`}
                    onChange={e => { setMemo(e.target.value); growTextarea(e.currentTarget); }}
                    style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} />
                </label>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
                <div style={{ fontSize: '14px' }}>
                  {picks.length} part{picks.length !== 1 ? 's' : ''}{total > 0 ? <> · PO total <strong>{money(total)}</strong></> : ''}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={onClose} style={btn('transparent', 'var(--text-label)', '1px solid var(--border)')}>Cancel</button>
                  <button onClick={submit} disabled={invalid || submitting}
                    style={{ ...btn('#60a5fa', '#0b1b33'), opacity: invalid || submitting ? 0.5 : 1, cursor: invalid || submitting ? 'not-allowed' : 'pointer' }}>
                    {submitting ? 'Making the PO in NetSuite…' : 'Create drop ship PO in NetSuite'}
                  </button>
                </div>
              </div>
            </>
          )}

          {done && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {done.made.map(m => (
                <div key={m.purchaseOrderId} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ fontSize: '17px', fontWeight: 800, color: '#22c55e' }}>
                    Drop ship PO {m.purchaseOrderNumber || m.purchaseOrderId} created in NetSuite
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-label)' }}>
                    {m.lines.map(l => `${l.quantity}× ${l.itemNumber}`).join(', ')} · ships to {shipTo.name}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <a href={m.netsuiteUrl} target="_blank" rel="noreferrer" style={btn('transparent', 'var(--text-label)', '1px solid var(--border)')}>Open PO in NetSuite</a>
                    <a href={pdfLink(m.purchaseOrderId, m.purchaseOrderNumber)} style={btn('rgba(96,165,250,0.12)', '#60a5fa', '1px solid rgba(96,165,250,0.5)')}>PO PDF (Print / Save)</a>
                    {m.id && (
                      <button onClick={() => setEmailing({ id: m.id!, poLabel: m.purchaseOrderNumber || m.purchaseOrderId, to: done.vendorEmail || '' })} style={btn('#22c55e', '#052e16')}>
                        Email vendor…
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {done.warnings.map((w, i) => <div key={i} style={warnBox}>{w}</div>)}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Email vendor opens the email screen with the PO PDF attached; nothing is sent until someone presses Send.
                When the vendor ships, mark the PO shipped in NetSuite; then Fulfill &amp; Invoice can bill that line.
              </div>
              <div>
                <button onClick={onClose} style={btn('transparent', 'var(--text-label)', '1px solid var(--border)')}>Done</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {emailing && (
        <EmailComposeModal
          title={`Email vendor · drop ship PO ${emailing.poLabel}`}
          stateKey={`drop-ship-email:${emailing.id}`}
          initialTo={emailing.to}
          intro={<div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>The PO PDF from NetSuite is attached, and the email shows the customer&apos;s ship-to address.</div>}
          messagePlaceholder="Optional note to the vendor"
          sendLabel="Send to vendor"
          fetchPreview={async fields => {
            const res = await fetch(`/api/estimates/${estimateId}/drop-ship/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: emailBody(fields, true) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) return { error: json.error || 'Could not build the preview' };
            return { preview: { to: json.to, subject: json.subject, html: json.html } };
          }}
          onSend={async fields => {
            const res = await fetch(`/api/estimates/${estimateId}/drop-ship/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: emailBody(fields, false) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) { await dialog.alert(json.error || 'Could not send the email', { error: true }); return { ok: false }; }
            setSentNote(`PO ${emailing.poLabel} emailed to ${(json.to || []).join(', ')}.`);
            return { ok: true };
          }}
          onClose={() => setEmailing(null)}
        />
      )}
    </>
  );
}
