'use client';

/**
 * New sales order from nothing (Craig, 2026-10-31, thread "Redesign
 * order-to-cash and procure-to-pay", answers 1A 2A 3A 4B). The New invoice
 * screen, making a NetSuite sales order from O'Fallon instead: pick a
 * customer, type the lines (any NetSuite item, typed price, discounts), and,
 * if the order ships somewhere else, a ship-to. Create opens the order's own
 * page, where Edit and Fulfill & Invoice already work. Nothing is billed and
 * no FleetSuite job is made.
 *
 * Tax and totals are src/lib/new-invoice.ts (`noun: 'sales order'`), the same
 * rules /api/sales-orders/new checks. Anyone with the Estimates or the
 * Invoicing permission who can see prices.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import CustomerPicker from '@/components/CustomerPicker';
import TopSaveBar from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { holdAwareFetch } from '@/lib/hold-aware-fetch';
import { deepLinks } from '@/lib/deep-links';
import {
  MAX_LINES, formatCents, isDiscountType, workOutNewInvoice,
  type NewInvoiceItem, type NewInvoiceLineDraft,
} from '@/lib/new-invoice';
import { EMPTY_NEW_SO_SHIP_TO, NEW_SALES_ORDER_FEATURES, shipToBlank, shipToProblem, type NewSoShipTo } from '@/lib/new-sales-order';

type Line = NewInvoiceLineDraft & { key: number; quantityText: string; priceText: string };

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

export default function NewSalesOrderPage() {
  const router = useRouter();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();

  const [requestId] = useState(newRequestId);
  const [customer, setCustomer] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [tax, setTax] = useState<{ taxExempt: boolean; taxRate: number } | null>(null);
  const [poNumber, setPoNumber] = useState('');
  const [memo, setMemo] = useState('');
  const [vin, setVin] = useState('');
  const [shipOpen, setShipOpen] = useState(false);
  const [shipTo, setShipTo] = useState<NewSoShipTo>(EMPTY_NEW_SO_SHIP_TO);
  const [lines, setLines] = useState<Line[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<NewInvoiceItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);

  // The customer's tax-exempt flag and Settings → Sales Tax, for the total shown.
  useEffect(() => {
    setTax(null);
    if (!customerId) return;
    let stale = false;
    (async () => {
      const res = await apiFetch(`/api/sales-orders/new?customer=${encodeURIComponent(customerId)}`);
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
      const res = await apiFetch(`/api/sales-orders/new?q=${encodeURIComponent(q)}`);
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
    () => workOutNewInvoice(drafts, { taxRate: tax?.taxRate ?? 0, taxExempt: !!tax?.taxExempt, hasCustomer: !!customerId, noun: 'sales order' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drafts derive from lines
    [lines, tax, customerId],
  );
  const shipProblem = shipToProblem(shipTo);
  const problems = shipProblem ? [...worked.problems, shipProblem] : worked.problems;

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
    if (problems.length > 0 || !customerId) return;
    const ok = await dialog.confirm(
      `Make a sales order for ${customer} in NetSuite for ${formatCents(worked.totalCents)}? It ships from O'Fallon${shipToBlank(shipTo) ? '' : ` to ${shipTo.name.trim()}`}. Nothing is billed yet.`,
      { confirmLabel: 'Create sales order', title: 'Create sales order' },
    );
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await holdAwareFetch(dialog, '/api/sales-orders/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          customerNetsuiteId: customerId,
          customerName: customer,
          poNumber: poNumber.trim() || null,
          memo: memo.trim() || null,
          vin: vin.trim() || null,
          shipTo: shipToBlank(shipTo) ? null : shipTo,
          lines: worked.lines.map(l => ({ itemId: l.itemId, quantity: l.quantity || 1, price: l.price, description: l.description })),
        }),
      }, apiFetch);
      if (!res) return;
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || `NetSuite didn't make the sales order (${res.status}).`);
      setMade(body.salesOrderNumber || body.salesOrderId);
      router.replace(deepLinks.salesOrder(body.salesOrderId));
    } catch (e: any) {
      setError(e?.message || "NetSuite didn't make the sales order.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!authLoading && (!NEW_SALES_ORDER_FEATURES.some(f => hasFeature(f)) || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Estimates or Invoicing permission and price access to make sales orders.</div>;
  }

  const shown = !!customerId && lines.length > 0;

  return (
    <div style={{ maxWidth: '820px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!made && (
        <TopSaveBar
          title="New sales order"
          subtitle={customer || undefined}
          error={error || undefined}
          onSave={create}
          saving={submitting}
          disabled={problems.length > 0}
          saveLabel="Create sales order"
          savingLabel="Making sales order…"
          onCancel={() => router.push('/sales-orders')}
        />
      )}
      <div>
        <button onClick={() => router.push('/sales-orders')} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>← Sales orders</button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>New sales order</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>Made in NetSuite from O&apos;Fallon, dated today. Nothing is billed until you invoice it.</div>
      </div>

      {made ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, fontSize: '16px', fontWeight: 800, color: theme.success }}>
          Sales order {made} made in NetSuite. Opening it…
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '12px' }}>
            <div>
              <label style={label} htmlFor="nso-customer">Customer</label>
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
                <label style={label} htmlFor="nso-po">Customer PO # (optional)</label>
                <input id="nso-po" style={input} value={poNumber} maxLength={45} onChange={e => setPoNumber(e.target.value)} />
              </div>
              <div>
                <label style={label} htmlFor="nso-vin">VIN (optional)</label>
                <input id="nso-vin" style={input} value={vin} maxLength={17} onChange={e => setVin(e.target.value.toUpperCase())} />
              </div>
            </div>
            <div>
              <label style={label} htmlFor="nso-memo">Memo (optional)</label>
              <input id="nso-memo" style={input} value={memo} maxLength={999} onChange={e => setMemo(e.target.value)} />
            </div>
            {!shipOpen && shipToBlank(shipTo) ? (
              <div>
                <button onClick={() => setShipOpen(true)} style={{ ...btn, padding: '6px 10px', fontSize: '13px' }}>+ Ship to a different address</button>
                <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px' }}>Left alone, NetSuite uses the customer&apos;s own ship-to address.</div>
              </div>
            ) : (
              <div style={{ border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '10px', display: 'grid', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary }}>Ship to</span>
                  <button onClick={() => { setShipTo(EMPTY_NEW_SO_SHIP_TO); setShipOpen(false); }} style={{ ...btn, padding: '4px 8px', fontSize: '12px' }}>Use the customer&apos;s address</button>
                </div>
                <div>
                  <label style={label} htmlFor="nso-ship-name">Name</label>
                  <input id="nso-ship-name" style={input} value={shipTo.name} maxLength={150} onChange={e => setShipTo(s => ({ ...s, name: e.target.value }))} />
                </div>
                <div>
                  <label style={label} htmlFor="nso-ship-address">Street</label>
                  <input id="nso-ship-address" style={input} value={shipTo.address} maxLength={150} onChange={e => setShipTo(s => ({ ...s, address: e.target.value }))} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)', gap: '8px' }}>
                  <div>
                    <label style={label} htmlFor="nso-ship-city">City</label>
                    <input id="nso-ship-city" style={input} value={shipTo.city} maxLength={50} onChange={e => setShipTo(s => ({ ...s, city: e.target.value }))} />
                  </div>
                  <div>
                    <label style={label} htmlFor="nso-ship-state">State</label>
                    <input id="nso-ship-state" style={input} value={shipTo.state} maxLength={30} onChange={e => setShipTo(s => ({ ...s, state: e.target.value.toUpperCase() }))} />
                  </div>
                  <div>
                    <label style={label} htmlFor="nso-ship-zip">ZIP</label>
                    <input id="nso-ship-zip" style={input} value={shipTo.zip} maxLength={20} inputMode="numeric" onChange={e => setShipTo(s => ({ ...s, zip: e.target.value }))} />
                  </div>
                </div>
              </div>
            )}
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
                        <label style={label} htmlFor={`nso-q-${l.key}`}>Qty</label>
                        <input id={`nso-q-${l.key}`} style={{ ...input, ...num }} inputMode="decimal" value={l.quantityText}
                          onChange={e => patch(l.key, { quantityText: e.target.value })} />
                      </div>
                    )}
                    <div style={{ width: '130px' }}>
                      <label style={label} htmlFor={`nso-p-${l.key}`}>{w.isDiscount ? 'Takes off $' : 'Price each $'}</label>
                      <input id={`nso-p-${l.key}`} style={{ ...input, ...num }} inputMode="decimal" value={l.priceText}
                        onChange={e => patch(l.key, { priceText: e.target.value })} />
                    </div>
                    <button onClick={() => remove(l.key)} style={{ ...btn, marginLeft: 'auto', color: theme.error, borderColor: theme.errorBorder }}>Remove</button>
                  </div>
                </div>
              );
            })}

            {lines.length < MAX_LINES && (
              <div style={{ position: 'relative' }}>
                <label style={label} htmlFor="nso-add">Add a line</label>
                <input id="nso-add" style={input} value={search} placeholder="Part number, labor, freight, discount…"
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

          {shown && problems.length > 0 && (
            <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700, display: 'grid', gap: '2px' }}>
              {problems.map(p => <div key={p}>{p}</div>)}
            </div>
          )}

        </>
      )}

    </div>
  );
}
