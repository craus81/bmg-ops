'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { looseMatcher } from '@/lib/loose-search';
import type { PartyBalance, PartyKind } from '@/lib/books/party-balances';

/**
 * Books → Customer and vendor balances (migration 406,
 * src/lib/books/party-balances.ts, docs/books.md "Customer and vendor
 * balances"; owner decision 2026-10-19, "Balance checks").
 *
 * What each customer owes and each vendor is owed in one company's books,
 * FleetSuite's next to NetSuite's: from where NetSuite's receivable and
 * payable accounts stood for them before 2025, then every document since,
 * FleetSuite's journal on one side and the copy of NetSuite's general ledger
 * on the other. The customers FleetSuite can't name (NetSuite customers the
 * ledger mirror hasn't matched to one of its own, and lines that name none)
 * are one row, with NetSuite's names in it. Tap a name for the documents
 * behind its balance. The daily check tells the super admins when a balance
 * stops matching and links here (?only=differs) or to the balance. Open to
 * whoever opens the books.
 */

interface Payload {
  companies: Array<{ code: string; name: string }>;
  company: string;
  kind: PartyKind;
  accounts: Array<{ number: string | null; name: string }>;
  parties: PartyBalance[];
  unsplit: number;
  openingComplete: boolean;
  totals: { fleetsuite: number; netsuite: number };
  differing: number;
  other: { kind: PartyKind; parties: number; differing: number };
  copyHolds: boolean | null;
  lastPosting: { at: string; error: string | null; partial: boolean } | null;
  lastCopy: { at: string; error: string | null } | null;
  lastCheck: { at: string; error: string | null } | null;
}

type Filter = 'all' | 'differs';

/** Rows shown at once; Show more adds as many again. */
const PAGE = 300;

const KIND_NAMES: Record<PartyKind, { one: string; many: string; Many: string; owes: string; accounts: string }> = {
  customer: { one: 'customer', many: 'customers', Many: 'Customers', owes: 'What each customer owes', accounts: 'receivable' },
  vendor: { one: 'vendor', many: 'vendors', Many: 'Vendors', owes: 'What each vendor is owed', accounts: 'payable' },
};

