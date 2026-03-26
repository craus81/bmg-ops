'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { PortalCustomer, PortalOrder, PortalOrderStatus } from '@/lib/types';

const STATUS_LABELS: Record<PortalOrderStatus, string> = {
  pending: 'Pending Review',
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

const STATUS_ORDER: PortalOrderStatus[] = ['pending', 'confirmed', 'in_production', 'shipped', 'completed'];

export default function PortalOrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const orderId = params.orderId as string;

  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<PortalOrder | null>(null);
  const [portalCustomer, setPortalCustomer] = useState<PortalCustomer | null>(null);

  const accentColor = portalCustomer?.primary_color || '#EE3120';

  useEffect(() => {
    loadOrder();
  }, [orderId]);

  const loadOrder = async () => {
    setLoading(true);
    const res = await fetch(`/api/portal/orders/${orderId}`);
    if (!res.ok) { router.replace(`/portal/${slug}/orders`); return; }
    const data: PortalOrder = await res.json();
    setOrder(data);
    if (data.portal_customer) setPortalCustomer(data.portal_customer as unknown as PortalCustomer);

    // Also load branding via slug for color if not on order
    if (!data.portal_customer?.primary_color) {
      const brandRes = await fetch(`/api/portal/${slug}`);
      if (brandRes.ok) setPortalCustomer(await brandRes.json());
    }
    setLoading(false);
  };

  if (loading) return <PortalSpinner />;
  if (!order) return null;

  const lines = order.lines || [];
  const total = lines.reduce((s, l) => s + l.quantity * Number(l.unit_price), 0);
  const status = order.status as PortalOrderStatus;
  const statusIndex = STATUS_ORDER.indexOf(status);
  const addr = order.ship_to_address;
  const isNew = new Date(order.created_at) > new Date(Date.now() - 5000); // just submitted

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
            <div style={{ height: '24px', width: '1px', background: 'rgba(255,255,255,0.08)' }} />
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Graphics Portal</span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <NavLink href={`/portal/${slug}/dashboard`} label="Catalog" />
            <NavLink href={`/portal/${slug}/orders`} label="Orders" active />
          </div>
        </div>
      </header>

      <main style={{ maxWidth: '760px', margin: '0 auto', padding: '28px 20px' }}>
        {/* Success banner for new orders */}
        {isNew && (
          <div style={{
            padding: '16px 20px', borderRadius: '12px', marginBottom: '24px',
            background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)',
            display: 'flex', alignItems: 'center', gap: '12px',
          }}>
            <div style={{ fontSize: '24px' }}>✅</div>
            <div>
              <div style={{ fontWeight: 700, color: '#34d399', fontSize: '15px' }}>Order Placed Successfully</div>
              <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>
                Your order has been received. Our team will review and confirm it shortly.
              </div>
            </div>
          </div>
        )}

        {/* Back link */}
        <button
          onClick={() => router.push(`/portal/${slug}/orders`)}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: '13px', cursor: 'pointer', padding: 0, marginBottom: '20px' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6" /></svg>
          All orders
        </button>

        {/* Order header */}
        <div style={{ background: 'var(--card, rgba(255,255,255,0.04))', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: '14px', padding: '20px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: '4px' }}>Purchase Order</div>
              <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary, #e8ecf1)' }}>#{order.po_number}</div>
              <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.4)', marginTop: '4px' }}>
                {new Date(order.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })}
              </div>
            </div>
            <span style={{
              padding: '6px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 700,
              background: STATUS_COLORS[status] + '22', color: STATUS_COLORS[status],
            }}>
              {STATUS_LABELS[status]}
            </span>
          </div>

          {/* Status progress */}
          <div style={{ display: 'flex', gap: 0, marginTop: '8px' }}>
            {STATUS_ORDER.map((s, i) => (
              <div key={s} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                <div style={{ position: 'relative', width: '100%', display: 'flex', alignItems: 'center' }}>
                  {i > 0 && <div style={{ flex: 1, height: '2px', background: i <= statusIndex ? accentColor : 'rgba(255,255,255,0.1)' }} />}
                  <div style={{
                    width: '10px', height: '10px', borderRadius: '50%', flexShrink: 0,
                    background: i <= statusIndex ? accentColor : 'rgba(255,255,255,0.1)',
                  }} />
                  {i < STATUS_ORDER.length - 1 && <div style={{ flex: 1, height: '2px', background: i < statusIndex ? accentColor : 'rgba(255,255,255,0.1)' }} />}
                </div>
                <div style={{ fontSize: '9px', color: i === statusIndex ? accentColor : 'rgba(255,255,255,0.3)', fontWeight: i === statusIndex ? 700 : 400, textAlign: 'center' }}>
                  {STATUS_LABELS[s].split(' ')[0]}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Line items */}
        <div style={{ background: 'var(--card, rgba(255,255,255,0.04))', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: '14px', padding: '20px', marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: '14px' }}>Items Ordered</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {lines.map((line: any) => {
              const part = line.proof_part;
              return (
                <div key={line.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '12px', alignItems: 'center', padding: '12px 14px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary, #e8ecf1)' }}>
                      {part?.part_name || '—'}
                      {part?.part_number && <span style={{ color: 'rgba(255,255,255,0.35)', fontWeight: 400, marginLeft: '6px', fontSize: '12px' }}>#{part.part_number}</span>}
                    </div>
                    <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>${Number(line.unit_price).toFixed(2)} each</div>
                  </div>
                  <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.5)', textAlign: 'center' }}>×{line.quantity}</div>
                  <div style={{ fontSize: '15px', fontWeight: 800, color: accentColor, textAlign: 'right', minWidth: '64px' }}>
                    ${(line.quantity * Number(line.unit_price)).toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: '12px', paddingTop: '12px', display: 'flex', justifyContent: 'flex-end', gap: '16px', alignItems: 'center' }}>
            <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '14px' }}>Order Total</span>
            <span style={{ fontSize: '20px', fontWeight: 800, color: accentColor }}>${total.toFixed(2)}</span>
          </div>
        </div>

        {/* Ship-to */}
        {addr && (
          <div style={{ background: 'var(--card, rgba(255,255,255,0.04))', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: '14px', padding: '20px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: '10px' }}>Ship-To Address</div>
            <div style={{ fontSize: '14px', color: 'var(--text-primary, #e8ecf1)', lineHeight: 1.6 }}>
              {addr.street}<br />
              {addr.city}, {addr.state} {addr.zip}
            </div>
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
