'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import {
  BUILDER_MONTHS, BUILDER_ROWS, BY_LABELS, MONTHS_LABELS, ROWS_LABELS, builderTitle, filterWords,
  type BuilderBy, type BuilderMonths, type BuilderRows,
} from '@/lib/books/report-builder-words';
import { useFileDownload } from '@/lib/use-file-download';

/**
 * Books → Reports → Report builder (src/lib/books/report-builder.ts,
 * migrations 500 and 501, docs/books.md "Report builder").
 *
 * FleetSuite's own profit and loss for any months from January 2025, or
 * months that move with the calendar, laid out as on Reports with a line
 * for each account, customer or vendor and a column for each month,
 * quarter, year, division or location and a Total, only one division's or
 * one location's lines when picked, ready-made ones on top, reports saved
 * by name, and the report as an Excel file. Open to whoever opens the
 * books, linked from Reports and the Books hub.
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
  /** On lines by customer or vendor, its key: NetSuite's id, or 'none'. */
  party?: string;
  grand?: true;
  inChart?: boolean;
  /** One amount for each column; null on a section or heading. */
  amounts: number[] | null;
}

/** A report saved by name (loadSavedReports in src/lib/books/report-data.ts). */
interface Saved {
  id: string;
  name: string;
  rows: BuilderRows;
  by: BuilderBy;
  division: string | null;
  location: string | null;
  months: BuilderMonths;
  from: string | null;
  to: string | null;
  savedBy: string | null;
  updatedAt: string;
  canChange: boolean;
}

interface Payload {
  companies: Array<{ code: string; name: string; netsuite_subsidiary_id: string | null }>;
  company: string;
  posts: boolean;
  /** The months there are to pick from, 'YYYY-MM-01'. */
  monthList: string[];
  months: BuilderMonths;
  from: string;
  to: string;
  rows: BuilderRows;
  by: BuilderBy;
  columns: Choice[];
  lines: Line[];
  divisions: Choice[];
  locations: Choice[];
  division: string | null;
  location: string | null;
  ties: boolean;
  saved: Saved[];
  copied: boolean;
  lastPosting: { at: string; error: string | null; partial: boolean } | null;
  lastCopy: { at: string; error: string | null } | null;
}

interface Ask {
  company?: string | null;
  rows?: BuilderRows | null;
  by?: BuilderBy | null;
  months?: BuilderMonths | null;
  from?: string | null;
  to?: string | null;
  division?: string | null;
  location?: string | null;
}

/** Ready-made reports: a line for each account and a column for each division, location or month, or a line for each customer or vendor, over the months shown. */
const READY_MADE: Array<{ rows: BuilderRows; by: BuilderBy; label: string }> = [
  { rows: 'account', by: 'division', label: 'P&L by division' },
  { rows: 'account', by: 'location', label: 'P&L by location' },
  { rows: 'account', by: 'month', label: 'P&L by month' },
  { rows: 'customer', by: 'total', label: 'P&L by customer' },
  { rows: 'vendor', by: 'total', label: 'P&L by vendor' },
];
/** What the columns picker offers, in its order. */
const PICKER: BuilderBy[] = ['division', 'location', 'month', 'quarter', 'year', 'total'];

/**
 * The route's params for what's asked: months as 'YYYY-MM', anything not
 * asked for left out, and no months picked with ones that move with the
 * calendar, which the route works out.
 */
const query = (ask: Ask) => {
  const moving = !!ask.months && ask.months !== 'picked';
  return new URLSearchParams(Object.entries({
    company: ask.company, rows: ask.rows, by: ask.by, months: ask.months,
    from: moving ? null : ask.from?.slice(0, 7), to: moving ? null : ask.to?.slice(0, 7), division: ask.division, location: ask.location,
  }).filter((e): e is [string, string] => !!e[1])).toString();
};

/** Is the report shown the saved one, as it was saved? */
const shows = (s: Saved, d: Payload) => s.rows === d.rows && s.by === d.by && s.division === d.division && s.location === d.location
  && s.months === d.months && (s.months !== 'picked' || (s.from === d.from && s.to === d.to));

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

const act = (color: string | null, enabled: boolean): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
  border: color ? 'none' : '1px solid var(--border)', background: color ?? 'var(--card)', color: color ? '#fff' : 'var(--text-primary)',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
});

const input: React.CSSProperties = {
  width: '100%', maxWidth: '360px', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)',
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '16px',
};

