'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/components/AppProvider';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import type { CatalogProof } from '@/lib/types';

// ─── Admin Dashboard ───────────────────────────────────────────
function AdminDashboard() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    openPoCount: 0,
    openPoValue: 0,
    openPoRemaining: 0,
    unpaidInvoiceCount: 0,
    unpaidInvoiceValue: 0,
    paidCount: 0,
    paidTotal: 0,
    pendingInvoiceCount: 0,
    vehiclesScanned: 0,
    vehiclesThisMonth: 0,
    revenueThisMonth: 0,
    revenueLastMonth: 0,
  });
  const [openPOs, setOpenPOs] = useState<any[]>([]);
  const [unpaidInvoices, setUnpaidInvoices] = useState<any[]>([]);
  const [showPODetail, setShowPODetail] = useState(false);
  const [showInvoiceDetail, setShowInvoiceDetail] = useState(false);

  useEffect(() => { loadDashboard(); }, []);

  const loadDashboard = async () => {
    // ── Open POs ──
    const { data: pos } = await supabase
      .from('purchase_orders')
      .select('id, po_number, customer, status, created_at')
      .eq('status', 'open');

    let openPoValue = 0;
    let openPoRemaining = 0;
    const poDetails: any[] = [];

    if (pos && pos.length > 0) {
      const { data: allLines } = await supabase
        .from('po_line_items')
        .select('po_id, part_number, quantity, installed, unit_price')
        .in('po_id', pos.map((p: any) => p.id));

      for (const po of pos) {
        const lines = (allLines || []).filter((l: any) => l.po_id === po.id);
        const totalValue = lines.reduce((s: number, l: any) => s + (l.quantity * l.unit_price), 0);
        const remainingValue = lines.reduce((s: number, l: any) => s + ((l.quantity - l.installed) * l.unit_price), 0);
        const totalQty = lines.reduce((s: number, l: any) => s + l.quantity, 0);
        const installedQty = lines.reduce((s: number, l: any) => s + l.installed, 0);
        openPoValue += totalValue;
        openPoRemaining += remainingValue;
        poDetails.push({ ...po, totalValue, remainingValue, totalQty, installedQty, lines });
      }
    }
    setOpenPOs(poDetails.sort((a, b) => b.remainingValue - a.remainingValue));

    // ── Invoices ──
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, invoice_number, status, submitted_at, payment_amount, paid_at, payment_method, company_id');

    const unpaid = (invoices || []).filter((i: any) => i.status === 'approved');
    const paid = (invoices || []).filter((i: any) => i.status === 'paid');
    const pending = (invoices || []).filter((i: any) => i.status === 'pending');

    // Get company names for unpaid
    const companyIds = [...new Set(unpaid.map((i: any) => i.company_id).filter(Boolean))];
    let companyMap: Record<string, string> = {};
    if (companyIds.length > 0) {
      const { data: companies } = await supabase
        .from('companies')
        .select('id, name')
        .in('id', companyIds);
      companyMap = (companies || []).reduce((m: Record<string, string>, c: any) => { m[c.id] = c.name; return m; }, {});
    }

    // For unpaid invoices, get the vehicle counts
    const unpaidDetails: any[] = [];
    for (const inv of unpaid) {
      const { count } = await supabase
        .from('invoice_vehicles')
        .select('*', { count: 'exact', head: true })
        .eq('invoice_id', inv.id);
      unpaidDetails.push({
        ...inv,
        company_name: companyMap[inv.company_id] || 'Unknown',
        vehicle_count: count || 0,
      });
    }
    setUnpaidInvoices(unpaidDetails.sort((a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime()));

    // We don't have dollar amounts on approved invoices (amount is only recorded when paid).
    // So for unpaid total, we'll show count only. For paid, sum payment_amount.
    const paidTotal = paid.reduce((s: number, i: any) => s + (i.payment_amount || 0), 0);

    // ── Vehicles ──
    const { count: totalVehicles } = await supabase
      .from('scanned_vehicles')
      .select('*', { count: 'exact', head: true });

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString();

    const { count: vehiclesThisMonth } = await supabase
      .from('scanned_vehicles')
      .select('*', { count: 'exact', head: true })
      .gte('scanned_at', monthStart);

    // ── Revenue (from paid invoices) ──
    const paidThisMonth = paid
      .filter((i: any) => i.paid_at && new Date(i.paid_at) >= new Date(monthStart))
      .reduce((s: number, i: any) => s + (i.payment_amount || 0), 0);

    const paidLastMonth = paid
      .filter((i: any) => i.paid_at && new Date(i.paid_at) >= new Date(lastMonthStart) && new Date(i.paid_at) <= new Date(lastMonthEnd))
      .reduce((s: number, i: any) => s + (i.payment_amount || 0), 0);

    setStats({
      openPoCount: (pos || []).length,
      openPoValue,
      openPoRemaining,
      unpaidInvoiceCount: unpaid.length,
      unpaidInvoiceValue: 0, // we don't know until paid
      paidCount: paid.length,
      paidTotal,
      pendingInvoiceCount: pending.length,
      vehiclesScanned: totalVehicles || 0,
      vehiclesThisMonth: vehiclesThisMonth || 0,
      revenueThisMonth: paidThisMonth,
      revenueLastMonth: paidLastMonth,
    });

    setLoading(false);
  };

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtFull = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  const monthName = new Date().toLocaleDateString('en-US', { month: 'long' });
  const lastMonthName = new Date(new Date().getFullYear(), new Date().getMonth() - 1).toLocaleDateString('en-US', { month: 'long' });

  if (loading) return (
    <div style={{ textAlign: 'center', padding: '60px 0' }}>
      <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
      <div style={{ color: theme.textMuted, fontWeight: 600, marginTop: '12px', fontSize: '13px' }}>Loading dashboard...</div>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '14px' }}>Dashboard</div>

      {/* ── Open PO Balance ── */}
      <button onClick={() => setShowPODetail(!showPODetail)} style={{
        width: '100%', textAlign: 'left', background: theme.card, border: `1px solid ${theme.border}`,
        borderLeft: `3px solid ${theme.orange}`, borderRadius: '4px 14px 14px 4px',
        padding: '16px', marginBottom: '10px', boxShadow: theme.shadowSm,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 700, color: theme.orange, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Open PO Balance</div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: theme.textPrimary, marginTop: '4px', letterSpacing: '-1px' }}>{fmt(stats.openPoRemaining)}</div>
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
              {stats.openPoCount} open PO{stats.openPoCount !== 1 ? 's' : ''} • {fmt(stats.openPoValue)} total value
            </div>
          </div>
          <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px' }}>{showPODetail ? '▲' : '▼'}</div>
        </div>
      </button>

      {showPODetail && openPOs.length > 0 && (
        <div style={{ marginBottom: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {openPOs.map((po) => (
            <div key={po.id} style={{
              background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px',
              padding: '12px', fontSize: '12px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: '13px' }}>PO #{po.po_number}</div>
                  <div style={{ color: theme.textMuted, marginTop: '1px' }}>{po.customer}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 800, color: theme.orange }}>{fmt(po.remainingValue)}</div>
                  <div style={{ fontSize: '10px', color: theme.textMuted }}>{po.installedQty}/{po.totalQty} installed</div>
                </div>
              </div>
              {po.lines && po.lines.length > 0 && (
                <div style={{ marginTop: '8px', borderTop: `1px solid ${theme.border}`, paddingTop: '6px' }}>
                  {po.lines.map((line: any, idx: number) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: theme.textSecondary, padding: '2px 0' }}>
                      <span>{line.part_number} ({line.installed}/{line.quantity})</span>
                      <span>{fmtFull(line.unit_price)} ea</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Outstanding Invoices (unpaid) ── */}
      <button onClick={() => setShowInvoiceDetail(!showInvoiceDetail)} style={{
        width: '100%', textAlign: 'left', background: theme.card, border: `1px solid ${theme.border}`,
        borderLeft: '3px solid var(--warning)', borderRadius: '4px 14px 14px 4px',
        padding: '16px', marginBottom: '10px', boxShadow: theme.shadowSm,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Outstanding Invoices</div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: theme.textPrimary, marginTop: '4px', letterSpacing: '-1px' }}>{stats.unpaidInvoiceCount}</div>
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
              Approved, awaiting payment
            </div>
          </div>
          <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px' }}>{showInvoiceDetail ? '▲' : '▼'}</div>
        </div>
      </button>

      {showInvoiceDetail && unpaidInvoices.length > 0 && (
        <div style={{ marginBottom: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {unpaidInvoices.map((inv) => (
            <button key={inv.id} onClick={() => router.push('/admin/jobs')} style={{
              width: '100%', textAlign: 'left', background: theme.card, border: `1px solid ${theme.border}`,
              borderRadius: '10px', padding: '12px', fontSize: '12px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: '13px' }}>Invoice #{inv.invoice_number}</div>
                  <div style={{ color: theme.textMuted, marginTop: '1px' }}>{inv.company_name} • {inv.vehicle_count} vehicle{inv.vehicle_count !== 1 ? 's' : ''}</div>
                </div>
                <div style={{ fontSize: '10px', color: theme.textMuted }}>
                  {new Date(inv.submitted_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* ── Stats Grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
        {/* Paid to Date */}
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          padding: '14px', boxShadow: theme.shadowSm,
        }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--success)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Paid to Date</div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: theme.textPrimary, marginTop: '4px', letterSpacing: '-0.5px' }}>{fmt(stats.paidTotal)}</div>
          <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '2px' }}>{stats.paidCount} invoice{stats.paidCount !== 1 ? 's' : ''}</div>
        </div>

        {/* Pending Review */}
        <button onClick={() => router.push('/admin/jobs')} style={{
          textAlign: 'left', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          padding: '14px', boxShadow: theme.shadowSm,
        }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pending Review</div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: stats.pendingInvoiceCount > 0 ? 'var(--warning)' : theme.textPrimary, marginTop: '4px', letterSpacing: '-0.5px' }}>{stats.pendingInvoiceCount}</div>
          <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '2px' }}>invoice{stats.pendingInvoiceCount !== 1 ? 's' : ''} to review</div>
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '14px' }}>
        {/* Vehicles Scanned */}
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          padding: '14px', boxShadow: theme.shadowSm,
        }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Vehicles Scanned</div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: theme.textPrimary, marginTop: '4px', letterSpacing: '-0.5px' }}>{stats.vehiclesScanned}</div>
          <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '2px' }}>{stats.vehiclesThisMonth} this month</div>
        </div>

        {/* Payments This Month */}
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          padding: '14px', boxShadow: theme.shadowSm,
        }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Paid in {monthName}</div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: theme.textPrimary, marginTop: '4px', letterSpacing: '-0.5px' }}>{fmt(stats.revenueThisMonth)}</div>
          <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '2px' }}>{fmt(stats.revenueLastMonth)} in {lastMonthName}</div>
        </div>
      </div>

      {/* Quick Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button onClick={() => router.push('/admin/jobs')} style={{
          display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
          padding: '14px', borderRadius: '14px', textAlign: 'left',
          border: `1px solid ${theme.border}`, background: theme.card, boxShadow: theme.shadowSm,
        }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(238,49,32,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 }}>📋</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '14px', color: theme.textPrimary }}>Jobs & Invoices</div>
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>Review jobs, manage invoices</div>
          </div>
        </button>
        <button onClick={() => router.push('/admin/schedule')} style={{
          display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
          padding: '14px', borderRadius: '14px', textAlign: 'left',
          border: `1px solid ${theme.border}`, background: theme.card, boxShadow: theme.shadowSm,
        }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(238,49,32,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 }}>📅</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '14px', color: theme.textPrimary }}>Scheduler</div>
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>Assign work to installers</div>
          </div>
        </button>
        <button onClick={() => router.push('/admin/reviews')} style={{
          display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
          padding: '14px', borderRadius: '14px', textAlign: 'left',
          border: `1px solid ${theme.border}`, background: theme.card, boxShadow: theme.shadowSm,
        }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(238,49,32,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 }}>📸</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '14px', color: theme.textPrimary }}>Photo Reviews</div>
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>Approve or deny submissions</div>
          </div>
        </button>
      </div>
    </div>
  );
}

// ─── Installer Home (existing) ─────────────────────────────────
function InstallerHome() {
  const router = useRouter();
  const { clockStatus, activePart } = useApp();
  const supabase = createClient();

  const [proofs, setProofs] = useState<CatalogProof[]>([]);
  const [viewingProof, setViewingProof] = useState(false);
  const [viewIdx, setViewIdx] = useState(0);

  useEffect(() => {
    if (!activePart) { setProofs([]); return; }
    const load = async () => {
      const { data } = await supabase
        .from('catalog_proofs')
        .select('*')
        .eq('catalog_id', activePart.id)
        .order('sort_order');
      setProofs(data || []);
    };
    load();
  }, [activePart?.id]);

  const getProofUrl = (proof: CatalogProof) => {
    const { data } = supabase.storage.from('proofs').getPublicUrl(proof.file_path);
    return data.publicUrl;
  };

  const handlePrint = () => {
    const proof = proofs[viewIdx];
    if (!proof) return;
    const url = getProofUrl(proof);
    window.open(url, '_blank');
  };

  if (viewingProof && proofs.length > 0) {
    const proof = proofs[viewIdx];
    const url = getProofUrl(proof);
    const isImage = proof.file_type.startsWith('image/');
    const total = proofs.length;

    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#000', display: 'flex', flexDirection: 'column' }}>
        <div style={{
          padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'var(--header-bg)', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: '14px', color: '#fff' }}>{activePart?.part_number}</div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '1px' }}>
              {activePart?.end_customer} — {activePart?.graphic_package}
              {proof.label && ` • ${proof.label}`}
            </div>
            {total > 1 && <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginTop: '1px' }}>{viewIdx + 1} of {total}</div>}
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={handlePrint} style={{
              padding: '8px 14px', borderRadius: '10px', background: 'var(--orange)',
              color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none',
              boxShadow: '0 2px 8px rgba(238,49,32,0.3)',
            }}>🖨 Print</button>
            <button onClick={() => setViewingProof(false)} style={{
              padding: '8px 14px', borderRadius: '10px', background: 'rgba(255,255,255,0.1)',
              color: '#fff', fontSize: '12px', fontWeight: 700, border: '1px solid rgba(255,255,255,0.15)',
            }}>✕ Close</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'hidden' }}>
          {isImage ? (
            <div style={{ width: '100%', height: '100%', overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px' }}>
              <img src={url} alt={proof.file_name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '4px' }} />
            </div>
          ) : (
            <iframe src={url} style={{ width: '100%', height: '100%', border: 'none' }} title={proof.file_name} />
          )}
        </div>

        {total > 1 && (
          <div style={{
            padding: '12px 16px', display: 'flex', gap: '8px', justifyContent: 'center',
            background: 'var(--header-bg)', borderTop: '1px solid var(--border)', flexShrink: 0,
          }}>
            <button onClick={() => setViewIdx(Math.max(0, viewIdx - 1))} disabled={viewIdx === 0} style={{
              padding: '10px 24px', borderRadius: '10px', background: 'rgba(255,255,255,0.1)',
              color: '#fff', fontWeight: 700, fontSize: '13px', opacity: viewIdx === 0 ? 0.3 : 1,
              border: '1px solid rgba(255,255,255,0.15)',
            }}>← Prev</button>
            <button onClick={() => setViewIdx(Math.min(total - 1, viewIdx + 1))} disabled={viewIdx === total - 1} style={{
              padding: '10px 24px', borderRadius: '10px', background: 'rgba(255,255,255,0.1)',
              color: '#fff', fontWeight: 700, fontSize: '13px', opacity: viewIdx === total - 1 ? 0.3 : 1,
              border: '1px solid rgba(255,255,255,0.15)',
            }}>Next →</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {clockStatus === 'out' && (
        <button onClick={() => router.push('/time')} style={{
          width: '100%', padding: '12px 16px', borderRadius: '14px', marginBottom: '14px',
          background: theme.warningBg, border: `1px solid ${theme.warningBorder}`,
          color: theme.warning, fontSize: '13px', fontWeight: 600, textAlign: 'left',
          display: 'flex', alignItems: 'center', gap: '8px',
        }}>
          ⏰ Not clocked in — tap to start your day
        </button>
      )}

      {activePart && (
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`,
          borderLeft: `3px solid ${theme.orange}`,
          borderRadius: '4px 14px 14px 4px', marginBottom: '14px',
          boxShadow: theme.shadowSm, overflow: 'hidden',
        }}>
          <div style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
              <div>
                <div style={{ fontSize: '10px', color: theme.orange, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Active Part Number</div>
                <div style={{ fontWeight: 800, fontSize: '20px', color: theme.textPrimary, marginTop: '2px', letterSpacing: '-0.5px' }}>{activePart.part_number}</div>
                <div style={{ fontSize: '12px', color: theme.textSecondary, marginTop: '3px' }}>{activePart.end_customer} • {activePart.graphic_package}</div>
                <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>{activePart.vehicle_type} • {activePart.customer}</div>
              </div>
              <button onClick={() => router.push('/select-part')} style={{
                background: 'transparent', border: `1px solid ${theme.borderStrong}`,
                borderRadius: '8px', color: theme.textSecondary, padding: '5px 10px',
                fontSize: '11px', fontWeight: 700,
              }}>Change</button>
            </div>
          </div>

          {proofs.length > 0 && (() => {
            const proof = proofs[0];
            const url = getProofUrl(proof);
            const isImage = proof.file_type.startsWith('image/');

            return (
              <button
                onClick={() => { setViewIdx(0); setViewingProof(true); }}
                style={{
                  width: '100%', display: 'block', cursor: 'pointer',
                  borderTop: `1px solid ${theme.border}`,
                  background: 'transparent', padding: 0,
                }}
              >
                <div style={{ position: 'relative' }}>
                  {isImage ? (
                    <img src={url} alt="Proof" style={{ width: '100%', maxHeight: '200px', objectFit: 'contain', background: 'var(--subtle-bg)', display: 'block' }} />
                  ) : (
                    <div style={{ width: '100%', height: '220px', overflow: 'hidden', position: 'relative', background: '#fff', borderRadius: '0 0 10px 0' }}>
                      <iframe
                        src={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
                        style={{
                          width: '300%', height: '300%', border: 'none',
                          position: 'absolute', top: 0, left: 0,
                          transform: 'scale(0.333)', transformOrigin: 'top left',
                          pointerEvents: 'none',
                        }}
                        title="Proof preview"
                      />
                    </div>
                  )}
                  <div style={{ position: 'absolute', bottom: '8px', right: '8px', display: 'flex', gap: '4px' }}>
                    {proofs.length > 1 && (
                      <span style={{ background: 'rgba(0,0,0,0.75)', borderRadius: '6px', padding: '3px 8px', fontSize: '10px', fontWeight: 700, color: '#fff' }}>{proofs.length} proofs</span>
                    )}
                    <span style={{ background: 'rgba(238,49,32,0.9)', borderRadius: '6px', padding: '3px 8px', fontSize: '10px', fontWeight: 700, color: '#fff' }}>Tap to view & print</span>
                  </div>
                </div>
              </button>
            );
          })()}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <ActionBtn icon="📷" title="Scan VIN"
          sub={activePart ? `${activePart.part_number} — ${activePart.end_customer}` : 'Select a part number first'}
          onClick={() => router.push('/scan')} primary disabled={!activePart} />
        <ActionBtn icon="🔧" title="Set Active Part Number"
          sub={activePart ? 'Change what you\'re installing' : 'Choose before scanning'}
          onClick={() => router.push('/select-part')} highlight={!activePart} />
      </div>
    </div>
  );
}

function ActionBtn({ icon, title, sub, onClick, primary, highlight, disabled }: {
  icon: string; title: string; sub?: string; onClick: () => void;
  primary?: boolean; highlight?: boolean; disabled?: boolean;
}) {
  return (
    <button onClick={disabled ? undefined : onClick} style={{
      display: 'flex', alignItems: 'center', gap: '14px', width: '100%',
      padding: '16px', borderRadius: '14px', textAlign: 'left',
      border: primary ? '1px solid rgba(238,49,32,0.12)' : highlight ? `1px solid ${theme.warningBorder}` : `1px solid ${theme.border}`,
      background: primary ? 'rgba(238,49,32,0.04)' : highlight ? theme.warningBg : theme.card,
      color: theme.textPrimary, opacity: disabled ? 0.4 : 1,
      boxShadow: theme.shadowSm, transition: 'all 0.15s',
    }}>
      <div style={{
        width: '44px', height: '44px', borderRadius: '12px',
        background: primary ? 'rgba(238,49,32,0.08)' : 'rgba(255,255,255,0.03)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '20px', flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '-0.2px' }}>{title}</div>
        {sub && <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px' }}>{sub}</div>}
      </div>
    </button>
  );
}

// ─── Main Export ────────────────────────────────────────────────
export default function HomePage() {
  const { isAdmin } = useAuth();
  return isAdmin ? <AdminDashboard /> : <InstallerHome />;
}
