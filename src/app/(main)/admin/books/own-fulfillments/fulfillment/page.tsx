'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { OwnCheckStatus } from '@/lib/books/own-invoice-check';
import type { FulfilItemPair, OwnFulfillmentCheck } from '@/lib/books/own-fulfillment-check';

/**
 * Books → Own fulfillments → one of FleetSuite's own fulfillments, next to
 * NetSuite's (migration 417, src/lib/books/own-fulfillment-check.ts,
 * docs/books.md "FleetSuite's own fulfillments").
 *
 * What's compared, each with FleetSuite's and NetSuite's side and why they
 * differ; each item FleetSuite took from stock paired with NetSuite's, with
 * the count and value FleetSuite costed it from (each item opens its moves
 * on Stock by item); what NetSuite's fulfillment posted; what FleetSuite
 * couldn't work out; and how it worked its copy out. Super admins only, as
 * the books are; opened from Own fulfillments or the daily check's
 * notification (?id=, NetSuite's id for the fulfillment).
 */

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
const qty = (n: number) => String(Number(n.toFixed(4)));
/** A cost each, in cents: to the cent when it is whole cents, else to four places. */
const eachText = (cents: number) =>
  Math.abs(cents - Math.round(cents)) < 1e-6
    ? fmt(Math.round(cents))
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(cents / 100);

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#fbbf24';
const BLUE = '#60a5fa';
const GRAY = '#9ca3af';

