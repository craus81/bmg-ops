'use client';

/**
 * Counts (Books part 69, migration 499, src/lib/stock-counts.ts,
 * docs/books.md "Counts"; the NetSuite Exit Checklist's Count screen),
 * linked from the Inventory page. Start a count at a location, everything
 * NetSuite has on hand there, the items matching a search, or items picked,
 * print its sheet or type the counts in on a phone, and Save. NetSuite's
 * counts stay out of sight while counting; each count saved is kept with
 * NetSuite's live count as it's saved, and the review below shows what
 * differs. Ask for approval, and a super admin who didn't ask approves it,
 * which posts every difference in NetSuite as one Inventory Adjustment, or
 * turns it down saying why. Built switched off (Books → Switches): until
 * it's on, super admins can count and ask to see what a count would post,
 * and nothing goes to NetSuite. Nobody is alerted (Craig, 2026-10-30: no
 * alerts for adjustments).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import TopSaveBar from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import { openCountSheetPdf } from '@/lib/count-sheet-pdf';
import { quantityText } from '@/lib/inventory-transfers';
import {
  MAX_LINES, STATUS_TEXT, blockedText, describeLine, differenceOf, movedWhileCounting, needsAsking, parseCounted, reviewCount,
  type BlockedLine, type CountKind, type CountLine, type CountStatus, type StockCount,
} from '@/lib/stock-counts';

const API = '/api/inventory/counts';

interface OpenCount extends StockCount { progress: { items: number; counted: number } }

interface ListData {
  locations: { id: string; name: string }[];
  defaultLocationId: string | null;
  open: OpenCount[];
  done: StockCount[];
  today: string;
  me: string;
  superAdmin: boolean;
  switchedOn: boolean;
  offText: string | null;
}

interface OneData {
  count: StockCount;
  lines: CountLine[];
  blocked: BlockedLine[];
  /** NetSuite's average cost at the location by item, for whoever sees money; null otherwise. */
  averages: Record<string, number> | null;
  today: string;
  me: string;
  superAdmin: boolean;
  switchedOn: boolean;
  offText: string | null;
}

/** An item found by searching, to pick or add. */
interface Found { netsuiteItemId: string; itemNumber: string; displayName: string | null }

interface Preview { items: number; more: number; matched: number; what: string; first: string; last: string; leftOff: number; leftOffText: string | null; readAt: string | null }

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

const day = (ymd: string) => (ymd ? new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const money = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const label = (f: Found) => (f.displayName && f.displayName !== f.itemNumber ? `${f.itemNumber} · ${f.displayName}` : f.itemNumber);

const card: React.CSSProperties = { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px' };
const fieldLabel: React.CSSProperties = {
  display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: theme.textMuted, marginBottom: '3px',
};
// 16px so a phone doesn't zoom in on the box.
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '7px', border: `1px solid ${theme.border}`,
  background: theme.inputBg, color: theme.textPrimary, fontSize: '16px',
};
const btn: React.CSSProperties = {
  padding: '9px 14px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.card, color: theme.textPrimary,
  fontSize: '14px', fontWeight: 700, cursor: 'pointer',
};
const GREEN = '#22c55e';
const go: React.CSSProperties = { ...btn, background: GREEN, borderColor: GREEN, color: '#fff' };
const small: React.CSSProperties = { ...btn, padding: '6px 10px', fontSize: '13px' };
const muted: React.CSSProperties = { fontSize: '12px', color: theme.textMuted };
const red: React.CSSProperties = { fontSize: '13px', color: theme.error, fontWeight: 700 };
const heading: React.CSSProperties = { fontSize: '15px', fontWeight: 800, color: theme.textPrimary };

const CHIP: Record<CountStatus, { bg: string; color: string }> = {
  counting: { bg: theme.warningBg, color: theme.warning },
  asked: { bg: theme.warningBg, color: theme.warning },
  sending: { bg: theme.subtleBg, color: theme.textSecondary },
  unsure: { bg: theme.errorBg, color: theme.error },
  made: { bg: theme.successBg, color: theme.success },
  cancelled: { bg: theme.subtleBg, color: theme.textMuted },
};

function Chip({ status }: { status: CountStatus }) {
  return (
    <span style={{ fontSize: '10px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', background: CHIP[status].bg, color: CHIP[status].color, whiteSpace: 'nowrap' }}>
      {STATUS_TEXT[status]}
    </span>
  );
}

/** Reads a route's answer: its body, or its error in words. */
async function call(url: string, body?: Record<string, unknown>): Promise<{ ok: boolean; json: any }> {
  try {
    const res = await apiFetch(url, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, json: res.ok ? json : { ...json, error: json.error || `Request failed (${res.status})` } };
  } catch {
    return { ok: false, json: { error: "Couldn't reach FleetSuite. Check your connection, then look here again before trying once more." } };
  }
}

/** Finds the items NetSuite keeps stock of a moment after typing stops. */
function useItemSearch(text: string) {
  const [found, setFound] = useState<Found[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) { setFound([]); setError(null); return; }
    let stale = false;
    const t = setTimeout(async () => {
      const { ok, json } = await call(`${API}?${new URLSearchParams({ q })}`);
      if (stale) return;
      setFound(ok ? json.items ?? [] : []);
      setError(ok ? null : json.error);
    }, 300);
    return () => { stale = true; clearTimeout(t); };
  }, [text]);
  return { found, error };
}

