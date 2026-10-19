'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { PartyKind } from '@/lib/books/party-balances';
import type { DetailDocument } from '@/lib/books/report-detail';

/**
 * Books → Customer and vendor balances → one customer's or vendor's balance
 * (migration 406, src/lib/books/party-balances.ts, docs/books.md "Customer
 * and vendor balances").
 *
 * Where NetSuite's receivable (payable) accounts stood for it before 2025,
 * then every document since that moved its balance, FleetSuite's journal
 * next to the copy of NetSuite's general ledger, those that differ first,
 * then the newest. Tap a document's number for its line by line check.
 * Super admins only, as the books are; opened from a name on Customer and
 * vendor balances, or from the daily check's notification.
 */

interface Pair {
  fleetsuite: number;
  netsuite: number;
}

interface Payload {
  companies: Array<{ code: string; name: string }>;
  company: string;
  kind: PartyKind;
  party: string;
  name: string;
  netsuiteIds: string[];
  opening: number;
  moved: Pair;
  balance: Pair;
  documents: number;
  differing: number;
  only: 'all' | 'differs';
  rows: DetailDocument[];
  lastPosting: { at: string; error: string | null; partial: boolean } | null;
}

interface Asked {
  company: string;
  kind: string;
  party: string;
  differs: boolean;
}

