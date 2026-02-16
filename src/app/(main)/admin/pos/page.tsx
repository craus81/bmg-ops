'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import SwipeToDelete from '@/components/SwipeToDelete';
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
  const [editPoId, setEditPoId] = useState<string | null>(null);
  const [editPoForm, setEditPoForm] = useState({ po_number: '', customer: '', status: '' as string });
  const [editLineId, setEditLineId] = useState<string | null>(null);
  const [editLineForm, setEditLineForm] = useState({ quantity: '', unit_price: '' });
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
      setCatalog((catData as CatalogItem[]) || []);
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

    setPos((prev) => [{ ...po, line_items: (items as POLineItem[]) || [] }, ...prev]);
    setForm({ po_number: '', customer: 'Masterack' });
    setLineItems([]);
    setShowCreate(false);
  };

  const handleDeletePO = async (poId: string) => {
    // Delete line items first, then PO
    await supabase.from('po_line_items').delete().eq('po_id', poId);
    const { error } = await supabase.from('purchase_orders').delete().eq('id', poId);
    if (!error) {
      setPos((prev) => prev.filter((p) => p.id !== poId));
    }
  };

  const handleDeleteLineItem = async (lineId: string, poId: string) => {
    const { error } = await supabase.from('po_line_items').delete().eq('id', lineId);
    if (!error) {
      setPos((prev) =>
        prev.map((po) =>
          po.id === poId
            ? { ...po, line_items: po.line_items.filter((li) => li.id !== lineId) }
            : po
        )
      );
    }
  };

  // PO header edit
  const startEditPO = (po: PurchaseOrder & { line_items: POLineItem[] }) => {
    setEditPoId(po.id);
    setEditPoForm({ po_number: po.po_number, customer: po.customer, status: po.status });
  };

  const saveEditPO = async () => {
    if (!editPoId) return;
    const { error } = await supabase
      .from('purchase_orders')
      .update({ po_number: editPoForm.po_number, customer: editPoForm.customer, status: editPoForm.status })
      .eq('id', editPoId);

    if (!error) {
      setPos((prev) =>
        prev.map((po) =>
          po.id === editPoId
            ? { ...po, po_number: editPoForm.po_number, customer: editPoForm.customer, status: editPoForm.status as any }
            : po
        )
      );
      setEditPoId(null);
    }
  };

  // Line item edit
  const startEditLine = (li: POLineItem) => {
    setEditLineId(li.id);
    setEditLineForm({ quantity: li.quantity.toString(), unit_price: li.unit_price.toString() });
  };

  const saveEditLine = async (poId: string) => {
    if (!editLineId) return;
    const qty = parseInt(editLineForm.quantity) || 1;
    const price = parseFloat(editLineForm.unit_price) || 0;
    const { error } = await supabase
      .from('po_line_items')
      .update({ quantity: qty, unit_price: price })
      .eq('id', editLineId);

    if (!error) {
      setPos((prev) =>
        prev.map((po) =>
          po.id === poId
            ? { ...po, line_items: po.line_items.map((li) => li.id === editLineId ? { ...li, quantity: qty, unit_price: price } : li) }
            : po
        )
      );
      setEditLineId(null);
    }
  };

  const toggleExpand = (poId: string) => {
    setExpandedPo(expandedPo === poId ? null : poId);
    setEditPoId(null);
    setEditLineId(null);
  };

  const fmt = (n: number) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Purchase Orders ({pos.length})
        </div>
        <button onClick={() => setShowCreate(!showCreate)} style={{ padding: '6px 12px', borderRadius: '10px', background: 'var(--navy)', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}>
          {showCreate ? 'Cancel' : '+ New PO'}
        </button>
      </div>

      {showCreate && (
        <div style={{ background: 'var(--card)', border: '1px solid #1e2d3d', borderRadius: '14px', padding: '14px', marginBottom: '12px' }}>
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
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{fmt(li.unit_price)}</div>
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
                  <button onClick={() => setLineItems((prev) => prev.filter((_, j) => j !== i))} style={{ color: 'var(--error)', fontSize: '18px', padding: '0 4px', background: 'none', border: 'none' }}>×</button>
                </div>
              ))}
              <div style={{ textAlign: 'right', marginTop: '6px', fontSize: '13px', fontWeight: 700, color: 'var(--navy)' }}>
                Total: {fmt(lineItems.reduce((s, l) => s + l.quantity * l.unit_price, 0))}
              </div>
            </div>
          )}

          <button
            onClick={handleCreate}
            disabled={!form.po_number || lineItems.length === 0}
            style={{
              width: '100%', padding: '12px', borderRadius: '14px', background: 'var(--success)',
              color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
              opacity: form.po_number && lineItems.length > 0 ? 1 : 0.4,
            }}
          >
            Create PO
          </button>
        </div>
      )}

      {pos.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
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
        const isEditingPO = editPoId === po.id;
        const createdDate = new Date(po.created_at);

        return (
          <SwipeToDelete
            key={po.id}
            onDelete={() => handleDeletePO(po.id)}
            confirmMessage={`Delete PO #${po.po_number} and all its line items? This cannot be undone.`}
          >
            <div style={{ background: 'var(--card)', border: '1px solid #1e2d3d', borderRadius: '14px', marginBottom: '6px', overflow: 'hidden' }}>
              <div
                onClick={() => toggleExpand(po.id)}
                style={{ padding: '12px', cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '15px' }}>PO #{po.po_number}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '1px' }}>
                      {po.customer} • {po.line_items.length} item{po.line_items.length !== 1 ? 's' : ''}
                      {po.status === 'complete' && <span style={{ color: 'var(--success)', marginLeft: '6px' }}>✓ Complete</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--navy)' }}>{fmt(totalValue)}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>{isExpanded ? '▲' : '▼'} Details</div>
                  </div>
                </div>
                <div style={{ marginTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '3px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Progress</span>
                    <span style={{ color: pct >= 100 ? 'var(--success)' : 'var(--navy)', fontWeight: 700 }}>{totalInstalled}/{totalQty}</span>
                  </div>
                  <div style={{ height: '6px', background: 'var(--border)', borderRadius: '3px' }}>
                    <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: pct >= 100 ? 'var(--success)' : 'var(--navy)', borderRadius: '3px', transition: 'width 0.3s' }} />
                  </div>
                </div>
              </div>

              {isExpanded && (
                <div style={{ borderTop: '1px solid #1e2d3d', padding: '10px 12px' }}>
                  {/* PO Header Edit */}
                  {isEditingPO ? (
                    <div style={{ marginBottom: '10px', padding: '8px', background: 'rgba(238,49,32,0.04)', borderRadius: '10px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                        <div>
                          <label style={labelStyle}>PO Number</label>
                          <input value={editPoForm.po_number} onChange={(e) => setEditPoForm({ ...editPoForm, po_number: e.target.value })} style={inputStyle} />
                        </div>
                        <div>
                          <label style={labelStyle}>Customer</label>
                          <select value={editPoForm.customer} onChange={(e) => setEditPoForm({ ...editPoForm, customer: e.target.value })} style={inputStyle}>
                            <option>Masterack</option><option>Knapheide</option><option>Bodewell</option><option>Designs That Stick</option>
                          </select>
                        </div>
                      </div>
                      <div style={{ marginTop: '6px' }}>
                        <label style={labelStyle}>Status</label>
                        <select value={editPoForm.status} onChange={(e) => setEditPoForm({ ...editPoForm, status: e.target.value })} style={inputStyle}>
                          <option value="open">Open</option><option value="complete">Complete</option><option value="cancelled">Cancelled</option>
                        </select>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                        <button onClick={saveEditPO} style={{ flex: 1, padding: '8px', borderRadius: '10px', background: 'var(--success)', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}>Save</button>
                        <button onClick={() => setEditPoId(null)} style={{ flex: 1, padding: '8px', borderRadius: '10px', background: 'transparent', border: '1px solid #1e2d3d', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700 }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        Created {createdDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); startEditPO(po); }}
                        style={{ padding: '3px 8px', borderRadius: '6px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(238,49,32,0.15)', color: 'var(--navy)', fontSize: '10px', fontWeight: 700 }}
                      >
                        ✏️ Edit PO
                      </button>
                    </div>
                  )}

                  {/* Column headers */}
                  <div style={{ display: 'flex', gap: '4px', padding: '8px 0 4px', borderBottom: '1px solid #1e2d3d', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
                    <div style={{ flex: 1 }}>Part #</div>
                    <div style={{ width: '36px', textAlign: 'center' }}>Qty</div>
                    <div style={{ width: '42px', textAlign: 'center' }}>Done</div>
                    <div style={{ width: '65px', textAlign: 'right' }}>Price</div>
                    <div style={{ width: '55px', textAlign: 'right' }}>Total</div>
                    <div style={{ width: '24px' }}></div>
                  </div>

                  {/* Line items */}
                  {po.line_items.map((li) => {
                    const lineTotal = li.quantity * li.unit_price;
                    const linePct = li.quantity > 0 ? (li.installed / li.quantity) * 100 : 0;
                    const isEditingLine = editLineId === li.id;

                    if (isEditingLine) {
                      return (
                        <div key={li.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)' }}>
                          <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '4px' }}>{li.part_number}</div>
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'end' }}>
                            <div style={{ flex: 1 }}>
                              <label style={{ ...labelStyle, fontSize: '9px' }}>Qty</label>
                              <input type="number" value={editLineForm.quantity} onChange={(e) => setEditLineForm({ ...editLineForm, quantity: e.target.value })} style={{ ...inputStyle, padding: '6px 8px', fontSize: '12px' }} />
                            </div>
                            <div style={{ flex: 1 }}>
                              <label style={{ ...labelStyle, fontSize: '9px' }}>Unit Price</label>
                              <input type="number" value={editLineForm.unit_price} onChange={(e) => setEditLineForm({ ...editLineForm, unit_price: e.target.value })} style={{ ...inputStyle, padding: '6px 8px', fontSize: '12px' }} step="0.01" />
                            </div>
                            <button onClick={() => saveEditLine(po.id)} style={{ padding: '6px 10px', borderRadius: '6px', background: 'var(--success)', color: '#fff', fontSize: '11px', fontWeight: 700, border: 'none' }}>✓</button>
                            <button onClick={() => setEditLineId(null)} style={{ padding: '6px 10px', borderRadius: '6px', background: 'transparent', border: '1px solid #1e2d3d', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 700 }}>✕</button>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={li.id} style={{ display: 'flex', gap: '4px', padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)', alignItems: 'center', fontSize: '12px' }}>
                        <div style={{ flex: 1 }} onClick={() => startEditLine(li)}>
                          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{li.part_number}</div>
                          <div style={{ height: '3px', background: 'var(--border)', borderRadius: '2px', marginTop: '3px', width: '80%' }}>
                            <div style={{ height: '100%', width: `${Math.min(linePct, 100)}%`, background: linePct >= 100 ? 'var(--success)' : 'var(--navy)', borderRadius: '2px' }} />
                          </div>
                        </div>
                        <div style={{ width: '36px', textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 600 }} onClick={() => startEditLine(li)}>{li.quantity}</div>
                        <div style={{ width: '42px', textAlign: 'center', fontWeight: 700, color: li.installed >= li.quantity ? 'var(--success)' : 'var(--warning)' }}>{li.installed}</div>
                        <div style={{ width: '65px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '11px' }} onClick={() => startEditLine(li)}>{fmt(li.unit_price)}</div>
                        <div style={{ width: '55px', textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)' }}>{fmt(lineTotal)}</div>
                        <button
                          onClick={() => {
                            if (window.confirm(`Remove ${li.part_number} from this PO?`)) {
                              handleDeleteLineItem(li.id, po.id);
                            }
                          }}
                          style={{ width: '24px', background: 'none', border: 'none', color: 'var(--error)', fontSize: '14px', padding: 0, cursor: 'pointer' }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}

                  {/* Totals */}
                  <div style={{ display: 'flex', gap: '4px', padding: '10px 0 4px', fontSize: '13px' }}>
                    <div style={{ flex: 1, fontWeight: 800, color: 'var(--text-primary)' }}>Total</div>
                    <div style={{ width: '36px', textAlign: 'center', fontWeight: 700, color: 'var(--text-secondary)' }}>{totalQty}</div>
                    <div style={{ width: '42px', textAlign: 'center', fontWeight: 700, color: totalInstalled >= totalQty ? 'var(--success)' : 'var(--navy)' }}>{totalInstalled}</div>
                    <div style={{ width: '65px' }}></div>
                    <div style={{ width: '55px', textAlign: 'right', fontWeight: 800, color: 'var(--navy)' }}>{fmt(totalValue)}</div>
                    <div style={{ width: '24px' }}></div>
                  </div>
                </div>
              )}
            </div>
          </SwipeToDelete>
        );
      })}

      <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px', border: '1px solid #1e2d3d', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>
        ← Back
      </button>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid #1e2d3d', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px' };
