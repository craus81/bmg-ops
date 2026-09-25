'use client';

/**
 * My List — the signed-in person's own assigned jobs, in the order a manager
 * set for them (migration 326, /api/work-lists). Renders nothing when the
 * person has nothing assigned, so boards can drop it in unconditionally.
 *
 * `reloadKey` lets the host board refetch after something that can change the
 * list (a manager saving People's Lists, a status change).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api-client';
import type { WorkListItem, WorkListType } from '@/lib/personal-work-list';

const PREVIEW = 5;

const displayDate = (d: string | null) => {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return y && m && day ? new Date(y, m - 1, day).toLocaleDateString() : '';
};

export default function MyWorkList({ type, reloadKey = 0 }: { type: WorkListType; reloadKey?: number }) {
  const [items, setItems] = useState<WorkListItem[] | null>(null);
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/work-lists?type=${type}`);
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setItems(body.items || []);
      } catch { /* the board still works without the list */ }
    })();
    return () => { cancelled = true; };
  }, [type, reloadKey]);

  if (!items || items.length === 0) return null;

  const today = new Date().toISOString().slice(0, 10);
  const shown = showAll ? items : items.slice(0, PREVIEW);

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', marginBottom: '12px', overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)',
        }}
      >
        <span style={{ fontSize: '13px', fontWeight: 800 }}>My List ({items.length})</span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {shown.map((item, i) => (
            <Link
              key={item.id}
              href={item.href}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 9px', borderRadius: '9px',
                background: 'var(--bg)', border: '1px solid var(--border)', textDecoration: 'none',
              }}
            >
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
                </div>
              </div>
            </Link>
          ))}
          {items.length > PREVIEW && (
            <button
              onClick={() => setShowAll(s => !s)}
              style={{ alignSelf: 'flex-start', padding: '4px 8px', fontSize: '11px', fontWeight: 700, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              {showAll ? 'Show less' : `Show all ${items.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