export default function CountsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin, loading: authLoading } = useAuth();
  const id = (searchParams.get('id') || '').trim();

  useEffect(() => {
    if (!authLoading && !isAdmin) router.push('/home');
  }, [authLoading, isAdmin, router]);

  if (authLoading || !isAdmin) return null;
  return (
    <div style={{ padding: '16px', maxWidth: '820px', margin: '0 auto', display: 'grid', gap: '14px' }}>
      {id ? <CountView key={id} id={id} /> : <CountList />}
    </div>
  );
}

// ── The list, and starting a count ─────────────────────────────────────────

function CountList() {
  const router = useRouter();
  const [data, setData] = useState<ListData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, json } = await call(API);
    if (ok) { setData(json); setLoadError(null); } else setLoadError(json.error);
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div>
        <Link href="/admin/inventory" style={{ fontSize: '12px', color: theme.textMuted }}>← Inventory</Link>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Counts</h1>
        <div style={{ ...muted, fontSize: '13px', maxWidth: '640px' }}>
          Count a location&apos;s stock, all of it or a part. What differs from NetSuite is asked for as one, and a super admin who didn&apos;t ask
          approves it as one NetSuite adjustment.
        </div>
        {data?.offText && <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textSecondary, marginTop: '6px' }}>{data.offText}</div>}
      </div>
      {loadError && <div style={red}>{loadError}</div>}
      {!data && !loadError && <div style={muted}>Loading…</div>}
      {data && (
        <>
          <StartCount data={data} onStarted={(countId) => router.push(deepLinks.stockCounts(countId))} />
          <div style={{ display: 'grid', gap: '8px' }}>
            <div style={{ ...heading, fontSize: '13px', color: theme.textSecondary }}>Open · {data.open.length}</div>
            {data.open.length === 0 && <div style={muted}>No count is open.</div>}
            {data.open.map((c) => (
              <Link key={c.id} href={deepLinks.stockCounts(c.id)} style={{ ...card, display: 'grid', gap: '4px', textDecoration: 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <span style={heading}>{c.label} · {c.locationName}</span>
                  <Chip status={c.status} />
                </div>
                <div style={{ fontSize: '13px', color: theme.textSecondary }}>{c.what}</div>
                <div style={muted}>
                  {c.progress.counted.toLocaleString('en-US')} of {plural(c.progress.items, 'item')} counted · started by{' '}
                  {c.startedBy === data.me ? 'you' : c.startedByName || 'someone'}, {when(c.startedAt)}
                </div>
              </Link>
            ))}
          </div>
          {data.done.length > 0 && (
            <div style={{ display: 'grid', gap: '6px' }}>
              <div style={{ ...heading, fontSize: '13px', color: theme.textSecondary }}>Done lately</div>
              <div style={{ ...card, padding: '4px 12px' }}>
                {data.done.map((c, i) => (
                  <Link key={c.id} href={deepLinks.stockCounts(c.id)}
                    style={{ display: 'grid', gap: '2px', padding: '8px 0', borderTop: i ? `1px solid ${theme.border}` : 'none', textDecoration: 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, color: theme.textPrimary }}>{c.label} · {c.locationName} · {c.what}</span>
                      <span style={{ fontSize: '11px', fontWeight: 800, color: CHIP[c.status].color }}>
                        {STATUS_TEXT[c.status]}{c.netsuiteNumber ? ` · ${c.netsuiteNumber}` : ''}
                      </span>
                    </div>
                    <div style={muted}>Count day {day(c.countDate)}{c.decidedAt ? ` · ${c.status === 'cancelled' ? 'stopped' : 'done'} by ${c.decidedByName || 'someone'}, ${when(c.decidedAt)}` : ''}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

function StartCount({ data, onStarted }: { data: ListData; onStarted: (id: string) => void }) {
  const [locationId, setLocationId] = useState(data.defaultLocationId ?? data.locations[0]?.id ?? '');
  const [kind, setKind] = useState<CountKind>('all');
  const [q, setQ] = useState('');
  const [countDate, setCountDate] = useState(data.today);
  const [picked, setPicked] = useState<Found[]>([]);
  const [pickText, setPickText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickSearch = useItemSearch(kind === 'picked' ? pickText : '');
  // One id per count being started, so a press sent twice starts one; a new one once anything changes.
  const pressId = useRef<string | null>(null);
  useEffect(() => { pressId.current = null; }, [locationId, kind, q, countDate, picked]);

  // What Start would put on the count, a moment after anything changes.
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!locationId || kind === 'picked' || (kind === 'search' && q.trim().length < 2)) return;
    let stale = false;
    const t = setTimeout(async () => {
      const { ok, json } = await call(`${API}?${new URLSearchParams({ preview: '1', location: locationId, kind, q: kind === 'search' ? q.trim() : '' })}`);
      if (stale) return;
      if (ok) setPreview(json); else setPreviewError(json.error);
    }, 350);
    return () => { stale = true; clearTimeout(t); };
  }, [locationId, kind, q]);

  const ready = !!locationId && (kind === 'all' ? !!preview : kind === 'search' ? !!preview : picked.length > 0) && !busy;

  const start = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    pressId.current ??= newId();
    const { ok, json } = await call(API, {
      action: 'start', id: pressId.current, locationId, kind, q: kind === 'search' ? q.trim() : null,
      itemIds: kind === 'picked' ? picked.map((p) => p.netsuiteItemId) : null, countDate,
    });
    setBusy(false);
    if (ok) onStarted(json.count.id);
    else setError(json.error);
  };

  const kinds: Array<[CountKind, string]> = [['all', 'Everything on hand'], ['search', 'Items matching a search'], ['picked', 'Items I pick']];
  const location = data.locations.find((l) => l.id === locationId);

  return (
    <div style={{ ...card, display: 'grid', gap: '10px' }}>
      <div style={heading}>Start a count</div>
      {data.locations.length === 0 && <div style={red}>Books has no locations from NetSuite yet, so there&apos;s nowhere to count.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
        <label>
          <span style={fieldLabel}>Location</span>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={input}>
            {data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>
          <span style={fieldLabel}>Count day</span>
          <input type="date" value={countDate} max={data.today} onChange={(e) => setCountDate(e.target.value)} style={input} />
        </label>
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {kinds.map(([k, text]) => (
          <button key={k} type="button" onClick={() => setKind(k)}
            style={{ ...small, ...(kind === k ? { background: theme.tabActiveBg, borderColor: theme.tabActiveBorder, color: theme.tabActiveColor } : {}) }}>
            {text}
          </button>
        ))}
      </div>
      {kind === 'search' && (
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. hitch ball, or CURT" style={input} aria-label="Items to count" />
      )}
      {kind === 'picked' && (
        <div style={{ display: 'grid', gap: '6px' }}>
          <input value={pickText} onChange={(e) => setPickText(e.target.value)} placeholder="Find an item to add" style={input} aria-label="Find an item" />
          {pickSearch.error && <div style={red}>{pickSearch.error}</div>}
          {pickSearch.found.filter((f) => !picked.some((p) => p.netsuiteItemId === f.netsuiteItemId)).map((f) => (
            <div key={f.netsuiteItemId} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', fontSize: '14px' }}>
              <span style={{ color: theme.textPrimary }}>{label(f)}</span>
              <button type="button" style={small} disabled={picked.length >= MAX_LINES} onClick={() => setPicked((ps) => [...ps, f])}>Add</button>
            </div>
          ))}
          {picked.length > 0 && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {picked.map((p) => (
                <button key={p.netsuiteItemId} type="button" onClick={() => setPicked((ps) => ps.filter((x) => x.netsuiteItemId !== p.netsuiteItemId))}
                  style={{ ...small, fontWeight: 600 }} title="Take it off">
                  {p.itemNumber} ✕
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div style={{ fontSize: '13px', color: theme.textSecondary }}>
        {kind === 'picked' && (picked.length ? `${plural(picked.length, 'item')} picked.` : 'Find the items to count and add them.')}
        {kind !== 'picked' && preview && (
          <>
            {preview.more > 0
              ? `${plural(preview.items + preview.more, 'item')} to count at ${location?.name}. A count takes ${MAX_LINES}, so this one takes ${preview.first} to ${preview.last}; start another for the rest.`
              : `${plural(preview.items, 'item')} to count at ${location?.name}.`}
            {preview.leftOffText ? ` ${preview.leftOffText} ${preview.leftOff === 1 ? "It's" : "They're"} left off.` : ''}
            {preview.readAt ? <span style={muted}> NetSuite&apos;s counts as Books read them {when(preview.readAt)}.</span> : null}
          </>
        )}
        {kind !== 'picked' && previewError && <span style={red}>{previewError}</span>}
      </div>
      {error && <div style={red}>{error}</div>}
      <div>
        <button type="button" onClick={start} disabled={!ready} style={{ ...go, ...(ready ? {} : { opacity: 0.5, cursor: 'default' }) }}>
          {busy ? 'Starting…' : 'Start the count'}
        </button>
      </div>
    </div>
  );
}

// ── One count: counting, the review, and approval ──────────────────────────

function CountView({ id }: { id: string }) {
  const router = useRouter();
  const dialog = useDialog();
  const { canSeeMoney } = useAuth();
  const [data, setData] = useState<OneData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** What's typed in each item's box, by NetSuite id, until it's saved. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [dateTyped, setDateTyped] = useState<string | null>(null);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState('');
  const addSearch = useItemSearch(adding ? addText : '');

  const load = useCallback(async () => {
    const { ok, json } = await call(`${API}?${new URLSearchParams({ id })}`);
    if (ok) { setData(json); setLoadError(null); } else setLoadError(json.error);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const count = data?.count;
  const lines = useMemo(() => data?.lines ?? [], [data]);
  const counting = count?.status === 'counting';
  const savedText = (l: CountLine) => (l.counted === null ? '' : quantityText(l.counted));
  const changed = lines.filter((l) => typed[l.netsuiteItemId] !== undefined && typed[l.netsuiteItemId].trim().replace(/,/g, '') !== savedText(l));
  const dateChanged = dateTyped !== null && dateTyped !== count?.countDate;
  const dirty = counting && (changed.length > 0 || dateChanged);
  const review = useMemo(() => reviewCount(lines, canSeeMoney ? data?.averages ?? null : null), [lines, data, canSeeMoney]);

  const act = async (body: Record<string, unknown>, said: (json: any) => string | null, name: string) => {
    setBusy(name);
    setError(null);
    setDone(null);
    const { ok, json } = await call(API, { id, ...body });
    setBusy(null);
    if (ok) setDone(said(json));
    else setError(json.error);
    await load();
    return ok;
  };

  const save = async () => {
    const errors: Record<string, string> = {};
    const toSave: Array<{ itemId: string; counted: number | null }> = [];
    for (const l of changed) {
      const parsed = parseCounted(typed[l.netsuiteItemId]);
      if ('error' in parsed) errors[l.netsuiteItemId] = parsed.error;
      else toSave.push({ itemId: l.netsuiteItemId, counted: parsed.value });
    }
    setLineErrors(errors);
    if (Object.keys(errors).length) { setError('Fix the counts in red, then save.'); return; }
    const ok = await act({ action: 'save', lines: toSave, countDate: dateChanged ? dateTyped : null },
      (json) => `Saved ${plural(json.saved ?? toSave.length, 'count')}.`, 'save');
    if (ok) {
      setTyped((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !toSave.some((s) => s.itemId === k))));
      setDateTyped(null);
    }
  };

  const undo = () => { setTyped({}); setDateTyped(null); setLineErrors({}); setError(null); };

  const back = async () => {
    if (dirty && !(await dialog.confirm("The counts you've typed aren't saved. Leave them?", { confirmLabel: 'Leave without saving', title: 'Not saved' }))) return;
    router.push(deepLinks.stockCounts());
  };

  const printSheet = (onlyLeft: boolean) => {
    if (!count) return;
    const left = onlyLeft ? lines.filter((l) => l.counted === null) : lines;
    const opened = openCountSheetPdf({
      label: count.label, locationName: count.locationName, what: count.what, countDate: count.countDate,
      lines: left.map((l) => ({ position: l.position, itemNumber: l.itemNumber, displayName: l.displayName })),
      ...(onlyLeft ? { leftOut: lines.length - left.length } : {}),
    });
    if (!opened.ok) setError(opened.error || "Couldn't make the count sheet.");
  };

  const ask = async () => {
    const notCounted = review.notCounted ? ` ${plural(review.notCounted, 'item')} on it ${review.notCounted === 1 ? "isn't" : "aren't"} counted, so ${review.notCounted === 1 ? 'it stays' : 'they stay'} as NetSuite has ${review.notCounted === 1 ? 'it' : 'them'}.` : '';
    const ok = await dialog.confirm(
      `Ask for approval of ${plural(review.differ, 'difference')} from NetSuite?${notCounted} The count can't be changed while it waits; you can withdraw it.`,
      { confirmLabel: 'Ask for approval', title: `Ask for approval of ${count?.label}` },
    );
    if (ok) await act({ action: 'ask' }, () => "Asked. A super admin who didn't ask approves it.", 'ask');
  };

  const finish = async () => {
    const ok = await dialog.confirm('Everything counted matches NetSuite. Finish the count? Nothing is posted.', { confirmLabel: 'Finish it', title: `Finish ${count?.label}` });
    if (ok) await act({ action: 'finish' }, () => 'Finished. Nothing was posted.', 'finish');
  };

  const stop = async () => {
    const ok = await dialog.confirm(`Stop ${count?.label}? Nothing is posted, and its items can go on another count.`, { confirmLabel: 'Stop this count', title: 'Stop the count', destructive: true });
    if (ok) await act({ action: 'cancel' }, () => 'Stopped. Nothing was posted.', 'cancel');
  };

  const withdraw = async () => {
    const ok = await dialog.confirm('Withdraw the ask? Nothing goes to NetSuite, and it can be counted again.', { confirmLabel: 'Withdraw it', title: 'Withdraw the ask' });
    if (ok) await act({ action: 'withdraw' }, () => 'Withdrawn. It can be counted again.', 'withdraw');
  };

  const approve = async () => {
    if (!count) return;
    const ok = await dialog.confirm(
      `Approve ${count.label}? FleetSuite posts its ${plural(review.differ, 'difference')} in NetSuite now as one Inventory Adjustment at ${count.locationName}, dated ${day(count.countDate)}, to 52000 Inventory Adjustment.`,
      { confirmLabel: 'Approve and post', title: `Approve ${count.label}` },
    );
    if (ok) {
      await act({ action: 'approve' }, (json) => `Posted ${json.number || 'the adjustment'} in NetSuite.${json.warning ? ` ${json.warning}` : ''}`, 'approve');
    }
  };

  const turnDown = async () => {
    const why = await dialog.prompt('Why is it turned down? Whoever asked sees this.', '', {
      confirmLabel: 'Turn down', title: `Turn down ${count?.label}`, placeholder: 'e.g. Count bin 4 again', multiline: true,
    });
    if (!why?.trim()) return;
    await act({ action: 'turn_down', why: why.trim() }, () => "Turned down. It's being counted again, and whoever asked sees why.", 'turn_down');
  };

  const askNetSuite = () => act({ action: 'check' }, (json) => (json.made ? `NetSuite has it as ${json.number || 'an adjustment'}. Kept as done.` : json.message), 'check');

  const addItem = async (f: Found) => {
    await act({ action: 'add', itemIds: [f.netsuiteItemId] }, () => `Added ${f.itemNumber} to the end of the count.`, `add-${f.netsuiteItemId}`);
  };

  // Leaving the page with counts typed and not saved asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (loadError && !data) {
    return (
      <>
        <Link href={deepLinks.stockCounts()} style={{ fontSize: '12px', color: theme.textMuted }}>← Counts</Link>
        <div style={red}>{loadError}</div>
      </>
    );
  }
  if (!data || !count) return <div style={muted}>Loading…</div>;

  const mine = count.askedBy === data.me;
  const startedByMe = count.startedBy === data.me;
  const needle = find.trim().toLowerCase();
  const shown = needle ? lines.filter((l) => `${l.itemNumber} ${l.displayName ?? ''}`.toLowerCase().includes(needle)) : lines;
  const differ = lines.filter((l) => { const d = differenceOf(l); return d !== null && d !== 0; });
  const blockedIds = new Set(data.blocked.map((b) => b.netsuiteItemId));
  const showMoney = canSeeMoney && review.centsOver !== null;
  const ask_ = counting && review.differ > 0;
  const finish_ = counting && review.counted > 0 && review.differ === 0;

  return (
    <>
      {dirty && (
        <TopSaveBar
          title={`${count.label} counts`}
          subtitle={changed.length ? `${plural(changed.length, 'count')} typed, not saved` : 'Count day changed, not saved'}
          error={error || undefined}
          onSave={() => { save(); }}
          saving={busy === 'save'}
          onCancel={undo}
          cancelLabel="Undo changes"
        />
      )}
      <div>
        <button type="button" onClick={back} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>← Counts</button>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>{count.label} · {count.locationName}</h1>
          <Chip status={count.status} />
        </div>
        <div style={{ fontSize: '13px', color: theme.textSecondary }}>{count.what}</div>
        <div style={muted}>
          Started by {startedByMe ? 'you' : count.startedByName || 'someone'}, {when(count.startedAt)} · {plural(lines.length, 'item')}, {review.counted.toLocaleString('en-US')} counted
        </div>
        {data.offText && <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textSecondary, marginTop: '6px' }}>{data.offText}</div>}
      </div>

      {error && !dirty && <div style={{ ...red, background: theme.errorBg, padding: '8px 10px', borderRadius: '8px' }}>{error}</div>}
      {done && <div style={{ fontSize: '13px', fontWeight: 700, color: theme.success, background: theme.successBg, padding: '8px 10px', borderRadius: '8px' }}>{done}</div>}

      {/* Where it is, and what can be done */}
      <div style={{ ...card, display: 'grid', gap: '8px' }}>
        {counting && count.why && (
          <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>
            Turned down by {count.turnedDownByName || 'a super admin'}, {when(count.turnedDownAt)}: {count.why}
          </div>
        )}
        {counting && (
          <label style={{ maxWidth: '220px' }}>
            <span style={fieldLabel}>Count day (the adjustment&apos;s date)</span>
            <input type="date" value={dateTyped ?? count.countDate} max={data.today} onChange={(e) => setDateTyped(e.target.value)} style={input} />
          </label>
        )}
        {count.status === 'asked' && (
          <div style={{ fontSize: '13px', color: theme.textSecondary }}>
            Asked for approval by {mine ? 'you' : count.askedByName || 'someone'}, {when(count.askedAt)}.{' '}
            {mine ? "A super admin who didn't ask approves it." : !data.superAdmin ? "A super admin who didn't ask approves it." : ''}
          </div>
        )}
        {count.status === 'asked' && count.error && <div style={red}>Last time: {count.error}</div>}
        {count.status === 'sending' && !needsAsking(count) && <div style={{ fontSize: '13px', color: theme.textSecondary }}>Being posted to NetSuite now.</div>}
        {needsAsking(count) && (
          <div style={{ fontSize: '13px', color: theme.textSecondary }}>
            {count.error ? <span style={red}>{count.error} </span> : null}
            FleetSuite can&apos;t tell whether NetSuite posted it.{data.superAdmin ? ' Ask NetSuite to find out.' : ' A super admin can ask NetSuite.'}
          </div>
        )}
        {count.status === 'made' && (
          <div style={{ fontSize: '13px', color: theme.success, fontWeight: 700 }}>
            {count.netsuiteAdjustmentId
              ? `Posted in NetSuite as ${count.netsuiteNumber || `adjustment ${count.netsuiteAdjustmentId}`}, approved by ${count.decidedByName || 'a super admin'}, ${when(count.decidedAt)}.`
              : `Finished by ${count.decidedByName || 'someone'}, ${when(count.decidedAt)}: everything counted matched NetSuite, so nothing was posted.`}
          </div>
        )}
        {count.status === 'cancelled' && (
          <div style={{ fontSize: '13px', color: theme.textSecondary }}>Stopped by {count.decidedByName || 'someone'}, {when(count.decidedAt)}. Nothing was posted.</div>
        )}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {ask_ && (
            <button type="button" onClick={ask} disabled={busy !== null || dirty} style={{ ...go, ...(dirty ? { opacity: 0.5 } : {}) }} title={dirty ? 'Save the counts first' : undefined}>
              {busy === 'ask' ? 'Asking…' : 'Ask for approval'}
            </button>
          )}
          {finish_ && (
            <button type="button" onClick={finish} disabled={busy !== null || dirty} style={{ ...go, ...(dirty ? { opacity: 0.5 } : {}) }}>
              {busy === 'finish' ? 'Finishing…' : 'Finish: nothing to post'}
            </button>
          )}
          {count.status === 'asked' && data.superAdmin && !mine && (
            <>
              <button type="button" onClick={approve} disabled={busy !== null || !data.switchedOn} style={{ ...go, ...(data.switchedOn ? {} : { opacity: 0.5 }) }}>
                {busy === 'approve' ? 'Posting…' : data.switchedOn ? 'Approve and post to NetSuite' : 'Posting is switched off'}
              </button>
              <button type="button" onClick={turnDown} disabled={busy !== null} style={btn}>Turn down</button>
            </>
          )}
          {count.status === 'asked' && mine && <button type="button" onClick={withdraw} disabled={busy !== null} style={btn}>{busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw it'}</button>}
          {needsAsking(count) && data.superAdmin && <button type="button" onClick={askNetSuite} disabled={busy !== null} style={btn}>{busy === 'check' ? 'Asking NetSuite…' : 'Ask NetSuite'}</button>}
          {lines.length > 0 && <button type="button" onClick={() => printSheet(false)} style={btn}>Print the sheet</button>}
          {counting && review.counted > 0 && review.notCounted > 0 && <button type="button" onClick={() => printSheet(true)} style={btn}>Print what&apos;s left</button>}
          {counting && <button type="button" onClick={() => setAdding((a) => !a)} style={btn}>{adding ? 'Done adding' : 'Add items'}</button>}
          {counting && (startedByMe || data.superAdmin) && <button type="button" onClick={stop} disabled={busy !== null} style={btn}>{busy === 'cancel' ? 'Stopping…' : 'Stop this count'}</button>}
        </div>
        {adding && counting && (
          <div style={{ display: 'grid', gap: '6px' }}>
            <input value={addText} onChange={(e) => setAddText(e.target.value)} placeholder="Find an item that isn't on the count" style={input} aria-label="Find an item to add" />
            {addSearch.error && <div style={red}>{addSearch.error}</div>}
            {addSearch.found.map((f) => {
              const on = lines.some((l) => l.netsuiteItemId === f.netsuiteItemId);
              return (
                <div key={f.netsuiteItemId} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', fontSize: '14px' }}>
                  <span style={{ color: theme.textPrimary }}>{label(f)}</span>
                  {on ? <span style={muted}>On the count</span> : (
                    <button type="button" style={small} disabled={busy !== null} onClick={() => addItem(f)}>{busy === `add-${f.netsuiteItemId}` ? 'Adding…' : 'Add'}</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* The review: what's counted, and what differs from NetSuite */}
      {review.counted > 0 && (
        <div style={{ ...card, display: 'grid', gap: '8px' }}>
          <div style={heading}>What differs from NetSuite</div>
          <div style={{ fontSize: '13px', color: theme.textSecondary }}>
            {review.counted.toLocaleString('en-US')} of {plural(review.items, 'item')} counted · {review.matched.toLocaleString('en-US')} match · {review.differ.toLocaleString('en-US')} differ
            {review.differ > 0 ? ` (${quantityText(review.unitsOver)} over, ${quantityText(review.unitsShort)} short` : ''}
            {review.differ > 0 && showMoney ? `: ${money(review.centsOver!)} over, ${money(review.centsShort!)} short at NetSuite's average cost` : ''}
            {review.differ > 0 ? ')' : ''}.
            {showMoney && review.noCost > 0 ? ` ${plural(review.noCost, 'item')} that differ ${review.noCost === 1 ? 'has' : 'have'} no average cost in NetSuite.` : ''}
          </div>
          {review.notCounted > 0 && (
            <div style={muted}>{plural(review.notCounted, 'item')} {review.notCounted === 1 ? "isn't" : "aren't"} counted, so {review.notCounted === 1 ? 'it stays' : 'they stay'} as NetSuite has {review.notCounted === 1 ? 'it' : 'them'}.</div>
          )}
          {data.blocked.map((b) => <div key={b.netsuiteItemId} style={red}>{blockedText(b)}</div>)}
          {differ.length > 0 && (
            <div style={{ display: 'grid', gap: '4px' }}>
              {differ.map((l) => (
                <div key={l.netsuiteItemId} style={{ display: 'grid', gap: '1px', padding: '6px 0', borderTop: `1px solid ${theme.border}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '14px', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, color: blockedIds.has(l.netsuiteItemId) ? theme.error : theme.textPrimary }}>{l.itemNumber}</span>
                    <span style={{ fontWeight: 700, color: theme.textPrimary, fontVariantNumeric: 'tabular-nums' }}>{describeLine(l)}</span>
                  </div>
                  {movedWhileCounting(l) && (
                    <div style={{ fontSize: '12px', color: theme.warning, fontWeight: 700 }}>
                      NetSuite&apos;s count went from {quantityText(l.onHandStart)} to {quantityText(l.onHandThen!)} while it was being counted: check it was counted after that.
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* The items, in the sheet's order, each with its box while it's being counted */}
      <div style={{ ...card, display: 'grid', gap: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={heading}>{counting ? 'Type what is on the shelf' : 'What was counted'}</div>
          {counting && dirty && (
            <button type="button" onClick={() => { save(); }} disabled={busy !== null} style={go}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          )}
        </div>
        {counting && <div style={muted}>Type 0 when there&apos;s none, and leave a box blank when it isn&apos;t counted. NetSuite&apos;s counts stay out of sight until a count is saved.</div>}
        {lines.length > 12 && (
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find an item on the count" style={input} aria-label="Find an item on the count" />
        )}
        {shown.map((l) => {
          const text = typed[l.netsuiteItemId] ?? savedText(l);
          const unsaved = typed[l.netsuiteItemId] !== undefined && typed[l.netsuiteItemId].trim().replace(/,/g, '') !== savedText(l);
          return (
            <div key={l.netsuiteItemId} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', alignItems: 'center', padding: '6px 0', borderTop: `1px solid ${theme.border}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>
                  <span style={{ ...muted, fontWeight: 600 }}>{l.position}. </span>{l.itemNumber}
                </div>
                {l.displayName && l.displayName !== l.itemNumber && <div style={{ fontSize: '12px', color: theme.textSecondary }}>{l.displayName}</div>}
                {lineErrors[l.netsuiteItemId] && unsaved && <div style={{ ...red, fontSize: '12px' }}>{lineErrors[l.netsuiteItemId]}</div>}
                {unsaved && !lineErrors[l.netsuiteItemId] && <div style={{ fontSize: '12px', color: theme.warning, fontWeight: 700 }}>Not saved</div>}
                {!unsaved && l.counted !== null && <div style={muted}>Counted by {l.countedByName || 'someone'}, {when(l.countedAt)}</div>}
              </div>
              {counting ? (
                <input inputMode="decimal" value={text} placeholder="Count" aria-label={`Count of ${l.itemNumber}`}
                  onChange={(e) => setTyped((t) => ({ ...t, [l.netsuiteItemId]: e.target.value }))}
                  style={{ ...input, width: '96px', textAlign: 'right', borderColor: lineErrors[l.netsuiteItemId] && unsaved ? theme.error : theme.border }} />
              ) : (
                <span style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, fontVariantNumeric: 'tabular-nums' }}>
                  {l.counted === null ? '—' : quantityText(l.counted)}
                </span>
              )}
            </div>
          );
        })}
        {shown.length === 0 && <div style={muted}>{needle ? 'No item on the count matches.' : 'Nothing is on this count.'}</div>}
      </div>
    </>
  );
}
