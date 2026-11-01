'use client';

/**
 * A payment run's checks printed on BMG's check stock, on the Pay Vendors
 * page (Books part 58, docs/books.md "Checks printed on BMG's stock").
 *
 * RunChecks is an approved run's checks. Tick the ones to print and type the
 * number on the first check in the printer: FleetSuite gives them that number
 * and the ones after it, in the run's order, and sets each in NetSuite, taking
 * it off To Be Printed so NetSuite doesn't print it too. Then print them, and
 * say how they came out: printed right, or didn't (jammed, printed crooked),
 * kept with why, and that vendor's check numbered again from the next check in
 * the printer. One printed from NetSuite's Print Checks first keeps NetSuite's
 * number.
 *
 * CheckStockPanel lines the print up with the stock, a bank account at a time:
 * where the check is on the sheet, and how far the print moves, a sixteenth of
 * an inch a press, with a test page to hold against a sheet of the stock.
 *
 * The rules are src/lib/check-printing.ts, the PDF src/lib/check-pdf.ts, and
 * /api/pay-vendors/checks numbers them.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { openChecksPdf } from '@/lib/check-pdf';
import {
  CHECK_POSITIONS, DEFAULT_LAYOUT, NUDGE_MAX, SPOILED_REASON_MAX, checkNumbersText, formatCents, layoutText, numberingProblems, nudgeText,
  stockText, type CheckLayout, type CheckPosition, type PrintedCheck,
} from '@/lib/check-printing';

const API = '/api/pay-vendors/checks';

/** A press that got no answer back. */
const NO_ANSWER = "FleetSuite didn't hear back, so it may have been done: reload in a minute to see.";

const card: CSSProperties = {
  background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px',
};
const box: CSSProperties = { border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '12px' };
const label: CSSProperties = {
  display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
  color: theme.textMuted, marginBottom: '3px',
};
const input: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '7px',
  border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '15px',
};
const btn: CSSProperties = {
  padding: '9px 14px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.card,
  color: theme.textPrimary, fontSize: '14px', fontWeight: 700, cursor: 'pointer',
};
const green: CSSProperties = { ...btn, background: theme.successBg, borderColor: theme.successBorder, color: theme.success };
const small: CSSProperties = { ...btn, padding: '5px 10px', fontSize: '12px' };
const redSmall: CSSProperties = { ...small, color: theme.error, borderColor: theme.errorBorder };
const off: CSSProperties = { opacity: 0.6, cursor: 'default' };
const num: CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const muted: CSSProperties = { fontSize: '12px', color: theme.textMuted };
const heading: CSSProperties = { fontSize: '15px', fontWeight: 800, color: theme.textPrimary };
const red: CSSProperties = { fontSize: '13px', color: theme.error, fontWeight: 700 };
const pressed = (on: boolean): CSSProperties => ({
  ...small, borderColor: on ? theme.successBorder : theme.border, background: on ? theme.successBg : theme.card, color: on ? theme.success : theme.textPrimary,
});

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

async function post(payload: Record<string, unknown>) {
  const res = await apiFetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !!body.success, status: res.status, body };
}

type LiveStatus = 'numbering' | 'numbered' | 'printed' | 'printed_in_netsuite';

/** A vendor the run pays by check, and the check it has (GET /api/pay-vendors/checks?run=). */
interface RunCheck {
  paymentId: string;
  position: number;
  vendorName: string;
  totalCents: number;
  paymentStatus: string;
  check: {
    id: string;
    number: number;
    status: LiveStatus;
    error: string | null;
    /** Being set in NetSuite long enough that NetSuite took the number or never will. */
    stale: boolean;
    printedBy: string | null;
    printedAt: string | null;
    /** What's printed on it, while it's numbered and not marked printed. */
    printed: PrintedCheck | null;
  } | null;
  spoiled: Array<{ id: string; number: number; reason: string | null; by: string | null; at: string | null }>;
}

interface ChecksLoaded {
  run: { id: string; company: string; accountId: string; accountName: string | null; status: string };
  layout: CheckLayout;
  nextNumber: number | null;
  checks: RunCheck[];
  switchedOn: boolean;
}

