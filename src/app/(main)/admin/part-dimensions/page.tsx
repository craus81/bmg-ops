'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { BrowsePart } from '@/components/PartCatalogBrowser';

// Dimension authoring queue for the 3D upfit designer (migration 213).
// A part enters the 3D scene only once someone records its installed W×D×H —
// this page is where that happens at volume: filter to a category or vendor,
// type the three numbers off the spec sheet, save, next. The vendor-site
// import and scripts/extract-part-dimensions.mjs pre-fill what they can
// (dims_source vendor_site / pdf_vision); anything typed here is stamped
// 'manual' and never overwritten by either.

interface Category { id: string; name: string }

const card: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--border)',
  borderRadius: '12px', padding: '14px',
};
const label: React.CSSProperties = {
  fontSize: '10px', fontWeight: 800, textTransform: 'uppercase',
  letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '4px',
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 8px', borderRadius: '8px',
  border: '1px solid var(--border)', background: 'var(--input-bg)',
  color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'inherit',
};
const numInput: React.CSSProperties = { ...input, width: '64px', textAlign: 'right', padding: '6px 6px' };

const MOUNT_TYPES = [
  { key: '', label: '—' },
  { key: 'floor', label: 'Floor' },
  { key: 'wall', label: 'Wall' },
  { key: 'door', label: 'Door' },
  { key: 'partition', label: 'Partition' },
  { key: 'ceiling', label: 'Ceiling' },
  { key: 'accessory', label: 'Accessory' },
];

interface RowDraft { w: string; d: string; h: string; wt: string; mount: string }

const draftFor = (p: BrowsePart): RowDraft => ({
  w: p.width_in != null ? String(p.width_in) : '',
  d: p.depth_in != null ? String(p.depth_in) : '',
  h: p.height_in != null ? String(p.height_in) : '',
  wt: p.weight_lb != null ? String(p.weight_lb) : '',
  mount: p.mount_type || '',
});

