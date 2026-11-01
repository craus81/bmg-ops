'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';

/**
 * Books → Sales by location (src/lib/books/sales-report.ts, migration 426,
 * docs/books.md).
 *
 * A company's sales for a range of months by state, location and NetSuite
 * class, with returns, discounts and transportation charges apart, from the
 * copy of NetSuite's ledger; made for the insurance premium audit. Print
 * shows the report alone, for saving as a PDF. Open to whoever opens the
 * books, linked from Reports.
 */

type Column = 'gross' | 'returns' | 'discounts' | 'transportation' | 'other';

interface Amounts {
  gross: number;
  returns: number;
  discounts: number;
  transportation: number;
  other: number;
  net: number;
}

interface Payload {
  companies: Array<{ code: string; name: string; legal_name: string | null }>;
  company: string;
  from: string;
  to: string;
  months: string[];
  rows: Array<Amounts & { state: string; location: string; class: string }>;
  states: Array<Amounts & { state: string }>;
  accounts: Array<Amounts & { account: string; number: string | null; name: string }>;
  total: Amounts;
  lastCopy: { at: string; error: string | null } | null;
}

const COLUMNS: Array<[Column | 'net', string]> = [
  ['gross', 'Gross sales'],
  ['returns', 'Returns'],
  ['discounts', 'Discounts'],
  ['transportation', 'Transportation'],
  ['other', 'Other'],
  ['net', 'Net sales'],
];

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => (cents ? money.format(cents / 100) : '—');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const shortName = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1].slice(0, 3)} ${month.slice(0, 4)}`;
const firstDay = (month: string) => `${Number(month.slice(5, 7))}/1/${month.slice(0, 4)}`;
const lastDay = (month: string) => {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${Number(month.slice(5, 7))}/${last}/${month.slice(0, 4)}`;
};

const STATE_NAMES: Record<string, string> = { MO: 'Missouri', GA: 'Georgia', '—': 'No state' };

const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const left: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };

const button = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: '8px', border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border)'}`,
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: active ? 800 : 600, cursor: 'pointer',
});

const select: React.CSSProperties = {
  padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
  color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600,
};

const RED = '#ef4444';

