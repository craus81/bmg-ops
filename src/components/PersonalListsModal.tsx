'use client';

/**
 * People's Lists — where an admin orders each person's own jobs (migration
 * 326). Opened from the Graphics board and the In-Shop board; each board has
 * its own list type, so a person's graphics list and vehicle list are
 * separate (owner decision, 2026-09-25).
 *
 * Every job assigned to the chosen person is on their list; nothing is added
 * or removed here. Jobs nobody has ordered yet come after the ordered ones in
 * the board's default order and are marked "not set", so the manager can
 * see what they have and haven't placed. Saving writes the whole visible
 * order, like the shared work order modal: debounced, serialized, and the
 * server's echo is what lands in state.
 *
 * ▲/▼ are the primary control because drag-and-drop does nothing on a touch
 * screen; the drag handle is the desktop enhancement.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { WorkListItem, WorkListType } from '@/lib/personal-work-list';

interface Person { id: string; name: string; count: number }

const displayDate = (d: string | null) => {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return y && m && day ? new Date(y, m - 1, day).toLocaleDateString() : '';
};

export default function PersonalListsModal({ type, initialUserId, onClose }: {
  type: WorkListType;
  /** Open on this person (e.g. the board's assignee filter). */
  initialUserId?: string | null;
  onClose: (changed: boolean) => void;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [userId, setUserId] = useState<string | null>(initialUserId || null);
  const [items, setItems] = useState<WorkListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'clean' | 'saving' | 'saved' | 'error'>('clean');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const changedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ userId: string; order: string[] } | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const noun = type === 'graphics' ? 'jobs' : 'vehicles';

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`/api/work-lists?type=${type}&people=1`);
        const body = await res.json().catch(() => ({} as any));
        if (!res.ok) throw new Error(body?.error || `Could not load people (${res.status})`);
        const list: Person[] = body.people || [];
        setPeople(list);
        setUserId(prev => prev && list.some(p => p.id === prev) ? prev : list[0]?.id || null);
      } catch (e: any) {
        setLoadError(e?.message || 'Could not load people.');
      }
    })();
  }, [type]);

  useEffect(() => {
    if (!userId) { setItems(null); return; }
    let cancelled = false;
    setItems(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/work-lists?type=${type}&userId=${userId}`);
        const body = await res.json().catch(() => ({} as any));
        if (!res.ok) throw new Error(body?.error || `Could not load the list (${res.status})`);
        if (!cancelled) { setItems(body.items || []); setLoadError(null); }
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || 'Could not load the list.');
      }
    })();
    return () => { cancelled = true; };
  }, [type, userId]);

  const drain = useCallback(async () => {
    while (pendingRef.current) {
      const next = pendingRef.current;
      pendingRef.current = null;
      setSaveState('saving');
      try {
        const res = await apiFetch('/api/work-lists', {
          method: 'POST',
          body: JSON.stringify({ type, userId: next.userId, order: next.order }),
        });
        const body = await res.json().catch(() => ({} as any));
        if (!res.ok) throw new Error(body?.error || `Save failed (${res.status})`);
        // Only adopt the echo if the manager is still looking at that person.
        if (Array.isArray(body.items) && userIdRef.current === next.userId && !pendingRef.current) setItems(body.items);
        changedRef.current = true;
        setSaveError(null);
        setSaveState('saved');
      } catch (e: any) {
        setSaveError(e?.message || 'Could not save the list.');
        setSaveState('error');
      }
    }
  }, [type]);

  const flush = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    chainRef.current = chainRef.current.then(drain);
    return chainRef.current;
  }, [drain]);

  const applyOrder = (next: WorkListItem[]) => {
    if (!userId) return;
    // Everything on screen is now placed by the manager.
    const placed = next.map(i => ({ ...i, ranked: true }));
    setItems(placed);
    pendingRef.current = { userId, order: placed.map(i => i.id) };
    setSaveState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flush(); }, 500);
  };

  const close = useCallback(async () => {
    await flush();
    onClose(changedRef.current);
  }, [flush, onClose]);

  const switchPerson = async (id: string) => {
    await flush();
    setSaveState('clean');
    setUserId(id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => () => { if (pendingRef.current) void flush(); }, [flush]);

  const move = (i: number, delta: number) => {
    if (!items) return;
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    applyOrder(next);
  };

  const toTop = (i: number) => {
    if (!items || i === 0) return;
    applyOrder([items[i], ...items.filter((_, k) => k !== i)]);
  };

  const dropOn = (targetId: string) => {
    if (!items || !dragId || dragId === targetId) return;
    const dragged = items.find(i => i.id === dragId);
    if (!dragged) return;
    const next = items.filter(i => i.id !== dragId);
    const at = next.findIndex(i => i.id === targetId);
    next.splice(at < 0 ? next.length : at, 0, dragged);
    applyOrder(next);
    setDragId(null);
  };

  const today = new Date().toISOString().slice(0, 10);
  const iconBtn: React.CSSProperties = {
    padding: '2px 7px', borderRadius: '6px', fontSize: '11px', fontWeight: 800, cursor: 'pointer',
    background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
    lineHeight: 1.6,
  };
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
        background: 'var(--card)', borderRadius: '14px', maxWidth: '640px', width: '100%',
        border: '1px solid var(--border)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)', margin: 'auto 0',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>People&apos;s Lists</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              Put each person&apos;s assigned {noun} in the order they should work them. They see it as My List.
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

        <div style={{ padding: '12px 18px 0' }}>
          <select
            value={userId || ''}
            onChange={e => void switchPerson(e.target.value)}
            disabled={!people || people.length === 0}
            style={{
              width: '100%', padding: '8px 10px', borderRadius: '8px', fontSize: '16px',
              border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-body)',
            }}
          >
            {!people && <option value="">Loading people…</option>}
            {people && people.length === 0 && <option value="">Nobody has {noun} assigned</option>}
            {people?.map(p => <option key={p.id} value={p.id}>{p.name} ({p.count})</option>)}
          </select>
        </div>

        {(loadError || saveError) && (
          <div style={{ margin: '12px 18px 0', padding: '8px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}>
            {saveError ? `${saveError}. Your last change is not saved; try moving it again.` : loadError}
          </div>
        )}

        <div style={{ padding: '14px 18px' }}>
          {userId && !items && !loadError && (
            <div style={{ padding: '18px 0', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>
          )}
          {items && items.length === 0 && (
            <div style={{ padding: '18px 0', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
              No active {noun} are assigned to this person.
            </div>
          )}
          {items && items.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              {items.map((item, i) => (
                <div
                  key={item.id}
                  draggable
                  onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDragId(item.id); }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); dropOn(item.id); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '7px 9px', borderRadius: '9px', background: 'var(--bg)',
                    border: `1px solid ${dragId === item.id ? '#60a5fa' : 'var(--border)'}`,
                    opacity: dragId === item.id ? 0.5 : 1,
                  }}
                >
                  <span title="Drag to reorder" style={{ cursor: 'grab', color: 'var(--text-label)', fontSize: '12px' }}>⋮⋮</span>
                  <span style={{
                    minWidth: '26px', textAlign: 'center', fontSize: '12px', fontWeight: 800,
                    color: i === 0 ? '#22c55e' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums',
                  }}>#{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12.5px', fontWeight: 800, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.title}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px', fontSize: '10px', color: 'var(--text-muted)' }}>
                      <span style={{ fontWeight: 700 }}>{item.statusLabel}</span>
                      {item.due && (
                        <span style={{ fontWeight: 700, color: item.due < today ? '#ef4444' : undefined }}>
                          {item.due < today ? '⚠ ' : ''}{type === 'graphics' ? 'due' : 'promised'} {displayDate(item.due)}
                        </span>
                      )}
                      {item.subtitle && <span>{item.subtitle}</span>}
                      {!item.ranked && <span style={{ fontStyle: 'italic' }}>not set</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                    <button onClick={() => toTop(i)} disabled={i === 0} title="Make this next" style={{ ...iconBtn, opacity: i === 0 ? 0.35 : 1 }}>⤒</button>
                    <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up" style={{ ...iconBtn, opacity: i === 0 ? 0.35 : 1 }}>▲</button>
                    <button onClick={() => move(i, 1)} disabled={i === items.length - 1} title="Move down" style={{ ...iconBtn, opacity: i === items.length - 1 ? 0.35 : 1 }}>▼</button>
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
