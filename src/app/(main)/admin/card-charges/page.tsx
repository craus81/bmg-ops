'use client';

/**
 * Chase card charges, coded in FleetSuite and sent to NetSuite as one
 * journal entry a month (Books part 36, docs/books.md "Card charges coded in
 * FleetSuite"; owner decisions 2026-10-31: from January 1, 2027 the team
 * works only in FleetSuite, apart from payments). Opened from More → Money &
 * Books → Card Charges.
 *
 * Add the card's activity as Chase downloads it (CSV), give each charge its
 * account (a merchant's charges come in with the account its charges last
 * went to), Save, then Send a month. The rules are src/lib/card-charges.ts,
 * the same ones /api/card-charges makes the journal entry by. Built switched
 * off (Books → Switches): until it's on, super admins can add and code
 * charges to see what a send would make, and nothing goes to NetSuite.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import TopSaveBar from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import {
  MEMO_MAX, accountName, byDateThenId, formatCents, monthName, workOutCardEntry,
  type CardAccount, type CardCharge, type CardCompany,
} from '@/lib/card-charges';

const API = '/api/card-charges';

interface Charge extends CardCharge {
  postDate: string | null;
  merchantKey: string;
  category: string | null;
  type: string | null;
  remembered: boolean;
}

interface Send {
  id: string;
  month: string;
  date: string | null;
  count: number | null;
  netCents: number | null;
  totalCents: number | null;
  state: 'made' | 'making' | 'refused';
  journalId: string | null;
  number: string | null;
  error: string | null;
  at: string;
}

interface FileAdded {
  id: string;
  fileName: string | null;
  charges: number;
  added: number;
  already: number;
  remembered: number;
  payments: number;
  unsent: number;
  at: string;
}

interface Loaded {
  companies: CardCompany[];
  company: string | null;
  cardAccounts: CardAccount[];
  accounts: CardAccount[];
  cardId: string | null;
  charges: Charge[];
  sends: Send[];
  imports: FileAdded[];
  firstSendMonth: string;
  maxPerEntry: number;
  switchedOn: boolean;
  offText: string | null;
}

/** What's been changed on a charge and not saved yet. */
interface Edit { accountId: string; memo: string }

const TYPE_LABELS: Record<string, string> = {
  expense: 'Expenses',
  cost_of_goods_sold: 'Cost of goods sold',
  other_expense: 'Other expenses',
  other_current_asset: 'Other current assets',
  fixed_asset: 'Fixed assets',
  other_asset: 'Other assets',
  deferred_expense: 'Deferred expenses',
  other_current_liability: 'Other current liabilities',
  long_term_liability: 'Long-term liabilities',
};

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