/** What numbering answered (POST action 'number'). */
interface NumberAnswer {
  success?: boolean;
  error?: string;
  numbered?: Array<{ id: string; paymentId: string; number: number }>;
  skipped?: Array<{ paymentId: string; vendorName: string; why: string }>;
  inNetSuite?: Array<{ paymentId: string; vendorName: string; number: number }>;
  stopped?: { paymentId: string; vendorName: string; number: number; why: string; unsure: boolean } | null;
  warnings?: string[];
}

interface Said { text: string; notes?: string[]; warnings?: string[] }

const STATUS: Record<LiveStatus, (k: NonNullable<RunCheck['check']>) => { text: string; color: string }> = {
  numbering: (k) => ({ text: `Check ${k.number}: being set in NetSuite`, color: theme.warning }),
  numbered: (k) => ({ text: `Check ${k.number}: to print`, color: theme.warning }),
  printed: (k) => ({ text: `Check ${k.number}: printed${k.printedBy ? ` by ${k.printedBy}` : ''}${k.printedAt ? ` ${when(k.printedAt)}` : ''}`, color: theme.success }),
  printed_in_netsuite: (k) => ({ text: `Check ${k.number}: printed from NetSuite`, color: theme.success }),
};

function statusOf(c: RunCheck): { text: string; color: string } {
  if (c.check) return STATUS[c.check.status](c.check);
  if (c.paymentStatus === 'made') return { text: 'To print', color: theme.textMuted };
  if (c.paymentStatus === 'dropped') return { text: 'Dropped from the run', color: theme.textMuted };
  return { text: 'Prints once its bill payment is made in NetSuite', color: theme.textMuted };
}

