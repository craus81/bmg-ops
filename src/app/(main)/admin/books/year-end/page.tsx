'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess, booksAllows } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { CHECK_LABELS, STATE_WORDS } from '@/lib/books/year-end-words';
import { deepLinks } from '@/lib/deep-links';
import { useFileDownload } from '@/lib/use-file-download';

/**
 * Books → Year end (docs/books.md "Year end").
 *
 * A company's year closing into retained earnings, FleetSuite's books next
 * to NetSuite's: retained earnings at January 1, what was posted to them,
 * the year's net income and retained earnings once it closes. Below, what's
 * done before it closes, each linked to where it's done. Once every month
 * of the year is closed on Months, a super admin closes the year, with a
 * reason if anything isn't done; its months then stay closed until the year
 * is reopened, for a reason. Years before the books went live close in
 * NetSuite and show as a rehearsal. The year-end package downloads the
 * year's reports and general ledger for the CPA as one Excel file. Open to
 * whoever opens the books.
 */

type Pair = { fleetsuite: number; netsuite: number };
type CheckKey = 'months' | 'netsuite' | 'entries' | 'bank' | 'sales_tax';

interface Check {
  key: CheckKey;
  state: 'done' | 'todo' | 'none';
  detail: string;
  months?: string[];
}

interface YearEvent {
  action: 'closed' | 'reopened';
  by: string | null;
  reason: string | null;
  at: string;
  netIncome: number | null;
  retainedEarnings: number | null;
}

interface Payload {
  companies: Array<{ code: string; name: string; liveFrom: string | null }>;
  company: string;
  liveFrom: string | null;
  plannedLiveFrom: string;
  today: string;
  years: number[];
  year: number;
  close: {
    account: { key: string; number: string | null; name: string } | null;
    starting: Pair;
    posted: Pair;
    netIncome: Pair;
    closed: Pair;
  };
  checked: boolean;
  own: boolean;
  over: boolean;
  checks: Check[];
  closed: { at: string | null; by: string | null; netIncome: number | null; retainedEarnings: number | null } | null;
  changedSince: boolean;
  events: YearEvent[];
  can: 'close' | 'reopen' | null;
}

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const GREY = '#94a3b8';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso: string) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});

const STATE_COLORS: Record<Check['state'], string> = { done: GREEN, todo: AMBER, none: GREY };

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

const act = (color: string | null, enabled: boolean): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
  border: color ? 'none' : '1px solid var(--border)', background: color ?? 'var(--card)', color: color ? '#fff' : 'var(--text-primary)',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
});

const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};

const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border)',
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '16px', marginBottom: '8px',
};

const card: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px', background: 'var(--card)', marginBottom: '12px',
};

