'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess, booksAllows } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';

/**
 * Books → Months (docs/books.md "Closing a month").
 *
 * A company's months in FleetSuite's books since they went live, newest
 * first: whether each is closed, how it compares with NetSuite, and every
 * close and reopen. The first month that's open and over can be closed, the
 * latest one closed reopened, for a reason; closing one that doesn't match
 * NetSuite needs a reason too. A closed month takes nothing new, so what
 * NetSuite changes in it waits until it's reopened. Open to whoever opens the
 * books.
 */

interface Company {
  code: string;
  name: string;
  liveFrom: string | null;
}

interface MonthEvent {
  action: 'closed' | 'reopened';
  by: string | null;
  reason: string | null;
  at: string;
}

interface Month {
  month: string;
  over: boolean;
  closed: { at: string | null; by: string | null } | null;
  compared: { status: 'matches' | 'differs' | 'none'; differing: number; notPosted: boolean };
  events: MonthEvent[];
  can: 'close' | 'reopen' | null;
}

interface Payload {
  companies: Company[];
  company: string;
  liveFrom: string | null;
  plannedLiveFrom: string;
  today: string;
  months: Month[];
}

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const GREY = '#94a3b8';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const longDate = (iso: string) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});
const accounts = (n: number) => `${n} account${n === 1 ? '' : 's'}`;

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

const act = (color: string | null, enabled: boolean): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
  border: color ? 'none' : '1px solid var(--border)', background: color ?? 'var(--card)', color: color ? '#fff' : 'var(--text-primary)',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
});

const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};

const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border)',
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px', marginBottom: '8px',
};

/** How the month compares with NetSuite, in words and a colour. */
function compared(m: Month): { words: string; color: string; differs: boolean } {
  if (m.compared.status === 'differs') return { words: `Doesn't match NetSuite on ${accounts(m.compared.differing)}`, color: AMBER, differs: true };
  if (m.compared.notPosted) return { words: "NetSuite has documents FleetSuite doesn't post yet", color: AMBER, differs: true };
  if (m.compared.status === 'matches') return { words: 'Matches NetSuite', color: GREEN, differs: false };
  return { words: 'Nothing posted', color: GREY, differs: false };
}

