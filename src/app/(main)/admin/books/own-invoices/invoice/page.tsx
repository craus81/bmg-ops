'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { OwnCheckStatus, OwnInvoiceCheck, OwnLinePair } from '@/lib/books/own-invoice-check';
import type { OwnBooks } from '@/lib/books/own-invoice-posting';

/**
 * Books → Own invoices → one of FleetSuite's own invoices, next to
 * NetSuite's (migration 407, src/lib/books/own-invoice-check.ts,
 * docs/books.md "FleetSuite's own invoices").
 *
 * What's compared, each with FleetSuite's and NetSuite's side and why they
 * differ; each line FleetSuite billed paired with NetSuite's; what FleetSuite
 * couldn't work out; how it worked its copy out; and which copy the books
 * posted the invoice from (migration 409,
 * src/lib/books/own-invoice-posting.ts). Open to whoever opens the books;
 * opened from Own invoices, Invoices vs NetSuite, or the daily check's
 * notification (?id=, NetSuite's id for the invoice).
 */

type Invoice = OwnInvoiceCheck & { books: OwnBooks | null };

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
const qty = (n: number) => String(Number(n.toFixed(4)));

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

/** One side of a line: quantity × price = amount, and on FleetSuite's its tax. */
function LineSide({ side, own }: { side: OwnLinePair['fleetsuite'] | OwnLinePair['netsuite']; own: boolean }) {
  if (!side) return <span style={{ color: 'var(--text-muted)' }}>Not billed</span>;
  const priced = !own || (side as NonNullable<OwnLinePair['fleetsuite']>).priced;
  const cents = side.cents;
  const amount = !priced ? 'NetSuite priced it' : cents === null ? "Can't be read" : fmt(cents);
  const each = side.quantity !== null && side.rate !== null ? `${qty(side.quantity)} × ${money.format(side.rate)}` : side.quantity !== null ? `${qty(side.quantity)}` : '';
  const f = own ? (side as NonNullable<OwnLinePair['fleetsuite']>) : null;
  return (
    <div>
      <div style={{ fontWeight: 700 }}>{amount}</div>
      {each && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{each}</div>}
      {f && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{f.taxable ? `Taxed ${fmt(f.taxCents)}` : 'Not taxed'}</div>}
    </div>
  );
}

/** What the books hold for the invoice, in a sentence. */
function booksText(invoice: Invoice): string {
  const b = invoice.books;
  if (!b) return invoice.status === 'voided' ? "Not in FleetSuite's books: NetSuite voided it." : "Not in FleetSuite's books yet.";
  const entry = `In FleetSuite's books as entry ${b.entryNo}`;
  if (invoice.status === 'voided') return `${entry}. NetSuite voided or deleted the invoice, so the next posting run reverses it.`;
  if (b.from === 'fleetsuite') return `${entry}, made from this copy.`;
  if (invoice.status === 'differs') return `${entry}, made from NetSuite's invoice, since this copy differs from it and NetSuite's is what the customer was billed.`;
  if (invoice.status === 'incomplete') return `${entry}, made from NetSuite's invoice, since this copy is incomplete.`;
  return `${entry}, made from NetSuite's invoice.`;
}

export default function BooksOwnInvoicePage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (id: string) => {
    try {
      if (!id) throw new Error('No invoice was named');
      const res = await apiFetch(`/api/admin/books/own-invoices?${new URLSearchParams({ id })}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setInvoice(json.invoice);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the invoice');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // Own invoices and the daily check link here with NetSuite's id for the invoice (deepLinks.booksOwnInvoice).
    load(new URLSearchParams(window.location.search).get('id') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const s = invoice ? STATUS[invoice.status] : null;

  return (
    <div>
      <div style={{ marginBottom: '10px', fontSize: '12px' }}>
        <Link href={deepLinks.booksOwnInvoices(invoice?.date ?? null)} style={{ color: 'var(--text-secondary)' }}>← Own invoices</Link>
      </div>
      {error && <div style={banner(RED)}>{error}</div>}

      {invoice && s && (
        <>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' }}>
              <span style={{ fontSize: '20px', fontWeight: 800 }}>{invoice.number}</span>
              {invoice.customer && <span style={{ fontSize: '16px', fontWeight: 600 }}>· {invoice.customer}</span>}
              <span style={chip(s.color)}>{s.chip}</span>
            </div>
            <div style={{ fontSize: '12px', color: invoice.status === 'differs' ? RED : 'var(--text-muted)', marginTop: '4px' }}>{invoice.summary}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              FleetSuite&apos;s own copy, made from {invoice.madeFromText}.
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              {booksText(invoice)}{' '}
              {/* The entry is dated in the month NetSuite booked the invoice into, which Invoices vs NetSuite lists it under. */}
              <Link href={deepLinks.booksDocument('BMG', 'invoice', invoice.books?.date ?? invoice.date, invoice.netsuiteId)} style={{ color: 'var(--text-secondary)' }}>
                {invoice.status === 'matches' && invoice.books?.from === 'netsuite' ? 'Why, on Invoices vs NetSuite' : 'How it posts, on Invoices vs NetSuite'}
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
                {invoice.fields.map((f) => (
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

          {invoice.lines.length > 0 && (
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
                    {invoice.lines.map((l, i) => {
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

          {invoice.unknowns.length > 0 && (
            <>
              <div style={heading}>What FleetSuite didn&apos;t know</div>
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                {invoice.unknowns.map((u) => <li key={u}>{u.charAt(0).toUpperCase()}{u.slice(1)}.</li>)}
              </ul>
            </>
          )}

          <div style={heading}>How FleetSuite worked it out</div>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {invoice.workedOut.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
