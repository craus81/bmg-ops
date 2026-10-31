'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';

/**
 * Books → Going live (docs/books.md "Going live").
 *
 * The entry that would open a company's books the day after a month ends,
 * customer by customer and vendor by vendor on the receivable and payable
 * accounts, what still differs from NetSuite's own totals then, what would
 * stop it posting, and a rehearsal: had the books gone live after that
 * month, how FleetSuite's balances since compare with NetSuite's. From
 * December 1, 2026, the tap that sets the books live on January 1, 2027,
 * which can't be undone; after it, the opening entries the posting run has
 * posted and why the next one waits. Super admins only, as the books are.
 */

interface Company {
  code: string;
  name: string;
  liveFrom: string | null;
}

interface Party {
  kind: 'customer' | 'vendor';
  party: string;
  name: string | null;
  cents: number;
}

interface Line {
  netsuiteAccountId: string;
  accountId: string | null;
  number: string | null;
  name: string;
  fleetsuite: number;
  netsuite: number;
  cents: number;
  /** On a receivable or payable account: the customers or vendors whose balance differs, together coming to `cents`. */
  parties?: Party[];
}

/** An opening entry the books have. */
interface Posted {
  id: string;
  entryNo: number;
  date: string;
  memo: string | null;
  postedAt: string;
  debit: number;
  lines: number;
  reversedBy: number | null;
}

interface Entry {
  month: string;
  date: string;
  liveFrom: string;
  lines: Line[];
  debit: number;
  credit: number;
  problems: string[];
}

interface Row {
  netsuiteAccountId: string | null;
  number: string | null;
  name: string;
  retained?: true;
  inChart: boolean;
  fleetsuite: number;
  netsuite: number;
}

interface Totals {
  debit: number;
  credit: number;
}

interface Payload {
  companies: Company[];
  company: string;
  liveFrom: string | null;
  plannedLiveFrom: string;
  /** The first day going live is offered. */
  goLiveFrom: string;
  month: string;
  months: string[];
  through: string;
  today: string;
  entry: Entry;
  rehearsal: { through: string; date: string; rows: Row[]; totals: { fleetsuite: Totals; netsuite: Totals }; differing: number } | null;
  openingEntries: Posted[];
  /** Once the books are live, why the opening entry for the day before won't post with the next posting run. */
  waiting: string | null;
  lastCopy: { at: string; syncedAt: string | null; error: string | null } | null;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents: number) => money.format(cents / 100);
const debitOf = (cents: number) => (cents > 0 ? fmt(cents) : '');
const creditOf = (cents: number) => (cents < 0 ? fmt(-cents) : '');
const balanceOf = (cents: number) => (cents === 0 ? '—' : cents > 0 ? `${fmt(cents)} Dr` : `${fmt(-cents)} Cr`);

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso: string) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
/** A day ('YYYY-MM-DD') moved by `days`. */
const addDay = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' };
const frame: React.CSSProperties = { overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '18px' };
const heading: React.CSSProperties = { fontSize: '14px', fontWeight: 800, marginBottom: '4px' };
const note: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' };
const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};

const partyName = (p: Party) => p.name || (p.kind === 'customer' ? 'No customer named' : 'No vendor named');
const counted = (n: number, kind: Party['kind']) => `${n} ${kind}${n === 1 ? '' : 's'}`;

