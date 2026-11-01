'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { looseMatcher } from '@/lib/loose-search';
import { useFileDownload } from '@/lib/use-file-download';
import type { AccountTie, CompanyValue, MonthEntry, ValueLine } from '@/lib/books/inventory-value';
import type { LoadedInventoryValue } from '@/lib/books/inventory-value-data';

/**
 * Books → Inventory value (part 64, migration 495, src/lib/books/inventory-value.ts,
 * docs/books.md "Inventory value at a month's end"; the NetSuite Exit
 * Checklist's "Inventory moves and value", thread "Replacing NetSuite with
 * FleetSuite").
 *
 * What each stocked item was worth at the end of a month, item by item at
 * each location, and how that comes to each inventory account on the balance
 * sheet that day: from the stocked items to NetSuite's ledger as FleetSuite
 * copies it, NetSuite's own balance sheet and FleetSuite's, every cent
 * between them on a line of its own, so a month can be closed with stock
 * that ties. Each document counts in the month NetSuite posted it to. Last
 * month at first; any month from January 2025 through this one. Read only,
 * with an Excel file of the company and month shown. Open to whoever opens
 * the books.
 */

/** Items shown at once; Show more adds as many again. */
const PAGE = 300;
/** Documents an account lists at first; Show all lists every one sent. */
const ENTRIES_FIRST = 10;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
// What one cost on average, to four places as NetSuite keeps it.
const unit = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
/** A quantity as people write one: no trailing zeros, thousands grouped (as quantityText in stock-items.ts). */
const qty = (n: number) => {
  const rounded = Math.round(n * 1e5) / 1e5;
  return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString('en-US', { maximumFractionDigits: 5 });
};
const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOf = (month: string) => MONTH_NAMES[Number(month.slice(5, 7)) - 1];
const monthName = (month: string) => `${monthOf(month)} ${month.slice(0, 4)}`;
const monthEnd = (month: string) => {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${monthOf(month)} ${last}, ${month.slice(0, 4)}`;
};
const monthBefore = (month: string) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
};
/** Every month from `first` through `through`, newest first. */
const monthsBetween = (first: string, through: string) => {
  const list: string[] = [];
  for (let m = through; m >= first; m = monthBefore(m)) list.push(m);
  return list;
};
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (iso: string) => `${SHORT[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** "3 journals", "1 bill": how many documents of a kind, as a sentence names them (Stock by item's). */
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

const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};

// 16px so a phone doesn't zoom in on them.
const field: React.CSSProperties = {
  padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
  color: 'var(--text-primary)', fontSize: '16px', fontWeight: 600,
};

const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const labelCell: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };
const amountHead: React.CSSProperties = { ...cell, width: '15%' };

/**
 * A row of the items' table: its label, then the amounts. On a phone the
 * label takes a row of its own above them (.rep-label-row in globals.css),
 * as on Stock by item.
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

/** An item at a location: its number (opening its moves on Stock by item), where, what it is, and what's odd about it. */
function ItemLabel({ line }: { line: ValueLine }) {
  return (
    <div>
      <div>
        <Link href={deepLinks.booksStockItem(line.itemId, line.locationId)} className="rep-link" style={{ fontWeight: 700 }}>{line.item}</Link>
        {line.location && <span style={{ color: 'var(--text-secondary)', marginLeft: '6px' }}>at {line.location}</span>}
        {line.belowZero && <span style={{ ...chip(RED), marginLeft: '6px' }}>Fewer than none on hand</span>}
        {line.leftover && <span style={{ ...chip(AMBER), marginLeft: '6px' }}>None on hand, value left</span>}
      </div>
      {line.description && <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{line.description}</div>}
    </div>
  );
}

/** One line of an account's tie-out: what it is, then its amount; the totals bold, what's between them indented. */
function TieLine({ label, cents, total, color, top }: { label: React.ReactNode; cents: number; total?: boolean; color?: string; top?: boolean }) {
  return (
    <div style={{
      display: 'flex', gap: '10px', alignItems: 'baseline', padding: '5px 12px', fontSize: '12px',
      borderTop: top ? '1px solid var(--border)' : undefined, fontWeight: total ? 700 : 400, color,
    }}
    >
      <div style={{ flex: 1, minWidth: 0, paddingLeft: total ? 0 : '14px', overflowWrap: 'anywhere' }}>{label}</div>
      <div style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmt(cents)}</div>
    </div>
  );
}

/** A document that posted to the account on no stocked item: its number (opening its check), what, when, and what it posted. */
function EntryRow({ entry, company, month }: { entry: MonthEntry; company: string; month: string }) {
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
          {entry.inMonth && <span style={{ ...chip('#60a5fa'), marginLeft: '6px' }}>In {monthOf(month)}</span>}
        </div>
        {about && <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{about}</div>}
      </div>
      <div style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontWeight: 700 }}>{fmt(entry.amount)}</div>
    </div>
  );
}

