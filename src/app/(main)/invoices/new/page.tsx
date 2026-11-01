'use client';

/**
 * New invoice from nothing (Craig, 2026-10-26: "there's really no way to just
 * create an invoice … from nothing right now"). Pick a customer, type the
 * lines (any NetSuite item: parts, labor, freight, discounts), and FleetSuite
 * makes a standalone invoice in NetSuite from O'Fallon, no sales order. Books
 * keeps its own copy. Then the PDF and the normal invoice email screen; a
 * person presses Send, nothing goes to the customer on its own.
 *
 * Tax and totals are src/lib/new-invoice.ts, the same rules the server
 * checks in /api/invoices/new. Anyone with the Invoicing permission.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import CustomerPicker from '@/components/CustomerPicker';
import TopSaveBar from '@/components/TopSaveBar';
import EmailInvoicesModal from '@/components/EmailInvoicesModal';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';
import {
  MAX_LINES, formatCents, isDiscountType, workOutNewInvoice,
  type NewInvoiceItem, type NewInvoiceLineDraft,
} from '@/lib/new-invoice';

type Line = NewInvoiceLineDraft & { key: number; quantityText: string; priceText: string };

interface Done {
  invoiceId: string;
  invoiceNumber: string | null;
  customerName: string;
  customerNetsuiteId: string;
  poNumber: string | null;
  totalCents: number;
  warning?: string;
  /** The customer is billed tax-exempt on a certificate that had expired. */
  taxWarning?: string;
}

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

const card: React.CSSProperties = {
  background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px',
};
const label: React.CSSProperties = {
  display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
  color: theme.textMuted, marginBottom: '3px',
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '7px',
  border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '15px',
};
const btn: React.CSSProperties = {
  padding: '9px 14px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.card,
  color: theme.textPrimary, fontSize: '14px', fontWeight: 700, cursor: 'pointer',
};
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

