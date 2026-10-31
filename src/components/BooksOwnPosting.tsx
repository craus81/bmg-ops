'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { deepLinks } from '@/lib/deep-links';
import type { OwnPostingView } from '@/lib/books/own-posting-view';
import { ownBooksLinkText, ownBooksText, ownBooksWhy, type OwnCopyStatus } from '@/lib/books/own-posting-text';

/**
 * What the books hold for Books' own copies of fulfillments, receipts and
 * bills, on each one's page on Own fulfillments, Own receipts and Own bills
 * (migration 456, src/lib/books/own-posting-view.ts, docs/books.md "Posting
 * FleetSuite's own fulfillments, receipts and bills"): the entry that stands,
 * and the copy's entry next to NetSuite's. The lists' chip and count are in
 * src/lib/books/own-posting-text.ts. Super admins only, as the pages are.
 */

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents: number) => money.format(cents / 100);

const GREEN = '#22c55e';
const RED = '#ef4444';

const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const labelCell: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };
const sideHead: React.CSSProperties = { ...cell, width: '30%' };
const markHead: React.CSSProperties = { ...cell, width: '6%' };
const muted: React.CSSProperties = { fontSize: '11px', color: 'var(--text-muted)' };
const heading: React.CSSProperties = { fontSize: '13px', fontWeight: 800, margin: '16px 0 6px' };

/**
 * The line under a copy's heading saying what the books hold for its document, with a link to it on Invoices vs
 * NetSuite (`kind` and `company` there, `date` the month to open when the copy of NetSuite's GL hasn't got it yet),
 * and why the books post NetSuite's when the copy matches but its entry can't be worked out.
 */
export function OwnBooksLine({ posting, status, theirs, company, kind, netsuiteId, date }: {
  posting: OwnPostingView | null;
  status: OwnCopyStatus;
  theirs: string;
  company: string;
  kind: 'stock' | 'bill';
  netsuiteId: string | null;
  date: string;
}) {
  const month = posting?.month ?? posting?.books?.date ?? date;
  const why = ownBooksWhy(posting, status);
  return (
    <>
      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
        {ownBooksText(posting, status, theirs)}
        {netsuiteId && status !== 'not_in_netsuite' && (
          <>
            {' '}
            {/* The entry is dated in the month NetSuite booked the document into, which Invoices vs NetSuite lists it under. */}
            <Link href={deepLinks.booksDocument(company, kind, month, netsuiteId)} style={{ color: 'var(--text-secondary)' }}>
              {ownBooksLinkText(posting, status)}
            </Link>
          </>
        )}
      </div>
      {why && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{why}</div>}
    </>
  );
}

/** Same or not. */
function Mark({ same }: { same: boolean }) {
  return same ? <span style={{ color: GREEN, fontWeight: 800 }}>✓</span> : <span style={{ color: RED, fontWeight: 800 }}>✕</span>;
}

/** One side's amount in an account, and which side of it; Nothing when it puts nothing there. */
function Side({ cents }: { cents: number | null }) {
  if (cents === null) return <span style={{ color: 'var(--text-muted)' }}>Nothing</span>;
  return <div><div style={{ fontWeight: 700 }}>{fmt(Math.abs(cents))}</div><div style={muted}>{cents > 0 ? 'debit' : 'credit'}</div></div>;
}

/**
 * The copy's entry next to NetSuite's, account by account, when it's worked out: why the books post this copy, or
 * how the entries differ and so why they post NetSuite's, and `note`, what NetSuite's side is when it isn't plain.
 * Nothing when the copy's entry isn't worked out.
 */
export function OwnEntry({ posting, note }: { posting: OwnPostingView | null; note?: string }) {
  if (!posting?.entry?.length) return null;
  return (
    <div id="entry">
      <div style={heading}>The entry</div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
        <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
          <thead>
            <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
              <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Account</th>
              <th style={sideHead}>FleetSuite</th>
              <th style={sideHead}>NetSuite</th>
              <th style={markHead} aria-label="Same" />
            </tr>
          </thead>
          <tbody>
            {posting.entry.map((r) => (
              <Fragment key={r.account}>
                {/* On a phone the account takes a row of its own above the amounts (.rep-label-row in globals.css). */}
                <tr className="rep-label-row" style={{ borderTop: '1px solid var(--border)' }}>
                  <td colSpan={3} style={labelCell}><span style={{ fontWeight: 700 }}>{r.account}</span></td>
                </tr>
                <tr className="rep-amounts" style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="rep-label" style={labelCell}><span style={{ fontWeight: 700 }}>{r.account}</span></td>
                  <td style={cell}><Side cents={r.fleetsuite} /></td>
                  <td style={cell}><Side cents={r.netsuite} /></td>
                  <td style={cell}><Mark same={r.same} /></td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {note && <div style={{ ...muted, marginTop: '6px' }}>{note}</div>}
      {posting.posts && (
        <div style={{ ...muted, marginTop: '6px' }}>
          {posting.costs ? `${posting.costs} ` : ''}The same accounts and amounts, on the same day, so the books post this copy.
        </div>
      )}
      {!posting.posts && posting.differs && (
        <div style={{ fontSize: '12px', color: RED, marginTop: '6px', lineHeight: 1.45 }}>
          The entry isn&apos;t the same, so the books post NetSuite&apos;s: {posting.differs}.
        </div>
      )}
      {posting.learned.map((l) => <div key={l} style={{ ...muted, marginTop: '4px' }}>{l}</div>)}
    </div>
  );
}
