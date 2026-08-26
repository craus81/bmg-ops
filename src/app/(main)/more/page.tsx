'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useTheme } from '@/components/ThemeProvider';
import TextSizeToggle from '@/components/TextSizeToggle';
import { createClient } from '@/lib/supabase-browser';

export default function MorePage() {
  const router = useRouter();
  const { isAdmin, isSales, isGraphicsProduction, hasRole, hasFeature, profile, signOut } = useAuth();
  const { mode, setMode, resolvedTheme } = useTheme();
  const supabase = createClient();
  const [pendingUserCount, setPendingUserCount] = useState(0);

  useEffect(() => {
    if (!hasFeature('user_management')) return;
    const load = async () => {
      if (hasFeature('user_management')) {
        const { count: userCount } = await supabase
          .from('profiles')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'pending');
        setPendingUserCount(userCount || 0);
      }
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [profile]);

  const F = hasFeature; // shorthand

  // One curated, grouped list. Bottom-nav tabs that don't fit the 7-slot
  // bar are NOT repeated as naked cards up top anymore — every page has
  // exactly one entry here, with a subtitle, in a sensible group.
  interface Item { title: string; sub: string; path: string; show: boolean; badge?: number }
  const groups: { header: string; items: Item[] }[] = [
    {
      header: 'Sales & Quoting',
      items: [
        { title: 'Customers', sub: 'Customers & sales pipeline', path: '/admin/prospects', show: F('prospects') },
        { title: 'Estimates', sub: 'Build estimates & push to NetSuite', path: '/estimates', show: F('estimates') },
        { title: 'Upfit Designer', sub: 'Design a van upfit in 3D & turn it into an estimate', path: '/upfit-designer', show: F('upfit_configurator') },
        { title: 'Wrap Quotes', sub: 'Measure a vehicle template by hand & email the quote', path: '/admin/wrap-quote', show: isAdmin || isSales || isGraphicsProduction },
        { title: 'Quotes', sub: 'Every estimate & wrap quote in one list — search, chase, mark won or lost', path: '/quotes', show: isAdmin || isSales },
        { title: 'Reports', sub: 'Sales by customer detail & other custom reports', path: '/admin/reports', show: F('reports') },
        { title: 'Invoicing', sub: 'Create & email NetSuite invoices from graphics jobs and scans', path: '/invoices', show: isAdmin || isSales },
      ],
    },
    {
      header: 'Shop & Production',
      items: [
        { title: 'Schedule', sub: 'Installs, upfits & events — two-way synced with Google Calendar', path: '/admin/schedule', show: F('schedule') },
        { title: 'Upfit Projects', sub: 'Track upfit jobs from estimate to completion', path: '/upfit', show: F('upfit_projects') },
        { title: 'Scan & Log', sub: 'Scan VINs and log work', path: '/scan', show: F('scan') },
        { title: 'Time Tracking', sub: 'Clock in/out & timesheets', path: '/time', show: F('time') },
        { title: 'Proof Search', sub: 'Find proof artwork in Dropbox by customer or part', path: '/admin/proof-search', show: F('proof_search') },
      ],
    },
    {
      header: 'Parts & Purchasing',
      items: [
        { title: 'Purchase Orders', sub: 'Manage POs', path: '/admin/pos', show: F('purchase_orders') },
        { title: 'Scan Log', sub: 'Review scans, match POs, export & invoice', path: '/admin/scans', show: F('reports') },
        { title: 'Parts Catalog', sub: 'Upfit & graphic parts from NetSuite', path: '/parts', show: F('parts_catalog') },
        { title: 'Inventory', sub: 'On hand · allocated to jobs · free · on order, at a glance', path: '/admin/inventory', show: F('parts_catalog') },
        { title: 'Part Tagging Rules', sub: 'Auto-categorize parts by vendor & name instead of one dropdown at a time', path: '/admin/part-category-rules', show: isAdmin },
        { title: 'Part Dimensions', sub: 'Record W×D×H per part so the 3D Upfit Designer can place it', path: '/admin/part-dimensions', show: isAdmin },
        { title: 'Vehicle Interiors', sub: 'Cargo geometry per wheelbase/roof — what the 3D designer draws', path: '/admin/vehicle-interiors', show: isAdmin },
        { title: 'Parts Mail', sub: 'Incoming parts & ETAs vs. stock and job allocations', path: '/admin/parts-mail', show: F('upfit_projects') },
        { title: 'Invoice Locations', sub: 'Backfill NetSuite invoice locations from the PO', path: '/admin/invoice-locations', show: isAdmin },
      ],
    },
    {
      header: 'CNI Network',
      items: [
        { title: 'Certified Network Installers', sub: 'Jobs, companies, installers & vendor payments', path: '/admin/cni', show: isAdmin },
        { title: 'Install Guides', sub: 'Dimension a 1:20 template & export a placement guide PDF for installers', path: '/graphics/install-guides', show: isAdmin || isSales || isGraphicsProduction },
        { title: 'Installer Portal', sub: 'The CNI installer view — available jobs, bids & invoices', path: '/installer', show: F('cni_portal') },
        { title: 'Import Installs', sub: 'Bulk-import installs from a spreadsheet, credited to a CNI installer', path: '/admin/import-installs', show: isAdmin },
        { title: 'Import Vendor Assets', sub: 'Pull product photos & descriptions from a vendor’s website onto matching parts', path: '/admin/import-vendor-assets', show: isAdmin },
        { title: 'Proof Sweep', sub: 'Search Gmail for proofs by part number and attach them to part records', path: '/admin/proof-sweep', show: isAdmin },
        { title: 'Payments (AP)', sub: 'Approve CNI vendor invoices & push bills to NetSuite', path: '/admin/ap', show: isAdmin || hasRole('finance') },
      ],
    },
    {
      header: 'Admin',
      items: [
        { title: 'User Management', sub: pendingUserCount > 0 ? `${pendingUserCount} pending approval` : 'Manage team access', path: '/admin/users', show: F('user_management'), badge: pendingUserCount > 0 ? pendingUserCount : undefined },
        { title: 'Customer Notifications', sub: 'Who gets automatic emails — everything else is on-demand', path: '/admin/customer-notifications', show: F('customers') },
        { title: 'Bulk Upload', sub: 'Import templates & proofs from ZIP', path: '/admin/bulk-upload', show: F('bulk_upload') },
        { title: 'Audit Log', sub: 'Who changed what — money edits, payouts, rates & invoices', path: '/admin/audit', show: F('audit_log') },
        { title: 'System Health', sub: 'Background syncs & crons — with alerts when one dies', path: '/admin/system-health', show: F('system_health') },
        { title: 'AI Instructions', sub: 'Steer FleetSuite AI behavior — global rules, no deploy', path: '/admin/ai-instructions', show: F('ai_instructions') },
        { title: 'Knowledge Base', sub: 'SOPs and docs for AI agent', path: '/admin/knowledge', show: F('knowledge_base') },
      ],
    },
    {
      header: 'Account',
      items: [
        { title: 'Sent Emails', sub: 'Every email you’ve sent from FleetSuite — with delivery status', path: '/sent-emails', show: true },
        { title: 'Settings', sub: 'Password, email signature, alerts & notifications', path: '/settings', show: true },
      ],
    },
  ];

  return (
    <div>
      {groups.map(group => {
        const items = group.items.filter(i => i.show);
        if (items.length === 0) return null;
        return (
          <div key={group.header} style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '8px' }}>
              {group.header}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {items.map(item => (
                <MenuBtn key={item.path + item.title} title={item.title} sub={item.sub} onClick={() => router.push(item.path)} badge={item.badge} />
              ))}
            </div>
          </div>
        );
      })}

      {/* Theme Toggle */}
      <div style={{ marginTop: '24px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
          Appearance
        </div>
        <div style={{
          display: 'flex', gap: '4px', padding: '4px',
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: '14px', boxShadow: 'var(--shadow-sm)',
        }}>
          {([
            { id: 'auto' as const, label: 'Auto' },
            { id: 'light' as const, label: 'Light' },
            { id: 'dark' as const, label: 'Dark' },
          ]).map((opt) => (
            <button
              key={opt.id}
              onClick={() => setMode(opt.id)}
              style={{
                flex: 1, padding: '10px 6px', borderRadius: '10px',
                fontSize: '12px', fontWeight: 700,
                background: mode === opt.id ? 'var(--tab-active-bg)' : 'transparent',
                border: mode === opt.id ? '1px solid var(--tab-active-border)' : '1px solid transparent',
                color: mode === opt.id ? 'var(--text-primary)' : 'var(--text-muted)',
                transition: 'all 0.15s',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {mode === 'auto' && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', textAlign: 'center' }}>
            Currently showing {resolvedTheme} (matches your device)
          </div>
        )}

        {/* Text Size */}
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginTop: '16px', marginBottom: '10px' }}>
          Text Size
        </div>
        <TextSizeToggle />
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', textAlign: 'center' }}>
          Makes everything on this device larger and easier to read
        </div>
      </div>

      {/* Profile */}
      <div style={{ marginTop: '24px', padding: '16px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{profile?.full_name}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>{profile?.email}</div>
        <div style={{ fontSize: '11px', color: isAdmin ? 'var(--orange)' : 'var(--navy-light)', marginTop: '3px', fontWeight: 600 }}>
          {(() => {
            if (isAdmin) return 'Administrator';
            const roles = (profile?.roles?.length ? profile.roles : [profile?.role]).filter(Boolean);
            const labelMap: Record<string, string> = {
              field_tech: 'Field Tech',
              shop_tech: 'Shop Tech',
              sales: 'Sales',
              graphics_production: 'Graphics / Production',
              production: 'Graphics / Production',
              installer: 'CNI Installer',
              finance: 'Finance / AP',
              customer: 'Customer',
            };
            return roles.map((r: any) => labelMap[r] || r).join(', ') || 'Installer';
          })()}
        </div>
        <button onClick={signOut} style={{
          marginTop: '14px', width: '100%', padding: '12px', borderRadius: '10px',
          border: '1px solid var(--error-border)', background: 'var(--error-bg)',
          color: 'var(--error)', fontSize: '13px', fontWeight: 700,
        }}>Sign Out</button>
      </div>
    </div>
  );
}

function MenuBtn({ title, sub, onClick, badge }: { icon?: string; title: string; sub: string; onClick: () => void; badge?: number }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: '14px', width: '100%',
      padding: '12px 16px', borderRadius: '14px', textAlign: 'left',
      border: '1px solid var(--border)', background: 'var(--card)',
      boxShadow: 'var(--shadow-sm)', transition: 'all 0.15s',
      position: 'relative',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>{title}</div>
        <div style={{ fontSize: '11px', color: badge ? 'var(--warning)' : 'var(--text-muted)', marginTop: '2px', fontWeight: badge ? 600 : 400 }}>{sub}</div>
      </div>
      {badge && (
        <div style={{
          width: '22px', height: '22px', borderRadius: '50%',
          background: 'var(--orange)', color: '#fff',
          fontSize: '11px', fontWeight: 800,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>{badge}</div>
      )}
    </button>
  );
}
