'use client';

import { useState, useEffect, lazy, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/components/AppProvider';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import { storage } from '@/lib/storage';
import type { CatalogProof } from '@/lib/types';

const DashboardGrid = lazy(() => import('@/components/widgets/DashboardGrid'));

// ─── Admin Dashboard Wrapper with tabs ─────────────────────────
function AdminDashboard() {
  const [dashTab, setDashTab] = useState<'dashboard' | 'analytics'>('dashboard');

  return (
    <div>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '14px', background: 'var(--card)', borderRadius: '10px', padding: '3px' }}>
        <button onClick={() => setDashTab('dashboard')} style={{
          flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
          background: dashTab === 'dashboard' ? 'var(--tab-active-bg)' : 'transparent', border: 'none',
          color: dashTab === 'dashboard' ? 'var(--text-primary)' : 'var(--text-muted)',
        }}>Dashboard</button>
        <button onClick={() => setDashTab('analytics')} style={{
          flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
          background: dashTab === 'analytics' ? 'var(--tab-active-bg)' : 'transparent', border: 'none',
          color: dashTab === 'analytics' ? 'var(--text-primary)' : 'var(--text-muted)',
        }}>Analytics</button>
      </div>
      {dashTab === 'dashboard' ? (
        <Suspense fallback={
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
          </div>
        }>
          <DashboardGrid />
        </Suspense>
      ) : <DashboardAnalytics />}
    </div>
  );
}

// ─── Dashboard Overview (original dashboard) ──────────────────
function DashboardOverview() {
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

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
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
            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Outstanding Bills</div>
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
                  <div style={{ fontWeight: 800, fontSize: '13px' }}>Bill #{inv.invoice_number}</div>
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
          <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '2px' }}>{stats.paidCount} bill{stats.paidCount !== 1 ? 's' : ''}</div>
        </div>

        {/* Pending Review */}
        <button onClick={() => router.push('/admin/jobs')} style={{
          textAlign: 'left', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          padding: '14px', boxShadow: theme.shadowSm,
        }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pending Review</div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: stats.pendingInvoiceCount > 0 ? 'var(--warning)' : theme.textPrimary, marginTop: '4px', letterSpacing: '-0.5px' }}>{stats.pendingInvoiceCount}</div>
          <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '2px' }}>bill{stats.pendingInvoiceCount !== 1 ? 's' : ''} to review</div>
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
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(238,49,32,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 }}></div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '14px', color: theme.textPrimary }}>Jobs & Bills</div>
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>Review jobs, manage bills</div>
          </div>
        </button>
        <button onClick={() => router.push('/admin/schedule')} style={{
          display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
          padding: '14px', borderRadius: '14px', textAlign: 'left',
          border: `1px solid ${theme.border}`, background: theme.card, boxShadow: theme.shadowSm,
        }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(238,49,32,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 }}></div>
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
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(238,49,32,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 }}></div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '14px', color: theme.textPrimary }}>Photo Reviews</div>
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>Approve or deny submissions</div>
          </div>
        </button>
      </div>
    </div>
  );
}

