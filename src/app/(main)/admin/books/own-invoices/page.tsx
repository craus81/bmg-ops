'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { looseMatcher } from '@/lib/loose-search';
import type { OwnCheckStatus, OwnInvoiceCheck } from '@/lib/books/own-invoice-check';
import type { OwnBooks } from '@/lib/books/own-invoice-posting';

/**
 * Books → Own invoices (migration 407, src/lib/books/own-invoices.ts and
 * own-invoice-check.ts, docs/books.md "FleetSuite's own invoices"; owner
 * decision 2026-10-19, "Own invoices").
 *
 * FleetSuite's own copy of each invoice it makes, worked out by its own
 * rules, next to NetSuite's invoice, a month at a time: the ones that differ
 * first, with why in a sentence, and which copy the books posted it from
 * (migration 409, src/lib/books/own-invoice-posting.ts). Tap one for its
 * line by line check. The daily check tells the super admins when one
 * differs and links here (?only=differs) or to the invoice. Open to whoever
 * opens the books.
 */

type Row = Omit<OwnInvoiceCheck, 'fields' | 'lines' | 'workedOut'> & { books: OwnBooks | null };

interface SyncState { at: string; error: string | null }

interface Payload {
  months: Array<{ month: string; invoices: number }>;
  month: string | null;
  invoices: Row[];
  counts: Record<OwnCheckStatus, number> | null;
  lastMirror: SyncState | null;
  lastCopy: SyncState | null;
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
  voided: { chip: 'Voided in NetSuite', button: ['voided', 'voided'], color: GRAY },
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

/** Which copy of an invoice the books posted it from, as a chip. */
function booksChip(books: OwnBooks | null): { label: string; color: string } {
  if (!books) return { label: 'Not posted yet', color: GRAY };
  return books.from === 'fleetsuite' ? { label: `Entry ${books.entryNo} · own copy`, color: GREEN } : { label: `Entry ${books.entryNo} · NetSuite's`, color: GRAY };
}

/** An invoice: its number (opening its check), status, customer, what the books hold, how it was made and the sentence saying how it compares. */
function InvoiceLabel({ r }: { r: Row }) {
  const s = STATUS[r.status];
  const books = booksChip(r.books);
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' }}>
        <span style={{ color: 'var(--text-muted)' }}>{dayText(r.date)}</span>
        <Link href={deepLinks.booksOwnInvoice(r.netsuiteId)} className="rep-link" style={{ fontWeight: 700 }}>{r.number}</Link>
        {r.customer && <span>· {r.customer}</span>}
        <span style={chip(s.color)}>{s.chip}</span>
        {r.status !== 'voided' && <span style={chip(books.color)}>{books.label}</span>}
      </div>
      <div style={{ fontSize: '11px', color: r.status === 'differs' ? RED : 'var(--text-muted)', overflowWrap: 'anywhere' }}>
        {r.summary}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>From {r.madeFromText}</div>
    </div>
  );
}

