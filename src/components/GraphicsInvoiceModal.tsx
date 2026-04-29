'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import type { GraphicsJob } from '@/lib/types';

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

interface LineItem {
  key: string;
  netsuite_item_id: string | null;
  item_number: string;
  description: string;
  quantity: number;
  rate: number;
}

interface Props {
  job: GraphicsJob;
  onClose: () => void;
  onComplete: (result: { invoiceId?: string; invoiceNumber?: string }) => void;
}

const genKey = () => Math.random().toString(36).slice(2, 10);

export default function GraphicsInvoiceModal({ job, onClose, onComplete }: Props) {
  const supabase = createClient();

  // ── Customer ──
  const [custSearch, setCustSearch] = useState(job.customer || '');
  const [custResults, setCustResults] = useState<CustomerRow[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRow | null>(null);
  const [custSearching, setCustSearching] = useState(false);

  // ── Lines ──
  const [lines, setLines] = useState<LineItem[]>(() => [{
    key: genKey(),
    netsuite_item_id: null,
    item_number: job.part_number || '',
    description: job.title || '',
    quantity: job.quantity || 1,
    rate: 0,
  }]);

  // ── Part picker (per-row) ──
  const [activePartRow, setActivePartRow] = useState<string | null>(null);
  const [partSearch, setPartSearch] = useState('');
  const [partResults, setPartResults] = useState<PartRow[]>([]);
  const [partSearching, setPartSearching] = useState(false);

  // ── Memo + submit ──
  const [memo, setMemo] = useState(`Graphics job ${job.job_number ? `#${job.job_number} ` : ''}${job.title || ''}`.trim());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Customer search (debounced) ──
  useEffect(() => {
    if (selectedCustomer) return;
    if (custSearch.length < 2) { setCustResults([]); return; }
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
  }, [custSearch, selectedCustomer, supabase]);

  // ── Part search (debounced, only when a row is being edited) ──
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

  const updateLine = useCallback((key: string, patch: Partial<LineItem>) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l));
  }, []);

  const addLine = useCallback(() => {
    setLines(prev => [...prev, {
      key: genKey(),
      netsuite_item_id: null,
      item_number: '',
      description: '',
      quantity: 1,
      rate: 0,
    }]);
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines(prev => prev.length > 1 ? prev.filter(l => l.key !== key) : prev);
  }, []);

  const pickPart = useCallback((rowKey: string, part: PartRow) => {
    updateLine(rowKey, {
      netsuite_item_id: part.netsuite_id,
      item_number: part.item_number || '',
      description: part.display_name || part.description || part.item_number || '',
      rate: part.sales_price ?? 0,
    });
    setActivePartRow(null);
    setPartSearch('');
    setPartResults([]);
  }, [updateLine]);

  const total = lines.reduce((sum, l) => sum + l.quantity * l.rate, 0);

  const ready =
    !!selectedCustomer?.netsuite_id &&
    lines.length > 0 &&
    lines.every(l => l.netsuite_item_id && l.quantity > 0 && l.rate >= 0);

  const submit = async () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/netsuite/create-invoice-direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: selectedCustomer!.netsuite_id,
          memo: memo.trim() || undefined,
          graphicsJobId: job.id,
          lineItems: lines.map(l => ({
            itemId: l.netsuite_item_id,
            quantity: l.quantity,
            rate: l.rate,
            description: l.description.trim() || undefined,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed (${res.status})`);
      } else {
        onComplete({ invoiceId: data.invoiceId, invoiceNumber: data.invoiceNumber });
      }
    } catch (e: any) {
      setError(e?.message || 'Network error');
    }
    setSubmitting(false);
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      zIndex: 1000, padding: '20px', overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--card)', borderRadius: '14px', maxWidth: '720px', width: '100%',
        border: '1px solid var(--border)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)',
        margin: 'auto 0',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Create Invoice in FleetSuite</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {job.title || 'Graphics job'}{job.job_number ? ` · #${job.job_number}` : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px 8px' }}>✕</button>
        </div>

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Customer */}
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Customer {selectedCustomer ? '· selected' : '· required'}
            </div>
            {selectedCustomer ? (
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 10px', borderRadius: '8px',
                background: 'var(--input-bg)', border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                  <span style={{ fontWeight: 700 }}>{selectedCustomer.company_name || selectedCustomer.entity_id}</span>
                  {selectedCustomer.entity_id && <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>{selectedCustomer.entity_id}</span>}
                </div>
                <button
                  onClick={() => { setSelectedCustomer(null); setCustSearch(''); }}
                  style={{ background: 'transparent', border: 'none', color: 'var(--accent, #2563eb)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                >Change</button>
              </div>
            ) : (
              <div>
                <input
                  type="text"
                  value={custSearch}
                  onChange={e => setCustSearch(e.target.value)}
                  placeholder="Search customer by name or entity id…"
                  style={{
                    width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)',
                    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px', boxSizing: 'border-box',
                  }}
                />
                {custSearching && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>Searching…</div>}
                {custResults.length > 0 && (
                  <div style={{
                    marginTop: '6px', maxHeight: '180px', overflowY: 'auto', borderRadius: '8px',
                    border: '1px solid var(--border)', background: 'var(--card)',
                  }}>
                    {custResults.map(c => (
                      <button
                        key={c.id}
                        onClick={() => { setSelectedCustomer(c); setCustResults([]); }}
                        disabled={!c.netsuite_id}
                        title={!c.netsuite_id ? 'No NetSuite id on this customer record' : undefined}
                        style={{
                          width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
                          background: 'transparent', color: 'var(--text-primary)', fontSize: '12px',
                          cursor: c.netsuite_id ? 'pointer' : 'not-allowed',
                          opacity: c.netsuite_id ? 1 : 0.4,
                          borderTop: '1px solid var(--border)',
                        }}
                      >
                        <div style={{ fontWeight: 700 }}>{c.company_name || c.entity_id}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {c.entity_id} {c.netsuite_id ? `· NS ${c.netsuite_id}` : '· no NetSuite id'}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Line items */}
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Line items
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {lines.map(line => (
                <div key={line.key} style={{
                  padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
                }}>
                  {/* Item picker / chosen */}
                  {activePartRow === line.key ? (
                    <div>
                      <input
                        type="text"
                        autoFocus
                        value={partSearch}
                        onChange={e => setPartSearch(e.target.value)}
                        placeholder="Search NetSuite items by part number or name…"
                        style={{
                          width: '100%', padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--border)',
                          background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
                        }}
                      />
                      {partSearching && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>Searching…</div>}
                      {partResults.length > 0 && (
                        <div style={{
                          marginTop: '6px', maxHeight: '180px', overflowY: 'auto', borderRadius: '6px',
                          border: '1px solid var(--border)', background: 'var(--card)',
                        }}>
                          {partResults.map(p => (
                            <button
                              key={p.id}
                              onClick={() => pickPart(line.key, p)}
                              disabled={!p.netsuite_id}
                              style={{
                                width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none',
                                background: 'transparent', color: 'var(--text-primary)', fontSize: '12px',
                                cursor: p.netsuite_id ? 'pointer' : 'not-allowed',
                                opacity: p.netsuite_id ? 1 : 0.4,
                                borderTop: '1px solid var(--border)',
                              }}
                            >
                              <div style={{ fontWeight: 700 }}>{p.item_number}</div>
                              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                {p.display_name || p.description}
                                {p.sales_price != null && ` · $${p.sales_price.toFixed(2)}`}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        onClick={() => { setActivePartRow(null); setPartSearch(''); setPartResults([]); }}
                        style={{
                          marginTop: '6px', padding: '4px 10px', borderRadius: '6px',
                          border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)',
                          fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                        }}
                      >Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                      <div style={{ flex: 1 }}>
                        {line.netsuite_item_id ? (
                          <>
                            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{line.item_number}</div>
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>NS {line.netsuite_item_id}</div>
                          </>
                        ) : (
                          <button
                            onClick={() => { setActivePartRow(line.key); setPartSearch(line.item_number || ''); }}
                            style={{
                              padding: '6px 10px', borderRadius: '6px',
                              border: '1px dashed var(--border)', background: 'transparent', color: 'var(--accent, #2563eb)',
                              fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                            }}
                          >Pick NetSuite item…</button>
                        )}
                      </div>
                      {line.netsuite_item_id && (
                        <button
                          onClick={() => { setActivePartRow(line.key); setPartSearch(line.item_number || ''); }}
                          style={{ background: 'transparent', border: 'none', color: 'var(--accent, #2563eb)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                        >Change</button>
                      )}
                    </div>
                  )}

                  {/* Description */}
                  <input
                    type="text"
                    value={line.description}
                    onChange={e => updateLine(line.key, { description: e.target.value })}
                    placeholder="Description (optional)"
                    style={{
                      width: '100%', marginTop: '8px', padding: '6px 8px', borderRadius: '6px',
                      border: '1px solid var(--border)', background: 'var(--input-bg)',
                      color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
                    }}
                  />

                  {/* Qty / rate / line total / remove */}
                  <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'flex-end' }}>
                    <div style={{ flex: '0 0 80px' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>Qty</div>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={line.quantity}
                        onChange={e => updateLine(line.key, { quantity: Math.max(0, parseFloat(e.target.value) || 0) })}
                        style={{
                          width: '100%', padding: '6px 8px', borderRadius: '6px',
                          border: '1px solid var(--border)', background: 'var(--input-bg)',
                          color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <div style={{ flex: '0 0 110px' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>Rate</div>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={line.rate}
                        onChange={e => updateLine(line.key, { rate: Math.max(0, parseFloat(e.target.value) || 0) })}
                        style={{
                          width: '100%', padding: '6px 8px', borderRadius: '6px',
                          border: '1px solid var(--border)', background: 'var(--input-bg)',
                          color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <div style={{ flex: 1, fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'right' }}>
                      ${(line.quantity * line.rate).toFixed(2)}
                    </div>
                    {lines.length > 1 && (
                      <button
                        onClick={() => removeLine(line.key)}
                        style={{
                          padding: '6px 10px', borderRadius: '6px',
                          border: '1px solid var(--border)', background: 'transparent', color: 'var(--danger, #ef4444)',
                          fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                        }}
                      >Remove</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={addLine}
              style={{
                marginTop: '8px', padding: '8px 12px', borderRadius: '8px',
                border: '1px dashed var(--border)', background: 'transparent', color: 'var(--accent, #2563eb)',
                fontSize: '12px', fontWeight: 700, cursor: 'pointer',
              }}
            >+ Add line</button>
          </div>

          {/* Memo */}
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Memo
            </div>
            <textarea
              value={memo}
              onChange={e => setMemo(e.target.value)}
              rows={2}
              placeholder="Internal memo for the NetSuite invoice"
              style={{
                width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)',
                background: 'var(--input-bg)', color: 'var(--text-primary)',
                fontSize: '13px', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Total + error */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Total</div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>${total.toFixed(2)}</div>
          </div>

          {error && (
            <div style={{
              padding: '10px 12px', borderRadius: '8px',
              background: 'color-mix(in srgb, var(--danger, #ef4444) 8%, var(--card))',
              border: '1px solid var(--danger, #ef4444)',
              fontSize: '12px', color: 'var(--danger, #ef4444)',
            }}>{error}</div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '10px 14px', borderRadius: '10px', border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text-primary)',
              fontSize: '13px', fontWeight: 700, cursor: 'pointer',
            }}
          >Cancel</button>
          <button
            onClick={submit}
            disabled={!ready || submitting}
            style={{
              padding: '10px 18px', borderRadius: '10px', border: 'none',
              background: ready ? '#22c55e' : 'var(--border)', color: '#fff',
              fontSize: '14px', fontWeight: 800,
              cursor: ready && !submitting ? 'pointer' : 'not-allowed',
              opacity: ready && !submitting ? 1 : 0.5,
            }}
          >{submitting ? 'Creating…' : 'Create Invoice'}</button>
        </div>
      </div>
    </div>
  );
}
