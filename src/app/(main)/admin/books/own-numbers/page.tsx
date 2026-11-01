'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess, booksAllows } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import type { NumberView, OutsideView, OwnNumberType, SeriesView, Standing } from '@/lib/books/own-numbers';

/**
 * Books → Own numbers (docs/books.md "Own numbers").
 *
 * Once FleetSuite's own numbers is switched on, each sales order, PO, invoice
 * and credit memo FleetSuite makes in NetSuite gets the next number of its
 * kind here, and NetSuite keeps it as the document's number when Allow
 * Override is ticked for the kind in NetSuite. Each kind's letters and next
 * number (a super admin changes them), every number given with what became of
 * it, and the sales orders and POs made in NetSuite instead, since it went on
 * or, while it's off, the last 30 days. Open to whoever opens the books.
 */

interface Payload {
  now: string;
  on: boolean;
  changedAt: string | null;
  kind: OwnNumberType | null;
  series: SeriesView[];
  numbers: NumberView[];
  numbersMore: boolean;
  since: string;
  offDays: number;
  outside: OutsideView[];
  outsideMore: boolean;
}

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const GREY = '#94a3b8';

const when = (iso: string) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});
const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const chip = (color: string): React.CSSProperties => ({
  fontSize: '10px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
  border: `1px solid ${color}55`, color,
});

const act = (color: string | null, enabled: boolean): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
  border: color ? 'none' : '1px solid var(--border)', background: color ?? 'var(--card)', color: color ? '#fff' : 'var(--text-primary)',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
});

const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};

// 16px so a phone doesn't zoom in on them.
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)',
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '16px',
};
const pill = (on: boolean): React.CSSProperties => ({
  fontSize: '12px', fontWeight: 700, padding: '3px 10px', borderRadius: '999px', cursor: 'pointer',
  border: `1px solid ${on ? 'var(--text-secondary)' : 'var(--border)'}`, background: on ? 'var(--card)' : 'none',
  color: on ? 'var(--text-primary)' : 'var(--text-muted)',
});
const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' };
const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px', background: 'var(--card)' };
const heading: React.CSSProperties = { fontSize: '14px', fontWeight: 800, marginBottom: '6px' };
const muted: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)' };

const STANDINGS: Record<Standing, { label: string; color: string }> = {
  made: { label: 'Made', color: GREEN },
  kept_own: { label: "NetSuite's number", color: AMBER },
  refused: { label: 'Refused', color: RED },
  unsure: { label: 'Not sure', color: AMBER },
  sending: { label: 'Sending', color: GREY },
  no_answer: { label: 'No answer', color: AMBER },
};

const KINDS: Array<{ key: OwnNumberType | null; name: string }> = [
  { key: null, name: 'All' },
  { key: 'sales_order', name: 'Sales orders' },
  { key: 'purchase_order', name: 'POs' },
  { key: 'invoice', name: 'Invoices' },
  { key: 'credit_memo', name: 'Credit memos' },
];

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

interface Draft { type: OwnNumberType; prefix: string; next: string }