/** An approved run's checks: numbered from the stock in the printer, printed, and how each came out. */
export function RunChecks({ runId, madeKey }: { runId: string; madeKey: string }) {
  const dialog = useDialog();
  const [loaded, setLoaded] = useState<ChecksLoaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Every check that can be numbered starts ticked.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  // The first number as typed; null shows the one FleetSuite suggests.
  const [first, setFirst] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [done, setDone] = useState<Said | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [lining, setLining] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`${API}?run=${encodeURIComponent(runId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the run's checks (${res.status}).`);
      setLoaded(body as ChecksLoaded);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the run's checks.");
    }
  }, [runId]);

  // Again whenever the run's bill payments change: a check prints once its bill payment is made.
  useEffect(() => { load(); }, [load, madeKey]);

  const clearSaid = () => { setDone(null); setError(null); setProblems([]); };

  const rows = loaded?.checks ?? [];
  const on = !!loaded?.switchedOn;
  const tickable = rows.filter((c) => !c.check && c.paymentStatus === 'made');
  const ticked = tickable.filter((c) => !unticked.has(c.paymentId));
  const firstText = first ?? (loaded?.nextNumber ? String(loaded.nextNumber) : '');
  const firstNumber = /^\d{1,8}$/.test(firstText) ? Number(firstText) : NaN;
  const range = Number.isInteger(firstNumber) && firstNumber > 0 ? ticked.map((_, i) => firstNumber + i) : [];
  // Numbered and not marked printed, in number order: the order the stock prints them.
  const toPrint = rows.flatMap((c) => (c.check?.status === 'numbered' ? [{ row: c, check: c.check }] : []))
    .sort((a, b) => a.check.number - b.check.number);
  const printable = toPrint.flatMap((t) => (t.check.printed ? [t.check.printed] : []));
  const unprintable = toPrint.filter((t) => !t.check.printed).map((t) => t.check.number);

  const tick = (id: string) => setUnticked((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const numberThem = async () => {
    if (!loaded || busy) return;
    const ids = ticked.map((c) => c.paymentId);
    const why = numberingProblems(firstNumber, ids.length, new Set());
    if (why.length > 0) { setError(why[0]); setDone(null); return; }
    clearSaid();
    setBusy('number');
    setProgress(`Numbering ${checkNumbersText(range)} and setting each in NetSuite…`);
    try {
      const res = await apiFetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'number', runId, first: firstNumber, paymentIds: ids }),
      });
      const answer = (await res.json().catch(() => ({}))) as NumberAnswer;
      const lines = [
        ...(answer.skipped ?? []).map((s) => `${s.vendorName}: ${s.why}`),
        ...(answer.stopped ? [`${answer.stopped.vendorName}, check ${answer.stopped.number}: ${answer.stopped.why}`] : []),
      ];
      const notes = (answer.inNetSuite ?? []).map((c) => `${c.vendorName}'s check was printed from NetSuite already, as check ${c.number}.`);
      if (!res.ok || !answer.success) {
        setError(answer.error || `Nothing was numbered (${res.status}).`);
        setProblems(lines);
        if (notes.length > 0) setDone({ text: notes.join(' ') });
      } else {
        const numbers = (answer.numbered ?? []).map((n) => n.number);
        setDone({
          text: numbers.length > 0
            ? `${upper(checkNumbersText(numbers))} numbered and set in NetSuite: print ${numbers.length === 1 ? 'it' : 'them'} now.`
            : 'No check was numbered.',
          notes,
          warnings: answer.warnings ?? [],
        });
        setProblems(lines);
        setFirst(null);
      }
    } catch {
      setError("FleetSuite didn't hear back about numbering them, so some may be numbered: reload in a few minutes to see which.");
    } finally {
      setProgress(null);
      setBusy(null);
      await load();
    }
  };

  /** Shows the checks to print in the tab the press opens, in number order, laid out the bank account's way. */
  const print = () => {
    if (!loaded || printable.length === 0) return;
    const made = openChecksPdf(window.open('about:blank', '_blank'), printable, loaded.layout);
    if (!made.ok) setError(made.error || "Couldn't make the checks.");
  };

  const markPrinted = async (checks: Array<{ id: string; number: number }>) => {
    if (busy || checks.length === 0) return;
    clearSaid();
    setBusy('printed');
    try {
      const { ok, status, body } = await post({ action: 'printed', checkIds: checks.map((c) => c.id) });
      if (!ok) setError(body.error || `They weren't marked printed (${status}).`);
      else setDone({ text: `${upper(checkNumbersText(checks.map((c) => c.number)))} marked printed.` });
    } catch {
      setError(NO_ANSWER);
    } finally {
      setBusy(null);
      await load();
    }
  };

  const spoil = async (c: RunCheck) => {
    const k = c.check;
    if (!k || busy) return;
    const reason = await dialog.prompt(
      `Only while you still have check ${k.number}: it's kept as not printed right, with why, and ${c.vendorName}'s check is numbered again `
        + 'from the next check in the printer. A check that went out is voided in NetSuite instead.',
      '', { title: `Check ${k.number} didn't print right`, confirmLabel: "Didn't print right", placeholder: 'Jammed, printed crooked, torn', multiline: true },
    );
    const why = reason?.trim();
    if (!why) return;
    if (why.length > SPOILED_REASON_MAX) { setError(`Say why in ${SPOILED_REASON_MAX} characters or fewer.`); setDone(null); return; }
    clearSaid();
    setBusy(`spoil-${k.id}`);
    try {
      const { ok, status, body } = await post({ action: 'spoiled', checkId: k.id, reason: why });
      if (!ok) setError(body.error || `It wasn't marked (${status}).`);
      else setDone({ text: `Check ${k.number} is kept as not printed right: write VOID across it. ${c.vendorName}'s check is ready to number again.` });
    } catch {
      setError(NO_ANSWER);
    } finally {
      setBusy(null);
      await load();
    }
  };

  const ask = async (c: RunCheck) => {
    const k = c.check;
    if (!k || busy) return;
    clearSaid();
    setBusy(`ask-${k.id}`);
    try {
      const { ok, status, body } = await post({ action: 'ask', checkId: k.id });
      if (!ok) setError(body.error || `NetSuite wasn't asked (${status}).`);
      else if (body.numbered) setDone({ text: `NetSuite has check ${k.number} on ${c.vendorName}'s bill payment: print it now.` });
      else setDone({ text: `Check ${k.number} isn't being set in NetSuite any more.` });
    } catch {
      setError(NO_ANSWER);
    } finally {
      setBusy(null);
      await load();
    }
  };

  if (!loaded) {
    return (
      <div style={{ ...card, display: 'grid', gap: '8px' }}>
        <div style={heading}>Checks</div>
        {loadError ? (
          <>
            <div style={red}>{loadError}</div>
            <div><button type="button" onClick={load} style={small}>Try again</button></div>
          </>
        ) : <div style={muted}>Reading the run&apos;s checks…</div>}
      </div>
    );
  }

  const idle = busy === null;
  const row = (c: RunCheck) => {
    const k = c.check;
    const canTick = !k && c.paymentStatus === 'made';
    const status = statusOf(c);
    return (
      <div key={c.paymentId} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '8px', display: 'grid', gap: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', color: theme.textPrimary }}>
          {canTick ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0, cursor: on && idle ? 'pointer' : 'default' }}>
              <input type="checkbox" checked={!unticked.has(c.paymentId)} disabled={!on || !idle} onChange={() => tick(c.paymentId)} />
              <b style={{ minWidth: 0 }}>{c.vendorName}</b>
            </label>
          ) : <b style={{ flex: 1, minWidth: 0 }}>{c.vendorName}</b>}
          <span style={{ ...num, fontWeight: 800 }}>{formatCents(c.totalCents)}</span>
        </div>
        <div style={{ fontSize: '13px', fontWeight: 700, color: status.color }}>{status.text}</div>
        {k?.status === 'numbering' && k.error && <div style={red}>NetSuite didn&apos;t say whether it took check {k.number}: {k.error}</div>}
        {k?.status === 'numbered' && !k.printed && (
          <div style={red}>FleetSuite can&apos;t print check {k.number} again: mark it as not printed right, and number it again.</div>
        )}
        {on && k && (k.status === 'numbered' || k.status === 'printed' || (k.status === 'numbering' && (k.stale || !!k.error))) && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {k.status === 'numbering' && (
              <button type="button" onClick={() => ask(c)} disabled={!idle} style={{ ...small, ...(!idle ? off : {}) }}>
                {busy === `ask-${k.id}` ? 'Asking…' : 'Ask NetSuite'}
              </button>
            )}
            {k.status === 'numbered' && (
              <button type="button" onClick={() => markPrinted([k])} disabled={!idle} style={{ ...small, ...(!idle ? off : {}) }}>
                Printed right
              </button>
            )}
            {(k.status === 'numbered' || k.status === 'printed') && (
              <button type="button" onClick={() => spoil(c)} disabled={!idle} style={{ ...redSmall, ...(!idle ? off : {}) }}>
                {busy === `spoil-${k.id}` ? 'Marking…' : "Didn't print right"}
              </button>
            )}
          </div>
        )}
        {c.spoiled.map((s) => (
          <div key={s.id} style={muted}>
            Check {s.number} didn&apos;t print right{s.reason ? `: ${s.reason}` : ''}{s.by ? ` · ${s.by}` : ''}{s.at ? ` ${when(s.at)}` : ''}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ ...card, display: 'grid', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={heading}>Checks</div>
          <div style={muted}>{layoutText(loaded.layout)}</div>
        </div>
        <button type="button" onClick={() => setLining((v) => !v)} aria-expanded={lining} style={small}>
          {lining ? 'Done lining up' : 'Line up the stock'}
        </button>
      </div>
      {lining && (
        <CheckStockPanel company={loaded.run.company} accountId={loaded.run.accountId}
          onSaved={(layout) => setLoaded((d) => (d ? { ...d, layout } : d))} />
      )}
      {loadError && <div style={red}>{loadError}</div>}
      {rows.map(row)}

      {toPrint.length > 0 && (
        <div style={{ ...box, borderColor: theme.warningBorder, background: theme.warningBg, display: 'grid', gap: '8px' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary }}>
            {printable.length > 0 ? `${upper(checkNumbersText(printable.map((p) => p.number)))} to print. ${stockText(printable.map((p) => p.number))}` : 'Nothing to print.'}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {printable.length > 0 && (
              <button type="button" onClick={print} disabled={!idle} style={{ ...green, ...(!idle ? off : {}) }}>
                Print {checkNumbersText(printable.map((p) => p.number))}
              </button>
            )}
            {on && (
              <button type="button" onClick={() => markPrinted(toPrint.map((t) => t.check))} disabled={!idle} style={{ ...btn, ...(!idle ? off : {}) }}>
                {busy === 'printed' ? 'Marking…' : toPrint.length === 1 ? 'It printed right' : 'All printed right'}
              </button>
            )}
          </div>
          {unprintable.length > 0 && <div style={red}>FleetSuite can&apos;t print {checkNumbersText(unprintable)} again.</div>}
          <div style={muted}>Print at actual size, not fit to page. Then say how they came out: one that jammed or printed crooked didn&apos;t print right.</div>
        </div>
      )}

      {tickable.length > 0 && (
        <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '10px', display: 'grid', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '0 1 240px' }}>
              <label style={label} htmlFor="checks-first">Number on the first check in the printer</label>
              <input id="checks-first" inputMode="numeric" autoComplete="off" style={input} value={firstText} disabled={!on || !idle}
                onChange={(e) => { setFirst(e.target.value.replace(/\D/g, '').slice(0, 8)); setError(null); }} />
            </div>
            <button type="button" onClick={numberThem} disabled={!on || !idle || ticked.length === 0}
              style={{ ...green, ...(!on || !idle || ticked.length === 0 ? off : {}) }}>
              {busy === 'number' ? 'Numbering…' : ticked.length === 0 ? 'Tick the checks to number' : `Number ${plural(ticked.length, 'check')}`}
            </button>
          </div>
          <div style={muted}>
            {range.length > 0
              ? `The ticked ${ticked.length === 1 ? 'check gets' : 'checks get'} ${checkNumbersText(range)}, in the order above. Each number is set in NetSuite, so NetSuite doesn't print it too.`
              : 'Type the number printed on the first check in the printer.'}
          </div>
        </div>
      )}

      {progress && <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{progress}</div>}
      {done && (
        <div style={{ display: 'grid', gap: '4px' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: theme.success }}>{done.text}</div>
          {(done.notes ?? []).map((n, i) => <div key={`n${i}`} style={{ fontSize: '13px', color: theme.textPrimary }}>{n}</div>)}
          {(done.warnings ?? []).map((w, i) => <div key={`w${i}`} style={red}>{w}</div>)}
        </div>
      )}
      {(error || problems.length > 0) && (
        <div style={{ display: 'grid', gap: '2px' }}>
          {error && <div style={red}>{error}</div>}
          {problems.map((p, i) => <div key={`${i}-${p}`} style={red}>{p}</div>)}
        </div>
      )}
      {!on && <div style={muted}>Numbering and printing checks is switched off until paying vendors is switched on.</div>}
    </div>
  );
}