const STATUS: Record<OwnCheckStatus, { chip: string; color: string }> = {
  differs: { chip: 'Differs from NetSuite', color: RED },
  incomplete: { chip: 'Incomplete', color: AMBER },
  waiting: { chip: 'Waiting for NetSuite', color: BLUE },
  matches: { chip: 'Matches NetSuite', color: GREEN },
  voided: { chip: 'Deleted in NetSuite', color: GRAY },
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
const amountHead: React.CSSProperties = { ...cell, width: '20%' };

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

/** FleetSuite's side of an item: what it cost, quantity × cost each, and the count and value it was costed from. */
function OwnSide({ side }: { side: FulfilItemPair['fleetsuite'] }) {
  if (!side) return <span style={{ color: 'var(--text-muted)' }}>Not taken</span>;
  if (side.kind === 'kit') {
    return <div><div style={{ fontWeight: 700 }}>A kit</div><div style={muted}>{qty(side.quantity)}, parts not known</div></div>;
  }
  if (side.kind === 'unknown') {
    return <div><div style={{ fontWeight: 700 }}>Not known</div><div style={muted}>{qty(side.quantity)}, not in the item list yet</div></div>;
  }
  return (
    <div>
      <div style={{ fontWeight: 700, color: side.cents === null ? 'var(--text-muted)' : undefined }}>{side.cents === null ? 'Not known' : fmt(side.cents)}</div>
      <div style={muted}>{side.each !== null ? `${qty(side.quantity)} × ${eachText(side.each)}` : qty(side.quantity)}</div>
      {side.location && side.count !== null && side.valueCents !== null && (
        <div style={muted}>of {qty(side.count)} worth {fmt(side.valueCents)} at {side.location}</div>
      )}
    </div>
  );
}

/** NetSuite's side of an item: what it took off the inventory accounts, quantity × cost each, and where from. */
function NetSuiteSide({ side, kit, copied }: { side: FulfilItemPair['netsuite']; kit: boolean; copied: boolean }) {
  // NetSuite takes a kit's parts, not the kit, and a fulfillment not copied yet took nothing that's known.
  if (!side) return <span style={{ color: 'var(--text-muted)' }}>{kit ? 'Not compared' : copied ? 'Not taken' : 'Not copied'}</span>;
  return (
    <div>
      <div style={{ fontWeight: 700, color: side.cents === null ? 'var(--text-muted)' : undefined }}>{side.cents === null ? 'Not copied' : fmt(side.cents)}</div>
      <div style={muted}>{side.each !== null ? `${qty(side.quantity)} × ${eachText(side.each)}` : qty(side.quantity)}</div>
      {side.locations.length > 0 && <div style={muted}>at {side.locations.join(', ')}</div>}
    </div>
  );
}

export default function BooksOwnFulfillmentPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [fulfillment, setFulfillment] = useState<OwnFulfillmentCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (id: string) => {
    try {
      if (!id) throw new Error('No fulfillment was named');
      const res = await apiFetch(`/api/admin/books/own-fulfillments?${new URLSearchParams({ id })}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setFulfillment(json.fulfillment);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the fulfillment');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // Own fulfillments and the daily check link here with NetSuite's id for the fulfillment (deepLinks.booksOwnFulfillment).
    load(new URLSearchParams(window.location.search).get('id') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const f = fulfillment;
  const s = f ? STATUS[f.status] : null;
  const debits = f ? f.entry.reduce((sum, e) => sum + e.debit, 0) : 0;
  const credits = f ? f.entry.reduce((sum, e) => sum + e.credit, 0) : 0;

  return (
    <div>
      <div style={{ marginBottom: '10px', fontSize: '12px' }}>
        <Link href={deepLinks.booksOwnFulfillments(f?.date ?? null)} style={{ color: 'var(--text-secondary)' }}>← Own fulfillments</Link>
      </div>
      {error && <div style={banner(RED)}>{error}</div>}

      {f && s && (
        <>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' }}>
              <span style={{ fontSize: '20px', fontWeight: 800 }}>{f.number}</span>
              {f.customer && <span style={{ fontSize: '16px', fontWeight: 600 }}>· {f.customer}</span>}
              <span style={chip(s.color)}>{s.chip}</span>
            </div>
            <div style={{ fontSize: '12px', color: f.status === 'differs' ? RED : 'var(--text-muted)', marginTop: '4px' }}>{f.summary}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              FleetSuite&apos;s own copy, made when it invoiced {f.madeFromText} off {f.salesOrder}. Nothing is posted from it yet.
            </div>
            {f.invoice && (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                Invoiced as{' '}
                <Link href={deepLinks.booksOwnInvoice(f.invoice.netsuiteId)} style={{ color: 'var(--text-secondary)' }}>{f.invoice.number}</Link>
                , on Own invoices.
              </div>
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
                {f.fields.map((field) => (
                  <TableRow
                    key={field.field}
                    span={3}
                    label={<div><div style={{ fontWeight: 700 }}>{field.label}</div><Why text={field.why} differs={field.same === false} /></div>}
                    style={{ borderTop: '1px solid var(--border)' }}
                  >
                    <td style={{ ...cell, whiteSpace: 'normal', color: field.fleetsuite === null ? 'var(--text-muted)' : undefined }}>{field.fleetsuite ?? 'Not known'}</td>
                    <td style={{ ...cell, whiteSpace: 'normal', color: field.netsuite === null ? 'var(--text-muted)' : undefined }}>{field.netsuite ?? 'Not copied'}</td>
                    <td style={cell}><Mark same={field.same} /></td>
                  </TableRow>
                ))}
              </tbody>
            </table>
          </div>

          {f.items.length > 0 && (
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
                    {f.items.map((item) => (
                      <TableRow
                        key={item.itemId}
                        span={3}
                        label={(
                          <div>
                            {/* Its moves at the location FleetSuite costed it at, on Stock by item. */}
                            <Link href={deepLinks.booksStockItem(item.itemId, f.locationId)} className="rep-link" style={{ fontWeight: 700 }}>{item.item}</Link>
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
                          <NetSuiteSide
                            side={item.netsuite}
                            kit={item.fleetsuite?.kind === 'kit'}
                            copied={f.fields.some((field) => field.field === 'items' && field.netsuite !== null)}
                          />
                        </td>
                        <td style={cell}><Mark same={item.same} /></td>
                      </TableRow>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {f.entry.length > 0 && (
            <>
              <div style={heading}>What NetSuite&apos;s fulfillment posted</div>
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
                <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                      <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Account</th>
                      <th style={amountHead}>Debit</th>
                      <th style={amountHead}>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.entry.map((e) => (
                      <TableRow key={e.account} span={2} label={e.account} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={cell}>{e.debit ? fmt(e.debit) : ''}</td>
                        <td style={cell}>{e.credit ? fmt(e.credit) : ''}</td>
                      </TableRow>
                    ))}
                    <TableRow span={2} label={<span style={{ fontWeight: 700 }}>Total</span>} style={{ borderTop: '1px solid var(--border)', fontWeight: 700 }}>
                      <td style={cell}>{fmt(debits)}</td>
                      <td style={cell}>{fmt(credits)}</td>
                    </TableRow>
                  </tbody>
                </table>
              </div>
            </>
          )}

          {f.unknowns.length > 0 && (
            <>
              <div style={heading}>What FleetSuite didn&apos;t know</div>
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                {f.unknowns.map((u) => <li key={u}>{u.charAt(0).toUpperCase()}{u.slice(1)}.</li>)}
              </ul>
            </>
          )}

          <div style={heading}>How FleetSuite worked it out</div>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {f.workedOut.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
