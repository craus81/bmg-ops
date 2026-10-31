'use client';

/**
 * Inventory transfers made in FleetSuite and sent on to NetSuite (Books part
 * 38, docs/books.md "Inventory transfers made in FleetSuite"; owner decisions
 * 2026-10-31: from January 1, 2027 the team works only in FleetSuite, apart
 * from payments). Opened from More → Parts & Inventory → Inventory Transfers.
 *
 * Pick where the stock is and where it's going, add the items and how many,
 * Save, and Move: FleetSuite makes NetSuite's Transfer Inventory for it,
 * once, from the lines as saved, and never moves more than NetSuite has
 * where it's moving from. The rules are src/lib/inventory-transfers.ts, the
 * same ones /api/inventory-transfers checks and sends by. Built switched off
 * (Books → Switches): until it's on, super admins can make and save
 * transfers to see what they'd send, and nothing is moved.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import TopSaveBar from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import {
  MAX_LINES, MAX_QUANTITY, MEMO_MAX, QUANTITY_PLACES, hasTooManyPlaces, itemLabel, quantityText, workOutTransfer,
  type TransferCompany, type TransferItem, type TransferLine, type TransferStatus,
} from '@/lib/inventory-transfers';

const API = '/api/inventory-transfers';
/** As the route: how long a Move can say it's being made before Ask NetSuite finds out what became of it. */
const STALE_MS = 5 * 60 * 1000;

interface Transfer {
  id: string;
  company: string;
  date: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  memo: string | null;
  lines: Array<TransferLine & { itemNumber: string | null }>;
  status: TransferStatus;
  createdBy: string | null;
  createdById: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  sentBy: string | null;
  sentAt: string | null;
  transferId: string | null;
  number: string | null;
  error: string | null;
}

/** NetSuite's count of each item at each location, as Books' stock copy last read it. */
type Counts = Record<string, Record<string, number>>;

interface Loaded {
  companies: TransferCompany[];
  transfers: Transfer[];
  items: Record<string, TransferItem>;
  counts: Counts;
  countsReadAt: string | null;
  me: string;
  superAdmin: boolean;
  switchedOn: boolean;
  offText: string | null;
}

/** A line as it's typed: its quantity is text until it's saved. */
interface EditLine { key: string; itemId: string; quantity: string }

/** The transfer being made, new or a draft opened. */
interface Draft { id: string; company: string; date: string; fromLocationId: string; toLocationId: string; memo: string; lines: EditLine[] }

/** The search for one line's item. */
interface Search { key: string; text: string; items: TransferItem[]; loading: boolean; error: string | null }

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

let lineSeq = 0;
const lineKey = () => `line-${++lineSeq}`;
const blankLine = (): EditLine => ({ key: lineKey(), itemId: '', quantity: '' });
const editLines = (lines: TransferLine[]): EditLine[] => lines.map((l) => ({
  key: lineKey(), itemId: l.itemId ?? '', quantity: l.quantity > 0 ? quantityText(l.quantity) : '',
}));
const toDraft = (t: Transfer): Draft => ({
  id: t.id, company: t.company, date: t.date, fromLocationId: t.fromLocationId ?? '', toLocationId: t.toLocationId ?? '',
  memo: t.memo ?? '', lines: editLines(t.lines),
});