/**
 * One inventory account at the month's end: the stocked items on it rolled
 * forward through the month, then everything between them and FleetSuite's
 * balance sheet, each on a line of its own, and the documents with no
 * stocked item behind them, the month's first.
 */
function TieCard({ tie, company, month }: { tie: AccountTie; company: string; month: string }) {
  const [all, setAll] = useState(false);
  const { entries } = tie;
  const rows = all ? entries.rows : entries.rows.slice(0, ENTRIES_FIRST);
  const muted = 'var(--text-secondary)';
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '10px', background: 'var(--card)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 12px 6px' }}>
        <div style={{ fontSize: '13px', fontWeight: 800 }}>
          {tie.account}
          {tie.fixedAsset && <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}> · fixed asset</span>}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {!tie.apart ? "FleetSuite's balance sheet holds what the stocked items on it are worth."
            : `FleetSuite's balance sheet holds ${fmt(Math.abs(tie.apart))} ${tie.apart < 0 ? 'less' : 'more'} than the stocked items on it are worth${
              tie.fixedAsset && tie.apart > 0 ? ", most likely the company's own equipment or vehicles" : ''}.`}
          {' '}
          <Link href={deepLinks.booksAccountDetail(company, tie.accountId, 'balance_sheet', '2025-01', month)} className="rep-link">
            Every document on it
          </Link>
        </div>
      </div>
      <TieLine label={`Stocked items at the end of ${monthName(monthBefore(month))}`} cents={tie.items.before} total top />
      {tie.items.moves.map((m) => (
        <TieLine key={m.type} label={`${m.type} · ${count(m.documents, 'document', 'documents')}`} cents={m.total} color={muted} />
      ))}
      <TieLine label={`Stocked items at the end of ${monthName(month)}`} cents={tie.items.end} total top />
      {tie.start !== 0 && (
        <TieLine label="Where NetSuite's ledger and the items stood apart on December 31, 2024" cents={tie.start} color={muted} />
      )}
      {entries.count > 0 && (
        <TieLine
          label={`${count(entries.count, 'document', 'documents')} since with no stocked item${entries.month.count ? `, ${entries.month.count} in ${monthOf(month)}` : ''}, below`}
          cents={entries.total}
          color={muted}
        />
      )}
      {tie.unexplained !== 0 && (
        <TieLine label="Not accounted for: FleetSuite's copy of NetSuite's ledger is off" cents={tie.unexplained} color={RED} />
      )}
      <TieLine label="NetSuite's ledger, as FleetSuite copies it" cents={tie.ledger} total top />
      {tie.notCopied !== 0 && (
        <TieLine label="In NetSuite's own totals, not copied yet" cents={tie.notCopied} color={muted} />
      )}
      <TieLine label="NetSuite's balance sheet" cents={tie.netsuite} total top />
      {tie.booksApart !== 0 && <TieLine label="FleetSuite's books apart from NetSuite's" cents={tie.booksApart} color={RED} />}
      <TieLine label="FleetSuite's balance sheet" cents={tie.books} total top />

      {entries.count > 0 && (
        <div style={{ padding: '6px 12px 10px', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
            {entries.kinds.map((k) => `${documents(k.type, k.count)}: ${fmt(k.total)}`).join(' · ')}.
            {' '}{monthName(month)}&apos;s first, then the biggest.
          </div>
          {rows.map((e) => <EntryRow key={e.doc} entry={e} company={company} month={month} />)}
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
        </div>
      )}
    </div>
  );
}

