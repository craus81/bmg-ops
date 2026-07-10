'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { storage } from '@/lib/storage';
import { apiFetch } from '@/lib/api-client';
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

interface Substrate {
  id: string;
  name: string;
  price_per_sqft: number;
  bleed_in: number;
  is_active: boolean | null;
}

interface LaborSection { flat: number; hourly: number; hours: number; extra: number }

interface Company {
  name?: string; address?: string; city?: string; state?: string; zip?: string;
  phone?: string; email?: string;
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
  vehicle_description: string | null;
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
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [substrates, setSubstrates] = useState<Substrate[]>([]);
  const [settings, setSettings] = useState<Settings>({ company: {}, tax_rate: 0, design: EMPTY_LABOR, preparation: EMPTY_LABOR, installation: EMPTY_LABOR });
  const [history, setHistory] = useState<WrapQuote[]>([]);

  // ----- Estimator state -----
  const [yearFilter, setYearFilter] = useState('');
  const [makeFilter, setMakeFilter] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [imgDim, setImgDim] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  // ----- Pricing tab state (edit copies) -----
  const [subSel, setSubSel] = useState(''); // '' = new
  const [subForm, setSubForm] = useState({ name: '', price_per_sqft: '', bleed_in: '' });
  const [savingSettings, setSavingSettings] = useState(false);