/** What's typed in a quantity box: 0 when it's empty, NaN when it isn't a number. */
const typedQuantity = (text: string) => {
  const t = text.replace(/,/g, '').trim();
  if (t === '') return 0;
  return /^(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN;
};
const draftLines = (d: Draft): TransferLine[] => d.lines.map((l) => ({ itemId: l.itemId || null, quantity: typedQuantity(l.quantity) }));
/** A draft as it'd be saved, to tell whether anything's changed. */
const shape = (d: Draft) => JSON.stringify({
  company: d.company, date: d.date, from: d.fromLocationId, to: d.toLocationId, memo: d.memo.trim(), lines: draftLines(d),
});
/** The O'Fallon location, where the stock usually is, or a company's first. */
const mainLocation = (c: TransferCompany | undefined) => c?.locations.find((l) => /fallon/i.test(l.name)) ?? c?.locations[0];

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

const STATUS: Record<TransferStatus, { text: string; color: string }> = {
  draft: { text: 'Draft', color: theme.textMuted },
  sending: { text: 'Being made in NetSuite', color: theme.warning },
  made: { text: 'In NetSuite', color: theme.success },
};

export default function InventoryTransfersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { isAdmin, loading: authLoading } = useAuth();

  const [openId, setOpenId] = useState(() => (searchParams.get('id') || '').trim());
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  /** Items found by searching, with NetSuite's counts of them, on top of the ones the transfers name. */
  const [found, setFound] = useState<{ items: Record<string, TransferItem>; counts: Counts; readAt: string | null }>({ items: {}, counts: {}, readAt: null });
  const [search, setSearch] = useState<Search | null>(null);

  const allowed = !authLoading && isAdmin;

  const load = useCallback(async (id: string): Promise<Loaded | null> => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(id ? `${API}?${new URLSearchParams({ id })}` : API);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't open inventory transfers (${res.status}).`);
      setData(body as Loaded);
      return body as Loaded;
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't open inventory transfers.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /** Reads the transfers again, with this one open: typed into when it's a draft. */
  const refresh = useCallback(async (id: string) => {
    const fresh = await load(id);
    const t = fresh?.transfers.find((x) => x.id === id);
    setDraft(t?.status === 'draft' ? toDraft(t) : null);
  }, [load]);

  // The transfer the link opened, once the page can open it.
  const firstId = useRef(openId);
  useEffect(() => { if (allowed) refresh(firstId.current); }, [allowed, refresh]);

  // Finds the items a line's search names, a moment after typing stops.
  const searchKey = search?.key ?? '';
  const searchText = search?.text ?? '';
  useEffect(() => {
    if (!searchKey || searchText.trim().length < 2) return;
    const timer = setTimeout(async () => {
      const mine = (s: Search | null) => !!s && s.key === searchKey && s.text === searchText;
      try {
        const res = await apiFetch(`${API}?${new URLSearchParams({ q: searchText })}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Couldn't search the parts (${res.status}).`);
        const list = (body.items ?? []) as TransferItem[];
        setFound((f) => ({
          items: { ...f.items, ...Object.fromEntries(list.map((i) => [i.id, i])) },
          counts: { ...f.counts, ...(body.counts ?? {}) },
          readAt: body.countsReadAt && (!f.readAt || body.countsReadAt > f.readAt) ? body.countsReadAt : f.readAt,
        }));
        setSearch((s) => (mine(s) ? { ...s!, items: list, loading: false, error: null } : s));
      } catch (e: any) {
        setSearch((s) => (mine(s) ? { ...s!, items: [], loading: false, error: e?.message || "Couldn't search the parts." } : s));
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [searchKey, searchText]);

  const items = useMemo(() => new Map<string, TransferItem>(Object.entries({ ...(data?.items ?? {}), ...found.items })), [data, found]);
  const counts = useMemo<Counts>(() => ({ ...(data?.counts ?? {}), ...found.counts }), [data, found]);
  const countsReadAt = [data?.countsReadAt, found.readAt].filter((x): x is string => !!x).sort().pop() ?? null;
  const companyOf = (code: string) => data?.companies.find((c) => c.code === code);
  const placeName = (company: string, id: string | null) =>
    (id ? companyOf(company)?.locations.find((l) => l.id === id)?.name ?? `location ${id}` : 'not picked yet');
  const fromTo = (t: { company: string; fromLocationId: string | null; toLocationId: string | null }) =>
    `${placeName(t.company, t.fromLocationId)} → ${placeName(t.company, t.toLocationId)}`;

  const transfer = data?.transfers.find((t) => t.id === openId) ?? null;
  const savedDraft = transfer?.status === 'draft' ? transfer : null;
  const dirty = !!draft && (!savedDraft || shape(draft) !== shape(toDraft(savedDraft)));

  const worked = useMemo(() => {
    const t = draft
      ? { date: draft.date, fromLocationId: draft.fromLocationId || null, toLocationId: draft.toLocationId || null, memo: draft.memo, lines: draftLines(draft) }
      : transfer;
    if (!t) return null;
    return workOutTransfer(t, { company: data?.companies.find((c) => c.code === (draft?.company ?? transfer?.company)) ?? null, items });
  }, [draft, transfer, data, items]);

  const clearSaid = () => { setError(null); setProblems([]); setDone(null); };

  const go = (id: string) => {
    setOpenId(id);
    router.replace(deepLinks.inventoryTransfers(id || null), { scroll: false });
  };

  /** Leaves what's typed and not saved only when that's what's wanted. */
  const leaveOk = async () => !dirty || dialog.confirm("What you've typed isn't saved. Leave it?", { confirmLabel: 'Leave it', title: 'Not saved' });

  const open = async (t: Transfer) => {
    if (!(await leaveOk())) return;
    clearSaid();
    setSearch(null);
    go(t.id);
    setDraft(t.status === 'draft' ? toDraft(t) : null);
    window.scrollTo({ top: 0 });
  };

  const close = async () => {
    if (!(await leaveOk())) return;
    clearSaid();
    setSearch(null);
    go('');
    setDraft(null);
  };

  /** Starts a new transfer: blank, a copy of one made, or one moving it back where it came from. */
  const start = async (from?: Transfer, back = false) => {
    if (!(await leaveOk())) return;
    clearSaid();
    setSearch(null);
    const company = from ? companyOf(from.company) : data?.companies.find((c) => c.code === 'BMG') ?? data?.companies[0];
    const memo = !from ? '' : back ? `Moves back ${from.number || 'a transfer'}${from.memo ? `: ${from.memo}` : ''}` : from.memo ?? '';
    const d: Draft = {
      id: newId(),
      company: from?.company ?? company?.code ?? '',
      date: today(),
      fromLocationId: (from ? (back ? from.toLocationId : from.fromLocationId) : mainLocation(company)?.id) ?? '',
      toLocationId: (from ? (back ? from.fromLocationId : from.toLocationId) : '') ?? '',
      memo: memo.slice(0, MEMO_MAX),
      lines: from ? editLines(from.lines) : [blankLine()],
    };
    setOpenId(d.id);
    setDraft(d);
    window.scrollTo({ top: 0 });
  };

  const change = (p: Partial<Draft>) => { setDraft((d) => (d ? { ...d, ...p } : d)); setError(null); setDone(null); };
  const pickCompany = (code: string) => change({ company: code, fromLocationId: mainLocation(companyOf(code))?.id ?? '', toLocationId: '' });
  const changeLine = (key: string, p: Partial<EditLine>) => {
    setDraft((d) => (d ? { ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) } : d));
    setError(null);
    setDone(null);
  };
  const pick = (key: string, item: TransferItem) => { changeLine(key, { itemId: item.id }); setSearch(null); };

  const post = async (payload: Record<string, unknown>) => {
    const res = await apiFetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && !!body.success, status: res.status, body };
  };

  /** What stops what's typed being saved at all: a quantity that isn't one, and no date. */
  const typedProblem = (d: Draft): string | null => {
    for (const [i, l] of draftLines(d).entries()) {
      if (Number.isNaN(l.quantity)) return `Line ${i + 1}'s quantity isn't a number: type it like 12 or 2.5.`;
      if (l.quantity > MAX_QUANTITY) return `Line ${i + 1} moves more than ${MAX_QUANTITY.toLocaleString('en-US')}.`;
      if (hasTooManyPlaces(l.quantity)) return `Line ${i + 1}'s quantity takes ${QUANTITY_PLACES} places at most.`;
    }
    return d.date ? null : 'Pick the date.';
  };

  /** Saves the draft. Returns when it was saved, or null when it wasn't. */
  const save = async (): Promise<string | null> => {
    if (!draft) return null;
    const bad = typedProblem(draft);
    if (bad) { setError(bad); return null; }
    setBusy('save');
    setError(null);
    setProblems([]);
    try {
      const { ok, status, body } = await post({
        action: 'save', id: draft.id, company: draft.company, date: draft.date, fromLocationId: draft.fromLocationId || null,
        toLocationId: draft.toLocationId || null, memo: draft.memo, lines: draftLines(draft),
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

  /** Move on a draft makes the transfer in NetSuite; on one being made a while, it asks NetSuite what became of it. */
  const move = async () => {
    const t = draft ?? transfer;
    if (!t || !worked) return;
    if (transfer?.status !== 'sending') {
      if (worked.problems.length > 0) { clearSaid(); setProblems(worked.problems); return; }
      const ok = await dialog.confirm(
        `Move ${plural(worked.lines.length, 'item')} from ${placeName(t.company, worked.fromLocationId)} to ${placeName(t.company, worked.toLocationId)} `
          + `in NetSuite, dated ${day(worked.date)}? NetSuite moves them at the cost it carries them at, and only moving them back undoes it.`,
        { confirmLabel: 'Move in NetSuite', title: 'Move stock' },
      );
      if (!ok) return;
    }
    const updatedAt = draft && dirty ? await save() : transfer?.updatedAt;
    if (!updatedAt) return;
    setBusy('move');
    clearSaid();
    try {
      const { ok, status, body } = await post({ action: 'move', id: t.id, updatedAt });
      if (!ok) {
        if (body.problems?.length) {
          setProblems(body.problems);
          throw new Error('Nothing was moved. Fix these first:');
        }
        throw new Error(body.error || `Nothing was moved (${status}).`);
      }
      setDone(`${body.already ? 'It was already moved' : 'Moved'} in NetSuite: transfer ${body.number || body.transferId}.`);
      await refresh(t.id);
    } catch (e: any) {
      setError(e?.message || 'Nothing was moved.');
      await refresh(t.id);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!draft) return;
    if (!savedDraft) { setDraft(null); go(''); return; }
    const ok = await dialog.confirm("Delete this draft? Nothing was moved, and it can't be got back.", {
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
      setDone('Draft deleted.');
      await load('');
    } catch (e: any) {
      setError(e?.message || "It wasn't deleted.");
    } finally {
      setBusy(null);
    }
  };

  if (!authLoading && !isAdmin) {
    return <div style={{ padding: '24px', color: theme.error }}>Only admins can move stock between locations.</div>;
  }

  const lists = (data?.transfers ?? []).reduce<Record<TransferStatus, Transfer[]>>((by, t) => {
    by[t.status].push(t);
    return by;
  }, { sending: [], draft: [], made: [] });
  lists.made.sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''));

  const several = (data?.companies.length ?? 0) > 1;
  const company = draft ? companyOf(draft.company) : undefined;
  const locations = company?.locations ?? [];
  const canDelete = !savedDraft || !!data?.superAdmin || savedDraft.createdById === data?.me;
  const stale = transfer?.status === 'sending' && Date.now() - Date.parse(transfer.sentAt ?? '') > STALE_MS;
  /** NetSuite's count of an item at a location, as the stock copy last read it; undefined when it has none of the item. */
  const countAt = (itemId: string, locationId: string) => (counts[itemId] && locationId ? counts[itemId][locationId] ?? 0 : undefined);

  const row = (t: Transfer) => (
    <button key={t.id} type="button" onClick={() => open(t)}
      style={{
        display: 'grid', gap: '2px', width: '100%', textAlign: 'left', background: 'none', border: 'none',
        borderTop: `1px solid ${theme.border}`, padding: '10px 0 0', cursor: 'pointer', color: theme.textPrimary,
      }}>
      <span style={{ ...twoLines, fontSize: '14px', fontWeight: 700 }}>{t.memo || 'No memo yet'}</span>
      <span style={muted}>
        {[day(t.date), several ? companyOf(t.company)?.name ?? t.company : '', fromTo(t), plural(t.lines.length, 'item'),
          t.status === 'made' ? t.number || `NetSuite ${t.transferId}` : ''].filter(Boolean).join(' · ')}
      </span>
      {t.status !== 'made' && t.error && <span style={{ ...red, ...twoLines, fontSize: '12px' }}>Not moved: {t.error}</span>}
    </button>
  );

  const section = (title: string, list: Transfer[], empty?: string) => (list.length > 0 || empty) && (
    <div style={{ ...card, display: 'grid', gap: '10px' }}>
      <div style={heading}>{title}</div>
      {list.length > 0 ? list.map(row) : <div style={muted}>{empty}</div>}
    </div>
  );

  const said = (
    <>
      {done && (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: theme.success }}>{done}</div>
        </div>
      )}
      {(error || problems.length > 0) && (
        <div style={{ display: 'grid', gap: '2px' }}>
          {error && <div style={red}>{error}</div>}
          {problems.map((p, i) => <div key={`${i}-${p}`} style={red}>{p}</div>)}
        </div>
      )}
    </>
  );

  return (
    <div style={{ maxWidth: '860px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {draft && dirty && (
        <TopSaveBar
          title={savedDraft ? 'Inventory transfer' : 'New inventory transfer'}
          subtitle={savedDraft ? 'Changed, not saved' : 'Not saved yet'}
          error={error || undefined}
          onSave={() => { save(); }}
          saving={busy === 'save'}
          saveLabel="Save"
          savingLabel="Saving…"
          onCancel={() => { if (savedDraft) setDraft(toDraft(savedDraft)); else { setDraft(null); go(''); } setError(null); setSearch(null); }}
          cancelLabel={savedDraft ? 'Undo changes' : 'Discard'}
        />
      )}
      <div>
        <button onClick={() => (openId ? close() : router.push('/more'))}
          style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>
          {openId ? '← Inventory transfers' : '← More'}
        </button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Inventory transfers</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>Move stock from one location to another. FleetSuite makes the transfer in NetSuite, once.</div>
      </div>

      {data?.offText && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {loading && !data ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Opening inventory transfers…</div>
      ) : loadError || !data ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={red}>{loadError || "Couldn't open inventory transfers."}</div>
          <div><button onClick={() => refresh(openId)} style={btn}>Try again</button></div>
        </div>
      ) : draft ? (
        <div style={{ ...card, display: 'grid', gap: '12px' }}>
          {savedDraft?.error && <div style={{ ...red, fontSize: '14px' }}>The last Move didn&apos;t make it: {savedDraft.error}</div>}
          {several && (
            <div>
              <div style={label}>Company</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {data.companies.map((c) => (
                  <button key={c.code} type="button" aria-pressed={c.code === draft.company} onClick={() => pickCompany(c.code)}
                    style={{ ...small, borderColor: c.code === draft.company ? theme.successBorder : theme.border, background: c.code === draft.company ? theme.successBg : theme.card }}>
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {company && locations.length < 2 && (
            <div style={red}>{company.name} has {locations.length === 0 ? 'no locations' : 'one location'} in NetSuite, so there&apos;s nowhere to move its stock to.</div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
            <div>
              <label style={label} htmlFor="it-from">From</label>
              <select id="it-from" style={input} value={draft.fromLocationId} onChange={(e) => change({ fromLocationId: e.target.value })}>
                <option value="">Where the stock is now</option>
                {draft.fromLocationId && !locations.some((l) => l.id === draft.fromLocationId) && (
                  <option value={draft.fromLocationId}>A location {company?.name ?? 'this company'} doesn&apos;t have</option>
                )}
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label style={label} htmlFor="it-to">To</label>
              <select id="it-to" style={input} value={draft.toLocationId} onChange={(e) => change({ toLocationId: e.target.value })}>
                <option value="">Where it&apos;s going</option>
                {draft.toLocationId && !locations.some((l) => l.id === draft.toLocationId) && (
                  <option value={draft.toLocationId}>A location {company?.name ?? 'this company'} doesn&apos;t have</option>
                )}
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label style={label} htmlFor="it-date">Date</label>
              <input id="it-date" type="date" style={input} value={draft.date} onChange={(e) => change({ date: e.target.value })} />
            </div>
            <div>
              <label style={label} htmlFor="it-memo">Memo</label>
              <input id="it-memo" style={input} maxLength={MEMO_MAX} placeholder="Why it's moving, as NetSuite shows it" value={draft.memo}
                onChange={(e) => change({ memo: e.target.value })} />
            </div>
          </div>

          {draft.lines.map((l, i) => {
            const item = l.itemId ? items.get(l.itemId) : undefined;
            const s = search?.key === l.key ? search : null;
            const have = l.itemId ? countAt(l.itemId, draft.fromLocationId) : undefined;
            const there = l.itemId ? countAt(l.itemId, draft.toLocationId) : undefined;
            const q = typedQuantity(l.quantity);
            return (
              <div key={l.key} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '10px', display: 'grid', gap: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                  <span style={label}>Item {i + 1}</span>
                  {draft.lines.length > 1 && (
                    <button type="button" aria-label={`Take off item ${i + 1}`}
                      onClick={() => { change({ lines: draft.lines.filter((x) => x.key !== l.key) }); if (s) setSearch(null); }}
                      style={{ ...small, padding: '2px 8px', color: theme.error, borderColor: theme.errorBorder }}>✕</button>
                  )}
                </div>
                {l.itemId && !s ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <span style={{ minWidth: 0, fontSize: '14px', fontWeight: 700, color: theme.textPrimary, wordBreak: 'break-word' }}>
                      {item ? itemLabel(item) : `NetSuite item ${l.itemId}`}
                    </span>
                    <button type="button" style={small} onClick={() => setSearch({ key: l.key, text: '', items: [], loading: false, error: null })}>Change</button>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: '4px' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input aria-label={`Search for item ${i + 1}`} style={input} placeholder="Search parts by number or name" value={s?.text ?? ''}
                        onChange={(e) => setSearch({ key: l.key, text: e.target.value, items: s?.items ?? [], loading: e.target.value.trim().length >= 2, error: null })} />
                      {l.itemId && <button type="button" style={small} onClick={() => setSearch(null)}>Keep it</button>}
                    </div>
                    {s?.loading && <div style={muted}>Searching…</div>}
                    {s?.error && <div style={red}>{s.error}</div>}
                    {s && !s.loading && !s.error && s.text.trim().length >= 2 && s.items.length === 0 && (
                      <div style={muted}>No active part NetSuite keeps stock of has that in its number or name.</div>
                    )}
                    {s?.items.map((it) => {
                      const n = countAt(it.id, draft.fromLocationId);
                      return (
                        <button key={it.id} type="button" onClick={() => pick(l.key, it)} style={{ ...small, textAlign: 'left', fontWeight: 600 }}>
                          {itemLabel(it)}{n !== undefined ? ` · ${quantityText(n)} at ${placeName(draft.company, draft.fromLocationId)}` : ''}
                        </button>
                      );
                    })}
                  </div>
                )}
                <input aria-label={`How many of item ${i + 1}`} inputMode="decimal" style={{ ...input, ...num }} placeholder="How many" value={l.quantity}
                  onChange={(e) => changeLine(l.key, { quantity: e.target.value })} />
                {(have !== undefined || there !== undefined) && (
                  <div style={muted}>
                    NetSuite counted {[have !== undefined ? `${quantityText(have)} at ${placeName(draft.company, draft.fromLocationId)}` : '',
                      there !== undefined ? `${quantityText(there)} at ${placeName(draft.company, draft.toLocationId)}` : ''].filter(Boolean).join(' and ')}.
                  </div>
                )}
                {have !== undefined && q > have && (
                  <div style={{ ...muted, color: theme.warning, fontWeight: 700 }}>
                    That&apos;s more than NetSuite counted at {placeName(draft.company, draft.fromLocationId)}. It counts again before anything moves.
                  </div>
                )}
              </div>
            );
          })}
          <div>
            <button type="button" onClick={() => change({ lines: [...draft.lines, blankLine()] })} disabled={draft.lines.length >= MAX_LINES}
              style={{ ...small, ...(draft.lines.length >= MAX_LINES ? off : {}) }}>+ Add item</button>
          </div>
          {countsReadAt && <div style={muted}>Counts are NetSuite&apos;s, as Books last copied them {when(countsReadAt)}.</div>}
          {said}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {dirty && (
              <button type="button" onClick={() => { save(); }} disabled={busy !== null} style={{ ...green, ...(busy !== null ? off : {}) }}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
            )}
            <button type="button" onClick={move} disabled={!data.switchedOn || busy !== null}
              style={{ ...btn, ...(!data.switchedOn || busy !== null ? off : {}) }}>
              {busy === 'move' ? 'Moving in NetSuite…' : !data.switchedOn ? 'Moving is switched off' : dirty ? 'Save and move in NetSuite' : 'Move in NetSuite'}
            </button>
            {canDelete && (
              <button type="button" onClick={remove} disabled={busy !== null} style={{ ...btn, color: theme.error, borderColor: theme.errorBorder }}>
                {savedDraft ? 'Delete draft' : 'Discard'}
              </button>
            )}
          </div>
        </div>
      ) : transfer ? (
        <div style={{ ...card, display: 'grid', gap: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary, wordBreak: 'break-word' }}>{transfer.memo || 'No memo'}</div>
              <div style={muted}>{[day(transfer.date), several ? companyOf(transfer.company)?.name ?? transfer.company : ''].filter(Boolean).join(' · ')}</div>
            </div>
            <span style={{ fontSize: '13px', fontWeight: 800, color: STATUS[transfer.status].color }}>
              {transfer.status === 'made' ? `${STATUS.made.text}: ${transfer.number || transfer.transferId}` : STATUS[transfer.status].text}
            </span>
          </div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{fromTo(transfer)}</div>
          <div style={muted}>
            {[transfer.createdBy ? `Started by ${transfer.createdBy}` : '',
              transfer.sentBy ? `moved by ${transfer.sentBy} ${when(transfer.sentAt)}` : ''].filter(Boolean).join(' · ')}
          </div>
          {transfer.status === 'sending' && transfer.error && (
            <div style={red}>FleetSuite can&apos;t tell whether NetSuite made it ({transfer.error}).</div>
          )}
          {transfer.lines.map((l, i) => {
            const it = l.itemId ? items.get(l.itemId) : undefined;
            return (
              <div key={`${i}-${l.itemId}`} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '8px', display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                <div style={{ minWidth: 0, fontSize: '14px', fontWeight: 700, color: theme.textPrimary, wordBreak: 'break-word' }}>
                  {it ? itemLabel(it) : l.itemNumber || `NetSuite item ${l.itemId ?? 'not picked'}`}
                </div>
                <div style={{ ...num, fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{quantityText(l.quantity)}</div>
              </div>
            );
          })}
          {said}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {stale && data.switchedOn && (
              <button type="button" onClick={move} disabled={busy !== null} style={btn}>{busy === 'move' ? 'Asking NetSuite…' : 'Ask NetSuite'}</button>
            )}
            {transfer.status === 'made' && (
              <>
                <button type="button" onClick={() => start(transfer)} style={btn}>Copy</button>
                <button type="button" onClick={() => start(transfer, true)} style={btn}>Move it back</button>
              </>
            )}
          </div>
          {transfer.status === 'sending' && !stale && (
            <div style={muted}>It&apos;s being made in NetSuite now. Reload in a minute to see it.</div>
          )}
        </div>
      ) : (
        <>
          {openId && !loading && <div style={red}>There&apos;s no such transfer: it may have been deleted.</div>}
          {said}
          <div>
            <button type="button" onClick={() => start()} style={green}>+ New transfer</button>
          </div>
          {section('Being made in NetSuite', lists.sending)}
          {section('Drafts', lists.draft, lists.sending.length + lists.made.length === 0 ? 'No transfers yet.' : undefined)}
          {section('In NetSuite', lists.made)}
        </>
      )}
    </div>
  );
}
