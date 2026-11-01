'use client';

/**
 * The ACH file for First Bank, on the Pay Vendors page (Books part 60,
 * docs/books.md "The ACH file for First Bank").
 *
 * RunAchFile is an approved run's ACH payments. Once each is made in NetSuite
 * as a bill payment, tick the ones to pay and make the file: each is paid to
 * the vendor's bank numbers confirmed on a call-back (part 59), with the bills
 * it pays listed for the vendor, and First Bank pays them on the run's day, or
 * the first banking day it can. Download the file, upload it to First Bank,
 * and mark it uploaded; or set it aside with why, when First Bank refused it
 * or it was never sent, and its payments can go in a new file.
 *
 * AchSetupPanel is how First Bank takes the file, a bank account at a time,
 * typed or read from NetSuite's last ACH file for the account. NetSuite's file
 * is read here in the browser, and only how it starts is kept: never a
 * vendor's numbers, and BMG's account for the debit that offsets the payments,
 * when First Bank wants one, is typed from BMG's own records.
 *
 * Super admins only: the file holds whole account numbers. The rules are
 * src/lib/ach-file.ts, and /api/pay-vendors/ach makes the file.
 */

import { useCallback, useEffect, useState, type ChangeEvent, type CSSProperties } from 'react';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { useFileDownload } from '@/lib/use-file-download';
import {
  BANK_NAME_DEFAULT, BANK_NAME_MAX, COMPANY_NAME_MAX, DESCRIPTION_DEFAULT, DESCRIPTION_MAX, ORIGIN_NAME_MAX, WHY_MAX, formatCents, readAchFile,
  setupProblems, type SetupTyped,
} from '@/lib/ach-file';
import { ACCOUNT_TYPES, accountProblem, digitsOf, isAccountType, maskedAccount, noteProblem, routingProblem } from '@/lib/vendor-bank';

const API = '/api/pay-vendors/ach';

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
const typeName = (type: string) => (isAccountType(type) ? ACCOUNT_TYPES[type] : type);

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

async function post(payload: Record<string, unknown>) {
  const res = await apiFetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !!body.success, status: res.status, body };
}

/** How a bank account's file starts, as the route shows it: BMG's account only as routing number, last four and type. */
interface SetupShown extends SetupTyped {
  offset: { routing: string; last4: string; type: string } | null;
  offsetProblem: string | null;
  problems: string[];
  updatedBy: string | null;
  updatedAt: string;
}

/** How the setup reads on the run, in a line. */
const setupLine = (s: SetupShown) => [
  `${s.secCode} to ${s.destinationName}`,
  s.addenda ? 'bills listed for each vendor' : 'no bills listed',
  s.balanced && s.offset ? `balanced by a debit to ${typeName(s.offset.type)} ${maskedAccount(s.offset.last4)}` : 'payments only',
].join(' · ');

/** A vendor the run pays by ACH (GET /api/pay-vendors/ach?run=). */
interface AchPayment {
  paymentId: string;
  vendorName: string;
  totalCents: number;
  paymentStatus: string;
  bank: { last4: string; type: string; routing: string; nameOnAccount: string } | null;
  /** The file it's in, not set aside. */
  fileId: string | null;
  /** Why it can't go in a file now. */
  why: string | null;
}

type FileStatus = 'made' | 'sent' | 'set_aside';

interface AchFileShown {
  id: string;
  fileName: string;
  status: FileStatus;
  pays: { day: string; text: string };
  entryCount: number;
  totalCents: number;
  madeBy: string | null;
  madeAt: string;
  downloads: number;
  downloadedBy: string | null;
  sentBy: string | null;
  sentAt: string | null;
  setAsideBy: string | null;
  setAsideAt: string | null;
  setAsideWhy: string | null;
  payments: Array<{ vendorName: string; cents: number; last4: string; type: string }>;
  /** Waiting to be uploaded on or after the day it pays. */
  late: boolean;
  /** A vendor's numbers in it replaced or removed since it was made. */
  problem: string | null;
}

