'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { CountsBy, StockMove, StockPlace } from '@/lib/books/stock-items';

/**
 * Books → Stock by item → one item (migration 401, src/lib/books/stock-items.ts,
 * docs/books.md "Stock by item").
 *
 * Where the item stood on December 31, 2024 at each location, where FleetSuite
 * has it now next to NetSuite's own count, and every NetSuite document since
 * that moved it, oldest first, each with the count it left at its location.
 * Opened from Stock by item, or from the daily check's notification about the
 * item, which names a location (?location=) to pick out. Says when NetSuite
 * has the item's asset account wrong (migration 403) and where it has value
 * left over, with the moves that posted its value the wrong way round (owner
 * decision 2026-10-19, "Flag them"). Super admins only.
 */

interface Payload {
  item: { id: string; name: string; description: string | null; active: boolean };
  readAt: string | null;
  places: StockPlace[];
  moves: StockMove[];
  more: number;
  by: CountsBy | null;
  netsuite: { quantity: number; value: number | null } | null;
  leftover: Array<{ locationId: string | null; location: string | null; value: number }>;
  /** When NetSuite has the item's asset account as something other than an asset account: that account, and the one most stocked items use. */
  setup: { account: string; accountKind: string; usual: string | null } | null;
}

type Show = 'count' | 'value';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
/** A quantity as people write one: no trailing zeros, thousands grouped (as quantityText in stock-items.ts). */
const qty = (n: number) => {
  const rounded = Math.round(n * 1e5) / 1e5;
  return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString('en-US', { maximumFractionDigits: 5 });
};
const signed = (n: number) => (n > 0 ? `+${qty(n)}` : qty(n));
/** Counts closer than this are the same (compareStock's). */
const SAME = 1e-6;

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
const amountHead: React.CSSProperties = { ...cell, width: '15%' };

/**
 * A row of a table: its label, then `span` amounts. On a phone the label
 * takes a row of its own above them (.rep-label-row in globals.css), as on
 * Reports, and can say more there (`phoneLabel`) for a column a phone hides.
 */
function Row({ label, phoneLabel, span, id, style, children }: {
  label: React.ReactNode; phoneLabel?: React.ReactNode; span: number; id?: string; style?: React.CSSProperties; children: React.ReactNode;
}) {
  return (
    <>
      <tr className="rep-label-row" style={style}><td colSpan={span} style={labelCell}>{phoneLabel ?? label}</td></tr>
      <tr id={id} className="rep-amounts" style={style}>
        <td className="rep-label" style={labelCell}>{label}</td>
        {children}
      </tr>
    </>
  );
}

/** A count or a value, as the toggle shows. */
const amount = (show: Show, side: { quantity: number; value: number | null } | null) => {
  if (!side) return '—';
  if (show === 'count') return qty(side.quantity);
  return side.value === null ? '—' : fmt(side.value);
};

/** A location, with where the item started there: a phone's line for the column it hides. */
function Started({ name, start }: { name: string; start: string }) {
  return (
    <div>
      <div>{name}</div>
      <div style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text-muted)' }}>{start} on Dec 31, 2024</div>
    </div>
  );
}

/**
 * FleetSuite's less NetSuite's, red when they differ, amber when it's value
 * left over (explained above the table); nothing when NetSuite has no count
 * to compare.
 */
function Difference({ show, ours, theirs, leftover = false }: {
  show: Show; ours: { quantity: number; value: number }; theirs: { quantity: number; value: number | null } | null; leftover?: boolean;
}) {
  let text = '—';
  if (theirs && show === 'count' && Math.abs(ours.quantity - theirs.quantity) >= SAME) text = signed(ours.quantity - theirs.quantity);
  if (theirs && show === 'value' && theirs.value !== null && ours.value !== theirs.value) text = fmt(ours.value - theirs.value);
  const differs = text !== '—';
  const color = !differs ? 'var(--text-muted)' : leftover && show === 'value' ? AMBER : RED;
  return <td style={{ ...cell, color, fontWeight: differs ? 700 : 400 }}>{text}</td>;
}

/** A move: its date, type and number (opening its check on Invoices vs NetSuite), and where, unless only one location's moves are listed. */
function MoveLabel({ m, where }: { m: StockMove; where: boolean }) {
  const number = m.check
    ? <Link href={deepLinks.booksDocument(m.company, m.check.kind, m.check.month, m.documentId)} className="rep-link" style={{ fontWeight: 700 }}>{m.number}</Link>
    : <span style={{ fontWeight: 700 }}>{m.number}</span>;
  return (
    <div>
      <span style={{ color: 'var(--text-muted)', marginRight: '8px' }}>{dayText(m.date)}</span>
      <span style={{ color: 'var(--text-secondary)', marginRight: '6px' }}>{m.typeName}</span>
      {number}
      {where && m.location && <span style={{ marginLeft: '6px' }}>· {m.location}</span>}
      {m.company !== 'BMG' && <span style={{ ...chip('#60a5fa'), marginLeft: '6px' }}>{m.company}</span>}
    </div>
  );
}

