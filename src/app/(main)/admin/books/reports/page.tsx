'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';

/**
 * Books → Reports (src/lib/books/reports.ts, migration 396, docs/books.md).
 *
 * FleetSuite's own profit and loss, balance sheet and trial balance, each
 * line next to NetSuite's own totals, for every month from January 2025.
 * Super admins only while the books are built, linked from the other books
 * pages.
 */

type Kind = 'profit_and_loss' | 'balance_sheet' | 'trial_balance';

interface Company {
  code: string;
  name: string;
  netsuite_subsidiary_id: string | null;
}

interface Line {
  kind: 'section' | 'heading' | 'account' | 'total';
  depth: number;
  label: string;
  number?: string | null;
  account?: string;
  inChart?: boolean;
  derived?: true;
  grand?: true;
  fleetsuite: number | null;
  netsuite: number | null;
  /** On an account line that differs: the months whose entries make up the difference, oldest first. */
  months?: Gap[];
}

interface Gap {
  month: string;
  difference: number;
}

interface Totals {
  debit: number;
  credit: number;
}

interface MonthStatus {
  month: string;
  matches: boolean;
  differing: number;
}

interface Payload {
  companies: Company[];
  company: string;
  posts: boolean;
  report: Kind;
  /** The profit and loss covers from through to; the balance sheet and trial balance are at to's end. */
  from: string;
  to: string;
  months: MonthStatus[];
  lines: Line[];
  differing: number;
  totals?: { fleetsuite: Totals; netsuite: Totals };
  checked: boolean;
  lastPosting: { at: string; error: string | null; partial: boolean } | null;
  lastCopy: { at: string; error: string | null } | null;
}