// ─── Dashboard Analytics ──────────────────────────────────────
function DashboardAnalytics() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [analyticsTab, setAnalyticsTab] = useState<'parts' | 'rework' | 'locations' | 'installers'>('parts');

  // Data
  const [partStats, setPartStats] = useState<any[]>([]);
  const [reworkStats, setReworkStats] = useState<{ byInstaller: any[]; byPart: any[] }>({ byInstaller: [], byPart: [] });
  const [locationStats, setLocationStats] = useState<any[]>([]);
  const [installerStats, setInstallerStats] = useState<any[]>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { loadAnalytics(); }, []);

  const loadAnalytics = async () => {
    // ── Get all vehicles with their data ──
    const { data: vehicles } = await supabase
      .from('scanned_vehicles')
      .select('id, vin, part_number, customer, end_customer, scanned_by, scanned_at, review_status, denial_count, install_location, po_line_item_id, company_id');

    const allVehicles = vehicles || [];

    // ── Get unified catalog for pricing: by uppercased item number, and by id
    //    for schedule assignments that carry a part_id ──
    const catalogMap: Record<string, { customer: string; price: number }> = {};
    const priceById: Record<string, number> = {};
    for (let offset = 0; ; offset += 1000) {
      const { data } = await supabase
        .from('netsuite_parts')
        .select('id, item_number, customer, billable_customer, sales_price')
        .eq('is_active', true)
        .order('item_number')
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      for (const c of data as any[]) {
        priceById[c.id] = c.sales_price || 0;
        if (c.item_number) {
          catalogMap[c.item_number.toUpperCase()] = {
            customer: c.customer || c.billable_customer || '',
            price: c.sales_price || 0,
          };
        }
      }
      if (data.length < 1000) break;
    }

    // ── Get PO line items for revenue data ──
    const { data: poLines } = await supabase
      .from('po_line_items')
      .select('id, part_number, quantity, installed, unit_price, po_id');

    const poLineMap: Record<string, any> = {};
    (poLines || []).forEach((l: any) => { poLineMap[l.id] = l; });

    // ── Get invoices for cost data ──
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, status, payment_amount, company_id');

    const { data: invoiceVehicles } = await supabase
      .from('invoice_vehicles')
      .select('invoice_id, vehicle_id');

    // Build invoice cost per vehicle
    const invoiceCostByVehicle: Record<string, number> = {};
    const paidInvoices = (invoices || []).filter((i: any) => i.status === 'paid' && i.payment_amount);
    for (const inv of paidInvoices) {
      const linkedVehicles = (invoiceVehicles || []).filter((iv: any) => iv.invoice_id === inv.id);
      if (linkedVehicles.length > 0) {
        const costPerVehicle = inv.payment_amount / linkedVehicles.length;
        linkedVehicles.forEach((iv: any) => {
          invoiceCostByVehicle[iv.vehicle_id] = (invoiceCostByVehicle[iv.vehicle_id] || 0) + costPerVehicle;
        });
      }
    }

    // ── Get profiles for installer names ──
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, company_id')
      .eq('status', 'approved');

    const profileMap: Record<string, any> = {};
    (profiles || []).forEach((p: any) => { profileMap[p.id] = p; });

    // ── Get companies ──
    const { data: companies } = await supabase.from('companies').select('id, name');
    const companyMap: Record<string, string> = {};
    (companies || []).forEach((c: any) => { companyMap[c.id] = c.name; });

    // ═══════════════════════════════════════════
    // PART NUMBER STATS
    // ═══════════════════════════════════════════
    const partMap: Record<string, { partNumber: string; customer: string; catalogPrice: number; installs: number; revenue: number; cost: number; reworks: number }> = {};

    for (const v of allVehicles) {
      const pn = v.part_number || 'Unknown';
      if (!partMap[pn]) {
        const cat = catalogMap[pn.toUpperCase()];
        partMap[pn] = {
          partNumber: pn,
          customer: v.customer || cat?.customer || '',
          catalogPrice: cat?.price || 0,
          installs: 0,
          revenue: 0,
          cost: 0,
          reworks: 0,
        };
      }
      partMap[pn].installs++;
      partMap[pn].reworks += (v.denial_count || 0);

      // Revenue from PO line item
      if (v.po_line_item_id && poLineMap[v.po_line_item_id]) {
        partMap[pn].revenue += poLineMap[v.po_line_item_id].unit_price;
      } else if (catalogMap[pn.toUpperCase()]) {
        partMap[pn].revenue += catalogMap[pn.toUpperCase()].price;
      }

      // Cost from invoices
      if (invoiceCostByVehicle[v.id]) {
        partMap[pn].cost += invoiceCostByVehicle[v.id];
      }
    }
    setPartStats(Object.values(partMap).sort((a, b) => b.installs - a.installs));

    // ═══════════════════════════════════════════
    // REWORK STATS
    // ═══════════════════════════════════════════
    const reworkByInstaller: Record<string, { name: string; company: string; total: number; reworks: number }> = {};
    const reworkByPart: Record<string, { partNumber: string; total: number; reworks: number }> = {};

    for (const v of allVehicles) {
      const installer = profileMap[v.scanned_by];
      const installerName = installer?.full_name || 'Unknown';
      const installerCompany = installer?.company_id ? (companyMap[installer.company_id] || '') : '';
      const pn = v.part_number || 'Unknown';

      if (!reworkByInstaller[v.scanned_by]) {
        reworkByInstaller[v.scanned_by] = { name: installerName, company: installerCompany, total: 0, reworks: 0 };
      }
      reworkByInstaller[v.scanned_by].total++;
      reworkByInstaller[v.scanned_by].reworks += (v.denial_count || 0);

      if (!reworkByPart[pn]) {
        reworkByPart[pn] = { partNumber: pn, total: 0, reworks: 0 };
      }
      reworkByPart[pn].total++;
      reworkByPart[pn].reworks += (v.denial_count || 0);
    }

    setReworkStats({
      byInstaller: Object.values(reworkByInstaller).sort((a, b) => b.reworks - a.reworks),
      byPart: Object.values(reworkByPart).sort((a, b) => b.reworks - a.reworks),
    });

    // ═══════════════════════════════════════════
    // LOCATION STATS
    // ═══════════════════════════════════════════
    const { data: scheduleData } = await supabase
      .from('schedule_assignments')
      .select('id, location_id, catalog_id, part_id, quantity, status');

    const { data: locations } = await supabase.from('locations').select('id, name');
    const locationMap: Record<string, string> = {};
    (locations || []).forEach((l: any) => { locationMap[l.id] = l.name; });

    const locStats: Record<string, { name: string; scheduledJobs: number; scheduledQty: number; revenue: number; cost: number }> = {};

    // From schedule assignments - get scheduled work by location
    for (const sa of (scheduleData || [])) {
      const locName = sa.location_id ? (locationMap[sa.location_id] || 'Unknown') : 'Unassigned';
      if (!locStats[locName]) {
        locStats[locName] = { name: locName, scheduledJobs: 0, scheduledQty: 0, revenue: 0, cost: 0 };
      }
      locStats[locName].scheduledJobs++;
      locStats[locName].scheduledQty += sa.quantity || 0;

      // Revenue estimate from the unified catalog (via the part_id backfilled
      // by migration 117).
      if (sa.part_id && priceById[sa.part_id] != null) {
        locStats[locName].revenue += priceById[sa.part_id] * (sa.quantity || 1);
      }
    }

    // From scanned vehicles with install_location
    for (const v of allVehicles) {
      if (v.install_location) {
        if (!locStats[v.install_location]) {
          locStats[v.install_location] = { name: v.install_location, scheduledJobs: 0, scheduledQty: 0, revenue: 0, cost: 0 };
        }
        if (invoiceCostByVehicle[v.id]) {
          locStats[v.install_location].cost += invoiceCostByVehicle[v.id];
        }
      }
    }

    setLocationStats(Object.values(locStats).sort((a, b) => b.revenue - a.revenue));

    // ═══════════════════════════════════════════
    // INSTALLER PERFORMANCE
    // ═══════════════════════════════════════════
    const instStats: Record<string, { name: string; company: string; installs: number; approved: number; denied: number; pending: number; reworks: number }> = {};

    for (const v of allVehicles) {
      const installer = profileMap[v.scanned_by];
      const installerName = installer?.full_name || 'Unknown';
      const installerCompany = installer?.company_id ? (companyMap[installer.company_id] || '') : '';

      if (!instStats[v.scanned_by]) {
        instStats[v.scanned_by] = { name: installerName, company: installerCompany, installs: 0, approved: 0, denied: 0, pending: 0, reworks: 0 };
      }
      instStats[v.scanned_by].installs++;
      instStats[v.scanned_by].reworks += (v.denial_count || 0);
      if (v.review_status === 'approved') instStats[v.scanned_by].approved++;
      else if (v.review_status === 'denied') instStats[v.scanned_by].denied++;
      else if (v.review_status === 'pending') instStats[v.scanned_by].pending++;
    }

    setInstallerStats(Object.values(instStats).sort((a, b) => b.installs - a.installs));

    setLoading(false);
  };

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtFull = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  const pct = (n: number, d: number) => d === 0 ? '0%' : `${((n / d) * 100).toFixed(1)}%`;

  if (loading) return (
    <div style={{ textAlign: 'center', padding: '60px 0' }}>
      <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
      <div style={{ color: theme.textMuted, fontWeight: 600, marginTop: '12px', fontSize: '13px' }}>Loading analytics...</div>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>Analytics</div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '14px', overflowX: 'auto' }}>
        {([
          { id: 'parts' as const, label: 'By Part #' },
          { id: 'rework' as const, label: 'Rework' },
          { id: 'locations' as const, label: 'Locations' },
          { id: 'installers' as const, label: 'Installers' },
        ]).map((t) => (
          <button key={t.id} onClick={() => setAnalyticsTab(t.id)} style={{
            padding: '7px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
            background: analyticsTab === t.id ? 'rgba(238,49,32,0.08)' : 'transparent',
            border: analyticsTab === t.id ? '1px solid rgba(238,49,32,0.2)' : `1px solid ${theme.border}`,
            color: analyticsTab === t.id ? theme.orange : theme.textMuted,
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══ PART NUMBER BREAKDOWN ═══ */}
      {analyticsTab === 'parts' && (
        <div>
          {partStats.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px', color: theme.textMuted, fontSize: '13px' }}>No install data yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Summary */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '4px' }}>
                <div style={{ flex: 1, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase' }}>Total Revenue</div>
                  <div style={{ fontSize: '20px', fontWeight: 800, color: theme.success, marginTop: '4px' }}>{fmt(partStats.reduce((s, p) => s + p.revenue, 0))}</div>
                </div>
                <div style={{ flex: 1, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase' }}>Total Cost</div>
                  <div style={{ fontSize: '20px', fontWeight: 800, color: theme.error, marginTop: '4px' }}>{fmt(partStats.reduce((s, p) => s + p.cost, 0))}</div>
                </div>
              </div>
              <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px', textAlign: 'center', marginBottom: '4px' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase' }}>Gross Profit</div>
                {(() => {
                  const rev = partStats.reduce((s, p) => s + p.revenue, 0);
                  const cost = partStats.reduce((s, p) => s + p.cost, 0);
                  const profit = rev - cost;
                  return <div style={{ fontSize: '20px', fontWeight: 800, color: profit >= 0 ? theme.success : theme.error, marginTop: '4px' }}>{fmt(profit)}</div>;
                })()}
              </div>

              {/* Part cards */}
              {partStats.map((p) => {
                const profit = p.revenue - p.cost;
                return (
                  <div key={p.partNumber} style={{
                    background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
                    padding: '14px', boxShadow: theme.shadowSm,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: '14px', color: theme.textPrimary }}>{p.partNumber}</div>
                        <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>{p.customer}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 800, fontSize: '14px', color: theme.textPrimary }}>{p.installs} install{p.installs !== 1 ? 's' : ''}</div>
                        {p.reworks > 0 && <div style={{ fontSize: '10px', color: theme.error, fontWeight: 700 }}>{p.reworks} rework{p.reworks !== 1 ? 's' : ''}</div>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '12px', marginTop: '10px', fontSize: '11px' }}>
                      <div>
                        <span style={{ color: theme.textMuted }}>Price: </span>
                        <span style={{ fontWeight: 700, color: theme.textPrimary }}>{fmtFull(p.catalogPrice)}</span>
                      </div>
                      <div>
                        <span style={{ color: theme.textMuted }}>Revenue: </span>
                        <span style={{ fontWeight: 700, color: theme.success }}>{fmt(p.revenue)}</span>
                      </div>
                      <div>
                        <span style={{ color: theme.textMuted }}>Cost: </span>
                        <span style={{ fontWeight: 700, color: theme.error }}>{fmt(p.cost)}</span>
                      </div>
                    </div>
                    <div style={{ marginTop: '6px', fontSize: '11px' }}>
                      <span style={{ color: theme.textMuted }}>Profit: </span>
                      <span style={{ fontWeight: 800, color: profit >= 0 ? theme.success : theme.error }}>{fmt(profit)}</span>
                      {p.revenue > 0 && <span style={{ color: theme.textMuted, marginLeft: '6px' }}>({pct(profit, p.revenue)} margin)</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══ REWORK STATS ═══ */}
      {analyticsTab === 'rework' && (
        <div>
          {reworkStats.byInstaller.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px', color: theme.textMuted, fontSize: '13px' }}>No rework data yet</div>
          ) : (
            <div>
              {/* Summary */}
              {(() => {
                const totalReworks = reworkStats.byInstaller.reduce((s, r) => s + r.reworks, 0);
                const totalJobs = reworkStats.byInstaller.reduce((s, r) => s + r.total, 0);
                return (
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
                    <div style={{ flex: 1, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase' }}>Total Reworks</div>
                      <div style={{ fontSize: '22px', fontWeight: 800, color: totalReworks > 0 ? theme.error : theme.success, marginTop: '4px' }}>{totalReworks}</div>
                    </div>
                    <div style={{ flex: 1, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase' }}>Rework Rate</div>
                      <div style={{ fontSize: '22px', fontWeight: 800, color: theme.textPrimary, marginTop: '4px' }}>{pct(totalReworks, totalJobs)}</div>
                    </div>
                  </div>
                );
              })()}

              {/* By Installer */}
              <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>By Installer</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
                {reworkStats.byInstaller.map((r, i) => (
                  <div key={i} style={{
                    background: theme.card, border: `1px solid ${r.reworks > 0 ? theme.errorBorder : theme.border}`,
                    borderRadius: '12px', padding: '12px', boxShadow: theme.shadowSm,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '14px', color: theme.textPrimary }}>{r.name}</div>
                        <div style={{ fontSize: '11px', color: theme.textMuted }}>{r.company} &bull; {r.total} job{r.total !== 1 ? 's' : ''}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 800, fontSize: '16px', color: r.reworks > 0 ? theme.error : theme.success }}>
                          {r.reworks}
                        </div>
                        <div style={{ fontSize: '10px', color: theme.textMuted }}>{pct(r.reworks, r.total)} rate</div>
                      </div>
                    </div>
                    {/* Mini progress bar */}
                    <div style={{ marginTop: '8px', height: '4px', background: 'rgba(255,255,255,0.04)', borderRadius: '2px', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', width: r.total > 0 ? `${Math.min((r.reworks / r.total) * 100, 100)}%` : '0%',
                        background: r.reworks > 0 ? theme.error : theme.success, borderRadius: '2px',
                      }} />
                    </div>
                  </div>
                ))}
              </div>

              {/* By Part Number */}
              <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>By Part Number</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {reworkStats.byPart.filter((r) => r.reworks > 0).map((r, i) => (
                  <div key={i} style={{
                    background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px',
                    padding: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '13px', color: theme.textPrimary }}>{r.partNumber}</div>
                      <div style={{ fontSize: '11px', color: theme.textMuted }}>{r.total} install{r.total !== 1 ? 's' : ''}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 800, color: theme.error }}>{r.reworks} rework{r.reworks !== 1 ? 's' : ''}</div>
                      <div style={{ fontSize: '10px', color: theme.textMuted }}>{pct(r.reworks, r.total)}</div>
                    </div>
                  </div>
                ))}
                {reworkStats.byPart.filter((r) => r.reworks > 0).length === 0 && (
                  <div style={{ textAlign: 'center', padding: '20px', color: theme.textMuted, fontSize: '13px' }}>No reworks on any part numbers</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ LOCATION STATS ═══ */}
      {analyticsTab === 'locations' && (
        <div>
          {locationStats.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px', color: theme.textMuted, fontSize: '13px' }}>No location data yet. Assign locations in the scheduler or when scanning vehicles.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Summary */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '4px' }}>
                <div style={{ flex: 1, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase' }}>Locations</div>
                  <div style={{ fontSize: '22px', fontWeight: 800, color: theme.textPrimary, marginTop: '4px' }}>{locationStats.length}</div>
                </div>
                <div style={{ flex: 1, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase' }}>Total Revenue</div>
                  <div style={{ fontSize: '22px', fontWeight: 800, color: theme.success, marginTop: '4px' }}>{fmt(locationStats.reduce((s, l) => s + l.revenue, 0))}</div>
                </div>
              </div>

              {/* Location cards */}
              {locationStats.map((loc, i) => {
                const profit = loc.revenue - loc.cost;
                return (
                  <div key={i} style={{
                    background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
                    padding: '14px', boxShadow: theme.shadowSm,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: '14px', color: theme.textPrimary }}>{loc.name}</div>
                        <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>
                          {loc.scheduledJobs} job{loc.scheduledJobs !== 1 ? 's' : ''} &bull; {loc.scheduledQty} vehicle{loc.scheduledQty !== 1 ? 's' : ''}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 800, fontSize: '14px', color: profit >= 0 ? theme.success : theme.error }}>{fmt(profit)}</div>
                        <div style={{ fontSize: '10px', color: theme.textMuted }}>profit</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '16px', marginTop: '8px', fontSize: '11px' }}>
                      <div>
                        <span style={{ color: theme.textMuted }}>Revenue: </span>
                        <span style={{ fontWeight: 700, color: theme.success }}>{fmt(loc.revenue)}</span>
                      </div>
                      <div>
                        <span style={{ color: theme.textMuted }}>Cost: </span>
                        <span style={{ fontWeight: 700, color: theme.error }}>{fmt(loc.cost)}</span>
                      </div>
                      {loc.revenue > 0 && (
                        <div>
                          <span style={{ color: theme.textMuted }}>Margin: </span>
                          <span style={{ fontWeight: 700, color: theme.textPrimary }}>{pct(profit, loc.revenue)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══ INSTALLER PERFORMANCE ═══ */}
      {analyticsTab === 'installers' && (
        <div>
          {installerStats.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px', color: theme.textMuted, fontSize: '13px' }}>No installer data yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {installerStats.map((inst, i) => {
                const approvalRate = inst.installs > 0 ? (inst.approved / inst.installs) * 100 : 0;
                return (
                  <div key={i} style={{
                    background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
                    padding: '14px', boxShadow: theme.shadowSm,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: '15px', color: theme.textPrimary }}>{inst.name}</div>
                        <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>{inst.company}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 800, fontSize: '18px', color: theme.navy }}>{inst.installs}</div>
                        <div style={{ fontSize: '10px', color: theme.textMuted }}>installs</div>
                      </div>
                    </div>

                    {/* Stats row */}
                    <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                      <div style={{ flex: 1, background: theme.successBg, borderRadius: '8px', padding: '6px 8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '14px', fontWeight: 800, color: theme.success }}>{inst.approved}</div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: theme.success, textTransform: 'uppercase' }}>Approved</div>
                      </div>
                      <div style={{ flex: 1, background: theme.warningBg, borderRadius: '8px', padding: '6px 8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '14px', fontWeight: 800, color: theme.warning }}>{inst.pending}</div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: theme.warning, textTransform: 'uppercase' }}>Pending</div>
                      </div>
                      <div style={{ flex: 1, background: theme.errorBg, borderRadius: '8px', padding: '6px 8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '14px', fontWeight: 800, color: theme.error }}>{inst.reworks}</div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: theme.error, textTransform: 'uppercase' }}>Reworks</div>
                      </div>
                    </div>

                    {/* Approval bar */}
                    {inst.installs > 0 && (
                      <div style={{ marginTop: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', marginBottom: '3px' }}>
                          <span style={{ color: theme.textMuted }}>Approval Rate</span>
                          <span style={{ fontWeight: 700, color: approvalRate >= 90 ? theme.success : approvalRate >= 70 ? theme.warning : theme.error }}>{approvalRate.toFixed(0)}%</span>
                        </div>
                        <div style={{ height: '4px', background: 'rgba(255,255,255,0.04)', borderRadius: '2px', overflow: 'hidden' }}>
                          <div style={{
                            height: '100%', width: `${approvalRate}%`,
                            background: approvalRate >= 90 ? theme.success : approvalRate >= 70 ? theme.warning : theme.error,
                            borderRadius: '2px',
                          }} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Installer Home (existing) ─────────────────────────────────
function InstallerHome() {
  const router = useRouter();
  const { clockStatus, activePart } = useApp();
  const { user } = useAuth();
  const supabase = createClient();

  const [proofs, setProofs] = useState<CatalogProof[]>([]);
  const [viewingProof, setViewingProof] = useState(false);
  const [viewIdx, setViewIdx] = useState(0);
  const [assignedVehicles, setAssignedVehicles] = useState<any[]>([]);
  const [assignedLoading, setAssignedLoading] = useState(true);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [activePart?.id]);

  // Load vehicles assigned to this installer
  useEffect(() => {
    if (!user?.id) return;
    const loadAssigned = async () => {
      setAssignedLoading(true);
      const { data: assignments } = await supabase
        .from('job_assignments')
        .select('job_id')
        .eq('job_type', 'scanned_vehicle')
        .eq('user_id', user.id);

      if (assignments && assignments.length > 0) {
        const jobIds = assignments.map((a: any) => a.job_id);
        const { data: vehicles } = await supabase
          .from('fleet_checkins')
          .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, status, updated_at')
          .in('id', jobIds)
          .order('updated_at', { ascending: false });
        setAssignedVehicles(vehicles || []);
      } else {
        setAssignedVehicles([]);
      }
      setAssignedLoading(false);
    };
    loadAssigned();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user?.id]);

  const getProofUrl = (proof: CatalogProof) => {
    const { data } = storage.from('proofs').getPublicUrl(proof.file_path);
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

      {/* My Assigned Vehicles */}
      {!assignedLoading && assignedVehicles.length > 0 && (
        <div style={{ marginBottom: '14px' }}>
          <div style={{
            fontSize: '10px', fontWeight: 700, color: theme.textMuted,
            textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px',
          }}>
            My Assigned Vehicles ({assignedVehicles.filter(v => v.status !== 'complete').length} active)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {assignedVehicles.filter(v => v.status !== 'complete').slice(0, 5).map(v => (
              <button
                key={v.id}
                onClick={() => router.push('/tracking')}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  width: '100%', textAlign: 'left',
                  padding: '10px 14px', borderRadius: '10px',
                  background: theme.card, border: `1px solid ${theme.border}`,
                  color: theme.textPrimary, fontSize: '12px',
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: '13px' }}>
                    {[v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown'}
                  </div>
                  <div style={{ fontSize: '10px', color: theme.textMuted, fontFamily: 'monospace', marginTop: '1px' }}>{v.vin}</div>
                  {v.customer_name && <div style={{ fontSize: '10px', color: theme.textSecondary, marginTop: '1px' }}>{v.customer_name}</div>}
                </div>
                <div style={{
                  padding: '3px 8px', borderRadius: '6px', fontSize: '9px', fontWeight: 700,
                  background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                  color: '#60a5fa', textTransform: 'uppercase',
                }}>
                  {(v.status || 'received').replace(/_/g, ' ')}
                </div>
              </button>
            ))}
            {assignedVehicles.filter(v => v.status !== 'complete').length > 5 && (
              <button
                onClick={() => router.push('/tracking')}
                style={{
                  padding: '8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                  background: 'transparent', border: `1px solid ${theme.border}`,
                  color: theme.textMuted, textAlign: 'center',
                }}
              >
                View all {assignedVehicles.filter(v => v.status !== 'complete').length} assigned vehicles →
              </button>
            )}
          </div>
        </div>
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
        <ActionBtn icon="" title="Scan VIN"
          sub={activePart ? `${activePart.part_number} — ${activePart.end_customer}` : 'Select a part number first'}
          onClick={() => router.push('/scan')} primary disabled={!activePart} />
        <ActionBtn icon="" title="Set Active Part Number"
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
  const router = useRouter();
  const { isAdmin, isSales, profile } = useAuth();

  const role = profile?.role;
  const roles = profile?.roles || [];
  const isOnlyRole = (r: string) => role === r || (roles.includes(r as any) && !roles.includes('admin' as any));

  useEffect(() => {
    if (!role) return;
    // Redirect roles to their dedicated home screens
    if (role === 'customer') { router.replace('/customer/dashboard'); return; }
    if (isOnlyRole('graphics_production')) { router.replace('/graphics'); return; }
    if (isOnlyRole('field_tech') || isOnlyRole('installer')) { router.replace('/scan'); return; }
    if (isOnlyRole('shop_tech')) { router.replace('/fleet'); return; }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [role, roles]);

  if (role === 'customer') return null;
  if (isOnlyRole('graphics_production') || isOnlyRole('field_tech') || isOnlyRole('installer') || isOnlyRole('shop_tech')) return null;

  // Admin and Sales get the customizable dashboard
  return <AdminDashboard />;
}