export default function PartDimensionsPage() {
  const router = useRouter();
  const { isAdmin, user, loading: authLoading } = useAuth();

  const [parts, setParts] = useState<BrowsePart[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dimsFilter, setDimsFilter] = useState<'missing' | 'present' | ''>('missing');
  const [categoryId, setCategoryId] = useState('');
  const [vendor, setVendor] = useState('');
  const [q, setQ] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [savedRow, setSavedRow] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<{ total: number; withDims: number } | null>(null);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [qLive, setQLive] = useState('');

  useEffect(() => {
    if (authLoading || !user) return;
    if (!isAdmin) router.push('/home');
  }, [authLoading, user, isAdmin, router]);

  // Debounce the search box so each keystroke doesn't hit the API.
  useEffect(() => {
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => { setQ(qLive); setPage(0); }, 350);
    return () => { if (qTimer.current) clearTimeout(qTimer.current); };
  }, [qLive]);

  const load = useCallback(async (pageNum: number, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dimsFilter) params.set('dims', dimsFilter);
      if (categoryId) params.set('categoryId', categoryId);
      if (vendor) params.set('vendor', vendor);
      if (q) params.set('q', q);
      params.set('catalog', 'upfit');
      if (pageNum) params.set('page', String(pageNum));
      const res = await fetch(`/api/parts/browse?${params.toString()}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      const rows: BrowsePart[] = d.parts || [];
      setParts(prev => (append ? [...prev, ...rows] : rows));
      setTotal(d.total ?? 0);
      setDrafts(prev => {
        const next = append ? { ...prev } : {};
        for (const p of rows) next[p.id] = draftFor(p);
        return next;
      });
      if (d.categories) setCategories(d.categories);
      if (d.vendors) setVendors(d.vendors);
    } catch (err: any) {
      setError(err.message || 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [dimsFilter, categoryId, vendor, q]);

  useEffect(() => {
    if (authLoading || !user || !isAdmin) return;
    setPage(0);
    load(0, false);
  }, [authLoading, user, isAdmin, load]);

  // Coverage stat: how much of the upfit catalog is 3D-placeable. Two exact
  // head-counts, refreshed after each save (savedRow flips).
  useEffect(() => {
    if (authLoading || !user || !isAdmin) return;
    (async () => {
      const { createClient } = await import('@/lib/supabase-browser');
      const supabase = createClient();
      const base = () => supabase.from('netsuite_parts').select('id', { count: 'exact', head: true }).eq('is_active', true).eq('catalog', 'upfit');
      const [{ count: total }, { count: withDims }] = await Promise.all([
        base(),
        base().not('width_in', 'is', null),
      ]);
      setCoverage({ total: total || 0, withDims: withDims || 0 });
    })();
  }, [authLoading, user, isAdmin, savedRow]);

  const saveRow = async (p: BrowsePart) => {
    const d = drafts[p.id];
    if (!d) return;
    const nums = [d.w, d.d, d.h].map(v => v.trim());
    const allBlank = nums.every(v => !v);
    const allFilled = nums.every(v => v && Number.isFinite(parseFloat(v)));
    if (!allBlank && !allFilled) {
      setError('Width, depth, and height must be entered together (or all left blank to clear).');
      return;
    }
    setBusyRow(p.id);
    setError(null);
    try {
      const res = await fetch('/api/parts/dimensions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partId: p.id,
          widthIn: allBlank ? null : parseFloat(d.w),
          depthIn: allBlank ? null : parseFloat(d.d),
          heightIn: allBlank ? null : parseFloat(d.h),
          weightLb: d.wt.trim() ? parseFloat(d.wt) : null,
          mountType: d.mount || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setParts(prev => prev.map(x => x.id === p.id ? {
        ...x,
        width_in: allBlank ? null : parseFloat(d.w),
        depth_in: allBlank ? null : parseFloat(d.d),
        height_in: allBlank ? null : parseFloat(d.h),
        weight_lb: d.wt.trim() ? parseFloat(d.wt) : null,
        mount_type: d.mount || null,
        dims_source: allBlank ? null : 'manual',
      } : x));
      setSavedRow(p.id);
      setTimeout(() => setSavedRow(s => (s === p.id ? null : s)), 1500);
    } catch (err: any) {
      setError(err.message || 'Save failed');
    } finally {
      setBusyRow(null);
    }
  };

  const setDraft = (id: string, patch: Partial<RowDraft>) =>
    setDrafts(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  if (authLoading || !user || !isAdmin) return null;

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
    background: active ? 'rgba(37,99,235,0.12)' : 'var(--card)',
    color: active ? 'var(--accent, #2563eb)' : 'var(--text-secondary)',
  });

  return (
    <div style={{ padding: '16px 0 40px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, margin: '0 0 4px' }}>Part Dimensions</h1>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
        Installed W×D×H per part, for the 3D Upfit Designer. A part without dimensions can still be quoted,
        but can&apos;t be placed in the 3D scene. Values typed here are marked <b>manual</b> and are never
        overwritten by the vendor-site import.
      </p>

      {error && (
        <div style={{ ...card, borderColor: 'rgba(239,68,68,0.4)', color: '#ef4444', fontSize: '12px', marginBottom: '12px' }}>{error}</div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
        <button style={chip(dimsFilter === 'missing')} onClick={() => { setDimsFilter('missing'); setPage(0); }}>Missing dims</button>
        <button style={chip(dimsFilter === 'present')} onClick={() => { setDimsFilter('present'); setPage(0); }}>Has dims</button>
        <button style={chip(dimsFilter === '')} onClick={() => { setDimsFilter(''); setPage(0); }}>All</button>
        <span style={{ flex: 1 }} />
        <select value={categoryId} onChange={e => { setCategoryId(e.target.value); setPage(0); }} style={{ ...input, width: '180px' }}>
          <option value="">All categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={vendor} onChange={e => { setVendor(e.target.value); setPage(0); }} style={{ ...input, width: '180px' }}>
          <option value="">All vendors</option>
          {vendors.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <input
          value={qLive}
          onChange={e => setQLive(e.target.value)}
          placeholder="Search part number / name…"
          style={{ ...input, width: '220px' }}
        />
      </div>

      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
        <span>{total.toLocaleString()} part{total === 1 ? '' : 's'} in this view</span>
        {coverage && coverage.total > 0 && (
          <span>
            Upfit catalog coverage: <b style={{ color: 'var(--text-primary)' }}>{coverage.withDims.toLocaleString()} / {coverage.total.toLocaleString()}</b>
            {' '}placeable in 3D ({Math.round((coverage.withDims / coverage.total) * 100)}%)
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {parts.map(p => {
          const d = drafts[p.id] || draftFor(p);
          return (
            <div key={p.id} style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', padding: '10px 14px' }}>
              <div style={{ minWidth: '220px', flex: '1 1 220px' }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{p.display_name || p.item_number}</div>
                <div style={{ fontSize: '10px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                  {p.item_number}{p.vendor ? ` · ${p.vendor}` : ''}
                  {p.dims_source ? ` · dims: ${p.dims_source === 'vendor_site' ? 'vendor site' : p.dims_source === 'pdf_vision' ? 'PDF extract' : 'manual'}` : ''}
                </div>
              </div>
              <div>
                <div style={label}>W (in)</div>
                <input inputMode="decimal" value={d.w} onChange={e => setDraft(p.id, { w: e.target.value })} style={numInput} />
              </div>
              <div>
                <div style={label}>D (in)</div>
                <input inputMode="decimal" value={d.d} onChange={e => setDraft(p.id, { d: e.target.value })} style={numInput} />
              </div>
              <div>
                <div style={label}>H (in)</div>
                <input inputMode="decimal" value={d.h} onChange={e => setDraft(p.id, { h: e.target.value })} style={numInput} />
              </div>
              <div>
                <div style={label}>Wt (lb)</div>
                <input inputMode="decimal" value={d.wt} onChange={e => setDraft(p.id, { wt: e.target.value })} style={numInput} />
              </div>
              <div>
                <div style={label}>Mount</div>
                <select value={d.mount} onChange={e => setDraft(p.id, { mount: e.target.value })} style={{ ...input, width: '110px', padding: '6px' }}>
                  {MOUNT_TYPES.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </div>
              <button
                onClick={() => saveRow(p)}
                disabled={busyRow === p.id}
                style={{
                  padding: '7px 16px', borderRadius: '8px', border: 'none', fontSize: '12px', fontWeight: 800,
                  cursor: busyRow === p.id ? 'default' : 'pointer',
                  background: savedRow === p.id ? 'rgba(34,197,94,0.15)' : 'var(--accent, #2563eb)',
                  color: savedRow === p.id ? '#22c55e' : '#fff',
                }}
              >
                {busyRow === p.id ? 'Saving…' : savedRow === p.id ? '✓ Saved' : 'Save'}
              </button>
            </div>
          );
        })}
      </div>

      {!loading && parts.length === 0 && (
        <div style={{ ...card, textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          Nothing here — every part in this view {dimsFilter === 'missing' ? 'already has dimensions' : 'matches no filter'}.
        </div>
      )}
      {loading && <div style={{ padding: '18px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>Loading…</div>}

      {parts.length < total && !loading && (
        <div style={{ textAlign: 'center', marginTop: '14px' }}>
          <button
            onClick={() => { const next = page + 1; setPage(next); load(next, true); }}
            style={{ padding: '8px 18px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
          >
            Load more ({parts.length} of {total.toLocaleString()})
          </button>
        </div>
      )}
    </div>
  );
}
