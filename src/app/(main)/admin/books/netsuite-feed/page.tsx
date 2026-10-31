'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';

/**
 * Books → NetSuite feed (docs/books.md "NetSuite feed").
 *
 * Every send FleetSuite made to NetSuite, newest first, with what NetSuite
 * answered: it took it, refused it, or left FleetSuite unsure (no answer, a
 * timeout, a server error). NetSuite may have done an unsure one anyway, so
 * those wait at the top until a super admin has looked for them in NetSuite
 * and noted what they found. Super admins only, as the books are.
 */

type FeedOutcome = 'took' | 'refused' | 'unsure' | 'no_answer' | 'sending';
type Show = 'all' | 'took' | 'refused' | 'unsure';

interface FeedSend {
  id: string;
  at: string;
  answeredAt: string | null;
  what: string;
  outcome: FeedOutcome;
  status: number | null;
  error: string | null;
  docRef: string | null;
  netsuiteId: string | null;
  link: string | null;
  who: string | null;
  looked: { at: string; by: string | null; note: string | null } | null;
}

interface Payload {
  now: string;
  show: Show;
  kind: string | null;
  page: number;
  kinds: Array<{ key: string; name: string }>;
  summary: { days: number; took: number; refused: number; unsure: number };
  toLook: FeedSend[];
  sends: FeedSend[];
  more: boolean;
}

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const GREY = '#94a3b8';

const OUTCOMES: Record<FeedOutcome, { label: string; color: string }> = {
  took: { label: 'Took it', color: GREEN },
  refused: { label: 'Refused', color: RED },
  unsure: { label: 'Not sure', color: AMBER },
  no_answer: { label: 'No answer', color: AMBER },
  sending: { label: 'Sending', color: GREY },
};

const SHOWS: Array<{ key: Show; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'took', label: 'Took it' },
  { key: 'refused', label: 'Refused' },
  { key: 'unsure', label: 'Not sure' },
];

const when = (iso: string) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});

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

const card = (picked: boolean): React.CSSProperties => ({
  border: `1px solid ${picked ? AMBER : 'var(--border)'}`, borderRadius: '8px', padding: '10px 12px', background: 'var(--card)',
});

/** Who sent it, the number to find it by, and NetSuite's ID, on one line. */
function details(s: FeedSend): string {
  return [
    `Sent ${when(s.at)}${s.who ? ` by ${s.who}` : ''}`,
    s.docRef,
    s.netsuiteId ? `NetSuite ID ${s.netsuiteId}` : null,
  ].filter(Boolean).join(' · ');
}

export default function BooksNetsuiteFeedPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [kind, setKind] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  /** The send a link picked out (?send=…). */
  const [picked, setPicked] = useState('');
  /** The send being noted as looked at, once Looked at it is tapped, and the note typed. */
  const [noting, setNoting] = useState<{ id: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(async (next: { show: Show; kind: string; page: number }) => {
    try {
      const params = new URLSearchParams({ show: next.show, page: String(next.page) });
      if (next.kind) params.set('kind', next.kind);
      const res = await apiFetch(`/api/admin/books/netsuite-feed?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      // Show more adds the next page under what's shown.
      setData((was) => (next.page > 0 && was ? { ...json, sends: [...was.sends, ...json.sends] } : json));
      setError('');
    } catch (e: any) {
      setError(e?.message || "Couldn't read the NetSuite feed");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // The daily check's notification names the send it's about.
    setPicked(new URLSearchParams(window.location.search).get('send') ?? '');
    load({ show: 'all', kind: '', page: 0 });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  useEffect(() => {
    if (!picked || !data) return;
    document.getElementById(`send-${picked}`)?.scrollIntoView({ block: 'center' });
  }, [picked, data]);

  const narrow = (next: { show: Show; kind: string }) => {
    setShow(next.show);
    setKind(next.kind);
    setLoading(true);
    load({ ...next, page: 0 });
  };

  const showMore = () => {
    if (!data) return;
    setLoading(true);
    load({ show, kind, page: data.page + 1 });
  };

  const saveLook = async (id: string, note: string) => {
    setBusy(true);
    setActError(null);
    try {
      const res = await apiFetch('/api/admin/books/netsuite-feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, note }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setNoting(null);
      await load({ show, kind, page: 0 });
    } catch (e: any) {
      setActError({ id, message: e?.message || "Couldn't note it" });
    }
    setBusy(false);
  };

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>NetSuite feed</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Every send FleetSuite makes to NetSuite and what NetSuite answered. One FleetSuite isn&apos;t sure about stays at the top
          until someone has looked for it in NetSuite.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              Not sure means NetSuite didn&apos;t answer, took too long, or had a problem of its own, so it may have done it anyway.
              Look for it in NetSuite before anyone tries again. The daily check tells the super admins about each one once.
              Nothing a send carried is kept here, only what it was for and what NetSuite said. Visible only to super admins.
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link>
          {' · '}
          <Link href="/admin/books/switches" style={{ color: 'var(--text-secondary)' }}>Switches</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px', fontSize: '12px' }}>
            <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Last {data.summary.days} days:</span>
            <span style={chip(GREEN)}>{data.summary.took.toLocaleString('en-US')} took it</span>
            <span style={chip(data.summary.refused ? RED : GREY)}>{data.summary.refused.toLocaleString('en-US')} refused</span>
            <span style={chip(data.summary.unsure ? AMBER : GREY)}>{data.summary.unsure.toLocaleString('en-US')} not sure</span>
          </div>

          {data.toLook.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '14px', fontWeight: 800, marginBottom: '6px' }}>To look for in NetSuite</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {data.toLook.map((s) => {
                  const asking = noting?.id === s.id;
                  return (
                    <div key={s.id} id={`send-${s.id}`} style={card(picked === s.id)}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontSize: '14px', fontWeight: 800 }}>{s.what}</span>
                        <span style={chip(OUTCOMES[s.outcome].color)}>{OUTCOMES[s.outcome].label}</span>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{details(s)}</div>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: RED, marginTop: '2px' }}>
                        {s.error || "FleetSuite never heard back from NetSuite."}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        NetSuite may have done it anyway. Look for it there before anyone tries again.
                        {s.link && <>{' '}<a href={s.link} target="_blank" rel="noreferrer" style={{ color: 'inherit', fontWeight: 700 }}>Open in NetSuite</a></>}
                      </div>
                      <div style={{ marginTop: '8px' }}>
                        {asking ? (
                          <>
                            <input
                              value={noting.note}
                              onChange={(e) => setNoting({ id: s.id, note: e.target.value })}
                              placeholder="What did you find? (optional)"
                              maxLength={300}
                              disabled={busy}
                              style={input}
                            />
                            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                              <button onClick={() => saveLook(s.id, noting.note)} disabled={busy} style={act(GREEN, !busy)}>
                                {busy ? 'Saving…' : 'Save'}
                              </button>
                              <button onClick={() => { setNoting(null); setActError(null); }} disabled={busy} style={link}>Not yet</button>
                            </div>
                          </>
                        ) : (
                          <button onClick={() => { setNoting({ id: s.id, note: '' }); setActError(null); }} disabled={busy} style={act(null, !busy)}>
                            Looked at it
                          </button>
                        )}
                        {actError?.id === s.id && <div style={{ ...banner(RED), marginTop: '8px', marginBottom: 0 }}>{actError.message}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
            {SHOWS.map((o) => (
              <button key={o.key} onClick={() => narrow({ show: o.key, kind })} disabled={loading} style={button(o.key === show)}>
                {o.label}
              </button>
            ))}
            <select
              value={kind}
              onChange={(e) => narrow({ show, kind: e.target.value })}
              disabled={loading}
              style={{ ...button(!!kind), padding: '5px 8px' }}
              aria-label="Kind of record"
            >
              <option value="">Every kind</option>
              {data.kinds.map((k) => <option key={k.key} value={k.key}>{k.name}</option>)}
            </select>
          </div>

          {!data.sends.length && (
            <div style={banner(GREY)}>
              {show === 'all' && !kind ? "FleetSuite hasn't sent anything to NetSuite since the feed began." : 'No sends like that.'}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {data.sends.map((s) => (
              <div key={s.id} id={data.toLook.some((t) => t.id === s.id) ? undefined : `send-${s.id}`} style={card(picked === s.id)}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ fontSize: '13px', fontWeight: 700 }}>{s.what}</span>
                  <span style={chip(OUTCOMES[s.outcome].color)}>{OUTCOMES[s.outcome].label}</span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {details(s)}
                  {s.link && <>{' · '}<a href={s.link} target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>Open in NetSuite</a></>}
                </div>
                {s.error && s.outcome !== 'took' && (
                  <div style={{ fontSize: '12px', fontWeight: 600, color: RED }}>{s.error}</div>
                )}
                {s.looked && (
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Looked for in NetSuite{s.looked.by ? ` by ${s.looked.by}` : ''} {when(s.looked.at)}{s.looked.note ? `: ${s.looked.note}` : ''}
                  </div>
                )}
              </div>
            ))}
          </div>

          {data.more && (
            <div style={{ marginTop: '10px' }}>
              <button onClick={showMore} disabled={loading} style={button(false)}>{loading ? 'Loading…' : 'Show more'}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
