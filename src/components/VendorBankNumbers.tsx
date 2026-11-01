'use client';

/**
 * Vendor bank numbers for ACH, on the Pay Vendors page (Books part 59,
 * docs/books.md "Vendor bank numbers kept encrypted").
 *
 * A super admin enters a vendor's numbers from the vendor's ACH form, and
 * they're locked on the server, waiting for a call-back. Another super admin
 * calls the vendor on a number BMG already had, has them read the numbers out
 * and types what they read: they're confirmed when it matches, and three
 * call-backs that don't match refuse them. Numbers waiting can be refused, and
 * confirmed ones removed, with why. This page only ever sees the four digits
 * an account number ends with.
 *
 * The rules are src/lib/vendor-bank.ts, and /api/pay-vendors/bank keeps the
 * numbers. Super admins only.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import {
  ACCOUNT_TYPES, BANK_STATUSES, NAME_MAX, NOTE_MAX, PHONE_MAX, SPOKE_WITH_MAX, TRIES, callBackProblems, entryProblems, maskedAccount, nameFor,
  noteProblem, type AccountType, type BankStatus,
} from '@/lib/vendor-bank';

const API = '/api/pay-vendors/bank';

/** A press that got no answer back. */
const NO_ANSWER = "FleetSuite didn't hear back, so it may have been done: reload in a minute to see.";

const box: CSSProperties = { border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '12px', display: 'grid', gap: '6px' };
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
const muted: CSSProperties = { fontSize: '12px', color: theme.textMuted };
const body: CSSProperties = { fontSize: '13px', color: theme.textSecondary };
const heading: CSSProperties = { fontSize: '15px', fontWeight: 800, color: theme.textPrimary };
const sub: CSSProperties = { fontSize: '13px', fontWeight: 800, color: theme.textPrimary, marginTop: '4px' };
const red: CSSProperties = { fontSize: '13px', color: theme.error, fontWeight: 700 };
const amber: CSSProperties = { fontSize: '13px', color: theme.warning, fontWeight: 700 };
const row: CSSProperties = { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' };
const pressed = (on: boolean): CSSProperties => ({
  ...small, borderColor: on ? theme.successBorder : theme.border, background: on ? theme.successBg : theme.card, color: on ? theme.success : theme.textPrimary,
});
/** Typed numbers: the phone's number pad, and nothing a browser offers to remember. */
const numberField = { inputMode: 'numeric', autoComplete: 'off', autoCorrect: 'off', spellCheck: false } as const;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function post(payload: Record<string, unknown>) {
  const res = await apiFetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const answer = await res.json().catch(() => ({}));
  return { ok: res.ok && !!answer.success, status: res.status, body: answer };
}

/** A set of numbers kept for a vendor, as GET /api/pay-vendors/bank shows it: the account only as its last four digits. */
interface Bank {
  id: string;
  vendorId: string;
  vendorName: string;
  routing: string;
  last4: string;
  type: AccountType;
  nameOnAccount: string;
  source: string;
  status: BankStatus;
  tries: number;
  enteredBy: string | null;
  enteredById: string | null;
  enteredAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  calledPhone: string | null;
  spokeWith: string | null;
  endedBy: string | null;
  endedAt: string | null;
  endedWhy: string | null;
  problem: string | null;
  phone: string | null;
  phoneChanged: { at: string; by: string | null } | null;
}

interface Loaded {
  keyProblem: string | null;
  me: string;
  accounts: Bank[];
  past: Bank[];
}

interface FoundVendor {
  id: string;
  name: string;
  phone: string | null;
  active: boolean;
}

interface Entry {
  /** Made when the form opens, and again when anything in it changes: the same form pressed twice is one entry. */
  id: string;
  vendor: FoundVendor | null;
  find: string;
  routing: string;
  account: string;
  accountAgain: string;
  type: AccountType | '';
  name: string;
  source: string;
}

interface Call {
  id: string;
  phone: string;
  spokeWith: string;
  routing: string;
  account: string;
  type: AccountType | '';
}

const newEntry = (vendor: FoundVendor | null = null): Entry => ({
  id: crypto.randomUUID(), vendor, find: '', routing: '', account: '', accountAgain: '', type: '', name: vendor ? nameFor(vendor.name) : '', source: '',
});

/** What a set is, in a line: checking or savings, its last four digits, the routing number and the name on it. */
const numbersLine = (b: Bank) => `${ACCOUNT_TYPES[b.type] ?? b.type} ${maskedAccount(b.last4)} · routing ${b.routing} · ${b.nameOnAccount}`;

/**
 * Makes VENDOR_BANK_KEY in this browser, for a super admin to put in Vercel: 32 random bytes as base64. Nothing is sent
 * anywhere and nothing keeps it.
 */
function KeyMaker() {
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const make = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    setMade(btoa(String.fromCharCode(...bytes)));
    setCopied(false);
  };
  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div style={{ ...box, borderColor: theme.warningBorder, background: theme.warningBg }}>
      <div style={body}>
        Make the key here once: it&apos;s made in this browser and goes nowhere until you put it in Vercel. Add it in Vercel → Settings →
        Environment Variables as VENDOR_BANK_KEY, for Production, and redeploy. Keep a copy in a password manager: without it the numbers
        can&apos;t be opened, and every vendor&apos;s are entered and confirmed again.
      </div>
      {made ? (
        <div style={row}>
          <code style={{ fontSize: '13px', wordBreak: 'break-all', color: theme.textPrimary }}>{made}</code>
          <button type="button" onClick={copy} style={small}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      ) : (
        <div><button type="button" onClick={make} style={small}>Make a key</button></div>
      )}
    </div>
  );
}

