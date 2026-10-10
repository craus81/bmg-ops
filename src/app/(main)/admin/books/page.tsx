'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';

/**
 * Books → Chart of accounts (migrations 359/360, docs/books.md).
 *
 * FleetSuite's own books are built hidden: super admins only, and no menu
 * links here yet. Read-only — until the changeover the accounts are copied
 * from NetSuite every two hours (or on "Sync now"), so they're added and
 * changed there.
 */

interface Account {
  id: string;
  number: string | null;
  name: string;
  account_type: string;
  parent_id: string | null;
  company_id: string | null;
  is_control: boolean;
  is_summary: boolean;
  active: boolean;
  description: string | null;
  netsuite_account_id: string | null;
  sync_issue: string | null;
}

interface Company {
  id: string;
  code: string;
  name: string;
  netsuite_subsidiary_id: string | null;
  books_live_from: string | null;
}

interface SyncResult {
  received?: number;
  added?: number;
  changed?: number;
  gone?: number;
  issues?: { issue: string; number?: string | null; name?: string }[];
  skipped?: Record<string, number>;
  unknownTypes?: string[];
  notes?: string[];
  error?: string;
}

// Balance sheet first, then the income statement, in the order NetSuite lists them.
const TYPES: [string, string][] = [
  ['bank', 'Bank'],
  ['accounts_receivable', 'Accounts receivable'],
  ['unbilled_receivable', 'Unbilled receivable'],
  ['other_current_asset', 'Other current asset'],
  ['fixed_asset', 'Fixed asset'],
  ['other_asset', 'Other asset'],
  ['deferred_expense', 'Deferred expense'],
  ['accounts_payable', 'Accounts payable'],
  ['credit_card', 'Credit card'],
  ['other_current_liability', 'Other current liability'],
  ['long_term_liability', 'Long-term liability'],
  ['deferred_revenue', 'Deferred revenue'],
  ['equity', 'Equity'],
  ['income', 'Income'],
  ['other_income', 'Other income'],
  ['cost_of_goods_sold', 'Cost of goods sold'],
  ['expense', 'Expense'],
  ['other_expense', 'Other expense'],
];

const SKIPPED_LABELS: Record<string, string> = { NonPosting: 'non-posting', Stat: 'statistical' };

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const chip = (color: string): React.CSSProperties => ({
  fontSize: '10px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
  border: `1px solid ${color}55`, color,
});