export default function BooksOwnInvoicesPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async (month: string, nextFilter: Filter) => {
    try {
      const res = await apiFetch(`/api/admin/books/own-invoices${month ? `?${new URLSearchParams({ month })}` : ''}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setFilter(nextFilter);
      setError('');
      // Keep the address on what's shown, so going back here opens it again.
      window.history.replaceState(null, '', deepLinks.booksOwnInvoices(json.month, nextFilter === 'differs'));
    } catch (e: any) {
      setError(e?.message || 'Could not load the own invoices');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // The daily check's notification about several own invoices opens the ones that differ (deepLinks.booksOwnInvoices).
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
    window.history.replaceState(null, '', deepLinks.booksOwnInvoices(data.month, next === 'differs'));
  };

  const visible = useMemo(() => {
    const match = looseMatcher(search);
    const rows = (data?.invoices ?? []).filter((r) => (filter === 'all' || r.status === filter) && match(r.number, r.customer ?? ''));
    // The ones that differ first, then as they came (newest first).
    return rows.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  }, [data, filter, search]);

  const counts = data?.counts;
  const total = data?.invoices.length ?? 0;
  const fromOwn = data?.invoices.filter((r) => r.books?.from === 'fleetsuite').length ?? 0;
  const fromNetsuite = data?.invoices.filter((r) => r.books?.from === 'netsuite').length ?? 0;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Own invoices</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          FleetSuite&apos;s own copy of each invoice it makes, worked out by its own rules: the lines it billed, sales tax at the rate
          in Settings → Sales Tax on the lines it taxes (not service items, tax-exempt customers or work at Social Circle, Georgia),
          and the due date from the customer&apos;s terms. Each is put next to NetSuite&apos;s invoice; tap one for its line by line
          check. The books post a copy that matches NetSuite&apos;s invoice, and makes the same entry, in place of NetSuite&apos;s; one
          that doesn&apos;t keeps posting NetSuite&apos;s, since that&apos;s what the customer was billed. Each morning the daily check
          tells super admins when one differs.{' '}
          <Link href="/admin/books/invoices" style={{ color: 'var(--text-secondary)' }}>Invoices vs NetSuite</Link>
          {' · '}
          <Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link>
          {' · '}
          <Link href="/admin/books/balances" style={{ color: 'var(--text-secondary)' }}>Customer and vendor balances</Link>
          {' · '}
          <Link href="/admin/books/lists" style={{ color: 'var(--text-secondary)' }}>NetSuite lists</Link>
          {' · '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
          {' · '}
          <Link href="/admin/books/own-fulfillments" style={{ color: 'var(--text-secondary)' }}>Own fulfillments</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          {data.lastMirror?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s invoices failed {ago(data.lastMirror.at)}: {data.lastMirror.error}</div>}
          {data.lastCopy?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s ledger failed {ago(data.lastCopy.at)}: {data.lastCopy.error}</div>}
          {data.lastLists?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s lists failed {ago(data.lastLists.at)}: {data.lastLists.error}</div>}
          {data.lastCheck?.error && <div style={banner(RED)}>The daily check couldn&apos;t look at everything {ago(data.lastCheck.at)}: {data.lastCheck.error}</div>}
          {data.lastMirror && !data.lastMirror.error && (
            <div style={note}>
              NetSuite&apos;s invoices copied {ago(data.lastMirror.at)}
              {data.lastCopy ? `, its ledger ${ago(data.lastCopy.at)}` : ''}
              {data.lastLists ? `, its customers and items ${ago(data.lastLists.at)}` : ''}.
              {data.lastCheck && ` The daily check looked ${ago(data.lastCheck.at)}.`}
            </div>
          )}

          {!data.months.length && (
            <div style={banner(BLUE)}>
              FleetSuite hasn&apos;t made an invoice since it started keeping its own copies. The next one made from a finished
              vehicle, a sales order, a PO, the Scan Log or a graphics job shows up here.
            </div>
          )}

          {data.months.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
              {data.months.map((m) => (
                <button key={m.month} onClick={() => pickMonth(m.month)} disabled={loading} style={button(m.month === data.month)}>
                  {monthText(m.month)} · {m.invoices.toLocaleString('en-US')}
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
                placeholder="Search invoices or customers"
                style={{ padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', flex: '1 1 180px', minWidth: 0, maxWidth: '280px' }}
              />
            </div>
          )}

          {fromOwn + fromNetsuite > 0 && (
            <div style={note}>
              In FleetSuite&apos;s books: {count(fromOwn, 'invoice', 'invoices')} from FleetSuite&apos;s own copy
              {fromNetsuite ? `, ${count(fromNetsuite, 'invoice', 'invoices')} from NetSuite's` : ''}.
            </div>
          )}

          {data.month && (
            <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
              <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
                <thead>
                  <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                    <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Made in {monthText(data.month)}</th>
                    <th style={amountHead}>FleetSuite</th>
                    <th style={amountHead}>NetSuite</th>
                    <th style={amountHead}>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {!visible.length && (
                    <tr><td colSpan={4} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                      {search ? 'No invoice matches that search.' : filter === 'differs' ? "Every own invoice this month matches NetSuite's or isn't checked yet." : 'No own invoices this month.'}
                    </td></tr>
                  )}
                  {visible.map((r) => {
                    const diff = r.netsuiteTotal === null ? null : r.fleetsuiteTotal - r.netsuiteTotal;
                    return (
                      <TableRow key={r.netsuiteId} label={<InvoiceLabel r={r} />} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={cell}>{fmt(r.fleetsuiteTotal)}</td>
                        <td style={{ ...cell, color: r.netsuiteTotal === null ? 'var(--text-muted)' : undefined }}>
                          {r.netsuiteTotal === null ? 'Not copied' : fmt(r.netsuiteTotal)}
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
