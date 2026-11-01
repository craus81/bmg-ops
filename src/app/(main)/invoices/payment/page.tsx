'use client';

/**
 * A customer's check or ACH payment, received in FleetSuite and sent on to
 * NetSuite (Books part 54, docs/books.md "Payments received in FleetSuite";
 * owner decisions 2026-10-31: receiving payments moves into FleetSuite during
 * 2027). Opened from Invoicing → Invoiced → Payment on an open invoice.
 *
 * Type the payment, check or ACH with its number or reference, the day it
 * came and its amount, then tick the invoices it pays. Ticking one puts what's
 * left of the payment on it, up to what's open on it; Oldest first spreads the
 * amount the way NetSuite's Accept Payment does. Every dollar of it pays an
 * invoice. The checks are src/lib/receive-payment.ts, the same rules
 * /api/invoices/payment checks the payment by again, against what NetSuite has
 * open, when it's pressed. Built switched off (Books → Switches): until it's
 * on, super admins see what it would send and nothing goes to NetSuite.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import TopSaveBar from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import { parseDollars } from '@/lib/books/typed-dollars';
import {
  MEMO_MAX, METHODS, REFERENCE_MAX, applyOldestFirst, formatCents, netsuiteMemo, workOutPayment,
  type OpenInvoice, type PaymentMethod,
} from '@/lib/receive-payment';

interface Earlier {
  id: string;
  paymentId: string | null;
  number: string | null;
  date: string;
  method: PaymentMethod;
  reference: string | null;
  amountCents: number;
  invoices: string[];
  making: boolean;
  warning: string | null;
}

interface Loaded {
  today: string;
  customer: { id: string; name: string };
  company: string | null;
  invoice: { id: string; number: string; openCents: number };
  open: OpenInvoice[];
  elsewhere: number;
  earlier: Earlier[];
  switchedOn: boolean;
  offText: string | null;
}

interface Done {
  paymentId: string;
  number: string | null;
  amountCents: number;
  warning?: string;
  booksWarning?: string;
}

/** What's typed against one invoice. */
interface Pick { on: boolean; text: string }

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

const centsText = (cents: number) => (cents / 100).toFixed(2);
/** Typed dollars in cents; 0 when the box is empty or isn't an amount, which the checks say plainly. */
const typedCents = (text: string) => parseDollars(text) ?? 0;

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
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const muted: React.CSSProperties = { fontSize: '12px', color: theme.textMuted };

/** The invoice Payment was pressed on ticked with all that's open on it, and the amount filled in to match. */
function starting(data: Loaded): { picks: Record<string, Pick>; amountText: string } {
  const picks: Record<string, Pick> = {};
  for (const i of data.open) picks[i.id] = { on: false, text: '' };
  const first = data.open.find((i) => i.id === data.invoice.id);
  if (first) picks[first.id] = { on: true, text: centsText(first.openCents) };
  return { picks, amountText: first ? centsText(first.openCents) : '' };
}

