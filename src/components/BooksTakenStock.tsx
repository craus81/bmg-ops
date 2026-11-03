'use client';

import Link from 'next/link';
import { deepLinks } from '@/lib/deep-links';
import type { FulfilEntryLine, FulfilItemPair } from '@/lib/books/own-fulfillment-check';

/**
 * What Books' own copy of a fulfillment, or of an invoice made without a
 * sales order, took from stock next to what NetSuite's took, and what its
 * copy of a credit memo put back on the shelf next to what NetSuite's put
 * back, on its page on Own fulfillments, Own invoices or Own credit memos
 * (src/lib/books/own-fulfillment-check.ts checkTaken,
 * own-invoice-cost-check.ts, own-credit-cost-check.ts; docs/books.md
 * "FleetSuite's own fulfillments", "Posting FleetSuite's own invoices' cost"
 * and "Posting the stock a credit memo puts back"): each item with where it
 * was taken from (or put back) and the count and value FleetSuite costed it
 * from (each item opens its moves there on Stock by item), and what
 * NetSuite's document posted when the copy's entry isn't worked out. Open to
 * whoever opens the books, as the pages are.
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
function OwnSide({ side, back }: { side: FulfilItemPair['fleetsuite']; back: boolean }) {
  if (!side) return <span style={{ color: 'var(--text-muted)' }}>{back ? 'Not put back' : 'Not taken'}</span>;
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
      {/* Taken from more than one place: each line was costed at its own. */}
      {side.location && side.count === null && <div style={muted}>at {side.location}</div>}
    </div>
  );
}

/** NetSuite's side of an item: what it took off the inventory accounts (or put on them), quantity × cost each, and where. */
function NetSuiteSide({ side, kit, copied, back }: { side: FulfilItemPair['netsuite']; kit: boolean; copied: boolean; back: boolean }) {
  // NetSuite takes a kit's parts, not the kit, and a document not copied yet took nothing that's known.
  if (!side) return <span style={{ color: 'var(--text-muted)' }}>{kit ? 'Not compared' : !copied ? 'Not copied' : back ? 'Not put back' : 'Not taken'}</span>;
  return (
    <div>
      <div style={{ fontWeight: 700, color: side.cents === null ? 'var(--text-muted)' : undefined }}>{side.cents === null ? 'Not copied' : fmt(side.cents)}</div>
      <div style={muted}>{side.each !== null ? `${qty(side.quantity)} × ${eachText(side.each)}` : qty(side.quantity)}</div>
      {side.locations.length > 0 && <div style={muted}>at {side.locations.join(', ')}</div>}
    </div>
  );
}

/**
 * Each item the copy took from stock (or, `back`, put back on the shelf) next to NetSuite's (`copied`: whether the
 * copy of NetSuite's stock moves has its document), each opening its moves where FleetSuite took it from on Stock by
 * item (`locationId` when it took it from more than one). Nothing when neither took anything.
 */
export function TakenItems({ items, locationId, copied, title = 'Items', back = false }: {
  items: FulfilItemPair[];
  locationId: string | null;
  copied: boolean;
  title?: string;
  back?: boolean;
}) {
  if (!items.length) return null;
  return (
    <>
      <div style={heading}>{title}</div>
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
            {items.map((item) => (
              <TableRow
                key={item.itemId}
                span={3}
                label={(
                  <div>
                    {/* Its moves where FleetSuite took it from, on Stock by item: every location when it took it from more than one. */}
                    <Link href={deepLinks.booksStockItem(item.itemId, item.fleetsuite ? item.fleetsuite.locationId : locationId)} className="rep-link" style={{ fontWeight: 700 }}>{item.item}</Link>
                    {item.description && item.description !== item.item && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{item.description}</div>
                    )}
                    {/* A kit's part: NetSuite takes a kit's parts from stock, not the kit. */}
                    {item.partOf && <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{item.partOf}</div>}
                    <Why text={item.why} differs={item.same === false} />
                  </div>
                )}
                style={{ borderTop: '1px solid var(--border)' }}
              >
                <td style={cell}><OwnSide side={item.fleetsuite} back={back} /></td>
                <td style={cell}><NetSuiteSide side={item.netsuite} kit={item.fleetsuite?.kind === 'kit'} copied={copied} back={back} /></td>
                <td style={cell}><Mark same={item.same} /></td>
              </TableRow>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** What NetSuite's document posted, account by account, under `title`; nothing when it posted nothing. */
export function NetSuitePosted({ entry, title }: { entry: FulfilEntryLine[]; title: string }) {
  if (!entry.length) return null;
  const debits = entry.reduce((sum, e) => sum + e.debit, 0);
  const credits = entry.reduce((sum, e) => sum + e.credit, 0);
  return (
    <>
      <div style={heading}>{title}</div>
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
            {entry.map((e) => (
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
  );
}
