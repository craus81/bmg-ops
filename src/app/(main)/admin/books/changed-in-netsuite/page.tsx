'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import type { Act, Change } from '@/lib/fleetsuite-records';

/**
 * Books → Changed in NetSuite (docs/books.md "FleetSuite's record wins").
 *
 * Once FleetSuite's record wins is switched on, a change made in NetSuite to a
 * customer's name, email, phone or billing address, to a vendor's name, email
 * or phone, or to an item's number, display name, description, purchase
 * price, vendor or labor hours, doesn't come into FleetSuite over what
 * FleetSuite has. Each one is listed here, newest first, to keep FleetSuite's,
 * which sends it on to NetSuite (an item's vendor and labor hours stay in
 * FleetSuite), or take NetSuite's into FleetSuite. One a sync finds the same
 * in both again goes by itself. Super admins only, as the books are.
 */

interface Payload {
  on: boolean;
  open: Change[];
  closed: Change[];
  more: boolean;
}

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const GREY = '#94a3b8';

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

const act = (color: string | null, enabled: boolean): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
  border: color ? 'none' : '1px solid var(--border)', background: color ?? 'var(--card)', color: color ? '#fff' : 'var(--text-primary)',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
});

const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};

const card = (picked: boolean): React.CSSProperties => ({
  border: `1px solid ${picked ? AMBER : 'var(--border)'}`, borderRadius: '8px', padding: '10px 12px', background: 'var(--card)',
});

const KIND_COLORS: Record<Change['kind'], string> = { customer: '#3b82f6', vendor: '#a855f7', item: '#14b8a6' };

/** What each side has, one under the other. */
function Values({ c, size }: { c: Change; size: string }) {
  const label: React.CSSProperties = { color: 'var(--text-muted)', fontWeight: 700 };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', fontSize: size, overflowWrap: 'anywhere' }}>
      <span style={label}>FleetSuite</span><span>{c.fleetsuite}</span>
      <span style={label}>NetSuite</span><span>{c.netsuite}</span>
    </div>
  );
}

/** How one that's done went. */
function outcome(c: Change): string {
  const by = c.closedBy ? ` by ${c.closedBy}` : '';
  const at = c.closedAt ? ` ${when(c.closedAt)}` : '';
  if (c.status === 'kept') return c.sent === false ? `FleetSuite's kept in FleetSuite${by}${at}` : `FleetSuite's kept and sent on to NetSuite${by}${at}`;
  if (c.status === 'taken') return `NetSuite's taken into FleetSuite${by}${at}`;
  return `The same in both again${at}`;
}

