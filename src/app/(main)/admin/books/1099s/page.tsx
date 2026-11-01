'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess, booksAllows } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { docName, unsplitReason, type Payee1099, type Payment1099, type PaymentType, type Year1099 } from '@/lib/books/1099s';
import {
  read1099ReportFile, scrub, titleYears, type Comparison1099, type ComparedVendor, type Report1099, type ReportColumn,
} from '@/lib/books/1099-report';

/**
 * Books → 1099s (part 50, migration 481, src/lib/books/1099s.ts,
 * docs/books.md "1099s"; the NetSuite Exit Checklist, thread "Replacing
 * NetSuite with FleetSuite", 2026-10-31): the 1099 dry run.
 *
 * What each vendor NetSuite marks to get a 1099 was paid in one company's
 * year on the accounts that count toward one, by category, worked out from
 * FleetSuite's copy of NetSuite the way NetSuite counts it: checks on their
 * own lines' accounts, bill payments on the accounts of the bills they paid.
 * Card payments are left out and listed, with whoever was paid on an
 * account that counts without being marked, whoever is marked but was paid
 * only on other accounts, and the payments FleetSuite can't split. Tap a
 * vendor for its payments. Nothing is filed or sent. Open to whoever opens
 * the books.
 *
 * NetSuite's 1099 report for the year can be dropped on it (part 51,
 * migration 482, src/lib/books/1099-report.ts): it's read here on the
 * device, only each vendor's names and amounts are kept (never a tax ID),
 * and the two are shown side by side, vendor by vendor and box by box.
 */

type Copy = { at: string | null; tried: string | null; error: string | null } | null;

/** NetSuite's 1099 report as kept for the year (migration 482). */
interface ReportInfo {
  fileName: string;
  title: string[];
  columns: ReportColumn[];
  leftOut: string[];
  skipped: Report1099['skipped'];
  vendors: number;
  uploadedBy: string | null;
  uploadedAt: string;
}

interface Payload extends Year1099 {
  companies: Array<{ code: string; name: string }>;
  company: string;
  year: number;
  years: number[];
  report: ReportInfo | null;
  comparison: Comparison1099 | null;
  copies: {
    chart: Copy;
    accounts1099: { received?: number; error?: string } | null;
    lists: Copy;
    vendors: { error: string | null; missing: string[] } | null;
    ledger: Copy;
    billPayments: Copy;
    spending: Copy;
  };
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const TYPE_NAMES: Record<PaymentType, string> = {
  Check: 'Check', VendPymt: 'Bill payment', CardChrg: 'Card charge', CardRfnd: 'Card refund',
};
const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#fbbf24';

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const note: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' };

const button = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: '8px', border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border)'}`,
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: active ? 800 : 600, cursor: 'pointer',
});

