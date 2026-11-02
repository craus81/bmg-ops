'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { ChangeArea, ChangeOp, ChangeShow, ChangeVia, ShownChange } from '@/lib/books/money-changes';

/**
 * Books → Change history (docs/books.md "Change history").
 *
 * Every change to a row of FleetSuite's books, newest first: which record,
 * what changed from what to what, how it was made and, where FleetSuite
 * knows, who made it. A change made outside FleetSuite (straight in the
 * database, or from a browser signed in to it) stands out, and the daily
 * check tells the super admins about it once. Any change opens its record's
 * whole history. Open to whoever opens the books; the vendors' bank numbers
 * and the ACH setups and files to super admins only.
 */

type RowKey = Record<string, string | number | boolean>;

interface Payload {
  now: string;
  show: ChangeShow;
  area: ChangeArea | null;
  table: string | null;
  tableWhat: string | null;
  key: RowKey | null;
  page: number;
  shows: Array<{ key: ChangeShow; name: string }>;
  areas: Array<{ key: ChangeArea; name: string }>;
  summary: { days: number; fleetsuite: number; outside: number; updates: number };
  changes: ShownChange[];
  more: boolean;
}

/** What the page asks for: how changes were made, an area, or one record's history. */
interface Ask {
  show: ChangeShow;
  area: ChangeArea | '';
  row: { table: string; key: RowKey } | null;
}

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const BLUE = '#3b82f6';
const GREY = '#94a3b8';

const OPS: Record<ChangeOp, { label: string; color: string }> = {
  insert: { label: 'Added', color: GREEN },
  update: { label: 'Changed', color: AMBER },
  delete: { label: 'Removed', color: RED },
};

const VIAS: Record<ChangeVia, { label: string; color: string }> = {
  server: { label: 'In FleetSuite', color: GREY },
  screen: { label: 'Outside FleetSuite', color: RED },
  database: { label: 'Outside FleetSuite', color: RED },
  migration: { label: 'FleetSuite update', color: BLUE },
};

/** Columns a change shows before Show all. */
const COLUMNS_SHOWN = 6;

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

const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};

const card = (outside: boolean): React.CSSProperties => ({
  border: `1px solid ${outside ? `${RED}66` : 'var(--border)'}`, borderRadius: '8px', padding: '10px 12px', background: 'var(--card)',
});

const muted: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)' };

/** One column's change in a line: from → to, what it was set to, or what it was. */
function columnLine(c: ShownChange['columns'][number]): string {
  if (c.from === null) return c.to ?? '';
  if (c.to === null) return `was ${c.from}`;
  return `${c.from} → ${c.to}`;
}

/** What the page asked for, from the link it was opened with. */
function askOf(search: string): Ask {
  const params = new URLSearchParams(search);
  const show = (['outside', 'fleetsuite', 'updates'] as const).find((s) => s === params.get('show')) ?? 'all';
  const table = params.get('table');
  let key: RowKey | null = null;
  try {
    const parsed = JSON.parse(params.get('key') ?? 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) key = parsed as RowKey;
  } catch {
    key = null;
  }
  return { show, area: (params.get('area') as ChangeArea | null) ?? '', row: table && key ? { table, key } : null };
}

