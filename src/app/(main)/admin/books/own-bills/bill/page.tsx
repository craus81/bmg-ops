'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { OwnCheckStatus } from '@/lib/books/own-invoice-check';
import type { BillLinePair, OwnBillCheck } from '@/lib/books/own-bill-check';

/**
 * Books → Own bills → one of Books' own bills, next to NetSuite's (migration
 * 435, src/lib/books/own-bill-check.ts, docs/books.md "FleetSuite's own
 * bills and receipts").
 *
 * What's compared, each with Books' and NetSuite's side and why they differ;
 * each line paired with NetSuite's by what it's for; what FleetSuite
 * couldn't work out; and how Books worked its copy out. Super admins only,
 * as the books are; opened from Own bills or the daily check's notification
 * (?id=, NetSuite's id for the bill).
 */

type Bill = OwnBillCheck & { netsuiteUrl: string | null; poUrl: string | null };

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
const qty = (n: number) => String(Number(n.toFixed(4)));

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#fbbf24';
const BLUE = '#60a5fa';
const GRAY = '#9ca3af';

/** Each status: its chip, its color, and what NetSuite's side says when it has nothing. */
const STATUS: Record<OwnCheckStatus, { chip: string; color: string; none: string }> = {
  differs: { chip: 'Differs from NetSuite', color: RED, none: 'Not known' },
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

/** One side of a line: its amount, and how many when it bills an item. */
function Side({ side, missing }: { side: BillLinePair['fleetsuite'] | BillLinePair['netsuite']; missing: string }) {
  if (!side) return <span style={{ color: 'var(--text-muted)' }}>{missing}</span>;
  return (
    <div>
      <div style={{ fontWeight: 700, color: side.cents === null ? 'var(--text-muted)' : undefined }}>{side.cents === null ? 'Not known' : fmt(side.cents)}</div>
      {side.quantity !== null && <div style={muted}>{qty(side.quantity)}</div>}
    </div>
  );
}

/** Where FleetSuite made the bill, as a link to it when there's a page for it. */
function MadeFrom({ bill }: { bill: Bill }) {
  if (bill.madeFrom === 'vendor_invoice' && bill.madeFromId) {
    return <Link href={deepLinks.apInvoice(bill.madeFromId)} style={link}>the CNI vendor invoice</Link>;
  }
  if (bill.madeFrom === 'payout') return <Link href="/admin/cni/payouts" style={link}>an installer payout</Link>;
  if (bill.madeFrom === 'parts_mail') return <Link href="/admin/parts-mail" style={link}>a Parts Mail invoice</Link>;
  return <>{bill.madeFromText}</>;
}

export default function BooksOwnBillPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [bill, setBill] = useState<Bill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (id: string) => {
    try {
      if (!id) throw new Error('No bill was named');
      const res = await apiFetch(`/api/admin/books/own-bills?${new URLSearchParams({ id })}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setBill(json.bill);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the bill');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // Own bills and the daily check link here with NetSuite's id for the bill (deepLinks.booksOwnBill).
    load(new URLSearchParams(window.location.search).get('id') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const b = bill;
  const s = b ? STATUS[b.status] : null;

  return (
    <div>
      <div style={{ marginBottom: '10px', fontSize: '12px' }}>
        <Link href={deepLinks.booksOwnBills(b?.date ?? null)} style={link}>← Own bills</Link>
      </div>
      {error && <div style={banner(RED)}>{error}</div>}

      {b && s && (
        <>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' }}>
              <span style={{ fontSize: '20px', fontWeight: 800 }}>{b.vendor ?? 'A vendor'}</span>
              <span style={{ fontSize: '16px', fontWeight: 600 }}>· {b.number}</span>
              <span style={chip(s.color)}>{s.chip}</span>
            </div>
            <div style={{ fontSize: '12px', color: b.status === 'differs' ? RED : 'var(--text-muted)', marginTop: '4px' }}>{b.summary}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              Books&apos; own copy of the bill FleetSuite made for {b.company} from <MadeFrom bill={b} />
              {b.poNumber ? `, from ${b.poNumber}` : ''}. Nothing is posted from it yet.
            </div>
            {(b.netsuiteUrl || b.poUrl) && (
              <div style={{ fontSize: '12px', marginTop: '2px' }}>
                {b.netsuiteUrl && <a href={b.netsuiteUrl} target="_blank" rel="noreferrer" style={link}>Bill in NetSuite ↗</a>}
                {b.netsuiteUrl && b.poUrl && ' · '}
                {b.poUrl && <a href={b.poUrl} target="_blank" rel="noreferrer" style={link}>{b.poNumber ?? 'Purchase order'} in NetSuite ↗</a>}
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
                {b.fields.map((field) => (
                  <TableRow
                    key={field.field}
                    span={3}
                    label={<div><div style={{ fontWeight: 700 }}>{field.label}</div><Why text={field.why} differs={field.same === false} /></div>}
                    style={{ borderTop: '1px solid var(--border)' }}
                  >
                    <td style={{ ...cell, whiteSpace: 'normal', color: field.fleetsuite === null ? 'var(--text-muted)' : undefined }}>{field.fleetsuite ?? 'Not known'}</td>
                    <td style={{ ...cell, whiteSpace: 'normal', color: field.netsuite === null ? 'var(--text-muted)' : undefined }}>{field.netsuite ?? STATUS[b.status].none}</td>
                    <td style={cell}><Mark same={field.same} /></td>
                  </TableRow>
                ))}
              </tbody>
            </table>
          </div>

          {b.lines.length > 0 && (
            <>
              <div style={heading}>Lines</div>
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
                <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                      <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>For</th>
                      <th style={sideHead}>FleetSuite</th>
                      <th style={sideHead}>NetSuite</th>
                      <th style={markHead} aria-label="Same" />
                    </tr>
                  </thead>
                  <tbody>
                    {b.lines.map((line, i) => (
                      <TableRow
                        key={`${line.label}-${i}`}
                        span={3}
                        label={(
                          <div>
                            <div style={{ fontWeight: 700 }}>{line.label}</div>
                            {line.description && line.description !== line.label && (
                              <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{line.description}</div>
                            )}
                            <Why text={line.why} differs={line.same === false} />
                          </div>
                        )}
                        style={{ borderTop: '1px solid var(--border)' }}
                      >
                        <td style={cell}><Side side={line.fleetsuite} missing="No line" /></td>
                        <td style={cell}><Side side={line.netsuite} missing={b.netsuiteCents === null ? STATUS[b.status].none : 'No line'} /></td>
                        <td style={cell}><Mark same={line.same} /></td>
                      </TableRow>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {b.unknowns.length > 0 && (
            <>
              <div style={heading}>What FleetSuite didn&apos;t know</div>
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                {b.unknowns.map((u) => <li key={u}>{u.charAt(0).toUpperCase()}{u.slice(1)}.</li>)}
              </ul>
            </>
          )}

          <div style={heading}>How Books worked it out</div>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {b.workedOut.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