const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const labelCell: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };
const tableBox: React.CSSProperties = { overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '14px' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' };
const muted: React.CSSProperties = { fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' };
const section: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--card)', marginBottom: '10px' };
const summary: React.CSSProperties = { padding: '10px 14px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' };

/**
 * A row of a table: its label, then `amounts` amounts. On a phone the label
 * takes a row of its own above them (.rep-label-row in globals.css), as on
 * Reports, spanning the amounts, since the label's own cell is hidden there.
 */
function Row({ label, amounts, style, onClick, children }: {
  label: React.ReactNode; amounts: number; style?: React.CSSProperties; onClick?: () => void; children: React.ReactNode;
}) {
  const clickable = onClick ? { ...style, cursor: 'pointer' } : style;
  return (
    <>
      <tr className="rep-label-row" style={clickable} onClick={onClick}><td colSpan={amounts} style={labelCell}>{label}</td></tr>
      <tr className="rep-amounts" style={clickable} onClick={onClick}>
        <td className="rep-label" style={labelCell}>{label}</td>
        {children}
      </tr>
    </>
  );
}

const amount = (cents: number | undefined, strong?: boolean) => (
  <td style={{ ...cell, fontWeight: strong ? 800 : 400, color: cents ? 'var(--text-primary)' : 'var(--text-muted)' }}>
    {cents ? fmt(cents) : '—'}
  </td>
);

/** One payment: when, what, how much, and where it went or why it's left out. */
function PaymentLine({ p, categories }: { p: Payment1099; categories: string[] }) {
  const boxes = categories.filter((c) => p.boxes[c]).map((c) => `${fmt(p.boxes[c])} ${c}`);
  return (
    <div style={{ padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
        <span>{shortDate(p.date)} · {TYPE_NAMES[p.type]}{p.number ? ` ${p.number}` : ''}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(p.cents)}</span>
      </div>
      <div style={{ ...muted, color: p.unsplit ? RED : 'var(--text-muted)' }}>
        {p.byCard ? 'Paid by card, so left out.'
          : p.unsplit ? `Can't split: ${unsplitReason(p.unsplit)}`
            : boxes.length ? `On accounts that count: ${boxes.join(', ')}` : 'Nothing on an account that counts toward a 1099.'}
        {p.paid.length > 0 && !p.byCard && ` Paid ${p.paid.map(docName).join(', ')}.`}
      </div>
    </div>
  );
}

function Payments({ payee, categories }: { payee: Payee1099; categories: string[] }) {
  return (
    <div style={{ padding: '0 10px 8px' }}>
      {payee.payments.map((p) => <PaymentLine key={p.netsuiteId} p={p} categories={categories} />)}
    </div>
  );
}

/** A vendor's name, its legal name under it when that differs, and what else there is to know. */
function PayeeLabel({ p, open, extra }: { p: Payee1099; open: boolean; extra?: string }) {
  const about = [
    p.legalName ? `Legal name ${p.legalName}` : '',
    count(p.payments.length, 'payment', 'payments'),
    extra ?? '',
  ].filter(Boolean).join(' · ');
  return (
    <div>
      <span className="rep-link" style={{ fontWeight: 700 }}>{p.name}</span>
      <span style={{ ...muted, marginLeft: '6px' }}>{open ? '▴' : '▾'}</span>
      <div style={muted}>{about}</div>
      {p.unsplit !== 0 && <div style={{ ...muted, color: RED }}>FleetSuite can&apos;t split {fmt(p.unsplit)} of what it was paid.</div>}
    </div>
  );
}

/** A list of vendors, each with its amounts, that opens to its payments. */
function PayeeTable({ payees, heading, columns, amounts, extra, categories }: {
  payees: Payee1099[];
  heading: string;
  columns: string[];
  amounts: (p: Payee1099) => Array<number | undefined>;
  extra?: (p: Payee1099) => string;
  categories: string[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div style={tableBox}>
      <table className="rep-table" style={table}>
        <thead>
          <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
            <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>{heading}</th>
            {columns.map((c) => <th key={c} style={{ ...cell, whiteSpace: 'normal' }}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {payees.map((p) => {
            const isOpen = open === p.payee;
            const values = amounts(p);
            return (
              <Fragment key={p.payee || 'none'}>
                <Row
                  amounts={columns.length}
                  style={{ borderTop: '1px solid var(--border)' }}
                  onClick={() => setOpen(isOpen ? null : p.payee)}
                  label={<PayeeLabel p={p} open={isOpen} extra={extra?.(p)} />}
                >
                  {values.map((v, i) => <Fragment key={columns[i]}>{amount(v, i === values.length - 1)}</Fragment>)}
                </Row>
                {isOpen && (
                  <tr><td colSpan={columns.length + 1}><Payments payee={p} categories={categories} /></td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const linkButton: React.CSSProperties = {
  padding: 0, border: 'none', background: 'none', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 600,
  cursor: 'pointer', textDecoration: 'underline',
};

/** A difference: red when there is one. */
const difference = (cents: number) => (
  <td style={{ ...cell, fontWeight: 700, color: cents ? RED : 'var(--text-muted)' }}>{cents ? fmt(cents) : '—'}</td>
);

/** A vendor in both, with how NetSuite's report names it when that's different, and where it differs. */
function ComparedLabel({ v, open }: { v: ComparedVendor; open: boolean }) {
  const other = v.labels.filter((l) => l !== v.name);
  const boxes = Object.keys(v.differences.boxes);
  return (
    <div>
      <span className="rep-link" style={{ fontWeight: 700 }}>{v.name}</span>
      <span style={{ ...muted, marginLeft: '6px' }}>{open ? '▴' : '▾'}</span>
      {other.length > 0 && <div style={muted}>In NetSuite&apos;s report as {other.join(', ')}</div>}
      {boxes.length > 0 && <div style={{ ...muted, color: RED }}>Differs in {boxes.join(', ')}</div>}
      {v.marked === false && <div style={{ ...muted, color: RED }}>Not marked to get a 1099 in NetSuite&apos;s vendor list</div>}
      {v.marked === null && <div style={{ ...muted, color: RED }}>FleetSuite&apos;s copy of the vendor list doesn&apos;t say whether it gets a 1099</div>}
      {v.unsplit !== 0 && <div style={{ ...muted, color: RED }}>FleetSuite can&apos;t split {fmt(v.unsplit)} of what it was paid.</div>}
    </div>
  );
}

/** A vendor's boxes side by side. */
function BoxLines({ v, cmp }: { v: ComparedVendor; cmp: Comparison1099 }) {
  const line = (label: string, netsuite: number, fleetsuite: number) => {
    const d = netsuite - fleetsuite;
    return (
      <div key={label} style={{ padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
        <div style={{ fontWeight: 700 }}>{label}</div>
        <div style={{ ...muted, color: d ? RED : 'var(--text-muted)' }}>
          NetSuite {fmt(netsuite)} · FleetSuite {fmt(fleetsuite)}{d ? ` · Difference ${fmt(d)}` : ' · Same'}
        </div>
      </div>
    );
  };
  return (
    <div style={{ padding: '0 10px 8px' }}>
      {cmp.boxes.map((b) => line(b, v.netsuite.boxes[b] ?? 0, v.fleetsuite.boxes[b] ?? 0))}
      {line(cmp.hasTotal ? 'Total' : 'Total (NetSuite\'s is its boxes added up)', v.netsuite.total, v.fleetsuite.total)}
    </div>
  );
}

/** What was read from the report and what was left out of it. */
function readNote(r: ReportInfo, cmp: Comparison1099): string {
  const columns = r.columns.map((c) => (c.box === null ? `${c.header} as the total` : c.box === c.header ? c.header : `${c.header} as ${c.box}`));
  return [
    `Read ${columns.join(', ')}.`,
    cmp.hasTotal ? '' : "It has no total, so NetSuite's total is its boxes added up.",
    r.leftOut.length ? `Left out: ${r.leftOut.join(', ')}.` : '',
    r.skipped.totals ? `${count(r.skipped.totals, 'total row', 'total rows')} skipped.` : '',
    r.skipped.combined ? `${count(r.skipped.combined, 'vendor listed again was', 'vendors listed again were')} added to the first.` : '',
  ].filter(Boolean).join(' ');
}

type Busy = '' | 'reading' | 'saving' | 'removing';

/** NetSuite's 1099 report: a box to drop it in, then the two side by side. Only
 *  the bookkeeper and super admins upload it or take it off; the CPA reads it. */
function NetSuiteReport({ data, busy, problems, error, canKeep, onFile, onRemove }: {
  data: Payload;
  busy: Busy;
  problems: string[];
  error: string;
  canKeep: boolean;
  onFile: (f: File | undefined) => void;
  onRemove: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const r = data.report;
  const cmp = data.comparison;
  const years = r ? titleYears(r.title) : [];
  const differ = cmp?.vendors.filter((v) => !v.same) ?? [];
  const same = cmp?.vendors.filter((v) => v.same) ?? [];

  const parts: Array<[string, string]> = cmp ? ([
    [cmp.counts.same ? `${count(cmp.counts.same, 'vendor matches', 'vendors match')} to the cent` : '', GREEN],
    [cmp.counts.differ ? `${count(cmp.counts.differ, 'differs', 'differ')}` : '', RED],
    [cmp.counts.onlyInReport ? `${count(cmp.counts.onlyInReport, 'is', 'are')} only in NetSuite's report` : '', RED],
    [cmp.counts.onlyInFleetSuite ? `${count(cmp.counts.onlyInFleetSuite, 'of FleetSuite\'s 1099s isn\'t', 'of FleetSuite\'s 1099s aren\'t')} in it` : '', RED],
  ] as Array<[string, string]>).filter(([t]) => t) : [];

  return (
    <div
      style={{ ...section, padding: '10px 14px', borderColor: dragging ? GREEN : 'var(--border)' }}
      onDragOver={canKeep ? (e) => { e.preventDefault(); setDragging(true); } : undefined}
      onDragLeave={canKeep ? () => setDragging(false) : undefined}
      onDrop={canKeep ? (e) => { e.preventDefault(); setDragging(false); onFile(e.dataTransfer.files?.[0]); } : undefined}
    >
      <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '6px' }}>Against NetSuite&apos;s 1099 report</div>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,text/csv"
        disabled={!!busy}
        style={{ display: 'none' }}
        onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      {!r && !canKeep && (
        <div style={muted}>No 1099 report from NetSuite is kept for {data.year} yet. The bookkeeper or a super admin uploads it here.</div>
      )}

      {!r && canKeep && (
        <div
          onClick={() => !busy && fileRef.current?.click()}
          style={{
            border: `2px dashed ${dragging ? GREEN : 'var(--border)'}`, borderRadius: '8px', padding: '12px', cursor: busy ? 'default' : 'pointer',
            background: dragging ? `${GREEN}10` : 'transparent', fontSize: '12px', color: 'var(--text-secondary)',
          }}
        >
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Drop NetSuite&apos;s 1099 report for {data.year} here, or tap to choose the file</div>
          <div style={{ marginTop: '2px' }}>
            In NetSuite, open the 1099 report for {data.year} and use Export – CSV (an Excel .xlsx works too). It&apos;s read on this
            device, and only each vendor&apos;s names and amounts are kept, never a tax ID or an address.
          </div>
        </div>
      )}

      {r && (
        <div style={{ ...muted, marginBottom: '6px' }}>
          {r.fileName}, uploaded{r.uploadedBy ? ` by ${r.uploadedBy}` : ''} {ago(r.uploadedAt)} · {count(r.vendors, 'vendor', 'vendors')}
          {canKeep && (
            <>
              {' · '}
              <button style={linkButton} disabled={!!busy} onClick={() => fileRef.current?.click()}>Upload a new one</button>
              {' · '}
              <button style={linkButton} disabled={!!busy} onClick={onRemove}>Take it off</button>
            </>
          )}
        </div>
      )}

      {busy === 'reading' && <div style={muted}>Reading the file…</div>}
      {busy === 'saving' && <div style={muted}>Keeping it…</div>}
      {busy === 'removing' && <div style={muted}>Taking it off…</div>}
      {error && <div style={{ fontSize: '12px', color: RED, fontWeight: 700, marginTop: '6px' }}>{error}</div>}
      {problems.length > 0 && (
        <div style={{ fontSize: '12px', color: RED, display: 'grid', gap: '2px', marginTop: '6px' }}>
          <div style={{ fontWeight: 700 }}>Nothing was kept:</div>
          {problems.map((p, i) => <div key={`${i}-${p}`}>{p}</div>)}
        </div>
      )}

      {r && cmp && (
        <>
          {years.length > 0 && !years.includes(data.year) && (
            <div style={banner(AMBER)}>
              NetSuite&apos;s report says {years.join(' and ')} in its title, and this is {data.year}. Check it&apos;s {data.year}&apos;s report.
            </div>
          )}
          {r.skipped.noName > 0 && (
            <div style={banner(AMBER)}>
              {count(r.skipped.noName, 'row', 'rows')} of the report had amounts but no vendor named, so{' '}
              {r.skipped.noName === 1 ? 'it was' : 'they were'} left out. NetSuite&apos;s summary report lists one vendor a row.
            </div>
          )}

          <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>
            {parts.length === 1 && cmp.counts.same
              ? <span style={{ color: GREEN }}>All {count(cmp.counts.same, 'vendor matches', 'vendors match')} to the cent.</span>
              : parts.map(([t, color], i) => <span key={t} style={{ color }}>{i ? ' · ' : ''}{t}</span>)}
          </div>

          {differ.length > 0 && (
            <div style={tableBox}>
              <table className="rep-table" style={table}>
                <thead>
                  <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                    <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Differs</th>
                    <th style={cell}>NetSuite</th>
                    <th style={cell}>FleetSuite</th>
                    <th style={cell}>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {differ.map((v) => {
                    const isOpen = open === v.payee;
                    return (
                      <Fragment key={v.payee || 'none'}>
                        <Row
                          amounts={3}
                          style={{ borderTop: '1px solid var(--border)' }}
                          onClick={() => setOpen(isOpen ? null : v.payee)}
                          label={<ComparedLabel v={v} open={isOpen} />}
                        >
                          {amount(v.netsuite.total)}
                          {amount(v.fleetsuite.total)}
                          {difference(v.differences.total)}
                        </Row>
                        {isOpen && <tr><td colSpan={4}><BoxLines v={v} cmp={cmp} /></td></tr>}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {cmp.onlyInReport.length > 0 && (
            <details style={section} open>
              <summary style={{ ...summary, color: RED }}>Only in NetSuite&apos;s report ({cmp.onlyInReport.length.toLocaleString('en-US')})</summary>
              <div style={{ padding: '0 14px 8px' }}>
                {cmp.onlyInReport.map((o) => (
                  <div key={o.label} style={{ padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                      <span style={{ fontWeight: 700 }}>{o.label}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(o.netsuite.total)}</span>
                    </div>
                    <div style={muted}>
                      {o.candidates.length
                        ? `Its names fit more than one of FleetSuite's vendors: ${o.candidates.join(', ')}.`
                        : `FleetSuite has no vendor by that name paid in ${data.year}.`}
                      {o.names.length ? ` Also named ${o.names.join(', ')}.` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {cmp.onlyInFleetSuite.length > 0 && (
            <details style={section} open>
              <summary style={{ ...summary, color: RED }}>
                FleetSuite&apos;s 1099s not in NetSuite&apos;s report ({cmp.onlyInFleetSuite.length.toLocaleString('en-US')})
              </summary>
              <div style={{ ...note, padding: '0 14px' }}>
                FleetSuite applies no minimum, and NetSuite&apos;s report may leave out a vendor paid under $600, so a small one here may be why.
              </div>
              <div style={{ padding: '0 14px 8px' }}>
                {cmp.onlyInFleetSuite.map((p) => (
                  <div key={p.payee} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                    <span>
                      <span style={{ fontWeight: 700 }}>{p.name}</span>
                      {p.legalName && <span style={{ ...muted, marginLeft: '6px' }}>Legal name {p.legalName}</span>}
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(p.fleetsuite.total)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {same.length > 0 && (
            <details style={section}>
              <summary style={{ ...summary, color: GREEN }}>Match to the cent ({same.length.toLocaleString('en-US')})</summary>
              <div style={{ padding: '0 14px 8px' }}>
                {same.map((v) => (
                  <div key={v.payee} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                    <span style={{ fontWeight: 700 }}>{v.name}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(v.netsuite.total)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          <div style={muted}>{readNote(r, cmp)}</div>
        </>
      )}
    </div>
  );
}

const WHY_NOT_MARKED = (p: Payee1099) =>
  !p.vendor ? "Not a vendor in NetSuite's list" : p.marked === false ? 'Not marked to get a 1099' : "NetSuite hasn't said whether it gets one";

export default function Books1099sPage() {
  const router = useRouter();
  const { hasRole, hasFeature, canSeeMoney, loading: authLoading } = useAuth();
  // The CPA reads the year; the bookkeeper and super admins keep NetSuite's report.
  const canKeep = booksAllows(booksAccess(hasRole), 'keep');
  // Vendor Details is a Payments page (src/app/(main)/admin/vendor-details).
  const canVendorDetails = hasFeature('vendor_payments') && canSeeMoney;
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [introOpen, setIntroOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>('');
  const [problems, setProblems] = useState<string[]>([]);
  const [reportError, setReportError] = useState('');

  const load = useCallback(async (company: string, year: string) => {
    try {
      const params = new URLSearchParams();
      if (company) params.set('company', company);
      if (year) params.set('year', year);
      const res = await apiFetch(`/api/admin/books/1099s?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
      // Keep the address on what's shown, so going back here opens it again.
      window.history.replaceState(null, '', deepLinks.books1099s(json.company, json.year));
    } catch (e: any) {
      setError(e?.message || "Could not load the year's 1099s");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    const q = new URLSearchParams(window.location.search);
    load(q.get('company') ?? '', q.get('year') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const pick = (company: string, year: number) => {
    setLoading(true);
    setProblems([]);
    setReportError('');
    load(company, String(year));
  };

  // NetSuite's report is read here, and only its vendors' names and amounts are sent to be kept.
  const upload = async (file: File | undefined) => {
    if (!file || !data || busy) return;
    setProblems([]);
    setReportError('');
    setBusy('reading');
    try {
      const read = await read1099ReportFile(file, [...new Set(data.accounts.map((a) => a.category))]);
      if (!read.report) {
        setProblems(read.problems);
        return;
      }
      setBusy('saving');
      const res = await apiFetch('/api/admin/books/1099s', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: data.company, year: data.year, report: { ...read.report, fileName: scrub(file.name) } }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Couldn't keep the report (${res.status})`);
      await load(data.company, String(data.year));
    } catch (e: any) {
      setReportError(e?.message || "Couldn't read that file");
    } finally {
      setBusy('');
    }
  };

  const removeReport = async () => {
    if (!data || busy || !window.confirm(`Take NetSuite's 1099 report for ${data.year} off? You can upload it again.`)) return;
    setReportError('');
    setBusy('removing');
    try {
      const res = await apiFetch('/api/admin/books/1099s', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: data.company, year: data.year, remove: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Couldn't take the report off (${res.status})`);
      await load(data.company, String(data.year));
    } catch (e: any) {
      setReportError(e?.message || "Couldn't take the report off");
    } finally {
      setBusy('');
    }
  };

  const companyName = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company;
  const categories = data?.categories ?? [];
  // One column per category, and a total when there's more than one.
  const columns = categories.length > 1 ? [...categories, 'Total'] : categories.length ? categories : ['On accounts that count'];
  const boxAmounts = (p: Payee1099) => (categories.length > 1
    ? [...categories.map((c) => p.boxes[c]), p.total]
    : [categories.length ? p.boxes[categories[0]] : p.total]);
  const copies = data?.copies;
  const failed = copies ? ([
    ['ledger', copies.ledger], ['bill payments', copies.billPayments], ['checks and card charges', copies.spending],
  ] as Array<[string, Copy]>).filter(([, c]) => c?.error) : [];

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>1099s</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {/* Two lines until More opens the rest below them. */}
          <div style={introOpen ? undefined : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            What each vendor NetSuite marks to get a 1099 was paid in the year, worked out from FleetSuite&apos;s copy of NetSuite, to
            check against NetSuite&apos;s 1099s. It counts what was paid by check or bill payment, by the date paid, on the accounts
            NetSuite gives a 1099-MISC category, each category a box of the form. A bill payment counts on the accounts of the bills it
            paid, split in proportion to the cent. Card payments are left out, as the card company reports them, and every vendor is
            shown whatever the amount. Tap a vendor for its payments. Drop NetSuite&apos;s 1099 report on it to see the two side by
            side, vendor by vendor and box by box. Nothing is filed or sent.
          </div>
          <button
            onClick={() => setIntroOpen(!introOpen)}
            style={{ padding: 0, border: 'none', background: 'none', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
          >
            {introOpen ? 'Less' : 'More'}
          </button>
          {' · '}
          <Link href="/admin/books/lists" style={{ color: 'var(--text-secondary)' }}>NetSuite lists</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
          {canVendorDetails && (
            <>
              {' · '}
              <Link href="/admin/vendor-details" style={{ color: 'var(--text-secondary)' }}>Vendor Details</Link>
            </>
          )}
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && copies && (
        <>
          {copies.vendors?.error && (
            <div style={banner(RED)}>NetSuite wouldn&apos;t list its vendors the last time FleetSuite copied its lists: {copies.vendors.error}</div>
          )}
          {!copies.vendors?.error && copies.vendors?.missing.includes('is_1099') && (
            <div style={banner(RED)}>
              NetSuite wouldn&apos;t say which vendors get a 1099 the last time FleetSuite copied its lists, so a vendor copied before
              then shows as it was, and one since as not saying.
            </div>
          )}
          {!data.flagsCopied && !copies.vendors?.missing.includes('is_1099') && (
            <div style={banner(AMBER)}>
              NetSuite&apos;s vendors haven&apos;t been copied with their 1099 flags yet, so no vendor shows as marked to get one. The copy of
              NetSuite&apos;s lists brings them every two hours, or press Sync now on NetSuite lists.
            </div>
          )}
          {copies.accounts1099?.error && (
            <div style={banner(RED)}>
              NetSuite wouldn&apos;t say which accounts count toward a 1099 the last time FleetSuite copied the chart of accounts:
              {' '}{copies.accounts1099.error}
            </div>
          )}
          {!copies.accounts1099 && (
            <div style={banner(AMBER)}>
              FleetSuite hasn&apos;t read which accounts count toward a 1099 yet, so nothing shows on them. The copy of the chart of
              accounts reads them every two hours, or press Sync now on the Chart of accounts.
            </div>
          )}
          {copies.accounts1099 && !copies.accounts1099.error && !data.accounts.length && (
            <div style={banner(AMBER)}>
              NetSuite gives no account a 1099-MISC category, so nothing counts toward a 1099. In NetSuite an account&apos;s 1099-MISC
              Category says which box of the form what&apos;s paid on it goes in.
            </div>
          )}
          {failed.map(([what, c]) => (
            <div key={what} style={banner(RED)}>The last copy of NetSuite&apos;s {what} failed{c?.tried ? ` ${ago(c.tried)}` : ''}: {c?.error}</div>
          ))}
          {data.notCopied.length > 0 && (
            <div style={banner(AMBER)}>
              {count(data.notCopied.length, 'check or bill payment', 'checks and bill payments')} in NetSuite&apos;s ledger for {data.year}
              {' '}{data.notCopied.length === 1 ? "isn't" : "aren't"} in FleetSuite&apos;s copies of the payments yet, so{' '}
              {data.notCopied.length === 1 ? "it isn't" : "they aren't"} counted: {data.notCopied.slice(0, 10).map((d) => d.number || d.netsuite_id).join(', ')}
              {data.notCopied.length > 10 ? ' and more' : ''}. The copies run every two hours.
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {data.companies.length > 1 && data.companies.map((c) => (
              <button key={c.code} onClick={() => pick(c.code, data.year)} disabled={loading} style={button(c.code === data.company)}>
                {c.name}
              </button>
            ))}
            {data.companies.length > 1 && <span style={{ width: '8px' }} />}
            {data.years.map((y) => (
              <button key={y} onClick={() => pick(data.company, y)} disabled={loading} style={button(y === data.year)}>{y}</button>
            ))}
          </div>

          <div style={note}>
            {data.forms.length
              ? `${companyName}, ${data.year}: ${count(data.forms.length, 'vendor', 'vendors')} marked to get a 1099 ${data.forms.length === 1 ? 'was' : 'were'} paid ${fmt(data.totals.total)} on accounts that count toward one.`
              : `${companyName}, ${data.year}: no vendor marked to get a 1099 was paid on an account that counts toward one.`}
            {copies.ledger?.at ? ` NetSuite's ledger copied ${ago(copies.ledger.at)}.` : ''}
            {copies.billPayments?.at ? ` Bill payments ${ago(copies.billPayments.at)}.` : ''}
            {copies.spending?.at ? ` Checks and card charges ${ago(copies.spending.at)}.` : ''}
          </div>

          <NetSuiteReport data={data} busy={busy} problems={problems} error={reportError} canKeep={canKeep} onFile={upload} onRemove={removeReport} />

          {data.forms.length > 0 && (
            <PayeeTable
              payees={data.forms}
              heading={`${companyName}'s 1099s for ${data.year}`}
              columns={columns}
              amounts={boxAmounts}
              categories={categories}
            />
          )}

          {data.notMarked.length > 0 && (
            <details style={section}>
              <summary style={{ ...summary, color: RED }}>
                Paid on accounts that count, not marked to get a 1099 ({data.notMarked.length.toLocaleString('en-US')})
              </summary>
              <div style={{ ...note, padding: '0 14px' }}>
                Each was paid on an account NetSuite counts toward a 1099. One that should get a 1099 needs it ticked on its vendor
                record (Vendor Details); one that shouldn&apos;t, an employee say, was likely paid on the wrong account.
              </div>
              <PayeeTable
                payees={data.notMarked}
                heading="Paid on accounts that count"
                columns={columns}
                amounts={boxAmounts}
                extra={WHY_NOT_MARKED}
                categories={categories}
              />
            </details>
          )}

          {data.unsplit.length > 0 && (
            <details style={section}>
              <summary style={{ ...summary, color: RED }}>Payments FleetSuite can&apos;t split ({data.unsplit.length.toLocaleString('en-US')})</summary>
              <div style={{ padding: '0 14px 8px' }}>
                {data.unsplit.map((p) => (
                  <div key={p.netsuiteId}>
                    <div style={{ ...muted, paddingTop: '6px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                      {p.name}{p.marked === true ? ' · marked to get a 1099' : ''}
                    </div>
                    <PaymentLine p={p} categories={categories} />
                  </div>
                ))}
              </div>
            </details>
          )}

          {data.nothingCounted.length > 0 && (
            <details style={section}>
              <summary style={summary}>Marked to get a 1099, paid only on other accounts ({data.nothingCounted.length.toLocaleString('en-US')})</summary>
              <div style={{ ...note, padding: '0 14px' }}>
                Nothing they were paid went to an account NetSuite counts toward a 1099, so NetSuite&apos;s 1099s leave them out too.
              </div>
              <PayeeTable
                payees={data.nothingCounted}
                heading="Marked, paid on other accounts"
                columns={['Paid']}
                amounts={(p) => [p.paid]}
                categories={categories}
              />
            </details>
          )}

          {data.byCard.length > 0 && (
            <details style={section}>
              <summary style={summary}>Marked to get a 1099, paid by card ({data.byCard.length.toLocaleString('en-US')})</summary>
              <div style={{ ...note, padding: '0 14px' }}>
                Left out of the totals above: the card company reports card payments, on a 1099-K.
              </div>
              <PayeeTable
                payees={data.byCard}
                heading="Paid by card"
                columns={['By card']}
                amounts={(p) => [p.byCard]}
                categories={categories}
              />
            </details>
          )}

          {data.accounts.length > 0 && (
            <details style={section}>
              <summary style={summary}>Accounts that count toward a 1099 ({data.accounts.length.toLocaleString('en-US')})</summary>
              <div style={{ padding: '0 14px 10px' }}>
                {data.accounts.map((a) => (
                  <div key={a.netsuiteId} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '5px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                    <span>{[a.number, a.name].filter(Boolean).join(' ')}</span>
                    <span style={{ color: 'var(--text-muted)', textAlign: 'right' }}>{a.category}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
