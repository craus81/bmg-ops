'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import TopSaveBar from '@/components/TopSaveBar';
import {
  FEATURES, EDITABLE_ROLES, SUPER_ADMIN_FEATURES, canGrantToRole, roleFeatures, roleDefaultFeatures,
  type FeatureKey, type RoleFeatureSetting,
} from '@/lib/features';
import { ROLE_LABELS, type AppRole } from '@/lib/types';

// More → Admin → Permissions (owner ask 2026-10-20): pick a user type, flip
// what it can use, save. Role-wide switches live in role_feature_settings
// (migration 418) and are applied by resolveFeatures on the client AND the
// server, so a switch really opens or closes the page and its API. One
// person's exceptions stay on the Users page. Super admins only.

// Screen groups. A feature key added to FEATURES later and not listed here
// still shows, under "Other", so new pages always get a switch.
const GROUPS: { title: string; keys: FeatureKey[] }[] = [
  { title: 'Everyday', keys: ['home', 'scan', 'fleet_checkin', 'in_shop', 'schedule', 'messages'] },
  { title: 'Files & Follow-up', keys: ['client_files', 'completion_photos', 'after_hours_calls', 'qc_fixes'] },
  { title: 'Sales & Customers', keys: ['prospects', 'customers', 'estimates', 'quotes', 'invoicing', 'credit_applications', 'upfit_configurator'] },
  { title: 'Production', keys: ['graphics', 'graphics_builder', 'install_guides', 'upfit_projects', 'proof_search', 'install_admin'] },
  { title: 'Parts & Purchasing', keys: ['parts_catalog', 'parts_ordering', 'purchase_orders', 'part_admin'] },
  { title: 'Money & Reports', keys: ['see_prices', 'reports', 'vendor_payments', 'ledger', 'financials', 'payroll', 'invoice_admin'] },
  { title: 'CNI Network', keys: ['cni_portal', 'cni_admin'] },
  { title: 'Admin Tools', keys: ['bulk_upload', 'data_import', 'proof_admin', 'user_management', 'audit_log', 'system_health', 'ai_instructions', 'knowledge_base'] },
];

// What a few switches open, where the feature name alone doesn't say.
const HINTS: Partial<Record<FeatureKey, string>> = {
  scan: 'Scan a VIN and pick the parts used',
  fleet_checkin: 'Also opens the In-Shop tab',
  customers: 'Customer Notifications page',
  prospects: 'The Customers tab and sales pipeline',
  parts_catalog: 'Also Inventory and Rack Kits',
  parts_ordering: 'Purchasing and Receiving',
  reports: 'Scan Log and Reports',
  vendor_payments: 'Payments (AP)',
  financials: 'The executive P&L on Home',
  cni_portal: 'CNI Jobs: bids, schedule, photos, invoices',
  cni_admin: 'Jobs, companies, installers',
  part_admin: 'Part tagging, dimensions, vehicle interiors, vendor costs',
  see_prices: 'Customer prices, our cost and margin on every screen',
  quotes: 'Quotes list, follow-ups, unmatched sales orders',
  invoicing: 'Create and email NetSuite invoices',
  qc_fixes: 'Issues Masterack’s QC team reports',
};

const OUTSIDE_ROLES = ['installer', 'customer', 'executive'];