/** The vendor bank numbers kept for ACH, and entering, confirming, refusing and removing them. `focus` is a vendor to show. */
export function VendorBankPanel({ focus }: { focus?: string | null }) {
  const dialog = useDialog();
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [found, setFound] = useState<FoundVendor[]>([]);
  const [finding, setFinding] = useState(false);
  const [call, setCall] = useState<Call | null>(null);
  const [showPast, setShowPast] = useState(false);
  const shown = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(API);
      const answer = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(answer.error || `Couldn't open the vendor bank numbers (${res.status}).`);
      setData(answer as Loaded);
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't open the vendor bank numbers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // A vendor opened from an alert, once: among the past ones when that's where theirs are now.
  useEffect(() => {
    if (!focus || !data || shown.current) return;
    const ended = !data.accounts.some((b) => b.vendorId === focus) && data.past.some((b) => b.vendorId === focus);
    if (ended && !showPast) { setShowPast(true); return; }
    shown.current = true;
    document.getElementById(`bank-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focus, data, showPast]);

  // Vendors as the name is typed.
  const typed = entry && !entry.vendor ? entry.find.trim() : '';
  useEffect(() => {
    if (!typed) { setFound([]); setFinding(false); return; }
    let stale = false;
    const t = setTimeout(async () => {
      setFinding(true);
      try {
        const res = await apiFetch(`${API}?${new URLSearchParams({ find: typed })}`);
        const answer = await res.json().catch(() => ({}));
        if (!stale) setFound(res.ok ? (answer.vendors as FoundVendor[]) : []);
      } catch {
        if (!stale) setFound([]);
      } finally {
        if (!stale) setFinding(false);
      }
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [typed]);

  const clearSaid = () => { setError(null); setProblems([]); setDone(null); };
  // Anything changed makes it a new entry: pressing again repeats a press only when nothing changed in between.
  const change = (patch: Partial<Entry>) => setEntry((e) => (e ? { ...e, ...patch, id: crypto.randomUUID() } : e));
  const changeCall = (patch: Partial<Call>) => setCall((c) => (c ? { ...c, ...patch } : c));

  const live = data?.accounts ?? [];
  const waiting = live.filter((b) => b.status === 'pending');
  const confirmed = live.filter((b) => b.status === 'confirmed');
  const confirmedFor = (vendorId: string) => confirmed.find((b) => b.vendorId === vendorId) ?? null;
  // A vendor's latest past set, when none of theirs is waiting or confirmed: where an alert's link lands.
  const pastFirst = (b: Bank, i: number) => !live.some((l) => l.vendorId === b.vendorId) && data?.past.findIndex((p) => p.vendorId === b.vendorId) === i;
  const waitingFor = (vendorId: string) => waiting.find((b) => b.vendorId === vendorId) ?? null;

  const startEntry = (vendor: FoundVendor | null = null) => {
    clearSaid();
    setCall(null);
    setEntry(newEntry(vendor));
  };

  const save = async () => {
    if (!entry || busy) return;
    clearSaid();
    if (!entry.vendor) { setError('Pick the vendor these numbers are for.'); return; }
    const wrong = entryProblems(entry);
    if (wrong.length > 0) { setProblems(wrong); return; }
    setBusy('enter');
    try {
      const { ok, status, body: answer } = await post({
        action: 'enter', id: entry.id, vendorId: entry.vendor.id, routing: entry.routing, account: entry.account, accountAgain: entry.accountAgain,
        type: entry.type, name: entry.name, source: entry.source,
      });
      if (!ok) {
        if (Array.isArray(answer.problems)) setProblems(answer.problems);
        else setError(answer.error || `They weren't kept (${status}).`);
        // A set waiting for the vendor already: the list shows it.
        if (status === 409) await load();
        return;
      }
      setDone(`${entry.vendor.name}'s bank numbers are kept, locked, waiting for another super admin to call ${entry.vendor.name} and confirm them.`);
      setEntry(null);
      await load();
    } catch {
      setError(NO_ANSWER);
    } finally {
      setBusy(null);
    }
  };

  const startCall = (b: Bank) => {
    clearSaid();
    setEntry(null);
    setCall({ id: b.id, phone: b.phone ?? '', spokeWith: '', routing: '', account: '', type: '' });
  };

  const confirm = async (b: Bank) => {
    if (!call || busy) return;
    clearSaid();
    const wrong = callBackProblems(call);
    if (wrong.length > 0) { setProblems(wrong); return; }
    setBusy(`confirm-${b.id}`);
    try {
      const { ok, status, body: answer } = await post({
        action: 'confirm', id: b.id, phone: call.phone, spokeWith: call.spokeWith, routing: call.routing, account: call.account, type: call.type,
      });
      if (!ok) {
        if (Array.isArray(answer.problems)) setProblems(answer.problems);
        else setError(answer.error || `They weren't confirmed (${status}).`);
        // A try counted, or refused: the list says where they are now.
        if (status === 409) {
          if (answer.refused) setCall(null);
          await load();
        }
        return;
      }
      setDone(`Confirmed: ${b.vendorName}'s bank numbers are ${ACCOUNT_TYPES[b.type]} ${maskedAccount(b.last4)} at routing ${b.routing}.`);
      setCall(null);
      await load();
    } catch {
      setError(NO_ANSWER);
    } finally {
      setBusy(null);
    }
  };

  const end = async (b: Bank, action: 'refuse' | 'remove') => {
    if (busy) return;
    const refuse = action === 'refuse';
    const reason = await dialog.prompt(
      refuse
        ? `Nothing will be paid to the numbers ${b.enteredBy || 'someone'} entered for ${b.vendorName}. Say why: what ${b.vendorName} said, or what was wrong.`
        : `Nothing is paid to ${b.vendorName} by ACH until new numbers are entered and confirmed. Say why.`,
      '',
      {
        title: refuse ? `Refuse ${b.vendorName}'s new bank numbers` : `Remove ${b.vendorName}'s bank numbers`,
        confirmLabel: refuse ? 'Refuse them' : 'Remove them',
        placeholder: refuse ? `${b.vendorName} says they never changed banks` : 'They want checks again',
        multiline: true,
      },
    );
    if (reason === null) return;
    clearSaid();
    const wrong = noteProblem('why', reason, NOTE_MAX);
    if (wrong) { setError(wrong); return; }
    setBusy(`${action}-${b.id}`);
    try {
      const { ok, status, body: answer } = await post({ action, id: b.id, reason });
      if (!ok) { setError(answer.error || `They weren't ${refuse ? 'refused' : 'removed'} (${status}).`); return; }
      setDone(refuse ? `${b.vendorName}'s new bank numbers are refused: nothing will be paid to them.` : `${b.vendorName}'s bank numbers are removed.`);
      if (call?.id === b.id) setCall(null);
      await load();
    } catch {
      setError(NO_ANSWER);
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <div style={muted}>Opening the vendor bank numbers…</div>;
  if (!data) {
    return (
      <div style={{ display: 'grid', gap: '8px' }}>
        <div style={red}>{loadError || "Couldn't open the vendor bank numbers."}</div>
        <div><button type="button" onClick={load} style={small}>Try again</button></div>
      </div>
    );
  }

  const said = (
    <>
      {error && <div style={red}>{error}</div>}
      {problems.length > 0 && (
        <div style={{ display: 'grid', gap: '2px' }}>{problems.map((p) => <div key={p} style={red}>{p}</div>)}</div>
      )}
      {done && <div style={{ fontSize: '13px', color: theme.success, fontWeight: 700 }}>{done}</div>}
    </>
  );

  const entryForm = entry && (() => {
    const vendor = entry.vendor;
    const before = vendor ? confirmedFor(vendor.id) : null;
    const already = vendor ? waitingFor(vendor.id) : null;
    const saving = busy === 'enter';
    return (
      <div style={{ ...box, gap: '10px' }}>
        <div style={heading}>Bank numbers for a vendor</div>
        {vendor ? (
          <div style={{ display: 'grid', gap: '4px' }}>
            <div style={row}>
              <span style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{vendor.name}</span>
              <button type="button" onClick={() => change({ vendor: null, find: '', name: '' })} style={small}>Pick another</button>
            </div>
            {vendor.phone && <div style={muted}>Phone on file: {vendor.phone}</div>}
            {before && (
              <div style={body}>
                Confirmed now: {numbersLine(before)}. These replace them once they&apos;re confirmed on a call-back.
              </div>
            )}
            {already && <div style={red}>{vendor.name} has bank numbers waiting for a call-back already: confirm or refuse those first.</div>}
          </div>
        ) : (
          <div>
            <label style={label} htmlFor="vb-find">Vendor</label>
            <input id="vb-find" style={input} value={entry.find} placeholder="Find the vendor by name" autoComplete="off"
              onChange={(e) => change({ find: e.target.value })} />
            {finding && <div style={muted}>Looking…</div>}
            {found.length > 0 && (
              <div style={{ display: 'grid', gap: '4px', marginTop: '6px' }}>
                {found.map((v) => (
                  <button key={v.id} type="button" onClick={() => change({ vendor: v, find: '', name: nameFor(v.name) })}
                    style={{ ...btn, textAlign: 'left', fontWeight: 600 }}>
                    {v.name}{v.active ? '' : ' (inactive)'}
                    {v.phone && <span style={{ ...muted, marginLeft: '8px' }}>{v.phone}</span>}
                  </button>
                ))}
              </div>
            )}
            {!finding && entry.find.trim() && found.length === 0 && <div style={muted}>No vendor by that name in FleetSuite&apos;s copy of NetSuite&apos;s vendors.</div>}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 160px' }}>
            <label style={label} htmlFor="vb-routing">Routing number</label>
            <input id="vb-routing" style={input} value={entry.routing} {...numberField} placeholder="9 digits" maxLength={20}
              onChange={(e) => change({ routing: e.target.value })} />
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label style={label} htmlFor="vb-account">Account number</label>
            <input id="vb-account" style={input} value={entry.account} {...numberField} maxLength={30}
              onChange={(e) => change({ account: e.target.value })} />
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label style={label} htmlFor="vb-again">Account number again</label>
            <input id="vb-again" style={input} value={entry.accountAgain} {...numberField} maxLength={30}
              onChange={(e) => change({ accountAgain: e.target.value })} />
          </div>
        </div>
        <div>
          <span style={label}>Checking or savings</span>
          <div style={row}>
            {(Object.keys(ACCOUNT_TYPES) as AccountType[]).map((t) => (
              <button key={t} type="button" onClick={() => change({ type: t })} aria-pressed={entry.type === t} style={pressed(entry.type === t)}>
                {ACCOUNT_TYPES[t]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label style={label} htmlFor="vb-name">Name on the account</label>
          <input id="vb-name" style={input} value={entry.name} maxLength={NAME_MAX} autoComplete="off" onChange={(e) => change({ name: e.target.value })} />
        </div>
        <div>
          <label style={label} htmlFor="vb-source">Where the numbers came from</label>
          <input id="vb-source" style={input} value={entry.source} maxLength={NOTE_MAX} autoComplete="off"
            placeholder="ACH form emailed by Dana at Ozark, 10/30" onChange={(e) => change({ source: e.target.value })} />
        </div>
        <div style={row}>
          <button type="button" onClick={save} disabled={saving || !!already} style={{ ...green, ...(saving || already ? off : {}) }}>
            {saving ? 'Keeping them…' : 'Save for a call-back'}
          </button>
          <button type="button" onClick={() => { setEntry(null); clearSaid(); }} disabled={saving} style={btn}>Leave without saving</button>
        </div>
      </div>
    );
  })();

  const callForm = (b: Bank) => {
    if (!call || call.id !== b.id) return null;
    const confirming = busy === `confirm-${b.id}`;
    return (
      <div style={{ ...box, gap: '10px', marginTop: '4px' }}>
        <div style={body}>
          Ask {b.vendorName} to read out the routing number and the account number they want paid, and type what they read: don&apos;t read
          them yours.
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 180px' }}>
            <label style={label} htmlFor={`vb-phone-${b.id}`}>Phone you called them on</label>
            <input id={`vb-phone-${b.id}`} style={input} value={call.phone} maxLength={PHONE_MAX} autoComplete="off" inputMode="tel"
              onChange={(e) => changeCall({ phone: e.target.value })} />
          </div>
          <div style={{ flex: '1 1 180px' }}>
            <label style={label} htmlFor={`vb-spoke-${b.id}`}>Who read them out</label>
            <input id={`vb-spoke-${b.id}`} style={input} value={call.spokeWith} maxLength={SPOKE_WITH_MAX} autoComplete="off" placeholder="Dana in accounts"
              onChange={(e) => changeCall({ spokeWith: e.target.value })} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 160px' }}>
            <label style={label} htmlFor={`vb-read-routing-${b.id}`}>Routing number they read</label>
            <input id={`vb-read-routing-${b.id}`} style={input} value={call.routing} {...numberField} maxLength={20}
              onChange={(e) => changeCall({ routing: e.target.value })} />
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label style={label} htmlFor={`vb-read-account-${b.id}`}>Account number they read</label>
            <input id={`vb-read-account-${b.id}`} style={input} value={call.account} {...numberField} maxLength={30}
              onChange={(e) => changeCall({ account: e.target.value })} />
          </div>
        </div>
        <div>
          <span style={label}>Checking or savings, as they said</span>
          <div style={row}>
            {(Object.keys(ACCOUNT_TYPES) as AccountType[]).map((t) => (
              <button key={t} type="button" onClick={() => changeCall({ type: t })} aria-pressed={call.type === t} style={pressed(call.type === t)}>
                {ACCOUNT_TYPES[t]}
              </button>
            ))}
          </div>
        </div>
        <div style={row}>
          <button type="button" onClick={() => confirm(b)} disabled={confirming} style={{ ...green, ...(confirming ? off : {}) }}>
            {confirming ? 'Checking…' : 'Confirm'}
          </button>
          <button type="button" onClick={() => { setCall(null); clearSaid(); }} disabled={confirming} style={btn}>Leave without saving</button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      {data.keyProblem && (
        <>
          <div style={red}>{data.keyProblem}</div>
          <KeyMaker />
        </>
      )}
      {said}
      {!entry && (
        <div>
          <button type="button" onClick={() => startEntry()} disabled={!!data.keyProblem} style={{ ...green, ...(data.keyProblem ? off : {}) }}>
            + Bank numbers for a vendor
          </button>
        </div>
      )}
      {entryForm}

      <div style={sub}>Waiting for a call-back</div>
      {waiting.length === 0 && <div style={muted}>None waiting.</div>}
      {waiting.map((b) => {
        const mine = b.enteredById === data.me;
        return (
          <div key={b.id} id={`bank-${b.vendorId}`} style={{ ...box, ...(focus === b.vendorId ? { borderColor: theme.warningBorder } : {}) }}>
            <div style={heading}>{b.vendorName}</div>
            <div style={body}>{numbersLine(b)}</div>
            <div style={muted}>Entered by {b.enteredBy || 'someone'} {when(b.enteredAt)}, from: {b.source}</div>
            {b.tries > 0 && (
              <div style={amber}>
                {plural(b.tries, 'call-back')} didn&apos;t match: {plural(TRIES - b.tries, 'more try', 'more tries')} before they&apos;re refused.
              </div>
            )}
            {b.problem && <div style={red}>{b.problem}</div>}
            {mine ? (
              <div style={muted}>Another super admin calls {b.vendorName} and confirms them.</div>
            ) : (
              <>
                <div style={body}>
                  Call {b.vendorName} on a number BMG already had, not one from the form or email that sent these. Phone on file: {b.phone || 'none'}.
                </div>
                {b.phoneChanged && (
                  <div style={red}>
                    The phone on file was changed in FleetSuite {when(b.phoneChanged.at)} by {b.phoneChanged.by || 'someone'}: call a number you had before that.
                  </div>
                )}
              </>
            )}
            <div style={row}>
              {!mine && call?.id !== b.id && (
                <button type="button" onClick={() => startCall(b)} disabled={!!data.keyProblem || !!b.problem}
                  style={{ ...small, ...(data.keyProblem || b.problem ? off : {}) }}>
                  Confirm on a call-back
                </button>
              )}
              <button type="button" onClick={() => end(b, 'refuse')} disabled={busy !== null} style={redSmall}>Refuse</button>
            </div>
            {callForm(b)}
          </div>
        );
      })}

      <div style={sub}>Confirmed</div>
      {confirmed.length === 0 && <div style={muted}>No vendor&apos;s bank numbers are confirmed yet.</div>}
      {confirmed.map((b) => (
        <div key={b.id} id={waitingFor(b.vendorId) ? undefined : `bank-${b.vendorId}`} style={box}>
          <div style={heading}>{b.vendorName}</div>
          <div style={body}>{numbersLine(b)}</div>
          <div style={muted}>
            Confirmed by {b.confirmedBy || 'someone'} {when(b.confirmedAt)}: called {b.calledPhone}, and {b.spokeWith} read them out. Entered by{' '}
            {b.enteredBy || 'someone'}.
          </div>
          {b.problem && <div style={red}>{b.problem}</div>}
          <div style={row}>
            {!waitingFor(b.vendorId) && !entry && (
              <button type="button" onClick={() => startEntry({ id: b.vendorId, name: b.vendorName, phone: null, active: true })}
                disabled={!!data.keyProblem} style={{ ...small, ...(data.keyProblem ? off : {}) }}>
                New numbers
              </button>
            )}
            <button type="button" onClick={() => end(b, 'remove')} disabled={busy !== null} style={redSmall}>Remove</button>
          </div>
        </div>
      ))}

      {data.past.length > 0 && (
        <div style={{ display: 'grid', gap: '6px' }}>
          <div>
            <button type="button" onClick={() => setShowPast((v) => !v)} aria-expanded={showPast} style={small}>
              {showPast ? 'Hide past ones' : `Past ones (${data.past.length})`}
            </button>
          </div>
          {showPast && data.past.map((b, i) => (
            <div key={b.id} id={pastFirst(b, i) ? `bank-${b.vendorId}` : undefined}
              style={{ ...muted, fontSize: '13px', ...(focus === b.vendorId && pastFirst(b, i) ? { color: theme.warning } : {}) }}>
              <span style={{ fontWeight: 700, color: theme.textSecondary }}>{b.vendorName}</span> {ACCOUNT_TYPES[b.type] ?? b.type} {maskedAccount(b.last4)} ·
              routing {b.routing}: {BANK_STATUSES[b.status]} {when(b.endedAt)}{b.endedBy ? ` by ${b.endedBy}` : ''}{b.endedWhy ? `: ${b.endedWhy}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
