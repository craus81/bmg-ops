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
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import type { JobPart, JobProgressView, JobStageView } from '@/lib/job-progress';

export type JobProgressRef = { estimate: string } | { so: string } | { graphicsJob: string } | { checkin: string };

interface Loaded {
  estimateId: string;
  estimateNumber: string | null;
  soNumber: string | null;
  soNetsuiteId?: string | null;
  progress: JobProgressView;
  parts?: JobPart[];
}

type PartsFilter = 'all' | 'notin' | 'in';

const GREEN = '#16a34a';
const BLUE = '#2563eb';
const AMBER = '#d97706';
const ORANGE = '#ea580c';

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
.jp-need{background:rgba(234,88,12,.14);color:${ORANGE};box-shadow:none}
.jp-need .jp-ic{border:2px solid currentColor}
.jp-need .jp-tag{background:rgba(234,88,12,.16)}
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
.jp-tap{cursor:pointer}
.jp-tap:focus-visible{outline:2px solid ${BLUE};outline-offset:2px}
.jp-see{color:${BLUE};font-weight:700;font-size:12.5px;white-space:nowrap}
.jp-sheet-wrap{position:fixed;inset:0;background:rgba(10,14,20,.55);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}
.jp-sheet{background:var(--bg);color:var(--text-primary);width:min(640px,100%);max-height:calc(90vh / var(--ts, 1));overflow:auto;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box}
@media (max-width:640px){.jp-sheet-wrap{padding:0}.jp-sheet{width:100%;height:100%;max-height:none;border-radius:0;padding:calc(14px + env(safe-area-inset-top,0px)) 16px calc(16px + env(safe-area-inset-bottom,0px))}}
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

const PARTS_KEYS = new Set(['parts_ordered', 'parts_in']);