const cell: React.CSSProperties = { padding: '4px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

/** Where each check is done, for the company and year shown. */
function checkHref(c: Check, company: string, year: number): string | null {
  const first = c.months?.[0];
  if (c.key === 'months') return `/admin/books/months?${new URLSearchParams({ company })}`;
  if (c.key === 'netsuite') return first ? deepLinks.booksDifferences(company, first) : null;
  if (c.key === 'entries') return c.state === 'todo' ? deepLinks.journalEntries() : null;
  if (c.key === 'bank') return c.state === 'none' ? null : deepLinks.booksBankReconciliation();
  return c.state === 'none' ? null : deepLinks.booksSalesTax(first ?? `${year}-12-01`);
}

/** One line of the close: its label above, each side's amount and the difference below. */
function CloseRow({ label, pair, checked, strong = false, href = null }: {
  label: string; pair: Pair; checked: boolean; strong?: boolean; href?: string | null;
}) {
  const diff = pair.fleetsuite - pair.netsuite;
  const style: React.CSSProperties = { fontWeight: strong ? 800 : 400 };
  return (
    <>
      <tr style={{ ...style, borderTop: strong ? '3px double var(--border)' : '1px solid var(--border)' }}>
        <td colSpan={checked ? 3 : 1} style={{ padding: '6px 8px 0' }}>
          {href ? <Link href={href} style={{ color: 'inherit' }}>{label}</Link> : label}
        </td>
      </tr>
      <tr style={style}>
        <td style={cell}>{fmt(pair.fleetsuite)}</td>
        {checked && <td style={cell}>{fmt(pair.netsuite)}</td>}
        {checked && (
          <td style={{ ...cell, color: diff ? RED : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>{diff ? fmt(diff) : '—'}</td>
        )}
      </tr>
    </>
  );
}

export default function BooksYearEndPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  // Only a super admin closes or reopens a year; the bookkeeper and the CPA read.
  const canOwn = booksAllows(booksAccess(hasRole), 'owner');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [history, setHistory] = useState(false);
  /** Reopen tapped: it asks why first. */
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState('');
  const excel = useFileDownload(setError);

  const load = useCallback(async (company: string, year: number | null) => {
    try {
      const params = new URLSearchParams();
      if (company) params.set('company', company);
      if (year) params.set('year', String(year));
      const res = await apiFetch(`/api/admin/books/year-end?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
    } catch (e: any) {
      setError(e?.message || "Couldn't read the year");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // A link may name the company and year (?company=BMG&year=2027), as Months' does.
    const params = new URLSearchParams(window.location.search);
    load(params.get('company') ?? '', Number(params.get('year')) || null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const pick = (company: string, year: number | null) => {
    setLoading(true);
    setReopening(false);
    setReason('');
    setActError('');
    setHistory(false);
    load(company, year);
  };

  const change = async (action: 'close' | 'reopen') => {
    if (!data) return;
    setBusy(true);
    setActError('');
    try {
      const res = await apiFetch('/api/admin/books/year-end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: data.company, year: data.year, action, reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setReopening(false);
      setReason('');
      await load(data.company, data.year);
    } catch (e: any) {
      setActError(e?.message || `Couldn't ${action} ${data.year}`);
    }
    setBusy(false);
  };

  const name = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company ?? '';
  const year = data?.year ?? 0;
  const firstOwn = data ? Number((data.liveFrom ?? data.plannedLiveFrom).slice(0, 4)) : 0;
  const todo = data?.checks.some((c) => c.state === 'todo') ?? false;
  const needsReason = reopening || (data?.can === 'close' && todo);
  const ready = !busy && (!needsReason || !!reason.trim());
  const excelUrl = data && `/api/admin/books/year-end/download?${new URLSearchParams({ company: data.company, year: String(year) })}`;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Year end</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          A year closes into retained earnings once its months are closed, and they stay closed until it&apos;s reopened.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              Nothing is posted to close a year: the balance sheet takes its net income into retained earnings on January 1, as
              NetSuite&apos;s does. Years close in order and reopen from the latest. Closing with anything not done, or
              reopening, needs a reason, and each is kept with who did it. Only a super admin closes or reopens a year. Years
              before the books went live close in NetSuite.
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href="/admin/books/months" style={{ color: 'var(--text-secondary)' }}>Months</Link>
          {' · '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
          {data && (
            <>
              {' · '}
              <Link href={deepLinks.booksReport(data.company, 'balance_sheet', `${year}-12-01`, `${year}-12-01`)} style={{ color: 'var(--text-secondary)' }}>
                Balance sheet at December 31
              </Link>
              {' · '}
              <Link href={deepLinks.booksInventoryValue(data.company, `${year}-12-01`)} style={{ color: 'var(--text-secondary)' }}>
                Inventory value
              </Link>
              {' · '}
              <Link href={deepLinks.booksAgings(data.company, 'customer')} style={{ color: 'var(--text-secondary)' }}>AR and AP agings</Link>
              {' · '}
              <Link href={deepLinks.books1099s(data.company, year)} style={{ color: 'var(--text-secondary)' }}>1099s</Link>
            </>
          )}
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
            {data.companies.map((c) => (
              <button key={c.code} onClick={() => pick(c.code, data.year)} disabled={loading} style={button(c.code === data.company)}>
                {c.name}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {data.years.map((y) => (
              <button key={y} onClick={() => pick(data.company, y)} disabled={loading} style={button(y === year)}>{y}</button>
            ))}
            {excelUrl && (
              <button
                onClick={() => excel.download(excelUrl, `${data.company} Year-end package ${year}.xlsx`)}
                disabled={loading || excel.busy}
                title="The trial balance, balance sheet, profit and loss, cash flows, retained earnings, general ledger and inventory value at the year's end, as one Excel file for the CPA"
                style={button(false)}
              >
                {excel.busy ? 'Making the file…' : excel.ready(excelUrl) ? '⬇ Tap to save the Excel file' : '⬇ Year-end package'}
              </button>
            )}
          </div>

          {!data.own && (
            <div style={banner(GREY)}>
              {data.liveFrom
                ? `${year} is before ${name}'s books went live, so it closes in NetSuite.`
                : `${name}'s books aren't live yet, so ${year} closes in NetSuite.`}{' '}
              FleetSuite closes its own years from {firstOwn}. What&apos;s here is the rehearsal.
            </div>
          )}
          {data.closed && (
            <div style={banner(GREEN)}>
              {year} is closed{data.closed.by ? ` by ${data.closed.by}` : ''}{data.closed.at ? ` ${when(data.closed.at)}` : ''}.
            </div>
          )}
          {data.closed && data.changedSince && (
            <div style={banner(RED)}>
              FleetSuite&apos;s books have changed since {year} closed: it closed at {fmt(data.closed.netIncome ?? 0)} of net income and{' '}
              {fmt(data.closed.retainedEarnings ?? 0)} of retained earnings. An account&apos;s type may have changed in the chart.
            </div>
          )}

          <div style={card}>
            <div style={{ fontSize: '14px', fontWeight: 800, marginBottom: '4px' }}>{year} into retained earnings</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)' }}>
                  <th style={cell}>FleetSuite</th>
                  {data.checked && <th style={cell}>NetSuite</th>}
                  {data.checked && <th style={cell}>Difference</th>}
                </tr>
              </thead>
              <tbody>
                <CloseRow label={`Retained earnings, January 1, ${year}`} pair={data.close.starting} checked={data.checked} />
                <CloseRow label={`Posted to retained earnings in ${year}`} pair={data.close.posted} checked={data.checked} />
                <CloseRow
                  label={`Net income for ${year}`}
                  pair={data.close.netIncome}
                  checked={data.checked}
                  href={deepLinks.booksReport(data.company, 'profit_and_loss', `${year}-01-01`, `${year}-12-01`)}
                />
                <CloseRow label={`Retained earnings once ${year} closes, January 1, ${year + 1}`} pair={data.close.closed} checked={data.checked} strong />
              </tbody>
            </table>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
              {data.close.account
                ? `Retained earnings is ${[data.close.account.number, data.close.account.name].filter(Boolean).join(' ')}.`
                : "The chart has no retained earnings account, so they're the balance sheet's own line of earlier years' net income."}
              {!data.checked && " NetSuite's totals haven't been read yet, so there's nothing to compare."}
            </div>
          </div>

          <div style={card}>
            <div style={{ fontSize: '14px', fontWeight: 800, marginBottom: '6px' }}>Before {year} closes</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {data.checks.map((c) => {
                const href = checkHref(c, data.company, year);
                return (
                  <div key={c.key}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700 }}>
                        {href ? <Link href={href} style={{ color: 'inherit' }}>{CHECK_LABELS[c.key]}</Link> : CHECK_LABELS[c.key]}
                      </span>
                      <span style={chip(STATE_COLORS[c.state])}>{STATE_WORDS[c.state]}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: c.state === 'todo' ? AMBER : 'var(--text-muted)', fontWeight: c.state === 'todo' ? 600 : 400 }}>
                      {c.detail}
                    </div>
                  </div>
                );
              })}
            </div>

            {data.can === 'close' && !canOwn && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '10px' }}>A super admin closes the year.</div>
            )}
            {canOwn && (data.can === 'close' || (data.can === 'reopen' && reopening)) && (
              <div style={{ marginTop: '10px' }}>
                {needsReason && (
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={reopening ? `Why reopen ${year}?` : `Why close ${year} anyway?`}
                    maxLength={500}
                    disabled={busy}
                    style={input}
                  />
                )}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {reopening ? (
                    <>
                      <button onClick={() => change('reopen')} disabled={!ready} style={act(GREEN, ready)}>
                        {busy ? 'Reopening…' : `Reopen ${year}`}
                      </button>
                      <button onClick={() => { setReopening(false); setReason(''); setActError(''); }} disabled={busy} style={act(null, !busy)}>
                        Keep it closed
                      </button>
                    </>
                  ) : (
                    <button onClick={() => change('close')} disabled={!ready} style={act(GREEN, ready)}>
                      {busy ? 'Closing…' : `Close ${year}`}
                    </button>
                  )}
                </div>
              </div>
            )}
            {canOwn && data.can === 'reopen' && !reopening && (
              <div style={{ marginTop: '10px' }}>
                <button onClick={() => { setReopening(true); setReason(''); setActError(''); }} disabled={busy} style={act(null, !busy)}>
                  Reopen
                </button>
              </div>
            )}
            {actError && <div style={{ ...banner(RED), marginTop: '8px', marginBottom: 0 }}>{actError}</div>}

            {data.events.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                <button onClick={() => setHistory(!history)} style={link}>{history ? 'Hide history' : 'History'}</button>
                {history && (
                  <ul style={{ margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {[...data.events].reverse().map((e, i) => (
                      <li key={i}>
                        {e.action === 'closed' ? 'Closed' : 'Reopened'}{e.by ? ` by ${e.by}` : ''} {when(e.at)}
                        {e.action === 'closed' && e.netIncome !== null ? `, at ${fmt(e.netIncome)} of net income` : ''}
                        {e.reason ? `: ${e.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {data.own && !data.over && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {year} isn&apos;t over yet: it closes once December is closed, after {longDate(`${year}-12-31`)}.
            </div>
          )}
        </>
      )}
    </div>
  );
}
