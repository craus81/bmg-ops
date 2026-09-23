'use client';

/**
 * The admin work order — a hand-ranked queue that tells the designer and the
 * production manager which graphics job to start next.
 *
 * Due dates and the priority bucket both tie constantly (a dozen "high" jobs
 * due the same week say nothing about what to touch first), so admins drag an
 * explicit 1..N list here and the board sorts by it. Ranked jobs float to the
 * top of the board in this order; everything else stays below them ordered by
 * due date, which is exactly how the board behaved before ranking existed.
 *
 * Reordering saves itself (debounced) through /api/graphics-jobs/rank — the
 * admin-only route that rewrites the whole list as a contiguous block. The
 * server's returned order is what lands in state, so two admins reordering at
 * once converge instead of each keeping their own optimistic copy.
 *
 * Buttons, not just drag: HTML5 drag-and-drop does nothing on a touch screen
 * and this app ships as a phone app, so ▲/▼ are the primary control and the
 * drag handle is the enhancement.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { isOffTheFloor } from '@/lib/graphics-status';
import { rankedQueue, unrankedPool } from '@/lib/graphics-work-order';
import {
  GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_COLORS,
  type GraphicsJob, type Profile,
} from '@/lib/types';

const priorityColor = (p: string) => {
  switch (p) {
    case 'rush': return '#ef4444';
    case 'high': return '#f59e0b';
    case 'normal': return '#60a5fa';
    default: return '#6b7280';
  }
};

const displayDate = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.substring(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(y, m - 1, d).toLocaleDateString();
};

export default function GraphicsWorkOrderModal({ jobs, profiles = [], onClose }: {
  jobs: GraphicsJob[];
  profiles?: Profile[];
  /** Called once on close — the board reloads so the new ranks land in the table. */
  onClose: (changed: boolean) => void;
}) {
  // Only jobs someone can still work belong on the list. A job off the floor
  // that is somehow still ranked is dropped here and cleared by the next save.
  const workable = useMemo(() => jobs.filter(j => !isOffTheFloor(j.status)), [jobs]);
  const byId = useMemo(() => new Map(workable.map(j => [j.id, j])), [workable]);

  // Seeded once: after this the server's response is the source of truth, so
  // a board refresh underneath can't yank a row out from under a drag.
  const [order, setOrder] = useState<string[]>(() => rankedQueue(workable).map(j => j.id));

  const [saveState, setSaveState] = useState<'clean' | 'saving' | 'saved' | 'error'>('clean');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [poolSearch, setPoolSearch] = useState('');

  const changedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string[] | null>(null);
  // Serializes saves: every flush chains onto the previous one, so a fast
  // series of ▲ clicks can't land out of order.
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const drain = useCallback(async () => {
    while (pendingRef.current) {
      const next = pendingRef.current;
      pendingRef.current = null;
      setSaveState('saving');
      try {
        const res = await apiFetch('/api/graphics-jobs/rank', {
          method: 'POST',
          body: JSON.stringify({ order: next }),
        });
        const body = await res.json().catch(() => ({} as any));
        if (!res.ok) throw new Error(body?.error || `Save failed (${res.status})`);
        if (Array.isArray(body.order)) setOrder(body.order);
        changedRef.current = true;
        setSaveError(null);
        setSaveState('saved');
      } catch (e: any) {
        setSaveError(e?.message || 'Could not save the work order.');
        setSaveState('error');
      }
    }
  }, []);

  const flush = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    chainRef.current = chainRef.current.then(drain);
    return chainRef.current;
  }, [drain]);

  const applyOrder = useCallback((next: string[]) => {
    setOrder(next);
    pendingRef.current = next;
    setSaveState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flush(); }, 500);
  }, [flush]);

  // Never close on an unsaved drag: flush first, then let the board reload.
  const close = useCallback(async () => {
    await flush();
    onClose(changedRef.current);
  }, [flush, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // A pending debounce must not die with the component.
  useEffect(() => () => { if (pendingRef.current) void flush(); }, [flush]);

  const ranked = order.map(id => byId.get(id)).filter((j): j is GraphicsJob => !!j);
  const rankedIds = new Set(order);
  // Unranked jobs are offered soonest-due first — the most likely next pick.
  const pool = unrankedPool(workable, rankedIds).filter(j => {
    const term = poolSearch.trim().toLowerCase();
    if (!term) return true;
    return [j.title, j.customer, j.job_number, j.po_number].some(v => v?.toLowerCase().includes(term));
  });

  const move = (id: string, delta: number) => {
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    applyOrder(next);
  };

  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const next = order.filter(id => id !== dragId);
    const at = next.indexOf(targetId);
    next.splice(at < 0 ? next.length : at, 0, dragId);
    applyOrder(next);
    setDragId(null);
  };

  const add = (id: string, toTop: boolean) =>
    applyOrder(toTop ? [id, ...order.filter(x => x !== id)] : [...order.filter(x => x !== id), id]);

  const remove = (id: string) => applyOrder(order.filter(x => x !== id));

  const today = new Date().toISOString().slice(0, 10);
  const assigneeName = (job: GraphicsJob) => {
    if (!job.assigned_to) return null;
    const p = profiles.find(pr => pr.id === job.assigned_to);
    return p?.full_name || p?.email || null;
  };

  const chip = (color: string): React.CSSProperties => ({
    fontSize: '9px', fontWeight: 800, color, padding: '1px 6px', borderRadius: '4px',
    background: `${color}15`, border: `1px solid ${color}33`, whiteSpace: 'nowrap',
    textTransform: 'uppercase', letterSpacing: '0.3px',
  });

  const iconBtn: React.CSSProperties = {
    padding: '2px 7px', borderRadius: '6px', fontSize: '11px', fontWeight: 800, cursor: 'pointer',
    background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
    lineHeight: 1.6,
  };

  const jobLine = (job: GraphicsJob) => (
    <>
      <div style={{ fontSize: '12.5px', fontWeight: 800, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {job.title}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '2px' }}>
        <span style={chip(GRAPHICS_STATUS_COLORS[job.status])}>
          {GRAPHICS_STATUS_LABELS[job.status].replace('Job ', '')}
        </span>
        {job.priority !== 'normal' && <span style={chip(priorityColor(job.priority))}>{job.priority}</span>}
        {job.due_date && (
          <span style={{
            fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap',
            color: job.due_date.slice(0, 10) < today ? '#ef4444' : 'var(--text-muted)',
          }}>
            {job.due_date.slice(0, 10) < today ? '⚠ due ' : 'due '}{displayDate(job.due_date)}
          </span>
        )}
        {job.customer && (
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>
            {job.customer}
          </span>
        )}
        {assigneeName(job) && (
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>★ {assigneeName(job)}</span>
        )}
      </div>
    </>
  );

  const saveLabel = saveState === 'saving' ? 'Saving…'
    : saveState === 'saved' ? 'Saved ✓'
    : saveState === 'error' ? 'Not saved'
    : '';

  return (
    <div
      onClick={() => void close()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        zIndex: 1000, padding: '20px', overflowY: 'auto',
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--card)', borderRadius: '14px', maxWidth: '720px', width: '100%',
        border: '1px solid var(--border)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)', margin: 'auto 0',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Work Order</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              Drag or use ▲▼ to set what gets worked first. The board sorts by this list.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {saveLabel && (
              <span style={{
                fontSize: '10px', fontWeight: 800, whiteSpace: 'nowrap',
                color: saveState === 'error' ? '#ef4444' : saveState === 'saved' ? '#22c55e' : 'var(--text-muted)',
              }}>{saveLabel}</span>
            )}
            <button onClick={() => void close()} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: 'var(--text-muted)', lineHeight: 1 }}>✕</button>
          </div>
        </div>

        {saveError && (
          <div style={{ margin: '12px 18px 0', padding: '8px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}>
            {saveError} — your last change is not saved. Try moving it again.
          </div>
        )}

        {/* The queue */}
        <div style={{ padding: '14px 18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              In order ({ranked.length})
            </div>
            {ranked.length > 0 && (
              <button onClick={() => applyOrder([])} style={{ ...iconBtn, color: 'var(--text-muted)' }}>Clear list</button>
            )}
          </div>

          {ranked.length === 0 ? (
            <div style={{ padding: '18px 0', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
              Nothing ranked yet — add jobs below and the board falls back to due-date order.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              {ranked.map((job, i) => (
                <div
                  key={job.id}
                  draggable
                  onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDragId(job.id); }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); dropOn(job.id); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '7px 9px', borderRadius: '9px', background: 'var(--bg)',
                    border: `1px solid ${dragId === job.id ? '#60a5fa' : 'var(--border)'}`,
                    opacity: dragId === job.id ? 0.5 : 1,
                  }}
                >
                  <span title="Drag to reorder" style={{ cursor: 'grab', color: 'var(--text-label)', fontSize: '12px' }}>⋮⋮</span>
                  <span style={{
                    minWidth: '26px', textAlign: 'center', fontSize: '12px', fontWeight: 800,
                    color: i === 0 ? '#22c55e' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums',
                  }}>#{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>{jobLine(job)}</div>
                  <div style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                    <button onClick={() => move(job.id, -1)} disabled={i === 0} title="Move up" style={{ ...iconBtn, opacity: i === 0 ? 0.35 : 1 }}>▲</button>
                    <button onClick={() => move(job.id, 1)} disabled={i === ranked.length - 1} title="Move down" style={{ ...iconBtn, opacity: i === ranked.length - 1 ? 0.35 : 1 }}>▼</button>
                    <button onClick={() => remove(job.id)} title="Take off the list" style={{ ...iconBtn, color: 'var(--text-muted)' }}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Everything not on the list yet */}
        <div style={{ padding: '4px 18px 18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Not ranked ({pool.length})
            </div>
            <input
              value={poolSearch}
              onChange={e => setPoolSearch(e.target.value)}
              placeholder="Search jobs…"
              style={{
                padding: '5px 9px', borderRadius: '8px', fontSize: '11px', width: '160px',
                border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-body)',
              }}
            />
          </div>

          {pool.length === 0 ? (
            <div style={{ padding: '10px 0', fontSize: '11px', color: 'var(--text-muted)' }}>
              {poolSearch ? 'No jobs match that search.' : 'Every active job is on the list.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', maxHeight: '320px', overflowY: 'auto' }}>
              {pool.map(job => (
                <div key={job.id} style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '7px 9px', borderRadius: '9px', background: 'var(--bg)', border: '1px solid var(--border)',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>{jobLine(job)}</div>
                  <div style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                    <button onClick={() => add(job.id, true)} title="Make this the next job" style={{ ...iconBtn, color: '#22c55e' }}>⤒ Top</button>
                    <button onClick={() => add(job.id, false)} title="Add to the bottom of the list" style={iconBtn}>+ Add</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={() => void close()} style={{
            padding: '7px 16px', borderRadius: '9px', fontSize: '12px', fontWeight: 800, cursor: 'pointer',
            background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
          }}>Done</button>
        </div>
      </div>
    </div>
  );
}
