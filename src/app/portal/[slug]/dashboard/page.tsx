'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import type { PortalCustomer, CustomerProofAssignment, ProofPart, GraphicsProof } from '@/lib/types';

interface AssignedProof {
  id: string;           // assignment id
  proof_id: string;
  proof: GraphicsProof;
  parts: ProofPart[];
}

export default function PortalDashboardPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [portalCustomer, setPortalCustomer] = useState<PortalCustomer | null>(null);
  const [assignedProofs, setAssignedProofs] = useState<AssignedProof[]>([]);
  const [userId, setUserId] = useState<string | null>(null);

  const accentColor = portalCustomer?.primary_color || '#EE3120';

  useEffect(() => {
    init();
  }, [slug]);

  const init = async () => {
    setLoading(true);

    // Check auth
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      router.replace(`/portal/${slug}`);
      return;
    }
    setUserId(session.user.id);

    // Load portal customer branding
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

    if (!pcu) {
      await supabase.auth.signOut();
      router.replace(`/portal/${slug}`);
      return;
    }

    // Load assigned proofs
    const { data: assignments } = await supabase
      .from('customer_proof_assignments')
      .select(`
        id,
        proof_id,
        proof:graphics_proofs (
          id, customer_name, vehicle_type, file_name, storage_path, thumbnail_path, created_at
        )
      `)
      .eq('portal_customer_id', customer.id);

    if (!assignments?.length) { setAssignedProofs([]); setLoading(false); return; }

    const proofIds = assignments.map((a: any) => a.proof_id);

    // Load parts for all assigned proofs
    const { data: allParts } = await supabase
      .from('proof_parts')
      .select('*')
      .in('proof_id', proofIds)
      .order('sort_order');

    const parts: ProofPart[] = allParts || [];

    const built: AssignedProof[] = assignments.map((a: any) => ({
      id: a.id,
      proof_id: a.proof_id,
      proof: a.proof,
      parts: parts.filter((p) => p.proof_id === a.proof_id),
    }));

    setAssignedProofs(built);
    setLoading(false);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace(`/portal/${slug}`);
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg, #0f1720)' }}>
        <div style={{ width: '28px', height: '28px', border: '2px solid rgba(255,255,255,0.1)', borderTopColor: '#EE3120', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>

      {/* Header */}
      <header style={{
        borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))',
        background: 'var(--card, rgba(255,255,255,0.03))',
        padding: '0 20px',
      }}>
        <div style={{ maxWidth: '760px', margin: '0 auto', height: '60px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {portalCustomer?.logo_url ? (
              <img
                src={portalCustomer.logo_url}
                alt={portalCustomer?.company_name}
                style={{ maxHeight: '36px', maxWidth: '120px', objectFit: 'contain' }}
              />
            ) : (
              <div style={{
                height: '36px', paddingInline: '12px', borderRadius: '8px',
                background: accentColor,
                display: 'flex', alignItems: 'center',
                fontSize: '14px', fontWeight: 800, color: '#fff',
              }}>
                {portalCustomer?.company_name}
              </div>
            )}
            {/* Divider + BMG logo */}
            <div style={{ height: '24px', width: '1px', background: 'var(--border, rgba(255,255,255,0.08))' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <img
                src="/bmg-logo-white.png"
                alt="BMG Fleet"
                style={{ height: '22px', opacity: 0.7 }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
              <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>Graphics Portal</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <a href={`/portal/${slug}/dashboard`} style={{ padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 600, color: '#fff', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', textDecoration: 'none' }}>
              Catalog
            </a>
            <a href={`/portal/${slug}/orders`} style={{ padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.5)', background: 'transparent', border: '1px solid transparent', textDecoration: 'none' }}>
              Orders
            </a>
            <button
              onClick={handleSignOut}
              style={{ padding: '7px 14px', borderRadius: '8px', border: '1px solid var(--border, rgba(255,255,255,0.1))', background: 'transparent', color: 'rgba(255,255,255,0.5)', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main style={{ maxWidth: '760px', margin: '0 auto', padding: '28px 20px' }}>
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary, #e8ecf1)', margin: '0 0 6px' }}>
            Graphics Catalog
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--text-muted, rgba(255,255,255,0.45))', margin: 0 }}>
            Your available graphics proofs and pricing
          </p>
        </div>

        {assignedProofs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 20px' }}>
            <div style={{ fontSize: '40px', marginBottom: '16px' }}>📋</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary, #e8ecf1)', marginBottom: '8px' }}>
              No graphics assigned yet
            </div>
            <div style={{ fontSize: '14px', color: 'var(--text-muted, rgba(255,255,255,0.4))' }}>
              Your BMG Fleet representative will add your graphics catalog soon.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {assignedProofs.map((item) => (
              <ProofCard key={item.id} item={item} accentColor={accentColor} slug={slug} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function ProofCard({ item, accentColor, slug }: { item: AssignedProof; accentColor: string; slug: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      background: 'var(--card, rgba(255,255,255,0.04))',
      border: '1px solid var(--border, rgba(255,255,255,0.08))',
      borderRadius: '14px', overflow: 'hidden',
    }}>
      {/* Proof header */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: '100%', padding: '18px 20px',
          display: 'flex', alignItems: 'center', gap: '16px',
          background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        {item.proof?.thumbnail_path ? (
          <img
            src={item.proof.thumbnail_path}
            alt=""
            style={{ width: '72px', height: '56px', objectFit: 'cover', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', flexShrink: 0 }}
          />
        ) : (
          <div style={{
            width: '72px', height: '56px', borderRadius: '8px',
            background: `${accentColor}22`, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '20px',
          }}>
            🖼️
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary, #e8ecf1)', marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {item.proof?.customer_name || 'Unnamed Proof'}
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted, rgba(255,255,255,0.45))' }}>
            {item.proof?.vehicle_type || item.proof?.file_name || '—'}
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', marginTop: '4px' }}>
            {item.parts.length} item{item.parts.length !== 1 ? 's' : ''} available
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          {item.parts.length > 0 && (
            <div style={{
              padding: '4px 10px', borderRadius: '20px',
              background: `${accentColor}22`, color: accentColor,
              fontSize: '11px', fontWeight: 700,
            }}>
              {item.parts.length} SKU{item.parts.length !== 1 ? 's' : ''}
            </div>
          )}
          <svg
            width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="rgba(255,255,255,0.35)" strokeWidth="2.5"
            style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </button>

      {/* Parts list */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border, rgba(255,255,255,0.08))', padding: '16px 20px' }}>
          {item.parts.length === 0 ? (
            <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '12px' }}>
              No items available yet — contact your BMG Fleet representative
            </div>
          ) : (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px 16px', marginBottom: '8px', padding: '0 4px' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Item</span>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.6px', textAlign: 'right' }}>Unit Price</span>
              </div>
              {item.parts.map((part) => (
                <div
                  key={part.id}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr auto',
                    gap: '4px 16px', padding: '12px 14px', borderRadius: '10px',
                    background: 'rgba(255,255,255,0.03)', marginBottom: '6px',
                    border: '1px solid rgba(255,255,255,0.05)',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary, #e8ecf1)' }}>
                      {part.part_name}
                      {part.part_number && (
                        <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.35)', marginLeft: '6px', fontSize: '12px' }}>
                          #{part.part_number}
                        </span>
                      )}
                    </div>
                    {part.description && (
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>
                        {part.description}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', alignSelf: 'center' }}>
                    <div style={{ fontSize: '16px', fontWeight: 800, color: accentColor }}>
                      ${Number(part.unit_price).toFixed(2)}
                    </div>
                    <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)' }}>each</div>
                  </div>
                </div>
              ))}

              {/* Order CTA */}
              <div style={{ marginTop: '14px' }}>
                <a
                  href={`/portal/${slug}/order/${item.proof_id}`}
                  style={{
                    display: 'block', padding: '13px', borderRadius: '10px',
                    background: accentColor, textAlign: 'center', textDecoration: 'none',
                    fontSize: '14px', fontWeight: 700, color: '#fff',
                  }}
                >
                  Order Now
                </a>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
