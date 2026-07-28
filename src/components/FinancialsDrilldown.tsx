'use client';

/**
 * Drill-down modal behind the Financials tab tiles. Every number on the
 * dashboard opens here to show the transactions/accounts underneath it:
 *
 *  - cash  → per-bank-account balances (financials RESTlet)
 *  - cards → per-card balances (RESTlet; cards in credit flagged, not owed)
 *  - ar    → every open customer invoice: aging-bucket chips, search,
 *            group-by-customer, invoice PDFs, printable customer statements
 *  - bills → open vendor bills (SuiteQL headers) with printable summaries,
 *            reconciled against the A/P account balance
 *  - net   → how Cash + A/R − A/P is assembled, linking into each view
 *
 * Stays inside FleetSuite: lists render here, PDFs/statements open in a new
 * tab for printing. Each list footer reconciles against the tile it came
 * from, so discrepancies are visible instead of mysterious.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useDialog } from '@/components/DialogProvider';
import { useFocusTrap } from '@/lib/use-focus-trap';
import { printStatements, printBill, openArInvoicePdf, usd2, fmtDate } from '@/lib/financials-print';
import type { OpenArInvoice, OpenVendorBill, AccountBalance, AgingBucketKey } from '@/lib/financials-data';
import type { FinancialsData } from './FinancialsDashboard';

export const AGE_META: { key: AgingBucketKey; label: string; shortLabel: string; color: string }[] = [
  { key: 'current', label: 'Current — not yet due', shortLabel: 'Current', color: 'var(--success)' },
  { key: 'd1_30', label: '1–30 days past due', shortLabel: '1–30', color: '#facc15' },
  { key: 'd31_60', label: '31–60 days past due', shortLabel: '31–60', color: '#f59e0b' },
  { key: 'd61_90', label: '61–90 days past due', shortLabel: '61–90', color: '#fb7a34' },
  { key: 'd90plus', label: '90+ days past due', shortLabel: '90+', color: 'var(--error)' },
];

export type DrillView = 'cash' | 'cards' | 'ar' | 'bills' | 'net';
export type BucketFilter = AgingBucketKey | 'pastdue' | 'all';
/** Customer filter — keyed by NetSuite entity id, with the display name for chips/titles. */
export interface CustomerRef { key: string; name: string }
export interface DrillTarget {
  view: DrillView;
  bucket?: BucketFilter;
  customer?: CustomerRef;
  grouped?: boolean;
}

// Must mirror arCustomerKey in src/lib/financials-data.ts (kept local — a
// value import would pull the server-only NetSuite client into this bundle).
const keyOf = (inv: { entityId: string | null; customer: string }): string =>
  inv.entityId ? `e:${inv.entityId}` : `n:${inv.customer}`;

interface ArBody { success: boolean; unpaidColumn: boolean; invoices: OpenArInvoice[] }
interface BillsBody { success: boolean; unpaidColumn: boolean; bills: OpenVendorBill[] }
interface AccountsBody { success: boolean; error?: string; bank: AccountBalance[]; card: AccountBalance[]; ap: AccountBalance[] }

/**
 * Fetch `url` once when `active` first becomes true; retry() re-arms it.
 * Superseded requests are versioned out via a request id rather than an
 * in-flight lock — a lock that outlives its effect wedges the view on the
 * spinner forever (StrictMode's mount/cleanup/remount, or deactivating and
 * reactivating the view while a slow fetch is still in the air).
 */
function useLazyFetch<T>(active: boolean, url: string) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const reqId = useRef(0);

  useEffect(() => {
    if (!active || state.data !== null || state.error !== null) return;
    const id = ++reqId.current;
    (async () => {
      try {
        const res = await apiFetch(url);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || 'Request failed');
        if (reqId.current === id) setState({ data: body as T, error: null });
      } catch (e: any) {
        if (reqId.current === id) setState({ data: null, error: e?.message || 'Request failed' });
      }
    })();
  }, [active, url, attempt, state]);

  const retry = useCallback(() => { setState({ data: null, error: null }); setAttempt(a => a + 1); }, []);
  return { ...state, retry };
}

