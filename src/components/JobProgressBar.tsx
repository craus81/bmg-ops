'use client';

/**
 * The Job progress bar (Valarie's mockup, Craig 2026-11-06): eight chevrons,
 * green done / blue in progress / grey upcoming / amber held up / striped
 * skipped, then the current stage, the next step and the parts tile. The
 * same bar sits on the estimate, the sales order page and the graphics job
 * page; `mini` is the slim version on an In-Shop vehicle card.
 *
 * Everything moves on its own (src/lib/job-progress.ts). The one button is
 * Mark all parts in, for parts that came in without a PO receipt.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import type { JobProgressView, JobStageView } from '@/lib/job-progress';

export type JobProgressRef = { estimate: string } | { so: string } | { graphicsJob: string } | { checkin: string };

interface Loaded {
  estimateId: string;
  estimateNumber: string | null;
  soNumber: string | null;
  progress: JobProgressView;
}

const GREEN = '#16a34a';
const BLUE = '#2563eb';
const AMBER = '#d97706';

const CSS = `
.jp-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.jp-scroll::-webkit-scrollbar{display:none}
.jp-bar{display:flex;gap:3px;min-width:100%}
.jp-seg{position:relative;flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;text-align:center;
  padding:9px 4px 9px 14px;min-height:70px;background:var(--subtle-bg);color:var(--text-secondary);border:0;font:inherit;
  clip-path:polygon(0 0,calc(100% - 11px) 0,100% 50%,calc(100% - 11px) 100%,0 100%,11px 50%);box-shadow:inset 0 0 0 999px rgba(127,127,127,.10)}
.jp-seg:first-child{clip-path:polygon(0 0,calc(100% - 11px) 0,100% 50%,calc(100% - 11px) 100%,0 100%);border-radius:10px 0 0 10px;padding-left:6px}
.jp-seg:last-child{clip-path:polygon(0 0,100% 0,100% 100%,0 100%,11px 50%);border-radius:0 10px 10px 0}
.jp-done{background:${GREEN};color:#fff;box-shadow:none}
.jp-now{background:${BLUE};color:#fff;box-shadow:none}
.jp-held{background:${AMBER};color:#fff;box-shadow:none}
.jp-skip{background:repeating-linear-gradient(135deg,rgba(127,127,127,.10) 0 6px,rgba(127,127,127,.22) 6px 12px);box-shadow:none;color:var(--text-muted)}
.jp-ic{width:21px;height:21px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:11px;flex:none}
.jp-done .jp-ic{background:#fff;color:${GREEN}}
.jp-now .jp-ic{background:#fff;color:${BLUE}}
.jp-held .jp-ic{background:#fff;color:${AMBER}}
.jp-todo .jp-ic,.jp-skip .jp-ic{border:2px solid currentColor}
.jp-nm{font-weight:800;font-size:12.5px;line-height:1.12}
.jp-tag{font-weight:800;font-size:9px;letter-spacing:.05em;text-transform:uppercase;background:rgba(255,255,255,.22);padding:2px 5px;border-radius:5px}
.jp-mini .jp-seg{min-height:28px;padding:3px 2px 3px 12px;cursor:pointer}
.jp-mini .jp-seg:first-child{padding-left:4px}
.jp-mini .jp-nm,.jp-mini .jp-tag{display:none}
.jp-mini .jp-ic{width:16px;height:16px;font-size:9.5px}
.jp-swipe{display:none;font-size:11px;color:var(--text-muted);text-align:right}
.jp-tiles{display:grid;grid-template-columns:1fr 1fr;gap:8px}
@media (max-width:640px){
  .jp-full .jp-bar{min-width:640px}
  .jp-full .jp-tag{display:none}
  .jp-swipe{display:block}
  .jp-tiles{grid-template-columns:1fr}
}
`;

const CHECK = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>
);

function queryOf(ref: JobProgressRef): string {
  const [k, v] = Object.entries(ref)[0];
  return `${k}=${encodeURIComponent(v)}`;
}

function Segments({ stages }: { stages: JobStageView[] }) {
  let n = 0;
  return (
    <div className="jp-bar" role="list" aria-label="Job progress">
      {stages.map(s => {
        if (s.state !== 'skip') n += 1;
        const stateWord = { done: 'completed', now: 'in progress', todo: 'upcoming', skip: 'skipped', held: 'held up' }[s.state];
        return (
          <div key={s.key} role="listitem" className={`jp-seg jp-${s.state}`} title={`${s.label}: ${s.detail}`} aria-label={`${s.label}: ${stateWord}. ${s.detail}`} data-now={s.state === 'now' ? '1' : undefined}>
            <span className="jp-ic">{s.state === 'done' ? CHECK : s.state === 'skip' ? '–' : s.state === 'held' ? '!' : n}</span>
            <span className="jp-nm">{s.label}</span>
            {s.state === 'now' && <span className="jp-tag">In progress</span>}
            {s.state === 'held' && <span className="jp-tag">Held up</span>}
          </div>
        );
      })}
    </div>
  );
}

export function useJobProgress(ref: JobProgressRef | null) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const q = ref ? queryOf(ref) : null;

  const load = useCallback(async () => {
    if (!q) return;
    try {
      const res = await apiFetch(`/api/job-progress?${q}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || "Couldn't load the job progress."); return; }
      setError(null);
      setData(body.found ? body : null);
    } catch {
      setError("Couldn't load the job progress. Check your connection.");
    } finally {
      setLoaded(true);
    }
  }, [q]);

  useEffect(() => { load(); }, [load]);
  return { data, error, loaded, reload: load };
}

/** The full bar with the current-stage card. Renders nothing for an order
 *  that isn't approved yet. */