export default function NewInvoicePage() {
  const router = useRouter();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();

  const [requestId, setRequestId] = useState(newRequestId);
  const [customer, setCustomer] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [tax, setTax] = useState<{ taxExempt: boolean; taxRate: number } | null>(null);
  const [poNumber, setPoNumber] = useState('');
  const [memo, setMemo] = useState('');
  const [vin, setVin] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<NewInvoiceItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [emailing, setEmailing] = useState(false);
  const [opening, setOpening] = useState(false);

  // The customer's tax-exempt flag and Settings → Sales Tax, for the total shown.
  useEffect(() => {
    setTax(null);
    if (!customerId) return;
    let stale = false;
    (async () => {
      const res = await apiFetch(`/api/invoices/new?customer=${encodeURIComponent(customerId)}`);
      const body = await res.json().catch(() => ({}));
      if (!stale && res.ok) setTax({ taxExempt: !!body.taxExempt, taxRate: Number(body.taxRate) || 0 });
    })();
    return () => { stale = true; };
  }, [customerId]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      const res = await apiFetch(`/api/invoices/new?q=${encodeURIComponent(q)}`);
      const body = await res.json().catch(() => ({}));
      setHits(res.ok ? body.items || [] : []);
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const drafts: NewInvoiceLineDraft[] = lines.map(l => ({
    itemId: l.itemId, itemNumber: l.itemNumber, itemType: l.itemType, taxableOverride: l.taxableOverride,
    description: l.description, quantity: Number(l.quantityText), price: Number(l.priceText),
  }));
  const worked = useMemo(
    () => workOutNewInvoice(drafts, { taxRate: tax?.taxRate ?? 0, taxExempt: !!tax?.taxExempt, hasCustomer: !!customerId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drafts derive from lines
    [lines, tax, customerId],
  );

  const addItem = (item: NewInvoiceItem) => {
    setLines(prev => [...prev, {
      key: nextKey, itemId: item.itemId, itemNumber: item.itemNumber, itemType: item.itemType,
      taxableOverride: item.taxableOverride, description: item.description,
      quantity: 1, price: item.price ?? 0,
      quantityText: '1', priceText: isDiscountType(item.itemType) ? '' : item.price != null ? String(item.price) : '',
    }]);
    setNextKey(k => k + 1);
    setSearch('');
    setHits([]);
  };
  const patch = (key: number, p: Partial<Line>) => setLines(prev => prev.map(l => (l.key === key ? { ...l, ...p } : l)));
  const remove = (key: number) => setLines(prev => prev.filter(l => l.key !== key));

  const create = async () => {
    if (worked.problems.length > 0 || !customerId) return;
    const ok = await dialog.confirm(
      `Make invoice for ${customer} in NetSuite for ${formatCents(worked.totalCents)}? It ships from O'Fallon, and stock parts come off O'Fallon's stock.`,
      { confirmLabel: 'Create invoice', title: 'Create invoice' },
    );
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/invoices/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          customerNetsuiteId: customerId,
          customerName: customer,
          poNumber: poNumber.trim() || null,
          memo: memo.trim() || null,
          vin: vin.trim() || null,
          lines: worked.lines.map(l => ({ itemId: l.itemId, quantity: l.quantity || 1, price: l.price, description: l.description })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || `NetSuite didn't make the invoice (${res.status}).`);
      setDone({
        invoiceId: body.invoiceId, invoiceNumber: body.invoiceNumber, customerName: body.customerName || customer,
        customerNetsuiteId: body.customerNetsuiteId, poNumber: body.poNumber, totalCents: body.totalCents, warning: body.warning,
        taxWarning: body.taxWarning,
      });
    } catch (e: any) {
      setError(e?.message || "NetSuite didn't make the invoice.");
    } finally {
      setSubmitting(false);
    }
  };

  const startAnother = () => {
    setRequestId(newRequestId());
    setCustomer(''); setCustomerId(null); setPoNumber(''); setMemo(''); setVin('');
    setLines([]); setDone(null); setError(null);
  };

  const openPdf = async () => {
    if (!done) return;
    setOpening(true);
    const r = await openNetSuitePdf('invoice', done.invoiceId);
    setOpening(false);
    if (!r.ok) setError(r.error || "Couldn't open the invoice PDF.");
  };

  if (!authLoading && (!hasFeature('invoicing') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Invoicing permission and price access to make invoices.</div>;
  }

  const shown = !!customerId && lines.length > 0;

  return (
    <div style={{ maxWidth: '820px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!done && (
        <TopSaveBar
          title="New invoice"
          subtitle={customer || undefined}
          error={error || undefined}
          onSave={create}
          saving={submitting}
          disabled={worked.problems.length > 0}
          saveLabel="Create invoice"
          savingLabel="Making invoice…"
          onCancel={() => router.push('/invoices')}
        />
      )}
      <div>
        <button onClick={() => router.push('/invoices')} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>← Invoicing</button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>New invoice</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>No order needed. Made in NetSuite from O&apos;Fallon.</div>
      </div>

      {done ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: theme.success }}>
            Invoice {done.invoiceNumber || done.invoiceId} made in NetSuite
          </div>
          <div style={{ fontSize: '14px', color: theme.textPrimary }}>
            {done.customerName} · {formatCents(done.totalCents)}{done.poNumber ? ` · PO ${done.poNumber}` : ''}
          </div>
          {done.warning && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{done.warning}</div>}
          {done.taxWarning && <div style={{ fontSize: '13px', color: theme.warning, fontWeight: 700 }}>{done.taxWarning}</div>}
          {error && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{error}</div>}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={openPdf} disabled={opening} style={btn}>{opening ? 'Opening…' : 'Open PDF'}</button>
            <button onClick={() => setEmailing(true)} disabled={!done.invoiceNumber} style={btn}>Email invoice…</button>
            <button onClick={startAnother} style={btn}>+ Start another</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '12px' }}>
            <div>
              <label style={label} htmlFor="ni-customer">Customer</label>
              <CustomerPicker
                value={customer}
                netsuiteId={customerId}
                allowCreate={false}
                placeholder="Search customers…"
                onChange={r => { setCustomer(r.customer); setCustomerId(r.customerNetsuiteId); }}
              />
              {customer.trim() && !customerId && (
                <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px' }}>Pick the customer from the list.</div>
              )}
              {tax?.taxExempt && (
                <div style={{ fontSize: '12px', color: theme.textSecondary, marginTop: '4px' }}>Tax exempt customer: no sales tax.</div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
              <div>
                <label style={label} htmlFor="ni-po">Customer PO # (optional)</label>
                <input id="ni-po" style={input} value={poNumber} maxLength={45} onChange={e => setPoNumber(e.target.value)} />
              </div>
              <div>
                <label style={label} htmlFor="ni-vin">VIN (optional)</label>
                <input id="ni-vin" style={input} value={vin} maxLength={17} onChange={e => setVin(e.target.value.toUpperCase())} />
              </div>
            </div>
            <div>
              <label style={label} htmlFor="ni-memo">Memo (optional)</label>
              <input id="ni-memo" style={input} value={memo} maxLength={999} onChange={e => setMemo(e.target.value)} />
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>Lines</div>
            {lines.length === 0 && (
              <div style={{ fontSize: '13px', color: theme.textMuted }}>Find a part, labor, freight or discount item below to add the first line.</div>
            )}
            {worked.lines.map((w, i) => {
              const l = lines[i];
              return (
                <div key={l.key} style={{ border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '10px', display: 'grid', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 800, color: theme.textPrimary }}>{l.itemNumber}</span>
                      <span style={{ fontSize: '12px', color: theme.textMuted, marginLeft: '8px' }}>
                        {w.isDiscount ? 'Discount' : w.taxable ? 'Taxed' : 'Not taxed'}
                      </span>
                    </div>
                    <div style={{ ...num, fontWeight: 800, color: w.cents < 0 ? theme.success : theme.textPrimary }}>{formatCents(w.cents)}</div>
                  </div>
                  <input aria-label="Description" style={input} value={l.description} onChange={e => patch(l.key, { description: e.target.value })} />
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    {!w.isDiscount && (
                      <div style={{ width: '90px' }}>
                        <label style={label} htmlFor={`ni-q-${l.key}`}>Qty</label>
                        <input id={`ni-q-${l.key}`} style={{ ...input, ...num }} inputMode="decimal" value={l.quantityText}
                          onChange={e => patch(l.key, { quantityText: e.target.value })} />
                      </div>
                    )}
                    <div style={{ width: '130px' }}>
                      <label style={label} htmlFor={`ni-p-${l.key}`}>{w.isDiscount ? 'Takes off $' : 'Price each $'}</label>
                      <input id={`ni-p-${l.key}`} style={{ ...input, ...num }} inputMode="decimal" value={l.priceText}
                        onChange={e => patch(l.key, { priceText: e.target.value })} />
                    </div>
                    <button onClick={() => remove(l.key)} style={{ ...btn, marginLeft: 'auto', color: theme.error, borderColor: theme.errorBorder }}>Remove</button>
                  </div>
                </div>
              );
            })}

            {lines.length < MAX_LINES && (
              <div style={{ position: 'relative' }}>
                <label style={label} htmlFor="ni-add">Add a line</label>
                <input id="ni-add" style={input} value={search} placeholder="Part number, labor, freight, discount…"
                  onChange={e => setSearch(e.target.value)} />
                {(hits.length > 0 || (searching && search.trim().length >= 2)) && (
                  <div style={{ border: `1px solid ${theme.border}`, borderRadius: '8px', marginTop: '4px', background: theme.card, maxHeight: '320px', overflowY: 'auto' }}>
                    {searching && hits.length === 0 && <div style={{ padding: '10px', fontSize: '13px', color: theme.textMuted }}>Searching…</div>}
                    {hits.map(h => (
                      <button key={h.itemId} onClick={() => addItem(h)} style={{
                        display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px', border: 'none',
                        borderBottom: `1px solid ${theme.border}`, background: 'none', cursor: 'pointer', color: theme.textPrimary,
                      }}>
                        <span style={{ fontWeight: 700 }}>{h.itemNumber}</span>
                        {h.price != null && !isDiscountType(h.itemType) && <span style={{ float: 'right', ...num }}>{formatCents(Math.round(h.price * 100))}</span>}
                        <span style={{ display: 'block', fontSize: '12px', color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {isDiscountType(h.itemType) ? 'Discount · ' : h.itemType === 'Service' ? 'Service · ' : ''}{h.description}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ ...card, display: 'grid', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: theme.textSecondary }}>
              <span>Subtotal</span><span style={num}>{formatCents(worked.subtotalCents)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: theme.textSecondary }}>
              <span>{!customerId ? 'Sales tax' : tax?.taxExempt ? 'Sales tax (exempt)' : `Sales tax ${tax ? `${(tax.taxRate * 100).toFixed(3).replace(/\.?0+$/, '')}%` : ''}`}</span>
              <span style={num}>{formatCents(worked.taxCents)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '18px', fontWeight: 800, color: theme.textPrimary }}>
              <span>Total</span><span style={num}>{formatCents(worked.totalCents)}</span>
            </div>
            <div style={{ fontSize: '12px', color: theme.textMuted }}>NetSuite works out the final tax; this is what FleetSuite&apos;s rules expect.</div>
          </div>

          {shown && worked.problems.length > 0 && (
            <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700, display: 'grid', gap: '2px' }}>
              {worked.problems.map(p => <div key={p}>{p}</div>)}
            </div>
          )}

        </>
      )}

      {emailing && done?.invoiceNumber && (
        <EmailInvoicesModal
          customerName={done.customerName}
          customerNetsuiteId={done.customerNetsuiteId}
          invoices={[{ invoiceId: done.invoiceId, invoiceNumber: done.invoiceNumber, po: done.poNumber || undefined }]}
          onClose={() => setEmailing(false)}
        />
      )}
    </div>
  );
}
