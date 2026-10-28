'use client';

import { useState, type CSSProperties } from 'react';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';
import { BUYERS_PHOTO_DIR, type CatalogPhotoMatch } from '@/lib/buyers-catalog-photos';

/**
 * "Buyers catalog photos" card on Import Vendor Assets (Craig 2026-10-27):
 * find every part the Buyers Products 2024 printed catalog has a photo for,
 * review the list, and add the ticked photos. Parts that already have a
 * photo are counted but never changed. Close part-number matches
 * (BP-1702700 ↔ 1702700) start unticked.
 */

const BATCH = 25;

export default function BuyersCatalogPhotos() {
  const dialog = useDialog();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [matches, setMatches] = useState<CatalogPhotoMatch[] | null>(null);
  const [stats, setStats] = useState<{ catalogNumbers: number; partsSearched: number } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [failures, setFailures] = useState<{ itemNumber: string; error: string }[]>([]);

  const post = async (body: unknown) => {
    const res = await fetch('/api/parts/import-catalog-photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d) throw new Error(d?.error || `HTTP ${res.status}`);
    return d;
  };

  const findMatches = async () => {
    setLoading(true); setError(''); setSavedCount(null); setFailures([]);
    try {
      const d = await post({ mode: 'match' });
      const list: CatalogPhotoMatch[] = d.matches || [];
      setMatches(list);
      setStats({ catalogNumbers: d.catalogNumbers, partsSearched: d.partsSearched });
      setPicked(new Set(list.filter(m => !m.hasPhoto && !m.closeNumber).map(m => m.partId)));
    } catch (e: any) {
      setError(e?.message || 'Could not load matches');
    }
    setLoading(false);
  };

  const ready = (matches || []).filter(m => !m.hasPhoto);
  const alreadyCount = (matches || []).length - ready.length;
  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const save = async () => {
    const list = ready.filter(m => picked.has(m.partId));
    if (list.length === 0) return;
    const ok = await dialog.confirm(
      `Add ${list.length} Buyers catalog photo${list.length !== 1 ? 's' : ''} to the parts catalog? Parts that already have a photo are left alone.`,
      { confirmLabel: `Add ${list.length} photo${list.length !== 1 ? 's' : ''}` },
    );
    if (!ok) return;
    setError(''); setFailures([]);
    let saved = 0;
    const failed: { itemNumber: string; error: string }[] = [];
    const doneIds = new Set<string>();
    setSaving({ done: 0, total: list.length });
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      try {
        const d = await post({ mode: 'save', items: chunk.map(m => ({ partId: m.partId, catalogNumber: m.catalogNumber })) });
        saved += d.saved || 0;
        for (const r of d.results || []) {
          const m = chunk.find(c => c.partId === r.partId);
          if (r.ok) doneIds.add(r.partId);
          else failed.push({ itemNumber: m?.itemNumber || r.partId, error: r.error || 'Failed' });
        }
      } catch (e: any) {
        for (const m of chunk) failed.push({ itemNumber: m.itemNumber, error: e?.message || 'Request failed' });
      }
      setSaving({ done: Math.min(i + BATCH, list.length), total: list.length });
      setFailures([...failed]);
    }
    setSaving(null);
    setSavedCount(saved);
    setMatches(prev => (prev || []).map(m => (doneIds.has(m.partId) ? { ...m, hasPhoto: true } : m)));
    setPicked(prev => new Set([...prev].filter(id => !doneIds.has(id))));
  };

  const card: CSSProperties = { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 16, marginBottom: 16 };
  const btn: CSSProperties = { background: theme.accent, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
  const plainBtn: CSSProperties = { background: 'none', border: `1px solid ${theme.border}`, color: theme.textPrimary, borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
  const chip = (bg: string, fg: string, border: string): CSSProperties => ({ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, border: `1px solid ${border}`, whiteSpace: 'nowrap' });
  const pickedCount = ready.filter(m => picked.has(m.partId)).length;

  return (
    <div style={card}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Buyers catalog photos</div>
      <div style={{ fontSize: 13, color: theme.textSecondary, marginBottom: 12 }}>
        Photos cut from the Buyers Products 2024 catalog, matched to our parts by part number.
      </div>

      {!matches && (
        <button onClick={findMatches} disabled={loading} style={{ ...btn, opacity: loading ? 0.6 : 1 }}>
          {loading ? 'Finding matches…' : 'Find Buyers parts'}
        </button>
      )}
      {error && <div style={{ color: theme.error, fontSize: 13, marginTop: 8 }}>{error}</div>}

      {matches && (
        <>
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            <strong>{ready.length.toLocaleString()}</strong> part{ready.length !== 1 ? 's' : ''} can get a photo
            {alreadyCount > 0 && <span style={{ color: theme.textMuted }}> · {alreadyCount.toLocaleString()} already have one (left alone)</span>}
            {stats && <span style={{ color: theme.textMuted }}> · {stats.catalogNumbers.toLocaleString()} catalog numbers checked against {stats.partsSearched.toLocaleString()} active parts</span>}
          </div>

          {savedCount !== null && (
            <div style={{ color: theme.success, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
              Added {savedCount} photo{savedCount !== 1 ? 's' : ''}.
            </div>
          )}
          {failures.length > 0 && (
            <div style={{ color: theme.error, fontSize: 13, marginBottom: 10 }}>
              {failures.length} not added:
              {failures.slice(0, 20).map(f => <div key={f.itemNumber}>{f.itemNumber}: {f.error}</div>)}
              {failures.length > 20 && <div>…and {failures.length - 20} more</div>}
            </div>
          )}

          {ready.length === 0 ? (
            <div style={{ fontSize: 13, color: theme.textMuted }}>Nothing left to add.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                <button onClick={() => setPicked(new Set(ready.map(m => m.partId)))} style={plainBtn}>Tick all</button>
                <button onClick={() => setPicked(new Set())} style={plainBtn}>Untick all</button>
                <span style={{ flex: 1 }} />
                <button onClick={save} disabled={!!saving || pickedCount === 0} style={{ ...btn, opacity: saving || pickedCount === 0 ? 0.6 : 1 }}>
                  {saving ? `Adding… ${saving.done}/${saving.total}` : `Add ${pickedCount} photo${pickedCount !== 1 ? 's' : ''}`}
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 'calc(60vh / var(--ts))', overflowY: 'auto' }}>
                {ready.map(m => (
                  <label key={m.partId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 6, borderRadius: 8, border: `1px solid ${picked.has(m.partId) ? theme.orange : theme.border}`, cursor: 'pointer' }}>
                    <input type="checkbox" checked={picked.has(m.partId)} onChange={() => toggle(m.partId)} />
                    {/* eslint-disable-next-line @next/next/no-img-element -- static catalog photo */}
                    <img src={`${BUYERS_PHOTO_DIR}/${m.photo}.jpg`} alt="" loading="lazy" style={{ width: 64, height: 48, objectFit: 'contain', background: '#fff', borderRadius: 4, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{m.itemNumber}</div>
                      <div style={{ fontSize: 11, color: theme.textMuted }}>
                        Catalog page {m.page}{m.catalogNumber !== m.itemNumber ? ` · catalog no. ${m.catalogNumber}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {m.closeNumber && <span style={chip(theme.warningBg, theme.warning, theme.warningBorder)}>Close number</span>}
                      {m.exactPhoto
                        ? <span style={chip(theme.successBg, theme.success, theme.successBorder)}>Exact photo</span>
                        : <span style={chip(theme.subtleBg, theme.textSecondary, theme.border)}>Same product line</span>}
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
