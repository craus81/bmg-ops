'use client';

/**
 * Sales order page (Craig, 2026-10-21: "I should be able to open and edit
 * sales orders natively in FleetSuite"). Read live from NetSuite, which stays
 * the system of record; an admin can edit the order here and the edit is
 * written straight to NetSuite (src/app/api/sales-orders/[id]/route.ts).
 *
 * Rules shown on screen are the ones the server checks
 * (src/lib/sales-order-edit.ts): billed lines are locked, quantities never go
 * below what shipped or billed, a partly shipped line closes instead of
 * being removed, a partly billed line keeps its price.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';
import { openJobOrder } from '@/lib/job-order-pdf';
import TopSaveBar, { LEAVE_WITHOUT_SAVING } from '@/components/TopSaveBar';
import FulfillInvoiceModal from '@/components/FulfillInvoiceModal';
import EmailInvoicesModal from '@/components/EmailInvoicesModal';
import EmailComposeModal, { type EmailComposeFields } from '@/components/EmailComposeModal';
import SentBox from '@/components/SentBox';
import { docRef } from '@/lib/document-sends';
import { isBadDelivery } from '@/lib/invoice-emails';
import { lineAllows, isFullyBilled, type SoLine, type SoHeader, type SoLineEdit, type SoNewLine } from '@/lib/sales-order-edit';

interface SoPage {
  header: SoHeader;
  lines: SoLine[];
  canEdit: boolean;
  seeMoney: boolean;
  estimate: { id: string; number: string } | null;
  job: { id: string; title: string | null } | null;
  invoices: {
    id: string; tranid: string; trandate: string | null; total: number | null;
    /** Latest customer email of this invoice; null = never emailed from FleetSuite. */
    emailed: { at: string; by: string | null; to: string[]; status: string | null } | null;
  }[] | null;
  history: { at: string; by: string | null; changes: string[] }[];
}

interface ItemHit { itemId: string; itemNumber: string; description: string; price: number | null }

type LineDraft = { quantity: string; rate: string; close: boolean; reopen: boolean; remove: boolean };
type NewDraft = SoNewLine & { key: number; quantityText: string; rateText: string };

const money = (n: number | null | undefined) =>
  n == null ? '' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const qtyText = (n: number) => String(Math.round(n * 100) / 100);
