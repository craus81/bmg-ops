'use client';

/**
 * Vendors paid in payment runs, asked for approval, and made in NetSuite as
 * bill payments once a super admin who didn't ask approves them (Books part
 * 57, docs/books.md "Vendors paid in FleetSuite"; owner decisions 2026-10-31:
 * making payments moves into FleetSuite during 2027). Opened from More →
 * Money & Books → Pay Vendors.
 *
 * Start a run for BMG or 1084, pick the bank account and the day, tick the
 * bills to pay from what NetSuite has open, vendor by vendor, each by check
 * or ACH, and change what's paid on a bill to pay part of it. Save it, and
 * ask for approval. A super admin who didn't ask approves it, or sends it
 * back with why, and FleetSuite makes each vendor's bill payment in NetSuite,
 * one at a time from this page. A check is made To Be Printed, and prints on
 * BMG's check stock from the run's Checks (Books part 58,
 * src/components/PayVendorChecks.tsx), which number it from the stock in the
 * printer and set the number in NetSuite. The rules are src/lib/pay-vendors.ts,
 * the same ones /api/pay-vendors checks a run by again, against what NetSuite
 * has open, when it's asked for, approved and made. Built switched off (Books →
 * Switches): until it's on, super admins can make and save runs to see what
 * they'd pay, and line up the check stock, and none is asked for approval or
 * sent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import TopSaveBar, { LEAVE_WITHOUT_SAVING } from '@/components/TopSaveBar';
import { CheckStockPanel, RunChecks } from '@/components/PayVendorChecks';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import { parseDollars } from '@/lib/books/typed-dollars';
import {
  AHEAD_DAYS, MAX_BILLS, MEMO_MAX, PAY_METHODS, accountName, billName, byDue, byVendor, formatCents, vendorNameOf, workOutRun,
  type BankAccount, type BillNow, type OpenBill, type PayMethod, type PaymentStatus, type RunBill, type RunPayment, type RunStatus,
} from '@/lib/pay-vendors';

const API = '/api/pay-vendors';

/** A press that got no answer back: it may have made the bill payment, or not. */
const NO_ANSWER = "FleetSuite didn't hear back about this bill payment, so NetSuite may have made it. Reload in a few minutes, and press Ask NetSuite if it's still being made.";

interface RunSummary {
  id: string;
  company: string;
  date: string;
  accountId: string | null;
  accountName: string | null;
  memo: string | null;
  status: RunStatus;
  totalCents: number;
  vendorCount: number;
  billCount: number;
  createdBy: string | null;
  createdById: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  askedBy: string | null;
  askedById: string | null;
  askedAt: string | null;
  returnedBy: string | null;
  returnedAt: string | null;
  returnedReason: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  doneAt: string | null;
}

/** One vendor's payment in an approved run, and what became of it. */
interface MadePayment extends RunPayment {
  id: string;
  position: number;
  totalCents: number;
  status: PaymentStatus;
  sentBy: string | null;
  sentAt: string | null;
  /** Being made long enough that NetSuite made it or never will. */
  stale: boolean;
  billPaymentId: string | null;
  number: string | null;
  error: string | null;
  droppedBy: string | null;
  droppedAt: string | null;
  droppedReason: string | null;
}

interface RunDetail extends RunSummary {
  payments: RunPayment[];
  /** Its bills as NetSuite has them now, while it's a draft or asked for; null when NetSuite couldn't be asked. */
  billsNow: Record<string, BillNow> | null;
  checkError: string | null;
  made: MadePayment[];
}

interface Loaded {
  today: string;
  companies: Array<{ code: string; name: string }>;
  company: string;
  accounts: BankAccount[];
  bills: OpenBill[] | null;
  billsError: string | null;
  held: string[];
  runs: RunSummary[];
  run: RunDetail | null;
  me: string;
  superAdmin: boolean;
  switchedOn: boolean;
  offText: string | null;
}

/** A ticked bill as it's typed: what it pays is text until it's saved. */
type DraftBill = Omit<RunBill, 'cents'> & { amount: string };
interface DraftPayment { vendorId: string; vendorName: string | null; method: PayMethod; bills: DraftBill[] }
/** The run being ticked, new or a draft opened. Its company is the one it was started for, and kept. */
interface Draft { id: string; company: string; accountId: string; date: string; memo: string; payments: DraftPayment[] }

/** A bill the editor lists under its vendor: open in NetSuite now, or ticked in the draft and not open any more. */
type ShownBill = Omit<RunBill, 'cents'> & { open: boolean };

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

const centsText = (c: number) => (c / 100).toFixed(2);
const toDraft = (r: RunDetail): Draft => ({
  id: r.id, company: r.company, accountId: r.accountId ?? '', date: r.date, memo: r.memo ?? '',
  payments: r.payments.map((p) => ({
    vendorId: p.vendorId, vendorName: p.vendorName, method: p.method,
    bills: p.bills.map(({ cents, ...b }) => ({ ...b, amount: centsText(cents) })),
  })),
});
/** What's typed in an amount box, in whole cents; NaN when it isn't an amount. */
const typedCents = (text: string) => parseDollars(text) ?? NaN;
const draftPayments = (d: Draft): RunPayment[] => d.payments.map((p) => ({
  ...p, bills: p.bills.map(({ amount, ...b }) => ({ ...b, cents: typedCents(amount) })),
}));
/** A draft as it'd be saved, to tell whether anything's changed. */
const shape = (d: Draft) => JSON.stringify({ accountId: d.accountId, date: d.date, memo: d.memo.trim(), payments: draftPayments(d) });

