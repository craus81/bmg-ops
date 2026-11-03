'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { OwnCheckStatus } from '@/lib/books/own-invoice-check';
import type { OwnFulfillmentCheck } from '@/lib/books/own-fulfillment-check';
import type { OwnPostingView } from '@/lib/books/own-posting-view';
import { OwnBooksLine, OwnEntry } from '@/components/BooksOwnPosting';
import { NetSuitePosted, TakenItems } from '@/components/BooksTakenStock';

/**
 * Books → Own fulfillments → one of FleetSuite's own fulfillments, next to
 * NetSuite's (migration 416, src/lib/books/own-fulfillment-check.ts,
 * docs/books.md "FleetSuite's own fulfillments").
 *
 * What's compared, each with FleetSuite's and NetSuite's side and why they
 * differ; each item FleetSuite took from stock paired with NetSuite's, with
 * where it was taken from and the count and value FleetSuite costed it from
 * (each item opens its moves there on Stock by item); what the books hold
 * for it, and the entry this copy makes next to NetSuite's, or when it isn't
 * worked out what NetSuite's fulfillment posted (migration 456,
 * src/lib/books/own-posting-view.ts);
 * what FleetSuite couldn't work out; and how it worked its copy out. Open
 * to whoever opens the books; opened from Own fulfillments or the daily
 * check's notification (?id=, NetSuite's id for the fulfillment).
 */

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
 * A row of the table: its label, then FleetSuite's side, NetSuite's and the mark. On a phone the label takes a row of
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

export default function BooksOwnFulfillmentPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [fulfillment, setFulfillment] = useState<OwnFulfillmentCheck | null>(null);
  const [posting, setPosting] = useState<OwnPostingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (id: string) => {
    try {
      if (!id) throw new Error('No fulfillment was named');
      const res = await apiFetch(`/api/admin/books/own-fulfillments?${new URLSearchParams({ id })}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setFulfillment(json.fulfillment);
      setPosting(json.posting ?? null);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the fulfillment');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // Own fulfillments and the daily check link here with NetSuite's id for the fulfillment (deepLinks.booksOwnFulfillment).
    load(new URLSearchParams(window.location.search).get('id') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const f = fulfillment;
  const s = f ? STATUS[f.status] : null;

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
              FleetSuite&apos;s own copy, made when it invoiced {f.madeFromText} off {f.salesOrder}.
            </div>
            <OwnBooksLine posting={posting} status={f.status} theirs="fulfillment" company="BMG" kind="stock" netsuiteId={f.netsuiteId} date={f.date} />
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

          <TakenItems
            items={f.items}
            locationId={f.locationId}
            copied={f.fields.some((field) => field.field === 'items' && field.netsuite !== null)}
          />

          {/* The entry above puts NetSuite's posting next to this copy's once it's worked out. */}
          {!posting?.entry?.length && <NetSuitePosted entry={f.entry} title="What NetSuite's fulfillment posted" />}

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