export default function BooksGoingLivePage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [company, setCompany] = useState('');
  const [month, setMonth] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState('');
  const [going, setGoing] = useState(false);
  const [goError, setGoError] = useState('');
  const [more, setMore] = useState(false);

  const load = useCallback(async (nextCompany: string, nextMonth: string) => {
    try {
      const params = new URLSearchParams();
      if (nextCompany) params.set('company', nextCompany);
      if (nextMonth) params.set('month', nextMonth.slice(0, 7));
      const res = await apiFetch(`/api/admin/books/going-live?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setCompany(json.company);
      setMonth(json.month);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not work out the opening entry');
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
    if (nextCompany !== company) {
      setConfirm('');
      setGoError('');
    }
    load(nextCompany, nextMonth);
  };

  const toggle = (account: string) => setOpen((was) => {
    const next = new Set(was);
    if (next.has(account)) next.delete(account);
    else next.add(account);
    return next;
  });

  const goLive = async () => {
    setGoing(true);
    setGoError('');
    try {
      const res = await apiFetch('/api/admin/books/going-live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company, confirm }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setConfirm('');
      await load(company, '');
    } catch (e: any) {
      setGoError(e?.message || "Couldn't set the books live");
    }
    setGoing(false);
  };

  const entry = data?.entry;
  const rehearsal = data?.rehearsal;
  const name = data?.companies.find((c) => c.code === company)?.name ?? company;
  const years = [...new Set((data?.months ?? []).map((m) => m.slice(0, 4)))];
  const rows = (rehearsal?.rows ?? []).filter((r) => !onlyDifferences || r.fleetsuite !== r.netsuite);
  // Once the books are live, the month before is the one the posting run opens them at.
  const openingDay = data?.liveFrom ? entry?.liveFrom === data.liveFrom : false;
  const typed = confirm.trim().toUpperCase() === company.toUpperCase();
  const status = !entry ? null
    : entry.problems.length ? { label: `${entry.problems.length} to fix first`, color: '#ef4444' }
      : openingDay && entry.lines.length ? (data!.waiting ? { label: 'Waiting', color: '#f59e0b' } : { label: 'Posts with the next posting run', color: '#22c55e' })
        : entry.lines.length ? { label: 'Would post as it is', color: '#22c55e' }
          : openingDay && data!.openingEntries.length ? { label: 'Posted', color: '#22c55e' }
            : { label: 'Nothing to post', color: '#94a3b8' };

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Going live</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          The entry that opens FleetSuite&apos;s books at NetSuite&apos;s balances at the end of the month before they go live,
          and the tap that sets them live. Pick any month to see its entry and a rehearsal of going live after it. Visible only
          to super admins.{' '}
          <Link href="/admin/books/trial-balance" style={{ color: 'var(--text-secondary)' }}>Trial balance vs NetSuite</Link>
          {' · '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
          {' · '}
          <Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner('#ef4444')}>{error}</div>}

      {data && entry && (
        <>
          {data.liveFrom ? (
            <div style={banner('#22c55e')}>
              {name}&apos;s books {data.liveFrom > data.today ? 'go' : 'went'} live on {longDate(data.liveFrom)}. The posting run
              posts the opening entry once {longDate(addDay(data.liveFrom, -1))} is over.
            </div>
          ) : data.today < data.goLiveFrom ? (
            <div style={banner('#94a3b8')}>
              {name}&apos;s books aren&apos;t live yet. They&apos;re planned to go live on {longDate(data.plannedLiveFrom)}, and this page
              offers that from {longDate(data.goLiveFrom)}. It can&apos;t be undone.
            </div>
          ) : (
            <div style={{ ...banner('#ef4444'), background: 'var(--card)' }}>
              <div style={{ fontSize: '13px', fontWeight: 800, marginBottom: '4px' }}>
                Go live on {longDate(data.plannedLiveFrom)}. This can&apos;t be undone.
              </div>
              <div style={{ color: 'var(--text-secondary)', fontWeight: 500, marginBottom: '8px' }}>
                {name}&apos;s books then take nothing dated earlier but the opening entry.{' '}
                <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'What happens'}</button>
                {more && (
                  <span style={{ display: 'block', marginTop: '4px' }}>
                    The posting run posts the opening entry once {longDate(addDay(data.plannedLiveFrom, -1))} is over and
                    NetSuite&apos;s ledger has been copied since, and trues it up whenever NetSuite&apos;s numbers for that day
                    change. What NetSuite books for December after this tap comes in with the opening entry rather than
                    document by document, so the nearer to December 31 the better.
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={`Type ${company} to go live`}
                  disabled={going}
                  style={{
                    padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
                    color: 'var(--text-primary)', fontSize: '13px', width: '180px',
                  }}
                />
                <button
                  onClick={goLive}
                  disabled={!typed || going || loading}
                  style={{
                    padding: '6px 14px', borderRadius: '8px', border: 'none', background: '#ef4444', color: '#fff', fontSize: '13px',
                    fontWeight: 800, cursor: typed && !going ? 'pointer' : 'not-allowed', opacity: typed && !going ? 1 : 0.5,
                  }}
                >
                  {going ? 'Going live…' : 'Go live'}
                </button>
              </div>
              {goError && <div style={{ marginTop: '6px' }}>{goError}</div>}
            </div>
          )}
          {data.lastCopy?.error && (
            <div style={banner('#ef4444')}>The last copy of NetSuite&apos;s ledger failed {ago(data.lastCopy.at)}: {data.lastCopy.error}</div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {data.companies.map((c) => (
              <button key={c.code} onClick={() => pick(c.code, month)} disabled={loading} style={button(c.code === company)}>
                {c.name}
              </button>
            ))}
          </div>

          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '6px' }}>Balances at the end of</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
            {years.map((year) => (
              <div key={year} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ width: '40px', fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)' }}>{year}</span>
                {data.months.filter((m) => m.startsWith(year)).map((m) => (
                  <button key={m} onClick={() => pick(company, m)} disabled={loading} style={button(m === month)}>
                    {MONTH_NAMES[Number(m.slice(5, 7)) - 1].slice(0, 3)}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div style={heading}>
            Opening entry, {longDate(entry.date)}
            {status && <span style={{ ...chip(status.color), marginLeft: '8px' }}>{status.label}</span>}
          </div>
          <div style={note}>
            For books going live on {longDate(entry.liveFrom)}: each account FleetSuite&apos;s books have differently from
            NetSuite&apos;s on {longDate(entry.date)} brought to NetSuite&apos;s balance, customer by customer and vendor by vendor
            on receivables and payables, so the books open at NetSuite&apos;s numbers.
            {' '}<Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link> shows
            why they differ.
          </div>
          {openingDay && !entry.problems.length && data.waiting && <div style={banner('#f59e0b')}>{data.waiting}</div>}
          {entry.problems.length > 0 && (
            <div style={banner('#ef4444')}>
              <div style={{ marginBottom: '4px' }}>What would stop it posting:</div>
              <ul style={{ margin: 0, paddingLeft: '18px' }}>
                {entry.problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </div>
          )}
          <div style={frame}>
            <table style={table}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th style={{ ...cell, textAlign: 'left' }} colSpan={2}>Account</th>
                  <th style={cell}>FleetSuite has</th>
                  <th style={cell}>NetSuite has</th>
                  <th style={cell}>Debit</th>
                  <th style={cell}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {entry.lines.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                    FleetSuite&apos;s books match NetSuite&apos;s on {longDate(entry.date)}, line for line.
                  </td></tr>
                )}
                {entry.lines.map((l) => {
                  const parties = l.parties ?? [];
                  const shown = open.has(l.netsuiteAccountId);
                  // Split by customer or vendor, it posts a line for each, debits and credits both.
                  const debit = parties.length ? parties.reduce((t, p) => t + Math.max(0, p.cents), 0) : Math.max(0, l.cents);
                  const credit = parties.length ? parties.reduce((t, p) => t + Math.max(0, -p.cents), 0) : Math.max(0, -l.cents);
                  return (
                    <Fragment key={l.netsuiteAccountId}>
                      <tr style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...cell, textAlign: 'left', color: 'var(--text-muted)', width: '70px' }}>{l.number ?? ''}</td>
                        <td style={{ ...cell, textAlign: 'left', whiteSpace: 'normal' }}>
                          {l.name}
                          {!l.accountId && <span style={{ ...chip('#fbbf24'), marginLeft: '6px' }}>Not in the chart yet</span>}
                          {parties.length > 0 && (
                            <button onClick={() => toggle(l.netsuiteAccountId)} style={{ ...link, marginLeft: '8px' }}>
                              {shown ? 'Hide' : 'Show'} {counted(parties.length, parties[0].kind)}
                            </button>
                          )}
                        </td>
                        <td style={{ ...cell, color: 'var(--text-muted)' }}>{balanceOf(l.fleetsuite)}</td>
                        <td style={{ ...cell, color: 'var(--text-muted)' }}>{balanceOf(l.netsuite)}</td>
                        <td style={cell}>{debit ? fmt(debit) : ''}</td>
                        <td style={cell}>{credit ? fmt(credit) : ''}</td>
                      </tr>
                      {shown && parties.map((p) => (
                        <tr key={`${l.netsuiteAccountId}:${p.party}`} style={{ color: 'var(--text-secondary)' }}>
                          <td style={cell} />
                          <td style={{ ...cell, textAlign: 'left', whiteSpace: 'normal', paddingLeft: '22px' }} colSpan={3}>{partyName(p)}</td>
                          <td style={cell}>{debitOf(p.cents)}</td>
                          <td style={cell}>{creditOf(p.cents)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
                <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 800 }}>
                  <td style={{ ...cell, textAlign: 'left' }} colSpan={4}>Total</td>
                  <td style={cell}>{fmt(entry.debit)}</td>
                  <td style={cell}>{fmt(entry.credit)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {openingDay && data.openingEntries.length > 0 && (
            <>
              <div style={heading}>Opening entries posted</div>
              <div style={note}>
                The first opens the books; each after it trued them up to NetSuite&apos;s numbers for {longDate(entry.date)} again.
              </div>
              <div style={frame}>
                <table style={table}>
                  <thead>
                    <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                      <th style={{ ...cell, textAlign: 'left' }}>Entry</th>
                      <th style={{ ...cell, textAlign: 'left' }}>Memo</th>
                      <th style={cell}>Posted</th>
                      <th style={cell}>Lines</th>
                      <th style={cell}>In all</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.openingEntries.map((e) => (
                      <tr key={e.id} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...cell, textAlign: 'left' }}>
                          {e.entryNo}
                          {e.reversedBy !== null && <span style={{ ...chip('#94a3b8'), marginLeft: '6px' }}>Reversed by {e.reversedBy}</span>}
                        </td>
                        <td style={{ ...cell, textAlign: 'left', whiteSpace: 'normal' }}>{e.memo ?? ''}</td>
                        <td style={{ ...cell, color: 'var(--text-muted)' }}>{ago(e.postedAt)}</td>
                        <td style={cell}>{e.lines}</td>
                        <td style={cell}>{fmt(e.debit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div style={heading}>
            Had the books gone live on {longDate(entry.liveFrom)}
            {rehearsal && (
              <span style={{ ...chip(rehearsal.differing ? '#ef4444' : '#22c55e'), marginLeft: '8px' }}>
                {rehearsal.differing ? `${rehearsal.differing} of ${rehearsal.rows.length} lines differ` : 'Matches NetSuite'}
              </span>
            )}
          </div>
          {!rehearsal ? (
            <div style={note}>Nothing to rehearse yet: no month has ended since. Pick an earlier month.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: '8px' }}>
                <div style={{ ...note, marginBottom: 0, flex: '1 1 280px' }}>
                  Balances at {longDate(rehearsal.date)}{rehearsal.date >= data.today ? ' so far' : ''}: FleetSuite&apos;s books
                  opened at NetSuite&apos;s numbers on {longDate(entry.date)} with everything they have posted since, next to
                  NetSuite&apos;s own. Laid out as the trial balance is.
                </div>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <input type="checkbox" checked={onlyDifferences} onChange={(e) => setOnlyDifferences(e.target.checked)} />
                  Only lines that differ
                </label>
              </div>
              <div style={frame}>
                <table style={table}>
                  <thead>
                    <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                      <th style={{ ...cell, textAlign: 'left' }} colSpan={2}>Account</th>
                      <th style={cell}>FleetSuite debit</th>
                      <th style={cell}>FleetSuite credit</th>
                      <th style={cell}>NetSuite debit</th>
                      <th style={cell}>NetSuite credit</th>
                      <th style={cell}>Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr><td colSpan={7} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                        {onlyDifferences ? 'Every line matches.' : 'No balances yet.'}
                      </td></tr>
                    )}
                    {rows.map((r) => {
                      const diff = r.fleetsuite - r.netsuite;
                      return (
                        <tr key={r.netsuiteAccountId ?? 'retained'} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ ...cell, textAlign: 'left', color: 'var(--text-muted)', width: '70px' }}>{r.number ?? ''}</td>
                          <td style={{ ...cell, textAlign: 'left', whiteSpace: 'normal', fontStyle: r.retained ? 'italic' : 'normal' }}>
                            {r.name}
                            {!r.inChart && <span style={{ ...chip('#fbbf24'), marginLeft: '6px' }}>Not in the chart yet</span>}
                          </td>
                          <td style={cell}>{debitOf(r.fleetsuite)}</td>
                          <td style={cell}>{creditOf(r.fleetsuite)}</td>
                          <td style={cell}>{debitOf(r.netsuite)}</td>
                          <td style={cell}>{creditOf(r.netsuite)}</td>
                          <td style={{ ...cell, color: diff ? '#ef4444' : 'var(--text-muted)', fontWeight: diff ? 700 : 400 }}>
                            {diff ? fmt(diff) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                    <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 800 }}>
                      <td style={{ ...cell, textAlign: 'left' }} colSpan={2}>Total</td>
                      <td style={cell}>{fmt(rehearsal.totals.fleetsuite.debit)}</td>
                      <td style={cell}>{fmt(rehearsal.totals.fleetsuite.credit)}</td>
                      <td style={cell}>{fmt(rehearsal.totals.netsuite.debit)}</td>
                      <td style={cell}>{fmt(rehearsal.totals.netsuite.credit)}</td>
                      <td style={cell} />
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
      {loading && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
