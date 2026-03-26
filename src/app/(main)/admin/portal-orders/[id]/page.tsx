'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import type { PortalOrder, PortalOrderStatus } from '@/lib/types';

const STATUS_FLOW: PortalOrderStatus[] = ['pending', 'confirmed', 'in_production', 'shipped', 'completed'];

const STATUS_LABELS: Record<PortalOrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  in_production: 'In Production',
  shipped: 'Shipped',
  completed: 'Completed',
};

const STATUS_COLORS: Record<PortalOrderStatus, string> = {
  pending: '#f59e0b',
  confirmed: '#3b82f6',
  in_production: '#8b5cf6',
  shipped: '#10b981',
  completed: '#6b7280',
};

interface OrderLine {
  id: string;
  proof_part_id: string;
  quantity: number;
  unit_price: number;
  proof_part?: {
    id: string;
    part_name: string;
    part_number: string | null;
    description: string | null;
    proof?: { id: string; customer_name: string; vehicle_type: string };
  };
}

interface FullOrder extends Omit<PortalOrder, 'lines' | 'portal_customer'> {
  portal_customer: { id: string; company_name: string; slug: string; logo_url: string | null; primary_color: string | null };
  lines: OrderLine[];
}

export default function AdminPortalOrderDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const { isAdmin, isSales, isGraphicsProduction } = useAuth();

  const [order, setOrder] = useState<FullOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<{ success?: boolean; message?: string; error?: string } | null>(null);
  const [error, setError] = useState('');

  // Editable state
  const [editLines, setEditLines] = useState<OrderLine[]>([]);
  const [shipTo, setShipTo] = useState({ street: '', city: '', state: '', zip: '' });
  const [notes, setNotes] = useState('');
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (!isAdmin && !isSales && !isGraphicsProduction) { router.push('/home'); return; }
    loadOrder();
  }, [id]);

  const loadOrder = async () => {
    setLoading(true);
    const res = await fetch(`/api/admin/portal-orders/${id}`);
    if (!res.ok) { router.push('/admin/portal-orders'); return; }
    const data: FullOrder = await res.json();
    setOrder(data);
    setEditLines(data.lines.map((l) => ({ ...l })));
    setShipTo(data.ship_to_address || { street: '', city: '', state: '', zip: '' });
    setNotes(data.notes || '');
    setIsDirty(false);
    setLoading(false);
  };

  const handleStatusChange = async (newStatus: PortalOrderStatus) => {
    if (!order) return;
    setSaving(true);
    setError('');
    const res = await fetch(`/api/admin/portal-orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (res.ok) {
      setOrder((prev) => prev ? { ...prev, status: newStatus } : null);
    } else {
      const data = await res.json();
      setError(data.error || 'Failed to update status');
    }
    setSaving(false);
  };

  const handleSaveChanges = async () => {
    if (!order) return;
    setSaving(true);
    setError('');
    const res = await fetch(`/api/admin/portal-orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes,
        ship_to_address: shipTo,
        lines: editLines
          .filter((l) => l.quantity > 0)
          .map((l) => ({
            proof_part_id: l.proof_part_id,
            quantity: l.quantity,
            unit_price: l.unit_price,
          })),
      }),
    });
    if (res.ok) {
      setIsDirty(false);
      await loadOrder();
    } else {
      const data = await res.json();
      setError(data.error || 'Failed to save changes');
    }
    setSaving(false);
  };

  const handlePushToNetsuite = async () => {
    if (!order) return;
    setPushing(true);
    setPushResult(null);
    setError('');
    const res = await fetch(`/api/admin/portal-orders/${id}/push-to-netsuite`, {
      method: 'POST',
    });
    const data = await res.json();
    if (res.ok) {
      setPushResult({
        success: true,
        message: data.status === 'already_created'
          ? data.message
          : `Sales Order #${data.salesOrderNumber || data.salesOrderId} created in NetSuite`,
      });
      await loadOrder();
    } else {
      setPushResult({ success: false, error: data.error });
    }
    setPushing(false);
  };

  const updateLineQty = (lineId: string, qty: number) => {
    setEditLines((prev) => prev.map((l) => l.id === lineId ? { ...l, quantity: Math.max(0, qty) } : l));
    setIsDirty(true);
  };

  const removeLine = (lineId: string) => {
    setEditLines((prev) => prev.map((l) => l.id === lineId ? { ...l, quantity: 0 } : l));
    setIsDirty(true);
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '80px', color: 'var(--text-muted)' }}>Loading order…</div>
    );
  }
  if (!order) return null;

  const total = editLines.reduce((s, l) => s + l.quantity * Number(l.unit_price), 0);
  const status = order.status as PortalOrderStatus;
  const currentIdx = STATUS_FLOW.indexOf(status);
  const canEdit = status !== 'completed';
  const canPush = !order.netsuite_so_id && canEdit;

  return (
    <div>
      {/* Back + header */}
      <button
        onClick={() => router.push('/admin/portal-orders')}
        style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '13px', cursor: 'pointer', padding: 0, marginBottom: '16px' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6" /></svg>
        Portal Orders
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 4px' }}>
            {order.portal_customer?.company_name} — PO #{order.po_number || '—'}
          </h1>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {new Date(order.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </div>
        </div>

        {/* Push to NetSuite */}
        {order.netsuite_so_id ? (
          <div style={{ padding: '10px 16px', borderRadius: '10px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', fontSize: '13px', fontWeight: 700, color: '#34d399' }}>
            ✓ NS SO #{order.netsuite_so_number || order.netsuite_so_id}
          </div>
        ) : (
          <button
            onClick={handlePushToNetsuite}
            disabled={pushing || !canPush}
            style={{
              padding: '10px 20px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
              background: pushing ? 'var(--card)' : 'var(--orange)', color: pushing ? 'var(--text-muted)' : '#fff',
              border: '1px solid ' + (pushing ? 'var(--border)' : 'var(--orange)'),
              cursor: pushing || !canPush ? 'not-allowed' : 'pointer',
              opacity: !canPush ? 0.5 : 1,
            }}
          >
            {pushing ? 'Pushing…' : 'Push to NetSuite'}
          </button>
        )}
      </div>

      {/* Push result banner */}
      {pushResult && (
        <div style={{
          padding: '12px 16px', borderRadius: '10px', marginBottom: '16px', fontSize: '14px',
          background: pushResult.success ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          border: '1px solid ' + (pushResult.success ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'),
          color: pushResult.success ? '#34d399' : '#f87171',
        }}>
          {pushResult.message || pushResult.error}
        </div>
      )}

      {error && (
        <div style={{ padding: '12px 16px', borderRadius: '10px', marginBottom: '16px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', fontSize: '14px' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '16px', alignItems: 'start' }}>
        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Status flow */}
          <Card title="Status">
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {STATUS_FLOW.map((s, i) => (
                <button
                  key={s}
                  onClick={() => s !== status && handleStatusChange(s)}
                  disabled={saving}
                  style={{
                    padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                    border: '1px solid ' + (s === status ? STATUS_COLORS[s] : 'var(--border)'),
                    background: s === status ? STATUS_COLORS[s] + '22' : 'var(--subtle-bg)',
                    color: s === status ? STATUS_COLORS[s] : 'var(--text-muted)',
                    cursor: s === status || saving ? 'default' : 'pointer',
                    opacity: saving ? 0.6 : 1,
                    transition: 'all 0.15s',
                    position: 'relative',
                  }}
                >
                  {i < currentIdx && '✓ '}{STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </Card>

          {/* Line items */}
          <Card title="Line Items">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {editLines.filter((l) => l.quantity > 0 || true).map((line) => (
                <div
                  key={line.id}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr auto auto auto',
                    gap: '12px', alignItems: 'center',
                    padding: '12px 14px', borderRadius: '10px',
                    background: line.quantity === 0 ? 'rgba(239,68,68,0.05)' : 'var(--subtle-bg)',
                    border: '1px solid ' + (line.quantity === 0 ? 'rgba(239,68,68,0.15)' : 'var(--border)'),
                    opacity: line.quantity === 0 ? 0.5 : 1,
                  }}
                >
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {line.proof_part?.part_name || 'Unknown Part'}
                      {line.proof_part?.part_number && (
                        <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px', fontSize: '12px' }}>#{line.proof_part.part_number}</span>
                      )}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      ${Number(line.unit_price).toFixed(2)} each
                      {line.proof_part?.proof?.customer_name && ` · ${line.proof_part.proof.customer_name}`}
                    </div>
                  </div>

                  {canEdit ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <button
                          type="button"
                          onClick={() => updateLineQty(line.id, line.quantity - 1)}
                          style={{ width: '28px', height: '28px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >−</button>
                        <input
                          type="number"
                          value={line.quantity}
                          min={0}
                          onChange={(e) => updateLineQty(line.id, parseInt(e.target.value) || 0)}
                          style={{ width: '48px', textAlign: 'center', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '14px', fontWeight: 700 }}
                        />
                        <button
                          type="button"
                          onClick={() => updateLineQty(line.id, line.quantity + 1)}
                          style={{ width: '28px', height: '28px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >+</button>
                      </div>
                      <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--orange)', textAlign: 'right', minWidth: '60px' }}>
                        ${(line.quantity * Number(line.unit_price)).toFixed(2)}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        style={{ width: '28px', height: '28px', borderRadius: '6px', border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.05)', color: '#f87171', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        title="Remove line"
                      >✕</button>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: '14px', color: 'var(--text-muted)', textAlign: 'center' }}>×{line.quantity}</div>
                      <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--orange)', textAlign: 'right', minWidth: '60px' }}>
                        ${(line.quantity * Number(line.unit_price)).toFixed(2)}
                      </div>
                      <div />
                    </>
                  )}
                </div>
              ))}
            </div>

            <div style={{ borderTop: '1px solid var(--border)', marginTop: '12px', paddingTop: '12px', display: 'flex', justifyContent: 'flex-end', gap: '16px', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Order Total</span>
              <span style={{ fontSize: '20px', fontWeight: 800, color: 'var(--orange)' }}>${total.toFixed(2)}</span>
            </div>
          </Card>

          {/* Notes */}
          <Card title="Internal Notes">
            <textarea
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setIsDirty(true); }}
              placeholder="Add internal notes about this order…"
              rows={3}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: '8px',
                border: '1px solid var(--border)', background: 'var(--subtle-bg)',
                color: 'var(--text-primary)', fontSize: '14px', resize: 'vertical', boxSizing: 'border-box',
              }}
            />
          </Card>

          {/* Save button */}
          {canEdit && isDirty && (
            <button
              onClick={handleSaveChanges}
              disabled={saving}
              style={{
                padding: '14px', borderRadius: '10px', fontSize: '15px', fontWeight: 700,
                background: 'var(--orange)', border: 'none', color: '#fff',
                cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          )}
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Customer info */}
          <Card title="Customer">
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
              {order.portal_customer?.company_name}
            </div>
            <a
              href={`/admin/portal-customers/${order.portal_customer?.id}`}
              style={{ fontSize: '12px', color: 'var(--orange)', textDecoration: 'none', fontWeight: 600 }}
            >
              View portal customer →
            </a>
          </Card>

          {/* Ship-to */}
          <Card title="Ship-To">
            {canEdit ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <input
                  type="text"
                  value={shipTo.street}
                  onChange={(e) => { setShipTo((p) => ({ ...p, street: e.target.value })); setIsDirty(true); }}
                  placeholder="Street"
                  style={inputStyle}
                />
                <input
                  type="text"
                  value={shipTo.city}
                  onChange={(e) => { setShipTo((p) => ({ ...p, city: e.target.value })); setIsDirty(true); }}
                  placeholder="City"
                  style={inputStyle}
                />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <input
                    type="text"
                    value={shipTo.state}
                    onChange={(e) => { setShipTo((p) => ({ ...p, state: e.target.value })); setIsDirty(true); }}
                    placeholder="State"
                    maxLength={2}
                    style={inputStyle}
                  />
                  <input
                    type="text"
                    value={shipTo.zip}
                    onChange={(e) => { setShipTo((p) => ({ ...p, zip: e.target.value })); setIsDirty(true); }}
                    placeholder="ZIP"
                    style={inputStyle}
                  />
                </div>
              </div>
            ) : (
              order.ship_to_address ? (
                <div style={{ fontSize: '14px', color: 'var(--text-primary)', lineHeight: 1.6 }}>
                  {order.ship_to_address.street}<br />
                  {order.ship_to_address.city}, {order.ship_to_address.state} {order.ship_to_address.zip}
                </div>
              ) : (
                <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>No address provided</div>
              )
            )}
          </Card>

          {/* NetSuite */}
          {order.netsuite_so_id && (
            <Card title="NetSuite">
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '4px' }}>Sales Order</div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#34d399' }}>
                #{order.netsuite_so_number || order.netsuite_so_id}
              </div>
            </Card>
          )}
        </div>
      </div>

      <style>{`
        input:focus, textarea:focus { outline: none; border-color: var(--orange) !important; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
      `}</style>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: '12px' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: '8px',
  border: '1px solid var(--border)',
  background: 'var(--subtle-bg)',
  color: 'var(--text-primary)',
  fontSize: '13px',
  boxSizing: 'border-box',
};
