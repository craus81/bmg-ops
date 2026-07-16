'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { storage } from '@/lib/storage';
import { apiFetch } from '@/lib/api-client';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';
import { theme } from '@/lib/theme';

// Manual wrap-quote estimator (WrapUP-style): pick a 1:20 vehicle outline
// template, draw measurement shapes over it, price by substrate + labor,
// then save and email the quote. See migrations/128-wrap-quote-estimator.sql
// for the data model; the AI proof-analysis flow lives at /admin/quotes.

interface Template {
  id: string;
  name: string;
  make: string;
  model: string;
  year: string | null;
  variant: string | null;
  scale: string | null;
  template_code: string | null;
  template_image_path: string | null;
  px_per_in: number | null;
  overall_length_in: number | null;
  is_active: boolean | null;
}

// "Film" is the material (a substrate is the surface being wrapped); the
// table keeps its historical wrap_substrates name. A film may be paired with
// an overlaminate that prices as one combined material, and carries a color
// so mixed-film vehicles read at a glance on the canvas.
interface Film {
  id: string;
  name: string;
  price_per_sqft: number;
  bleed_in: number;
  laminate_name: string | null;
  laminate_price_per_sqft: number;
  labor_per_sqft: number;
  color: string | null;
  is_active: boolean | null;
}

const FILM_COLORS = ['#06b6d4', '#a78bfa', '#f472b6', '#4ade80', '#fb923c', '#facc15', '#60a5fa', '#f87171'];
const filmLabel = (f: Film) => f.laminate_name ? `${f.name} + ${f.laminate_name}` : f.name;
const filmRate = (f: Film) => num(f.price_per_sqft) + num(f.laminate_price_per_sqft);

interface LaborSection { flat: number; hourly: number; hours: number; extra: number }

interface Company {
  name?: string; address?: string; city?: string; state?: string; zip?: string;
  phone?: string; email?: string; logo_path?: string;
}

// File attached to the emailed quote (proof, vinyl specs, …). Uploaded to
// the vehicle-templates bucket under quote-attachments/ when picked.
interface QuoteAttachment {
  name: string;
  path: string;
  size: number;
  type: string | null;
}

interface Settings {
  company: Company;
  tax_rate: number;
  design: LaborSection;
  preparation: LaborSection;
  installation: LaborSection;
}

type MType = 'box' | 'circle' | 'roof' | 'hood';

// Geometry is stored in template-image pixel coordinates so shapes redraw
// at any display size; dim1_in/dim2_in are the real-world dimensions and are
// the source of truth for pricing (the user can override them numerically).
interface Measurement {
  id: string;
  name: string;
  type: MType;
  rect?: { x: number; y: number; w: number; h: number };
  line1?: { x1: number; y1: number; x2: number; y2: number };
  line2?: { x1: number; y1: number; x2: number; y2: number };
  dim1_in: number;
  dim2_in: number;
  qty: number;
  substrate_id: string | null;
}

interface WrapQuote {
  id: string;
  quote_number: string;
  template_id: string | null;
  vehicle_description: string | null;
  customer_id: string | null;
  customer: any;
  project_type: string | null;
  project_notes: string | null;
  measurements: any[];
  labor: any;
  total_area_sqft: number;
  materials_total: number;
  labor_total: number;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  status: string;
  sent_at: string | null;
  sent_to: string | null;
  diagram_path: string | null;
  attachments: QuoteAttachment[] | null;
  archived_at: string | null;
  netsuite_estimate_id: string | null;
  netsuite_estimate_number: string | null;
  created_at: string;
}

type Tab = 'estimator' | 'quote' | 'history' | 'pricing' | 'company' | 'templates';
type Tool = 'select' | 'box' | 'circle' | 'roof' | 'hood' | 'calibrate';

const EMPTY_LABOR: LaborSection = { flat: 0, hourly: 0, hours: 0, extra: 0 };
const fmt = (n: number) => (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v: any) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

const laborSectionTotal = (s: LaborSection) => num(s.flat) + num(s.hourly) * num(s.hours) + num(s.extra);

// Area of one unit, in ft². Bleed extends each dimension on both sides
// (print size), which is what gets billed.
const unitAreaSqft = (m: Measurement, bleedIn: number) => {
  const d1 = Math.max(0, num(m.dim1_in) + 2 * bleedIn);
  const d2 = Math.max(0, num(m.dim2_in) + 2 * bleedIn);
  if (m.type === 'circle') return (Math.PI * (d1 / 2) * (d2 / 2)) / 144;
  return (d1 * d2) / 144;
};

const templateLabel = (t: Template) =>
  [t.year, t.make, t.model, t.variant].filter(Boolean).join(' ');

