'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { centralToday } from '@/lib/new-sales-order';
import { parseDollars } from '@/lib/books/typed-dollars';
import { useFileDownload } from '@/lib/use-file-download';
import { BASIS_WORDS, RETURN_FIELDS, RETURN_FIELD_WORDS, type ReturnField } from '@/lib/books/sales-tax-words';
import type { LoadedSalesTax, RateShown, ReturnShown } from '@/lib/books/sales-tax-data';
import type { OtherMove, OtherMoves, ReturnLine, SalesTaxWorksheet, TaxAccounts, WorkedDocument } from '@/lib/books/sales-tax-worksheet';

/**
 * Books → Sales tax (part 65, migration 496, src/lib/books/sales-tax-worksheet.ts,
 * docs/books.md "Sales tax"; the NetSuite Exit Checklist's "Missouri sales
 * tax", thread "Replacing NetSuite with FleetSuite").
 *
 * What goes on Missouri's sales tax return for a month, location by
 * location: the sales NetSuite posted to it, less what FleetSuite's own rule
 * doesn't tax, at each location's rate on the sale's day, with the 2% timely
 * payment allowance and what to pay. Then the return as it was filed, typed
 * in and held against that; the documents whose tax NetSuite worked out
 * differently, and why; exempt customers' sales and their certificates; the
 * sales tax account through the month; and each location's rates. Last
 * month at first; any month from January 2025 through this one, with an
 * Excel file of it. Open to whoever opens the books; the bookkeeper and super
 * admins type in returns, and super admins change rates. Nothing here moves
 * money or is sent to NetSuite.
 */

/** Where Invoices vs NetSuite checks a document line by line, or null when FleetSuite doesn't post its kind. */
type Check = { kind: string; month: string } | null;
type Listed<T> = T & { check: Check };
type ListedMoves = Omit<OtherMoves, 'list'> & { list: Array<Listed<OtherMove>> };

/** What the page reads: the documents listed are only those NetSuite taxed differently, without their lines (the Excel file has them all). */
interface Payload extends Omit<LoadedSalesTax, 'worksheet'> {
  worksheet: Omit<SalesTaxWorksheet, 'documents' | 'accounts'> & {
    documents: Array<Listed<Omit<WorkedDocument, 'lines'>>>;
    accounts: (Omit<TaxAccounts, 'others' | 'next'> & { others: ListedMoves; next: ListedMoves }) | null;
  };
  can: { keep: boolean; owner: boolean };
}

/** Saving or removing something on the page: which part is busy, and what came of it there. */
interface Acts {
  busy: string;
  error: { at: string; message: string } | null;
  done: { at: string; message: string } | null;
  post: (at: string, body: Record<string, unknown>) => Promise<any>;
  /** The month read again once something is saved, then `message` where it was saved. */
  after: (at: string, message: string) => Promise<void>;
  fail: (at: string, message: string) => void;
  clear: () => void;
}

/** The month's return as it's being typed in. */
interface ReturnDraft {
  filedOn: string;
  figures: Record<ReturnField, string>;
  note: string;
}

/** A location's rate as it's being added. */
interface RateDraft {
  locationId: string;
  startsOn: string;
  pct: string;
  note: string;
}

/** Documents a list shows at first; Show all lists every one read. */
const FIRST = 10;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
/** Cents as a money box holds them: -78500 is "-785.00". */
const typed = (cents: number) => (cents / 100).toFixed(2);
const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOf = (month: string) => MONTH_NAMES[Number(month.slice(5, 7)) - 1];
const monthName = (month: string) => `${monthOf(month)} ${month.slice(0, 4)}`;
const monthBefore = (month: string) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
};
const monthAfter = (month: string) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};
const lastDay = (month: string) =>
  `${month.slice(0, 8)}${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
/** Every month from `first` through `through`, newest first. */
const monthsBetween = (first: string, through: string) => {
  const list: string[] = [];
  for (let m = through; m >= first; m = monthBefore(m)) list.push(m);
  return list;
};
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (iso: string) => `${SHORT[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});

const blankReturn = (): ReturnDraft => ({
  filedOn: '', figures: Object.fromEntries(RETURN_FIELDS.map((f) => [f, ''])) as Record<ReturnField, string>, note: '',
});
const returnDraftOf = (filed: ReturnShown): ReturnDraft => ({
  filedOn: filed.filedOn,
  figures: Object.fromEntries(RETURN_FIELDS.map((f) => [f, typed(filed[f])])) as Record<ReturnField, string>,
  note: filed.note ?? '',
});

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#fbbf24';
const GREY = '#94a3b8';
const MUTED = 'var(--text-secondary)';

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const chip = (color: string): React.CSSProperties => ({
  fontSize: '10px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
  border: `1px solid ${color}55`, color,
});

