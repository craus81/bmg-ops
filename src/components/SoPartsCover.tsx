'use client';

/**
 * "Parts ordered" on sales orders (Craig, 2026-11-06, thread "Mark sales
 * orders parts ordered"). The badge on a Sales orders list row (tap a gray
 * "5 of 7 ready" to see what's missing), and the Parts card on the sales
 * order page with the admin's "Mark parts ordered". Rules live in
 * src/lib/so-parts-cover.ts.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { coverLabel, partCoverText, type SoPartsCover } from '@/lib/so-parts-cover';

const GREEN = '#16a34a';

const fmtDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
};

function MissingList({ cover }: { cover: SoPartsCover }) {
  return (
    <div style={{ display: 'grid', gap: '3px', fontSize: '13px' }}>
      {cover.parts.map(p => (
        <div key={p.item_number} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: theme.textPrimary }}>
            {p.item_number}{p.needed > 1 ? ` ×${p.needed}` : ''}{p.description ? ` · ${p.description}` : ''}
          </span>
          <span style={{ flexShrink: 0, fontWeight: 700, color: p.state === 'missing' ? theme.warning : theme.success }}>{partCoverText(p)}</span>
        </div>
      ))}
    </div>
  );
}

/** Pill for a list row. Gray ones open the parts list under the row. */
export function PartsBadge({ cover, open, onToggle }: { cover: SoPartsCover; open: boolean; onToggle: () => void }) {
  if (cover.allReady) {
    return (
      <span style={{ padding: '1px 8px', borderRadius: '99px', background: GREEN, color: '#fff', fontWeight: 700 }}>
        ✓ Parts ordered{cover.marked?.byName ? ` · marked by ${cover.marked.byName.split(' ')[0]}` : ''}
      </span>
    );
  }
  return (
    <span
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={e => { e.stopPropagation(); onToggle(); }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggle(); } }}
      style={{ padding: '1px 8px', borderRadius: '99px', background: theme.subtleBg, color: theme.textSecondary, fontWeight: 700, cursor: 'pointer' }}
    >{coverLabel(cover)} {open ? '▴' : '▾'}</span>
  );
}

export function PartsRowDetail({ cover }: { cover: SoPartsCover }) {
  return (
    <div style={{ borderTop: `1px dashed ${theme.border}`, paddingTop: '6px', marginTop: '2px' }}>
      <MissingList cover={cover} />
    </div>
  );
}

/** Parts card on the sales order page. */
export function SoPartsCard({ netsuiteId }: { netsuiteId: string }) {
  const [cover, setCover] = useState<SoPartsCover | null | undefined>(undefined);
  const [canMark, setCanMark] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    apiFetch(`/api/sales-orders/${netsuiteId}/parts`)
      .then(async res => {
        const body = await res.json().catch(() => ({}));
        if (stale) return;
        if (!res.ok) throw new Error(body.error || `Couldn't check the parts (${res.status}).`);
        setCover(body.cover || null);
        setCanMark(!!body.canMark);
      })
      .catch(e => { if (!stale) { setError(e?.message || "Couldn't check the parts."); setCover(null); } });
    return () => { stale = true; };
  }, [netsuiteId]);

  const mark = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sales-orders/${netsuiteId}/parts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mark: on }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't save (${res.status}).`);
      setCover(body.cover || null);
    } catch (e: any) {
      setError(e?.message || "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  if (cover === undefined && !error) return null;
  if (!cover) return error ? <div style={{ color: theme.error, fontWeight: 700, fontSize: '14px' }}>{error}</div> : null;

  const green = cover.allReady;
  return (
    <div style={{
      background: green ? theme.successBg : theme.card, border: `1px solid ${green ? theme.successBorder : theme.border}`,
      borderRadius: '10px', padding: '12px', display: 'grid', gap: '8px',
    }}>
      <div style={{ fontWeight: 800, color: green ? theme.success : theme.textPrimary }}>
        {green ? '✓ Parts ordered' : `Parts · ${cover.ready} of ${cover.total} ready`}
      </div>
      {cover.marked && (
        <div style={{ fontSize: '13px', color: theme.textMuted }}>
          Marked by hand{cover.marked.byName ? ` by ${cover.marked.byName}` : ''} {fmtDay(cover.marked.at)}
        </div>
      )}
      <MissingList cover={cover} />
      <div style={{ fontSize: '12px', color: theme.textMuted }}>
        In stock means on the shelf and not held for another order. Older orders get the shelf first.
      </div>
      {error && <div style={{ color: theme.error, fontWeight: 700, fontSize: '14px' }}>{error}</div>}
      {canMark && (cover.marked || !green) && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {!cover.marked && (
            <button disabled={busy} onClick={() => mark(true)} style={{
              padding: '9px 14px', borderRadius: '8px', border: 'none', background: GREEN, color: '#fff',
              fontSize: '14px', fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1,
            }}>✓ Mark parts ordered</button>
          )}
          {cover.marked && (
            <button disabled={busy} onClick={() => mark(false)} style={{
              padding: '9px 14px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'transparent',
              color: theme.textSecondary, fontSize: '14px', fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1,
            }}>Undo mark</button>
          )}
        </div>
      )}
    </div>
  );
}
