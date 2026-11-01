'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess, booksAllows } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';

/**
 * Books → Trial balance vs NetSuite (migration 361, docs/books.md).
 *
 * NetSuite's general ledger from January 2025 is copied into FleetSuite every
 * two hours (or on "Copy now"), and each company's month-end balances are
 * shown next to NetSuite's own. Open to whoever opens the books, linked from
 * the accounts page.
 */

interface Company {
  code: string;
  name: string;
  netsuite_subsidiary_id: string | null;
}

interface MonthStatus {
  month: string;
  matches: boolean;
  differing: number;
}

interface Row {
  netsuiteAccountId: string | null;
  number: string | null;
  name: string;
  statement: 'balance_sheet' | 'income_statement';
  retained?: true;
  inChart: boolean;
  copied: number;
  netsuite: number;
}

interface Totals {
  debit: number;
  credit: number;
}

interface RunResult {
  monthsBy?: 'posting_period' | 'transaction_date';
  netsuiteAsOf?: string;
  monthsChecked?: number;
  monthsDiffering?: string[];
  swept?: string[];
  partial?: boolean;
  notes?: string[];
  error?: string;
}

interface Payload {
  companies: Company[];
  company: string;
  month: string;
  months: MonthStatus[];
  rows: Row[];
  totals: { copied: Totals; netsuite: Totals };
  checked: boolean;
  lastRun: { at: string; result: RunResult } | null;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents: number) => money.format(cents / 100);
const debitOf = (cents: number) => (cents > 0 ? fmt(cents) : '');
const creditOf = (cents: number) => (cents < 0 ? fmt(-cents) : '');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

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

const button = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: '8px', border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border)'}`,
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: active ? 800 : 600, cursor: 'pointer',
});

const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

