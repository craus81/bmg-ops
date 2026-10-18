'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { looseMatcher } from '@/lib/loose-search';
import type { CountsBy, StockLine } from '@/lib/books/stock-items';

/**
 * Books → Stock by item (migration 401, src/lib/books/stock-items.ts,
 * docs/books.md "Stock by item"; owner decision 2026-10-18, "Every move").
 *
 * Each item's count and value at each location, FleetSuite's next to
 * NetSuite's own. FleetSuite's count is where the item stood on December 31,
 * 2024 plus every NetSuite document since that moved it, copied every two
 * hours or on Copy now; its value adds what NetSuite posted to the inventory
 * accounts on those documents' lines. NetSuite's count is its own, read as
 * each copy ends. Tap an item for its moves. The daily check tells the super
 * admins when a count stops matching and links here (?only=differs) or to
 * the item. Super admins only, as the books are.
 */

interface CopyResult {
  read?: number;
  added?: number;
  changed?: number;
  unchanged?: number;
  gone?: number;
  opening?: number;
  counts?: number;
  countsBy?: CountsBy;
  partial?: boolean;
  notes?: string[];
  error?: string;
}

interface Payload {
  by: CountsBy | null;
  readAt: string | null;
  lines: StockLine[];
  cleared: number;
  value: { fleetsuite: number; netsuite: number | null };
  ledger: Array<{ company: string; balance: number; items: number }>;
  accounts: Array<{ number: string | null; name: string }>;
  lastCopy: { at: string; result: CopyResult } | null;
}

type Show = 'count' | 'value';
type Filter = 'all' | 'differs';

/** Lines shown at once; Show more adds as many again. */
const PAGE = 300;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
/** A quantity as people write one: no trailing zeros, thousands grouped (as quantityText in stock-items.ts). */
const qty = (n: number) => {
  const rounded = Math.round(n * 1e5) / 1e5;
  return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString('en-US', { maximumFractionDigits: 5 });
};
const signed = (n: number) => (n > 0 ? `+${qty(n)}` : qty(n));
/** Counts closer than this are the same (compareStock's). */
const SAME = 1e-6;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

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

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

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
 * A row of a table: its label, then the amounts. On a phone the label takes a
 * row of its own above them (.rep-label-row in globals.css), as on Reports.
 */
