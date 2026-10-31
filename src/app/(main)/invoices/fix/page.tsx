'use client';

/**
 * Fixing an invoice after it's made, in FleetSuite, and sending the fix on to
 * NetSuite (Books part 39, docs/books.md "Invoices fixed in FleetSuite";
 * owner decisions 2026-10-31: from January 1, 2027 the team works only in
 * FleetSuite). Opened from Invoicing → Invoiced → Fix on an invoice.
 *
 * Its PO number, memo and VIN can always be fixed; while nothing on it is
 * paid or credited, its date and lines too: a line's quantity, price each and
 * description, a discount's amount, a line taken off and a line added. What
 * changes and what NetSuite is sent are src/lib/invoice-fix.ts, the same rules
 * /api/invoices/fix works the fix out by before it sends it. Built switched
 * off (Books → Switches): until it's on, super admins see what a fix would
 * send and nothing goes to NetSuite.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import TopSaveBar from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';
import { centsOf, formatCents } from '@/lib/credit-memo';
import { isDiscountType, type NewInvoiceItem } from '@/lib/new-invoice';
import {
  DESCRIPTION_MAX, MAX_ADDED, MEMO_MAX, PO_MAX, REASON_MAX, dayText, planInvoiceFix, priceText, quantityText,
  type FixAllows, type FixHeaderEdit, type FixInvoice, type FixItem, type FixLine, type FixLineEdit, type FixNewLine,
} from '@/lib/invoice-fix';

interface FixHistory {
  id: string;
  at: string;
  by: string | null;
  reason: string;
  changes: string[];
  status: 'sending' | 'fixed' | 'refused' | 'unsure';
  error: string | null;
  totalBeforeCents: number | null;
  totalAfterCents: number | null;
  ownCopy: 'fixed' | 'none' | 'not_saved' | null;
}

interface Loaded {
  invoice: FixInvoice;
  allows: FixAllows;
  termsDays: number | null;
  untaxed: 'exempt_customer' | 'georgia' | null;
  signature: string;
  fixes: FixHistory[];
  ownCopy: { version: number; fixedAt: string | null } | null;
  switchedOn: boolean;
  offText: string | null;
}

/** What's in the boxes of one of the invoice's lines. */
interface Box {
  quantityText: string;
  priceText: string;
  amountText: string;
  description: string;
  describing: boolean;
  removed: boolean;
}

/** A line added: a discount's price is what it takes off. */
interface Added {
  key: number;
  item: NewInvoiceItem;
  quantityText: string;
  priceText: string;
  description: string;
}

interface Done {
  changes: string[];
  totalBeforeCents: number | null;
  totalAfterCents: number | null;
  ownCopy: 'fixed' | 'none' | 'not_saved' | null;
  warning?: string;
  already?: boolean;
}

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

/** A typed amount or quantity; a box emptied is no number, so it asks for one. */
const typed = (text: string) => (text.trim() === '' ? NaN : Number(text.replace(/[$,\s]/g, '')));

const day = (ymd: string | null) => (ymd ? new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString() : '');