  // ----- Templates tab state -----
  const [tplForm, setTplForm] = useState({ year: '', make: '', model: '', variant: '', code: '', length: '' });
  const [tplFile, setTplFile] = useState<File | null>(null);
  const [tplUploading, setTplUploading] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibStatus, setCalibStatus] = useState('');
  const [clearing, setClearing] = useState(false);
  const [clearStatus, setClearStatus] = useState('');

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
    setSubstrates((subRes.data || []) as Substrate[]);
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

  // Retired templates stay in state (the Templates tab manages them) but are
  // hidden from the estimator's vehicle pickers.
  const activeTemplates = useMemo(() => templates.filter(t => t.is_active !== false), [templates]);
  const years = useMemo(() => [...new Set(activeTemplates.map(t => t.year).filter(Boolean) as string[])].sort().reverse(), [activeTemplates]);
  const makes = useMemo(() => [...new Set(activeTemplates.filter(t => !yearFilter || t.year === yearFilter).map(t => t.make))].sort(), [activeTemplates, yearFilter]);
  const templateOptions = useMemo(() =>
    activeTemplates.filter(t => (!yearFilter || t.year === yearFilter) && (!makeFilter || t.make === makeFilter)),
    [activeTemplates, yearFilter, makeFilter]);

  // ----- Pricing math -----
  const measurementPricing = (m: Measurement) => {
    const sub = substrateById(m.substrate_id);
    const bleed = sub ? num(sub.bleed_in) : 0;
    const trimArea = unitAreaSqft(m, 0);
    const billedArea = unitAreaSqft(m, bleed);
    const unitPrice = billedArea * (sub ? num(sub.price_per_sqft) : 0);
    return { sub, trimArea, billedArea, unitPrice, lineTotal: unitPrice * Math.max(1, num(m.qty)) };
  };

  const totals = useMemo(() => {
    let area = 0, materials = 0;
    for (const m of measurements) {
      const p = measurementPricing(m);
      area += p.trimArea * Math.max(1, num(m.qty));
      materials += p.lineTotal;
    }
    const design = laborSectionTotal(settings.design);
    const prep = laborSectionTotal(settings.preparation);
    const install = laborSectionTotal(settings.installation);
    const labor = design + prep + install;
    const subtotal = materials + labor;
    const tax = subtotal * num(settings.tax_rate) / 100;
    return { area, materials, design, prep, install, labor, subtotal, tax, total: subtotal + tax };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- substrates feed measurementPricing
  }, [measurements, settings, substrates]);

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
    if (!drag) return;
    const p = svgPoint(e);
    if (!p) return;
    setDrag(d => d ? { ...d, x2: p.x, y2: p.y } : d);
  };

  const onPointerUp = () => {
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
        substrate_id: activeSubstrates[0]?.id || null,
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
        substrate_id: activeSubstrates[0]?.id || null,
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
    setMeasurements(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  };

  const removeMeasurement = (id: string) => {
    setMeasurements(prev => prev.filter(m => m.id !== id));
    if (selectedId === id) setSelectedId(null);
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
  const buildSnapshot = () => {
    const lines = measurements.map(m => {
      const p = measurementPricing(m);
      return {
        name: m.name,
        type: m.type,
        qty: Math.max(1, num(m.qty)),
        dim1_in: num(m.dim1_in),
        dim2_in: num(m.dim2_in),
        substrate: p.sub ? { id: p.sub.id, name: p.sub.name, price_per_sqft: num(p.sub.price_per_sqft), bleed_in: num(p.sub.bleed_in) } : null,
        trim_area_sqft: p.trimArea,
        billed_area_sqft: p.billedArea,
        unit_price: p.unitPrice,
        line_total: p.lineTotal,
      };
    });
    return {
      quote_number: quoteNumber || `WQ-${Date.now().toString(36).toUpperCase()}`,
      template_id: template?.id || null,
      vehicle_description: template ? templateLabel(template) : null,
      customer_id: customerId,
      customer,
      project_type: projectType || null,
      project_notes: projectNotes || null,
      measurements: lines,
      labor: {
        design: { ...settings.design, total: totals.design },
        preparation: { ...settings.preparation, total: totals.prep },
        installation: { ...settings.installation, total: totals.install },
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

  const saveQuote = async (): Promise<string | null> => {
    const snap = buildSnapshot();
    if (!quoteNumber) setQuoteNumber(snap.quote_number);
    if (savedQuoteId) {
      const { error } = await supabase.from('wrap_quotes').update({ ...snap, updated_at: new Date().toISOString() }).eq('id', savedQuoteId);
      if (error) { await dialog.alert(`Save failed: ${error.message}`); return null; }
      await loadAll();
      return savedQuoteId;
    }
    const { data, error } = await supabase.from('wrap_quotes').insert({ ...snap, created_by: user?.id }).select('id').single();
    if (error || !data) { await dialog.alert(`Save failed: ${error?.message || 'unknown error'}`); return null; }
    setSavedQuoteId(data.id);
    await loadAll();
    return data.id;
  };

  const createAndEmail = async () => {
    if (!customer.email?.trim()) { await dialog.alert('Enter a customer email first.'); return; }
    if (measurements.length === 0) { await dialog.alert('No measurements — draw the wrap areas on the Estimator tab first.'); return; }
    if (!(await dialog.confirm(`Email this quote ($${fmt(totals.total)}) to ${customer.email}? Make sure everything is accurate — this sends immediately.`))) return;
    setSending(true);
    try {
      const id = await saveQuote();
      if (!id) return;
      const res = await apiFetch('/api/wrap-quote/send', {
        method: 'POST',
        body: JSON.stringify({ quoteId: id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        await dialog.alert(`Email failed: ${data.error || 'Unknown error'}`);
      } else {
        await dialog.alert(`Quote emailed to ${customer.email}`);
        await loadAll();
        setTab('history');
      }
    } catch (e: any) {
      await dialog.alert(`Email failed: ${e.message}`);
    } finally {
      setSending(false);
    }
  };

  // ----- Pricing tab handlers -----
  const pickSubstrate = (id: string) => {
    setSubSel(id);
    const s = substrates.find(x => x.id === id);
    setSubForm(s ? { name: s.name, price_per_sqft: String(s.price_per_sqft), bleed_in: String(s.bleed_in) } : { name: '', price_per_sqft: '', bleed_in: '' });
  };

  const saveSubstrate = async () => {
    if (!subForm.name.trim()) { await dialog.alert('Substrate needs a name.'); return; }
    const row = { name: subForm.name.trim(), price_per_sqft: num(subForm.price_per_sqft), bleed_in: num(subForm.bleed_in), updated_at: new Date().toISOString() };
    const { error } = subSel
      ? await supabase.from('wrap_substrates').update(row).eq('id', subSel)
      : await supabase.from('wrap_substrates').insert({ ...row, is_active: true });
    if (error) { await dialog.alert(`Save failed: ${error.message}`); return; }
    setSubSel(''); setSubForm({ name: '', price_per_sqft: '', bleed_in: '' });
    await loadAll();
  };

  const toggleSubstrate = async (s: Substrate) => {
    await supabase.from('wrap_substrates').update({ is_active: s.is_active === false }).eq('id', s.id);
    await loadAll();
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    const { error } = await supabase.from('wrap_quote_settings').upsert({
      id: 1,
      company: settings.company,
      tax_rate: num(settings.tax_rate),
      design: settings.design,
      preparation: settings.preparation,
      installation: settings.installation,
      updated_at: new Date().toISOString(),
    });
    setSavingSettings(false);
    if (error) await dialog.alert(`Save failed: ${error.message}`);
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
  const clearLibrary = async () => {
    if (!(await dialog.confirm(
      `Delete the entire template library (${templates.length} template${templates.length !== 1 ? 's' : ''})? Templates used by existing quotes are kept but retired. This cannot be undone.`,
      { destructive: true, confirmLabel: 'Delete All' }
    ))) return;
    setClearing(true);
    setClearStatus('Deleting…');
    let deleted = 0, retired = 0;
    try {
      for (let batch = 0; batch < 1000; batch++) {
        const res = await apiFetch('/api/admin/clear-templates', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setClearStatus(`Failed: ${data.error || 'Unknown error'}`);
          return;
        }
        deleted += data.deleted;
        retired += data.retired;
        if (data.remaining <= 0) break;
        setClearStatus(`Deleted ${deleted} — ${data.remaining} to go…`);
      }
      setClearStatus(`Done — ${deleted} deleted${retired ? `, ${retired} retired (still referenced by quotes)` : ''}.`);
      await loadAll();
    } catch (e: any) {
      setClearStatus(`Failed: ${e.message}`);
    } finally {
      setClearing(false);
    }
  };

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

  // Quote preview shared by the Quote tab and History view modal
  const quotePreview = (q: { quote_number: string; vehicle_description: string | null; customer: any; project_type: string | null; project_notes: string | null; measurements: any[]; labor: any; subtotal: number; tax_rate: number; tax_amount: number; total: number; created_at?: string }) => (
    <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)' }}>Wrap Quote <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700 }}>{q.quote_number}</span></div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>{new Date(q.created_at || Date.now()).toLocaleDateString()}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px', fontSize: '11px', color: 'var(--text-secondary)' }}>
        <div>
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
      <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px', fontSize: '12px', color: 'var(--text-primary)' }}>
        <div>Subtotal <b style={{ marginLeft: '14px' }}>${fmt(q.subtotal)}</b></div>
        <div>Tax ({fmt(q.tax_rate)}%) <b style={{ marginLeft: '14px' }}>${fmt(q.tax_amount)}</b></div>
        <div style={{ fontSize: '15px', fontWeight: 800 }}>Total <span style={{ marginLeft: '14px', color: '#22c55e' }}>${fmt(q.total)}</span></div>
      </div>
      {q.project_notes && <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--text-secondary)' }}><b>Project Notes:</b> {q.project_notes}</div>}
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
          { id: 'quote' as Tab, label: 'Generate Quote', color: '#22c55e' },
          { id: 'history' as Tab, label: `Quote History (${history.length})`, color: '#a78bfa' },
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
            <select value={templateId} onChange={e => { setTemplateId(e.target.value); setImgDim(null); resetEstimate(); }} style={{ ...inputStyle, flex: 1, minWidth: '220px' }}>
              <option value="">— Select vehicle template —</option>
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
                    { id: 'circle' as Tool, label: 'Draw Circle' },
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
                    <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>{m.name}</span>
                    <button onClick={e => { e.stopPropagation(); removeMeasurement(m.id); }} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
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
                      <div style={labelStyle}>Substrate</div>
                      <select value={selected.substrate_id || ''} onChange={e => updateMeasurement(selected.id, { substrate_id: e.target.value || null })} style={{ ...inputStyle, marginBottom: '6px' }}>
                        <option value="">— none —</option>
                        {activeSubstrates.map(s => <option key={s.id} value={s.id}>{s.name} (${fmt(s.price_per_sqft)}/ft²)</option>)}
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
                        const stroke = sel ? '#f59e0b' : '#06b6d4';
                        const fill = sel ? 'rgba(245,158,11,0.18)' : 'rgba(6,182,212,0.15)';
                        const fontSize = imgDim.w / 70;
                        return (
                          <g key={m.id} onPointerDown={e => { if (tool === 'select') { e.stopPropagation(); setSelectedId(m.id); } }} style={{ cursor: 'pointer' }}>
                            {m.type === 'box' && m.rect && (
                              <rect x={m.rect.x} y={m.rect.y} width={m.rect.w} height={m.rect.h} fill={fill} stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />
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
                  }}>Create Quote →</button>
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
            {sectionHead('Project')}
            <div style={{ marginBottom: '6px' }}>
              <div style={labelStyle}>Type</div>
              <input value={projectType} onChange={e => setProjectType(e.target.value)} placeholder="e.g. Full truck wrap" style={inputStyle} />
            </div>
            <div style={{ marginBottom: '12px' }}>
              <div style={labelStyle}>Note</div>
              <textarea value={projectNotes} onChange={e => setProjectNotes(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button onClick={() => saveQuote()} style={btnStyle('#60a5fa', 'rgba(59,130,246,0.1)')}>{savedQuoteId ? 'Update Draft' : 'Save Draft'}</button>
              <button onClick={createAndEmail} disabled={sending} style={{ ...btnStyle('#fff', '#22c55e'), border: 'none' }}>
                {sending ? 'Sending…' : 'Create & Email Quote'}
              </button>
            </div>
            {measurements.length === 0 && (
              <div style={{ marginTop: '8px', fontSize: '10px', color: '#fbbf24', fontWeight: 700 }}>No measurements yet — use the Estimator tab first.</div>
            )}
          </div>
          {quotePreview({ ...buildSnapshot(), created_at: new Date().toISOString() } as any)}
        </div>
      )}

      {/* ================= HISTORY ================= */}
      {tab === 'history' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {history.length === 0 && <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>No quotes yet.</div>}
          {history.map(q => (
            <button key={q.id} onClick={() => setViewQuote(q)} style={{
              display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px', borderRadius: '8px', textAlign: 'left',
              background: 'var(--card)', border: `1px solid ${theme.border}`, cursor: 'pointer',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {q.customer?.name || 'No customer'}
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: '8px' }}>{q.quote_number}</span>
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{q.vehicle_description || '—'}{q.project_type ? ` · ${q.project_type}` : ''}</div>
              </div>
              <span style={{
                fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px',
                background: q.status === 'sent' ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.12)',
                color: q.status === 'sent' ? '#22c55e' : '#94a3b8',
              }}>{q.status === 'sent' ? `Sent${q.sent_to ? ` · ${q.sent_to}` : ''}` : 'Draft'}</span>
              <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>${fmt(q.total)}</span>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{new Date(q.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            </button>
          ))}
        </div>
      )}

      {viewQuote && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }} onClick={() => setViewQuote(null)}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '640px', maxHeight: '90vh', overflowY: 'auto' }}>
            {quotePreview(viewQuote)}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
              <button onClick={() => setViewQuote(null)} style={btnStyle('#94a3b8', 'var(--card)')}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ================= PRICING ================= */}
      {tab === 'pricing' && (
        <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px', maxWidth: '640px' }}>
          {sectionHead('Substrates')}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '8px' }}>
            <div>
              <div style={labelStyle}>Substrate</div>
              <select value={subSel} onChange={e => pickSubstrate(e.target.value)} style={{ ...inputStyle, width: '170px' }}>
                <option value="">— New —</option>
                {substrates.map(s => <option key={s.id} value={s.id}>{s.name}{s.is_active === false ? ' (inactive)' : ''}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>Name</div>
              <input value={subForm.name} onChange={e => setSubForm({ ...subForm, name: e.target.value })} placeholder="e.g. Cast vinyl + laminate" style={{ ...inputStyle, width: '190px' }} />
            </div>
            <div>
              <div style={labelStyle}>Price ($/ft²)</div>
              <input type="number" value={subForm.price_per_sqft} onChange={e => setSubForm({ ...subForm, price_per_sqft: e.target.value })} style={{ ...inputStyle, width: '90px' }} />
            </div>
            <div>
              <div style={labelStyle}>Bleed (in)</div>
              <input type="number" value={subForm.bleed_in} onChange={e => setSubForm({ ...subForm, bleed_in: e.target.value })} style={{ ...inputStyle, width: '80px' }} />
            </div>
            <button onClick={saveSubstrate} style={btnStyle('#22c55e', 'rgba(34,197,94,0.1)')}>Save</button>
            {subSel && (
              <button onClick={() => { const s = substrates.find(x => x.id === subSel); if (s) toggleSubstrate(s); }} style={btnStyle('#f59e0b', 'rgba(245,158,11,0.08)')}>
                {substrates.find(x => x.id === subSel)?.is_active === false ? 'Reactivate' : 'Deactivate'}
              </button>
            )}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '16px' }}>
            The price drives quote generation; bleed is extra print margin added to each side of a measured area before pricing.
          </div>

          {sectionHead('Taxes')}
          <div style={{ marginBottom: '16px' }}>
            <div style={labelStyle}>Tax Rate (%)</div>
            <input type="number" value={settings.tax_rate || ''} onChange={e => setSettings(prev => ({ ...prev, tax_rate: num(e.target.value) }))} style={{ ...inputStyle, width: '110px' }} />
          </div>

          {laborEditor('design', 'Design')}
          {laborEditor('preparation', 'Preparation')}
          {laborEditor('installation', 'Installation')}

          <button onClick={saveSettings} disabled={savingSettings} style={{ ...btnStyle('#fff', '#22c55e'), border: 'none', padding: '9px 18px' }}>
            {savingSettings ? 'Saving…' : 'Save Pricing Settings'}
          </button>
        </div>
      )}

      {/* ================= COMPANY INFO ================= */}
      {tab === 'company' && (
        <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px', maxWidth: '480px' }}>
          {sectionHead('Company Information')}
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '10px' }}>Shown in the header of every quote you send.</div>
          {([
            ['name', 'Company Name'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'Zip'], ['phone', 'Phone'], ['email', 'Email'],
          ] as const).map(([k, label]) => (
            <div key={k} style={{ marginBottom: '6px' }}>
              <div style={labelStyle}>{label}</div>
              <input value={(settings.company as any)[k] || ''} onChange={e => setSettings(prev => ({ ...prev, company: { ...prev.company, [k]: e.target.value } }))} style={inputStyle} />
            </div>
          ))}
          <button onClick={saveSettings} disabled={savingSettings} style={{ ...btnStyle('#fff', '#22c55e'), border: 'none', padding: '9px 18px', marginTop: '8px' }}>
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
            {isAdmin && templates.length > 0 && (
              <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button onClick={clearLibrary} disabled={clearing} style={btnStyle('#ef4444', 'rgba(239,68,68,0.08)')}>
                  {clearing ? 'Deleting…' : 'Delete All Templates'}
                </button>
                <span style={{ fontSize: '10px', fontWeight: clearStatus ? 700 : 400, color: clearStatus ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                  {clearStatus || 'Clears the library for a fresh bulk import. Templates already used on a quote are retired, not deleted.'}
                </span>
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px' }}>
            {templates.map(t => (
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
