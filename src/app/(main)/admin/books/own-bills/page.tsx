'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { looseMatcher } from '@/lib/loose-search';
import type { OwnCheckStatus } from '@/lib/books/own-invoice-check';
import type { OwnBillCheck } from '@/lib/books/own-bill-check';
import type { OwnBooks } from '@/lib/books/own-invoice-posting';
import { ownBooksChip, ownBooksCount } from '@/lib/books/own-posting-text';

/**
 * Books → Own bills (migration 435, src/lib/books/own-bills.ts and
 * own-bill-check.ts, docs/books.md "FleetSuite's own bills and receipts";
 * owner decision 2026-10-24, "Shared bills").
 *
 * Books' own copy of each bill FleetSuite puts into NetSuite (Send to NetSuite
 * on Snap a bill, Create Bill in NetSuite on a CNI vendor invoice or an
 * installer payout, Create bill on a Parts Mail invoice), next to NetSuite's
 * bill, a month at a time: the ones
 * that differ first, with why in a sentence. Tap one for its line by line
 * check. The daily check tells the super admins when one differs and links
 * here (?only=differs) or to the bill. Each says what the books hold for
 * NetSuite's bill and which copy made it (migration 456,
 * src/lib/books/own-bill-posting.ts). Super admins only, as the books are.
 */

type Row = Omit<OwnBillCheck, 'fields' | 'lines' | 'workedOut'> & {
  netsuiteUrl: string | null; poUrl: string | null; madeByName: string | null; books: OwnBooks | null;
};

interface SyncState { at: string; error: string | null }

interface Payload {
  months: Array<{ month: string; bills: number }>;
  month: string | null;
  bills: Row[];
  counts: Record<OwnCheckStatus, number> | null;
  lastBills: SyncState | null;
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

/** Each status: its chip, its button, its color, and what the NetSuite column says when NetSuite's side has no amount. */
const STATUS: Record<OwnCheckStatus, { chip: string; button: [string, string]; color: string; none: string }> = {
  differs: { chip: 'Differs', button: ['differs', 'differ'], color: RED, none: 'Not known' },
  incomplete: { chip: 'Incomplete', button: ['incomplete', 'incomplete'], color: AMBER, none: 'Not known' },
  waiting: { chip: 'Waiting', button: ['waiting', 'waiting'], color: BLUE, none: 'Not yet' },
  matches: { chip: 'Matches', button: ['matches', 'match'], color: GREEN, none: 'Not known' },
  voided: { chip: 'Gone from NetSuite', button: ['gone', 'gone'], color: GRAY, none: 'Gone' },
};
const ORDER: readonly OwnCheckStatus[] = ['differs', 'incomplete', 'waiting', 'matches', 'voided'];

/** Where FleetSuite made it, in a few words. */
const MADE_FROM: Record<OwnBillCheck['madeFrom'], string> = {
  vendor_invoice: 'CNI vendor invoice',
  payout: 'Installer payout',
  parts_mail: 'Parts Mail',
  snapped: 'Snap a bill',
};

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

/** A bill: its vendor and number (opening its check), status, what the books hold, the sentence saying how it compares, and where it came from. */
function BillLabel({ r }: { r: Row }) {
  const s = STATUS[r.status];
  const books = ownBooksChip(r.books, r.status);
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' }}>
        <span style={{ color: 'var(--text-muted)' }}>{dayText(r.date)}</span>
        <span style={{ fontWeight: 700 }}>{r.vendor ?? 'A vendor'}</span>
        <Link href={deepLinks.booksOwnBill(r.netsuiteId)} className="rep-link" style={{ fontWeight: 700 }}>{r.number}</Link>
        <span style={chip(s.color)}>{s.chip}</span>
        {books && <span style={chip(books.color)}>{books.label}</span>}
      </div>
      <div style={{ fontSize: '11px', color: r.status === 'differs' ? RED : 'var(--text-muted)', overflowWrap: 'anywhere' }}>
        {r.summary}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
        {r.madeFrom === 'snapped' && r.madeFromId ? (
          <Link href={deepLinks.booksSnapBill(r.madeFromId)} style={{ color: 'var(--text-secondary)' }}>
            {r.madeByName ? `Snapped by ${r.madeByName}` : MADE_FROM.snapped}
          </Link>
        ) : MADE_FROM[r.madeFrom]}
        {r.poNumber ? `, ${r.poNumber}` : ''}
        {r.netsuiteUrl && (
          <>
            {' · '}
            <a href={r.netsuiteUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)' }}>Bill in NetSuite ↗</a>
          </>
        )}
      </div>
    </div>
  );
}

