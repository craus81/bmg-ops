'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { OwnReceiptCheck, ReceiptItemPair, ReceiptStatus } from '@/lib/books/own-receipt-check';

/**
 * Books → Own receipts → one of Books' own receipts, next to NetSuite's item
 * receipt (migration 435, src/lib/books/own-receipt-check.ts, docs/books.md
 * "FleetSuite's own bills and receipts").
 *
 * What's compared, each with Books' and NetSuite's side and why they differ;
 * each item received paired with NetSuite's (each opens its moves on Stock
 * by item); where Receiving's rows for it stand and what NetSuite said when
 * it didn't take it; what FleetSuite couldn't work out; and how Books worked
 * its copy out. Super admins only, as the books are; opened from Own
 * receipts or the daily check's notification (?key=, the receipt's key).
 */

type Receipt = OwnReceiptCheck & { netsuiteUrl: string | null; poUrl: string | null };

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const qty = (n: number) => String(Number(n.toFixed(4)));
const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#fbbf24';
const ORANGE = '#fb923c';
const BLUE = '#60a5fa';
const GRAY = '#9ca3af';

/** Each status: its chip, its color, and what NetSuite's side says when it has nothing. */
const STATUS: Record<ReceiptStatus, { chip: string; color: string; none: string }> = {
  differs: { chip: 'Differs from NetSuite', color: RED, none: 'Not known' },
  not_in_netsuite: { chip: 'Not in NetSuite', color: ORANGE, none: 'Not in NetSuite' },
  incomplete: { chip: 'Incomplete', color: AMBER, none: 'Not known' },
  waiting: { chip: 'Waiting for NetSuite', color: BLUE, none: 'Not yet' },
  matches: { chip: 'Matches NetSuite', color: GREEN, none: 'Not known' },
  voided: { chip: 'Gone from NetSuite', color: GRAY, none: 'Gone' },
};

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const chip = (color: string): React.CSSProperties => ({
  fontSize: '10px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
  border: `1px solid ${color}55`, color,
});

const heading: React.CSSProperties = { fontSize: '13px', fontWeight: 800, margin: '16px 0 6px' };
const muted: React.CSSProperties = { fontSize: '11px', color: 'var(--text-muted)' };
const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const labelCell: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };
const sideHead: React.CSSProperties = { ...cell, width: '30%' };
const markHead: React.CSSProperties = { ...cell, width: '6%' };
const link: React.CSSProperties = { color: 'var(--text-secondary)' };

/** Same, differs, or not compared. */
function Mark({ same }: { same: boolean | null }) {
  if (same === null) return <span style={{ color: 'var(--text-muted)' }}>·</span>;
  return same ? <span style={{ color: GREEN, fontWeight: 800 }}>✓</span> : <span style={{ color: RED, fontWeight: 800 }}>✕</span>;
}

/**
 * A row of a table: its label, then the cells after it (`span` of them). On a phone the label takes a row of its own
 * above them (.rep-label-row in globals.css), as on Reports.
 */
function TableRow({ label, span, style, children }: { label: React.ReactNode; span: number; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <>
      <tr className="rep-label-row" style={style}><td colSpan={span} style={labelCell}>{label}</td></tr>
      <tr className="rep-amounts" style={style}>
        <td className="rep-label" style={labelCell}>{label}</td>
        {children}
      </tr>
    </>
  );
}

const Why = ({ text, differs }: { text: string | null; differs: boolean }) =>
  text ? <div style={{ fontSize: '11px', color: differs ? RED : 'var(--text-muted)', overflowWrap: 'anywhere' }}>{text}</div> : null;

/** Books' side of an item: how many came in, at the PO's price, and whether NetSuite keeps it in stock. */
function OwnSide({ side }: { side: ReceiptItemPair['fleetsuite'] }) {
  if (!side) return <span style={{ color: 'var(--text-muted)' }}>None received</span>;
  return (
    <div>
      <div style={{ fontWeight: 700, color: side.cents === null ? 'var(--text-muted)' : undefined }}>{side.cents === null ? 'No price' : fmt(side.cents)}</div>
      <div style={muted}>{side.rate !== null ? `${qty(side.quantity)} × ${price.format(side.rate)}` : qty(side.quantity)}</div>
      {side.stock === false && <div style={muted}>not kept in stock</div>}
      {side.stock === null && <div style={muted}>not in the item list yet</div>}
    </div>
  );
}

/** NetSuite's side of an item: what it posted to the inventory accounts, how many, and where; `none` when it doesn't say. */
function NetSuiteSide({ side, copied, none }: { side: ReceiptItemPair['netsuite']; copied: boolean; none: string }) {
  if (!side) return <span style={{ color: 'var(--text-muted)' }}>{copied ? 'None received' : none}</span>;
  return (
    <div>
      <div style={{ fontWeight: 700, color: side.cents === null ? 'var(--text-muted)' : undefined }}>
        {side.cents === null ? none : side.movesStock ? fmt(side.cents) : 'Not stock'}
      </div>
      <div style={muted}>{qty(side.quantity)}</div>
      {side.locations.length > 0 && <div style={muted}>at {side.locations.join(', ')}</div>}
    </div>
  );
}