/** Printing shows the report alone, as the page it is meant to be. */
const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  .sales-print, .sales-print * { visibility: visible !important; }
  .sales-print { position: absolute; left: 0; top: 0; width: 100%; color: #000; }
  .sales-print table { font-size: 10px !important; }
  .sales-print th, .sales-print td { padding: 3px 6px !important; }
  .sales-no-print { display: none !important; }
}`;

function AmountCells({ a, bold = false }: { a: Amounts; bold?: boolean }) {
  return (
    <>
      {COLUMNS.map(([key]) => (
        <td key={key} style={{ ...cell, fontWeight: bold || key === 'net' ? 700 : 400 }}>{fmt(a[key])}</td>
      ))}
    </>
  );
}

function Head({ first, second }: { first: string; second?: string }) {
  return (
    <thead>
      <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
        <th style={{ ...left, fontWeight: 700 }}>{first}</th>
        {second && <th style={{ ...left, fontWeight: 700 }}>{second}</th>}
        {COLUMNS.map(([key, label]) => <th key={key} style={cell}>{label}</th>)}
      </tr>
    </thead>
  );
}

const box: React.CSSProperties = { overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '14px' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' };
const heading: React.CSSProperties = { fontSize: '13px', fontWeight: 800, margin: '4px 0 6px' };

function csvOf(data: Payload): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const n = (cents: number) => (cents / 100).toFixed(2);
  const out = [['State', 'Location', 'Class', ...COLUMNS.map(([, label]) => label)].map(q).join(',')];
  for (const r of data.rows) out.push([q(r.state), q(r.location), q(r.class), ...COLUMNS.map(([k]) => n(r[k]))].join(','));
  out.push([q('Total'), '', '', ...COLUMNS.map(([k]) => n(data.total[k]))].join(','));
  return out.join('\n');
}

export default function BooksSalesPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (next: { company?: string; from?: string; to?: string }) => {
    try {
      const params = new URLSearchParams();
      if (next.company) params.set('company', next.company);
      if (next.from) params.set('from', next.from.slice(0, 7));
      if (next.to) params.set('to', next.to.slice(0, 7));
      const res = await apiFetch(`/api/admin/books/sales?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
      window.history.replaceState(null, '', `/admin/books/sales?${new URLSearchParams({
        company: json.company, from: json.from.slice(0, 7), to: json.to.slice(0, 7),
      })}`);
    } catch (e: any) {
      setError(e?.message || 'Could not load the report');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    const q = new URLSearchParams(window.location.search);
    load({ company: q.get('company') ?? undefined, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  // A start after the end moves the end with it, and an end before the start the start.
  const pick = (next: { company?: string; from?: string; to?: string }) => {
    if (!data) return;
    let from = next.from ?? data.from;
    let to = next.to ?? data.to;
    if (next.from && from > to) to = from;
    if (next.to && to < from) from = to;
    setLoading(true);
    load({ company: next.company ?? data.company, from, to });
  };

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([csvOf(data)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `Sales by location ${data.company} ${data.from.slice(0, 7)} to ${data.to.slice(0, 7)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const company = data?.companies.find((c) => c.code === data.company);

  return (
    <div>
      <style>{PRINT_CSS}</style>
      <div className="sales-no-print" style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Sales by location</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Sales for the months picked by state, location and NetSuite class, with returns, discounts and transportation
          charges apart, from the copy of NetSuite&apos;s ledger. Net sales is the income on the profit and loss for the same
          months.{' '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '13px', fontWeight: 700, background: `${RED}10`, border: `1px solid ${RED}40`, color: RED }}>{error}</div>}
      {data?.lastCopy?.error && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '13px', fontWeight: 700, background: `${RED}10`, border: `1px solid ${RED}40`, color: RED }}>
          The last copy of NetSuite&apos;s ledger failed: {data.lastCopy.error}
        </div>
      )}

      {data && (
        <>
          <div className="sales-no-print" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {data.companies.map((c) => (
              <button key={c.code} onClick={() => pick({ company: c.code })} disabled={loading} style={button(c.code === data.company)}>
                {c.name}
              </button>
            ))}
          </div>
          <div className="sales-no-print" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '14px', fontSize: '12px', color: 'var(--text-secondary)' }}>
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
            <button onClick={() => window.print()} disabled={loading} style={button(false)}>🖨 Print / Save PDF</button>
            <button onClick={download} disabled={loading} style={button(false)}>⬇ Download CSV</button>
          </div>

          <div className="sales-print">
            <div style={{ fontSize: '16px', fontWeight: 800 }}>{company?.legal_name || company?.name}</div>
            <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '2px' }}>
              Gross sales by originating location and product type, {firstDay(data.from)} to {lastDay(data.to)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Product type is the NetSuite class on each line. Returns are credit memos and refunds; discounts are discount
              lines and discounts taken on payments; transportation is freight and shipping billed to customers; other is
              journal entries to income accounts. Returns and discounts are shown as reductions.
            </div>

            <div style={heading}>By state</div>
            <div style={box}>
              <table style={table}>
                <Head first="State" />
                <tbody>
                  {data.states.map((s) => (
                    <tr key={s.state} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={left}>{STATE_NAMES[s.state] ?? s.state}</td>
                      <AmountCells a={s} />
                    </tr>
                  ))}
                  <tr style={{ borderTop: '3px double var(--border)' }}>
                    <td style={{ ...left, fontWeight: 800 }}>Total</td>
                    <AmountCells a={data.total} bold />
                  </tr>
                </tbody>
              </table>
            </div>

            <div style={heading}>By location and product type</div>
            <div style={box}>
              <table style={table}>
                <Head first="Location" second="Product type" />
                <tbody>
                  {data.rows.length === 0 && (
                    <tr><td colSpan={8} style={{ padding: '12px', color: 'var(--text-muted)' }}>No sales in these months.</td></tr>
                  )}
                  {data.rows.map((r, i) => {
                    const firstOfLocation = i === 0 || data.rows[i - 1].location !== r.location;
                    return (
                      <tr key={`${r.state}-${r.location}-${r.class}`} style={{ borderTop: firstOfLocation ? '1px solid var(--border)' : 'none' }}>
                        <td style={{ ...left, fontWeight: 600 }}>{firstOfLocation ? `${r.location}${r.state !== '—' ? `, ${r.state}` : ''}` : ''}</td>
                        <td style={left}>{r.class}</td>
                        <AmountCells a={r} />
                      </tr>
                    );
                  })}
                  <tr style={{ borderTop: '3px double var(--border)' }}>
                    <td colSpan={2} style={{ ...left, fontWeight: 800 }}>Total</td>
                    <AmountCells a={data.total} bold />
                  </tr>
                </tbody>
              </table>
            </div>

            <div style={heading}>By income account</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
              The same amounts by the account they post to, to tie the total to the profit and loss.
            </div>
            <div style={box}>
              <table style={table}>
                <Head first="Account" />
                <tbody>
                  {data.accounts.map((a) => (
                    <tr key={a.account} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={left}>
                        {a.number && <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>{a.number}</span>}
                        {a.name}
                      </td>
                      <AmountCells a={a} />
                    </tr>
                  ))}
                  <tr style={{ borderTop: '3px double var(--border)' }}>
                    <td style={{ ...left, fontWeight: 800 }}>Total income</td>
                    <AmountCells a={data.total} bold />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {loading && <div className="sales-no-print" style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