const th: React.CSSProperties = { textAlign: 'left', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', fontWeight: 700, padding: '8px 10px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const thNum: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { fontSize: '12.5px', padding: '8px 10px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)', verticalAlign: 'middle' };
const tdNum: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const tdMuted: React.CSSProperties = { ...td, color: 'var(--text-secondary)' };
const btnSm: React.CSSProperties = { padding: '4px 10px', borderRadius: '7px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-secondary)', fontSize: '11.5px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' };
const infoText: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.55 };

function daysChip(days: number) {
  if (days <= 0) return null;
  const color = days > 90 ? 'var(--error)' : days > 60 ? '#fb7a34' : days > 30 ? '#f59e0b' : '#facc15';
  return <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', color, background: 'var(--subtle-bg)', whiteSpace: 'nowrap' }}>{days}d</span>;
}

function Spinner({ label }: { label: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 0' }}>
      <div style={{ width: '28px', height: '28px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '10px' }}>{label}</div>
    </div>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ textAlign: 'center', padding: '32px 0' }}>
      <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', fontWeight: 600 }}>{message}</div>
      <button onClick={onRetry} style={{ ...btnSm, marginTop: '10px' }}>Retry</button>
    </div>
  );
}

function nsLink(url: string) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
      style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
      NetSuite ↗
    </a>
  );
}

const VIEW_TITLES: Record<DrillView, string> = {
  cash: 'Cash on hand — bank accounts',
  cards: 'Credit cards — balances',
  ar: 'Accounts receivable — open invoices',
  bills: 'Accounts payable — open vendor bills',
  net: 'Net position — how it adds up',
};