export default function BooksChangeHistoryPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [ask, setAsk] = useState<Ask>({ show: 'all', area: '', row: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  /** The changes showing every column they changed. */
  const [open, setOpen] = useState<Set<number>>(new Set());

  const load = useCallback(async (next: Ask, page: number) => {
    try {
      const params = new URLSearchParams({ show: next.show, page: String(page) });
      if (next.row) {
        params.set('table', next.row.table);
        params.set('key', JSON.stringify(next.row.key));
      } else if (next.area) {
        params.set('area', next.area);
      }
      const res = await apiFetch(`/api/admin/books/change-history?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      // Show more adds the next page under what's shown.
      setData((was) => (page > 0 && was ? { ...json, changes: [...was.changes, ...json.changes] } : json));
      setError('');
    } catch (e: any) {
      setError(e?.message || "Couldn't read the change history");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // The daily check's notification asks for the changes made outside FleetSuite; an ACH setup's, for its history.
    const first = askOf(window.location.search);
    setAsk(first);
    load(first, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const narrow = (next: Ask) => {
    setAsk(next);
    setOpen(new Set());
    setLoading(true);
    load(next, 0);
    window.scrollTo({ top: 0 });
  };

  const showMore = () => {
    if (!data) return;
    setLoading(true);
    load(ask, data.page + 1);
  };

  const toggle = (id: number) => setOpen((was) => {
    const next = new Set(was);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const rowName = ask.row && data?.changes.length ? data.changes[0].name : null;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Change history</div>
        <div style={muted}>
          Every change to FleetSuite&apos;s books: what changed, from what to what, who made it and how. One made outside
          FleetSuite, straight in the database, is marked in red.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              Every change to the money settings and documents is kept: switches, the chart, months and years, payment runs,
              checks, bank numbers, payments and deposits, journal entries, credits and fixes, card charges, sales tax, own
              numbers, rent and mortgage, bank reconciliations and stock. For the rest of the books, the journal and the copies
              FleetSuite makes itself, only a change made outside FleetSuite is. Bank account numbers are never shown here, only
              that they changed. Changes stay: nobody can edit or remove them. The daily check tells the super admins about each
              change made outside FleetSuite once.
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href={deepLinks.booksBackups()} style={{ color: 'var(--text-secondary)' }}>Backups</Link>
          {' · '}
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
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px', fontSize: '12px' }}>
            <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Last {data.summary.days} days:</span>
            <span style={chip(GREY)}>{data.summary.fleetsuite.toLocaleString('en-US')} in FleetSuite</span>
            <span style={chip(data.summary.outside ? RED : GREY)}>{data.summary.outside.toLocaleString('en-US')} outside FleetSuite</span>
            <span style={chip(data.summary.updates ? BLUE : GREY)}>{data.summary.updates.toLocaleString('en-US')} by updates</span>
          </div>

          {ask.row ? (
            <div style={{ ...banner(GREY), color: 'var(--text-primary)' }}>
              The history of one {(data.tableWhat ?? 'record').toLowerCase()}{rowName ? `: ${rowName}` : ''}.{' '}
              <button onClick={() => narrow({ show: ask.show, area: '', row: null })} disabled={loading} style={link}>Show every change</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
              {data.shows.map((o) => (
                <button key={o.key} onClick={() => narrow({ ...ask, show: o.key })} disabled={loading} style={button(o.key === ask.show)}>
                  {o.name}
                </button>
              ))}
              <select
                value={ask.area}
                onChange={(e) => narrow({ ...ask, area: e.target.value as ChangeArea | '' })}
                disabled={loading}
                style={{ ...button(!!ask.area), padding: '5px 8px', fontSize: '16px' }}
                aria-label="Kind of record"
              >
                <option value="">Every kind</option>
                {data.areas.map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
              </select>
            </div>
          )}

          {!data.changes.length && (
            <div style={banner(GREY)}>
              {ask.row
                ? 'No changes to this record are kept.'
                : ask.show === 'all' && !ask.area ? 'No changes yet: the history starts with the update that made it.' : 'No changes like that.'}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {data.changes.map((c) => {
              const all = open.has(c.id);
              const columns = all ? c.columns : c.columns.slice(0, COLUMNS_SHOWN);
              return (
                <div key={c.id} style={card(c.outside)}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13px', fontWeight: 800 }}>{c.what}</span>
                    <span style={chip(OPS[c.op].color)}>{OPS[c.op].label}</span>
                    <span style={chip(VIAS[c.via].color)}>{VIAS[c.via].label}</span>
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>{c.name}</div>
                  <div style={{ ...muted, color: c.outside ? RED : 'var(--text-muted)', fontWeight: c.outside ? 600 : 400 }}>
                    {when(c.at)} · {c.how}
                  </div>
                  {columns.length > 0 && (
                    <div style={{ marginTop: '4px', display: 'grid', gap: '2px' }}>
                      {columns.map((col) => (
                        <div key={col.column} style={{ fontSize: '12px', overflowWrap: 'anywhere' }}>
                          <span style={{ color: 'var(--text-muted)' }}>{col.label}:</span> {columnLine(col)}
                        </div>
                      ))}
                    </div>
                  )}
                  {c.outside && (
                    <div style={{ ...muted, marginTop: '2px' }}>
                      {c.toldAt ? `The super admins were told ${when(c.toldAt)}.` : 'The daily check tells the super admins at its next look.'}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '12px', marginTop: '4px', flexWrap: 'wrap' }}>
                    {c.columns.length > COLUMNS_SHOWN && (
                      <button onClick={() => toggle(c.id)} style={link}>{all ? 'Show fewer' : `Show all ${c.columns.length}`}</button>
                    )}
                    {!ask.row && (
                      <button onClick={() => narrow({ show: 'all', area: '', row: { table: c.table, key: c.key as RowKey } })} disabled={loading} style={link}>
                        This record&apos;s history
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
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
