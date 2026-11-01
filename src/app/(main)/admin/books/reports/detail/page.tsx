'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { useFileDownload } from '@/lib/use-file-download';
import type { DetailDocument } from '@/lib/books/report-detail';

/**
 * Books → Reports → one account line's detail (src/lib/books/report-detail.ts,
 * migration 400, docs/books.md "Report detail").
 *
 * Every document that moved the account in the months picked, FleetSuite's
 * journal next to the copy of NetSuite's general ledger, and for a balance
 * sheet account its balance before and after them. Amounts read as the
 * report the line is on shows them, so the documents add up to the line.
 * Every document of the months downloads as Excel with each side's running
 * balance (docs/books.md "Excel downloads"). Open to whoever opens the
 * books; opened from a line on Reports.
 */

type Kind = 'profit_and_loss' | 'balance_sheet' | 'trial_balance';

interface Pair {
  fleetsuite: number;
  netsuite: number;
}

interface Payload {
  companies: Array<{ code: string; name: string }>;
  company: string;
  report: Kind;
  account: { key: string; number: string | null; name: string; inChart: boolean };
  from: string;
  to: string;
  months: string[];
  sign: 1 | -1;
  /** A balance sheet account's line at the end of the month before `from`; null for income and expenses. */
  starting: Pair | null;
  moved: Pair;
  /** On retained earnings: earlier years' net income it takes in between the two ends. */
  closed: Pair | null;
  ending: Pair;
  documents: number;
  differing: number;
  only: 'all' | 'differs';
  rows: DetailDocument[];
  copyHolds: boolean;
  copied: number;
  lastPosting: { at: string; error: string | null; partial: boolean } | null;
}

interface Asked {
  company: string;
  account: string;
  report: string;
  from: string;
  to: string;
  differs: boolean;
}