export default function BooksAccountsPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [lastSync, setLastSync] = useState<{ at: string; result: SyncResult } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/books/accounts');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setAccounts(json.accounts || []);
      setCompanies(json.companies || []);
      setLastSync(json.lastSync || null);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the chart of accounts');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  // How the sync went is recorded either way and shows in the banner after
  // the reload; syncError is only for a request that never got that far.
  const syncNow = async () => {
    setSyncing(true);
    setSyncError('');
    try {
      const res = await apiFetch('/api/admin/books/accounts', { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `Sync failed (${res.status})`);
      }
    } catch (e: any) {
      setSyncError(e?.message || 'Sync failed');
    }
    await load();
    setSyncing(false);
  };

  const companyById = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);

  // How deep each account sits under its headings, for the indent.
  const depthOf = useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const depth = new Map<string, number>();
    for (const a of accounts) {
      let d = 0;
      let p = a.parent_id ? byId.get(a.parent_id) : undefined;
      while (p && d < 8) { d++; p = p.parent_id ? byId.get(p.parent_id) : undefined; }
      depth.set(a.id, d);
    }
    return depth;
  }, [accounts]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts.filter((a) => (showInactive || a.active)
      && (!q || `${a.number ?? ''} ${a.name}`.toLowerCase().includes(q)));
  }, [accounts, search, showInactive]);

  const result = lastSync?.result;
  const inactiveCount = accounts.filter((a) => !a.active).length;

  return (
    <div>
      <div style={{ marginBottom: '14px', display: 'flex', gap: '12px', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px' }}>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>Chart of accounts</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            FleetSuite&apos;s own books, visible only to super admins while they&apos;re built. Until the changeover these
            accounts are copied from NetSuite every two hours, so add or change an account in NetSuite.
          </div>
        </div>
        <button
          onClick={syncNow}
          disabled={syncing || loading}
          style={{
            padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
            color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: syncing ? 'wait' : 'pointer',
          }}
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {error && <div style={banner('#ef4444')}>{error}</div>}
      {syncError && <div style={banner('#ef4444')}>{syncError}</div>}

      {!loading && !error && (
        <>
          {!lastSync && (
            <div style={banner('#fbbf24')}>No NetSuite account sync has run yet. It runs every two hours, or press Sync now.</div>
          )}
          {result?.error && (
            <div style={banner('#ef4444')}>The last sync failed {ago(lastSync!.at)}: {result.error}</div>
          )}
          {lastSync && !result?.error && (
            <div style={banner('#22c55e')}>
              Synced {ago(lastSync.at)}: {result?.received ?? 0} accounts from NetSuite
              ({result?.added ?? 0} added, {result?.changed ?? 0} changed, {result?.gone ?? 0} gone from NetSuite).
              {result?.skipped && Object.keys(result.skipped).length > 0 && (
                <span style={{ fontWeight: 400 }}>
                  {' '}Left out: {Object.entries(result.skipped).map(([t, n]) => `${n} ${SKIPPED_LABELS[t] ?? t}`).join(', ')}.
                </span>
              )}
            </div>
          )}
          {(result?.notes ?? []).map((n) => <div key={n} style={banner('#fbbf24')}>{n}</div>)}
          {(result?.unknownTypes ?? []).length > 0 && (
            <div style={banner('#fbbf24')}>
              NetSuite account types FleetSuite doesn&apos;t know yet, so those accounts were left out: {result!.unknownTypes!.join(', ')}.
            </div>
          )}
          {(result?.issues ?? []).map((i) => (
            <div key={`${i.number}-${i.issue}`} style={banner('#fbbf24')}>
              {i.number || i.name ? `${[i.number, i.name].filter(Boolean).join(' ')}: ` : ''}{i.issue}
            </div>
          ))}

          <div style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 12px' }}>
            {companies.map((c) => (
              <span key={c.id} style={{ marginRight: '14px' }}>
                <strong style={{ color: 'var(--text-secondary)' }}>{c.name}</strong>
                {' — '}{c.netsuite_subsidiary_id ? `NetSuite subsidiary ${c.netsuite_subsidiary_id}` : 'not linked to NetSuite yet'}
                {c.books_live_from ? `, live from ${c.books_live_from}` : ''}
              </span>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search number or name"
              style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', minWidth: '220px' }}
            />
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show inactive ({inactiveCount})
            </label>
          </div>

          {accounts.length === 0 && (
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No accounts yet.</div>
          )}

          {TYPES.map(([type, label]) => {
            const rows = visible.filter((a) => a.account_type === type);
            if (rows.length === 0) return null;
            return (
              <div key={type} style={{ marginBottom: '14px' }}>
                <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  {label} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({rows.length})</span>
                </div>
                <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
                  {rows.map((a, idx) => {
                    const company = a.company_id ? companyById.get(a.company_id) : null;
                    return (
                      <div key={a.id} style={{
                        display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 12px', fontSize: '13px',
                        borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                        background: 'var(--card)', opacity: a.active ? 1 : 0.55,
                      }}>
                        <span style={{ width: '70px', flexShrink: 0, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{a.number ?? '—'}</span>
                        <span
                          title={a.description ?? undefined}
                          style={{ flex: 1, minWidth: 0, paddingLeft: `${(depthOf.get(a.id) ?? 0) * 16}px`, fontWeight: a.is_summary ? 700 : 400 }}
                        >
                          {a.name}
                        </span>
                        <span style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {company && <span style={chip('#60a5fa')}>{company.code} only</span>}
                          {a.is_summary && <span style={chip('#a78bfa')}>Heading</span>}
                          {a.is_control && <span style={chip('#94a3b8')}>Control</span>}
                          {!a.active && <span style={chip('#94a3b8')}>Inactive</span>}
                          {!a.netsuite_account_id && <span style={chip('#94a3b8')}>FleetSuite only</span>}
                          {a.sync_issue && <span style={chip('#fbbf24')} title={a.sync_issue}>⚠ Needs a look</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Loading…</div>}
    </div>
  );
}