// Free-text template search: every space-separated term must match somewhere
// in the label, name, or code ("transit 2023 high" finds 2023 High Roof
// Transits regardless of word order).
const matchesTemplateSearch = (t: Template, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${templateLabel(t)} ${t.name || ''} ${t.template_code || ''}`.toLowerCase();
  return q.split(/\s+/).every(term => hay.includes(term));
};

const imageUrl = (path: string | null) => {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  return storage.from('vehicle-templates').getPublicUrl(path).data.publicUrl;
};

export default function WrapQuotePage() {
  const { user, isAdmin, isSales, isGraphicsProduction, loading: authLoading } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();
  const hasAccess = isAdmin || isSales || isGraphicsProduction;

  const [tab, setTab] = useState<Tab>('estimator');
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [substrates, setSubstrates] = useState<Film[]>([]);
  const [settings, setSettings] = useState<Settings>({ company: {}, tax_rate: 0, design: EMPTY_LABOR, preparation: EMPTY_LABOR, installation: EMPTY_LABOR });
  const [history, setHistory] = useState<WrapQuote[]>([]);

  // ----- Estimator state -----
  const [yearFilter, setYearFilter] = useState('');
  const [makeFilter, setMakeFilter] = useState('');
  const [tplSearch, setTplSearch] = useState('');
  const [tplGridSearch, setTplGridSearch] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [imgDim, setImgDim] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Film applied to newly drawn shapes: sticks to the last film the user
  // picked instead of resetting to the first film in the list on every box.
  const [lastFilmId, setLastFilmId] = useState<string | null>(null);
  // In-progress drag (image-pixel coords)
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Roof/hood need two lines; after the first drag we hold the partial
  // measurement here until the second drag completes it.
  const [pendingPair, setPendingPair] = useState<Measurement | null>(null);
  // Calibration: after drawing the line, ask for its real length.
  const [calibLine, setCalibLine] = useState<{ lenPx: number } | null>(null);
  const [calibInches, setCalibInches] = useState('');
  const svgRef = useRef<SVGSVGElement | null>(null);

  // ----- Quote state -----
  const [customer, setCustomer] = useState<any>({ name: '', address: '', city: '', state: '', zip: '', phone: '', email: '', email_cc: '' });
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [custSearch, setCustSearch] = useState('');
  const [custMatches, setCustMatches] = useState<{ id: string; company_name: string; entity_id: string | null; email: string | null; phone: string | null; address: string | null }[]>([]);
  const [projectType, setProjectType] = useState('');
  const [projectNotes, setProjectNotes] = useState('');
  const [savedQuoteId, setSavedQuoteId] = useState<string | null>(null);
  const [quoteNumber, setQuoteNumber] = useState('');
  const [sending, setSending] = useState(false);
  const [viewQuote, setViewQuote] = useState<WrapQuote | null>(null);
  const [attachments, setAttachments] = useState<QuoteAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sendMode, setSendMode] = useState<'full' | 'quote_only' | 'coverage_only' | 'netsuite_pdf'>('full');

  // Deep link from search/popout: ?id= opens that quote's detail view over
  // the history tab once the quote list has loaded.
  useEffect(() => {
    const qid = searchParams.get('id');
    if (!qid || history.length === 0) return;
    const q = history.find(h => h.id === qid);
    if (q) {
      setTab('history');
      setViewQuote(q);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: deep-link once after load
  }, [history, searchParams]);

  // Open the NetSuite estimate PDF in a new tab (the browser's PDF viewer
  // covers viewing and printing).
  const viewEstimatePdf = async (estimateId: string | null) => {
    if (!estimateId) return;
    const { ok, error } = await openNetSuitePdf('estimate', estimateId);
    if (!ok) await dialog.alert(`Could not open the NetSuite PDF: ${error}`);
  };
  const [pushingNetsuite, setPushingNetsuite] = useState(false);

  // ----- Pricing tab state (edit copies) -----
  const [subSel, setSubSel] = useState(''); // '' = new
  const [subForm, setSubForm] = useState({ name: '', price_per_sqft: '', bleed_in: '', laminate_name: '', laminate_price_per_sqft: '', labor_per_sqft: '', color: '' });
  const [savingSettings, setSavingSettings] = useState(false);

  // ----- Templates tab state -----
  const [tplForm, setTplForm] = useState({ year: '', make: '', model: '', variant: '', code: '', length: '' });
  const [tplFile, setTplFile] = useState<File | null>(null);
  const [tplUploading, setTplUploading] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibStatus, setCalibStatus] = useState('');

  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    setLoading(true);
    const [tplRes, subRes, setRes, histRes] = await Promise.all([
      supabase.from('vehicle_templates').select('id, name, make, model, year, variant, scale, template_code, template_image_path, px_per_in, overall_length_in, is_active').not('template_image_path', 'is', null).order('make').order('model'),
      supabase.from('wrap_substrates').select('*').order('name'),
      supabase.from('wrap_quote_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.from('wrap_quotes').select('*').order('created_at', { ascending: false }).limit(200),
    ]);
    setTemplates((tplRes.data || []) as Template[]);
    setSubstrates((subRes.data || []) as Film[]);
    if (setRes.data) {
      setSettings({
        company: setRes.data.company || {},
        tax_rate: num(setRes.data.tax_rate),
        design: { ...EMPTY_LABOR, ...(setRes.data.design || {}) },
        preparation: { ...EMPTY_LABOR, ...(setRes.data.preparation || {}) },
        installation: { ...EMPTY_LABOR, ...(setRes.data.installation || {}) },
      });
    }
    setHistory((histRes.data || []) as WrapQuote[]);
    setLoading(false);
  };

  // Debounced NetSuite customer search for the quote tab
  useEffect(() => {
    const q = custSearch.trim();
    if (q.length < 2) { setCustMatches([]); return; }
    const t = setTimeout(async () => {
      const escaped = q.replace(/[%,()]/g, ' ');
      const { data } = await supabase
        .from('customers')
        .select('id, company_name, entity_id, email, phone, address')
        .or(`company_name.ilike.%${escaped}%,entity_id.ilike.%${escaped}%`)
        .order('company_name')
        .limit(8);
      setCustMatches((data || []) as typeof custMatches);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [custSearch]);

  const template = templates.find(t => t.id === templateId) || null;
  const activeSubstrates = substrates.filter(s => s.is_active !== false);
  const substrateById = (id: string | null) => substrates.find(s => s.id === id) || null;
  const defaultFilmId = () =>
    lastFilmId && activeSubstrates.some(s => s.id === lastFilmId) ? lastFilmId : activeSubstrates[0]?.id || null;

  // Retired templates stay in state (the Templates tab manages them) but are
  // hidden from the estimator's vehicle pickers.
  const activeTemplates = useMemo(() => templates.filter(t => t.is_active !== false), [templates]);
  const years = useMemo(() => [...new Set(activeTemplates.map(t => t.year).filter(Boolean) as string[])].sort().reverse(), [activeTemplates]);
  const makes = useMemo(() => [...new Set(activeTemplates.filter(t => !yearFilter || t.year === yearFilter).map(t => t.make))].sort(), [activeTemplates, yearFilter]);
  const templateOptions = useMemo(() =>
    activeTemplates.filter(t =>
      (!yearFilter || t.year === yearFilter) &&
      (!makeFilter || t.make === makeFilter) &&
      matchesTemplateSearch(t, tplSearch)),
    [activeTemplates, yearFilter, makeFilter, tplSearch]);

  // ----- Pricing math -----
  const measurementPricing = (m: Measurement) => {
    const sub = substrateById(m.substrate_id);
    const bleed = sub ? num(sub.bleed_in) : 0;
    const trimArea = unitAreaSqft(m, 0);
    const billedArea = unitAreaSqft(m, bleed);
    const unitPrice = billedArea * (sub ? filmRate(sub) : 0);
    return { sub, trimArea, billedArea, unitPrice, lineTotal: unitPrice * Math.max(1, num(m.qty)) };
  };

  // Stable per-film color for canvas shapes; stored color wins, else palette.
  const filmColor = (id: string | null) => {
    const f = substrateById(id);
    if (f?.color) return f.color;
    const idx = Math.max(0, activeSubstrates.findIndex(x => x.id === id));
    return FILM_COLORS[idx % FILM_COLORS.length];
  };

  // Per-quote install-labor rate overrides ($/sqft), keyed by film id.
  // Empty string = use the film's default labor_per_sqft.
  const [laborRates, setLaborRates] = useState<Record<string, string>>({});
  const filmLaborRate = (f: Film) => {
    const o = laborRates[f.id];
    return o !== undefined && o !== '' ? num(o) : num(f.labor_per_sqft);
  };

  const totals = useMemo(() => {
    let area = 0, materials = 0;
    // Billed (with-bleed) square footage per film — drives material buying
    // and per-film install labor.
    const byFilm = new Map<string, { film: Film; sqft: number }>();
    for (const m of measurements) {
      const p = measurementPricing(m);
      const qty = Math.max(1, num(m.qty));
      area += p.trimArea * qty;
      materials += p.lineTotal;
      if (p.sub) {
        const cur = byFilm.get(p.sub.id) || { film: p.sub, sqft: 0 };
        cur.sqft += p.billedArea * qty;
        byFilm.set(p.sub.id, cur);
      }
    }
    const filmTotals = [...byFilm.values()].map(({ film, sqft }) => ({
      id: film.id, label: filmLabel(film), sqft,
      laborRate: filmLaborRate(film), laborTotal: sqft * filmLaborRate(film),
    }));
    const filmLabor = filmTotals.reduce((sum, f) => sum + f.laborTotal, 0);
    const design = laborSectionTotal(settings.design);
    const prep = laborSectionTotal(settings.preparation);
    const install = laborSectionTotal(settings.installation);
    const labor = design + prep + install + filmLabor;
    const subtotal = materials + labor;
    const tax = subtotal * num(settings.tax_rate) / 100;
    return { area, materials, filmTotals, filmLabor, design, prep, install, labor, subtotal, tax, total: subtotal + tax };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- substrates feed measurementPricing
  }, [measurements, settings, substrates, laborRates]);

  // ----- Canvas drawing -----
  const svgPoint = (e: React.PointerEvent): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg || !imgDim) return null;
    const r = svg.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (imgDim.w / r.width),
      y: (e.clientY - r.top) * (imgDim.h / r.height),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool === 'select' || !imgDim) return;
    if (tool !== 'calibrate' && !template?.px_per_in) return;
    const p = svgPoint(e);
    if (!p) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = svgPoint(e);
    if (!p) return;
    if (editDrag) {
      const dx = p.x - editDrag.grabX, dy = p.y - editDrag.grabY;
      const ppi = num(template?.px_per_in);
      setMeasurements(prev => prev.map(m => {
        if (m.id !== editDrag.id || !m.rect) return m;
        if (editDrag.kind === 'move') {
          return { ...m, rect: { ...m.rect, x: editDrag.rect.x + dx, y: editDrag.rect.y + dy } };
        }
        const w = Math.max(4, editDrag.rect.w + dx);
        const h = Math.max(4, editDrag.rect.h + dy);
        return { ...m, rect: { ...m.rect, w, h }, dim1_in: ppi > 0 ? w / ppi : m.dim1_in, dim2_in: ppi > 0 ? h / ppi : m.dim2_in };
      }));
      return;
    }
    if (!drag) return;
    setDrag(d => d ? { ...d, x2: p.x, y2: p.y } : d);
  };

  const onPointerUp = () => {
    if (editDrag) { setEditDrag(null); return; }
    if (!drag || !imgDim) { setDrag(null); return; }
    const d = drag;
    setDrag(null);
    const wPx = Math.abs(d.x2 - d.x1);
    const hPx = Math.abs(d.y2 - d.y1);
    const lenPx = Math.sqrt(wPx * wPx + hPx * hPx);
    if (lenPx < 4) return; // ignore accidental clicks

    if (tool === 'calibrate') {
      setCalibLine({ lenPx });
      setCalibInches(template?.overall_length_in ? String(template.overall_length_in) : '');
      return;
    }

    const ppi = num(template?.px_per_in);
    if (!ppi) return;

    if (tool === 'box' || tool === 'circle') {
      const m: Measurement = {
        id: crypto.randomUUID(),
        name: `${tool === 'box' ? 'Area' : 'Circle'} ${measurements.length + 1}`,
        type: tool,
        rect: { x: Math.min(d.x1, d.x2), y: Math.min(d.y1, d.y2), w: wPx, h: hPx },
        dim1_in: wPx / ppi,
        dim2_in: hPx / ppi,
        qty: 1,
        substrate_id: defaultFilmId(),
      };
      setMeasurements(prev => [...prev, m]);
      setSelectedId(m.id);
      setTool('select');
      return;
    }

    // roof / hood: two line drags. Line 1 = length (side view),
    // line 2 = width (front/back view). Area = L1 × L2.
    const line = { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 };
    if (!pendingPair) {
      const m: Measurement = {
        id: crypto.randomUUID(),
        name: tool === 'roof' ? 'Roof' : 'Hood',
        type: tool as MType,
        line1: line,
        dim1_in: lenPx / ppi,
        dim2_in: 0,
        qty: 1,
        substrate_id: defaultFilmId(),
      };
      setPendingPair(m);
    } else {
      const m = { ...pendingPair, line2: line, dim2_in: lenPx / ppi };
      setMeasurements(prev => [...prev, m]);
      setSelectedId(m.id);
      setPendingPair(null);
      setTool('select');
    }
  };

  const saveCalibration = async () => {
    const inches = num(calibInches);
    if (!template || !calibLine || inches <= 0) return;
    const ppi = calibLine.lenPx / inches;
    await supabase.from('vehicle_templates').update({ px_per_in: ppi }).eq('id', template.id);
    setTemplates(prev => prev.map(t => t.id === template.id ? { ...t, px_per_in: ppi } : t));
    setCalibLine(null);
    setCalibInches('');
    setTool('select');
  };

  const updateMeasurement = (id: string, patch: Partial<Measurement>) => {
    // Remember the last film explicitly chosen so new shapes default to it.
    if (patch.substrate_id) setLastFilmId(patch.substrate_id);
    setMeasurements(prev => prev.map(m => {
      if (m.id !== id) return m;
      const next = { ...m, ...patch };
      // Typing a width/height reshapes the drawn box to match (boxes only —
      // roof/hood line pairs are numeric-first).
      const ppi = num(template?.px_per_in);
      if (next.type === 'box' && next.rect && ppi > 0 && ('dim1_in' in patch || 'dim2_in' in patch)) {
        next.rect = { ...next.rect, w: Math.max(2, num(next.dim1_in) * ppi), h: Math.max(2, num(next.dim2_in) * ppi) };
      }
      return next;
    }));
  };

  // Move/resize drag on already-drawn boxes (select mode). Move keeps the
  // dimensions; dragging the corner handle resizes and rewrites the inches.
  const [editDrag, setEditDrag] = useState<{ kind: 'move' | 'resize'; id: string; grabX: number; grabY: number; rect: { x: number; y: number; w: number; h: number } } | null>(null);

  const beginEditDrag = (e: React.PointerEvent, m: Measurement, kind: 'move' | 'resize') => {
    if (tool !== 'select' || !m.rect) return;
    e.stopPropagation();
    const pt = svgPoint(e);
    if (!pt) return;
    setSelectedId(m.id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setEditDrag({ kind, id: m.id, grabX: pt.x, grabY: pt.y, rect: { ...m.rect } });
  };

  const removeMeasurement = (id: string) => {
    setMeasurements(prev => prev.filter(m => m.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  // Clone a measurement (same dims/film/qty) offset a little so the copy
  // isn't hidden under the original.
  const duplicateMeasurement = (id: string) => {
    const src = measurements.find(m => m.id === id);
    if (!src) return;
    const OFFSET = 14;
    const copy: Measurement = {
      ...src,
      id: crypto.randomUUID(),
      name: `${src.name} copy`,
      rect: src.rect ? { ...src.rect, x: src.rect.x + OFFSET, y: src.rect.y + OFFSET } : undefined,
      line1: src.line1 ? { x1: src.line1.x1 + OFFSET, y1: src.line1.y1 + OFFSET, x2: src.line1.x2 + OFFSET, y2: src.line1.y2 + OFFSET } : undefined,
      line2: src.line2 ? { x1: src.line2.x1 + OFFSET, y1: src.line2.y1 + OFFSET, x2: src.line2.x2 + OFFSET, y2: src.line2.y2 + OFFSET } : undefined,
    };
    setMeasurements(prev => [...prev, copy]);
    setSelectedId(copy.id);
  };

  const selected = measurements.find(m => m.id === selectedId) || null;

  const resetEstimate = () => {
    setMeasurements([]);
    setSelectedId(null);
    setPendingPair(null);
    setSavedQuoteId(null);
    setQuoteNumber('');
  };

  // ----- Quote snapshot / save / email -----
  // Quote numbers are date-based: WQ-MMDDYY for the first quote of the day,
  // then WQ-MMDDYY-1, -2, … for additional quotes that day.
  const wqBase = () => {
    const d = new Date();
    return `WQ-${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getFullYear()).slice(-2)}`;
  };
  const nextQuoteNumber = async (): Promise<string> => {
    const base = wqBase();
    const { data } = await supabase.from('wrap_quotes').select('quote_number').like('quote_number', `${base}%`);
    const taken = new Set((data || []).map((r: { quote_number: string }) => r.quote_number));
    if (!taken.has(base)) return base;
    for (let n = 1; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  };

  const buildSnapshot = () => {
    const lines = measurements.map(m => {
      const p = measurementPricing(m);
      return {
        name: m.name,
        type: m.type,
        qty: Math.max(1, num(m.qty)),
        dim1_in: num(m.dim1_in),
        dim2_in: num(m.dim2_in),
        // Snapshot stores the combined film+laminate label and effective rate
        // so quote history, preview, and the emailed document all match.
        substrate: p.sub ? { id: p.sub.id, name: filmLabel(p.sub), price_per_sqft: filmRate(p.sub), bleed_in: num(p.sub.bleed_in), film_name: p.sub.name, laminate_name: p.sub.laminate_name } : null,
        trim_area_sqft: p.trimArea,
        billed_area_sqft: p.billedArea,
        unit_price: p.unitPrice,
        line_total: p.lineTotal,
        // Canvas geometry (template-image pixels) so a saved quote can be
        // reopened in the estimator with its shapes intact.
        geometry: { rect: m.rect || null, line1: m.line1 || null, line2: m.line2 || null },
      };
    });
    return {
      quote_number: quoteNumber || wqBase(),
      template_id: template?.id || null,
      vehicle_description: template ? templateLabel(template) : null,
      customer_id: customerId,
      customer,
      project_type: projectType || null,
      project_notes: projectNotes || null,
      attachments,
      measurements: lines,
      labor: {
        design: { ...settings.design, total: totals.design },
        preparation: { ...settings.preparation, total: totals.prep },
        installation: { ...settings.installation, total: totals.install },
        films: totals.filmTotals.map(f => ({ id: f.id, label: f.label, sqft: f.sqft, rate: f.laborRate, total: f.laborTotal })),
      },
      total_area_sqft: totals.area,
      materials_total: totals.materials,
      labor_total: totals.labor,
      subtotal: totals.subtotal,
      tax_rate: num(settings.tax_rate),
      tax_amount: totals.tax,
      total: totals.total,
    };
  };

  // Rasterize the estimator canvas (template outline + drawn shapes, colored
  // by film) to a PNG so the saved/emailed quote can show the customer which
  // panels are covered. Draws onto an offscreen canvas at the template
  // image's native resolution; returns null if anything prevents rendering.
  const renderDiagramBlob = async (): Promise<Blob | null> => {
    if (!template?.template_image_path || measurements.length === 0) return null;
    const img = new Image();
    img.crossOrigin = 'anonymous'; // keep the canvas untainted so toBlob works
    img.src = imageUrl(template.template_image_path);
    try { await img.decode(); } catch { return null; }
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    const fontSize = w / 70;
    ctx.font = `700 ${fontSize}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
    // SVG strokes are non-scaling (screen px); scale them up for the raster.
    ctx.lineWidth = Math.max(2, w / 500);
    for (const m of measurements) {
      const fc = filmColor(m.substrate_id);
      if (m.type === 'box' && m.rect) {
        ctx.fillStyle = fc + '26';
        ctx.strokeStyle = fc;
        ctx.fillRect(m.rect.x, m.rect.y, m.rect.w, m.rect.h);
        ctx.strokeRect(m.rect.x, m.rect.y, m.rect.w, m.rect.h);
      } else if (m.type === 'circle' && m.rect) {
        ctx.fillStyle = fc + '26';
        ctx.strokeStyle = fc;
        ctx.beginPath();
        ctx.ellipse(m.rect.x + m.rect.w / 2, m.rect.y + m.rect.h / 2, m.rect.w / 2, m.rect.h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        // roof/hood line pairs keep the editor's colors (red = length, blue = width)
        for (const [line, color] of [[m.line1, '#ef4444'], [m.line2, '#3b82f6']] as const) {
          if (!line) continue;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(line.x1, line.y1);
          ctx.lineTo(line.x2, line.y2);
          ctx.stroke();
        }
      }
      if (m.rect || m.line1) {
        ctx.fillStyle = fc;
        ctx.fillText(m.name, (m.rect ? m.rect.x : m.line1!.x1) + fontSize / 3, (m.rect ? m.rect.y : m.line1!.y1) - fontSize / 3);
      }
    }
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  };

  // Timestamped path so re-saves aren't served stale from CDN/email caches;
  // failure is non-fatal (the quote just saves without a diagram).
  const uploadDiagram = async (qn: string): Promise<string | null> => {
    try {
      const blob = await renderDiagramBlob();
      if (!blob) return null;
      const path = `quote-diagrams/${qn}-${Date.now()}.png`;
      const { error } = await storage.from('vehicle-templates').upload(path, blob, { contentType: 'image/png', upsert: true });
      return error ? null : path;
    } catch {
      return null;
    }
  };

  const saveQuote = async (): Promise<string | null> => {
    const snap = buildSnapshot();
    if (!savedQuoteId) snap.quote_number = await nextQuoteNumber();
    if (!quoteNumber) setQuoteNumber(snap.quote_number);
    const diagramPath = await uploadDiagram(snap.quote_number);
    const row = diagramPath ? { ...snap, diagram_path: diagramPath } : snap;
    if (savedQuoteId) {
      const { error } = await supabase.from('wrap_quotes').update({ ...row, updated_at: new Date().toISOString() }).eq('id', savedQuoteId);
      if (error) { await dialog.alert(`Save failed: ${error.message}`); return null; }
      await loadAll();
      return savedQuoteId;
    }
    let insert = await supabase.from('wrap_quotes').insert({ ...row, created_by: user?.id }).select('id').single();
    if (insert.error?.code === '23505') {
      // Someone grabbed today's number between our check and the insert —
      // pick the next free suffix and try once more.
      row.quote_number = await nextQuoteNumber();
      setQuoteNumber(row.quote_number);
      insert = await supabase.from('wrap_quotes').insert({ ...row, created_by: user?.id }).select('id').single();
    }
    const { data, error } = insert;
    if (error || !data) { await dialog.alert(`Save failed: ${error?.message || 'unknown error'}`); return null; }
    setSavedQuoteId(data.id);
    await loadAll();
    return data.id;
  };

  const createAndEmail = async () => {
    if (!customer.email?.trim()) { await dialog.alert('Enter a customer email first.'); return; }
    if (measurements.length === 0) { await dialog.alert('No measurements — draw the wrap areas on the Estimator tab first.'); return; }
    const coverageOnly = sendMode === 'coverage_only';
    if (sendMode === 'netsuite_pdf' && !history.find(q => q.id === savedQuoteId)?.netsuite_estimate_id) {
      await dialog.alert('This quote isn\'t in NetSuite yet — use "Create Quote in NetSuite" first.');
      return;
    }
    const confirmMsg = coverageOnly
      ? `Email just the coverage picture (no pricing) to ${customer.email}?`
      : sendMode === 'netsuite_pdf'
        ? `Email the NetSuite quote PDF to ${customer.email}? This sends immediately.`
        : `Email this quote ($${fmt(totals.total)})${sendMode === 'quote_only' ? ' without the coverage picture' : ''} to ${customer.email}? Make sure everything is accurate — this sends immediately.`;
    if (!(await dialog.confirm(confirmMsg))) return;
    setSending(true);
    try {
      const id = await saveQuote();
      if (!id) return;
      const res = await apiFetch('/api/wrap-quote/send', {
        method: 'POST',
        body: JSON.stringify({ quoteId: id, mode: sendMode }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        await dialog.alert(`Email failed: ${data.error || 'Unknown error'}`);
      } else if (coverageOnly) {
        // The quote itself hasn't gone out — keep everything in place so
        // the real quote can still be sent after the customer sees coverage.
        await dialog.alert(`Coverage picture emailed to ${customer.email}`);
        await loadAll();
      } else {
        await dialog.alert(`Quote emailed to ${customer.email}`);
        resetAfterSend();
        await loadAll();
        setTab('history');
      }
    } catch (e: any) {
      await dialog.alert(`Email failed: ${e.message}`);
    } finally {
      setSending(false);
    }
  };

  // Push the quote to NetSuite as an Estimate: vinyl total -> "3M Vinyl"
  // (described as the quoted vehicle), labor total -> "Graphics Install
  // Labor". Taxes are NetSuite's job. No email is sent.
  const createNetsuiteQuote = async () => {
    if (measurements.length === 0) { await dialog.alert('No measurements — draw the wrap areas on the Estimator tab first.'); return; }
    if (!customerId) { await dialog.alert('Pick the customer from the NetSuite search first — a typed-in name has no NetSuite record to attach the quote to.'); return; }
    if (!(await dialog.confirm(`Create a NetSuite quote for ${customer.name}? Vinyl ($${fmt(totals.materials)}) maps to "3M Vinyl", labor ($${fmt(totals.labor)}) to "Graphics Install Labor" — NetSuite adds tax.`))) return;
    setPushingNetsuite(true);
    try {
      const id = await saveQuote();
      if (!id) return;
      const res = await apiFetch('/api/wrap-quote/netsuite', {
        method: 'POST',
        body: JSON.stringify({ quoteId: id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        await dialog.alert(`NetSuite quote failed: ${data.error || 'Unknown error'}`);
      } else {
        await dialog.alert(`NetSuite quote created${data.estimateNumber ? `: ${data.estimateNumber}` : ''}.`);
        await loadAll();
      }
    } catch (e: any) {
      await dialog.alert(`NetSuite quote failed: ${e.message}`);
    } finally {
      setPushingNetsuite(false);
    }
  };

  // Reopen a saved quote for editing / resending: restores the template,
  // drawn shapes, customer, project fields, attachments, and per-film labor
  // overrides, and binds saveQuote to the same row (same quote number).
  // From there every send option applies — email variants, NetSuite push,
  // PDF — so a quote sent earlier can be pushed to NetSuite later, etc.
  const loadQuoteForEdit = (q: WrapQuote) => {
    const tpl = templates.find(t => t.id === q.template_id) || null;
    const ppi = num(tpl?.px_per_in);
    // Quotes saved before geometry was snapshotted have no shape coordinates.
    // Synthesize a simple stacked layout for boxes/circles from their real
    // dimensions so they render and stay editable; roof/hood line pairs
    // without geometry keep their dims but can't be redrawn on the canvas.
    let legacyY = 40;
    const ms: Measurement[] = (q.measurements || []).map((l: any) => {
      const m: Measurement = {
        id: crypto.randomUUID(),
        name: l.name || 'Area',
        type: (l.type || 'box') as MType,
        dim1_in: num(l.dim1_in),
        dim2_in: num(l.dim2_in),
        qty: Math.max(1, num(l.qty)),
        substrate_id: l.substrate?.id || null,
        rect: l.geometry?.rect || undefined,
        line1: l.geometry?.line1 || undefined,
        line2: l.geometry?.line2 || undefined,
      };
      if (!m.rect && !m.line1 && (m.type === 'box' || m.type === 'circle') && ppi > 0) {
        const w = Math.max(2, m.dim1_in * ppi);
        const h = Math.max(2, m.dim2_in * ppi);
        m.rect = { x: 40, y: legacyY, w, h };
        legacyY += h + 20;
      }
      return m;
    });

    setTemplateId(q.template_id || '');
    setImgDim(null);
    setMeasurements(ms);
    setSelectedId(null);
    setPendingPair(null);
    setSavedQuoteId(q.id);
    setQuoteNumber(q.quote_number);
    setCustomer({ name: '', address: '', city: '', state: '', zip: '', phone: '', email: '', email_cc: '', ...(q.customer || {}) });
    setCustomerId(q.customer_id);
    setCustSearch('');
    setProjectType(q.project_type || '');
    setProjectNotes(q.project_notes || '');
    setAttachments(q.attachments || []);
    // Per-film install-labor overrides come back from the labor snapshot
    setLaborRates(Object.fromEntries(((q.labor?.films || []) as any[]).filter((f: any) => f.id).map((f: any) => [f.id, f.rate == null ? '' : String(f.rate)])));
    setSendMode('full');
    setViewQuote(null);
    setTab('quote');
  };

  // A sent quote is finished — clear the whole estimator (drawing, customer,
  // project, attachments) so the next quote starts clean. Keeps the selected
  // vehicle template.
  const resetAfterSend = () => {
    resetEstimate();
    setCustomer({ name: '', address: '', city: '', state: '', zip: '', phone: '', email: '', email_cc: '' });
    setCustomerId(null);
    setCustSearch('');
    setProjectType('');
    setProjectNotes('');
    setAttachments([]);
    setLaborRates({});
  };

  // ----- Email attachments (proofs, vinyl specs, …) -----
  const addAttachments = async (files: FileList | null) => {
    if (!files?.length) return;
    setAttaching(true);
    try {
      const added: QuoteAttachment[] = [];
      for (const f of Array.from(files)) {
        if (f.size > 20 * 1024 * 1024) {
          await dialog.alert(`${f.name} is over 20 MB — too large to email. Attach a smaller file.`);
          continue;
        }
        const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `quote-attachments/${Date.now()}-${safeName}`;
        const { error } = await storage.from('vehicle-templates').upload(path, f, { contentType: f.type || 'application/octet-stream' });
        if (error) {
          await dialog.alert(`Upload failed for ${f.name}: ${error.message}`);
          continue;
        }
        added.push({ name: f.name, path, size: f.size, type: f.type || null });
      }
      if (added.length) setAttachments(prev => [...prev, ...added]);
    } finally {
      setAttaching(false);
    }
  };

  const removeAttachment = async (a: QuoteAttachment) => {
    setAttachments(prev => prev.filter(x => x.path !== a.path));
    await storage.from('vehicle-templates').remove([a.path]); // best-effort cleanup
  };

  // ----- History: archive / delete -----
  const toggleArchiveQuote = async (q: WrapQuote) => {
    const { error } = await supabase.from('wrap_quotes')
      .update({ archived_at: q.archived_at ? null : new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', q.id);
    if (error) { await dialog.alert(`${q.archived_at ? 'Unarchive' : 'Archive'} failed: ${error.message}`); return; }
    if (viewQuote?.id === q.id) setViewQuote(null);
    await loadAll();
  };

  const deleteQuote = async (q: WrapQuote) => {
    if (!(await dialog.confirm(
      `Permanently delete quote ${q.quote_number}${q.customer?.name ? ` for ${q.customer.name}` : ''}? This cannot be undone.`,
      { destructive: true, confirmLabel: 'Delete' }
    ))) return;
    const { error } = await supabase.from('wrap_quotes').delete().eq('id', q.id);
    if (error) { await dialog.alert(`Delete failed: ${error.message}`); return; }
    // Best-effort cleanup of stored files the quote owned
    const paths = [q.diagram_path, ...(q.attachments || []).map(a => a.path)].filter(Boolean) as string[];
    if (paths.length) await storage.from('vehicle-templates').remove(paths);
    if (savedQuoteId === q.id) { setSavedQuoteId(null); setQuoteNumber(''); }
    if (viewQuote?.id === q.id) setViewQuote(null);
    await loadAll();
  };

  // ----- Pricing tab handlers -----
  const pickSubstrate = (id: string) => {
    setSubSel(id);
    const s = substrates.find(x => x.id === id);
    setSubForm(s
      ? { name: s.name, price_per_sqft: String(s.price_per_sqft), bleed_in: String(s.bleed_in), laminate_name: s.laminate_name || '', laminate_price_per_sqft: s.laminate_price_per_sqft ? String(s.laminate_price_per_sqft) : '', labor_per_sqft: s.labor_per_sqft ? String(s.labor_per_sqft) : '', color: s.color || '' }
      : { name: '', price_per_sqft: '', bleed_in: '', laminate_name: '', laminate_price_per_sqft: '', labor_per_sqft: '', color: '' });
  };

  const saveSubstrate = async () => {
    if (!subForm.name.trim()) { await dialog.alert('Film needs a name.'); return; }
    const row = {
      name: subForm.name.trim(),
      price_per_sqft: num(subForm.price_per_sqft),
      bleed_in: num(subForm.bleed_in),
      laminate_name: subForm.laminate_name.trim() || null,
      laminate_price_per_sqft: num(subForm.laminate_price_per_sqft),
      labor_per_sqft: num(subForm.labor_per_sqft),
      // Default a palette color for new films so boxes are distinct from day one
      color: subForm.color || FILM_COLORS[substrates.length % FILM_COLORS.length],
      updated_at: new Date().toISOString(),
    };
    const { error } = subSel
      ? await supabase.from('wrap_substrates').update(row).eq('id', subSel)
      : await supabase.from('wrap_substrates').insert({ ...row, is_active: true });
    if (error) { await dialog.alert(`Save failed: ${error.message}`); return; }
    setSubSel(''); setSubForm({ name: '', price_per_sqft: '', bleed_in: '', laminate_name: '', laminate_price_per_sqft: '', labor_per_sqft: '', color: '' });
    await loadAll();
  };

  const toggleSubstrate = async (s: Film) => {
    await supabase.from('wrap_substrates').update({ is_active: s.is_active === false }).eq('id', s.id);
    await loadAll();
  };

  // companyOverride lets the logo upload persist immediately without waiting
  // for the setSettings state update to flush.
  const saveSettings = async (companyOverride?: Company) => {
    setSavingSettings(true);
    const { error } = await supabase.from('wrap_quote_settings').upsert({
      id: 1,
      company: companyOverride ?? settings.company,
      tax_rate: num(settings.tax_rate),
      design: settings.design,
      preparation: settings.preparation,
      installation: settings.installation,
      updated_at: new Date().toISOString(),
    });
    setSavingSettings(false);
    if (error) await dialog.alert(`Save failed: ${error.message}`);
  };

  // Company logo shown on quote documents (preview + email header).
  const uploadLogo = async (f: File | null) => {
    if (!f) return;
    const ext = (f.name.split('.').pop() || 'png').toLowerCase();
    const path = `company/logo-${Date.now()}.${ext}`;
    const { error } = await storage.from('vehicle-templates').upload(path, f, { contentType: f.type || 'image/png' });
    if (error) { await dialog.alert(`Logo upload failed: ${error.message}`); return; }
    const company = { ...settings.company, logo_path: path };
    setSettings(prev => ({ ...prev, company }));
    await saveSettings(company);
  };

  const removeLogo = async () => {
    const old = settings.company.logo_path;
    const company = { ...settings.company, logo_path: undefined };
    setSettings(prev => ({ ...prev, company }));
    await saveSettings(company);
    if (old) await storage.from('vehicle-templates').remove([old]); // best-effort
  };

  // ----- Templates tab handlers -----
  const uploadTemplate = async () => {
    if (!tplFile || !tplForm.make.trim() || !tplForm.model.trim()) {
      await dialog.alert('Template needs at least an image, make, and model.');
      return;
    }
    setTplUploading(true);
    try {
      const safeName = tplFile.name.replace(/[^a-zA-Z0-9.-]/g, '_');
      const path = `wrapup/${Date.now()}-${safeName}`;
      const { error: upErr } = await storage.from('vehicle-templates').upload(path, tplFile, { contentType: tplFile.type || 'image/png' });
      if (upErr) { await dialog.alert(`Upload failed: ${upErr.message}`); return; }
      const { error } = await supabase.from('vehicle_templates').insert({
        name: [tplForm.make.trim(), tplForm.model.trim(), tplForm.variant.trim()].filter(Boolean).join(' '),
        make: tplForm.make.trim(),
        model: tplForm.model.trim(),
        year: tplForm.year.trim() || null,
        variant: tplForm.variant.trim() || null,
        template_code: tplForm.code.trim() || null,
        overall_length_in: tplForm.length ? num(tplForm.length) : null,
        scale: '1:20',
        template_image_path: path,
        is_active: true,
        created_by: user?.id,
      });
      if (error) { await dialog.alert(`Save failed: ${error.message}`); return; }
      setTplForm({ year: '', make: '', model: '', variant: '', code: '', length: '' });
      setTplFile(null);
      await loadAll();
    } finally {
      setTplUploading(false);
    }
  };

  const toggleTemplate = async (t: Template) => {
    await supabase.from('vehicle_templates').update({ is_active: t.is_active === false }).eq('id', t.id);
    setTemplates(prev => prev.map(x => x.id === t.id ? { ...x, is_active: t.is_active === false } : x));
  };

  // Force-delete one template. Unlike Delete All (which retires templates
  // that quotes reference), this detaches those quotes and removes the row +
  // stored files — it's the way to clean up the retired stragglers.
  const deleteTemplate = async (t: Template) => {
    if (!(await dialog.confirm(
      `Permanently delete "${templateLabel(t)}"? If any quotes reference it, they keep their pricing but lose the template link. This cannot be undone.`,
      { destructive: true, confirmLabel: 'Delete' }
    ))) return;
    try {
      const res = await apiFetch('/api/admin/delete-template', {
        method: 'POST',
        body: JSON.stringify({ templateId: t.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        await dialog.alert(`Delete failed: ${data.error || 'Unknown error'}`);
        return;
      }
      setTemplates(prev => prev.filter(x => x.id !== t.id));
      if (templateId === t.id) setTemplateId('');
    } catch (e: any) {
      await dialog.alert(`Delete failed: ${e.message}`);
    }
  };

  // Wipe the template library ahead of a fresh bulk import. The server works
  // in small batches (timeout-safe for libraries of thousands), so loop until
  // it reports nothing left. Templates a quote still references are retired
  // (kept for history) instead of deleted.
  // Batch auto-calibration: the server reads each template's vector artboard
  // size (EPS BoundingBox / AI MediaBox — the drawings are 1:20) plus the
  // preview's pixel dimensions and computes px_per_in, so nobody has to
  // hand-calibrate a library of thousands. Loops batch-by-batch until the
  // server reports no more candidates.
  const autoCalibrateAll = async () => {
    setCalibrating(true);
    setCalibStatus('Starting…');
    let cursor: string | null = null;
    let calibrated = 0, skipped = 0;
    const reasonTotals: Record<string, number> = {};
    try {
      do {
        const res: Response = await apiFetch('/api/admin/calibrate-templates', {
          method: 'POST',
          body: JSON.stringify({ cursor }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setCalibStatus(`Failed: ${data.error || 'Unknown error'}`);
          return;
        }
        calibrated += data.calibrated;
        skipped += data.skipped;
        for (const [k, v] of Object.entries(data.reasons || {})) reasonTotals[k] = (reasonTotals[k] || 0) + (v as number);
        cursor = data.nextCursor;
        setCalibStatus(`Calibrated ${calibrated}${skipped ? ` · ${skipped} skipped` : ''}…`);
      } while (cursor);
      const reasonText = Object.entries(reasonTotals).map(([k, v]) => `${k}: ${v}`).join(', ');
      setCalibStatus(`Done — ${calibrated} calibrated automatically${skipped ? `, ${skipped} skipped (${reasonText})` : ''}.`);
      await loadAll();
    } catch (e: any) {
      setCalibStatus(`Failed: ${e.message}`);
    } finally {
      setCalibrating(false);
    }
  };

  // ----- Shared styles -----
  const inputStyle: React.CSSProperties = { width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' };
  const labelStyle: React.CSSProperties = { fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' };
  const btnStyle = (color: string, bg: string): React.CSSProperties => ({ padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: bg, border: `1px solid ${color}40`, color, cursor: 'pointer' });
  const sectionHead = (t: string) => (
    <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', padding: '6px 0', borderBottom: `1px solid ${theme.border}`, marginBottom: '10px' }}>{t}</div>
  );

  if (authLoading || loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;
  if (!hasAccess) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>You don&apos;t have access to Wrap Quotes.</div>;

  const laborEditor = (key: 'design' | 'preparation' | 'installation', title: string) => {
    const s = settings[key];
    const set = (patch: Partial<LaborSection>) => setSettings(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    return (
      <div style={{ marginBottom: '16px' }}>
        {sectionHead(title)}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px' }}>
          <div><div style={labelStyle}>Flat Price ($)</div><input type="number" value={s.flat || ''} onChange={e => set({ flat: num(e.target.value) })} style={inputStyle} /></div>
          <div><div style={labelStyle}>Hourly Price ($)</div><input type="number" value={s.hourly || ''} onChange={e => set({ hourly: num(e.target.value) })} style={inputStyle} /></div>
          <div><div style={labelStyle}>Hours</div><input type="number" value={s.hours || ''} onChange={e => set({ hours: num(e.target.value) })} style={inputStyle} /></div>
          <div><div style={labelStyle}>Extra Price ($)</div><input type="number" value={s.extra || ''} onChange={e => set({ extra: num(e.target.value) })} style={inputStyle} /></div>
        </div>
        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', marginTop: '4px' }}>Section total: ${fmt(laborSectionTotal(s))}</div>
      </div>
    );
  };

  // Read-only copy of the estimator canvas for the live quote preview, so it
  // matches the coverage diagram the customer gets in the emailed quote.
  const liveCoverageDiagram = () => {
    if (!template?.template_image_path || measurements.length === 0) return null;
    return (
      <div style={{ position: 'relative', marginBottom: '10px', background: '#fff', border: `1px solid ${theme.border}`, borderRadius: '8px', overflow: 'hidden' }}>
        {/* Self-measuring so the preview works when a quote is loaded from
            history without ever visiting the estimator tab. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- template dimensions are unknown; next/image needs fixed sizes */}
        <img
          src={imageUrl(template.template_image_path)}
          alt="Coverage areas"
          onLoad={e => { if (!imgDim) setImgDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }); }}
          style={{ width: '100%', display: 'block' }}
          draggable={false}
        />
        {imgDim && <svg viewBox={`0 0 ${imgDim.w} ${imgDim.h}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {measurements.map(m => {
            const fc = filmColor(m.substrate_id);
            const fontSize = imgDim.w / 70;
            return (
              <g key={m.id}>
                {m.type === 'box' && m.rect && (
                  <rect x={m.rect.x} y={m.rect.y} width={m.rect.w} height={m.rect.h} fill={fc + '26'} stroke={fc} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                )}
                {m.type === 'circle' && m.rect && (
                  <ellipse cx={m.rect.x + m.rect.w / 2} cy={m.rect.y + m.rect.h / 2} rx={m.rect.w / 2} ry={m.rect.h / 2} fill={fc + '26'} stroke={fc} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                )}
                {(m.type === 'roof' || m.type === 'hood') && (
                  <>
                    {m.line1 && <line x1={m.line1.x1} y1={m.line1.y1} x2={m.line1.x2} y2={m.line1.y2} stroke="#ef4444" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
                    {m.line2 && <line x1={m.line2.x1} y1={m.line2.y1} x2={m.line2.x2} y2={m.line2.y2} stroke="#3b82f6" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
                  </>
                )}
                {(m.rect || m.line1) && (
                  <text x={(m.rect ? m.rect.x : m.line1!.x1) + fontSize / 3} y={(m.rect ? m.rect.y : m.line1!.y1) - fontSize / 3} fontSize={fontSize} fontWeight={700} fill={fc}>{m.name}</text>
                )}
              </g>
            );
          })}
        </svg>}
      </div>
    );
  };

  // Quote preview shared by the Quote tab and History view modal. `coverage`
  // overrides the stored diagram with a live render (Quote tab, pre-save).
  const quotePreview = (q: { quote_number: string; vehicle_description: string | null; customer: any; project_type: string | null; project_notes: string | null; measurements: any[]; labor: any; subtotal: number; tax_rate: number; tax_amount: number; total: number; diagram_path?: string | null; attachments?: QuoteAttachment[] | null; created_at?: string }, coverage?: React.ReactNode) => (
    <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)' }}>Wrap Quote <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700 }}>{q.quote_number}</span></div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>{new Date(q.created_at || Date.now()).toLocaleDateString()}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px', fontSize: '11px', color: 'var(--text-secondary)' }}>
        <div>
          {settings.company.logo_path && (
            <div style={{ background: '#fff', borderRadius: '6px', padding: '6px', display: 'inline-block', marginBottom: '6px' }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- logo dimensions are unknown; next/image needs fixed sizes */}
              <img src={imageUrl(settings.company.logo_path)} alt={settings.company.name || 'Company logo'} style={{ maxHeight: '40px', maxWidth: '180px', display: 'block' }} />
            </div>
          )}
          <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{settings.company.name || 'Your Company'}</div>
          {settings.company.address && <div>{settings.company.address}</div>}
          {(settings.company.city || settings.company.state || settings.company.zip) && <div>{[settings.company.city, settings.company.state, settings.company.zip].filter(Boolean).join(', ')}</div>}
          {settings.company.phone && <div>{settings.company.phone}</div>}
        </div>
        <div>
          <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>Customer</div>
          <div>{q.customer?.name || '—'}</div>
          {q.customer?.address && <div>{q.customer.address}</div>}
          {(q.customer?.city || q.customer?.state || q.customer?.zip) && <div>{[q.customer.city, q.customer.state, q.customer.zip].filter(Boolean).join(', ')}</div>}
          {q.customer?.email && <div>{q.customer.email}</div>}
        </div>
      </div>
      {q.project_type && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px' }}><b>Project Type:</b> {q.project_type}</div>}
      {q.vehicle_description && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '10px' }}><b>Vehicle:</b> {q.vehicle_description}</div>}
      {coverage || (q.diagram_path ? (
        <div style={{ marginBottom: '10px', background: '#fff', border: `1px solid ${theme.border}`, borderRadius: '8px', overflow: 'hidden' }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- diagram dimensions are unknown; next/image needs fixed sizes */}
          <img src={imageUrl(q.diagram_path)} alt="Coverage areas" style={{ width: '100%', display: 'block' }} />
        </div>
      ) : null)}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
        <thead>
          <tr style={{ color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: '9px' }}>
            <th style={{ textAlign: 'left', padding: '5px 6px', borderBottom: `1px solid ${theme.border}` }}>Item</th>
            <th style={{ textAlign: 'right', padding: '5px 6px', borderBottom: `1px solid ${theme.border}` }}>Qty</th>
            <th style={{ textAlign: 'right', padding: '5px 6px', borderBottom: `1px solid ${theme.border}` }}>Price</th>
            <th style={{ textAlign: 'right', padding: '5px 6px', borderBottom: `1px solid ${theme.border}` }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {(q.measurements || []).map((l: any, i: number) => (
            <tr key={i} style={{ color: 'var(--text-primary)' }}>
              <td style={{ padding: '5px 6px', borderBottom: `1px solid ${theme.border}` }}>
                {l.name}
                <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '9px' }}>
                  {fmt(l.billed_area_sqft)} ft²{l.substrate ? ` · ${l.substrate.name}` : ''}
                </span>
              </td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{l.qty}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{fmt(l.unit_price)}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{fmt(l.line_total)}</td>
            </tr>
          ))}
          {(q.labor?.films || []).filter((f: any) => num(f.total) > 0).map((f: any) => (
            <tr key={`labor-${f.id}`} style={{ color: 'var(--text-primary)' }}>
              <td style={{ padding: '5px 6px', borderBottom: `1px solid ${theme.border}` }}>
                Install — {f.label}
                <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '9px' }}>{fmt(f.sqft)} ft² @ ${fmt(f.rate)}/ft²</span>
              </td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>1</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{fmt(f.total)}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{fmt(f.total)}</td>
            </tr>
          ))}
          {(['design', 'preparation', 'installation'] as const).map(k => {
            const sec = q.labor?.[k];
            if (!sec || !num(sec.total)) return null;
            const label = k === 'design' ? 'Design' : k === 'preparation' ? 'Preparation' : 'Installation';
            return (
              <tr key={k} style={{ color: 'var(--text-primary)' }}>
                <td style={{ padding: '5px 6px', borderBottom: `1px solid ${theme.border}` }}>{label}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>1</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{fmt(sec.total)}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{fmt(sec.total)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(q.labor?.films || []).length > 0 && (
        <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--text-secondary)' }}>
          <b style={{ color: 'var(--text-primary)' }}>Film usage:</b>{' '}
          {(q.labor.films as any[]).map((f: any) => `${f.label} — ${fmt(f.sqft)} ft²`).join('  ·  ')}
        </div>
      )}
      <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px', fontSize: '12px', color: 'var(--text-primary)' }}>
        <div>Subtotal <b style={{ marginLeft: '14px' }}>${fmt(q.subtotal)}</b></div>
        <div>Tax ({fmt(q.tax_rate)}%) <b style={{ marginLeft: '14px' }}>${fmt(q.tax_amount)}</b></div>
        <div style={{ fontSize: '15px', fontWeight: 800 }}>Total <span style={{ marginLeft: '14px', color: '#22c55e' }}>${fmt(q.total)}</span></div>
      </div>
      {q.project_notes && <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--text-secondary)' }}><b>Project Notes:</b> {q.project_notes}</div>}
      {(q.attachments || []).length > 0 && (
        <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--text-secondary)' }}>
          <b style={{ color: 'var(--text-primary)' }}>Attachments:</b> {(q.attachments || []).map(a => a.name).join(', ')}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
        Wrap Quotes
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {([
          { id: 'estimator' as Tab, label: 'Estimator', color: '#06b6d4' },
          { id: 'quote' as Tab, label: 'Quote', color: '#22c55e' },
          { id: 'history' as Tab, label: `Quote History (${history.filter(q => !q.archived_at).length})`, color: '#a78bfa' },
          { id: 'pricing' as Tab, label: 'Pricing', color: '#f59e0b' },
          { id: 'company' as Tab, label: 'Company Info', color: '#60a5fa' },
          { id: 'templates' as Tab, label: `Templates (${templates.length})`, color: '#94a3b8' },
        ]).map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            background: tab === t.id ? 'var(--tab-active-bg)' : 'transparent',
            border: tab === t.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: tab === t.id ? t.color : 'var(--text-muted)',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ================= ESTIMATOR ================= */}
      {tab === 'estimator' && (
        <div>
          {/* Vehicle selection */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
            <select value={yearFilter} onChange={e => { setYearFilter(e.target.value); setTemplateId(''); }} style={{ ...inputStyle, width: '110px' }}>
              <option value="">All years</option>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <select value={makeFilter} onChange={e => { setMakeFilter(e.target.value); setTemplateId(''); }} style={{ ...inputStyle, width: '150px' }}>
              <option value="">All makes</option>
              {makes.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <input
              value={tplSearch}
              onChange={e => { setTplSearch(e.target.value); setTemplateId(''); }}
              placeholder="Search templates…"
              style={{ ...inputStyle, width: '180px' }}
            />
            <select value={templateId} onChange={e => { setTemplateId(e.target.value); setImgDim(null); resetEstimate(); }} style={{ ...inputStyle, flex: 1, minWidth: '220px' }}>
              <option value="">{templateOptions.length === 0 ? '— No templates match —' : '— Select vehicle template —'}</option>
              {templateOptions.map(t => <option key={t.id} value={t.id}>{templateLabel(t)}{t.template_code ? ` (${t.template_code})` : ''}</option>)}
            </select>
          </div>

          {activeTemplates.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
              No vehicle templates yet — add your 1:20 outlines in the Templates tab.
            </div>
          )}

          {template && (
            <div style={{ display: 'grid', gridTemplateColumns: '230px 1fr', gap: '12px', alignItems: 'start' }}>
              {/* Sidebar: tools + measurements */}
              <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px' }}>
                <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>Film Estimator</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '10px' }}>
                  {([
                    { id: 'box' as Tool, label: 'Draw Box' },
                    { id: 'roof' as Tool, label: 'Draw Roof' },
                    { id: 'hood' as Tool, label: 'Draw Hood' },
                  ]).map(t => (
                    <button key={t.id} onClick={() => { setTool(t.id); setPendingPair(null); }} disabled={!template.px_per_in} title={!template.px_per_in ? 'Calibrate the template first' : (t.id === 'roof' || t.id === 'hood') ? 'Drag line 1 along the side view, then line 2 across the front/back view — area = L1 × L2' : undefined} style={{
                      padding: '8px 6px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: template.px_per_in ? 'pointer' : 'default',
                      background: tool === t.id ? 'rgba(6,182,212,0.15)' : 'var(--subtle-bg)',
                      border: tool === t.id ? '1px solid rgba(6,182,212,0.4)' : '1px solid var(--border)',
                      color: tool === t.id ? '#06b6d4' : 'var(--text-secondary)',
                      opacity: template.px_per_in ? 1 : 0.5,
                    }}>{t.label}</button>
                  ))}
                </div>
                <button onClick={() => { setTool('calibrate'); setPendingPair(null); }} style={{
                  width: '100%', padding: '6px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', marginBottom: '10px',
                  background: tool === 'calibrate' ? 'rgba(251,191,36,0.15)' : 'transparent',
                  border: '1px solid rgba(251,191,36,0.35)', color: '#fbbf24',
                }}>{template.px_per_in ? 'Recalibrate Scale' : 'Calibrate Scale'}</button>

                {(tool === 'roof' || tool === 'hood') && !pendingPair && !drag && (
                  <div style={{ padding: '8px', borderRadius: '8px', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '10px', lineHeight: 1.5 }}>
                    <b style={{ color: '#06b6d4' }}>How Draw {tool === 'roof' ? 'Roof' : 'Hood'} works</b> (for templates without a top view):<br />
                    <b style={{ color: '#ef4444' }}>1.</b> Drag the <b style={{ color: '#ef4444' }}>red line</b> along the {tool} in the <b>side view</b> — front edge to back edge (its length).<br />
                    <b style={{ color: '#3b82f6' }}>2.</b> Drag the <b style={{ color: '#3b82f6' }}>blue line</b> across the {tool} in the <b>front or back view</b> (its width).<br />
                    Area = length × width. Both numbers stay editable afterward.
                  </div>
                )}

                {pendingPair && (
                  <div style={{ padding: '8px', borderRadius: '8px', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', fontSize: '10px', fontWeight: 700, color: '#06b6d4', marginBottom: '10px' }}>
                    Line 1 done ({fmt(pendingPair.dim1_in)} in) — now drag line 2 across the {pendingPair.type === 'roof' ? 'front/back view of the roof' : 'front view of the hood'}.
                    <button onClick={() => { setPendingPair(null); setTool('select'); }} style={{ display: 'block', marginTop: '4px', background: 'none', border: 'none', color: '#ef4444', fontSize: '10px', fontWeight: 700, cursor: 'pointer', padding: 0 }}>Cancel</button>
                  </div>
                )}

                {calibLine && (
                  <div style={{ padding: '8px', borderRadius: '8px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', marginBottom: '10px' }}>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: '#fbbf24', marginBottom: '4px' }}>How long is that line in real life?</div>
                    <input type="number" value={calibInches} onChange={e => setCalibInches(e.target.value)} placeholder="inches" style={{ ...inputStyle, marginBottom: '4px' }} />
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button onClick={saveCalibration} style={btnStyle('#22c55e', 'rgba(34,197,94,0.1)')}>Save</button>
                      <button onClick={() => { setCalibLine(null); setTool('select'); }} style={btnStyle('#94a3b8', 'transparent')}>Cancel</button>
                    </div>
                  </div>
                )}

                <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>Measurements</div>
                {measurements.length === 0 && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '8px' }}>Nothing measured yet.</div>}
                {measurements.map(m => (
                  <div key={m.id} onClick={() => setSelectedId(m.id)} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', borderRadius: '6px', marginBottom: '3px', cursor: 'pointer',
                    background: selectedId === m.id ? 'rgba(6,182,212,0.1)' : 'var(--subtle-bg)',
                    border: selectedId === m.id ? '1px solid rgba(6,182,212,0.35)' : '1px solid var(--border)',
                  }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                      <span style={{ width: '9px', height: '9px', borderRadius: '3px', background: filmColor(m.substrate_id), flexShrink: 0 }} />
                      <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                      <button onClick={e => { e.stopPropagation(); duplicateMeasurement(m.id); }} title="Duplicate" style={{ background: 'none', border: 'none', color: '#06b6d4', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>⧉</button>
                      <button onClick={e => { e.stopPropagation(); removeMeasurement(m.id); }} title="Delete" style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
                    </span>
                  </div>
                ))}

                {selected && (() => {
                  const p = measurementPricing(selected);
                  const twoLines = selected.type === 'roof' || selected.type === 'hood';
                  return (
                    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${theme.border}` }}>
                      <div style={labelStyle}>Name</div>
                      <input value={selected.name} onChange={e => updateMeasurement(selected.id, { name: e.target.value })} style={{ ...inputStyle, marginBottom: '6px' }} />
                      <div style={labelStyle}>{twoLines ? 'Line 1 (in)' : 'Width (in)'}</div>
                      <input type="number" value={selected.dim1_in ? Number(selected.dim1_in.toFixed(2)) : ''} onChange={e => updateMeasurement(selected.id, { dim1_in: num(e.target.value) })} style={{ ...inputStyle, marginBottom: '6px' }} />
                      <div style={labelStyle}>{twoLines ? 'Line 2 (in)' : 'Height (in)'}</div>
                      <input type="number" value={selected.dim2_in ? Number(selected.dim2_in.toFixed(2)) : ''} onChange={e => updateMeasurement(selected.id, { dim2_in: num(e.target.value) })} style={{ ...inputStyle, marginBottom: '6px' }} />
                      <div style={labelStyle}>Quantity</div>
                      <input type="number" min={1} value={selected.qty} onChange={e => updateMeasurement(selected.id, { qty: Math.max(1, Math.round(num(e.target.value))) })} style={{ ...inputStyle, marginBottom: '6px' }} />
                      <div style={labelStyle}>Film</div>
                      <select value={selected.substrate_id || ''} onChange={e => updateMeasurement(selected.id, { substrate_id: e.target.value || null })} style={{ ...inputStyle, marginBottom: '6px' }}>
                        <option value="">— none —</option>
                        {activeSubstrates.map(s => <option key={s.id} value={s.id}>{filmLabel(s)} (${fmt(filmRate(s))}/ft²)</option>)}
                      </select>
                      <div style={{ fontSize: '10px', color: 'var(--text-secondary)', fontWeight: 700 }}>
                        Area: {fmt(p.trimArea)} ft²{p.sub && num(p.sub.bleed_in) > 0 ? ` · billed ${fmt(p.billedArea)} ft² with ${p.sub.bleed_in}" bleed` : ''}
                      </div>
                      <div style={{ fontSize: '10px', color: '#22c55e', fontWeight: 700 }}>Line total: ${fmt(p.lineTotal)}</div>
                    </div>
                  );
                })()}
              </div>

              {/* Canvas */}
              <div>
                {!template.px_per_in && !calibLine && (
                  <div style={{ padding: '10px 14px', borderRadius: '10px', marginBottom: '10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', fontSize: '11px', fontWeight: 700, color: '#fbbf24' }}>
                    This template isn&apos;t calibrated yet. Click <b>Calibrate Scale</b>, drag a line along a dimension you know (e.g. the vehicle&apos;s overall length{template.overall_length_in ? ` — ${template.overall_length_in}"` : ''}), and enter its real length. You only do this once per template.
                  </div>
                )}
                <div style={{ position: 'relative', background: '#fff', border: `1px solid ${theme.border}`, borderRadius: '12px', overflow: 'hidden' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- template dimensions are unknown; next/image needs fixed sizes */}
                  <img
                    src={imageUrl(template.template_image_path)}
                    alt={templateLabel(template)}
                    onLoad={e => setImgDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                    style={{ width: '100%', display: 'block' }}
                    draggable={false}
                  />
                  {imgDim && (
                    <svg
                      ref={svgRef}
                      viewBox={`0 0 ${imgDim.w} ${imgDim.h}`}
                      onPointerDown={onPointerDown}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: tool === 'select' ? 'default' : 'crosshair', touchAction: 'none' }}
                    >
                      {measurements.map(m => {
                        const sel = m.id === selectedId;
                        // Boxes wear their film's color so mixed-film vehicles
                        // (print layer + reflective on top) read at a glance.
                        const fc = filmColor(m.substrate_id);
                        const stroke = sel ? '#f59e0b' : fc;
                        const fill = sel ? 'rgba(245,158,11,0.18)' : fc + '26';
                        const fontSize = imgDim.w / 70;
                        return (
                          <g key={m.id} onPointerDown={e => { if (tool === 'select') { if (m.type === 'box' && m.rect) { beginEditDrag(e, m, 'move'); } else { e.stopPropagation(); setSelectedId(m.id); } } }} style={{ cursor: tool === 'select' ? 'move' : 'pointer' }}>
                            {m.type === 'box' && m.rect && (
                              <rect x={m.rect.x} y={m.rect.y} width={m.rect.w} height={m.rect.h} fill={fill} stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                            )}
                            {m.type === 'box' && m.rect && sel && (
                              <circle
                                cx={m.rect.x + m.rect.w} cy={m.rect.y + m.rect.h} r={Math.max(6, imgDim.w / 160)}
                                fill="#f59e0b" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                                style={{ cursor: 'nwse-resize' }}
                                onPointerDown={e => beginEditDrag(e, m, 'resize')}
                              />
                            )}
                            {m.type === 'circle' && m.rect && (
                              <ellipse cx={m.rect.x + m.rect.w / 2} cy={m.rect.y + m.rect.h / 2} rx={m.rect.w / 2} ry={m.rect.h / 2} fill={fill} stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                            )}
                            {(m.type === 'roof' || m.type === 'hood') && (
                              <>
                                {m.line1 && <line x1={m.line1.x1} y1={m.line1.y1} x2={m.line1.x2} y2={m.line1.y2} stroke="#ef4444" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
                                {m.line2 && <line x1={m.line2.x1} y1={m.line2.y1} x2={m.line2.x2} y2={m.line2.y2} stroke="#3b82f6" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
                              </>
                            )}
                            {(m.rect || m.line1) && (
                              <text x={(m.rect ? m.rect.x : m.line1!.x1) + fontSize / 3} y={(m.rect ? m.rect.y : m.line1!.y1) - fontSize / 3} fontSize={fontSize} fontWeight={700} fill={stroke}>{m.name}</text>
                            )}
                          </g>
                        );
                      })}
                      {pendingPair?.line1 && (
                        <line x1={pendingPair.line1.x1} y1={pendingPair.line1.y1} x2={pendingPair.line1.x2} y2={pendingPair.line1.y2} stroke="#ef4444" strokeWidth={3} vectorEffect="non-scaling-stroke" strokeDasharray="6 4" />
                      )}
                      {drag && (tool === 'box' ? (
                        <rect x={Math.min(drag.x1, drag.x2)} y={Math.min(drag.y1, drag.y2)} width={Math.abs(drag.x2 - drag.x1)} height={Math.abs(drag.y2 - drag.y1)} fill="rgba(6,182,212,0.1)" stroke="#06b6d4" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray="6 4" />
                      ) : tool === 'circle' ? (
                        <ellipse cx={(drag.x1 + drag.x2) / 2} cy={(drag.y1 + drag.y2) / 2} rx={Math.abs(drag.x2 - drag.x1) / 2} ry={Math.abs(drag.y2 - drag.y1) / 2} fill="rgba(6,182,212,0.1)" stroke="#06b6d4" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray="6 4" />
                      ) : (
                        <line x1={drag.x1} y1={drag.y1} x2={drag.x2} y2={drag.y2} stroke={tool === 'calibrate' ? '#fbbf24' : pendingPair ? '#3b82f6' : '#ef4444'} strokeWidth={3} vectorEffect="non-scaling-stroke" strokeDasharray="6 4" />
                      ))}
                    </svg>
                  )}
                </div>

                {/* Footer bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', padding: '10px 14px', marginTop: '10px', background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '10px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                    {template.template_code ? `${template.template_code} · ` : ''}{templateLabel(template)} · {template.scale || '1:20'} scale
                  </div>
                  <div style={{ marginLeft: 'auto', fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>Total Area: {fmt(totals.area)} ft²</div>
                  <div style={{ fontSize: '12px', fontWeight: 800, color: '#22c55e' }}>Estimated Cost: ${fmt(totals.total)}</div>
                  <button onClick={() => setTab('quote')} disabled={measurements.length === 0} style={{
                    padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, border: 'none',
                    background: measurements.length === 0 ? 'var(--subtle-bg)' : '#22c55e',
                    color: measurements.length === 0 ? 'var(--text-muted)' : '#fff',
                    cursor: measurements.length === 0 ? 'default' : 'pointer',
                  }}>Quote →</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ================= GENERATE QUOTE ================= */}
      {tab === 'quote' && (
        <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '12px', alignItems: 'start' }}>
          <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px' }}>
            {sectionHead('Customer Information')}
            <div style={{ position: 'relative', marginBottom: '8px' }}>
              <input value={custSearch} onChange={e => setCustSearch(e.target.value)} placeholder="Search NetSuite customers…" style={inputStyle} />
              {custMatches.length > 0 && custSearch.trim().length >= 2 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '200px', overflowY: 'auto', marginTop: '2px' }}>
                  {custMatches.map(c => (
                    <button key={c.id} onMouseDown={e => e.preventDefault()} onClick={() => {
                      setCustomerId(c.id);
                      setCustomer((prev: any) => ({ ...prev, name: c.company_name, email: c.email || prev.email, phone: c.phone || prev.phone, address: c.address || prev.address }));
                      setCustSearch('');
                    }} style={{ display: 'block', width: '100%', padding: '8px 10px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'var(--text-primary)' }}>
                      <span style={{ fontWeight: 700 }}>{c.company_name}</span>
                      {c.entity_id && <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '10px' }}>{c.entity_id}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {([
              ['name', 'Name'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'Zip'],
              ['phone', 'Telephone'], ['email', 'Email'], ['email_cc', 'Email (CC)'],
            ] as const).map(([k, label]) => (
              <div key={k} style={{ marginBottom: '6px' }}>
                <div style={labelStyle}>{label}</div>
                <input value={customer[k] || ''} onChange={e => { setCustomer({ ...customer, [k]: e.target.value }); if (k === 'name') setCustomerId(null); }} style={inputStyle} />
              </div>
            ))}
            {totals.filmTotals.length > 0 && (<>
              {sectionHead('Install Labor (per film)')}
              {totals.filmTotals.map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <span style={{ flex: 1, fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', minWidth: 0 }}>
                    {f.label}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginLeft: '6px' }}>{fmt(f.sqft)} ft²</span>
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>$</span>
                  <input type="number" value={laborRates[f.id] ?? (num(substrateById(f.id)?.labor_per_sqft) || '')}
                    onChange={e => setLaborRates(prev => ({ ...prev, [f.id]: e.target.value }))}
                    placeholder="0" style={{ ...inputStyle, width: '70px' }} />
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', width: '34px' }}>/ft²</span>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#22c55e', width: '70px', textAlign: 'right' }}>${fmt(f.laborTotal)}</span>
                </div>
              ))}
            </>)}
            {sectionHead('Project')}
            <div style={{ marginBottom: '6px' }}>
              <div style={labelStyle}>Type</div>
              <input value={projectType} onChange={e => setProjectType(e.target.value)} placeholder="e.g. Full truck wrap" style={inputStyle} />
            </div>
            <div style={{ marginBottom: '12px' }}>
              <div style={labelStyle}>Note</div>
              <textarea value={projectNotes} onChange={e => setProjectNotes(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
            </div>
            {sectionHead('Email Attachments')}
            {attachments.map(a => (
              <div key={a.path} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{(a.size / 1024 / 1024) >= 1 ? `${(a.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`}</span>
                <button onClick={() => removeAttachment(a)} title="Remove attachment" style={btnStyle('#ef4444', 'transparent')}>✕</button>
              </div>
            ))}
            <label style={{ ...btnStyle('#a78bfa', 'rgba(167,139,250,0.08)'), display: 'inline-block', marginBottom: '4px', opacity: attaching ? 0.6 : 1 }}>
              {attaching ? 'Uploading…' : '+ Attach File'}
              <input type="file" multiple disabled={attaching} onChange={e => { addAttachments(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
            </label>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '12px' }}>Sent with the emailed quote — proof files, vinyl specs, or other documentation.</div>
            <div style={{ marginBottom: '8px' }}>
              <div style={labelStyle}>Email Content</div>
              <select value={sendMode} onChange={e => setSendMode(e.target.value as typeof sendMode)} style={inputStyle}>
                <option value="full">Quote + coverage picture</option>
                <option value="quote_only">Quote only (no picture)</option>
                <option value="coverage_only">Coverage picture only (no pricing)</option>
                <option value="netsuite_pdf">NetSuite quote PDF (attached)</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button onClick={() => saveQuote()} style={btnStyle('#60a5fa', 'rgba(59,130,246,0.1)')}>{savedQuoteId ? 'Update Draft' : 'Save Draft'}</button>
              <button onClick={createAndEmail} disabled={sending} style={{ ...btnStyle('#fff', '#22c55e'), border: 'none' }}>
                {sending ? 'Sending…' : sendMode === 'coverage_only' ? 'Email Coverage' : 'Email Quote'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' }}>
              {(() => {
                const nsQuote = history.find(q => q.id === savedQuoteId);
                return nsQuote?.netsuite_estimate_id ? (
                  <>
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
                      NetSuite quote {nsQuote.netsuite_estimate_number || nsQuote.netsuite_estimate_id}
                    </span>
                    <button onClick={() => viewEstimatePdf(nsQuote.netsuite_estimate_id)} style={btnStyle('#a78bfa', 'rgba(167,139,250,0.08)')}>
                      View PDF
                    </button>
                  </>
                ) : (
                  <button onClick={createNetsuiteQuote} disabled={pushingNetsuite} style={btnStyle('#a78bfa', 'rgba(167,139,250,0.08)')}>
                    {pushingNetsuite ? 'Creating…' : 'Create Quote in NetSuite'}
                  </button>
                );
              })()}
            </div>
            {measurements.length === 0 && (
              <div style={{ marginTop: '8px', fontSize: '10px', color: '#fbbf24', fontWeight: 700 }}>No measurements yet — use the Estimator tab first.</div>
            )}
          </div>
          {quotePreview({ ...buildSnapshot(), created_at: new Date().toISOString() } as any, liveCoverageDiagram())}
        </div>
      )}

      {/* ================= HISTORY ================= */}
      {tab === 'history' && (() => {
        const archivedCount = history.filter(q => q.archived_at).length;
        const visible = history.filter(q => showArchived || !q.archived_at);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {archivedCount > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', alignSelf: 'flex-end', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', cursor: 'pointer', marginBottom: '4px' }}>
                <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
                Show archived ({archivedCount})
              </label>
            )}
            {visible.length === 0 && <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>{history.length === 0 ? 'No quotes yet.' : 'No quotes — everything is archived.'}</div>}
            {visible.map(q => (
              <div key={q.id} onClick={() => setViewQuote(q)} style={{
                display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px', borderRadius: '8px', textAlign: 'left',
                background: 'var(--card)', border: `1px solid ${theme.border}`, cursor: 'pointer',
                opacity: q.archived_at ? 0.55 : 1,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {q.customer?.name || 'No customer'}
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: '8px' }}>{q.quote_number}</span>
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{q.vehicle_description || '—'}{q.project_type ? ` · ${q.project_type}` : ''}</div>
                </div>
                {q.netsuite_estimate_number && (
                  <button
                    onClick={e => { e.stopPropagation(); viewEstimatePdf(q.netsuite_estimate_id); }}
                    title="Open the NetSuite quote PDF"
                    style={{ fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px', background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: 'none', cursor: 'pointer' }}
                  >NS {q.netsuite_estimate_number} ⎙</button>
                )}
                {q.archived_at && (
                  <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px', background: 'rgba(148,163,184,0.12)', color: '#94a3b8' }}>Archived</span>
                )}
                <span style={{
                  fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px',
                  background: q.status === 'sent' ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.12)',
                  color: q.status === 'sent' ? '#22c55e' : '#94a3b8',
                }}>{q.status === 'sent' ? `Sent${q.sent_to ? ` · ${q.sent_to}` : ''}` : 'Draft'}</span>
                <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>${fmt(q.total)}</span>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{new Date(q.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                <button onClick={e => { e.stopPropagation(); loadQuoteForEdit(q); }} title="Reopen this quote for editing / resending" style={btnStyle('#60a5fa', 'transparent')}>
                  Edit
                </button>
                <button onClick={e => { e.stopPropagation(); toggleArchiveQuote(q); }} title={q.archived_at ? 'Unarchive' : 'Archive'} style={btnStyle('#f59e0b', 'transparent')}>
                  {q.archived_at ? 'Unarchive' : 'Archive'}
                </button>
                {isAdmin && (
                  <button onClick={e => { e.stopPropagation(); deleteQuote(q); }} title="Delete this quote permanently" style={btnStyle('#ef4444', 'transparent')}>✕</button>
                )}
              </div>
            ))}
          </div>
        );
      })()}

      {viewQuote && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }} onClick={() => setViewQuote(null)}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '640px', maxHeight: '90vh', overflowY: 'auto' }}>
            {quotePreview(viewQuote)}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '8px' }}>
              <button onClick={() => loadQuoteForEdit(viewQuote)} style={btnStyle('#60a5fa', 'var(--card)')}>Edit / Resend</button>
              {viewQuote.netsuite_estimate_id && (
                <button onClick={() => viewEstimatePdf(viewQuote.netsuite_estimate_id)} style={btnStyle('#a78bfa', 'var(--card)')}>
                  NetSuite PDF
                </button>
              )}
              <button onClick={() => setViewQuote(null)} style={btnStyle('#94a3b8', 'var(--card)')}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ================= PRICING ================= */}
      {tab === 'pricing' && (
        <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px', maxWidth: '640px' }}>
          {sectionHead('Films')}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '8px' }}>
            <div>
              <div style={labelStyle}>Film</div>
              <select value={subSel} onChange={e => pickSubstrate(e.target.value)} style={{ ...inputStyle, width: '170px' }}>
                <option value="">— New —</option>
                {substrates.map(s => <option key={s.id} value={s.id}>{filmLabel(s)}{s.is_active === false ? ' (inactive)' : ''}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>Film Name</div>
              <input value={subForm.name} onChange={e => setSubForm({ ...subForm, name: e.target.value })} placeholder="e.g. 3M IJ280" style={{ ...inputStyle, width: '150px' }} />
            </div>
            <div>
              <div style={labelStyle}>Film ($/ft²)</div>
              <input type="number" value={subForm.price_per_sqft} onChange={e => setSubForm({ ...subForm, price_per_sqft: e.target.value })} style={{ ...inputStyle, width: '85px' }} />
            </div>
            <div>
              <div style={labelStyle}>Laminate</div>
              <input value={subForm.laminate_name} onChange={e => setSubForm({ ...subForm, laminate_name: e.target.value })} placeholder="e.g. 8428" style={{ ...inputStyle, width: '100px' }} />
            </div>
            <div>
              <div style={labelStyle}>Laminate ($/ft²)</div>
              <input type="number" value={subForm.laminate_price_per_sqft} onChange={e => setSubForm({ ...subForm, laminate_price_per_sqft: e.target.value })} style={{ ...inputStyle, width: '85px' }} />
            </div>
            <div>
              <div style={labelStyle}>Bleed (in)</div>
              <input type="number" value={subForm.bleed_in} onChange={e => setSubForm({ ...subForm, bleed_in: e.target.value })} style={{ ...inputStyle, width: '75px' }} />
            </div>
            <div>
              <div style={labelStyle}>Labor ($/ft²)</div>
              <input type="number" value={subForm.labor_per_sqft} onChange={e => setSubForm({ ...subForm, labor_per_sqft: e.target.value })} style={{ ...inputStyle, width: '85px' }} />
            </div>
            <div>
              <div style={labelStyle}>Box Color</div>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center', padding: '6px 0' }}>
                {FILM_COLORS.map(c => (
                  <button key={c} onClick={() => setSubForm({ ...subForm, color: c })} title={c} style={{
                    width: '18px', height: '18px', borderRadius: '5px', background: c, cursor: 'pointer',
                    border: subForm.color === c ? '2px solid var(--text-primary)' : '2px solid transparent',
                  }} />
                ))}
              </div>
            </div>
            <button onClick={saveSubstrate} style={btnStyle('#22c55e', 'rgba(34,197,94,0.1)')}>Save</button>
            {subSel && (
              <button onClick={() => { const s = substrates.find(x => x.id === subSel); if (s) toggleSubstrate(s); }} style={btnStyle('#f59e0b', 'rgba(245,158,11,0.08)')}>
                {substrates.find(x => x.id === subSel)?.is_active === false ? 'Reactivate' : 'Deactivate'}
              </button>
            )}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '16px' }}>
            Film + laminate price together as one material (e.g. IJ280 + 8428) and appear as one quote line. Bleed is extra print margin added to each side of a measured area. The color is what that film's boxes look like on the vehicle, so mixing films (print layer + reflective on top) stays readable.
          </div>

          {sectionHead('Taxes')}
          <div style={{ marginBottom: '16px' }}>
            <div style={labelStyle}>Tax Rate (%)</div>
            <input type="number" value={settings.tax_rate || ''} onChange={e => setSettings(prev => ({ ...prev, tax_rate: num(e.target.value) }))} style={{ ...inputStyle, width: '110px' }} />
          </div>

          {laborEditor('design', 'Design')}
          {laborEditor('preparation', 'Preparation')}
          {laborEditor('installation', 'Installation')}

          <button onClick={() => saveSettings()} disabled={savingSettings} style={{ ...btnStyle('#fff', '#22c55e'), border: 'none', padding: '9px 18px' }}>
            {savingSettings ? 'Saving…' : 'Save Pricing Settings'}
          </button>
        </div>
      )}

      {/* ================= COMPANY INFO ================= */}
      {tab === 'company' && (
        <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px', maxWidth: '480px' }}>
          {sectionHead('Company Information')}
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '10px' }}>Shown in the header of every quote you send.</div>
          <div style={{ marginBottom: '10px' }}>
            <div style={labelStyle}>Logo</div>
            {settings.company.logo_path && (
              <div style={{ background: '#fff', border: `1px solid ${theme.border}`, borderRadius: '8px', padding: '10px', marginBottom: '6px', display: 'inline-block' }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- logo dimensions are unknown; next/image needs fixed sizes */}
                <img src={imageUrl(settings.company.logo_path)} alt="Company logo" style={{ maxHeight: '56px', maxWidth: '220px', display: 'block' }} />
              </div>
            )}
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <label style={{ ...btnStyle('#a78bfa', 'rgba(167,139,250,0.08)'), display: 'inline-block' }}>
                {settings.company.logo_path ? 'Replace Logo' : 'Upload Logo'}
                <input type="file" accept="image/*" onChange={e => { uploadLogo(e.target.files?.[0] || null); e.target.value = ''; }} style={{ display: 'none' }} />
              </label>
              {settings.company.logo_path && (
                <button onClick={removeLogo} style={btnStyle('#ef4444', 'transparent')}>Remove</button>
              )}
            </div>
          </div>
          {([
            ['name', 'Company Name'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'Zip'], ['phone', 'Phone'], ['email', 'Email'],
          ] as const).map(([k, label]) => (
            <div key={k} style={{ marginBottom: '6px' }}>
              <div style={labelStyle}>{label}</div>
              <input value={(settings.company as any)[k] || ''} onChange={e => setSettings(prev => ({ ...prev, company: { ...prev.company, [k]: e.target.value } }))} style={inputStyle} />
            </div>
          ))}
          <button onClick={() => saveSettings()} disabled={savingSettings} style={{ ...btnStyle('#fff', '#22c55e'), border: 'none', padding: '9px 18px', marginTop: '8px' }}>
            {savingSettings ? 'Saving…' : 'Save Company Info'}
          </button>
        </div>
      )}

      {/* ================= TEMPLATES ================= */}
      {tab === 'templates' && (
        <div>
          {(() => {
            const uncalibrated = templates.filter(t => !t.px_per_in).length;
            if (uncalibrated === 0 && !calibStatus) return null;
            return (
              <div style={{ background: 'var(--card)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
                {sectionHead('Auto-Calibration')}
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '10px' }}>
                  {uncalibrated > 0
                    ? `${uncalibrated} template${uncalibrated !== 1 ? 's' : ''} not calibrated yet. Templates imported with their vector file (EPS/AI) can be calibrated automatically — the vector artboard declares its real size, and the drawings are 1:20, so no measuring is needed.`
                    : 'All templates are calibrated.'}
                </div>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                  {uncalibrated > 0 && (
                    <button onClick={autoCalibrateAll} disabled={calibrating} style={{ ...btnStyle('#fff', '#f59e0b'), border: 'none' }}>
                      {calibrating ? 'Calibrating…' : `Auto-Calibrate ${uncalibrated} Template${uncalibrated !== 1 ? 's' : ''}`}
                    </button>
                  )}
                  {calibStatus && <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>{calibStatus}</span>}
                </div>
              </div>
            );
          })()}

          <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
            {sectionHead('Add Template')}
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '10px' }}>
              Add a single template image here (PNG/JPG), or use <b>Bulk Upload</b> in the More menu to import a ZIP of EPS files with preview images — bulk imports calibrate themselves from the vector artboard. Single image uploads need one manual calibration in the Estimator (draw a line over a known dimension).
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div><div style={labelStyle}>Year</div><input value={tplForm.year} onChange={e => setTplForm({ ...tplForm, year: e.target.value })} style={{ ...inputStyle, width: '80px' }} /></div>
              <div><div style={labelStyle}>Make *</div><input value={tplForm.make} onChange={e => setTplForm({ ...tplForm, make: e.target.value })} style={{ ...inputStyle, width: '120px' }} /></div>
              <div><div style={labelStyle}>Model *</div><input value={tplForm.model} onChange={e => setTplForm({ ...tplForm, model: e.target.value })} style={{ ...inputStyle, width: '130px' }} /></div>
              <div><div style={labelStyle}>Variant</div><input value={tplForm.variant} onChange={e => setTplForm({ ...tplForm, variant: e.target.value })} placeholder="Double Cab 6ft Bed" style={{ ...inputStyle, width: '170px' }} /></div>
              <div><div style={labelStyle}>Code</div><input value={tplForm.code} onChange={e => setTplForm({ ...tplForm, code: e.target.value })} placeholder="ToyP_602" style={{ ...inputStyle, width: '100px' }} /></div>
              <div><div style={labelStyle}>Overall Length (in)</div><input type="number" value={tplForm.length} onChange={e => setTplForm({ ...tplForm, length: e.target.value })} style={{ ...inputStyle, width: '110px' }} /></div>
              <label style={{ ...btnStyle('#a78bfa', 'rgba(167,139,250,0.08)'), display: 'inline-block' }}>
                {tplFile ? tplFile.name.slice(0, 24) : 'Choose Image'}
                <input type="file" accept="image/*" onChange={e => setTplFile(e.target.files?.[0] || null)} style={{ display: 'none' }} />
              </label>
              <button onClick={uploadTemplate} disabled={tplUploading} style={{ ...btnStyle('#fff', '#22c55e'), border: 'none' }}>
                {tplUploading ? 'Uploading…' : 'Add Template'}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
            <input
              value={tplGridSearch}
              onChange={e => setTplGridSearch(e.target.value)}
              placeholder="Search templates by year, make, model, or code…"
              style={{ ...inputStyle, flex: 1, maxWidth: '360px' }}
            />
            {tplGridSearch.trim() && (
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>
                {templates.filter(t => matchesTemplateSearch(t, tplGridSearch)).length} of {templates.length}
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px' }}>
            {templates.filter(t => matchesTemplateSearch(t, tplGridSearch)).map(t => (
              <div key={t.id} style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '10px', overflow: 'hidden' }}>
                <div style={{ background: '#fff', height: '110px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- R2-hosted, dimensions unknown */}
                  <img src={imageUrl(t.template_image_path)} alt={t.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                </div>
                <div style={{ padding: '8px 10px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>{templateLabel(t)}</div>
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    {t.template_code || 'no code'} · {t.scale || '1:20'} · {t.px_per_in ? 'calibrated' : 'not calibrated'}
                  </div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button onClick={() => { setTemplateId(t.id); setImgDim(null); resetEstimate(); setTab('estimator'); }} style={btnStyle('#06b6d4', 'rgba(6,182,212,0.08)')}>Open</button>
                    <button onClick={() => toggleTemplate(t)} style={btnStyle('#f59e0b', 'transparent')}>{t.is_active === false ? 'Reactivate' : 'Retire'}</button>
                    {isAdmin && (
                      <button onClick={() => deleteTemplate(t)} style={btnStyle('#ef4444', 'transparent')} title="Delete this template permanently">✕</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