/** What the page warns about for the company and month shown, as inventoryNotes in report-workbook.ts says it in the file. */
function Warnings({ data, value }: { data: LoadedInventoryValue; value: CompanyValue | undefined }) {
  const { lastCopy: copy, lastPosting: posting } = data;
  return (
    <>
      {data.month === data.through && (
        <div style={banner(AMBER)}>{monthName(data.month)} isn&apos;t over yet, so this is where it stands now.</div>
      )}
      {!copy && (
        <div style={banner(AMBER)}>
          NetSuite&apos;s stock moves haven&apos;t been copied yet, so no item has a count or value. <Link href={deepLinks.booksStock()} className="rep-link">Stock by item</Link> copies them every two hours.
        </div>
      )}
      {copy?.error && (
        <div style={banner(RED)}>
          The last copy of NetSuite&apos;s stock moves failed {ago(copy.at)}: {copy.error}. <Link href={deepLinks.booksStock()} className="rep-link">Stock by item</Link>
        </div>
      )}
      {copy && !copy.error && copy.partial && (
        <div style={banner(AMBER)}>
          Still copying NetSuite&apos;s stock moves: the last run, {ago(copy.at)}, stopped for time, so some items&apos; moves aren&apos;t in yet.
          It carries on at the next run.
        </div>
      )}
      {posting?.error && <div style={banner(RED)}>The last posting run failed {ago(posting.at)}: {posting.error}</div>}
      {posting && !posting.error && posting.partial && (
        <div style={banner(AMBER)}>
          Still posting: the last run, {ago(posting.at)}, stopped for time, so some documents aren&apos;t in FleetSuite&apos;s books yet.
          It carries on at the next run.
        </div>
      )}
      {value?.netsuiteShort && (
        <div style={banner(AMBER)}>
          {value.netsuiteThrough
            ? `NetSuite's own totals for ${value.company} are read through ${monthName(value.netsuiteThrough)}, so NetSuite's balance sheet stops there.`
            : `NetSuite's own totals for ${value.company} haven't been read yet, so NetSuite's balance sheet holds only its starting entry.`}
        </div>
      )}
    </>
  );
}