export default function BooksTrialBalancePage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  // Copying now isn't the CPA's.
  const canKeep = booksAllows(booksAccess(hasRole), 'keep');
  const [data, setData] = useState<Payload | null>(null);
  const [company, setCompany] = useState('');
  const [month, setMonth] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [onlyDifferences, setOnlyDifferences] = useState(false);

  const load = useCallback(async (nextCompany: string, nextMonth: string) => {
    try {
      const params = new URLSearchParams();
      if (nextCompany) params.set('company', nextCompany);
      if (nextMonth) params.set('month', nextMonth === 'start' ? 'start' : nextMonth.slice(0, 7));
      const res = await apiFetch(`/api/admin/books/trial-balance?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setCompany(json.company);
      setMonth(json.month);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the trial balance');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    load('', '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  // How the copy went is recorded either way and shows in the banners after
  // the reload; copyError is only for a request that never got that far.
  const copyNow = async () => {
    setCopying(true);
    setCopyError('');
    try {
      const res = await apiFetch('/api/admin/books/trial-balance', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Copy failed (${res.status})`);
      if (json.skipped) setCopyError(`${json.skipped} Try again in a few minutes.`);
    } catch (e: any) {
      setCopyError(e?.message || 'Copy failed');
    }
    await load(company, month);
    setCopying(false);
  };

  const pick = (nextCompany: string, nextMonth: string) => {
    setLoading(true);
    load(nextCompany, nextMonth);
  };

  const run = data?.lastRun?.result;
  const matching = data?.months.filter((m) => m.matches).length ?? 0;
  const selected = data?.months.find((m) => m.month === month);
  const rows = (data?.rows ?? []).filter((r) => !onlyDifferences || r.copied !== r.netsuite);
  const years = [...new Set((data?.months ?? []).map((m) => m.month.slice(0, 4)))];

  return (
    <div>
      <div style={{ marginBottom: '14px', display: 'flex', gap: '12px', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px' }}>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>Trial balance vs NetSuite</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            NetSuite&apos;s general ledger from January 2025, copied into FleetSuite&apos;s books every two hours, starting from
            NetSuite&apos;s balances on December 31, 2024. Each month-end balance is checked against NetSuite&apos;s own totals.
            {' '}<Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
            {' · '}
            <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
            {' · '}
            <Link href="/admin/books/lists" style={{ color: 'var(--text-secondary)' }}>NetSuite lists</Link>
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
        {canKeep && (
          <button
            onClick={copyNow}
            disabled={copying || loading}
            style={{
              padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
              color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: copying ? 'wait' : 'pointer',
            }}
          >
            {copying ? 'Copying… up to 4 minutes' : 'Copy now'}
          </button>
        )}
      </div>

      {error && <div style={banner('#ef4444')}>{error}</div>}
      {copyError && <div style={banner('#ef4444')}>{copyError}</div>}

      {data && (
        <>
          {!data.lastRun && (
            <div style={banner('#fbbf24')}>
              Nothing has been copied yet. The copy runs every two hours{canKeep ? ', or press Copy now' : ''}. The first copy takes a few runs.
            </div>
          )}
          {run?.error && <div style={banner('#ef4444')}>The last copy failed {ago(data.lastRun!.at)}: {run.error}</div>}
          {data.lastRun && !run?.error && run?.partial && (
            <div style={banner('#fbbf24')}>
              Still copying: the last run, {ago(data.lastRun.at)}, copied {run.swept?.length ?? 0} month(s) and stopped for time.
              It carries on at the next run{canKeep ? ', or press Copy now' : ''}.
            </div>
          )}
          {data.lastRun && !run?.error && !run?.partial && (
            <div style={banner('#22c55e')}>
              Copied {ago(data.lastRun.at)}{run?.swept?.length ? ` (${run.swept.length} month(s) refreshed)` : ''}.
              {data.checked && ` ${matching} of ${data.months.length} months match NetSuite.`}
            </div>
          )}
          {(run?.notes ?? []).map((n) => <div key={n} style={banner('#fbbf24')}>{n}</div>)}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {data.companies.map((c) => (
              <button
                key={c.code}
                onClick={() => pick(c.code, month)}
                disabled={loading}
                title={c.netsuite_subsidiary_id ? `NetSuite subsidiary ${c.netsuite_subsidiary_id}` : 'Not linked to NetSuite yet'}
                style={button(c.code === company)}
              >
                {c.name}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              <button onClick={() => pick(company, 'start')} disabled={loading} style={button(month === 'start')}>
                Start (Dec 31, 2024)
              </button>
            </div>
            {years.map((year) => (
              <div key={year} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ width: '40px', fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)' }}>{year}</span>
                {data.months.filter((m) => m.month.startsWith(year)).map((m) => {
                  const color = !data.checked ? '#94a3b8' : m.matches ? '#22c55e' : '#ef4444';
                  return (
                    <button
                      key={m.month}
                      onClick={() => pick(company, m.month)}
                      disabled={loading}
                      title={!data.checked ? 'Not checked yet' : m.matches ? 'Matches NetSuite' : `${m.differing} account(s) differ from NetSuite`}
                      style={{ ...button(m.month === month), borderColor: m.month === month ? 'var(--text-primary)' : `${color}88`, color }}
                    >
                      {MONTH_NAMES[Number(m.month.slice(5, 7)) - 1]} {data.checked ? (m.matches ? '✓' : '✗') : ''}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: '8px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800 }}>
              {month === 'start' ? 'Starting balances, December 31, 2024' : `${monthName(month)} month end`}
              {month !== 'start' && data.checked && selected && (
                <span style={{ ...chip(selected.matches ? '#22c55e' : '#ef4444'), marginLeft: '8px' }}>
                  {selected.matches ? 'Matches NetSuite' : `${selected.differing} account(s) differ`}
                </span>
              )}
            </div>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input type="checkbox" checked={onlyDifferences} onChange={(e) => setOnlyDifferences(e.target.checked)} />
              Only accounts that differ
            </label>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            Balance sheet accounts at their month-end balance; income and expenses for the year to date; earlier years&apos; net
            income in retained earnings, as on NetSuite&apos;s Trial Balance report.
            {run?.monthsBy === 'transaction_date' && ' Months follow each transaction’s date, because NetSuite’s accounting periods couldn’t be read.'}
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th style={{ ...cell, textAlign: 'left' }} colSpan={2}>Account</th>
                  <th style={cell}>FleetSuite debit</th>
                  <th style={cell}>FleetSuite credit</th>
                  <th style={cell}>NetSuite debit</th>
                  <th style={cell}>NetSuite credit</th>
                  <th style={cell}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                    {onlyDifferences ? 'Every account matches.' : 'No balances for this month yet.'}
                  </td></tr>
                )}
                {rows.map((r) => {
                  const diff = r.copied - r.netsuite;
                  return (
                    <tr key={r.netsuiteAccountId ?? 'retained'} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...cell, textAlign: 'left', color: 'var(--text-muted)', width: '70px' }}>{r.number ?? ''}</td>
                      <td style={{ ...cell, textAlign: 'left', whiteSpace: 'normal', fontStyle: r.retained ? 'italic' : 'normal' }}>
                        {r.name}
                        {!r.inChart && <span style={{ ...chip('#fbbf24'), marginLeft: '6px' }}>Not in the chart yet</span>}
                      </td>
                      <td style={cell}>{debitOf(r.copied)}</td>
                      <td style={cell}>{creditOf(r.copied)}</td>
                      <td style={cell}>{debitOf(r.netsuite)}</td>
                      <td style={cell}>{creditOf(r.netsuite)}</td>
                      <td style={{ ...cell, color: diff ? '#ef4444' : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>
                        {diff ? fmt(diff) : '—'}
                      </td>
                    </tr>
                  );
                })}
                <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 800 }}>
                  <td style={{ ...cell, textAlign: 'left' }} colSpan={2}>Total</td>
                  <td style={cell}>{fmt(data.totals.copied.debit)}</td>
                  <td style={cell}>{fmt(data.totals.copied.credit)}</td>
                  <td style={cell}>{fmt(data.totals.netsuite.debit)}</td>
                  <td style={cell}>{fmt(data.totals.netsuite.credit)}</td>
                  <td style={cell} />
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
      {loading && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
