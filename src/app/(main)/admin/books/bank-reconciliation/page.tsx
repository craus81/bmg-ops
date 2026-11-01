'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { parseDollars } from '@/lib/books/typed-dollars';
import { monthBefore, monthsFrom } from '@/lib/books/rent-and-mortgage';
import {
  formatCents, lastDay, longDate, monthName, nextView, startProblems, startView,
  type BankDoc, type MonthView, type RecBooks, type RecEvent, type RecItem, type RecStart, type RecTick, type SavedRec, type StartView,
} from '@/lib/books/bank-reconciliation';

/**
 * Books → 1084's bank reconciliation (docs/books.md "1084's bank
 * reconciliation").
 *
 * 1084 Cool Springs' bank statements, month by month, newest first: each
 * entry on its bank account in FleetSuite's books ticked as it clears the
 * bank, until the statement's starting balance and what cleared come to its
 * ending balance. Where reconciling starts is set first: the first month,
 * and the bank's balance before it. Open to whoever opens the books; the
 * bookkeeper and super admins reconcile.
 */

interface Payload {
  company: { code: string; name: string };
  account: { id: string; name: string } | null;
  start: (RecStart & { updatedAt: string; updatedBy: string | null }) | null;
  startView: StartView | null;
  next: string | null;
  months: MonthView[];
  recs: SavedRec[];
  ticks: RecTick[];
  events: RecEvent[];
  docs: BankDoc[];
  openingCents: number;
  notPosted: number;
  capped: boolean;
  can: { keep: boolean };
  today: string;
  thisMonth: string;
  firstMonth: string;
}

/** Where reconciling starts, as it's being changed. */
interface StartDraft {
  firstMonth: string;
  asOf: string;
  balance: string;
  outstanding: Set<string>;
}

/** The month being reconciled, as it's being ticked. */
interface MonthDraft {
  month: string;
  seen: string | null;
  endsOn: string;
  ending: string;
  ticked: Set<string>;
}

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const GREY = '#94a3b8';

/** How many entries show before "Show all" where reconciling starts. */
const SHOWN = 12;

const when = (iso: string) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});
const dollars = (cents: number) => (cents / 100).toFixed(2);
const shortMonth = (month: string) => monthName(month).split(' ')[0];

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
const row: React.CSSProperties = { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '12px', padding: '3px 0' };

/** The books held against the bank in words: what they have, less what hasn't cleared, next to the bank's balance. */
function tieWords(booksCents: number, notClearedCents: number, bankCents: number, onDay: string): { words: string; color: string } {
  const apart = booksCents - notClearedCents - bankCents;
  const less = notClearedCents ? `, less ${formatCents(notClearedCents)} not cleared by then,` : '';
  return apart === 0
    ? { words: `The books tie to the bank: they have ${formatCents(booksCents)} on ${longDate(onDay)}${less} which is the bank's ${formatCents(bankCents)}.`, color: GREEN }
    : {
      words: `The books don't tie to the bank: they have ${formatCents(booksCents)} on ${longDate(onDay)}${less} which is `
        + `${formatCents(booksCents - notClearedCents)}, not the bank's ${formatCents(bankCents)}: ${formatCents(Math.abs(apart))} apart.`,
      color: RED,
    };
}

function eventWords(e: RecEvent): string {
  return e.action === 'done'
    ? `Reconciled${e.by ? ` by ${e.by}` : ''} ${when(e.at)}`
    : `Undone${e.by ? ` by ${e.by}` : ''} ${when(e.at)}: ${e.reason ?? ''}`;
}

function EntryRow({ item, onTick, disabled }: { item: RecItem; onTick?: () => void; disabled?: boolean }) {
  const words = [item.name, item.memo].filter(Boolean).join(' · ');
  return (
    <label style={{ ...row, cursor: onTick && !disabled ? 'pointer' : 'default' }}>
      {onTick && <input type="checkbox" checked={item.ticked} onChange={onTick} disabled={disabled} style={{ width: '18px', height: '18px' }} />}
      <span style={{ minWidth: '84px', color: 'var(--text-muted)' }}>{item.date ? longDate(item.date).replace(/, \d{4}$/, '') : ''}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 700 }}>{item.type} {item.number}</span>
        {words && <span style={{ display: 'block', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{words}</span>}
      </span>
      <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{formatCents(item.cents)}</span>
    </label>
  );
}

