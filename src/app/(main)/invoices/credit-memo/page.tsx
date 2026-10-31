'use client';

/**
 * A credit memo against an invoice, made in FleetSuite and sent on to
 * NetSuite (Books part 34, docs/books.md "Credit memos made in FleetSuite";
 * owner decisions 2026-10-31: from January 1, 2027 the team works only in
 * FleetSuite). Opened from Invoicing → Invoiced → Credit on an invoice.
 *
 * Pick what to credit: a line by quantity and price each, a discount by its
 * amount, or an amount of its own. A stock part goes back on the shelf at
 * O'Fallon unless "Back to stock" is off. The caps, tax and total are
 * src/lib/credit-memo.ts, the same rules /api/invoices/credit-memo works the
 * credit memo out by before it makes it in NetSuite. Built switched off
 * (Books → Switches): until it's on, super admins see what it would send and
 * nothing goes to NetSuite.
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
import {
  MAX_ADDED_AMOUNTS, boxText, creditAllOf, earlierCredits, formatCents, leftToCredit, workOutCreditMemo,
  type AddedCreditDraft, type CreditItem, type CreditLineDraft, type EarlierCreditLine, type InvoiceLine, type InvoiceView,
} from '@/lib/credit-memo';

interface Loaded {
  invoice: InvoiceView;
  earlier: {
    fleetsuite: { id: string; creditMemoId: string | null; number: string | null; totalCents: number | null; reason: string; at: string; making: boolean }[];
    lines: EarlierCreditLine[];
    netsuite: { id: string; number: string; date: string | null; total: number }[] | null;
    netsuiteError: string | null;
  };
  creditItem: CreditItem | null;
  switchedOn: boolean;
  offText: string | null;
}

/** What's typed against one invoice line. */
interface Pick {
  on: boolean;
  quantityText: string;
  priceText: string;
  amountText: string;
  backToStock: boolean;
}

interface Added { key: number; description: string; amountText: string; taxable: boolean }

interface Done {
  creditMemoId: string;
  creditMemoNumber: string | null;
  totalCents: number;
  warning?: string;
}

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

/** A typed amount or quantity; blank is 0, so a box left empty credits nothing. */
const typed = (text: string) => (text.trim() === '' ? 0 : Number(text.replace(/[$,\s]/g, '')));

const day = (ymd: string | null) => (ymd ? new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString() : '');

const pct = (rate: number) => `${Number((rate * 100).toFixed(4))}%`;

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
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const muted: React.CSSProperties = { fontSize: '12px', color: theme.textMuted };
/** Two lines at most, so a long description doesn't push the boxes off the screen. */
const twoLines: React.CSSProperties = {
  fontSize: '13px', color: theme.textSecondary, overflow: 'hidden', display: '-webkit-box',
  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};

/** A box for every line, filled with all that's left of it, none picked yet. */
function startingPicks(invoice: InvoiceView, earlier: ReturnType<typeof earlierCredits>): Record<number, Pick> {
  const picks: Record<number, Pick> = {};
  for (const l of invoice.lines) picks[l.line] = { ...pickFor(l, creditAllOf(l, earlier)), on: false };
  return picks;
}

function pickFor(l: InvoiceLine, all: CreditLineDraft | null): Pick {
  return {
    on: !!all,
    quantityText: all?.quantity != null ? boxText(all.quantity, 'quantity') : '',
    priceText: all?.price != null ? boxText(all.price, 'money') : '',
    amountText: all?.amount != null ? boxText(all.amount, 'money') : '',
    backToStock: l.stock,
  };
}

