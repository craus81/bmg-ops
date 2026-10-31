'use client';

/**
 * An item's accounts, changed in FleetSuite and sent on to NetSuite (Books
 * part 46, docs/books.md "Item accounts changed in FleetSuite"; owner
 * decisions 2026-10-31: from January 1, 2027 the team works only in
 * FleetSuite, and FleetSuite becomes the master for items with their
 * accounts). Opened from More → Money & Books → Item Accounts, which finds
 * the item by number or name, or from Change accounts beside an item set up
 * wrong on Books → Stock by item.
 *
 * Its income account; an inventory item's cost of goods sold and inventory
 * asset accounts; and the expense account of one that's bought. Each picks
 * from the accounts of the kind it can be, so an asset account can't become
 * a cost of goods sold account. What changes and what NetSuite is sent are
 * src/lib/item-accounts.ts, the same rules /api/item-accounts works the
 * change out by before it sends it. Built switched off (Books → Switches):
 * until it's on, super admins see what a change would send and nothing goes
 * to NetSuite.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import TopSaveBar from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import type { DetailChange } from '@/lib/detail-changes';
import {
  FIELDS, ITEM_KINDS, REASON_MAX, accountText, choicesFor, fitsField, kindWords, planItemAccounts,
  type AccountField, type AccountsItem, type ChartAccount, type ItemAccountsEdit,
} from '@/lib/item-accounts';

const API = '/api/item-accounts';

interface Loaded {
  item: AccountsItem;
  chart: ChartAccount[];
  signature: string;
  changes: DetailChange[];
  switchedOn: boolean;
  offText: string | null;
}

/** An item the search found, from the copy of NetSuite's items. */
interface FoundItem {
  id: string;
  number: string;
  displayName: string | null;
  active: boolean;
}

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

const day = (iso: string) => new Date(iso).toLocaleDateString();

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
const muted: React.CSSProperties = { fontSize: '12px', color: theme.textMuted };
const heading: React.CSSProperties = { fontSize: '15px', fontWeight: 800, color: theme.textPrimary };
/** Two lines at most. */
const twoLines: React.CSSProperties = {
  fontSize: '13px', color: theme.textSecondary, overflow: 'hidden', display: '-webkit-box',
  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};

const STATUS_TEXT: Record<DetailChange['status'], string> = {
  changed: 'Changed',
  refused: 'NetSuite refused it',
  unsure: "Couldn't tell whether it went in",
  sending: 'Being sent now',
};

/** The boxes as NetSuite has the item, so a box left alone changes nothing. */
const pickedOf = (item: AccountsItem): Partial<Record<AccountField, string>> =>
  Object.fromEntries(ITEM_KINDS[item.recordType].fields.map((f) => [f, item.accounts[f]?.id ?? '']));

