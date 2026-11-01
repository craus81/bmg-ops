'use client';

/**
 * Journal entries typed in FleetSuite, asked for approval, and made in
 * NetSuite once a super admin who didn't ask approves them (Books part 37,
 * docs/books.md "Journal entries typed in FleetSuite"; owner decisions
 * 2026-10-31: from January 1, 2027 the team works only in FleetSuite, apart
 * from payments). Opened from More → Money & Books → Journal Entries.
 *
 * Type the entry line by line, each an account and a debit or a credit,
 * Save, and Ask for approval. A super admin who didn't ask approves it and
 * FleetSuite makes it in NetSuite exactly as typed, or sends it back with
 * why. The rules are src/lib/typed-journal-entries.ts, the same ones
 * /api/journal-entries checks and makes the entry by. Built switched off
 * (Books → Switches): until it's on, super admins can type and save entries
 * to see what they'd make, and none is asked for approval or sent.
 *
 * Each entry is in the general journal, typed by whoever has Payments, or
 * the CPA's own adjustments (Books part 53), typed by the CPA or a super
 * admin for them and made in NetSuite with its memo starting "CPA
 * adjustment:". The page shows the journals the roles it's viewed as type
 * in (journalsFor), so View As → CPA shows the CPA's page; the route goes by
 * the viewer's own. The CPA opens it from the books.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import TopSaveBar from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import { parseDollars } from '@/lib/books/typed-dollars';
import { booksAccess } from '@/lib/books/access';
import { SWITCH_ON_DATE_TEXT } from '@/lib/books/switches';
import {
  CPA_MEMO_PREFIX, MAX_LINES, MAX_LINE_CENTS, MEMO_MAX, accountName, entryNoun, formatCents, journalsFor, memoMax, reversalDate, reversed,
  workOutTypedEntry,
  type JournalAccount, type JournalCompany, type JournalKind, type TypedLine, type TypedStatus,
} from '@/lib/typed-journal-entries';

const API = '/api/journal-entries';

interface Entry {
  id: string;
  journal: JournalKind;
  company: string;
  date: string;
  memo: string | null;
  lines: TypedLine[];
  totalCents: number;
  status: TypedStatus;
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
  journalId: string | null;
  number: string | null;
  error: string | null;
}

interface Loaded {
  companies: JournalCompany[];
  accounts: JournalAccount[];
  entries: Entry[];
  me: string;
  journals: JournalKind[];
  superAdmin: boolean;
  switchedOn: boolean;
  offText: string | null;
}

/** A line as it's typed: its amounts are text until it's saved. */
interface EditLine { key: string; accountId: string; debit: string; credit: string; memo: string }

/** The entry being typed, new or a draft opened. Its journal is picked before it's first saved, and kept. */
interface Draft { id: string; journal: JournalKind; company: string; date: string; memo: string; lines: EditLine[] }

const TYPE_LABELS: Record<string, string> = {
  bank: 'Bank',
  other_current_asset: 'Other current assets',
  fixed_asset: 'Fixed assets',
  other_asset: 'Other assets',
  deferred_expense: 'Deferred expenses',
  credit_card: 'Credit cards',
  other_current_liability: 'Other current liabilities',
  long_term_liability: 'Long-term liabilities',
  deferred_revenue: 'Deferred revenue',
  equity: 'Equity',
  income: 'Income',
  other_income: 'Other income',
  cost_of_goods_sold: 'Cost of goods sold',
  expense: 'Expenses',
  other_expense: 'Other expenses',
};

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

let lineSeq = 0;
const lineKey = () => `line-${++lineSeq}`;
const blankLine = (): EditLine => ({ key: lineKey(), accountId: '', debit: '', credit: '', memo: '' });
const centsText = (c: number) => (c > 0 ? (c / 100).toFixed(2) : '');
const editLines = (lines: TypedLine[]): EditLine[] => lines.map((l) => ({
  key: lineKey(), accountId: l.accountId ?? '', debit: centsText(l.debitCents), credit: centsText(l.creditCents), memo: l.memo ?? '',
}));
const toDraft = (e: Entry): Draft => ({ id: e.id, journal: e.journal, company: e.company, date: e.date, memo: e.memo ?? '', lines: editLines(e.lines) });