const REPORT_NAMES: Record<Kind, string> = {
  profit_and_loss: 'profit and loss',
  balance_sheet: 'balance sheet',
  trial_balance: 'trial balance',
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
const plain = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
/** A trial balance amount, debit positive, as the trial balance shows one on a phone. */
const drCr = (cents: number) => (cents ? `${plain.format(Math.abs(cents) / 100)} ${cents > 0 ? 'Dr' : 'Cr'}` : plain.format(0));

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOf = (month: string) => MONTH_NAMES[Number(month.slice(5, 7)) - 1];
const monthName = (month: string) => `${monthOf(month)} ${month.slice(0, 4)}`;
const shortName = (month: string) => `${monthOf(month).slice(0, 3)} ${month.slice(0, 4)}`;
const monthEnd = (month: string) => {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${monthOf(month)} ${last}, ${month.slice(0, 4)}`;
};
const monthBefore = (month: string) => {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
};
const dayText = (iso: string) => `${monthOf(iso).slice(0, 3)} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

function rangeText(from: string, to: string): string {
  if (from === to) return monthName(to);
  if (from.slice(0, 4) === to.slice(0, 4)) return `${monthOf(from)} to ${monthName(to)}`;
  return `${monthName(from)} to ${monthName(to)}`;
}

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
/** An amount's heading: the same width in both tables, so their columns line up. */
const amountHead: React.CSSProperties = { ...cell, width: '15%' };

const select: React.CSSProperties = {
  padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
  color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600,
};

const ONLY: Record<NonNullable<DetailDocument['only']>, string> = {
  netsuite: 'Only in NetSuite',
  fleetsuite: 'Only in FleetSuite',
  not_posted: "FleetSuite doesn't post these yet",
};

/**
 * A row of the table: its label, then the amounts. On a phone the label takes
 * a row of its own above them (.rep-label-row in globals.css), as on Reports,
 * so the three amounts fit across the screen.
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

function Amounts({ pair, show }: { pair: Pair; show: (cents: number) => string }) {
  const diff = pair.fleetsuite - pair.netsuite;
  return (
    <>
      <td style={cell}>{show(pair.fleetsuite)}</td>
      <td style={cell}>{show(pair.netsuite)}</td>
      <td style={{ ...cell, color: diff ? RED : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>{diff ? fmt(diff) : '—'}</td>
    </>
  );
}

/** A document: its date, type and number (opening its check on Invoices vs NetSuite), name and memo. */
function DocumentLabel({ d, company }: { d: DetailDocument; company: string }) {
  const number = d.check
    ? <Link href={deepLinks.booksDocument(company, d.check.kind, d.check.month, d.doc)} className="rep-link" style={{ fontWeight: 700 }}>{d.number}</Link>
    : <span style={{ fontWeight: 700 }}>{d.number}</span>;
  return (
    <div>
      <div>
        {d.date && <span style={{ color: 'var(--text-muted)', marginRight: '8px' }}>{dayText(d.date)}</span>}
        <span style={{ color: 'var(--text-secondary)', marginRight: '6px' }}>{d.type}</span>
        {number}
        {d.name && <span style={{ marginLeft: '6px' }}>· {d.name}</span>}
        {d.only && <span style={{ ...chip(d.only === 'not_posted' ? AMBER : RED), marginLeft: '6px' }}>{ONLY[d.only]}</span>}
      </div>
      {/* Two lines of a long memo at most, wrapping on a phone. */}
      {d.memo && (
        <div
          style={{
            fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', overflowWrap: 'anywhere',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          }}
        >
          {d.memo}
        </div>
      )}
    </div>
  );
}

export default function BooksReportDetailPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const excel = useFileDownload(setError);

  const load = useCallback(async (asked: Asked) => {
    try {
      const params = new URLSearchParams({ company: asked.company, account: asked.account, report: asked.report });
      if (asked.from) params.set('from', asked.from.slice(0, 7));
      if (asked.to) params.set('to', asked.to.slice(0, 7));
      if (asked.differs) params.set('only', 'differs');
      const res = await apiFetch(`/api/admin/books/reports/detail?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
      // Keep the address on what's shown, so going back here opens it again.
      window.history.replaceState(null, '', deepLinks.booksAccountDetail(json.company, json.account.key, json.report, json.from, json.to, json.only === 'differs'));
    } catch (e: any) {
      setError(e?.message || 'Could not load the documents');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // Reports links here with the line's company, account, report and months (deepLinks.booksAccountDetail).
    const q = new URLSearchParams(window.location.search);
    load({
      company: q.get('company') ?? '', account: q.get('account') ?? '', report: q.get('report') ?? '',
      from: q.get('from') ?? '', to: q.get('to') ?? '', differs: q.get('only') === 'differs',
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  // A start after the end moves the end with it, and an end before the start the start.
  const pick = (next: { from?: string; to?: string; differs?: boolean }) => {
    if (!data) return;
    let from = next.from ?? data.from;
    let to = next.to ?? data.to;
    if (next.from && from > to) to = from;
    if (next.to && to < from) from = to;
    setLoading(true);
    load({ company: data.company, account: data.account.key, report: data.report, from, to, differs: next.differs ?? data.only === 'differs' });
  };

  const companyName = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company;
  const show = data?.report === 'trial_balance' ? drCr : fmt;
  const listed = data ? (data.only === 'differs' ? data.differing : data.documents) : 0;
  const lineDiffers = !!data && data.ending.fleetsuite !== data.ending.netsuite;
  // Back to the report the line is on: the profit and loss for these months, the others at the end of `to`.
  const back = data && deepLinks.booksReport(data.company, data.report, data.report === 'profit_and_loss' ? data.from : data.to, data.to);
  // Every document of the months, whichever the page lists, with running balances (src/lib/books/report-workbook.ts).
  const excelUrl = data && `/api/admin/books/reports/detail/download?${new URLSearchParams({
    company: data.company, account: data.account.key, report: data.report, from: data.from.slice(0, 7), to: data.to.slice(0, 7),
  })}`;

  return (
    <div>
      {back && (
        <div style={{ marginBottom: '8px', fontSize: '12px' }}>
          <Link href={back} style={{ color: 'var(--text-secondary)' }}>← Back to the {REPORT_NAMES[data!.report]}</Link>
        </div>
      )}

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '20px', fontWeight: 800 }}>
              {data.account.number && <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginRight: '8px' }}>{data.account.number}</span>}
              {data.account.name}
              <span style={{ ...chip(lineDiffers ? RED : GREEN), marginLeft: '8px', verticalAlign: 'middle' }}>
                {lineDiffers ? `Differs by ${fmt(data.ending.fleetsuite - data.ending.netsuite)}` : 'Matches NetSuite'}
              </span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {companyName} · {rangeText(data.from, data.to)}. Every document that moved this account
              {data.starting ? ` between its balance at the end of ${monthName(monthBefore(data.from))} and at the end of ${monthName(data.to)}` : ` in ${data.from === data.to ? 'the month' : 'these months'}`},
              FleetSuite&apos;s journal next to the copy of NetSuite&apos;s general ledger. Amounts read as the {REPORT_NAMES[data.report]} shows
              them, so the documents add up to its line. Tap a document&apos;s number for its line by line check.
            </div>
          </div>

          {data.lastPosting?.error && <div style={banner(RED)}>The last posting run failed {ago(data.lastPosting.at)}: {data.lastPosting.error}</div>}
          {data.lastPosting && !data.lastPosting.error && data.lastPosting.partial && (
            <div style={banner(AMBER)}>
              Still posting: the last run, {ago(data.lastPosting.at)}, stopped for time, so some documents aren&apos;t in FleetSuite&apos;s
              books yet. It carries on at the next run, or press Post now on Invoices vs NetSuite.
            </div>
          )}
          {!data.copyHolds && (
            <div style={banner(AMBER)}>
              NetSuite&apos;s own totals say this account moved {fmt(data.moved.netsuite)} in {data.from === data.to ? 'this month' : 'these months'}, but
              the copy of its ledger holds {fmt(data.copied)} of it so far, so some of NetSuite&apos;s documents may be missing below. The next copy
              catches up.
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              From
              <select value={data.from} onChange={(e) => pick({ from: e.target.value })} disabled={loading} style={select}>
                {data.months.map((m) => <option key={m} value={m}>{shortName(m)}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              To
              <select value={data.to} onChange={(e) => pick({ to: e.target.value })} disabled={loading} style={select}>
                {data.months.map((m) => <option key={m} value={m}>{shortName(m)}</option>)}
              </select>
            </label>
            {excelUrl && (
              <button
                onClick={() => excel.download(excelUrl, 'Documents.xlsx')}
                disabled={loading || excel.busy}
                title="Every document in these months as an Excel file, by date, with each side's running balance"
                style={button(false)}
              >
                {excel.busy ? 'Making the file…' : excel.ready(excelUrl) ? '⬇ Tap to save the Excel file' : '⬇ Download Excel'}
              </button>
            )}
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '14px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th className="rep-label" style={{ ...cell, textAlign: 'left' }} />
                  <th style={amountHead}>FleetSuite</th>
                  <th style={amountHead}>NetSuite</th>
                  <th style={amountHead}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {data.starting && (
                  <Row label={`Balance at the end of ${monthName(monthBefore(data.from))}`}>
                    <Amounts pair={data.starting} show={show} />
                  </Row>
                )}
                <Row
                  label={`${count(data.documents, 'document', 'documents')} in ${rangeText(data.from, data.to)}`}
                  style={{ borderTop: data.starting ? '1px solid var(--border)' : 'none' }}
                >
                  <Amounts pair={data.moved} show={show} />
                </Row>
                {data.closed && (data.closed.fleetsuite !== 0 || data.closed.netsuite !== 0) && (
                  <Row label="Earlier years' net income, taken into retained earnings at the year's start" style={{ borderTop: '1px solid var(--border)' }}>
                    <Amounts pair={data.closed} show={show} />
                  </Row>
                )}
                <Row
                  label={data.starting ? `Balance at the end of ${monthName(data.to)}` : `Total, ${rangeText(data.from, data.to)}`}
                  style={{ borderTop: '3px double var(--border)', fontWeight: 800 }}
                >
                  <Amounts pair={data.ending} show={show} />
                </Row>
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
            <button onClick={() => pick({ differs: false })} disabled={loading} style={button(data.only === 'all')}>
              All {count(data.documents, 'document', 'documents')}
            </button>
            <button
              onClick={() => pick({ differs: true })}
              disabled={loading}
              style={{ ...button(data.only === 'differs'), color: data.differing ? RED : 'var(--text-primary)' }}
            >
              {data.differing ? `${count(data.differing, 'differs', 'differ')} from NetSuite` : 'None differ from NetSuite'}
            </button>
          </div>
          {data.rows.length < listed && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              Showing the first {data.rows.length.toLocaleString('en-US')} of {listed.toLocaleString('en-US')}, by date. Pick fewer months to see the rest.
            </div>
          )}

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Document</th>
                  <th style={amountHead}>FleetSuite</th>
                  <th style={amountHead}>NetSuite</th>
                  <th style={amountHead}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {!data.rows.length && (
                  <tr><td colSpan={4} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                    {data.only === 'differs'
                      ? 'Every document matches NetSuite.'
                      : `Nothing moved this account in ${data.from === data.to ? 'this month' : 'these months'}.`}
                  </td></tr>
                )}
                {data.rows.map((d) => (
                  <Row key={d.doc} label={<DocumentLabel d={d} company={data.company} />} style={{ borderTop: '1px solid var(--border)' }}>
                    <Amounts pair={d} show={show} />
                  </Row>
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
