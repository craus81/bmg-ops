'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';

/**
 * Books → Invoices vs NetSuite (migrations 364, 367, 370, 374, 376, 382, 383
 * and 384, docs/books.md "Invoices", "Payments", "Customer deposits" and
 * "Vendor bills").
 *
 * FleetSuite works out its own entry for every NetSuite invoice with the
 * invoice rule, and for every credit memo with the same rule the other way
 * round, and checks it line by line against what NetSuite posted for the
 * same document, and shows what its own books hold for each: the posting
 * job (src/lib/books/invoice-posting.ts) posts BMG's every two hours, or on
 * "Post now". Customer payments are checked the same way with the payment
 * rule, and post in the same run. Customer deposits and their applications
 * are copied from NetSuite every two hours, or on "Copy now", checked with
 * the deposit rule, and post in the same run too. Vendor bills and bill
 * credits are copied the same way and checked with the bill rule; they don't
 * post yet. Super admins only while the books are built, linked from the
 * other books pages.
 */

type Status = 'matches' | 'differs' | 'unworkable' | 'waiting';

type Kind = 'invoice' | 'credit_memo' | 'payment' | 'deposit' | 'bill';
const KINDS: readonly Kind[] = ['invoice', 'credit_memo', 'payment', 'deposit', 'bill'];

/** What each kind of document is called. */
const WORDS: Record<Kind, { one: string; many: string; title: string; head: string }> = {
  invoice: { one: 'invoice', many: 'invoices', title: 'Invoices', head: 'Invoice' },
  credit_memo: { one: 'credit memo', many: 'credit memos', title: 'Credit memos', head: 'Credit memo' },
  payment: { one: 'payment', many: 'payments', title: 'Payments', head: 'Payment' },
  // The Deposits switch lists deposit applications too, so its counts count both.
  deposit: { one: 'deposit or application', many: 'deposits and applications', title: 'Deposits', head: 'Deposit' },
  // And the Bills switch lists bill credits too.
  bill: { one: 'bill or bill credit', many: 'bills and bill credits', title: 'Bills', head: 'Bill' },
};

/** The kinds of document copied from NetSuite by the books themselves, each with its Copy now. */
const COPIED: Partial<Record<Kind, string>> = { deposit: '/api/admin/books/deposits', bill: '/api/admin/books/bills' };

interface Summary {
  /** Invoices, credit memos or payments, whichever kind the month was checked for. */
  invoices: number;
  matches: number;
  differs: number;
  unworkable: number;
  waiting: number;
  withCost: number;
  /** When the company's documents post. */
  posted?: number;
  pending?: number;
}

/** What FleetSuite's books hold for an invoice, and what the next posting run does about it. */
interface Books {
  entryNo: number | null;
  next: 'post' | 'replace' | 'reverse' | null;
  earlier: Array<{ entryNo: number; reversedBy: number | null }>;
}

/** How the last posting run went (src/lib/books/invoice-posting.ts); counts only. */
interface PostingRun {
  months?: string[];
  posted?: number;
  replaced?: number;
  reversed?: number;
  unchanged?: number;
  left?: number;
  failedCount?: number;
  failed?: Array<{ number: string; reason: string }>;
  partial?: boolean;
  notes?: string[];
  error?: string;
}

/** How the last copy of NetSuite's deposits or bills went (src/lib/books/netsuite-deposits.ts, netsuite-bills.ts); counts and words only. */
interface CopyRun {
  read: number;
  partial: boolean;
  notes?: string[];
  error?: string;
}

interface Amount {
  account: string;
  cents: number;
}

/** What NetSuite says about a line; amounts in cents, a charge positive. */
interface Says {
  net: number | null;
  own: number | null;
  quantity: string | null;
  rate: string | null;
  topDiscount: boolean;
  cogs: boolean;
}

