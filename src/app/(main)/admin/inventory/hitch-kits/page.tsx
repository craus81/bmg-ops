'use client';

/**
 * Hitch Kits: the settings behind the estimate's trailer hitch kit builder
 * (migration 433, Craig 2026-10-25). There are no kits to set up — the
 * builder puts each one together on the estimate — so this page holds what
 * it builds from: the labor hours per step, the brake controllers offered
 * (good / better / best / Bluetooth), the 7/4-way adapters, and the Curt
 * fitment by vehicle and year.
 *
 * Also lists the parts that aren't NetSuite items yet: an estimate prices
 * them at Curt's list price until they are created.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { useAuth, useRequireFeature } from '@/components/AuthProvider';
import { partNumberIncludes } from '@/lib/loose-search';
import {
  BRAKE_TIER_LABEL, loadHitchData, matchHitchCatalog,
  type CatalogPart, type HitchData, type HitchPart, type HitchSettings,
} from '@/lib/hitch-kits';

const money = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const ROLE_LABEL: Record<string, string> = {
  hitch: 'Hitch', wiring: '4-way harness', brake_harness: 'Brake harness',
};
const LABOR_ROWS: { key: keyof HitchSettings; label: string }[] = [
  { key: 'labor_hitch', label: 'Hitch' },
  { key: 'labor_wiring', label: '4-way wiring' },
  { key: 'labor_adapter', label: '7/4-way adapter' },
  { key: 'labor_brake', label: 'Brake controller' },
];

export default function HitchKitsPage() {
  useRequireFeature('parts_catalog');
  const { canSeeMoney, hasFeature, isAdmin } = useAuth();
  const showPrice = canSeeMoney || hasFeature('parts_ordering');
  const canEdit = isAdmin || hasFeature('parts_ordering');
  const supabase = createClient();
  const [data, setData] = useState<HitchData | null>(null);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [catalog, setCatalog] = useState<Map<string, CatalogPart>>(new Map());
  const [labor, setLabor] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        loadHitchData(supabase),
        supabase.from('vehicle_platforms').select('key, label'),
      ]);
      setData(d);
      setLabels(new Map(((p.data || []) as { key: string; label: string }[]).map(x => [x.key, x.label])));
      setLabor(Object.fromEntries(LABOR_ROWS.map(r => [r.key, String(d.settings[r.key])])));
      setCatalog(await matchHitchCatalog(supabase, d.parts.map(x => x.sku)));
    } catch (e: any) {
      setError(e?.message || 'Could not load the hitch kit settings');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveLabor = async () => {
    setError(''); setSaved('');
    const row: Record<string, number> = {};
    for (const r of LABOR_ROWS) {
      const v = Number(labor[r.key]);
      if (!(v >= 0) || labor[r.key] === '') { setError(`${r.label} labor must be a number of hours (0 or more).`); return; }
      row[r.key] = v;
    }
    const { error: e } = await supabase.from('hitch_settings').upsert({ id: 1, ...row, updated_at: new Date().toISOString() });
    if (e) { setError(`Could not save the labor hours: ${e.message}`); return; }
    setSaved('Labor hours saved.');
    load();
  };

  const setActive = async (p: HitchPart, active: boolean) => {
    setError('');
    const { error: e } = await supabase.from('hitch_parts').update({ active, updated_at: new Date().toISOString() }).eq('sku', p.sku);
    if (e) { setError(`Could not update ${p.sku}: ${e.message}`); return; }
    setData(d => d && { ...d, parts: d.parts.map(x => x.sku === p.sku ? { ...x, active } : x) });
  };

  const bySku = useMemo(() => new Map((data?.parts || []).map(p => [p.sku, p])), [data]);
  const fitRows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.fitment
      .map(f => ({ f, part: bySku.get(f.sku), label: labels.get(f.platform_key) || f.platform_key }))
      .filter(r => r.part && r.part.role !== 'factory_adapter')
      .filter(r => !q || r.label.toLowerCase().includes(q) || partNumberIncludes(r.f.sku, q) || r.part!.name.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label) || String(a.part!.role).localeCompare(String(b.part!.role)) || a.f.year_start - b.f.year_start);
  }, [data, bySku, labels, search]);
  const notInNetSuite = (data?.parts || []).filter(p => p.active && !catalog.has(p.sku));

  const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' };
  const h2: React.CSSProperties = { fontSize: '14px', fontWeight: 800, margin: 0 };
  const cell: React.CSSProperties = { padding: '5px 6px', borderBottom: '1px solid var(--border)', fontSize: '12px', verticalAlign: 'top' };
  const th: React.CSSProperties = { ...cell, fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', textAlign: 'left' };
  const thumb = (p: HitchPart) => p.image_url
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={p.image_url} alt={p.sku} loading="lazy" style={{ width: '48px', height: '36px', objectFit: 'contain', background: '#fff', borderRadius: '4px' }} />
    : null;

  return (
    <div style={{ padding: '16px', maxWidth: '1020px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Hitch Kits</h1>
          <Link href="/admin/inventory/rack-kits" style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa' }}>Rack Kits</Link>
          <Link href="/admin/inventory" style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa' }}>← Inventory</Link>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          Hitch kits are built on the estimate with the Hitch Kit button. This page sets what the builder offers. Parts and fitment are from CURT.
        </div>
      </div>

      {error && <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(248,113,113,0.1)', color: '#f87171', fontSize: '12px', fontWeight: 700 }}>{error}</div>}
      {!data && !error && <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Loading…</div>}

      {data && (
        <>
          {notInNetSuite.length > 0 && (
            <details style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '10px', padding: '8px 12px' }}>
              <summary style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 700, color: '#f59e0b' }}>
                {notInNetSuite.length} part{notInNetSuite.length !== 1 ? 's' : ''} not in NetSuite yet. Estimates price {notInNetSuite.length !== 1 ? 'them' : 'it'} at Curt list until {notInNetSuite.length !== 1 ? 'they are' : 'it is'} created (as {'"'}13193{'"'} or {'"'}C13193{'"'}).
              </summary>
              <div style={{ marginTop: '8px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '4px 16px' }}>
                {notInNetSuite.map(p => (
                  <div key={p.sku} style={{ fontSize: '11px', display: 'flex', gap: '6px' }}>
                    <span style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{p.sku}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{p.name}{showPrice ? ` · ${money(p.list_price)}` : ''}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' }}>
            <div style={card}>
              <h2 style={h2}>Labor hours</h2>
              {LABOR_ROWS.map(r => (
                <label key={r.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                  <span style={{ flex: 1 }}>{r.label}</span>
                  <input
                    type="number" min="0" step="0.25" inputMode="decimal" disabled={!canEdit}
                    aria-label={`${r.label} labor hours`}
                    value={labor[r.key] ?? ''}
                    onChange={e => { setSaved(''); setLabor(l => ({ ...l, [r.key]: e.target.value })); }}
                    style={{ width: '80px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '12px', textAlign: 'right' }}
                  />
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>hr</span>
                </label>
              ))}
              {canEdit && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <button type="button" onClick={saveLabor} style={{ padding: '7px 14px', borderRadius: '8px', border: 'none', background: 'var(--accent, #2563eb)', color: '#fff', fontSize: '12px', fontWeight: 800, cursor: 'pointer' }}>Save labor hours</button>
                  {saved && <span style={{ fontSize: '11px', color: '#22c55e', fontWeight: 700 }}>{saved}</span>}
                </div>
              )}
            </div>

            <div style={card}>
              <h2 style={h2}>7/4-way adapters</h2>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>The cheapest Curt adapters with a mounting bracket. The builder picks the one that fits the harness.</div>
              {data.parts.filter(p => p.role === 'adapter' || p.role === 'factory_adapter').map(p => (
                <div key={p.sku} style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px' }}>
                  {thumb(p)}
                  <span style={{ flex: 1 }}><b>{p.sku}</b> {p.name}</span>
                  {showPrice && <span>{money(p.list_price)}</span>}
                </div>
              ))}
            </div>
          </div>

          <div style={card}>
            <h2 style={h2}>Brake controllers offered</h2>
            {data.parts.filter(p => p.role === 'brake_controller').map(p => (
              <div key={p.sku} style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', opacity: p.active ? 1 : 0.55 }}>
                {thumb(p)}
                {p.tier && <span style={{ fontSize: '10px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px', background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>{BRAKE_TIER_LABEL[p.tier]}</span>}
                <span style={{ flex: 1 }}><b>{p.sku}</b> {p.name}</span>
                {showPrice && <span>{money(catalog.get(p.sku)?.sales_price ?? p.list_price)}</span>}
                {canEdit && (
                  <label style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '11px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={p.active} onChange={e => setActive(p, e.target.checked)} /> Offered
                  </label>
                )}
              </div>
            ))}
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <h2 style={h2}>Fitment</h2>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{fitRows.length} rows</span>
              <span style={{ flex: 1 }} />
              <input
                type="search" aria-label="Search fitment" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search vehicle or part number"
                style={{ width: '240px', maxWidth: '100%', padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '12px' }}
              />
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={th}>Vehicle</th><th style={th}>Years</th><th style={th}>Part</th><th style={th}></th><th style={th}>Description</th>{showPrice && <th style={{ ...th, textAlign: 'right' }}>Price</th>}</tr></thead>
                <tbody>
                  {fitRows.map(({ f, part, label }) => (
                    <tr key={`${f.platform_key}-${f.sku}`}>
                      <td style={cell}>{label}</td>
                      <td style={{ ...cell, whiteSpace: 'nowrap' }}>{f.year_start === f.year_end ? f.year_start : `${f.year_start}–${f.year_end}`}</td>
                      <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                        <b>{f.sku}</b>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{part!.needs_factory_wiring ? 'Factory plug' : ROLE_LABEL[part!.role] || part!.role}{part!.hitch_class ? ` · Class ${part!.hitch_class}` : ''}</div>
                      </td>
                      <td style={cell}>{thumb(part!)}</td>
                      <td style={cell}>
                        {part!.name}
                        {!catalog.has(f.sku) && <div style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 700 }}>Not in NetSuite yet</div>}
                      </td>
                      {showPrice && <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(catalog.get(f.sku)?.sales_price ?? part!.list_price)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
