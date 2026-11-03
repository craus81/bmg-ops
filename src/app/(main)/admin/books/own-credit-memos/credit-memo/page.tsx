'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { OwnCreditMemoCheck, OwnCreditStatus } from '@/lib/books/own-credit-memo-check';
import type { OwnLinePair } from '@/lib/books/own-invoice-check';
import type { OwnBooks } from '@/lib/books/own-invoice-posting';

/**
 * Books → Own credit memos → Books' own copy of one credit memo FleetSuite
 * made against an invoice, next to NetSuite's (migration 518,
 * src/lib/books/own-credit-memo-check.ts, docs/books.md "Posting FleetSuite's
 * own credit memos").
 *
 * What's compared, each with FleetSuite's and NetSuite's side and why they
 * differ; each line FleetSuite credited paired with NetSuite's; how it worked
 * its copy out; and which copy the books posted the credit memo from
 * (src/lib/books/own-credit-memo-posting.ts). Open to whoever opens the
 * books; opened from Own credit memos, Invoices vs NetSuite, or the daily
 * check's notification (?id=, NetSuite's id for the credit memo).
 */

type CreditMemo = OwnCreditMemoCheck & { books: OwnBooks | null };

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
const qty = (n: number) => String(Number(n.toFixed(4)));

const GREEN = '#22c55e';
const RED = '#ef4444';
const BLUE = '#60a5fa';
const GRAY = '#9ca3af';

const STATUS: Record<OwnCreditStatus, { chip: string; color: string }> = {
  differs: { chip: 'Differs from NetSuite', color: RED },
  waiting: { chip: 'Waiting for NetSuite', color: BLUE },
  matches: { chip: 'Matches NetSuite', color: GREEN },
  voided: { chip: 'Voided in NetSuite', color: GRAY },
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
const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const labelCell: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };
const sideHead: React.CSSProperties = { ...cell, width: '30%' };
const markHead: React.CSSProperties = { ...cell, width: '6%' };

/** Same, differs, or not compared. */
function Mark({ same }: { same: boolean | null }) {
  if (same === null) return <span style={{ color: 'var(--text-muted)' }}>·</span>;
  return same ? <span style={{ color: GREEN, fontWeight: 800 }}>✓</span> : <span style={{ color: RED, fontWeight: 800 }}>✕</span>;
}

/**
 * A row of a table: its label, then FleetSuite's side, NetSuite's and the mark. On a phone the label takes a row of
 * its own above them (.rep-label-row in globals.css), as on Reports.
 */
function TableRow({ label, style, children }: { label: React.ReactNode; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <>
      <tr className="rep-label-row" style={style}><td colSpan={3} style={labelCell}>{label}</td></tr>
      <tr className="rep-amounts" style={style}>
        <td className="rep-label" style={labelCell}>{label}</td>
        {children}
      </tr>
    </>
  );
}

const Why = ({ text, differs }: { text: string | null; differs: boolean }) =>
  text ? <div style={{ fontSize: '11px', color: differs ? RED : 'var(--text-muted)', overflowWrap: 'anywhere' }}>{text}</div> : null;

/** One side of a line: quantity × price = what it credits, and on FleetSuite's the sales tax it gives back. */
function LineSide({ side, own }: { side: OwnLinePair['fleetsuite'] | OwnLinePair['netsuite']; own: boolean }) {
  if (!side) return <span style={{ color: 'var(--text-muted)' }}>Not credited</span>;
  const amount = side.cents === null ? "Can't be read" : fmt(side.cents);
  const each = side.quantity !== null && side.rate !== null ? `${qty(side.quantity)} × ${money.format(side.rate)}` : side.quantity !== null ? `${qty(side.quantity)}` : '';
  const f = own ? (side as NonNullable<OwnLinePair['fleetsuite']>) : null;
  return (
    <div>
      <div style={{ fontWeight: 700 }}>{amount}</div>
      {each && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{each}</div>}
      {f && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{f.taxable ? `Tax back ${fmt(f.taxCents)}` : 'Not taxed'}</div>}
    </div>
  );
}