function Segments({ stages, onParts, onCreateGraphics }: { stages: JobStageView[]; onParts?: (f: PartsFilter) => void; onCreateGraphics?: () => void }) {
  let n = 0;
  return (
    <div className="jp-bar" role="list" aria-label="Job progress">
      {stages.map(s => {
        if (s.state !== 'skip') n += 1;
        const stateWord = { done: 'completed', now: 'in progress', todo: 'upcoming', skip: 'skipped', held: 'held up' }[s.state];
        const inner = (
          <>
            <span className="jp-ic">{s.state === 'done' ? CHECK : s.state === 'skip' ? '–' : s.state === 'held' ? '!' : n}</span>
            <span className="jp-nm">{s.label}</span>
            {s.needsJob
              ? <span className="jp-tag">{onCreateGraphics ? 'Tap to create' : 'No job yet'}</span>
              : <>
                {s.state === 'now' && <span className="jp-tag">In progress</span>}
                {s.state === 'held' && <span className="jp-tag">Held up</span>}
              </>}
          </>
        );
        // The order has graphics lines but no graphics job (Craig 2026-11-06):
        // orange, and tapping it opens the New Job form filled in.
        if (s.needsJob) {
          const cls = `jp-seg jp-need${onCreateGraphics ? ' jp-tap' : ''}`;
          return onCreateGraphics ? (
            <div key={s.key} role="listitem" style={{ display: 'contents' }}>
              <button type="button" className={cls} title={`${s.label}: ${s.detail}. Tap to create it.`}
                aria-label={`${s.label}: ${s.detail}. Create the graphics job.`} data-now={s.state === 'now' ? '1' : undefined}
                onClick={(e) => { e.stopPropagation(); onCreateGraphics(); }}>
                {inner}
              </button>
            </div>
          ) : (
            <div key={s.key} role="listitem" className={cls} title={`${s.label}: ${s.detail}`} aria-label={`${s.label}: ${s.detail}`} data-now={s.state === 'now' ? '1' : undefined}>
              {inner}
            </div>
          );
        }
        if (onParts && PARTS_KEYS.has(s.key)) {
          return (
            <div key={s.key} role="listitem" style={{ display: 'contents' }}>
              <button type="button" className={`jp-seg jp-${s.state} jp-tap`} title={`${s.label}: ${s.detail}. Tap to see the parts.`}
                aria-label={`${s.label}: ${stateWord}. ${s.detail}. Show the parts list.`} data-now={s.state === 'now' ? '1' : undefined}
                onClick={(e) => { e.stopPropagation(); onParts(s.key === 'parts_in' ? 'notin' : 'all'); }}>
                {inner}
              </button>
            </div>
          );
        }
        return (
          <div key={s.key} role="listitem" className={`jp-seg jp-${s.state}`} title={`${s.label}: ${s.detail}`} aria-label={`${s.label}: ${stateWord}. ${s.detail}`} data-now={s.state === 'now' ? '1' : undefined}>
            {inner}
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
export default function JobProgressBar({ refTo, createGraphicsHref }: {
  refTo: JobProgressRef;
  /** Where "Needs graphics job" goes; defaults to the New Job form from the estimate. */
  createGraphicsHref?: string;
}) {
  const { hasFeature } = useAuth();
  const router = useRouter();
  const { data, error, reload } = useJobProgress(refTo);
  const [partsSheet, setPartsSheet] = useState<PartsFilter | null>(null);
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

  const stageColor = cur.needsJob ? ORANGE : cur.state === 'done' ? GREEN : cur.state === 'held' ? AMBER : BLUE;
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
        <div className="jp-scroll" ref={scrollRef}><Segments stages={p.stages} onParts={setPartsSheet}
          onCreateGraphics={() => router.push(createGraphicsHref || `/graphics?new=1&fromEstimate=${encodeURIComponent(data.estimateId)}`)} /></div>
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
        <button type="button" className="jp-tap" onClick={() => setPartsSheet('all')}
          style={{ ...tile, flexDirection: 'row', alignItems: 'center', gap: '8px', background: theme.card, color: theme.textPrimary, font: 'inherit', textAlign: 'left' }}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: '12px', color: theme.textMuted }}>Parts &amp; materials</span>
            <span style={{ fontSize: '14px', fontWeight: 700, color: p.parts.ok ? GREEN : theme.textPrimary }}>{p.parts.ok ? '✓ ' : ''}{p.parts.text}</span>
          </span>
          <span className="jp-see">See parts ›</span>
        </button>
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
      {partsSheet && <JobPartsSheet data={data} start={partsSheet} onClose={() => setPartsSheet(null)} />}
    </div>
  );
}

const PART_STATUS: Record<JobPart['status'], { label: string; color: string; bg: string; group: string }> = {
  not_ordered: { label: 'Not ordered', color: AMBER, bg: 'rgba(217,119,6,.14)', group: 'Not ordered' },
  ordered: { label: 'Ordered', color: BLUE, bg: 'rgba(37,99,235,.12)', group: 'Ordered, not in yet' },
  in: { label: 'In', color: GREEN, bg: 'rgba(22,163,74,.13)', group: 'In' },
};

/** Every part on the order and where it stands: full screen on a phone. */
export function JobPartsSheet({ data, start, onClose }: { data: Loaded; start: PartsFilter; onClose: () => void }) {
  const [filter, setFilter] = useState<PartsFilter>(start);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); before?.focus?.(); };
  }, [onClose]);

  const parts = data.parts || [];
  const count = (st: JobPart['status']) => parts.filter(x => x.status === st).length;
  const shown = parts.filter(x => filter === 'all' || (filter === 'in' ? x.status === 'in' : x.status !== 'in'));
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: '999px', fontSize: '12.5px', fontWeight: 700, cursor: 'pointer',
    background: on ? 'rgba(37,99,235,.12)' : theme.card, color: on ? BLUE : theme.textPrimary,
    border: `1px solid ${on ? BLUE : theme.border}`,
  });
  const title = data.soNumber ? `Parts · ${data.soNumber}` : data.estimateNumber ? `Parts · Estimate #${data.estimateNumber}` : 'Parts';

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="jp-sheet-wrap" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
      <style>{CSS}</style>
      <div className="jp-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start' }}>
          <div style={{ fontSize: '19px', fontWeight: 800, minWidth: 0 }}>{title}</div>
          <button ref={closeRef} type="button" onClick={onClose} style={{
            padding: '8px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
            background: theme.card, color: theme.textPrimary, border: `1px solid ${theme.border}`,
          }}>Close</button>
        </div>
        {parts.length === 0 ? (
          <div style={{ fontSize: '14px', color: theme.textMuted }}>No parts on this order: nothing was requested and the sales order has no part lines.</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {(['in', 'ordered', 'not_ordered'] as const).map(st => count(st) > 0 && (
                <span key={st} style={{ fontSize: '12px', fontWeight: 700, padding: '4px 9px', borderRadius: '999px', background: PART_STATUS[st].bg, color: PART_STATUS[st].color }}>
                  {count(st)} {st === 'in' ? 'in' : st === 'ordered' ? 'ordered, not in' : 'not ordered'}
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button type="button" style={chip(filter === 'all')} onClick={() => setFilter('all')}>All {parts.length}</button>
              <button type="button" style={chip(filter === 'notin')} onClick={() => setFilter('notin')}>Not in yet {parts.length - count('in')}</button>
              <button type="button" style={chip(filter === 'in')} onClick={() => setFilter('in')}>In {count('in')}</button>
            </div>
            <div style={{ border: `1px solid ${theme.border}`, borderRadius: '12px', background: theme.card, overflow: 'hidden' }}>
              {shown.length === 0 && <div style={{ padding: '12px 14px', fontSize: '14px', color: theme.textMuted }}>Nothing here.</div>}
              {(['not_ordered', 'ordered', 'in'] as const).filter(st => shown.some(x => x.status === st)).map((st, gi) => {
                const rows = shown.filter(x => x.status === st);
                return (
                  <div key={st}>
                    <div style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: theme.textMuted, padding: '10px 14px 4px', borderTop: gi === 0 ? 'none' : `1px solid ${theme.border}` }}>
                      {PART_STATUS[st].group} · {rows.length}
                    </div>
                    {rows.map((r, i) => (
                      <div key={`${r.itemNumber}-${i}`} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 10px', padding: '9px 14px', borderTop: i === 0 ? 'none' : `1px solid ${theme.border}` }}>
                        <span style={{ fontWeight: 700, minWidth: 0, overflowWrap: 'anywhere' }}>{r.itemNumber}{r.quantity && r.quantity > 1 ? ` ×${Math.round(r.quantity * 100) / 100}` : ''}</span>
                        <span style={{ fontSize: '12px', fontWeight: 700, padding: '3px 8px', borderRadius: '999px', alignSelf: 'start', whiteSpace: 'nowrap', background: PART_STATUS[r.status].bg, color: PART_STATUS[r.status].color }}>{PART_STATUS[r.status].label}</span>
                        {r.description && <span style={{ gridColumn: '1 / -1', fontSize: '12.5px', color: theme.textMuted, minWidth: 0 }}>{r.description}</span>}
                        <span style={{ gridColumn: '1 / -1', fontSize: '12.5px', color: theme.textSecondary, minWidth: 0 }}>{r.where}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </>
        )}
        {data.soNetsuiteId && (
          <a href={`${deepLinks.salesOrder(data.soNetsuiteId)}#so-parts`} style={{ color: BLUE, fontWeight: 700, fontSize: '14px', textDecoration: 'none', alignSelf: 'flex-start' }}>
            Open the sales order&apos;s Parts card →
          </a>
        )}
        <div style={{ fontSize: '12px', color: theme.textMuted }}>Same counts as the bar. &quot;In&quot; means the PO line was received, someone tapped Got it, it came off the shelf, or all parts were marked in.</div>
      </div>
    </div>,
    document.body,
  );
}

/** "Parts: 14 of 16 ordered · 5 in · See parts ›" for the customer-updates
 *  card under the bar, using the bar's own counts. */
export function JobPartsLine({ estimateId, fallback }: { estimateId: string; fallback: string }) {
  const { data } = useJobProgress({ estimate: estimateId });
  const [open, setOpen] = useState(false);
  if (!data) return <>{fallback}</>;
  return (
    <>
      <button type="button" className="jp-tap" onClick={() => setOpen(true)}
        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', textAlign: 'left' }}>
        Parts: {data.progress.parts.text} · <span style={{ color: BLUE, fontWeight: 700 }}>See parts ›</span>
      </button>
      {open && <JobPartsSheet data={data} start="all" onClose={() => setOpen(false)} />}
    </>
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
