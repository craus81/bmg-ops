'use client';

/**
 * Review & verify a graphics job's invoice lines BEFORE anything is created.
 *
 * Opens on "Review & Invoice". Pulls a proposed set of lines from
 * /api/graphics/invoice-preview (one per part, quantities from the linked PO,
 * prices from the catalog/NetSuite), then lets the user fully edit them:
 * change quantities/rates/descriptions, pick or swap the NetSuite item per
 * line, add ad-hoc lines, and search/override the customer. From here they can
 * print a matching packing list or create the invoice with the verified lines.
 * Nothing is created until it's been checked — the fix for "quantities on the
 * invoice don't match reality".
 */

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import PhoneInput from '@/components/PhoneInput';
import NumberInput from '@/components/NumberInput';
import type { GraphicsJob } from '@/lib/types';
import { exportPackingListPDF, packingListFromJob, type PackingListLine } from '@/lib/packing-list-pdf';

interface CustomerRow {
  id: string;
  netsuite_id: string | null;
  company_name: string | null;
  entity_id: string | null;
}

interface PartRow {
  id: string;
  netsuite_id: string | null;
  item_number: string | null;
  display_name: string | null;
  description: string | null;
  sales_price: number | null;
}

interface ReviewLine {
  key: string;
  partNumber: string;
  itemId: string | null;       // NetSuite internal id; null = no item picked yet
  displayName: string;
  description: string;
  quantity: number;
  rate: number;
  qtySource: 'po' | 'job' | 'manual' | 'quote';
}

interface CustomerPrefill {
  companyName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}

const EMPTY_NEW_CUSTOMER: CustomerPrefill = {
  companyName: '', email: '', phone: '', address: '', city: '', state: '', zip: '',
};

interface Props {
  job: GraphicsJob;
  onClose: () => void;
  onComplete: (result: {
    invoiceId?: string;
    invoiceNumber?: string;
    invoiceAmount?: number;
    lines: PackingListLine[];
  }) => void;
}

const genKey = () => Math.random().toString(36).slice(2, 10);

