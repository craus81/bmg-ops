'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { looseMatcher } from '@/lib/loose-search';
import type { OwnCheckStatus } from '@/lib/books/own-invoice-check';
import type { OwnFulfillmentCheck } from '@/lib/books/own-fulfillment-check';

/**
 * Books → Own fulfillments (migration 418, src/lib/books/own-fulfillments.ts
 * and own-fulfillment-check.ts, docs/books.md "FleetSuite's own
 * fulfillments"; owner decision 2026-10-19, "Fulfillments").
 *
 * FleetSuite's own copy of each fulfillment it makes before invoicing a
 * sales order, with what FleetSuite works out it cost from Stock by item,
 * next to NetSuite's fulfillment, a month at a time: the ones that differ
 * first, with why in a sentence. Tap one for its item by item check. The
 * daily check tells the super admins when one differs and links here
 * (?only=differs) or to the fulfillment. Super admins only, as the books are.
 */

type Row = Omit<OwnFulfillmentCheck, 'fields' | 'items' | 'entry' | 'workedOut'>;

interface SyncState { at: string; error: string | null }

interface Payload {
  months: Array<{ month: string; fulfillments: number }>;
  month: string | null;
  fulfillments: Row[];
  counts: Record<OwnCheckStatus, number> | null;
  lastStock: SyncState | null;
  lastLedger: SyncState | null;
  lastLists: SyncState | null;
  lastCheck: SyncState | null;
}

type Filter = 'all' | OwnCheckStatus;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const monthText = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#fbbf24';
const BLUE = '#60a5fa';
const GRAY = '#9ca3af';

/** Each status: its chip, its button, and its color. */
const STATUS: Record<OwnCheckStatus, { chip: string; button: [string, string]; color: string }> = {
  differs: { chip: 'Differs', button: ['differs', 'differ'], color: RED },
  incomplete: { chip: 'Incomplete', button: ['incomplete', 'incomplete'], color: AMBER },
  waiting: { chip: 'Waiting', button: ['waiting', 'waiting'], color: BLUE },
  matches: { chip: 'Matches', button: ['matches', 'match'], color: GREEN },
  voided: { chip: 'Deleted in NetSuite', button: ['deleted', 'deleted'], color: GRAY },
};
const ORDER: readonly OwnCheckStatus[] = ['differs', 'incomplete', 'waiting', 'matches', 'voided'];

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const note: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' };

const chip = (color: string): React.CSSProperties => ({
  fontSize: '10px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
  border: `1px solid ${color}55`, color,
});

const button = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: '8px', border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border)'}`,
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: active ? 800 : 600, cursor: 'pointer',
});

const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const labelCell: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };
const amountHead: React.CSSProperties = { ...cell, width: '15%' };

/**
 * A row of the table: its label, then the amounts. On a phone the label takes
 * a row of its own above them (.rep-label-row in globals.css), as on Reports.
 */
function TableRow({ label, style, children }: { label: React.ReactNode; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <>
      <tr className="rep-label-row" style={style}><td colSpan={3} style={labelCell}>{label}</td></tr>
      <tr className="rep-amounts" style={style}>
        <td className="rep-label" style={labelCell}>{label}</td>
        {children}
      </tr>
    </>
  );
}

/** A fulfillment: its number (opening its check), status, customer, the order it fulfilled and the sentence saying how it compares. */
function FulfillmentLabel({ r }: { r: Row }) {
  const s = STATUS[r.status];
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' }}>
        <span style={{ color: 'var(--text-muted)' }}>{dayText(r.date)}</span>
        <Link href={deepLinks.booksOwnFulfillment(r.netsuiteId)} className="rep-link" style={{ fontWeight: 700 }}>{r.number}</Link>
        {r.customer && <span>· {r.customer}</span>}
        <span style={chip(s.color)}>{s.chip}</span>
      </div>
      <div style={{ fontSize: '11px', color: r.status === 'differs' ? RED : 'var(--text-muted)', overflowWrap: 'anywhere' }}>
        {r.summary}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
        {r.salesOrder}, from {r.madeFromText}{r.invoice ? `, invoiced as ${r.invoice.number}` : ''}
      </div>
    </div>
  );
}

export default function BooksOwnFulfillmentsPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async (month: string, nextFilter: Filter) => {
    try {
      const res = await apiFetch(`/api/admin/books/own-fulfillments${month ? `?${new URLSearchParams({ month })}` : ''}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setFilter(nextFilter);
      setError('');
      // Keep the address on what's shown, so going back here opens it again.
      window.history.replaceState(null, '', deepLinks.booksOwnFulfillments(json.month, nextFilter === 'differs'));
    } catch (e: any) {
      setError(e?.message || 'Could not load the own fulfillments');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // The daily check's notification about several own fulfillments opens the ones that differ (deepLinks.booksOwnFulfillments).
    const q = new URLSearchParams(window.location.search);
    load(q.get('month') ?? '', q.get('only') === 'differs' ? 'differs' : 'all');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const pickMonth = (month: string) => {
    setLoading(true);
    load(month.slice(0, 7), filter);
  };
  const pickFilter = (next: Filter) => {
    if (!data) return;
    setFilter(next);
    window.history.replaceState(null, '', deepLinks.booksOwnFulfillments(data.month, next === 'differs'));
  };

  const visible = useMemo(() => {
    const match = looseMatcher(search);
    const rows = (data?.fulfillments ?? [])
      .filter((r) => (filter === 'all' || r.status === filter) && match(r.number, r.customer ?? '', r.salesOrder, r.invoice?.number ?? ''));
    // The ones that differ first, then as they came (newest first).
    return rows.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  }, [data, filter, search]);

  const counts = data?.counts;
  const total = data?.fulfillments.length ?? 0;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Own fulfillments</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          FleetSuite&apos;s own copy of each fulfillment it makes before invoicing a sales order: what it took from stock, from
          where and on what day, worked out from its copy of the order and its location rules. FleetSuite works out what that
          cost itself, from Stock by item: each item at its average cost at that location just before. Each is put next to
          NetSuite&apos;s fulfillment; tap one for its item by item check. Nothing is posted from them yet. Each morning the daily
          check tells super admins when one differs. Visible only to super admins.{' '}
          <Link href="/admin/books/stock" style={{ color: 'var(--text-secondary)' }}>Stock by item</Link>
          {' · '}
          <Link href="/admin/books/own-invoices" style={{ color: 'var(--text-secondary)' }}>Own invoices</Link>
          {' · '}
          <Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link>
          {' · '}
          <Link href="/admin/books/lists" style={{ color: 'var(--text-secondary)' }}>NetSuite lists</Link>
          {' · '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          {data.lastStock?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s stock moves failed {ago(data.lastStock.at)}: {data.lastStock.error}</div>}
          {data.lastLedger?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s ledger failed {ago(data.lastLedger.at)}: {data.lastLedger.error}</div>}
          {data.lastLists?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s lists failed {ago(data.lastLists.at)}: {data.lastLists.error}</div>}
          {data.lastCheck?.error && <div style={banner(RED)}>The daily check couldn&apos;t look at everything {ago(data.lastCheck.at)}: {data.lastCheck.error}</div>}
          {data.lastStock && !data.lastStock.error && (
            <div style={note}>
              NetSuite&apos;s stock moves copied {ago(data.lastStock.at)}
              {data.lastLedger ? `, its ledger ${ago(data.lastLedger.at)}` : ''}
              {data.lastLists ? `, its items ${ago(data.lastLists.at)}` : ''}.
              {data.lastCheck && ` The daily check looked ${ago(data.lastCheck.at)}.`}
            </div>
          )}

          {!data.months.length && (
            <div style={banner(BLUE)}>
              FleetSuite hasn&apos;t fulfilled an order since it started keeping its own copies. The next sales order it fulfils
              when invoicing a finished vehicle or a sales order&apos;s installed quantities shows up here.
            </div>
          )}

          {data.months.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
              {data.months.map((m) => (
                <button key={m.month} onClick={() => pickMonth(m.month)} disabled={loading} style={button(m.month === data.month)}>
                  {monthText(m.month)} · {m.fulfillments.toLocaleString('en-US')}
                </button>
              ))}
            </div>
          )}

          {counts && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
              <button onClick={() => pickFilter('all')} style={button(filter === 'all')}>All {total.toLocaleString('en-US')}</button>
              {ORDER.filter((s) => counts[s] > 0).map((s) => (
                <button key={s} onClick={() => pickFilter(s)} style={{ ...button(filter === s), color: STATUS[s].color }}>
                  {count(counts[s], STATUS[s].button[0], STATUS[s].button[1])}
                </button>
              ))}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search fulfillments, orders or customers"
                style={{ padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', flex: '1 1 180px', minWidth: 0, maxWidth: '280px' }}
              />
            </div>
          )}

          {data.month && (
            <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
              <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
                <thead>
                  <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                    <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Made in {monthText(data.month)}</th>
                    <th style={amountHead}>FleetSuite&apos;s cost</th>
                    <th style={amountHead}>NetSuite&apos;s cost</th>
                    <th style={amountHead}>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {!visible.length && (
                    <tr><td colSpan={4} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                      {search ? 'No fulfillment matches that search.' : filter === 'differs' ? "Every own fulfillment this month matches NetSuite's or isn't checked yet." : 'No own fulfillments this month.'}
                    </td></tr>
                  )}
                  {visible.map((r) => {
                    const diff = r.fleetsuiteCost === null || r.netsuiteCost === null ? null : r.fleetsuiteCost - r.netsuiteCost;
                    return (
                      <TableRow key={r.netsuiteId} label={<FulfillmentLabel r={r} />} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...cell, color: r.fleetsuiteCost === null ? 'var(--text-muted)' : undefined }}>
                          {r.fleetsuiteCost === null ? 'Not known' : fmt(r.fleetsuiteCost)}
                        </td>
                        <td style={{ ...cell, color: r.netsuiteCost === null ? 'var(--text-muted)' : undefined }}>
                          {r.netsuiteCost === null ? 'Not copied' : fmt(r.netsuiteCost)}
                        </td>
                        <td style={{ ...cell, color: diff ? RED : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>{diff ? fmt(diff) : '—'}</td>
                      </TableRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
