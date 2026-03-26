'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import type { PortalCustomer, PortalOrder, PortalOrderStatus } from '@/lib/types';

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

export default function PortalOrdersPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [portalCustomer, setPortalCustomer] = useState<PortalCustomer | null>(null);
  const [orders, setOrders] = useState<PortalOrder[]>([]);

  const accentColor = portalCustomer?.primary_color || '#EE3120';

  useEffect(() => {
    init();
  }, [slug]);

  const init = async () => {
    setLoading(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace(`/portal/${slug}`); return; }

    const brandRes = await fetch(`/api/portal/${slug}`);
    if (!brandRes.ok) { router.replace(`/portal/${slug}`); return; }
    const customer: PortalCustomer = await brandRes.json();
    setPortalCustomer(customer);

    const { data: pcu } = await supabase
      .from('portal_customer_users')
      .select('id')
      .eq('portal_customer_id', customer.id)
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (!pcu) { await supabase.auth.signOut(); router.replace(`/portal/${slug}`); return; }

    const { data: ordersData } = await supabase
      .from('portal_orders')
      .select(`
        *,
        lines:portal_order_lines(id, quantity, unit_price)
      `)
      .eq('portal_customer_id', customer.id)
      .order('created_at', { ascending: false });

    setOrders((ordersData || []) as PortalOrder[]);
    setLoading(false);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace(`/portal/${slug}`);
  };

  if (loading) return <PortalSpinner />;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0f1720)', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* Header */}
      <header style={{ borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))', background: 'var(--card, rgba(255,255,255,0.03))', padding: '0 20px' }}>
        <div style={{ maxWidth: '760px', margin: '0 auto', height: '60px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {portalCustomer?.logo_url ? (
              <img src={portalCustomer.logo_url} alt={portalCustomer.company_name} style={{ maxHeight: '36px', maxWidth: '120px', objectFit: 'contain' }} />
            ) : (
              <div style={{ height: '36px', paddingInline: '12px', borderRadius: '8px', background: accentColor, display: 'flex', alignItems: 'center', fontSize: '14px', fontWeight: 800, color: '#fff' }}>
                {portalCustomer?.company_name}
              </div>
            )}
            <div style={{ height: '24px', width: '1px', background: 'var(--border, rgba(255,255,255,0.08))' }} />
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Graphics Portal</span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <NavLink href={`/portal/${slug}/dashboard`} label="Catalog" />
            <NavLink href={`/portal/${slug}/orders`} label="Orders" active />
            <button
              onClick={handleSignOut}
              style={{ padding: '7px 14px', borderRadius: '8px', border: '1px solid var(--border, rgba(255,255,255,0.1))', background: 'transparent', color: 'rgba(255,255,255,0.5)', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
            >Sign Out</button>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: '760px', margin: '0 auto', padding: '28px 20px' }}>
        <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary, #e8ecf1)', margin: '0 0 4px' }}>Order History</h1>
            <p style={{ fontSize: '14px', color: 'var(--text-muted, rgba(255,255,255,0.45))', margin: 0 }}>
              {orders.length} order{orders.length !== 1 ? 's' : ''} placed
            </p>
          </div>
          <button
            onClick={() => router.push(`/portal/${slug}/dashboard`)}
            style={{ padding: '10px 18px', borderRadius: '10px', background: accentColor, border: 'none', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}
          >
            + New Order
          </button>
        </div>

        {orders.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 20px' }}>
            <div style={{ fontSize: '40px', marginBottom: '16px' }}>📦</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary, #e8ecf1)', marginBottom: '8px' }}>No orders yet</div>
            <div style={{ fontSize: '14px', color: 'var(--text-muted, rgba(255,255,255,0.4))', marginBottom: '24px' }}>
              Browse your graphics catalog to place your first order.
            </div>
            <button
              onClick={() => router.push(`/portal/${slug}/dashboard`)}
              style={{ padding: '12px 24px', borderRadius: '10px', background: accentColor, border: 'none', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}
            >
              View Catalog
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {orders.map((order) => {
              const lines = (order as any).lines || [];
              const total = lines.reduce((s: number, l: any) => s + l.quantity * l.unit_price, 0);
              const status = order.status as PortalOrderStatus;
              return (
                <button
                  key={order.id}
                  onClick={() => router.push(`/portal/${slug}/orders/${order.id}`)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '18px 20px', borderRadius: '14px',
                    background: 'var(--card, rgba(255,255,255,0.04))',
                    border: '1px solid var(--border, rgba(255,255,255,0.08))',
                    cursor: 'pointer', textAlign: 'left', width: '100%',
                    transition: 'border-color 0.15s',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary, #e8ecf1)', marginBottom: '4px' }}>
                      PO #{order.po_number || '—'}
                    </div>
                    <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.4)' }}>
                      {new Date(order.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      {' · '}{lines.length} line{lines.length !== 1 ? 's' : ''}
                      {' · '}${total.toFixed(2)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{
                      padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 700,
                      background: STATUS_COLORS[status] + '22',
                      color: STATUS_COLORS[status],
                    }}>
                      {STATUS_LABELS[status]}
                    </span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2.5">
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active?: boolean }) {
  return (
    <a href={href} style={{
      padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
      color: active ? '#fff' : 'rgba(255,255,255,0.5)',
      background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
      border: '1px solid ' + (active ? 'rgba(255,255,255,0.12)' : 'transparent'),
      textDecoration: 'none',
    }}>
      {label}
    </a>
  );
}

function PortalSpinner() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f1720' }}>
      <div style={{ width: '28px', height: '28px', border: '2px solid rgba(255,255,255,0.1)', borderTopColor: '#EE3120', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