export default function BooksMonthsPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  // The bookkeeper closes months too; only a super admin reopens one, and the CPA reads.
  const access = booksAccess(hasRole);
  const canClose = booksAllows(access, 'keep');
  const canReopen = booksAllows(access, 'owner');
  const [data, setData] = useState<Payload | null>(null);
  const [company, setCompany] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [history, setHistory] = useState<Set<string>>(new Set());
  /** The month being reopened, once Reopen is tapped: it asks why first. */
  const [reopening, setReopening] = useState('');
  /** The reason typed, and the month it's for. */
  const [typed, setTyped] = useState<{ month: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<{ month: string; message: string } | null>(null);

  const load = useCallback(async (nextCompany: string) => {
    try {
      const params = new URLSearchParams();
      if (nextCompany) params.set('company', nextCompany);
      const res = await apiFetch(`/api/admin/books/months?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setCompany(json.company);
      setError('');
    } catch (e: any) {
      setError(e?.message || "Couldn't read the months");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // A link may name the company (?company=BMG), as Differences vs NetSuite's does.
    load(new URLSearchParams(window.location.search).get('company') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const pick = (nextCompany: string) => {
    setLoading(true);
    setReopening('');
    setTyped(null);
    setActError(null);
    load(nextCompany);
  };

  const toggle = (month: string) => setHistory((was) => {
    const next = new Set(was);
    if (next.has(month)) next.delete(month);
    else next.add(month);
    return next;
  });

  const change = async (month: string, action: 'close' | 'reopen', reason: string) => {
    setBusy(true);
    setActError(null);
    try {
      const res = await apiFetch('/api/admin/books/months', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company, month: month.slice(0, 7), action, reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setReopening('');
      setTyped(null);
      await load(company);
    } catch (e: any) {
      setActError({ month, message: e?.message || `Couldn't ${action} ${monthName(month)}` });
    }
    setBusy(false);
  };

  const name = data?.companies.find((c) => c.code === company)?.name ?? company;
  const firstMonth = data ? (data.liveFrom ?? data.plannedLiveFrom) : '';

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Months</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Close each month in FleetSuite&apos;s books once it&apos;s over, in order. A closed month takes nothing new, so what NetSuite
          changes in it waits until it&apos;s reopened.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              Reopening needs a reason, and so does closing a month that doesn&apos;t match NetSuite. Each close and reopen is kept
              with who did it and why. The bookkeeper and super admins close months, and only a super admin reopens one.
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link>
          {' · '}
          <Link href={deepLinks.booksInventoryValue()} style={{ color: 'var(--text-secondary)' }}>Inventory value</Link>
          {' · '}
          <Link href={deepLinks.booksSalesTax()} style={{ color: 'var(--text-secondary)' }}>Sales tax</Link>
          {' · '}
          <Link href="/admin/books/going-live" style={{ color: 'var(--text-secondary)' }}>Going live</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {data.companies.map((c) => (
              <button key={c.code} onClick={() => pick(c.code)} disabled={loading} style={button(c.code === company)}>
                {c.name}
              </button>
            ))}
          </div>

          {!data.months.length && (
            <div style={banner(GREY)}>
              {data.liveFrom
                ? `${name}'s books go live on ${longDate(data.liveFrom)}.`
                : `${name}'s books aren't live yet.`}{' '}
              Closing months starts with {monthName(firstMonth)}, once it&apos;s over.
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {data.months.map((m) => {
              const look = compared(m);
              const status = m.closed ? { label: 'Closed', color: GREEN } : m.over ? { label: 'Open', color: GREY } : { label: 'Not over yet', color: GREY };
              const asking = reopening === m.month;
              const needsReason = (m.can === 'close' && look.differs) || asking;
              const reason = typed?.month === m.month ? typed.reason : '';
              const ready = !busy && (!needsReason || !!reason.trim());
              const short = MONTH_NAMES[Number(m.month.slice(5, 7)) - 1];
              return (
                <div key={m.month} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px', background: 'var(--card)' }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 800 }}>{monthName(m.month)}</span>
                    <span style={chip(status.color)}>{status.label}</span>
                  </div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: look.color }}>
                    {look.differs
                      ? <Link href={`/admin/books/differences?${new URLSearchParams({ company, month: m.month.slice(0, 7) })}`} style={{ color: 'inherit' }}>{look.words}</Link>
                      : look.words}
                  </div>
                  {m.closed && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      Closed{m.closed.by ? ` by ${m.closed.by}` : ''}{m.closed.at ? ` ${when(m.closed.at)}` : ''}
                    </div>
                  )}

                  {((m.can === 'close' && canClose) || (asking && canReopen)) && (
                    <div style={{ marginTop: '8px' }}>
                      {needsReason && (
                        <input
                          value={reason}
                          onChange={(e) => setTyped({ month: m.month, reason: e.target.value })}
                          placeholder={asking ? 'Why reopen it?' : 'Why close it anyway?'}
                          maxLength={500}
                          disabled={busy}
                          style={input}
                        />
                      )}
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {asking ? (
                          <>
                            <button onClick={() => change(m.month, 'reopen', reason)} disabled={!ready} style={act(GREEN, ready)}>
                              {busy ? 'Reopening…' : `Reopen ${short}`}
                            </button>
                            <button onClick={() => { setReopening(''); setTyped(null); setActError(null); }} disabled={busy} style={act(null, !busy)}>
                              Keep it closed
                            </button>
                          </>
                        ) : (
                          <button onClick={() => change(m.month, 'close', needsReason ? reason : '')} disabled={!ready} style={act(GREEN, ready)}>
                            {busy ? 'Closing…' : `Close ${short}`}
                          </button>
                        )}
                      </div>
                      {actError?.month === m.month && <div style={{ ...banner(RED), marginTop: '8px', marginBottom: 0 }}>{actError.message}</div>}
                    </div>
                  )}
                  {m.can === 'reopen' && canReopen && !asking && (
                    <div style={{ marginTop: '8px' }}>
                      <button onClick={() => { setReopening(m.month); setTyped(null); setActError(null); }} disabled={busy} style={act(null, !busy)}>
                        Reopen
                      </button>
                    </div>
                  )}

                  {m.events.length > 0 && (
                    <div style={{ marginTop: '6px' }}>
                      <button onClick={() => toggle(m.month)} style={link}>{history.has(m.month) ? 'Hide history' : 'History'}</button>
                      {history.has(m.month) && (
                        <ul style={{ margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {[...m.events].reverse().map((e, i) => (
                            <li key={i}>
                              {e.action === 'closed' ? 'Closed' : 'Reopened'}{e.by ? ` by ${e.by}` : ''} {when(e.at)}{e.reason ? `: ${e.reason}` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