interface AchLoaded {
  run: { id: string; company: string; accountId: string; accountName: string | null; status: string; payDate: string };
  setup: SetupShown | null;
  keyProblem: string | null;
  /** The day First Bank pays a file made now. */
  pays: { day: string; text: string };
  payments: AchPayment[];
  files: AchFileShown[];
  switchedOn: boolean;
}

const FILE_STATUS: Record<FileStatus, (f: AchFileShown) => { text: string; color: string }> = {
  made: (f) => ({
    text: f.downloads > 0
      ? `Downloaded ${plural(f.downloads, 'time')}${f.downloadedBy ? `, last by ${f.downloadedBy}` : ''}: upload it to First Bank`
      : 'Made: download it and upload it to First Bank',
    color: theme.warning,
  }),
  sent: (f) => ({ text: `Uploaded to First Bank${f.sentBy ? ` by ${f.sentBy}` : ''}${f.sentAt ? ` ${when(f.sentAt)}` : ''}`, color: theme.success }),
  set_aside: (f) => ({
    text: `Set aside${f.setAsideBy ? ` by ${f.setAsideBy}` : ''}${f.setAsideAt ? ` ${when(f.setAsideAt)}` : ''}${f.setAsideWhy ? `: ${f.setAsideWhy}` : ''}`,
    color: theme.textMuted,
  }),
};

