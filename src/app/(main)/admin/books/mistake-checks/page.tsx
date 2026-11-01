'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess, booksAllows } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import type { BooksCompany } from '@/lib/books/journal';
import type { MistakeKind, MistakeView } from '@/lib/books/mistake-checks';

/**
 * Books → Mistake checks (migration 431, src/lib/books/mistake-checks.ts,
 * docs/books.md "Mistake checks"; owner decision 2026-10-24, "Mistake
 * checks").
 *
 * Each night Books looks through the bills, checks and card charges it copies
 * from NetSuite for likely mistakes. Each company's open ones show the
 * likeliest first, each with why in a sentence and links to its documents in
 * NetSuite. The bookkeeper or a super admin clears one as fixed in NetSuite
 * or fine as it is, with a note; as fine it can also teach the check. Cleared
 * ones keep who, when and why, with "Open it again". The daily check tells
 * the super admins about new ones and links here (?company=…&item=…). Open to
 * whoever opens the books.
 */

interface SyncState { at: string; error: string | null }

interface Payload {
  companies: Array<{ code: BooksCompany; name: string; open: number }>;
  items: MistakeView[];
  lookFrom: string;
  usualFrom: string;
  lastLook: SyncState | null;
  lastBills: SyncState | null;
  lastSpending: SyncState | null;
}

type How = 'fixed' | 'fine';

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#fbbf24';
const BLUE = '#60a5fa';
const VIOLET = '#a78bfa';

/** Each kind: its chip, the words on its filter button, and its color. */
const KINDS: Record<MistakeKind, { chip: string; color: string }> = {
  twice: { chip: 'Entered twice', color: RED },
  far_off: { chip: 'Far off usual', color: AMBER },
  missing: { chip: 'Monthly charge missing', color: BLUE },
  odd_account: { chip: 'Odd account', color: VIOLET },
};
const ORDER: readonly MistakeKind[] = ['twice', 'far_off', 'missing', 'odd_account'];

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents: number) => money.format(cents / 100);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayText = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1].slice(0, 3)} ${Number(iso.slice(8, 10))}`;
const monthText = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]}${iso.slice(0, 4) === String(new Date().getFullYear()) ? '' : ` ${iso.slice(0, 4)}`}`;
const longDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}${iso.slice(0, 4) === String(new Date().getFullYear()) ? '' : `, ${iso.slice(0, 4)}`}`;
const centralDay = (at: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(at));
const clock = (at: string) => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

/** When something ran: 'today at 4:46 AM', 'yesterday at 4:46 AM', 'Oct 21 at 4:46 AM'. */
function whenText(at: string): string {
  const day = centralDay(at);
  const today = centralDay(new Date().toISOString());
  const yesterday = centralDay(new Date(Date.now() - 86_400_000).toISOString());
  return `${day === today ? 'today' : day === yesterday ? 'yesterday' : dayText(day)} at ${clock(at)}`;
}

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const chip = (color: string): React.CSSProperties => ({
  fontSize: '10px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
  border: `1px solid ${color}55`, color,
});

const button = (active: boolean, color?: string): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: '8px', border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border)'}`,
  background: 'var(--card)', color: color ?? 'var(--text-primary)', fontSize: '12px', fontWeight: active ? 800 : 600, cursor: 'pointer',
});

const small = (primary = false): React.CSSProperties => ({
  padding: '5px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
  border: `1px solid ${primary ? GREEN : 'var(--border)'}`, background: primary ? `${GREEN}18` : 'var(--card)',
  color: primary ? GREEN : 'var(--text-primary)',
});

const muted: React.CSSProperties = { fontSize: '11px', color: 'var(--text-muted)' };

/** What a cleared item says about how it was cleared. */
function clearedLine(item: MistakeView): string {
  const at = item.at ? dayText(centralDay(item.at)) : '';
  if (item.how === 'gone') return `Cleared on its own, ${at}: ${item.goneWhy ?? 'the copies of NetSuite no longer show it.'}`;
  const how = item.how === 'fixed' ? 'fixed in NetSuite.' : 'fine as it is.';
  const note = item.note ? ` “${item.note}”` : '';
  const learned = !item.learned ? '' : item.kind === 'missing' ? ' No longer watched.' : ` Fine for ${item.party ?? 'this vendor'} from now on.`;
  return `Cleared by ${item.by ?? 'someone'}, ${at}: ${how}${note}${learned}`;
}

