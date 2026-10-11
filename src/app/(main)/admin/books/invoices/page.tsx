'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';

/**
 * Books → Invoices vs NetSuite (migration 364, docs/books.md "Invoices").
 *
 * FleetSuite works out its own entry for every NetSuite invoice with the
 * invoice rule and checks it line by line against what NetSuite posted for
 * the same invoice. Nothing is posted yet. Super admins only while the books
 * are built, linked from the other books pages.
 */

type Status = 'matches' | 'differs' | 'unworkable' | 'waiting';

interface Summary {
  invoices: number;
  matches: number;
  differs: number;
  unworkable: number;
  waiting: number;
  withCost: number;
}

interface Amount {
  account: string;
  cents: number;
}

interface Row {
  lineId: string;
  label: string;
  division: 'upfit' | 'graphics' | null;
  fleetsuite: Amount | null;
  netsuite: Amount | null;
  cost: boolean;
  same: boolean;
}

interface Invoice {
  netsuiteId: string;
  number: string;
  date: string;
  customer: string | null;
  total: number;
  voided: boolean;
  status: Status;
  waiting?: 'lines' | 'gl';
  reasons: string[];
  rows: Row[];
}

interface Reason {
  key: string;
  text: string;
  invoices: number;
  examples: string[];
}

interface Payload {
  rule: string;
  companies: Array<{ code: string; name: string }>;
  company: string;
  month: string;
  months: string[];
  listsCopiedAt: string | null;
  summary: Summary;
  reasons: Reason[];
  notes: string[];
  invoices: Invoice[];
  accounts: Record<string, string>;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents: number) => money.format(cents / 100);

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const dateText = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}/${iso.slice(0, 4)}`;

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
const AMBER = '#f59e0b';
const GREY = '#94a3b8';

const STATUS: Record<Status, { label: string; color: string }> = {
  matches: { label: 'Matches', color: GREEN },
  differs: { label: 'Differs', color: RED },
  unworkable: { label: "Can't work out", color: AMBER },
  waiting: { label: 'Waiting', color: GREY },
};
const waitingLabel = (inv: Invoice) =>
  inv.waiting === 'lines' ? 'Lines not copied yet' : inv.waiting === 'gl' ? "Not in NetSuite's GL yet" : STATUS[inv.status].label;

const allMatch = (s: Summary) => s.differs + s.unworkable + s.waiting === 0;

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
const textCell: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };

function Side({ amount, accounts }: { amount: Amount | null; accounts: Record<string, string> }) {
  if (!amount) return <><td style={textCell} /><td style={cell} /><td style={cell} /></>;
  return (
    <>
      <td style={textCell}>{accounts[amount.account] ?? `NetSuite account ${amount.account}`}</td>
      <td style={cell}>{amount.cents > 0 ? fmt(amount.cents) : ''}</td>
      <td style={cell}>{amount.cents < 0 ? fmt(-amount.cents) : ''}</td>
    </>
  );
}

function InvoiceDetail({ invoice, accounts }: { invoice: Invoice; accounts: Record<string, string> }) {
  return (
    <div style={{ padding: '8px 10px 12px', background: 'var(--bg)' }}>
      {invoice.reasons.map((r) => (
        <div key={r} style={{ fontSize: '12px', color: invoice.status === 'unworkable' ? AMBER : RED, marginBottom: '4px' }}>{r}</div>
      ))}
      {invoice.rows.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {invoice.waiting === 'lines' ? "This invoice's lines haven't been copied from NetSuite yet." : 'Nothing posts on either side.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginTop: '6px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
            <thead>
              <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                <th style={{ ...cell, textAlign: 'left' }}>Line</th>
                <th style={{ ...cell, textAlign: 'left' }}>FleetSuite account</th>
                <th style={cell}>Debit</th>
                <th style={cell}>Credit</th>
                <th style={{ ...cell, textAlign: 'left' }}>NetSuite account</th>
                <th style={cell}>Debit</th>
                <th style={cell}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {invoice.rows.map((r) => (
                <tr key={r.lineId} style={{ borderTop: '1px solid var(--border)', color: r.same || invoice.status !== 'differs' ? undefined : RED }}>
                  <td style={textCell}>
                    {r.label}
                    {r.division && <span style={{ ...chip(GREY), marginLeft: '6px' }}>{r.division === 'upfit' ? 'Upfit' : 'Graphics'}</span>}
                    {r.cost && <span style={{ ...chip(GREY), marginLeft: '6px' }}>Cost of goods, for the fulfillment rule</span>}
                  </td>
                  <Side amount={r.fleetsuite} accounts={accounts} />
                  <Side amount={r.netsuite} accounts={accounts} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function BooksInvoicesPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [company, setCompany] = useState('');
  const [month, setMonth] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  // Results of "Check every month", for the company they were checked for.
  const [monthly, setMonthly] = useState<{ company: string; months: Record<string, Summary> }>({ company: '', months: {} });
  const [checking, setChecking] = useState<string | null>(null);

  const load = useCallback(async (nextCompany: string, nextMonth: string) => {
    try {
      const params = new URLSearchParams();
      if (nextCompany) params.set('company', nextCompany);
      if (nextMonth) params.set('month', nextMonth.slice(0, 7));
      const res = await apiFetch(`/api/admin/books/invoices?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setCompany(json.company);
      setMonth(json.month);
      setOpen(null);
      setError('');
      setMonthly((m) => (m.company === json.company ? { ...m, months: { ...m.months, [json.month]: json.summary } } : m));
    } catch (e: any) {
      setError(e?.message || 'Could not check the invoices');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    load('', '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const pick = (nextCompany: string, nextMonth: string) => {
    setLoading(true);
    load(nextCompany, nextMonth);
  };

  const checkEveryMonth = async () => {
    if (!data) return;
    const results: Record<string, Summary> = {};
    setMonthly({ company, months: {} });
    setError('');
    try {
      for (const m of data.months) {
        setChecking(m);
        const res = await apiFetch(`/api/admin/books/invoices?${new URLSearchParams({ company, month: m.slice(0, 7), summary: '1' })}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `Checking ${monthName(m)} failed (${res.status})`);
        results[m] = json.summary;
        setMonthly({ company, months: { ...results } });
      }
    } catch (e: any) {
      setError(e?.message || 'Checking every month failed');
    }
    setChecking(null);
  };

  const s = data?.summary;
  const years = [...new Set((data?.months ?? []).map((m) => m.slice(0, 4)))];
  const checkedMonths = monthly.company === company ? monthly.months : {};
  const checkedCount = Object.keys(checkedMonths).length;
  const matchingMonths = Object.values(checkedMonths).filter(allMatch).length;
  const shown = (data?.invoices ?? []).filter((inv) => !onlyProblems || inv.status !== 'matches');

  return (
    <div>
      <div style={{ marginBottom: '14px', display: 'flex', gap: '12px', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px' }}>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>Invoices vs NetSuite</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            For every NetSuite invoice FleetSuite works out its own entry: receivables take the total, each line goes to its
            item&apos;s income account, and sales tax to the account its tax code posts to. Each entry is checked line by line
            against what NetSuite posted for the same invoice. Nothing is posted to FleetSuite&apos;s books yet. Visible only to
            super admins. <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
            {' · '}
            <Link href="/admin/books/trial-balance" style={{ color: 'var(--text-secondary)' }}>Trial balance vs NetSuite</Link>
            {' · '}
            <Link href="/admin/books/lists" style={{ color: 'var(--text-secondary)' }}>NetSuite lists</Link>
          </div>
        </div>
        <button
          onClick={checkEveryMonth}
          disabled={!!checking || loading || !data}
          style={{
            padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
            color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: checking ? 'wait' : 'pointer',
          }}
        >
          {checking ? `Checking ${monthName(checking)}…` : 'Check every month'}
        </button>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && s && (
        <>
          {!checking && checkedCount === data.months.length && (
            <div style={banner(matchingMonths === checkedCount ? GREEN : AMBER)}>
              Every invoice matches NetSuite in {matchingMonths} of {checkedCount} months.
            </div>
          )}
          {data.notes.map((n) => <div key={n} style={banner(AMBER)}>{n}</div>)}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {data.companies.map((c) => (
              <button key={c.code} onClick={() => pick(c.code, month)} disabled={loading || !!checking} style={button(c.code === company)}>
                {c.name}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
            {years.map((year) => (
              <div key={year} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ width: '40px', fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)' }}>{year}</span>
                {data.months.filter((m) => m.startsWith(year)).map((m) => {
                  const r = checkedMonths[m];
                  const color = !r ? GREY : allMatch(r) ? GREEN : RED;
                  return (
                    <button
                      key={m}
                      onClick={() => pick(company, m)}
                      disabled={loading || !!checking}
                      title={!r ? 'Not checked yet' : allMatch(r) ? 'Every invoice matches NetSuite' : `${r.invoices - r.matches} invoice(s) don't match`}
                      style={{ ...button(m === month), borderColor: m === month ? 'var(--text-primary)' : `${color}88`, color: r ? color : 'var(--text-primary)' }}
                    >
                      {MONTH_NAMES[Number(m.slice(5, 7)) - 1]} {r ? (allMatch(r) ? '✓' : '✗') : ''}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800 }}>{monthName(month)}</div>
            <span style={chip(GREY)}>{s.invoices.toLocaleString('en-US')} invoices</span>
            {s.matches > 0 && <span style={chip(GREEN)}>{s.matches.toLocaleString('en-US')} match</span>}
            {s.differs > 0 && <span style={chip(RED)}>{s.differs.toLocaleString('en-US')} differ</span>}
            {s.unworkable > 0 && <span style={chip(AMBER)}>{s.unworkable.toLocaleString('en-US')} can&apos;t be worked out</span>}
            {s.waiting > 0 && <span style={chip(GREY)}>{s.waiting.toLocaleString('en-US')} waiting on a copy</span>}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            Invoices dated this month that NetSuite posted to this company, checked with rule {data.rule}.
            {data.listsCopiedAt && ` Items and tax codes as copied from NetSuite ${ago(data.listsCopiedAt)}.`}
          </div>

          {data.reasons.length > 0 && (
            <div style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '13px', fontWeight: 800, marginBottom: '6px' }}>Why they don&apos;t match</div>
              <div style={{ border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--card)' }}>
                {data.reasons.map((r, i) => (
                  <div key={r.key} style={{ padding: '8px 12px', borderTop: i ? '1px solid var(--border)' : undefined, fontSize: '12px' }}>
                    <span style={{ fontWeight: 800 }}>{r.invoices.toLocaleString('en-US')} {r.invoices === 1 ? 'invoice' : 'invoices'}</span>
                    {' · '}{r.text}
                    <div style={{ color: 'var(--text-muted)', marginTop: '2px' }}>
                      {r.invoices > r.examples.length ? 'For example ' : ''}{r.examples.join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
              Only invoices that don&apos;t match
            </label>
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)' }}>
                  <th style={{ ...cell, textAlign: 'left' }}>Invoice</th>
                  <th style={{ ...cell, textAlign: 'left' }}>Date</th>
                  <th style={{ ...cell, textAlign: 'left' }}>Customer</th>
                  <th style={cell}>Total</th>
                  <th style={{ ...cell, textAlign: 'left' }}>Check</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                    {s.invoices === 0 ? 'No invoices for this company this month.' : 'Every invoice matches NetSuite.'}
                  </td></tr>
                )}
                {shown.map((inv) => (
                  <Fragment key={inv.netsuiteId}>
                    <tr
                      onClick={() => setOpen(open === inv.netsuiteId ? null : inv.netsuiteId)}
                      style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                    >
                      <td style={{ ...textCell, fontWeight: 700 }}>{open === inv.netsuiteId ? '▾' : '▸'} {inv.number}</td>
                      <td style={{ ...cell, textAlign: 'left' }}>{dateText(inv.date)}</td>
                      <td style={textCell}>{inv.customer ?? ''}</td>
                      <td style={cell}>{fmt(inv.total)}</td>
                      <td style={{ ...cell, textAlign: 'left' }}>
                        <span style={chip(STATUS[inv.status].color)}>{waitingLabel(inv)}</span>
                        {inv.voided && <span style={{ ...chip(GREY), marginLeft: '6px' }}>Voided</span>}
                      </td>
                    </tr>
                    {open === inv.netsuiteId && (
                      <tr><td colSpan={5} style={{ padding: 0 }}><InvoiceDetail invoice={inv} accounts={data.accounts} /></td></tr>
                    )}
                  </Fragment>
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
