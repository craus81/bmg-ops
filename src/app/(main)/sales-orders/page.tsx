'use client';

/**
 * Sales orders list (Sales menu, thread "Redesign order-to-cash and
 * procure-to-pay", 2026-10-27). Every NetSuite sales order in FleetSuite's
 * copy (/api/sales-orders), Open / Billed / Closed / All, searchable by
 * number, customer, PO, memo or VIN. A row opens the sales order page.
 * Totals only for people who can see prices. + New sales order
 * (/sales-orders/new) for anyone who can make one.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import { SO_VIEWS, SO_VIEW_LABELS, type SoView } from '@/lib/sales-order-list';
import { NEW_SALES_ORDER_FEATURES } from '@/lib/new-sales-order';

interface Row {
  netsuiteId: string;
  number: string | null;
  customerName: string | null;
  date: string | null;
  status: string;
  view: Exclude<SoView, 'all'>;
  poNumber: string | null;
  memo: string | null;
  vin: string | null;
  total: number | null;
  estimate: { id: string; number: string | null } | null;
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (d: string | null) => {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-');
  return y && m && day ? `${Number(m)}/${Number(day)}/${y}` : d;
};

function tone(view: Row['view']): { bg: string; fg: string } {
  if (view === 'open') return { bg: theme.successBg, fg: theme.success };
  return { bg: theme.subtleBg, fg: theme.textSecondary };
}

export default function SalesOrdersPage() {
  const router = useRouter();
  const { canSeeMoney, hasFeature } = useAuth();
  const canMake = canSeeMoney && NEW_SALES_ORDER_FEATURES.some(f => hasFeature(f));
  const [view, setView] = useState<SoView>('open');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/sales-orders?view=${view}&page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
        const body = await res.json().catch(() => ({}));
        if (stale) return;
        if (!res.ok) throw new Error(body.error || `Couldn't load sales orders (${res.status}).`);
        setRows(body.orders || []);
        setCount(body.count || 0);
        setPageSize(body.pageSize || 50);
      } catch (e: any) {
        if (!stale) setError(e?.message || "Couldn't load sales orders.");
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => { stale = true; };
  }, [view, page, q]);

  const showTotals = canSeeMoney;
  const pages = Math.max(1, Math.ceil(count / pageSize));

  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', padding: '16px', display: 'grid', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Sales orders</h1>
          <div style={{ fontSize: '13px', color: theme.textMuted }}>Every NetSuite sales order. Tap one to open, edit or invoice it.</div>
        </div>
        {canMake && (
          <button onClick={() => router.push('/sales-orders/new')} style={{
            padding: '9px 14px', borderRadius: '8px', border: 'none', background: '#16a34a', color: '#fff',
            fontSize: '14px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>+ New sales order</button>
        )}
      </div>

      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
        {SO_VIEWS.map(v => (
          <button key={v} onClick={() => { setView(v); setPage(0); }} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            background: view === v ? 'var(--tab-active-bg)' : 'transparent',
            border: view === v ? '1px solid var(--tab-active-border)' : `1px solid ${theme.border}`,
            color: view === v ? 'var(--tab-active-color)' : theme.textMuted,
          }}>{SO_VIEW_LABELS[v]}</button>
        ))}
      </div>

      <input
        aria-label="Search sales orders"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search SO #, customer, PO, memo, VIN…"
        style={{
          width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: '8px',
          border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '15px',
        }}
      />

      {error && <div style={{ color: theme.error, fontWeight: 700, fontSize: '14px' }}>{error}</div>}
      {loading && rows.length === 0 && <div style={{ color: theme.textMuted, fontSize: '13px' }}>Loading…</div>}
      {!loading && !error && rows.length === 0 && (
        <div style={{ color: theme.textMuted, fontSize: '13px' }}>No {view === 'all' ? '' : `${SO_VIEW_LABELS[view].toLowerCase()} `}sales orders{q ? ` match “${q}”` : ''}.</div>
      )}

      <div style={{ display: 'grid', gap: '8px', opacity: loading ? 0.6 : 1 }}>
        {rows.map(r => {
          const t = tone(r.view);
          return (
            <button key={r.netsuiteId} onClick={() => router.push(deepLinks.salesOrder(r.netsuiteId))} style={{
              textAlign: 'left', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px',
              padding: '10px 12px', cursor: 'pointer', color: theme.textPrimary, display: 'grid', gap: '4px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 800 }}>{r.number || `SO ${r.netsuiteId}`}</span>
                {showTotals && r.total != null && <span style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{money(r.total)}</span>}
              </div>
              <div style={{ fontSize: '14px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.customerName || 'No customer'}</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', fontSize: '12px', color: theme.textMuted }}>
                <span style={{ padding: '1px 8px', borderRadius: '99px', background: t.bg, color: t.fg, fontWeight: 700 }}>{r.status}</span>
                {r.date && <span>{fmtDate(r.date)}</span>}
                {r.poNumber && <span>PO {r.poNumber}</span>}
                {r.estimate?.number && <span>{r.estimate.number}</span>}
              </div>
            </button>
          );
        })}
      </div>

      {pages > 1 && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'center', fontSize: '13px', color: theme.textMuted }}>
          <button disabled={page === 0 || loading} onClick={() => setPage(p => Math.max(0, p - 1))} style={pagerBtn}>← Newer</button>
          <span>Page {page + 1} of {pages} · {count} orders</span>
          <button disabled={page + 1 >= pages || loading} onClick={() => setPage(p => p + 1)} style={pagerBtn}>Older →</button>
        </div>
      )}
      <div style={{ fontSize: '12px', color: theme.textMuted }}>From FleetSuite&apos;s copy of NetSuite, refreshed every 2 hours.</div>
    </div>
  );
}

const pagerBtn: React.CSSProperties = {
  padding: '7px 12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.card,
  color: theme.textPrimary, fontSize: '13px', fontWeight: 700, cursor: 'pointer',
};