const fmtDate = (d: string | null) => {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-');
  return y && m && day ? `${Number(m)}/${Number(day)}/${y}` : d;
};
const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const card: React.CSSProperties = {
  background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px',
};
const label: React.CSSProperties = {
  display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
  color: theme.textMuted, marginBottom: '3px',
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: '7px',
  border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '14px',
};
const btn: React.CSSProperties = {
  padding: '8px 14px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.card,
  color: theme.textPrimary, fontSize: '13px', fontWeight: 700, cursor: 'pointer',
};
const primary: React.CSSProperties = { ...btn, background: theme.accent, borderColor: theme.accent, color: '#fff' };
const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: '2px 4px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};
const th: React.CSSProperties = {
  padding: '8px', textAlign: 'left', fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em',
  textTransform: 'uppercase', color: theme.textMuted, borderBottom: `1px solid ${theme.border}`, whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '8px', borderBottom: `1px solid ${theme.border}`, verticalAlign: 'top', fontSize: '13px' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

function statusTone(status: string): { bg: string; fg: string } {
  const s = status.toLowerCase();
  if (/billed|closed|cancel/.test(s) && !/pending billing/.test(s)) return { bg: theme.subtleBg, fg: theme.textSecondary };
  if (/partial|pending/.test(s)) return { bg: theme.warningBg, fg: theme.warning };
  return { bg: theme.successBg, fg: theme.success };
}

export default function SalesOrderPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id || '');
  const router = useRouter();
  const dialog = useDialog();
  const { canSeeMoney } = useAuth();

  const [data, setData] = useState<SoPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<'pdf' | 'job' | null>(null);
  const [fulfilling, setFulfilling] = useState(false);
  const [emailing, setEmailing] = useState<{ id: string; tranid: string } | null>(null);
  const [emailingSo, setEmailingSo] = useState(false);
  const [sentBump, setSentBump] = useState(0);

  const [hdr, setHdr] = useState({ poNumber: '', memo: '', vin: '', shipDate: '' });
  const [drafts, setDrafts] = useState<Record<number, LineDraft>>({});
  const [added, setAdded] = useState<NewDraft[]>([]);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<ItemHit[]>([]);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await apiFetch(`/api/sales-orders/${encodeURIComponent(id)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setLoadError(body.error || `Couldn't open the sales order (${res.status}).`); return; }
      setData(body as SoPage);
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't open the sales order.");
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const startEdit = () => {
    if (!data) return;
    const h = data.header;
    setHdr({ poNumber: h.poNumber, memo: h.memo, vin: h.vin, shipDate: h.shipDate || '' });
    setDrafts(Object.fromEntries(data.lines.map(l => [l.line, {
      quantity: qtyText(l.quantity), rate: l.rate == null ? '' : String(l.rate), close: false, reopen: false, remove: false,
    }])));
    setAdded([]);
    setSaveErrors([]);
    setSaved(null);
    setEditing(true);
  };

  const setDraft = (line: number, patch: Partial<LineDraft>) =>
    setDrafts(d => ({ ...d, [line]: { ...d[line], ...patch } }));

  // Build the edit the server plans; untouched fields are sent as they are
  // and dropped there, so only real changes reach NetSuite.
  const edit = useMemo(() => {
    if (!data || !editing) return null;
    const lines: SoLineEdit[] = [];
    const errors: string[] = [];
    for (const l of data.lines) {
      const d = drafts[l.line];
      if (!d) continue;
      const can = lineAllows(l);
      const e: SoLineEdit = { line: l.line };
      if (d.remove) e.remove = true;
      else {
        if (d.reopen) e.reopen = true;
        if (d.close) e.close = true;
        if (can.quantity || d.reopen) {
          const q = parseFloat(d.quantity);
          if (!Number.isFinite(q)) errors.push(`${l.itemNumber}: enter a quantity.`);
          else if (Math.round(q * 100) !== Math.round(l.quantity * 100)) e.quantity = q;
        }
        if ((can.price || d.reopen) && data.seeMoney && canSeeMoney && d.rate.trim() !== '') {
          const r = parseFloat(d.rate);
          if (!Number.isFinite(r)) errors.push(`${l.itemNumber}: enter a price.`);
          else if (l.rate == null || Math.round(r * 100) !== Math.round(l.rate * 100)) e.rate = r;
        }
      }
      if (Object.keys(e).length > 1) lines.push(e);
    }
    const add: SoNewLine[] = [];
    for (const n of added) {
      const q = parseFloat(n.quantityText);
      const r = parseFloat(n.rateText);
      if (!Number.isFinite(q) || q <= 0) { errors.push(`${n.itemNumber}: enter a quantity.`); continue; }
      if (!Number.isFinite(r) || r < 0) { errors.push(`${n.itemNumber}: enter a price.`); continue; }
      add.push({ itemId: n.itemId, itemNumber: n.itemNumber, description: n.description, quantity: q, rate: r });
    }
    const h = data.header;
    const header: Record<string, string | null> = {};
    if (hdr.poNumber.trim() !== h.poNumber.trim()) header.poNumber = hdr.poNumber;
    if (hdr.memo.trim() !== h.memo.trim()) header.memo = hdr.memo;
    if (hdr.vin.trim().toUpperCase() !== h.vin.trim().toUpperCase()) header.vin = hdr.vin;
    if ((hdr.shipDate || null) !== h.shipDate) header.shipDate = hdr.shipDate || null;
    const count = lines.length + add.length + Object.keys(header).length;
    return { lines, add, header, errors, count };
  }, [data, editing, drafts, added, hdr, canSeeMoney]);

  // Quantity floors, shown in red as the person types.
  const lineProblem = (l: SoLine): string | null => {
    const d = drafts[l.line];
    if (!editing || !d || d.remove) return null;
    const can = lineAllows(l);
    if (!can.quantity && !d.reopen) return null;
    const q = parseFloat(d.quantity);
    const floor = Math.max(l.quantityShipped, l.quantityBilled);
    if (Number.isFinite(q) && q < floor) return `${qtyText(floor)} already ${l.quantityBilled >= floor ? 'billed' : 'shipped'}`;
    if (Number.isFinite(q) && q <= 0) return 'Use Remove or Close';
    return null;
  };
  const hasRed = !!data && data.lines.some(l => lineProblem(l));

  const save = async () => {
    if (!data || !edit || saving) return;
    if (edit.errors.length > 0) { setSaveErrors(edit.errors); return; }
    setSaving(true);
    setSaveErrors([]);
    try {
      const res = await apiFetch(`/api/sales-orders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lastModified: data.header.lastModified,
          ...(Object.keys(edit.header).length ? { header: edit.header } : {}),
          ...(edit.lines.length ? { lines: edit.lines } : {}),
          ...(edit.add.length ? { add: edit.add } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveErrors(Array.isArray(body.errors) && body.errors.length ? body.errors : [body.error || `Save failed (${res.status}).`]);
        return;
      }
      setSaved(body.changes || []);
      setEditing(false);
      await load();
    } catch (e: any) {
      setSaveErrors([e?.message || 'Save failed.']);
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    if (edit && edit.count > 0) {
      const ok = await dialog.confirm('The sales order stays exactly as it was last saved. Nothing is canceled, closed, or deleted.', { title: 'Leave without saving your edits?', confirmLabel: LEAVE_WITHOUT_SAVING, cancelLabel: 'Keep editing', destructive: true });
      if (!ok) return;
    }
    setEditing(false);
    setSaveErrors([]);
  };

  // Item search for "+ Add line".
  useEffect(() => {
    if (!adding || search.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      const res = await apiFetch(`/api/sales-orders/items?q=${encodeURIComponent(search.trim())}`);
      const body = await res.json().catch(() => ({}));
      setHits(res.ok ? body.items || [] : []);
    }, 250);
    return () => clearTimeout(t);
  }, [search, adding]);

  const addItem = (it: ItemHit) => {
    setAdded(a => [...a, {
      key: Date.now() + Math.random(), itemId: it.itemId, itemNumber: it.itemNumber, description: it.description,
      quantity: 1, rate: it.price ?? 0, quantityText: '1', rateText: it.price != null ? String(it.price) : '',
    }]);
    setSearch('');
    setHits([]);
    setAdding(false);
  };

  const soEmailBody = (fields: EmailComposeFields, preview: boolean) => JSON.stringify({
    emails: fields.emails, bccSelf: fields.bccSelf, cc: fields.cc, message: fields.message, preview,
  });

  const openPdf = async () => {
    setBusy('pdf');
    const r = await openNetSuitePdf('salesOrder', id);
    if (!r.ok) await dialog.alert(`Could not open the sales order PDF: ${r.error}`);
    setBusy(null);
  };
  const openJobOrderPdf = async () => {
    setBusy('job');
    const r = await openJobOrder(id);
    if (!r.ok) await dialog.alert(`Could not open the Job Order: ${r.error}`);
    setBusy(null);
  };

  if (loadError) {
    return (
      <div style={{ padding: '24px 16px', maxWidth: '1100px', margin: '0 auto' }}>
        <button onClick={() => router.back()} style={{ ...linkBtn, color: theme.textSecondary }}>← Back</button>
        <div style={{ ...card, marginTop: '12px', background: theme.errorBg, borderColor: theme.errorBorder, color: theme.error }}>{loadError}</div>
      </div>
    );
  }
  if (!data) {
    return <div style={{ padding: '24px 16px', color: theme.textMuted }}>Opening sales order from NetSuite…</div>;
  }

  // Prices only with See prices: the server already leaves them out, and the
  // screen follows the same gate.
  const showMoney = data.seeMoney && canSeeMoney;
  const h = data.header;
  const tone = statusTone(h.status);
  const live = editing
    ? data.lines.filter(l => !drafts[l.line]?.remove)
    : data.lines;
  const subtotal = editing
    ? live.reduce((s, l) => {
      const d = drafts[l.line];
      const q = parseFloat(d?.quantity ?? '') || l.quantity;
      const r = parseFloat(d?.rate ?? '') || (l.rate ?? 0);
      return s + (l.editable ? q * r : l.amount);
    }, 0) + added.reduce((s, n) => s + (parseFloat(n.quantityText) || 0) * (parseFloat(n.rateText) || 0), 0)
    : h.subtotal;

  return (
    <div style={{ padding: '16px', maxWidth: '1100px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '14px', paddingBottom: '32px' }}>
      {editing && edit && (
        <TopSaveBar
          title={`Sales Order ${h.tranId}`}
          subtitle={`${hasRed ? 'Fix the red quantity first' : edit.count === 0 ? 'No changes yet' : `${edit.count} change${edit.count === 1 ? '' : 's'}`} · saves to NetSuite right away`}
          error={saveErrors.length > 0 ? saveErrors.join('\n') : undefined}
          onSave={save}
          saving={saving}
          disabled={hasRed || edit.count === 0}
          saveLabel="Save to NetSuite"
          onCancel={saving ? undefined : cancel}
        />
      )}
      <div style={{ fontSize: '13px', color: theme.textSecondary, display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => router.back()} style={{ ...linkBtn, color: theme.textSecondary, paddingLeft: 0 }}>← Back</button>
        {h.customerId && (
          <>
            <span>·</span>
            <a href={deepLinks.customerByNetsuiteId(h.customerId)} style={{ color: theme.textSecondary }}>{h.customerName}</a>
          </>
        )}
      </div>

      {/* ── Header ── */}
      <div style={card}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>
              Sales Order {h.tranId}
              {h.status && (
                <span style={{ marginLeft: '10px', fontSize: '12px', fontWeight: 700, padding: '3px 10px', borderRadius: '999px', background: tone.bg, color: tone.fg, verticalAlign: 'middle' }}>
                  {h.status}
                </span>
              )}
            </h1>
            <div style={{ fontSize: '13px', color: theme.textSecondary, marginTop: '4px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              {data.estimate && <a href={deepLinks.estimate(data.estimate.id)} style={{ color: 'var(--accent)' }}>Estimate {data.estimate.number}</a>}
              {data.job && <a href={deepLinks.upfitProject(data.job.id)} style={{ color: 'var(--accent)' }}>Job{data.job.title ? `: ${data.job.title}` : ''}</a>}
              {!data.estimate && <span>Entered in NetSuite</span>}
            </div>
          </div>
          {!editing && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button onClick={openPdf} disabled={busy !== null} style={btn}>{busy === 'pdf' ? 'Opening…' : 'Sales Order PDF'}</button>
              {data.canEdit && <button onClick={() => setEmailingSo(true)} style={btn}>✉ Email</button>}
              <button onClick={openJobOrderPdf} disabled={busy !== null} style={btn}>{busy === 'job' ? 'Opening…' : 'Job Order'}</button>
              {data.canEdit && !/^(billed|closed|cancell?ed)$/i.test(h.status.trim()) && (
                <button onClick={() => setFulfilling(true)} title="Ship this sales order's parts from O'Fallon and invoice them in NetSuite (part of the order is fine)"
                  style={{ ...btn, background: 'rgba(245,158,11,0.15)', borderColor: 'rgba(245,158,11,0.6)', color: '#f59e0b' }}>
                  Fulfill &amp; Invoice
                </button>
              )}
              {data.canEdit && <button onClick={startEdit} style={primary}>Edit order</button>}
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px 20px', marginTop: '16px' }}>
          <div><span style={label}>Customer</span><div style={{ fontWeight: 600 }}>{h.customerName || '—'}</div></div>
          <div><span style={label}>Order date</span><div style={{ fontWeight: 600 }}>{fmtDate(h.tranDate) || '—'}</div></div>
          <div>
            <label style={label} htmlFor="so-po">Customer PO #</label>
            {editing
              ? <input id="so-po" style={input} value={hdr.poNumber} maxLength={45} onChange={e => setHdr({ ...hdr, poNumber: e.target.value })} />
              : <div style={{ fontWeight: 600 }}>{h.poNumber || '—'}</div>}
          </div>
          <div>
            <label style={label} htmlFor="so-vin">VIN</label>
            {editing
              ? <input id="so-vin" style={{ ...input, fontFamily: 'ui-monospace, Menlo, monospace' }} value={hdr.vin} maxLength={17} onChange={e => setHdr({ ...hdr, vin: e.target.value.toUpperCase() })} />
              : <div style={{ fontWeight: 600, fontFamily: 'ui-monospace, Menlo, monospace' }}>{h.vin || '—'}</div>}
          </div>
          <div>
            <label style={label} htmlFor="so-ship">Ship date</label>
            {editing
              ? <input id="so-ship" type="date" style={input} value={hdr.shipDate} onChange={e => setHdr({ ...hdr, shipDate: e.target.value })} />
              : <div style={{ fontWeight: 600 }}>{fmtDate(h.shipDate) || '—'}</div>}
          </div>
          <div><span style={label}>Sales rep</span><div style={{ fontWeight: 600 }}>{h.salesRep || '—'}</div></div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={label} htmlFor="so-memo">Memo</label>
            {editing
              ? <textarea id="so-memo" style={{ ...input, minHeight: '60px' }} value={hdr.memo} maxLength={999} onChange={e => setHdr({ ...hdr, memo: e.target.value })} />
              : <div style={{ whiteSpace: 'pre-wrap' }}>{h.memo || '—'}</div>}
          </div>
        </div>
        {!editing && h.tranId && (
          <SentBox
            refs={[docRef('sales_order', h.tranId)]}
            docLabel={`SO ${h.tranId}`}
            canMark={data.canEdit}
            emptyText="Not emailed yet"
            refreshKey={sentBump}
            style={{ marginTop: '14px' }}
          />
        )}
      </div>

      {saved && (
        <div style={{ ...card, background: theme.successBg, borderColor: theme.successBorder, color: theme.success, fontWeight: 600 }}>
          Saved to NetSuite: {saved.join('; ')}.
        </div>
      )}

      {/* ── Lines ── */}
      <div style={card}>
        <h2 style={{ margin: '0 0 10px', fontSize: '15px', fontWeight: 800 }}>Lines</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: showMoney ? '760px' : '560px' }}>
            <thead>
              <tr>
                <th style={th}>Item</th>
                <th style={th}>Description</th>
                <th style={{ ...th, ...num }}>Ordered</th>
                <th style={{ ...th, ...num }}>Shipped</th>
                <th style={{ ...th, ...num }}>Billed</th>
                {showMoney && <th style={{ ...th, ...num }}>Price</th>}
                {showMoney && <th style={{ ...th, ...num }}>Amount</th>}
                {editing && <th style={th}></th>}
              </tr>
            </thead>
            <tbody>
              {data.lines.map(l => {
                const d = drafts[l.line];
                const can = lineAllows(l);
                const billed = isFullyBilled(l);
                const removed = editing && d?.remove;
                const closing = editing && d?.close;
                const reopening = editing && d?.reopen;
                const shownClosed = (l.isClosed && !reopening) || closing;
                const problem = lineProblem(l);
                const qEditable = editing && !removed && !closing && (can.quantity || reopening);
                const rEditable = editing && !removed && !closing && showMoney && (can.price || (reopening && l.quantityBilled === 0));
                const rowBg = billed ? theme.subtleBg : undefined;
                const strike = removed || shownClosed;
                return (
                  <tr key={l.line} style={{ background: rowBg, opacity: removed ? 0.5 : 1 }}>
                    <td style={{ ...td, fontFamily: 'ui-monospace, Menlo, monospace', whiteSpace: 'nowrap' }}>{l.itemNumber}</td>
                    <td style={{ ...td, textDecoration: strike ? 'line-through' : undefined, color: strike ? theme.textMuted : undefined }}>
                      {l.description}
                      {shownClosed && <span style={{ marginLeft: '6px', fontSize: '11px', fontWeight: 700, color: theme.textMuted }}>Closed</span>}
                      {removed && <span style={{ marginLeft: '6px', fontSize: '11px', fontWeight: 700, color: theme.error }}>Will be removed</span>}
                    </td>
                    <td style={{ ...td, ...num }}>
                      {qEditable ? (
                        <>
                          <input
                            aria-label={`Quantity for ${l.itemNumber}`}
                            inputMode="decimal"
                            value={d.quantity}
                            onChange={e => setDraft(l.line, { quantity: e.target.value })}
                            style={{ ...input, width: '76px', textAlign: 'right', borderColor: problem ? theme.error : theme.border }}
                          />
                          {problem && <div style={{ color: theme.error, fontSize: '11px', marginTop: '2px' }}>{problem}</div>}
                        </>
                      ) : l.editable ? qtyText(l.quantity) : ''}
                    </td>
                    <td style={{ ...td, ...num }}>{l.editable ? qtyText(l.quantityShipped) : ''}</td>
                    <td style={{ ...td, ...num }}>{l.editable ? qtyText(l.quantityBilled) : ''}</td>
                    {showMoney && (
                      <td style={{ ...td, ...num }}>
                        {rEditable ? (
                          <input
                            aria-label={`Price for ${l.itemNumber}`}
                            inputMode="decimal"
                            value={d.rate}
                            onChange={e => setDraft(l.line, { rate: e.target.value })}
                            style={{ ...input, width: '96px', textAlign: 'right' }}
                          />
                        ) : (
                          <>
                            {money(l.rate)}
                            {editing && l.editable && !billed && l.quantityBilled > 0 && <div style={{ fontSize: '11px', color: theme.textMuted }}>partly billed</div>}
                          </>
                        )}
                      </td>
                    )}
                    {showMoney && <td style={{ ...td, ...num }}>{money(l.amount)}</td>}
                    {editing && (
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {billed && <span style={{ fontSize: '12px', color: theme.textMuted }}>Billed</span>}
                        {!l.editable && <span style={{ fontSize: '12px', color: theme.textMuted }}>Not editable</span>}
                        {can.remove && (
                          <button style={{ ...linkBtn, color: removed ? theme.textSecondary : theme.error }} onClick={() => setDraft(l.line, { remove: !removed })}>
                            {removed ? 'Keep' : 'Remove'}
                          </button>
                        )}
                        {can.close && !can.remove && (
                          <button style={{ ...linkBtn, color: closing ? theme.textSecondary : theme.error }} onClick={() => setDraft(l.line, { close: !closing })}>
                            {closing ? 'Keep open' : 'Close rest'}
                          </button>
                        )}
                        {can.reopen && (
                          <button style={{ ...linkBtn, color: 'var(--accent)' }} onClick={() => setDraft(l.line, { reopen: !reopening })}>
                            {reopening ? 'Keep closed' : 'Reopen'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {editing && added.map(n => (
                <tr key={n.key} style={{ background: theme.successBg }}>
                  <td style={{ ...td, fontFamily: 'ui-monospace, Menlo, monospace' }}>{n.itemNumber}</td>
                  <td style={td}>{n.description} <span style={{ fontSize: '11px', fontWeight: 700, color: theme.success }}>New</span></td>
                  <td style={{ ...td, ...num }}>
                    <input aria-label={`Quantity for ${n.itemNumber}`} inputMode="decimal" value={n.quantityText}
                      onChange={e => setAdded(a => a.map(x => x.key === n.key ? { ...x, quantityText: e.target.value } : x))}
                      style={{ ...input, width: '76px', textAlign: 'right' }} />
                  </td>
                  <td style={{ ...td, ...num }}>0</td>
                  <td style={{ ...td, ...num }}>0</td>
                  {showMoney && (
                    <td style={{ ...td, ...num }}>
                      <input aria-label={`Price for ${n.itemNumber}`} inputMode="decimal" value={n.rateText}
                        onChange={e => setAdded(a => a.map(x => x.key === n.key ? { ...x, rateText: e.target.value } : x))}
                        style={{ ...input, width: '96px', textAlign: 'right' }} />
                    </td>
                  )}
                  {showMoney && <td style={{ ...td, ...num }}>{money((parseFloat(n.quantityText) || 0) * (parseFloat(n.rateText) || 0))}</td>}
                  <td style={td}>
                    <button style={{ ...linkBtn, color: theme.error }} onClick={() => setAdded(a => a.filter(x => x.key !== n.key))}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {editing && showMoney && (
          <div style={{ marginTop: '10px' }}>
            {!adding ? (
              <button style={btn} onClick={() => setAdding(true)}>+ Add line</button>
            ) : (
              <div style={{ maxWidth: '520px' }}>
                <label style={label} htmlFor="so-add">Find a part or labor item</label>
                <input id="so-add" autoFocus style={input} value={search} placeholder="Item number or description" onChange={e => setSearch(e.target.value)} />
                {hits.length > 0 && (
                  <div style={{ border: `1px solid ${theme.border}`, borderRadius: '8px', marginTop: '4px', maxHeight: '260px', overflowY: 'auto' }}>
                    {hits.map(it => (
                      <button key={it.itemId} onClick={() => addItem(it)}
                        style={{ display: 'flex', width: '100%', gap: '10px', justifyContent: 'space-between', padding: '8px 10px', background: theme.card, border: 'none', borderBottom: `1px solid ${theme.border}`, color: theme.textPrimary, cursor: 'pointer', textAlign: 'left' }}>
                        <span style={{ minWidth: 0 }}><b style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{it.itemNumber}</b> <span style={{ color: theme.textSecondary }}>{it.description}</span></span>
                        <span style={{ whiteSpace: 'nowrap' }}>{money(it.price)}</span>
                      </button>
                    ))}
                  </div>
                )}
                <button style={{ ...linkBtn, color: theme.textSecondary, marginTop: '6px' }} onClick={() => { setAdding(false); setSearch(''); }}>Cancel</button>
              </div>
            )}
          </div>
        )}

        {showMoney && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '28px', marginTop: '12px', fontVariantNumeric: 'tabular-nums', flexWrap: 'wrap' }}>
            <div style={{ textAlign: 'right' }}><span style={label}>Subtotal{editing ? ' (estimated)' : ''}</span><b>{money(subtotal)}</b></div>
            {!editing && <div style={{ textAlign: 'right' }}><span style={label}>Tax</span><b>{money(h.taxTotal)}</b></div>}
            {!editing && <div style={{ textAlign: 'right' }}><span style={label}>Total</span><b style={{ fontSize: '16px' }}>{money(h.total)}</b></div>}
          </div>
        )}
        {editing && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: theme.textMuted }}>
            Billed lines are locked. A quantity can&apos;t go below what already shipped or billed. A line that has shipped can be closed instead of removed. NetSuite works out tax when you save.
          </div>
        )}
      </div>

      {/* ── Linked documents + history ── */}
      {!editing && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
          <div style={card}>
            <h2 style={{ margin: '0 0 10px', fontSize: '15px', fontWeight: 800 }}>Invoices</h2>
            {data.invoices === null && <div style={{ color: theme.warning, fontSize: '13px' }}>Couldn&apos;t check NetSuite for invoices just now.</div>}
            {data.invoices && data.invoices.length === 0 && <div style={{ color: theme.textMuted, fontSize: '13px' }}>Nothing billed yet.</div>}
            {data.invoices && data.invoices.map(inv => {
              const openInvoice = async () => { const r = await openNetSuitePdf('invoice', inv.id); if (!r.ok) await dialog.alert(`Could not open the invoice: ${r.error}`); };
              const e = inv.emailed;
              const bad = e && isBadDelivery(e.status);
              return (
                <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px 10px', padding: '8px 0', borderBottom: `1px dashed ${theme.border}`, fontSize: '13px' }}>
                  <div style={{ minWidth: 0 }}>
                    <button style={{ ...linkBtn, color: 'var(--accent)', paddingLeft: 0 }} onClick={openInvoice}>
                      Invoice {inv.tranid}
                    </button>
                    <div style={{ color: theme.textSecondary }}>{fmtDate(inv.trandate)}{inv.total != null ? ` · ${money(inv.total)}` : ''}</div>
                    <div style={{ fontSize: '12px', color: !e ? theme.textMuted : bad ? theme.error : theme.success, fontWeight: bad ? 700 : 400 }}>
                      {!e ? 'Not emailed yet' : `✉ Emailed ${fmtWhen(e.at)}${e.by ? ` by ${e.by}` : ''}${e.to.length ? ` to ${e.to.join(', ')}` : ''}${
                        bad ? ` · Did not arrive (${e.status})` : e.status === 'delivered' ? ' · Delivered' : ''}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button style={{ ...btn, padding: '5px 10px', fontSize: '12px' }} onClick={openInvoice}>🖨 Print</button>
                    {data.canEdit && <button style={{ ...btn, padding: '5px 10px', fontSize: '12px' }} onClick={() => setEmailing({ id: inv.id, tranid: inv.tranid })}>✉ Email</button>}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={card}>
            <h2 style={{ margin: '0 0 10px', fontSize: '15px', fontWeight: 800 }}>Changes made in FleetSuite</h2>
            {data.history.length === 0 && <div style={{ color: theme.textMuted, fontSize: '13px' }}>None yet.</div>}
            {data.history.map((e, i) => (
              <div key={i} style={{ padding: '6px 0', borderBottom: `1px dashed ${theme.border}`, fontSize: '13px' }}>
                <div style={{ color: theme.textSecondary, fontSize: '12px' }}>{fmtWhen(e.at)}{e.by ? ` · ${e.by}` : ''}</div>
                <div>{e.changes.join('; ')}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {fulfilling && (
        <FulfillInvoiceModal salesOrderId={id} soLabel={`SO ${h.tranId}`} onClose={() => { setFulfilling(false); load(); }} onInvoiced={load} />
      )}
      {emailingSo && (
        <EmailComposeModal
          title={`Email sales order ${h.tranId}`}
          stateKey={`sales-order-email:${id}`}
          intro={<div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 8 }}>The sales order PDF from NetSuite is attached.</div>}
          messagePlaceholder="Optional note to the customer"
          fetchPreview={async fields => {
            const res = await apiFetch(`/api/sales-orders/${encodeURIComponent(id)}/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: soEmailBody(fields, true) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) return { error: json.error || 'Could not build the preview' };
            return { preview: { to: json.to, subject: json.subject, html: json.html } };
          }}
          onSend={async fields => {
            const res = await apiFetch(`/api/sales-orders/${encodeURIComponent(id)}/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: soEmailBody(fields, false) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) { await dialog.alert(json.error || 'Could not send the email', { error: true }); return { ok: false }; }
            setSentBump(n => n + 1);
            return { ok: true };
          }}
          onClose={() => setEmailingSo(false)}
        />
      )}
      {emailing && (
        <EmailInvoicesModal
          customerName={h.customerName || ''}
          customerNetsuiteId={h.customerId}
          invoices={[{ invoiceId: emailing.id, invoiceNumber: emailing.tranid, po: h.poNumber || undefined }]}
          onClose={() => { setEmailing(null); load(); }}
        />
      )}
    </div>
  );
}
