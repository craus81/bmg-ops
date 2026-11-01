'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { parseDollars } from '@/lib/books/typed-dollars';
import {
  SETUP_ACCOUNTS, formatCents, monthName, paymentCents, typedProblems,
  type EntryKind, type EntryView, type MonthView, type RentMortgageSetup, type SetupRole, type TypedMonth,
} from '@/lib/books/rent-and-mortgage';

/**
 * Books → Rent and mortgage (docs/books.md "1084's rent and mortgage").
 *
 * 1084 Cool Springs' months from January 2025, newest first: the rent BMG's
 * books have next to what 1084's have from it, the lender's statement as
 * typed next to what 1084's books have for the mortgage, and the two entries
 * that book the month, made as drafts on Journal entries from the figures as
 * saved. The setup picks the accounts each is read from and booked to. Open
 * to whoever opens the books; the bookkeeper and super admins type the
 * figures, and making the entries needs Payments too.
 */

interface Choice {
  role: SetupRole;
  label: string;
  company: string;
  optional: boolean;
  accounts: Array<{ id: string; name: string }>;
}

interface Payload {
  landlord: { code: string; name: string; subsidiaryId: string | null };
  tenant: { code: string; name: string };
  setup: RentMortgageSetup;
  setupUpdatedAt: string | null;
  setupUpdatedBy: string | null;
  setupNames: Record<SetupRole, string | null>;
  setupProblems: string[];
  choices: Choice[];
  months: MonthView[];
  today: string;
  thisMonth: string;
  firstMonth: string;
  can: { keep: boolean; make: boolean };
  makeRefused: string | null;
  switchedOn: boolean;
  offText: string | null;
}

/** A month's figures as they're being typed. */
interface Draft {
  month: string;
  seen: string | null;
  rentDate: string;
  rentAmount: string;
  paidOn: string;
  principal: string;
  interest: string;
  escrow: string;
  balanceAfter: string;
}

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const GREY = '#94a3b8';

/** How many months show before "Show all". */
const SHOWN = 6;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso: string) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});
const dollars = (cents: number) => (cents / 100).toFixed(2);
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

/** The same day of the month as last month's, in this month (the last day when this month is shorter). */
function sameDay(month: string, before: string | null | undefined): string {
  if (!before) return '';
  const end = lastDay(month);
  const d = Math.min(Number(before.slice(8, 10)), Number(end.slice(8, 10)));
  return `${month.slice(0, 8)}${String(d).padStart(2, '0')}`;
}

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const chip = (color: string): React.CSSProperties => ({
  fontSize: '10px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
  border: `1px solid ${color}55`, color,
});

const act = (color: string | null, enabled: boolean): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
  border: color ? 'none' : '1px solid var(--border)', background: color ?? 'var(--card)', color: color ? '#fff' : 'var(--text-primary)',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
});

const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};

// 16px keeps an iPhone from zooming in on the box being typed in.
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)',
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '16px',
};

const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' };
const line = (color: string): React.CSSProperties => ({ fontSize: '12px', fontWeight: 600, color, marginTop: '2px' });
const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px', background: 'var(--card)' };
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' };

function draftOf(v: MonthView, older: MonthView | undefined): Draft {
  const s = v.statement;
  return {
    month: v.month,
    seen: v.updatedAt,
    rentDate: v.rent?.date ?? sameDay(v.month, older?.rent?.date),
    rentAmount: v.rent ? dollars(v.rent.cents) : v.rentDefaultCents ? dollars(v.rentDefaultCents) : '',
    paidOn: s?.paidOn ?? sameDay(v.month, older?.statement?.paidOn),
    principal: s ? dollars(s.principalCents) : '',
    interest: s ? dollars(s.interestCents) : '',
    escrow: s && s.escrowCents ? dollars(s.escrowCents) : '',
    balanceAfter: s ? dollars(s.balanceAfterCents) : '',
  };
}

