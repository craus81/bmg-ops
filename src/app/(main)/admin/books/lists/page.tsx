'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';

/**
 * Books → NetSuite lists (migration 363, docs/books.md).
 *
 * The lists FleetSuite's posting rules need, copied from NetSuite every two
 * hours (or on "Sync now"): locations, departments, classes, terms and tax
 * codes, plus the accounts each item and vendor posts to, where sales tax
 * posts, and where items with no income account post. Read-only and super
 * admins only while the books are built, linked from the accounts page.
 */

type Kind = 'location' | 'department' | 'class' | 'term' | 'tax_code' | 'vendor' | 'item' | 'customer';
/** The lists too long to send whole, looked up instead. */
type LongKind = 'vendor' | 'item' | 'customer';

interface ListRow {
  kind: Kind;
  netsuite_id: string;
  name: string;
  parent_netsuite_id: string | null;
  active: boolean;
  details: Record<string, string | number>;
  gone_at: string | null;
}

interface Overview {
  counts?: { kind: Kind; listed: number; active: number; gone: number }[];
  usage?: { kind: Kind | 'all'; netsuite_id: string | null; lines: number }[];
  accounts?: { kind: Kind; field: string; netsuite_account_id: string | null; item_type: string | null; rows: number }[];
}

interface ListResult {
  received?: number;
  added?: number;
  changed?: number;
  gone?: number;
  missing?: string[];
  skipped?: boolean;
  error?: string;
}

interface SyncResult {
  lists?: Partial<Record<Kind, ListResult>>;
  taxAccounts?: { tax_code_id: string | null; account_id: string; lines: number }[];
  itemAccounts?: { item_id: string; item_name: string; account_id: string; lines: number }[];
  notes?: string[];
  error?: string;
}

interface Payload {
  lists: ListRow[];
  accounts: { netsuite_account_id: string; number: string | null; name: string }[];
  overview: Overview;
  lastSync: { at: string; result: SyncResult } | null;
}

interface Lookup {
  title: string;
  rows: ListRow[];
  total: number;
}

const TABS: [Kind, string][] = [
  ['location', 'Locations'],
  ['department', 'Departments'],
  ['class', 'Classes'],
  ['term', 'Terms'],
  ['tax_code', 'Tax codes'],
  ['vendor', 'Vendors'],
  ['item', 'Items'],
  ['customer', 'Customers'],
];

const PLURAL: Record<Kind, string> = {
  location: 'locations', department: 'departments', class: 'classes', term: 'terms',
  tax_code: 'tax codes', vendor: 'vendors', item: 'items', customer: 'customers',
};
const SINGULAR: Record<Kind, string> = {
  location: 'location', department: 'department', class: 'class', term: 'term',
  tax_code: 'tax code', vendor: 'vendor', item: 'item', customer: 'customer',
};

/** The accounts each item and vendor posts to, in the order the page shows them. */
const ACCOUNT_FIELDS: Record<'item' | 'vendor', [string, string][]> = {
  item: [['income_account', 'Income account'], ['asset_account', 'Asset account'], ['expense_account', 'Expense account']],
  vendor: [['expense_account', 'Default expense account'], ['payables_account', 'Payables account']],
};

const n = (v: number) => v.toLocaleString('en-US');
/** "1 department", "18 classes". */
const howMany = (v: number, kind: Kind) => `${n(v)} ${v === 1 ? SINGULAR[kind] : PLURAL[kind]}`;

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

const box: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', marginBottom: '12px' };
const muted: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)' };
const heading: React.CSSProperties = { fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)', margin: '14px 0 6px' };

function rowStyle(idx: number, dim: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 12px', fontSize: '13px',
    borderTop: idx === 0 ? 'none' : '1px solid var(--border)', background: 'var(--card)', opacity: dim ? 0.55 : 1,
  };
}