/** An approved run's ACH payments: the file made from them for First Bank, downloaded, uploaded, or set aside. */
export function RunAchFile({ runId, madeKey }: { runId: string; madeKey: string }) {
  const dialog = useDialog();
  const [loaded, setLoaded] = useState<AchLoaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Every payment that can go in a file starts ticked.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  // The press that makes the next file: pressed twice, it's one file.
  const [pressId, setPressId] = useState(newId);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [settingUp, setSettingUp] = useState(false);
  const files = useFileDownload(useCallback((m: string) => { setError(m); setDone(null); }, []));

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`${API}?run=${encodeURIComponent(runId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the run's ACH payments (${res.status}).`);
      setLoaded(body as AchLoaded);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the run's ACH payments.");
    }
  }, [runId]);

  // Again whenever the run's bill payments change: a payment goes in the file once its bill payment is made.
  useEffect(() => { load(); }, [load, madeKey]);

  const clearSaid = () => { setDone(null); setError(null); setProblems([]); };

  if (!loaded) {
    return (
      <div style={{ ...card, display: 'grid', gap: '8px' }}>
        <div style={heading}>ACH file for First Bank</div>
        {loadError ? (
          <>
            <div style={red}>{loadError}</div>
            <div><button type="button" onClick={load} style={small}>Try again</button></div>
          </>
        ) : <div style={muted}>Reading the run&apos;s ACH payments…</div>}
      </div>
    );
  }

  const on = loaded.switchedOn;
  const setup = loaded.setup;
  const ready = on && !!setup && setup.problems.length === 0 && !setup.offsetProblem && !loaded.keyProblem;
  const tickable = loaded.payments.filter((p) => p.paymentStatus === 'made' && !p.fileId && !p.why && !!p.bank);
  const ticked = tickable.filter((p) => !unticked.has(p.paymentId));
  const tickedCents = ticked.reduce((sum, p) => sum + p.totalCents, 0);
  const idle = busy === null && !files.busy;
  const accountText = loaded.run.accountName || 'its bank account';

  const tick = (id: string) => setUnticked((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const make = async () => {
    if (!ready || !idle || ticked.length === 0) return;
    const yes = await dialog.confirm(
      `Make the ACH file paying ${plural(ticked.length, 'vendor')} ${formatCents(tickedCents)} from ${accountText}? Each is paid to the vendor's bank `
        + `numbers confirmed on a call-back, and First Bank pays them on ${loaded.pays.text} once the file is uploaded.`,
      { title: 'Make the ACH file', confirmLabel: 'Make the file' },
    );
    if (!yes) return;
    clearSaid();
    setBusy('make');
    try {
      const { ok, status, body } = await post({ action: 'make', id: pressId, runId, paymentIds: ticked.map((p) => p.paymentId) });
      if (!ok) {
        setError(body.error || `No file was made (${status}).`);
        setProblems(Array.isArray(body.problems) ? body.problems.slice(1) : []);
      } else {
        setDone(body.made
          ? `${body.fileName} is made: download it and upload it to First Bank, which pays it on ${body.pays?.text ?? loaded.pays.text}.`
          : 'That file was made already.');
        setPressId(newId());
        setUnticked(new Set());
      }
    } catch {
      setError(NO_ANSWER);
    } finally {
      setBusy(null);
      await load();
    }
  };

  const fileUrl = (f: AchFileShown) => `${API}?download=${encodeURIComponent(f.id)}`;

  const download = async (f: AchFileShown) => {
    if (!idle && !files.ready(fileUrl(f))) return;
    clearSaid();
    await files.download(fileUrl(f), f.fileName);
    await load();
  };

  const markSent = async (f: AchFileShown) => {
    if (!idle) return;
    const yes = await dialog.confirm(
      `Mark ${f.fileName} uploaded to First Bank? Do it once First Bank's online banking shows the file: FleetSuite's locked copy goes, so it can't be `
        + 'downloaded again.',
      { title: 'Uploaded to First Bank', confirmLabel: 'It was uploaded' },
    );
    if (!yes) return;
    clearSaid();
    setBusy(`sent-${f.id}`);
    try {
      const { ok, status, body } = await post({ action: 'sent', fileId: f.id });
      if (!ok) setError(body.error || `It wasn't marked uploaded (${status}).`);
      else setDone(`${f.fileName} is marked uploaded to First Bank.`);
    } catch {
      setError(NO_ANSWER);
    } finally {
      setBusy(null);
      await load();
    }
  };

  const setAside = async (f: AchFileShown) => {
    if (!idle) return;
    const sent = f.status === 'sent';
    const reason = await dialog.prompt(
      sent
        ? `Only when First Bank refused ${f.fileName} or didn't pay it: its payments can go in a new file, so a file First Bank paid would pay them twice. Say why.`
        : `${f.fileName} won't be uploaded, and its payments can go in a new file. If it was uploaded, mark it uploaded instead. Say why.`,
      '',
      {
        title: `Set aside ${f.fileName}`,
        confirmLabel: 'Set it aside',
        placeholder: sent ? 'First Bank returned it: the batch was out of balance' : "A vendor's numbers changed before it was uploaded",
        multiline: true,
      },
    );
    if (reason === null) return;
    clearSaid();
    const wrong = noteProblem('why', reason, WHY_MAX);
    if (wrong) { setError(wrong); return; }
    setBusy(`aside-${f.id}`);
    try {
      const { ok, status, body } = await post({ action: 'set_aside', fileId: f.id, reason });
      if (!ok) setError(body.error || `It wasn't set aside (${status}).`);
      else setDone(`${f.fileName} is set aside: its payments can go in a new file.`);
    } catch {
      setError(NO_ANSWER);
    } finally {
      setBusy(null);
      await load();
    }
  };

  const fileOf = (id: string | null) => loaded.files.find((f) => f.id === id) ?? null;

  const row = (p: AchPayment) => {
    const canTick = tickable.includes(p);
    const inFile = fileOf(p.fileId);
    const line = inFile ? `In ${inFile.fileName}${inFile.status === 'sent' ? ', uploaded to First Bank' : ''}` : p.why;
    const lineColor = inFile ? (inFile.status === 'sent' ? theme.success : theme.warning) : p.paymentStatus === 'made' ? theme.error : theme.textMuted;
    return (
      <div key={p.paymentId} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '8px', display: 'grid', gap: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', color: theme.textPrimary }}>
          {canTick ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0, cursor: ready && idle ? 'pointer' : 'default' }}>
              <input type="checkbox" checked={!unticked.has(p.paymentId)} disabled={!ready || !idle} onChange={() => tick(p.paymentId)} />
              <b style={{ minWidth: 0 }}>{p.vendorName}</b>
            </label>
          ) : <b style={{ flex: 1, minWidth: 0 }}>{p.vendorName}</b>}
          <span style={{ ...num, fontWeight: 800 }}>{formatCents(p.totalCents)}</span>
        </div>
        {p.bank && (
          <div style={muted}>{typeName(p.bank.type)} {maskedAccount(p.bank.last4)} at {p.bank.routing} · {p.bank.nameOnAccount}</div>
        )}
        {line && <div style={{ fontSize: '13px', fontWeight: 700, color: lineColor }}>{line}</div>}
      </div>
    );
  };

  const fileCard = (f: AchFileShown) => {
    const status = FILE_STATUS[f.status](f);
    const url = fileUrl(f);
    const waiting = files.ready(url);
    return (
      <div key={f.id} style={{
        ...box, display: 'grid', gap: '6px', ...(f.status === 'made' ? { borderColor: theme.warningBorder, background: theme.warningBg } : {}),
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
          <b style={{ fontSize: '14px', color: theme.textPrimary, overflowWrap: 'anywhere' }}>{f.fileName}</b>
          <span style={{ ...num, fontWeight: 800, color: theme.textPrimary }}>{formatCents(f.totalCents)}</span>
        </div>
        <div style={muted}>
          {plural(f.entryCount, 'vendor')} · First Bank pays it {f.pays.text}{f.madeBy ? ` · made by ${f.madeBy}` : ''} {when(f.madeAt)}
        </div>
        <div style={{ fontSize: '13px', fontWeight: 700, color: status.color }}>{status.text}</div>
        {f.payments.map((fp, i) => (
          <div key={`${i}-${fp.vendorName}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', color: theme.textPrimary }}>
            <span style={{ minWidth: 0 }}>{fp.vendorName} · {typeName(fp.type)} {maskedAccount(fp.last4)}</span>
            <span style={num}>{formatCents(fp.cents)}</span>
          </div>
        ))}
        {f.problem && <div style={red}>{f.problem}</div>}
        {f.late && !f.problem && (
          <div style={red}>Its day to be paid has come, and First Bank pays a file on a day still to come: set it aside and make a new one.</div>
        )}
        {f.status !== 'set_aside' && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {f.status === 'made' && on && !f.problem && (
              <button type="button" onClick={() => download(f)} disabled={!idle && !waiting} style={{ ...green, ...(!idle && !waiting ? off : {}) }}>
                {waiting ? 'Tap to save the file' : files.busy ? 'Opening the file…' : 'Download the file'}
              </button>
            )}
            {f.status === 'made' && f.downloads > 0 && (
              <button type="button" onClick={() => markSent(f)} disabled={!idle} style={{ ...btn, ...(!idle ? off : {}) }}>
                {busy === `sent-${f.id}` ? 'Marking…' : 'Uploaded to First Bank'}
              </button>
            )}
            <button type="button" onClick={() => setAside(f)} disabled={!idle} style={{ ...redSmall, ...(!idle ? off : {}) }}>
              {busy === `aside-${f.id}` ? 'Setting aside…' : 'Set aside'}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ ...card, display: 'grid', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={heading}>ACH file for First Bank</div>
          <div style={muted}>{setup ? setupLine(setup) : `How First Bank takes the file from ${accountText} isn't set up yet.`}</div>
        </div>
        <button type="button" onClick={() => setSettingUp((v) => !v)} aria-expanded={settingUp} style={small}>
          {settingUp ? 'Done setting up' : setup ? 'How First Bank takes it' : 'Set it up'}
        </button>
      </div>
      {settingUp && <AchSetupPanel company={loaded.run.company} accountId={loaded.run.accountId} onSaved={load} />}
      {loaded.keyProblem && <div style={red}>{loaded.keyProblem} The ACH file can&apos;t be made until it is.</div>}
      {!setup && !settingUp && <div style={red}>Set up how First Bank takes the file from {accountText} before making it.</div>}
      {setup && setup.problems.map((p, i) => <div key={`s${i}`} style={red}>How First Bank takes the file: {p}</div>)}
      {setup?.offsetProblem && <div style={red}>{setup.offsetProblem}</div>}
      {loaded.payments.map(row)}

      {tickable.length > 0 && (
        <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '10px', display: 'grid', gap: '8px' }}>
          <div>
            <button type="button" onClick={make} disabled={!ready || !idle || ticked.length === 0}
              style={{ ...green, ...(!ready || !idle || ticked.length === 0 ? off : {}) }}>
              {busy === 'make' ? 'Making the file…' : ticked.length === 0 ? 'Tick the payments to put in the file' : `Make the ACH file for ${plural(ticked.length, 'vendor')}`}
            </button>
          </div>
          <div style={muted}>
            {ticked.length > 0
              ? `${formatCents(tickedCents)}, paid by First Bank on ${loaded.pays.text} once the file is uploaded.`
              : 'Tick the payments to pay by ACH in one file.'}
          </div>
        </div>
      )}

      {loaded.files.length > 0 && (
        <div style={{ display: 'grid', gap: '8px' }}>
          {loaded.files.slice().reverse().map(fileCard)}
        </div>
      )}

      {done && <div style={{ fontSize: '14px', fontWeight: 800, color: theme.success }}>{done}</div>}
      {(error || problems.length > 0) && (
        <div style={{ display: 'grid', gap: '2px' }}>
          {error && <div style={red}>{error}</div>}
          {problems.map((p, i) => <div key={`${i}-${p}`} style={red}>{p}</div>)}
        </div>
      )}
      {!on && <div style={muted}>Making and downloading the ACH file is switched off until paying vendors is switched on.</div>}
    </div>
  );
}

/** A bank account and how its file starts (GET /api/pay-vendors/ach?company=). */
interface SetupAccount { netsuiteId: string; name: string; setup: SetupShown | null }

/** BMG's account for the offsetting debit, as typed. */
interface OffsetTyped { routing: string; account: string; accountAgain: string; type: string }

const NEW_SETUP: SetupTyped = {
  destination: '', destinationName: BANK_NAME_DEFAULT, origin: '', originName: '', odfi: '', companyName: '', companyId: '',
  entryDescription: DESCRIPTION_DEFAULT, secCode: 'CCD', addenda: true, balanced: false, lineEnding: 'crlf',
};
const NO_OFFSET: OffsetTyped = { routing: '', account: '', accountAgain: '', type: 'checking' };

const typedOf = (s: SetupShown | null): SetupTyped => (s
  ? {
    destination: s.destination, destinationName: s.destinationName, origin: s.origin, originName: s.originName, odfi: s.odfi,
    companyName: s.companyName, companyId: s.companyId, entryDescription: s.entryDescription, secCode: s.secCode, addenda: s.addenda,
    balanced: s.balanced, lineEnding: s.lineEnding,
  }
  : NEW_SETUP);

/** Why BMG's account as typed can't be kept, or none. */
const offsetProblems = (o: OffsetTyped) => [
  routingProblem(o.routing), accountProblem(o.account),
  digitsOf(o.account) !== digitsOf(o.accountAgain) ? "The account number typed again isn't the same." : null,
  isAccountType(o.type) ? null : 'Pick checking or savings.',
].filter((p): p is string => !!p);

/** The largest file read as NetSuite's ACH file: 50 payments with addenda are about 10 KB. */
const READ_MAX_BYTES = 2_000_000;

/**
 * How First Bank takes the ACH file, a bank account at a time: typed, or read from NetSuite's last ACH file for the
 * account, in the browser. `accountId` keeps it to one.
 */
export function AchSetupPanel({ company, accountId: only, onSaved }: { company: string; accountId?: string; onSaved?: () => void }) {
  const [accounts, setAccounts] = useState<SetupAccount[] | null>(null);
  const [keyProblem, setKeyProblem] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState(only ?? '');
  // What's typed and not saved; null shows what's kept.
  const [draft, setDraft] = useState<SetupTyped | null>(null);
  // BMG's account typed for the offsetting debit; null keeps the one kept.
  const [offset, setOffset] = useState<OffsetTyped | null>(null);
  const [readNote, setReadNote] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`${API}?company=${encodeURIComponent(company)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the bank accounts (${res.status}).`);
      const list = (body.accounts ?? []) as SetupAccount[];
      setAccounts(list);
      setKeyProblem(body.keyProblem ?? null);
      setPicked((p) => p || (list.length === 1 ? list[0].netsuiteId : ''));
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the bank accounts.");
    }
  }, [company]);
  useEffect(() => { load(); }, [load]);

  const account = accounts?.find((a) => a.netsuiteId === picked) ?? null;
  const kept = account?.setup ?? null;
  const form = draft ?? typedOf(kept);
  const keptOffset = kept?.balanced ? kept.offset : null;
  const typingOffset = form.balanced && (offset !== null || !keptOffset);
  const offsetForm = offset ?? NO_OFFSET;
  const changed = !!account && (draft !== null || offset !== null);

  const clearSaid = () => { setError(null); setProblems([]); setDone(null); };
  const pick = (id: string) => {
    setPicked(id);
    setDraft(null);
    setOffset(null);
    setReadNote(null);
    clearSaid();
  };
  const set = (p: Partial<SetupTyped>) => {
    const next = { ...form, ...p };
    // The sending bank is First Bank's routing number's first 8 digits, unless First Bank gave others.
    if (p.destination !== undefined && (form.odfi === '' || form.odfi === (digitsOf(form.destination) ?? '').slice(0, 8))) {
      next.odfi = (digitsOf(p.destination) ?? '').slice(0, 8);
    }
    setDraft(next);
    clearSaid();
  };
  const setOffsetField = (p: Partial<OffsetTyped>) => {
    setOffset({ ...offsetForm, ...p });
    clearSaid();
  };
  const undo = () => {
    setDraft(null);
    setOffset(null);
    setReadNote(null);
    clearSaid();
  };

  /** NetSuite's file, read here: how it starts fills the form, and nothing else of it is kept. */
  const readText = (text: string) => {
    const read = readAchFile(text);
    if ('problem' in read) { setError(read.problem); setReadNote(null); return; }
    setDraft({ ...read.setup });
    // Never NetSuite's numbers for BMG's account: they're typed from BMG's own records.
    setOffset(read.setup.balanced ? { ...NO_OFFSET, type: read.offset?.type ?? 'checking' } : null);
    setReadNote(`Read from NetSuite's file of ${plural(read.payments, 'payment')}, ${read.offset
      ? `balanced by a debit to BMG's ${typeName(read.offset.type).toLowerCase()} account ending ${read.offset.account.slice(-4)}: type that account below from BMG's own records`
      : 'with no debit to BMG\'s account'}. Check each line, then save.`);
    setPasted('');
    setPasting(false);
    setError(null);
    setProblems([]);
    setDone(null);
  };
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > READ_MAX_BYTES) { setError("That file is too big to be an ACH file."); return; }
    readText(await file.text());
  };

  const save = async () => {
    if (!account || saving) return;
    const wrong = [...setupProblems(form), ...(typingOffset ? offsetProblems(offsetForm).map((p) => `BMG's account: ${p}`) : [])];
    if (wrong.length > 0) { setError(wrong[0]); setProblems(wrong.slice(1)); setDone(null); return; }
    setSaving(true);
    clearSaid();
    try {
      const { ok, status, body } = await post({
        action: 'setup', company, accountId: account.netsuiteId, ...form, offset: typingOffset ? offsetForm : null,
      });
      if (!ok) {
        setError(body.error || `It wasn't saved (${status}).`);
        setProblems(Array.isArray(body.problems) ? body.problems.slice(1) : []);
        return;
      }
      const shown = body.setup as SetupShown;
      setAccounts((list) => list?.map((a) => (a.netsuiteId === account.netsuiteId ? { ...a, setup: shown } : a)) ?? list);
      setDraft(null);
      setOffset(null);
      setReadNote(null);
      setDone(`Saved: ACH files from ${account.name} start this way.`);
      onSaved?.();
    } catch {
      setError(NO_ANSWER);
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof SetupTyped, title: string, opts: { max?: number; placeholder?: string; numeric?: boolean; upper?: boolean } = {}) => (
    <div>
      <label style={label} htmlFor={`ach-${key}`}>{title}</label>
      <input id={`ach-${key}`} style={input} value={String(form[key])} maxLength={opts.max} placeholder={opts.placeholder} autoComplete="off"
        inputMode={opts.numeric ? 'numeric' : undefined}
        onChange={(e) => set({ [key]: opts.upper ? e.target.value.toUpperCase() : e.target.value } as Partial<SetupTyped>)} />
    </div>
  );
  const choice = <K extends keyof SetupTyped>(key: K, title: string, options: Array<[SetupTyped[K], string]>) => (
    <div>
      <div style={label}>{title}</div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {options.map(([value, text]) => (
          <button key={String(value)} type="button" aria-pressed={form[key] === value} onClick={() => set({ [key]: value } as Partial<SetupTyped>)}
            style={pressed(form[key] === value)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
  const offsetField = (key: keyof OffsetTyped, title: string) => (
    <div>
      <label style={label} htmlFor={`ach-offset-${key}`}>{title}</label>
      <input id={`ach-offset-${key}`} style={input} value={offsetForm[key]} inputMode="numeric" autoComplete="off" spellCheck={false}
        onChange={(e) => setOffsetField({ [key]: e.target.value })} />
    </div>
  );

  return (
    <div style={{ ...box, display: 'grid', gap: '10px' }}>
      <div style={muted}>
        Set each line the way First Bank set BMG up to send ACH files, or read NetSuite&apos;s last ACH file for the account to fill them in the same way.
      </div>
      {loadError && <div style={red}>{loadError}</div>}
      {!accounts && !loadError && <div style={muted}>Reading the bank accounts…</div>}
      {accounts && !only && (accounts.length === 0 ? (
        <div style={red}>Books has no bank accounts for this company from NetSuite yet.</div>
      ) : (
        <div>
          <label style={label} htmlFor="ach-account">Bank account</label>
          <select id="ach-account" style={input} value={picked} onChange={(e) => pick(e.target.value)}>
            <option value="">Pick the bank account the payments come from</option>
            {accounts.map((a) => <option key={a.netsuiteId} value={a.netsuiteId}>{a.name}{a.setup ? '' : ' (not set up)'}</option>)}
          </select>
        </div>
      ))}
      {accounts && only && !account && <div style={red}>This run&apos;s bank account isn&apos;t one of the company&apos;s bank accounts in Books any more.</div>}
      {account && (
        <>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ ...small, display: 'inline-block' }}>
              Read NetSuite&apos;s last ACH file
              <input type="file" accept=".txt,.ach,.dat,text/plain" onChange={onFile} style={{ display: 'none' }} />
            </label>
            <button type="button" onClick={() => setPasting((v) => !v)} aria-expanded={pasting} style={small}>{pasting ? 'Done pasting' : 'Paste it'}</button>
          </div>
          {pasting && (
            <div style={{ display: 'grid', gap: '6px' }}>
              <textarea aria-label="NetSuite's ACH file" style={{ ...input, minHeight: '90px', fontFamily: 'monospace', fontSize: '12px' }} value={pasted}
                spellCheck={false} onChange={(e) => setPasted(e.target.value)} placeholder="101 081999994 1431234567…" />
              <div><button type="button" onClick={() => readText(pasted)} disabled={!pasted.trim()} style={{ ...small, ...(!pasted.trim() ? off : {}) }}>Read it</button></div>
            </div>
          )}
          {readNote && <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary }}>{readNote}</div>}

          <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {field('destination', "First Bank's routing number", { numeric: true, placeholder: '9 digits' })}
            {field('destinationName', "The bank's name in the file", { max: BANK_NAME_MAX, upper: true })}
            {field('origin', "BMG's ACH ID with First Bank", { max: 10, upper: true, placeholder: '10 characters, or 9 digits' })}
            {field('originName', "BMG's name for First Bank", { max: ORIGIN_NAME_MAX, upper: true, placeholder: 'BMG FLEET INSTALLATIONS' })}
            {field('odfi', 'Sending bank', { numeric: true, placeholder: "First 8 digits of First Bank's routing number" })}
            {field('companyName', 'Company name', { max: COMPANY_NAME_MAX, upper: true, placeholder: 'BMG FLEET INSTAL' })}
            {field('companyId', "BMG's company ID for ACH", { max: 10, upper: true, placeholder: 'Often 1 and the EIN' })}
            {field('entryDescription', 'Description vendors see', { max: DESCRIPTION_MAX, upper: true })}
          </div>
          {choice('secCode', 'Who the payments go to', [['CCD', 'Businesses (CCD)'], ['PPD', 'People (PPD)']])}
          {choice('addenda', 'The bills each payment pays', [[true, 'Listed for the vendor'], [false, 'Not listed']])}
          {choice('balanced', "A debit to BMG's account in the file", [[false, 'No: payments only'], [true, 'Yes: balanced']])}
          {choice('lineEnding', 'How lines end', [['crlf', 'Windows (CRLF)'], ['lf', 'Unix (LF)']])}

          {form.balanced && (
            <div style={{ ...box, display: 'grid', gap: '8px' }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary }}>BMG&apos;s account the payments come from, for the debit that offsets them</div>
              {keyProblem && <div style={red}>{keyProblem}</div>}
              {keptOffset && !typingOffset ? (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '14px', color: theme.textPrimary }}>{typeName(keptOffset.type)} {maskedAccount(keptOffset.last4)} at {keptOffset.routing}</span>
                  <button type="button" onClick={() => setOffset({ ...NO_OFFSET })} style={small}>Type another account</button>
                </div>
              ) : (
                <>
                  <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
                    {offsetField('routing', 'Routing number')}
                    {offsetField('account', 'Account number')}
                    {offsetField('accountAgain', 'Account number again')}
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {(['checking', 'savings'] as const).map((t) => (
                      <button key={t} type="button" aria-pressed={offsetForm.type === t} onClick={() => setOffsetField({ type: t })} style={pressed(offsetForm.type === t)}>
                        {ACCOUNT_TYPES[t]}
                      </button>
                    ))}
                  </div>
                  <div style={muted}>Typed from BMG&apos;s own records, and kept locked: the page shows only the last four digits.</div>
                </>
              )}
              {kept?.offsetProblem && !typingOffset && <div style={red}>{kept.offsetProblem}</div>}
            </div>
          )}

          {kept && !changed && <div style={muted}>Saved{kept.updatedBy ? ` by ${kept.updatedBy}` : ''} {when(kept.updatedAt)}.</div>}
          {error && <div style={red}>{error}</div>}
          {problems.map((p, i) => <div key={`${i}-${p}`} style={red}>{p}</div>)}
          {done && <div style={{ fontSize: '13px', fontWeight: 700, color: theme.success }}>{done}</div>}
          {(changed || !kept) && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button type="button" onClick={save} disabled={saving} style={{ ...green, ...(saving ? off : {}) }}>{saving ? 'Saving…' : 'Save'}</button>
              {changed && <button type="button" onClick={undo} disabled={saving} style={btn}>Undo changes</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
