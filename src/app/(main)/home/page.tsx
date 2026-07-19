'use client';

import { useState, useEffect, lazy, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import MentionsInbox from '@/components/MentionsInbox';

const OpsDashboard = lazy(() => import('@/components/OpsDashboard'));

// ─── Admin Dashboard Wrapper with tabs ─────────────────────────
function AdminDashboard() {
  const [dashTab, setDashTab] = useState<'dashboard' | 'analytics'>('dashboard');

  return (
    <div>
      <MentionsInbox />
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
          <OpsDashboard />
        </Suspense>
      ) : <DashboardAnalytics />}
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
    if (isOnlyRole('shop_tech')) { router.replace('/tracking?checkin=1'); return; }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [role, roles]);

  if (role === 'customer') return null;
  if (isOnlyRole('graphics_production') || isOnlyRole('field_tech') || isOnlyRole('installer') || isOnlyRole('shop_tech')) return null;

  // Admin and Sales get the customizable dashboard
  return <AdminDashboard />;
}