/** Parents before their children, each level by name, with how deep each sits. */
function treeOrder(rows: ListRow[]): { row: ListRow; depth: number }[] {
  const ids = new Set(rows.map((r) => r.netsuite_id));
  const children = new Map<string | null, ListRow[]>();
  for (const r of rows) {
    const parent = r.parent_netsuite_id && r.parent_netsuite_id !== r.netsuite_id && ids.has(r.parent_netsuite_id)
      ? r.parent_netsuite_id : null;
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const out: { row: ListRow; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const r of [...(children.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(r.netsuite_id)) continue;
      seen.add(r.netsuite_id);
      out.push({ row: r, depth });
      walk(r.netsuite_id, depth + 1);
    }
  };
  walk(null, 0);
  // Rows whose parents point at each other are never reached from the top; list them there.
  for (const r of rows) if (!seen.has(r.netsuite_id)) out.push({ row: r, depth: 0 });
  return out;
}

function StatusChips({ row }: { row: ListRow }) {
  return (
    <span style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {!row.active && <span style={chip('#94a3b8')}>Inactive</span>}
      {row.gone_at && <span style={chip('#fbbf24')}>Gone from NetSuite</span>}
    </span>
  );
}

export default function BooksListsPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Kind>('location');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupError, setLookupError] = useState('');
  const [lookingUp, setLookingUp] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/books/lists');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json as Payload);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the NetSuite lists');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  // How the copy went is recorded either way and shows in the banner after
  // the reload; syncError is only for a request that never got that far.
  const syncNow = async () => {
    setSyncing(true);
    setSyncError('');
    try {
      const res = await apiFetch('/api/admin/books/lists', { method: 'POST' });
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

  const runLookup = async (params: Record<string, string>, title: string) => {
    setLookingUp(true);
    setLookupError('');
    try {
      const res = await apiFetch(`/api/admin/books/lists?${new URLSearchParams(params)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setLookup({ title, rows: json.rows || [], total: json.total ?? 0 });
    } catch (e: any) {
      setLookupError(e?.message || 'Lookup failed');
    }
    setLookingUp(false);
  };

  const switchTab = (k: Kind) => {
    setTab(k);
    setQuery('');
    setLookup(null);
    setLookupError('');
  };

  const accountLabel = useMemo(() => {
    const byId = new Map((data?.accounts ?? []).map((a) => [a.netsuite_account_id, a]));
    return (id: string | number | null | undefined): string => {
      if (id === null || id === undefined || id === '') return 'None set';
      const a = byId.get(String(id));
      return a ? [a.number, a.name].filter(Boolean).join(' ') : `NetSuite account ${id}`;
    };
  }, [data]);

  const byKind = useMemo(() => {
    const out = new Map<Kind, ListRow[]>();
    for (const row of data?.lists ?? []) out.set(row.kind, [...(out.get(row.kind) ?? []), row]);
    for (const rows of out.values()) rows.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [data]);

  const counts = useMemo(() => new Map((data?.overview.counts ?? []).map((c) => [c.kind, c])), [data]);
  const result = data?.lastSync?.result;
  const lists = result?.lists ?? {};

  const usageOf = (kind: Kind) => {
    const rows = (data?.overview.usage ?? []).filter((u) => u.kind === kind);
    return {
      byId: new Map(rows.filter((u) => u.netsuite_id).map((u) => [u.netsuite_id as string, u.lines])),
      none: rows.find((u) => !u.netsuite_id)?.lines ?? 0,
      all: (data?.overview.usage ?? []).find((u) => u.kind === 'all')?.lines ?? 0,
    };
  };

  const termName = (id: string | number | undefined) => {
    if (id === undefined) return '—';
    return (byKind.get('term') ?? []).find((t) => t.netsuite_id === String(id))?.name ?? `NetSuite terms ${id}`;
  };

  // ── Locations, departments, classes ──────────────────────────────────────
  const renderShort = (kind: 'location' | 'department' | 'class') => {
    const rows = byKind.get(kind) ?? [];
    const usage = usageOf(kind);
    const ids = new Set(rows.map((r) => r.netsuite_id));
    const unknown = [...usage.byId].filter(([id]) => !ids.has(id));
    const singular = kind === 'class' ? 'class' : kind;
    return (
      <>
        {rows.length === 0 ? (
          <div style={muted}>No {PLURAL[kind]} copied from NetSuite.</div>
        ) : (
          <div style={box}>
            <div style={{ ...rowStyle(0, false), fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>
              <span style={{ flex: 1 }}>Name</span>
              <span style={{ width: '90px', textAlign: 'right' }}>NetSuite id</span>
              <span style={{ width: '150px', textAlign: 'right' }}>GL lines since 2025</span>
              <span style={{ width: '120px' }} />
            </div>
            {treeOrder(rows).map(({ row: r, depth }) => (
              <div key={r.netsuite_id} style={rowStyle(1, !r.active || !!r.gone_at)}>
                <span style={{ flex: 1, minWidth: 0, paddingLeft: `${depth * 16}px` }} title={String(r.details.full_name ?? '')}>{r.name}</span>
                <span style={{ width: '90px', textAlign: 'right', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{r.netsuite_id}</span>
                <span style={{ width: '150px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{n(usage.byId.get(r.netsuite_id) ?? 0)}</span>
                <span style={{ width: '120px' }}><StatusChips row={r} /></span>
              </div>
            ))}
          </div>
        )}
        {usage.all > 0 && (
          <div style={muted}>
            {n(usage.none)} of the {n(usage.all)} GL lines copied since January 2025 have no {singular}.
            {unknown.length > 0 && ` Lines also carry ${singular} ids that aren't in this list: ${unknown.map(([id, lines]) => `${id} (${n(lines)})`).join(', ')}.`}
          </div>
        )}
      </>
    );
  };

  // ── Terms ────────────────────────────────────────────────────────────────
  const renderTerms = () => {
    const rows = byKind.get('term') ?? [];
    if (rows.length === 0) return <div style={muted}>No terms copied from NetSuite.</div>;
    return (
      <div style={box}>
        <div style={{ ...rowStyle(0, false), fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>
          <span style={{ flex: 1 }}>Terms</span>
          <span style={{ width: '110px' }}>Due</span>
          <span style={{ width: '200px' }}>Early payment discount</span>
          <span style={{ width: '120px' }} />
        </div>
        {rows.map((r) => {
          const days = r.details.days_until_net_due;
          const pct = Number(r.details.discount_percent ?? 0);
          const within = r.details.discount_days;
          return (
            <div key={r.netsuite_id} style={rowStyle(1, !r.active || !!r.gone_at)}>
              <span style={{ flex: 1, minWidth: 0 }}>{r.name}</span>
              <span style={{ width: '110px' }}>{days !== undefined ? `${days} days` : '—'}</span>
              <span style={{ width: '200px' }}>{pct > 0 ? `${pct}%${within !== undefined ? ` within ${within} days` : ''}` : '—'}</span>
              <span style={{ width: '120px' }}><StatusChips row={r} /></span>
            </div>
          );
        })}
      </div>
    );
  };

  // ── Tax codes ────────────────────────────────────────────────────────────
  const renderTaxCodes = () => {
    const rows = byKind.get('tax_code') ?? [];
    const nameOf = (id: string | null) => (id === null
      ? 'No tax code on the line'
      : rows.find((r) => r.netsuite_id === id)?.name ?? `NetSuite tax code ${id}`);
    return (
      <>
        {rows.length === 0 ? (
          <div style={muted}>No tax codes copied from NetSuite.</div>
        ) : (
          <div style={box}>
            <div style={{ ...rowStyle(0, false), fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>
              <span style={{ flex: 1 }}>Tax code</span>
              <span style={{ width: '90px' }}>Rate</span>
              <span style={{ flex: 1 }}>Description</span>
              <span style={{ width: '120px' }} />
            </div>
            {rows.map((r) => (
              <div key={r.netsuite_id} style={rowStyle(1, !r.active || !!r.gone_at)}>
                <span style={{ flex: 1, minWidth: 0 }}>{r.name}</span>
                <span style={{ width: '90px' }}>{r.details.rate !== undefined ? String(r.details.rate) : '—'}</span>
                <span style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)' }}>{String(r.details.description ?? '')}</span>
                <span style={{ width: '120px' }}><StatusChips row={r} /></span>
              </div>
            ))}
          </div>
        )}
        <div style={heading}>Where sales tax posted since January 2025</div>
        {!result?.taxAccounts ? (
          <div style={muted}>Not read yet. It&apos;s read with the tax codes.</div>
        ) : result.taxAccounts.length === 0 ? (
          <div style={muted}>NetSuite has no sales tax lines since January 2025.</div>
        ) : (
          <div style={box}>
            <div style={{ ...rowStyle(0, false), fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>
              <span style={{ flex: 1 }}>Tax code</span>
              <span style={{ flex: 1 }}>Account</span>
              <span style={{ width: '110px', textAlign: 'right' }}>GL lines</span>
            </div>
            {result.taxAccounts.map((t) => (
              <div key={`${t.tax_code_id}-${t.account_id}`} style={rowStyle(1, false)}>
                <span style={{ flex: 1, minWidth: 0 }}>{nameOf(t.tax_code_id)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>{accountLabel(t.account_id)}</span>
                <span style={{ width: '110px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{n(t.lines)}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  };

  // ── Vendors and items ────────────────────────────────────────────────────
  const taxCodeName = (id: string | number | undefined) => {
    if (id === undefined) return '—';
    return (byKind.get('tax_code') ?? []).find((t) => t.netsuite_id === String(id))?.name ?? `NetSuite tax code ${id}`;
  };

  /** A customer's terms and how NetSuite taxes them, which FleetSuite's own invoices go by. */
  const renderCustomerRows = (rows: ListRow[]) => (
    <div style={box}>
      <div style={{ ...rowStyle(0, false), fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>
        <span style={{ flex: 1 }}>Customer</span>
        <span style={{ width: '110px' }}>Terms</span>
        <span style={{ width: '90px' }}>Taxed</span>
        <span style={{ flex: 1 }}>Tax code</span>
        <span style={{ width: '120px' }} />
      </div>
      {rows.map((r) => (
        <div key={r.netsuite_id} style={rowStyle(1, !r.active || !!r.gone_at)}>
          <span style={{ flex: 1, minWidth: 0 }} title={`NetSuite id ${r.netsuite_id}`}>
            {r.name}
            {r.details.entity_id && <span style={{ color: 'var(--text-muted)' }}> · {String(r.details.entity_id)}</span>}
          </span>
          <span style={{ width: '110px' }}>{termName(r.details.terms_id)}</span>
          <span style={{ width: '90px', color: r.details.taxable === undefined ? 'var(--text-muted)' : undefined }}>
            {r.details.taxable === undefined ? '—' : r.details.taxable === 'T' ? 'Yes' : 'No'}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>{taxCodeName(r.details.tax_item_id)}</span>
          <span style={{ width: '120px' }}><StatusChips row={r} /></span>
        </div>
      ))}
    </div>
  );

  const renderLookupRows = (kind: 'vendor' | 'item', rows: ListRow[]) => (
    <div style={box}>
      <div style={{ ...rowStyle(0, false), fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>
        <span style={{ flex: 1 }}>{kind === 'item' ? 'Item' : 'Vendor'}</span>
        {kind === 'item' && <span style={{ width: '90px' }}>Type</span>}
        {ACCOUNT_FIELDS[kind].map(([, label]) => <span key={label} style={{ flex: 1 }}>{label}</span>)}
        {kind === 'vendor' && <span style={{ width: '110px' }}>Terms</span>}
        <span style={{ width: '120px' }} />
      </div>
      {rows.map((r) => (
        <div key={r.netsuite_id} style={rowStyle(1, !r.active || !!r.gone_at)}>
          <span style={{ flex: 1, minWidth: 0 }} title={`NetSuite id ${r.netsuite_id}`}>
            {r.name}
            {r.details.display_name && <span style={{ color: 'var(--text-muted)' }}> · {String(r.details.display_name)}</span>}
          </span>
          {kind === 'item' && <span style={{ width: '90px', color: 'var(--text-secondary)' }}>{String(r.details.item_type ?? '')}</span>}
          {ACCOUNT_FIELDS[kind].map(([field]) => (
            <span key={field} style={{ flex: 1, minWidth: 0, color: r.details[field] === undefined ? 'var(--text-muted)' : undefined }}>
              {accountLabel(r.details[field])}
            </span>
          ))}
          {kind === 'vendor' && <span style={{ width: '110px' }}>{termName(r.details.terms_id)}</span>}
          <span style={{ width: '120px' }}><StatusChips row={r} /></span>
        </div>
      ))}
    </div>
  );

  const renderCustomerCount = () => {
    const count = counts.get('customer');
    const missing = lists.customer?.missing ?? [];
    return (
      <div style={{ ...muted, marginBottom: '8px' }}>
        {count ? `${howMany(count.listed, 'customer')} in NetSuite, ${n(count.active)} active.` : 'No customers copied from NetSuite yet.'}
        {' '}FleetSuite&apos;s own invoices take each customer&apos;s terms from here.
        {missing.length > 0 && " NetSuite didn't give all of their details on the last copy."}
      </div>
    );
  };

  const renderAccounts = (kind: 'vendor' | 'item') => {
    const groups = (data?.overview.accounts ?? []).filter((a) => a.kind === kind);
    const missing = lists[kind]?.missing ?? [];
    const count = counts.get(kind);
    return (
      <>
        <div style={{ ...muted, marginBottom: '8px' }}>
          {count ? `${howMany(count.listed, kind)} in NetSuite, ${n(count.active)} active.` : `No ${PLURAL[kind]} copied from NetSuite yet.`}
          {' '}The accounts below are counted over the active ones.
        </div>
        {ACCOUNT_FIELDS[kind].map(([field, label]) => {
          const buckets = new Map<string | null, { rows: number; types: Map<string, number> }>();
          for (const g of groups.filter((x) => x.field === field)) {
            const b = buckets.get(g.netsuite_account_id) ?? { rows: 0, types: new Map<string, number>() };
            b.rows += g.rows;
            if (g.item_type) b.types.set(g.item_type, (b.types.get(g.item_type) ?? 0) + g.rows);
            buckets.set(g.netsuite_account_id, b);
          }
          const sorted = [...buckets].sort((a, b) => b[1].rows - a[1].rows);
          return (
            <div key={field}>
              <div style={heading}>{label}</div>
              {missing.includes(field) ? (
                <div style={muted}>NetSuite didn&apos;t give these on the last copy.</div>
              ) : sorted.length === 0 ? (
                <div style={muted}>None yet.</div>
              ) : (
                <div style={box}>
                  {sorted.map(([account, b], idx) => (
                    <div key={account ?? 'none'} style={rowStyle(idx, false)}>
                      <span style={{ flex: 1, minWidth: 0, color: account === null ? 'var(--text-muted)' : undefined }}>
                        {accountLabel(account)}
                        {kind === 'item' && b.types.size > 0 && (
                          <span style={{ color: 'var(--text-muted)' }}>
                            {' '}({[...b.types].sort((x, y) => y[1] - x[1]).map(([t, c]) => `${t} ${n(c)}`).join(' · ')})
                          </span>
                        )}
                      </span>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{howMany(b.rows, kind)}</span>
                      <button
                        onClick={() => runLookup(
                          { kind, field, account: account ?? 'none' },
                          `Active ${PLURAL[kind]} with ${label.toLowerCase()} ${accountLabel(account)}`,
                        )}
                        disabled={lookingUp}
                        style={{
                          padding: '2px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)',
                          color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                        }}
                      >
                        Show
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </>
    );
  };

  // ── Where items with no income account post ─────────────────────────────
  const renderItemPostings = () => (
    <>
      <div style={heading}>Where items with no income account posted on invoices since January 2025</div>
      <div style={{ ...muted, marginBottom: '6px' }}>
        Such an item, a payment item say, posts to an account of its own. The invoice rule uses the one NetSuite used most.
      </div>
      {!result?.itemAccounts ? (
        <div style={muted}>Not read yet. Sync now reads it.</div>
      ) : result.itemAccounts.length === 0 ? (
        <div style={muted}>No invoice since January 2025 has an item with no income account.</div>
      ) : (
        <div style={box}>
          <div style={{ ...rowStyle(0, false), fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>
            <span style={{ flex: 1 }}>Item</span>
            <span style={{ flex: 1 }}>Account</span>
            <span style={{ width: '110px', textAlign: 'right' }}>GL lines</span>
          </div>
          {result.itemAccounts.map((a) => (
            <div key={`${a.item_id}-${a.account_id}`} style={rowStyle(1, false)}>
              <span style={{ flex: 1, minWidth: 0 }}>{a.item_name || `NetSuite item ${a.item_id}`}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{accountLabel(a.account_id)}</span>
              <span style={{ width: '110px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{n(a.lines)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );

  const LOOKUP_WORDS: Record<LongKind, { title: string; placeholder: string }> = {
    item: { title: 'Items', placeholder: 'Look up an item by number or NetSuite id' },
    vendor: { title: 'Vendors', placeholder: 'Look up a vendor by name or NetSuite id' },
    customer: { title: 'Customers', placeholder: 'Look up a customer by name or NetSuite id' },
  };

  const renderLong = (kind: LongKind) => (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) runLookup({ kind, q: query.trim() }, `${LOOKUP_WORDS[kind].title} matching "${query.trim()}"`);
        }}
        style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={LOOKUP_WORDS[kind].placeholder}
          style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', minWidth: '260px' }}
        />
        <button
          type="submit"
          disabled={lookingUp || !query.trim()}
          style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
        >
          {lookingUp ? 'Looking…' : 'Look up'}
        </button>
      </form>
      {lookupError && <div style={banner('#ef4444')}>{lookupError}</div>}
      {lookup && (
        <>
          <div style={heading}>
            {lookup.title}{' '}
            <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
              ({lookup.total > lookup.rows.length ? `first ${n(lookup.rows.length)} of ${n(lookup.total)}` : n(lookup.total)})
            </span>
          </div>
          {lookup.rows.length === 0 ? <div style={muted}>None found.</div>
            : kind === 'customer' ? renderCustomerRows(lookup.rows) : renderLookupRows(kind, lookup.rows)}
        </>
      )}
      {kind === 'customer' ? renderCustomerCount() : renderAccounts(kind)}
      {kind === 'item' && renderItemPostings()}
    </>
  );

  const summary = TABS
    .filter(([k]) => lists[k]?.received !== undefined)
    .map(([k]) => howMany(lists[k]!.received!, k));
  const sums = Object.values(lists).reduce<{ added: number; changed: number; gone: number }>(
    (s, l) => ({ added: s.added + (l?.added ?? 0), changed: s.changed + (l?.changed ?? 0), gone: s.gone + (l?.gone ?? 0) }),
    { added: 0, changed: 0, gone: 0 },
  );

  return (
    <div>
      <div style={{ marginBottom: '14px', display: 'flex', gap: '12px', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px' }}>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>NetSuite lists</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            FleetSuite&apos;s own books, visible only to super admins while they&apos;re built. The posting rules will pick
            accounts from these lists the way NetSuite does. Until the changeover they&apos;re copied from NetSuite every two
            hours, so change them in NetSuite.{' '}
            <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
            {' · '}
            <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
            {' · '}
            <Link href="/admin/books/trial-balance" style={{ color: 'var(--text-secondary)' }}>Trial balance vs NetSuite</Link>
            {' · '}
            <Link href="/admin/books/invoices" style={{ color: 'var(--text-secondary)' }}>Invoices vs NetSuite</Link>
            {' · '}
            <Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link>
            {' · '}
            <Link href="/admin/books/stock" style={{ color: 'var(--text-secondary)' }}>Stock by item</Link>
            {' · '}
            <Link href="/admin/books/balances" style={{ color: 'var(--text-secondary)' }}>Customer and vendor balances</Link>
            {' · '}
            <Link href="/admin/books/own-invoices" style={{ color: 'var(--text-secondary)' }}>Own invoices</Link>
            {' · '}
            <Link href="/admin/books/own-fulfillments" style={{ color: 'var(--text-secondary)' }}>Own fulfillments</Link>
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

      {!loading && !error && data && (
        <>
          {!data.lastSync && (
            <div style={banner('#fbbf24')}>The lists haven&apos;t been copied yet. It runs every two hours, or press Sync now.</div>
          )}
          {result?.error && (
            <div style={banner('#ef4444')}>The last copy failed {ago(data.lastSync!.at)}: {result.error}</div>
          )}
          {data.lastSync && !result?.error && summary.length > 0 && (
            <div style={banner('#22c55e')}>
              Copied {ago(data.lastSync.at)}: {summary.join(', ')}
              {' '}({n(sums.added)} added, {n(sums.changed)} changed, {n(sums.gone)} gone from NetSuite).
            </div>
          )}
          {(result?.notes ?? []).map((note) => <div key={note} style={banner('#fbbf24')}>{note}</div>)}

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '6px 0 14px' }}>
            {TABS.map(([k, label]) => {
              const c = counts.get(k);
              return (
                <button
                  key={k}
                  onClick={() => switchTab(k)}
                  style={{
                    padding: '6px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${tab === k ? 'var(--text-secondary)' : 'var(--border)'}`,
                    background: tab === k ? 'var(--card)' : 'transparent',
                    color: tab === k ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                >
                  {label} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{c ? n(c.listed) : 0}</span>
                </button>
              );
            })}
          </div>

          {(tab === 'location' || tab === 'department' || tab === 'class') && renderShort(tab)}
          {tab === 'term' && renderTerms()}
          {tab === 'tax_code' && renderTaxCodes()}
          {(tab === 'vendor' || tab === 'item' || tab === 'customer') && renderLong(tab)}
        </>
      )}
      {loading && !error && <div style={muted}>Loading…</div>}
    </div>
  );
}