/**
 * What's typed, as the route takes it, and why it can't be saved. The rent is
 * none while its amount is empty, and the statement none while its amounts
 * are, whatever days are filled in; escrow left empty is $0.
 */
function typedOf(d: Draft): { typed: TypedMonth; problems: string[] } {
  const problems: string[] = [];
  const amount = (text: string, what: string): number => {
    const c = parseDollars(text);
    if (c === null) problems.push(`${what} isn't an amount: type it like 1,234.56.`);
    return c ?? 0;
  };
  let rent: TypedMonth['rent'] = null;
  if (d.rentAmount.trim()) {
    if (!d.rentDate) problems.push('Pick the day the rent was received.');
    rent = { date: d.rentDate, cents: amount(d.rentAmount, "The rent's amount") };
  }
  let statement: TypedMonth['statement'] = null;
  const amounts = [d.principal, d.interest, d.escrow, d.balanceAfter];
  if (amounts.some((a) => a.trim())) {
    if (!d.paidOn) problems.push('Pick the day the payment was made.');
    if (![d.principal, d.interest, d.balanceAfter].every((a) => a.trim())) {
      problems.push("Type the statement's principal, interest and principal left; escrow can be left empty.");
    }
    statement = {
      paidOn: d.paidOn,
      principalCents: d.principal.trim() ? amount(d.principal, "The statement's principal") : 0,
      interestCents: d.interest.trim() ? amount(d.interest, "The statement's interest") : 0,
      escrowCents: d.escrow.trim() ? amount(d.escrow, "The statement's escrow") : 0,
      balanceAfterCents: d.balanceAfter.trim() ? amount(d.balanceAfter, "The statement's principal left") : 0,
    };
  }
  const typed: TypedMonth = { month: d.month, rent, statement };
  if (!problems.length) problems.push(...typedProblems(typed));
  return { typed, problems };
}

/** The rent check in words, or none while the setup hasn't the accounts for it. */
function rentWords(v: MonthView): { words: string; color: string } | null {
  const c = v.rentCheck;
  switch (c.state) {
    case 'not_set_up': return null;
    case 'none': return { words: "No rent in either company's books", color: GREY };
    case 'matches': return { words: `Rent matches BMG's books: ${formatCents(c.tenantCents)}`, color: GREEN };
    case 'waiting': return { words: `BMG's books have ${formatCents(c.tenantCents)} of rent; 1084's don't have it yet`, color: GREY };
    case 'differs': return {
      words: `Rent doesn't match: BMG's books have ${formatCents(c.tenantCents)}, 1084's ${formatCents(c.landlordCents)}, ${formatCents(c.apartCents)} apart`,
      color: RED,
    };
  }
}

const FIGURE: Record<'principal' | 'interest' | 'balance', string> = { principal: 'principal', interest: 'interest', balance: 'principal left' };

/** The mortgage check in words, or none while the setup hasn't the accounts for it. */
function mortgageWords(v: MonthView): { words: string; color: string } | null {
  const c = v.mortgageCheck;
  const b = v.book;
  switch (c.state) {
    case 'not_set_up': return null;
    case 'no_statement': return {
      words: `No lender's statement typed. 1084's books: ${formatCents(b.principalCents ?? 0)} principal, ${formatCents(b.interestCents ?? 0)} interest, `
        + `${formatCents(b.balanceCents ?? 0)} owed at the month's end`,
      color: GREY,
    };
    case 'not_booked': return { words: `1084's books have nothing paid on the mortgage in ${monthName(v.month)} yet`, color: GREY };
    case 'matches': return { words: "Mortgage matches the lender's statement", color: GREEN };
    case 'differs': return {
      words: `Mortgage doesn't match the lender's statement: ${c.differing
        .map((d) => `the books have ${formatCents(d.books)} ${FIGURE[d.what]}, the statement ${formatCents(d.statement)}`).join('; ')}`,
      color: RED,
    };
  }
}

