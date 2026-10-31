'use client';

/**
 * Fixing a bill after it's made, in FleetSuite, and sending the fix on to
 * NetSuite (Books part 40, docs/books.md "Bills fixed in FleetSuite"; owner
 * decisions 2026-10-31: from January 1, 2027 the team works only in
 * FleetSuite). Opened from More → Purchasing → Fix a Bill, which finds the
 * bill by its number or vendor, or from Fix on Books → Own bills.
 *
 * Its number, memo and due date can always be fixed; while nothing on it is
 * paid or credited, its date and lines too: an expense line's account,
 * amount and memo, a part's quantity, rate and description, a line taken off
 * and an expense line added. What changes and what NetSuite is sent are
 * src/lib/bill-fix.ts, the same rules /api/purchasing/bill-fix works the fix
 * out by before it sends it. Undoing all of a bill is Credit all of it, a
 * vendor credit filled in from the bill. Built switched off (Books →
 * Switches): until it's on, super admins see what a fix would send and
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
import {
  BILL_NUMBER_MAX, DESCRIPTION_MAX, MAX_ADDED, MEMO_MAX, REASON_MAX, billName, dayText, formatCents, lineName, planBillFix,
  priceText, quantityText,
  type BillFixAllows, type BillFixLine, type BillHeaderEdit, type BillLineEdit, type BillNewLine, type FixBill,
} from '@/lib/bill-fix';

const API = '/api/purchasing/bill-fix';

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
  bill: FixBill;
  allows: BillFixAllows;
  termsDays: number | null;
  accounts: Array<{ id: string; name: string }>;
  signature: string;
  fixes: FixHistory[];
  ownCopy: { version: number; fixedAt: string | null } | null;
  switchedOn: boolean;
  offText: string | null;
}

/** A bill the search found, from the copy of NetSuite's bills. */
interface FoundBill {
  id: string;
  number: string | null;
  date: string;
  vendorName: string | null;
  totalCents: number;
  voided: boolean;
}

/** What's in the boxes of one of the bill's lines. */
interface Box {
  accountId: string;
  amountText: string;
  quantityText: string;
  rateText: string;
  description: string;
  describing: boolean;
  removed: boolean;
}

/** An expense line added. */
interface Added {
  key: number;
  accountId: string;
  amountText: string;
  memo: string;
}

