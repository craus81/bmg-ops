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
import CustomerPicker from '@/components/CustomerPicker';
import { apiFetch } from '@/lib/api-client';
import { computeTotals } from '@/lib/estimate-totals';
import { CompanyLetterhead, fetchCompanyLetterhead } from '@/lib/company-profile';
import {
  AutoLayoutEntry, InteriorGeometry, LayoutState, TRADES, UndoableLayout,
  aggregateLines, autoLayout, checkpoint, emptyLayout, estimateLinesFromLayout, footprint,
  initialUndoable, layoutWarnings, parseLayout, redo, snapPosition, undo, undoableApply,
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

interface TemplateRow {
  id: string; name: string; trade: string | null;
  wheelbase_label: string; roof_label: string;
  snapshot_path: string | null; layout: unknown;
}

interface DesignMeta {
  id: string | null;
  name: string;
  customerId: string | null;
  customerName: string;
  customerNetsuiteId: string | null;
  platform: Platform | null;
  wheelbase: string;
  roof: string;
  interior: InteriorRow | null;
  status: string;
  estimateId: string | null;
}

const BLANK_META: DesignMeta = {
  id: null, name: '', customerId: null, customerName: '', customerNetsuiteId: null,
  platform: null, wheelbase: '', roof: '', interior: null, status: 'draft', estimateId: null,
};

type Step = 'home' | 'vehicle' | 'package' | 'design' | 'review';

// Match the estimate API's own defaults so the review totals equal what the
// draft estimate will say (src/app/api/estimates/route.ts).
const DEFAULT_TAX_RATE = 0.0795;
const DEFAULT_LABOR_RATE = 85;

interface SnapshotData { blob: Blob; dataUrl: string; width: number; height: number }

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
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [templateModal, setTemplateModal] = useState<{ name: string; trade: string } | null>(null);
  const [reviewSnapshot, setReviewSnapshot] = useState<SnapshotData | null>(null);
  const [letterhead, setLetterhead] = useState<CompanyLetterhead | null>(null);
  const [creatingEstimate, setCreatingEstimate] = useState(false);
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

  // Letterhead pre-fetched on load, not at click time — the PDF opens a
  // window inside the click gesture and an await would trip popup blockers.
  useEffect(() => {
    if (authLoading || !user) return;
    fetchCompanyLetterhead().then(setLetterhead);
  }, [authLoading, user]);

  const openDesign = async (designId: string) => {
    const { data: row, error } = await supabase
      .from('upfit_designs')
      .select('id, name, customer_id, platform_id, wheelbase_label, roof_label, interior_id, layout, status, estimate_id, customers(company_name, netsuite_id)')
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
    const customer = (row as any).customers as { company_name: string | null; netsuite_id: string | null } | null;
    setMeta({
      id: row.id, name: row.name, customerId: row.customer_id,
      customerName: customer?.company_name || '', customerNetsuiteId: customer?.netsuite_id || null,
      platform, wheelbase: row.wheelbase_label, roof: row.roof_label, interior,
      status: row.status, estimateId: row.estimate_id,
    });
    setUndoState(initialUndoable(parseLayout(row.layout)));
    setSelectedUid(null);
    setReviewSnapshot(null);
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
    // Step 2: trade packages for this platform (or blank). Straight to the
    // editor when this design already has a layout going.
    if (undoState.present.items.length > 0 || undoState.present.unplaced.length > 0) {
      setStep('design');
    } else {
      setTemplates(null);
      loadTemplates(platform.id);
      setStep('package');
    }
  };

  const loadTemplates = async (platformId: string) => {
    const { data } = await supabase
      .from('upfit_designs')
      .select('id, name, trade, wheelbase_label, roof_label, snapshot_path, layout')
      .eq('is_template', true)
      .eq('platform_id', platformId)
      .order('trade')
      .order('name')
      .limit(100);
    setTemplates((data as TemplateRow[]) || []);
  };

  /** Clone a template's layout into this design (fresh uids — the template
   *  row itself must never be edited by accident). */
  const applyTemplate = (t: TemplateRow) => {
    const layout = parseLayout(t.layout);
    const items = layout.items.map(i => ({ ...i, uid: newUid() }));
    setUndoState(initialUndoable({ ...layout, items }));
    setDirty(true);
    setStep('design');
  };

  const tradeLabel = (key: string | null) => TRADES.find(t => t.key === key)?.label || key || 'General';

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
          part_id: o.part_id, netsuite_item_id: o.netsuite_item_id ?? null,
          item_number: o.item_number, label: o.label, category: o.category,
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
    netsuite_item_id: p.netsuite_id,
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
        part_id: null, netsuite_item_id: null, item_number: 'ASSEMBLY', label: `${kit.name} — assembly labor`,
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
  /** upfit_designs.customer_id is the LOCAL customers.id; the picker hands
   *  back a name + NetSuite id, so resolve when we can (non-fatal when not). */
  const resolveCustomerId = async (): Promise<string | null> => {
    if (meta.customerId) return meta.customerId;
    if (!meta.customerNetsuiteId) return null;
    const { data } = await supabase
      .from('customers')
      .select('id')
      .eq('netsuite_id', meta.customerNetsuiteId)
      .maybeSingle();
    return data?.id || null;
  };

  const saveDesign = async (): Promise<string | null> => {
    if (!meta.platform || !meta.interior) return null;
    setSaving(true);
    try {
      const customerId = await resolveCustomerId();
      if (customerId !== meta.customerId) setMeta(m => ({ ...m, customerId }));
      const layoutJson = JSON.parse(JSON.stringify(present));
      if (meta.id) {
        const { error } = await supabase
          .from('upfit_designs')
          .update({
            name: meta.name || 'Untitled design',
            customer_id: customerId,
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
          customer_id: customerId,
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

  /** Capture the 3D view with the pixel size the PDF needs. Only possible
   *  while the scene is mounted (design step) — review keeps the last one. */
  const captureSnapshotData = async (): Promise<SnapshotData | null> => {
    const fn = captureFnRef.current;
    if (!fn) return null;
    const blob = await fn();
    if (!blob) return null;
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = () => rej(new Error('snapshot read failed'));
      r.readAsDataURL(blob);
    });
    const dims = await new Promise<{ width: number; height: number }>((res, rej) => {
      const img = new Image();
      img.onload = () => res({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => rej(new Error('snapshot decode failed'));
      img.src = dataUrl;
    });
    return { blob, dataUrl, ...dims };
  };

  const uploadSnapshot = async (designId: string, blob: Blob): Promise<string | null> => {
    // Timestamped path so caches never serve a stale render (wrap-quote
    // diagram pattern); failure is non-fatal everywhere this is used.
    try {
      const path = `upfit-designs/${designId}-${Date.now()}.png`;
      const up = await storage.from('photos').upload(path, blob, { contentType: 'image/png', upsert: true });
      if (up.error) return null;
      await supabase.from('upfit_designs').update({ snapshot_path: path }).eq('id', designId);
      return path;
    } catch {
      return null;
    }
  };

  // Design thumbnail: captured on save, non-fatal on failure.
  const saveWithSnapshot = async () => {
    const id = await saveDesign();
    if (!id) return;
    try {
      const snap = await captureSnapshotData();
      if (snap) {
        setReviewSnapshot(snap);
        await uploadSnapshot(id, snap.blob);
      }
    } catch { /* thumbnail is a nice-to-have */ }
  };

  /** Leave the editor for Review & Quote — the capture must happen NOW,
   *  while the canvas still exists. */
  const goToReview = async () => {
    try {
      const snap = await captureSnapshotData();
      if (snap) setReviewSnapshot(snap);
    } catch { /* review degrades to text-only */ }
    setStep('review');
  };

  // ── Save as template (trade package) ──
  const saveTemplate = async () => {
    if (!templateModal || !meta.platform || !meta.interior) return;
    const name = templateModal.name.trim();
    if (!name) return;
    setSaving(true);
    try {
      const snap = await captureSnapshotData().catch(() => null);
      const { data, error } = await supabase
        .from('upfit_designs')
        .insert({
          name,
          is_template: true,
          trade: templateModal.trade || null,
          platform_id: meta.platform.id,
          wheelbase_label: meta.wheelbase,
          roof_label: meta.roof,
          interior_id: meta.interior.id,
          layout: JSON.parse(JSON.stringify(present)),
          created_by: profile?.id || null,
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      if (snap) await uploadSnapshot(data.id, snap.blob);
      setTemplateModal(null);
      dialog.alert(`Template "${name}" saved — it now shows as a package option for every ${meta.platform.label} design.`);
    } catch (err: any) {
      dialog.alert(`Template save failed: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  // ── Create the draft estimate (the Review & Quote handoff) ──
  const createEstimate = async () => {
    if (creatingEstimate) return;
    setCreatingEstimate(true);
    try {
      const designId = await saveDesign();
      if (!designId) return;
      const res = await apiFetch('/api/estimates', {
        method: 'POST',
        body: JSON.stringify({
          title: meta.name || 'Upfit design',
          customer_id: meta.customerId,
          customer_name: meta.customerName || null,
          customer_netsuite_id: meta.customerNetsuiteId,
          status: 'draft',
          vehicle_platform_id: meta.platform?.id || null,
          vehicle_wheelbase: meta.wheelbase || null,
          vehicle_roof: meta.roof || null,
          line_items: estimateLinesFromLayout(present),
          created_by: profile?.id || null,
          internal_notes: `Created from 3D upfit design "${meta.name}".`,
        }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
      await supabase
        .from('upfit_designs')
        .update({ estimate_id: body.id, status: 'quoted', updated_at: new Date().toISOString() })
        .eq('id', designId);
      if (reviewSnapshot) await uploadSnapshot(designId, reviewSnapshot.blob);
      router.push(deepLinks.estimate(body.id));
    } catch (err: any) {
      dialog.alert(`Estimate creation failed: ${err.message || err}`);
    } finally {
      setCreatingEstimate(false);
    }
  };

  const downloadPdf = async () => {
    const linesNow = aggregateLines(latest.current.present);
    const totals = computeTotals(
      linesNow.map(l => ({ quantity: l.quantity, unit_price: l.unit_price, labor_hours: l.labor_hours })),
      DEFAULT_TAX_RATE, false, DEFAULT_LABOR_RATE, null,
    );
    const { exportUpfitDesignPDF } = await import('@/lib/upfit-design-pdf');
    exportUpfitDesignPDF({
      designName: meta.name || 'Upfit design',
      vehicle: vehicleLabel(meta.platform, meta.wheelbase, meta.roof),
      customerName: meta.customerName || null,
      snapshot: reviewSnapshot ? { dataUrl: reviewSnapshot.dataUrl, width: reviewSnapshot.width, height: reviewSnapshot.height } : null,
      lines: linesNow,
      totals,
      taxExempt: false,
      laborRate: DEFAULT_LABOR_RATE,
      letterhead,
    });
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

  // ═══ Step 2: trade package or blank layout ═══
  if (step === 'package') {
    return (
      <div style={{ padding: '16px 0 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
          <button style={btn()} onClick={() => setStep('vehicle')}>← Back</button>
          <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>Start from a package?</h1>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>
          {vehicleLabel(meta.platform, meta.wheelbase, meta.roof)} — pick a trade package as a starting point, or begin with an
          empty van. (Flat parts bundles are also available inside the catalog browser&apos;s Packages strip.)
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px' }}>
          <div
            onClick={() => setStep('design')}
            style={{ ...card, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '180px', borderStyle: 'dashed' }}
          >
            <div style={{ fontSize: '28px', marginBottom: '6px' }}>▢</div>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>Blank layout</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Start with an empty van</div>
          </div>
          {templates === null && (
            <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '180px', color: 'var(--text-muted)', fontSize: '12px' }}>
              Loading packages…
            </div>
          )}
          {(templates || []).map(t => {
            const differentCombo = t.wheelbase_label !== meta.wheelbase || t.roof_label !== meta.roof;
            return (
              <div key={t.id} onClick={() => applyTemplate(t)} style={{ ...card, padding: 0, overflow: 'hidden', cursor: 'pointer' }}>
                <div style={{ height: '110px', background: 'var(--subtle-bg, rgba(127,127,127,0.08))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {t.snapshot_path
                    ? <img src={imageUrl(t.snapshot_path)} alt={t.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No preview</span>}
                </div>
                <div style={{ padding: '10px 12px' }}>
                  <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--accent, #2563eb)' }}>
                    {tradeLabel(t.trade)}
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>{t.name}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '3px' }}>
                    {parseLayout(t.layout).items.length} placed part{parseLayout(t.layout).items.length === 1 ? '' : 's'}
                    {differentCombo && (
                      <span style={{ color: 'var(--warning, #eab308)', fontWeight: 700 }}>
                        {' '}· built for {t.wheelbase_label}{t.roof_label ? ` ${t.roof_label}` : ''} — check fit after applying
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {templates !== null && templates.length === 0 && (
            <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '180px', color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center', padding: '14px' }}>
              No packages for this platform yet — design one and use &quot;Save as template&quot;.
            </div>
          )}
        </div>
      </div>
    );
  }

  // ═══ Step 4: Review & Quote ═══
  if (step === 'review') {
    const totals = computeTotals(
      lines.map(l => ({ quantity: l.quantity, unit_price: l.unit_price, labor_hours: l.labor_hours })),
      DEFAULT_TAX_RATE, false, DEFAULT_LABOR_RATE, null,
    );
    return (
      <div style={{ padding: '16px 0 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
          <button style={btn()} onClick={() => setStep('design')}>← Back to design</button>
          <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>Review &amp; Quote</h1>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{meta.name} · {vehicleLabel(meta.platform, meta.wheelbase, meta.roof)}</span>
        </div>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Layout preview */}
          <div style={{ flex: '1 1 380px', minWidth: '300px' }}>
            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              {reviewSnapshot ? (
                <img src={reviewSnapshot.dataUrl} alt="Layout" style={{ width: '100%', display: 'block' }} />
              ) : (
                <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                  No 3D capture — go back to the design step once so the view can be photographed.
                </div>
              )}
            </div>
          </div>

          {/* Summary + actions */}
          <div style={{ flex: '0 1 360px', minWidth: '280px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={card}>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '6px' }}>Customer</div>
              <CustomerPicker
                value={meta.customerName}
                netsuiteId={meta.customerNetsuiteId}
                onChange={({ customer, customerNetsuiteId }) => {
                  setMeta(m => ({ ...m, customerName: customer, customerNetsuiteId, customerId: null }));
                  setDirty(true);
                }}
                placeholder="Search customers…"
              />
            </div>

            <div style={card}>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                Parts ({lines.reduce((s, l) => s + l.quantity, 0)})
              </div>
              {lines.map(l => (
                <div key={`${l.item_number}-${l.placed}`} style={{ display: 'flex', gap: '8px', fontSize: '12px', padding: '3px 0', color: 'var(--text-primary)' }}>
                  <span style={{ fontWeight: 800, minWidth: '26px' }}>{l.quantity}×</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.description}{!l.placed && <span style={{ color: 'var(--warning, #eab308)' }}> *</span>}
                  </span>
                  <span style={{ fontWeight: 700 }}>{money(l.quantity * l.unit_price)}</span>
                </div>
              ))}
              {lines.some(l => !l.placed) && (
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>* priced but not shown in 3D (no dimensions on file)</div>
              )}
              <div style={{ borderTop: '1px solid var(--border)', marginTop: '8px', paddingTop: '8px', fontSize: '12px', color: 'var(--text-primary)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>Parts subtotal</span><span>{money(totals.subtotal)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>Labor ({totals.labor_hours} h @ {money(DEFAULT_LABOR_RATE)}/h)</span><span>{money(totals.labor_total)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>Tax</span><span>{money(totals.tax_amount)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '14px', fontWeight: 800 }}><span>Estimated total</span><span>{money(totals.grand_total)}</span></div>
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Standard tax &amp; labor rates — final numbers live on the estimate.
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button style={btn()} onClick={downloadPdf}>⬇ Download layout PDF</button>
              {meta.estimateId ? (
                <>
                  <button style={btn('primary')} onClick={() => router.push(deepLinks.estimate(meta.estimateId!))}>Open estimate</button>
                  <button style={btn(undefined, creatingEstimate)} disabled={creatingEstimate} onClick={createEstimate}>
                    {creatingEstimate ? 'Creating…' : 'Create another estimate'}
                  </button>
                </>
              ) : (
                <button style={btn('primary', creatingEstimate || lines.length === 0)} disabled={creatingEstimate || lines.length === 0} onClick={createEstimate}>
                  {creatingEstimate ? 'Creating…' : 'Create draft estimate →'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ═══ Step 3: the 3D editor ═══
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
        <button
          style={btn()}
          title="Save this layout as a reusable trade package for this platform"
          onClick={() => setTemplateModal({ name: meta.name ? `${meta.name} package` : 'New package', trade: TRADES[0].key })}
        >
          Save as template
        </button>
        <button style={btn(undefined, saving)} disabled={saving} onClick={saveWithSnapshot}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved ✓'}
        </button>
        <button style={btn('primary')} onClick={goToReview}>Review &amp; Quote →</button>
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

      {/* Save-as-template modal — a design becomes a trade package. */}
      {templateModal && (
        <div onClick={() => setTemplateModal(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '16px' }}>
          <div onClick={e => e.stopPropagation()} style={{ ...card, width: '100%', maxWidth: '380px', background: 'var(--bg, var(--card))' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '10px' }}>Save as trade package</div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '12px' }}>
              This layout (with 3D positions) becomes a starting option for every {meta.platform?.label} design.
            </div>
            <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '4px' }}>Package name</div>
            <input
              value={templateModal.name}
              onChange={e => setTemplateModal(m => m && { ...m, name: e.target.value })}
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px', marginBottom: '10px' }}
            />
            <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '4px' }}>Trade</div>
            <select
              value={templateModal.trade}
              onChange={e => setTemplateModal(m => m && { ...m, trade: e.target.value })}
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px', marginBottom: '14px' }}
            >
              {TRADES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button style={btn()} onClick={() => setTemplateModal(null)}>Cancel</button>
              <button style={btn('primary', saving || !templateModal.name.trim())} disabled={saving || !templateModal.name.trim()} onClick={saveTemplate}>
                {saving ? 'Saving…' : 'Save package'}
              </button>
            </div>
          </div>
        </div>
      )}

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