const STATUS: Record<EntryView['status'], string> = {
  draft: 'Draft',
  waiting: 'Asked for approval',
  sending: 'Being made in NetSuite',
  made: 'In NetSuite',
};
const ENTRY_NAME: Record<EntryKind, string> = { rent: 'Rent entry', mortgage: 'Mortgage payment entry' };

function EntryLine({ kind, e }: { kind: EntryKind; e: EntryView }) {
  return (
    <div style={{ fontSize: '12px', marginTop: '2px' }}>
      <Link href={deepLinks.journalEntries(e.id)} style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{ENTRY_NAME[kind]}</Link>
      {': '}{STATUS[e.status]}{e.status === 'made' && e.number ? ` as ${e.number}` : ''} · {longDate(e.date)} · {formatCents(e.totalCents)}
      {e.stale && <div style={line(AMBER)}>Behind the month&apos;s figures or the setup: bring it up to date below.</div>}
      {e.takenOff && (
        <div style={line(AMBER)}>
          {kind === 'rent' ? 'The rent was' : "The lender's statement was"} taken off the month since: delete this draft on Journal entries.
        </div>
      )}
      {e.error && <div style={line(RED)}>NetSuite didn&apos;t make it: {e.error}</div>}
    </div>
  );
}

export default function BooksRentMortgagePage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [all, setAll] = useState(false);
  /** The setup as it's being changed, once Change is tapped. */
  const [setupDraft, setSetupDraft] = useState<RentMortgageSetup | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  /** The month being typed, once it's opened. */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const [actError, setActError] = useState<{ at: string; message: string } | null>(null);
  const [done, setDone] = useState<{ at: string; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/books/rent-and-mortgage');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
      return json as Payload;
    } catch (e: any) {
      setError(e?.message || "Couldn't read the months");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    load().then((json) => {
      if (!json) return;
      if (SETUP_ACCOUNTS.some((r) => !r.optional && !json.setup[r.role])) setSetupOpen(true);
      // A link may open one month (?month=2027-03).
      const asked = new URLSearchParams(window.location.search).get('month');
      const at = json.months.findIndex((m) => m.month.slice(0, 7) === asked);
      if (at < 0) return;
      if (at >= SHOWN) setAll(true);
      if (json.can.keep) setDraft(draftOf(json.months[at], json.months[at + 1]));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const post = async (at: string, body: Record<string, unknown>): Promise<any> => {
    setBusy(at);
    setActError(null);
    setDone(null);
    try {
      const res = await apiFetch('/api/admin/books/rent-and-mortgage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      return json;
    } catch (e: any) {
      setActError({ at, message: e?.message || "Couldn't save it" });
      return null;
    } finally {
      setBusy('');
    }
  };

  const saveSetup = async () => {
    if (!data || !setupDraft) return;
    const { lender, ...accounts } = setupDraft;
    const ok = await post('setup', { action: 'setup', seen: data.setupUpdatedAt, accounts, lender });
    if (!ok) return;
    setSetupDraft(null);
    await load();
  };

  const saveMonth = async () => {
    if (!draft) return;
    const { typed, problems } = typedOf(draft);
    if (problems.length) { setActError({ at: draft.month, message: problems.join(' ') }); return; }
    const ok = await post(draft.month, { action: 'save', month: draft.month.slice(0, 7), seen: draft.seen, rent: typed.rent, statement: typed.statement });
    if (!ok) return;
    setDraft(null);
    await load();
  };

  const make = async (v: MonthView) => {
    const ok = await post(v.month, { action: 'make', month: v.month.slice(0, 7), seen: v.updatedAt });
    await load();
    if (!ok) return;
    const made = (ok.made as Array<{ kind: EntryKind }>).map((m) => ENTRY_NAME[m.kind].toLowerCase());
    setDone({
      at: v.month,
      message: made.length
        ? `Made the ${made.join(' and the ')} as ${made.length === 1 ? 'a draft' : 'drafts'} on Journal entries${data?.switchedOn ? ', to ask for approval there.' : '.'}`
        : "Nothing changed: the month's entries are asked for approval or made already.",
    });
  };

  if (!data) {
    return (
      <div>
        <div style={{ fontSize: '20px', fontWeight: 800, marginBottom: '10px' }}>Rent and mortgage</div>
        {error ? <div style={banner(RED)}>{error}</div> : loading && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>}
      </div>
    );
  }

  const keep = data.can.keep;
  const setupMissing = SETUP_ACCOUNTS.filter((r) => !r.optional && !data.setup[r.role]);
  const editingSetup = setupDraft !== null;
  const shown = all ? data.months : data.months.slice(0, SHOWN);

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Rent and mortgage</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {data.landlord.name}&apos;s months: the rent checked against BMG&apos;s books, the lender&apos;s statement against 1084&apos;s,
          and the month&apos;s two entries made for Journal entries.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              Type the rent received and the lender&apos;s statement for each month, each dated in the month the books show it in.
              Making the month&apos;s entries books the rent into 1084&apos;s bank and rent income, and the payment out of its bank to
              the mortgage, its interest and escrow, each on its own day, as drafts to ask for approval on Journal entries. What an
              entry books stays as it is once it&apos;s asked for approval. Escrow isn&apos;t checked against the books: what the lender
              pays out of it moves its account too. The bookkeeper and super admins type the figures; making the entries needs
              Payments too.
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href={deepLinks.journalEntries()} style={{ color: 'var(--text-secondary)' }}>Journal entries</Link>
          {' · '}
          <Link href={deepLinks.booksBankReconciliation()} style={{ color: 'var(--text-secondary)' }}>Bank reconciliation</Link>
          {' · '}
          <Link href="/admin/books/months" style={{ color: 'var(--text-secondary)' }}>Months</Link>
          {' · '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}
      {!data.landlord.subsidiaryId && (
        <div style={banner(RED)}>
          {data.landlord.name} has no NetSuite subsidiary in Books, so its accounts can&apos;t be picked and its entries can&apos;t be made
          until it has one.
        </div>
      )}
      {data.offText && <div style={banner(GREY)}>{data.offText}</div>}
      {keep && data.makeRefused && <div style={banner(GREY)}>{data.makeRefused}</div>}

      <div style={{ ...card, marginBottom: '12px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '14px', fontWeight: 800 }}>Setup</span>
          {setupMissing.length > 0 && <span style={chip(AMBER)}>Not finished</span>}
          <button onClick={() => setSetupOpen(!setupOpen)} style={{ ...link, marginLeft: 'auto' }}>{setupOpen ? 'Hide' : 'Show'}</button>
        </div>
        {setupMissing.length > 0 && !setupOpen && <div style={line(GREY)}>Pick each account to see each month&apos;s checks.</div>}
        {data.setupProblems.map((p) => <div key={p} style={line(RED)}>{p}</div>)}
        {setupOpen && (
          <div style={{ marginTop: '8px' }}>
            <div style={grid}>
              {data.choices.map((c) => (
                <div key={c.role}>
                  <span style={label}>{c.label}{c.optional ? ' (if the lender holds some)' : ''}</span>
                  {setupDraft ? (
                    <select
                      value={setupDraft[c.role] ?? ''}
                      onChange={(e) => setSetupDraft({ ...setupDraft, [c.role]: e.target.value || null })}
                      disabled={busy === 'setup'}
                      style={input}
                    >
                      <option value="">{c.optional ? 'None' : 'Not picked'}</option>
                      {setupDraft[c.role] && !c.accounts.some((a) => a.id === setupDraft[c.role]) && (
                        <option value={setupDraft[c.role]!}>{data.setupNames[c.role] ?? setupDraft[c.role]}</option>
                      )}
                      {c.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  ) : (
                    <div style={{ fontSize: '13px', fontWeight: 600, color: data.setupNames[c.role] ? 'var(--text-primary)' : GREY }}>
                      {data.setupNames[c.role] ?? (c.optional ? 'None' : 'Not picked')}
                    </div>
                  )}
                </div>
              ))}
              <div>
                <span style={label}>The lender</span>
                {setupDraft ? (
                  <input
                    value={setupDraft.lender ?? ''}
                    onChange={(e) => setSetupDraft({ ...setupDraft, lender: e.target.value })}
                    placeholder="Its name, for the payment's memo"
                    maxLength={100}
                    disabled={busy === 'setup'}
                    style={input}
                  />
                ) : (
                  <div style={{ fontSize: '13px', fontWeight: 600, color: data.setup.lender ? 'var(--text-primary)' : GREY }}>{data.setup.lender ?? 'Not named'}</div>
                )}
              </div>
            </div>
            {data.setupUpdatedAt && !editingSetup && (
              <div style={line(GREY)}>Saved{data.setupUpdatedBy ? ` by ${data.setupUpdatedBy}` : ''} {when(data.setupUpdatedAt)}</div>
            )}
            {keep && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                {editingSetup ? (
                  <>
                    <button onClick={saveSetup} disabled={busy === 'setup'} style={act(GREEN, busy !== 'setup')}>
                      {busy === 'setup' ? 'Saving…' : 'Save the setup'}
                    </button>
                    <button onClick={() => { setSetupDraft(null); setActError(null); }} disabled={busy === 'setup'} style={act(null, busy !== 'setup')}>
                      Leave without saving
                    </button>
                  </>
                ) : (
                  <button onClick={() => { setSetupDraft({ ...data.setup }); setActError(null); }} style={act(null, true)}>Change the setup</button>
                )}
              </div>
            )}
            {actError?.at === 'setup' && <div style={{ ...banner(RED), marginTop: '8px', marginBottom: 0 }}>{actError.message}</div>}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {shown.map((v, i) => {
          const older = data.months[i + 1];
          const rent = rentWords(v);
          const mortgage = mortgageWords(v);
          const open = draft?.month === v.month;
          const kinds: EntryKind[] = ['rent', 'mortgage'];
          const figures = (k: EntryKind) => (k === 'rent' ? v.rent : v.statement);
          const needs = kinds.filter((k) => figures(k) && (!v.entries[k] || (v.entries[k]!.status === 'draft' && v.entries[k]!.stale)));
          const firstMaking = needs.some((k) => !v.entries[k]);
          const s = v.statement;
          return (
            <div key={v.month} style={card}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '2px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '14px', fontWeight: 800 }}>{monthName(v.month)}</span>
                {v.month === data.thisMonth && <span style={chip(GREY)}>This month</span>}
              </div>
              {rent && <div style={line(rent.color)}>{rent.words}</div>}
              {mortgage && <div style={line(mortgage.color)}>{mortgage.words}</div>}
              {v.note && <div style={line(GREY)}>{v.note}</div>}

              {!open && (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  <div>{v.rent ? `Rent received ${longDate(v.rent.date)}: ${formatCents(v.rent.cents)}` : 'No rent typed'}</div>
                  <div>
                    {s
                      ? `Lender's statement: paid ${longDate(s.paidOn)}, ${formatCents(paymentCents(s))} (${formatCents(s.principalCents)} principal, `
                        + `${formatCents(s.interestCents)} interest${s.escrowCents ? `, ${formatCents(s.escrowCents)} escrow` : ''}), `
                        + `${formatCents(s.balanceAfterCents)} principal left`
                      : "No lender's statement typed"}
                  </div>
                  {v.updatedAt && <div style={{ color: 'var(--text-muted)' }}>Saved{v.updatedBy ? ` by ${v.updatedBy}` : ''} {when(v.updatedAt)}</div>}
                </div>
              )}

              {kinds.map((k) => v.entries[k] && <EntryLine key={k} kind={k} e={v.entries[k]!} />)}

              {open && draft && (
                <div style={{ marginTop: '8px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 800, marginBottom: '4px' }}>Rent received</div>
                  <div style={grid}>
                    <div>
                      <span style={label}>Day</span>
                      <input type="date" value={draft.rentDate} min={v.month} max={lastDay(v.month)} disabled={busy === v.month}
                        onChange={(e) => setDraft({ ...draft, rentDate: e.target.value })} style={input} />
                    </div>
                    <div>
                      <span style={label}>Amount</span>
                      <input inputMode="decimal" value={draft.rentAmount} placeholder="None this month" disabled={busy === v.month}
                        onChange={(e) => setDraft({ ...draft, rentAmount: e.target.value })} style={input} />
                    </div>
                  </div>
                  <div style={{ fontSize: '12px', fontWeight: 800, margin: '10px 0 4px' }}>The lender&apos;s statement</div>
                  <div style={grid}>
                    <div>
                      <span style={label}>Paid on</span>
                      <input type="date" value={draft.paidOn} min={v.month} max={lastDay(v.month)} disabled={busy === v.month}
                        onChange={(e) => setDraft({ ...draft, paidOn: e.target.value })} style={input} />
                    </div>
                    <div>
                      <span style={label}>Principal</span>
                      <input inputMode="decimal" value={draft.principal} disabled={busy === v.month}
                        onChange={(e) => setDraft({ ...draft, principal: e.target.value })} style={input} />
                    </div>
                    <div>
                      <span style={label}>Interest</span>
                      <input inputMode="decimal" value={draft.interest} disabled={busy === v.month}
                        onChange={(e) => setDraft({ ...draft, interest: e.target.value })} style={input} />
                    </div>
                    <div>
                      <span style={label}>Escrow</span>
                      <input inputMode="decimal" value={draft.escrow} placeholder="None" disabled={busy === v.month}
                        onChange={(e) => setDraft({ ...draft, escrow: e.target.value })} style={input} />
                    </div>
                    <div>
                      <span style={label}>Principal left after it</span>
                      <input inputMode="decimal" value={draft.balanceAfter} disabled={busy === v.month}
                        onChange={(e) => setDraft({ ...draft, balanceAfter: e.target.value })} style={input} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                    <button onClick={saveMonth} disabled={busy === v.month} style={act(GREEN, busy !== v.month)}>
                      {busy === v.month ? 'Saving…' : `Save ${MONTH_NAMES[Number(v.month.slice(5, 7)) - 1]}`}
                    </button>
                    <button onClick={() => { setDraft(null); setActError(null); }} disabled={busy === v.month} style={act(null, busy !== v.month)}>
                      Leave without saving
                    </button>
                  </div>
                </div>
              )}

              {!open && keep && (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                  <button
                    onClick={() => { setDraft(draftOf(v, older)); setActError(null); setDone(null); }}
                    disabled={!!busy || draft !== null}
                    style={act(null, !busy && draft === null)}
                  >
                    {v.rent || v.statement ? 'Change the figures' : 'Type the figures'}
                  </button>
                  {data.can.make && needs.length > 0 && v.updatedAt && (
                    <button onClick={() => make(v)} disabled={!!busy || draft !== null} style={act(GREEN, !busy && draft === null)}>
                      {busy === v.month ? 'Making…' : firstMaking ? "Make the month's entries" : 'Bring the entries up to date'}
                    </button>
                  )}
                </div>
              )}
              {actError?.at === v.month && <div style={{ ...banner(RED), marginTop: '8px', marginBottom: 0 }}>{actError.message}</div>}
              {done?.at === v.month && <div style={{ ...banner(GREEN), marginTop: '8px', marginBottom: 0 }}>{done.message}</div>}
            </div>
          );
        })}
      </div>
      {!all && data.months.length > SHOWN && (
        <div style={{ marginTop: '10px' }}>
          <button onClick={() => setAll(true)} style={link}>Show all {data.months.length} months, back to {monthName(data.firstMonth)}</button>
        </div>
      )}
    </div>
  );
}