interface Done {
  number: string;
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

const keyOf = (l: Pick<BillFixLine, 'list' | 'line'>) => `${l.list}:${l.line}`;

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
const heading: React.CSSProperties = { fontSize: '15px', fontWeight: 800, color: theme.textPrimary };
/** Two lines at most, so a long description doesn't push the boxes off the screen. */
const twoLines: React.CSSProperties = {
  fontSize: '13px', color: theme.textSecondary, overflow: 'hidden', display: '-webkit-box',
  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};

/** The boxes as the bill has them, so a box left alone changes nothing. */
function startingBox(l: BillFixLine): Box {
  return {
    accountId: l.accountId ?? '',
    amountText: l.kind === 'expense' ? (l.cents / 100).toFixed(2) : '',
    quantityText: l.kind === 'quantity' ? String(l.quantity) : '',
    rateText: l.kind === 'quantity' && l.rate !== null ? String(l.rate) : '',
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

export default function BillFixPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();
  const billId = (searchParams.get('bill') || '').trim();
  const allowed = !authLoading && hasFeature('parts_ordering') && canSeeMoney;

  // Made when the bill is read: the same form pressed twice is one fix.
  const [requestId, setRequestId] = useState(newRequestId);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [numberText, setNumberText] = useState('');
  const [dateText, setDateText] = useState('');
  const [dueText, setDueText] = useState('');
  const [memoText, setMemoText] = useState('');
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [added, setAdded] = useState<Added[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [find, setFind] = useState('');
  const [found, setFound] = useState<FoundBill[] | null>(null);
  const [findError, setFindError] = useState('');

  const load = useCallback(async () => {
    if (!/^\d+$/.test(billId)) { setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`${API}?${new URLSearchParams({ bill: billId })}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the bill from NetSuite (${res.status}).`);
      const loaded = body as Loaded;
      const b = loaded.bill;
      setData(loaded);
      setNumberText(b.number);
      setDateText(b.date ?? '');
      setDueText(b.dueDate ?? '');
      setMemoText(b.memo);
      setBoxes(Object.fromEntries(b.lines.map((l) => [keyOf(l), startingBox(l)])));
      setAdded([]);
      setReason('');
      setError(null);
      setReloadNeeded(false);
      setDone(null);
      setRequestId(newRequestId());
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the bill from NetSuite.");
    } finally {
      setLoading(false);
    }
  }, [billId]);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  // With no bill open: find one by its number or vendor, the newest first.
  useEffect(() => {
    if (billId || !allowed) return;
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(`${API}?${new URLSearchParams({ find: find.trim() })}`);
        const body = await res.json().catch(() => ({}));
        setFound(res.ok ? body.bills ?? [] : []);
        setFindError(res.ok ? '' : body.error || `Couldn't search the bills (${res.status}).`);
      } catch {
        setFindError("Couldn't reach FleetSuite to search the bills.");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [find, billId, allowed]);

  const bill = data?.bill;
  const accounts = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.id, a])), [data]);

  // Only what was changed goes: a box left as the bill has it isn't sent.
  const header: BillHeaderEdit = {};
  const lineEdits: BillLineEdit[] = [];
  if (bill) {
    if (numberText !== bill.number) header.number = numberText;
    if (dateText !== (bill.date ?? '')) header.date = dateText;
    if (dueText !== (bill.dueDate ?? '')) header.dueDate = dueText;
    if (memoText !== bill.memo) header.memo = memoText;
    for (const l of bill.lines) {
      const b = boxes[keyOf(l)];
      if (!b) continue;
      const start = startingBox(l);
      const e: BillLineEdit = { list: l.list, line: l.line };
      if (b.removed) e.remove = true;
      else {
        if (l.kind === 'expense' && b.accountId !== start.accountId) e.accountId = b.accountId;
        if (l.kind === 'expense' && b.amountText !== start.amountText) e.amount = typed(b.amountText);
        if (l.kind === 'quantity' && b.quantityText !== start.quantityText) e.quantity = typed(b.quantityText);
        if (l.kind === 'quantity' && b.rateText !== start.rateText) e.rate = typed(b.rateText);
        if ((l.kind === 'expense' || l.kind === 'quantity') && b.description !== start.description) e.description = b.description;
      }
      if (Object.keys(e).length > 2) lineEdits.push(e);
    }
  }
  const newLines: BillNewLine[] = added.map((a) => ({
    accountId: a.accountId, amount: typed(a.amountText), ...(a.memo.trim() ? { memo: a.memo } : {}),
  }));
  const plan = useMemo(
    () => (data
      ? planBillFix(data.bill, { reason, header, lines: lineEdits, add: newLines }, {
        allows: data.allows, accounts, termsDays: data.termsDays,
      })
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- header, lineEdits and newLines derive from the boxes
    [data, numberText, dateText, dueText, memoText, boxes, added, accounts, reason],
  );
  const started = Object.keys(header).length > 0 || lineEdits.length > 0 || added.length > 0;

  const patch = (key: string, p: Partial<Box>) => setBoxes((prev) => ({ ...prev, [key]: { ...prev[key], ...p } }));
  const putBack = (l: BillFixLine) => setBoxes((prev) => ({ ...prev, [keyOf(l)]: startingBox(l) }));
  const startOver = () => {
    if (!bill) return;
    setNumberText(bill.number);
    setDateText(bill.date ?? '');
    setDueText(bill.dueDate ?? '');
    setMemoText(bill.memo);
    setBoxes(Object.fromEntries(bill.lines.map((l) => [keyOf(l), startingBox(l)])));
    setAdded([]);
  };
  const addLine = () => {
    setAdded((prev) => [...prev, { key: nextKey, accountId: '', amountText: '', memo: '' }]);
    setNextKey((k) => k + 1);
  };
  const patchAdded = (key: number, p: Partial<Added>) => setAdded((prev) => prev.map((a) => (a.key === key ? { ...a, ...p } : a)));

  const send = async () => {
    if (!data || !bill || !plan || plan.problems.length > 0 || !data.switchedOn) return;
    const n = plan.changes.length;
    const totals = plan.fixed.totalCents !== null && bill.totalCents !== null && plan.fixed.totalCents !== bill.totalCents
      ? ` Its total goes from ${formatCents(bill.totalCents)} to ${formatCents(plan.fixed.totalCents)}.`
      : '';
    const ok = await dialog.confirm(
      `Fix ${billName(bill)} from ${bill.vendorName || 'the vendor'} in NetSuite? ${n === 1 ? 'One change' : `${n} changes`}.${totals}`,
      { confirmLabel: 'Fix bill', title: 'Fix bill' },
    );
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    setReloadNeeded(false);
    try {
      const res = await apiFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, billId: bill.id, signature: data.signature, reason, header, lines: lineEdits, add: newLines }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        if (body.stale || body.unsure) setReloadNeeded(true);
        throw new Error(body.error || `NetSuite didn't take the fix (${res.status}).`);
      }
      setDone({
        number: body.billNumber || plan.fixed.number,
        changes: Array.isArray(body.changes) ? body.changes : plan.changes,
        totalBeforeCents: body.totalBeforeCents ?? bill.totalCents,
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

  if (!authLoading && (!hasFeature('parts_ordering') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Parts Ordering permission and price access to fix bills.</div>;
  }

  const back = () => router.push('/more');
  const allows = data?.allows;
  const linesOpen = !!allows?.lines;
  const fixedLine = (l: BillFixLine) => plan?.fixed.lines.find((x) => x.list === l.list && x.line === l.line);
  const accountOptions = (current: string) => (
    <>
      <option value="">Pick the account</option>
      {current && !accounts.has(current) && <option value={current}>{bill?.lines.find((l) => l.accountId === current)?.accountName || `Account ${current}`}</option>}
      {(data?.accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
    </>
  );

  return (
    <div style={{ maxWidth: '820px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!done && bill && plan && allows?.header && (
        <TopSaveBar
          title="Fix bill"
          subtitle={`${bill.number || bill.id} · ${bill.vendorName}`}
          error={error || undefined}
          onSave={send}
          saving={submitting}
          disabled={!data?.switchedOn || plan.problems.length > 0}
          saveLabel={data?.switchedOn ? 'Fix bill' : 'Switched off'}
          savingLabel="Fixing bill…"
          onCancel={back}
        />
      )}
      <div>
        <button onClick={back} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>← More</button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Fix a bill</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>Changed in NetSuite as you fix it here, and in Books&apos; own copy.</div>
      </div>

      {data?.offText && !done && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {!/^\d+$/.test(billId) ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div>
            <label style={label} htmlFor="bf-find">Find the bill</label>
            <input id="bf-find" style={input} value={find} autoComplete="off" placeholder="The vendor's bill number, or the vendor"
              onChange={(e) => setFind(e.target.value)} />
          </div>
          {findError && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{findError}</div>}
          {found === null && !findError && <div style={muted}>Reading the bills…</div>}
          {found && found.length === 0 && !findError && <div style={muted}>No bill in the copy of NetSuite&apos;s bills matches that.</div>}
          {found && found.map((f) => (
            <button key={f.id} type="button" onClick={() => router.push(deepLinks.billFix(f.id))} style={{
              display: 'grid', gap: '2px', textAlign: 'left', padding: '10px', borderRadius: '10px', border: `1px solid ${theme.border}`,
              background: theme.card, color: theme.textPrimary, cursor: 'pointer', fontFamily: 'inherit',
            }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                <b>{f.number || `NetSuite bill ${f.id}`}</b>
                <span style={{ ...num, fontWeight: 800 }}>{formatCents(f.totalCents)}</span>
              </span>
              <span style={muted}>{[f.vendorName, day(f.date), f.voided ? 'Voided' : ''].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
          <div style={muted}>The copy of NetSuite&apos;s bills catches up every two hours; the bill opens as NetSuite has it now.</div>
        </div>
      ) : loading ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Reading the bill from NetSuite…</div>
      ) : loadError || !bill || !plan || !allows ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{loadError || "Couldn't read the bill from NetSuite."}</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={load} style={btn}>Try again</button>
            <button onClick={() => router.push(deepLinks.billFix())} style={btn}>Find another bill</button>
          </div>
        </div>
      ) : done ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: theme.success }}>
            Bill {done.number || bill.id} {done.already ? 'was already fixed' : 'fixed in NetSuite'}
          </div>
          <div style={{ display: 'grid', gap: '2px', fontSize: '14px', color: theme.textPrimary }}>
            {done.changes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <div style={{ fontSize: '14px', color: theme.textPrimary }}>
            {done.totalAfterCents === null
              ? "Reload the bill to see NetSuite's total."
              : done.totalAfterCents === done.totalBeforeCents
                ? `Its total is still ${formatCents(done.totalAfterCents)}.`
                : `NetSuite's total is now ${formatCents(done.totalAfterCents)}, from ${formatCents(done.totalBeforeCents ?? 0)}.`}
          </div>
          {done.ownCopy === 'fixed' && <div style={muted}>Books&apos; own copy of it changed too, and keeps the one before.</div>}
          {done.ownCopy === 'none' && <div style={muted}>Books has no copy of its own of this bill, so only NetSuite&apos;s changed.</div>}
          {done.warning && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{done.warning}</div>}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={load} style={btn}>Fix something else on it</button>
            <button onClick={() => router.push(deepLinks.billFix())} style={btn}>Find another bill</button>
            <button onClick={back} style={btn}>Back to More</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline' }}>
              <div style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>Bill {bill.number || bill.id}</div>
              <div style={{ ...num, fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>
                {bill.totalCents === null ? '' : formatCents(bill.totalCents)}
              </div>
            </div>
            <div style={{ fontSize: '14px', color: theme.textPrimary }}>{bill.vendorName}</div>
            <div style={muted}>
              {[day(bill.date), bill.termsName || '', bill.poNumber ? `Billed off ${bill.poNumber}` : '',
                bill.owedCents === null ? '' : bill.owedCents > 0 ? `${formatCents(bill.owedCents)} still owed` : 'Paid',
              ].filter(Boolean).join(' · ')}
            </div>
            {allows.why && (
              <div style={{ fontSize: '13px', color: allows.header ? theme.warning : theme.error, fontWeight: 700 }}>{allows.why}</div>
            )}
          </div>

          {allows.header && (
            <>
              <div style={{ ...card, display: 'grid', gap: '10px' }}>
                <div style={heading}>The bill</div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ width: '210px' }}>
                    <label style={label} htmlFor="bf-number">Vendor&apos;s bill number</label>
                    <input id="bf-number" style={input} value={numberText} maxLength={BILL_NUMBER_MAX} autoComplete="off"
                      onChange={(e) => setNumberText(e.target.value)} />
                  </div>
                  <div style={{ width: '170px' }}>
                    <label style={label} htmlFor="bf-date">Date</label>
                    <input id="bf-date" type="date" style={input} value={dateText} disabled={!linesOpen}
                      onChange={(e) => setDateText(e.target.value)} />
                  </div>
                  <div style={{ width: '170px' }}>
                    <label style={label} htmlFor="bf-due">Due</label>
                    <input id="bf-due" type="date" style={input} value={dueText} onChange={(e) => setDueText(e.target.value)} />
                    {dueText === (bill.dueDate ?? '') && plan.fixed.dueDate !== bill.dueDate && (
                      <div style={{ ...muted, marginTop: '3px' }}>Moves to {dayText(plan.fixed.dueDate)} with the date</div>
                    )}
                  </div>
                </div>
                <div>
                  <label style={label} htmlFor="bf-memo">Memo</label>
                  <textarea id="bf-memo" style={{ ...input, minHeight: '44px', resize: 'vertical' }} rows={2} value={memoText}
                    maxLength={MEMO_MAX} onChange={(e) => setMemoText(e.target.value)} />
                </div>
              </div>

              <div style={{ ...card, display: 'grid', gap: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <div style={heading}>Lines</div>
                  {started && <button onClick={startOver} style={small}>Start over</button>}
                </div>
                {bill.lines.map((l) => {
                  const key = keyOf(l);
                  const b = boxes[key];
                  if (!b) return null;
                  const name = lineName(l);
                  const f = fixedLine(l);
                  const changed = f?.state === 'changed';
                  if (l.kind === 'layout') {
                    return (
                      <div key={key} style={{ padding: '6px 10px', borderRadius: '8px', background: theme.inputBg, ...muted }}>
                        {name}{l.description ? ` · ${l.description}` : ''} · lays the bill out
                      </div>
                    );
                  }
                  if (b.removed) {
                    return (
                      <div key={key} style={{
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
                  const billed = l.kind === 'quantity'
                    ? `${quantityText(l.quantity)} × ${l.rate !== null ? priceText(l.rate) : '…'} = ${formatCents(l.cents)}`
                    : l.kind === 'expense'
                      ? 'Expense'
                      : `${formatCents(l.cents)} · FleetSuite only takes this line off, it doesn't change it`;
                  return (
                    <div key={key} style={{
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
                        <div style={muted}>{billed}{l.orderId && bill.poNumber ? ` · billed off ${bill.poNumber}` : l.orderId ? ' · billed off a purchase order' : ''}</div>
                      </div>
                      {linesOpen && (
                        <>
                          {l.kind === 'expense' && (
                            <div>
                              <label style={label} htmlFor={`bf-acct-${key}`}>Account</label>
                              <select id={`bf-acct-${key}`} style={input} value={b.accountId} onChange={(e) => patch(key, { accountId: e.target.value })}>
                                {accountOptions(b.accountId)}
                              </select>
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                            {l.kind === 'expense' && (
                              <div style={{ width: '140px' }}>
                                <label style={label} htmlFor={`bf-amt-${key}`}>Amount $</label>
                                <input id={`bf-amt-${key}`} style={{ ...input, ...num }} inputMode="decimal" value={b.amountText}
                                  onChange={(e) => patch(key, { amountText: e.target.value })} />
                              </div>
                            )}
                            {l.kind === 'quantity' && (
                              <>
                                <div style={{ width: '90px' }}>
                                  <label style={label} htmlFor={`bf-q-${key}`}>Qty</label>
                                  <input id={`bf-q-${key}`} style={{ ...input, ...num }} inputMode="decimal" value={b.quantityText}
                                    onChange={(e) => patch(key, { quantityText: e.target.value })} />
                                </div>
                                <div style={{ width: '130px' }}>
                                  <label style={label} htmlFor={`bf-r-${key}`}>Rate $</label>
                                  <input id={`bf-r-${key}`} style={{ ...input, ...num }} inputMode="decimal" value={b.rateText}
                                    onChange={(e) => patch(key, { rateText: e.target.value })} />
                                </div>
                              </>
                            )}
                            {(l.kind === 'expense' || l.kind === 'quantity') && !b.describing && (
                              <button onClick={() => patch(key, { describing: true })} style={small}>{l.kind === 'expense' ? 'Memo' : 'Description'}</button>
                            )}
                            <button onClick={() => patch(key, { removed: true })}
                              style={{ ...small, marginLeft: 'auto', color: theme.error, borderColor: theme.errorBorder }}>Take off</button>
                          </div>
                          {b.describing && (
                            <div>
                              <label style={label} htmlFor={`bf-d-${key}`}>{l.kind === 'expense' ? 'Memo' : 'Description'}</label>
                              <textarea id={`bf-d-${key}`} style={{ ...input, minHeight: '44px', resize: 'vertical' }} rows={2}
                                value={b.description} maxLength={DESCRIPTION_MAX} onChange={(e) => patch(key, { description: e.target.value })} />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}

                {added.map((a) => {
                  const amount = typed(a.amountText);
                  return (
                    <div key={a.key} style={{ border: `1px solid ${theme.successBorder}`, borderRadius: '10px', padding: '10px', display: 'grid', gap: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                        <span style={{ fontWeight: 800, color: theme.textPrimary }}>Expense line <span style={{ ...muted, fontWeight: 700 }}>· Adding</span></span>
                        <span style={{ ...num, fontWeight: 800, color: theme.success }}>{Number.isFinite(amount) && amount > 0 ? formatCents(Math.round(amount * 100)) : ''}</span>
                      </div>
                      <div>
                        <label style={label} htmlFor={`bf-aa-${a.key}`}>Account</label>
                        <select id={`bf-aa-${a.key}`} style={input} value={a.accountId} onChange={(e) => patchAdded(a.key, { accountId: e.target.value })}>
                          {accountOptions('')}
                        </select>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <div style={{ width: '140px' }}>
                          <label style={label} htmlFor={`bf-am-${a.key}`}>Amount $</label>
                          <input id={`bf-am-${a.key}`} style={{ ...input, ...num }} inputMode="decimal" value={a.amountText}
                            onChange={(e) => patchAdded(a.key, { amountText: e.target.value })} />
                        </div>
                        <div style={{ flex: 1, minWidth: '160px' }}>
                          <label style={label} htmlFor={`bf-ao-${a.key}`}>Memo</label>
                          <input id={`bf-ao-${a.key}`} style={input} value={a.memo} maxLength={DESCRIPTION_MAX} placeholder="Freight, fuel charge…"
                            onChange={(e) => patchAdded(a.key, { memo: e.target.value })} />
                        </div>
                        <button onClick={() => setAdded((prev) => prev.filter((x) => x.key !== a.key))}
                          style={{ ...small, color: theme.error, borderColor: theme.errorBorder }}>Remove</button>
                      </div>
                    </div>
                  );
                })}

                {linesOpen && added.length < MAX_ADDED && (
                  <div><button onClick={addLine} style={small}>+ Expense line</button></div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', ...muted }}>
                  <span>To undo all of it, make a vendor credit for all of it.</span>
                  <button onClick={() => router.push(deepLinks.vendorCreditForBill(bill.id))} style={small}>Credit all of it</button>
                </div>
              </div>

              <div style={{ ...card, display: 'grid', gap: '4px' }}>
                <label style={label} htmlFor="bf-reason">Why it&apos;s being fixed</label>
                <input id="bf-reason" style={input} value={reason} maxLength={REASON_MAX} placeholder="Typed the number wrong, wrong account, billed two not three…"
                  onChange={(e) => setReason(e.target.value)} />
                <div style={muted}>Kept with the fix in FleetSuite, for whoever looks at the bill next.</div>
              </div>

              <div style={{ ...card, display: 'grid', gap: '6px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', columnGap: '16px', rowGap: '4px', fontSize: '14px', color: theme.textSecondary }}>
                  <span />
                  <span style={{ ...num, ...muted, fontWeight: 700 }}>Now</span>
                  <span style={{ ...num, ...muted, fontWeight: 700 }}>After the fix</span>
                  <span style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>Total</span>
                  <span style={{ ...num, fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>
                    {bill.totalCents === null ? '…' : formatCents(bill.totalCents)}
                  </span>
                  <span style={{ ...num, fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>
                    {plan.fixed.totalCents === null ? '…' : formatCents(plan.fixed.totalCents)}
                  </span>
                </div>
                {plan.notes.map((n) => <div key={n} style={muted}>{n}</div>)}
                <div style={muted}>Bills carry no sales tax.</div>
                <div style={muted}>
                  {data.ownCopy
                    ? "Books' own copy of it changes with the fix, and keeps the one before."
                    : "Books has no copy of its own of this bill, so only NetSuite's changes."}
                </div>
              </div>

              {plan.changes.length > 0 && (
                <div style={{ ...card, display: 'grid', gap: '4px' }}>
                  <div style={heading}>What changes</div>
                  {plan.changes.map((c) => <div key={c} style={{ fontSize: '14px', color: theme.textPrimary }}>{c}</div>)}
                </div>
              )}

              {started && plan.problems.length > 0 && (
                <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700, display: 'grid', gap: '2px' }}>
                  {plan.problems.map((p) => <div key={p}>{p}</div>)}
                </div>
              )}
              {error && reloadNeeded && <div><button onClick={load} style={btn}>Reload the bill</button></div>}
            </>
          )}

          {data.fixes.length > 0 && (
            <div style={{ ...card, display: 'grid', gap: '8px' }}>
              <div style={heading}>Fixed before</div>
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
