'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { looseMatcher } from '@/lib/loose-search';
import type { PartyKind } from '@/lib/books/party-balances';
import { BUCKETS, BUCKET_NAMES, type AgingBucketKey } from '@/lib/books/aging-buckets';
import type { Buckets, PartyAging, Sides } from '@/lib/books/agings';

/**
 * Books → AR and AP agings (migration 458, src/lib/books/agings.ts,
 * docs/books.md "AR and AP agings"; the NetSuite Exit Checklist, thread
 * "Replacing NetSuite with FleetSuite", 2026-10-31).
 *
 * Who owes BMG and who BMG owes in one company's books, by how late, aged
 * to today in Central time: FleetSuite's books next to NetSuite's. NetSuite's
 * side is what NetSuite has open on each invoice and bill, copied every two
 * hours; FleetSuite's is NetSuite's open amount plus whatever FleetSuite's
 * books have more on the document, since they don't record which payment
 * paid which invoice yet. What a customer's or vendor's open documents leave
 * of its balance (Customer and vendor balances) is "not in an open invoice".
 * Tap a name for its documents. Super admins only, as the books are.
 */

type Listed = Omit<PartyAging, 'documents'> & { documentCount: number };

interface Payload {
  companies: Array<{ code: string; name: string }>;
  company: string;
  kind: PartyKind;
  today: string;
  linked: boolean;
  netsuiteDocuments: number;
  parties: Listed[];
  totals: { buckets: Buckets; notOpen: Sides<number>; unsplit: number; balance: Sides<number> };
  differing: number;
  lastOpenCopy: { at: string | null; tried: string; error: string | null; kept: boolean; notes: string[] } | null;
  lastCopy: { at: string; error: string | null } | null;
  lastPosting: { at: string; error: string | null; partial: boolean } | null;
}

type Filter = 'all' | 'differs';

/** Rows shown at once; Show more adds as many again. */
const PAGE = 300;

const KIND_NAMES: Record<PartyKind, { one: string; many: string; Many: string; owes: string; open: string; accounts: string }> = {
  customer: { one: 'customer', many: 'customers', Many: 'Customers', owes: 'Who owes BMG', open: 'invoice', accounts: 'receivable' },
  vendor: { one: 'vendor', many: 'vendors', Many: 'Vendors', owes: 'Whom BMG owes', open: 'bill', accounts: 'payable' },
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

/** The buckets past due, each one's own column on a computer and one column together on a phone. */
const LATE = BUCKETS.filter((b) => b !== 'current');
const pastDueOf = (buckets: Buckets): Sides<number> => ({
  fleetsuite: LATE.reduce((sum, b) => sum + buckets[b].fleetsuite, 0),
  netsuite: LATE.reduce((sum, b) => sum + buckets[b].netsuite, 0),
});

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const RED = '#ef4444';
const AMBER = '#fbbf24';
const GREEN = '#22c55e';

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const note: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' };

const button = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: '8px', border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border)'}`,
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: active ? 800 : 600, cursor: 'pointer',
});

const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const labelCell: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };
const amountHead: React.CSSProperties = { ...cell, width: '15%' };
const gridCell: React.CSSProperties = { ...cell, padding: '6px 8px' };

/**
 * A row of a table: its label, then `amounts` amounts. On a phone the label
 * takes a row of its own above them (.rep-label-row in globals.css), as on
 * Reports, spanning the amounts, since the label's own cell is hidden there.
 */
function Row({ label, amounts, style, children }: { label: React.ReactNode; amounts: number; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <>
      <tr className="rep-label-row" style={style}><td colSpan={amounts} style={labelCell}>{label}</td></tr>
      <tr className="rep-amounts" style={style}>
        <td className="rep-label" style={labelCell}>{label}</td>
        {children}
      </tr>
    </>
  );
}

/** An amount's color: muted when there's nothing. */
const tone = (amount: number, strong?: boolean) => (amount || strong ? 'var(--text-primary)' : 'var(--text-muted)');