const button = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: '8px', border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border)'}`,
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: active ? 800 : 600, cursor: 'pointer',
});

const act = (color: string | null, enabled: boolean): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
  border: color ? 'none' : '1px solid var(--border)', background: color ?? 'var(--card)', color: color ? '#fff' : 'var(--text-primary)',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
});

const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};

// 16px so a phone doesn't zoom in on them.
const field: React.CSSProperties = {
  padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
  color: 'var(--text-primary)', fontSize: '16px', fontWeight: 600,
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)',
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '16px',
};

const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' };
const line = (color: string): React.CSSProperties => ({ fontSize: '12px', fontWeight: 600, color, marginTop: '4px' });
const card: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', background: 'var(--card)',
};
const tieCard: React.CSSProperties = { ...card, padding: 0, overflow: 'hidden' };
const title: React.CSSProperties = { fontSize: '14px', fontWeight: 800 };
const about: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)' };
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' };
const buttons: React.CSSProperties = { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' };

const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const labelCell: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };
const amountHead: React.CSSProperties = { ...cell, width: '15%', whiteSpace: 'normal' };

/**
 * A row of the return's table: its label, then the amounts. On a phone the
 * label takes a row of its own above them (.rep-label-row in globals.css),
 * as on Inventory value.
 */
function Row({ label: name, span, style, children }: { label: React.ReactNode; span: number; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <>
      <tr className="rep-label-row" style={style}><td colSpan={span} style={labelCell}>{name}</td></tr>
      <tr className="rep-amounts" style={style}>
        <td className="rep-label" style={labelCell}>{name}</td>
        {children}
      </tr>
    </>
  );
}

/** One line under the return: what it is, then its amount, 'Not yet' while a rate is missing; totals bold. */
function TieLine({ label: name, cents, total, color, top }: { label: React.ReactNode; cents: number | null; total?: boolean; color?: string; top?: boolean }) {
  return (
    <div style={{
      display: 'flex', gap: '10px', alignItems: 'baseline', padding: '5px 12px', fontSize: '12px',
      borderTop: top ? '1px solid var(--border)' : undefined, fontWeight: total ? 700 : 400, color,
    }}
    >
      <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{name}</div>
      <div style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{cents === null ? 'Not yet' : fmt(cents)}</div>
    </div>
  );
}

/** A document's number, opening its line by line check on Invoices vs NetSuite when FleetSuite posts its kind. */
function DocNumber({ company, id, number, check }: { company: string; id: string; number: string | null; check: Check }) {
  const shown = number || `NetSuite ${id}`;
  return check
    ? <Link href={deepLinks.booksDocument(company, check.kind, check.month, id)} className="rep-link" style={{ fontWeight: 700 }}>{shown}</Link>
    : <span style={{ fontWeight: 700 }}>{shown}</span>;
}

/** What the page warns about for the month, as salesTaxNotes in report-workbook.ts says it in the file. */
function Warnings({ data }: { data: Payload }) {
  return (
    <>
      {data.month === data.through && (
        <div style={banner(AMBER)}>{monthName(data.month)} isn&apos;t over yet, so this is where it stands now.</div>
      )}
      {data.worksheet.problems.map((p) => <div key={p} style={banner(RED)}>{p}</div>)}
      {data.worksheet.warnings.map((p) => <div key={p} style={banner(AMBER)}>{p}</div>)}
    </>
  );
}

/** A line of the return: its location and rate, how many documents, and what NetSuite charged when it differs. */
function LineLabel({ line: l }: { line: ReturnLine }) {
  const notes = [
    count(l.documents, 'document', 'documents'),
    ...(l.tax !== null && l.charged !== l.tax ? [`NetSuite charged ${fmt(l.charged)}`] : []),
    ...(l.unsorted ? [`${fmt(l.unsorted)} counted as taxed, items not known`] : []),
  ];
  return (
    <div>
      <div>
        <span style={{ fontWeight: 700 }}>{l.location}</span>
        {l.rate
          ? <span style={{ color: MUTED, marginLeft: '6px' }}>at {l.rate.pct}</span>
          : <span style={{ ...chip(RED), marginLeft: '6px' }}>No rate</span>}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{notes.join(' · ')}</div>
    </div>
  );
}