export default function ItemAccountsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();
  const itemId = (searchParams.get('item') || '').trim();
  const allowed = !authLoading && hasFeature('vendor_payments') && canSeeMoney;

  // Made when the item is read: the same form pressed twice is one change.
  const [requestId, setRequestId] = useState(newRequestId);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Partial<Record<AccountField, string>>>({});
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [done, setDone] = useState<{ changes: string[]; already: boolean } | null>(null);
  const [find, setFind] = useState('');
  const [found, setFound] = useState<FoundItem[] | null>(null);
  const [findError, setFindError] = useState('');

  const load = useCallback(async () => {
    if (!/^\d+$/.test(itemId)) { setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`${API}?${new URLSearchParams({ item: itemId })}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the item from NetSuite (${res.status}).`);
      const loaded = body as Loaded;
      setData(loaded);
      setPicked(pickedOf(loaded.item));
      setReason('');
      setError(null);
      setReloadNeeded(false);
      setDone(null);
      setRequestId(newRequestId());
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the item from NetSuite.");
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  // With no item open: find one by number or name.
  useEffect(() => {
    if (itemId || !allowed) return;
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(`${API}?${new URLSearchParams({ find: find.trim() })}`);
        const body = await res.json().catch(() => ({}));
        setFound(res.ok ? body.items ?? [] : []);
        setFindError(res.ok ? '' : body.error || `Couldn't search the items (${res.status}).`);
      } catch {
        setFindError("Couldn't reach FleetSuite to search the items.");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [find, itemId, allowed]);

  const item = data?.item;
  const chart = useMemo(() => new Map((data?.chart ?? []).map((a) => [a.id, a])), [data]);

  // Only what was changed goes: a box left as NetSuite has it isn't sent.
  const edit: ItemAccountsEdit = { reason };
  if (item) {
    const accounts: Partial<Record<AccountField, string>> = {};
    for (const f of ITEM_KINDS[item.recordType].fields) {
      if ((picked[f] ?? '') !== (item.accounts[f]?.id ?? '')) accounts[f] = picked[f] ?? '';
    }
    if (Object.keys(accounts).length > 0) edit.accounts = accounts;
  }
  const plan = useMemo(
    () => (item ? planItemAccounts(item, edit, { chart }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edit derives from the boxes
    [item, picked, reason, chart],
  );
  const started = edit.accounts !== undefined || reason.trim() !== '';

  const send = async () => {
    if (!data || !item || !plan || plan.problems.length > 0 || !data.switchedOn) return;
    const n = plan.changes.length;
    const ok = await dialog.confirm(
      `Change ${item.number}'s accounts in NetSuite? ${n === 1 ? 'One change' : `${n} changes`}.`,
      { confirmLabel: 'Save to NetSuite', title: 'Change item accounts' },
    );
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    setReloadNeeded(false);
    try {
      const res = await apiFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, itemId: item.id, signature: data.signature, ...edit }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        if (body.stale || body.unsure) setReloadNeeded(true);
        throw new Error(body.error || `NetSuite didn't take the change (${res.status}).`);
      }
      setDone({ changes: Array.isArray(body.changes) ? body.changes : plan.changes, already: !!body.already });
    } catch (e: any) {
      setError(e?.message || "NetSuite didn't take the change.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!authLoading && (!hasFeature('vendor_payments') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Vendor Payments permission and price access to change an item&apos;s accounts.</div>;
  }

  const back = () => router.push('/more');
  const startOver = () => { if (item) { setPicked(pickedOf(item)); setReason(''); } };
  const kind = item ? ITEM_KINDS[item.recordType] : null;

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!done && item && plan && (
        <TopSaveBar
          title="Change item accounts"
          subtitle={item.number}
          error={error || undefined}
          onSave={send}
          saving={submitting}
          disabled={!data?.switchedOn || plan.problems.length > 0}
          saveLabel={data?.switchedOn ? 'Save to NetSuite' : 'Switched off'}
          savingLabel="Saving to NetSuite…"
          onCancel={back}
        />
      )}
      <div>
        <button onClick={back} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>← More</button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Item accounts</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>The accounts an item&apos;s sales, costs and stock post to, changed in NetSuite as you save them here.</div>
      </div>

      {data?.offText && !done && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {!/^\d+$/.test(itemId) ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div>
            <label style={label} htmlFor="ia-find">Find the item</label>
            <input id="ia-find" style={input} value={find} autoComplete="off" placeholder="Its number or name"
              onChange={(e) => setFind(e.target.value)} />
          </div>
          {findError && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{findError}</div>}
          {found === null && !findError && <div style={muted}>Reading the items…</div>}
          {found && found.length === 0 && !findError && <div style={muted}>No item in the copy of NetSuite&apos;s items matches that.</div>}
          {found && found.map((f) => (
            <button key={f.id} type="button" onClick={() => router.push(deepLinks.itemAccounts(f.id))} style={{
              display: 'grid', gap: '2px', textAlign: 'left', padding: '10px', borderRadius: '10px', border: `1px solid ${theme.border}`,
              background: theme.card, color: theme.textPrimary, cursor: 'pointer', fontFamily: 'inherit',
            }}>
              <b>{f.number}</b>
              <span style={muted}>{[f.displayName, f.active ? '' : 'Inactive in NetSuite'].filter(Boolean).join(' · ') || `NetSuite item ${f.id}`}</span>
            </button>
          ))}
          <div style={muted}>The copy of NetSuite&apos;s items catches up every two hours; the item opens as NetSuite has it now.</div>
        </div>
      ) : loading ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Reading the item from NetSuite…</div>
      ) : loadError || !item || !plan || !kind ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{loadError || "Couldn't read the item from NetSuite."}</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={load} style={btn}>Try again</button>
            <button onClick={() => router.push(deepLinks.itemAccounts())} style={btn}>Find another item</button>
          </div>
        </div>
      ) : done ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: theme.success }}>
            {item.number} {done.already ? 'was already changed' : 'changed in NetSuite'}
          </div>
          <div style={{ display: 'grid', gap: '2px', fontSize: '14px', color: theme.textPrimary }}>
            {done.changes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <div style={muted}>Documents already made keep what they posted; its next ones post to the new accounts.</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={load} style={btn}>Change something else</button>
            <button onClick={() => router.push(deepLinks.itemAccounts())} style={btn}>Find another item</button>
            <button onClick={back} style={btn}>Back to More</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
              <div style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary, overflowWrap: 'anywhere' }}>{item.number}</div>
              {started && <button onClick={startOver} style={small}>Start over</button>}
            </div>
            <div style={muted}>
              {[item.displayName !== item.number ? item.displayName : '', kind.name, item.inactive ? 'Inactive in NetSuite' : ''].filter(Boolean).join(' · ')}
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '14px' }}>
            <div style={heading}>Accounts</div>
            {kind.fields.map((f) => {
              const info = FIELDS[f];
              const now = item.accounts[f] ?? null;
              const nowAccount = now ? chart.get(now.id) : undefined;
              const wrong = !!nowAccount && !fitsField(f, nowAccount);
              const choices = choicesFor(f, chart.values());
              const listed = !now || choices.some((a) => a.id === now.id);
              const changed = (picked[f] ?? '') !== (now?.id ?? '');
              return (
                <div key={f} style={{ display: 'grid', gap: '4px' }}>
                  <label style={label} htmlFor={`ia-${f}`}>{info.name}</label>
                  <select id={`ia-${f}`} value={picked[f] ?? ''} onChange={(e) => setPicked((p) => ({ ...p, [f]: e.target.value }))}
                    style={{ ...input, borderColor: changed ? theme.successBorder : wrong ? theme.errorBorder : theme.border }}>
                    {!now && <option value="">None in NetSuite</option>}
                    {now && !listed && <option value={now.id}>{accountText(now.id, chart, now.name)} (as it is now)</option>}
                    {choices.map((a) => <option key={a.id} value={a.id}>{accountText(a.id, chart)}</option>)}
                  </select>
                  {wrong && nowAccount && (
                    <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>
                      It&apos;s {accountText(now!.id, chart)} now, {kindWords(nowAccount.type)}, where it should be {info.takes}.
                    </div>
                  )}
                  {changed && now && <div style={{ ...muted, textDecoration: 'line-through' }}>{accountText(now.id, chart, now.name)}</div>}
                  <div style={muted}>{info.posts}</div>
                </div>
              );
            })}
          </div>

          <div style={{ ...card, display: 'grid', gap: '4px' }}>
            <label style={label} htmlFor="ia-reason">Why it&apos;s being changed</label>
            <input id="ia-reason" style={input} value={reason} maxLength={REASON_MAX} placeholder="Set up with the wrong asset account, moved to its own sales account…"
              onChange={(e) => setReason(e.target.value)} />
            <div style={muted}>Kept with the change in FleetSuite, for whoever looks at the item next.</div>
          </div>

          {plan.changes.length > 0 && (
            <div style={{ ...card, display: 'grid', gap: '4px' }}>
              <div style={heading}>What changes</div>
              {plan.changes.map((c) => <div key={c} style={{ fontSize: '14px', color: theme.textPrimary }}>{c}</div>)}
              {plan.notes.map((n) => <div key={n} style={muted}>{n}</div>)}
            </div>
          )}
          {started && plan.problems.length > 0 && (
            <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700, display: 'grid', gap: '2px' }}>
              {plan.problems.map((p) => <div key={p}>{p}</div>)}
            </div>
          )}
          {error && reloadNeeded && <div><button onClick={load} style={btn}>Reload the item</button></div>}

          {data.changes.length > 0 && (
            <div style={{ ...card, display: 'grid', gap: '8px' }}>
              <div style={heading}>Changed before</div>
              {data.changes.map((x) => (
                <div key={x.id} style={{ display: 'grid', gap: '2px', fontSize: '13px', color: theme.textPrimary }}>
                  <span style={{ minWidth: 0 }}>
                    <b style={{ color: x.status === 'changed' ? theme.textPrimary : x.status === 'sending' ? theme.warning : theme.error }}>
                      {STATUS_TEXT[x.status]}
                    </b>
                    <span style={{ color: theme.textMuted }}> · {day(x.at)}{x.by ? ` · ${x.by}` : ''} · {x.reason}</span>
                  </span>
                  <div style={twoLines}>{x.changes.join(' · ')}</div>
                  {x.error && x.status !== 'changed' && <div style={{ fontSize: '12px', color: theme.error }}>{x.error}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
