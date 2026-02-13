'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import type { PurchaseOrder, POLineItem, CatalogItem } from '@/lib/types';

export default function POsPage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();

  const [pos, setPos] = useState<(PurchaseOrder & { line_items: POLineItem[] })[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedPo, setExpandedPo] = useState<string | null>(null);
  const [form, setForm] = useState({ po_number: '', customer: 'Masterack' });
  const [lineItems, setLineItems] = useState<{ catalog_id: string; part_number: string; quantity: number; unit_price: number }[]>([]);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    const load = async () => {
      const { data: poData } = await supabase
        .from('purchase_orders')
        .select('*, po_line_items(*)')
        .order('created_at', { ascending: false });

      const mapped = (poData || []).map((po: any) => ({
        ...po,
        line_items: po.po_line_items || [],
      }));
      setPos(mapped);

      const { data: catData } = await supabase.from('catalog').select('*').eq('active', true).order('part_number');
      setCatalog(catData || []);
      setLoading(false);
    };
    load();
  }, [isAdmin]);

  const addLineItem = (catId: string) => {
    const item = catalog.find((c) => c.id === catId);
    if (!item) return;
    setLineItems((prev) => [...prev, { catalog_id: item.id, part_number: item.part_number, quantity: 1, unit_price: item.price }]);
  };

  const handleCreate = async () => {
    if (!form.po_number || !form.customer || lineItems.length === 0 || !user) return;

    const { data: po, error } = await supabase
      .from('purchase_orders')
      .insert({ po_number: form.po_number, customer: form.customer, created_by: user.id })
      .select()
      .single();

    if (!po || error) { alert('Error: ' + error?.message); return; }

    const { data: items } = await supabase
      .from('po_line_items')
      .insert(lineItems.map((li) => ({ po_id: po.id, ...li })))
      .select();

    setPos((prev) => [{ ...po, line_items: items || [] }, ...prev]);
    setForm({ po_number: '', customer: 'Masterack' });
    setLineItems([]);
    setShowCreate(false);
  };

  const toggleExpand = (poId: string) => {
    setExpandedPo(expandedPo === poId ? null : poId);
  };

  const fmt = (n: number) => {
    return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Purchase Orders ({pos.length})
        </div>
        <button onClick={() => setShowCreate(!showCreate)} style={{ padding: '6px 12px', borderRadius: '8px', background: '#3b82f6', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}>
          {showCreate ? 'Cancel' : '+ New PO'}
        </button>
      </div>

      {showCreate && (
        <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ marginBottom: '8px' }}>
            <label style={labelStyle}>PO Number</label>
            <input value={form.po_number} onChange={(e) => setForm({ ...form, po_number: e.target.value })} style={inputStyle} />
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={labelStyle}>Customer</label>
            <select value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} style={inputStyle}>
              <option>Masterack</option><option>Knapheide</option><option>Bodewell</option><option>Designs That Stick</option>
            </select>
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={labelStyle}>Add Part Number</label>
            <select onChange={(e) => { if (e.target.value) addLineItem(e.target.value); e.target.value = ''; }} style={inputStyle}>
              <option value="">Select part number...</option>
              {catalog.filter((c) => c.customer === form.customer).map((c) => (
                <option key={c.id} value={c.id}>{c.part_number} — {c.end_customer} (${c.price})</option>
              ))}
            </select>
          </div>

          {lineItems.length > 0 && (
            <div style={{ marginBottom: '8px' }}>
              {lineItems.map((li, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid #1e2d3d' }}>
                  <div style={{ flex: 1, fontSize: '13px', fontWeight: 700 }}>{li.part_number}</div>
                  <div style={{ fontSize: '12px', color: '#4a5f78' }}>{fmt(li.unit_price)}</div>
                  <input
                    type="number"
                    value={li.quantity}
                    onChange={(e) => {
                      const q = parseInt(e.target.value) || 1;
                      setLineItems((prev) => prev.map((item, j) => j === i ? { ...item, quantity: q } : item));
                    }}
                    style={{ ...inputStyle, width: '60px', textAlign: 'center' }}
                    min={1}
                  />
                  <button onClick={() => setLineItems((prev) => prev.filter((_, j) => j !== i))} style={{ color: '#f87171', fontSize: '18px', padding: '0 4px', background: 'none', border: 'none' }}>×</button>
                </div>
              ))}
              <div style={{ textAlign: 'right', marginTop: '6px', fontSize: '13px', fontWeight: 700, color: '#60a5fa' }}>
                Total: {fmt(lineItems.reduce((s, l) => s + l.quantity * l.unit_price, 0))}
              </div>
            </div>
          )}

          <button
            onClick={handleCreate}
            disabled={!form.po_number || lineItems.length === 0}
            style={{
              width: '100%', padding: '12px', borderRadius: '10px', background: '#22c55e',
              color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
              opacity: form.po_number && lineItems.length > 0 ? 1 : 0.4,
            }}
          >
            Create PO
          </button>
        </div>
      )}

      {pos.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: '#4a5f78' }}>
          <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>📋</div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No purchase orders yet</div>
        </div>
      )}

      {pos.map((po) => {
        const totalQty = po.line_items.reduce((s, l) => s + l.quantity, 0);
        const totalInstalled = po.line_items.reduce((s, l) => s + l.installed, 0);
        const totalValue = po.line_items.reduce((s, l) => s + l.quantity * l.unit_price, 0);
        const pct = totalQty > 0 ? (totalInstalled / totalQty) * 100 : 0;
        const isExpanded = expandedPo === po.id;
        const createdDate = new Date(po.created_at);

        return (
          <div key={po.id} style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', marginBottom: '6px', overflow: 'hidden' }}>
            <div
              onClick={() => toggleExpand(po.id)}
              style={{ padding: '12px', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: '15px' }}>PO #{po.po_number}</div>
                  <div style={{ fontSize: '12px', color: '#4a5f78', marginTop: '1px' }}>
                    {po.customer} • {po.line_items.length} item{po.line_items.length !== 1 ? 's' : ''}
                    {po.status === 'complete' && <span style={{ color: '#4ade80', marginLeft: '6px' }}>✓ Complete</span>}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '14px', fontWeight: 800, color: '#60a5fa' }}>{fmt(totalValue)}</div>
                  <div style={{ fontSize: '10px', color: '#4a5f78', marginTop: '1px' }}>{isExpanded ? '▲' : '▼'} Details</div>
                </div>
              </div>
              <div style={{ marginTop: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '3px' }}>
                  <span style={{ color: '#4a5f78' }}>Progress</span>
                  <span style={{ color: pct >= 100 ? '#4ade80' : '#60a5fa', fontWeight: 700 }}>{totalInstalled}/{totalQty}</span>
                </div>
                <div style={{ height: '6px', background: '#1e2d3d', borderRadius: '3px' }}>
                  <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: pct >= 100 ? '#22c55e' : '#3b82f6', borderRadius: '3px', transition: 'width 0.3s' }} />
                </div>
              </div>
            </div>

            {isExpanded && (
              <div style={{ borderTop: '1px solid #1e2d3d', padding: '10px 12px' }}>
                <div style={{ fontSize: '10px', color: '#4a5f78', marginBottom: '2px' }}>
                  Created {createdDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>

                {/* Column headers */}
                <div style={{ display: 'flex', gap: '4px', padding: '8px 0 4px', borderBottom: '1px solid #1e2d3d', fontSize: '10px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
                  <div style={{ flex: 1 }}>Part #</div>
                  <div style={{ width: '36px', textAlign: 'center' }}>Qty</div>
                  <div style={{ width: '42px', textAlign: 'center' }}>Done</div>
                  <div style={{ width: '65px', textAlign: 'right' }}>Price</div>
                  <div style={{ width: '75px', textAlign: 'right' }}>Line Total</div>
                </div>

                {/* Line items */}
                {po.line_items.map((li) => {
                  const lineTotal = li.quantity * li.unit_price;
                  const linePct = li.quantity > 0 ? (li.installed / li.quantity) * 100 : 0;
                  return (
                    <div key={li.id} style={{ display: 'flex', gap: '4px', padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)', alignItems: 'center', fontSize: '12px' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, color: '#e8ecf1' }}>{li.part_number}</div>
                        <div style={{ height: '3px', background: '#1e2d3d', borderRadius: '2px', marginTop: '3px', width: '80%' }}>
                          <div style={{ height: '100%', width: `${Math.min(linePct, 100)}%`, background: linePct >= 100 ? '#22c55e' : '#3b82f6', borderRadius: '2px' }} />
                        </div>
                      </div>
                      <div style={{ width: '36px', textAlign: 'center', color: '#6b7a8d', fontWeight: 600 }}>{li.quantity}</div>
                      <div style={{ width: '42px', textAlign: 'center', fontWeight: 700, color: li.installed >= li.quantity ? '#4ade80' : '#fbbf24' }}>{li.installed}</div>
                      <div style={{ width: '65px', textAlign: 'right', color: '#6b7a8d', fontSize: '11px' }}>{fmt(li.unit_price)}</div>
                      <div style={{ width: '75px', textAlign: 'right', fontWeight: 700, color: '#e8ecf1' }}>{fmt(lineTotal)}</div>
                    </div>
                  );
                })}

                {/* Totals */}
                <div style={{ display: 'flex', gap: '4px', padding: '10px 0 4px', fontSize: '13px' }}>
                  <div style={{ flex: 1, fontWeight: 800, color: '#e8ecf1' }}>Total</div>
                  <div style={{ width: '36px', textAlign: 'center', fontWeight: 700, color: '#6b7a8d' }}>{totalQty}</div>
                  <div style={{ width: '42px', textAlign: 'center', fontWeight: 700, color: totalInstalled >= totalQty ? '#4ade80' : '#60a5fa' }}>{totalInstalled}</div>
                  <div style={{ width: '65px' }}></div>
                  <div style={{ width: '75px', textAlign: 'right', fontWeight: 800, color: '#60a5fa' }}>{fmt(totalValue)}</div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '10px', marginTop: '14px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>
        ← Back
      </button>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '10px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #1e2d3d', background: '#0f1720', color: '#e8ecf1', fontSize: '13px' };
