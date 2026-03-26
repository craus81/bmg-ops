'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import type { PortalOrder, PortalOrderStatus } from '@/lib/types';

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'in_production', label: 'In Production' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'completed', label: 'Completed' },
];

const STATUS_COLORS: Record<PortalOrderStatus, string> = {
  pending: '#f59e0b',
  confirmed: '#3b82f6',
  in_production: '#8b5cf6',
  shipped: '#10b981',
  completed: '#6b7280',
};

const STATUS_LABELS: Record<PortalOrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  in_production: 'In Production',
  shipped: 'Shipped',
  completed: 'Completed',
};

interface OrderRow extends Omit<PortalOrder, 'lines' | 'portal_customer'> {
  portal_customer: { id: string; company_name: string; slug: string };
  lines: { id: string; quantity: number; unit_price: number }[];
}

export default function AdminPortalOrdersPage() {
  const router = useRouter();
  const { isAdmin, isSales, isGraphicsProduction } = useAuth();
  const [statusFilter, setStatusFilter] = useState('all');
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAdmin && !isSales && !isGraphicsProduction) { router.push('/home'); return; }
    loadOrders();
  }, [statusFilter, isAdmin, isSales, isGraphicsProduction]);

  const loadOrders = async () => {
    setLoading(true);
    const params = statusFilter !== 'all' ? `?status=${statusFilter}` : '';
    const res = await fetch(`/api/admin/portal-orders${params}`);
    if (res.ok) setOrders(await res.json());
    setLoading(false);
  };

  const pendingCount = orders.filter((o) => o.status === 'pending').length;

  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 4px' }}>
              Portal Orders
              {pendingCount > 0 && (
                <span style={{ marginLeft: '10px', fontSize: '14px', fontWeight: 700, padding: '3px 8px', borderRadius: '12px', background: 'var(--orange)', color: '#fff' }}>
                  {pendingCount} new
                </span>
              )}
            </h1>
            <p style={{ fontSize: '14px', color: 'var(--text-muted)', margin: 0 }}>
              Customer portal orders queue
            </p>
          </div>
        </div>
      </div>

      {/* Status filter tabs */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '16px' }}>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            style={{
              padding: '7px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 600,
              border: '1px solid ' + (statusFilter === f.value ? 'var(--orange)' : 'var(--border)'),
              background: statusFilter === f.value ? 'var(--orange)' : 'var(--card)',
              color: statusFilter === f.value ? '#fff' : 'var(--text-muted)',
              cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>Loading orders…</div>
      ) : orders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '80px 20px' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>📭</div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>No orders</div>
          <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
            {statusFilter === 'all' ? 'No portal orders yet.' : `No ${statusFilter.replace('_', ' ')} orders.`}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {orders.map((order) => {
            const total = order.lines.reduce((s, l) => s + l.quantity * Number(l.unit_price), 0);
            const status = order.status as PortalOrderStatus;
            return (
              <button
                key={order.id}
                onClick={() => router.push(`/admin/portal-orders/${order.id}`)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr auto auto',
                  gap: '16px',
                  alignItems: 'center',
                  padding: '16px 18px',
                  borderRadius: '12px',
                  background: 'var(--card)',
                  border: '1px solid ' + (status === 'pending' ? 'rgba(245,158,11,0.3)' : 'var(--border)'),
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                  transition: 'border-color 0.15s',
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                {/* Customer badge */}
                <div style={{
                  width: '40px', height: '40px', borderRadius: '10px',
                  background: 'var(--subtle-bg)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  fontSize: '16px', fontWeight: 800, color: 'var(--orange)',
                  flexShrink: 0,
                }}>
                  {order.portal_customer?.company_name?.charAt(0) || '?'}
                </div>

                {/* Order info */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                    <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {order.portal_customer?.company_name}
                    </span>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      PO #{order.po_number || '—'}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {new Date(order.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    {' · '}{order.lines.length} line{order.lines.length !== 1 ? 's' : ''}
                    {order.netsuite_so_number && ` · SO #${order.netsuite_so_number}`}
                  </div>
                </div>

                {/* Total */}
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    ${total.toFixed(2)}
                  </div>
                </div>

                {/* Status */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{
                    padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 700,
                    background: STATUS_COLORS[status] + '22', color: STATUS_COLORS[status],
                    whiteSpace: 'nowrap',
                  }}>
                    {STATUS_LABELS[status]}
                  </span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
