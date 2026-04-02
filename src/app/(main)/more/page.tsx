'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useTheme } from '@/components/ThemeProvider';
import { createClient } from '@/lib/supabase-browser';

export default function MorePage() {
  const router = useRouter();
  const { isAdmin, isSales, isGraphicsProduction, isFieldTech, isShopTech, hasRole, profile, signOut } = useAuth();
  const { mode, setMode, resolvedTheme } = useTheme();
  const supabase = createClient();
  const [pendingUserCount, setPendingUserCount] = useState(0);
  const [pendingReviewCount, setPendingReviewCount] = useState(0);

  useEffect(() => {
    if (!isAdmin) return;
    const load = async () => {
      const { count: userCount } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');
      setPendingUserCount(userCount || 0);

      const { count: reviewCount } = await supabase
        .from('scanned_vehicles')
        .select('*', { count: 'exact', head: true })
        .eq('review_status', 'pending')
        .eq('submitted_for_review', true);
      setPendingReviewCount(reviewCount || 0);

    };
    load();
  }, [isAdmin]);

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
        More
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {(isAdmin || isShopTech) && (
          <MenuBtn icon="🔄" title="Update Vehicle Status" sub="Scan VIN to update status" onClick={() => router.push('/fleet/update')} />
        )}
        {(isAdmin || isFieldTech || isShopTech) && (
          <MenuBtn icon="🔧" title="My Jobs" sub="View your company's work" onClick={() => router.push('/jobs')} />
        )}
        {isAdmin && (
          <MenuBtn icon="📊" title="Export Reports" sub="Download vehicle spreadsheets" onClick={() => router.push('/reports')} />
        )}
        {/* Sales + Graphics Production + Admin tools */}
        {(isAdmin || isSales || isGraphicsProduction) && (<>
          <MenuBtn icon="🏢" title="Customers" sub="Customers & contacts from NetSuite" onClick={() => router.push('/admin/customers')} />
          <MenuBtn icon="🔩" title="Parts Catalog" sub="Upfit & graphic parts from NetSuite" onClick={() => router.push('/parts')} />
          <MenuBtn icon="💰" title="Estimates" sub="Build estimates & push to NetSuite" onClick={() => router.push('/estimates')} />
          <MenuBtn icon="📐" title="Estimating" sub="AI-powered vinyl wrap quoting" onClick={() => router.push('/admin/quotes')} />
        </>)}
        {/* Admin-only tools */}
        {isAdmin && (<>
          <MenuBtn icon="📄" title="Proof Hygiene" sub="Assign unmatched proof files from NAS" onClick={() => router.push('/admin/proofs')} />
          <MenuBtn icon="📋" title="All Jobs" sub="View all jobs by company" onClick={() => router.push('/admin/jobs')} />
          <MenuBtn icon="📅" title="Schedule" sub="Assign jobs to installers" onClick={() => router.push('/admin/schedule')} />
          <MenuBtn icon="📦" title="Part Catalog" sub="Manage part numbers" onClick={() => router.push('/admin/catalog')} />
          <MenuBtn icon="📤" title="Bulk Upload" sub="Import templates & proofs from ZIP" onClick={() => router.push('/admin/bulk-upload')} />
          <MenuBtn icon="📋" title="Purchase Orders" sub="Manage POs" onClick={() => router.push('/admin/pos')} />
          <MenuBtn
            icon="📸"
            title="Photo Reviews"
            sub={pendingReviewCount > 0 ? `${pendingReviewCount} waiting for approval` : 'Review completion photos'}
            onClick={() => router.push('/admin/reviews')}
            badge={pendingReviewCount > 0 ? pendingReviewCount : undefined}
          />
          <MenuBtn
            icon="👥"
            title="User Management"
            sub={pendingUserCount > 0 ? `${pendingUserCount} pending approval` : 'Manage team access'}
            onClick={() => router.push('/admin/users')}
            badge={pendingUserCount > 0 ? pendingUserCount : undefined}
          />
        </>)}
        {isAdmin && (
          <MenuBtn icon="👷" title="CNI Management" sub="Certified Network Installer jobs & profiles" onClick={() => router.push('/admin/cni')} />
        )}
        {isAdmin && (
          <MenuBtn icon="📚" title="Knowledge Base" sub="SOPs and docs for AI agent" onClick={() => router.push('/admin/knowledge')} />
        )}
        <MenuBtn icon="📝" title="Quick Job (No PO)" sub="Start scanning without a PO" onClick={() => router.push('/scan')} />
        <MenuBtn icon="📶" title="Offline Scanner" sub="Scan VINs underground — syncs when back online" onClick={() => router.push('/offline-scan')} />
        <MenuBtn icon="🔔" title="Notification Settings" sub="Configure your alert preferences" onClick={() => router.push('/settings')} />
      </div>

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
            { id: 'auto' as const, label: '🔄 Auto' },
            { id: 'light' as const, label: '☀️ Light' },
            { id: 'dark' as const, label: '🌙 Dark' },
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
              installer: 'Installer',
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

function MenuBtn({ icon, title, sub, onClick, badge }: { icon: string; title: string; sub: string; onClick: () => void; badge?: number }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: '14px', width: '100%',
      padding: '16px', borderRadius: '14px', textAlign: 'left',
      border: '1px solid var(--border)', background: 'var(--card)',
      boxShadow: 'var(--shadow-sm)', transition: 'all 0.15s',
      position: 'relative',
    }}>
      <div style={{
        width: '44px', height: '44px', borderRadius: '12px',
        background: 'var(--subtle-bg)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', fontSize: '20px', flexShrink: 0,
      }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>{title}</div>
        <div style={{ fontSize: '12px', color: badge ? 'var(--warning)' : 'var(--text-muted)', marginTop: '2px', fontWeight: badge ? 600 : 400 }}>{sub}</div>
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