const KINDS: Array<[Kind, string]> = [
  ['profit_and_loss', 'Profit and loss'],
  ['balance_sheet', 'Balance sheet'],
  ['trial_balance', 'Trial balance'],
];

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
const plain = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const debitOf = (cents: number) => (cents > 0 ? plain.format(cents / 100) : '');
const creditOf = (cents: number) => (cents < 0 ? plain.format(-cents / 100) : '');
/** A trial balance amount in one column, as a phone shows it. */
const drCr = (cents: number) => (cents ? `${plain.format(Math.abs(cents) / 100)} ${cents > 0 ? 'Dr' : 'Cr'}` : '');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOf = (month: string) => MONTH_NAMES[Number(month.slice(5, 7)) - 1];
const monthName = (month: string) => `${monthOf(month)} ${month.slice(0, 4)}`;
const shortName = (month: string) => `${monthOf(month).slice(0, 3)} ${month.slice(0, 4)}`;
const monthEnd = (month: string) => {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${monthOf(month)} ${last}, ${month.slice(0, 4)}`;
};

function title(kind: Kind, from: string, to: string): string {
  if (kind === 'balance_sheet') return `Balance sheet, ${monthEnd(to)}`;
  if (kind === 'trial_balance') return `Trial balance, ${monthEnd(to)}`;
  if (from === to) return `Profit and loss, ${monthName(to)}`;
  if (from.slice(0, 4) === to.slice(0, 4)) return `Profit and loss, ${monthOf(from)} to ${monthName(to)}`;
  return `Profit and loss, ${monthName(from)} to ${monthName(to)}`;
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const lines = (n: number) => `${n} ${n === 1 ? 'line differs' : 'lines differ'}`;

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

const select: React.CSSProperties = {
  padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
  color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600,
};

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#fbbf24';

const labelCell = (line: Line): React.CSSProperties => ({
  ...cell, textAlign: 'left', whiteSpace: 'normal', paddingLeft: `${10 + line.depth * 14}px`, fontStyle: line.derived ? 'italic' : 'normal',
});

/** An account's number and name, and whether the chart has it. */
function AccountLabel({ line }: { line: Line }) {
  return (
    <>
      {line.number && <span style={{ color: 'var(--text-muted)', marginRight: '6px', fontWeight: 400 }}>{line.number}</span>}
      {line.label}
      {line.inChart === false && <span style={{ ...chip(AMBER), marginLeft: '6px' }}>Not in the chart yet</span>}
    </>
  );
}

/** The most months a line lists: its first, and the ones that add the most to its difference. */
const GAPS_SHOWN = 4;

function shownGaps(months: Gap[]): Gap[] {
  if (months.length <= GAPS_SHOWN) return months;
  const [first, ...rest] = months;
  const biggest = new Set([...rest].sort((x, y) => Math.abs(y.difference) - Math.abs(x.difference)).slice(0, GAPS_SHOWN - 1));
  return [first, ...rest.filter((g) => biggest.has(g))];
}

/** The months whose entries make a line differ, each opening Differences vs NetSuite at that month. */
function GapMonths({ line, company }: { line: Line; company: string }) {
  if (!line.months?.length) return null;
  const shown = shownGaps(line.months);
  const more = line.months.length - shown.length;
  return (
    <div style={{ fontSize: '11px', fontWeight: 400, fontStyle: 'normal', color: 'var(--text-muted)', marginTop: '2px' }}>
      Differs in{' '}
      {shown.map((g, i) => (
        <span key={g.month}>
          {/* The line may break after a month's dot, never inside a month, so a long list wraps on a phone. */}
          {i > 0 && ' · '}
          <span style={{ whiteSpace: 'nowrap' }}>
            {/* Differences starts in January 2025; FleetSuite entries dated earlier have no month there. */}
            {g.month < '2025-01-01' ? shortName(g.month) : (
              <Link
                href={deepLinks.booksDifferences(company, g.month)}
                style={{ color: 'var(--text-secondary)' }}
              >
                {shortName(g.month)}
              </Link>
            )}{' '}
            <span style={{ color: RED }}>{fmt(g.difference)}</span>
          </span>
        </span>
      ))}
      {more > 0 && ` and ${more} more ${more === 1 ? 'month' : 'months'}`}
    </div>
  );
}

/**
 * One line of a report: the account, then its amounts. On a phone the account
 * takes a row of its own above them (.rep-label-row in globals.css), so the
 * amounts fit across the screen: three columns on every report.
 */
function ReportRow({ line, company, style, children }: { line: Line; company: string; style: React.CSSProperties; children: React.ReactNode }) {
  const amounts = line.fleetsuite !== null && line.netsuite !== null;
  return (
    <>
      <tr className="rep-label-row" style={style}>
        <td colSpan={3} style={labelCell(line)}><AccountLabel line={line} /><GapMonths line={line} company={company} /></td>
      </tr>
      <tr className={amounts ? 'rep-amounts' : 'rep-amounts rep-amounts-empty'} style={style}>
        <td className="rep-label" style={labelCell(line)}><AccountLabel line={line} /><GapMonths line={line} company={company} /></td>
        {children}
      </tr>
    </>
  );
}

/** One line of the profit and loss or balance sheet. */
function StatementRow({ line, company }: { line: Line; company: string }) {
  const amounts = line.fleetsuite !== null && line.netsuite !== null;
  const diff = amounts ? line.fleetsuite! - line.netsuite! : 0;
  const total = line.kind === 'total';
  const style: React.CSSProperties = {
    borderTop: line.grand ? '3px double var(--border)' : total || line.kind === 'section' ? '1px solid var(--border)' : 'none',
    fontWeight: line.grand ? 800 : total || line.kind === 'section' ? 700 : line.kind === 'heading' ? 600 : 400,
  };
  return (
    <ReportRow line={line} company={company} style={style}>
      <td style={cell}>{amounts ? fmt(line.fleetsuite!) : ''}</td>
      <td style={cell}>{amounts ? fmt(line.netsuite!) : ''}</td>
      <td style={{ ...cell, color: diff ? RED : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>
        {amounts ? (diff ? fmt(diff) : '—') : ''}
      </td>
    </ReportRow>
  );
}

/** One account of the trial balance, debits and credits apart; on a phone, each side's in one column with Dr or Cr. */
function TrialBalanceRow({ line, company }: { line: Line; company: string }) {
  const diff = (line.fleetsuite ?? 0) - (line.netsuite ?? 0);
  return (
    <ReportRow line={line} company={company} style={{ borderTop: '1px solid var(--border)' }}>
      <td className="rep-wide" style={cell}>{debitOf(line.fleetsuite ?? 0)}</td>
      <td className="rep-wide" style={cell}>{creditOf(line.fleetsuite ?? 0)}</td>
      <td className="rep-wide" style={cell}>{debitOf(line.netsuite ?? 0)}</td>
      <td className="rep-wide" style={cell}>{creditOf(line.netsuite ?? 0)}</td>
      <td className="rep-narrow" style={cell}>{drCr(line.fleetsuite ?? 0)}</td>
      <td className="rep-narrow" style={cell}>{drCr(line.netsuite ?? 0)}</td>
      <td style={{ ...cell, color: diff ? RED : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>{diff ? fmt(diff) : '—'}</td>
    </ReportRow>
  );
}

export default function BooksReportsPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [onlyDifferences, setOnlyDifferences] = useState(false);

  const load = useCallback(async (next: { company?: string; report?: Kind; from?: string; to?: string }) => {
    try {
      const params = new URLSearchParams();
      if (next.company) params.set('company', next.company);
      if (next.report) params.set('report', next.report);
      if (next.from) params.set('from', next.from.slice(0, 7));
      if (next.to) params.set('to', next.to.slice(0, 7));
      const res = await apiFetch(`/api/admin/books/reports?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the report');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    load({});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  // A start after the end moves the end with it, and an end before the start the start.
  const pick = (next: { company?: string; report?: Kind; from?: string; to?: string }) => {
    if (!data) return;
    let from = next.from ?? data.from;
    let to = next.to ?? data.to;
    if (next.from && from > to) to = from;
    if (next.to && to < from) from = to;
    setLoading(true);
    load({ company: data.company, report: data.report, ...next, from, to });
  };

  const companyName = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company;
  const matching = data?.months.filter((m) => m.matches).length ?? 0;
  const isProfitAndLoss = data?.report === 'profit_and_loss';
  // Where a difference starts: the first month that differs in the range, or by its end.
  const firstDiffering = data?.months.find((m) => !m.matches && m.month <= data.to && (!isProfitAndLoss || m.month >= data.from));
  const picked = (month: string) => !!data && month <= data.to && month >= (isProfitAndLoss ? data.from : data.to);
  const years = [...new Set((data?.months ?? []).map((m) => m.month.slice(0, 4)))];
  const shown = (data?.lines ?? []).filter((l) => !onlyDifferences
    || ((l.kind === 'account' || l.kind === 'total') && l.fleetsuite !== l.netsuite));
  const isTrialBalance = data?.report === 'trial_balance';

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Reports</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          FleetSuite&apos;s own books, from what has posted to them, next to NetSuite&apos;s own totals, for each month from
          January 2025. Both start from NetSuite&apos;s balances on December 31, 2024, and are laid out as NetSuite&apos;s reports
          are. Visible only to super admins.{' '}
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

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          {!data.posts && (
            <div style={banner(AMBER)}>
              {companyName} doesn&apos;t post to FleetSuite&apos;s books yet, so its side holds only the starting balances from
              NetSuite.
            </div>
          )}
          {data.posts && !data.lastPosting && (
            <div style={banner(AMBER)}>Nothing has posted to FleetSuite&apos;s books yet. Posting runs every two hours, or press Post now on Invoices vs NetSuite.</div>
          )}
          {data.lastPosting?.error && <div style={banner(RED)}>The last posting run failed {ago(data.lastPosting.at)}: {data.lastPosting.error}</div>}
          {data.lastPosting && !data.lastPosting.error && data.lastPosting.partial && (
            <div style={banner(AMBER)}>
              Still posting: the last run, {ago(data.lastPosting.at)}, stopped for time, so some documents aren&apos;t in these
              reports yet. It carries on at the next run, or press Post now on Invoices vs NetSuite.
            </div>
          )}
          {!data.checked && (
            <div style={banner(AMBER)}>
              NetSuite&apos;s totals haven&apos;t been read yet. They&apos;re read with the copy of NetSuite&apos;s ledger every two
              hours, or press Copy now on Trial balance vs NetSuite.
            </div>
          )}
          {data.lastCopy?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s ledger failed {ago(data.lastCopy.at)}: {data.lastCopy.error}</div>}
          {data.posts && data.lastPosting && !data.lastPosting.error && !data.lastPosting.partial && data.checked && (
            <div style={banner(GREEN)}>
              Posted {ago(data.lastPosting.at)}. {matching} of {data.months.length} months match NetSuite.
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {data.companies.map((c) => (
              <button
                key={c.code}
                onClick={() => pick({ company: c.code })}
                disabled={loading}
                title={c.netsuite_subsidiary_id ? `NetSuite subsidiary ${c.netsuite_subsidiary_id}` : 'Not linked to NetSuite yet'}
                style={button(c.code === data.company)}
              >
                {c.name}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
            {KINDS.map(([kind, label]) => (
              <button key={kind} onClick={() => pick({ report: kind })} disabled={loading} style={button(kind === data.report)}>
                {label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {isProfitAndLoss ? (
              <>
                <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  From
                  <select value={data.from} onChange={(e) => pick({ from: e.target.value })} disabled={loading} style={select}>
                    {data.months.map((m) => <option key={m.month} value={m.month}>{shortName(m.month)}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  To
                  <select value={data.to} onChange={(e) => pick({ to: e.target.value })} disabled={loading} style={select}>
                    {data.months.map((m) => <option key={m.month} value={m.month}>{shortName(m.month)}</option>)}
                  </select>
                </label>
              </>
            ) : (
              <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                As of the end of
                <select value={data.to} onChange={(e) => pick({ to: e.target.value })} disabled={loading} style={select}>
                  {data.months.map((m) => <option key={m.month} value={m.month}>{shortName(m.month)}</option>)}
                </select>
              </label>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
            {years.map((year) => (
              <div key={year} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ width: '40px', fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)' }}>{year}</span>
                {data.months.filter((m) => m.month.startsWith(year)).map((m) => {
                  const color = !data.checked ? '#94a3b8' : m.matches ? GREEN : RED;
                  return (
                    <button
                      key={m.month}
                      onClick={() => pick(isProfitAndLoss ? { from: m.month, to: m.month } : { to: m.month })}
                      disabled={loading}
                      title={!data.checked ? 'Not checked yet' : m.matches ? 'Matches NetSuite' : lines(m.differing)}
                      style={{ ...button(picked(m.month)), borderColor: picked(m.month) ? 'var(--text-primary)' : `${color}88`, color }}
                    >
                      {monthOf(m.month).slice(0, 3)} {data.checked ? (m.matches ? '✓' : '✗') : ''}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: '6px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800 }}>
              {title(data.report, data.from, data.to)}
              {data.checked && (
                <span style={{ ...chip(data.differing ? RED : GREEN), marginLeft: '8px' }}>
                  {data.differing ? lines(data.differing) : 'Matches NetSuite'}
                </span>
              )}
            </div>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input type="checkbox" checked={onlyDifferences} onChange={(e) => setOnlyDifferences(e.target.checked)} />
              Only lines that differ
            </label>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            {isProfitAndLoss && (
              <>
                Income, cost of sales and expenses for the months picked, as on NetSuite&apos;s income statement, each account
                under its parent with a total for the parent. The ✓ and ✗ on the months above are for each month&apos;s
                own profit and loss.
              </>
            )}
            {data.report === 'balance_sheet' && (
              <>
                Balances at the month&apos;s end. Earlier years&apos; net income is in retained earnings and this year&apos;s is net
                income, as on NetSuite&apos;s balance sheet.
              </>
            )}
            {isTrialBalance && (
              <>
                Balance sheet accounts at their month-end balance, income and expenses for the year to date, and earlier
                years&apos; net income in retained earnings, as on NetSuite&apos;s Trial Balance report.
              </>
            )}
            {data.checked && data.differing > 0 && firstDiffering && (
              <>
                {' '}
                <Link
                  href={deepLinks.booksDifferences(data.company, firstDiffering.month)}
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Differences vs NetSuite
                </Link>{' '}
                shows which documents differ and why, from {monthName(firstDiffering.month)}.
              </>
            )}
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                {isTrialBalance ? (
                  <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                    <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Account</th>
                    <th className="rep-wide" style={cell}>FleetSuite debit</th>
                    <th className="rep-wide" style={cell}>FleetSuite credit</th>
                    <th className="rep-wide" style={cell}>NetSuite debit</th>
                    <th className="rep-wide" style={cell}>NetSuite credit</th>
                    <th className="rep-narrow" style={cell}>FleetSuite</th>
                    <th className="rep-narrow" style={cell}>NetSuite</th>
                    <th style={cell}>Difference</th>
                  </tr>
                ) : (
                  <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                    <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Account</th>
                    <th style={cell}>FleetSuite</th>
                    <th style={cell}>NetSuite</th>
                    <th style={cell}>Difference</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {!shown.some((l) => l.kind === 'account') && (
                  <tr><td colSpan={isTrialBalance ? 6 : 4} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                    {onlyDifferences ? 'Every line matches NetSuite.' : `Nothing on either side for ${data.from === data.to || !isProfitAndLoss ? 'this month' : 'these months'}.`}
                  </td></tr>
                )}
                {isTrialBalance && shown.map((l) => <TrialBalanceRow key={l.account ?? l.label} line={l} company={data.company} />)}
                {isTrialBalance && data.totals && (
                  <ReportRow
                    line={{ kind: 'total', depth: 0, label: 'Total', fleetsuite: 0, netsuite: 0 }}
                    company={data.company}
                    style={{ borderTop: '2px solid var(--border)', fontWeight: 800 }}
                  >
                    <td className="rep-wide" style={cell}>{plain.format(data.totals.fleetsuite.debit / 100)}</td>
                    <td className="rep-wide" style={cell}>{plain.format(data.totals.fleetsuite.credit / 100)}</td>
                    <td className="rep-wide" style={cell}>{plain.format(data.totals.netsuite.debit / 100)}</td>
                    <td className="rep-wide" style={cell}>{plain.format(data.totals.netsuite.credit / 100)}</td>
                    {(['fleetsuite', 'netsuite'] as const).map((side) => (
                      <td key={side} className="rep-narrow" style={cell}>
                        <div>{plain.format(data.totals![side].debit / 100)} Dr</div>
                        <div>{plain.format(data.totals![side].credit / 100)} Cr</div>
                      </td>
                    ))}
                    <td style={cell} />
                  </ReportRow>
                )}
                {!isTrialBalance && shown.map((l, i) => (
                  <StatementRow key={`${i}-${l.kind}-${l.account ?? l.label}`} line={l} company={data.company} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {loading && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