export default function JobProgressBar({ refTo }: { refTo: JobProgressRef }) {
  const { hasFeature } = useAuth();
  const { data, error, reload } = useJobProgress(refTo);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Open on the blue step when the bar scrolls (phones).
  useEffect(() => {
    const sc = scrollRef.current;
    const el = sc?.querySelector('[data-now="1"]') as HTMLElement | null;
    if (sc && el && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = el.offsetLeft - sc.clientWidth / 2 + el.offsetWidth / 2;
  }, [data]);

  if (error) return <div style={{ color: theme.error, fontSize: '13px', fontWeight: 600 }}>{error}</div>;
  if (!data) return null;
  const p = data.progress;
  const cur = p.stages.find(s => s.key === p.current)!;
  const partsOpen = p.stages.some(s => s.key === 'parts_in' && (s.state === 'now' || s.state === 'held'));
  const canMark = partsOpen && hasFeature('estimates');

  const markPartsIn = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      const res = await apiFetch(`/api/estimates/${data.estimateId}/order-status/parts-in`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setSaveError(body.error || "Couldn't mark the parts in.");
      else await reload();
    } catch {
      setSaveError("Couldn't mark the parts in. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

  const stageColor = cur.state === 'done' ? GREEN : cur.state === 'held' ? AMBER : BLUE;
  const tile: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '2px', border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '10px 12px', minWidth: 0,
  };

  return (
    <div className="jp-full" style={{ display: 'grid', gap: '10px', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px', color: theme.textPrimary }}>
      <style>{CSS}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: theme.textMuted }}>Job progress</div>
        <Link href={`/sales-orders/stages?stage=${p.current}`} style={{ fontSize: '12px', fontWeight: 700, color: BLUE, textDecoration: 'none' }}>
          Everything in {p.done ? 'Complete' : cur.label} →
        </Link>
      </div>
      <div style={{ display: 'grid', gap: '4px' }}>
        <div className="jp-scroll" ref={scrollRef}><Segments stages={p.stages} /></div>
        <span className="jp-swipe">Swipe for all 8 steps →</span>
      </div>

      <div style={{ background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`, borderLeft: `4px solid ${stageColor}`, borderRadius: '10px', padding: '10px 12px' }}>
        <div style={{ fontSize: '16px', fontWeight: 800 }}>{p.done ? 'Complete' : `Current stage: ${cur.label}`}</div>
        <div style={{ fontSize: '13px', color: theme.textSecondary }}>{cur.detail}</div>
        {p.heldUp.length > 0 && !p.done && (
          <div style={{ fontSize: '13px', color: AMBER, fontWeight: 700, marginTop: '4px' }}>Still open: {p.heldUp.join(', ')}</div>
        )}
      </div>

      <div className="jp-tiles">
        <div style={tile}>
          <span style={{ fontSize: '12px', color: theme.textMuted }}>Next step</span>
          <span style={{ fontSize: '14px', fontWeight: 700 }}>{p.nextStep}</span>
        </div>
        <div style={tile}>
          <span style={{ fontSize: '12px', color: theme.textMuted }}>Parts &amp; materials</span>
          <span style={{ fontSize: '14px', fontWeight: 700, color: p.parts.ok ? GREEN : theme.textPrimary }}>{p.parts.ok ? '✓ ' : ''}{p.parts.text}</span>
        </div>
      </div>

      {canMark && (
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span style={{ fontSize: '12px', color: theme.textMuted, flex: '1 1 220px' }}>Parts in moves on its own when every PO line is received. Use this if they came in another way.</span>
          <button type="button" onClick={markPartsIn} disabled={busy} style={{
            padding: '9px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, cursor: busy ? 'default' : 'pointer',
            background: theme.card, color: theme.textPrimary, border: `1px solid ${theme.border}`,
          }}>{busy ? 'Saving…' : 'Mark all parts in'}</button>
        </div>
      )}
      {saveError && <div style={{ color: theme.error, fontSize: '13px', fontWeight: 600 }}>{saveError}</div>}
    </div>
  );
}

/** The slim bar on an In-Shop vehicle card, in place of the status
 *  buttons: tap it to open them (picking Graphics or Upfit in progress is
 *  what moves the job to Install). A vehicle with no approved order behind
 *  it keeps the buttons showing, as before. */
export function JobProgressMini({ checkinId, children }: { checkinId: string; children: React.ReactNode }) {
  const { data, loaded } = useJobProgress({ checkin: checkinId });
  const [open, setOpen] = useState(false);
  if (!loaded || !data) return <>{children}</>;
  const p = data.progress;
  const cur = p.stages.find(s => s.key === p.current)!;
  return (
    <div className="jp-mini" style={{ display: 'grid', gap: '6px' }}>
      <style>{CSS}</style>
      <button type="button" onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(o => !o); }} aria-expanded={open}
        style={{ all: 'unset', display: 'block', cursor: 'pointer' }}
        aria-label={`Job progress: ${p.done ? 'Complete' : cur.label}. Tap to ${open ? 'hide' : 'show'} the status buttons.`}>
        <Segments stages={p.stages} />
      </button>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', fontSize: '12px', color: theme.textSecondary }}>
        <span style={{ flex: '1 1 auto', minWidth: 0 }}>
          {p.done ? <b style={{ color: GREEN }}>Complete</b> : <><b style={{ color: cur.state === 'held' ? AMBER : BLUE }}>{cur.label}</b> · {cur.detail}</>}
          {p.heldUp.length > 0 && !p.done ? <span style={{ color: AMBER, fontWeight: 700 }}> · Still open: {p.heldUp.join(', ')}</span> : null}
        </span>
        <button type="button" onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(o => !o); }}
          style={{ background: 'none', border: 'none', padding: 0, color: BLUE, fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}>
          {open ? 'Hide status buttons' : 'Update status'}
        </button>
      </div>
      {open && children}
    </div>
  );
}