export default function BooksOwnNumbersPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  // Changing the numbers is the owner's; the bookkeeper and the CPA see them.
  const canChange = booksAllows(booksAccess(hasRole), 'owner');
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [kind, setKind] = useState<OwnNumberType | null>(null);
  const [showOutside, setShowOutside] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  /** Whether a link asked for the list made in NetSuite (?show=outside), to scroll to it once it's read. */
  const toOutside = useRef(false);

  const load = useCallback(async (show: OwnNumberType | null) => {
    try {
      const res = await apiFetch(`/api/admin/books/own-numbers${show ? `?show=${show}` : ''}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
    } catch (e: any) {
      setError(e?.message || "Couldn't read the numbers");
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    // The daily check's notification opens a kind's numbers, or what was made in NetSuite.
    const show = new URLSearchParams(window.location.search).get('show');
    const picked = KINDS.find((k) => k.key && k.key === show)?.key ?? null;
    if (show === 'outside') { toOutside.current = true; setShowOutside(true); }
    setKind(picked);
    load(picked);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  useEffect(() => {
    if (!data || !toOutside.current) return;
    toOutside.current = false;
    document.getElementById('outside')?.scrollIntoView({ block: 'start' });
  }, [data]);

  const pick = (key: OwnNumberType | null) => {
    setKind(key);
    load(key);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError('');
    try {
      const res = await apiFetch('/api/admin/books/own-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setDraft(null);
      await load(kind);
    } catch (e: any) {
      setSaveError(e?.message || "Couldn't change the numbers");
    }
    setSaving(false);
  };

  const outsideList = data && (data.on || showOutside) ? data.outside : [];

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Own numbers</div>
        <div style={muted}>
          The number FleetSuite gives each sales order, PO, invoice and credit memo it makes in NetSuite, and what became of each.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              NetSuite keeps FleetSuite&apos;s number only when Allow Override is ticked for that kind in NetSuite (Setup → Company →
              Auto-Generated Numbers); otherwise it gives its own, which is kept beside FleetSuite&apos;s. No number is given twice, and
              each one is kept here with what became of it, so every gap has its reason. Bills already carry FleetSuite&apos;s number:
              the Reference No. FleetSuite sends with each one. Sales orders and POs start in FleetSuite, so one made in NetSuite
              instead is listed at the bottom. The daily check tells the super admins once about each number NetSuite didn&apos;t keep
              and each sales order or PO made in NetSuite.
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href="/admin/books/switches" style={{ color: 'var(--text-secondary)' }}>Switches</Link>
          {' · '}
          <Link href="/admin/books/netsuite-feed" style={{ color: 'var(--text-secondary)' }}>NetSuite feed</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && (
        <>
          {!data.on && (
            <div style={banner(GREY)}>
              FleetSuite&apos;s own numbers is switched off, so NetSuite numbers what FleetSuite makes, as it does now.{' '}
              <Link href="/admin/books/switches" style={{ color: 'inherit', fontWeight: 700 }}>Switches</Link>
            </div>
          )}

          <div style={{ marginBottom: '16px' }}>
            <div style={heading}>Next numbers</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {data.series.map((s) => (
                <div key={s.type} style={card}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13px', fontWeight: 700, minWidth: '110px' }}>{s.many}</span>
                    <span style={{ fontSize: '15px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{s.nextNumber}</span>
                    {canChange && draft?.type !== s.type && (
                      <button
                        onClick={() => { setDraft({ type: s.type, prefix: s.prefix, next: String(s.next) }); setSaveError(''); }}
                        disabled={!!draft}
                        style={{ ...link, marginLeft: 'auto', opacity: draft ? 0.5 : 1 }}
                      >
                        Change
                      </button>
                    )}
                  </div>
                  {s.changedAt && <div style={muted}>Changed {when(s.changedAt)}{s.changedBy ? ` by ${s.changedBy}` : ''}</div>}
                  {draft?.type === s.type && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, 1fr) minmax(120px, 2fr)', gap: '8px' }}>
                        <div>
                          <span style={label}>Letters</span>
                          <input value={draft.prefix} maxLength={6} disabled={saving} autoCapitalize="characters"
                            onChange={(e) => setDraft({ ...draft, prefix: e.target.value.toUpperCase() })} style={input} />
                        </div>
                        <div>
                          <span style={label}>Next number</span>
                          <input value={draft.next} inputMode="numeric" disabled={saving}
                            onChange={(e) => setDraft({ ...draft, next: e.target.value })} style={input} />
                        </div>
                      </div>
                      <div style={{ ...muted, marginTop: '4px' }}>A number already given is never given again; FleetSuite skips to the next free one.</div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                        <button onClick={save} disabled={saving} style={act(GREEN, !saving)}>{saving ? 'Saving…' : 'Save'}</button>
                        <button onClick={() => { setDraft(null); setSaveError(''); }} disabled={saving} style={act(null, !saving)}>Leave without saving</button>
                      </div>
                      {saveError && <div style={{ ...banner(RED), marginTop: '8px', marginBottom: 0 }}>{saveError}</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <div style={heading}>Numbers given</div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
              {KINDS.map((k) => (
                <button key={k.name} onClick={() => pick(k.key)} style={pill(kind === k.key)}>{k.name}</button>
              ))}
            </div>
            {!data.numbers.length && (
              <div style={banner(GREY)}>
                {data.on ? 'None given yet. Each one shows here once FleetSuite sends it to NetSuite.' : "None given: NetSuite numbers them while it's off."}
              </div>
            )}
            {data.numbersMore && <div style={banner(AMBER)}>These are the newest {data.numbers.length}.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {data.numbers.map((n) => {
                const s = STANDINGS[n.standing];
                return (
                  <div key={n.id} style={card}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '14px', fontWeight: 800 }}>{n.number}</span>
                      <span style={chip(s.color)}>{s.label}</span>
                      <span style={muted}>{n.one}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: n.standing === 'made' || n.standing === 'sending' ? 'var(--text-secondary)' : s.color, marginTop: '2px' }}>
                      {n.text}
                    </div>
                    <div style={{ ...muted, marginTop: '2px' }}>
                      Given {when(n.at)}{n.by ? `, sent by ${n.by}` : ''}
                      {n.link && <>{' · '}<a href={n.link} target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>Open in NetSuite</a></>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div id="outside">
            <div style={heading}>Made in NetSuite instead</div>
            {data.on ? (
              <div style={{ ...muted, marginBottom: '8px' }}>
                Sales orders and POs dated from {day(data.since)}, when this went on, that were made in NetSuite, not FleetSuite, so they
                have no FleetSuite number.
              </div>
            ) : (
              <div style={{ ...muted, marginBottom: '8px' }}>
                {plural(data.outside.length, 'sales order or PO', 'sales orders and POs')}{data.outsideMore ? ' or more' : ''} made in NetSuite in
                the last {data.offDays} days, not by FleetSuite. Once this is on, each one made in NetSuite shows here.{' '}
                {data.outside.length > 0 && (
                  <button onClick={() => setShowOutside(!showOutside)} style={link}>{showOutside ? 'Hide' : 'Show'}</button>
                )}
              </div>
            )}
            {data.on && !data.outside.length && <div style={banner(GREY)}>None. Every sales order and PO since then started in FleetSuite.</div>}
            {data.outsideMore && (data.on || showOutside) && <div style={banner(AMBER)}>These are the newest {data.outside.length}.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {outsideList.map((o) => (
                <div key={o.netsuiteId} style={card}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '14px', fontWeight: 800 }}>{o.number ?? `NetSuite ID ${o.netsuiteId}`}</span>
                    <span style={chip(GREY)}>{o.one}</span>
                    {o.party && <span style={{ fontSize: '13px', fontWeight: 600 }}>{o.party}</span>}
                  </div>
                  <div style={{ ...muted, marginTop: '2px' }}>
                    Dated {day(o.date)}{o.by ? `, made by ${o.by}` : ''}
                    {o.link && <>{' · '}<a href={o.link} target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>Open in NetSuite</a></>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
