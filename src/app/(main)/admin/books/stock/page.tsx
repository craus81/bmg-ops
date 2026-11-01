'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess, booksAllows } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { looseMatcher } from '@/lib/loose-search';
import type { CountsBy, LedgerEntry, LedgerPart, StockLine, StockSetup } from '@/lib/books/stock-items';

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
 * the item. The stocked items NetSuite has set up with an asset account that
 * isn't an asset account are listed with what to set it to, and an item none
 * is left of on either side that still has value on NetSuite's ledger is
 * labelled value left over (migration 403; owner decision 2026-10-19, "Flag
 * them"). Each inventory account on NetSuite's ledger is put next to the
 * stocked items on it, with where they stood on December 31, 2024 and the
 * documents since that posted to it without a stocked item (migration 404;
 * owner decision 2026-10-19, "Break it down"), and, on any but the account
 * most stocked items name, the stocked items that put it there (migration
 * 405; owner decision 2026-10-19, "Name it"). Open to whoever opens the
 * books.
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
  setup: StockSetup;
  ledgerParts: LedgerPart[];
  lastCopy: { at: string; result: CopyResult } | null;
}

type Show = 'count' | 'value';
type Filter = 'all' | 'differs';

/** Lines shown at once; Show more adds as many again. */
const PAGE = 300;
/** Documents an account's breakdown lists at first; Show all lists every one sent. */
const ENTRIES_FIRST = 10;

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

/** "3 journals", "1 bill": how many documents of a kind, as a sentence names them. */
const documents = (type: string, n: number) => {
  const one = type.toLowerCase();
  return count(n, one, one.endsWith('y') ? `${one.slice(0, -1)}ies` : `${one}s`);
};

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
  // Value left over is explained beside the item, so it's amber rather than red.
  const color = !diff ? 'var(--text-muted)' : line.leftover ? AMBER : RED;
  return (
    <>
      <td style={cell}>{fmt(line.fleetsuite.value)}</td>
      <td style={cell}>{theirs === null ? '—' : fmt(theirs)}</td>
      <td style={{ ...cell, color, fontWeight: diff ? 700 : 400 }}>{diff ? fmt(diff) : '—'}</td>
    </>
  );
}

/**
 * An item: its number (opening its moves), where, what it is, and when it
 * last moved; whether NetSuite has its asset account wrong, and when it has
 * value left over, how much.
 */
function ItemLabel({ line, wrong }: { line: StockLine; wrong: boolean }) {
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
        {wrong && <span style={{ ...chip(RED), marginLeft: '6px' }}>Asset account wrong in NetSuite</span>}
        {line.leftover && <span style={{ ...chip(AMBER), marginLeft: '6px' }}>Value left over</span>}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{about}</div>
      {line.leftover && (
        <div style={{ fontSize: '11px', color: AMBER, overflowWrap: 'anywhere' }}>
          None on hand on either side, but NetSuite&apos;s ledger still holds {fmt(line.fleetsuite.value)} on its lines. Its page says why.
        </div>
      )}
    </div>
  );
}

/** Whether this login can open Item Accounts (src/app/(main)/admin/item-accounts), where Change accounts goes; anyone else reads these without the link. */
function useCanChangeAccounts(): boolean {
  const { hasFeature, canSeeMoney } = useAuth();
  return hasFeature('vendor_payments') && canSeeMoney;
}

