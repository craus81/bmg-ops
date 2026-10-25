'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { loadKits, type KitWithMembers } from '@/lib/part-kits';
import {
  addonLines, addonPicks, addonPrice, builtRackName, chosenRack, CURB_CLAMP, EMPTY_CHOICE, fitsFor, loadAddonParts,
  pairsFor, pickerRacks, racksForFit, SIDE_HINT, SIDE_LABEL, sideOffered, STREET_CLAMP, TIE_DOWN, vehiclesFor,
  ADDON_LABOR_HOURS, type AddonLine, type AddonPart, type ClampChoice, type PickerChoice, type RackSide,
} from '@/lib/rack-picker';

/**
 * Build a rack, one step at a time (src/lib/rack-picker.ts). Every option
 * that isn't a real Prime/Ranger kit is greyed out.
 */

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Opt<V> { value: V; title: string; sub?: string; on: boolean; off?: boolean }

export default function RackStepPicker({ onAdd, showPrice }: {
  onAdd: (kit: KitWithMembers, kitName: string, addons: AddonLine[]) => void;
  showPrice: boolean;
}) {
  const [kits, setKits] = useState<KitWithMembers[] | null>(null);
  const [addonParts, setAddonParts] = useState<Map<string, AddonPart>>(new Map());
  const [error, setError] = useState('');
  const [c, setC] = useState<PickerChoice>(EMPTY_CHOICE);
  const [clamp, setClamp] = useState<ClampChoice>('none');
  const [clampPicked, setClampPicked] = useState(false);
  const [straps, setStraps] = useState(0);
  // A finished step can be reopened to change it.
  const [open, setOpen] = useState<string | null>(null);
  const [added, setAdded] = useState('');

  useEffect(() => {
    const supabase = createClient();
    let live = true;
    loadKits(supabase)
      .then(ks => { if (live) setKits(ks); })
      .catch(e => { if (live) setError(e?.message || 'Could not load rack kits'); });
    loadAddonParts(supabase).then(m => { if (live) setAddonParts(m); }).catch(() => { /* fallback prices */ });
    return () => { live = false; };
  }, []);

  const racks = useMemo(() => pickerRacks(kits || []), [kits]);
  const rack = chosenRack(racks, c);
  const picks = c.line === 'AluRack' && rack ? addonPicks(clamp, straps) : [];
  const addons = addonLines(picks, addonParts);
  const addonTotal = addons.reduce((s, l) => s + l.unit_price * l.quantity, 0);

  const pick = (patch: Partial<PickerChoice>) => { setC(prev => ({ ...prev, ...patch })); setOpen(null); setAdded(''); };

  const optStyle = (o: Opt<unknown>): React.CSSProperties => ({
    display: 'flex', flexDirection: 'column', gap: '1px', textAlign: 'left', minWidth: 0,
    padding: '8px 12px', borderRadius: '8px', cursor: o.off ? 'not-allowed' : 'pointer',
    border: `1.5px ${o.off ? 'dashed' : 'solid'} ${o.on ? 'rgba(59,130,246,0.7)' : 'var(--border)'}`,
    background: o.on ? 'rgba(59,130,246,0.15)' : o.off ? 'transparent' : 'var(--card)',
    color: o.off ? 'var(--text-muted)' : 'var(--text-primary)', opacity: o.off ? 0.55 : 1,
    fontSize: '13px', fontWeight: 700,
  });
  const options = <V,>(list: Opt<V>[], onPick: (v: V) => void, column = false) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', flexDirection: column ? 'column' : 'row', gap: '8px' }}>
      {list.map(o => (
        <button key={String(o.value)} type="button" disabled={o.off} aria-pressed={o.on} onClick={() => onPick(o.value)} style={optStyle(o)}>
          <span>{o.title}</span>
          {o.sub && <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-muted)' }}>{o.sub}</span>}
        </button>
      ))}
    </div>
  );

  // ── Steps ──
  interface Step { id: string; label: string; value: string | null; reachable: boolean; body: () => React.ReactNode }
  const steps: Step[] = [];
  steps.push({
    id: 'line', label: 'Rack line', value: c.line, reachable: true,
    body: () => options<'ErgoRack' | 'AluRack'>([
      { value: 'ErgoRack', title: 'ErgoRack', sub: 'Drop-down ladder rack, 2 or 3 crossbars', on: c.line === 'ErgoRack' },
      { value: 'AluRack', title: 'AluRack', sub: 'Aluminum cargo rack with side rails', on: c.line === 'AluRack' },
    ], v => pick({ ...EMPTY_CHOICE, line: v })),
  });
  steps.push({
    id: 'vehicle', label: 'Vehicle', value: c.vehicle, reachable: !!c.line,
    body: () => options(vehiclesFor(racks, c.line).map(v => ({
      value: v, title: v, sub: `${fitsFor(racks, c.line, v).length} fit${fitsFor(racks, c.line, v).length === 1 ? '' : 's'}`, on: c.vehicle === v,
    })), v => pick({ vehicle: v, fit: null, street: null, curb: null, finish: null, bars: 2 })),
  });
  const fits = fitsFor(racks, c.line, c.vehicle);
  const fitNow = fits.find(f => f.fit === c.fit);
  steps.push({
    id: 'fit', label: c.line === 'AluRack' ? 'Roof / length' : 'Roof / crossbar size',
    value: fitNow ? [fitNow.fitLabel, fitNow.fitSub].filter(Boolean).join(' · ') : null, reachable: !!c.vehicle,
    body: () => options(fits.map(f => ({ value: f.fit, title: f.fitLabel, sub: f.fitSub, on: c.fit === f.fit })), v => {
      const finishes = [...new Set(racks.filter(r => r.line === c.line && r.vehicle === c.vehicle && r.fit === v).map(r => r.finish))];
      pick({ fit: v, street: null, curb: null, bars: 2, finish: finishes.length === 1 ? finishes[0] : null });
    }),
  });
  if (c.line === 'ErgoRack') {
    const has3 = racksForFit(racks, c).some(r => r.bars === 3);
    steps.push({
      id: 'bars', label: 'Crossbars', value: c.fit ? `${c.bars} crossbars` : null, reachable: !!c.fit,
      body: () => options<2 | 3>([
        { value: 2, title: '2 crossbars', on: c.bars === 2 },
        { value: 3, title: '3 crossbars', sub: has3 ? 'Adds a middle bar' : 'No 3-bar kit for this fit', on: c.bars === 3, off: !has3 },
      ], v => {
        const keep = !!chosenRack(racks, { ...c, bars: v });
        pick(keep ? { bars: v } : { bars: v, street: null, curb: null });
      }),
    });
    const pairs = pairsFor(racks, c);
    const side = (key: 'street' | 'curb') => {
      const other = key === 'street' ? null : c.street;
      return options<RackSide>((['B', 'C', 'R'] as RackSide[]).map(f => {
        const ok = sideOffered(pairs, f, other);
        return { value: f, title: SIDE_LABEL[f], sub: ok ? SIDE_HINT[f] : `No kit with ${other ? `${SIDE_LABEL[other]} on the street side` : 'this'}`, on: c[key] === f, off: !ok };
      }), v => {
        if (key === 'street') {
          const keepCurb = c.curb && sideOffered(pairs, c.curb, v);
          setC(prev => ({ ...prev, street: v, curb: keepCurb ? prev.curb : null }));
        } else {
          setC(prev => ({ ...prev, curb: v }));
        }
        setAdded('');
      }, true);
    };
    steps.push({
      id: 'sides', label: 'Ladder side features',
      value: c.street && c.curb ? `Street: ${SIDE_LABEL[c.street]} · Curb: ${SIDE_LABEL[c.curb]}` : null, reachable: !!c.fit,
      body: () => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
            <div><div style={sideHead}>Street side</div>{side('street')}</div>
            <div><div style={sideHead}>Curb side</div>{side('curb')}</div>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Kits for this fit: {pairs.map(p => `${SIDE_LABEL[p[0] as RackSide]} + ${SIDE_LABEL[p[1] as RackSide]}`).join(', ') || 'none'}.
          </div>
        </div>
      ),
    });
  } else if (c.line === 'AluRack') {
    const finishes = new Set(racksForFit(racks, c).map(r => r.finish));
    steps.push({
      id: 'finish', label: 'Finish', value: c.fit ? c.finish : null, reachable: !!c.fit,
      body: () => options((['Silver', 'Black'] as const).map(f => ({
        value: f, title: f, sub: finishes.has(f) ? undefined : `No ${f.toLowerCase()} kit`, on: c.finish === f, off: !finishes.has(f),
      })), v => pick({ finish: v })),
    });
    const clampText: Record<ClampChoice, string> = { none: 'None', street: 'Street side (ACX)', curb: 'Curb side (AXC)', both: 'Both sides' };
    const p = (a: typeof STREET_CLAMP) => (showPrice ? ` · ${money(addonPrice(a, addonParts))}` : '');
    steps.push({
      id: 'clamp', label: 'Ladder clamp down', value: rack && clampPicked ? clampText[clamp] : null, reachable: !!rack,
      body: () => options<ClampChoice>([
        { value: 'none', title: 'None', on: clamp === 'none' },
        { value: 'street', title: 'Street side', sub: `ACX Quick Clamp LH${p(STREET_CLAMP)}`, on: clamp === 'street' },
        { value: 'curb', title: 'Curb side', sub: `AXC Quick Clamp RH${p(CURB_CLAMP)}`, on: clamp === 'curb' },
        { value: 'both', title: 'Both sides', sub: 'One ACX + one AXC', on: clamp === 'both' },
      ], v => { setClamp(v); setClampPicked(true); setOpen(null); setAdded(''); }),
    });
    steps.push({
      id: 'straps', label: 'Ratchet tie downs', value: null, reachable: !!rack && clampPicked,
      body: () => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <button type="button" aria-label="One less strap" onClick={() => { setStraps(n => Math.max(0, n - 1)); setAdded(''); }} style={stepBtn}>−</button>
          <span style={{ fontSize: '16px', fontWeight: 800, minWidth: '2ch', textAlign: 'center' }}>{straps}</span>
          <button type="button" aria-label="One more strap" onClick={() => { setStraps(n => n + 1); setAdded(''); }} style={stepBtn}>+</button>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            ACC-8000 Retractable Ratchet Strap w/ Mount{showPrice ? ` · ${money(addonPrice(TIE_DOWN, addonParts))} each` : ''}
          </span>
        </div>
      ),
    });
  }

  const firstOpen = steps.find(s => s.reachable && !s.value)?.id;
  const active = open || firstOpen || steps[steps.length - 1].id;

  const add = () => {
    if (!rack) return;
    onAdd(rack.kit, builtRackName(rack, c), addons);
    setAdded(rack.kit.item_number || rack.kit.name);
  };

  if (error) return <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(248,113,113,0.1)', color: '#f87171', fontSize: '12px' }}>{error}</div>;
  if (kits === null) return <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '20px 0' }}>Loading rack kits…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
        {steps.map((s, i) => {
          const isOpen = s.id === active && s.reachable;
          const done = !isOpen && !!s.value;
          return (
            <div key={s.id} style={{ padding: '12px 14px', borderTop: i ? '1px solid var(--border)' : 'none', display: 'flex', flexDirection: 'column', gap: '10px', opacity: !isOpen && !done ? 0.5 : 1 }}>
              <div
                role={done ? 'button' : undefined}
                tabIndex={done ? 0 : undefined}
                onClick={done ? () => setOpen(s.id) : undefined}
                onKeyDown={done ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(s.id); } } : undefined}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', cursor: done ? 'pointer' : 'default' }}
              >
                <span style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)' }}>{s.label}</span>
                {done && (
                  <span style={{ fontSize: '13px', fontWeight: 700, textAlign: 'right' }}>
                    {s.value} <span style={{ color: '#60a5fa', fontWeight: 500, fontSize: '11px' }}>· change</span>
                  </span>
                )}
              </div>
              {isOpen && s.body()}
            </div>
          );
        })}
      </div>

      {rack && (
        <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--card)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '14px', fontWeight: 800 }}>{rack.kit.item_number}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{builtRackName(rack, c)}</div>
            </div>
            {showPrice && (
              <span style={{ fontSize: '18px', fontWeight: 800, color: '#22c55e' }}>
                {money(rack.kit.totalPrice + addonTotal)}
                {rack.kit.missing.length > 0 && <span style={{ fontSize: '10px', color: '#f59e0b' }}> incomplete</span>}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px' }}>
            {rack.kit.members.map((m, i) => (
              <div key={`${m.part.id}-${i}`} style={{ display: 'flex', gap: '6px' }}>
                <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{m.quantity}× {m.part.item_number}</span>
                <span style={{ color: 'var(--text-muted)' }}>{m.part.display_name || m.part.description || ''}</span>
              </div>
            ))}
            {rack.kit.missing.map(m => (
              <div key={`miss-${m.item_number}`} style={{ display: 'flex', gap: '6px' }}>
                <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{m.quantity}× {m.item_number}</span>
                <span style={{ color: '#f59e0b' }}>not in NetSuite yet</span>
              </div>
            ))}
            {addons.map(l => (
              <div key={`addon-${l.item_number}`} style={{ display: 'flex', gap: '6px' }}>
                <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{l.quantity}× {l.item_number}</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {l.description} · own line, {ADDON_LABOR_HOURS * l.quantity} hr labor{showPrice ? ` · ${money(l.unit_price * l.quantity)}` : ''}
                  {l.is_custom && <span style={{ color: '#f59e0b' }}> · not in NetSuite yet</span>}
                </span>
              </div>
            ))}
          </div>
          <button type="button" onClick={add}
            style={{ alignSelf: 'flex-start', padding: '9px 18px', borderRadius: '8px', border: 'none', background: added ? 'rgba(34,197,94,0.15)' : 'var(--accent, #2563eb)', color: added ? '#22c55e' : '#fff', fontSize: '13px', fontWeight: 800, cursor: 'pointer' }}>
            {added ? `✓ Added ${added} · add another` : 'Add rack to estimate'}
          </button>
        </div>
      )}
    </div>
  );
}

const sideHead: React.CSSProperties = { fontSize: '12px', fontWeight: 800, marginBottom: '6px' };
const stepBtn: React.CSSProperties = { width: '36px', height: '36px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '18px', cursor: 'pointer' };