/** What to file, Form 53-1's way: each location's line, the allowance, what to pay, and what isn't on the return. */
function ReturnCard({ data }: { data: Payload }) {
  const w = data.worksheet;
  const f = w.figures;
  const docs = [count(w.counts.sales, 'sale', 'sales'), ...(w.counts.returns ? [count(w.counts.returns, 'return', 'returns')] : [])].join(' and ');
  return (
    <div style={tieCard}>
      <div style={{ padding: '10px 12px 6px' }}>
        <div style={title}>What to file</div>
        <div style={about}>
          Form 53-1 for {monthName(data.month)}, due {dayText(data.due)}, from the {docs} NetSuite posted to {monthOf(data.month)}.
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr style={{ color: MUTED, textAlign: 'right' }}>
              <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>Location</th>
              {(['gross', 'adjustments', 'taxable', 'tax'] as const).map((k) => <th key={k} style={amountHead}>{RETURN_FIELD_WORDS[k]}</th>)}
            </tr>
          </thead>
          <tbody>
            {!w.lines.length && (
              <tr><td colSpan={5} style={{ padding: '12px', color: 'var(--text-muted)' }}>
                No Missouri location had a rate or a sale in {monthName(data.month)}.
              </td></tr>
            )}
            {w.lines.map((l) => (
              <Row key={`${l.locationId}|${l.rate?.startsOn ?? ''}`} label={<LineLabel line={l} />} span={4} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={cell}>{fmt(l.gross)}</td>
                <td style={cell}>{fmt(l.adjustments)}</td>
                <td style={cell}>{fmt(l.taxable)}</td>
                <td style={{ ...cell, color: l.tax === null ? RED : undefined }}>{l.tax === null ? '—' : fmt(l.tax)}</td>
              </Row>
            ))}
            {w.lines.length > 1 && (
              <Row label="Total" span={4} style={{ borderTop: '1px solid var(--border)', fontWeight: 700 }}>
                <td style={cell}>{fmt(f.gross)}</td>
                <td style={cell}>{fmt(f.adjustments)}</td>
                <td style={cell}>{fmt(f.taxable)}</td>
                <td style={cell}>{f.tax === null ? 'Not yet' : fmt(f.tax)}</td>
              </Row>
            )}
          </tbody>
        </table>
      </div>
      <TieLine
        label={`Less the timely payment allowance, 2% when filed and paid by ${dayText(data.due)}`}
        cents={f.allowance === null ? null : -f.allowance}
        color={MUTED}
        top
      />
      <TieLine label="To pay" cents={f.pay} total top />
      <TieLine label="NetSuite charged on the same documents" cents={f.charged} color={MUTED} top />
      {w.apart.length > 0 && (
        <div style={{ padding: '6px 12px 10px', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: '12px', fontWeight: 800 }}>Not on Missouri&apos;s return</div>
          {w.apart.map((a) => {
            const basis = a.state === 'GA' ? 'georgia' : a.locationId ? 'other_state' : 'no_location';
            return (
              <div key={`${a.state}|${a.locationId ?? ''}`} style={{ display: 'flex', gap: '10px', alignItems: 'baseline', padding: '4px 0', fontSize: '12px' }}>
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  {a.locationId && <span style={{ marginRight: '6px' }}>{a.location}</span>}
                  <span style={chip(basis === 'georgia' ? GREY : RED)}>{BASIS_WORDS[basis]}</span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}{count(a.documents, 'document', 'documents')}{a.charged ? `, NetSuite charged ${fmt(a.charged)}` : ''}
                  </span>
                </div>
                <div style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmt(a.gross)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The month's return as it was filed: typed in, corrected or removed, and each figure held against what it should be. */
function FiledCard({ data, acts }: { data: Payload; acts: Acts }) {
  const [draft, setDraft] = useState<ReturnDraft | null>(null);
  const [removing, setRemoving] = useState(false);
  const { filed, held } = data;
  const name = monthName(data.month);
  const over = monthAfter(data.month);
  const today = centralToday();
  const busy = acts.busy === 'return';
  const idle = !acts.busy;

  const save = async () => {
    if (!draft) return;
    const cents = Object.fromEntries(RETURN_FIELDS.map((f) => [f, parseDollars(draft.figures[f])])) as Record<ReturnField, number | null>;
    const bad = RETURN_FIELDS.filter((f) => cents[f] === null).map((f) => RETURN_FIELD_WORDS[f]);
    if (!draft.filedOn) { acts.fail('return', 'Pick the day the return was filed.'); return; }
    if (bad.length) { acts.fail('return', `Type each figure as the return has it, like 1,234.56: ${bad.join(', ')}.`); return; }
    const ok = await acts.post('return', {
      action: 'return', month: data.month.slice(0, 7), seen: filed?.updatedAt ?? null, filedOn: draft.filedOn,
      grossCents: cents.gross, adjustmentsCents: cents.adjustments, taxableCents: cents.taxable, taxCents: cents.tax,
      allowanceCents: cents.allowance, paidCents: cents.paid, note: draft.note.trim() || null,
    });
    if (!ok) return;
    setDraft(null);
    await acts.after('return', `${name}'s return is saved.`);
  };

  const remove = async () => {
    if (!filed) return;
    const ok = await acts.post('return', { action: 'remove_return', month: data.month.slice(0, 7), seen: filed.updatedAt });
    if (!ok) return;
    setRemoving(false);
    await acts.after('return', `${name}'s return as it was typed in is removed.`);
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={title}>The return as filed</span>
        {held && <span style={chip(held.late ? RED : GREEN)}>{held.late ? `Filed late, ${dayText(held.filedOn)}` : `Filed ${dayText(held.filedOn)}`}</span>}
        {!filed && today >= over && <span style={chip(AMBER)}>Not typed in yet</span>}
      </div>

      {!filed && !draft && (
        <div style={about}>
          {today < over
            ? `Once ${monthOf(data.month)} is over, its return is typed in here as it was filed, and held against what to file.`
            : 'Typed in as it was filed, each figure is held against what to file.'}
        </div>
      )}

      {filed && held && !draft && (
        <>
          <table className="rep-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', marginTop: '6px' }}>
            <thead>
              <tr style={{ color: MUTED }}>
                <th style={{ ...cell, textAlign: 'left', paddingLeft: 0 }}>Figure</th>
                <th style={amountHead}>On the return</th>
                <th style={{ ...amountHead, paddingRight: 0 }}>Should be</th>
              </tr>
            </thead>
            <tbody>
              {held.fields.map((f) => (
                <tr key={f.field} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...labelCell, paddingLeft: 0 }}>{RETURN_FIELD_WORDS[f.field]}</td>
                  <td style={{ ...cell, color: f.differs ? RED : undefined, fontWeight: f.differs ? 700 : 400 }}>{fmt(f.filed)}</td>
                  <td style={{ ...cell, paddingRight: 0, color: MUTED }}>{f.expected === null ? 'Not yet' : fmt(f.expected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {held.notes.map((n) => <div key={n} style={line(AMBER)}>{n}</div>)}
          {!held.notes.length && <div style={line(GREEN)}>Each figure on the return is what it should be.</div>}
          {filed.note && <div style={{ ...about, marginTop: '4px', overflowWrap: 'anywhere' }}>Note: {filed.note}</div>}
          <div style={line(GREY)}>
            Typed in{filed.enteredBy ? ` by ${filed.enteredBy}` : ''} {when(filed.enteredAt)}
            {filed.updatedAt !== filed.enteredAt && `; corrected${filed.updatedBy ? ` by ${filed.updatedBy}` : ''} ${when(filed.updatedAt)}`}
          </div>
        </>
      )}

      {draft && (
        <div style={{ marginTop: '8px' }}>
          <div style={grid}>
            <div>
              <span style={label}>Filed on</span>
              <input type="date" value={draft.filedOn} min={over} max={today} disabled={busy}
                onChange={(e) => setDraft({ ...draft, filedOn: e.target.value })} style={input} />
            </div>
            {RETURN_FIELDS.map((f) => (
              <div key={f}>
                <span style={label}>{RETURN_FIELD_WORDS[f]}</span>
                <input
                  // What's taken off is typed less than nothing, and a phone's number pad has no minus key.
                  inputMode={f === 'adjustments' ? 'text' : 'decimal'}
                  value={draft.figures[f]}
                  placeholder={f === 'adjustments' ? '-1,234.56' : 'As the return says'}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, figures: { ...draft.figures, [f]: e.target.value } })}
                  style={input}
                />
              </div>
            ))}
          </div>
          <div style={{ marginTop: '8px' }}>
            <span style={label}>Note</span>
            <input value={draft.note} maxLength={300} placeholder="Optional: its confirmation number, say" disabled={busy}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })} style={input} />
          </div>
          <div style={buttons}>
            <button onClick={save} disabled={busy} style={act(GREEN, !busy)}>{busy ? 'Saving…' : 'Save the return'}</button>
            <button onClick={() => { setDraft(null); acts.clear(); }} disabled={busy} style={act(null, !busy)}>Leave without saving</button>
          </div>
        </div>
      )}

      {data.can.keep && !draft && today >= over && (removing && filed ? (
        <div style={{ marginTop: '8px' }}>
          <div style={line(RED)}>Remove {name}&apos;s return as it was typed in? What was filed with the state stays as it is.</div>
          <div style={buttons}>
            <button onClick={remove} disabled={busy} style={act(RED, !busy)}>{busy ? 'Removing…' : 'Remove it'}</button>
            <button onClick={() => { setRemoving(false); acts.clear(); }} disabled={busy} style={act(null, !busy)}>Keep it</button>
          </div>
        </div>
      ) : (
        <div style={buttons}>
          {filed ? (
            <>
              <button onClick={() => { setDraft(returnDraftOf(filed)); acts.clear(); }} disabled={!idle} style={act(null, idle)}>Correct it</button>
              <button onClick={() => { setRemoving(true); acts.clear(); }} disabled={!idle} style={act(null, idle)}>Remove it</button>
            </>
          ) : (
            <button onClick={() => { setDraft(blankReturn()); acts.clear(); }} disabled={!idle} style={act(null, idle)}>
              Type in the return as filed
            </button>
          )}
        </div>
      ))}
      {acts.error?.at === 'return' && <div style={{ ...banner(RED), marginTop: '8px', marginBottom: 0 }}>{acts.error.message}</div>}
      {acts.done?.at === 'return' && <div style={{ ...banner(GREEN), marginTop: '8px', marginBottom: 0 }}>{acts.done.message}</div>}
    </div>
  );
}

/** The documents whose tax NetSuite worked out differently from FleetSuite's rule, and why. */
function DiffersCard({ data }: { data: Payload }) {
  const [all, setAll] = useState(false);
  const docs = data.worksheet.documents;
  const rows = all ? docs : docs.slice(0, FIRST);
  return (
    <div style={card}>
      <div style={title}>Where NetSuite&apos;s tax differs</div>
      {!docs.length ? (
        <div style={line(GREEN)}>NetSuite charged what FleetSuite&apos;s rule says on each of {monthOf(data.month)}&apos;s documents.</div>
      ) : (
        <div style={about}>
          {count(docs.length, 'document', 'documents')}: NetSuite charged {fmt(docs.reduce((t, d) => t + d.charged, 0))} on{' '}
          {docs.length === 1 ? 'it' : 'them'}, and FleetSuite&apos;s rule says {fmt(docs.reduce((t, d) => t + (d.owed ?? 0), 0))}.
        </div>
      )}
      {rows.map((d) => (
        <div key={d.id} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px', marginTop: '4px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ overflowWrap: 'anywhere' }}>
              <DocNumber company={data.company.code} id={d.id} number={d.number} check={d.check} />
              <span style={{ color: MUTED, marginLeft: '6px' }}>{d.typeName} · {dayText(d.date)} · {d.location}</span>
              {d.basis !== 'rate' && <span style={{ ...chip(GREY), marginLeft: '6px' }}>{BASIS_WORDS[d.basis]}</span>}
            </div>
            {d.customer && <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{d.customer}</div>}
            <div style={{ color: MUTED, marginTop: '2px' }}>{d.note}</div>
          </div>
          <div style={{ textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            <div style={{ fontWeight: 700 }}>NetSuite {fmt(d.charged)}</div>
            <div style={{ color: MUTED }}>FleetSuite {d.owed === null ? '—' : fmt(d.owed)}</div>
          </div>
        </div>
      ))}
      {docs.length > rows.length && (
        <button onClick={() => setAll(true)} style={{ ...button(false), marginTop: '6px' }}>Show all {docs.length.toLocaleString('en-US')}</button>
      )}
    </div>
  );
}

/** Exempt customers' sales in the month, with the certificate on file on the sales' dates. */
function ExemptCard({ data }: { data: Payload }) {
  return (
    <div style={card}>
      <div style={title}>Exempt customers&apos; sales</div>
      <div style={about}>Not taxed: each customer FleetSuite has as tax exempt, and their certificate on file.</div>
      {data.worksheet.exempt.map((e) => {
        const cert = [
          e.certNumber ? `Certificate ${e.certNumber}` : 'No certificate number',
          ...(e.certExpires ? [`expires ${dayText(e.certExpires)}`] : []),
          ...(e.certFiles ? [count(e.certFiles, 'file', 'files')] : []),
        ].join(', ');
        return (
          <div key={e.customerId} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px', marginTop: '4px' }}>
            <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
              <div>
                {data.can.owner
                  ? <Link href={deepLinks.customerByNetsuiteId(e.customerId)} className="rep-link" style={{ fontWeight: 700 }}>{e.customer}</Link>
                  : <span style={{ fontWeight: 700 }}>{e.customer}</span>}
                <span style={{ color: MUTED }}> · {count(e.documents, 'document', 'documents')}</span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{cert}</div>
              {e.warning && <div style={line(AMBER)}>{e.warning}</div>}
            </div>
            <div style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontWeight: 700 }}>{fmt(e.gross)}</div>
          </div>
        );
      })}
    </div>
  );
}

/** One of the sales tax account's other documents: a payment to the state or a journal entry, say. */
function MoveRow({ move, company }: { move: Listed<OtherMove>; company: string }) {
  const words = [move.name, move.memo].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflowWrap: 'anywhere' }}>
          <DocNumber company={company} id={move.id} number={move.number} check={move.check} />
          <span style={{ color: MUTED, marginLeft: '6px' }}>{move.typeName} · {dayText(move.date)}</span>
        </div>
        {words && <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{words}</div>}
      </div>
      <div style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontWeight: 700 }}>{fmt(move.amount)}</div>
    </div>
  );
}

