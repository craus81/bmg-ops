'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { closeOnEscape } from '@/lib/modal-escape';
import {
  BRAKE_TIER_LABEL, adapterFor, hitchKitLines, hitchKitName, hitchLabor, hitchOptionsFor, loadHitchData, matchHitchCatalog,
  needsSevenWay, type CatalogPart, type HitchData, type HitchKitLine, type HitchPart,
} from '@/lib/hitch-kits';

/**
 * Trailer hitch kit builder (Craig 2026-10-25), opened from the estimate's
 * "Hitch Kit" button. Four steps: hitch, 4-way wiring harness, optional
 * 7/4-way adapter, brake controller. Every option shows its photo, specs,
 * features and fitment notes, so the right part gets ordered. The picks
 * land on the estimate as one hitch kit (src/lib/hitch-kits.ts).
 */

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const RED = '#f87171';
const WARN = '#f59e0b';

interface Platform { id: string; key: string; label: string }

export function HitchKitBuilderModal({ open, onClose, onAdd, platformId, vehicleYear, laborRate, showPrice }: {
  open: boolean;
  onClose: () => void;
  onAdd: (lines: HitchKitLine[]) => void;
  platformId: string | null;
  vehicleYear: string;
  laborRate: number;
  showPrice: boolean;
}) {
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }} ref={closeOnEscape(onClose)}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg, var(--card))', borderRadius: '16px', width: '100%', maxWidth: '860px', height: 'calc(90vh / var(--ts))', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid var(--border)', boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '16px', fontWeight: 800 }}>Build a trailer hitch kit</div>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
        </div>
        <HitchKitBuilder
          platformId={platformId}
          vehicleYear={vehicleYear}
          laborRate={laborRate}
          showPrice={showPrice}
          onAdd={lines => { onAdd(lines); onClose(); }}
        />
      </div>
    </div>
  );
}

