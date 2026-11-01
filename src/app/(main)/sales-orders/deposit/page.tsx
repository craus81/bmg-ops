'use client';

/**
 * A customer's check or ACH deposit, taken in FleetSuite on a sales order and
 * sent on to NetSuite (Books part 55, docs/books.md "Deposits taken in
 * FleetSuite"; owner decisions 2026-10-31: taking deposits moves into
 * FleetSuite during 2027). Opened from a sales order's Deposit, or an
 * estimate's once it has its sales order.
 *
 * Type the deposit, check or ACH with its number or reference, the day it
 * came and its amount. It goes on an order NetSuite still has open, never more
 * than what's left of the order after the deposits on it. The checks are
 * src/lib/take-deposit.ts, the same rules /api/sales-orders/deposit checks the
 * deposit by again, against the order as NetSuite has it, when it's pressed.
 * Built switched off (Books → Switches): until it's on, super admins see what
 * it would send and nothing goes to NetSuite.
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
import { MEMO_MAX, METHODS, REFERENCE_MAX, netsuiteMemo, type PaymentMethod } from '@/lib/receive-payment';
import { formatCents, workOutDeposit, type DepositOnOrder, type DepositOrder } from '@/lib/take-deposit';

interface Loaded {
  today: string;
  customer: { id: string; name: string };
  company: string | null;
  order: DepositOrder & { date: string | null };
  onOrder: DepositOnOrder[];
  switchedOn: boolean;
  offText: string | null;
}

interface Done {
  depositId: string;
  number: string | null;
  amountCents: number;
  booksWarning?: string;
}

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

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

export default function TakeDepositPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();
  const salesOrderId = (searchParams.get('so') || '').trim();

  const [requestId] = useState(newRequestId);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('check');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState('');
  const [amountText, setAmountText] = useState('');
  const [memo, setMemo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsure, setUnsure] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  const load = useCallback(async () => {
    if (!/^\d+$/.test(salesOrderId)) { setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`/api/sales-orders/deposit?so=${encodeURIComponent(salesOrderId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the sales order from NetSuite (${res.status}).`);
      const loaded = body as Loaded;
      setData(loaded);
      setDate(loaded.today);
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the sales order from NetSuite.");
    } finally {
      setLoading(false);
    }
  }, [salesOrderId]);

  useEffect(() => { load(); }, [load]);

  const amountCents = typedCents(amountText);
  const worked = useMemo(
    () => (data ? workOutDeposit({ date, method, reference, memo, amountCents }, data.order, data.onOrder, { today: data.today }) : null),
    [data, date, method, reference, memo, amountCents],
  );

  const send = async (asking: boolean) => {
    if (!data || !worked || !data.switchedOn || (!asking && worked.problems.length > 0)) return;
    if (!asking) {
      const ok = await dialog.confirm(
        `Take ${netsuiteMemo(worked.method, worked.reference, null)} for ${formatCents(worked.amountCents)} from ${data.customer.name} `
          + `as a deposit on ${data.order.number}, and make it in NetSuite? It goes to Undeposited Funds.`,
        { confirmLabel: 'Take deposit', title: 'Take deposit' },
      );
      if (!ok) return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/sales-orders/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, salesOrderId: data.order.id, date, method, reference, memo, amountCents }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        setUnsure(!!body.unsure);
        throw new Error(body.error || `NetSuite didn't make the deposit (${res.status}).`);
      }
      setUnsure(false);
      setDone({ depositId: body.depositId, number: body.number ?? null, amountCents: body.amountCents ?? worked.amountCents, booksWarning: body.booksWarning });
    } catch (e: any) {
      setError(e?.message || "NetSuite didn't make the deposit.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!authLoading && (!hasFeature('invoicing') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Invoicing permission and price access to take deposits.</div>;
  }

  const back = () => router.push(/^\d+$/.test(salesOrderId) ? deepLinks.salesOrder(salesOrderId) : '/sales-orders');

  return (
    <div style={{ maxWidth: '820px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!done && data && worked && !unsure && (
        <TopSaveBar
          title="Take deposit"
          subtitle={`${data.customer.name} · ${data.order.number}${amountCents > 0 ? ` · ${formatCents(amountCents)}` : ''}`}
          error={error || undefined}
          onSave={() => send(false)}
          saving={submitting}
          disabled={!data.switchedOn || worked.problems.length > 0}
          saveLabel={data.switchedOn ? 'Take deposit' : 'Switched off'}
          savingLabel="Making the deposit…"
          onCancel={back}
        />
      )}
      <div>
        <button onClick={back} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>
          ← {data?.order.number ?? 'Sales order'}
        </button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Take deposit</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>A check or ACH deposit on a sales order, made in NetSuite on the order.</div>
      </div>

      {data?.offText && !done && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {!/^\d+$/.test(salesOrderId) ? (
        <div style={{ ...card, color: theme.textSecondary, fontSize: '14px' }}>
          Open a deposit from a sales order: its Deposit button, or an estimate&apos;s once it has its sales order.
        </div>
      ) : loading ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Reading the sales order from NetSuite…</div>
      ) : loadError || !data || !worked ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{loadError || "Couldn't read the sales order from NetSuite."}</div>
          <div><button onClick={load} style={btn}>Try again</button></div>
        </div>
      ) : done ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: theme.success }}>
            Deposit {done.number || done.depositId} made in NetSuite
          </div>
          <div style={{ fontSize: '14px', color: theme.textPrimary }}>
            {data.customer.name} · {data.order.number} · {netsuiteMemo(worked.method, worked.reference, null)} · {formatCents(done.amountCents)} · In Undeposited Funds
          </div>
          {done.booksWarning && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{done.booksWarning}</div>}
          <div><button onClick={back} style={btn}>Back to the order</button></div>
        </div>
      ) : unsure ? (
        <div style={{ ...card, borderColor: theme.errorBorder, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{error}</div>
          <div style={muted}>Don&apos;t take it again on another screen: FleetSuite asks NetSuite under this deposit&apos;s own name, so it&apos;s never made twice.</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={() => send(true)} disabled={submitting} style={btn}>{submitting ? 'Asking NetSuite…' : 'Ask NetSuite'}</button>
            <button onClick={back} style={btn}>Back to the order</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '4px' }}>
            <div style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>{data.customer.name}</div>
            <div style={muted}>
              {[data.company ? `${data.company}'s books` : '', data.order.number, data.order.statusName, `${formatCents(data.order.totalCents)} order`]
                .filter(Boolean).join(' · ')}
            </div>
          </div>

          {data.onOrder.length > 0 && (
            <div style={{ ...card, display: 'grid', gap: '6px' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>Deposits on this order</div>
              {data.onOrder.map((d, i) => (
                <div key={d.netsuiteId ?? `making-${i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', color: theme.textPrimary }}>
                  <span style={{ minWidth: 0 }}>
                    <b>{d.making ? 'Being made now' : d.number || d.netsuiteId}</b>
                    <span style={{ color: theme.textMuted }}> · {day(d.date)} · {d.inFleetSuite ? 'taken in FleetSuite' : 'made in NetSuite'}</span>
                  </span>
                  <span style={num}>{formatCents(d.cents)}</span>
                </div>
              ))}
              <div style={muted}>A deposit made in NetSuite shows here within two hours.</div>
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
                <label style={label} htmlFor="dep-ref">{METHODS[method].reference}{method === 'ach' ? ' (if any)' : ''}</label>
                <input id="dep-ref" style={input} value={reference} maxLength={REFERENCE_MAX} inputMode={method === 'check' ? 'numeric' : 'text'}
                  onChange={(e) => setReference(e.target.value)} />
              </div>
              <div style={{ flex: '1 1 150px' }}>
                <label style={label} htmlFor="dep-date">Received</label>
                <input id="dep-date" type="date" style={input} value={date} max={data.today} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div style={{ flex: '1 1 140px' }}>
                <label style={label} htmlFor="dep-amount">Amount $</label>
                <input id="dep-amount" style={{ ...input, ...num }} inputMode="decimal" value={amountText}
                  onChange={(e) => setAmountText(e.target.value)} />
              </div>
            </div>
            <div>
              <label style={label} htmlFor="dep-memo">Memo (if any)</label>
              <input id="dep-memo" style={input} value={memo} maxLength={MEMO_MAX} onChange={(e) => setMemo(e.target.value)} />
              <div style={{ ...muted, marginTop: '4px' }}>NetSuite&apos;s memo reads &ldquo;{worked.netsuiteMemo}&rdquo;.</div>
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: theme.textSecondary }}>
              <span>Order</span><span style={num}>{formatCents(data.order.totalCents)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: theme.textSecondary }}>
              <span>Deposits on it</span><span style={num}>{formatCents(worked.onOrderCents)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '18px', fontWeight: 800, color: theme.textPrimary }}>
              <span>Left for this deposit</span><span style={num}>{formatCents(worked.leftCents)}</span>
            </div>
            <div style={muted}>
              It goes to Undeposited Funds in NetSuite until it&apos;s deposited, as payments go now, and NetSuite puts it on the order&apos;s invoice when the order&apos;s billed.
            </div>
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