export default function BooksStockItemPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [show, setShow] = useState<Show>('count');
  /** The location the link picked out, and the one whose moves are listed ('' for every location). */
  const [picked, setPicked] = useState('');
  const [where, setWhere] = useState('');

  const load = useCallback(async (item: string) => {
    try {
      const res = await apiFetch(`/api/admin/books/stock/item?${new URLSearchParams({ item })}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the item');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // Stock by item and the daily check link here with the item and, when it's about one, its location (deepLinks.booksStockItem).
    const q = new URLSearchParams(window.location.search);
    const location = q.get('location') ?? '';
    setPicked(location);
    setWhere(location);
    load(q.get('item') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  useEffect(() => {
    if (data && picked) document.getElementById(`place-${picked}`)?.scrollIntoView({ block: 'center' });
  }, [data, picked]);

  const moves = useMemo(() => (data?.moves ?? []).filter((m) => !where || m.locationId === where), [data, where]);
  const backwards = useMemo(() => (data?.moves ?? []).filter((m) => m.backwards).length, [data]);
  const leftoverAt = useMemo(() => new Set((data?.leftover ?? []).map((l) => l.locationId ?? '')), [data]);
  const leftoverValue = (data?.leftover ?? []).reduce((total, l) => total + l.value, 0);
  const leftoverWhere = (data?.leftover ?? []).map((l) => l.location).filter(Boolean).join(', ');

  const total = useMemo(() => {
    const places = data?.places ?? [];
    const add = (pick: (p: StockPlace) => { quantity: number; value: number }) => places.reduce(
      (sum, p) => ({ quantity: sum.quantity + pick(p).quantity, value: sum.value + pick(p).value }), { quantity: 0, value: 0 });
    return { start: add((p) => p.start), fleetsuite: add((p) => p.fleetsuite) };
  }, [data]);
  const countDiff = data?.netsuite ? total.fleetsuite.quantity - data.netsuite.quantity : 0;
  // The whole item's difference is amber when value left over is all of it.
  const allLeftover = !!data?.netsuite && data.netsuite.value !== null && leftoverValue !== 0
    && total.fleetsuite.value - data.netsuite.value === leftoverValue;
  const differs = Math.abs(countDiff) >= SAME;
  // A location NetSuite counts none of the item at: nothing there, valued at nothing when NetSuite gives values.
  const theirs = (p: StockPlace) => p.netsuite ?? { quantity: 0, value: data?.netsuite?.value === null ? null : 0 };

  return (
    <div>
      <div style={{ marginBottom: '8px', fontSize: '12px' }}>
        <Link href={deepLinks.booksStock()} style={{ color: 'var(--text-secondary)' }}>← Stock by item</Link>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '20px', fontWeight: 800 }}>
              {data.item.name}
              {data.by && (
                <span style={{ ...chip(differs ? RED : GREEN), marginLeft: '8px', verticalAlign: 'middle' }}>
                  {differs ? `Count differs by ${signed(countDiff)}` : 'Count matches NetSuite'}
                </span>
              )}
              {!data.item.active && <span style={{ ...chip('#94a3b8'), marginLeft: '6px', verticalAlign: 'middle' }}>Inactive</span>}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {data.item.description && <>{data.item.description}. </>}
              Where it stood on December 31, 2024 at each location, where FleetSuite has it now next to NetSuite&apos;s own count, and
              every NetSuite document since that moved it, oldest first, each with the count it left there. Values are what NetSuite
              posted to the inventory accounts. Tap a document&apos;s number for its line by line check.
              {data.readAt ? ` NetSuite's count read ${ago(data.readAt)}.` : ''}
            </div>
          </div>

          {!data.by && (
            <div style={banner(AMBER)}>NetSuite&apos;s own counts haven&apos;t been read yet, so there&apos;s nothing to compare this item with.</div>
          )}
          {data.by === 'item' && (
            <div style={banner(AMBER)}>NetSuite gave only its company-wide count, so the item is compared across every location at once.</div>
          )}
          {data.setup && (
            <div style={banner(RED)}>
              In NetSuite, this item&apos;s asset account is {data.setup.account}, {data.setup.accountKind}, not an asset account, so what
              it costs lands in the wrong place when it&apos;s received and when it ships. With{' '}
              <Link href={deepLinks.itemAccounts(data.item.id)} className="rep-link">Change accounts</Link>, set its inventory asset
              account to {data.setup.usual ? `${data.setup.usual}, as most stocked items have it,` : 'your inventory asset account'} and
              check its cost of goods sold account there: this page can&apos;t read that one. This goes once it&apos;s changed there, or after
              a change made in NetSuite once <Link href="/admin/books/lists" className="rep-link">NetSuite&apos;s lists</Link> are copied
              again, every two hours or on Sync now.
            </div>
          )}
          {data.leftover.length > 0 && (
            <div style={banner(AMBER)}>
              Value left over: none is on hand {leftoverWhere ? `at ${leftoverWhere} ` : ''}on either side, but NetSuite&apos;s ledger still
              holds {fmt(leftoverValue)} on the item&apos;s lines{leftoverWhere ? ' there' : ''}. NetSuite&apos;s own count doesn&apos;t show
              it: it values what&apos;s on hand at the average cost, so nothing at none.
            </div>
          )}
          {backwards > 0 && (
            <div style={banner(AMBER)}>
              {backwards.toLocaleString('en-US')} of its moves took the item out of stock but put value into inventory, or the other way
              round (in amber under Values). NetSuite posts a shipment that way when the item&apos;s COGS account is an inventory account, as
              when it&apos;s swapped with the asset account. Fixing the item in NetSuite puts its next moves right. What&apos;s posted already
              stays on these documents: a journal entry can move it off the inventory account, but a journal entry names no item, so
              FleetSuite still counts it in this item&apos;s value.
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
            <button onClick={() => setShow('count')} style={button(show === 'count')}>Counts</button>
            <button onClick={() => setShow('value')} style={button(show === 'value')}>Values</button>
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '14px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Location</th>
                  <th className="rep-wide" style={amountHead}>Dec 31, 2024</th>
                  <th style={amountHead}>FleetSuite now</th>
                  <th style={amountHead}>NetSuite now</th>
                  <th style={amountHead}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {data.places.map((p) => (
                  <Row
                    key={p.locationId ?? ''}
                    id={`place-${p.locationId ?? ''}`}
                    span={4}
                    label={p.location ?? 'No location'}
                    phoneLabel={<Started name={p.location ?? 'No location'} start={amount(show, p.start)} />}
                    style={{ borderTop: '1px solid var(--border)', background: picked && p.locationId === picked ? `${AMBER}14` : undefined }}
                  >
                    <td className="rep-wide" style={cell}>{amount(show, p.start)}</td>
                    <td style={cell}>{amount(show, p.fleetsuite)}</td>
                    <td style={cell}>{data.by === 'location' ? amount(show, theirs(p)) : '—'}</td>
                    {data.by === 'location'
                      ? <Difference show={show} ours={p.fleetsuite} theirs={theirs(p)} leftover={leftoverAt.has(p.locationId ?? '')} />
                      : <td style={{ ...cell, color: 'var(--text-muted)' }}>—</td>}
                  </Row>
                ))}
                {data.places.length > 1 || data.by === 'item' ? (
                  <Row
                    span={4}
                    label="Every location"
                    phoneLabel={<Started name="Every location" start={amount(show, total.start)} />}
                    style={{ borderTop: '3px double var(--border)', fontWeight: 800 }}
                  >
                    <td className="rep-wide" style={cell}>{amount(show, total.start)}</td>
                    <td style={cell}>{amount(show, total.fleetsuite)}</td>
                    <td style={cell}>{amount(show, data.netsuite)}</td>
                    <Difference show={show} ours={total.fleetsuite} theirs={data.netsuite} leftover={allLeftover} />
                  </Row>
                ) : null}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
            <button onClick={() => setWhere('')} style={button(!where)}>Every location</button>
            {data.places.filter((p) => p.locationId).map((p) => (
              <button key={p.locationId} onClick={() => setWhere(p.locationId!)} style={button(where === p.locationId)}>{p.location}</button>
            ))}
          </div>
          {data.more > 0 && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              The newest {data.moves.length.toLocaleString('en-US')} moves; {data.more.toLocaleString('en-US')} older ones are counted in but not listed.
            </div>
          )}

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Document</th>
                  <th style={amountHead}>Moved</th>
                  <th style={amountHead}>Left there</th>
                </tr>
              </thead>
              <tbody>
                {!moves.length && (
                  <tr><td colSpan={3} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                    No NetSuite document has moved it {where ? 'there ' : ''}since December 31, 2024.
                  </td></tr>
                )}
                {moves.map((m) => (
                  <Row key={`${m.documentId}|${m.company}|${m.locationId ?? ''}`} span={2} label={<MoveLabel m={m} where={!where} />} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...cell, ...(show === 'value' && m.backwards ? { color: AMBER, fontWeight: 700 } : {}) }}>
                      {show === 'count' ? signed(m.quantity) : fmt(m.value)}
                    </td>
                    <td style={cell}>{show === 'count' ? qty(m.after.quantity) : fmt(m.after.value)}</td>
                  </Row>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
