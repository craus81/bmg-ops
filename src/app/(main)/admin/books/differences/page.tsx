'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import type { DiffAccountRow, DiffDocument, DiffKindRow, DiffMonth, MonthStatus } from '@/lib/books/differences';

/**
 * Books → Differences vs NetSuite (migration 377, docs/books.md).
 *
 * FleetSuite's own journal next to the copy of NetSuite's general ledger, one
 * company and one month at a time: what NetSuite moved with kinds of
 * documents FleetSuite doesn't post yet, and, for the kinds it does, each
 * document whose entry differs from what NetSuite posted, with why. Super
 * admins only while the books are built, linked from the other books pages.
 */

interface Company {
  code: string;
  name: string;
  netsuite_subsidiary_id: string | null;
}

interface Payload {
  companies: Company[];
  company: string;
  month: string;
  months: DiffMonth[];
  status: MonthStatus;
  differing: number;
  covered: number | null;
  posts: boolean;
  accounts: DiffAccountRow[];
  kinds: DiffKindRow[];
  documents: DiffDocument[];
  documentsTotal: number;
  copyHolds: boolean | null;
  lastPosting: { at: string; error: string | null; partial: boolean } | null;
  lastCopy: { at: string; error: string | null } | null;
}

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#fbbf24';
const GREY = '#94a3b8';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents: number) => money.format(cents / 100);
const amount = (cents: number) => (cents ? fmt(cents) : '—');
const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const percent = (share: number) => (share > 0 && share < 0.1 ? `${(share * 100).toFixed(1)}%` : `${Math.round(share * 100)}%`);

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const shortMonth = (month: string) => MONTH_NAMES[Number(month.slice(5, 7)) - 1].slice(0, 3);
const dateText = (iso: string) => `${shortMonth(iso)} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

const DOC_NAMES: Record<string, string> = {
  invoice: 'Invoice', credit_memo: 'Credit memo', payment: 'Payment', customer_deposit: 'Deposit', deposit_application: 'Deposit application',
  vendor_bill: 'Bill', vendor_credit: 'Bill credit', bill_payment: 'Bill payment',
  check: 'Check', card_charge: 'Card charge', card_refund: 'Card refund', journal_entry: 'Journal entry',
};

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
const textCell: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };
const sectionTitle: React.CSSProperties = { fontSize: '14px', fontWeight: 800, margin: '18px 0 6px' };
const note: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' };
const frame: React.CSSProperties = { overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' };

function monthLook(m: DiffMonth): { color: string; mark: string; title: string } {
  if (m.status === 'matches') {
    return { color: GREEN, mark: '✓', title: `What FleetSuite posts matches NetSuite${m.covered !== null ? ` (${percent(m.covered)} of NetSuite's activity)` : ''}` };
  }
  if (m.status === 'differs') return { color: RED, mark: '✗', title: `${count(m.differing, 'account differs', 'accounts differ')} on what FleetSuite posts` };
  return { color: GREY, mark: '', title: 'FleetSuite posts nothing of this month yet' };
}

function kindStatus(k: DiffKindRow): { label: string; color: string; title: string } {
  if (k.state === 'posted') {
    if (k.differing === null) return { label: 'Posted by FleetSuite', color: GREY, title: 'FleetSuite posts these' };
    return k.differing
      ? { label: `${k.differing.toLocaleString('en-US')} differ`, color: RED, title: 'Documents FleetSuite posted differently from NetSuite; they are listed below' }
      : { label: 'Matches', color: GREEN, title: 'Every one comes to what NetSuite posted for it, account by account' };
  }
  if (k.state === 'cost') {
    return {
      label: 'Waits for fulfillments', color: GREY,
      title: "The cost of the stock NetSuite books on an invoice that wasn't fulfilled first. FleetSuite will post it with fulfillments, which it doesn't post yet.",
    };
  }
  if (k.state === 'not_posted') return { label: 'Not posted yet', color: GREY, title: 'FleetSuite has no rule for this kind of document yet' };
  return { label: 'FleetSuite only', color: AMBER, title: 'Entries FleetSuite made itself, which NetSuite has no document for' };
}

/** What one side's documents of a kind moved, and how many there were. */
function Side({ total }: { total: DiffKindRow['netsuite'] }) {
  if (!total) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  return (
    <>
      {fmt(total.moved)}
      <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{count(total.documents, 'document', 'documents')}</div>
    </>
  );
}

export default function BooksDifferencesPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [company, setCompany] = useState('');
  const [month, setMonth] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [onlyDifferences, setOnlyDifferences] = useState(false);

  const load = useCallback(async (nextCompany: string, nextMonth: string) => {
    try {
      const params = new URLSearchParams();
      if (nextCompany) params.set('company', nextCompany);
      if (nextMonth) params.set('month', nextMonth.slice(0, 7));
      const res = await apiFetch(`/api/admin/books/differences?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setCompany(json.company);
      setMonth(json.month);
      setOpen(null);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not compare the books');
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

  const years = [...new Set((data?.months ?? []).map((m) => m.month.slice(0, 4)))];
  const accounts = (data?.accounts ?? []).filter((a) => !onlyDifferences || a.differs !== 0);
  const companyName = data?.companies.find((c) => c.code === company)?.name ?? company;
  const matching = data?.months.filter((m) => m.status === 'matches').length ?? 0;
  const differingMonths = data?.months.filter((m) => m.status === 'differs').length ?? 0;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Differences vs NetSuite</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          FleetSuite&apos;s own books next to NetSuite&apos;s, account by account and month by month. What NetSuite moved with kinds
          of documents FleetSuite doesn&apos;t post yet is counted apart; for the kinds it does post, each document FleetSuite posted
          differently from NetSuite is listed with why. Visible only to super admins.{' '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
          {' · '}
          <Link href="/admin/books/trial-balance" style={{ color: 'var(--text-secondary)' }}>Trial balance vs NetSuite</Link>
          {' · '}
          <Link href="/admin/books/lists" style={{ color: 'var(--text-secondary)' }}>NetSuite lists</Link>
          {' · '}
          <Link href="/admin/books/invoices" style={{ color: 'var(--text-secondary)' }}>Invoices vs NetSuite</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          {!data.lastCopy && (
            <div style={banner(AMBER)}>NetSuite&apos;s general ledger hasn&apos;t been copied yet, so there is nothing to compare with.</div>
          )}
          {data.lastCopy?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s ledger failed {ago(data.lastCopy.at)}: {data.lastCopy.error}</div>}
          {data.lastPosting?.error && <div style={banner(RED)}>The last posting run failed {ago(data.lastPosting.at)}: {data.lastPosting.error}</div>}
          {data.copyHolds === false && (
            <div style={banner(AMBER)}>
              The copy of NetSuite&apos;s ledger doesn&apos;t hold all of {monthName(data.month)} yet, so NetSuite&apos;s side may be
              short. <Link href="/admin/books/trial-balance" style={{ color: 'inherit' }}>Trial balance vs NetSuite</Link> shows the
              accounts; the next copy catches up.
            </div>
          )}
          {data.lastCopy && !data.lastCopy.error && (
            <div style={note}>
              NetSuite&apos;s ledger copied {ago(data.lastCopy.at)}.
              {data.lastPosting ? ` FleetSuite's books posted ${ago(data.lastPosting.at)}${data.lastPosting.partial ? ', still working through the months' : ''}.` : ''}
              {data.posts && ` ${matching} of ${data.months.length} months match on what FleetSuite posts; ${differingMonths} differ.`}
            </div>
          )}

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
            {years.map((year) => (
              <div key={year} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ width: '40px', fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)' }}>{year}</span>
                {data.months.filter((m) => m.month.startsWith(year)).map((m) => {
                  const look = monthLook(m);
                  return (
                    <button
                      key={m.month}
                      onClick={() => pick(company, m.month)}
                      disabled={loading}
                      title={look.title}
                      style={{ ...button(m.month === month), borderColor: m.month === month ? 'var(--text-primary)' : `${look.color}88`, color: look.color }}
                    >
                      {shortMonth(m.month)} {look.mark}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' }}>
            <div style={{ fontSize: '16px', fontWeight: 800 }}>{monthName(month)}</div>
            {data.status === 'matches' && <span style={chip(GREEN)}>What FleetSuite posts matches NetSuite</span>}
            {data.status === 'differs' && <span style={chip(RED)}>{count(data.differing, 'account differs', 'accounts differ')} on what FleetSuite posts</span>}
            {data.status === 'none' && <span style={chip(GREY)}>FleetSuite posts nothing of this month yet</span>}
            {data.covered !== null && <span style={chip(GREY)}>FleetSuite posts {percent(data.covered)} of NetSuite&apos;s activity</span>}
          </div>
          <div style={note}>
            The month&apos;s activity on each side, not month-end balances, so a difference shows in the month it comes from:
            debits positive, credits negative. NetSuite&apos;s side counts in the month NetSuite posted to, FleetSuite&apos;s by each
            entry&apos;s date.
          </div>

          <div style={sectionTitle}>By kind of document</div>
          <div style={frame}>
            <table style={table}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)' }}>
                  <th style={{ ...cell, textAlign: 'left' }}>Kind of document</th>
                  <th style={cell}>NetSuite</th>
                  <th style={cell}>FleetSuite</th>
                </tr>
              </thead>
              <tbody>
                {data.kinds.length === 0 && (
                  <tr><td colSpan={3} style={{ padding: '12px', color: 'var(--text-muted)' }}>Neither side has anything this month.</td></tr>
                )}
                {data.kinds.map((k) => {
                  const s = kindStatus(k);
                  return (
                    <tr key={k.kind} style={{ borderTop: '1px solid var(--border)', verticalAlign: 'top' }}>
                      <td style={textCell}>
                        <div style={{ fontWeight: k.state === 'posted' ? 700 : 400 }}>{k.name}</div>
                        <span style={{ ...chip(s.color), display: 'inline-block', marginTop: '2px' }} title={s.title}>{s.label}</span>
                      </td>
                      <td style={cell}><Side total={k.netsuite} /></td>
                      <td style={cell}><Side total={k.fleetsuite} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ ...note, marginTop: '6px' }}>
            The amount is what the documents moved: each one&apos;s debits, after its lines on the same account are netted.
          </div>

          {data.posts && (
            <>
              <div style={sectionTitle}>Documents that differ</div>
              <div style={note}>
                {data.documentsTotal === 0
                  ? `Every document FleetSuite posts this month comes to what NetSuite posted for it, account by account.`
                  : `${count(data.documentsTotal, 'document', 'documents')} FleetSuite posts this month ${data.documentsTotal === 1 ? "doesn't" : "don't"} come to what NetSuite posted, the largest difference first${data.documents.length < data.documentsTotal ? `; the first ${data.documents.length} are shown` : ''}. Tap one for its accounts.`}
              </div>
              {data.documents.length > 0 && (
                <div style={{ border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--card)' }}>
                  {data.documents.map((d, i) => {
                    const key = `${d.kind}:${d.netsuiteId}`;
                    const isOpen = open === key;
                    return (
                      <div key={key} style={{ borderTop: i ? '1px solid var(--border)' : undefined, fontSize: '12px' }}>
                        <div onClick={() => setOpen(isOpen ? null : key)} style={{ padding: '8px 12px', cursor: 'pointer' }}>
                          <div style={{ display: 'flex', gap: '4px 16px', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
                            <div>
                              <span style={{ fontWeight: 800 }}>{isOpen ? '▾' : '▸'} {d.number}</span>
                              <span style={{ color: 'var(--text-muted)' }}>
                                {' · '}{[DOC_NAMES[d.kind] ?? d.kind, d.customer, d.date ? dateText(d.date) : null].filter(Boolean).join(' · ')}
                              </span>
                            </div>
                            <div style={{ display: 'flex', gap: '12px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              <span><span style={{ color: 'var(--text-muted)' }}>NetSuite </span>{amount(d.netsuite)}</span>
                              <span><span style={{ color: 'var(--text-muted)' }}>FleetSuite </span>{amount(d.fleetsuite)}</span>
                            </div>
                          </div>
                          <div style={{ marginTop: '3px', color: 'var(--text-secondary)' }}>{d.why}</div>
                        </div>
                        {isOpen && (
                          <div style={{ padding: '0 12px 12px' }}>
                            <div style={frame}>
                              <table style={table}>
                                <thead>
                                  <tr style={{ color: 'var(--text-secondary)' }}>
                                    <th style={{ ...cell, textAlign: 'left' }}>Account</th>
                                    <th style={cell}>NetSuite</th>
                                    <th style={cell}>FleetSuite</th>
                                    <th style={cell}>Difference</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {d.lines.map((l) => {
                                    const diff = l.fleetsuite - l.netsuite;
                                    return (
                                      <tr key={l.account} style={{ borderTop: '1px solid var(--border)' }}>
                                        <td style={textCell}>{[l.number, l.name].filter(Boolean).join(' ')}</td>
                                        <td style={cell}>{amount(l.netsuite)}</td>
                                        <td style={cell}>{amount(l.fleetsuite)}</td>
                                        <td style={{ ...cell, color: diff ? RED : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>{amount(diff)}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                            <div style={{ color: 'var(--text-muted)', marginTop: '8px', display: 'flex', gap: '4px 12px', flexWrap: 'wrap' }}>
                              {d.netsuiteMonth && <span>NetSuite posted it to {monthName(d.netsuiteMonth)}.</span>}
                              {d.entryNo !== null && d.fleetsuiteDate && <span>FleetSuite&apos;s entry {d.entryNo}, dated {dateText(d.fleetsuiteDate)}.</span>}
                              {d.listMonth && (
                                <Link
                                  href={`/admin/books/invoices?${new URLSearchParams({ company, kind: d.listKind, month: d.listMonth.slice(0, 7), doc: d.netsuiteId })}`}
                                  style={{ color: 'var(--text-secondary)', fontWeight: 700 }}
                                >
                                  Open in Invoices vs NetSuite →
                                </Link>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
          {!data.posts && (
            <div style={{ ...note, marginTop: '14px' }}>
              FleetSuite doesn&apos;t post {companyName}&apos;s documents yet, so everything NetSuite moved for it is still to come.
            </div>
          )}

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', margin: '18px 0 6px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800 }}>By account</div>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input type="checkbox" checked={onlyDifferences} onChange={(e) => setOnlyDifferences(e.target.checked)} />
              Only accounts where what FleetSuite posts differs
            </label>
          </div>
          <div style={frame}>
            <table style={table}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)' }}>
                  <th style={{ ...cell, textAlign: 'left' }} colSpan={2}>Account</th>
                  <th style={cell}>FleetSuite</th>
                  <th style={cell}>NetSuite</th>
                  <th style={cell} title="What NetSuite moved with kinds of documents FleetSuite doesn't post yet">Not posted yet</th>
                  <th style={cell} title="FleetSuite less NetSuite, on the kinds of documents FleetSuite posts">Differs</th>
                </tr>
              </thead>
              <tbody>
                {accounts.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                    {onlyDifferences ? 'What FleetSuite posts matches NetSuite on every account.' : 'Neither side moved anything this month.'}
                  </td></tr>
                )}
                {accounts.map((a) => (
                  <tr key={a.account} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...cell, textAlign: 'left', color: 'var(--text-muted)', width: '70px' }}>{a.number ?? ''}</td>
                    <td style={textCell}>
                      {a.name}
                      {!a.inChart && <span style={{ ...chip(AMBER), marginLeft: '6px' }}>Not in the chart</span>}
                    </td>
                    <td style={cell}>{amount(a.fleetsuite)}</td>
                    <td style={cell}>{amount(a.netsuite)}</td>
                    <td style={{ ...cell, color: 'var(--text-muted)' }}>{amount(a.notPosted)}</td>
                    <td style={{ ...cell, color: a.differs ? RED : 'var(--text-muted)', fontWeight: a.differs ? 700 : 400 }}>{amount(a.differs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ ...note, marginTop: '6px' }}>
            Differs is FleetSuite less NetSuite on the kinds of documents FleetSuite posts, so FleetSuite = NetSuite − Not posted
            yet + Differs.
          </div>
        </>
      )}
      {loading && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