function ClearPanel({ item, how, busy, error, onClear, onCancel }: {
  item: MistakeView;
  how: How;
  busy: boolean;
  error: string;
  onClear: (note: string, learn: boolean) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState('');
  // Unticked to start, so clearing one as fine never hides the next mistake by itself.
  const [learn, setLearn] = useState(false);
  return (
    <div style={{ marginTop: '8px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)' }}>
      <div style={{ fontSize: '12px', fontWeight: 800, marginBottom: '6px' }}>{how === 'fixed' ? 'Fixed in NetSuite' : 'Fine as it is'}</div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onInput={(e) => {
          // Grows with what's typed.
          const box = e.currentTarget;
          box.style.height = 'auto';
          box.style.height = `${box.scrollHeight}px`;
        }}
        placeholder="Note, if you like: what happened, for whoever looks next"
        rows={2}
        maxLength={2000}
        style={{
          width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '6px 8px', borderRadius: '6px', resize: 'vertical',
          border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontFamily: 'inherit',
        }}
      />
      {how === 'fine' && item.learnText && (
        <label style={{ display: 'flex', gap: '6px', alignItems: 'flex-start', fontSize: '12px', marginTop: '6px', cursor: 'pointer' }}>
          <input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} style={{ marginTop: '2px' }} />
          <span>{item.learnText}</span>
        </label>
      )}
      {how === 'fixed' && (
        <div style={{ ...muted, marginTop: '6px' }}>
          The next look checks the copies: if it still finds the mistake once NetSuite&apos;s change is copied, it comes back.
        </div>
      )}
      {error && <div style={{ fontSize: '12px', fontWeight: 600, color: RED, marginTop: '6px' }}>{error}</div>}
      <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
        <button type="button" style={small(true)} disabled={busy} onClick={() => onClear(note, learn)}>{busy ? 'Clearing…' : 'Clear it'}</button>
        <button type="button" style={small()} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ItemRow({ item, open, busy, error, highlight, canKeep, onOpen, onClear, onReopen }: {
  item: MistakeView;
  open: How | null;
  busy: boolean;
  error: string;
  highlight: boolean;
  /** Clearing and opening again are the bookkeeper's and super admins'; the CPA reads. */
  canKeep: boolean;
  onOpen: (how: How | null) => void;
  onClear: (how: How, note: string, learn: boolean) => void;
  onReopen: () => void;
}) {
  const k = KINDS[item.kind];
  const cleared = item.state === 'cleared';
  return (
    <div
      id={`item-${item.id}`}
      style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', ...(highlight ? { boxShadow: `inset 3px 0 0 ${BLUE}` } : {}) }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 8px' }}>
        <span style={chip(k.color)}>{k.chip}</span>
        <span style={{ fontWeight: 700, fontSize: '13px' }}>{item.party ?? 'No vendor named'}</span>
        <span style={{ ...muted, fontSize: '12px' }}>{item.kind === 'missing' ? monthText(item.date) : dayText(item.date)}</span>
        {item.cents !== null && (
          <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: '13px', color: item.kind === 'missing' ? 'var(--text-muted)' : undefined }}>
            {item.kind === 'missing' ? `About ${fmt(item.cents)}` : fmt(item.cents)}
          </span>
        )}
      </div>
      <div style={{ fontSize: '12px', color: cleared ? 'var(--text-muted)' : 'var(--text-secondary)', marginTop: '3px', overflowWrap: 'anywhere' }}>{item.why}</div>
      {!cleared && item.backAt && (
        <div style={{ fontSize: '12px', color: AMBER, marginTop: '3px' }}>Back {dayText(centralDay(item.backAt))}: the look found it again.</div>
      )}
      {cleared && <div style={{ fontSize: '12px', color: GREEN, marginTop: '3px', overflowWrap: 'anywhere' }}>{clearedLine(item)}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', marginTop: '6px' }}>
        <span style={{ fontSize: '12px' }}>
          {item.docs.map((d, i) => (
            <span key={`${d.label}-${i}`}>
              {i > 0 && <span style={muted}> · </span>}
              {d.url
                ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="rep-link" style={d.label.startsWith('Last:') ? muted : undefined}>{d.label} ↗</a>
                : <span style={muted}>{d.label}</span>}
            </span>
          ))}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
          {!canKeep ? null : cleared ? (
            <button type="button" style={small()} disabled={busy} onClick={onReopen}>{busy ? 'Opening…' : 'Open it again'}</button>
          ) : (
            <>
              <button type="button" style={button(open === 'fixed')} onClick={() => onOpen(open === 'fixed' ? null : 'fixed')}>Fixed in NetSuite</button>
              <button type="button" style={button(open === 'fine')} onClick={() => onOpen(open === 'fine' ? null : 'fine')}>Fine as it is</button>
            </>
          )}
        </span>
      </div>
      {cleared && error && <div style={{ fontSize: '12px', fontWeight: 600, color: RED, marginTop: '6px' }}>{error}</div>}
      {canKeep && open && !cleared && (
        <ClearPanel
          key={open}
          item={item}
          how={open}
          busy={busy}
          error={error}
          onClear={(note, learn) => onClear(open, note, learn)}
          onCancel={() => onOpen(null)}
        />
      )}
    </div>
  );
}