const day = (ymd: string | null) => (ymd ? new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
const small: React.CSSProperties = { ...btn, padding: '6px 10px', fontSize: '13px' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const muted: React.CSSProperties = { fontSize: '12px', color: theme.textMuted };
const heading: React.CSSProperties = { fontSize: '15px', fontWeight: 800, color: theme.textPrimary };
const chip: React.CSSProperties = {
  display: 'inline-block', fontSize: '11px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px',
  border: `1px solid ${theme.successBorder}`, background: theme.successBg, color: theme.success,
};
/** Two lines at most, so a long description doesn't push the boxes off the screen. */
const twoLines: React.CSSProperties = {
  overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};

export default function CardChargesPage() {
  const router = useRouter();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();

  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [addProblems, setAddProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  /** One id per month's Send, kept until it's made, so pressing again or trying again is one journal entry. */
  const [sendIds, setSendIds] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<{ month: string; text: string; warning?: string } | null>(null);
  const [sendError, setSendError] = useState<{ month: string; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const allowed = !authLoading && hasFeature('vendor_payments') && canSeeMoney;

  const load = useCallback(async (pick?: { company?: string; card?: string }) => {
    setLoading(true);
    setLoadError(null);
    try {
      const q = new URLSearchParams();
      if (pick?.company) q.set('company', pick.company);
      if (pick?.card) q.set('card', pick.card);
      const res = await apiFetch(q.toString() ? `${API}?${q}` : API);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't open card charges (${res.status}).`);
      setData(body as Loaded);
      setEdits({});
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't open card charges.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  const accounts = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.id, a])), [data]);
  const originals = useMemo(() => new Map((data?.charges ?? []).map((c) => [c.id, c])), [data]);
  const companyRow = data?.companies.find((c) => c.code === data.company);
  const cardRow = data?.cardAccounts.find((c) => c.id === data.cardId);

  // The charges as they'd be kept once the changes are saved.
  const charges: Charge[] = useMemo(() => (data?.charges ?? []).map((c) => {
    const e = edits[c.id];
    return e ? { ...c, accountId: e.accountId || null, memo: e.memo.trim() || null } : c;
  }), [data, edits]);
  const changed = Object.keys(edits).length;

  const months = useMemo(() => {
    const by = new Map<string, Charge[]>();
    for (const c of charges) {
      const m = c.date.slice(0, 7);
      by.set(m, [...(by.get(m) ?? []), c]);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, list]) => {
      const sorted = [...list].sort(byDateThenId);
      const next = sorted.slice(0, data?.maxPerEntry ?? 250);
      return {
        month,
        charges: sorted,
        next,
        netCents: sorted.reduce((s, c) => s + c.cents, 0),
        uncoded: sorted.filter((c) => !c.accountId).length,
        worked: workOutCardEntry(next, { company: companyRow, cardAccount: cardRow, accounts }),
      };
    });
  }, [charges, data, companyRow, cardRow, accounts]);

  const groups = useMemo(() => {
    const out: Array<{ type: string; accounts: CardAccount[] }> = [];
    for (const a of data?.accounts ?? []) {
      if (a.id === data?.cardId) continue;
      const g = out.find((x) => x.type === a.type) ?? out[out.push({ type: a.type, accounts: [] }) - 1];
      g.accounts.push(a);
    }
    return out;
  }, [data]);

  /** Changes one charge, against what's kept for it; back to what's kept, it's no change at all. */
  const edit = (id: string, p: Partial<Edit>) => {
    const c = originals.get(id);
    if (!c) return;
    setSaveError(null);
    setEdits((prev) => {
      const now = { accountId: prev[id]?.accountId ?? c.accountId ?? '', memo: prev[id]?.memo ?? c.memo ?? '', ...p };
      const next = { ...prev, [id]: now };
      if (now.accountId === (c.accountId ?? '') && now.memo.trim() === (c.memo ?? '')) delete next[id];
      // An account picked for one charge fills in the merchant's other charges that have none yet.
      if (p.accountId && c.merchantKey) {
        for (const o of data?.charges ?? []) {
          if (o.id === id || o.merchantKey !== c.merchantKey || o.accountId || next[o.id]?.accountId) continue;
          next[o.id] = { accountId: p.accountId, memo: next[o.id]?.memo ?? o.memo ?? '' };
        }
      }
      return next;
    });
  };

  const save = async () => {
    if (!data?.cardId || !data.company || changed === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'code', company: data.company, cardId: data.cardId,
          changes: Object.entries(edits).map(([id, e]) => ({ id, accountId: e.accountId || null, memo: e.memo })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || `The changes weren't saved (${res.status}).`);
      await load({ company: data.company, card: data.cardId });
    } catch (e: any) {
      setSaveError(e?.message || "The changes weren't saved.");
    } finally {
      setSaving(false);
    }
  };

  const addFile = async (f: File | undefined) => {
    if (!f || !data?.cardId || !data.company) return;
    if (changed > 0) { setAddProblems(['Save your changes first, then add the file.']); return; }
    setAdding(true);
    setAdded(null);
    setAddProblems([]);
    try {
      const csv = await f.text();
      const res = await apiFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', importId: newId(), company: data.company, cardId: data.cardId, fileName: f.name, csv }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        setAddProblems(body.problems?.length ? body.problems : [body.error || `The file wasn't added (${res.status}).`]);
        return;
      }
      const said = [`Added ${plural(body.added, 'charge')}.`];
      if (body.already > 0) said.push(`${body.already} ${body.already === 1 ? 'was' : 'were'} here already.`);
      if (body.remembered > 0) said.push(`${body.remembered} came in coded to the merchant's account.`);
      if (body.payments > 0) {
        said.push(`${plural(body.payments, 'payment')} to the card left out: ${body.payments === 1 ? "it's" : "they're"} entered from the bank in NetSuite.`);
      }
      setAdded(said.join(' '));
      await load({ company: data.company, card: data.cardId });
    } catch (e: any) {
      setAddProblems([e?.message || "The file wasn't added."]);
    } finally {
      setAdding(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const undo = async (f: FileAdded) => {
    if (!data) return;
    const ok = await dialog.confirm(
      `Take ${plural(f.unsent, 'charge')} from ${f.fileName || 'this file'} back off? Charges already sent to NetSuite stay.`,
      { confirmLabel: 'Take them off', title: 'Undo a file' },
    );
    if (!ok) return;
    try {
      const res = await apiFetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'undo', importId: f.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || `Nothing was taken off (${res.status}).`);
      setAdded(`Took ${plural(body.removed, 'charge')} back off.`);
      await load({ company: data.company ?? undefined, card: data.cardId ?? undefined });
    } catch (e: any) {
      setAddProblems([e?.message || 'Nothing was taken off.']);
    }
  };

  const sendMonth = async (m: (typeof months)[number], again?: Send) => {
    if (!data?.cardId || !data.company) return;
    const sendId = again?.id ?? sendIds[m.month] ?? newId();
    if (!again) {
      const w = m.worked;
      const ok = await dialog.confirm(
        `Send ${monthName(m.month)}'s ${plural(w.chargeCount, 'charge')} to NetSuite as one journal entry dated ${day(w.date)}, `
          + `putting ${formatCents(w.netCents)} on ${cardRow ? accountName(cardRow) : 'the card'}?`
          + (m.charges.length > m.next.length ? ` The other ${m.charges.length - m.next.length} go in the next one.` : ''),
        { confirmLabel: 'Send to NetSuite', title: 'Send card charges' },
      );
      if (!ok) return;
    }
    setSendIds((prev) => ({ ...prev, [m.month]: sendId }));
    setSending(m.month);
    setSendError(null);
    setSent(null);
    try {
      const res = await apiFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send', sendId, company: data.company, cardId: data.cardId, month: m.month,
          ...(again ? {} : { expectedCount: m.worked.chargeCount, expectedTotalCents: m.worked.netCents }),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        // Unless NetSuite might have made it, the next press is a new send.
        if (!body.unsure) setSendIds((prev) => { const next = { ...prev }; delete next[m.month]; return next; });
        throw new Error(body.error || `NetSuite didn't make the journal entry (${res.status}).`);
      }
      setSendIds((prev) => { const next = { ...prev }; delete next[m.month]; return next; });
      setSent({
        month: m.month,
        text: `Journal entry ${body.number || body.journalId} ${body.already ? 'was already made' : 'made'} in NetSuite for ${monthName(m.month)}: `
          + `${plural(body.count ?? 0, 'charge')}, ${formatCents(body.totalCents ?? 0)}.`,
        warning: body.warning,
      });
      await load({ company: data.company, card: data.cardId });
    } catch (e: any) {
      setSendError({ month: m.month, text: e?.message || "NetSuite didn't make the journal entry." });
    } finally {
      setSending(null);
    }
  };

  const askAgain = (s: Send) => {
    const m = months.find((x) => x.month === s.month)
      ?? { month: s.month, charges: [], next: [], netCents: 0, uncoded: 0, worked: workOutCardEntry([], { company: companyRow, cardAccount: cardRow, accounts }) };
    return sendMonth(m, s);
  };

  if (!authLoading && (!hasFeature('vendor_payments') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Payments permission and price access to code card charges.</div>;
  }

  const back = () => router.push('/more');

  return (
    <div style={{ maxWidth: '860px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {changed > 0 && (
        <TopSaveBar
          title="Card charges"
          subtitle={plural(changed, 'change')}
          error={saveError || undefined}
          onSave={save}
          saving={saving}
          saveLabel="Save"
          savingLabel="Saving…"
          onCancel={() => { setEdits({}); setSaveError(null); }}
          cancelLabel="Undo changes"
        />
      )}
      <div>
        <button onClick={back} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>← More</button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Card charges</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>The Chase card&apos;s charges, coded here and sent to NetSuite as one journal entry a month.</div>
      </div>

      {data?.offText && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {loading && !data ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Opening card charges…</div>
      ) : loadError || !data ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{loadError || "Couldn't open card charges."}</div>
          <div><button onClick={() => load()} style={btn}>Try again</button></div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '12px' }}>
            {data.companies.length > 1 && (
              <div>
                <div style={label}>Company</div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {data.companies.map((c) => (
                    <button key={c.code} type="button" aria-pressed={c.code === data.company} disabled={changed > 0}
                      onClick={() => load({ company: c.code })}
                      style={{ ...small, borderColor: c.code === data.company ? theme.successBorder : theme.border, background: c.code === data.company ? theme.successBg : theme.card }}>
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label style={label} htmlFor="cc-card">Card account</label>
              {data.cardAccounts.length === 0 ? (
                <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>
                  {companyRow?.name ?? 'This company'} has no credit card account in NetSuite&apos;s chart in Books yet.
                </div>
              ) : (
                <select id="cc-card" style={input} value={data.cardId ?? ''} disabled={changed > 0}
                  onChange={(e) => load({ company: data.company ?? undefined, card: e.target.value })}>
                  {data.cardAccounts.map((a) => <option key={a.id} value={a.id}>{accountName(a)}</option>)}
                </select>
              )}
            </div>

            {data.cardId && (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); addFile(e.dataTransfer.files?.[0]); }}
                style={{
                  border: `2px dashed ${dragging ? theme.successBorder : theme.border}`, borderRadius: '10px', padding: '14px',
                  display: 'grid', gap: '8px', background: dragging ? theme.successBg : 'transparent',
                }}>
                <div style={heading}>Add the card&apos;s charges</div>
                <div style={{ fontSize: '13px', color: theme.textSecondary, lineHeight: 1.5 }}>
                  In Chase, open the card, choose Download account activity, pick CSV, and drop the file here. A charge that&apos;s here
                  already is only kept once, and payments to the card are left out.
                </div>
                <div>
                  <input ref={fileRef} type="file" accept=".csv,text/csv" disabled={adding} onChange={(e) => addFile(e.target.files?.[0])} />
                </div>
                {adding && <div style={muted}>Reading the file…</div>}
                {added && <div style={{ fontSize: '13px', color: theme.success, fontWeight: 700 }}>{added}</div>}
                {addProblems.length > 0 && (
                  <div style={{ fontSize: '13px', color: theme.error, display: 'grid', gap: '2px' }}>
                    {addProblems.map((p, i) => <div key={`${i}-${p}`} style={{ fontWeight: i === 0 ? 700 : 400 }}>{p}</div>)}
                  </div>
                )}
              </div>
            )}
          </div>

          {sent && (
            <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '6px' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: theme.success }}>{sent.text}</div>
              {sent.warning && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{sent.warning}</div>}
            </div>
          )}

          {data.cardId && months.length === 0 && (
            <div style={{ ...card, ...muted, fontSize: '14px' }}>No charges waiting. Add the card&apos;s activity from Chase to code it.</div>
          )}

          {months.map((m) => {
            const early = m.month < data.firstSendMonth;
            const problems = m.worked.problems.filter((p) => !/no account yet/.test(p));
            const canSend = data.switchedOn && !early && changed === 0 && m.worked.problems.length === 0 && sending === null;
            return (
              <div key={m.month} style={{ ...card, display: 'grid', gap: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>{monthName(m.month)}</div>
                    <div style={muted}>
                      {plural(m.charges.length, 'charge')} · {formatCents(m.netCents)}
                      {' · '}
                      <span style={{ color: m.uncoded > 0 ? theme.warning : theme.success, fontWeight: 700 }}>
                        {m.uncoded > 0 ? `${m.uncoded} to code` : 'All coded'}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => sendMonth(m)} disabled={!canSend}
                    style={{ ...btn, ...(canSend ? { background: theme.successBg, borderColor: theme.successBorder, color: theme.success } : { opacity: 0.6, cursor: 'default' }) }}>
                    {sending === m.month ? 'Sending…' : !data.switchedOn ? 'Switched off' : `Send ${monthName(m.month).split(' ')[0]}`}
                  </button>
                </div>
                {early ? (
                  <div style={muted}>
                    Before {monthName(data.firstSendMonth)}, the card&apos;s charges are on the bookkeeper&apos;s journal entries in NetSuite, so these
                    can&apos;t be sent. Undo the file below to clear them.
                  </div>
                ) : changed > 0 ? (
                  <div style={muted}>Save your changes before sending.</div>
                ) : m.charges.length > m.next.length ? (
                  <div style={muted}>One journal entry takes {m.next.length}; the oldest {m.next.length} go first and the rest in the next.</div>
                ) : null}
                {!early && problems.length > 0 && (
                  <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700, display: 'grid', gap: '2px' }}>
                    {problems.map((p, i) => <div key={`${i}-${p}`}>{p}</div>)}
                  </div>
                )}
                {sendError?.month === m.month && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{sendError.text}</div>}

                {m.charges.map((c) => {
                  const e = edits[c.id];
                  const accountId = c.accountId ?? '';
                  const unknown = accountId && !accounts.has(accountId);
                  return (
                    <div key={c.id} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '10px', display: 'grid', gap: '6px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ ...twoLines, fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{c.description}</div>
                          <div style={muted}>
                            {[day(c.date), c.category, c.card ? `card ${c.card}` : '', c.cents < 0 ? 'Money back' : ''].filter(Boolean).join(' · ')}
                            {c.remembered && !e && <> {' '}<span style={chip}>Remembered</span></>}
                          </div>
                        </div>
                        <div style={{ ...num, fontSize: '15px', fontWeight: 800, color: c.cents < 0 ? theme.success : theme.textPrimary }}>
                          {formatCents(c.cents)}
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px' }}>
                        <select aria-label={`Account for ${c.description} on ${day(c.date)}`} style={{ ...input, borderColor: accountId ? theme.border : theme.warningBorder }}
                          value={accountId} onChange={(ev) => edit(c.id, { accountId: ev.target.value })}>
                          <option value="">Pick the account</option>
                          {unknown && <option value={accountId}>An account FleetSuite can&apos;t use</option>}
                          {groups.map((g) => (
                            <optgroup key={g.type} label={TYPE_LABELS[g.type] ?? g.type}>
                              {g.accounts.map((a) => <option key={a.id} value={a.id}>{accountName(a)}</option>)}
                            </optgroup>
                          ))}
                        </select>
                        <input aria-label={`Note for ${c.description} on ${day(c.date)}`} style={input} maxLength={MEMO_MAX} placeholder="Note (optional)"
                          value={e ? e.memo : c.memo ?? ''} onChange={(ev) => edit(c.id, { memo: ev.target.value })} />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {data.sends.length > 0 && (
            <div style={{ ...card, display: 'grid', gap: '8px' }}>
              <div style={heading}>Sent to NetSuite</div>
              {data.sends.map((s) => (
                <div key={s.id} style={{ display: 'grid', gap: '2px', fontSize: '13px', color: theme.textPrimary }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                    <span style={{ minWidth: 0 }}>
                      <b>{monthName(s.month)}</b>
                      <span style={{ color: theme.textMuted }}>
                        {' · '}{[s.number || (s.journalId ? `NetSuite ${s.journalId}` : ''), s.count != null ? plural(s.count, 'charge') : '', when(s.at)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span style={num}>{s.netCents != null ? formatCents(s.netCents) : ''}</span>
                  </div>
                  <div style={{ ...muted, color: s.state === 'refused' ? theme.error : theme.textMuted, fontWeight: s.state === 'refused' ? 700 : 400 }}>
                    {s.state === 'made' ? 'Journal entry made in NetSuite'
                      : s.state === 'making' ? `Being sent${s.error ? `: ${s.error}` : ''}`
                        : `Not sent: ${s.error || 'no reason given'}`}
                  </div>
                  {s.state === 'making' && data.switchedOn && (
                    <div>
                      <button onClick={() => askAgain(s)} disabled={sending !== null} style={small}>Ask NetSuite</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {data.imports.length > 0 && (
            <div style={{ ...card, display: 'grid', gap: '8px' }}>
              <div style={heading}>Files added</div>
              {data.imports.map((f) => (
                <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', fontSize: '13px', color: theme.textPrimary }}>
                  <span style={{ minWidth: 0 }}>
                    <b style={{ wordBreak: 'break-word' }}>{f.fileName || 'Chase download'}</b>
                    <span style={{ color: theme.textMuted }}>
                      {' · '}{[when(f.at), `${f.added} added`, f.already > 0 ? `${f.already} already here` : '', f.unsent > 0 ? `${f.unsent} not sent` : ''].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {f.unsent > 0 && (
                    <button onClick={() => undo(f)} disabled={changed > 0} style={{ ...small, color: theme.error, borderColor: theme.errorBorder }}>Undo</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