function Row({ label, style, children }: { label: React.ReactNode; style?: React.CSSProperties; children: React.ReactNode }) {
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

/** FleetSuite's, NetSuite's and the difference, as counts or as values. */
function Sides({ line, show }: { line: StockLine; show: Show }) {
  if (show === 'count') {
    const diff = line.fleetsuite.quantity - line.netsuite.quantity;
    const differs = Math.abs(diff) >= SAME;
    return (
      <>
        <td style={cell}>{qty(line.fleetsuite.quantity)}</td>
        <td style={cell}>{qty(line.netsuite.quantity)}</td>
        <td style={{ ...cell, color: differs ? RED : 'var(--text-muted)', fontWeight: differs ? 700 : 400 }}>{differs ? signed(diff) : '—'}</td>
      </>
    );
  }
  const theirs = line.netsuite.value;
  const diff = theirs === null ? 0 : line.fleetsuite.value - theirs;
  return (
    <>
      <td style={cell}>{fmt(line.fleetsuite.value)}</td>
      <td style={cell}>{theirs === null ? '—' : fmt(theirs)}</td>
      <td style={{ ...cell, color: diff ? RED : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>{diff ? fmt(diff) : '—'}</td>
    </>
  );
}

/** An item: its number (opening its moves), where, what it is, and when it last moved. */
function ItemLabel({ line }: { line: StockLine }) {
  const other = line.companies.filter((c) => c !== 'BMG');
  const about = [
    line.description,
    line.documents ? `${count(line.documents, 'move', 'moves')} since 2025${line.lastDate ? `, the last ${dayText(line.lastDate)}` : ''}` : 'No moves since 2025',
  ].filter(Boolean).join(' · ');
  return (
    <div>
      <div>
        <Link href={deepLinks.booksStockItem(line.itemId, line.locationId)} className="rep-link" style={{ fontWeight: 700 }}>{line.item}</Link>
        {line.location && <span style={{ color: 'var(--text-secondary)', marginLeft: '6px' }}>at {line.location}</span>}
        {other.length > 0 && <span style={{ ...chip('#60a5fa'), marginLeft: '6px' }}>{line.companies.join(' + ')}</span>}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{about}</div>
    </div>
  );
}

export default function BooksStockPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [show, setShow] = useState<Show>('count');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/books/stock');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the stock');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // The daily check's notification about several items opens the ones that differ (deepLinks.booksStock).
    if (new URLSearchParams(window.location.search).get('only') === 'differs') setFilter('differs');
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const pickFilter = (next: Filter) => {
    setFilter(next);
    setShown(PAGE);
    // Keep the address on what's shown, so going back here opens it again.
    window.history.replaceState(null, '', deepLinks.booksStock(next === 'differs'));
  };

  // How the copy went is recorded either way and shows in the banner after
  // the reload; copyError is only for a request that never got that far.
  const copyNow = async () => {
    setCopying(true);
    setCopyError('');
    try {
      const res = await apiFetch('/api/admin/books/stock', { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `Copy failed (${res.status})`);
      }
    } catch (e: any) {
      setCopyError(e?.message || 'Copy failed');
    }
    await load();
    setCopying(false);
  };

  const differs = (l: StockLine) => l.countDiffers || l.valueDiffers;
  const differing = useMemo(() => (data?.lines ?? []).filter(differs).length, [data]);
  const countsDiffering = useMemo(() => (data?.lines ?? []).filter((l) => l.countDiffers).length, [data]);
  const valuesDiffering = useMemo(() => (data?.lines ?? []).filter((l) => l.valueDiffers).length, [data]);

  const visible = useMemo(() => {
    const match = looseMatcher(search);
    return (data?.lines ?? []).filter((l) => (filter === 'all' || differs(l))
      && match(`${l.item} ${l.description ?? ''} ${l.location ?? ''}`));
  }, [data, filter, search]);

  const r = data?.lastCopy?.result;
  const at = data?.lastCopy?.at ?? '';
  const valueDiff = data && data.value.netsuite !== null ? data.value.fleetsuite - data.value.netsuite : 0;
  const accountNames = (data?.accounts ?? []).map((a) => [a.number, a.name].filter(Boolean).join(' ')).join(', ');

  return (
    <div>
      <div style={{ marginBottom: '14px', display: 'flex', gap: '12px', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px' }}>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>Stock by item</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Each item&apos;s count and value at each location, FleetSuite&apos;s next to NetSuite&apos;s own. FleetSuite counts from where
            the item stood on December 31, 2024 and every NetSuite document since that moved it, copied every two hours, and values it at
            what NetSuite posted to the inventory accounts on those documents. NetSuite&apos;s count is read as each copy ends. Tap an item
            for its moves. Each morning the daily check tells super admins when a count stops matching. Visible only to super admins.{' '}
            <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
            {' · '}
            <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
            {' · '}
            <Link href="/admin/books/trial-balance" style={{ color: 'var(--text-secondary)' }}>Trial balance vs NetSuite</Link>
            {' · '}
            <Link href="/admin/books/lists" style={{ color: 'var(--text-secondary)' }}>NetSuite lists</Link>
            {' · '}
            <Link href="/admin/books/invoices" style={{ color: 'var(--text-secondary)' }}>Invoices vs NetSuite</Link>
            {' · '}
            <Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link>
          </div>
        </div>
        <button
          onClick={copyNow}
          disabled={copying || loading}
          style={{
            padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
            color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: copying ? 'wait' : 'pointer',
          }}
        >
          {copying ? 'Copying…' : 'Copy now'}
        </button>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}
      {copyError && <div style={banner(RED)}>{copyError}</div>}

      {data && (
        <>
          {!data.lastCopy && (
            <div style={banner(AMBER)}>NetSuite&apos;s stock moves haven&apos;t been copied yet. They&apos;re copied every two hours, or press Copy now.</div>
          )}
          {r?.error && <div style={banner(RED)}>The last copy failed {ago(at)}: {r.error}</div>}
          {r && !r.error && r.partial && (
            <div style={banner(AMBER)}>
              Still copying: the last run, {ago(at)}, read {count(r.read ?? 0, 'document', 'documents')} and stopped for time. It carries on
              at the next run, or press Copy now again. NetSuite&apos;s counts are read once every move is in.
            </div>
          )}
          {r && !r.error && !r.partial && (
            <div style={banner(GREEN)}>
              Copied {ago(at)}: {count(r.read ?? 0, 'document', 'documents')} changed in NetSuite since the last copy
              ({r.added ?? 0} new, {r.changed ?? 0} changed{r.gone ? `, ${r.gone} gone from NetSuite` : ''})
              {r.counts !== undefined ? `, and ${count(r.counts, 'count', 'counts')} read from NetSuite.` : '.'}
            </div>
          )}
          {(r?.notes ?? []).map((n) => <div key={n} style={banner(AMBER)}>{n}</div>)}
          {data.lastCopy && !data.by && (
            <div style={banner(AMBER)}>
              NetSuite&apos;s own counts haven&apos;t been read yet, so nothing is compared. A copy reads them once it has every move.
            </div>
          )}

          {data.by && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px', fontSize: '12px' }}>
              <span style={chip(countsDiffering ? RED : GREEN)}>
                {countsDiffering ? `${count(countsDiffering, 'count differs', 'counts differ')} from NetSuite` : 'Every count matches NetSuite'}
              </span>
              {data.value.netsuite !== null && (
                <span style={chip(valuesDiffering ? RED : GREEN)}>
                  {valuesDiffering ? `${count(valuesDiffering, 'value differs', 'values differ')}` : 'Every value matches'}
                </span>
              )}
              <span style={{ color: 'var(--text-muted)' }}>
                {count(data.lines.length, 'item', 'items')}{data.by === 'item' ? ', each counted company-wide' : ' at their locations'}.
                NetSuite&apos;s counts read {data.readAt ? ago(data.readAt) : 'never'}.
              </span>
            </div>
          )}

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '14px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Value of stock</th>
                  <th style={amountHead}>FleetSuite</th>
                  <th style={amountHead}>NetSuite</th>
                  <th style={amountHead}>Difference</th>
                </tr>
              </thead>
              <tbody>
                <Row label="Every item at every location">
                  <td style={cell}>{fmt(data.value.fleetsuite)}</td>
                  <td style={cell}>{data.value.netsuite === null ? '—' : fmt(data.value.netsuite)}</td>
                  <td style={{ ...cell, color: valueDiff ? RED : 'var(--text-muted)', fontWeight: valueDiff ? 700 : 400 }}>{valueDiff ? fmt(valueDiff) : '—'}</td>
                </Row>
                {data.ledger.map((l) => (
                  <Row
                    key={l.company}
                    label={(
                      <div>
                        <div>{l.company}&apos;s inventory accounts in NetSuite&apos;s ledger</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {accountNames || 'No inventory account yet'}. Its items come to {fmt(l.items)}
                          {l.balance !== l.items ? `; ${fmt(l.balance - l.items)} was posted there without an item, as by a journal entry` : ''}.
                        </div>
                      </div>
                    )}
                    style={{ borderTop: '1px solid var(--border)' }}
                  >
                    <td style={cell}>{fmt(l.items)}</td>
                    <td style={cell}>{fmt(l.balance)}</td>
                    <td style={{ ...cell, color: l.items !== l.balance ? AMBER : 'var(--text-muted)', fontWeight: l.items !== l.balance ? 700 : 400 }}>
                      {l.items !== l.balance ? fmt(l.items - l.balance) : '—'}
                    </td>
                  </Row>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
            <button onClick={() => setShow('count')} style={button(show === 'count')}>Counts</button>
            <button onClick={() => setShow('value')} style={button(show === 'value')}>Values</button>
            <span style={{ width: '8px' }} />
            <button onClick={() => pickFilter('all')} style={button(filter === 'all')}>All {data.lines.length.toLocaleString('en-US')}</button>
            <button onClick={() => pickFilter('differs')} style={{ ...button(filter === 'differs'), color: differing ? RED : 'var(--text-primary)' }}>
              {differing ? `${count(differing, 'differs', 'differ')} from NetSuite` : 'None differ from NetSuite'}
            </button>
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }}
              placeholder="Search item or location"
              style={{ padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', flex: '1 1 180px', minWidth: 0, maxWidth: '280px' }}
            />
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Item</th>
                  <th style={amountHead}>FleetSuite</th>
                  <th style={amountHead}>NetSuite</th>
                  <th style={amountHead}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {!visible.length && (
                  <tr><td colSpan={4} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                    {search ? 'No item matches that search.'
                      : filter === 'differs' ? 'Every item matches NetSuite.'
                        : 'No stock yet. It shows once the first copy is in.'}
                  </td></tr>
                )}
                {visible.slice(0, shown).map((l) => (
                  <Row key={l.key} label={<ItemLabel line={l} />} style={{ borderTop: '1px solid var(--border)' }}>
                    <Sides line={l} show={show} />
                  </Row>
                ))}
              </tbody>
            </table>
          </div>
          {visible.length > shown && (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Showing {shown.toLocaleString('en-US')} of {visible.length.toLocaleString('en-US')}.
              <button onClick={() => setShown(shown + PAGE)} style={button(false)}>Show more</button>
            </div>
          )}
          {data.cleared > 0 && filter === 'all' && !search && (
            <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
              {count(data.cleared, 'item that both sides have none of now is', 'items that both sides have none of now are')} left out.
            </div>
          )}
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