const DAY_MS = 86_400_000;
const daysAfter = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const day = (ymd: string | null) => (ymd ? new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
const green: React.CSSProperties = { ...btn, background: theme.successBg, borderColor: theme.successBorder, color: theme.success };
const small: React.CSSProperties = { ...btn, padding: '5px 10px', fontSize: '12px' };
const off: React.CSSProperties = { opacity: 0.6, cursor: 'default' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const muted: React.CSSProperties = { fontSize: '12px', color: theme.textMuted };
const heading: React.CSSProperties = { fontSize: '15px', fontWeight: 800, color: theme.textPrimary };
const red: React.CSSProperties = { fontSize: '13px', color: theme.error, fontWeight: 700 };
/** Two lines at most, so a long memo or reason doesn't push the list off the screen. */
const twoLines: React.CSSProperties = {
  overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};

const STATUS: Record<RunStatus, { text: string; color: string }> = {
  draft: { text: 'Draft', color: theme.textMuted },
  waiting: { text: 'Waiting for approval', color: theme.warning },
  approved: { text: 'Being paid', color: theme.warning },
  done: { text: 'Paid', color: theme.success },
};

const PAYMENT_STATUS: Record<PaymentStatus, { text: string; color: string }> = {
  to_make: { text: 'To make', color: theme.textMuted },
  sending: { text: 'Being made in NetSuite', color: theme.warning },
  made: { text: 'In NetSuite', color: theme.success },
  refused: { text: 'Not made', color: theme.error },
  dropped: { text: 'Dropped', color: theme.textMuted },
};

export default function PayVendorsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { hasFeature, hasRole, canSeeMoney, loading: authLoading } = useAuth();

  const [openId, setOpenId] = useState(() => (searchParams.get('run') || '').trim());
  const [company, setCompany] = useState<string | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The route refused because paying vendors is switched off and this person isn't a super admin.
  const [switchedOff, setSwitchedOff] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<{ text: string; warnings?: string[] } | null>(null);
  const [lining, setLining] = useState(false);

  const allowed = !authLoading && hasFeature('vendor_payments') && canSeeMoney;

  const load = useCallback(async (opts: { company?: string | null; run?: string; bills?: boolean }): Promise<Loaded | null> => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (opts.company) params.set('company', opts.company);
      if (opts.run) params.set('run', opts.run);
      if (opts.bills) params.set('bills', '1');
      const res = await apiFetch(`${API}?${params}`);
      const body = await res.json().catch(() => ({}));
      setSwitchedOff(!res.ok && !!body.switchedOff);
      if (!res.ok) throw new Error(body.error || `Couldn't open the payment runs (${res.status}).`);
      const loaded = body as Loaded;
      setData(loaded);
      setCompany(loaded.company);
      return loaded;
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't open the payment runs.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /** Reads the runs again, with this one open: ticked into when it's a draft. */
  const refresh = useCallback(async (id: string, companyCode?: string | null) => {
    const fresh = await load({ company: companyCode, run: id || undefined });
    setDraft(fresh?.run?.status === 'draft' ? toDraft(fresh.run) : null);
  }, [load]);

  // The run the link opened, once the page can open it.
  const firstId = useRef(openId);
  useEffect(() => { if (allowed) refresh(firstId.current); }, [allowed, refresh]);

  const run = data?.run && data.run.id === openId ? data.run : null;
  const savedDraft = run?.status === 'draft' ? run : null;
  // A new run is worth keeping once something's ticked or typed in it.
  const dirty = !!draft && (savedDraft ? shape(draft) !== shape(toDraft(savedDraft)) : draft.payments.length > 0 || !!draft.memo.trim());
  // Approving, sending back and dropping are a super admin's, as the page is viewed.
  const superAdmin = !!data?.superAdmin && hasRole('super_admin');
  const held = useMemo(() => new Set(data?.held ?? []), [data]);

  /** Every bill as NetSuite has it now, as far as the page knows: the open ones, and the run's own. */
  const nowMap = useMemo(() => {
    const now = new Map<string, BillNow>();
    for (const b of data?.bills ?? []) now.set(b.id, { open: true, openCents: b.openCents, vendorId: b.vendorId });
    for (const [id, b] of Object.entries(data?.run?.billsNow ?? {})) now.set(id, b);
    return now;
  }, [data]);

  const worked = useMemo(() => {
    if (!data) return null;
    const r = draft
      ? { date: draft.date, accountId: draft.accountId, memo: draft.memo, payments: draftPayments(draft) }
      : run && (run.status === 'draft' || run.status === 'waiting') && run.billsNow
        ? { date: run.date, accountId: run.accountId ?? '', memo: run.memo ?? '', payments: run.payments }
        : null;
    return r ? workOutRun(r, nowMap, data.accounts, { today: data.today, held }) : null;
  }, [data, draft, run, nowMap, held]);

  /** The editor's vendors: each with its open bills and the ones ticked in the draft, oldest due first. */
  const groups = useMemo(() => {
    if (!draft) return [];
    const byId = new Map<string, { vendorId: string; vendorName: string | null; bills: Map<string, ShownBill> }>();
    const group = (vendorId: string, vendorName: string | null) => {
      let g = byId.get(vendorId);
      if (!g) byId.set(vendorId, (g = { vendorId, vendorName, bills: new Map() }));
      return g;
    };
    for (const b of data?.bills ?? []) {
      group(b.vendorId, b.vendorName).bills.set(b.id, { billId: b.id, number: b.number, date: b.date, dueDate: b.dueDate, openCents: b.openCents, open: true });
    }
    for (const p of draft.payments) {
      const g = group(p.vendorId, p.vendorName);
      for (const { amount: _amount, ...b } of p.bills) if (!g.bills.has(b.billId)) g.bills.set(b.billId, { ...b, open: false });
    }
    return byVendor([...byId.values()]).map((g) => ({ ...g, bills: byDue([...g.bills.values()]) }));
  }, [draft, data]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => vendorNameOf(g).toLowerCase().includes(q) || g.bills.some((b) => (b.number || '').toLowerCase().includes(q)));
  }, [groups, query]);

  const clearSaid = () => { setError(null); setProblems([]); setDone(null); };

  const go = (id: string) => {
    setOpenId(id);
    router.replace(deepLinks.payVendors(id || null), { scroll: false });
  };

  /** Leaves what's ticked and not saved only when that's what's wanted. */
  const leaveOk = async () => !dirty || dialog.confirm(
    savedDraft ? 'The payment run stays as it was last saved. Nothing is sent to NetSuite.' : "The new payment run isn't saved. Nothing is sent to NetSuite.",
    { title: 'Leave without saving your edits?', confirmLabel: LEAVE_WITHOUT_SAVING, cancelLabel: 'Keep editing', destructive: true },
  );

  /** Drops a new run that was never saved, once that's what's wanted. */
  const leaveNew = async () => {
    if (!(await leaveOk())) return;
    clearSaid();
    setDraft(null);
    go('');
    await refresh('', data?.company);
  };

  /** Reads what NetSuite has open again, keeping what's ticked and typed. */
  const reloadBills = async () => {
    if (!draft) return;
    const kept = draft;
    await load({ company: kept.company, run: savedDraft ? kept.id : undefined, bills: true });
    setDraft(kept);
  };

  const open = async (r: RunSummary) => {
    if (!(await leaveOk())) return;
    clearSaid();
    go(r.id);
    setDraft(null);
    window.scrollTo({ top: 0 });
    await refresh(r.id);
  };

  const close = async () => {
    if (!(await leaveOk())) return;
    clearSaid();
    go('');
    setDraft(null);
    setQuery('');
    await refresh('', data?.company);
  };

  const pickCompany = async (code: string) => {
    if (code === data?.company) return;
    clearSaid();
    await load({ company: code });
  };

  /** Starts a new run for the company the list shows, with what NetSuite has open now to tick from. */
  const start = async () => {
    if (!data || !(await leaveOk())) return;
    clearSaid();
    setQuery('');
    const fresh = await load({ company: data.company, bills: true });
    if (!fresh) return;
    const d: Draft = {
      id: newId(), company: fresh.company, accountId: fresh.accounts.length === 1 ? fresh.accounts[0].netsuiteId : '',
      date: fresh.today, memo: '', payments: [],
    };
    setOpenId(d.id);
    setDraft(d);
    window.scrollTo({ top: 0 });
  };

  const change = (p: Partial<Draft>) => { setDraft((d) => (d ? { ...d, ...p } : d)); setError(null); setDone(null); };
  const changePayments = (fn: (payments: DraftPayment[]) => DraftPayment[]) => {
    setDraft((d) => (d ? { ...d, payments: fn(d.payments).filter((p) => p.bills.length > 0) } : d));
    setError(null);
    setDone(null);
  };
  const ticked = (vendorId: string, billId: string) =>
    !!draft?.payments.find((p) => p.vendorId === vendorId)?.bills.some((b) => b.billId === billId);
  const tickFor = (g: { vendorId: string; vendorName: string | null }, bills: ShownBill[], on: boolean) => changePayments((payments) => {
    const ids = new Set(bills.map((b) => b.billId));
    const has = payments.some((p) => p.vendorId === g.vendorId);
    const next = has ? payments : [...payments, { vendorId: g.vendorId, vendorName: g.vendorName, method: 'check' as PayMethod, bills: [] }];
    return next.map((p) => {
      if (p.vendorId !== g.vendorId) return p;
      if (!on) return { ...p, bills: p.bills.filter((b) => !ids.has(b.billId)) };
      const add = bills.filter((b) => !p.bills.some((x) => x.billId === b.billId))
        .map(({ open: _open, ...b }) => ({ ...b, amount: centsText(b.openCents) }));
      return { ...p, bills: [...p.bills, ...add].slice(0, MAX_BILLS) };
    });
  });
  const setAmount = (vendorId: string, billId: string, amount: string) => changePayments((payments) => payments.map((p) => (
    p.vendorId !== vendorId ? p : { ...p, bills: p.bills.map((b) => (b.billId === billId ? { ...b, amount } : b)) }
  )));
  const setMethod = (vendorId: string, method: PayMethod) => changePayments((payments) => payments.map((p) => (p.vendorId === vendorId ? { ...p, method } : p)));

  const post = async (payload: Record<string, unknown>) => {
    const res = await apiFetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && !!body.success, status: res.status, body };
  };

  /** Saves the draft. Returns when it was saved, or null when it wasn't. */
  const save = async (): Promise<string | null> => {
    if (!draft) return null;
    const payments = draftPayments(draft);
    for (const p of payments) {
      for (const b of p.bills) {
        if (Number.isNaN(b.cents)) { setError(`What it pays on ${billName(b)} isn't an amount: type it like 1,250.00.`); return null; }
        if (b.cents < 0) { setError(`What it pays on ${billName(b)} can't be below $0.`); return null; }
      }
    }
    if (!draft.date) { setError('Pick the day the vendors are paid.'); return null; }
    setBusy('save');
    setError(null);
    setProblems([]);
    try {
      const { ok, status, body } = await post({
        action: 'save', id: draft.id, company: draft.company, accountId: draft.accountId || null, date: draft.date, memo: draft.memo, payments,
      });
      if (!ok) throw new Error(body.error || `It wasn't saved (${status}).`);
      go(draft.id);
      await refresh(draft.id);
      return body.updatedAt as string;
    } catch (e: any) {
      setError(e?.message || "It wasn't saved.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const askApproval = async () => {
    if (!draft || !worked) return;
    if (worked.problems.length > 0) { setProblems(worked.problems); return; }
    const updatedAt = dirty ? await save() : savedDraft?.updatedAt;
    if (!updatedAt) return;
    setBusy('ask');
    clearSaid();
    try {
      const { ok, status, body } = await post({ action: 'ask', id: draft.id, updatedAt });
      if (!ok) {
        setProblems(body.problems ?? []);
        throw new Error(body.error || `It wasn't asked for approval (${status}).`);
      }
      setDone({
        text: "Asked for approval. A super admin who didn't ask approves it, and FleetSuite makes the bill payments in NetSuite.",
        warnings: body.warning ? [body.warning] : undefined,
      });
      await refresh(draft.id);
    } catch (e: any) {
      setError(e?.message || "It wasn't asked for approval.");
    } finally {
      setBusy(null);
    }
  };

  /** One press on a run that isn't being ticked: take back or send back. */
  const act = async (action: string, payload: Record<string, unknown>, said: string) => {
    if (!run) return;
    setBusy(action);
    clearSaid();
    try {
      const { ok, status, body } = await post({ action, id: run.id, ...payload });
      if (!ok) {
        setProblems(body.problems ?? []);
        throw new Error(body.error || `That didn't work (${status}).`);
      }
      setDone({ text: said });
      await refresh(run.id);
    } catch (e: any) {
      setError(e?.message || "That didn't work.");
      await refresh(run.id);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!draft) return;
    if (!savedDraft) { await leaveNew(); return; }
    const ok = await dialog.confirm("Delete this draft run? Nothing in it was sent to NetSuite, and it can't be got back.", {
      confirmLabel: 'Delete draft', destructive: true, title: 'Delete a draft run',
    });
    if (!ok) return;
    setBusy('delete');
    clearSaid();
    try {
      const { ok: deleted, status, body } = await post({ action: 'delete', id: draft.id });
      if (!deleted) throw new Error(body.error || `It wasn't deleted (${status}).`);
      setDraft(null);
      go('');
      setDone({ text: 'Draft deleted.' });
      await refresh('', data?.company);
    } catch (e: any) {
      setError(e?.message || "It wasn't deleted.");
    } finally {
      setBusy(null);
    }
  };

  const sendBack = async () => {
    const reason = await dialog.prompt('Why is it going back? Whoever asked sees this.', '', {
      confirmLabel: 'Send back', title: 'Send back to be fixed', placeholder: 'What to fix', multiline: true,
    });
    if (!reason?.trim()) return;
    await act('send_back', { reason: reason.trim() }, 'Sent back to be fixed. Whoever asked sees why.');
  };

  /** Makes these payments in NetSuite one at a time, each its own press, and says how it went. */
  const makeAll = async (ids: string[], runId: string) => {
    const made: string[] = [];
    const failed: string[] = [];
    const warnings: string[] = [];
    for (const [i, paymentId] of ids.entries()) {
      setProgress(ids.length > 1 ? `Making bill payment ${i + 1} of ${ids.length} in NetSuite…` : 'Making the bill payment in NetSuite…');
      const { ok, body } = await post({ action: 'make', paymentId }).catch(() => ({ ok: false, body: {} as any }));
      if (ok) {
        made.push(body.number || `bill payment ${body.billPaymentId}`);
        if (body.booksWarning) warnings.push(body.booksWarning);
        continue;
      }
      failed.push(body.error || NO_ANSWER);
      // NetSuite may have made it: stop, so it's asked about before anything else is sent.
      if (body.unsure || !body.error) break;
    }
    setProgress(null);
    if (made.length > 0) setDone({ text: `${plural(made.length, 'bill payment')} made in NetSuite: ${made.join(', ')}.`, warnings });
    if (failed.length > 0) {
      setError(failed[0]);
      setProblems(failed.slice(1));
    }
    await refresh(runId);
  };

  const approve = async () => {
    if (!run || !worked) return;
    const ok = await dialog.confirm(
      `Approve this run and make ${plural(run.vendorCount, 'bill payment')} in NetSuite for ${formatCents(run.totalCents)}, `
        + `from ${run.accountName || 'its bank account'}, dated ${day(run.date)}? Its checks print on the check stock from this page once they're made.`,
      { confirmLabel: 'Approve and pay', title: 'Approve a payment run' },
    );
    if (!ok) return;
    setBusy('approve');
    clearSaid();
    try {
      const { ok: approved, status, body } = await post({ action: 'approve', id: run.id, askedAt: run.askedAt });
      if (!approved) {
        setProblems(body.problems ?? []);
        throw new Error(body.error || `It wasn't approved (${status}).`);
      }
      await makeAll((body.toMake ?? []) as string[], run.id);
    } catch (e: any) {
      setError(e?.message || "It wasn't approved.");
      await refresh(run.id);
    } finally {
      setBusy(null);
    }
  };

  const make = async (ids: string[]) => {
    if (!run) return;
    setBusy('make');
    clearSaid();
    try {
      await makeAll(ids, run.id);
    } finally {
      setBusy(null);
    }
  };

  const drop = async (p: MadePayment) => {
    if (!run) return;
    const reason = await dialog.prompt(`Drop ${vendorNameOf(p)}'s payment from the run? Its bills stay open in NetSuite. Why?`, '', {
      confirmLabel: 'Drop it', title: 'Drop a payment', placeholder: 'Why it isn’t paid', multiline: true,
    });
    if (!reason?.trim()) return;
    setBusy(`drop-${p.id}`);
    clearSaid();
    try {
      const { ok, status, body } = await post({ action: 'drop', paymentId: p.id, reason: reason.trim() });
      if (!ok) throw new Error(body.error || `It wasn't dropped (${status}).`);
      setDone({ text: `${vendorNameOf(p)}'s payment was dropped. Its bills stay open in NetSuite.` });
    } catch (e: any) {
      setError(e?.message || "It wasn't dropped.");
    } finally {
      await refresh(run.id);
      setBusy(null);
    }
  };

  if (!authLoading && !allowed) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Payments permission and price access to pay vendors.</div>;
  }

  const lists = (data?.runs ?? []).reduce<Record<RunStatus, RunSummary[]>>((by, r) => {
    by[r.status].push(r);
    return by;
  }, { waiting: [], approved: [], draft: [], done: [] });
  const mine = run?.askedById === data?.me;
  const canApprove = superAdmin && !!data?.switchedOn && !mine;
  const canTakeBack = !!run && (superAdmin || run.askedById === data?.me || run.createdById === data?.me);
  // Until paying vendors is switched on only super admins make runs: anyone else, or a super admin
  // viewing as them, reads that it's off.
  const offOnly = switchedOff || (!!data && !data.switchedOn && !superAdmin);
  const offNote = switchedOff ? loadError : data?.offText ? (superAdmin ? data.offText : 'Paying vendors is switched off until it moves into FleetSuite during 2027.') : null;
  const companyName = (code: string) => data?.companies.find((c) => c.code === code)?.name ?? code;

  const row = (r: RunSummary) => (
    <button key={r.id} type="button" onClick={() => open(r)}
      style={{
        display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', width: '100%', textAlign: 'left',
        background: 'none', border: 'none', borderTop: `1px solid ${theme.border}`, padding: '10px 0 0', cursor: 'pointer', color: theme.textPrimary,
      }}>
      <span style={{ minWidth: 0, display: 'grid', gap: '2px' }}>
        <span style={{ ...twoLines, fontSize: '14px', fontWeight: 700 }}>
          {day(r.date)} · {r.accountName || 'No bank account yet'}
        </span>
        <span style={muted}>
          {[plural(r.vendorCount, 'vendor'), plural(r.billCount, 'bill'), r.memo || '',
            r.status === 'waiting' && r.askedBy ? `asked by ${r.askedBy}` : '',
            r.status === 'done' && r.approvedBy ? `approved by ${r.approvedBy}` : ''].filter(Boolean).join(' · ')}
        </span>
        {r.status === 'draft' && r.returnedReason && <span style={{ ...red, ...twoLines, fontSize: '12px' }}>Sent back: {r.returnedReason}</span>}
      </span>
      <span style={{ ...num, fontSize: '15px', fontWeight: 800 }}>{formatCents(r.totalCents)}</span>
    </button>
  );

  const section = (title: string, list: RunSummary[], empty?: string) => (list.length > 0 || empty) && (
    <div style={{ ...card, display: 'grid', gap: '10px' }}>
      <div style={heading}>{title}</div>
      {list.length > 0 ? list.map(row) : <div style={muted}>{empty}</div>}
    </div>
  );

  const said = (
    <>
      {done && (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '6px' }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: theme.success }}>{done.text}</div>
          {(done.warnings ?? []).map((w, i) => <div key={`${i}-${w}`} style={red}>{w}</div>)}
        </div>
      )}
      {progress && <div style={{ ...card, color: theme.textPrimary, fontSize: '14px', fontWeight: 700 }}>{progress}</div>}
      {(error || problems.length > 0) && (
        <div style={{ display: 'grid', gap: '2px' }}>
          {error && <div style={red}>{error}</div>}
          {problems.filter((p) => p !== error && !error?.startsWith(p)).map((p, i) => <div key={`${i}-${p}`} style={red}>{p}</div>)}
        </div>
      )}
    </>
  );

  /** A payment's bills, as a run shows them once it's no longer ticked. */
  const billLines = (p: RunPayment) => p.bills.map((b) => (
    <div key={b.billId} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', color: theme.textSecondary }}>
      <span style={{ minWidth: 0 }}>
        {billName(b)}{b.dueDate ? ` · due ${day(b.dueDate)}` : ''}{b.cents < b.openCents ? ` · part of ${formatCents(b.openCents)}` : ''}
      </span>
      <span style={num}>{formatCents(b.cents)}</span>
    </div>
  ));

  const totals = worked && (
    <div style={{ ...card, display: 'grid', gap: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '18px', fontWeight: 800, color: theme.textPrimary }}>
        <span>Pays</span><span style={num}>{formatCents(worked.totalCents)}</span>
      </div>
      <div style={muted}>{plural(worked.payments.length, 'vendor')} · {plural(worked.billCount, 'bill')} · one bill payment in NetSuite for each vendor</div>
    </div>
  );

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {draft && dirty && (
        <TopSaveBar
          title={savedDraft ? 'Payment run' : 'New payment run'}
          subtitle={`${savedDraft ? 'Changed, not saved' : 'Not saved yet'}${worked ? ` · ${formatCents(worked.totalCents)}` : ''}`}
          error={error || undefined}
          onSave={() => { save(); }}
          saving={busy === 'save'}
          saveLabel="Save"
          savingLabel="Saving…"
          onCancel={() => {
            if (!savedDraft) { leaveNew(); return; }
            setDraft(toDraft(savedDraft));
            setError(null);
          }}
          cancelLabel={savedDraft ? 'Undo changes' : undefined}
        />
      )}
      <div>
        <button onClick={() => (openId ? close() : router.push('/more'))}
          style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>
          {openId ? '← Payment runs' : '← More'}
        </button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Pay vendors</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>
          Open bills paid in a payment run, approved by a super admin who didn&apos;t ask, and made in NetSuite as bill payments.
        </div>
      </div>

      {offNote && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {offNote}
        </div>
      )}

      {offOnly ? null : loading && !data ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Opening the payment runs…</div>
      ) : !data || (loadError && !draft) ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={red}>{loadError || "Couldn't open the payment runs."}</div>
          <div><button onClick={() => refresh(openId, company)} style={btn}>Try again</button></div>
        </div>
      ) : draft ? (
        <>
          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            {savedDraft?.returnedReason && (
              <div style={{ ...red, fontSize: '14px' }}>
                Sent back by {savedDraft.returnedBy || 'a super admin'} {when(savedDraft.returnedAt)}: {savedDraft.returnedReason}
              </div>
            )}
            <div style={muted}>{companyName(draft.company)}</div>
            <div>
              <label style={label} htmlFor="pv-account">Pay from</label>
              {data.accounts.length === 0 ? (
                <div style={red}>Books has no bank accounts for {companyName(draft.company)} from NetSuite yet.</div>
              ) : (
                <select id="pv-account" style={input} value={draft.accountId} onChange={(e) => change({ accountId: e.target.value })}>
                  <option value="">Pick the bank account it pays from</option>
                  {data.accounts.map((a) => <option key={a.netsuiteId} value={a.netsuiteId}>{accountName(a)}</option>)}
                </select>
              )}
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 150px' }}>
                <label style={label} htmlFor="pv-date">Paid on</label>
                <input id="pv-date" type="date" style={input} value={draft.date} max={daysAfter(data.today, AHEAD_DAYS)}
                  onChange={(e) => change({ date: e.target.value })} />
              </div>
              <div style={{ flex: '3 1 240px' }}>
                <label style={label} htmlFor="pv-memo">Memo (if any)</label>
                <input id="pv-memo" style={input} value={draft.memo} maxLength={MEMO_MAX} placeholder="On each bill payment in NetSuite"
                  onChange={(e) => change({ memo: e.target.value })} />
              </div>
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <div style={heading}>Open bills</div>
              <button onClick={reloadBills} disabled={loading} style={small}>{loading ? 'Reading…' : 'Reload from NetSuite'}</button>
            </div>
            <input aria-label="Find a vendor or bill" style={input} placeholder="Find a vendor or bill" value={query} onChange={(e) => setQuery(e.target.value)} />
            {loadError && <div style={red}>{loadError}</div>}
            {data.billsError && <div style={red}>{data.billsError}</div>}
            {!data.billsError && groups.length === 0 && <div style={{ fontSize: '14px', color: theme.textSecondary }}>NetSuite has no open bills for {companyName(draft.company)}.</div>}
            {shown.map((g) => {
              const payment = draft.payments.find((p) => p.vendorId === g.vendorId);
              const tickable = g.bills.filter((b) => b.open && !held.has(b.billId));
              const allTicked = tickable.length > 0 && tickable.every((b) => ticked(g.vendorId, b.billId));
              const vendorCents = draftPayments({ ...draft, payments: payment ? [payment] : [] })[0]?.bills.reduce((s, b) => s + (Number.isNaN(b.cents) ? 0 : b.cents), 0) ?? 0;
              return (
                <div key={g.vendorId} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '10px', display: 'grid', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary, minWidth: 0 }}>{vendorNameOf(g)}</span>
                    <span style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                      {payment && (Object.keys(PAY_METHODS) as PayMethod[]).map((m) => (
                        <button key={m} type="button" aria-pressed={payment.method === m} onClick={() => setMethod(g.vendorId, m)}
                          style={{ ...small, borderColor: payment.method === m ? theme.successBorder : theme.border, background: payment.method === m ? theme.successBg : theme.card, color: payment.method === m ? theme.success : theme.textPrimary }}>
                          {PAY_METHODS[m]}
                        </button>
                      ))}
                      {tickable.length > 1 && (
                        <button type="button" onClick={() => tickFor(g, tickable, !allTicked)} style={small}>{allTicked ? 'Untick all' : 'Tick all'}</button>
                      )}
                      {payment && <span style={{ ...num, fontSize: '14px', fontWeight: 800 }}>{formatCents(vendorCents)}</span>}
                    </span>
                  </div>
                  {g.bills.map((b) => {
                    const isTicked = ticked(g.vendorId, b.billId);
                    const isHeld = held.has(b.billId);
                    const typed = payment?.bills.find((x) => x.billId === b.billId);
                    return (
                      <div key={b.billId} style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '13px', color: isHeld || !b.open ? theme.textMuted : theme.textPrimary }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '1 1 220px', minWidth: 0, cursor: isHeld || (!b.open && !isTicked) ? 'default' : 'pointer' }}>
                          <input type="checkbox" checked={isTicked} disabled={!isTicked && (isHeld || !b.open)} onChange={() => tickFor(g, [b], !isTicked)} />
                          <span style={{ minWidth: 0 }}>
                            <b>{billName(b)}</b>
                            <span style={{ color: theme.textMuted }}>
                              {b.dueDate ? ` · due ${day(b.dueDate)}` : b.date ? ` · ${day(b.date)}` : ''}
                              {b.dueDate && b.dueDate < data.today ? ' · past due' : ''}
                              {isHeld ? ' · in another run' : ''}
                              {!b.open ? ' · not open in NetSuite now' : ''}
                            </span>
                          </span>
                        </label>
                        {isTicked && typed ? (
                          <input aria-label={`What it pays on ${billName(b)}`} inputMode="decimal" value={typed.amount}
                            onChange={(e) => setAmount(g.vendorId, b.billId, e.target.value)}
                            style={{ ...input, ...num, width: '120px', padding: '5px 8px', fontSize: '14px' }} />
                        ) : null}
                        <span style={{ ...num, minWidth: '90px' }}>{b.open ? `${formatCents(b.openCents)} open` : ''}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            <div style={muted}>As NetSuite had them when the page was read. Asking for approval checks them with NetSuite again.</div>
          </div>

          {totals}
          {said}
          {worked && worked.problems.length > 0 && problems.length === 0 && draft.payments.length > 0 && (
            <div style={{ display: 'grid', gap: '2px' }}>{worked.problems.map((p, i) => <div key={`${i}-${p}`} style={red}>{p}</div>)}</div>
          )}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {dirty && (
              <button type="button" onClick={() => { save(); }} disabled={busy !== null} style={{ ...green, ...(busy !== null ? off : {}) }}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
            )}
            <button type="button" onClick={askApproval} disabled={!data.switchedOn || busy !== null}
              style={{ ...btn, ...(!data.switchedOn || busy !== null ? off : {}) }}>
              {busy === 'ask' ? 'Asking…' : !data.switchedOn ? 'Asking is switched off' : dirty ? 'Save and ask for approval' : 'Ask for approval'}
            </button>
            <button type="button" onClick={remove} disabled={busy !== null} style={{ ...btn, color: theme.error, borderColor: theme.errorBorder }}>
              {savedDraft ? 'Delete draft' : LEAVE_WITHOUT_SAVING}
            </button>
          </div>
        </>
      ) : run ? (
        <>
          <div style={{ ...card, display: 'grid', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary, wordBreak: 'break-word' }}>
                  {companyName(run.company)} · {day(run.date)}
                </div>
                <div style={muted}>{[run.accountName, run.memo].filter(Boolean).join(' · ')}</div>
              </div>
              <span style={{ fontSize: '13px', fontWeight: 800, color: STATUS[run.status].color }}>{STATUS[run.status].text}</span>
            </div>
            <div style={muted}>
              {[run.createdBy ? `Started by ${run.createdBy}` : '',
                run.askedBy ? `asked for approval by ${run.askedBy} ${when(run.askedAt)}` : '',
                run.approvedBy ? `approved by ${run.approvedBy} ${when(run.approvedAt)}` : ''].filter(Boolean).join(' · ')}
            </div>

            {run.status === 'waiting' ? run.payments.map((p) => (
              <div key={p.vendorId} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '8px', display: 'grid', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '14px', fontWeight: 800, color: theme.textPrimary }}>
                  <span style={{ minWidth: 0 }}>{vendorNameOf(p)} · {PAY_METHODS[p.method]}</span>
                  <span style={num}>{formatCents(p.bills.reduce((s, b) => s + b.cents, 0))}</span>
                </div>
                {billLines(p)}
              </div>
            )) : run.made.map((p) => {
              const s = PAYMENT_STATUS[p.status];
              return (
                <div key={p.id} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '8px', display: 'grid', gap: '4px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '14px', fontWeight: 800, color: theme.textPrimary }}>
                    <span style={{ minWidth: 0 }}>{vendorNameOf(p)} · {PAY_METHODS[p.method]}</span>
                    <span style={num}>{formatCents(p.totalCents)}</span>
                  </div>
                  {billLines(p)}
                  <div style={{ fontSize: '13px', fontWeight: 700, color: s.color }}>
                    {p.status === 'made' ? `${s.text}: ${p.number || `bill payment ${p.billPaymentId}`}`
                      : p.status === 'dropped' ? `${s.text}${p.droppedBy ? ` by ${p.droppedBy}` : ''}${p.droppedReason ? `: ${p.droppedReason}` : ''}`
                        : p.status === 'refused' ? `${s.text}: ${p.error || "NetSuite didn't make it."}`
                          : p.status === 'sending' && p.error ? `NetSuite didn't say whether it made it: ${p.error}` : s.text}
                  </div>
                  {run.status === 'approved' && data.switchedOn && (p.status === 'refused' || (p.status === 'sending' && (p.stale || !!p.error)) || p.status === 'to_make') && (
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {p.status !== 'to_make' && (
                        <button type="button" onClick={() => make([p.id])} disabled={busy !== null} style={{ ...small, ...(busy !== null ? off : {}) }}>
                          {p.status === 'sending' ? 'Ask NetSuite' : 'Make it again'}
                        </button>
                      )}
                      {superAdmin && p.status !== 'sending' && (
                        <button type="button" onClick={() => drop(p)} disabled={busy !== null} style={{ ...small, color: theme.error, borderColor: theme.errorBorder }}>
                          Drop from the run
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '16px', fontWeight: 800, color: theme.textPrimary, borderTop: `1px solid ${theme.border}`, paddingTop: '8px' }}>
              <span>{plural(run.vendorCount, 'vendor')} · {plural(run.billCount, 'bill')}</span><span style={num}>{formatCents(run.totalCents)}</span>
            </div>
            {run.status === 'waiting' && run.checkError && <div style={red}>{run.checkError}</div>}
            {run.status === 'waiting' && worked && worked.problems.length > 0 && problems.length === 0 && (
              <div style={{ display: 'grid', gap: '2px' }}>{worked.problems.map((p, i) => <div key={`${i}-${p}`} style={red}>{p}</div>)}</div>
            )}
            {said}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {run.status === 'waiting' && (
                <>
                  {superAdmin && (
                    <button type="button" onClick={approve} disabled={!canApprove || busy !== null} style={{ ...green, ...(!canApprove || busy !== null ? off : {}) }}>
                      {busy === 'approve' ? 'Approving…' : 'Approve and pay'}
                    </button>
                  )}
                  {superAdmin && <button type="button" onClick={sendBack} disabled={busy !== null} style={btn}>Send back</button>}
                  {canTakeBack && (
                    <button type="button" onClick={() => act('take_back', {}, 'Taken back. Change it, then ask for approval again.')}
                      disabled={busy !== null} style={btn}>Take back to change it</button>
                  )}
                </>
              )}
              {run.status === 'approved' && data.switchedOn && run.made.some((p) => p.status === 'to_make') && (
                <button type="button" onClick={() => make(run.made.filter((p) => p.status === 'to_make').map((p) => p.id))} disabled={busy !== null}
                  style={{ ...green, ...(busy !== null ? off : {}) }}>
                  {busy === 'make' ? 'Making them…' : 'Make the bill payments in NetSuite'}
                </button>
              )}
            </div>
            {run.status === 'waiting' && superAdmin && mine && (
              <div style={muted}>You asked for this one, so a super admin who didn&apos;t ask approves it.</div>
            )}
            {run.status === 'waiting' && superAdmin && !data.switchedOn && (
              <div style={muted}>Approving is switched off until paying vendors is switched on.</div>
            )}
          </div>
          {(run.status === 'approved' || run.status === 'done') && run.made.some((p) => p.method === 'check' && p.status !== 'dropped') && (
            <RunChecks key={run.id} runId={run.id} madeKey={run.made.map((p) => `${p.id}:${p.status}`).join(',')} />
          )}
        </>
      ) : (
        <>
          {data.companies.length > 1 && (
            <div style={{ display: 'flex', gap: '8px' }}>
              {data.companies.map((c) => (
                <button key={c.code} onClick={() => pickCompany(c.code)} aria-pressed={data.company === c.code}
                  style={{ ...btn, flex: 1, borderColor: data.company === c.code ? theme.successBorder : theme.border, background: data.company === c.code ? theme.successBg : theme.card, color: data.company === c.code ? theme.success : theme.textPrimary }}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {openId && !loading && <div style={red}>There&apos;s no such payment run: it may have been deleted.</div>}
          {said}
          <div>
            <button type="button" onClick={start} disabled={loading} style={{ ...green, ...(loading ? off : {}) }}>
              {loading ? 'Reading the open bills…' : '+ New payment run'}
            </button>
          </div>
          {section('Waiting for approval', lists.waiting)}
          {section('Being paid', lists.approved)}
          {section('Drafts', lists.draft, lists.waiting.length + lists.approved.length + lists.done.length === 0 ? `No payment runs for ${companyName(data.company)} yet.` : undefined)}
          {section('Paid', lists.done)}
          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={heading}>Check stock</div>
                <div style={muted}>Where checks print on BMG&apos;s check stock, for each bank account.</div>
              </div>
              <button type="button" onClick={() => setLining((v) => !v)} aria-expanded={lining} style={small}>
                {lining ? 'Done lining up' : 'Line up the check stock'}
              </button>
            </div>
            {lining && <CheckStockPanel key={data.company} company={data.company} />}
          </div>
        </>
      )}
    </div>
  );
}
