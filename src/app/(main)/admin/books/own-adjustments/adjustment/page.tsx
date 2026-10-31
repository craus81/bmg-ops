'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { OwnCheckStatus } from '@/lib/books/own-invoice-check';
import type { OwnAdjustmentCheck } from '@/lib/books/own-adjustment-check';
import type { OwnPostingView } from '@/lib/books/own-posting-view';
import { OwnBooksLine, OwnEntry } from '@/components/BooksOwnPosting';

/**
 * Books → Own adjustments → one change made with Inventory Adjust, next to
 * NetSuite's adjustment (migration 457, src/lib/books/own-adjustment-check.ts,
 * docs/books.md "FleetSuite's own adjustments").
 *
 * What's compared, each with FleetSuite's and NetSuite's side and why they
 * differ; what the books hold for NetSuite's adjustment, and the entry this
 * copy makes next to NetSuite's, or when it isn't worked out what NetSuite's
 * adjustment posted (src/lib/books/own-posting-view.ts); what FleetSuite
 * couldn't work out; and how it worked its copy out. The item opens its moves
 * on Stock by item. Super admins only, as the books are; opened from Own
 * adjustments or the daily check's notification (?id=, FleetSuite's id for
 * the Inventory Adjust).
 */

type Adjustment = OwnAdjustmentCheck & { netsuiteUrl: string | null };

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

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
  voided: { chip: 'Gone from NetSuite', color: GRAY },
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

export default function BooksOwnAdjustmentPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [adjustment, setAdjustment] = useState<Adjustment | null>(null);
  const [posting, setPosting] = useState<OwnPostingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (id: string) => {
    try {
      if (!id) throw new Error('No Inventory Adjust was named');
      const res = await apiFetch(`/api/admin/books/own-adjustments?${new URLSearchParams({ id })}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setAdjustment(json.adjustment);
      setPosting(json.posting ?? null);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the adjustment');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    // Own adjustments and the daily check link here with FleetSuite's id for the Inventory Adjust (deepLinks.booksOwnAdjustment).
    load(new URLSearchParams(window.location.search).get('id') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const a = adjustment;
  const s = a ? STATUS[a.status] : null;
  const debits = a ? a.entry.reduce((sum, e) => sum + e.debit, 0) : 0;
  const credits = a ? a.entry.reduce((sum, e) => sum + e.credit, 0) : 0;

  return (
    <div>
      <div style={{ marginBottom: '10px', fontSize: '12px' }}>
        <Link href={deepLinks.booksOwnAdjustments(a?.date ?? null)} style={{ color: 'var(--text-secondary)' }}>← Own adjustments</Link>
      </div>
      {error && <div style={banner(RED)}>{error}</div>}

      {a && s && (
        <>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' }}>
              <span style={{ fontSize: '20px', fontWeight: 800 }}>{a.number}</span>
              <span style={{ fontSize: '16px', fontWeight: 600 }}>· {a.item}, {a.changeText}</span>
              <span style={chip(s.color)}>{s.chip}</span>
            </div>
            <div style={{ fontSize: '12px', color: a.status === 'differs' ? RED : 'var(--text-muted)', marginTop: '4px' }}>{a.summary}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              Books&apos; own copy of {a.madeBy ? `${a.madeBy}'s` : 'an'} Inventory Adjust on {dayText(a.date)}: {a.reason}
              {a.note ? `, “${a.note}”` : ''}.
            </div>
            {a.netsuiteId ? (
              <OwnBooksLine posting={posting} status={a.status} theirs="adjustment" company="BMG" kind="stock" netsuiteId={a.netsuiteId} date={a.date} />
            ) : (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                Not posted from this copy: NetSuite didn&apos;t say which adjustment it made, so the books post NetSuite&apos;s
                adjustments as NetSuite booked them.
              </div>
            )}
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              {/* The item's moves where it was changed, on Stock by item. */}
              <Link href={deepLinks.booksStockItem(a.itemId, a.locationId)} style={{ color: 'var(--text-secondary)' }}>
                {a.item} on Stock by item
              </Link>
              {a.description && a.description !== a.item ? ` · ${a.description}` : ''}
              {a.netsuiteUrl && (
                <>
                  {' · '}
                  <a href={a.netsuiteUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)' }}>{a.number} in NetSuite ↗</a>
                </>
              )}
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
                {a.fields.map((field) => (
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

          <OwnEntry posting={posting} />

          {/* The entry above puts NetSuite's posting next to this copy's once it's worked out. */}
          {a.entry.length > 0 && !posting?.entry?.length && (
            <>
              <div style={heading}>What NetSuite&apos;s adjustment posted</div>
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
                    {a.entry.map((e) => (
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

          {a.unknowns.length > 0 && (
            <>
              <div style={heading}>What FleetSuite didn&apos;t know</div>
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                {a.unknowns.map((u) => <li key={u}>{u.charAt(0).toUpperCase()}{u.slice(1)}.</li>)}
              </ul>
            </>
          )}

          <div style={heading}>How FleetSuite worked it out</div>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {a.workedOut.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