/** The stocked items NetSuite has set up with an asset account that isn't an asset account, and what to set it to. */
function SetupList({ setup }: { setup: StockSetup }) {
  const canChange = useCanChangeAccounts();
  return (
    <div style={banner(RED)}>
      <div>
        {count(setup.items.length, 'stocked item has', 'stocked items have')} an asset account in NetSuite that isn&apos;t an asset
        account. NetSuite puts what a stocked item costs on its asset account when it&apos;s received and takes it off when it ships,
        so {setup.items.length === 1 ? 'its' : 'their'} cost lands in the wrong place.{' '}
        {canChange ? <>With Change accounts beside {setup.items.length === 1 ? 'it' : 'each one'},</> : 'In NetSuite,'} set its inventory asset account to {setup.usual ? `${setup.usual}, as most stocked items have it,` : 'your inventory asset account'} and
        check its cost of goods sold account there: this list can&apos;t read that one. An item drops off this list once it&apos;s changed there,
        or after a change made in NetSuite once <Link href="/admin/books/lists" className="rep-link">NetSuite&apos;s lists</Link> are copied again,
        every two hours or on Sync now.
      </div>
      <ul style={{ margin: '6px 0 0', paddingLeft: '18px', fontWeight: 400 }}>
        {setup.items.map((i) => (
          <li key={i.itemId} style={{ overflowWrap: 'anywhere' }}>
            <Link href={deepLinks.booksStockItem(i.itemId)} className="rep-link" style={{ fontWeight: 700 }}>{i.item}</Link>
            {i.description ? ` · ${i.description}` : ''}: asset account {i.account}, {i.accountKind}
            {canChange && <>{' · '}<Link href={deepLinks.itemAccounts(i.itemId)} className="rep-link">Change accounts</Link></>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** An inventory account's difference: amber on stock, quieter on a fixed asset account, where most of it is the company's own. */
const partColor = (part: LedgerPart, cents: number) => (!cents ? 'var(--text-muted)' : part.fixedAsset ? 'var(--text-secondary)' : AMBER);

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** A document that posted to an inventory account without a stocked item: its number (opening its check), what, when, and what it posted. */
function EntryRow({ entry, company }: { entry: LedgerEntry; company: string }) {
  const about = [entry.name, entry.memo].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflowWrap: 'anywhere' }}>
          {entry.check ? (
            <Link href={deepLinks.booksDocument(company, entry.check.kind, entry.check.month, entry.doc)} className="rep-link" style={{ fontWeight: 700 }}>
              {entry.number}
            </Link>
          ) : <span style={{ fontWeight: 700 }}>{entry.number}</span>}
          <span style={{ color: 'var(--text-secondary)', marginLeft: '6px' }}>{entry.type}{entry.date ? ` · ${dayText(entry.date)}` : ''}</span>
        </div>
        {about && <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{about}</div>}
      </div>
      <div style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontWeight: 700 }}>{fmt(entry.amount)}</div>
    </div>
  );
}

/** On an account other than the one most stocked items name: the stocked items that put it on the page, and what to set them to. */
function NamedBy({ named }: { named: NonNullable<LedgerPart['namedBy']> }) {
  const canChange = useCanChangeAccounts();
  const one = named.count === 1;
  return (
    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px' }}>
      <div>
        On this page because {count(named.count, 'stocked item names', 'stocked items name')} it as {one ? 'its' : 'their'} asset account:
      </div>
      <ul style={{ margin: '2px 0', paddingLeft: '18px' }}>
        {named.items.map((i) => (
          <li key={i.itemId} style={{ overflowWrap: 'anywhere' }}>
            <Link href={deepLinks.booksStockItem(i.itemId)} className="rep-link" style={{ fontWeight: 700 }}>{i.item}</Link>
            {i.description ? ` · ${i.description}` : ''}
            {i.active ? '' : ' · inactive'}
            {canChange && <>{' · '}<Link href={deepLinks.itemAccounts(i.itemId)} className="rep-link">Change accounts</Link></>}
          </li>
        ))}
        {named.more > 0 && <li>and {count(named.more, 'more', 'more')}</li>}
      </ul>
      <div>
        If {one ? 'it' : 'they'} shouldn&apos;t, set {one ? 'its' : 'each one\'s'} inventory asset account to {named.usual ?? 'your inventory asset account'}{' '}
        {canChange ? 'with Change accounts' : 'in NetSuite'}. Once {one ? 'it\'s' : 'they\'re'} right, at once when changed there or after a change in NetSuite once{' '}
        <Link href="/admin/books/lists" className="rep-link">NetSuite&apos;s lists</Link> are copied again, every two hours or on Sync now, the
        account leaves this page.
      </div>
    </div>
  );
}

/**
 * One company's inventory account: what the stocked items and NetSuite's
 * ledger held on it on December 31, 2024, the items' moves since (on both
 * sides alike), and the documents since that posted to it without a stocked
 * item, which with the starting difference make up the rest (migration 404;
 * owner decision 2026-10-19, "Break it down"). Its documents show at first
 * on a stock account, and on a tap on a fixed asset account. On any account
 * but the usual one, the stocked items that name it (migration 405).
 */
function LedgerBreakdown({ part, named }: { part: LedgerPart; named: boolean }) {
  const [open, setOpen] = useState(!part.fixedAsset);
  const [all, setAll] = useState(false);
  const { entries } = part;
  const start = part.items.start - part.ledger.start;
  const now = part.items.now - part.ledger.now;
  const gap = part.ledger.now - part.items.now;
  const rows = all ? entries.rows : entries.rows.slice(0, ENTRIES_FIRST);
  const amount = (cents: number, color?: string, bold = false): React.ReactNode => (
    <td style={{ ...cell, color, fontWeight: bold ? 700 : 400 }}>{fmt(cents)}</td>
  );
  const none = <td style={{ ...cell, color: 'var(--text-muted)' }}>—</td>;
  return (
    <div id={`ledger-${part.company}-${part.accountId}`} style={{ border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '10px', background: 'var(--card)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 12px 6px' }}>
        <div style={{ fontSize: '13px', fontWeight: 800 }}>{named ? `${part.company} · ` : ''}{part.account}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {part.fixedAsset ? 'A fixed asset account. ' : ''}
          {!gap ? 'NetSuite\'s ledger holds what the stocked items on it are worth.'
            : `NetSuite's ledger holds ${fmt(Math.abs(gap))} ${gap < 0 ? 'less' : 'more'} than the stocked items on it are worth${
              part.fixedAsset && gap > 0 ? ', most likely the company\'s own equipment or vehicles' : ''}.`}
          {' '}
          <Link href={deepLinks.booksAccountDetail(part.company, part.accountId, 'balance_sheet', '2025-01', thisMonth())} className="rep-link">
            Every document on it since 2025
          </Link>
        </div>
        {part.namedBy && <NamedBy named={part.namedBy} />}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
              <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>On the account</th>
              <th style={amountHead}>Stocked items</th>
              <th style={amountHead}>Ledger</th>
              <th style={amountHead}>Difference</th>
            </tr>
          </thead>
          <tbody>
            <Row label="December 31, 2024" style={{ borderTop: '1px solid var(--border)' }}>
              {amount(part.items.start)}
              {amount(part.ledger.start)}
              {start ? amount(start, partColor(part, start)) : none}
            </Row>
            <Row label="Received, shipped, built and adjusted since" style={{ borderTop: '1px solid var(--border)' }}>
              {amount(part.items.moves)}
              {amount(part.items.moves)}
              {none}
            </Row>
            <Row
              label={`${count(entries.count, 'document', 'documents')} since with no stocked item${entries.count ? ', below' : ''}`}
              style={{ borderTop: '1px solid var(--border)' }}
            >
              {none}
              {amount(entries.total)}
              {entries.total ? amount(-entries.total, partColor(part, entries.total)) : none}
            </Row>
            <Row label={<span style={{ fontWeight: 700 }}>Now</span>} style={{ borderTop: '1px solid var(--border)' }}>
              {amount(part.items.now, undefined, true)}
              {amount(part.ledger.now, undefined, true)}
              {now ? amount(now, partColor(part, now), true) : none}
            </Row>
          </tbody>
        </table>
      </div>
      {entries.count > 0 && (
        <div style={{ padding: '6px 12px 10px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
            {entries.kinds.map((k) => `${documents(k.type, k.count)}: ${fmt(k.total)}`).join(' · ')}.
            {' '}The biggest first, as each posted to the account.
          </div>
          {!open ? (
            <button onClick={() => setOpen(true)} style={button(false)}>Show the {count(entries.count, 'document', 'documents')}</button>
          ) : (
            <>
              {rows.map((e) => <EntryRow key={e.doc} entry={e} company={part.company} />)}
              {entries.rows.length > rows.length && (
                <button onClick={() => setAll(true)} style={{ ...button(false), marginTop: '6px' }}>
                  Show all {entries.rows.length.toLocaleString('en-US')}
                </button>
              )}
              {(all || entries.rows.length <= ENTRIES_FIRST) && entries.more.count > 0 && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  {count(entries.more.count, 'smaller document comes', 'smaller documents come')} to {fmt(entries.more.total)} more.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function BooksStockPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  // Copying now isn't the CPA's.
  const canKeep = booksAllows(booksAccess(hasRole), 'keep');
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
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
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
  // Value left over is counted apart from the other values that differ: it's explained.
  const valuesDiffering = useMemo(() => (data?.lines ?? []).filter((l) => l.valueDiffers && !l.leftover).length, [data]);
  const leftover = useMemo(() => {
    const lines = (data?.lines ?? []).filter((l) => l.leftover);
    return { lines: lines.length, value: lines.reduce((total, l) => total + l.fleetsuite.value - (l.netsuite.value ?? 0), 0) };
  }, [data]);
  const wrong = useMemo(() => new Set((data?.setup.items ?? []).map((i) => i.itemId)), [data]);

  const visible = useMemo(() => {
    const match = looseMatcher(search);
    return (data?.lines ?? []).filter((l) => (filter === 'all' || differs(l))
      && match(`${l.item} ${l.description ?? ''} ${l.location ?? ''}`));
  }, [data, filter, search]);

  const r = data?.lastCopy?.result;
  const at = data?.lastCopy?.at ?? '';
  const valueDiff = data && data.value.netsuite !== null ? data.value.fleetsuite - data.value.netsuite : 0;
  // Amber when all of the difference is value left over, explained on its items.
  const valueDiffColor = !valueDiff ? 'var(--text-muted)' : valueDiff === leftover.value ? AMBER : RED;
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
            for its moves. Each morning the daily check tells super admins when a count stops matching.{' '}
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
            {' · '}
            <Link href="/admin/books/balances" style={{ color: 'var(--text-secondary)' }}>Customer and vendor balances</Link>
            {' · '}
            <Link href="/admin/books/own-invoices" style={{ color: 'var(--text-secondary)' }}>Own invoices</Link>
            {' · '}
            <Link href="/admin/books/own-fulfillments" style={{ color: 'var(--text-secondary)' }}>Own fulfillments</Link>
          </div>
        </div>
        {canKeep && (
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
        )}
      </div>

      {error && <div style={banner(RED)}>{error}</div>}
      {copyError && <div style={banner(RED)}>{copyError}</div>}

      {data && (
        <>
          {!data.lastCopy && (
            <div style={banner(AMBER)}>NetSuite&apos;s stock moves haven&apos;t been copied yet. They&apos;re copied every two hours{canKeep ? ', or press Copy now' : ''}.</div>
          )}
          {r?.error && <div style={banner(RED)}>The last copy failed {ago(at)}: {r.error}</div>}
          {r && !r.error && r.partial && (
            <div style={banner(AMBER)}>
              Still copying: the last run, {ago(at)}, read {count(r.read ?? 0, 'document', 'documents')} and stopped for time. It carries on
              at the next run{canKeep ? ', or press Copy now again' : ''}. NetSuite&apos;s counts are read once every move is in.
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
          {data.setup.items.length > 0 && <SetupList setup={data.setup} />}

          {data.by && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px', fontSize: '12px' }}>
              <span style={chip(countsDiffering ? RED : GREEN)}>
                {countsDiffering ? `${count(countsDiffering, 'count differs', 'counts differ')} from NetSuite` : 'Every count matches NetSuite'}
              </span>
              {data.value.netsuite !== null && (
                <span style={chip(valuesDiffering ? RED : GREEN)}>
                  {valuesDiffering ? `${count(valuesDiffering, 'value differs', 'values differ')}`
                    : leftover.lines ? 'Every other value matches' : 'Every value matches'}
                </span>
              )}
              {leftover.lines > 0 && (
                <span style={chip(AMBER)}>{count(leftover.lines, 'item', 'items')} with value left over</span>
              )}
              {!data.setup.items.length && (
                <span style={chip(GREEN)}>Every stocked item&apos;s asset account checks out</span>
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
                <Row
                  label={(
                    <div>
                      <div>Every item at every location</div>
                      {leftover.lines > 0 && (
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {valueDiff === leftover.value ? 'All' : fmt(leftover.value)} of the difference is value left over
                          on {count(leftover.lines, 'item', 'items')} neither side has any of.
                        </div>
                      )}
                    </div>
                  )}
                >
                  <td style={cell}>{fmt(data.value.fleetsuite)}</td>
                  <td style={cell}>{data.value.netsuite === null ? '—' : fmt(data.value.netsuite)}</td>
                  <td style={{ ...cell, color: valueDiffColor, fontWeight: valueDiff ? 700 : 400 }}>{valueDiff ? fmt(valueDiff) : '—'}</td>
                </Row>
                {data.ledger.map((l) => (
                  <Fragment key={l.company}>
                    <Row
                      label={(
                        <div>
                          <div>{l.company}&apos;s inventory accounts in NetSuite&apos;s ledger</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            {accountNames || 'No inventory account yet'}. Its stocked items come to {fmt(l.items)}; each account is below.
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
                    {data.ledgerParts.filter((p) => p.company === l.company).map((p) => (
                      <Row
                        key={p.accountId}
                        label={(
                          <div style={{ paddingLeft: '12px' }}>
                            <a href={`#ledger-${p.company}-${p.accountId}`} className="rep-link">{p.account}</a>
                            {p.fixedAsset && <span style={{ color: 'var(--text-muted)' }}> · fixed asset</span>}
                          </div>
                        )}
                      >
                        <td style={cell}>{fmt(p.items.now)}</td>
                        <td style={cell}>{fmt(p.ledger.now)}</td>
                        <td style={{ ...cell, color: partColor(p, p.items.now - p.ledger.now) }}>
                          {p.items.now !== p.ledger.now ? fmt(p.items.now - p.ledger.now) : '—'}
                        </td>
                      </Row>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {data.ledgerParts.length > 0 && (
            <div style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '14px', fontWeight: 800, marginBottom: '2px' }}>Where NetSuite&apos;s ledger and the stocked items part</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                NetSuite moves an inventory account with the stocked items on it as they&apos;re received, shipped, built or adjusted.
                Anything else that posts to one, a journal entry say, or a bill for a truck on a fixed asset account, is listed here
                under the account, with where the account and its items stood on December 31, 2024. Each item&apos;s starting value
                counts on its own asset account.
              </div>
              {data.ledgerParts.map((p) => (
                <LedgerBreakdown key={`${p.company}-${p.accountId}`} part={p} named={data.ledger.length > 1} />
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
            <button onClick={() => setShow('count')} style={button(show === 'count')}>Counts</button>
            <button onClick={() => setShow('value')} style={button(show === 'value')}>Values</button>
            <span style={{ width: '8px' }} />
            <button onClick={() => pickFilter('all')} style={button(filter === 'all')}>All {data.lines.length.toLocaleString('en-US')}</button>
            <button
              onClick={() => pickFilter('differs')}
              style={{ ...button(filter === 'differs'), color: !differing ? 'var(--text-primary)' : differing === leftover.lines ? AMBER : RED }}
            >
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
                  <Row key={l.key} label={<ItemLabel line={l} wrong={wrong.has(l.itemId)} />} style={{ borderTop: '1px solid var(--border)' }}>
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