/** What the row of lines FleetSuite can't name holds. */
const UNNAMED_ABOUT: Record<PartyKind, string> = {
  customer: "NetSuite customers the ledger mirror hasn't matched to a FleetSuite customer by their NetSuite id, and lines that name no customer. "
    + "FleetSuite's books can't tell them apart, so they're compared together.",
  vendor: 'Payables lines that name no vendor, compared together.',
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const RED = '#ef4444';
const AMBER = '#fbbf24';

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const note: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' };

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
const amountHead: React.CSSProperties = { ...cell, width: '15%' };

/**
 * A row of a table: its label, then the amounts. On a phone the label takes a
 * row of its own above them (.rep-label-row in globals.css), as on Reports.
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

function Amounts({ fleetsuite, netsuite }: { fleetsuite: number; netsuite: number }) {
  const diff = fleetsuite - netsuite;
  return (
    <>
      <td style={cell}>{fmt(fleetsuite)}</td>
      <td style={cell}>{fmt(netsuite)}</td>
      <td style={{ ...cell, color: diff ? RED : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>{diff ? fmt(diff) : '—'}</td>
    </>
  );
}

/** A customer or vendor: its name (opening its documents), its NetSuite ids, and how many of its documents differ. */
function PartyLabel({ p, kind, company }: { p: PartyBalance; kind: PartyKind; company: string }) {
  const [open, setOpen] = useState(false);
  const ids = p.netsuiteIds.length > 1
    ? `${count(p.netsuiteIds.length, 'NetSuite customer', 'NetSuite customers')}`
    : null;
  const about = p.party === ''
    ? UNNAMED_ABOUT[kind]
    : [
      p.documents ? `${count(p.documents, 'document', 'documents')} since 2025` : 'No documents since 2025',
      p.opening ? `${fmt(p.opening)} before 2025` : '',
    ].filter(Boolean).join(' · ');
  return (
    <div>
      {/* A chip that doesn't fit beside the name goes under it whole. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' }}>
        <Link href={deepLinks.booksBalance(company, kind, p.party)} className="rep-link" style={{ fontWeight: 700 }}>{p.name}</Link>
        {ids && <span style={chip('#60a5fa')}>{ids}</span>}
        {p.differing > 0 && (
          <span style={chip(p.differs ? RED : AMBER)}>
            {count(p.differing, 'document differs', 'documents differ')}{p.differs ? '' : ', the balance matches'}
          </span>
        )}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{about}</div>
      {p.party === '' && p.membersCount > 0 && (
        <div style={{ marginTop: '4px' }}>
          {!open ? (
            <button onClick={() => setOpen(true)} style={{ ...button(false), padding: '3px 9px', fontSize: '11px' }}>
              Show the {count(p.membersCount, 'NetSuite customer', 'NetSuite customers')} in it
            </button>
          ) : (
            <ul style={{ margin: '2px 0', paddingLeft: '18px', fontSize: '11px', color: 'var(--text-secondary)' }}>
              {p.members.map((m) => (
                <li key={m.entityId || 'none'} style={{ overflowWrap: 'anywhere' }}>
                  {m.name}{m.entityId ? ` (NetSuite ${m.entityId})` : ''}: {fmt(m.balance)} in NetSuite&apos;s books
                </li>
              ))}
              {p.membersCount > p.members.length && <li>and {(p.membersCount - p.members.length).toLocaleString('en-US')} more with smaller balances</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function BooksBalancesPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(async (company: string, kind: string, nextFilter: Filter) => {
    try {
      const params = new URLSearchParams();
      if (company) params.set('company', company);
      if (kind) params.set('kind', kind);
      const res = await apiFetch(`/api/admin/books/balances?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setFilter(nextFilter);
      setShown(PAGE);
      setError('');
      // Keep the address on what's shown, so going back here opens it again.
      window.history.replaceState(null, '', deepLinks.booksBalances(json.company, json.kind, nextFilter === 'differs'));
    } catch (e: any) {
      setError(e?.message || 'Could not load the balances');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // The daily check's notification about several balances opens the ones that differ (deepLinks.booksBalances).
    const q = new URLSearchParams(window.location.search);
    load(q.get('company') ?? '', q.get('kind') ?? '', q.get('only') === 'differs' ? 'differs' : 'all');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const pick = (company: string, kind: string) => {
    setLoading(true);
    load(company, kind, filter);
  };
  const pickFilter = (next: Filter) => {
    if (!data) return;
    setFilter(next);
    setShown(PAGE);
    window.history.replaceState(null, '', deepLinks.booksBalances(data.company, data.kind, next === 'differs'));
  };

  const visible = useMemo(() => {
    const match = looseMatcher(search);
    return (data?.parties ?? []).filter((p) => (filter === 'all' || p.differs || p.differing > 0)
      && match(p.name, p.netsuiteIds, p.members.map((m) => m.name)));
  }, [data, filter, search]);

  const names = data ? KIND_NAMES[data.kind] : KIND_NAMES.customer;
  const companyName = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company;
  const accountNames = (data?.accounts ?? []).map((a) => [a.number, a.name].filter(Boolean).join(' ')).join(', ');
  const total = data ? data.totals.fleetsuite - data.totals.netsuite : 0;
  const docsOnly = (data?.parties ?? []).filter((p) => !p.differs && p.differing > 0).length;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Customer and vendor balances</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          What each customer owes and each vendor is owed, FleetSuite&apos;s books next to NetSuite&apos;s. Both start where
          NetSuite&apos;s receivable and payable accounts stood for each one before 2025, then add every document since:
          FleetSuite&apos;s journal on one side, the copy of NetSuite&apos;s general ledger on the other. Tap a name for the documents
          behind its balance. Each morning the daily check tells super admins when a balance stops matching.{' '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
          {' · '}
          <Link href="/admin/books/trial-balance" style={{ color: 'var(--text-secondary)' }}>Trial balance vs NetSuite</Link>
          {' · '}
          <Link href="/admin/books/lists" style={{ color: 'var(--text-secondary)' }}>NetSuite lists</Link>
          {' · '}
          <Link href="/admin/books/invoices" style={{ color: 'var(--text-secondary)' }}>Invoices vs NetSuite</Link>
          {' · '}
          <Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link>
          {' · '}
          <Link href="/admin/books/stock" style={{ color: 'var(--text-secondary)' }}>Stock by item</Link>
          {' · '}
          <Link href="/admin/books/own-invoices" style={{ color: 'var(--text-secondary)' }}>Own invoices</Link>
          {' · '}
          <Link href="/admin/books/own-fulfillments" style={{ color: 'var(--text-secondary)' }}>Own fulfillments</Link>
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
          {data.lastPosting && !data.lastPosting.error && data.lastPosting.partial && (
            <div style={banner(AMBER)}>
              Still posting: the last run, {ago(data.lastPosting.at)}, stopped for time, so some documents aren&apos;t in FleetSuite&apos;s
              books yet. It carries on at the next run, or press Post now on Invoices vs NetSuite.
            </div>
          )}
          {data.lastCheck?.error && <div style={banner(RED)}>The daily check couldn&apos;t look at everything {ago(data.lastCheck.at)}: {data.lastCheck.error}</div>}
          {data.copyHolds === false && (
            <div style={banner(AMBER)}>
              The copy of NetSuite&apos;s ledger doesn&apos;t hold everything on the {names.accounts} accounts yet, so NetSuite&apos;s side
              may be short. <Link href="/admin/books/trial-balance" style={{ color: 'inherit' }}>Trial balance vs NetSuite</Link> shows
              the months; the next copy catches up.
            </div>
          )}
          {!data.openingComplete && (
            <div style={banner(AMBER)}>
              {data.unsplit
                ? `${fmt(data.unsplit)} of where NetSuite's ${names.accounts} accounts stood before 2025 isn't split by ${names.one} yet, so it's in the total below but under no one. `
                : `The split by ${names.one} of where NetSuite's ${names.accounts} accounts stood before 2025 no longer adds up to them line for line. `}
              The next copy of NetSuite&apos;s ledger reads it again.
            </div>
          )}
          {data.lastCopy && !data.lastCopy.error && (
            <div style={note}>
              NetSuite&apos;s ledger copied {ago(data.lastCopy.at)}.
              {data.lastPosting ? ` FleetSuite's books posted ${ago(data.lastPosting.at)}.` : ''}
              {data.lastCheck && ` The daily check looked ${ago(data.lastCheck.at)}; super admins hear each morning when a balance stops matching.`}
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {data.companies.length > 1 && data.companies.map((c) => (
              <button key={c.code} onClick={() => pick(c.code, data.kind)} disabled={loading} style={button(c.code === data.company)}>
                {c.name}
              </button>
            ))}
            {data.companies.length > 1 && <span style={{ width: '8px' }} />}
            {(['customer', 'vendor'] as const).map((k) => {
              const differing = k === data.kind ? data.differing : data.other.differing;
              return (
                <button key={k} onClick={() => pick(data.company, k)} disabled={loading} style={button(k === data.kind)}>
                  {KIND_NAMES[k].Many}
                  {differing > 0 && <span style={{ color: RED }}> · {count(differing, 'differs', 'differ')}</span>}
                </button>
              );
            })}
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '14px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>{companyName}</th>
                  <th style={amountHead}>FleetSuite</th>
                  <th style={amountHead}>NetSuite</th>
                  <th style={amountHead}>Difference</th>
                </tr>
              </thead>
              <tbody>
                <Row
                  label={(
                    <div>
                      <div style={{ fontWeight: 700 }}>Every {names.one}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {accountNames ? `On ${accountNames}.` : `No ${names.accounts} account in the chart yet.`}
                        {data.unsplit ? ` ${fmt(data.unsplit)} of it from before 2025 isn't split by ${names.one}.` : ''}
                      </div>
                    </div>
                  )}
                >
                  <td style={cell}>{fmt(data.totals.fleetsuite)}</td>
                  <td style={cell}>{fmt(data.totals.netsuite)}</td>
                  <td style={{ ...cell, color: total ? RED : 'var(--text-muted)', fontWeight: total ? 700 : 400 }}>{total ? fmt(total) : '—'}</td>
                </Row>
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
            <button onClick={() => pickFilter('all')} style={button(filter === 'all')}>
              All {data.parties.length.toLocaleString('en-US')}
            </button>
            <button
              onClick={() => pickFilter('differs')}
              style={{ ...button(filter === 'differs'), color: data.differing ? RED : docsOnly ? AMBER : 'var(--text-primary)' }}
            >
              {data.differing ? `${count(data.differing, 'balance differs', 'balances differ')} from NetSuite`
                : docsOnly ? 'Every balance matches NetSuite' : 'None differ from NetSuite'}
            </button>
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }}
              placeholder={`Search ${names.many}`}
              style={{ padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', flex: '1 1 180px', minWidth: 0, maxWidth: '280px' }}
            />
          </div>
          {docsOnly > 0 && (
            <div style={note}>
              {count(docsOnly, `${names.one} has`, `${names.many} have`)} documents that differ from NetSuite&apos;s, though{' '}
              {docsOnly === 1 ? 'its balance matches' : 'their balances match'}: listed with the ones that differ, in amber.
            </div>
          )}

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>{names.owes}</th>
                  <th style={amountHead}>FleetSuite</th>
                  <th style={amountHead}>NetSuite</th>
                  <th style={amountHead}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {!visible.length && (
                  <tr><td colSpan={4} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                    {search ? `No ${names.one} matches that search.`
                      : filter === 'differs' ? `Every ${names.one}'s balance matches NetSuite.`
                        : `No ${names.one} has a balance in these books yet.`}
                  </td></tr>
                )}
                {visible.slice(0, shown).map((p) => (
                  <Row key={p.party || 'none'} label={<PartyLabel p={p} kind={data.kind} company={data.company} />} style={{ borderTop: '1px solid var(--border)' }}>
                    <Amounts fleetsuite={p.fleetsuite} netsuite={p.netsuite} />
                  </Row>
                ))}
              </tbody>
            </table>
          </div>
          {visible.length > shown && (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Showing {shown.toLocaleString('en-US')} of {visible.length.toLocaleString('en-US')}.
              <button onClick={() => setShown(shown + PAGE)} style={button(false)}>Show more</button>
            </div>
          )}
          {filter === 'all' && !search && (
            <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
              {names.Many} at nothing on both sides, with every document matching, are left out.
            </div>
          )}
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