export default function CreditMemoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();
  const invoiceId = (searchParams.get('invoice') || '').trim();

  const [requestId] = useState(newRequestId);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<number, Pick>>({});
  const [added, setAdded] = useState<Added[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    if (!/^\d+$/.test(invoiceId)) { setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`/api/invoices/credit-memo?invoice=${encodeURIComponent(invoiceId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the invoice from NetSuite (${res.status}).`);
      const loaded = body as Loaded;
      setData(loaded);
      setPicks(startingPicks(loaded.invoice, earlierCredits(loaded.earlier.lines)));
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the invoice from NetSuite.");
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => { load(); }, [load]);

  const earlier = useMemo(() => earlierCredits(data?.earlier.lines ?? []), [data]);

  const drafts: CreditLineDraft[] = (data?.invoice.lines ?? []).flatMap((l): CreditLineDraft[] => {
    const p = picks[l.line];
    if (!p?.on) return [];
    if (l.kind === 'amount') return [{ line: l.line, amount: typed(p.amountText) }];
    return [{ line: l.line, quantity: typed(p.quantityText), price: typed(p.priceText), ...(l.stock ? { backToStock: p.backToStock } : {}) }];
  });
  const addedDrafts: AddedCreditDraft[] = added.map((a) => ({ description: a.description, amount: typed(a.amountText), taxable: a.taxable }));
  const worked = useMemo(
    () => (data
      ? workOutCreditMemo(data.invoice, drafts, addedDrafts, { earlier, creditItem: data.creditItem, reason })
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drafts derive from picks and added
    [data, picks, added, reason, earlier],
  );

  const patch = (line: number, p: Partial<Pick>) => setPicks((prev) => ({ ...prev, [line]: { ...prev[line], ...p } }));
  const creditAll = () => {
    if (!data) return;
    setPicks((prev) => {
      const next = { ...prev };
      for (const l of data.invoice.lines) next[l.line] = { ...pickFor(l, creditAllOf(l, earlier)), backToStock: prev[l.line]?.backToStock ?? l.stock };
      return next;
    });
  };
  const clearAll = () => {
    if (!data) return;
    setPicks(startingPicks(data.invoice, earlier));
    setAdded([]);
  };
  const addAmount = () => {
    setAdded((prev) => [...prev, { key: nextKey, description: '', amountText: '', taxable: false }]);
    setNextKey((k) => k + 1);
  };
  const patchAdded = (key: number, p: Partial<Added>) => setAdded((prev) => prev.map((a) => (a.key === key ? { ...a, ...p } : a)));

  const make = async () => {
    if (!data || !worked || worked.problems.length > 0 || !data.switchedOn) return;
    const { invoice } = data;
    const back = worked.lines.filter((l) => l.backToStock).length;
    const ok = await dialog.confirm(
      `Make a credit memo in NetSuite for ${formatCents(worked.totalCents)} against invoice ${invoice.number} for ${invoice.customerName}?`
        + (back > 0 ? ` ${back === 1 ? 'One part goes' : `${back} parts go`} back on the shelf at O'Fallon.` : ''),
      { confirmLabel: 'Make credit memo', title: 'Make credit memo' },
    );
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/invoices/credit-memo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          invoiceId: invoice.id,
          reason,
          lines: drafts.filter((d) => (d.amount ?? 0) > 0 || (d.quantity ?? 0) > 0),
          added: addedDrafts,
          expectedTotalCents: worked.totalCents,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || `NetSuite didn't make the credit memo (${res.status}).`);
      setDone({ creditMemoId: body.creditMemoId, creditMemoNumber: body.creditMemoNumber, totalCents: body.totalCents, warning: body.warning });
    } catch (e: any) {
      setError(e?.message || "NetSuite didn't make the credit memo.");
    } finally {
      setSubmitting(false);
    }
  };

  const openPdf = async () => {
    if (!done) return;
    setOpening(true);
    const r = await openNetSuitePdf('creditMemo', done.creditMemoId);
    setOpening(false);
    if (!r.ok) setError(r.error || "Couldn't open the credit memo PDF.");
  };

  if (!authLoading && (!hasFeature('invoicing') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Invoicing permission and price access to make credit memos.</div>;
  }

  const back = () => router.push(deepLinks.invoicesSent());
  const invoice = data?.invoice;
  const started = drafts.length > 0 || added.length > 0;
  const fleetsuiteIds = new Set((data?.earlier.fleetsuite ?? []).map((c) => c.creditMemoId).filter(Boolean));
  const otherNetsuite = (data?.earlier.netsuite ?? []).filter((c) => !fleetsuiteIds.has(c.id));

  return (
    <div style={{ maxWidth: '820px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!done && invoice && worked && (
        <TopSaveBar
          title="Credit memo"
          subtitle={`${invoice.number} · ${invoice.customerName}`}
          error={error || undefined}
          onSave={make}
          saving={submitting}
          disabled={!data?.switchedOn || worked.problems.length > 0}
          saveLabel={data?.switchedOn ? 'Make credit memo' : 'Switched off'}
          savingLabel="Making credit memo…"
          onCancel={back}
        />
      )}
      <div>
        <button onClick={back} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>← Invoicing</button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Credit memo</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>Made in NetSuite from the invoice, and applied to it while it&apos;s owed.</div>
      </div>

      {data?.offText && !done && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {!/^\d+$/.test(invoiceId) ? (
        <div style={{ ...card, color: theme.textSecondary, fontSize: '14px' }}>
          Open a credit memo from an invoice: Invoicing → Invoiced, then Credit on the invoice.
        </div>
      ) : loading ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Reading the invoice from NetSuite…</div>
      ) : loadError || !invoice || !worked ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{loadError || "Couldn't read the invoice from NetSuite."}</div>
          <div><button onClick={load} style={btn}>Try again</button></div>
        </div>
      ) : done ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: theme.success }}>
            Credit memo {done.creditMemoNumber || done.creditMemoId} made in NetSuite
          </div>
          <div style={{ fontSize: '14px', color: theme.textPrimary }}>
            Against invoice {invoice.number} · {invoice.customerName} · {formatCents(done.totalCents)}
          </div>
          {done.warning && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{done.warning}</div>}
          {error && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{error}</div>}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={openPdf} disabled={opening} style={btn}>{opening ? 'Opening…' : 'Open PDF'}</button>
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
              {[day(invoice.date), invoice.poNumber ? `PO ${invoice.poNumber}` : '', invoice.locationName || '',
                invoice.owedCents === null ? '' : invoice.owedCents > 0 ? `${formatCents(invoice.owedCents)} still owed` : 'Paid',
              ].filter(Boolean).join(' · ')}
            </div>
            {invoice.voided && <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>This invoice is voided in NetSuite.</div>}
          </div>

          {(data.earlier.fleetsuite.length > 0 || otherNetsuite.length > 0 || data.earlier.netsuiteError) && (
            <div style={{ ...card, display: 'grid', gap: '6px' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>Credited before</div>
              {data.earlier.fleetsuite.map((c) => (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', color: theme.textPrimary }}>
                  <span style={{ minWidth: 0 }}>
                    <b>{c.making ? 'Being made now' : c.number || c.creditMemoId}</b>
                    <span style={{ color: theme.textMuted }}> · {day(c.at)} · {c.reason}</span>
                  </span>
                  <span style={num}>{c.totalCents != null ? formatCents(c.totalCents) : ''}</span>
                </div>
              ))}
              {data.earlier.fleetsuite.length > 0 && (
                <div style={muted}>What these credited counts against what&apos;s left on each line below.</div>
              )}
              {otherNetsuite.map((c) => (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', color: theme.textPrimary }}>
                  <span><b>{c.number}</b><span style={{ color: theme.textMuted }}> · {day(c.date)} · made in NetSuite</span></span>
                  <span style={num}>{formatCents(Math.round(c.total * 100))}</span>
                </div>
              ))}
              {otherNetsuite.length > 0 && (
                <div style={{ fontSize: '12px', color: theme.warning, fontWeight: 700 }}>
                  FleetSuite can&apos;t tell which lines {otherNetsuite.length === 1 ? 'that one' : 'those'} credited, so check before crediting the same thing again.
                </div>
              )}
              {data.earlier.netsuiteError && (
                <div style={{ fontSize: '12px', color: theme.warning, fontWeight: 700 }}>
                  Couldn&apos;t check NetSuite for other credit memos on this invoice: {data.earlier.netsuiteError}
                </div>
              )}
            </div>
          )}

          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>What to credit</div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={creditAll} style={{ ...btn, padding: '6px 10px', fontSize: '13px' }}>Credit it all</button>
                {started && <button onClick={clearAll} style={{ ...btn, padding: '6px 10px', fontSize: '13px' }}>Clear</button>}
              </div>
            </div>
            {invoice.lines.length === 0 && <div style={muted}>This invoice has no lines with an amount to credit.</div>}
            {invoice.lines.map((l) => {
              const p = picks[l.line];
              if (!p) return null;
              const left = leftToCredit(l, earlier);
              const before = l.cents - left;
              const nothingLeft = l.cents < 0 ? left >= 0 : left <= 0;
              const w = worked.lines.find((x) => x.invoiceLine === l.line);
              const billed = l.kind === 'amount'
                ? `${l.rateOnly ? (l.cents < 0 ? 'Discount' : 'Markup') : 'Amount'} ${formatCents(l.cents)}`
                : `Billed ${boxText(l.quantity, 'quantity')} × ${l.rate != null ? formatCents(Math.round(l.rate * 100)) : '…'} = ${formatCents(l.cents)}`;
              return (
                <div key={l.line} style={{
                  border: `1px solid ${p.on ? theme.successBorder : theme.border}`, borderRadius: '10px', padding: '10px',
                  display: 'grid', gap: '8px', opacity: nothingLeft ? 0.6 : 1,
                }}>
                  <label style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: nothingLeft ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={p.on} disabled={nothingLeft} onChange={(e) => patch(l.line, { on: e.target.checked })}
                      aria-label={`Credit ${l.itemNumber || `line ${l.line}`}`} style={{ width: '20px', height: '20px', marginTop: '1px', flexShrink: 0 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                        <span style={{ fontWeight: 800, color: theme.textPrimary }}>{l.itemNumber || `Line ${l.line}`}</span>
                        <span style={{ ...num, fontWeight: 800, color: p.on && w ? theme.success : theme.textMuted }}>
                          {formatCents(p.on && w ? w.cents : l.cents)}
                        </span>
                      </div>
                      {l.description && <div style={twoLines}>{l.description}</div>}
                      <div style={muted}>
                        {billed}{l.taxable ? ' · Taxed' : ''}
                        {nothingLeft ? ' · All credited before' : before !== 0 ? ` · ${formatCents(Math.abs(before))} credited before` : ''}
                      </div>
                    </div>
                  </label>
                  {p.on && (
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', paddingLeft: '30px' }}>
                      {l.kind === 'amount' ? (
                        <div style={{ width: '140px' }}>
                          <label style={label} htmlFor={`cm-a-${l.line}`}>{l.cents < 0 ? 'Discount $' : 'Amount $'}</label>
                          <input id={`cm-a-${l.line}`} style={{ ...input, ...num }} inputMode="decimal" value={p.amountText}
                            onChange={(e) => patch(l.line, { amountText: e.target.value })} />
                        </div>
                      ) : (
                        <>
                          <div style={{ width: '90px' }}>
                            <label style={label} htmlFor={`cm-q-${l.line}`}>Qty</label>
                            <input id={`cm-q-${l.line}`} style={{ ...input, ...num }} inputMode="decimal" value={p.quantityText}
                              onChange={(e) => patch(l.line, { quantityText: e.target.value })} />
                          </div>
                          <div style={{ width: '130px' }}>
                            <label style={label} htmlFor={`cm-p-${l.line}`}>Price each $</label>
                            <input id={`cm-p-${l.line}`} style={{ ...input, ...num }} inputMode="decimal" value={p.priceText}
                              onChange={(e) => patch(l.line, { priceText: e.target.value })} />
                          </div>
                          {l.stock && (
                            <label style={{ display: 'grid', gap: '2px', cursor: 'pointer', minWidth: '170px' }}>
                              <span style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>
                                <input type="checkbox" checked={p.backToStock} onChange={(e) => patch(l.line, { backToStock: e.target.checked })}
                                  style={{ width: '18px', height: '18px' }} />
                                Back to stock
                              </span>
                              <span style={muted}>{p.backToStock ? 'Goes back on the shelf at O\'Fallon' : 'Credit only, no part comes back'}</span>
                            </label>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {added.map((a, i) => (
              <div key={a.key} style={{ border: `1px solid ${theme.successBorder}`, borderRadius: '10px', padding: '10px', display: 'grid', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 800, color: theme.textPrimary }}>Amount of its own</span>
                  <span style={{ ...num, fontWeight: 800, color: theme.success }}>
                    {typed(a.amountText) > 0 ? formatCents(Math.round(typed(a.amountText) * 100)) : ''}
                  </span>
                </div>
                <div>
                  <label style={label} htmlFor={`cm-ad-${a.key}`}>What it&apos;s for</label>
                  <input id={`cm-ad-${a.key}`} style={input} value={a.description} maxLength={300} placeholder="Goodwill, late delivery…"
                    onChange={(e) => patchAdded(a.key, { description: e.target.value })} />
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div style={{ width: '140px' }}>
                    <label style={label} htmlFor={`cm-aa-${a.key}`}>Amount $</label>
                    <input id={`cm-aa-${a.key}`} style={{ ...input, ...num }} inputMode="decimal" value={a.amountText}
                      onChange={(e) => patchAdded(a.key, { amountText: e.target.value })} />
                  </div>
                  {invoice.taxCents > 0 && (
                    <label style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '14px', fontWeight: 700, color: theme.textPrimary, cursor: 'pointer', paddingBottom: '8px' }}>
                      <input type="checkbox" checked={a.taxable} onChange={(e) => patchAdded(a.key, { taxable: e.target.checked })}
                        style={{ width: '18px', height: '18px' }} />
                      Give back sales tax on it too
                    </label>
                  )}
                  <button onClick={() => setAdded((prev) => prev.filter((x) => x.key !== a.key))}
                    aria-label={`Remove amount ${i + 1}`}
                    style={{ ...btn, marginLeft: 'auto', color: theme.error, borderColor: theme.errorBorder }}>Remove</button>
                </div>
              </div>
            ))}
            {added.length < MAX_ADDED_AMOUNTS && (
              <div>
                <button onClick={addAmount} style={{ ...btn, padding: '6px 10px', fontSize: '13px' }}>+ Add an amount</button>
                <div style={{ ...muted, marginTop: '4px' }}>A credit of its own, like goodwill. No part comes back.</div>
              </div>
            )}
            {!data.creditItem && (
              <div style={muted}>
                Crediting money with no part coming back needs the NetSuite Credit Item, which a super admin picks in Settings.
              </div>
            )}
          </div>

          <div style={{ ...card, display: 'grid', gap: '4px' }}>
            <label style={label} htmlFor="cm-reason">Why it&apos;s being credited</label>
            <input id="cm-reason" style={input} value={reason} maxLength={999} placeholder="Returned part, priced wrong, goodwill…"
              onChange={(e) => setReason(e.target.value)} />
            <div style={muted}>Goes on the credit memo in NetSuite as its memo.</div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: theme.textSecondary }}>
              <span>Subtotal</span><span style={num}>{formatCents(worked.subtotalCents)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: theme.textSecondary }}>
              <span>
                {invoice.taxCents === 0 ? 'Sales tax (none on this invoice)'
                  : invoice.taxRate !== null ? `Sales tax ${pct(invoice.taxRate)}, as the invoice charged it` : 'Sales tax'}
              </span>
              <span style={num}>{formatCents(worked.taxCents)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '18px', fontWeight: 800, color: theme.textPrimary }}>
              <span>Total credit</span><span style={num}>{formatCents(worked.totalCents)}</span>
            </div>
            <div style={muted}>
              {invoice.owedCents === null
                ? `NetSuite applies it to invoice ${invoice.number} while it's owed; anything more stays as ${invoice.customerName}'s credit.`
                : invoice.owedCents > 0
                  ? `NetSuite applies it to invoice ${invoice.number}, which still owes ${formatCents(invoice.owedCents)}. Anything more stays as ${invoice.customerName}'s credit.`
                  : `Invoice ${invoice.number} is paid, so the credit stays as ${invoice.customerName}'s credit, for a later invoice or a refund in NetSuite.`}
            </div>
          </div>

          {started && worked.problems.length > 0 && (
            <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700, display: 'grid', gap: '2px' }}>
              {worked.problems.map((p) => <div key={p}>{p}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