/** What the route said went wrong: a field it refused, else its error. */
const problem = (json: any, status: number) => json?.details?.[0]?.message ?? json?.error ?? `Request failed (${status})`;

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
  const dialog = useDialog();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [howOpen, setHowOpen] = useState(false);
  // The report saved by name that was opened, by id; it stays open while the report is changed, to save the changes to it.
  const [savedId, setSavedId] = useState<string | null>(null);
  // The Save panel: the name typed in, and what went wrong saving; null when it's closed.
  const [panel, setPanel] = useState<{ name: string; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const excel = useFileDownload(setError);

  const load = useCallback(async (ask: Ask) => {
    try {
      const res = await apiFetch(`/api/admin/books/reports/builder?${query(ask)}`);
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
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // A link may name the company, lines, columns, months, filters and saved report (deepLinks.booksReportBuilder).
    const q = new URLSearchParams(window.location.search);
    setSavedId(q.get('saved'));
    load({
      company: q.get('company'), rows: BUILDER_ROWS.find((r) => r === q.get('rows')) ?? null, by: PICKER.find((b) => b === q.get('by')) ?? null,
      months: BUILDER_MONTHS.find((m) => m === q.get('months')) ?? null, from: q.get('from'), to: q.get('to'),
      division: q.get('division'), location: q.get('location'),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  // The saved report open: one of the company's.
  const open = data?.saved.find((s) => s.id === savedId) ?? null;

  // Keep the address on the report shown, so a reload or a shared link opens it again.
  useEffect(() => {
    if (!data) return;
    window.history.replaceState(null, '', deepLinks.booksReportBuilder({
      company: data.company, rows: data.rows, by: data.by, months: data.months, from: data.from, to: data.to,
      division: data.division, location: data.location, saved: open?.id ?? null,
    }));
  }, [data, open?.id]);

  // A start after the end moves the end with it, and an end before the start the start; picking a month picks the months by hand.
  const pick = (next: Ask) => {
    if (!data) return;
    let from = next.from ?? data.from;
    let to = next.to ?? data.to;
    if (next.from && from > to) to = from;
    if (next.to && to < from) from = to;
    const months = next.months ?? (next.from || next.to ? 'picked' : data.months);
    // Another company has its own saved reports.
    if (next.company && next.company !== data.company) setSavedId(null);
    setLoading(true);
    setNotice('');
    load({ company: data.company, rows: data.rows, by: data.by, division: data.division, location: data.location, ...next, months, from, to });
  };

  const openSaved = (s: Saved) => {
    if (!data) return;
    setSavedId(s.id);
    setPanel(null);
    setNotice('');
    setLoading(true);
    load({ company: data.company, rows: s.rows, by: s.by, months: s.months, from: s.from, to: s.to, division: s.division, location: s.location });
  };

  // The report shown saved by name: as the saved one open, or as a new one.
  const save = async (asNew: boolean) => {
    if (!data || !panel) return;
    const into = asNew ? null : open;
    const picked = data.months === 'picked';
    setBusy(true);
    try {
      const res = await apiFetch('/api/admin/books/reports/builder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save', id: into?.id ?? null, seen: into?.updatedAt ?? null, name: panel.name, company: data.company,
          rows: data.rows, by: data.by, division: data.division, location: data.location, months: data.months,
          from: picked ? data.from.slice(0, 7) : null, to: picked ? data.to.slice(0, 7) : null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(problem(json, res.status));
      setSavedId(json.id);
      setPanel(null);
      setNotice(`Saved "${panel.name.trim()}".`);
      await load(data);
    } catch (e: any) {
      setPanel((p) => p && { ...p, error: e?.message || 'Could not save the report' });
    }
    setBusy(false);
  };

  const remove = async (s: Saved) => {
    if (!data) return;
    const ok = await dialog.confirm(`Delete the saved report "${s.name}"? The books stay as they are; only the report's name and settings go.`, {
      title: 'Delete a saved report', confirmLabel: 'Delete it', cancelLabel: 'Keep it', destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/admin/books/reports/builder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', id: s.id, seen: s.updatedAt }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(problem(json, res.status));
      setSavedId(null);
      setPanel(null);
      setNotice(`Deleted "${s.name}".`);
      await load(data);
    } catch (e: any) {
      setPanel((p) => p && { ...p, error: e?.message || 'Could not delete the report' });
    }
    setBusy(false);
  };

  const companyName = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company;
  const picked = data && {
    division: data.divisions.find((d) => d.key === data.division) ?? null,
    location: data.locations.find((l) => l.key === data.location) ?? null,
  };
  const filters = picked ? filterWords(picked.division, picked.location) : '';
  // The report shown, every line, as an Excel file (src/lib/books/report-workbook.ts).
  const excelUrl = data && `/api/admin/books/reports/builder/download?${query(data)}`;
  const lineWord = data?.rows === 'customer' ? 'Customer' : data?.rows === 'vendor' ? 'Vendor' : 'Account';

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Report builder</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          FleetSuite&apos;s own profit and loss with a line for each account, customer or vendor and a column for each month,
          quarter, year, division or location.{' '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}
      {notice && !error && <div style={banner(GREEN)}>{notice}</div>}

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
              NetSuite&apos;s ledger hasn&apos;t been copied yet, so lines from its documents have no location, customer or vendor.
              It&apos;s copied every two hours, or press Copy now on Trial balance vs NetSuite.
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
            {READY_MADE.map((r) => (
              <button
                key={r.label}
                onClick={() => pick({ rows: r.rows, by: r.by, division: null, location: null })}
                disabled={loading}
                style={button(data.rows === r.rows && data.by === r.by && !data.division && !data.location)}
              >
                {r.label}
              </button>
            ))}
          </div>

          {data.saved.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>Saved</span>
              {data.saved.map((s) => (
                <button
                  key={s.id}
                  onClick={() => openSaved(s)}
                  disabled={loading}
                  title={s.savedBy ? `Saved by ${s.savedBy}` : undefined}
                  style={button(open?.id === s.id && shows(s, data))}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              Months
              <select value={data.months} onChange={(e) => pick({ months: e.target.value as BuilderMonths })} disabled={loading} style={select}>
                {BUILDER_MONTHS.map((m) => <option key={m} value={m}>{MONTHS_LABELS[m]}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              From
              <select value={data.from} onChange={(e) => pick({ from: e.target.value })} disabled={loading} style={select}>
                {data.monthList.map((m) => <option key={m} value={m}>{shortName(m)}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              To
              <select value={data.to} onChange={(e) => pick({ to: e.target.value })} disabled={loading} style={select}>
                {data.monthList.map((m) => <option key={m} value={m}>{shortName(m)}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              Lines
              <select value={data.rows} onChange={(e) => pick({ rows: e.target.value as BuilderRows })} disabled={loading} style={select}>
                {BUILDER_ROWS.map((r) => <option key={r} value={r}>{ROWS_LABELS[r]}</option>)}
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
              {builderTitle(data.by, data.rows)}, {period(data.from, data.to)}
              {data.months !== 'picked' && (
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginLeft: '8px' }}>{MONTHS_LABELS[data.months]}</span>
              )}
              {filters && <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginLeft: '8px' }}>{filters}</span>}
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {!panel && (
                <button
                  onClick={() => setPanel({ name: open?.canChange ? open.name : '', error: '' })}
                  disabled={loading}
                  title="Keep this report's lines, columns, filters and months under a name, to open again"
                  style={act(GREEN, !loading)}
                >
                  Save report
                </button>
              )}
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
          </div>

          {panel && (
            <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '12px', marginBottom: '10px', background: 'var(--card)' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '4px' }}>
                Name
              </label>
              <input
                value={panel.name}
                onChange={(e) => setPanel({ name: e.target.value, error: '' })}
                maxLength={60}
                placeholder="Upfit by month, say"
                style={input}
              />
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Keeps the lines, columns, filters and months{data.months !== 'picked' ? `, ${MONTHS_LABELS[data.months].toLowerCase()} as the calendar moves` : ''}.
                Everyone who opens the books sees it.
              </div>
              {panel.error && <div style={{ fontSize: '12px', fontWeight: 700, color: RED, marginTop: '6px' }}>{panel.error}</div>}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px' }}>
                {open?.canChange ? (
                  <>
                    <button onClick={() => save(false)} disabled={busy} style={act(GREEN, !busy)}>{busy ? 'Saving…' : 'Save changes'}</button>
                    <button onClick={() => save(true)} disabled={busy} style={act(null, !busy)}>Save as a new report</button>
                  </>
                ) : (
                  <button onClick={() => save(true)} disabled={busy} style={act(GREEN, !busy)}>{busy ? 'Saving…' : 'Save'}</button>
                )}
                <button onClick={() => setPanel(null)} disabled={busy} style={act(null, !busy)}>Leave without saving</button>
                {open?.canChange && (
                  <button
                    onClick={() => remove(open)}
                    disabled={busy}
                    style={{ background: 'none', border: 'none', padding: 0, color: RED, fontSize: '12px', fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer' }}
                  >
                    Delete &ldquo;{open.name}&rdquo;
                  </button>
                )}
              </div>
            </div>
          )}
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
                made without one. A line&apos;s location is its own, else the one NetSuite has on its document, else No location. A
                line&apos;s customer or vendor is the one NetSuite names on the line it copies, else the one its document names, else
                it&apos;s No customer or No vendor.
              </div>
            )}
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table className="rep-table" style={{ minWidth: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)' }}>
                  <th style={{ ...labelCell(0), fontWeight: 700 }}>{lineWord}</th>
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
                {data.lines.map((l, i) => <BuilderRow key={`${i}-${l.kind}-${l.account ?? l.party ?? l.label}`} line={l} columns={data.columns} />)}
              </tbody>
            </table>
          </div>
        </>
      )}
      {loading && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