export default function BooksInventoryValuePage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<LoadedInventoryValue | null>(null);
  const [company, setCompany] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const excel = useFileDownload(setError);

  const load = useCallback(async (month: string | null, asked: string | null) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/admin/books/inventory-value${month ? `?${new URLSearchParams({ month: month.slice(0, 7) })}` : ''}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      const loaded = json as LoadedInventoryValue;
      const codes = loaded.value.companies.map((c) => c.company);
      const picked = asked && codes.includes(asked) ? asked : codes[0] ?? null;
      setData(loaded);
      setCompany(picked);
      setError('');
      setShown(PAGE);
      // Keep the address on what's shown, so coming back from an item or a document opens it again.
      window.history.replaceState(null, '', deepLinks.booksInventoryValue(picked, loaded.month));
    } catch (e: any) {
      setError(e?.message || 'Could not load the inventory value');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // A link may name the company and month (deepLinks.booksInventoryValue).
    const q = new URLSearchParams(window.location.search);
    load(q.get('month'), q.get('company'));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const pickCompany = (next: string) => {
    setCompany(next);
    setShown(PAGE);
    if (data) window.history.replaceState(null, '', deepLinks.booksInventoryValue(next, data.month));
  };

  const value = data?.value.companies.find((c) => c.company === company);
  const visible = useMemo(() => {
    const match = looseMatcher(search);
    return (value?.lines ?? []).filter((l) => match(`${l.item} ${l.description ?? ''} ${l.location ?? ''}`));
  }, [value, search]);
  const belowZero = (value?.lines ?? []).filter((l) => l.belowZero).length;
  const leftover = (value?.lines ?? []).filter((l) => l.leftover).length;
  const unexplained = (value?.accounts ?? []).reduce((sum, a) => sum + a.unexplained, 0);
  const booksApart = (value?.accounts ?? []).reduce((sum, a) => sum + a.booksApart, 0);
  const onAccounts = (value?.accounts ?? []).reduce((sum, a) => sum + a.items.end, 0);
  const excelUrl = data && value && `/api/admin/books/inventory-value/download?${new URLSearchParams({ month: data.month.slice(0, 7), company: value.company })}`;
  const nameOf = (code: string) => data?.names.find((n) => n.code === code)?.name ?? code;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Inventory value</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          What each stocked item was worth at a month&apos;s end, and how that ties to each inventory account on the balance sheet
          that day, every cent between them named.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              Counts and values come from the same copy of NetSuite&apos;s documents as Stock by item, each document in the month
              NetSuite posted it to, from where each item stood on December 31, 2024. Under each account, the stocked items at the end
              of the month before, what moved them in the month by kind, and where they stood at its end; then where NetSuite&apos;s
              ledger and the items stood apart before FleetSuite&apos;s copies begin, the documents since that posted to the account on
              no stocked item, what NetSuite&apos;s own totals hold that the copy doesn&apos;t yet, and how far FleetSuite&apos;s books
              are from NetSuite&apos;s. Anything else is listed in red as not accounted for.
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href={deepLinks.booksStock()} style={{ color: 'var(--text-secondary)' }}>Stock by item</Link>
          {' · '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
          {' · '}
          <Link href="/admin/books/months" style={{ color: 'var(--text-secondary)' }}>Months</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', color: 'var(--text-secondary)' }}>
              At the end of
              <select value={data.month} onChange={(e) => load(e.target.value, company)} disabled={loading} style={field}>
                {monthsBetween(data.first, data.through).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
              </select>
            </label>
            {data.value.companies.length > 1 && data.value.companies.map((c) => (
              <button key={c.company} onClick={() => pickCompany(c.company)} disabled={loading} style={button(c.company === company)}>
                {nameOf(c.company)}
              </button>
            ))}
            {excelUrl && (
              <button
                onClick={() => excel.download(excelUrl, 'Inventory value.xlsx')}
                disabled={loading || excel.busy}
                title="Each item's value, how it ties to each inventory account, and the documents with no stocked item, as an Excel file"
                style={button(false)}
              >
                {excel.busy ? 'Making the file…' : excel.ready(excelUrl) ? '⬇ Tap to save the Excel file' : '⬇ Download Excel'}
              </button>
            )}
          </div>

          <Warnings data={data} value={value} />

          {!value ? (
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              No company had stock or an inventory account at the end of {monthName(data.month)}.
            </div>
          ) : (
            <>
              <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', background: 'var(--card)' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{nameOf(value.company)}&apos;s stocked items on {monthEnd(data.month)}</div>
                <div style={{ fontSize: '22px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmt(value.value)}</div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginTop: '4px' }}>
                  <span style={chip(unexplained ? RED : GREEN)}>
                    {unexplained ? `${fmt(unexplained)} not accounted for` : 'Every cent to the balance sheet named'}
                  </span>
                  {!value.netsuiteShort && (
                    <span style={chip(booksApart ? RED : GREEN)}>
                      {booksApart ? `FleetSuite's books ${fmt(booksApart)} apart from NetSuite's` : "FleetSuite's books match NetSuite's"}
                    </span>
                  )}
                  {belowZero > 0 && <span style={chip(RED)}>{count(belowZero, 'item', 'items')} below zero</span>}
                  {leftover > 0 && <span style={chip(AMBER)}>{count(leftover, 'item', 'items')} with value and none on hand</span>}
                  {onAccounts !== value.value && (
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {fmt(value.value - onAccounts)} of it is on items whose asset account isn&apos;t an inventory account; Stock by item lists them.
                    </span>
                  )}
                </div>
              </div>

              {value.accounts.length > 0 && (
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 800, marginBottom: '6px' }}>How it ties to the balance sheet</div>
                  {value.accounts.map((a) => <TieCard key={a.accountId} tie={a} company={value.company} month={data.month} />)}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 800, marginRight: 'auto' }}>
                  Each item, {count(value.lines.length, 'line', 'lines')}
                </div>
                <input
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }}
                  placeholder="Search item or location"
                  style={{ ...field, fontWeight: 400, flex: '1 1 180px', minWidth: 0, maxWidth: '280px' }}
                />
              </div>
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
                <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                      <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Item</th>
                      <th style={amountHead}>On hand</th>
                      <th style={amountHead}>Average cost</th>
                      <th style={amountHead}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!visible.length && (
                      <tr><td colSpan={4} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                        {search ? 'No item matches that search.' : `No item had any on hand or any value at the end of ${monthName(data.month)}.`}
                      </td></tr>
                    )}
                    {visible.slice(0, shown).map((l) => (
                      <Row key={l.key} label={<ItemLabel line={l} />} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...cell, color: l.belowZero ? RED : undefined, fontWeight: l.belowZero ? 700 : 400 }}>{qty(l.quantity)}</td>
                        <td style={{ ...cell, color: l.averageCost === null ? 'var(--text-muted)' : undefined }}>
                          {l.averageCost === null ? '—' : unit.format(l.averageCost / 100)}
                        </td>
                        <td style={cell}>{fmt(l.value)}</td>
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
            </>
          )}
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