interface Row {
  lineId: string;
  label: string;
  division: 'upfit' | 'graphics' | null;
  fleetsuite: Amount | null;
  netsuite: Amount | null;
  cost: boolean;
  same: boolean;
  /** NetSuite's own number for the line, when the copy of its GL has it under another one. */
  netsuiteLine?: string;
  says?: Says;
}

interface Invoice {
  netsuiteId: string;
  number: string;
  date: string;
  /** NetSuite booked it into another month than its date's: that month, and the date FleetSuite's entry carries. */
  booked?: { month: string; date: string };
  customer: string | null;
  total: number;
  voided: boolean;
  status: Status;
  waiting?: 'lines' | 'gl';
  amounts?: 'own' | 'unfit';
  reasons: string[];
  rows: Row[];
  books?: Books;
  /** A payment's or a deposit application's: what it was applied to. A deposit's: what its applications applied it to, each on its date. */
  applied?: Array<{ number: string; cents: number | null; date?: string }>;
  /** A deposit's or deposit application's, a bill's or bill credit's. */
  type?: 'CustDep' | 'DepAppl' | 'VendBill' | 'VendCred';
  /** NetSuite's status for a deposit, application, bill or bill credit, in its words. */
  netsuiteStatus?: string;
  /** An application's: the deposit it applies. */
  deposit?: string;
  /** A deposit's: the sales order NetSuite links it to. */
  order?: string;
  /** A bill's: the purchase orders and receipts it came from; a bill credit's vendor return. */
  from?: string[];
  /** A bill's or bill credit's lines, as copied from NetSuite; amounts in cents, as the document has them. */
  lines?: Array<{ label: string; quantity: string | null; memo: string | null; cents: number | null }>;
}

interface Reason {
  key: string;
  text: string;
  invoices: number;
  examples: string[];
}

interface Payload {
  rule: string;
  kind: Kind;
  companies: Array<{ code: string; name: string }>;
  company: string;
  month: string;
  months: string[];
  listsCopiedAt: string | null;
  /** Whether this company's invoices, credit memos, payments and deposits post to FleetSuite's books yet. */
  posts: boolean;
  lastRun: { at: string; result: PostingRun } | null;
  /** Deposits and bills only: how the last copy of them from NetSuite went; null before the first. */
  copy?: { at: string; result: CopyRun } | null;
  summary: Summary;
  reasons: Reason[];
  notes: string[];
  invoices: Invoice[];
  accounts: Record<string, string>;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents: number) => money.format(cents / 100);
const rateMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 5 });

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

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** A posting run's counts in words, the ones that aren't zero. The run posts invoices, credit memos, payments and deposits alike. */
function runCounts(run: PostingRun): string {
  const parts = [
    run.posted ? count(run.posted, 'new entry', 'new entries') : '',
    run.replaced ? `${count(run.replaced, 'entry', 'entries')} replaced` : '',
    run.reversed ? `${count(run.reversed, 'entry', 'entries')} reversed` : '',
    run.unchanged ? `${count(run.unchanged, 'entry', 'entries')} unchanged` : '',
    run.left ? `${count(run.left, 'document', 'documents')} left as they were` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing to post';
}

/** The Books chip for an invoice, credit memo, payment, deposit or application. */
function booksChip(books: Books): { label: string; color: string } {
  if (books.entryNo !== null) {
    if (books.next === 'replace') return { label: `Entry ${books.entryNo} · to replace`, color: AMBER };
    if (books.next === 'reverse') return { label: `Entry ${books.entryNo} · to reverse`, color: AMBER };
    return { label: `Entry ${books.entryNo}`, color: GREEN };
  }
  return books.next === 'post' ? { label: 'To post', color: GREY } : { label: 'Not posted', color: GREY };
}

/** What the books hold for an invoice, credit memo, payment, deposit or application, in a sentence or two. */
function booksText(books: Books): string {
  const now = books.entryNo !== null ? `In FleetSuite's books as entry ${books.entryNo}.` : "Not in FleetSuite's books.";
  const next = books.next === 'post' ? ' The next posting run posts it.'
    : books.next === 'replace' ? ' It no longer fits what the rule works out, so the next posting run reverses it and posts the new entry.'
      : books.next === 'reverse' ? ' NetSuite voided it or it comes to nothing now, so the next posting run reverses it.'
        : '';
  const earlier = books.earlier.length
    ? ` Earlier: ${books.earlier.map((e) => (e.reversedBy ? `entry ${e.entryNo}, reversed by ${e.reversedBy}` : `entry ${e.entryNo}`)).join('; ')}.`
    : '';
  return `${now}${next}${earlier}`;
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

/** A line as NetSuite has it: its own amount, its net amount, quantity × rate, and what it's flagged as. */
function saysText(says: Says): string {
  const parts: string[] = [];
  if (says.own !== null) parts.push(`amount ${fmt(says.own)}`);
  if (says.net !== null) parts.push(`net ${fmt(says.net)}`);
  const quantity = Number(says.quantity);
  if (says.quantity !== null && says.rate !== null && Number.isFinite(quantity) && quantity !== 0) {
    const rate = Number(says.rate);
    parts.push(`${Math.abs(quantity).toLocaleString('en-US', { maximumFractionDigits: 4 })} × ${Number.isFinite(rate) ? rateMoney.format(rate) : says.rate}`);
  }
  if (says.topDiscount) parts.push('set at the top');
  if (says.cogs) parts.push('cost of goods');
  return `NetSuite: ${parts.join(', ')}`;
}

/** One document a payment or deposit was applied to, with its amount and date when known. */
const appliedText = (a: NonNullable<Invoice['applied']>[number]) =>
  `${a.number}${a.cents !== null ? ` (${fmt(a.cents)})` : ''}${a.date ? ` on ${dateText(a.date)}` : ''}`;

/** What a deposit or deposit application is linked to, in a sentence. */
function depositLinksText(invoice: Invoice): string | null {
  if (invoice.type !== 'CustDep' && invoice.type !== 'DepAppl') return null;
  const applied = (invoice.applied ?? []).map(appliedText).join(', ');
  if (invoice.type === 'DepAppl') {
    if (!invoice.deposit && !applied) return null;
    return `Applies ${invoice.deposit ?? 'a deposit'}${applied ? ` to ${applied}` : ''}.`;
  }
  const parts = [invoice.order ? `For ${invoice.order}.` : '', applied ? `Applied to ${applied}.` : ''].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

const amountsText = (amounts: NonNullable<Invoice['amounts']>, one: string) => (amounts === 'own'
  ? `NetSuite spread a discount, markup or payment over this ${one}'s lines, so FleetSuite takes each line at its own amount, as NetSuite posts it.`
  : `NetSuite's own amounts for this ${one}'s lines don't add up to it, so FleetSuite took each line at its net amount.`);

function InvoiceDetail({ invoice, accounts, one }: { invoice: Invoice; accounts: Record<string, string>; one: string }) {
  return (
    <div style={{ padding: '8px 10px 12px', background: 'var(--bg)' }}>
      {invoice.booked && (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
          Dated {dateText(invoice.date)}, but NetSuite booked it into {monthName(invoice.booked.month)}, so FleetSuite&apos;s entry is dated {dateText(invoice.booked.date)}.
        </div>
      )}
      {invoice.books && (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>{booksText(invoice.books)}</div>
      )}
      {invoice.reasons.map((r) => (
        <div key={r} style={{ fontSize: '12px', color: invoice.status === 'unworkable' ? AMBER : RED, marginBottom: '4px' }}>{r}</div>
      ))}
      {invoice.amounts && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>{amountsText(invoice.amounts, one)}</div>
      )}
      {invoice.netsuiteStatus && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>NetSuite&apos;s status: {invoice.netsuiteStatus}.</div>
      )}
      {!!invoice.from?.length && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>
          Came from {invoice.from.join(', ')}.
        </div>
      )}
      {!!invoice.lines?.length && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>
          Its lines in NetSuite:
          {invoice.lines.map((l, i) => (
            <div key={i} style={{ paddingLeft: '10px' }}>
              {l.label}
              {l.quantity && Number(l.quantity) !== 0 && ` × ${Math.abs(Number(l.quantity)).toLocaleString('en-US', { maximumFractionDigits: 4 })}`}
              {`, ${l.cents === null ? "an amount FleetSuite can't read" : fmt(l.cents)}`}
              {l.memo && ` · ${l.memo}`}
            </div>
          ))}
        </div>
      )}
      {invoice.type ? (
        depositLinksText(invoice) && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>{depositLinksText(invoice)}</div>
        )
      ) : !!invoice.applied?.length && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>
          Applied to {invoice.applied.map(appliedText).join(', ')}.
        </div>
      )}
      {invoice.rows.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {invoice.waiting === 'lines' ? `This ${one}'s lines haven't been copied from NetSuite yet.`
            : invoice.waiting === 'gl' ? `NetSuite's GL copy has nothing for this ${one} yet.` : 'Nothing posts on either side.'}
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
                    {r.says && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{saysText(r.says)}</div>}
                    {r.netsuiteLine && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        NetSuite&apos;s GL has it as line {r.netsuiteLine}, so it&apos;s matched by account and amount.
                      </div>
                    )}
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
  const [kind, setKind] = useState<Kind>('invoice');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  // Results of "Check every month", for the company and kind of document they were checked for.
  const [monthly, setMonthly] = useState<{ company: string; kind: Kind; months: Record<string, Summary> }>({ company: '', kind: 'invoice', months: {} });
  const [checking, setChecking] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState('');
  // A document a link asked for (Differences vs NetSuite), scrolled to once it's open.
  const scrollTo = useRef<string | null>(null);

  const load = useCallback(async (nextCompany: string, nextMonth: string, nextKind: Kind) => {
    try {
      const params = new URLSearchParams({ kind: nextKind });
      if (nextCompany) params.set('company', nextCompany);
      if (nextMonth) params.set('month', nextMonth.slice(0, 7));
      const res = await apiFetch(`/api/admin/books/invoices?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setCompany(json.company);
      setMonth(json.month);
      setKind(json.kind);
      setOpen(null);
      setError('');
      setMonthly((m) => (m.company === json.company && m.kind === json.kind ? { ...m, months: { ...m.months, [json.month]: json.summary } } : m));
    } catch (e: any) {
      setError(e?.message || `Could not check the ${WORDS[nextKind].many}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // A link may name the company, kind, month and document to open (?company=BMG&kind=payment&month=2026-09&doc=123).
    const q = new URLSearchParams(window.location.search);
    const askedKind = q.get('kind');
    const doc = q.get('doc');
    load(q.get('company') ?? '', q.get('month') ?? '', KINDS.find((k) => k === askedKind) ?? 'invoice')
      .then(() => {
        if (!doc) return;
        scrollTo.current = doc;
        setOnlyProblems(false);
        setOpen(doc);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  useEffect(() => {
    if (!open || scrollTo.current !== open) return;
    scrollTo.current = null;
    document.getElementById(`doc-${open}`)?.scrollIntoView({ block: 'center' });
  }, [open, data]);

  const pick = (nextCompany: string, nextMonth: string, nextKind: Kind = kind) => {
    setLoading(true);
    load(nextCompany, nextMonth, nextKind);
  };

  const checkEveryMonth = async () => {
    if (!data) return;
    const results: Record<string, Summary> = {};
    setMonthly({ company, kind, months: {} });
    setError('');
    try {
      for (const m of data.months) {
        setChecking(m);
        const res = await apiFetch(`/api/admin/books/invoices?${new URLSearchParams({ company, month: m.slice(0, 7), kind, summary: '1' })}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `Checking ${monthName(m)} failed (${res.status})`);
        results[m] = json.summary;
        setMonthly({ company, kind, months: { ...results } });
      }
    } catch (e: any) {
      setError(e?.message || 'Checking every month failed');
    }
    setChecking(null);
  };

  // How the run went is recorded either way and shows in the banners after
  // the reload; postError is only for a request that never got that far.
  const postNow = async () => {
    setPosting(true);
    setPostError('');
    try {
      const res = await apiFetch('/api/admin/books/invoices', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Posting failed (${res.status})`);
      if (json.skipped) setPostError(`${json.skipped} Try again in a few minutes.`);
    } catch (e: any) {
      setPostError(e?.message || 'Posting failed');
    }
    await load(company, month, kind);
    setPosting(false);
  };

  // Copies NetSuite's deposits, or bills, now. As with posting, how the copy
  // went is recorded either way and shows in the banners after the reload.
  const copyNow = async () => {
    const path = COPIED[kind];
    if (!path) return;
    setCopying(true);
    setCopyError('');
    try {
      const res = await apiFetch(path, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Copy failed (${res.status})`);
    } catch (e: any) {
      setCopyError(e?.message || 'Copy failed');
    }
    await load(company, month, kind);
    setCopying(false);
  };

  const s = data?.summary;
  const words = WORDS[kind];
  const years = [...new Set((data?.months ?? []).map((m) => m.slice(0, 4)))];
  const checkedMonths = monthly.company === company && monthly.kind === kind ? monthly.months : {};
  const checkedCount = Object.keys(checkedMonths).length;
  const matchingMonths = Object.values(checkedMonths).filter(allMatch).length;
  const checkedInvoices = Object.values(checkedMonths).reduce((n, r) => n + r.invoices, 0);
  const checkedPosted = Object.values(checkedMonths).reduce((n, r) => n + (r.posted ?? 0), 0);
  // A matching invoice needs a look when the next run changes its entry, or when it has none though it should
  // (not voided, not $0): NetSuite couldn't say enough about its lines, say, or its copy is mid-refresh.
  const needsLook = (inv: Invoice) => inv.status !== 'matches' || (!!inv.books
    && (inv.books.next !== null || (inv.books.entryNo === null && !inv.voided && inv.total !== 0)));
  const shown = (data?.invoices ?? []).filter((inv) => !onlyProblems || needsLook(inv));
  const run = data?.lastRun?.result;
  const copied = COPIED[kind] ? data?.copy : undefined;
  const busy = loading || !!checking || posting || copying;

  return (
    <div>
      <div style={{ marginBottom: '14px', display: 'flex', gap: '12px', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px' }}>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>{words.title} vs NetSuite</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {kind === 'bill' ? (
              <>
                NetSuite&apos;s vendor bills, what BMG owes its vendors, and the bill credits that take some of it back are copied
                from NetSuite every two hours with their lines. For each bill FleetSuite works out its own entry: payables are
                credited with the total, an expense line is debited to its own account, a non-stock item to its expense account,
                and a stock item to the account NetSuite holds received stock in until it&apos;s billed when the bill came from a
                purchase order, or else to the item&apos;s asset account. A bill credit works the other way round. Each entry is
                checked account by account against what NetSuite posted for the same document. Bills aren&apos;t posted to
                FleetSuite&apos;s books yet: they will be once they&apos;ve been checked.
              </>
            ) : kind === 'deposit' ? (
              <>
                NetSuite&apos;s customer deposits, money a customer pays ahead of an invoice, and the deposit applications that
                apply them to invoices are copied from NetSuite every two hours. For each deposit FleetSuite works out its own
                entry: the money goes to the account the deposit went to, Undeposited Funds or a bank account, and the customer
                deposits account is credited with it. An application debits the customer deposits account and credits
                receivables. Where a deposit&apos;s money went comes from NetSuite&apos;s posting of it, and the customer deposits
                account is the one NetSuite&apos;s deposits use. Each entry is checked account by account against what NetSuite
                posted for the same document. Every two hours each BMG deposit and application FleetSuite can work out is posted
                to its own books, once, in the same run as invoices and payments. When NetSuite changes one its entry is reversed
                and the new one posted, and one NetSuite voids or no longer has is reversed. Until the books go live they can be
                emptied and posted again.
              </>
            ) : kind === 'payment' ? (
              <>
                For every NetSuite customer payment FleetSuite works out its own entry: the money goes to the account the payment
                was deposited to, Undeposited Funds or a bank account, a discount the customer took goes to the account NetSuite
                booked it to, and receivables are credited with the total plus the discount. Where the money went and the discount
                come from NetSuite&apos;s posting of the payment, since the copy of the payment doesn&apos;t keep them. Each entry
                is checked account by account against what NetSuite posted for the same payment. Every two hours each BMG
                payment FleetSuite can work out is posted to its own books, once, in the same run as invoices. When NetSuite
                changes one its entry is reversed and the new one posted, and a voided or deleted one is reversed. Until the
                books go live they can be emptied and posted again.
              </>
            ) : (
              <>
                For every NetSuite invoice FleetSuite works out its own entry: receivables take the total, each line goes to its
                item&apos;s income account, and sales tax to the account its tax code posts to. A credit memo works the other way
                round: its lines and sales tax are debited and receivables credited. Each entry is checked line by line against
                what NetSuite posted for the same invoice or credit memo. Every two hours each BMG invoice and credit memo
                FleetSuite can work out is posted to its own books, once. When NetSuite changes one its entry is reversed and the
                new one posted, and a voided or deleted one is reversed. Until the books go live they can be emptied and posted
                again.
              </>
            )}
            {' '}Visible only to super admins. <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
            {' · '}
            <Link href="/admin/books/trial-balance" style={{ color: 'var(--text-secondary)' }}>Trial balance vs NetSuite</Link>
            {' · '}
            <Link href="/admin/books/lists" style={{ color: 'var(--text-secondary)' }}>NetSuite lists</Link>
            {' · '}
            <Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={checkEveryMonth}
            disabled={busy || !data}
            style={{
              padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
              color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: checking ? 'wait' : 'pointer',
            }}
          >
            {checking ? `Checking ${monthName(checking)}…` : 'Check every month'}
          </button>
          {COPIED[kind] && (
            <button
              onClick={copyNow}
              disabled={busy}
              style={{
                padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
                color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: copying ? 'wait' : 'pointer',
              }}
            >
              {copying ? 'Copying… up to 4 minutes' : 'Copy now'}
            </button>
          )}
          {data?.posts && (
            <button
              onClick={postNow}
              disabled={busy}
              style={{
                padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
                color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: posting ? 'wait' : 'pointer',
              }}
            >
              {posting ? 'Posting… up to 4 minutes' : 'Post now'}
            </button>
          )}
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}
      {postError && <div style={banner(RED)}>{postError}</div>}
      {copyError && <div style={banner(RED)}>{copyError}</div>}
      {data && COPIED[kind] && (
        <>
          {!copied && (
            <div style={banner(GREY)}>
              Nothing has been copied from NetSuite yet. The copy runs every two hours, or press Copy now.
            </div>
          )}
          {copied?.result.error && <div style={banner(RED)}>The last copy failed {ago(copied.at)}: {copied.result.error}</div>}
          {copied && !copied.result.error && (
            <div style={banner(copied.result.partial ? AMBER : GREEN)}>
              {copied.result.partial
                ? `Still copying: the last run, ${ago(copied.at)}, read ${count(copied.result.read, words.one, words.many)} and stopped for time. It carries on at the next run, or press Copy now.`
                : `Copied from NetSuite ${ago(copied.at)}.`}
            </div>
          )}
          {(copied?.result.notes ?? []).map((n) => <div key={n} style={banner(AMBER)}>{n}</div>)}
        </>
      )}
      {data?.posts && (
        <>
          {!data.lastRun && (
            <div style={banner(GREY)}>
              Nothing has been posted to FleetSuite&apos;s books yet. Posting runs every two hours, or press Post now. The first
              run posts every invoice, credit memo, payment and deposit since January 2025 and may take more than one run.
            </div>
          )}
          {run?.error && <div style={banner(RED)}>The last posting run failed {ago(data.lastRun!.at)}: {run.error}</div>}
          {data.lastRun && !run?.error && (
            <div style={banner(run?.partial ? AMBER : GREEN)}>
              {run?.partial
                ? `Still posting: the last run, ${ago(data.lastRun.at)}, went through ${count(run.months?.length ?? 0, 'month', 'months')} and stopped for time (${runCounts(run)}). It carries on at the next run, or press Post now.`
                : `Posted ${ago(data.lastRun.at)}: ${runCounts(run ?? {})}.`}
            </div>
          )}
          {!!run?.failedCount && (
            <div style={banner(RED)}>
              {count(run.failedCount, 'document', 'documents')} couldn&apos;t be posted or changed
              {run.failed?.length ? `: ${run.failed.map((f) => `${f.number} (${f.reason})`).join('; ')}` : ''}
              {run.failed && run.failedCount > run.failed.length ? '; …' : ''}
            </div>
          )}
          {(run?.notes ?? []).map((n) => <div key={n} style={banner(AMBER)}>{n}</div>)}
        </>
      )}

      {data && s && (
        <>
          {!checking && checkedCount === data.months.length && (
            <div style={banner(matchingMonths === checkedCount ? GREEN : AMBER)}>
              Every {words.one} matches NetSuite in {matchingMonths} of {checkedCount} months.
              {data.posts && ` FleetSuite's books hold ${checkedPosted.toLocaleString('en-US')} of these ${count(checkedInvoices, words.one, words.many)}.`}
            </div>
          )}
          {data.notes.map((n) => <div key={n} style={banner(AMBER)}>{n}</div>)}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {data.companies.map((c) => (
              <button key={c.code} onClick={() => pick(c.code, month)} disabled={busy} style={button(c.code === company)}>
                {c.name}
              </button>
            ))}
            <span style={{ borderLeft: '1px solid var(--border)', margin: '0 4px' }} />
            {KINDS.map((k) => (
              <button key={k} onClick={() => pick(company, month, k)} disabled={busy} style={button(k === kind)}>
                {WORDS[k].title}
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
                      disabled={busy}
                      title={!r ? 'Not checked yet' : allMatch(r) ? `Every ${words.one} matches NetSuite` : `${count(r.invoices - r.matches, `${words.one} doesn't`, `${words.many} don't`)} match`}
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
            <span style={chip(GREY)}>{count(s.invoices, words.one, words.many)}</span>
            {s.matches > 0 && <span style={chip(GREEN)}>{s.matches.toLocaleString('en-US')} match</span>}
            {s.differs > 0 && <span style={chip(RED)}>{s.differs.toLocaleString('en-US')} differ</span>}
            {s.unworkable > 0 && <span style={chip(AMBER)}>{s.unworkable.toLocaleString('en-US')} can&apos;t be worked out</span>}
            {s.waiting > 0 && <span style={chip(GREY)}>{s.waiting.toLocaleString('en-US')} waiting on a copy</span>}
            {s.posted !== undefined && <span style={chip(GREEN)}>{s.posted.toLocaleString('en-US')} in FleetSuite&apos;s books</span>}
            {!!s.pending && <span style={chip(AMBER)}>{s.pending.toLocaleString('en-US')} for the next posting run</span>}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            {kind === 'deposit'
              ? 'Customer deposits and deposit applications dated this month that NetSuite posted to this company'
              : kind === 'bill'
                ? 'Vendor bills and bill credits NetSuite booked into this month for this company'
              : kind === 'payment'
                ? `${words.title} dated this month that NetSuite posted to this company`
                : `${words.title} NetSuite booked into this month for this company`}, checked with rule {data.rule}.
            {data.listsCopiedAt && ` Items and ${kind === 'bill' ? 'vendors' : 'tax codes'} as copied from NetSuite ${ago(data.listsCopiedAt)}.`}
            {!data.posts && ` This company's ${words.many} aren't posted to FleetSuite's books yet; they will be once they've been checked.`}
          </div>

          {data.reasons.length > 0 && (
            <div style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '13px', fontWeight: 800, marginBottom: '6px' }}>Why they don&apos;t match</div>
              <div style={{ border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--card)' }}>
                {data.reasons.map((r, i) => (
                  <div key={r.key} style={{ padding: '8px 12px', borderTop: i ? '1px solid var(--border)' : undefined, fontSize: '12px' }}>
                    <span style={{ fontWeight: 800 }}>{count(r.invoices, words.one, words.many)}</span>
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
              {data.posts ? `Only ${words.many} that don't match or aren't posted as they should be` : `Only ${words.many} that don't match`}
            </label>
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)' }}>
                  <th style={{ ...cell, textAlign: 'left' }}>{words.head}</th>
                  <th style={{ ...cell, textAlign: 'left' }}>Date</th>
                  <th style={{ ...cell, textAlign: 'left' }}>{kind === 'bill' ? 'Vendor' : 'Customer'}</th>
                  <th style={cell}>Total</th>
                  <th style={{ ...cell, textAlign: 'left' }}>Check</th>
                  {data.posts && <th style={{ ...cell, textAlign: 'left' }}>Books</th>}
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr><td colSpan={data.posts ? 6 : 5} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                    {s.invoices === 0 ? `No ${words.many} for this company this month.`
                      : data.posts ? `Every ${words.one} matches NetSuite and is in FleetSuite's books.` : `Every ${words.one} matches NetSuite.`}
                  </td></tr>
                )}
                {shown.map((inv) => (
                  <Fragment key={inv.netsuiteId}>
                    <tr
                      id={`doc-${inv.netsuiteId}`}
                      onClick={() => setOpen(open === inv.netsuiteId ? null : inv.netsuiteId)}
                      style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                    >
                      <td style={{ ...textCell, fontWeight: 700 }}>
                        {open === inv.netsuiteId ? '▾' : '▸'} {inv.number}
                        {inv.type === 'DepAppl' && <span style={{ ...chip(GREY), marginLeft: '6px' }}>Application</span>}
                        {inv.type === 'VendCred' && <span style={{ ...chip(GREY), marginLeft: '6px' }}>Credit</span>}
                      </td>
                      <td style={{ ...cell, textAlign: 'left' }}>
                        {dateText(inv.date)}
                        {inv.booked && <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>booked {monthName(inv.booked.month)}</div>}
                      </td>
                      <td style={textCell}>{inv.customer ?? ''}</td>
                      <td style={cell}>{fmt(inv.total)}</td>
                      <td style={{ ...cell, textAlign: 'left' }}>
                        <span style={chip(STATUS[inv.status].color)}>{waitingLabel(inv)}</span>
                        {inv.voided && <span style={{ ...chip(GREY), marginLeft: '6px' }}>Voided</span>}
                      </td>
                      {data.posts && (
                        <td style={{ ...cell, textAlign: 'left' }}>
                          {inv.books && <span style={chip(booksChip(inv.books).color)}>{booksChip(inv.books).label}</span>}
                        </td>
                      )}
                    </tr>
                    {open === inv.netsuiteId && (
                      <tr>
                        <td colSpan={data.posts ? 6 : 5} style={{ padding: 0 }}>
                          <InvoiceDetail
                            invoice={inv}
                            accounts={data.accounts}
                            one={inv.type === 'DepAppl' ? 'deposit application' : inv.type === 'CustDep' ? 'deposit'
                              : inv.type === 'VendCred' ? 'bill credit' : inv.type === 'VendBill' ? 'bill' : words.one}
                          />
                        </td>
                      </tr>
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