export default function BooksOwnBillsPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [company, setCompany] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async (month: string, nextFilter: Filter) => {
    try {
      const res = await apiFetch(`/api/admin/books/own-bills${month ? `?${new URLSearchParams({ month })}` : ''}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setFilter(nextFilter);
      setError('');
      // Keep the address on what's shown, so going back here opens it again.
      window.history.replaceState(null, '', deepLinks.booksOwnBills(json.month, nextFilter === 'differs'));
    } catch (e: any) {
      setError(e?.message || 'Could not load the own bills');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // The daily check's notification about several own bills opens the ones that differ (deepLinks.booksOwnBills).
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
    window.history.replaceState(null, '', deepLinks.booksOwnBills(data.month, next === 'differs'));
  };

  // The companies the month's bills are for: a button each once there's more than one.
  const companies = useMemo(() => {
    const byCompany = new Map<string, number>();
    for (const r of data?.bills ?? []) byCompany.set(r.company, (byCompany.get(r.company) ?? 0) + 1);
    return [...byCompany.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);
  const shownCompany = company && companies.some(([c]) => c === company) ? company : null;

  const visible = useMemo(() => {
    const match = looseMatcher(search);
    const rows = (data?.bills ?? []).filter((r) => (filter === 'all' || r.status === filter)
      && (!shownCompany || r.company === shownCompany)
      && match(r.number, r.vendor ?? '', r.poNumber ?? '', MADE_FROM[r.madeFrom], r.madeByName ?? ''));
    // The ones that differ first, then as they came (newest first).
    return rows.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  }, [data, filter, search, shownCompany]);

  const counts = data?.counts;
  const total = data?.bills.length ?? 0;
  const booksCount = ownBooksCount(data?.bills ?? []);

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Own bills</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Each bill FleetSuite puts into NetSuite, from Snap a bill, Parts Mail, CNI vendor invoices or installer payouts,
          kept by Books and checked against NetSuite&apos;s copy; tap one for its line by line check. Nothing here changes
          NetSuite. The books post each one from this copy when it matches NetSuite&apos;s and its entry comes out the same,
          and from NetSuite&apos;s otherwise. Each morning the daily check tells super admins when one differs. Visible only
          to super admins.{' '}
          <Link href={deepLinks.booksSnapBill()} style={{ color: 'var(--text-secondary)' }}>Snap a bill</Link>
          {' · '}
          <Link href="/admin/books/own-receipts" style={{ color: 'var(--text-secondary)' }}>Own receipts</Link>
          {' · '}
          <Link href="/admin/books/mistake-checks" style={{ color: 'var(--text-secondary)' }}>Mistake checks</Link>
          {' · '}
          <Link href="/admin/books/own-invoices" style={{ color: 'var(--text-secondary)' }}>Own invoices</Link>
          {' · '}
          <Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link>
          {' · '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          {data.lastBills?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s bills failed {ago(data.lastBills.at)}: {data.lastBills.error}</div>}
          {data.lastLedger?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s ledger failed {ago(data.lastLedger.at)}: {data.lastLedger.error}</div>}
          {data.lastLists?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s lists failed {ago(data.lastLists.at)}: {data.lastLists.error}</div>}
          {data.lastCheck?.error && <div style={banner(RED)}>The daily check couldn&apos;t look at everything {ago(data.lastCheck.at)}: {data.lastCheck.error}</div>}
          {data.lastBills && !data.lastBills.error && (
            <div style={note}>
              NetSuite&apos;s bills copied {ago(data.lastBills.at)}
              {data.lastLedger ? `, its ledger ${ago(data.lastLedger.at)}` : ''}
              {data.lastLists ? `, its lists ${ago(data.lastLists.at)}` : ''}.
              {data.lastCheck && ` The daily check looked ${ago(data.lastCheck.at)}.`}
            </div>
          )}

          {!data.months.length && (
            <div style={banner(BLUE)}>
              FleetSuite hasn&apos;t made a bill since Books started keeping its own copies. The next one sent from Snap a bill,
              made with Create Bill in NetSuite on a CNI vendor invoice or an installer payout, or with Create bill on a Parts
              Mail invoice, shows up here.
            </div>
          )}

          {data.months.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
              {data.months.map((m) => (
                <button key={m.month} onClick={() => pickMonth(m.month)} disabled={loading} style={button(m.month === data.month)}>
                  {monthText(m.month)} · {m.bills.toLocaleString('en-US')}
                </button>
              ))}
            </div>
          )}

          {companies.length > 1 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
              <button onClick={() => setCompany(null)} style={button(!shownCompany)}>Both companies</button>
              {companies.map(([c, n]) => (
                <button key={c} onClick={() => setCompany(c)} style={button(shownCompany === c)}>{c} · {n.toLocaleString('en-US')}</button>
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
                placeholder="Search bills, vendors or POs"
                style={{ padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', flex: '1 1 180px', minWidth: 0, maxWidth: '280px' }}
              />
            </div>
          )}

          {booksCount && <div style={{ ...note, color: 'var(--text-secondary)' }}>{booksCount}</div>}

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
                      {search ? 'No bill matches that search.' : filter === 'differs' ? "Every own bill this month matches NetSuite's or isn't checked yet." : 'No own bills this month.'}
                    </td></tr>
                  )}
                  {visible.map((r) => {
                    const diff = r.fleetsuiteCents === null || r.netsuiteCents === null ? null : r.fleetsuiteCents - r.netsuiteCents;
                    return (
                      <TableRow key={r.netsuiteId} label={<BillLabel r={r} />} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...cell, color: r.fleetsuiteCents === null ? 'var(--text-muted)' : undefined }}>
                          {r.fleetsuiteCents === null ? 'Not known' : fmt(r.fleetsuiteCents)}
                        </td>
                        <td style={{ ...cell, color: r.netsuiteCents === null ? 'var(--text-muted)' : undefined }}>
                          {r.netsuiteCents === null ? STATUS[r.status].none : fmt(r.netsuiteCents)}
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
