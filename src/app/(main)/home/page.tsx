'use client';

import { useState, useEffect, lazy, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import MentionsInbox from '@/components/MentionsInbox';
import MyHome from '@/components/MyHome';

const OpsDashboard = lazy(() => import('@/components/OpsDashboard'));
const FinancialsDashboard = lazy(() => import('@/components/FinancialsDashboard'));

function DashSpinner() {
  return (
    <div style={{ textAlign: 'center', padding: '60px 0' }}>
      <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
    </div>
  );
}

// ─── Dashboard wrapper ─────────────────────────────────────────
// The ops Dashboard for everyone; a Financials tab appears alongside it only
// for roles with the `financials` feature (super_admin + executive).
function AdminDashboard() {
  const { hasFeature, hasRole, isAdmin } = useAuth();
  // Sales reps get their own week on top of the shared dashboard.
  const showMyWeek = hasRole('sales') && !isAdmin;
  const showFinancials = hasFeature('financials');
  const showOps = hasFeature('in_shop'); // the ops Dashboard is only meaningful for ops roles
  const bothTabs = showFinancials && showOps;
  const [dashTab, setDashTab] = useState<'dashboard' | 'financials'>(showOps ? 'dashboard' : 'financials');

  // A lean executive (financials but no ops access) lands straight on
  // Financials — the ops Dashboard would just 403 its data for them. The
  // toggle only applies when someone actually has both views.
  const view: 'dashboard' | 'financials' =
    !showOps ? (showFinancials ? 'financials' : 'dashboard')
    : !showFinancials ? 'dashboard'
    : dashTab;

  const tabBtn = (active: boolean) => ({
    flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
    background: active ? 'var(--tab-active-bg)' : 'transparent', border: 'none',
    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
  } as const);

  return (
    <div>
      <MentionsInbox />
      {showMyWeek && <MyHome role="sales" embedded />}
      {bothTabs && (
        <div style={{ display: 'flex', gap: '4px', marginBottom: '14px', background: 'var(--card)', borderRadius: '10px', padding: '3px' }}>
          <button onClick={() => setDashTab('dashboard')} style={tabBtn(view === 'dashboard')}>Dashboard</button>
          <button onClick={() => setDashTab('financials')} style={tabBtn(view === 'financials')}>Financials</button>
        </div>
      )}
      <Suspense fallback={<DashSpinner />}>
        {view === 'financials' ? <FinancialsDashboard /> : <OpsDashboard />}
      </Suspense>
    </div>
  );
}

// ─── Main Export ────────────────────────────────────────────────
export default function HomePage() {
  const router = useRouter();
  const { profile, hasFeature, hasRole, isAdmin } = useAuth();

  const role = profile?.role;

  // EFFECTIVE roles, via hasRole/isAdmin, not the raw profile columns. Two
  // things were wrong with reading profile.role directly:
  //
  //  * "View As" was ignored here, so an admin previewing graphics production
  //    stayed on the ops Dashboard — invoiced dollars, PO backlog, pipeline —
  //    and the one tool for checking what a role sees showed something no
  //    graphics account can reach. A preview that lies is worse than none.
  //  * The legacy `production` role value never matched 'graphics_production',
  //    so an account still carrying it skipped this redirect and landed on the
  //    money dashboard for real. AuthProvider normalises that value; reading
  //    through hasRole picks the normalisation up instead of re-deriving it.
  const isOnlyRole = (r: string) => hasRole(r) && !isAdmin;

  // Redirect only when the destination's feature gate would admit the user —
  // the gated pages bounce back to /home, so an unguarded redirect plus a
  // per-user feature revoke forms an infinite /home ↔ page loop.
  const scanOk = hasFeature('scan');
  const isTech = isOnlyRole('field_tech') || isOnlyRole('shop_tech');

  useEffect(() => {
    if (!role) return;
    // Redirect roles to their dedicated home screens
    if (role === 'customer') { router.replace('/customer/dashboard'); return; }
    // Field and shop techs get their own Home ("My week" + "Up next", owner
    // decision 2026-09-29) with Scan / Check In on top, so they stay here.
    // Contract installers still land on Scan.
    if (isOnlyRole('installer') && !isTech && scanOk) { router.replace('/scan'); return; }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: re-run when the effective role changes (including View As)
  }, [role, isAdmin, scanOk, isTech]);

  if (role === 'customer') return null;
  if (isOnlyRole('graphics_production')) return <MyHome role="graphics" />;
  // Shop first: its view is the superset (check-ins and completions plus installs).
  if (isOnlyRole('shop_tech')) return <MyHome role="shop_tech" />;
  if (isOnlyRole('field_tech')) return <MyHome role="field_tech" />;
  if (isOnlyRole('installer') && scanOk) return null;

  // Admin, Sales, Super Admin, and Executive get the dashboard
  return <AdminDashboard />;
}