const card: React.CSSProperties = {
  background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px',
};
const label: React.CSSProperties = {
  display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
  color: theme.textMuted, marginBottom: '3px',
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '7px',
  border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '15px',
};
const btn: React.CSSProperties = {
  padding: '9px 14px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.card,
  color: theme.textPrimary, fontSize: '14px', fontWeight: 700, cursor: 'pointer',
};
const small: React.CSSProperties = { ...btn, padding: '6px 10px', fontSize: '13px' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const muted: React.CSSProperties = { fontSize: '12px', color: theme.textMuted };
/** Two lines at most, so a long description doesn't push the boxes off the screen. */
const twoLines: React.CSSProperties = {
  fontSize: '13px', color: theme.textSecondary, overflow: 'hidden', display: '-webkit-box',
  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};

/** The boxes as the invoice has them, so a box left alone changes nothing. */
function startingBox(l: FixLine): Box {
  return {
    quantityText: l.kind === 'quantity' ? String(l.quantity) : '',
    priceText: l.kind === 'quantity' && l.rate !== null ? String(l.rate) : '',
    amountText: l.kind === 'amount' ? (Math.abs(l.cents) / 100).toFixed(2) : '',
    description: l.description,
    describing: false,
    removed: false,
  };
}

const STATUS_TEXT: Record<FixHistory['status'], string> = {
  fixed: 'Fixed',
  refused: 'NetSuite refused it',
  unsure: "Couldn't tell whether it went in",
  sending: 'Being sent now',
};

const OWN_COPY_TEXT: Record<'fixed' | 'none' | 'not_saved', string> = {
  fixed: "Books' own copy followed",
  none: 'Books has no copy of its own',
  not_saved: "Books' own copy didn't follow",
};

export default function InvoiceFixPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();
  const invoiceId = (searchParams.get('invoice') || '').trim();

  // Made when the invoice is read: the same form pressed twice is one fix.
  const [requestId, setRequestId] = useState(newRequestId);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dateText, setDateText] = useState('');
  const [poText, setPoText] = useState('');
  const [memoText, setMemoText] = useState('');
  const [vinText, setVinText] = useState('');
  const [boxes, setBoxes] = useState<Record<number, Box>>({});
  const [added, setAdded] = useState<Added[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<NewInvoiceItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    if (!/^\d+$/.test(invoiceId)) { setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`/api/invoices/fix?invoice=${encodeURIComponent(invoiceId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the invoice from NetSuite (${res.status}).`);
      const loaded = body as Loaded;
      const inv = loaded.invoice;
      setData(loaded);
      setDateText(inv.date ?? '');
      setPoText(inv.poNumber);
      setMemoText(inv.memo);
      setVinText(inv.vin);
      setBoxes(Object.fromEntries(inv.lines.map((l) => [l.line, startingBox(l)])));
      setAdded([]);
      setReason('');
      setError(null);
      setReloadNeeded(false);
      setDone(null);
      setRequestId(newRequestId());
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the invoice from NetSuite.");
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      const res = await apiFetch(`/api/invoices/new?q=${encodeURIComponent(q)}`);
      const body = await res.json().catch(() => ({}));
      setHits(res.ok ? body.items || [] : []);
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const invoice = data?.invoice;

  // Only what was changed goes: a box left as the invoice has it isn't sent.
  const header: FixHeaderEdit = {};
  const lineEdits: FixLineEdit[] = [];
  if (invoice) {
    if (dateText !== (invoice.date ?? '')) header.date = dateText;
    if (poText !== invoice.poNumber) header.poNumber = poText;
    if (memoText !== invoice.memo) header.memo = memoText;
    if (vinText !== invoice.vin) header.vin = vinText;
    for (const l of invoice.lines) {
      const b = boxes[l.line];
      if (!b) continue;
      const start = startingBox(l);
      const e: FixLineEdit = { line: l.line };
      if (b.removed) e.remove = true;
      else {
        if (l.kind === 'quantity' && b.quantityText !== start.quantityText) e.quantity = typed(b.quantityText);
        if (l.kind === 'quantity' && b.priceText !== start.priceText) e.price = typed(b.priceText);
        if (l.kind === 'amount' && b.amountText !== start.amountText) e.amount = typed(b.amountText);
        if ((l.kind === 'quantity' || l.kind === 'amount') && b.description !== start.description) e.description = b.description;
      }
      if (Object.keys(e).length > 1) lineEdits.push(e);
    }
  }
  const newLines: FixNewLine[] = added.map((a) => ({
    itemId: a.item.itemId,
    quantity: isDiscountType(a.item.itemType) ? 1 : typed(a.quantityText),
    price: typed(a.priceText),
    ...(a.description !== a.item.description ? { description: a.description } : {}),
  }));
  const items = useMemo(() => new Map<string, FixItem>(added.map((a) => [a.item.itemId, {
    itemId: a.item.itemId, itemNumber: a.item.itemNumber, itemType: a.item.itemType,
    taxableOverride: a.item.taxableOverride, description: a.item.description,
  }])), [added]);
  const plan = useMemo(
    () => (data
      ? planInvoiceFix(data.invoice, { reason, header, lines: lineEdits, add: newLines }, {
        allows: data.allows, items, untaxed: data.untaxed, termsDays: data.termsDays,
      })
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- header, lineEdits and newLines derive from the boxes
    [data, dateText, poText, memoText, vinText, boxes, added, items, reason],
  );
  const started = Object.keys(header).length > 0 || lineEdits.length > 0 || added.length > 0;

  const patch = (line: number, p: Partial<Box>) => setBoxes((prev) => ({ ...prev, [line]: { ...prev[line], ...p } }));
  const putBack = (l: FixLine) => setBoxes((prev) => ({ ...prev, [l.line]: startingBox(l) }));
  const startOver = () => {
    if (!invoice) return;
    setDateText(invoice.date ?? '');
    setPoText(invoice.poNumber);
    setMemoText(invoice.memo);
    setVinText(invoice.vin);
    setBoxes(Object.fromEntries(invoice.lines.map((l) => [l.line, startingBox(l)])));
    setAdded([]);
  };
  const addItem = (item: NewInvoiceItem) => {
    setAdded((prev) => [...prev, {
      key: nextKey, item, quantityText: '1',
      priceText: isDiscountType(item.itemType) ? '' : item.price != null ? String(item.price) : '',
      description: item.description,
    }]);
    setNextKey((k) => k + 1);
    setSearch('');
    setHits([]);
  };
  const patchAdded = (key: number, p: Partial<Added>) => setAdded((prev) => prev.map((a) => (a.key === key ? { ...a, ...p } : a)));

  const send = async () => {
    if (!data || !invoice || !plan || plan.problems.length > 0 || !data.switchedOn) return;
    const n = plan.changes.length;
    const totals = plan.fixed.totalCents === null ? ' NetSuite works its new total out.'
      : plan.fixed.totalCents !== invoice.totalCents
        ? ` Its total goes from ${formatCents(invoice.totalCents)} to about ${formatCents(plan.fixed.totalCents)}.`
        : '';
    const ok = await dialog.confirm(
      `Fix invoice ${invoice.number} for ${invoice.customerName} in NetSuite? ${n === 1 ? 'One change' : `${n} changes`}.${totals}`,
      { confirmLabel: 'Fix invoice', title: 'Fix invoice' },
    );
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    setReloadNeeded(false);
    try {
      const res = await apiFetch('/api/invoices/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          invoiceId: invoice.id,
          signature: data.signature,
          reason,
          header,
          lines: lineEdits,
          add: newLines,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        if (body.stale || body.unsure) setReloadNeeded(true);
        throw new Error(body.error || `NetSuite didn't take the fix (${res.status}).`);
      }
      setDone({
        changes: Array.isArray(body.changes) ? body.changes : plan.changes,
        totalBeforeCents: body.totalBeforeCents ?? invoice.totalCents,
        totalAfterCents: body.totalAfterCents ?? null,
        ownCopy: body.ownCopy ?? null,
        warning: body.warning,
        already: !!body.already,
      });
    } catch (e: any) {
      setError(e?.message || "NetSuite didn't take the fix.");
    } finally {
      setSubmitting(false);
    }
  };

  const openPdf = async () => {
    if (!invoice) return;
    setOpening(true);
    const r = await openNetSuitePdf('invoice', invoice.id);
    setOpening(false);
    if (!r.ok) setError(r.error || "Couldn't open the invoice PDF.");
  };

  if (!authLoading && (!hasFeature('invoicing') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Invoicing permission and price access to fix invoices.</div>;
  }

  const back = () => router.push(deepLinks.invoicesSent(invoice?.number));
  const allows = data?.allows;
  const linesOpen = !!allows?.lines;
  const fixedLine = (line: number) => plan?.fixed.lines.find((x) => x.line === line);

  return (
    <div style={{ maxWidth: '820px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!done && invoice && plan && allows?.header && (
        <TopSaveBar
          title="Fix invoice"
          subtitle={`${invoice.number} · ${invoice.customerName}`}
          error={error || undefined}
          onSave={send}
          saving={submitting}
          disabled={!data?.switchedOn || plan.problems.length > 0}
          saveLabel={data?.switchedOn ? 'Fix invoice' : 'Switched off'}
          savingLabel="Fixing invoice…"
          onCancel={back}
        />
      )}
      <div>
        <button onClick={back} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>← Invoicing</button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Fix invoice</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>Changed in NetSuite as you fix it here, and in Books&apos; own copy.</div>
      </div>

      {data?.offText && !done && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {!/^\d+$/.test(invoiceId) ? (
        <div style={{ ...card, color: theme.textSecondary, fontSize: '14px' }}>
          Open a fix from an invoice: Invoicing → Invoiced, then Fix on the invoice.
        </div>
      ) : loading ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Reading the invoice from NetSuite…</div>
      ) : loadError || !invoice || !plan || !allows ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{loadError || "Couldn't read the invoice from NetSuite."}</div>
          <div><button onClick={load} style={btn}>Try again</button></div>
        </div>
      ) : done ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: theme.success }}>
            Invoice {invoice.number} {done.already ? 'was already fixed' : 'fixed in NetSuite'}
          </div>
          <div style={{ display: 'grid', gap: '2px', fontSize: '14px', color: theme.textPrimary }}>
            {done.changes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <div style={{ fontSize: '14px', color: theme.textPrimary }}>
            {done.totalAfterCents === null
              ? "Reload the invoice to see NetSuite's total."
              : done.totalAfterCents === done.totalBeforeCents
                ? `Its total is still ${formatCents(done.totalAfterCents)}.`
                : `NetSuite's total is now ${formatCents(done.totalAfterCents)}, from ${formatCents(done.totalBeforeCents ?? 0)}.`}
          </div>
          {done.ownCopy === 'fixed' && <div style={muted}>Books&apos; own copy of it changed too, and keeps the one before.</div>}
          {done.ownCopy === 'none' && <div style={muted}>Books has no copy of its own of this invoice, so only NetSuite&apos;s changed.</div>}
          {done.warning && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{done.warning}</div>}
          {error && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{error}</div>}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={openPdf} disabled={opening} style={btn}>{opening ? 'Opening…' : 'Open PDF'}</button>
            <button onClick={load} style={btn}>Fix something else on it</button>
            <button onClick={back} style={btn}>Back to invoices</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline' }}>
              <div style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>Invoice {invoice.number}</div>
              <div style={{ ...num, fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>{formatCents(invoice.totalCents)}</div>
            </div>
            <div style={{ fontSize: '14px', color: theme.textPrimary }}>{invoice.customerName}</div>
            <div style={muted}>
              {[day(invoice.date), invoice.locationName || '', invoice.termsName || '',
                invoice.owedCents === null ? '' : invoice.owedCents > 0 ? `${formatCents(invoice.owedCents)} still owed` : 'Paid',
              ].filter(Boolean).join(' · ')}
            </div>
            {allows.why && (
              <div style={{ fontSize: '13px', color: allows.header ? theme.warning : theme.error, fontWeight: 700 }}>{allows.why}</div>
            )}
          </div>

          {allows.header && (
            <>
              <div style={{ ...card, display: 'grid', gap: '10px' }}>
                <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>The invoice</div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ width: '170px' }}>
                    <label style={label} htmlFor="fx-date">Date</label>
                    <input id="fx-date" type="date" style={input} value={dateText} disabled={!linesOpen}
                      onChange={(e) => setDateText(e.target.value)} />
                    <div style={{ ...muted, marginTop: '3px' }}>Due {dayText(plan.fixed.dueDate)}</div>
                  </div>
                  <div style={{ width: '200px' }}>
                    <label style={label} htmlFor="fx-po">PO number</label>
                    <input id="fx-po" style={input} value={poText} maxLength={PO_MAX} onChange={(e) => setPoText(e.target.value)} />
                  </div>
                  <div style={{ width: '230px' }}>
                    <label style={label} htmlFor="fx-vin">VIN</label>
                    <input id="fx-vin" style={{ ...input, textTransform: 'uppercase' }} value={vinText} maxLength={17}
                      onChange={(e) => setVinText(e.target.value.toUpperCase())} />
                  </div>
                </div>
                <div>
                  <label style={label} htmlFor="fx-memo">Memo</label>
                  <textarea id="fx-memo" style={{ ...input, minHeight: '44px', resize: 'vertical' }} rows={2} value={memoText}
                    maxLength={MEMO_MAX} onChange={(e) => setMemoText(e.target.value)} />
                </div>
              </div>

              <div style={{ ...card, display: 'grid', gap: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>Lines</div>
                  {started && <button onClick={startOver} style={small}>Start over</button>}
                </div>
                {invoice.lines.map((l) => {
                  const b = boxes[l.line];
                  if (!b) return null;
                  const name = l.itemNumber || `Line ${l.line}`;
                  const f = fixedLine(l.line);
                  const changed = f?.state === 'changed';
                  if (l.kind === 'layout') {
                    return (
                      <div key={l.line} style={{ padding: '6px 10px', borderRadius: '8px', background: theme.inputBg, ...muted }}>
                        {name}{l.description ? ` · ${l.description}` : ''} · lays the invoice out
                      </div>
                    );
                  }
                  if (b.removed) {
                    return (
                      <div key={l.line} style={{
                        border: `1px dashed ${theme.errorBorder}`, borderRadius: '10px', padding: '10px',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
                      }}>
                        <span style={{ minWidth: 0, textDecoration: 'line-through', color: theme.textMuted, fontSize: '14px' }}>
                          <b>{name}</b> · {formatCents(l.cents)}
                        </span>
                        <span style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <span style={{ fontSize: '12px', color: theme.error, fontWeight: 700 }}>Taking off</span>
                          <button onClick={() => putBack(l)} style={small}>Put back</button>
                        </span>
                      </div>
                    );
                  }
                  const billed = l.kind === 'amount'
                    ? `${l.cents < 0 ? 'Discount' : 'Markup'} ${formatCents(Math.abs(l.cents))}`
                    : l.kind === 'quantity'
                      ? `${quantityText(l.quantity)} × ${l.rate !== null ? priceText(l.rate) : '…'} = ${formatCents(l.cents)}`
                      : `${formatCents(l.cents)} · FleetSuite only takes this line off, it doesn't change it`;
                  return (
                    <div key={l.line} style={{
                      border: `1px solid ${changed ? theme.successBorder : theme.border}`, borderRadius: '10px', padding: '10px',
                      display: 'grid', gap: '8px',
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 800, color: theme.textPrimary }}>{name}</span>
                          <span style={{ ...num, fontWeight: 800, color: changed ? theme.success : theme.textPrimary }}>
                            {changed && f && f.cents !== l.cents && (
                              <span style={{ textDecoration: 'line-through', color: theme.textMuted, fontWeight: 600, marginRight: '6px' }}>{formatCents(l.cents)}</span>
                            )}
                            {formatCents(f ? f.cents : l.cents)}
                          </span>
                        </div>
                        {!b.describing && b.description && <div style={twoLines}>{b.description}</div>}
                        <div style={muted}>{billed}{l.taxable ? ' · Taxed' : ''}</div>
                      </div>
                      {linesOpen && (
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          {l.kind === 'quantity' && (
                            <>
                              <div style={{ width: '90px' }}>
                                <label style={label} htmlFor={`fx-q-${l.line}`}>Qty</label>
                                <input id={`fx-q-${l.line}`} style={{ ...input, ...num }} inputMode="decimal" value={b.quantityText}
                                  onChange={(e) => patch(l.line, { quantityText: e.target.value })} />
                              </div>
                              <div style={{ width: '130px' }}>
                                <label style={label} htmlFor={`fx-p-${l.line}`}>Price each $</label>
                                <input id={`fx-p-${l.line}`} style={{ ...input, ...num }} inputMode="decimal" value={b.priceText}
                                  onChange={(e) => patch(l.line, { priceText: e.target.value })} />
                              </div>
                            </>
                          )}
                          {l.kind === 'amount' && (
                            <div style={{ width: '140px' }}>
                              <label style={label} htmlFor={`fx-a-${l.line}`}>{l.cents < 0 ? 'Takes off $' : 'Adds $'}</label>
                              <input id={`fx-a-${l.line}`} style={{ ...input, ...num }} inputMode="decimal" value={b.amountText}
                                onChange={(e) => patch(l.line, { amountText: e.target.value })} />
                            </div>
                          )}
                          {(l.kind === 'quantity' || l.kind === 'amount') && !b.describing && (
                            <button onClick={() => patch(l.line, { describing: true })} style={small}>Description</button>
                          )}
                          <button onClick={() => patch(l.line, { removed: true })}
                            style={{ ...small, marginLeft: 'auto', color: theme.error, borderColor: theme.errorBorder }}>Take off</button>
                        </div>
                      )}
                      {linesOpen && b.describing && (
                        <div>
                          <label style={label} htmlFor={`fx-d-${l.line}`}>Description</label>
                          <textarea id={`fx-d-${l.line}`} style={{ ...input, minHeight: '44px', resize: 'vertical' }} rows={2}
                            value={b.description} maxLength={DESCRIPTION_MAX} onChange={(e) => patch(l.line, { description: e.target.value })} />
                        </div>
                      )}
                    </div>
                  );
                })}

                {added.map((a) => {
                  const discount = isDiscountType(a.item.itemType);
                  const q = discount ? 1 : typed(a.quantityText);
                  const p = typed(a.priceText);
                  const cents = Number.isFinite(q) && Number.isFinite(p) && p > 0 ? (discount ? -Math.round(p * 100) : centsOf(q * p)) : null;
                  return (
                    <div key={a.key} style={{ border: `1px solid ${theme.successBorder}`, borderRadius: '10px', padding: '10px', display: 'grid', gap: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                        <span style={{ fontWeight: 800, color: theme.textPrimary }}>{a.item.itemNumber} <span style={{ ...muted, fontWeight: 700 }}>· Adding</span></span>
                        <span style={{ ...num, fontWeight: 800, color: theme.success }}>{cents !== null ? formatCents(cents) : ''}</span>
                      </div>
                      <div>
                        <label style={label} htmlFor={`fx-ad-${a.key}`}>Description</label>
                        <textarea id={`fx-ad-${a.key}`} style={{ ...input, minHeight: '44px', resize: 'vertical' }} rows={2}
                          value={a.description} maxLength={DESCRIPTION_MAX} onChange={(e) => patchAdded(a.key, { description: e.target.value })} />
                      </div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        {!discount && (
                          <div style={{ width: '90px' }}>
                            <label style={label} htmlFor={`fx-aq-${a.key}`}>Qty</label>
                            <input id={`fx-aq-${a.key}`} style={{ ...input, ...num }} inputMode="decimal" value={a.quantityText}
                              onChange={(e) => patchAdded(a.key, { quantityText: e.target.value })} />
                          </div>
                        )}
                        <div style={{ width: '130px' }}>
                          <label style={label} htmlFor={`fx-ap-${a.key}`}>{discount ? 'Takes off $' : 'Price each $'}</label>
                          <input id={`fx-ap-${a.key}`} style={{ ...input, ...num }} inputMode="decimal" value={a.priceText}
                            onChange={(e) => patchAdded(a.key, { priceText: e.target.value })} />
                        </div>
                        <button onClick={() => setAdded((prev) => prev.filter((x) => x.key !== a.key))}
                          style={{ ...small, marginLeft: 'auto', color: theme.error, borderColor: theme.errorBorder }}>Remove</button>
                      </div>
                    </div>
                  );
                })}

                {linesOpen && added.length < MAX_ADDED && (
                  <div style={{ position: 'relative' }}>
                    <label style={label} htmlFor="fx-add">Add a line</label>
                    <input id="fx-add" style={input} value={search} placeholder="Part number, labor, freight, discount…"
                      onChange={(e) => setSearch(e.target.value)} />
                    {(hits.length > 0 || (searching && search.trim().length >= 2)) && (
                      <div style={{ border: `1px solid ${theme.border}`, borderRadius: '8px', marginTop: '4px', background: theme.card, maxHeight: '320px', overflowY: 'auto' }}>
                        {searching && hits.length === 0 && <div style={{ padding: '10px', fontSize: '13px', color: theme.textMuted }}>Searching…</div>}
                        {hits.map((h) => (
                          <button key={h.itemId} onClick={() => addItem(h)} style={{
                            display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px', border: 'none',
                            borderBottom: `1px solid ${theme.border}`, background: 'none', cursor: 'pointer', color: theme.textPrimary,
                          }}>
                            <span style={{ fontWeight: 700 }}>{h.itemNumber}</span>
                            {h.price != null && !isDiscountType(h.itemType) && <span style={{ float: 'right', ...num }}>{formatCents(Math.round(h.price * 100))}</span>}
                            <span style={{ display: 'block', fontSize: '12px', color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {isDiscountType(h.itemType) ? 'Discount · ' : h.itemType === 'Service' ? 'Service · ' : ''}{h.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', ...muted }}>
                  <span>To undo all of it, make a credit memo for all of it.</span>
                  <button onClick={() => router.push(deepLinks.creditMemo(invoice.id))} style={small}>Credit memo</button>
                </div>
              </div>

              <div style={{ ...card, display: 'grid', gap: '4px' }}>
                <label style={label} htmlFor="fx-reason">Why it&apos;s being fixed</label>
                <input id="fx-reason" style={input} value={reason} maxLength={REASON_MAX} placeholder="Wrong PO, wrong price, missed a part…"
                  onChange={(e) => setReason(e.target.value)} />
                <div style={muted}>Kept with the fix in FleetSuite, for whoever looks at the invoice next.</div>
              </div>

              <div style={{ ...card, display: 'grid', gap: '6px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', columnGap: '16px', rowGap: '4px', fontSize: '14px', color: theme.textSecondary }}>
                  <span />
                  <span style={{ ...num, ...muted, fontWeight: 700 }}>Now</span>
                  <span style={{ ...num, ...muted, fontWeight: 700 }}>After the fix</span>
                  <span>Subtotal</span>
                  <span style={num}>{formatCents(invoice.subtotalCents)}</span>
                  <span style={num}>{formatCents(plan.fixed.subtotalCents)}</span>
                  <span>Sales tax</span>
                  <span style={num}>{formatCents(invoice.taxCents)}</span>
                  <span style={num}>{plan.fixed.taxCents === null ? 'NetSuite works it out' : formatCents(plan.fixed.taxCents)}</span>
                  <span style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>Total</span>
                  <span style={{ ...num, fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>{formatCents(invoice.totalCents)}</span>
                  <span style={{ ...num, fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>
                    {plan.fixed.totalCents === null ? '…' : formatCents(plan.fixed.totalCents)}
                  </span>
                </div>
                {plan.notes.map((n) => <div key={n} style={muted}>{n}</div>)}
                <div style={muted}>
                  {data.ownCopy
                    ? "Books' own copy of it changes with the fix, and keeps the one before."
                    : "Books has no copy of its own of this invoice, so only NetSuite's changes."}
                </div>
              </div>

              {plan.changes.length > 0 && (
                <div style={{ ...card, display: 'grid', gap: '4px' }}>
                  <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>What changes</div>
                  {plan.changes.map((c) => <div key={c} style={{ fontSize: '14px', color: theme.textPrimary }}>{c}</div>)}
                </div>
              )}

              {started && plan.problems.length > 0 && (
                <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700, display: 'grid', gap: '2px' }}>
                  {plan.problems.map((p) => <div key={p}>{p}</div>)}
                </div>
              )}
              {error && reloadNeeded && <div><button onClick={load} style={btn}>Reload the invoice</button></div>}
            </>
          )}

          {data.fixes.length > 0 && (
            <div style={{ ...card, display: 'grid', gap: '8px' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>Fixed before</div>
              {data.fixes.map((x) => (
                <div key={x.id} style={{ display: 'grid', gap: '2px', fontSize: '13px', color: theme.textPrimary }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                    <span style={{ minWidth: 0 }}>
                      <b style={{ color: x.status === 'fixed' ? theme.textPrimary : x.status === 'sending' ? theme.warning : theme.error }}>
                        {STATUS_TEXT[x.status]}
                      </b>
                      <span style={{ color: theme.textMuted }}> · {day(x.at)}{x.by ? ` · ${x.by}` : ''} · {x.reason}</span>
                    </span>
                    <span style={num}>
                      {x.totalAfterCents !== null && x.totalBeforeCents !== null && x.totalAfterCents !== x.totalBeforeCents
                        ? `${formatCents(x.totalBeforeCents)} → ${formatCents(x.totalAfterCents)}` : ''}
                    </span>
                  </div>
                  <div style={twoLines}>{x.changes.join(' · ')}</div>
                  {x.error && x.status !== 'fixed' && <div style={{ fontSize: '12px', color: theme.error }}>{x.error}</div>}
                  {x.ownCopy && <div style={muted}>{OWN_COPY_TEXT[x.ownCopy]}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