export default function BooksMistakeChecksPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const canKeep = booksAllows(booksAccess(hasRole), 'keep');
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [company, setCompany] = useState<BooksCompany>('BMG');
  const [show, setShow] = useState<'open' | 'cleared'>('open');
  const [kind, setKind] = useState<MistakeKind | null>(null);
  const [opened, setOpened] = useState<{ id: string; how: How } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [itemError, setItemError] = useState<{ id: string; text: string } | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookError, setLookError] = useState('');
  const [highlight, setHighlight] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/books/mistake-checks');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
      return json as Payload;
    } catch (e: any) {
      setError(e?.message || 'Could not load the mistake checks');
      return null;
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // The daily check's notification opens a company's list, or one item on it (deepLinks.booksMistakeChecks).
    const q = new URLSearchParams(window.location.search);
    const wanted = q.get('company');
    if (wanted === 'BMG' || wanted === '1084') setCompany(wanted);
    load().then((json) => {
      const item = json?.items.find((i) => i.id === q.get('item'));
      if (!item) return;
      setCompany(item.company);
      setShow(item.state);
      setHighlight(item.id);
      window.setTimeout(() => document.getElementById(`item-${item.id}`)?.scrollIntoView({ block: 'center' }), 50);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const pickCompany = (next: BooksCompany) => {
    setCompany(next);
    setKind(null);
    setOpened(null);
    window.history.replaceState(null, '', deepLinks.booksMistakeChecks(next));
  };

  const ofCompany = useMemo(() => (data?.items ?? []).filter((i) => i.company === company), [data, company]);
  const list = useMemo(() => ofCompany.filter((i) => i.state === show), [ofCompany, show]);
  const shown = useMemo(() => {
    const rows = list.filter((i) => !kind || i.kind === kind);
    if (show === 'cleared') return rows.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    // The likeliest first: by kind, then how likely within it, then the most money, then the newest.
    return rows.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.strength - a.strength
      || (b.cents ?? 0) - (a.cents ?? 0) || b.date.localeCompare(a.date));
  }, [list, kind, show]);

  const act = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    setItemError(null);
    try {
      const res = await apiFetch('/api/admin/books/mistake-checks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setOpened(null);
      await load();
    } catch (e: any) {
      setItemError({ id, text: e?.message || 'That didn\'t go through' });
    }
    setBusy(null);
  };

  const lookNow = async () => {
    setLooking(true);
    setLookError('');
    try {
      const res = await apiFetch('/api/admin/books/mistake-checks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'look' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `The look failed (${res.status})`);
    } catch (e: any) {
      setLookError(e?.message || 'The look failed');
    }
    await load();
    setLooking(false);
  };

  const openCount = ofCompany.filter((i) => i.state === 'open').length;
  const copyFailed = [
    data?.lastBills?.error ? `The last copy of NetSuite's bills failed ${whenText(data.lastBills.at)}: ${data.lastBills.error}` : '',
    data?.lastSpending?.error ? `The last copy of NetSuite's checks and card charges failed ${whenText(data.lastSpending.at)}: ${data.lastSpending.error}` : '',
  ].filter(Boolean);

  return (
    <div>
      <div style={{ marginBottom: '14px', display: 'flex', gap: '12px', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px' }}>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>Mistake checks</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Each night Books looks through what it copies from NetSuite for likely mistakes: a bill entered twice, a bill or charge
            far off the vendor&apos;s usual, a monthly charge that didn&apos;t come, and a charge coded to an account that vendor
            doesn&apos;t use. Each one says why. {canKeep ? 'Clear it' : 'The bookkeeper or a super admin clears it'} once it&apos;s fixed in
            NetSuite, or if it&apos;s fine as it is. Nothing here changes NetSuite.{' '}
            <Link href="/admin/books/differences" style={{ color: 'var(--text-secondary)' }}>Differences vs NetSuite</Link>
            {' · '}
            <Link href="/admin/books/reports" style={{ color: 'var(--text-secondary)' }}>Reports</Link>
            {' · '}
            <Link href="/admin/books/lists" style={{ color: 'var(--text-secondary)' }}>NetSuite lists</Link>
          </div>
        </div>
        {canKeep && (
          <button
            type="button"
            onClick={lookNow}
            disabled={looking || !data}
            style={{
              padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
              color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: looking ? 'wait' : 'pointer',
            }}
          >
            {looking ? 'Looking…' : 'Look now'}
          </button>
        )}
      </div>

      {error && <div style={banner(RED)}>{error}</div>}
      {lookError && <div style={banner(RED)}>{lookError}</div>}

      {data && (
        <>
          {data.lastLook?.error && <div style={banner(RED)}>The last look didn&apos;t finish {whenText(data.lastLook.at)}: {data.lastLook.error}</div>}
          {copyFailed.map((text) => <div key={text} style={banner(RED)}>{text}</div>)}
          {!data.lastLook && (
            <div style={banner(BLUE)}>The first look runs tonight at 4:46 AM.{canKeep ? ' Tap Look now to look straight away.' : ''}</div>
          )}
          {data.lastLook && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
              Last looked {whenText(data.lastLook.at)}, at the bills, checks and card charges dated from {longDay(data.lookFrom)}.
              What&apos;s usual for a vendor comes from everything since {monthText(data.usualFrom)}. A fix made in NetSuite
              clears its item on its own once the copies pick it up.
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
            {data.companies.map((c) => (
              <button key={c.code} type="button" style={button(company === c.code)} onClick={() => pickCompany(c.code)}>
                {c.code} · {c.open.toLocaleString('en-US')} open
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
            <button type="button" style={button(show === 'open')} onClick={() => { setShow('open'); setKind(null); }}>
              Open {openCount.toLocaleString('en-US')}
            </button>
            <button type="button" style={button(show === 'cleared')} onClick={() => { setShow('cleared'); setKind(null); }}>
              Cleared {(ofCompany.length - openCount).toLocaleString('en-US')}
            </button>
            {ORDER.map((k) => {
              const n = list.filter((i) => i.kind === k).length;
              if (!n) return null;
              return (
                <button key={k} type="button" style={button(kind === k, KINDS[k].color)} onClick={() => setKind(kind === k ? null : k)}>
                  {n.toLocaleString('en-US')} {KINDS[k].chip.toLowerCase()}
                </button>
              );
            })}
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--card)', overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>
              {show === 'open' ? `${company}'s open items, the likeliest first` : `${company}'s cleared items, newest first`}
            </div>
            {shown.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                open={opened?.id === item.id ? opened.how : null}
                busy={busy === item.id}
                error={itemError?.id === item.id ? itemError.text : ''}
                highlight={highlight === item.id}
                canKeep={canKeep}
                onOpen={(how) => { setItemError(null); setOpened(how ? { id: item.id, how } : null); }}
                onClear={(how, note, learn) => act(item.id, { action: 'clear', how, note, learn })}
                onReopen={() => act(item.id, { action: 'reopen' })}
              />
            ))}
            {!shown.length && (
              <div style={{ padding: '12px', borderTop: '1px solid var(--border)', fontSize: '12px', color: 'var(--text-muted)' }}>
                {show === 'open' ? `Nothing open for ${company}.` : `Nothing cleared for ${company} yet.`}
              </div>
            )}
          </div>
        </>
      )}
      {!data && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Loading…</div>}
    </div>
  );
}
