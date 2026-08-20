'use client';

/**
 * Vehicle interior geometry editor (upfit configurator, migration 214).
 * The 3D designer can only offer wheelbase/roof combos that have a
 * vehicle_interiors row; the seed rows are compiled from published
 * body-builder guides and marked approximate — this screen is where staff
 * verify them against a tape measure and add new combos. Adding a vehicle
 * to the configurator is a row here, not code.
 *
 * The preview on the right is the real designer scene (empty layout,
 * read-only), so what's typed is exactly what reps will design into.
 */

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { createClient } from '@/lib/supabase-browser';
import { InteriorGeometry } from '@/lib/upfit-layout';

const UpfitSceneLazy = dynamic(() => import('@/components/upfit/UpfitScene'), {
  ssr: false,
  loading: () => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: '13px' }}>
      Loading 3D…
    </div>
  ),
});

interface Platform { id: string; key: string; label: string; body_type: string; config: Record<string, string[]> | null }
interface InteriorRow {
  id: string; platform_id: string; wheelbase_label: string; roof_label: string;
  geometry: InteriorGeometry; source: string; notes: string | null;
}

const card: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--border)',
  borderRadius: '12px', padding: '14px',
};
const label: React.CSSProperties = {
  fontSize: '10px', fontWeight: 800, textTransform: 'uppercase',
  letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '4px',
};
const numInput: React.CSSProperties = {
  width: '76px', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '8px',
  border: '1px solid var(--border)', background: 'var(--input-bg)',
  color: 'var(--text-primary)', fontSize: '13px', textAlign: 'right',
};
const btn = (kind: 'primary' | 'ghost' = 'ghost', disabled = false): React.CSSProperties => ({
  padding: '7px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 800,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  background: kind === 'primary' ? 'var(--accent, #2563eb)' : 'var(--card)',
  color: kind === 'primary' ? '#fff' : 'var(--text-primary)',
  border: kind === 'primary' ? 'none' : '1px solid var(--border)',
});

/** Flat, editable mirror of the geometry JSONB. Wheel wells are edited as
 *  ONE symmetric set (vans are symmetric; both sides get the numbers). */
interface GeoForm {
  length: string; width: string; height: string; betweenWells: string;
  wellFrom: string; wellLength: string; wellWidth: string; wellHeight: string;
  rearW: string; rearH: string;
  sideSide: 'left' | 'right'; sideFrom: string; sideW: string; sideH: string;
}

const toForm = (g: InteriorGeometry): GeoForm => {
  const well = g.wheelwells[0];
  return {
    length: String(g.cargo.length), width: String(g.cargo.width), height: String(g.cargo.height),
    betweenWells: String(g.cargo.width_between_wheelwells),
    wellFrom: String(well?.from_bulkhead ?? 0), wellLength: String(well?.length ?? 0),
    wellWidth: String(well?.width ?? 0), wellHeight: String(well?.height ?? 0),
    rearW: String(g.doors?.rear?.width ?? 0), rearH: String(g.doors?.rear?.height ?? 0),
    sideSide: g.doors?.side?.side ?? 'right',
    sideFrom: String(g.doors?.side?.from_bulkhead ?? 0),
    sideW: String(g.doors?.side?.width ?? 0), sideH: String(g.doors?.side?.height ?? 0),
  };
};

const n = (s: string) => {
  const v = parseFloat(s);
  return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : 0;
};

const fromForm = (f: GeoForm): InteriorGeometry => {
  const well = { from_bulkhead: n(f.wellFrom), length: n(f.wellLength), width: n(f.wellWidth), height: n(f.wellHeight) };
  return {
    version: 1,
    units: 'in',
    cargo: {
      length: n(f.length), width: n(f.width), height: n(f.height),
      width_between_wheelwells: n(f.betweenWells) || Math.max(0, n(f.width) - 2 * well.width),
    },
    wheelwells: well.length > 0 && well.width > 0
      ? [{ side: 'left' as const, ...well }, { side: 'right' as const, ...well }]
      : [],
    doors: {
      ...(n(f.rearW) > 0 && n(f.rearH) > 0 ? { rear: { width: n(f.rearW), height: n(f.rearH) } } : {}),
      ...(n(f.sideW) > 0 && n(f.sideH) > 0
        ? { side: { side: f.sideSide, from_bulkhead: n(f.sideFrom), width: n(f.sideW), height: n(f.sideH) } }
        : {}),
    },
  };
};

export default function VehicleInteriorsPage() {
  const router = useRouter();
  const { isAdmin, user, profile, loading: authLoading } = useAuth();
  const dialog = useDialog();
  const supabase = useMemo(() => createClient(), []);

  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [rows, setRows] = useState<InteriorRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<GeoForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [sceneKey, setSceneKey] = useState(0);

  useEffect(() => {
    if (authLoading || !user) return;
    if (!isAdmin) router.push('/home');
  }, [authLoading, user, isAdmin, router]);

  const load = async () => {
    const [{ data: plats }, { data: ints }] = await Promise.all([
      supabase.from('vehicle_platforms').select('id, key, label, body_type, config').eq('active', true).order('sort_order'),
      supabase.from('vehicle_interiors').select('id, platform_id, wheelbase_label, roof_label, geometry, source, notes'),
    ]);
    setPlatforms((plats as Platform[]) || []);
    setRows((ints as InteriorRow[]) || []);
  };

  useEffect(() => {
    if (authLoading || !user || !isAdmin) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  }, [authLoading, user, isAdmin]);

  const selected = rows.find(r => r.id === selectedId) || null;
  const selectedPlatform = selected ? platforms.find(p => p.id === selected.platform_id) || null : null;
  const previewGeometry = useMemo(() => (form ? fromForm(form) : null), [form]);

  const pick = (row: InteriorRow) => {
    setSelectedId(row.id);
    setForm(toForm(row.geometry));
    setSceneKey(k => k + 1);
  };

  const save = async () => {
    if (!selected || !form) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('vehicle_interiors')
        .update({
          geometry: fromForm(form) as unknown as Record<string, unknown>,
          source: 'manual',
          updated_by: profile?.id || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', selected.id);
      if (error) throw new Error(error.message);
      await load();
      dialog.alert('Saved — new designs on this combo use the updated geometry immediately.');
    } catch (err: any) {
      dialog.alert(`Save failed: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  const addCombo = async (platform: Platform) => {
    const config = platform.config || {};
    const wheelbases = config.wheelbases || [];
    const roofs = config.roofs || [''];
    const existing = new Set(rows.filter(r => r.platform_id === platform.id).map(r => `${r.wheelbase_label}|${r.roof_label}`));
    const options = wheelbases.flatMap(wb => (roofs.length > 0 ? roofs : ['']).map(roof => ({ wb, roof })))
      .filter(o => !existing.has(`${o.wb}|${o.roof}`));
    if (options.length === 0) {
      dialog.alert('Every configured wheelbase/roof combo for this platform already has geometry.');
      return;
    }
    const choice = await dialog.prompt(
      `Which combo? Available: ${options.map(o => `${o.wb}${o.roof ? ` ${o.roof}` : ''}`).join(', ')}\nType it exactly (e.g. "${options[0].wb}${options[0].roof ? ` ${options[0].roof}` : ''}").`,
      `${options[0].wb}${options[0].roof ? ` ${options[0].roof}` : ''}`,
      { confirmLabel: 'Add combo' },
    );
    if (!choice) return;
    const match = options.find(o => `${o.wb}${o.roof ? ` ${o.roof}` : ''}`.toLowerCase() === choice.trim().toLowerCase());
    if (!match) {
      dialog.alert('That did not match an available combo.');
      return;
    }
    // Start from a sibling row's geometry when one exists — editing beats
    // typing fourteen numbers from scratch.
    const sibling = rows.find(r => r.platform_id === platform.id);
    const geometry = sibling ? sibling.geometry : {
      version: 1, units: 'in' as const,
      cargo: { length: 120, width: 70, height: 70, width_between_wheelwells: 54 },
      wheelwells: [],
      doors: {},
    };
    const { data, error } = await supabase
      .from('vehicle_interiors')
      .insert({
        platform_id: platform.id,
        wheelbase_label: match.wb,
        roof_label: match.roof,
        geometry: geometry as unknown as Record<string, unknown>,
        source: 'manual',
        updated_by: profile?.id || null,
        notes: sibling ? `Started from ${sibling.wheelbase_label}${sibling.roof_label ? ` ${sibling.roof_label}` : ''} — verify all numbers.` : 'Entered by hand.',
      })
      .select('id, platform_id, wheelbase_label, roof_label, geometry, source, notes')
      .single();
    if (error) {
      dialog.alert(`Add failed: ${error.message}`);
      return;
    }
    setRows(prev => [...prev, data as InteriorRow]);
    pick(data as InteriorRow);
  };

  if (authLoading || !user || !isAdmin) return null;

  const grouped = platforms
    .map(p => ({ platform: p, combos: rows.filter(r => r.platform_id === p.id).sort((a, b) => a.wheelbase_label.localeCompare(b.wheelbase_label, undefined, { numeric: true }) || a.roof_label.localeCompare(b.roof_label)) }))
    .filter(g => g.combos.length > 0 || (g.platform.config?.wheelbases?.length || 0) > 0);

  const field = (key: keyof GeoForm, title: string) => form && (
    <div>
      <div style={label}>{title}</div>
      <input inputMode="decimal" value={form[key] as string} onChange={e => setForm(f => f && { ...f, [key]: e.target.value })} style={numInput} />
    </div>
  );

  return (
    <div style={{ padding: '16px 0 40px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, margin: '0 0 4px' }}>Vehicle Interiors</h1>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
        Cargo geometry per wheelbase/roof combo — what the 3D Upfit Designer draws and measures against. Seed rows are
        approximate (published body-builder figures); verify before quoting wall-tight fits. All numbers in inches.
      </p>

      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Combo list */}
        <div style={{ flex: '0 1 260px', minWidth: '220px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {grouped.map(({ platform, combos }) => (
            <div key={platform.id} style={{ ...card, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', flex: 1 }}>{platform.label}</div>
                {platform.body_type === 'van' && (
                  <button style={{ ...btn(), padding: '2px 8px', fontSize: '11px' }} onClick={() => addCombo(platform)} title="Add a wheelbase/roof combo">+</button>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {combos.map(r => (
                  <button
                    key={r.id}
                    onClick={() => pick(r)}
                    style={{
                      ...btn(), textAlign: 'left', padding: '6px 10px', fontSize: '12px',
                      borderColor: r.id === selectedId ? 'var(--accent, #2563eb)' : 'var(--border)',
                      color: r.id === selectedId ? 'var(--accent, #2563eb)' : 'var(--text-primary)',
                    }}
                  >
                    {/^\d/.test(r.wheelbase_label) ? `${r.wheelbase_label}"` : r.wheelbase_label}
                    {r.roof_label ? ` · ${r.roof_label}` : ''}
                    <span style={{ float: 'right', fontSize: '10px', color: r.source === 'seed' ? 'var(--warning, #eab308)' : 'var(--text-muted)', fontWeight: 700 }}>
                      {r.source === 'seed' ? 'approx.' : 'verified'}
                    </span>
                  </button>
                ))}
                {combos.length === 0 && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No combos yet.</div>}
              </div>
            </div>
          ))}
        </div>

        {/* Editor + preview */}
        {selected && form ? (
          <div style={{ flex: '1 1 480px', minWidth: '300px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', flex: 1 }}>
                  {selectedPlatform?.label} — {selected.wheelbase_label}{selected.roof_label ? ` · ${selected.roof_label} roof` : ''}
                </div>
                <button style={btn('primary', saving)} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save geometry'}</button>
              </div>
              {selected.notes && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>{selected.notes}</div>}

              <div style={{ ...label, marginBottom: '6px' }}>Cargo box</div>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
                {field('length', 'Length')}
                {field('width', 'Max width')}
                {field('height', 'Height')}
                {field('betweenWells', 'Between wells')}
              </div>

              <div style={{ ...label, marginBottom: '6px' }}>Wheel wells (symmetric — both sides)</div>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
                {field('wellFrom', 'From bulkhead')}
                {field('wellLength', 'Length')}
                {field('wellWidth', 'Width')}
                {field('wellHeight', 'Height')}
              </div>

              <div style={{ ...label, marginBottom: '6px' }}>Rear door opening</div>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
                {field('rearW', 'Width')}
                {field('rearH', 'Height')}
              </div>

              <div style={{ ...label, marginBottom: '6px' }}>Side door opening</div>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <div style={label}>Side</div>
                  <select
                    value={form.sideSide}
                    onChange={e => setForm(f => f && { ...f, sideSide: e.target.value as 'left' | 'right' })}
                    style={{ ...numInput, width: '90px', textAlign: 'left' }}
                  >
                    <option value="right">Passenger</option>
                    <option value="left">Driver</option>
                  </select>
                </div>
                {field('sideFrom', 'From bulkhead')}
                {field('sideW', 'Width')}
                {field('sideH', 'Height')}
              </div>
            </div>

            <div style={{ height: '380px', borderRadius: '14px', overflow: 'hidden', border: '1px solid var(--border)', background: '#171b22' }}>
              {previewGeometry && previewGeometry.cargo.length > 0 && previewGeometry.cargo.width > 0 && (
                <UpfitSceneLazy
                  key={sceneKey}
                  interior={previewGeometry}
                  items={[]}
                  selectedUid={null}
                  warningUids={[]}
                  guides={[]}
                  showLabels={false}
                  editable={false}
                  onSelect={() => {}}
                  onItemMove={() => {}}
                  onContextLost={() => setSceneKey(k => k + 1)}
                />
              )}
            </div>
          </div>
        ) : (
          <div style={{ ...card, flex: '1 1 480px', minWidth: '300px', color: 'var(--text-muted)', fontSize: '13px' }}>
            Pick a combo to edit its geometry — the live preview shows exactly what reps will design into.
          </div>
        )}
      </div>
    </div>
  );
}
