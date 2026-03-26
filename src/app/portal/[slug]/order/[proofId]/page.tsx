'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import type { PortalCustomer, ProofPart, GraphicsProof } from '@/lib/types';

interface CartLine {
  proof_part_id: string;
  part_name: string;
  part_number: string | null;
  unit_price: number;
  quantity: number;
}

export default function PortalOrderPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const proofId = params.proofId as string;
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [portalCustomer, setPortalCustomer] = useState<PortalCustomer | null>(null);
  const [proof, setProof] = useState<GraphicsProof | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [poNumber, setPoNumber] = useState('');
  const [shipTo, setShipTo] = useState({ street: '', city: '', state: '', zip: '' });

  const accentColor = portalCustomer?.primary_color || '#EE3120';

  useEffect(() => {
    init();
  }, [slug, proofId]);

  const init = async () => {
    setLoading(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace(`/portal/${slug}`); return; }

    // Load branding
    const brandRes = await fetch(`/api/portal/${slug}`);
    if (!brandRes.ok) { router.replace(`/portal/${slug}`); return; }
    const customer: PortalCustomer = await brandRes.json();
    setPortalCustomer(customer);

    // Verify user belongs to this portal
    const { data: pcu } = await supabase
      .from('portal_customer_users')
      .select('id')
      .eq('portal_customer_id', customer.id)
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (!pcu) { await supabase.auth.signOut(); router.replace(`/portal/${slug}`); return; }

    // Verify this proof is assigned to this customer
    const { data: assignment } = await supabase
      .from('customer_proof_assignments')
      .select('id')
      .eq('portal_customer_id', customer.id)
      .eq('proof_id', proofId)
      .maybeSingle();
    if (!assignment) { router.replace(`/portal/${slug}/dashboard`); return; }

    // Load proof
    const { data: proofData } = await supabase
      .from('graphics_proofs')
      .select('id, customer_name, vehicle_type, thumbnail_path')
      .eq('id', proofId)
      .maybeSingle();
    setProof(proofData);

    // Load parts
    const { data: parts } = await supabase
      .from('proof_parts')
      .select('*')
      .eq('proof_id', proofId)
      .order('sort_order');

    setLines((parts || []).map((p: ProofPart) => ({
      proof_part_id: p.id,
      part_name: p.part_name,
      part_number: p.part_number,
      unit_price: Number(p.unit_price),
      quantity: 0,
    })));

    setLoading(false);
  };

  const setQty = (id: string, qty: number) => {
    setLines((prev) => prev.map((l) => l.proof_part_id === id ? { ...l, quantity: Math.max(0, qty) } : l));
  };

  const selectedLines = lines.filter((l) => l.quantity > 0);
  const orderTotal = selectedLines.reduce((s, l) => s + l.quantity * l.unit_price, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (selectedLines.length === 0) { setError('Select at least one item with a quantity.'); return; }
    if (!poNumber.trim()) { setError('PO number is required.'); return; }
    if (!shipTo.street || !shipTo.city || !shipTo.state || !shipTo.zip) {
      setError('Complete ship-to address is required.');
      return;
    }

    setSubmitting(true);

    const res = await fetch('/api/portal/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug,
        po_number: poNumber.trim(),
        ship_to_address: shipTo,
        lines: selectedLines.map((l) => ({
          proof_part_id: l.proof_part_id,
          quantity: l.quantity,
          unit_price: l.unit_price,
        })),
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error || 'Failed to place order.');
      setSubmitting(false);
      return;
    }

    router.replace(`/portal/${slug}/orders/${data.id}`);
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
          <div style={{ display: 'flex', gap: '8px' }}>
            <NavLink href={`/portal/${slug}/dashboard`} label="Catalog" />
            <NavLink href={`/portal/${slug}/orders`} label="Orders" active />
          </div>
        </div>
      </header>

      <main style={{ maxWidth: '760px', margin: '0 auto', padding: '28px 20px' }}>
        {/* Proof info */}
        <div style={{ marginBottom: '24px' }}>
          <button
            onClick={() => router.push(`/portal/${slug}/dashboard`)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: '13px', cursor: 'pointer', padding: 0, marginBottom: '14px' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6" /></svg>
            Back to catalog
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '8px' }}>
            {proof?.thumbnail_path ? (
              <img src={proof.thumbnail_path} alt="" style={{ width: '56px', height: '44px', objectFit: 'cover', borderRadius: '8px' }} />
            ) : (
              <div style={{ width: '56px', height: '44px', borderRadius: '8px', background: `${accentColor}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' }}>🖼️</div>
            )}
            <div>
              <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary, #e8ecf1)', margin: 0 }}>
                {proof?.customer_name || 'Place Order'}
              </h1>
              {proof?.vehicle_type && (
                <div style={{ fontSize: '13px', color: 'var(--text-muted, rgba(255,255,255,0.45))', marginTop: '2px' }}>{proof.vehicle_type}</div>
              )}
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Items */}
          <Section title="Select Items & Quantities">
            {lines.length === 0 ? (
              <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '14px' }}>No parts available for this proof.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {lines.map((line) => (
                  <div key={line.proof_part_id} style={{
                    display: 'grid', gridTemplateColumns: '1fr auto auto',
                    gap: '12px', alignItems: 'center',
                    padding: '14px 16px', borderRadius: '10px',
                    background: line.quantity > 0 ? `${accentColor}11` : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${line.quantity > 0 ? accentColor + '44' : 'rgba(255,255,255,0.06)'}`,
                    transition: 'all 0.15s',
                  }}>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary, #e8ecf1)' }}>
                        {line.part_name}
                        {line.part_number && (
                          <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.35)', marginLeft: '6px', fontSize: '12px' }}>#{line.part_number}</span>
                        )}
                      </div>
                      <div style={{ fontSize: '13px', color: accentColor, fontWeight: 700, marginTop: '2px' }}>
                        ${line.unit_price.toFixed(2)} each
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        type="button"
                        onClick={() => setQty(line.proof_part_id, line.quantity - 1)}
                        style={{ width: '32px', height: '32px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: '18px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
                      >−</button>
                      <input
                        type="number"
                        value={line.quantity || ''}
                        placeholder="0"
                        min={0}
                        onChange={(e) => setQty(line.proof_part_id, parseInt(e.target.value) || 0)}
                        style={{ width: '52px', textAlign: 'center', padding: '6px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontSize: '15px', fontWeight: 700 }}
                      />
                      <button
                        type="button"
                        onClick={() => setQty(line.proof_part_id, line.quantity + 1)}
                        style={{ width: '32px', height: '32px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: '18px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
                      >+</button>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: '64px' }}>
                      {line.quantity > 0 ? (
                        <span style={{ fontSize: '15px', fontWeight: 800, color: accentColor }}>
                          ${(line.quantity * line.unit_price).toFixed(2)}
                        </span>
                      ) : (
                        <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.2)' }}>—</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Order summary */}
          {selectedLines.length > 0 && (
            <Section title="Order Summary">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
                {selectedLines.map((l) => (
                  <div key={l.proof_part_id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>{l.part_name} × {l.quantity}</span>
                    <span style={{ color: 'var(--text-primary, #e8ecf1)', fontWeight: 600 }}>${(l.quantity * l.unit_price).toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '10px', display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: '16px', color: accentColor }}>
                <span>Total</span>
                <span>${orderTotal.toFixed(2)}</span>
              </div>
            </Section>
          )}

          {/* PO Number */}
          <Section title="PO Number">
            <input
              type="text"
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
              placeholder="Enter your purchase order number"
              required
              style={inputStyle}
            />
          </Section>

          {/* Ship-to */}
          <Section title="Ship-To Address">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <input
                type="text"
                value={shipTo.street}
                onChange={(e) => setShipTo((p) => ({ ...p, street: e.target.value }))}
                placeholder="Street address"
                required
                style={inputStyle}
              />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px', gap: '10px' }}>
                <input
                  type="text"
                  value={shipTo.city}
                  onChange={(e) => setShipTo((p) => ({ ...p, city: e.target.value }))}
                  placeholder="City"
                  required
                  style={inputStyle}
                />
                <input
                  type="text"
                  value={shipTo.state}
                  onChange={(e) => setShipTo((p) => ({ ...p, state: e.target.value }))}
                  placeholder="State"
                  maxLength={2}
                  required
                  style={inputStyle}
                />
                <input
                  type="text"
                  value={shipTo.zip}
                  onChange={(e) => setShipTo((p) => ({ ...p, zip: e.target.value }))}
                  placeholder="ZIP"
                  required
                  style={inputStyle}
                />
              </div>
            </div>
          </Section>

          {error && (
            <div style={{ padding: '12px 16px', borderRadius: '10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', fontSize: '14px', marginBottom: '16px' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || selectedLines.length === 0}
            style={{
              width: '100%', padding: '16px', borderRadius: '12px',
              background: selectedLines.length === 0 ? 'rgba(255,255,255,0.05)' : accentColor,
              border: 'none', color: '#fff', fontSize: '16px', fontWeight: 800,
              cursor: selectedLines.length === 0 || submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.7 : 1, transition: 'all 0.15s',
            }}
          >
            {submitting ? 'Placing Order…' : selectedLines.length === 0 ? 'Select Items to Order' : `Place Order — $${orderTotal.toFixed(2)}`}
          </button>
        </form>
      </main>

      <style>{`
        input:focus { outline: none; border-color: ${accentColor} !important; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
      `}</style>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: '10px' }}>
        {title}
      </div>
      <div style={{ background: 'var(--card, rgba(255,255,255,0.04))', border: '1px solid var(--border, rgba(255,255,255,0.08))', borderRadius: '12px', padding: '16px' }}>
        {children}
      </div>
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

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '11px 14px',
  borderRadius: '10px',
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(255,255,255,0.04)',
  color: '#e8ecf1',
  fontSize: '14px',
  boxSizing: 'border-box',
};