/** What's typed in a money box, in whole cents: 0 when it's empty, NaN when it isn't an amount. */
const typedCents = (text: string) => (text.trim() === '' ? 0 : parseDollars(text) ?? NaN);
const draftLines = (d: Draft): TypedLine[] => d.lines.map((l) => ({
  accountId: l.accountId || null, debitCents: typedCents(l.debit), creditCents: typedCents(l.credit), memo: l.memo.trim() || null,
}));
/** A draft as it'd be saved, to tell whether anything's changed. */
const shape = (d: Draft) => JSON.stringify({ company: d.company, date: d.date, memo: d.memo.trim(), lines: draftLines(d) });

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const day = (ymd: string) => (ymd ? new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
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
const small: React.CSSProperties = { ...btn, padding: '6px 10px', fontSize: '13px' };
const off: React.CSSProperties = { opacity: 0.6, cursor: 'default' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const muted: React.CSSProperties = { fontSize: '12px', color: theme.textMuted };
const heading: React.CSSProperties = { fontSize: '15px', fontWeight: 800, color: theme.textPrimary };
const red: React.CSSProperties = { fontSize: '13px', color: theme.error, fontWeight: 700 };
/** Two lines at most, so a long memo doesn't push the list off the screen. */
const twoLines: React.CSSProperties = {
  overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};

const JOURNAL_LABELS: Record<JournalKind, string> = { general: 'General journal', cpa_adjustments: 'CPA adjustments' };

const STATUS: Record<TypedStatus, { text: string; color: string }> = {
  draft: { text: 'Draft', color: theme.textMuted },
  waiting: { text: 'Waiting for approval', color: theme.warning },
  sending: { text: 'Being made in NetSuite', color: theme.warning },
  made: { text: 'In NetSuite', color: theme.success },
};

export default function JournalEntriesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { hasFeature, hasRole, canSeeMoney, loading: authLoading } = useAuth();

  const [openId, setOpenId] = useState(() => (searchParams.get('id') || '').trim());
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The route refused because journal entries are switched off and this person isn't a super admin.
  const [switchedOff, setSwitchedOff] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<{ text: string; warning?: string } | null>(null);

  // The journals this page shows and starts entries in, by the roles it's viewed as.
  const journals = authLoading ? [] : journalsFor({ payments: hasFeature('vendor_payments') && canSeeMoney, hasRole });
  const allowed = journals.length > 0;
  const cpaOnly = journals.length === 1 && journals[0] === 'cpa_adjustments';
  const title = cpaOnly ? 'CPA adjustments' : 'Journal entries';
  // The CPA comes here from the books, and goes back there.
  const backTo = !hasFeature('vendor_payments') && booksAccess(hasRole) ? { href: '/admin/books', label: '← Books' } : { href: '/more', label: '← More' };

  const load = useCallback(async (id: string): Promise<Loaded | null> => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(id ? `${API}?${new URLSearchParams({ id })}` : API);
      const body = await res.json().catch(() => ({}));
      setSwitchedOff(!res.ok && !!body.switchedOff);
      if (!res.ok) throw new Error(body.error || `Couldn't open journal entries (${res.status}).`);
      setData(body as Loaded);
      return body as Loaded;
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't open journal entries.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /** Reads the entries again, with this one open: typed into when it's a draft. */
  const refresh = useCallback(async (id: string) => {
    const fresh = await load(id);
    const e = fresh?.entries.find((x) => x.id === id);
    setDraft(e?.status === 'draft' ? toDraft(e) : null);
  }, [load]);

  // The entry the link opened, once the page can open it.
  const firstId = useRef(openId);
  useEffect(() => { if (allowed) refresh(firstId.current); }, [allowed, refresh]);

  const accounts = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.id, a])), [data]);
  const companyOf = (code: string) => data?.companies.find((c) => c.code === code);
  const shown = (data?.entries ?? []).filter((e) => journals.includes(e.journal));
  const entry = shown.find((e) => e.id === openId) ?? null;
  // Approving and sending back are a super admin's, as the page is viewed.
  const superAdmin = !!data?.superAdmin && hasRole('super_admin');
  const savedDraft = entry?.status === 'draft' ? entry : null;
  const dirty = !!draft && (!savedDraft || shape(draft) !== shape(toDraft(savedDraft)));

  const worked = useMemo(() => {
    const e = draft ? { journal: draft.journal, date: draft.date, memo: draft.memo, lines: draftLines(draft) } : entry;
    if (!e) return null;
    return workOutTypedEntry(e, { company: data?.companies.find((c) => c.code === (draft?.company ?? entry?.company)), accounts });
  }, [draft, entry, data, accounts]);

  const groups = useMemo(() => {
    const out: Array<{ type: string; accounts: JournalAccount[] }> = [];
    for (const a of data?.accounts ?? []) {
      if (draft && !a.companies.includes(draft.company)) continue;
      const g = out.find((x) => x.type === a.type) ?? out[out.push({ type: a.type, accounts: [] }) - 1];
      g.accounts.push(a);
    }
    return out;
  }, [data, draft]);

  const clearSaid = () => { setError(null); setProblems([]); setDone(null); };

  const go = (id: string) => {
    setOpenId(id);
    router.replace(deepLinks.journalEntries(id || null), { scroll: false });
  };

  /** Leaves what's typed and not saved only when that's what's wanted. */
  const leaveOk = async () => !dirty || dialog.confirm("What you've typed isn't saved. Leave it?", { confirmLabel: 'Leave it', title: 'Not saved' });

  const open = async (e: Entry) => {
    if (!(await leaveOk())) return;
    clearSaid();
    go(e.id);
    setDraft(e.status === 'draft' ? toDraft(e) : null);
    window.scrollTo({ top: 0 });
  };

  const close = async () => {
    if (!(await leaveOk())) return;
    clearSaid();
    go('');
    setDraft(null);
  };

  /** Starts a new entry: blank, or the lines of one made (the other way round, to reverse it). */
  const start = async (from?: Entry, reverse = false) => {
    if (!(await leaveOk())) return;
    clearSaid();
    const company = from?.company ?? (data?.companies.find((c) => c.code === 'BMG') ?? data?.companies[0])?.code ?? '';
    const memo = !from ? '' : reverse ? `Reverses ${from.number || 'journal entry'}${from.memo ? `: ${from.memo}` : ''}` : from.memo ?? '';
    // A copy or a reversal stays in its journal; a new one starts in the general journal when it's this person's.
    const journal = from?.journal ?? (journals.includes('general') ? 'general' : journals[0]);
    const d: Draft = {
      id: newId(),
      journal,
      company,
      date: from && reverse ? reversalDate(from.date) || today() : today(),
      memo: memo.slice(0, memoMax(journal)),
      lines: from ? editLines(reverse ? reversed(from.lines) : from.lines) : [blankLine(), blankLine()],
    };
    setOpenId(d.id);
    setDraft(d);
    window.scrollTo({ top: 0 });
  };

  const change = (p: Partial<Draft>) => { setDraft((d) => (d ? { ...d, ...p } : d)); setError(null); setDone(null); };
  const changeLine = (key: string, p: Partial<EditLine>) => {
    setDraft((d) => (d ? {
      ...d,
      lines: d.lines.map((l) => {
        if (l.key !== key) return l;
        const next = { ...l, ...p };
        // A line is a debit or a credit: typing one clears the other.
        if (p.debit?.trim()) next.credit = '';
        if (p.credit?.trim()) next.debit = '';
        return next;
      }),
    } : d));
    setError(null);
    setDone(null);
  };

  const post = async (payload: Record<string, unknown>) => {
    const res = await apiFetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && !!body.success, status: res.status, body };
  };

  /** Saves the draft. Returns when it was saved, or null when it wasn't. */
  const save = async (): Promise<string | null> => {
    if (!draft) return null;
    const lines = draftLines(draft);
    for (const [i, l] of lines.entries()) {
      const amounts = [l.debitCents, l.creditCents];
      if (amounts.some((c) => Number.isNaN(c))) { setError(`Line ${i + 1}'s amount isn't an amount: type it like 1,250.00.`); return null; }
      if (amounts.some((c) => c < 0)) { setError(`Line ${i + 1}'s amount can't be below $0: put it on the other side.`); return null; }
      if (amounts.some((c) => c > MAX_LINE_CENTS)) { setError(`Line ${i + 1}'s amount is more than ${formatCents(MAX_LINE_CENTS)}.`); return null; }
    }
    if (!draft.date) { setError('Pick the date.'); return null; }
    setBusy('save');
    setError(null);
    setProblems([]);
    try {
      const { ok, status, body } = await post({
        action: 'save', id: draft.id, journal: draft.journal, company: draft.company, date: draft.date, memo: draft.memo, lines,
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
      setDone({ text: "Asked for approval. A super admin who didn't ask approves it, and FleetSuite makes it in NetSuite.", warning: body.warning });
      await refresh(draft.id);
    } catch (e: any) {
      setError(e?.message || "It wasn't asked for approval.");
    } finally {
      setBusy(null);
    }
  };

  /** One press on an entry that isn't being typed: take back, send back or approve. */
  const act = async (action: string, payload: Record<string, unknown>, said: (body: any) => { text: string; warning?: string } | null) => {
    if (!entry) return;
    setBusy(action);
    clearSaid();
    try {
      const { ok, status, body } = await post({ action, id: entry.id, ...payload });
      if (!ok) {
        setProblems(body.problems ?? []);
        throw new Error(body.error || `That didn't work (${status}).`);
      }
      const s = said(body);
      if (s) setDone(s);
      await refresh(entry.id);
    } catch (e: any) {
      setError(e?.message || "That didn't work.");
      await load(entry.id);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!draft) return;
    if (!savedDraft) { setDraft(null); go(''); return; }
    const ok = await dialog.confirm("Delete this draft? It isn't in NetSuite, and it can't be got back.", {
      confirmLabel: 'Delete draft', destructive: true, title: 'Delete a draft',
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
      await load('');
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
    await act('send_back', { reason: reason.trim() }, () => ({ text: 'Sent back to be fixed. Whoever asked sees why.' }));
  };

  const approve = async () => {
    if (!entry || !worked) return;
    if (entry.status === 'waiting') {
      const ok = await dialog.confirm(
        `Make this ${entryNoun(entry.journal)} in NetSuite exactly as typed? ${companyOf(entry.company)?.name ?? entry.company}, dated ${day(entry.date)}, `
          + `${plural(entry.lines.length, 'line')} for ${formatCents(worked.debitCents)}.`,
        { confirmLabel: 'Make it in NetSuite', title: `Approve a ${entryNoun(entry.journal)}` },
      );
      if (!ok) return;
    }
    await act('approve', { askedAt: entry.askedAt }, (body) => ({
      text: `Journal entry ${body.number || body.journalId} ${body.already ? 'was already made' : 'made'} in NetSuite.`,
      warning: body.warning,
    }));
  };

  if (!authLoading && !allowed) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Payments permission and price access to type journal entries.</div>;
  }

  const lists = shown.reduce<Record<TypedStatus, Entry[]>>((by, e) => {
    by[e.status].push(e);
    return by;
  }, { waiting: [], sending: [], draft: [], made: [] });
  lists.made.sort((a, b) => (b.approvedAt ?? '').localeCompare(a.approvedAt ?? ''));

  const companyRow = draft ? companyOf(draft.company) : null;
  const mine = entry?.askedById === data?.me;
  const canApprove = superAdmin && !!data?.switchedOn && !mine;
  const canTakeBack = !!entry && (superAdmin || entry.askedById === data?.me || entry.createdById === data?.me);
  // Until journal entries are switched on only super admins type them: anyone else, or a super admin
  // viewing as them, reads that they're off.
  const offOnly = switchedOff || (!!data && !data.switchedOn && !superAdmin);
  const offNote = switchedOff ? loadError
    : data?.offText ? (superAdmin ? data.offText : `Journal entries are switched off until ${SWITCH_ON_DATE_TEXT}.`) : null;
  /** Which journal an entry is in, said only when this page shows more than one. */
  const journalTag = (e: { journal: JournalKind }) => (journals.length > 1 && e.journal === 'cpa_adjustments' ? 'CPA adjustment' : '');

  const row = (e: Entry) => (
    <button key={e.id} type="button" onClick={() => open(e)}
      style={{
        display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', width: '100%', textAlign: 'left',
        background: 'none', border: 'none', borderTop: `1px solid ${theme.border}`, padding: '10px 0 0', cursor: 'pointer', color: theme.textPrimary,
      }}>
      <span style={{ minWidth: 0, display: 'grid', gap: '2px' }}>
        <span style={{ ...twoLines, fontSize: '14px', fontWeight: 700 }}>{e.memo || 'No memo yet'}</span>
        <span style={muted}>
          {[journalTag(e), day(e.date), companyOf(e.company)?.name ?? e.company, plural(e.lines.length, 'line'),
            e.status === 'waiting' && e.askedBy ? `asked by ${e.askedBy}` : '',
            e.status === 'made' ? e.number || `NetSuite ${e.journalId}` : ''].filter(Boolean).join(' · ')}
        </span>
        {e.status === 'draft' && e.returnedReason && <span style={{ ...red, ...twoLines, fontSize: '12px' }}>Sent back: {e.returnedReason}</span>}
        {e.status !== 'made' && e.error && <span style={{ ...red, ...twoLines, fontSize: '12px' }}>Not made: {e.error}</span>}
      </span>
      <span style={{ ...num, fontSize: '15px', fontWeight: 800 }}>{formatCents(e.totalCents)}</span>
    </button>
  );

  const section = (title: string, list: Entry[], empty?: string) => (list.length > 0 || empty) && (
    <div style={{ ...card, display: 'grid', gap: '10px' }}>
      <div style={heading}>{title}</div>
      {list.length > 0 ? list.map(row) : <div style={muted}>{empty}</div>}
    </div>
  );

  const totals = worked && (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', fontSize: '14px', fontWeight: 700 }}>
      <span style={{ color: theme.textPrimary }}>Debits {formatCents(worked.debitCents)} · Credits {formatCents(worked.creditCents)}</span>
      {worked.debitCents === worked.creditCents
        ? <span style={{ color: theme.success }}>{worked.debitCents > 0 ? 'Balanced' : ''}</span>
        : <span style={{ color: theme.error }}>{formatCents(Math.abs(worked.debitCents - worked.creditCents))} apart</span>}
    </div>
  );

  const said = (
    <>
      {done && (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '6px' }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: theme.success }}>{done.text}</div>
          {done.warning && <div style={red}>{done.warning}</div>}
        </div>
      )}
      {(error || problems.length > 0) && (
        <div style={{ display: 'grid', gap: '2px' }}>
          {error && <div style={red}>{error}</div>}
          {problems.filter((p) => p !== error && !error?.startsWith(p)).map((p, i) => <div key={`${i}-${p}`} style={red}>{p}</div>)}
        </div>
      )}
    </>
  );

  return (
    <div style={{ maxWidth: '860px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {draft && dirty && (
        <TopSaveBar
          title={savedDraft ? 'Journal entry' : 'New journal entry'}
          subtitle={savedDraft ? 'Changed, not saved' : 'Not saved yet'}
          error={error || undefined}
          onSave={() => { save(); }}
          saving={busy === 'save'}
          saveLabel="Save"
          savingLabel="Saving…"
          onCancel={() => { if (savedDraft) setDraft(toDraft(savedDraft)); else { setDraft(null); go(''); } setError(null); }}
          cancelLabel={savedDraft ? 'Undo changes' : undefined}
        />
      )}
      <div>
        <button onClick={() => (openId ? close() : router.push(backTo.href))}
          style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>
          {openId ? `← ${title}` : backTo.label}
        </button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>{title}</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>
          {cpaOnly
            ? 'Your adjustments, typed here, approved by a super admin, and made in NetSuite as typed, each memo starting “CPA adjustment:”.'
            : 'Typed here, approved by a super admin who didn\u2019t ask, and made in NetSuite exactly as typed.'}
        </div>
      </div>

      {offNote && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {offNote}
        </div>
      )}

      {offOnly ? null : loading && !data ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Opening journal entries…</div>
      ) : loadError || !data ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={red}>{loadError || "Couldn't open journal entries."}</div>
          <div><button onClick={() => refresh(openId)} style={btn}>Try again</button></div>
        </div>
      ) : draft ? (
        <div style={{ ...card, display: 'grid', gap: '12px' }}>
          {savedDraft?.returnedReason && (
            <div style={{ ...red, fontSize: '14px' }}>
              Sent back by {savedDraft.returnedBy || 'a super admin'} {when(savedDraft.returnedAt)}: {savedDraft.returnedReason}
            </div>
          )}
          {journals.length > 1 && !savedDraft ? (
            <div>
              <div style={label}>Journal</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {journals.map((j) => (
                  <button key={j} type="button" aria-pressed={j === draft.journal} onClick={() => change({ journal: j })}
                    style={{ ...small, borderColor: j === draft.journal ? theme.successBorder : theme.border, background: j === draft.journal ? theme.successBg : theme.card }}>
                    {JOURNAL_LABELS[j]}
                  </button>
                ))}
              </div>
            </div>
          ) : journals.length > 1 && <div style={muted}>{JOURNAL_LABELS[draft.journal]}</div>}
          {data.companies.length > 1 && (
            <div>
              <div style={label}>Company</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {data.companies.map((c) => (
                  <button key={c.code} type="button" aria-pressed={c.code === draft.company} onClick={() => change({ company: c.code })}
                    style={{ ...small, borderColor: c.code === draft.company ? theme.successBorder : theme.border, background: c.code === draft.company ? theme.successBg : theme.card }}>
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
            <div>
              <label style={label} htmlFor="je-date">Date</label>
              <input id="je-date" type="date" style={input} value={draft.date} onChange={(e) => change({ date: e.target.value })} />
            </div>
            <div>
              <label style={label} htmlFor="je-memo">Memo</label>
              <input id="je-memo" style={input} maxLength={memoMax(draft.journal)} placeholder="What it's for, as NetSuite shows it" value={draft.memo}
                onChange={(e) => change({ memo: e.target.value })} />
            </div>
          </div>
          {draft.journal === 'cpa_adjustments' && (
            <div style={muted}>NetSuite and the books show its memo starting &ldquo;{CPA_MEMO_PREFIX.trim()}&rdquo;, so it reads as the CPA&apos;s.</div>
          )}

          {draft.lines.map((l, i) => {
            const unknown = !!l.accountId && (!accounts.has(l.accountId) || !accounts.get(l.accountId)!.companies.includes(draft.company));
            return (
              <div key={l.key} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '10px', display: 'grid', gap: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                  <span style={label}>Line {i + 1}</span>
                  {draft.lines.length > 2 && (
                    <button type="button" aria-label={`Take off line ${i + 1}`} onClick={() => change({ lines: draft.lines.filter((x) => x.key !== l.key) })}
                      style={{ ...small, padding: '2px 8px', color: theme.error, borderColor: theme.errorBorder }}>✕</button>
                  )}
                </div>
                <select aria-label={`Account for line ${i + 1}`} style={{ ...input, borderColor: l.accountId && !unknown ? theme.border : theme.warningBorder }}
                  value={l.accountId} onChange={(e) => changeLine(l.key, { accountId: e.target.value })}>
                  <option value="">Pick the account</option>
                  {unknown && <option value={l.accountId}>An account {companyRow?.name ?? 'this company'} can&apos;t use</option>}
                  {groups.map((g) => (
                    <optgroup key={g.type} label={TYPE_LABELS[g.type] ?? g.type}>
                      {g.accounts.map((a) => <option key={a.id} value={a.id}>{accountName(a)}</option>)}
                    </optgroup>
                  ))}
                </select>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' }}>
                  <input aria-label={`Debit for line ${i + 1}`} inputMode="decimal" style={{ ...input, ...num }} placeholder="Debit" value={l.debit}
                    onChange={(e) => changeLine(l.key, { debit: e.target.value })} />
                  <input aria-label={`Credit for line ${i + 1}`} inputMode="decimal" style={{ ...input, ...num }} placeholder="Credit" value={l.credit}
                    onChange={(e) => changeLine(l.key, { credit: e.target.value })} />
                </div>
                <input aria-label={`Note for line ${i + 1}`} style={input} maxLength={MEMO_MAX} placeholder="Note (optional)" value={l.memo}
                  onChange={(e) => changeLine(l.key, { memo: e.target.value })} />
              </div>
            );
          })}
          <div>
            <button type="button" onClick={() => change({ lines: [...draft.lines, blankLine()] })} disabled={draft.lines.length >= MAX_LINES}
              style={{ ...small, ...(draft.lines.length >= MAX_LINES ? off : {}) }}>+ Add line</button>
          </div>
          {totals}
          {said}
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
              {savedDraft ? 'Delete draft' : 'Discard'}
            </button>
          </div>
        </div>
      ) : entry ? (
        <div style={{ ...card, display: 'grid', gap: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary, wordBreak: 'break-word' }}>{entry.memo || 'No memo'}</div>
              <div style={muted}>{[journalTag(entry), day(entry.date), companyOf(entry.company)?.name ?? entry.company].filter(Boolean).join(' · ')}</div>
            </div>
            <span style={{ fontSize: '13px', fontWeight: 800, color: STATUS[entry.status].color }}>
              {entry.status === 'made' ? `${STATUS.made.text}: ${entry.number || entry.journalId}` : STATUS[entry.status].text}
            </span>
          </div>
          <div style={muted}>
            {[entry.createdBy ? `Typed by ${entry.createdBy}` : '',
              entry.askedBy ? `asked for approval by ${entry.askedBy} ${when(entry.askedAt)}` : '',
              entry.approvedBy ? `approved by ${entry.approvedBy} ${when(entry.approvedAt)}` : ''].filter(Boolean).join(' · ')}
          </div>
          {entry.status !== 'made' && entry.error && <div style={red}>The last approval didn&apos;t make it: {entry.error}</div>}

          {entry.lines.map((l, i) => {
            const a = l.accountId ? accounts.get(l.accountId) : undefined;
            return (
              <div key={`${i}-${l.accountId}`} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '8px', display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{a ? accountName(a) : `NetSuite account ${l.accountId ?? 'not picked'}`}</div>
                  {l.memo && <div style={{ ...muted, ...twoLines }}>{l.memo}</div>}
                </div>
                <div style={{ ...num, fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>
                  {l.debitCents > 0 ? `${formatCents(l.debitCents)} Dr` : `${formatCents(l.creditCents)} Cr`}
                </div>
              </div>
            );
          })}
          {totals}
          {entry.status !== 'made' && worked && worked.problems.length > 0 && problems.length === 0 && (
            <div style={{ display: 'grid', gap: '2px' }}>{worked.problems.map((p, i) => <div key={`${i}-${p}`} style={red}>{p}</div>)}</div>
          )}
          {said}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {entry.status === 'waiting' && (
              <>
                {superAdmin && (
                  <button type="button" onClick={approve} disabled={!canApprove || busy !== null} style={{ ...green, ...(!canApprove || busy !== null ? off : {}) }}>
                    {busy === 'approve' ? 'Making it in NetSuite…' : 'Approve and make in NetSuite'}
                  </button>
                )}
                {superAdmin && (
                  <button type="button" onClick={sendBack} disabled={busy !== null} style={btn}>Send back</button>
                )}
                {canTakeBack && (
                  <button type="button" onClick={() => act('take_back', {}, () => ({ text: 'Taken back. Change it, then ask for approval again.' }))}
                    disabled={busy !== null} style={btn}>Take back to change it</button>
                )}
              </>
            )}
            {entry.status === 'sending' && superAdmin && data.switchedOn && (
              <button type="button" onClick={approve} disabled={busy !== null} style={btn}>{busy === 'approve' ? 'Asking NetSuite…' : 'Ask NetSuite'}</button>
            )}
            {entry.status === 'made' && (
              <>
                <button type="button" onClick={() => start(entry)} style={btn}>Copy</button>
                <button type="button" onClick={() => start(entry, true)} style={btn}>Reverse</button>
              </>
            )}
          </div>
          {entry.status === 'waiting' && superAdmin && mine && (
            <div style={muted}>You asked for this one, so a super admin who didn&apos;t ask approves it.</div>
          )}
          {entry.status === 'waiting' && superAdmin && !data.switchedOn && (
            <div style={muted}>Approving is switched off until journal entries are switched on.</div>
          )}
        </div>
      ) : (
        <>
          {openId && !loading && <div style={red}>There&apos;s no such journal entry: it may have been deleted.</div>}
          {said}
          <div>
            <button type="button" onClick={() => start()} style={green}>{cpaOnly ? '+ New CPA adjustment' : '+ New journal entry'}</button>
          </div>
          {section('Waiting for approval', lists.waiting)}
          {section('Being made in NetSuite', lists.sending)}
          {section('Drafts', lists.draft, lists.waiting.length + lists.made.length === 0 ? `No ${cpaOnly ? 'CPA adjustments' : 'journal entries'} yet.` : undefined)}
          {section('In NetSuite', lists.made)}
        </>
      )}
    </div>
  );
}