function MovesList({ heading, moves, company }: { heading: string; moves: ListedMoves; company: string }) {
  const [all, setAll] = useState(false);
  const rows = all ? moves.list : moves.list.slice(0, FIRST);
  return (
    <div style={{ padding: '6px 12px 10px', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline', fontSize: '12px', fontWeight: 800 }}>
        <div style={{ flex: 1, minWidth: 0 }}>{heading}</div>
        {moves.count > 0 && <div style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmt(moves.total)}</div>}
      </div>
      {!moves.count && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>None.</div>}
      {rows.map((o) => <MoveRow key={o.id} move={o} company={company} />)}
      {moves.list.length > rows.length && (
        <button onClick={() => setAll(true)} style={{ ...button(false), marginTop: '6px' }}>Show all {moves.list.length.toLocaleString('en-US')}</button>
      )}
      {(all || moves.list.length <= FIRST) && moves.count > moves.list.length && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
          {count(moves.count - moves.list.length, 'more document', 'more documents')} not listed.
        </div>
      )}
    </div>
  );
}

/** The sales tax account in the copy of NetSuite's ledger through the month, then what came off it in the month and the month after. */
function AccountCard({ data, accounts: a }: { data: Payload; accounts: NonNullable<Payload['worksheet']['accounts']> }) {
  const names = data.taxAccounts.map((t) => `${t.number ? `${t.number} ` : ''}${t.name}`).join(', ');
  return (
    <div style={tieCard}>
      <div style={{ padding: '10px 12px 6px' }}>
        <div style={title}>Sales tax account</div>
        <div style={about}>
          {names || "NetSuite's sales tax accounts"} in NetSuite&apos;s ledger as FleetSuite copies it, owed to the state.
        </div>
      </div>
      <TieLine label={`At the end of ${monthName(monthBefore(data.month))}`} cents={a.start} total top />
      {a.moves.map((m) => <TieLine key={m.type} label={`${m.typeName} · ${count(m.documents, 'document', 'documents')}`} cents={m.amount} color={MUTED} />)}
      <TieLine label={`At the end of ${monthName(data.month)}`} cents={a.end} total top />
      <TieLine label={`FleetSuite's books at the end of ${monthName(data.month)}`} cents={a.books} color={a.books === a.end ? MUTED : AMBER} />
      <MovesList heading={`Payments to the state and other entries in ${monthOf(data.month)}`} moves={a.others} company={data.company.code} />
      <MovesList heading={`In ${monthName(monthAfter(data.month))}, when ${monthOf(data.month)}'s return is paid`} moves={a.next} company={data.company.code} />
    </div>
  );
}