const KIND_NAMES: Record<PartyKind, { many: string; owes: string; accounts: string; netsuite: [string, string] }> = {
  customer: { many: 'customer', owes: 'owes', accounts: 'receivable', netsuite: ['NetSuite customer', 'NetSuite customers'] },
  vendor: { many: 'vendor', owes: 'is owed', accounts: 'payable', netsuite: ['NetSuite vendor', 'NetSuite vendors'] },
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

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

function Amounts({ pair }: { pair: Pair }) {
  const diff = pair.fleetsuite - pair.netsuite;
  return (
    <>
      <td style={cell}>{fmt(pair.fleetsuite)}</td>
      <td style={cell}>{fmt(pair.netsuite)}</td>
      <td style={{ ...cell, color: diff ? RED : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>{diff ? fmt(diff) : '—'}</td>
    </>
  );
}

/**
 * A document: its date, type and number (opening its check on Invoices vs NetSuite), memo, and the name it
 * carries in NetSuite when that isn't the page's own (`own`).
 */
function DocumentLabel({ d, company, own }: { d: DetailDocument; company: string; own: string }) {
  const number = d.check
    ? <Link href={deepLinks.booksDocument(company, d.check.kind, d.check.month, d.doc)} className="rep-link" style={{ fontWeight: 700 }}>{d.number}</Link>
    : <span style={{ fontWeight: 700 }}>{d.number}</span>;
  return (
    <div>
      <div>
        {d.date && <span style={{ color: 'var(--text-muted)', marginRight: '8px' }}>{dayText(d.date)}</span>}
        <span style={{ color: 'var(--text-secondary)', marginRight: '6px' }}>{d.type}</span>
        {number}
        {d.name && d.name !== own && <span style={{ marginLeft: '6px' }}>· {d.name}</span>}
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

export default function BooksBalancePage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (asked: Asked) => {
    try {
      const params = new URLSearchParams({ company: asked.company, kind: asked.kind, party: asked.party });
      if (asked.differs) params.set('only', 'differs');
      const res = await apiFetch(`/api/admin/books/balances/party?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
      // Keep the address on what's shown, so going back here opens it again.
      window.history.replaceState(null, '', deepLinks.booksBalance(json.company, json.kind, json.party, json.only === 'differs'));
    } catch (e: any) {
      setError(e?.message || 'Could not load the documents');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // Customer and vendor balances and the daily check link here with the company, kind and party (deepLinks.booksBalance).
    const q = new URLSearchParams(window.location.search);
    load({ company: q.get('company') ?? '', kind: q.get('kind') ?? '', party: q.get('party') ?? '', differs: q.get('only') === 'differs' });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const pick = (differs: boolean) => {
    if (!data) return;
    setLoading(true);
    load({ company: data.company, kind: data.kind, party: data.party || 'none', differs });
  };

  const names = data ? KIND_NAMES[data.kind] : KIND_NAMES.customer;
  const companyName = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company;
  const listed = data ? (data.only === 'differs' ? data.differing : data.documents) : 0;
  const diff = data ? data.balance.fleetsuite - data.balance.netsuite : 0;
  const ids = data?.netsuiteIds.length
    ? `${data.netsuiteIds.length === 1 ? names.netsuite[0] : names.netsuite[1]} ${data.netsuiteIds.join(', ')}`
    : null;

  return (
    <div>
      {data && (
        <div style={{ marginBottom: '8px', fontSize: '12px' }}>
          <Link href={deepLinks.booksBalances(data.company, data.kind)} style={{ color: 'var(--text-secondary)' }}>
            ← Back to {names.many} balances
          </Link>
        </div>
      )}

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '20px', fontWeight: 800 }}>
              {data.name}
              <span style={{ ...chip(diff ? RED : GREEN), marginLeft: '8px', verticalAlign: 'middle' }}>
                {diff ? `Differs by ${fmt(diff)}` : 'Matches NetSuite'}
              </span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {companyName}{ids ? ` · ${ids}` : ''}. What this {names.many} {names.owes}: where NetSuite&apos;s {names.accounts} accounts
              stood for it before 2025, then every document since that moved it, FleetSuite&apos;s journal next to the copy of
              NetSuite&apos;s general ledger. Those that differ come first, then the newest. Tap a document&apos;s number for its line by
              line check.
              {data.party === '' && data.kind === 'customer' && (
                ' These are the NetSuite customers the ledger mirror hasn\'t matched to a FleetSuite customer by their NetSuite id, and '
                + 'lines that name no customer, together: FleetSuite\'s books can\'t tell them apart. Each document names its NetSuite customer.'
              )}
            </div>
          </div>

          {data.lastPosting?.error && <div style={banner(RED)}>The last posting run failed {ago(data.lastPosting.at)}: {data.lastPosting.error}</div>}
          {data.lastPosting && !data.lastPosting.error && data.lastPosting.partial && (
            <div style={banner(AMBER)}>
              Still posting: the last run, {ago(data.lastPosting.at)}, stopped for time, so some documents aren&apos;t in FleetSuite&apos;s
              books yet. It carries on at the next run, or press Post now on Invoices vs NetSuite.
            </div>
          )}

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
                <Row label="Before 2025, as NetSuite had it">
                  <Amounts pair={{ fleetsuite: data.opening, netsuite: data.opening }} />
                </Row>
                <Row label={`${count(data.documents, 'document', 'documents')} since`} style={{ borderTop: '1px solid var(--border)' }}>
                  <Amounts pair={data.moved} />
                </Row>
                <Row label="Balance now" style={{ borderTop: '3px double var(--border)', fontWeight: 800 }}>
                  <Amounts pair={data.balance} />
                </Row>
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
            <button onClick={() => pick(false)} disabled={loading} style={button(data.only === 'all')}>
              All {count(data.documents, 'document', 'documents')}
            </button>
            <button
              onClick={() => pick(true)}
              disabled={loading}
              style={{ ...button(data.only === 'differs'), color: data.differing ? RED : 'var(--text-primary)' }}
            >
              {data.differing ? `${count(data.differing, 'differs', 'differ')} from NetSuite` : 'None differ from NetSuite'}
            </button>
          </div>
          {data.rows.length < listed && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              Showing the first {data.rows.length.toLocaleString('en-US')} of {listed.toLocaleString('en-US')}: those that differ, then the newest.
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
                    {data.only === 'differs' ? 'Every document matches NetSuite.' : 'No document has moved this balance since 2025.'}
                  </td></tr>
                )}
                {data.rows.map((d) => (
                  <Row key={d.doc} label={<DocumentLabel d={d} company={data.company} own={data.name} />} style={{ borderTop: '1px solid var(--border)' }}>
                    <Amounts pair={d} />
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
