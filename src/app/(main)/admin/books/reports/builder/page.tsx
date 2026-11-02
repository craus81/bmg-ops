'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { BY_LABELS, builderTitle, filterWords, type BuilderBy } from '@/lib/books/report-builder-words';
import { useFileDownload } from '@/lib/use-file-download';

/**
 * Books → Reports → Report builder (src/lib/books/report-builder.ts,
 * migration 500, docs/books.md "Report builder").
 *
 * FleetSuite's own profit and loss for any months from January 2025, laid
 * out as on Reports, with a column for each month, quarter, year, division
 * or location and a Total, only one division's or one location's lines when
 * picked, ready-made ones on top, and the report as an Excel file. Open to
 * whoever opens the books, linked from Reports and the Books hub.
 */

interface Choice {
  key: string;
  label: string;
}

interface Line {
  kind: 'section' | 'heading' | 'account' | 'total';
  depth: number;
  label: string;
  number?: string | null;
  account?: string;
  grand?: true;
  inChart?: boolean;
  /** One amount for each column; null on a section or heading. */
  amounts: number[] | null;
}

interface Payload {
  companies: Array<{ code: string; name: string; netsuite_subsidiary_id: string | null }>;
  company: string;
  posts: boolean;
  /** The months there are to pick from, 'YYYY-MM-01'. */
  months: string[];
  from: string;
  to: string;
  by: BuilderBy;
  columns: Choice[];
  lines: Line[];
  divisions: Choice[];
  locations: Choice[];
  division: string | null;
  location: string | null;
  ties: boolean;
  copied: boolean;
  lastPosting: { at: string; error: string | null; partial: boolean } | null;
  lastCopy: { at: string; error: string | null } | null;
}

interface Ask {
  company?: string | null;
  by?: BuilderBy | null;
  from?: string | null;
  to?: string | null;
  division?: string | null;
  location?: string | null;
}

/** Ready-made reports: a column for each division, location or month, every line, over the months picked. */
const READY_MADE: Array<[BuilderBy, string]> = [['division', 'P&L by division'], ['location', 'P&L by location'], ['month', 'P&L by month']];
/** What the columns picker offers, in its order. */
const PICKER: BuilderBy[] = ['division', 'location', 'month', 'quarter', 'year', 'total'];

/** The route's params for what's asked: months as 'YYYY-MM', anything not asked for left out. */
const query = (ask: Ask) => new URLSearchParams(Object.entries({
  company: ask.company, by: ask.by, from: ask.from?.slice(0, 7), to: ask.to?.slice(0, 7), division: ask.division, location: ask.location,
}).filter((e): e is [string, string] => !!e[1])).toString();

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOf = (month: string) => MONTH_NAMES[Number(month.slice(5, 7)) - 1];
const monthName = (month: string) => `${monthOf(month)} ${month.slice(0, 4)}`;
const shortName = (month: string) => `${monthOf(month).slice(0, 3)} ${month.slice(0, 4)}`;