export default function PermissionsPage() {
  const router = useRouter();
  const { user, hasRole, loading: authLoading, viewAsRole } = useAuth();
  const isSuperAdmin = hasRole('super_admin');

  const [saved, setSaved] = useState<RoleFeatureSetting[]>([]);
  const [role, setRole] = useState<string>('shop_tech');
  const [pending, setPending] = useState<Record<string, Set<FeatureKey>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !user) return;
    if (!isSuperAdmin) router.push('/home');
  }, [authLoading, user, isSuperAdmin, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/role-permissions');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Couldn't load permissions (${res.status})`);
      setSaved(data.settings || []);
      setPending({});
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Couldn’t load permissions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isSuperAdmin) load(); }, [isSuperAdmin, load]);

  const savedFor = useCallback((r: string) => roleFeatures(r, saved), [saved]);
  const current = pending[role] ?? savedFor(role);
  const defaults = useMemo(() => roleDefaultFeatures(role), [role]);
  const savedSet = useMemo(() => savedFor(role), [savedFor, role]);

  const groups = useMemo(() => {
    const listed = new Set(GROUPS.flatMap(g => g.keys));
    const other = (Object.keys(FEATURES) as FeatureKey[]).filter(k => !listed.has(k));
    return other.length > 0 ? [...GROUPS, { title: 'Other', keys: other }] : GROUPS;
  }, []);

  const unsavedCount = (r: string) => {
    const p = pending[r];
    if (!p) return 0;
    const s = savedFor(r);
    return (Object.keys(FEATURES) as FeatureKey[]).filter(k => p.has(k) !== s.has(k)).length;
  };
  const totalUnsaved = EDITABLE_ROLES.reduce((n, r) => n + unsavedCount(r), 0);

  const toggle = (key: FeatureKey) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    setPending(p => ({ ...p, [role]: next }));
    setNotice(null);
  };

  const resetRole = () => {
    setPending(p => ({ ...p, [role]: new Set(defaults) }));
    setNotice(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const r of EDITABLE_ROLES) {
        const p = pending[r];
        if (!p) continue;
        const s = savedFor(r);
        const changes = (Object.keys(FEATURES) as FeatureKey[])
          .filter(k => p.has(k) !== s.has(k))
          .map(k => ({ feature: k, granted: p.has(k) }));
        if (changes.length === 0) continue;
        const res = await fetch('/api/admin/role-permissions', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: r, changes }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Couldn't save ${roleLabel(r)} (${res.status})`);
        setSaved(data.settings || []);
        setPending(prev => { const n = { ...prev }; delete n[r]; return n; });
      }
      setNotice('Saved. People see the change the next time they open the app or switch back to it.');
    } catch (e: any) {
      setError(e?.message || 'Couldn’t save');
    } finally {
      setSaving(false);
    }
  };

  if (!user || !isSuperAdmin) return null;

  return (
    <div style={{ paddingBottom: '80px' }}>
      <TopSaveBar
        title={`Permissions · ${roleLabel(role)}`}
        subtitle={notice || (totalUnsaved > 0 ? `${totalUnsaved} change${totalUnsaved === 1 ? '' : 's'} not saved` : 'No changes')}
        onSave={save}
        saving={saving}
        disabled={totalUnsaved === 0}
        extra={(
          <button
            onClick={resetRole}
            disabled={saving}
            title={`Reset ${roleLabel(role)} to normal`}
            style={{ padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, background: 'var(--subtle-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)', cursor: 'pointer' }}
          >Reset</button>
        )}
      />
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Permissions</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', maxWidth: '720px' }}>
          Pick a user type, then switch what it can use. A switch changes everyone with that role.
          To make an exception for one person, open them on User Management. Super Admin always has everything.
          Books stays super-admin only until FleetSuite’s books replace NetSuite.
        </div>
        {viewAsRole && (
          <div style={{ fontSize: '12px', color: 'var(--orange)', marginTop: '6px' }}>
            You’re using View As. This screen still edits the real settings.
          </div>
        )}
      </div>

      <div role="tablist" aria-label="User type" style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px', marginBottom: '12px' }}>
        {EDITABLE_ROLES.map(r => {
          const active = r === role;
          const n = unsavedCount(r);
          return (
            <button
              key={r}
              role="tab"
              aria-selected={active}
              onClick={() => setRole(r)}
              style={{
                flex: 'none', padding: '6px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 600,
                border: `1px solid ${active ? 'var(--orange)' : 'var(--border)'}`,
                background: active ? 'var(--orange)' : 'var(--card)',
                color: active ? '#fff' : 'var(--text-primary)', cursor: 'pointer',
              }}
            >
              {roleLabel(r)}{n > 0 ? ` • ${n}` : ''}
            </button>
          );
        })}
      </div>

      {OUTSIDE_ROLES.includes(role) && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '8px 12px', marginBottom: '12px' }}>
          {role === 'executive'
            ? 'Executive isn’t a BMG staff role, so it can only turn off what it has.'
            : 'This login belongs to someone outside BMG, so it can only turn off what it has. The rest of the app’s data stays closed to it.'}
        </div>
      )}

      {error && <div style={{ fontSize: '12px', color: '#ef4444', marginBottom: '10px' }}>{error}</div>}

      {loading ? (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {groups.map(g => (
            <div key={g.title}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '6px' }}>
                {g.title}
              </div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
                {g.keys.map((key, i) => {
                  const on = current.has(key);
                  const locked = !on && !canGrantToRole(role, key);
                  const unsaved = on !== savedSet.has(key);
                  const offDefault = on !== defaults.has(key);
                  return (
                    <div key={key} style={{
                      display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                      borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                      background: unsaved ? 'var(--subtle-bg)' : 'transparent',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 500 }}>{FEATURES[key]}</div>
                        {HINTS[key] && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{HINTS[key]}</div>}
                        {locked && (
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            {SUPER_ADMIN_FEATURES.includes(key) ? 'Super admin only. Give it to one person on User Management.' : 'BMG staff roles only'}
                          </div>
                        )}
                        {offDefault && (
                          <div style={{ fontSize: '11px', color: 'var(--orange)', fontWeight: 600 }}>
                            {on ? 'On for this role (normally off)' : 'Off for this role (normally on)'}{unsaved ? ', not saved yet' : ''}
                          </div>
                        )}
                        {!offDefault && unsaved && (
                          <div style={{ fontSize: '11px', color: 'var(--orange)', fontWeight: 600 }}>Back to normal, not saved yet</div>
                        )}
                      </div>
                      <button
                        role="switch"
                        aria-checked={on}
                        aria-label={FEATURES[key]}
                        disabled={locked || saving}
                        onClick={() => toggle(key)}
                        style={{
                          flex: 'none', width: '44px', height: '26px', borderRadius: '999px', border: 'none', position: 'relative',
                          background: on ? '#22c55e' : 'var(--border)', opacity: locked ? 0.45 : 1,
                          cursor: locked || saving ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <span style={{
                          position: 'absolute', top: '3px', left: on ? '21px' : '3px', width: '20px', height: '20px',
                          borderRadius: '50%', background: '#fff', transition: 'left .15s',
                        }} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

function roleLabel(r: string): string {
  if (r === 'installer') return 'CNI Installer';
  if (r === 'shop_tech') return 'Shop Tech';
  return ROLE_LABELS[r as AppRole] || r;
}
