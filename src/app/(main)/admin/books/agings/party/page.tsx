'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { PartyKind } from '@/lib/books/party-balances';
import { BUCKETS, BUCKET_NAMES, DOCUMENT_TYPES } from '@/lib/books/aging-buckets';
import type { AgedDocument, PartyAging, Sides } from '@/lib/books/agings';

/**
 * Books → AR and AP agings → one customer's or vendor's aging (migration
 * 458, src/lib/books/agings.ts, docs/books.md "AR and AP agings").
 *
 * What it has open in each bucket, FleetSuite's books next to NetSuite's,
 * what its open documents leave of its balance, then every open document,
 * the most overdue first: its date, when it's due and how late it is each
 * side, and what's open on it each side. Super admins only, as the books are;
 * opened from a name on AR and AP agings.
 */

interface Payload {
  companies: Array<{ code: string; name: string }>;
  company: string;
  kind: PartyKind;
  today: string;
  party: PartyAging | null;
  lastOpenCopy: { at: string | null; tried: string; error: string | null } | null;
  lastPosting: { at: string; error: string | null; partial: boolean } | null;
}

interface Asked {
  company: string;
  kind: string;
  party: string;
}

const KIND_NAMES: Record<PartyKind, { one: string; owes: (company: string) => string; open: string }> = {
  customer: { one: 'customer', owes: (company) => `What this customer owes ${company}`, open: 'invoice' },
  vendor: { one: 'vendor', owes: (company) => `What ${company} owes this vendor`, open: 'bill' },
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

const RED = '#ef4444';
const AMBER = '#fbbf24';

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const note: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' };

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

const dayCount = (days: number) => `${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'}`;

/** When a document is due and how late it is, as one side has it; one with no due date ages from its date. */
function lateness(d: AgedDocument, side: keyof Sides<number>): string {
  const due = d.due[side];
  const days = d.days[side];
  if (days === null) return due ? `due ${dayText(due)}` : 'no due date';
  const bucket = BUCKET_NAMES[d.bucket[side]];
  if (!due) return `no due date, ${days > 0 ? `${dayCount(days)} old` : 'dated today'} (${bucket})`;
  const late = days > 0 ? `${dayCount(days)} late` : days === 0 ? 'due today' : 'not due yet';
  return `due ${dayText(due)}, ${late} (${bucket})`;
}

function DocumentLabel({ d }: { d: AgedDocument }) {
  const late = lateness(d, 'fleetsuite');
  const netsuiteLate = lateness(d, 'netsuite');
  return (
    <div>
      <div style={{ fontWeight: 700 }}>
        {DOCUMENT_TYPES[d.type] ?? d.type} {d.number ?? `NetSuite ${d.doc}`}
        {d.onlyIn && (
          <span style={{ marginLeft: '6px', fontSize: '10px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', border: `1px solid ${AMBER}55`, color: AMBER }}>
            Only in {d.onlyIn === 'fleetsuite' ? "FleetSuite's" : "NetSuite's"} books
          </span>
        )}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
        {d.date ? `Dated ${dayText(d.date)}, ` : ''}{late}
      </div>
      {netsuiteLate !== late && (
        <div style={{ fontSize: '11px', color: RED }}>NetSuite: {netsuiteLate}</div>
      )}
    </div>
  );
}

export default function BooksAgingPartyPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (q: Asked) => {
    try {
      const params = new URLSearchParams({ company: q.company, kind: q.kind, party: q.party || 'none' });
      const res = await apiFetch(`/api/admin/books/agings?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the aging');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    const q = new URLSearchParams(window.location.search);
    const party = q.get('party') ?? '';
    const next = { company: q.get('company') ?? '', kind: q.get('kind') ?? 'customer', party: party === 'none' ? '' : party };
    setAsked(next);
    load(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const kind: PartyKind = data?.kind ?? (asked?.kind === 'vendor' ? 'vendor' : 'customer');
  const names = KIND_NAMES[kind];
  const companyName = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company;
  const p = data?.party ?? null;
  const backTo = deepLinks.booksAgings(data?.company ?? asked?.company ?? 'BMG', kind);

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '12px', marginBottom: '4px' }}>
          <Link href={backTo} style={{ color: 'var(--text-secondary)' }}>← AR and AP agings</Link>
        </div>
        <div style={{ fontSize: '20px', fontWeight: 800, overflowWrap: 'anywhere' }}>{p?.name ?? 'Aging'}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {names.owes(companyName ?? 'the company')} by how late, FleetSuite&apos;s books next to NetSuite&apos;s, then each open document,
          the most overdue first.
          {data && asked && (
            <>
              {' '}
              <Link href={deepLinks.booksBalance(data.company, kind, asked.party)} style={{ color: 'var(--text-secondary)' }}>
                Every document behind the balance
              </Link>
            </>
          )}
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          {data.lastOpenCopy?.error && (
            <div style={banner(RED)}>The last copy of NetSuite&apos;s open documents failed {ago(data.lastOpenCopy.tried)}: {data.lastOpenCopy.error}</div>
          )}
          {data.lastPosting?.error && <div style={banner(RED)}>The last posting run failed {ago(data.lastPosting.at)}: {data.lastPosting.error}</div>}
          <div style={note}>
            Aged to {dayText(data.today)}, Central time.
            {data.lastOpenCopy?.at ? ` NetSuite's open documents copied ${ago(data.lastOpenCopy.at)}.` : " NetSuite's open documents haven't been copied yet."}
          </div>

          {!p && <div style={note}>Nothing is open for this {names.one} on either side, and its balance is nothing.</div>}

          {p && (
            <>
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '14px' }}>
                <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                      <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>By how late</th>
                      <th style={amountHead}>FleetSuite</th>
                      <th style={amountHead}>NetSuite</th>
                      <th style={amountHead}>Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {BUCKETS.map((b) => (
                      <Row key={b} label={BUCKET_NAMES[b]} style={{ borderTop: '1px solid var(--border)' }}>
                        <Amounts {...p.buckets[b]} />
                      </Row>
                    ))}
                    <Row
                      style={{ borderTop: '1px solid var(--border)' }}
                      label={(
                        <div>
                          <div>Not in an open {names.open}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            What its open documents leave of its balance: a payment not applied yet, a journal entry, or a difference
                            on a document that doesn&apos;t age.
                          </div>
                        </div>
                      )}
                    >
                      <Amounts {...p.notOpen} />
                    </Row>
                    <Row label={<span style={{ fontWeight: 800 }}>Balance</span>} style={{ borderTop: '2px solid var(--border)' }}>
                      <Amounts {...p.balance} strong />
                    </Row>
                  </tbody>
                </table>
              </div>

              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
                <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                      <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Open documents</th>
                      <th style={amountHead}>FleetSuite</th>
                      <th style={amountHead}>NetSuite</th>
                      <th style={amountHead}>Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!p.documents.length && (
                      <tr><td colSpan={4} style={{ padding: '12px', color: 'var(--text-muted)' }}>Nothing open on either side.</td></tr>
                    )}
                    {p.documents.map((d) => (
                      <Row key={d.doc} label={<DocumentLabel d={d} />} style={{ borderTop: '1px solid var(--border)' }}>
                        <Amounts {...d.open} />
                      </Row>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