export default function ReceivePaymentPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();
  const invoiceId = (searchParams.get('invoice') || '').trim();

  const [requestId] = useState(newRequestId);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('check');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState('');
  const [amountText, setAmountText] = useState('');
  const [memo, setMemo] = useState('');
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsure, setUnsure] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  const load = useCallback(async () => {
    if (!/^\d+$/.test(invoiceId)) { setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`/api/invoices/payment?invoice=${encodeURIComponent(invoiceId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the invoices from NetSuite (${res.status}).`);
      const loaded = body as Loaded;
      const start = starting(loaded);
      setData(loaded);
      setPicks(start.picks);
      setAmountText(start.amountText);
      setDate(loaded.today);
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the invoices from NetSuite.");
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => { load(); }, [load]);

  const amountCents = typedCents(amountText);
  const applied = (data?.open ?? []).filter((i) => picks[i.id]?.on).map((i) => ({ invoiceId: i.id, cents: typedCents(picks[i.id].text) }));
  const worked = useMemo(
    () => (data ? workOutPayment({ date, method, reference, memo, amountCents, applied }, data.open, { today: data.today }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applied derives from picks
    [data, date, method, reference, memo, amountCents, picks],
  );

  const tick = (invoice: OpenInvoice, on: boolean) => {
    setPicks((prev) => {
      if (!on) return { ...prev, [invoice.id]: { on: false, text: '' } };
      // What's left of the payment goes on it, up to what's open; with nothing left, all that's open.
      const elsewhere = Object.entries(prev).reduce((s, [id, p]) => (p.on && id !== invoice.id ? s + typedCents(p.text) : s), 0);
      const left = amountCents - elsewhere;
      return { ...prev, [invoice.id]: { on: true, text: centsText(left > 0 ? Math.min(left, invoice.openCents) : invoice.openCents) } };
    });
  };
  const spreadOldestFirst = () => {
    if (!data) return;
    const spread = applyOldestFirst(amountCents, data.open);
    setPicks(Object.fromEntries(data.open.map((i) => {
      const cents = spread.get(i.id);
      return [i.id, cents ? { on: true, text: centsText(cents) } : { on: false, text: '' }];
    })));
  };
  const clearAll = () => {
    if (!data) return;
    setPicks(Object.fromEntries(data.open.map((i) => [i.id, { on: false, text: '' }])));
  };

  const send = async (asking: boolean) => {
    if (!data || !worked || !data.switchedOn || (!asking && worked.problems.length > 0)) return;
    if (!asking) {
      const n = worked.applied.length;
      const ok = await dialog.confirm(
        `Receive ${netsuiteMemo(worked.method, worked.reference, null)} for ${formatCents(worked.amountCents)} from ${data.customer.name}, `
          + `and make the payment in NetSuite? It pays ${n === 1 ? 'one invoice' : `${n} invoices`} and goes to Undeposited Funds.`,
        { confirmLabel: 'Receive payment', title: 'Receive payment' },
      );
      if (!ok) return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/invoices/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, invoiceId: data.invoice.id, date, method, reference, memo, amountCents, applied }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        setUnsure(!!body.unsure);
        throw new Error(body.error || `NetSuite didn't make the payment (${res.status}).`);
      }
      setUnsure(false);
      setDone({ paymentId: body.paymentId, number: body.number ?? null, amountCents: body.amountCents ?? worked.amountCents, warning: body.warning, booksWarning: body.booksWarning });
    } catch (e: any) {
      setError(e?.message || "NetSuite didn't make the payment.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!authLoading && (!hasFeature('invoicing') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Invoicing permission and price access to receive payments.</div>;
  }

  const back = () => router.push(deepLinks.invoicesSent());
  const leftCents = worked ? amountCents - worked.appliedCents : 0;
  const openTotal = (data?.open ?? []).reduce((s, i) => s + i.openCents, 0);
  const startedOpen = !!data?.open.some((i) => i.id === data.invoice.id);

  return (
    <div style={{ maxWidth: '820px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!done && data && worked && !unsure && (
        <TopSaveBar
          title="Receive payment"
          subtitle={`${data.customer.name}${amountCents > 0 ? ` · ${formatCents(amountCents)}` : ''}`}
          error={error || undefined}
          onSave={() => send(false)}
          saving={submitting}
          disabled={!data.switchedOn || worked.problems.length > 0}
          saveLabel={data.switchedOn ? 'Receive payment' : 'Switched off'}
          savingLabel="Making the payment…"
          onCancel={back}
        />
      )}
      <div>
        <button onClick={back} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>← Invoicing</button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Receive payment</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>A check or ACH payment, put on the customer&apos;s open invoices and made in NetSuite.</div>
      </div>

      {data?.offText && !done && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {!/^\d+$/.test(invoiceId) ? (
        <div style={{ ...card, color: theme.textSecondary, fontSize: '14px' }}>
          Open a payment from an invoice: Invoicing → Invoiced, then Payment on an open invoice.
        </div>
      ) : loading ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Reading the customer&apos;s open invoices from NetSuite…</div>
      ) : loadError || !data || !worked ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{loadError || "Couldn't read the invoices from NetSuite."}</div>
          <div><button onClick={load} style={btn}>Try again</button></div>
        </div>
      ) : done ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: theme.success }}>
            Payment {done.number || done.paymentId} made in NetSuite
          </div>
          <div style={{ fontSize: '14px', color: theme.textPrimary }}>
            {data.customer.name} · {netsuiteMemo(worked.method, worked.reference, null)} · {formatCents(done.amountCents)} · In Undeposited Funds
          </div>
          {done.warning && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{done.warning}</div>}
          {done.booksWarning && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{done.booksWarning}</div>}
          <div><button onClick={back} style={btn}>Back to invoices</button></div>
        </div>
      ) : unsure ? (
        <div style={{ ...card, borderColor: theme.errorBorder, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{error}</div>
          <div style={muted}>Don&apos;t receive it again on another screen: FleetSuite asks NetSuite under this payment&apos;s own name, so it&apos;s never made twice.</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={() => send(true)} disabled={submitting} style={btn}>{submitting ? 'Asking NetSuite…' : 'Ask NetSuite'}</button>
            <button onClick={back} style={btn}>Back to invoices</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '4px' }}>
            <div style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>{data.customer.name}</div>
            <div style={muted}>
              {[data.company ? `${data.company}'s books` : '',
                data.open.length === 0 ? 'Nothing open in NetSuite'
                  : `${data.open.length === 1 ? 'One open invoice' : `${data.open.length} open invoices`}, ${formatCents(openTotal)} open`,
              ].filter(Boolean).join(' · ')}
            </div>
            {!startedOpen && (
              <div style={{ fontSize: '13px', color: theme.warning, fontWeight: 700 }}>
                {data.invoice.number} has nothing open in NetSuite now: it&apos;s paid.
              </div>
            )}
            {data.elsewhere > 0 && (
              <div style={muted}>
                {data.elsewhere === 1 ? 'One more open invoice is' : `${data.elsewhere} more open invoices are`} in the other company&apos;s books: a payment pays one company&apos;s.
              </div>
            )}
          </div>

          {data.earlier.length > 0 && (
            <div style={{ ...card, display: 'grid', gap: '6px' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>Received in FleetSuite lately</div>
              {data.earlier.map((p) => (
                <div key={p.id} style={{ display: 'grid', gap: '2px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', color: theme.textPrimary }}>
                    <span style={{ minWidth: 0 }}>
                      <b>{p.making ? 'Being made now' : p.number || p.paymentId}</b>
                      <span style={{ color: theme.textMuted }}> · {day(p.date)} · {netsuiteMemo(p.method, p.reference, null)} · {p.invoices.join(', ')}</span>
                    </span>
                    <span style={num}>{formatCents(p.amountCents)}</span>
                  </div>
                  {p.warning && <div style={{ fontSize: '12px', color: theme.error, fontWeight: 700 }}>{p.warning}</div>}
                </div>
              ))}
              <div style={muted}>What they paid is already off the open amounts below.</div>
            </div>
          )}

          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              {(Object.keys(METHODS) as PaymentMethod[]).map((m) => (
                <button key={m} onClick={() => setMethod(m)} aria-pressed={method === m}
                  style={{ ...btn, flex: 1, borderColor: method === m ? theme.successBorder : theme.border, background: method === m ? theme.successBg : theme.card, color: method === m ? theme.success : theme.textPrimary }}>
                  {METHODS[m].name}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 140px' }}>
                <label style={label} htmlFor="pay-ref">{METHODS[method].reference}{method === 'ach' ? ' (if any)' : ''}</label>
                <input id="pay-ref" style={input} value={reference} maxLength={REFERENCE_MAX} inputMode={method === 'check' ? 'numeric' : 'text'}
                  onChange={(e) => setReference(e.target.value)} />
              </div>
              <div style={{ flex: '1 1 150px' }}>
                <label style={label} htmlFor="pay-date">Received</label>
                <input id="pay-date" type="date" style={input} value={date} max={data.today} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div style={{ flex: '1 1 140px' }}>
                <label style={label} htmlFor="pay-amount">Amount $</label>
                <input id="pay-amount" style={{ ...input, ...num }} inputMode="decimal" value={amountText}
                  onChange={(e) => setAmountText(e.target.value)} />
              </div>
            </div>
            <div>
              <label style={label} htmlFor="pay-memo">Memo (if any)</label>
              <input id="pay-memo" style={input} value={memo} maxLength={MEMO_MAX} onChange={(e) => setMemo(e.target.value)} />
              <div style={{ ...muted, marginTop: '4px' }}>NetSuite&apos;s memo reads &ldquo;{worked.netsuiteMemo}&rdquo;.</div>
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>What it pays</div>
              {data.open.length > 0 && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={spreadOldestFirst} disabled={amountCents <= 0} style={{ ...btn, padding: '6px 10px', fontSize: '13px' }}>Oldest first</button>
                  <button onClick={clearAll} style={{ ...btn, padding: '6px 10px', fontSize: '13px' }}>Clear</button>
                </div>
              )}
            </div>
            {data.open.length === 0 && <div style={muted}>{data.customer.name} has no open invoices in NetSuite for a payment to pay.</div>}
            {data.open.map((i) => {
              const p = picks[i.id] ?? { on: false, text: '' };
              const left = i.openCents - (p.on ? typedCents(p.text) : 0);
              return (
                <div key={i.id} style={{
                  border: `1px solid ${p.on ? theme.successBorder : theme.border}`, borderRadius: '10px', padding: '10px',
                  display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
                }}>
                  <label style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', flex: '1 1 220px', minWidth: 0 }}>
                    <input type="checkbox" checked={p.on} onChange={(e) => tick(i, e.target.checked)}
                      aria-label={`Pay ${i.number}`} style={{ width: '20px', height: '20px', marginTop: '1px', flexShrink: 0 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                        <span style={{ fontWeight: 800, color: theme.textPrimary }}>{i.number}</span>
                        <span style={{ ...num, fontWeight: 800, color: theme.textPrimary }}>{formatCents(i.openCents)} open</span>
                      </div>
                      <div style={muted}>
                        {[day(i.date), i.dueDate ? `due ${day(i.dueDate)}` : '', i.po ? `PO ${i.po}` : '',
                          i.totalCents !== i.openCents ? `${formatCents(i.totalCents)} billed` : '',
                          p.on && left !== i.openCents ? (left > 0 ? `${formatCents(left)} left open after this` : left === 0 ? 'Paid in full by this' : '') : '',
                        ].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  </label>
                  {p.on && (
                    <div style={{ width: '130px', marginLeft: 'auto' }}>
                      <label style={label} htmlFor={`pay-i-${i.id}`}>Pays $</label>
                      <input id={`pay-i-${i.id}`} style={{ ...input, ...num }} inputMode="decimal" value={p.text}
                        onChange={(e) => setPicks((prev) => ({ ...prev, [i.id]: { on: true, text: e.target.value } }))} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ ...card, display: 'grid', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: theme.textSecondary }}>
              <span>Received</span><span style={num}>{formatCents(Math.max(amountCents, 0))}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: theme.textSecondary }}>
              <span>On invoices</span><span style={num}>{formatCents(worked.appliedCents)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '18px', fontWeight: 800, color: leftCents !== 0 && amountCents > 0 ? theme.error : theme.textPrimary }}>
              <span>{leftCents < 0 ? 'Over by' : 'Left to put on an invoice'}</span><span style={num}>{formatCents(Math.abs(leftCents))}</span>
            </div>
            <div style={muted}>It goes to Undeposited Funds in NetSuite until it&apos;s deposited, as payments go now.</div>
          </div>

          {worked.problems.length > 0 && (
            <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700, display: 'grid', gap: '2px' }}>
              {worked.problems.map((p) => <div key={p}>{p}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