function period(from: string, to: string): string {
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

const select: React.CSSProperties = {
  padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
  color: 'var(--text-primary)', fontSize: '16px', fontWeight: 600,
};

const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

/** The account column stays put while the amounts scroll across under it. */
const stuck: React.CSSProperties = { position: 'sticky', left: 0, zIndex: 1, background: 'var(--card)' };

const labelCell = (depth: number): React.CSSProperties => ({
  ...cell, ...stuck, textAlign: 'left', whiteSpace: 'normal', minWidth: '150px', maxWidth: '260px', paddingLeft: `${10 + depth * 14}px`,
});

/** One line of the report: the account, then an amount for each column, the Total set apart. */
function BuilderRow({ line, columns }: { line: Line; columns: Choice[] }) {
  const total = line.kind === 'total';
  const border = line.grand ? '3px double var(--border)' : total || line.kind === 'section' ? '1px solid var(--border)' : 'none';
  const weight = line.grand ? 800 : total || line.kind === 'section' ? 700 : line.kind === 'heading' ? 600 : 400;
  return (
    <tr style={{ fontWeight: weight }}>
      <td style={{ ...labelCell(line.depth), borderTop: border }}>
        {line.number && <span style={{ color: 'var(--text-muted)', marginRight: '6px', fontWeight: 400 }}>{line.number}</span>}
        {line.label}
        {line.inChart === false && <span style={{ ...chip(AMBER), marginLeft: '6px' }}>Not in the chart yet</span>}
      </td>
      {columns.map((c, i) => {
        const cents = line.amounts?.[i] ?? null;
        const isTotal = c.key === 'total' && columns.length > 1;
        return (
          <td
            key={c.key}
            style={{
              ...cell, borderTop: border,
              borderLeft: isTotal ? '1px solid var(--border)' : 'none',
              fontWeight: isTotal ? Math.max(weight, 600) : weight,
              color: cents === 0 ? 'var(--text-muted)' : undefined,
            }}
          >
            {cents === null ? '' : cents ? fmt(cents) : '—'}
          </td>
        );
      })}
    </tr>
  );
}

export default function BooksReportBuilderPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [howOpen, setHowOpen] = useState(false);
  const excel = useFileDownload(setError);

  const load = useCallback(async (ask: Ask) => {
    try {
      const res = await apiFetch(`/api/admin/books/reports/builder?${query(ask)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
      // Keep the address on the report shown, so a reload or a shared link opens it again.
      window.history.replaceState(null, '', deepLinks.booksReportBuilder({
        company: json.company, by: json.by, from: json.from, to: json.to, division: json.division, location: json.location,
      }));
    } catch (e: any) {
      setError(e?.message || 'Could not load the report');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // A link may name the company, columns, months and filters (deepLinks.booksReportBuilder).
    const q = new URLSearchParams(window.location.search);
    load({
      company: q.get('company'), by: PICKER.find((b) => b === q.get('by')) ?? null, from: q.get('from'), to: q.get('to'),
      division: q.get('division'), location: q.get('location'),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  // A start after the end moves the end with it, and an end before the start the start.
  const pick = (next: Ask) => {
    if (!data) return;
    let from = next.from ?? data.from;
    let to = next.to ?? data.to;
    if (next.from && from > to) to = from;
    if (next.to && to < from) from = to;
    setLoading(true);
    load({ company: data.company, by: data.by, division: data.division, location: data.location, ...next, from, to });
  };

  const companyName = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company;
  const picked = data && {
    division: data.divisions.find((d) => d.key === data.division) ?? null,
    location: data.locations.find((l) => l.key === data.location) ?? null,
  };
  const filters = picked ? filterWords(picked.division, picked.location) : '';
  // The report shown, every line, as an Excel file (src/lib/books/report-workbook.ts).
  const excelUrl = data && `/api/admin/books/reports/builder/download?${query(data)}`;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Report builder</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          FleetSuite&apos;s own profit and loss with a column for each month, quarter, year, division or location, for any
          months from January 2025.{' '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          {!data.ties && (
            <div style={banner(RED)}>
              Something posted to FleetSuite&apos;s books while this was read, so these columns may not come to the profit and
              loss on Reports. Reload the page.
            </div>
          )}
          {!data.posts && <div style={banner(AMBER)}>{companyName} doesn&apos;t post to FleetSuite&apos;s books yet, so nothing is in this report.</div>}
          {data.posts && !data.lastPosting && (
            <div style={banner(AMBER)}>Nothing has posted to FleetSuite&apos;s books yet. Posting runs every two hours, or press Post now on Invoices vs NetSuite.</div>
          )}
          {data.lastPosting?.error && <div style={banner(RED)}>The last posting run failed {ago(data.lastPosting.at)}: {data.lastPosting.error}</div>}
          {data.lastPosting && !data.lastPosting.error && data.lastPosting.partial && (
            <div style={banner(AMBER)}>
              Still posting: the last run, {ago(data.lastPosting.at)}, stopped for time, so some documents aren&apos;t in this
              report yet. It carries on at the next run, or press Post now on Invoices vs NetSuite.
            </div>
          )}
          {!data.copied && (
            <div style={banner(AMBER)}>
              NetSuite&apos;s ledger hasn&apos;t been copied yet, so lines from its documents have no location. It&apos;s copied every two
              hours, or press Copy now on Trial balance vs NetSuite.
            </div>
          )}
          {data.lastCopy?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s ledger failed {ago(data.lastCopy.at)}: {data.lastCopy.error}</div>}
          {data.ties && data.posts && data.lastPosting && !data.lastPosting.error && !data.lastPosting.partial && (
            <div style={banner(GREEN)}>Posted {ago(data.lastPosting.at)}. The Total comes to the profit and loss on Reports.</div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {data.companies.map((c) => (
              <button key={c.code} onClick={() => pick({ company: c.code })} disabled={loading} style={button(c.code === data.company)}>
                {c.name}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {READY_MADE.map(([by, label]) => (
              <button
                key={by}
                onClick={() => pick({ by, division: null, location: null })}
                disabled={loading}
                style={button(data.by === by && !data.division && !data.location)}
              >
                {label}
              </button>
            ))}
          </div>

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
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              Columns
              <select value={data.by} onChange={(e) => pick({ by: e.target.value as BuilderBy })} disabled={loading} style={select}>
                {PICKER.map((by) => <option key={by} value={by}>{BY_LABELS[by]}</option>)}
              </select>
            </label>
            {data.divisions.length > 0 && (
              <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                Division
                <select value={data.division ?? ''} onChange={(e) => pick({ division: e.target.value || null })} disabled={loading} style={select}>
                  <option value="">All divisions</option>
                  {data.divisions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
              </label>
            )}
            {data.locations.length > 0 && (
              <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                Location
                <select value={data.location ?? ''} onChange={(e) => pick({ location: e.target.value || null })} disabled={loading} style={select}>
                  <option value="">All locations</option>
                  {data.locations.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
                </select>
              </label>
            )}
          </div>

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: '6px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800 }}>
              {builderTitle(data.by)}, {period(data.from, data.to)}
              {filters && <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginLeft: '8px' }}>{filters}</span>}
            </div>
            {excelUrl && (
              <button
                onClick={() => excel.download(excelUrl, 'Report.xlsx')}
                disabled={loading || excel.busy}
                title="Every line of the report as an Excel file, an amount for each column"
                style={button(false)}
              >
                {excel.busy ? 'Making the file…' : excel.ready(excelUrl) ? '⬇ Tap to save the Excel file' : '⬇ Download Excel'}
              </button>
            )}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            Income, cost of sales and expenses for the months picked, laid out as on Reports.{' '}
            <button
              onClick={() => setHowOpen((o) => !o)}
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer', textDecoration: 'underline dotted' }}
            >
              How lines are split {howOpen ? '▴' : '▾'}
            </button>
            {howOpen && (
              <div style={{ marginTop: '4px' }}>
                A sale line&apos;s division is the invoice rule&apos;s: graphics for 3M vinyl, graphics install labor and removal and items
                starting 06, upfit for the rest, freight and discounts not split. A cost or expense line without one takes its item&apos;s
                division, else its document&apos;s sales&apos; when they&apos;re all one division, else it&apos;s Not split, as is an entry
                made without one. A line&apos;s location is its own, else the one NetSuite has on its document, else No location.
              </div>
            )}
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table className="rep-table" style={{ minWidth: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)' }}>
                  <th style={{ ...labelCell(0), fontWeight: 700 }}>Account</th>
                  {data.columns.map((c) => (
                    <th
                      key={c.key}
                      style={{ ...cell, fontWeight: 700, borderLeft: c.key === 'total' && data.columns.length > 1 ? '1px solid var(--border)' : 'none' }}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!data.lines.some((l) => l.kind === 'account') && (
                  <tr><td colSpan={data.columns.length + 1} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                    Nothing in FleetSuite&apos;s books for {data.from === data.to ? 'this month' : 'these months'}{filters ? ' with these filters' : ''}.
                  </td></tr>
                )}
                {data.lines.map((l, i) => <BuilderRow key={`${i}-${l.kind}-${l.account ?? l.label}`} line={l} columns={data.columns} />)}
              </tbody>
            </table>
          </div>
        </>
      )}
      {loading && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
