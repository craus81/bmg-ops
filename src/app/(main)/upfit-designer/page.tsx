'use client';

/**
 * Upfit Designer — the Ranger-style 3D configurator (roadmap N4, 3D tier).
 *
 * Flow: pick a vehicle (platform + wheelbase/roof combo that has interior
 * geometry) → design the cargo area in live 3D (add parts from the catalog
 * browser, drag/snap/rotate them) → save; Review & Quote turns the design
 * into a draft estimate on the existing pipeline.
 *
 * All layout math lives in src/lib/upfit-layout.ts (pure, unit-tested);
 * everything three.js lives under src/components/upfit/ behind the
 * next/dynamic ssr:false import below — this page's own module graph must
 * never import three, so the 3D chunk loads only when this route does.
 * Layout state is one useReducer-style UndoableLayout here, OUTSIDE the
 * Canvas, so the DOM panels and the scene share a single source of truth.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { deepLinks } from '@/lib/deep-links';
import PartCatalogBrowser, { BrowsePart, KitWithMembers } from '@/components/PartCatalogBrowser';
import {
  AutoLayoutEntry, InteriorGeometry, LayoutState, PlacedItem, UndoableLayout,
  aggregateLines, autoLayout, checkpoint, emptyLayout, footprint, initialUndoable,
  layoutWarnings, parseLayout, redo, snapPosition, undo, undoableApply,
} from '@/lib/upfit-layout';

const UpfitSceneLazy = dynamic(() => import('@/components/upfit/UpfitScene'), {
  ssr: false,
  loading: () => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: '13px' }}>
      Loading 3D…
    </div>
  ),
});

interface Platform {
  id: string; key: string; label: string; body_type: string;
  image_path: string | null; config: Record<string, string[]> | null;
}
interface InteriorRow {
  id: string; platform_id: string; wheelbase_label: string; roof_label: string;
  geometry: InteriorGeometry;
}
interface DesignListRow {
  id: string; name: string; platform_id: string; wheelbase_label: string; roof_label: string;
  status: string; snapshot_path: string | null; estimate_id: string | null; updated_at: string;
}

interface DesignMeta {
  id: string | null;
  name: string;
  customerId: string | null;
  platform: Platform | null;
  wheelbase: string;
  roof: string;
  interior: InteriorRow | null;
  status: string;
  estimateId: string | null;
}

const BLANK_META: DesignMeta = {
  id: null, name: '', customerId: null, platform: null,
  wheelbase: '', roof: '', interior: null, status: 'draft', estimateId: null,
};

type Step = 'home' | 'vehicle' | 'design';

const newUid = () => Math.random().toString(36).slice(2, 9);

const card: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--border)',
  borderRadius: '12px', padding: '14px',
};
const btn = (kind: 'primary' | 'ghost' | 'danger' = 'ghost', disabled = false): React.CSSProperties => ({
  padding: '7px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 800,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  background: kind === 'primary' ? 'var(--accent, #2563eb)' : 'var(--card)',
  color: kind === 'primary' ? '#fff' : kind === 'danger' ? '#ef4444' : 'var(--text-primary)',
  border: kind === 'primary' ? 'none' : `1px solid ${kind === 'danger' ? 'rgba(239,68,68,0.35)' : 'var(--border)'}`,
});
const money = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const vehicleLabel = (platform: Platform | null, wheelbase: string, roof: string) =>
  platform
    ? `${platform.label} · ${/^\d/.test(wheelbase) ? `${wheelbase}" WB` : wheelbase}${roof ? ` · ${roof} roof` : ''}`
    : '';

export default function UpfitDesignerPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, profile, isAdmin, hasFeature, loading: authLoading } = useAuth();
  const dialog = useDialog();
  const supabase = useMemo(() => createClient(), []);

  const [step, setStep] = useState<Step>('home');
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [interiors, setInteriors] = useState<InteriorRow[]>([]);
  const [categoriesById, setCategoriesById] = useState<Map<string, string>>(new Map());
  const [designs, setDesigns] = useState<DesignListRow[]>([]);
  const [refsLoaded, setRefsLoaded] = useState(false);

  const [meta, setMeta] = useState<DesignMeta>(BLANK_META);
  const [undoState, setUndoState] = useState<UndoableLayout>(() => initialUndoable(emptyLayout()));
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ axis: 'x' | 'z'; at: number }[]>([]);
  const [showLabels, setShowLabels] = useState(true);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [sceneKey, setSceneKey] = useState(0);
  const dragMovedRef = useRef(false);
  const captureFnRef = useRef<(() => Promise<Blob | null>) | null>(null);

  const present = undoState.present;
  const interiorGeom = meta.interior?.geometry ?? null;
  const canUndo = undoState.past.length > 0;
  const canRedo = undoState.future.length > 0;

  // Latest state in refs for the window keyboard handler.
  const latest = useRef({ present, interiorGeom, selectedUid });
  latest.current = { present, interiorGeom, selectedUid };

  // ── Access gate ──
  useEffect(() => {
    if (authLoading || !user) return;
    if (!hasFeature('upfit_configurator') && !isAdmin) router.push('/home');
  }, [authLoading, user, hasFeature, isAdmin, router]);

  // ── Reference data: platforms, interiors, category names ──
  useEffect(() => {
    if (authLoading || !user) return;
    (async () => {
      const [{ data: plats }, { data: ints }, { data: cats }] = await Promise.all([
        supabase.from('vehicle_platforms').select('id, key, label, body_type, image_path, config').eq('active', true).order('sort_order'),
        supabase.from('vehicle_interiors').select('id, platform_id, wheelbase_label, roof_label, geometry'),
        supabase.from('product_categories').select('id, name').eq('active', true),
      ]);
      setPlatforms((plats as Platform[]) || []);
      setInteriors(((ints as InteriorRow[]) || []).filter(r => r.geometry?.cargo));
      setCategoriesById(new Map(((cats as { id: string; name: string }[]) || []).map(c => [c.id, c.name])));
      setRefsLoaded(true);
    })();
  }, [authLoading, user, supabase]);

  const loadDesignList = useCallback(async () => {
    const { data } = await supabase
      .from('upfit_designs')
      .select('id, name, platform_id, wheelbase_label, roof_label, status, snapshot_path, estimate_id, updated_at')
      .eq('is_template', false)
      .neq('status', 'archived')
      .order('updated_at', { ascending: false })
      .order('id')
      .limit(50);
    setDesigns((data as DesignListRow[]) || []);
  }, [supabase]);

  useEffect(() => {
    if (authLoading || !user) return;
    loadDesignList();
  }, [authLoading, user, loadDesignList]);

  // ── Deep links: ?design= opens a saved design; ?new=1[&platform=] starts fresh ──
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (!refsLoaded || deepLinkHandled.current) return;
    const designId = searchParams.get('design');
    const isNew = searchParams.get('new');
    if (designId) {
      deepLinkHandled.current = true;
      openDesign(designId);
    } else if (isNew) {
      deepLinkHandled.current = true;
      const platformId = searchParams.get('platform');
      const customerId = searchParams.get('customer');
      setMeta({ ...BLANK_META, customerId, platform: platforms.find(p => p.id === platformId) || null });
      setStep('vehicle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once when refs arrive
  }, [refsLoaded, searchParams]);

  const openDesign = async (designId: string) => {
    const { data: row, error } = await supabase
      .from('upfit_designs')
      .select('id, name, customer_id, platform_id, wheelbase_label, roof_label, interior_id, layout, status, estimate_id')
      .eq('id', designId)
      .maybeSingle();
    if (error || !row) {
      dialog.alert(error?.message || 'That design no longer exists.');
      return;
    }
    const platform = platforms.find(p => p.id === row.platform_id) || null;
    const interior = interiors.find(i => i.id === row.interior_id)
      || interiors.find(i => i.platform_id === row.platform_id && i.wheelbase_label === row.wheelbase_label && i.roof_label === row.roof_label)
      || null;
    setMeta({
      id: row.id, name: row.name, customerId: row.customer_id, platform,
      wheelbase: row.wheelbase_label, roof: row.roof_label, interior,
      status: row.status, estimateId: row.estimate_id,
    });
    setUndoState(initialUndoable(parseLayout(row.layout)));
    setSelectedUid(null);
    setDirty(false);
    setStep('design');
  };

  // ── Vehicle step ──
  const combosFor = (platformId: string) => interiors
    .filter(i => i.platform_id === platformId)
    .sort((a, b) => a.wheelbase_label.localeCompare(b.wheelbase_label, undefined, { numeric: true }) || a.roof_label.localeCompare(b.roof_label));

  const pickCombo = (platform: Platform, combo: InteriorRow) => {
    setMeta(m => ({
      ...m,
      platform,
      wheelbase: combo.wheelbase_label,
      roof: combo.roof_label,
      interior: combo,
      name: m.name || `${platform.label} ${combo.wheelbase_label}${combo.roof_label ? ` ${combo.roof_label}` : ''} upfit`,
    }));
    setDirty(true);
    setStep('design');
  };

  // ── Layout ops ──
  const apply = useCallback((op: Parameters<typeof undoableApply>[1], opts?: { transient?: boolean }) => {
    setUndoState(s => undoableApply(s, op, latest.current.interiorGeom, opts));
    setDirty(true);
  }, []);

  /** Add catalog entries: auto-place what has dims, park the rest in the
   *  unplaced list — as ONE undoable step. */
  const addEntries = useCallback((entries: AutoLayoutEntry[]) => {
    setUndoState(s => {
      const geom = latest.current.interiorGeom;
      const cur = s.present;
      let items = cur.items;
      let overflow: AutoLayoutEntry[] = entries;
      if (geom) {
        const placeable = entries.filter(e => e.w > 0 && e.d > 0 && e.h > 0);
        const dimless = entries.filter(e => !(e.w > 0 && e.d > 0 && e.h > 0));
        const res = autoLayout(placeable, geom, cur.items, newUid);
        items = [...cur.items, ...res.placed];
        overflow = [...res.overflow, ...dimless];
      }
      const unplaced = [...cur.unplaced];
      for (const o of overflow) {
        const existing = unplaced.find(u => u.item_number === o.item_number);
        if (existing) existing.qty += o.qty;
        else unplaced.push({
          part_id: o.part_id, item_number: o.item_number, label: o.label, category: o.category,
          qty: o.qty, unit_price: o.unit_price, labor_hours: o.labor_hours,
        });
      }
      const nextLayout: LayoutState = { ...cur, items, unplaced };
      return undoableApply(s, { type: 'set_layout', layout: nextLayout }, geom);
    });
    setDirty(true);
  }, []);

  const entryFromPart = (p: BrowsePart, qty: number): AutoLayoutEntry => ({
    part_id: p.id,
    item_number: p.item_number,
    label: p.display_name || p.item_number,
    category: p.product_category_id ? categoriesById.get(p.product_category_id) || null : null,
    w: Number(p.width_in) || 0, d: Number(p.depth_in) || 0, h: Number(p.height_in) || 0,
    qty,
    unit_price: p.sales_price != null ? Number(p.sales_price) : null,
    labor_hours: p.labor_hours != null ? Number(p.labor_hours) : null,
    mount_type: p.mount_type || null,
  });

  const addPart = (p: BrowsePart) => addEntries([entryFromPart(p, 1)]);

  const addKit = (kit: KitWithMembers) => {
    const entries = kit.members.map(m => entryFromPart(m.part, m.quantity));
    if (kit.labor_adder_hours > 0) {
      entries.push({
        part_id: null, item_number: 'ASSEMBLY', label: `${kit.name} — assembly labor`,
        category: 'Labor & Services', w: 0, d: 0, h: 0, qty: 1,
        unit_price: 0, labor_hours: kit.labor_adder_hours, mount_type: null,
      });
    }
    addEntries(entries);
  };

  // ── Drag stream from the scene ──
  const handleItemMove = useCallback((uid: string, pos: [number, number, number] | null, phase: 'move' | 'end') => {
    const { present: cur, interiorGeom: geom } = latest.current;
    if (phase === 'end') {
      dragMovedRef.current = false;
      setGuides([]);
      return;
    }
    const item = cur.items.find(i => i.uid === uid);
    if (!item || !geom || !pos) return;
    if (!dragMovedRef.current) {
      // First real movement of this gesture: checkpoint so undo returns to
      // the pre-drag layout in one step.
      dragMovedRef.current = true;
      setUndoState(checkpoint);
    }
    const { fw } = footprint(item);
    const H = geom.cargo.height;
    const halfW = geom.cargo.width / 2;
    let p: [number, number, number] = pos;
    if (item.zone === 'floor') p = [p[0], 0, p[2]];
    else if (item.zone === 'ceiling') p = [p[0], Math.max(0, H - item.h), p[2]];
    else if (item.zone === 'wall_left') p = [-halfW + fw / 2, Math.min(Math.max(p[1], 0), Math.max(0, H - item.h)), p[2]];
    else if (item.zone === 'wall_right') p = [halfW - fw / 2, Math.min(Math.max(p[1], 0), Math.max(0, H - item.h)), p[2]];
    const snapped = snapPosition({ ...item, pos: p }, geom, cur.items.filter(i => i.uid !== uid));
    setGuides(snapped.guides);
    apply({ type: 'move', uid, pos: snapped.item.pos }, { transient: true });
  }, [apply]);

  const handleContextLost = useCallback(() => setSceneKey(k => k + 1), []);
  const handleCaptureReady = useCallback((fn: () => Promise<Blob | null>) => { captureFnRef.current = fn; }, []);

  // ── Toolbar / keyboard actions ──
  const rotateSelected = useCallback(() => {
    if (latest.current.selectedUid) apply({ type: 'rotate', uid: latest.current.selectedUid });
  }, [apply]);
  const duplicateSelected = useCallback(() => {
    if (latest.current.selectedUid) {
      const uid = newUid();
      apply({ type: 'duplicate', uid: latest.current.selectedUid, newUid: uid });
      setSelectedUid(uid);
    }
  }, [apply]);
  const removeSelected = useCallback(() => {
    if (latest.current.selectedUid) {
      apply({ type: 'remove', uid: latest.current.selectedUid });
      setSelectedUid(null);
    }
  }, [apply]);
  const nudgeSelected = useCallback((dx: number, dy: number, dz: number) => {
    const { selectedUid: uid, present: cur } = latest.current;
    if (!uid) return;
    const item = cur.items.find(i => i.uid === uid);
    if (!item) return;
    // On wall items the "forward/back" arrows move along the wall (z) and
    // up/down moves height — dz doubles as dy so arrows stay intuitive.
    if ((item.zone === 'wall_left' || item.zone === 'wall_right') && dz !== 0 && dx === 0) {
      apply({ type: 'nudge', uid, dz });
    } else {
      apply({ type: 'nudge', uid, dx, dy, dz });
    }
  }, [apply]);
  const doUndo = useCallback(() => { setUndoState(undo); setDirty(true); }, []);
  const doRedo = useCallback(() => { setUndoState(redo); setDirty(true); }, []);

  useEffect(() => {
    if (step !== 'design') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const stepSize = e.shiftKey ? 6 : 1;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
      else if (e.key === 'r' || e.key === 'R') rotateSelected();
      else if (e.key === 'd' || e.key === 'D') duplicateSelected();
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
      else if (e.key === 'Escape') setSelectedUid(null);
      else if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeSelected(-stepSize, 0, 0); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelected(stepSize, 0, 0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); nudgeSelected(0, 0, -stepSize); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); nudgeSelected(0, 0, stepSize); }
      else if (e.key === 'PageUp') { e.preventDefault(); nudgeSelected(0, stepSize, 0); }
      else if (e.key === 'PageDown') { e.preventDefault(); nudgeSelected(0, -stepSize, 0); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, doUndo, doRedo, rotateSelected, duplicateSelected, removeSelected, nudgeSelected]);

  // ── Persistence ──
  const saveDesign = async (): Promise<string | null> => {
    if (!meta.platform || !meta.interior) return null;
    setSaving(true);
    try {
      const layoutJson = JSON.parse(JSON.stringify(present));
      if (meta.id) {
        const { error } = await supabase
          .from('upfit_designs')
          .update({
            name: meta.name || 'Untitled design',
            customer_id: meta.customerId,
            platform_id: meta.platform.id,
            wheelbase_label: meta.wheelbase,
            roof_label: meta.roof,
            interior_id: meta.interior.id,
            layout: layoutJson,
            updated_at: new Date().toISOString(),
          })
          .eq('id', meta.id);
        if (error) throw new Error(error.message);
        setDirty(false);
        loadDesignList();
        return meta.id;
      }
      const { data, error } = await supabase
        .from('upfit_designs')
        .insert({
          name: meta.name || 'Untitled design',
          customer_id: meta.customerId,
          platform_id: meta.platform.id,
          wheelbase_label: meta.wheelbase,
          roof_label: meta.roof,
          interior_id: meta.interior.id,
          layout: layoutJson,
          created_by: profile?.id || null,
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      setMeta(m => ({ ...m, id: data.id }));
      setDirty(false);
      loadDesignList();
      router.replace(deepLinks.upfitDesign(data.id));
      return data.id as string;
    } catch (err: any) {
      dialog.alert(`Save failed: ${err.message || err}`);
      return null;
    } finally {
      setSaving(false);
    }
  };

  // Design thumbnail: captured on save, non-fatal on failure (wrap-quote
  // diagram pattern — timestamped path so caches never serve a stale one).
  const saveWithSnapshot = async () => {
    const id = await saveDesign();
    if (!id || !captureFnRef.current) return;
    try {
      const blob = await captureFnRef.current();
      if (!blob) return;
      const path = `upfit-designs/${id}-${Date.now()}.png`;
      const up = await storage.from('photos').upload(path, blob, { contentType: 'image/png', upsert: true });
      if (!up.error) {
        await supabase.from('upfit_designs').update({ snapshot_path: path }).eq('id', id);
      }
    } catch { /* thumbnail is a nice-to-have */ }
  };

  // ── Derived ──
  const warnings = useMemo(
    () => (interiorGeom ? layoutWarnings(present.items, interiorGeom) : { overlaps: [], outOfShell: [], overWheelwell: [] }),
    [present.items, interiorGeom],
  );
  const warningUids = useMemo(
    () => [...new Set([...warnings.overlaps.flat(), ...warnings.outOfShell, ...warnings.overWheelwell])],
    [warnings],
  );
  const lines = useMemo(() => aggregateLines(present), [present]);
  const partsSubtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const selectedItem = selectedUid ? present.items.find(i => i.uid === selectedUid) || null : null;
  const imageUrl = (path: string) => storage.from('photos').getPublicUrl(path).data.publicUrl;
  const platformById = useMemo(() => new Map(platforms.map(p => [p.id, p])), [platforms]);

  if (authLoading || !user) return null;
  if (!hasFeature('upfit_configurator') && !isAdmin) return null;

  // ═══ Home: recent designs + new ═══
  if (step === 'home') {
    return (
      <div style={{ padding: '16px 0 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>Upfit Designer</h1>
          <span style={{ flex: 1 }} />
          <button style={btn('primary')} onClick={() => { setMeta(BLANK_META); setUndoState(initialUndoable(emptyLayout())); setStep('vehicle'); }}>
            + New Design
          </button>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>
          Design a van upfit in 3D — pick the vehicle, lay out shelving and equipment, then turn the design into an estimate.
        </p>
        {designs.length === 0 ? (
          <div style={{ ...card, textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
            No designs yet — start your first one.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '10px' }}>
            {designs.map(d => {
              const plat = platformById.get(d.platform_id) || null;
              return (
                <div key={d.id} onClick={() => openDesign(d.id)} style={{ ...card, padding: 0, overflow: 'hidden', cursor: 'pointer' }}>
                  <div style={{ height: '120px', background: 'var(--subtle-bg, rgba(127,127,127,0.08))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {d.snapshot_path
                      ? <img src={imageUrl(d.snapshot_path)} alt={d.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No preview yet</span>}
                  </div>
                  <div style={{ padding: '10px 12px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{d.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {vehicleLabel(plat, d.wheelbase_label, d.roof_label) || 'Vehicle unknown'}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <span style={{ padding: '1px 7px', borderRadius: '999px', border: '1px solid var(--border)', fontWeight: 700, textTransform: 'capitalize' }}>{d.status}</span>
                      <span>{new Date(d.updated_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ═══ Step 1: vehicle choice ═══
  if (step === 'vehicle') {
    const platformsWithGeometry = platforms.filter(p => interiors.some(i => i.platform_id === p.id));
    return (
      <div style={{ padding: '16px 0 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
          <button style={btn()} onClick={() => setStep('home')}>← Back</button>
          <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>Choose the vehicle</h1>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>
          Pick the platform, then the wheelbase / roof combination. Only combinations with interior geometry on file can be designed —
          more can be added under Admin → Vehicle Interiors.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {platformsWithGeometry.map(p => (
            <div key={p.id} style={{ ...card, display: 'flex', gap: '14px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ width: '120px', height: '80px', borderRadius: '10px', overflow: 'hidden', background: 'var(--subtle-bg, rgba(127,127,127,0.08))', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {p.image_path
                  ? <img src={imageUrl(p.image_path)} alt={p.label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{p.label}</span>}
              </div>
              <div style={{ flex: '1 1 240px' }}>
                <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>{p.label}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {combosFor(p.id).map(combo => (
                    <button
                      key={combo.id}
                      onClick={() => pickCombo(p, combo)}
                      style={{ ...btn(), padding: '9px 14px', fontSize: '12px' }}
                    >
                      {/^\d/.test(combo.wheelbase_label) ? `${combo.wheelbase_label}" WB` : combo.wheelbase_label}
                      {combo.roof_label ? ` · ${combo.roof_label} roof` : ''}
                      <span style={{ display: 'block', fontSize: '10px', fontWeight: 500, color: 'var(--text-muted)', marginTop: '2px' }}>
                        {combo.geometry.cargo.length}&quot; long · {combo.geometry.cargo.height}&quot; tall
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {platformsWithGeometry.length === 0 && (
            <div style={{ ...card, color: 'var(--text-muted)', fontSize: '13px' }}>No vehicle interiors on file yet.</div>
          )}
        </div>
      </div>
    );
  }

  // ═══ Step 2/3: the 3D editor ═══
  return (
    <div style={{ padding: '10px 0 30px' }}>
      {/* Header: name, vehicle, save */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
        <button style={btn()} onClick={() => setStep('home')} title="Back to designs">←</button>
        <input
          value={meta.name}
          onChange={e => { setMeta(m => ({ ...m, name: e.target.value })); setDirty(true); }}
          placeholder="Design name"
          style={{ flex: '1 1 200px', minWidth: '160px', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '14px', fontWeight: 700 }}
        />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{vehicleLabel(meta.platform, meta.wheelbase, meta.roof)}</span>
        <button style={btn()} onClick={() => setStep('vehicle')}>Change vehicle</button>
        <button style={btn('primary', saving)} disabled={saving} onClick={saveWithSnapshot}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved ✓'}
        </button>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
        <button style={btn('primary')} onClick={() => setBrowserOpen(true)}>+ Add Parts</button>
        <button style={btn(undefined, !canUndo)} disabled={!canUndo} onClick={doUndo} title="Undo (Ctrl+Z)">↺ Undo</button>
        <button style={btn(undefined, !canRedo)} disabled={!canRedo} onClick={doRedo} title="Redo (Ctrl+Y)">↻ Redo</button>
        <button style={btn(undefined, !selectedItem)} disabled={!selectedItem} onClick={rotateSelected} title="Rotate 90° (R)">⟳ Rotate</button>
        <button style={btn(undefined, !selectedItem)} disabled={!selectedItem} onClick={duplicateSelected} title="Duplicate (D)">⧉ Duplicate</button>
        <button style={btn(!selectedItem ? undefined : 'danger', !selectedItem)} disabled={!selectedItem} onClick={removeSelected} title="Remove (Del)">✕ Remove</button>
        <button style={btn()} onClick={() => setShowLabels(v => !v)}>{showLabels ? 'Hide labels' : 'Show labels'}</button>
        <span style={{ flex: 1 }} />
        {(warnings.overlaps.length > 0 || warnings.outOfShell.length > 0 || warnings.overWheelwell.length > 0) && (
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#ef4444' }}>
            {warnings.overlaps.length > 0 && `${warnings.overlaps.length} overlap${warnings.overlaps.length === 1 ? '' : 's'} `}
            {warnings.outOfShell.length > 0 && `${warnings.outOfShell.length} outside van `}
            {warnings.overWheelwell.length > 0 && `${warnings.overWheelwell.length} on wheel well`}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: '10px', alignItems: 'stretch', flexWrap: 'wrap' }}>
        {/* Scene */}
        <div style={{ position: 'relative', flex: '1 1 480px', minWidth: '300px', height: 'calc(100vh - 300px)', minHeight: '420px', borderRadius: '14px', overflow: 'hidden', border: '1px solid var(--border)', background: '#171b22' }}>
          {interiorGeom ? (
            <UpfitSceneLazy
              key={sceneKey}
              interior={interiorGeom}
              items={present.items}
              selectedUid={selectedUid}
              warningUids={warningUids}
              guides={guides}
              showLabels={showLabels}
              editable
              onSelect={setSelectedUid}
              onItemMove={handleItemMove}
              onContextLost={handleContextLost}
              onCaptureReady={handleCaptureReady}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: '13px' }}>
              No interior geometry for this vehicle.
            </div>
          )}

          {/* Touch control strip — Capacitor webviews have no keyboard. */}
          {selectedItem && (
            <div style={{ position: 'absolute', left: '50%', bottom: '10px', transform: 'translateX(-50%)', display: 'flex', gap: '6px', padding: '6px 8px', borderRadius: '12px', background: 'rgba(15,18,24,0.85)', border: '1px solid rgba(255,255,255,0.12)' }}>
              {([
                ['←', () => nudgeSelected(-1, 0, 0)],
                ['→', () => nudgeSelected(1, 0, 0)],
                ['↑', () => nudgeSelected(0, 0, -1)],
                ['↓', () => nudgeSelected(0, 0, 1)],
                ...(selectedItem.zone === 'wall_left' || selectedItem.zone === 'wall_right'
                  ? [['▲', () => nudgeSelected(0, 1, 0)], ['▼', () => nudgeSelected(0, -1, 0)]] as [string, () => void][]
                  : []),
                ['⟳', rotateSelected],
                ['⧉', duplicateSelected],
                ['✕', removeSelected],
              ] as [string, () => void][]).map(([label, fn], i) => (
                <button key={i} onClick={fn} style={{ width: '34px', height: '34px', borderRadius: '9px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontSize: '14px', fontWeight: 800, cursor: 'pointer' }}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Parts list panel */}
        <div style={{ flex: '0 1 300px', minWidth: '260px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ ...card, flex: 1, overflowY: 'auto', maxHeight: 'calc(100vh - 300px)' }}>
            <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              Parts on this design
            </div>
            {lines.length === 0 && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Nothing yet — Add Parts opens the catalog, pre-filtered to this vehicle.
              </div>
            )}
            {lines.map(l => (
              <div key={`${l.item_number}-${l.placed}`} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', minWidth: '28px' }}>{l.quantity}×</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description}</div>
                  <div style={{ fontSize: '10px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                    {l.item_number}
                    {!l.placed && <span style={{ color: 'var(--warning, #eab308)', fontFamily: 'inherit', fontWeight: 700 }}> · not in 3D</span>}
                  </div>
                </div>
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{money(l.quantity * l.unit_price)}</span>
              </div>
            ))}
            {lines.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '8px', fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
                <span>Parts subtotal</span>
                <span>{money(partsSubtotal)}</span>
              </div>
            )}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Drag to move · R rotate · D duplicate · Del remove · arrows nudge (Shift = 6&quot;) · PgUp/PgDn raise wall items
          </div>
        </div>
      </div>

      <PartCatalogBrowser
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onAdd={addPart}
        onAddKit={addKit}
        isAdmin={isAdmin}
        variant="modal"
        initialPlatformId={meta.platform?.id}
        initialWheelbase={meta.wheelbase}
        initialRoof={meta.roof}
      />
    </div>
  );
}