const startDraftOf = (data: Payload): StartDraft => {
  const s = data.start;
  const firstMonth = s?.firstMonth ?? (data.thisMonth > data.firstMonth ? monthBefore(data.thisMonth) : data.firstMonth);
  return {
    firstMonth,
    asOf: s?.asOf ?? lastDay(monthBefore(firstMonth)),
    balance: s ? dollars(s.balanceCents) : '',
    outstanding: new Set(s?.outstanding ?? []),
  };
};

const monthDraftOf = (v: MonthView): MonthDraft => ({
  month: v.month,
  seen: v.saved?.updatedAt ?? null,
  endsOn: v.endsOn,
  ending: v.endingCents === null ? '' : dollars(v.endingCents),
  ticked: new Set(v.items.filter((i) => i.ticked).map((i) => i.doc)),
});

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export default function BooksBankReconciliationPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [startDraft, setStartDraft] = useState<StartDraft | null>(null);
  const [allBefore, setAllBefore] = useState(false);
  const [draft, setDraft] = useState<MonthDraft | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [undoing, setUndoing] = useState<{ month: string; reason: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [actError, setActError] = useState<{ at: string; message: string } | null>(null);
  const [done, setDone] = useState<{ at: string; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/books/bank-reconciliation');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      const payload = json as Payload;
      setData(payload);
      setError('');
      const next = payload.months.find((m) => m.state === 'next');
      setDraft(next ? monthDraftOf(next) : null);
      return payload;
    } catch (e: any) {
      setError(e?.message || "Couldn't read the reconciliation");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    load().then((json) => {
      if (json && json.account && !json.start && json.can.keep) setStartDraft(startDraftOf(json));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const books: RecBooks | null = useMemo(() => (data?.start
    ? { start: data.start, recs: data.recs, ticks: data.ticks, events: data.events, docs: data.docs, openingCents: data.openingCents }
    : null), [data]);

  const post = async (at: string, body: Record<string, unknown>): Promise<any> => {
    setBusy(at);
    setActError(null);
    setDone(null);
    try {
      const res = await apiFetch('/api/admin/books/bank-reconciliation', {
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

  if (!data) {
    return (
      <div>
        <div style={{ fontSize: '20px', fontWeight: 800, marginBottom: '10px' }}>1084&apos;s bank reconciliation</div>
        {error ? <div style={banner(RED)}>{error}</div> : loading && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>}
      </div>
    );
  }

  const keep = data.can.keep;
  const anyDone = data.recs.some((r) => r.status === 'done');
  const savedMonths = data.recs.map((r) => r.month);

  // ── Where reconciling starts, as typed ─────────────────────────────────────
  const typedStart: RecStart | null = startDraft
    ? { firstMonth: startDraft.firstMonth, asOf: startDraft.asOf, balanceCents: parseDollars(startDraft.balance) ?? NaN, outstanding: [...startDraft.outstanding] }
    : null;
  const startTyped = typedStart && Number.isSafeInteger(typedStart.balanceCents)
    ? startView({ start: typedStart, docs: data.docs, openingCents: data.openingCents })
    : null;
  const before = startDraft ? data.docs.filter((d) => d.date <= startDraft.asOf).slice().reverse() : [];
  const letGo = startDraft && data.start && startDraft.firstMonth !== data.start.firstMonth ? savedMonths : [];

  const saveStart = async () => {
    if (!startDraft || !typedStart) return;
    const problems = Number.isSafeInteger(typedStart.balanceCents)
      ? startProblems(typedStart, { thisMonth: data.thisMonth, docs: data.docs })
      : ["Type the bank's starting balance like 12,345.67."];
    if (problems.length) { setActError({ at: 'start', message: problems.join(' ') }); return; }
    const ok = await post('start', {
      action: 'start', seen: data.start?.updatedAt ?? null, firstMonth: typedStart.firstMonth.slice(0, 7), asOf: typedStart.asOf,
      balanceCents: typedStart.balanceCents, outstanding: typedStart.outstanding,
    });
    if (!ok) return;
    setStartDraft(null);
    await load();
  };

  // ── The month being reconciled, as it's ticked ─────────────────────────────
  const endingCents = draft ? (draft.ending.trim() ? parseDollars(draft.ending) : null) : null;
  const endingBad = !!draft && draft.ending.trim() !== '' && endingCents === null;
  const live = books && draft ? nextView(books, { month: draft.month, endsOn: draft.endsOn, endingCents, ticked: draft.ticked }) : null;
  const savedNext = data.months.find((m) => m.state === 'next');
  // Typed or ticked since it was opened, and anything to save: that, or a month not saved yet.
  const draftDiffers = !!draft && !!savedNext && (draft.endsOn !== savedNext.endsOn || endingBad || endingCents !== savedNext.endingCents
    || !sameSet(draft.ticked, new Set(savedNext.items.filter((i) => i.ticked).map((i) => i.doc))));
  const draftChanged = draftDiffers || (!!savedNext && !savedNext.saved);

  const saveMonth = async (finish: boolean) => {
    if (!draft || !live) return;
    if (endingBad) { setActError({ at: draft.month, message: "The ending balance isn't an amount: type it like 12,345.67." }); return; }
    const open = new Set(live.items.map((i) => i.doc));
    const ok = await post(draft.month, {
      action: 'save', month: draft.month.slice(0, 7), seen: draft.seen, endsOn: draft.endsOn, endingCents,
      ticked: [...draft.ticked].filter((d) => open.has(d)), finish,
    });
    if (!ok) return;
    await load();
    setDone({ at: draft.month, message: ok.done ? `${monthName(draft.month)} is reconciled.` : `${monthName(draft.month)} is saved.` });
  };

  const undo = async (v: MonthView) => {
    if (!undoing || !v.saved) return;
    const ok = await post(v.month, { action: 'undo', month: v.month.slice(0, 7), seen: v.saved.updatedAt, reason: undoing.reason });
    if (!ok) return;
    setUndoing(null);
    await load();
    setDone({ at: v.month, message: `${monthName(v.month)} is open again, with what was ticked on it.` });
  };

  const lastDone = data.recs.filter((r) => r.status === 'done').map((r) => r.month).sort().pop() ?? null;
  const toggle = (doc: string) => draft && setDraft({
    ...draft, ticked: new Set(draft.ticked.has(doc) ? [...draft.ticked].filter((d) => d !== doc) : [...draft.ticked, doc]),
  });
  const tickAll = (items: RecItem[], on: boolean) => draft && setDraft({
    ...draft,
    ticked: new Set(on ? [...draft.ticked, ...items.map((i) => i.doc)] : [...draft.ticked].filter((d) => !items.some((i) => i.doc === d))),
  });

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>1084&apos;s bank reconciliation</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {data.company.name}&apos;s bank statements, month by month: each entry in its books ticked as it clears the bank.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              Tick each entry on the statement as it cleared, and type the statement&apos;s last day and ending balance. Once the starting
              balance and what&apos;s ticked come to the ending balance, the difference is $0.00 and Finish reconciling makes the month
              done; the next month starts from its ending balance. Months are reconciled in order, and only the last one done can be
              undone, with why. The books tie to the bank when what they have, less what hasn&apos;t cleared, is the bank&apos;s balance.
              The bookkeeper and super admins reconcile. Nothing here moves money or is sent to NetSuite.
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href={deepLinks.booksRentMortgage()} style={{ color: 'var(--text-secondary)' }}>Rent and mortgage</Link>
          {' · '}
          <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
          {' · '}
          <Link href="/admin/books/months" style={{ color: 'var(--text-secondary)' }}>Months</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}
      {!data.account && (
        <div style={banner(GREY)}>
          Pick 1084&apos;s bank account on <Link href={deepLinks.booksRentMortgage()} style={{ color: GREY }}>Rent and mortgage</Link>&apos;s setup first.
        </div>
      )}
      {data.capped && (
        <div style={banner(RED)}>1084&apos;s bank account has more entries than FleetSuite reads at once, so it isn&apos;t reconciled here.</div>
      )}
      {data.notPosted > 0 && (
        <div style={banner(GREY)}>
          NetSuite&apos;s copy has {data.notPosted === 1 ? 'an entry' : `${data.notPosted} entries`} on this account that FleetSuite&apos;s books
          haven&apos;t posted yet; {data.notPosted === 1 ? 'it shows' : 'they show'} here once posted.
        </div>
      )}

      {data.account && (
        <div style={{ ...card, marginBottom: '12px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '14px', fontWeight: 800 }}>Where reconciling starts</span>
            {!data.start && <span style={chip(AMBER)}>Not set</span>}
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{data.account.name}</span>
          </div>
          {data.start && data.startView && !startDraft && (
            <>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                With {monthName(data.start.firstMonth)}&apos;s statement, from the bank&apos;s {formatCents(data.start.balanceCents)} on {longDate(data.start.asOf)}.
                {data.startView.outstanding.length > 0 && ` ${data.startView.outstanding.length === 1 ? '1 entry' : `${data.startView.outstanding.length} entries`} hadn't cleared by then.`}
              </div>
              <div style={line(tieWords(data.startView.booksCents, data.startView.outstandingCents, data.start.balanceCents, data.start.asOf).color)}>
                {tieWords(data.startView.booksCents, data.startView.outstandingCents, data.start.balanceCents, data.start.asOf).words}
              </div>
              {data.startView.missing > 0 && (
                <div style={line(RED)}>
                  {data.startView.missing === 1 ? 'An entry' : `${data.startView.missing} entries`} picked as not cleared by then {data.startView.missing === 1 ? "isn't" : "aren't"} in the books by then now.
                </div>
              )}
              <div style={line(GREY)}>Saved{data.start.updatedBy ? ` by ${data.start.updatedBy}` : ''} {when(data.start.updatedAt)}</div>
            </>
          )}
          {!data.start && !startDraft && <div style={line(GREY)}>Pick the first month to reconcile and the bank&apos;s balance before it.</div>}

          {startDraft && (
            <div style={{ marginTop: '8px' }}>
              <div style={grid}>
                <div>
                  <span style={label}>The first statement to reconcile</span>
                  <select
                    value={startDraft.firstMonth}
                    onChange={(e) => setStartDraft({ ...startDraft, firstMonth: e.target.value, asOf: lastDay(monthBefore(e.target.value)) })}
                    disabled={busy === 'start'}
                    style={input}
                  >
                    {monthsFrom(data.firstMonth, data.thisMonth).reverse().map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
                  </select>
                </div>
                <div>
                  <span style={label}>Its starting balance is the bank&apos;s on</span>
                  <input type="date" value={startDraft.asOf} min={monthBefore(startDraft.firstMonth)} max={lastDay(monthBefore(startDraft.firstMonth))}
                    disabled={busy === 'start'} onChange={(e) => setStartDraft({ ...startDraft, asOf: e.target.value })} style={input} />
                </div>
                <div>
                  <span style={label}>The bank&apos;s balance then</span>
                  <input inputMode="decimal" value={startDraft.balance} placeholder="As the statement says" disabled={busy === 'start'}
                    onChange={(e) => setStartDraft({ ...startDraft, balance: e.target.value })} style={input} />
                </div>
              </div>
              {startTyped && (
                <div style={line(tieWords(startTyped.booksCents, startTyped.outstandingCents, typedStart!.balanceCents, startDraft.asOf).color)}>
                  {tieWords(startTyped.booksCents, startTyped.outstandingCents, typedStart!.balanceCents, startDraft.asOf).words}
                </div>
              )}
              {before.length > 0 && (
                <div style={{ marginTop: '8px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 800 }}>Tick each entry that hadn&apos;t cleared the bank by {longDate(startDraft.asOf)}</div>
                  {(allBefore ? before : before.slice(0, SHOWN)).map((d) => (
                    <EntryRow
                      key={d.doc}
                      item={{ ...d, ticked: startDraft.outstanding.has(d.doc) }}
                      disabled={busy === 'start'}
                      onTick={() => {
                        const o = new Set(startDraft.outstanding);
                        if (o.has(d.doc)) o.delete(d.doc); else o.add(d.doc);
                        setStartDraft({ ...startDraft, outstanding: o });
                      }}
                    />
                  ))}
                  {!allBefore && before.length > SHOWN && (
                    <button onClick={() => setAllBefore(true)} style={link}>Show all {before.length} entries by then</button>
                  )}
                </div>
              )}
              {letGo.length > 0 && (
                <div style={line(AMBER)}>
                  Starting with another month lets go of what&apos;s saved on {letGo.map((m) => monthName(m)).join(', ')}.
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                <button onClick={saveStart} disabled={busy === 'start'} style={act(GREEN, busy !== 'start')}>
                  {busy === 'start' ? 'Saving…' : 'Save where it starts'}
                </button>
                {data.start && (
                  <button onClick={() => { setStartDraft(null); setActError(null); }} disabled={busy === 'start'} style={act(null, busy !== 'start')}>
                    Leave without saving
                  </button>
                )}
              </div>
            </div>
          )}
          {keep && data.start && !startDraft && (
            anyDone
              ? <div style={line(GREY)}>It stays as it is once a month is reconciled.</div>
              : (
                <div style={{ marginTop: '8px' }}>
                  <button onClick={() => { setStartDraft(startDraftOf(data)); setActError(null); }} disabled={!!busy} style={act(null, !busy)}>
                    Change where it starts
                  </button>
                </div>
              )
          )}
          {actError?.at === 'start' && <div style={{ ...banner(RED), marginTop: '8px', marginBottom: 0 }}>{actError.message}</div>}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {data.months.map((saved) => {
          const v = saved.state === 'next' && live && draft?.month === saved.month ? live : saved;
          const open = v.state === 'next';
          const editing = open && keep && !!draft;
          const isShown = shown.has(v.month) || open;
          const ins = v.items.filter((i) => i.cents > 0);
          const outs = v.items.filter((i) => i.cents < 0);
          const tie = v.booksCents !== null && v.notClearedCents !== null && v.endingCents !== null
            ? tieWords(v.booksCents, v.notClearedCents, v.endingCents, v.endsOn) : null;
          const ticked = (list: RecItem[]) => list.filter((i) => i.ticked).length;
          return (
            <div key={v.month} style={card}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '2px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '14px', fontWeight: 800 }}>{monthName(v.month)}</span>
                {v.state === 'done' && <span style={chip(GREEN)}>Reconciled</span>}
                {open && <span style={chip(AMBER)}>{v.saved ? 'Being reconciled' : 'To reconcile'}</span>}
                {v.month === data.thisMonth && <span style={chip(GREY)}>This month</span>}
              </div>

              {v.state === 'later' && data.next && <div style={line(GREY)}>Reconcile {monthName(data.next)} first.</div>}

              {v.state === 'done' && v.endingCents !== null && (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  The statement ended {longDate(v.endsOn)} at {formatCents(v.endingCents)}: {v.items.length === 1 ? '1 entry' : `${v.items.length} entries`} cleared,
                  {' '}{formatCents(v.inCents)} in and {formatCents(v.outCents)} out, from {formatCents(v.startingCents ?? 0)}.
                </div>
              )}
              {v.changed.map((c) => (
                <div key={c.doc} style={line(RED)}>
                  {c.number} cleared at {formatCents(c.clearedCents)}; {c.nowCents ? `the books have ${formatCents(c.nowCents)} for it now` : "it's gone from the books"}.
                </div>
              ))}
              {v.state === 'done' && tie && <div style={line(tie.color)}>{tie.words}</div>}

              {open && (
                <div style={{ marginTop: '6px' }}>
                  <div style={grid}>
                    <div>
                      <span style={label}>The statement&apos;s last day</span>
                      {editing ? (
                        <input type="date" value={draft!.endsOn} min={v.month} max={lastDay(v.month)} disabled={busy === v.month}
                          onChange={(e) => setDraft({ ...draft!, endsOn: e.target.value })} style={input} />
                      ) : <div style={{ fontSize: '13px', fontWeight: 600 }}>{longDate(v.endsOn)}</div>}
                    </div>
                    <div>
                      <span style={label}>Its ending balance</span>
                      {editing ? (
                        <input inputMode="decimal" value={draft!.ending} placeholder="As the statement says" disabled={busy === v.month}
                          onChange={(e) => setDraft({ ...draft!, ending: e.target.value })} style={input} />
                      ) : <div style={{ fontSize: '13px', fontWeight: 600 }}>{v.endingCents === null ? 'Not typed' : formatCents(v.endingCents)}</div>}
                    </div>
                  </div>
                  {endingBad && editing && <div style={line(RED)}>The ending balance isn&apos;t an amount: type it like 12,345.67.</div>}
                  <div style={{ fontSize: '12px', marginTop: '6px' }}>
                    <div>Starting balance: {v.startingCents === null ? '—' : formatCents(v.startingCents)}</div>
                    <div>Cleared in: {formatCents(v.inCents)} ({ticked(ins)} of {ins.length})</div>
                    <div>Cleared out: {formatCents(v.outCents)} ({ticked(outs)} of {outs.length})</div>
                    <div>Cleared balance: {v.clearedCents === null ? '—' : formatCents(v.clearedCents)}</div>
                    {v.differenceCents !== null && (
                      <div style={{ fontWeight: 800, color: v.differenceCents === 0 ? GREEN : RED }}>
                        Difference: {formatCents(v.differenceCents)}{v.differenceCents === 0 ? ', ready to finish' : ''}
                      </div>
                    )}
                  </div>
                  {tie && <div style={line(tie.color)}>{tie.words}</div>}
                  {v.dropped > 0 && (
                    <div style={line(GREY)}>
                      {v.dropped === 1 ? 'An entry' : `${v.dropped} entries`} ticked before can&apos;t clear on this statement now, so {v.dropped === 1 ? "it's" : "they're"} left off.
                    </div>
                  )}
                </div>
              )}

              {(v.state === 'done' || open) && v.items.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  {v.state === 'done' && (
                    <button onClick={() => setShown(new Set(shown.has(v.month) ? [...shown].filter((m) => m !== v.month) : [...shown, v.month]))} style={link}>
                      {isShown ? 'Hide what cleared' : 'Show what cleared'}
                    </button>
                  )}
                  {isShown && ([['Money in', ins], ['Money out', outs]] as const).map(([title, list]) => list.length > 0 && (
                    <div key={title} style={{ marginTop: '6px' }}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <span style={{ fontSize: '12px', fontWeight: 800 }}>{title}</span>
                        {editing && (
                          <button onClick={() => tickAll(list, ticked(list) < list.length)} disabled={busy === v.month} style={link}>
                            {ticked(list) < list.length ? 'Tick all' : 'Untick all'}
                          </button>
                        )}
                      </div>
                      {list.map((i) => <EntryRow key={i.doc} item={i} onTick={editing ? () => toggle(i.doc) : undefined} disabled={busy === v.month} />)}
                    </div>
                  ))}
                </div>
              )}
              {open && v.items.length === 0 && <div style={line(GREY)}>The books have no entries to clear on this statement.</div>}

              {v.events.map((e, n) => <div key={n} style={line(GREY)}>{eventWords(e)}</div>)}

              {editing && (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                  <button onClick={() => saveMonth(false)} disabled={!!busy || !draftChanged} style={act(GREEN, !busy && draftChanged)}>
                    {busy === v.month ? 'Saving…' : `Save ${shortMonth(v.month)}`}
                  </button>
                  <button onClick={() => saveMonth(true)} disabled={!!busy || v.differenceCents !== 0} style={act(GREEN, !busy && v.differenceCents === 0)}>
                    Finish reconciling
                  </button>
                  {draftDiffers && savedNext && (
                    <button onClick={() => { setDraft(monthDraftOf(savedNext)); setActError(null); }} disabled={!!busy} style={act(null, !busy)}>
                      Leave without saving
                    </button>
                  )}
                </div>
              )}

              {keep && v.state === 'done' && v.month === lastDone && (
                undoing?.month === v.month ? (
                  <div style={{ marginTop: '8px' }}>
                    <span style={label}>Why it&apos;s undone</span>
                    <input value={undoing.reason} maxLength={300} placeholder="For the record" disabled={busy === v.month}
                      onChange={(e) => setUndoing({ month: v.month, reason: e.target.value })} style={input} />
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                      <button onClick={() => undo(v)} disabled={!!busy || !undoing.reason.trim()} style={act(RED, !busy && !!undoing.reason.trim())}>
                        {busy === v.month ? 'Undoing…' : `Undo ${shortMonth(v.month)}`}
                      </button>
                      <button onClick={() => { setUndoing(null); setActError(null); }} disabled={!!busy} style={act(null, !busy)}>Keep it reconciled</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: '8px' }}>
                    <button onClick={() => { setUndoing({ month: v.month, reason: '' }); setActError(null); setDone(null); }} disabled={!!busy} style={act(null, !busy)}>
                      Undo {shortMonth(v.month)}
                    </button>
                  </div>
                )
              )}
              {actError?.at === v.month && <div style={{ ...banner(RED), marginTop: '8px', marginBottom: 0 }}>{actError.message}</div>}
              {done?.at === v.month && <div style={{ ...banner(GREEN), marginTop: '8px', marginBottom: 0 }}>{done.message}</div>}
            </div>
          );
        })}
      </div>
      {data.start && !data.next && data.months.length > 0 && (
        <div style={{ ...line(GREEN), marginTop: '10px' }}>Each month is reconciled through {monthName(data.thisMonth)}.</div>
      )}
    </div>
  );
}