/** A bank account and where its checks print (GET /api/pay-vendors/checks?company=). */
interface StockAccount { netsuiteId: string; name: string; layout: CheckLayout }

/**
 * Where checks print on the stock, a bank account at a time: the check's part of the sheet, and the print moved right
 * or left and down or up, with a test page printed the way it's set, saved or not. `accountId` keeps it to one.
 */
export function CheckStockPanel({ company, accountId: only, onSaved }: {
  company: string;
  accountId?: string;
  onSaved?: (layout: CheckLayout) => void;
}) {
  const [accounts, setAccounts] = useState<StockAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState(only ?? '');
  // What's set and not saved, by bank account.
  const [drafts, setDrafts] = useState<Record<string, CheckLayout>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`${API}?company=${encodeURIComponent(company)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the bank accounts (${res.status}).`);
      const list = (body.accounts ?? []) as StockAccount[];
      setAccounts(list);
      setPicked((p) => p || (list.length === 1 ? list[0].netsuiteId : ''));
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the bank accounts.");
    }
  }, [company]);
  useEffect(() => { load(); }, [load]);

  const account = accounts?.find((a) => a.netsuiteId === picked) ?? null;
  const saved = account?.layout ?? DEFAULT_LAYOUT;
  const layout = (picked && drafts[picked]) || saved;
  const changed = !!account && (layout.position !== saved.position || layout.right !== saved.right || layout.down !== saved.down);

  const set = (p: Partial<CheckLayout>) => {
    if (!picked) return;
    setDrafts((d) => ({ ...d, [picked]: { ...layout, ...p } }));
    setError(null);
    setDone(null);
  };
  const move = (way: 'right' | 'down', by: number) => set({ [way]: Math.max(-NUDGE_MAX, Math.min(NUDGE_MAX, layout[way] + by)) });
  const undo = () => {
    setDrafts(({ [picked]: _dropped, ...rest }) => rest);
    setError(null);
  };

  /** The made-up check, laid out as it's set now, in the tab the press opens. */
  const test = () => {
    const made = openChecksPdf(window.open('about:blank', '_blank'), [], layout, { test: true });
    if (!made.ok) setError(made.error || "Couldn't make the test page.");
  };

  const save = async () => {
    if (!account || saving) return;
    setSaving(true);
    setError(null);
    setDone(null);
    try {
      const { ok, status, body } = await post({ action: 'layout', company, accountId: account.netsuiteId, ...layout });
      if (!ok) throw new Error(body.error || `It wasn't saved (${status}).`);
      const kept = body.layout as CheckLayout;
      setAccounts((list) => list?.map((a) => (a.netsuiteId === account.netsuiteId ? { ...a, layout: kept } : a)) ?? list);
      setDrafts(({ [account.netsuiteId]: _saved, ...rest }) => rest);
      setDone(`Saved: checks drawn on ${account.name} print this way.`);
      onSaved?.(kept);
    } catch (e: any) {
      setError(e?.message || "It wasn't saved.");
    } finally {
      setSaving(false);
    }
  };

  const nudgeRow = (way: 'right' | 'down') => {
    const v = layout[way];
    const [less, more] = way === 'right' ? ['← Left', 'Right →'] : ['↑ Up', 'Down ↓'];
    const text = v === 0 ? `Not moved ${way === 'right' ? 'right or left' : 'up or down'}` : upper(nudgeText(way === 'right' ? { right: v, down: 0 } : { right: 0, down: v }));
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button type="button" onClick={() => move(way, -1)} disabled={v <= -NUDGE_MAX} style={{ ...small, minWidth: '78px', ...(v <= -NUDGE_MAX ? off : {}) }}>{less}</button>
        <span style={{ flex: 1, textAlign: 'center', fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{text}</span>
        <button type="button" onClick={() => move(way, 1)} disabled={v >= NUDGE_MAX} style={{ ...small, minWidth: '78px', ...(v >= NUDGE_MAX ? off : {}) }}>{more}</button>
      </div>
    );
  };

  return (
    <div style={{ ...box, display: 'grid', gap: '10px' }}>
      <div style={muted}>
        Print the test page on plain paper at actual size, hold it against a sheet of the stock up to the light, and move the print until each line sits where it should.
      </div>
      {loadError && <div style={red}>{loadError}</div>}
      {!accounts && !loadError && <div style={muted}>Reading the bank accounts…</div>}
      {accounts && !only && (accounts.length === 0 ? (
        <div style={red}>Books has no bank accounts for this company from NetSuite yet.</div>
      ) : (
        <div>
          <label style={label} htmlFor="stock-account">Bank account</label>
          <select id="stock-account" style={input} value={picked} onChange={(e) => { setPicked(e.target.value); setError(null); setDone(null); }}>
            <option value="">Pick the bank account the checks are drawn on</option>
            {accounts.map((a) => <option key={a.netsuiteId} value={a.netsuiteId}>{a.name}</option>)}
          </select>
        </div>
      ))}
      {accounts && only && !account && <div style={red}>This run&apos;s bank account isn&apos;t one of the company&apos;s bank accounts in Books any more.</div>}
      {account && (
        <>
          <div>
            <div style={label}>Where the check is on the sheet</div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {(Object.keys(CHECK_POSITIONS) as CheckPosition[]).map((p) => (
                <button key={p} type="button" aria-pressed={layout.position === p} onClick={() => set({ position: p })} style={pressed(layout.position === p)}>
                  {CHECK_POSITIONS[p]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={label}>Move the print</div>
            <div style={{ display: 'grid', gap: '6px' }}>
              {nudgeRow('right')}
              {nudgeRow('down')}
            </div>
            <div style={{ ...muted, marginTop: '4px' }}>A sixteenth of an inch a press, an inch at most.</div>
          </div>
          {error && <div style={red}>{error}</div>}
          {done && <div style={{ fontSize: '13px', fontWeight: 700, color: theme.success }}>{done}</div>}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" onClick={test} style={btn}>Print a test page</button>
            {changed && (
              <button type="button" onClick={save} disabled={saving} style={{ ...green, ...(saving ? off : {}) }}>{saving ? 'Saving…' : 'Save'}</button>
            )}
            {changed && <button type="button" onClick={undo} disabled={saving} style={btn}>Undo changes</button>}
          </div>
        </>
      )}
    </div>
  );
}