export default function GraphicsInvoiceReviewModal({ job, onClose, onComplete }: Props) {
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [alreadyInvoiced, setAlreadyInvoiced] = useState<{ number?: string | null } | null>(null);

  // ── Customer (resolved, with optional override) ──
  const [customer, setCustomer] = useState<{ netsuiteId: string | null; name: string | null }>({ netsuiteId: null, name: null });
  const [customerOverride, setCustomerOverride] = useState<CustomerRow | null>(null);
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [custSearch, setCustSearch] = useState('');
  const [custResults, setCustResults] = useState<CustomerRow[]>([]);
  const [custSearching, setCustSearching] = useState(false);

  // ── Add a brand-new NetSuite customer (used when the graphics job has no
  // NetSuite customer — common for wrap-quote jobs where the customer was
  // typed in, not picked from the synced list) ──
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [newCust, setNewCust] = useState<CustomerPrefill>(EMPTY_NEW_CUSTOMER);
  const [customerPrefill, setCustomerPrefill] = useState<CustomerPrefill | null>(null);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [custError, setCustError] = useState<string | null>(null);

  const [poNumber, setPoNumber] = useState<string | null>(null);
  const [lines, setLines] = useState<ReviewLine[]>([]);
  const [wrapQuote, setWrapQuote] = useState<{ quoteNumber: string | null; total: number; applied: boolean } | null>(null);

  // ── Per-row NetSuite item picker ──
  const [activePartRow, setActivePartRow] = useState<string | null>(null);
  const [partSearch, setPartSearch] = useState('');
  const [partResults, setPartResults] = useState<PartRow[]>([]);
  const [partSearching, setPartSearching] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Load proposed lines ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/graphics/invoice-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: job.id }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data.error || `Failed to load preview (${res.status})`);
        } else if (data.alreadyInvoiced) {
          setAlreadyInvoiced({ number: data.alreadyInvoiced.number });
        } else {
          setCustomer(data.customer || { netsuiteId: null, name: null });
          setPoNumber(data.poNumber || null);
          setWrapQuote(data.wrapQuote || null);
          if (data.customerPrefill) setCustomerPrefill(data.customerPrefill);
          setLines((data.lines || []).map((l: any) => ({
            key: genKey(),
            partNumber: l.partNumber,
            itemId: l.itemId,
            displayName: l.displayName,
            description: l.displayName || l.partNumber || '',
            quantity: l.quantity,
            rate: l.rate,
            qtySource: l.qtySource,
          })));
        }
      } catch {
        if (!cancelled) setLoadError('Network error loading preview');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [job.id]);

  // ── Customer search (debounced) ──
  useEffect(() => {
    if (!editingCustomer || custSearch.length < 2) { setCustResults([]); return; }
    let cancelled = false;
    setCustSearching(true);
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('customers')
        .select('id, netsuite_id, company_name, entity_id')
        .or(`company_name.ilike.%${custSearch}%,entity_id.ilike.%${custSearch}%`)
        .limit(8);
      if (!cancelled) {
        setCustResults((data as CustomerRow[]) || []);
        setCustSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [custSearch, editingCustomer, supabase]);

  // ── Part search (debounced, only for the row being edited) ──
  useEffect(() => {
    if (!activePartRow || partSearch.length < 2) { setPartResults([]); return; }
    let cancelled = false;
    setPartSearching(true);
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('netsuite_parts')
        .select('id, netsuite_id, item_number, display_name, description, sales_price')
        .eq('is_active', true)
        .or(`item_number.ilike.%${partSearch}%,display_name.ilike.%${partSearch}%,description.ilike.%${partSearch}%`)
        .limit(10);
      if (!cancelled) {
        setPartResults((data as PartRow[]) || []);
        setPartSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [partSearch, activePartRow, supabase]);

  const updateLine = useCallback((key: string, patch: Partial<ReviewLine>) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l));
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines(prev => prev.filter(l => l.key !== key));
  }, []);

  const addLine = useCallback(() => {
    const key = genKey();
    setLines(prev => [...prev, {
      key, partNumber: '', itemId: null, displayName: '', description: '',
      quantity: 1, rate: 0, qtySource: 'manual',
    }]);
    setActivePartRow(key);
    setPartSearch('');
    setPartResults([]);
  }, []);

  const pickPart = useCallback((rowKey: string, part: PartRow) => {
    updateLine(rowKey, {
      itemId: part.netsuite_id,
      partNumber: part.item_number || '',
      displayName: part.display_name || part.description || part.item_number || '',
      description: part.display_name || part.description || part.item_number || '',
      rate: part.sales_price ?? 0,
    });
    setActivePartRow(null);
    setPartSearch('');
    setPartResults([]);
  }, [updateLine]);

  const openCreateCustomer = useCallback(() => {
    setCreatingCustomer(true);
    setEditingCustomer(false);
    setCustError(null);
    // Prefill from the wrap quote's customer snapshot (or whatever was typed
    // into the search), so the NetSuite record isn't retyped from scratch.
    setNewCust({
      ...EMPTY_NEW_CUSTOMER,
      ...(customerPrefill || {}),
      companyName: (customerPrefill?.companyName || custSearch || customer.name || '').trim(),
    });
  }, [customerPrefill, custSearch, customer.name]);

  const createCustomer = useCallback(async () => {
    const companyName = newCust.companyName.trim();
    if (!companyName) { setCustError('Company name is required.'); return; }
    setSavingCustomer(true);
    setCustError(null);
    try {
      const res = await fetch('/api/wrap-quote/create-customer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName,
          email: newCust.email.trim() || undefined,
          phone: newCust.phone.trim() || undefined,
          address: newCust.address.trim() || undefined,
          city: newCust.city.trim() || undefined,
          state: newCust.state.trim() || undefined,
          zip: newCust.zip.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setCustError(data.error || `Failed to create customer (${res.status})`);
        setSavingCustomer(false);
        return;
      }
      // Use the freshly-created NetSuite customer as the invoice customer.
      setCustomerOverride({
        id: data.customerId || `ns-${data.netsuiteId}`,
        netsuite_id: String(data.netsuiteId),
        company_name: companyName,
        entity_id: data.entityId || null,
      });
      setCreatingCustomer(false);
      setNewCust(EMPTY_NEW_CUSTOMER);
    } catch (e: any) {
      setCustError(e?.message || 'Network error creating customer');
    }
    setSavingCustomer(false);
  }, [newCust]);

  const effectiveCustomer = customerOverride
    ? { netsuiteId: customerOverride.netsuite_id, name: customerOverride.company_name || customerOverride.entity_id }
    : customer;

  // Lines that can go on the invoice (item picked + qty > 0).
  const invoiceLines = lines.filter(l => l.itemId && l.quantity > 0);
  const unpriced = invoiceLines.filter(l => !(l.rate > 0));
  const total = invoiceLines.reduce((sum, l) => sum + l.quantity * l.rate, 0);

  // Packing list reflects everything being shipped (qty > 0), item or not.
  const packingLines = (): PackingListLine[] =>
    lines.filter(l => l.quantity > 0).map(l => ({
      partNumber: l.partNumber,
      description: l.description || l.displayName || '',
      quantity: l.quantity,
    }));

  const canCreate = !!effectiveCustomer.netsuiteId && invoiceLines.length > 0 && unpriced.length === 0 && !submitting;

  const printPackingList = () => {
    try {
      exportPackingListPDF(packingListFromJob(job, { lines: packingLines() }), { print: true });
    } catch {
      setError('Could not generate the packing list.');
    }
  };

  const createInvoice = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/graphics/create-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.id,
          customerNsId: effectiveCustomer.netsuiteId,
          lines: invoiceLines.map(l => ({
            itemId: l.itemId,
            quantity: l.quantity,
            rate: l.rate,
            description: l.description.trim() || undefined,
            partNumber: l.partNumber || undefined,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setError(data.error || `Failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      onComplete({
        invoiceId: data.invoiceId,
        invoiceNumber: data.invoiceNumber,
        invoiceAmount: data.invoiceAmount,
        lines: packingLines(),
      });
    } catch (e: any) {
      setError(e?.message || 'Network error');
      setSubmitting(false);
    }
  };

  const numInput: React.CSSProperties = {
    width: '100%', padding: '6px 8px', borderRadius: '6px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
  };
  const searchInput: React.CSSProperties = {
    width: '100%', padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      zIndex: 1000, padding: '20px', overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--card)', borderRadius: '14px', maxWidth: '760px', width: '100%',
        border: '1px solid var(--border)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)', margin: 'auto 0',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Review &amp; Verify Invoice</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {job.title || 'Graphics job'}{job.job_number ? ` · #${job.job_number}` : ''}{poNumber ? ` · PO #${poNumber}` : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px 8px' }}>✕</button>
        </div>

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {loading ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading proposed lines…</div>
          ) : loadError ? (
            <div style={{ padding: '12px', borderRadius: '8px', background: 'color-mix(in srgb, var(--danger, #ef4444) 8%, var(--card))', border: '1px solid var(--danger, #ef4444)', fontSize: '12px', color: 'var(--danger, #ef4444)' }}>{loadError}</div>
          ) : alreadyInvoiced ? (
            <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', fontSize: '13px', color: '#22c55e' }}>
              This job is already invoiced{alreadyInvoiced.number ? ` as #${alreadyInvoiced.number}` : ''}.
            </div>
          ) : (
            <>
              {/* Customer */}
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Customer</div>
                {creatingCustomer ? (
                  <div style={{ borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', padding: '12px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>New NetSuite customer</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <input value={newCust.companyName} onChange={e => setNewCust(v => ({ ...v, companyName: e.target.value }))} placeholder="Company name *" autoFocus style={{ ...searchInput, gridColumn: '1 / -1' }} />
                      <input value={newCust.email} onChange={e => setNewCust(v => ({ ...v, email: e.target.value }))} placeholder="Email" style={searchInput} />
                      <PhoneInput value={newCust.phone} onChange={val => setNewCust(v => ({ ...v, phone: val }))} placeholder="Phone" style={searchInput} />
                      <input value={newCust.address} onChange={e => setNewCust(v => ({ ...v, address: e.target.value }))} placeholder="Address" style={{ ...searchInput, gridColumn: '1 / -1' }} />
                      <input value={newCust.city} onChange={e => setNewCust(v => ({ ...v, city: e.target.value }))} placeholder="City" style={searchInput} />
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                        <input value={newCust.state} onChange={e => setNewCust(v => ({ ...v, state: e.target.value }))} placeholder="State" style={searchInput} />
                        <input value={newCust.zip} onChange={e => setNewCust(v => ({ ...v, zip: e.target.value }))} placeholder="ZIP" style={searchInput} />
                      </div>
                    </div>
                    {custError && <div style={{ fontSize: '11px', color: 'var(--danger, #ef4444)', marginTop: '8px' }}>{custError}</div>}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                      <button
                        onClick={createCustomer}
                        disabled={savingCustomer || !newCust.companyName.trim()}
                        style={{ padding: '7px 14px', borderRadius: '7px', border: 'none', background: '#22c55e', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: savingCustomer || !newCust.companyName.trim() ? 'not-allowed' : 'pointer', opacity: savingCustomer || !newCust.companyName.trim() ? 0.5 : 1 }}
                      >{savingCustomer ? 'Creating…' : 'Create in NetSuite'}</button>
                      <button onClick={() => { setCreatingCustomer(false); setCustError(null); }} style={{ padding: '7px 12px', borderRadius: '7px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
                    </div>
                  </div>
                ) : editingCustomer ? (
                  <div>
                    <input
                      type="text" autoFocus value={custSearch}
                      onChange={e => setCustSearch(e.target.value)}
                      placeholder="Search customer by name or entity id…"
                      style={searchInput}
                    />
                    {custSearching && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>Searching…</div>}
                    {custResults.length > 0 && (
                      <div style={{ marginTop: '6px', maxHeight: '180px', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)' }}>
                        {custResults.map(c => (
                          <button
                            key={c.id}
                            onClick={() => { setCustomerOverride(c); setEditingCustomer(false); setCustResults([]); setCustSearch(''); }}
                            disabled={!c.netsuite_id}
                            title={!c.netsuite_id ? 'No NetSuite id on this customer record' : undefined}
                            style={{
                              width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'transparent',
                              color: 'var(--text-primary)', fontSize: '12px', cursor: c.netsuite_id ? 'pointer' : 'not-allowed',
                              opacity: c.netsuite_id ? 1 : 0.4, borderTop: '1px solid var(--border)',
                            }}
                          >
                            <div style={{ fontWeight: 700 }}>{c.company_name || c.entity_id}</div>
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{c.entity_id} {c.netsuite_id ? `· NS ${c.netsuite_id}` : '· no NetSuite id'}</div>
                          </button>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '6px', alignItems: 'center' }}>
                      <button onClick={() => { setEditingCustomer(false); setCustSearch(''); setCustResults([]); }} style={{ padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
                      <button onClick={openCreateCustomer} style={{ padding: '4px 10px', borderRadius: '6px', border: 'none', background: 'transparent', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>+ Add new NetSuite customer</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                    <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                      {effectiveCustomer.name || <span style={{ color: 'var(--text-muted)' }}>No customer</span>}
                      {effectiveCustomer.netsuiteId
                        ? <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>NS {effectiveCustomer.netsuiteId}</span>
                        : <span style={{ color: 'var(--danger, #ef4444)', marginLeft: '8px', fontWeight: 700, fontSize: '11px' }}>· no NetSuite customer — search or add one</span>}
                    </div>
                    <div style={{ display: 'flex', gap: '10px', whiteSpace: 'nowrap' }}>
                      <button onClick={() => { setEditingCustomer(true); setCustSearch(''); }} style={{ background: 'transparent', border: 'none', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                        {effectiveCustomer.netsuiteId ? 'Change' : 'Search'}
                      </button>
                      {!effectiveCustomer.netsuiteId && (
                        <button onClick={openCreateCustomer} style={{ background: 'transparent', border: 'none', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>+ Add</button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Line source hint */}
              {wrapQuote?.applied ? (
                <div style={{ fontSize: '11px', color: '#a78bfa', padding: '8px 10px', borderRadius: '8px', background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.2)' }}>
                  Materials &amp; labor carried through from wrap quote{wrapQuote.quoteNumber ? ` ${wrapQuote.quoteNumber}` : ''} (total ${wrapQuote.total.toFixed(2)}). Verify the lines before creating the invoice.
                </div>
              ) : (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Quantities are suggested from {poNumber ? `PO #${poNumber}` : 'the linked PO'} where parts match, otherwise the job quantity ({job.quantity || 1}). Check each line before creating anything.
                </div>
              )}

              {/* Lines */}
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 110px 70px 28px', gap: '8px', padding: '0 4px 6px', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  <div>Part / Description</div>
                  <div style={{ textAlign: 'center' }}>Qty</div>
                  <div style={{ textAlign: 'center' }}>Rate</div>
                  <div style={{ textAlign: 'right' }}>Total</div>
                  <div />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {lines.length === 0 && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px' }}>No parts on this job — add a line below.</div>
                  )}
                  {lines.map(line => {
                    const lineUnpriced = !!line.itemId && !(line.rate > 0);
                    const needsItem = !line.itemId;
                    if (activePartRow === line.key) {
                      return (
                        <div key={line.key} style={{ padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)' }}>
                          <input
                            type="text" autoFocus value={partSearch}
                            onChange={e => setPartSearch(e.target.value)}
                            placeholder="Search NetSuite items by part number or name…"
                            style={searchInput}
                          />
                          {partSearching && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>Searching…</div>}
                          {partResults.length > 0 && (
                            <div style={{ marginTop: '6px', maxHeight: '180px', overflowY: 'auto', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)' }}>
                              {partResults.map(p => (
                                <button
                                  key={p.id}
                                  onClick={() => pickPart(line.key, p)}
                                  disabled={!p.netsuite_id}
                                  style={{
                                    width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none', background: 'transparent',
                                    color: 'var(--text-primary)', fontSize: '12px', cursor: p.netsuite_id ? 'pointer' : 'not-allowed',
                                    opacity: p.netsuite_id ? 1 : 0.4, borderTop: '1px solid var(--border)',
                                  }}
                                >
                                  <div style={{ fontWeight: 700 }}>{p.item_number}</div>
                                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                    {p.display_name || p.description}{p.sales_price != null && ` · $${p.sales_price.toFixed(2)}`}
                                  </div>
                                </button>
                              ))}
                            </div>
                          )}
                          <button
                            onClick={() => { setActivePartRow(null); setPartSearch(''); setPartResults([]); if (needsItem && !line.partNumber) removeLine(line.key); }}
                            style={{ marginTop: '6px', padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                          >Cancel</button>
                        </div>
                      );
                    }
                    return (
                      <div key={line.key} style={{
                        padding: '10px', borderRadius: '8px',
                        border: `1px solid ${needsItem ? 'rgba(245,158,11,0.4)' : 'var(--border)'}`,
                        background: needsItem ? 'rgba(245,158,11,0.04)' : 'var(--card)',
                      }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 110px 70px 28px', gap: '8px', alignItems: 'center' }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{line.partNumber || 'No part'}</span>
                              {line.qtySource === 'po' && (
                                <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', background: 'rgba(167,139,250,0.15)', color: '#a78bfa' }}>PO QTY</span>
                              )}
                              {line.qtySource === 'quote' && (
                                <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', background: 'rgba(167,139,250,0.15)', color: '#a78bfa' }}>QUOTE</span>
                              )}
                              <button
                                onClick={() => { setActivePartRow(line.key); setPartSearch(line.partNumber || ''); }}
                                style={{ background: 'transparent', border: 'none', color: '#60a5fa', fontSize: '10px', fontWeight: 700, cursor: 'pointer', padding: 0 }}
                              >{line.itemId ? 'change item' : 'pick item'}</button>
                            </div>
                            <input
                              type="text" value={line.description}
                              onChange={e => updateLine(line.key, { description: e.target.value })}
                              placeholder="Description"
                              style={{ ...numInput, marginTop: '6px', fontSize: '11px' }}
                            />
                          </div>
                          <NumberInput
                            min={0} step={1} value={line.quantity}
                            onChange={e => updateLine(line.key, { quantity: Math.max(0, parseFloat(e.target.value) || 0) })}
                            style={{ ...numInput, textAlign: 'center' }}
                          />
                          <NumberInput
                            min={0} step={0.01} value={line.rate}
                            onChange={e => updateLine(line.key, { rate: Math.max(0, parseFloat(e.target.value) || 0) })}
                            style={{ ...numInput, textAlign: 'center', border: `1px solid ${lineUnpriced ? 'var(--danger, #ef4444)' : 'var(--border)'}` }}
                          />
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'right' }}>
                            ${(line.quantity * line.rate).toFixed(2)}
                          </div>
                          <button
                            onClick={() => removeLine(line.key)}
                            title="Remove line"
                            style={{ background: 'transparent', border: 'none', color: 'var(--danger, #ef4444)', fontSize: '16px', cursor: 'pointer', padding: 0 }}
                          >✕</button>
                        </div>
                        {needsItem && (
                          <div style={{ fontSize: '10px', color: '#f59e0b', marginTop: '6px' }}>No NetSuite item — pick one to invoice this line (it still appears on the packing list).</div>
                        )}
                        {lineUnpriced && (
                          <div style={{ fontSize: '10px', color: 'var(--danger, #ef4444)', marginTop: '6px' }}>Enter a price for this part to invoice it.</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  onClick={addLine}
                  style={{ marginTop: '8px', padding: '8px 12px', borderRadius: '8px', border: '1px dashed var(--border)', background: 'transparent', color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                >+ Add line</button>
              </div>

              {/* Total */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Invoice total · {invoiceLines.length} line{invoiceLines.length !== 1 ? 's' : ''}
                </div>
                <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>${total.toFixed(2)}</div>
              </div>

              {error && (
                <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'color-mix(in srgb, var(--danger, #ef4444) 8%, var(--card))', border: '1px solid var(--danger, #ef4444)', fontSize: '12px', color: 'var(--danger, #ef4444)' }}>{error}</div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && !loadError && !alreadyInvoiced && (
          <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', gap: '8px', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={printPackingList}
              disabled={packingLines().length === 0}
              style={{
                padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(34,197,94,0.3)',
                background: 'rgba(34,197,94,0.1)', color: '#22c55e', fontSize: '13px', fontWeight: 700,
                cursor: packingLines().length === 0 ? 'not-allowed' : 'pointer', opacity: packingLines().length === 0 ? 0.5 : 1,
              }}
            >Print Packing List</button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={onClose}
                style={{ padding: '10px 14px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
              >Cancel</button>
              <button
                onClick={createInvoice}
                disabled={!canCreate}
                title={!effectiveCustomer.netsuiteId ? 'Set or search a customer first' : unpriced.length > 0 ? 'Some lines need a price' : undefined}
                style={{
                  padding: '10px 18px', borderRadius: '10px', border: 'none',
                  background: canCreate ? '#22c55e' : 'var(--border)', color: '#fff', fontSize: '14px', fontWeight: 800,
                  cursor: canCreate ? 'pointer' : 'not-allowed', opacity: canCreate ? 1 : 0.5,
                }}
              >{submitting ? 'Creating…' : 'Create Invoice'}</button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