/** What the books hold for the credit memo, in a sentence. */
function booksText(c: CreditMemo): string {
  const b = c.books;
  if (!b) return c.status === 'voided' ? "Not in FleetSuite's books: NetSuite voided it." : "Not in FleetSuite's books yet.";
  const entry = `In FleetSuite's books as entry ${b.entryNo}`;
  if (c.status === 'voided') return `${entry}. NetSuite voided or deleted the credit memo, so the next posting run reverses it.`;
  if (b.from === 'fleetsuite') return `${entry}, made from this copy.`;
  if (c.status === 'differs') {
    return `${entry}, made from NetSuite's credit memo, since this copy differs from it and NetSuite's is what the customer was credited.`;
  }
  return `${entry}, made from NetSuite's credit memo.`;
}

export default function BooksOwnCreditMemoPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [creditMemo, setCreditMemo] = useState<CreditMemo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (id: string) => {
    try {
      if (!id) throw new Error('No credit memo was named');
      const res = await apiFetch(`/api/admin/books/own-credit-memos?${new URLSearchParams({ id })}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setCreditMemo(json.creditMemo);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the credit memo');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // Own credit memos, Invoices vs NetSuite and the daily check link here with NetSuite's id for it (deepLinks.booksOwnCreditMemo).
    load(new URLSearchParams(window.location.search).get('id') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const c = creditMemo;
  const s = c ? STATUS[c.status] : null;

  return (
    <div>
      <div style={{ marginBottom: '10px', fontSize: '12px' }}>
        <Link href={deepLinks.booksOwnCreditMemos(c?.date ?? null)} style={{ color: 'var(--text-secondary)' }}>← Own credit memos</Link>
      </div>
      {error && <div style={banner(RED)}>{error}</div>}

      {c && s && (
        <>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' }}>
              <span style={{ fontSize: '20px', fontWeight: 800 }}>{c.number}</span>
              {c.customer && <span style={{ fontSize: '16px', fontWeight: 600 }}>· {c.customer}</span>}
              <span style={chip(s.color)}>{s.chip}</span>
            </div>
            <div style={{ fontSize: '12px', color: c.status === 'differs' ? RED : 'var(--text-muted)', marginTop: '4px' }}>{c.summary}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', overflowWrap: 'anywhere' }}>
              FleetSuite&apos;s own copy, made against {c.invoiceNumber}{c.reason ? `: ${c.reason}` : '.'}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              {booksText(c)}{' '}
              {/* The entry is dated in the month NetSuite booked the credit memo into, which Invoices vs NetSuite lists it under. */}
              <Link href={deepLinks.booksDocument('BMG', 'credit_memo', c.books?.date ?? c.date, c.netsuiteId)} style={{ color: 'var(--text-secondary)' }}>
                {c.status === 'matches' && c.books?.from === 'netsuite' ? 'Why, on Invoices vs NetSuite' : 'How it posts, on Invoices vs NetSuite'}
              </Link>
            </div>
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
                {c.fields.map((f) => (
                  <TableRow
                    key={f.field}
                    label={<div><div style={{ fontWeight: 700 }}>{f.label}</div><Why text={f.why} differs={f.same === false} /></div>}
                    style={{ borderTop: '1px solid var(--border)' }}
                  >
                    <td style={{ ...cell, whiteSpace: 'normal', color: f.fleetsuite === null ? 'var(--text-muted)' : undefined }}>{f.fleetsuite ?? 'Not known'}</td>
                    <td style={{ ...cell, whiteSpace: 'normal', color: f.netsuite === null ? 'var(--text-muted)' : undefined }}>{f.netsuite ?? 'Not copied'}</td>
                    <td style={cell}><Mark same={f.same} /></td>
                  </TableRow>
                ))}
              </tbody>
            </table>
          </div>

          {c.lines.length > 0 && (
            <>
              <div style={heading}>Lines</div>
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
                    {c.lines.map((l, i) => {
                      const description = l.fleetsuite?.description ?? l.netsuite?.description ?? null;
                      return (
                        <TableRow
                          key={`${l.itemId ?? 'none'}-${i}`}
                          label={(
                            <div>
                              <div style={{ fontWeight: 700 }}>{l.item}</div>
                              {description && description !== l.item && (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{description}</div>
                              )}
                              <Why text={l.why} differs={l.same === false} />
                            </div>
                          )}
                          style={{ borderTop: '1px solid var(--border)' }}
                        >
                          <td style={cell}><LineSide side={l.fleetsuite} own /></td>
                          <td style={cell}><LineSide side={l.netsuite} own={false} /></td>
                          <td style={cell}><Mark same={l.same} /></td>
                        </TableRow>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div style={heading}>How FleetSuite worked it out</div>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {c.workedOut.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