export default function BooksOwnReceiptPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (key: string) => {
    try {
      if (!key) throw new Error('No receipt was named');
      const res = await apiFetch(`/api/admin/books/own-receipts?${new URLSearchParams({ key })}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setReceipt(json.receipt);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the receipt');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // Own receipts and the daily check link here with the receipt's key (deepLinks.booksOwnReceipt).
    load(new URLSearchParams(window.location.search).get('key') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const r = receipt;
  const s = r ? STATUS[r.status] : null;
  const rows = r ? [
    r.receiving.posted ? count(r.receiving.posted, 'line is in NetSuite', 'lines are in NetSuite') : '',
    r.receiving.manualNeeded ? count(r.receiving.manualNeeded, 'line is still to enter in NetSuite by hand', 'lines are still to enter in NetSuite by hand') : '',
    r.receiving.manualDone ? count(r.receiving.manualDone, 'line was entered in NetSuite by hand', 'lines were entered in NetSuite by hand') : '',
  ].filter(Boolean) : [];

  return (
    <div>
      <div style={{ marginBottom: '10px', fontSize: '12px' }}>
        <Link href={deepLinks.booksOwnReceipts(r?.date ?? null)} style={link}>← Own receipts</Link>
      </div>
      {error && <div style={banner(RED)}>{error}</div>}

      {r && s && (
        <>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' }}>
              <span style={{ fontSize: '20px', fontWeight: 800 }}>{r.poNumber}</span>
              {r.vendor && <span style={{ fontSize: '16px', fontWeight: 600 }}>· {r.vendor}</span>}
              <span style={chip(s.color)}>{s.chip}</span>
            </div>
            <div style={{ fontSize: '12px', color: r.status === 'differs' ? RED : r.status === 'not_in_netsuite' ? ORANGE : 'var(--text-muted)', marginTop: '4px' }}>
              {r.summary}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              Books&apos; own copy of a Receive on the <Link href={deepLinks.receiving()} style={link}>Receiving page</Link>: {r.what}
              {r.location ? ` at ${r.location}` : ''}, for {r.company}. Nothing is posted from it yet.
            </div>
            {(r.netsuiteUrl || r.poUrl) && (
              <div style={{ fontSize: '12px', marginTop: '2px' }}>
                {r.netsuiteUrl && <a href={r.netsuiteUrl} target="_blank" rel="noreferrer" style={link}>{r.number ?? 'Receipt'} in NetSuite ↗</a>}
                {r.netsuiteUrl && r.poUrl && ' · '}
                {r.poUrl && <a href={r.poUrl} target="_blank" rel="noreferrer" style={link}>{r.poNumber} in NetSuite ↗</a>}
              </div>
            )}
            {rows.length > 0 && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>On Receiving: {rows.join(', ')}.</div>}
            {r.netsuiteError && (
              <div style={{ fontSize: '12px', color: ORANGE, marginTop: '2px', overflowWrap: 'anywhere' }}>NetSuite said: {r.netsuiteError}</div>
            )}
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Compared</th>
                  <th style={sideHead}>FleetSuite</th>
                  <th style={sideHead}>NetSuite</th>
                  <th style={markHead} aria-label="Same" />
                </tr>
              </thead>
              <tbody>
                {r.fields.map((field) => (
                  <TableRow
                    key={field.field}
                    span={3}
                    label={<div><div style={{ fontWeight: 700 }}>{field.label}</div><Why text={field.why} differs={field.same === false} /></div>}
                    style={{ borderTop: '1px solid var(--border)' }}
                  >
                    <td style={{ ...cell, whiteSpace: 'normal', color: field.fleetsuite === null ? 'var(--text-muted)' : undefined }}>{field.fleetsuite ?? 'Not known'}</td>
                    <td style={{ ...cell, whiteSpace: 'normal', color: field.netsuite === null ? 'var(--text-muted)' : undefined }}>
                      {field.netsuite ?? STATUS[r.status].none}
                    </td>
                    <td style={cell}><Mark same={field.same} /></td>
                  </TableRow>
                ))}
              </tbody>
            </table>
          </div>

          {r.items.length > 0 && (
            <>
              <div style={heading}>Items</div>
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
                <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                      <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Item</th>
                      <th style={sideHead}>FleetSuite</th>
                      <th style={sideHead}>NetSuite</th>
                      <th style={markHead} aria-label="Same" />
                    </tr>
                  </thead>
                  <tbody>
                    {r.items.map((item, i) => (
                      <TableRow
                        key={`${item.itemId ?? item.item}-${i}`}
                        span={3}
                        label={(
                          <div>
                            {/* Its moves on Stock by item. */}
                            {item.itemId
                              ? <Link href={deepLinks.booksStockItem(item.itemId)} className="rep-link" style={{ fontWeight: 700 }}>{item.item}</Link>
                              : <span style={{ fontWeight: 700 }}>{item.item}</span>}
                            {item.description && item.description !== item.item && (
                              <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{item.description}</div>
                            )}
                            <Why text={item.why} differs={item.same === false} />
                          </div>
                        )}
                        style={{ borderTop: '1px solid var(--border)' }}
                      >
                        <td style={cell}><OwnSide side={item.fleetsuite} /></td>
                        <td style={cell}>
                          <NetSuiteSide side={item.netsuite} copied={r.fields.some((field) => field.field === 'items' && field.netsuite !== null)} none={STATUS[r.status].none} />
                        </td>
                        <td style={cell}><Mark same={item.same} /></td>
                      </TableRow>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {r.unknowns.length > 0 && (
            <>
              <div style={heading}>What FleetSuite didn&apos;t know</div>
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                {r.unknowns.map((u) => <li key={u}>{u.charAt(0).toUpperCase()}{u.slice(1)}.</li>)}
              </ul>
            </>
          )}

          <div style={heading}>How Books worked it out</div>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {r.workedOut.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