export default function FinancialsDrilldown({ target, summary, onClose }: {
  target: DrillTarget;
  summary: FinancialsData;
  onClose: () => void;
}) {
  const dialog = useDialog();
  const panelRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const downOnBackdrop = useRef(false);

  const [view, setView] = useState<DrillView>(target.view);
  const [bucket, setBucket] = useState<BucketFilter>(target.bucket ?? 'all');
  const [customer, setCustomer] = useState<CustomerRef | null>(target.customer ?? null);
  const [grouped, setGrouped] = useState(!!target.grouped);
  const [search, setSearch] = useState('');
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);

  useEffect(() => {
    setView(target.view);
    setBucket(target.bucket ?? 'all');
    setCustomer(target.customer ?? null);
    setGrouped(!!target.grouped);
    setSearch('');
  }, [target]);

  const ar = useLazyFetch<ArBody>(view === 'ar', '/api/reports/financials/ar-invoices');
  const bills = useLazyFetch<BillsBody>(view === 'bills', '/api/reports/financials/ap-bills');
  const accounts = useLazyFetch<AccountsBody>(view === 'cash' || view === 'cards', '/api/reports/financials/accounts');

  const arData = ar.data;
  const invoices = useMemo(() => arData?.invoices ?? [], [arData]);
  const filtered = useMemo(() => {
    let list = invoices;
    if (customer) list = list.filter(i => keyOf(i) === customer.key);
    if (bucket === 'pastdue') list = list.filter(i => i.daysPastDue > 0);
    else if (bucket !== 'all') list = list.filter(i => i.bucket === bucket);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter(i => i.customer.toLowerCase().includes(q) || i.tranid.toLowerCase().includes(q) || (i.po || '').toLowerCase().includes(q));
    return list;
  }, [invoices, customer, bucket, search]);

  const customerRows = useMemo(() => {
    const map = new Map<string, { key: string; customer: string; count: number; total: number; pastDue: number; oldest: number }>();
    for (const i of filtered) {
      const key = keyOf(i);
      const c = map.get(key) || { key, customer: i.customer, count: 0, total: 0, pastDue: 0, oldest: 0 };
      c.count += 1;
      c.total += i.unpaid;
      if (i.daysPastDue > 0) { c.pastDue += i.unpaid; c.oldest = Math.max(c.oldest, i.daysPastDue); }
      map.set(key, c);
    }
    return [...map.values()].sort((a, b) => b.pastDue - a.pastDue || b.total - a.total);
  }, [filtered]);

  // Statements always cover the customer's FULL open balance, whatever the
  // current bucket/search filter shows — a partial statement misleads.
  const statementGroupFor = useCallback((cust: CustomerRef) => ({
    customer: cust.name,
    invoices: invoices.filter(i => keyOf(i) === cust.key),
  }), [invoices]);

  const onPdf = async (inv: OpenArInvoice) => {
    setPdfBusy(inv.id);
    const res = await openArInvoicePdf(inv.id);
    setPdfBusy(null);
    if (!res.ok) await dialog.alert(res.error || 'Could not open the PDF');
  };

  const showTotalCol = !!ar.data && ar.data.unpaidColumn && filtered.some(i => Math.abs(i.total - i.unpaid) > 0.005);
  const sumShown = filtered.reduce((s, i) => s + i.unpaid, 0);
  const unfiltered = !customer && bucket === 'all' && !search.trim();

  const chip = (active: boolean, color?: string): React.CSSProperties => ({
    padding: '5px 11px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${active ? (color || 'var(--tab-active-border, var(--border-strong))') : 'var(--border)'}`,
    background: active ? 'var(--tab-active-bg)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
    whiteSpace: 'nowrap',
  });

  // ── View bodies ─────────────────────────────────────────────────────────

  const renderAccounts = (group: 'cash' | 'cards') => {
    if (accounts.error) return <LoadError message={accounts.error} onRetry={accounts.retry} />;
    if (!accounts.data) return <Spinner label="Pulling balances from NetSuite…" />;
    if (!accounts.data.success) {
      return (
        <div style={{ ...infoText, padding: '18px 2px' }}>
          <span style={{ color: 'var(--warning)', fontWeight: 700 }}>Balances unavailable.</span>{' '}
          {accounts.data.error ? <>NetSuite said: <code style={{ color: 'var(--text-primary)' }}>{accounts.data.error}</code></>
            : <>The financials RESTlet isn&apos;t deployed (set <code>NETSUITE_FINANCIALS_RESTLET_URL</code>).</>}
        </div>
      );
    }
    const rows = group === 'cash' ? accounts.data.bank : accounts.data.card;
    if (rows.length === 0) {
      return <div style={{ ...infoText, padding: '18px 2px' }}>No accounts configured — set <code>{group === 'cash' ? 'NETSUITE_BANK_ACCOUNT_IDS' : 'NETSUITE_CARD_ACCOUNT_ID'}</code>.</div>;
    }
    const owed = (b: number | null) => (b || 0) > 0.005 ? Math.abs(b || 0) : 0;
    const total = group === 'cash'
      ? rows.reduce((s, a) => s + (a.balance || 0), 0)
      : rows.reduce((s, a) => s + owed(a.balance), 0);
    const tile = group === 'cash' ? summary.cash : summary.ap.cardOwed;
    return (
      <>
        <div style={{ ...infoText, marginBottom: '12px' }}>
          {group === 'cash'
            ? 'Bank account balances straight from NetSuite’s chart of accounts — these add up to the Cash on hand tile.'
            : 'Credit card account balances from NetSuite. A card in credit (negative balance) isn’t money owed, so it’s excluded from the tile.'}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Account</th><th style={thNum}>Balance</th>{group === 'cards' && <th style={thNum}>Counted as owed</th>}</tr></thead>
          <tbody>
            {rows.map(a => (
              <tr key={a.id}>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{a.name || `Account #${a.id}`}</div>
                  {a.name === null && <div style={{ fontSize: '11px', color: 'var(--warning)' }}>Not returned by the RESTlet — check the account id</div>}
                </td>
                <td style={tdNum}>{a.balance === null ? '—' : usd2(a.balance)}</td>
                {group === 'cards' && <td style={tdNum}>{a.balance === null ? '—' : usd2(owed(a.balance))}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ ...td, fontWeight: 800, borderBottom: 'none' }}>{group === 'cash' ? 'Total cash' : 'Total owed on cards'}</td>
              <td style={{ ...tdNum, fontWeight: 800, borderBottom: 'none' }} colSpan={group === 'cards' ? 2 : 1}>{usd2(total)}</td>
            </tr>
          </tfoot>
        </table>
        {tile !== null && Math.abs(total - tile) >= 1 && (
          <div style={{ ...infoText, marginTop: '10px', color: 'var(--warning)' }}>
            The tile shows {usd2(tile)} — refreshed at a different moment; reopen the Financials tab to resync.
          </div>
        )}
      </>
    );
  };

  const renderAr = () => {
    if (ar.error) return <LoadError message={ar.error} onRetry={ar.retry} />;
    if (!ar.data) return <Spinner label="Pulling open invoices from NetSuite…" />;
    return (
      <>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', marginBottom: '10px' }}>
          <button onClick={() => setBucket('all')} style={chip(bucket === 'all')}>All</button>
          <button onClick={() => setBucket('pastdue')} style={chip(bucket === 'pastdue', 'var(--error)')}>Past due</button>
          {AGE_META.map(m => (
            <button key={m.key} onClick={() => setBucket(m.key)} style={chip(bucket === m.key, m.color)} title={m.label}>{m.shortLabel}</button>
          ))}
          <span style={{ flex: 1 }} />
          <button onClick={() => setGrouped(g => !g)} style={chip(grouped)}>By customer</button>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search customer, invoice #, or PO…"
            style={{ flex: '1 1 220px', padding: '8px 12px', borderRadius: '9px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px' }}
          />
          {customer && (
            <button onClick={() => setCustomer(null)} style={{ ...btnSm, borderColor: 'var(--border-strong)' }}>
              {customer.name} ✕
            </button>
          )}
          {customer && (
            <button onClick={() => printStatements([statementGroupFor(customer)], dialog.alert)} style={{ ...btnSm, color: 'var(--text-primary)' }}>
              🖨 Print statement
            </button>
          )}
          {grouped && !customer && customerRows.length > 0 && (
            <button onClick={() => printStatements(customerRows.map(c => statementGroupFor({ key: c.key, name: c.customer })), dialog.alert)} style={{ ...btnSm, color: 'var(--text-primary)' }}>
              {bucket !== 'all' || search.trim()
                ? `🖨 Statements for these ${customerRows.length} customer${customerRows.length === 1 ? '' : 's'}`
                : `🖨 Print all statements (${customerRows.length})`}
            </button>
          )}
        </div>
        {grouped && !customer && (
          <div style={{ ...infoText, marginBottom: '10px' }}>
            Statements always include the customer&apos;s full open balance{bucket !== 'all' || search.trim() ? ' — the active filter only picks which customers print.' : '.'}
          </div>
        )}
        {!ar.data.unpaidColumn && (
          <div style={{ ...infoText, color: 'var(--warning)', marginBottom: '10px' }}>
            NetSuite didn&apos;t return open balances — amounts are full invoice totals, so partial payments aren&apos;t reflected.
          </div>
        )}
        {grouped && !customer ? (
          <div className="responsive-table">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Customer</th><th style={thNum}>Invoices</th><th style={thNum}>Open balance</th>
                  <th style={thNum}>Past due</th><th style={thNum}>Oldest</th><th style={th} />
                </tr>
              </thead>
              <tbody>
                {customerRows.map(c => (
                  <tr key={c.key} onClick={() => { setCustomer({ key: c.key, name: c.customer }); setGrouped(false); }} style={{ cursor: 'pointer' }} className="fin-row">
                    <td style={{ ...td, fontWeight: 600 }}>{c.customer}</td>
                    <td style={tdNum}>{c.count}</td>
                    <td style={tdNum}>{usd2(c.total)}</td>
                    <td style={{ ...tdNum, color: c.pastDue > 0.005 ? 'var(--error)' : 'var(--text-muted)', fontWeight: 700 }}>{c.pastDue > 0.005 ? usd2(c.pastDue) : '—'}</td>
                    <td style={tdNum}>{daysChip(c.oldest) || '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button onClick={e => { e.stopPropagation(); printStatements([statementGroupFor({ key: c.key, name: c.customer })], dialog.alert); }} style={btnSm}>🖨 Statement</button>
                    </td>
                  </tr>
                ))}
                {customerRows.length === 0 && <tr><td style={tdMuted} colSpan={6}>No customers match.</td></tr>}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="responsive-table">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Invoice</th><th style={th}>Customer</th><th style={th}>Date</th><th style={th}>Due</th>
                  <th style={thNum}>Days</th>{showTotalCol && <th style={thNum}>Total</th>}<th style={thNum}>Balance</th><th style={th} />
                </tr>
              </thead>
              <tbody>
                {filtered.map(inv => (
                  <tr key={inv.id} className="fin-row">
                    <td style={{ ...td, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {inv.tranid}
                      {inv.po && <div style={{ fontSize: '10.5px', fontWeight: 600, color: 'var(--text-muted)' }}>PO {inv.po}</div>}
                    </td>
                    <td style={tdMuted}>
                      <span onClick={() => setCustomer({ key: keyOf(inv), name: inv.customer })} style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border-strong)', textUnderlineOffset: '3px' }} title="Filter to this customer">
                        {inv.customer}
                      </span>
                    </td>
                    <td style={{ ...tdMuted, whiteSpace: 'nowrap' }}>{fmtDate(inv.date)}</td>
                    <td style={{ ...tdMuted, whiteSpace: 'nowrap' }}>{fmtDate(inv.dueDate)}</td>
                    <td style={tdNum}>{daysChip(inv.daysPastDue) || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                    {showTotalCol && <td style={{ ...tdNum, color: 'var(--text-muted)' }}>{usd2(inv.total)}</td>}
                    <td style={{ ...tdNum, fontWeight: 700 }}>{usd2(inv.unpaid)}</td>
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
                        <button onClick={() => onPdf(inv)} disabled={pdfBusy === inv.id} style={{ ...btnSm, opacity: pdfBusy === inv.id ? 0.6 : 1 }}>
                          {pdfBusy === inv.id ? '…' : 'PDF'}
                        </button>
                        {nsLink(inv.nsUrl)}
                      </span>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && <tr><td style={tdMuted} colSpan={showTotalCol ? 8 : 7}>No invoices match.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  };

  const renderBills = () => {
    if (bills.error) return <LoadError message={bills.error} onRetry={bills.retry} />;
    if (!bills.data) return <Spinner label="Pulling open bills from NetSuite…" />;
    const list = bills.data.bills;
    const sum = list.reduce((s, b) => s + b.unpaid, 0);
    const tile = summary.ap.vendorBills;
    return (
      <>
        <div style={{ ...infoText, marginBottom: '12px' }}>
          Unpaid vendor bills visible to the FleetSuite integration. The tile is the NetSuite A/P account balance — vendor credits and unapplied payments aren&apos;t visible here, so a small difference between the two is normal.
        </div>
        {!bills.data.unpaidColumn && (
          <div style={{ ...infoText, color: 'var(--warning)', marginBottom: '10px' }}>
            NetSuite didn&apos;t return open balances — amounts are full bill totals, so partial payments aren&apos;t reflected.
          </div>
        )}
        <div className="responsive-table">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Bill</th><th style={th}>Vendor</th><th style={th}>Date</th><th style={th}>Due</th>
                <th style={thNum}>Days</th><th style={thNum}>Balance</th><th style={th} />
              </tr>
            </thead>
            <tbody>
              {list.map(b => (
                <tr key={b.id} className="fin-row">
                  <td style={{ ...td, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {b.tranid}
                    {b.memo && <div style={{ fontSize: '10.5px', fontWeight: 600, color: 'var(--text-muted)', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.memo}>{b.memo}</div>}
                  </td>
                  <td style={tdMuted}>{b.vendor}</td>
                  <td style={{ ...tdMuted, whiteSpace: 'nowrap' }}>{fmtDate(b.date)}</td>
                  <td style={{ ...tdMuted, whiteSpace: 'nowrap' }}>{fmtDate(b.dueDate)}</td>
                  <td style={tdNum}>{daysChip(b.daysPastDue) || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{usd2(b.unpaid)}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
                      <button onClick={() => printBill(b, dialog.alert, { unpaidKnown: bills.data!.unpaidColumn })} style={btnSm}>🖨 Print</button>
                      {nsLink(b.nsUrl)}
                    </span>
                  </td>
                </tr>
              ))}
              {list.length === 0 && <tr><td style={tdMuted} colSpan={7}>No open vendor bills 🎉</td></tr>}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ ...td, fontWeight: 800, borderBottom: 'none' }} colSpan={5}>Open bills total</td>
                <td style={{ ...tdNum, fontWeight: 800, borderBottom: 'none' }}>{usd2(sum)}</td>
                <td style={{ ...td, borderBottom: 'none' }} />
              </tr>
            </tfoot>
          </table>
        </div>
        {tile !== null && (
          <div style={{ ...infoText, marginTop: '10px' }}>
            A/P account balance (tile): <strong style={{ color: 'var(--text-primary)' }}>{usd2(tile)}</strong>
            {Math.abs(sum - tile) >= 1 && <> · difference of {usd2(Math.abs(sum - tile))} — usually vendor credits or payments in transit that the integration can&apos;t see.</>}
          </div>
        )}
      </>
    );
  };

  const renderNet = () => {
    const parts: { label: string; amount: number | null; sign: '+' | '−'; view: DrillView }[] = [
      { label: 'Cash on hand', amount: summary.cash, sign: '+', view: 'cash' },
      { label: 'Owed to us · A/R', amount: summary.ar.total, sign: '+', view: 'ar' },
      { label: 'Vendor bills', amount: summary.ap.vendorBills, sign: '−', view: 'bills' },
      { label: 'Credit card balances', amount: summary.ap.cardOwed, sign: '−', view: 'cards' },
    ];
    return (
      <>
        <div style={{ ...infoText, marginBottom: '12px' }}>
          Net position = Cash + A/R − A/P. Tap any line to see the transactions or accounts behind it.
        </div>
        {parts.map(p => (
          <div key={p.label} role="button" tabIndex={0} className="fin-row"
            onClick={() => setView(p.view)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(p.view); } }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '12px 10px', borderBottom: '1px solid var(--border)', cursor: 'pointer', borderRadius: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>{p.sign} {p.label}</span>
            <span style={{ fontSize: '13.5px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {p.amount === null ? '—' : usd2(p.amount)} <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>›</span>
            </span>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '14px 10px 4px' }}>
          <span style={{ fontSize: '13px', fontWeight: 800 }}>Net position</span>
          <span style={{ fontSize: '15px', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: summary.net === null ? 'var(--text-muted)' : summary.net >= 0 ? 'var(--success)' : 'var(--error)' }}>
            {summary.net === null ? '—' : `${summary.net >= 0 ? '+' : '−'}${usd2(Math.abs(summary.net))}`}
          </span>
        </div>
      </>
    );
  };

  // ── Footer reconciliation line (A/R only — others inline) ───────────────
  const arFooter = view === 'ar' && ar.data ? (
    unfiltered
      ? <>Sum of {filtered.length} open invoices: <strong style={{ color: 'var(--text-primary)' }}>{usd2(sumShown)}</strong>{Math.abs(sumShown - summary.ar.total) < 1 ? ' · matches the A/R tile' : ` · tile shows ${usd2(summary.ar.total)} (refreshed at a different moment)`}</>
      : <>Showing {grouped && !customer ? `${customerRows.length} customers` : `${filtered.length} of ${invoices.length} invoices`} · <strong style={{ color: 'var(--text-primary)' }}>{usd2(sumShown)}</strong></>
  ) : null;

  return (
    // Close only when the click STARTED on the backdrop — a drag-select that
    // ends past the panel edge must not nuke the modal (and its filters).
    // zIndex 1200: above AiChat's 1000 mascot/panel, below DialogProvider's
    // 4000 so error alerts still stack on top.
    <div
      onMouseDown={e => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={e => { if (e.target === e.currentTarget && downOnBackdrop.current) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '4vh 12px calc(24px + env(safe-area-inset-bottom))' }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={VIEW_TITLES[view]} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '14px', width: 'min(980px, 100%)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '13px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {view !== target.view && (
            <button onClick={() => setView(target.view)} aria-label="Back" style={{ ...btnSm, padding: '4px 9px' }}>‹</button>
          )}
          <div style={{ fontSize: '13px', fontWeight: 800, letterSpacing: '.3px', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {VIEW_TITLES[view]}
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer', padding: '2px 6px', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '14px 16px', overflowY: 'auto', flex: 1 }}>
          {view === 'cash' && renderAccounts('cash')}
          {view === 'cards' && renderAccounts('cards')}
          {view === 'ar' && renderAr()}
          {view === 'bills' && renderBills()}
          {view === 'net' && renderNet()}
        </div>
        {arFooter && (
          <div style={{ ...infoText, padding: '10px 16px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>{arFooter}</div>
        )}
      </div>
      <style>{`.fin-row:hover { background: var(--card-hover, var(--subtle-bg)); }`}</style>
    </div>
  );
}