export default function BooksChangedInNetsuitePage() {
  const router = useRouter();
  const dialog = useDialog();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [showDone, setShowDone] = useState(false);
  /** The change a link picked out (?change=…). */
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState<{ id: string; how: Act } | null>(null);
  const [actError, setActError] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/books/changed-in-netsuite');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
    } catch (e: any) {
      setError(e?.message || "Couldn't read what changed in NetSuite");
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // The daily check's notification names the change it's about.
    setPicked(new URLSearchParams(window.location.search).get('change') ?? '');
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  useEffect(() => {
    if (!picked || !data) return;
    // One that's been done meanwhile is under Done lately.
    if (!showDone && data.closed.some((c) => c.id === picked)) { setShowDone(true); return; }
    document.getElementById(`change-${picked}`)?.scrollIntoView({ block: 'center' });
  }, [picked, data, showDone]);

  const decide = async (c: Change, how: Act) => {
    const field = c.fieldName.toLowerCase();
    const ok = await dialog.confirm(
      how === 'keep'
        ? c.sends
          ? `Keep FleetSuite's ${field} for ${c.name}? FleetSuite sends "${c.fleetsuite}" to NetSuite in place of "${c.netsuite}".`
          : `Keep FleetSuite's ${field} for ${c.name}? FleetSuite keeps "${c.fleetsuite}" and nothing goes to NetSuite, which stays "${c.netsuite}". It's listed again only if NetSuite's changes.`
        : `Take NetSuite's ${field} for ${c.name}? FleetSuite's record changes to "${c.netsuite}" from "${c.fleetsuite}". Nothing goes to NetSuite.`,
      { confirmLabel: how === 'keep' ? "Keep FleetSuite's" : "Take NetSuite's", cancelLabel: 'Not now', title: c.name },
    );
    if (!ok) return;
    setBusy({ id: c.id, how });
    setActError(null);
    try {
      const res = await apiFetch('/api/admin/books/changed-in-netsuite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.id, act: how }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      await load();
    } catch (e: any) {
      setActError({ id: c.id, message: e?.message || "Couldn't do it" });
    }
    setBusy(null);
  };

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Changed in NetSuite</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          A customer&apos;s, vendor&apos;s or item&apos;s details changed in NetSuite wait here instead of coming over FleetSuite&apos;s.
          Keep FleetSuite&apos;s, which sends it on to NetSuite, or take NetSuite&apos;s.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              That&apos;s a customer&apos;s name, email, phone and billing address, a vendor&apos;s name, email and phone, and an item&apos;s
              number, display name, description, purchase price, vendor and labor hours. An item&apos;s vendor and labor hours stay in
              FleetSuite, so keeping FleetSuite&apos;s sends nothing for those. Where FleetSuite has none, NetSuite&apos;s comes in by itself,
              and so does a new customer, vendor or item; where NetSuite has none for an item, FleetSuite&apos;s stays and nothing is
              listed. One a sync finds the same in both again goes off the list by itself. The daily check tells the super admins
              about each new one once. Visible only to super admins.
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href="/admin/books/switches" style={{ color: 'var(--text-secondary)' }}>Switches</Link>
          {' · '}
          <Link href="/admin/books/netsuite-feed" style={{ color: 'var(--text-secondary)' }}>NetSuite feed</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          {!data.on && (
            <div style={banner(GREY)}>
              FleetSuite&apos;s record wins is switched off, so NetSuite&apos;s changes come into FleetSuite as they do now
              {data.open.length ? ", and these can't be kept or taken until it's on." : ' and nothing waits here.'}{' '}
              <Link href="/admin/books/switches" style={{ color: 'inherit', fontWeight: 700 }}>Switches</Link>
            </div>
          )}

          {data.on && !data.open.length && (
            <div style={banner(GREY)}>Nothing waiting. A change made in NetSuite shows here once the next sync reads it.</div>
          )}

          {data.more && (
            <div style={banner(AMBER)}>These are the newest {data.open.length}. The rest show once some of these are done.</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {data.open.map((c) => {
              const enabled = data.on && !busy;
              return (
                <div key={c.id} id={`change-${c.id}`} style={card(picked === c.id)}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '2px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 800 }}>{c.name}</span>
                    <span style={chip(KIND_COLORS[c.kind] ?? GREY)}>{c.kindName}</span>
                  </div>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '4px' }}>{c.fieldName}</div>
                  <Values c={c} size="13px" />
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Seen {when(c.firstSeenAt)}{c.lastSeenAt !== c.firstSeenAt ? `, again ${when(c.lastSeenAt)}` : ''}
                    {c.link && <>{' · '}<a href={c.link} target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>Open in NetSuite</a></>}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                    <button onClick={() => decide(c, 'keep')} disabled={!enabled} style={act(GREEN, enabled)}>
                      {busy?.id === c.id && busy.how === 'keep' ? (c.sends ? 'Sending…' : 'Keeping…') : "Keep FleetSuite's"}
                    </button>
                    <button onClick={() => decide(c, 'take')} disabled={!enabled} style={act(null, enabled)}>
                      {busy?.id === c.id && busy.how === 'take' ? 'Taking…' : "Take NetSuite's"}
                    </button>
                  </div>
                  {actError?.id === c.id && <div style={{ ...banner(RED), marginTop: '8px', marginBottom: 0 }}>{actError.message}</div>}
                </div>
              );
            })}
          </div>

          {data.closed.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <button onClick={() => setShowDone(!showDone)} style={{ ...link, fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
                {showDone ? '▾' : '▸'} Done lately ({data.closed.length})
              </button>
              {showDone && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                  {data.closed.map((c) => (
                    <div key={c.id} id={`change-${c.id}`} style={card(picked === c.id)}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <span style={{ fontSize: '13px', fontWeight: 700 }}>{c.name} · {c.fieldName}</span>
                        <span style={chip(KIND_COLORS[c.kind] ?? GREY)}>{c.kindName}</span>
                      </div>
                      <Values c={c} size="12px" />
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{outcome(c)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