function HitchKitBuilder({ platformId, vehicleYear, laborRate, showPrice, onAdd }: {
  platformId: string | null;
  vehicleYear: string;
  laborRate: number;
  showPrice: boolean;
  onAdd: (lines: HitchKitLine[]) => void;
}) {
  const [data, setData] = useState<HitchData | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [error, setError] = useState('');
  const [platformKey, setPlatformKey] = useState('');
  const [year, setYear] = useState<number>(() => {
    const y = parseInt(vehicleYear, 10);
    return y >= 1990 && y <= 2100 ? y : new Date().getFullYear();
  });
  const [factory, setFactory] = useState(false);
  const [hitchSku, setHitchSku] = useState('');
  const [wiringSku, setWiringSku] = useState('');
  const [withAdapter, setWithAdapter] = useState(false);
  const [brakeSku, setBrakeSku] = useState('');
  const [catalog, setCatalog] = useState<Map<string, CatalogPart>>(new Map());

  useEffect(() => {
    const supabase = createClient();
    let live = true;
    Promise.all([
      loadHitchData(supabase),
      supabase.from('vehicle_platforms').select('id, key, label, sort_order').order('sort_order'),
    ])
      .then(([d, p]) => {
        if (!live) return;
        setData(d);
        const keys = new Set(d.fitment.map(f => f.platform_key));
        const list = ((p.data || []) as Platform[]).filter(x => keys.has(x.key));
        setPlatforms(list);
        const fromEstimate = list.find(x => x.id === platformId);
        setPlatformKey(fromEstimate?.key || '');
      })
      .catch(e => { if (live) setError(e?.message || 'Could not load the hitch parts'); });
    return () => { live = false; };
  }, [platformId]);

  const options = useMemo(
    () => (data && platformKey ? hitchOptionsFor(data, platformKey, year, factory) : null),
    [data, platformKey, year, factory],
  );
  const years = useMemo(() => {
    if (!data || !platformKey) return [year];
    const fs = data.fitment.filter(f => f.platform_key === platformKey);
    const lo = Math.min(...fs.map(f => f.year_start), year);
    const hi = Math.max(...fs.map(f => f.year_end), year);
    return Array.from({ length: hi - lo + 1 }, (_, i) => hi - i);
  }, [data, platformKey, year]);

  // A pick that no longer fits (vehicle, year or factory answer changed) clears.
  useEffect(() => {
    if (!options) return;
    if (!options.hitches.some(h => h.sku === hitchSku)) setHitchSku(options.hitches[0]?.sku || '');
    if (wiringSku && !options.wiring.some(w => w.sku === wiringSku)) setWiringSku('');
  }, [options, hitchSku, wiringSku]);

  // NetSuite prices for everything on offer here.
  useEffect(() => {
    if (!options) return;
    const skus = [...options.hitches, ...options.wiring, ...options.brakeControllers, options.brakeHarness]
      .filter((p): p is HitchPart => !!p).map(p => p.sku);
    if (data) for (const p of data.parts) if (p.role === 'adapter' || p.role === 'factory_adapter') skus.push(p.sku);
    let live = true;
    matchHitchCatalog(createClient(), skus).then(m => { if (live) setCatalog(m); }).catch(() => { /* list prices stand in */ });
    return () => { live = false; };
  }, [options, data]);

  if (error) return <div style={{ margin: '16px', padding: '10px 12px', borderRadius: '8px', background: 'rgba(248,113,113,0.1)', color: RED, fontSize: '13px', fontWeight: 700 }}>{error}</div>;
  if (!data) return <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading hitch parts…</div>;

  const platform = platforms.find(p => p.key === platformKey) || null;
  const hitch = options?.hitches.find(h => h.sku === hitchSku) || null;
  const wiring = options?.wiring.find(w => w.sku === wiringSku) || null;
  const adapter = withAdapter ? adapterFor(data, wiring) : null;
  const brake = options?.brakeControllers.find(b => b.sku === brakeSku) || null;
  const choices = platform && hitch ? {
    platformLabel: platform.label, year, hitch, wiring, adapter, brakeController: brake, brakeHarness: options?.brakeHarness || null,
  } : null;
  const lines = choices ? hitchKitLines(choices, data.settings, catalog) : [];
  const partsTotal = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0);
  const labor = hitchLabor(lines);
  const missing = lines.filter(l => l.not_in_netsuite);
  const priceOf = (p: HitchPart) => {
    const ns = catalog.get(p.sku);
    return ns?.sales_price != null ? Number(ns.sales_price) : Number(p.list_price) || 0;
  };

  const label: React.CSSProperties = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '4px' };
  const sel: React.CSSProperties = { width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600 };
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
    background: on ? 'rgba(59,130,246,0.2)' : 'var(--card)',
    border: `1px solid ${on ? 'rgba(59,130,246,0.5)' : 'var(--border)'}`,
    color: on ? '#60a5fa' : 'var(--text-secondary)',
  });
  const step = (n: number, title: string, hint?: string) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '6px' }}>
      <span style={{ fontSize: '14px', fontWeight: 800 }}>{n}. {title}</span>
      {hint && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{hint}</span>}
    </div>
  );
  const card = (p: HitchPart, picked: boolean, onPick: () => void, kind: 'radio' | 'checkbox', extra?: React.ReactNode) => {
    const ns = catalog.get(p.sku);
    const warnings = [
      ...p.notes.filter(n => /required|not compatible|limited|must|only/i.test(n)),
      ...(p.needs_factory_wiring ? ['Needs factory trailer wiring (tow package plug)'] : []),
    ];
    const plain = p.notes.filter(n => !/required|not compatible|limited|must|only/i.test(n));
    const specs = Object.entries(p.specs || {}).filter(([, v]) => v && v !== 'N/A');
    return (
      <label key={p.sku} style={{ display: 'grid', gridTemplateColumns: 'auto 110px 1fr', gap: '10px', alignItems: 'start', padding: '10px', borderRadius: '10px', cursor: 'pointer', border: `1px solid ${picked ? 'rgba(59,130,246,0.6)' : 'var(--border)'}`, background: picked ? 'rgba(59,130,246,0.08)' : 'var(--card)' }}>
        <input type={kind} checked={picked} onChange={onPick} style={{ marginTop: '4px' }} aria-label={`${p.sku} ${p.name}`} />
        <div style={{ width: '110px', height: '82px', background: '#fff', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {p.image_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={p.image_url} alt={p.sku} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            : <span style={{ fontSize: '10px', color: '#64748b' }}>No photo</span>}
        </div>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ fontSize: '13px', lineHeight: 1.35 }}>
            <span style={{ fontWeight: 800 }}>{p.sku}</span> <span style={{ fontWeight: 600 }}>{p.name}</span>
            {showPrice && <span style={{ color: '#22c55e', fontWeight: 800 }}> {money(priceOf(p))}</span>}
            {extra}
          </div>
          {specs.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: '11px' }}>
              {specs.map(([k, v]) => <span key={k}><span style={{ color: 'var(--text-muted)' }}>{k}</span> <b>{v}</b></span>)}
            </div>
          )}
          {(p.features.length > 0 || plain.length > 0) && (
            <ul style={{ margin: '2px 0 0', paddingLeft: '16px', fontSize: '11px', color: 'var(--text-secondary)' }}>
              {[...p.features.slice(0, 4), ...plain].map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
          {warnings.map((w, i) => <div key={i} style={{ fontSize: '11px', fontWeight: 700, color: WARN }}>⚠ {w}</div>)}
          {!ns && <div style={{ fontSize: '11px', fontWeight: 700, color: RED }}>Not in NetSuite yet{showPrice ? ' — priced at Curt list' : ''}</div>}
          <a href={`https://www.curtmfg.com/part/${encodeURIComponent(p.sku)}`} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: '11px', color: '#60a5fa', fontWeight: 700 }}>Curt page and install sheet ↗</a>
        </div>
      </label>
    );
  };
  const none = (picked: boolean, onPick: () => void, text: string) => (
    <label style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '10px', borderRadius: '10px', cursor: 'pointer', border: `1px solid ${picked ? 'rgba(59,130,246,0.6)' : 'var(--border)'}`, background: picked ? 'rgba(59,130,246,0.08)' : 'var(--card)', fontSize: '13px', fontWeight: 700 }}>
      <input type="radio" checked={picked} onChange={onPick} />{text}
    </label>
  );

  return (
    <>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
          <div>
            <div style={label}>Vehicle</div>
            <select aria-label="Vehicle" value={platformKey} onChange={e => setPlatformKey(e.target.value)} style={sel}>
              <option value="">Pick a vehicle…</option>
              {platforms.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <div style={label}>Year</div>
            <select aria-label="Year" value={year} onChange={e => setYear(Number(e.target.value))} style={sel}>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {!platformKey && <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '12px 0' }}>Pick the vehicle to see the hitches that fit it.</div>}

        {options && (
          <>
            {step(1, 'Hitch', `${options.hitches.length} fit a ${year} ${platform?.label || ''}`)}
            {options.hitches.length === 0
              ? <div style={{ fontSize: '12px', fontWeight: 700, color: RED }}>No Curt hitch is listed for this vehicle and year.</div>
              : options.hitches.map(h => card(h, h.sku === hitchSku, () => setHitchSku(h.sku), 'radio',
                h.hitch_class ? <span style={{ marginLeft: '6px', fontSize: '10px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px', background: 'rgba(96,165,250,0.15)', color: '#60a5fa' }}>Class {h.hitch_class}</span> : null))}

            {step(2, '4-way wiring harness')}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>Factory trailer wiring?</span>
              <button type="button" aria-pressed={!factory} onClick={() => setFactory(false)} style={chip(!factory)}>No</button>
              <button type="button" aria-pressed={factory} onClick={() => setFactory(true)} style={chip(factory)}>Yes, has the factory tow plug</button>
            </div>
            {none(!wiringSku, () => { setWiringSku(''); setWithAdapter(false); }, 'No wiring')}
            {options.wiring.map(w => card(w, w.sku === wiringSku, () => setWiringSku(w.sku), 'radio'))}
            {options.wiring.length === 0 && (
              <div style={{ fontSize: '12px', fontWeight: 700, color: WARN }}>
                {factory ? 'No 4-way harness is listed for this vehicle and year.' : 'No harness that works without factory trailer wiring is listed for this vehicle and year.'}
              </div>
            )}

            {step(3, '7/4-way adapter', wiring ? 'adds a 7-way plug to the 4-way' : 'pick a harness first')}
            {wiring && adapterFor(data, wiring)
              ? card(adapterFor(data, wiring)!, withAdapter, () => setWithAdapter(v => !v), 'checkbox')
              : <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>The adapter plugs into the 4-way harness.</div>}

            {step(4, 'Brake controller')}
            {none(!brakeSku, () => setBrakeSku(''), 'No brake controller')}
            {options.brakeControllers.map(b => card(b, b.sku === brakeSku, () => setBrakeSku(b.sku), 'radio',
              b.tier ? <span style={{ marginLeft: '6px', fontSize: '10px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px', background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>{BRAKE_TIER_LABEL[b.tier]}</span> : null))}
            {brake && needsSevenWay(brake) && !adapter && (
              <div style={{ fontSize: '12px', fontWeight: 700, color: RED }}>The Bluetooth controller plugs into the trailer&apos;s 7-way. Add a harness and the 7/4-way adapter.</div>
            )}
            {brake && !needsSevenWay(brake) && options.brakeHarness && (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Adds the vehicle&apos;s plug-in brake harness, {options.brakeHarness.sku}.</div>
            )}
          </>
        )}
      </div>

      {choices && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ fontSize: '13px', fontWeight: 800 }}>{hitchKitName(choices)}</div>
          {missing.length > 0 && (
            <div style={{ fontSize: '12px', fontWeight: 700, color: RED }}>
              Not in NetSuite yet: {missing.map(l => l.item_number).join(', ')}. Create {missing.length === 1 ? 'it' : 'them'} before converting to a sales order.
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            {showPrice && <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Parts <b>{money(partsTotal)}</b></span>}
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Labor <b>{labor} hr</b>{showPrice && laborRate > 0 ? <> · <b>{money(labor * laborRate)}</b></> : null}</span>
            {showPrice && <span style={{ fontSize: '14px', fontWeight: 800, color: '#22c55e' }}>{money(partsTotal + labor * laborRate)}</span>}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              disabled={!!(brake && needsSevenWay(brake) && !adapter)}
              onClick={() => onAdd(lines)}
              style={{ padding: '9px 16px', borderRadius: '8px', border: 'none', background: 'var(--accent, #2563eb)', color: '#fff', fontSize: '13px', fontWeight: 800, cursor: 'pointer', opacity: brake && needsSevenWay(brake) && !adapter ? 0.5 : 1 }}
            >
              Add hitch kit to estimate
            </button>
          </div>
        </div>
      )}
    </>
  );
}
