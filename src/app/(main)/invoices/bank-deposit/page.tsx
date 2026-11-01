'use client';

/**
 * Customer payments and deposits waiting in Undeposited Funds, deposited to a
 * bank account in FleetSuite and sent on to NetSuite as one bank deposit
 * (Books part 56, docs/books.md "Bank deposits made in FleetSuite"; owner
 * decisions 2026-10-31: deposits and banking move into FleetSuite during
 * 2027). Opened from Invoicing → Invoiced's Bank deposit.
 *
 * Pick the company and the bank account the money went into, tick the
 * payments and deposits that went to the bank together, as NetSuite has them
 * waiting, and the day. The checks are src/lib/bank-deposit.ts, the same
 * rules /api/invoices/bank-deposit checks the deposit by again, against what
 * NetSuite has waiting, when it's pressed. Built switched off (Books →
 * Switches): until it's on, super admins see what it would send and nothing
 * goes to NetSuite.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import TopSaveBar from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import {
  MEMO_MAX, accountName, formatCents, workOutBankDeposit, type BankAccount, type WaitingItem,
} from '@/lib/bank-deposit';

interface Loaded {
  today: string;
  companies: Array<{ code: string; name: string }>;
  company: string;
  accounts: BankAccount[];
  waiting: WaitingItem[];
  held: string[];
  switchedOn: boolean;
  offText: string | null;
}

interface Done {
  depositId: string;
  number: string | null;
  totalCents: number;
  booksWarning?: string;
}

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

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

export default function BankDepositPage() {
  const router = useRouter();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();

  const [requestId, setRequestId] = useState(newRequestId);
  const [company, setCompany] = useState<string | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState('');
  const [memo, setMemo] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsure, setUnsure] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`/api/invoices/bank-deposit${company ? `?company=${encodeURIComponent(company)}` : '?company='}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read what's waiting in Undeposited Funds (${res.status}).`);
      const loaded = body as Loaded;
      setData(loaded);
      setDate((d) => d || loaded.today);
      setAccountId((a) => (loaded.accounts.some((x) => x.netsuiteId === a) ? a : loaded.accounts.length === 1 ? loaded.accounts[0].netsuiteId : ''));
      setTicked((t) => new Set([...t].filter((id) => loaded.waiting.some((w) => w.netsuiteId === id))));
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read what's waiting in Undeposited Funds from NetSuite.");
    } finally {
      setLoading(false);
    }
  }, [company]);

  useEffect(() => { load(); }, [load]);

  const held = useMemo(() => new Set(data?.held ?? []), [data]);
  const free = useMemo(() => (data?.waiting ?? []).filter((w) => !held.has(w.netsuiteId)), [data, held]);
  const worked = useMemo(
    () => (data ? workOutBankDeposit({ date, accountId, memo, lineIds: [...ticked] }, data.waiting, data.accounts, { today: data.today, held }) : null),
    [data, date, accountId, memo, ticked, held],
  );

  const toggle = (id: string) => setTicked((t) => {
    const next = new Set(t);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allTicked = free.length > 0 && free.every((w) => ticked.has(w.netsuiteId));
  const tickAll = () => setTicked(allTicked ? new Set() : new Set(free.map((w) => w.netsuiteId)));

  const pickCompany = (code: string) => {
    if (code === data?.company) return;
    setCompany(code);
    setAccountId('');
    setTicked(new Set());
    setError(null);
  };

  const send = async (asking: boolean) => {
    if (!data || !worked || !data.switchedOn || (!asking && worked.problems.length > 0)) return;
    if (!asking) {
      const ok = await dialog.confirm(
        `Deposit ${worked.lines.length} ${worked.lines.length === 1 ? 'payment' : 'payments and deposits'} for ${formatCents(worked.totalCents)} `
          + `into ${worked.account ? accountName(worked.account) : 'the bank account'} on ${day(worked.date)}, and make the bank deposit in NetSuite?`,
        { confirmLabel: 'Make deposit', title: 'Make deposit' },
      );
      if (!ok) return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/invoices/bank-deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, company: data.company, accountId, date, memo, lineIds: [...ticked], expectedCents: worked.totalCents }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        setUnsure(!!body.unsure);
        throw new Error(body.error || `NetSuite didn't make the bank deposit (${res.status}).`);
      }
      setUnsure(false);
      setDone({ depositId: body.depositId, number: body.number ?? null, totalCents: body.totalCents ?? worked.totalCents, booksWarning: body.booksWarning });
    } catch (e: any) {
      setError(e?.message || "NetSuite didn't make the bank deposit.");
    } finally {
      setSubmitting(false);
    }
  };

  const reload = () => {
    setError(null);
    load();
  };

  const another = () => {
    setDone(null);
    setTicked(new Set());
    setMemo('');
    setRequestId(newRequestId());
    load();
  };

  if (!authLoading && (!hasFeature('invoicing') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Invoicing permission and price access to make bank deposits.</div>;
  }

  const back = () => router.push('/invoices?tab=sent');

  return (
    <div style={{ maxWidth: '820px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!done && data && worked && !unsure && (
        <TopSaveBar
          title="Make deposit"
          subtitle={`${data.company}${worked.lines.length > 0 ? ` · ${worked.lines.length} ticked · ${formatCents(worked.totalCents)}` : ''}`}
          error={error || undefined}
          onSave={() => send(false)}
          saving={submitting}
          disabled={!data.switchedOn || worked.problems.length > 0}
          saveLabel={data.switchedOn ? 'Make deposit' : 'Switched off'}
          savingLabel="Making the bank deposit…"
          onCancel={back}
        />
      )}
      <div>
        <button onClick={back} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>
          ← Invoiced
        </button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Bank deposit</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>Payments and deposits waiting in Undeposited Funds, deposited to the bank and made in NetSuite.</div>
      </div>

      {data?.offText && !done && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {data && data.companies.length > 1 && !done && !unsure && (
        <div style={{ display: 'flex', gap: '8px' }}>
          {data.companies.map((c) => (
            <button key={c.code} onClick={() => pickCompany(c.code)} aria-pressed={data.company === c.code}
              style={{ ...btn, flex: 1, borderColor: data.company === c.code ? theme.successBorder : theme.border, background: data.company === c.code ? theme.successBg : theme.card, color: data.company === c.code ? theme.success : theme.textPrimary }}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      {loading && !data ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Reading what&apos;s waiting in Undeposited Funds from NetSuite…</div>
      ) : loadError || !data || !worked ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{loadError || "Couldn't read what's waiting in Undeposited Funds from NetSuite."}</div>
          <div><button onClick={load} style={btn}>Try again</button></div>
        </div>
      ) : done ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: theme.success }}>
            Bank deposit {done.number || done.depositId} made in NetSuite
          </div>
          <div style={{ fontSize: '14px', color: theme.textPrimary }}>
            {worked.account ? accountName(worked.account) : data.company} · {day(worked.date)} · {worked.lines.length} {worked.lines.length === 1 ? 'payment' : 'payments and deposits'} · {formatCents(done.totalCents)}
          </div>
          {done.booksWarning && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{done.booksWarning}</div>}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={another} style={btn}>Make another</button>
            <button onClick={back} style={btn}>Back to Invoiced</button>
          </div>
        </div>
      ) : unsure ? (
        <div style={{ ...card, borderColor: theme.errorBorder, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{error}</div>
          <div style={muted}>Don&apos;t make it again on another screen: FleetSuite asks NetSuite under this bank deposit&apos;s own name, so it&apos;s never made twice.</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={() => send(true)} disabled={submitting} style={btn}>{submitting ? 'Asking NetSuite…' : 'Ask NetSuite'}</button>
            <button onClick={back} style={btn}>Back to Invoiced</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div>
              <label style={label} htmlFor="bd-account">Bank account</label>
              {data.accounts.length === 0 ? (
                <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>Books has no bank accounts for {data.company} from NetSuite yet.</div>
              ) : (
                <select id="bd-account" style={input} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="">Pick the account it went into</option>
                  {data.accounts.map((a) => <option key={a.netsuiteId} value={a.netsuiteId}>{accountName(a)}</option>)}
                </select>
              )}
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 150px' }}>
                <label style={label} htmlFor="bd-date">Deposited</label>
                <input id="bd-date" type="date" style={input} value={date} max={data.today} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div style={{ flex: '3 1 240px' }}>
                <label style={label} htmlFor="bd-memo">Memo (if any)</label>
                <input id="bd-memo" style={input} value={memo} maxLength={MEMO_MAX} onChange={(e) => setMemo(e.target.value)} />
              </div>
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>Waiting in Undeposited Funds</div>
              <div style={{ display: 'flex', gap: '6px' }}>
                {free.length > 0 && <button onClick={tickAll} style={{ ...btn, padding: '5px 10px', fontSize: '12px' }}>{allTicked ? 'Untick all' : 'Tick all'}</button>}
                <button onClick={reload} disabled={loading} style={{ ...btn, padding: '5px 10px', fontSize: '12px' }}>{loading ? 'Reading…' : 'Reload'}</button>
              </div>
            </div>
            {data.waiting.length === 0 ? (
              <div style={{ fontSize: '14px', color: theme.textSecondary }}>Nothing is waiting in Undeposited Funds for {data.company}.</div>
            ) : data.waiting.map((w) => {
              const isHeld = held.has(w.netsuiteId);
              return (
                <label key={w.netsuiteId} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: isHeld ? theme.textMuted : theme.textPrimary, cursor: isHeld ? 'default' : 'pointer' }}>
                  <input type="checkbox" checked={ticked.has(w.netsuiteId)} disabled={isHeld} onChange={() => toggle(w.netsuiteId)} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b>{w.customerName}</b>
                    <span style={{ color: theme.textMuted }}>
                      {' · '}{w.kind === 'payment' ? 'Payment' : 'Deposit'} {w.number} · {day(w.date)}{w.reference ? ` · ${w.reference}` : ''}{isHeld ? ' · being deposited now' : ''}
                    </span>
                  </span>
                  <span style={num}>{formatCents(w.cents)}</span>
                </label>
              );
            })}
            <div style={muted}>As NetSuite had them when the page was read. Reload to see what NetSuite has now.</div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '18px', fontWeight: 800, color: theme.textPrimary }}>
              <span>Deposit</span><span style={num}>{formatCents(worked.totalCents)}</span>
            </div>
            <div style={muted}>Match it to the deposit slip or the bank: one bank deposit in NetSuite for what went to the bank together.</div>
          </div>

          {worked.problems.length > 0 && ticked.size > 0 && (
            <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700, display: 'grid', gap: '2px' }}>
              {worked.problems.map((p) => <div key={p}>{p}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