function Amounts({ fleetsuite, netsuite, strong }: Sides<number> & { strong?: boolean }) {
  const diff = fleetsuite - netsuite;
  const amount = (cents: number) => (cents || strong ? fmt(cents) : '—');
  return (
    <>
      <td style={{ ...cell, fontWeight: strong ? 800 : 400, color: tone(fleetsuite, strong) }}>{amount(fleetsuite)}</td>
      <td style={{ ...cell, fontWeight: strong ? 800 : 400, color: tone(netsuite, strong) }}>{amount(netsuite)}</td>
      <td style={{ ...cell, color: diff ? RED : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>{diff ? fmt(diff) : '—'}</td>
    </>
  );
}

/** One amount of a customer's or vendor's aging: FleetSuite's, and NetSuite's under it in red when it differs. */
function GridAmount({ sides, strong, className }: { sides: Sides<number>; strong?: boolean; className?: string }) {
  const differs = sides.fleetsuite !== sides.netsuite;
  return (
    <td className={className} style={{ ...gridCell, fontWeight: strong ? 800 : 400, color: differs ? RED : tone(sides.fleetsuite) }}>
      {sides.fleetsuite ? fmt(sides.fleetsuite) : '—'}
      {differs && <div style={{ fontSize: '10px', fontWeight: 600 }}>NetSuite {fmt(sides.netsuite)}</div>}
    </td>
  );
}

function PartyLabel({ p, kind, company }: { p: Listed; kind: PartyKind; company: string }) {
  const names = KIND_NAMES[kind];
  const about = [
    p.documentCount ? count(p.documentCount, `open ${names.open}`, `open ${names.open}s`) : `No open ${names.open}`,
    p.notOpen.fleetsuite || p.notOpen.netsuite
      ? `${fmt(p.notOpen.fleetsuite)} not in an open ${names.open}${p.notOpen.fleetsuite !== p.notOpen.netsuite ? ` (NetSuite ${fmt(p.notOpen.netsuite)})` : ''}`
      : '',
  ].filter(Boolean).join(' · ');
  return (
    <div>
      <Link href={deepLinks.booksAging(company, kind, p.party)} className="rep-link" style={{ fontWeight: 700 }}>{p.name}</Link>
      <div style={{ fontSize: '11px', color: p.notOpen.fleetsuite !== p.notOpen.netsuite ? RED : 'var(--text-muted)', overflowWrap: 'anywhere' }}>{about}</div>
    </div>
  );
}

export default function BooksAgingsPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [copying, setCopying] = useState(false);
  const [copyNote, setCopyNote] = useState('');
  const [introOpen, setIntroOpen] = useState(false);

  const load = useCallback(async (company: string, kind: string, nextFilter: Filter) => {
    try {
      const params = new URLSearchParams();
      if (company) params.set('company', company);
      if (kind) params.set('kind', kind);
      const res = await apiFetch(`/api/admin/books/agings?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setFilter(nextFilter);
      setShown(PAGE);
      setError('');
      // Keep the address on what's shown, so going back here opens it again.
      window.history.replaceState(null, '', deepLinks.booksAgings(json.company, json.kind, nextFilter === 'differs'));
    } catch (e: any) {
      setError(e?.message || 'Could not load the agings');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
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
    window.history.replaceState(null, '', deepLinks.booksAgings(data.company, data.kind, next === 'differs'));
  };
  const copyNow = async () => {
    if (!data) return;
    setCopying(true);
    setCopyNote('');
    try {
      const res = await apiFetch('/api/admin/books/agings', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setCopyNote(json.kept ? 'NetSuite gave nothing open, so the copy kept the last one.' : `Copied ${count(json.copied ?? 0, 'open document', 'open documents')} from NetSuite.`);
      setLoading(true);
      await load(data.company, data.kind, filter);
    } catch (e: any) {
      setError(e?.message || "Could not copy NetSuite's open documents");
    }
    setCopying(false);
  };

  const visible = useMemo(() => {
    const match = looseMatcher(search);
    return (data?.parties ?? []).filter((p) => (filter === 'all' || p.differs) && match(p.name, p.netsuiteIds));
  }, [data, filter, search]);

  const names = data ? KIND_NAMES[data.kind] : KIND_NAMES.customer;
  const companyName = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company;
  const pastDue = data ? pastDueOf(data.totals.buckets) : { fleetsuite: 0, netsuite: 0 };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>AR and AP agings</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {/* Two lines until More opens the rest below them. */}
            <div style={introOpen ? undefined : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              Who owes BMG and whom BMG owes, by how late, FleetSuite&apos;s books next to NetSuite&apos;s. Each open invoice and bill is
              aged from its due date, or its date when it has none, to today. NetSuite&apos;s side is what NetSuite has open on each one,
              copied every two hours. FleetSuite&apos;s books don&apos;t record yet which payment paid which invoice, so FleetSuite&apos;s
              side is NetSuite&apos;s open amount plus whatever FleetSuite&apos;s books have more on it. Tap a name for its documents.
              Visible only to super admins.
            </div>
            <button
              onClick={() => setIntroOpen(!introOpen)}
              style={{ padding: 0, border: 'none', background: 'none', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
            >
              {introOpen ? 'Less' : 'More'}
            </button>
            {' · '}
            <Link href="/admin/books/balances" style={{ color: 'var(--text-secondary)' }}>Customer and vendor balances</Link>
            {' · '}
            <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
            {' · '}
            <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
          </div>
        </div>
        <button onClick={copyNow} disabled={copying || loading || !data} style={{ ...button(false), alignSelf: 'flex-start', cursor: copying ? 'wait' : 'pointer' }}>
          {copying ? 'Copying…' : 'Copy now'}
        </button>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}
      {copyNote && <div style={banner(GREEN)}>{copyNote}</div>}

      {data && (
        <>
          {!data.lastOpenCopy && (
            <div style={banner(AMBER)}>
              NetSuite&apos;s open invoices and bills haven&apos;t been copied yet, so NetSuite&apos;s side has nothing open and every balance shows as
              not in an open {names.open}. Press Copy now, or wait for the next copy.
            </div>
          )}
          {data.lastOpenCopy?.error && (
            <div style={banner(RED)}>The last copy of NetSuite&apos;s open documents failed {ago(data.lastOpenCopy.tried)}: {data.lastOpenCopy.error}</div>
          )}
          {data.lastOpenCopy?.notes.map((n) => <div key={n} style={banner(AMBER)}>{n}</div>)}
          {!data.linked && (
            <div style={banner(AMBER)}>
              {companyName} isn&apos;t linked to a NetSuite subsidiary, so NetSuite&apos;s open documents can&apos;t be told apart for it: its balances show
              as not in an open {names.open}.
            </div>
          )}
          {data.lastCopy?.error && <div style={banner(RED)}>The last copy of NetSuite&apos;s ledger failed {ago(data.lastCopy.at)}: {data.lastCopy.error}</div>}
          {data.lastPosting?.error && <div style={banner(RED)}>The last posting run failed {ago(data.lastPosting.at)}: {data.lastPosting.error}</div>}
          {data.lastPosting && !data.lastPosting.error && data.lastPosting.partial && (
            <div style={banner(AMBER)}>
              Still posting: the last run, {ago(data.lastPosting.at)}, stopped for time, so some documents aren&apos;t in FleetSuite&apos;s
              books yet. It carries on at the next run, or press Post now on Invoices vs NetSuite.
            </div>
          )}
          <div style={note}>
            Aged to {longDate(data.today)}, Central time.
            {data.lastOpenCopy?.at ? ` NetSuite's open documents copied ${ago(data.lastOpenCopy.at)}: ${count(data.netsuiteDocuments, `open ${names.open} or credit`, `open ${names.open}s and credits`)} for ${companyName}.` : ''}
            {data.lastCopy && !data.lastCopy.error ? ` NetSuite's ledger copied ${ago(data.lastCopy.at)}.` : ''}
            {data.lastPosting ? ` FleetSuite's books posted ${ago(data.lastPosting.at)}.` : ''}
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {data.companies.length > 1 && data.companies.map((c) => (
              <button key={c.code} onClick={() => pick(c.code, data.kind)} disabled={loading} style={button(c.code === data.company)}>
                {c.name}
              </button>
            ))}
            {data.companies.length > 1 && <span style={{ width: '8px' }} />}
            {(['customer', 'vendor'] as const).map((k) => (
              <button key={k} onClick={() => pick(data.company, k)} disabled={loading} style={button(k === data.kind)}>
                {KIND_NAMES[k].Many}
              </button>
            ))}
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '14px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>{companyName}: {names.owes}</th>
                  <th style={amountHead}>FleetSuite</th>
                  <th style={amountHead}>NetSuite</th>
                  <th style={amountHead}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {BUCKETS.map((b) => (
                  <Row key={b} label={BUCKET_NAMES[b]} amounts={3} style={{ borderTop: '1px solid var(--border)' }}>
                    <Amounts {...data.totals.buckets[b]} />
                  </Row>
                ))}
                <Row
                  amounts={3}
                  style={{ borderTop: '1px solid var(--border)' }}
                  label={(
                    <div>
                      <div>Not in an open {names.open}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        Payments not applied to {data.kind === 'customer' ? 'an invoice' : 'a bill'} yet, journal entries, and differences
                        on documents that don&apos;t age.
                      </div>
                    </div>
                  )}
                >
                  <Amounts {...data.totals.notOpen} />
                </Row>
                {data.totals.unsplit !== 0 && (
                  <Row amounts={3} label={`Before 2025, not split by ${names.one}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <Amounts fleetsuite={data.totals.unsplit} netsuite={data.totals.unsplit} />
                  </Row>
                )}
                <Row
                  amounts={3}
                  style={{ borderTop: '2px solid var(--border)' }}
                  label={(
                    <div>
                      <div style={{ fontWeight: 800 }}>Total, the {names.accounts} accounts</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {fmt(pastDue.fleetsuite)} past due in FleetSuite&apos;s books
                        {pastDue.fleetsuite !== pastDue.netsuite ? `, ${fmt(pastDue.netsuite)} in NetSuite's` : ''}.
                      </div>
                    </div>
                  )}
                >
                  <Amounts {...data.totals.balance} strong />
                </Row>
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
            <button onClick={() => pickFilter('all')} style={button(filter === 'all')}>
              All {data.parties.length.toLocaleString('en-US')}
            </button>
            <button onClick={() => pickFilter('differs')} style={{ ...button(filter === 'differs'), color: data.differing ? RED : 'var(--text-primary)' }}>
              {data.differing ? `${count(data.differing, 'differs', 'differ')} from NetSuite` : 'None differ from NetSuite'}
            </button>
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }}
              placeholder={`Search ${names.many}`}
              style={{ padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', flex: '1 1 180px', minWidth: 0, maxWidth: '280px' }}
            />
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th className="rep-label" style={{ ...gridCell, textAlign: 'left' }}>{names.Many}, FleetSuite&apos;s books</th>
                  {BUCKETS.map((b: AgingBucketKey) => (
                    <th key={b} className={b === 'current' ? undefined : 'rep-wide'} style={gridCell}>{BUCKET_NAMES[b].replace(' days', '')}</th>
                  ))}
                  <th className="rep-narrow" style={gridCell}>Past due</th>
                  <th style={gridCell}>Total</th>
                </tr>
              </thead>
              <tbody>
                {!visible.length && (
                  <tr>
                    {[{ className: 'rep-wide', span: 7 }, { className: 'rep-narrow', span: 3 }].map((c) => (
                      <td key={c.className} className={c.className} colSpan={c.span} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                        {search ? `No ${names.one} matches that search.`
                          : filter === 'differs' ? `Every ${names.one}'s aging matches NetSuite's.`
                            : `No ${names.one} has anything open in these books.`}
                      </td>
                    ))}
                  </tr>
                )}
                {visible.slice(0, shown).map((p) => (
                  <Row key={p.party || 'none'} amounts={3} label={<PartyLabel p={p} kind={data.kind} company={data.company} />} style={{ borderTop: '1px solid var(--border)' }}>
                    {BUCKETS.map((b) => <GridAmount key={b} className={b === 'current' ? undefined : 'rep-wide'} sides={p.buckets[b]} />)}
                    <GridAmount className="rep-narrow" sides={pastDueOf(p.buckets)} />
                    <GridAmount sides={p.balance} strong />
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
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
            A red amount differs from NetSuite&apos;s, shown under it. Those that differ come first, then the largest balance.
          </div>
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