/** Each location's rates from the day each starts: super admins add and remove them. */
function RatesCard({ data, acts }: { data: Payload; acts: Acts }) {
  const [adding, setAdding] = useState<RateDraft | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const busy = acts.busy === 'rate';
  const idle = !acts.busy;
  const owner = data.can.owner;
  const nameOf = (id: string) => data.locations.find((l) => l.id === id)?.name ?? `Location ${id}`;

  // The rates come sorted by location, then by the day each starts.
  const groups: Array<[string, RateShown[]]> = [];
  for (const r of data.rates) {
    const last = groups[groups.length - 1];
    if (last && last[0] === r.locationId) last[1].push(r);
    else groups.push([r.locationId, [r]]);
  }
  // A rate is in force from the day it starts until the next one does.
  const end = lastDay(data.month);
  const usedInMonth = (rates: RateShown[], i: number) => rates[i].startsOn <= end && (i === rates.length - 1 || rates[i + 1].startsOn > data.month);

  const add = async () => {
    if (!adding) return;
    const pct = adding.pct.trim().replace(/%$/, '').trim();
    if (!adding.locationId) { acts.fail('rate', 'Pick the location the rate is for.'); return; }
    if (!adding.startsOn) { acts.fail('rate', 'Pick the day the rate starts.'); return; }
    if (!/^\d{1,2}(\.\d{1,3})?$/.test(pct) || Number(pct) <= 0) {
      acts.fail('rate', 'Type the rate as a percent with up to three decimals, 8.488 say.');
      return;
    }
    const ok = await acts.post('rate', {
      action: 'add_rate', locationId: adding.locationId, startsOn: adding.startsOn, pct, note: adding.note.trim() || null,
    });
    if (!ok) return;
    setAdding(null);
    await acts.after('rate', `${nameOf(adding.locationId)}'s ${pct}% from ${dayText(adding.startsOn)} is added.`);
  };

  const remove = async (r: RateShown) => {
    const ok = await acts.post('rate', { action: 'remove_rate', locationId: r.locationId, startsOn: r.startsOn });
    if (!ok) return;
    setRemoving(null);
    await acts.after('rate', `${nameOf(r.locationId)}'s ${r.pct} from ${dayText(r.startsOn)} is removed.`);
  };

  return (
    <div style={card}>
      <div style={title}>Each location&apos;s rate</div>
      <div style={about}>For the return and FleetSuite&apos;s own invoice copies; quotes still use Settings → Sales Tax, {data.settingsPct}.</div>
      {!groups.length && <div style={line(GREY)}>No location has a rate yet.</div>}
      {groups.map(([id, rates]) => (
        <div key={id} style={{ marginTop: '8px' }}>
          <div style={{ fontSize: '12px', fontWeight: 800 }}>{nameOf(id)}</div>
          {rates.map((r, i) => {
            const key = `${r.locationId}|${r.startsOn}`;
            const words = [r.note, r.enteredBy ? `added by ${r.enteredBy}` : null].filter(Boolean).join(' · ');
            return (
              <div key={key} style={{ padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', fontSize: '12px' }}>
                  <span style={{ fontWeight: 700 }}>{r.pct}</span>
                  <span>from {dayText(r.startsOn)}</span>
                  {usedInMonth(rates, i) && <span style={chip(GREEN)}>Used in {monthOf(data.month)}</span>}
                  {owner && removing !== key && (
                    <button onClick={() => { setRemoving(key); acts.clear(); }} disabled={!idle} style={{ ...link, marginLeft: 'auto' }}>Remove</button>
                  )}
                </div>
                {words && <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{words}</div>}
                {removing === key && (
                  <div style={buttons}>
                    <button onClick={() => remove(r)} disabled={busy} style={act(RED, !busy)}>{busy ? 'Removing…' : `Remove ${r.pct}`}</button>
                    <button onClick={() => { setRemoving(null); acts.clear(); }} disabled={busy} style={act(null, !busy)}>Keep it</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {owner && !adding && (
        <div style={buttons}>
          <button onClick={() => { setAdding({ locationId: '', startsOn: '', pct: '', note: '' }); setRemoving(null); acts.clear(); }} disabled={!idle} style={act(null, idle)}>
            Add a rate
          </button>
        </div>
      )}
      {adding && (
        <div style={{ marginTop: '10px' }}>
          <div style={grid}>
            <div>
              <span style={label}>Location</span>
              <select value={adding.locationId} disabled={busy} onChange={(e) => setAdding({ ...adding, locationId: e.target.value })} style={input}>
                <option value="">Pick one</option>
                {data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <span style={label}>Starts on</span>
              <input type="date" value={adding.startsOn} min={data.first} disabled={busy}
                onChange={(e) => setAdding({ ...adding, startsOn: e.target.value })} style={input} />
            </div>
            <div>
              <span style={label}>Rate, %</span>
              <input inputMode="decimal" value={adding.pct} placeholder="8.488" disabled={busy}
                onChange={(e) => setAdding({ ...adding, pct: e.target.value })} style={input} />
            </div>
          </div>
          <div style={{ marginTop: '8px' }}>
            <span style={label}>Note</span>
            <input value={adding.note} maxLength={200} placeholder="Optional: where the rate is from" disabled={busy}
              onChange={(e) => setAdding({ ...adding, note: e.target.value })} style={input} />
          </div>
          <div style={buttons}>
            <button onClick={add} disabled={busy} style={act(GREEN, !busy)}>{busy ? 'Saving…' : 'Save the rate'}</button>
            <button onClick={() => { setAdding(null); acts.clear(); }} disabled={busy} style={act(null, !busy)}>Leave without saving</button>
          </div>
        </div>
      )}
      {acts.error?.at === 'rate' && <div style={{ ...banner(RED), marginTop: '8px', marginBottom: 0 }}>{acts.error.message}</div>}
      {acts.done?.at === 'rate' && <div style={{ ...banner(GREEN), marginTop: '8px', marginBottom: 0 }}>{acts.done.message}</div>}
    </div>
  );
}

export default function BooksSalesTaxPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState('');
  const [actError, setActError] = useState<{ at: string; message: string } | null>(null);
  const [done, setDone] = useState<{ at: string; message: string } | null>(null);
  const excel = useFileDownload(setError);

  const load = useCallback(async (month: string | null) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/admin/books/sales-tax${month ? `?${new URLSearchParams({ month: month.slice(0, 7) })}` : ''}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      const loaded = json as Payload;
      setData(loaded);
      setError('');
      // Keep the address on the month shown, so coming back from a document opens it again.
      window.history.replaceState(null, '', deepLinks.booksSalesTax(loaded.month));
    } catch (e: any) {
      setError(e?.message || "Couldn't read the sales tax");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // A link may name the month (deepLinks.booksSalesTax).
    load(new URLSearchParams(window.location.search).get('month'));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const acts: Acts = {
    busy,
    error: actError,
    done,
    post: async (at, body) => {
      setBusy(at);
      setActError(null);
      setDone(null);
      try {
        const res = await apiFetch('/api/admin/books/sales-tax', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
        return json;
      } catch (e: any) {
        setActError({ at, message: e?.message || "Couldn't save it" });
        return null;
      } finally {
        setBusy('');
      }
    },
    after: async (at, message) => {
      if (data) await load(data.month);
      setDone({ at, message });
    },
    fail: (at, message) => { setDone(null); setActError({ at, message }); },
    clear: () => { setActError(null); setDone(null); },
  };

  const pickMonth = (month: string) => {
    setActError(null);
    setDone(null);
    load(month);
  };

  const excelUrl = data && `/api/admin/books/sales-tax/download?${new URLSearchParams({ month: data.month.slice(0, 7) })}`;
  const w = data?.worksheet;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Sales tax</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          What goes on Missouri&apos;s sales tax return each month, location by location, and the return as filed held against it.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              Each invoice, credit memo and cash sale NetSuite posted to the month counts at its location&apos;s rate on its date, on the
              lines FleetSuite&apos;s own rule taxes: NetSuite service items and 06 numbers aren&apos;t taxed, unless an admin set the part
              otherwise, and neither are exempt customers&apos; sales. Social Circle&apos;s work in Georgia isn&apos;t taxed and isn&apos;t on
              Missouri&apos;s return. The 2% timely payment allowance comes off when the return is filed and paid by the 20th of the month
              after, or the Monday after a weekend. Each document NetSuite charged a different tax on is listed with why. The
              bookkeeper and super admins type in each return as it was filed, to hold it against what to file, and super admins set
              each location&apos;s rates. Nothing here moves money or is sent to NetSuite.
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href="/admin/books/months" style={{ color: MUTED }}>Months</Link>
          {' · '}
          <Link href="/admin/books/reports" style={{ color: MUTED }}>Reports</Link>
          {' · '}
          <Link href="/admin/books/lists" style={{ color: MUTED }}>NetSuite lists</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: MUTED }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && w && (
        <>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', color: MUTED }}>
              For
              <select value={data.month} onChange={(e) => pickMonth(e.target.value)} disabled={loading || !!busy} style={field}>
                {monthsBetween(data.first, data.through).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
              </select>
            </label>
            {excelUrl && (
              <button
                onClick={() => excel.download(excelUrl, `${data.company.code} Sales tax ${data.month.slice(0, 7)}.xlsx`)}
                disabled={loading || excel.busy}
                title="What to file, the return as filed, every document and its lines, exempt sales and the sales tax account, as an Excel file"
                style={button(false)}
              >
                {excel.busy ? 'Making the file…' : excel.ready(excelUrl) ? '⬇ Tap to save the Excel file' : '⬇ Download Excel'}
              </button>
            )}
          </div>

          <Warnings data={data} />
          <ReturnCard data={data} />
          <FiledCard key={data.month} data={data} acts={acts} />
          {w.counts.sales + w.counts.returns > 0 && <DiffersCard key={`differs ${data.month}`} data={data} />}
          {w.exempt.length > 0 && <ExemptCard data={data} />}
          {w.accounts && <AccountCard key={`account ${data.month}`} data={data} accounts={w.accounts} />}
          <RatesCard data={data} acts={acts} />
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
