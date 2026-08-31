'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { deepLinks } from '@/lib/deep-links';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { storage } from '@/lib/storage';
import { apiFetch } from '@/lib/api-client';
import { formatPhoneInput } from '@/lib/utils';
import { fetchAllRows } from '@/lib/fetch-all';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';
import { DropZone } from '@/components/DropZone';
import { theme } from '@/lib/theme';
import { RollNesting, RollFilmInfo } from '@/components/RollNesting';
import NumberInput from '@/components/NumberInput';
import EmailComposeModal, { type EmailComposeFields } from '@/components/EmailComposeModal';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';
import { estimateHeadlineNumber } from '@/lib/estimate-number';
import {
  DEFAULT_ROLL,
  MAX_ROLLS_PER_FILM,
  NestPiece,
  PlacementMap,
  RollConfig,
  computeUsage,
  ellipseOutline,
  fmtFtIn,
  offsetArea,
  partLetter,
  pieceKey,
  polygonArea,
  polygonPerimeter,
  polygonSelfIntersects,
  reconcilePlacements,
  scaleOutline,
  splitForRoll,
  splitOutlineForRoll,
} from '@/lib/roll-nesting';

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
  // What the material actually costs us per ft² (price_per_sqft is what we
  // charge) — drives the internal margin readout.
  cost_per_sqft: number | null;
  laminate_cost_per_sqft: number | null;
}

const FILM_COLORS = ['#06b6d4', '#a78bfa', '#f472b6', '#4ade80', '#fb923c', '#facc15', '#60a5fa', '#f87171'];
const filmLabel = (f: Film) => f.laminate_name ? `${f.name} + ${f.laminate_name}` : f.name;
const filmRate = (f: Film) => num(f.price_per_sqft) + num(f.laminate_price_per_sqft);
const filmCost = (f: Film) => num(f.cost_per_sqft) + num(f.laminate_cost_per_sqft);
const filmHasCost = (f: Film) => f.cost_per_sqft != null || f.laminate_cost_per_sqft != null;

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

// Quantity-discount tier: pct applies once the kit count reaches min_qty
// (highest qualifying pct wins).
interface QtyDiscountTier { min_qty: number; pct: number }

interface Settings {
  company: Company;
  tax_rate: number;
  design: LaborSection;
  preparation: LaborSection;
  installation: LaborSection;
  // Job-pricing policy: pre-tax floor for any job + quantity discount tiers.
  min_job_charge: number;
  qty_discounts: QtyDiscountTier[];
}

type MType = 'box' | 'circle' | 'roof' | 'hood' | 'poly';

// Geometry is stored in template-image pixel coordinates so shapes redraw
// at any display size; dim1_in/dim2_in are the real-world dimensions and are
// the source of truth for pricing (the user can override them numerically).
// Freeform shapes ('poly') additionally carry their closed outline plus the
// real polygon area/perimeter in inches — dims alone would overbill an
// L-shape or door cutout by its bounding box.
interface Measurement {
  id: string;
  name: string;
  type: MType;
  rect?: { x: number; y: number; w: number; h: number };
  line1?: { x1: number; y1: number; x2: number; y2: number };
  line2?: { x1: number; y1: number; x2: number; y2: number };
  points?: { x: number; y: number }[];
  area_in2?: number;
  perimeter_in?: number;
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
  // Follow-up state (quote-followups queue) — surfaced on sent history
  // rows so chasing happens from here too.
  last_followup_at: string | null;
  approval_token: string | null;
  accepted_at: string | null;
  customer_rejection_reason: string | null;
  diagram_path: string | null;
  attachments: QuoteAttachment[] | null;
  archived_at: string | null;
  netsuite_estimate_id: string | null;
  netsuite_estimate_number: string | null;
  package_qty: number | null;
  adjustments: QuoteAdjustments | null;
  nesting: NestingSnapshot | null;
  created_at: string;
}

// Saved roll-nesting layout + usage rollup. `enabled` = materials were
// priced from roll consumption (width × used length per film) instead of
// per-shape area; the layout is stored either way so reopening a quote
// restores the arrangement. Placements reference measurements by index
// into the snapshot's measurements array (ids are regenerated on load).
interface NestingSnapshot {
  enabled: boolean;
  roll_width_in: number;
  roll_length_in: number;
  spacing_in: number;
  edge_margin_in: number;
  overlap_in: number;
  sets: number;
  films: {
    film_id: string | null;
    label: string;
    rate_per_sqft: number;
    rolls: { used_length_in: number; piece_count: number }[];
    roll_sqft: number;
    graphic_sqft: number;
    // ft² billed by area rather than roll usage (pieces that couldn't be
    // placed); material_total = (roll_sqft + extra_area_sqft) × rate so the
    // rendered rows always sum to the stored materials_total.
    extra_area_sqft: number;
    material_total: number;
  }[];
  unplaced: { name: string; w_in: number; h_in: number; film_id: string | null }[];
  // part: -1 = whole panel, 0+ = index of a lettered split strip (A, B, …)
  placements: { m: number; copy: number; set: number; part: number; roll: number; x: number; y: number; rot: 0 | 90 }[];
}

// How the final totals were reached, snapshotted for display: the pre-
// adjustment numbers plus the discount/minimum applied. The stored
// materials_total/labor_total already have these folded in.
interface QuoteAdjustments {
  package_qty: number;
  kit_area_sqft: number;
  kit_materials: number;
  pre_materials: number;
  pre_labor: number;
  pre_subtotal: number;
  discount_pct: number;
  discount_amount: number;
  min_charge: number;
  min_bump: number;
}

type Tab = 'estimator' | 'nesting' | 'quote' | 'history' | 'pricing' | 'company' | 'templates';
type Tool = 'select' | 'box' | 'circle' | 'roof' | 'hood' | 'poly' | 'calibrate';

const EMPTY_LABOR: LaborSection = { flat: 0, hourly: 0, hours: 0, extra: 0 };
const fmt = (n: number) => (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v: any) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

const laborSectionTotal = (s: LaborSection) => num(s.flat) + num(s.hourly) * num(s.hours) + num(s.extra);

// A column this page writes that the database doesn't have yet comes back
// from PostgREST as PGRST204 ("Could not find the 'x' column … in the schema
// cache") — the deploy is ahead of the database, not anything the user did.
// Say that, with the command that fixes it, instead of the raw string.
const saveErrorMessage = (error: { message?: string; code?: string } | null | undefined) => {
  const msg = error?.message || 'unknown error';
  const schemaDrift = error?.code === 'PGRST204' || /schema cache|column .* does not exist/i.test(msg);
  return schemaDrift
    ? `${msg}\n\nThis database is missing a column this page writes, which means pending migrations haven't been applied. Run "npm run migrate" (list them first with "npm run migrate -- --dry-run").`
    : msg;
};

// Area of one unit, in ft². Bleed extends each dimension on both sides
// (print size), which is what gets billed. Freeform shapes bill their real
// polygon area grown by the bleed (A + P·b + πb²), not the bounding box.
const unitAreaSqft = (m: Measurement, bleedIn: number) => {
  if (m.type === 'poly') {
    return offsetArea(Math.max(0, num(m.area_in2)), Math.max(0, num(m.perimeter_in)), Math.max(0, bleedIn)) / 144;
  }
  const d1 = Math.max(0, num(m.dim1_in) + 2 * bleedIn);
  const d2 = Math.max(0, num(m.dim2_in) + 2 * bleedIn);
  if (m.type === 'circle') return (Math.PI * (d1 / 2) * (d2 / 2)) / 144;
  return (d1 * d2) / 144;
};

// Bounding box + real area/perimeter of a polygon drawn in template-image
// pixels, converted to inches with the template's calibration.
const polyMetrics = (points: { x: number; y: number }[], ppi: number) => {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const wPx = Math.max(...xs) - Math.min(...xs);
  const hPx = Math.max(...ys) - Math.min(...ys);
  const scale = ppi > 0 ? ppi : 1;
  return {
    dim1_in: wPx / scale,
    dim2_in: hPx / scale,
    area_in2: polygonArea(points) / (scale * scale),
    perimeter_in: polygonPerimeter(points) / scale,
  };
};

const templateLabel = (t: Template) =>
  [t.year, t.make, t.model, t.variant].filter(Boolean).join(' ');

// Template make/model/year come in verbatim from ZIP folder names, so the
// library holds mixed casings ("FORD" and "Ford") — every compare and dedupe
// over them must go through this.
const normText = (v?: string | null) => (v || '').trim().toLowerCase();

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
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [substrates, setSubstrates] = useState<Film[]>([]);
  const [settings, setSettings] = useState<Settings>({ company: {}, tax_rate: 0, design: EMPTY_LABOR, preparation: EMPTY_LABOR, installation: EMPTY_LABOR, min_job_charge: 0, qty_discounts: [] });
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
  // Freeform shape in progress: clicked vertices + the live cursor point
  // (image-pixel coords). Clicking the first vertex again closes the shape.
  const [polyDraft, setPolyDraft] = useState<{ x: number; y: number }[] | null>(null);
  const [polyHover, setPolyHover] = useState<{ x: number; y: number } | null>(null);
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
  // Follow-up actions on sent quotes (history rows) — same machinery as
  // /admin/quote-followups: a compose modal for the follow-up email and a
  // log-a-note dialog, both against /api/quotes/follow-up*.
  const [followupEmailFor, setFollowupEmailFor] = useState<WrapQuote | null>(null);
  const [followupNoteFor, setFollowupNoteFor] = useState<WrapQuote | null>(null);
  const [fuNote, setFuNote] = useState('');
  const [fuRemindAt, setFuRemindAt] = useState('');
  const [fuSaving, setFuSaving] = useState(false);
  const [attachments, setAttachments] = useState<QuoteAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // Email content checkboxes (replaced the single-select mode — you can now
  // mix them, e.g. picture + total with no line items, or pricing + PDF).
  const [sendInclude, setSendInclude] = useState<{ pricing: boolean; lineItems: boolean; diagram: boolean; netsuitePdf: boolean }>({
    pricing: true, lineItems: true, diagram: true, netsuitePdf: false,
  });
  // Email-the-quote compose (the standard EmailComposeModal): opens on a
  // saved quote id; the modal owns recipients/bcc/message/attachment picks
  // and pulls its live preview from the send route's dry run.
  const [emailModal, setEmailModal] = useState(false);
  const [emailQuoteId, setEmailQuoteId] = useState<string | null>(null);

  // Add Graphics round trip (?forEstimate=<id>): the estimate builder saved
  // itself and sent the rep here to price graphics. Prefill the customer,
  // pin a banner with the estimate's identity, and offer "Add to Estimate"
  // which writes the quote back as estimate lines and returns.
  const [forEstimate, setForEstimate] = useState<{
    id: string; number: string; customerName: string | null; vehicle: string | null;
  } | null>(null);
  const [addingToEstimate, setAddingToEstimate] = useState(false);
  // Vehicle identity carried over from the estimate; resolved against the
  // template library once it loads (loadAll races this effect on arrival).
  const [vehiclePrefill, setVehiclePrefill] = useState<{ year: string; label: string } | null>(null);
  const forEstimateHandled = useRef(false);
  useEffect(() => {
    const estId = searchParams.get('forEstimate');
    if (!estId || forEstimateHandled.current) return;
    forEstimateHandled.current = true;
    (async () => {
      const { data: est } = await supabase
        .from('estimates')
        .select('id, estimate_number, netsuite_estimate_number, customer_id, customer_name, vehicle_year, vehicle_roof, vehicle_wheelbase, vehicle_platform_id, vehicle_other, vin, unit_number, vehicle_platforms(label)')
        .eq('id', estId)
        .maybeSingle();
      if (!est) return;
      const platformLabel = (est as any).vehicle_platforms?.label || (est as any).vehicle_other || '';
      const vehicle = [
        est.vehicle_year,
        platformLabel,
        est.vehicle_roof ? `${est.vehicle_roof} roof` : null,
        est.vehicle_wheelbase ? `${est.vehicle_wheelbase}" WB` : null,
        est.unit_number ? `Unit ${est.unit_number}` : null,
        est.vin ? `VIN ${est.vin}` : null,
      ].filter(Boolean).join(' · ') || null;
      setForEstimate({ id: est.id, number: estimateHeadlineNumber(est), customerName: est.customer_name, vehicle });
      // Prefill on a fresh quote only — never clobber a loaded one.
      if (!savedQuoteId) {
        // Customer: same fields the customer picker fills, so the quote tab
        // doesn't ask her to re-type what the estimate already knows.
        if (est.customer_id) {
          setCustomerId(est.customer_id);
          const { data: cust } = await supabase
            .from('customers')
            .select('company_name, email, phone, address')
            .eq('id', est.customer_id)
            .maybeSingle();
          setCustomer((prev: any) => ({
            ...prev,
            name: prev.name || cust?.company_name || est.customer_name || '',
            email: prev.email || cust?.email || '',
            phone: prev.phone || cust?.phone || '',
            address: prev.address || cust?.address || '',
          }));
        }
        // Vehicle: hand the year + platform to the template matcher below.
        if (platformLabel || est.vehicle_year) {
          setVehiclePrefill({ year: String(est.vehicle_year ?? '').trim(), label: platformLabel });
        }
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on arrival
  }, [searchParams]);

  // What this quote contributes to the estimate's customer PDF — the
  // Add-to-Estimate checkboxes (coverage diagram / uploaded proofs /
  // vinyl details). Stored on the quote (estimate_attach) so the estimate
  // PDF generator knows what to merge in.
  const [estAttach, setEstAttach] = useState({ diagram: true, attachments: true, films: true });

  const addToEstimate = async () => {
    if (!forEstimate) return;
    setAddingToEstimate(true);
    try {
      const quoteId = await saveQuote();
      if (!quoteId) return;
      const res = await apiFetch(`/api/estimates/${forEstimate.id}/add-wrap-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wrapQuoteId: quoteId, attach: estAttach }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        await dialog.alert(`Could not add to the estimate: ${d.error || 'unknown error'}`);
        return;
      }
      router.push(`/estimates?id=${forEstimate.id}`);
    } finally {
      setAddingToEstimate(false);
    }
  };

  // Deep link from search/popout/notifications: ?id= opens that quote's
  // detail view over the history tab once the quote list has loaded.
  // The ref guards the handling window: loadAll() refreshes `history` after
  // every save/archive/delete, and until the router.replace below lands the
  // ?id= is still in the URL — without the guard each refresh would yank the
  // user back to the deep-linked quote. Once the quote is open the id is
  // consumed out of the URL and the ref cleared, so clicking the same
  // notification again re-opens the quote (it used to be a dead click).
  const handledQuoteId = useRef<string | null>(null);
  useEffect(() => {
    const qid = searchParams.get('id');
    if (!qid) { handledQuoteId.current = null; return; }
    if (history.length === 0 || handledQuoteId.current === qid) return;
    handledQuoteId.current = qid;
    const consume = () => router.replace('/admin/wrap-quote', { scroll: false });
    const q = history.find(h => h.id === qid);
    if (q) {
      setTab('history');
      setViewQuote(q);
      consume();
      return;
    }
    // Outside the newest-200 window the list loads — fetch it by id so an
    // old quote's accepted/rejected notification still lands on the quote.
    (async () => {
      const { data } = await supabase.from('wrap_quotes').select('*').eq('id', qid).maybeSingle();
      if (data) {
        setTab('history');
        setViewQuote(data);
      }
      consume();
    })();
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
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  // Graphics jobs spawned from wrap quotes, keyed by wrap_quote_id — powers
  // the job badge in history and stops duplicate creates.
  const [jobsByQuote, setJobsByQuote] = useState<Record<string, { id: string; job_number: string | null }>>({});
  const [creatingJobFor, setCreatingJobFor] = useState<string | null>(null);

  // ----- Pricing tab state (edit copies) -----
  const [subSel, setSubSel] = useState(''); // '' = new
  const [subForm, setSubForm] = useState({ name: '', price_per_sqft: '', bleed_in: '', laminate_name: '', laminate_price_per_sqft: '', labor_per_sqft: '', color: '', cost_per_sqft: '', laminate_cost_per_sqft: '' });
  const [savingSettings, setSavingSettings] = useState(false);
  // Margin floor (%) shared with the estimate builder (quote_settings singleton).
  const [marginFloor, setMarginFloor] = useState(30);

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
    const [tplRes, subRes, setRes, histRes, floorRes, jobsRes] = await Promise.all([
      // The template library can exceed PostgREST's silent 1000-row cap — a
      // bare select made everything past row 1000 unfindable in the pickers.
      fetchAllRows<Template>((from, to) =>
        supabase.from('vehicle_templates').select('id, name, make, model, year, variant, scale, template_code, template_image_path, px_per_in, overall_length_in, is_active').not('template_image_path', 'is', null).order('make').order('model').order('id').range(from, to)),
      supabase.from('wrap_substrates').select('*').order('name'),
      supabase.from('wrap_quote_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.from('wrap_quotes').select('*').order('created_at', { ascending: false }).limit(200),
      supabase.from('quote_settings').select('margin_floor_pct').eq('id', 1).maybeSingle(),
      // Paginated (R3-1 MAJOR sweep): this map is the "already converted"
      // guard — a quote whose job fell past the 1000-row cap looked
      // unconverted, inviting a duplicate graphics job. Ascending order is
      // load-bearing: with several jobs per quote, the NEWEST must win the
      // map, so keep created_at asc (+id) and let later rows overwrite.
      fetchAllRows<{ id: string; job_number: string | null; wrap_quote_id: string | null }>((from, to) =>
        supabase.from('graphics_jobs').select('id, job_number, wrap_quote_id').not('wrap_quote_id', 'is', null).neq('status', 'cancelled').order('created_at', { ascending: true }).order('id').range(from, to)),
    ]);
    const jobMap: Record<string, { id: string; job_number: string | null }> = {};
    for (const j of jobsRes.data || []) {
      if (j.wrap_quote_id) jobMap[j.wrap_quote_id] = { id: j.id, job_number: j.job_number };
    }
    setJobsByQuote(jobMap);
    if (floorRes.data?.margin_floor_pct != null) setMarginFloor(Number(floorRes.data.margin_floor_pct));
    setTemplates((tplRes.data || []) as Template[]);
    setSubstrates((subRes.data || []) as Film[]);
    if (setRes.data) {
      setSettings({
        company: setRes.data.company || {},
        tax_rate: num(setRes.data.tax_rate),
        design: { ...EMPTY_LABOR, ...(setRes.data.design || {}) },
        preparation: { ...EMPTY_LABOR, ...(setRes.data.preparation || {}) },
        installation: { ...EMPTY_LABOR, ...(setRes.data.installation || {}) },
        min_job_charge: num(setRes.data.min_job_charge),
        qty_discounts: Array.isArray(setRes.data.qty_discounts) ? setRes.data.qty_discounts : [],
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
  const years = useMemo(() => [...new Set(activeTemplates.map(t => (t.year || '').trim()).filter(Boolean))].sort().reverse(), [activeTemplates]);
  // Dedupe makes case-insensitively (first-seen casing wins) so "FORD" and
  // "Ford" don't appear as two entries that each hide the other's templates.
  const makes = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of activeTemplates) {
      if (yearFilter && normText(t.year) !== normText(yearFilter)) continue;
      const key = normText(t.make);
      if (key && !seen.has(key)) seen.set(key, t.make.trim());
    }
    // The <select> matches its value against options verbatim — keep the
    // active filter's exact casing in the list so the pick never shows blank.
    if (makeFilter && seen.has(normText(makeFilter))) seen.set(normText(makeFilter), makeFilter);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [activeTemplates, yearFilter, makeFilter]);
  const templateOptions = useMemo(() =>
    activeTemplates.filter(t =>
      (!yearFilter || normText(t.year) === normText(yearFilter)) &&
      (!makeFilter || normText(t.make) === normText(makeFilter))),
    [activeTemplates, yearFilter, makeFilter]);
  // Live type-ahead results for the template search box. Searches the WHOLE
  // active library, not the Year/Make-filtered subset — a leftover filter
  // used to make the search say "No templates match" for templates that
  // plainly exist. Full list here; the render caps what's shown and says so.
  const templateSearchMatches = useMemo(() =>
    tplSearch.trim().length < 2 ? [] : activeTemplates.filter(t => matchesTemplateSearch(t, tplSearch)),
    [activeTemplates, tplSearch]);
  // Picking a template (search result, browse dropdown, or grid Open) syncs
  // the Year/Make filters to it so the browse <select> always shows the pick
  // instead of rendering blank when a filter excludes it.
  const pickTemplate = (t: Template) => {
    setTemplateId(t.id);
    setImgDim(null);
    resetEstimate();
    setTplSearch('');
    setYearFilter((t.year || '').trim());
    setMakeFilter(t.make.trim());
  };

  // Resolve the estimate's vehicle (Add Graphics round trip) against the
  // template library: a unique match loads outright; several matches open
  // the search box with them listed; no match leaves the pickers alone.
  useEffect(() => {
    if (!vehiclePrefill || templates.length === 0) return;
    if (templateId || savedQuoteId) { setVehiclePrefill(null); return; }
    const queries = [
      [vehiclePrefill.year, vehiclePrefill.label].filter(Boolean).join(' '),
      vehiclePrefill.label,
    ].filter(q => q.trim().length >= 2);
    for (const q of queries) {
      const matches = activeTemplates.filter(t => matchesTemplateSearch(t, q));
      if (matches.length === 1) { pickTemplate(matches[0]); break; }
      if (matches.length > 1) { setTplSearch(q); break; }
    }
    setVehiclePrefill(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once when both the prefill and the library are in
  }, [vehiclePrefill, templates]);

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

  // The drawn canvas is ONE kit; this multiplies the sqft-driven pricing
  // (materials + per-film install labor) for "12 of this package" jobs.
  const [packageQty, setPackageQty] = useState('1');
  // Per-quote quantity-discount override (%). '' = use the settings tier
  // that the kit count qualifies for.
  const [discountPctOverride, setDiscountPctOverride] = useState('');

  // ----- Roll nesting -----
  // Shapes transfer onto rolls of their film (58.5" × 150' by default) on
  // the Roll Nesting tab; when the toggle is on, materials price from the
  // roll length actually consumed instead of per-shape area.
  const [rollConfig, setRollConfig] = useState<RollConfig>({ ...DEFAULT_ROLL });
  const [placements, setPlacements] = useState<PlacementMap>({});
  const [useRollPricing, setUseRollPricing] = useState(false);
  const kitSets = Math.max(1, Math.floor(num(packageQty) || 1));

  // Every measurement copy in every set is one print piece (drawn size +
  // bleed per side). Panels too wide for the roll in both orientations are
  // auto-split into lettered strips with a seam overlap ("Panel 1-A",
  // "Panel 1-B") so they actually fit. Enumeration is capped so a
  // fat-fingered qty can't hang the packer — anything past the cap skips
  // the layout but still BILLS by area (overflowSqft) so the quote never
  // silently under-charges.
  const NEST_PIECE_CAP = 800;
  const nest = useMemo(() => {
    const pieces: NestPiece[] = [];
    const overflowSqft = new Map<string, number>();
    let capped = false;
    for (const m of measurements) {
      const sub = substrateById(m.substrate_id);
      const bleed = sub ? Math.max(0, num(sub.bleed_in)) : 0;
      const d1 = num(m.dim1_in), d2 = num(m.dim2_in);
      const w = Math.max(0.5, d1 + 2 * bleed);
      const h = Math.max(0.5, d2 + 2 * bleed);
      const qty = Math.max(1, num(m.qty));
      const filmKey = m.substrate_id || '';
      // Non-rectangular shapes panel against their real outline: same
      // panel widths/letters as the bounding box, but each panel's height
      // trims to the shape inside it (a van's 36"-tall fender panel isn't
      // cut 96" tall just because the rear of the van is).
      const parts =
        m.type === 'poly' && m.points && m.points.length >= 3 && d1 > 0 && d2 > 0
          ? splitOutlineForRoll(scaleOutline(m.points, d1, d2), bleed, rollConfig)
          : m.type === 'circle' && d1 > 0 && d2 > 0
            ? splitOutlineForRoll(ellipseOutline(d1, d2), bleed, rollConfig)
            : splitForRoll(w, h, rollConfig);
      for (let s = 0; s < kitSets; s++) {
        for (let c = 0; c < qty; c++) {
          for (const part of parts) {
            if (pieces.length >= NEST_PIECE_CAP) {
              capped = true;
              overflowSqft.set(filmKey, (overflowSqft.get(filmKey) || 0) + (part.w * part.h) / 144);
            } else {
              pieces.push({
                key: pieceKey(m.id, c, s, part.partIndex, filmKey),
                filmKey,
                name: m.name,
                w: part.w,
                h: part.h,
                set: s,
                copy: c,
                part: part.partIndex >= 0 ? partLetter(part.partIndex) : '',
              });
            }
          }
        }
      }
    }
    return { pieces, overflowSqft, capped };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- substrateById reads substrates
  }, [measurements, kitSets, substrates, rollConfig]);
  const nestPieces = nest.pieces;
  const nestCapped = nest.capped;

  const nestFilms = useMemo<RollFilmInfo[]>(() => {
    const used = new Set(measurements.map(m => m.substrate_id || ''));
    const out: RollFilmInfo[] = substrates
      .filter(s => used.has(s.id))
      .map(s => ({ key: s.id, label: filmLabel(s), color: filmColor(s.id), ratePerSqft: filmRate(s) }));
    if (used.has('')) out.push({ key: '', label: 'No film', color: '#94a3b8', ratePerSqft: 0 });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filmColor reads substrates
  }, [measurements, substrates]);

  // Keep the layout in step with the drawing: new pieces pack into the
  // gaps, deleted shapes free their spots, manual arrangements stay put.
  useEffect(() => {
    setPlacements(prev => reconcilePlacements(nestPieces, prev, rollConfig));
  }, [nestPieces, rollConfig]);

  const nestUsage = useMemo(() => computeUsage(nestPieces, placements, rollConfig), [nestPieces, placements, rollConfig]);

  // Per-film nested billing, shared by the totals math AND the saved
  // snapshot so the numbers on documents always sum: roll consumption plus
  // area-billed extras (pieces the packer couldn't fit and anything past
  // the enumeration cap).
  const nestFilmBilling = useMemo(() => {
    const rows = new Map<string, { rollSqft: number; graphicSqft: number; extraSqft: number; rolls: { usedLengthIn: number; pieceCount: number }[] }>();
    for (const f of nestUsage.films) {
      rows.set(f.filmKey, { rollSqft: f.rollSqft, graphicSqft: f.graphicSqft, extraSqft: 0, rolls: f.rolls });
    }
    const addExtra = (filmKey: string, sqft: number) => {
      const row = rows.get(filmKey) || { rollSqft: 0, graphicSqft: 0, extraSqft: 0, rolls: [] };
      row.extraSqft += sqft;
      rows.set(filmKey, row);
    };
    for (const p of nestUsage.unplaced) addExtra(p.filmKey, (p.w * p.h) / 144);
    for (const [filmKey, sqft] of nest.overflowSqft) addExtra(filmKey, sqft);
    return rows;
  }, [nestUsage, nest]);

  const totals = useMemo(() => {
    const kitQty = Math.max(1, Math.floor(num(packageQty) || 1));
    let kitArea = 0, kitBilledArea = 0, kitMaterials = 0;
    // Billed (with-bleed) square footage per film — drives material buying
    // and per-film install labor.
    const byFilm = new Map<string, { film: Film; sqft: number }>();
    for (const m of measurements) {
      const p = measurementPricing(m);
      const qty = Math.max(1, num(m.qty));
      kitArea += p.trimArea * qty;
      kitBilledArea += p.billedArea * qty;
      kitMaterials += p.lineTotal;
      if (p.sub) {
        const cur = byFilm.get(p.sub.id) || { film: p.sub, sqft: 0 };
        cur.sqft += p.billedArea * qty;
        byFilm.set(p.sub.id, cur);
      }
    }
    // Whole-job numbers: the kit × package quantity. The three labor
    // sections (design/prep/install) stay one-time job-level entries.
    const area = kitArea * kitQty;
    const billedArea = kitBilledArea * kitQty;
    let materials = kitMaterials * kitQty;

    // Roll pricing: materials come from the vinyl actually cut — roll
    // width × used length per film, and the nested layout already contains
    // every set, so this is a whole-job number (NOT multiplied by kits).
    // Pieces the packer couldn't fit still bill by their area. Install
    // labor stays on the graphic area — waste isn't installed.
    const nested = useRollPricing && nestPieces.length > 0;
    let nestedRollSqft = 0;
    if (nested) {
      let rollMaterials = 0;
      for (const [filmKey, row] of nestFilmBilling) {
        const film = substrateById(filmKey || null);
        if (!film) continue;
        rollMaterials += (row.rollSqft + row.extraSqft) * filmRate(film);
        nestedRollSqft += row.rollSqft;
      }
      materials = rollMaterials;
      kitMaterials = rollMaterials / kitQty;
    }
    const filmTotals = [...byFilm.values()].map(({ film, sqft }) => {
      const jobSqft = sqft * kitQty;
      return {
        id: film.id, label: filmLabel(film), sqft: jobSqft,
        laborRate: filmLaborRate(film), laborTotal: jobSqft * filmLaborRate(film),
      };
    });
    const filmLabor = filmTotals.reduce((sum, f) => sum + f.laborTotal, 0);
    const design = laborSectionTotal(settings.design);
    const prep = laborSectionTotal(settings.preparation);
    const install = laborSectionTotal(settings.installation);
    const labor = design + prep + install + filmLabor;
    const preSubtotal = materials + labor;

    // Quantity discount: the highest settings tier the kit count reaches,
    // unless this quote overrides the percentage.
    const tierPct = settings.qty_discounts.reduce(
      (best, t) => kitQty >= Math.max(1, num(t.min_qty)) ? Math.max(best, num(t.pct)) : best, 0);
    const discountPct = discountPctOverride.trim() === ''
      ? tierPct
      : Math.min(100, Math.max(0, num(discountPctOverride)));
    const discount = preSubtotal * discountPct / 100;

    // Shop minimum: no job quotes below the pre-tax floor — the bump covers
    // the fixed time a job takes regardless of its square footage.
    const minCharge = num(settings.min_job_charge);
    const afterDiscount = preSubtotal - discount;
    const minBump = preSubtotal > 0 && afterDiscount < minCharge ? minCharge - afterDiscount : 0;
    const subtotal = afterDiscount + minBump;
    // Fold the adjustments into materials/labor proportionally: the NetSuite
    // estimate and invoice read materials_total + labor_total directly, so
    // those two must always sum to what the customer was actually quoted.
    const adjust = preSubtotal > 0 ? subtotal / preSubtotal : 1;

    const tax = subtotal * num(settings.tax_rate) / 100;
    // Internal margin readout: what the billed film actually costs us
    // (whole job), against what we charge for it AFTER the discount. Films
    // with no cost on the Pricing tab are listed so the gap is visible.
    // With roll pricing on, cost follows the same roll footage we charge.
    let materialCost = 0;
    const uncostedFilms = new Set<string>();
    if (nested) {
      for (const [filmKey, row] of nestFilmBilling) {
        const film = substrateById(filmKey || null);
        if (!film) continue;
        if (filmHasCost(film)) materialCost += (row.rollSqft + row.extraSqft) * filmCost(film);
        else uncostedFilms.add(filmLabel(film));
      }
    } else {
      for (const { film, sqft } of byFilm.values()) {
        if (filmHasCost(film)) materialCost += sqft * kitQty * filmCost(film);
        else uncostedFilms.add(filmLabel(film));
      }
    }
    return {
      kitQty, kitArea, kitMaterials,
      area, billedArea, materials, filmTotals, filmLabor, design, prep, install, labor,
      preSubtotal, tierPct, discountPct, discount, minCharge, minBump,
      adjMaterials: materials * adjust, adjLabor: labor * adjust,
      subtotal, tax, total: subtotal + tax,
      materialCost, uncostedFilms: [...uncostedFilms],
      nested, nestedRollSqft,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- substrates feed measurementPricing
  }, [measurements, settings, substrates, laborRates, packageQty, discountPctOverride, useRollPricing, nestPieces, nestFilmBilling]);

  // ----- Canvas drawing -----
  const svgPoint = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg || !imgDim) return null;
    const r = svg.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (imgDim.w / r.width),
      y: (e.clientY - r.top) * (imgDim.h / r.height),
    };
  };

  // ----- Freeform shape tool -----
  // Vertex snapping: clicks land square with the previous point when close
  // (clean horizontal/vertical edges), and near the first point they snap
  // onto it exactly so the outline closes without pixel-hunting.
  const polySnapRadius = () => (imgDim ? Math.max(8, imgDim.w / 90) : 12);

  const polySnapped = (p: { x: number; y: number }, draft: { x: number; y: number }[]) => {
    const snap = polySnapRadius();
    if (draft.length >= 3) {
      const first = draft[0];
      if (Math.hypot(p.x - first.x, p.y - first.y) < snap) return { ...first };
    }
    const out = { ...p };
    const last = draft[draft.length - 1];
    if (last) {
      if (Math.abs(p.x - last.x) < snap / 2) out.x = last.x;
      if (Math.abs(p.y - last.y) < snap / 2) out.y = last.y;
    }
    return out;
  };

  const closesPoly = (p: { x: number; y: number }, draft: { x: number; y: number }[]) =>
    draft.length >= 3 && Math.hypot(p.x - draft[0].x, p.y - draft[0].y) < polySnapRadius();

  // While the crossed-outline alert is up, the draft hotkeys must go dead —
  // otherwise Escape (the natural "dismiss" key) silently wipes the very
  // outline the alert is asking the user to fix.
  const polyAlertRef = useRef(false);

  const closePoly = async () => {
    const ppi = num(template?.px_per_in);
    if (!polyDraft || !ppi) { setPolyDraft(null); setPolyHover(null); return; }
    // Drop consecutive near-duplicate clicks (double-click close leaves one).
    const pts = polyDraft.filter((p, i) => i === 0 || Math.hypot(p.x - polyDraft[i - 1].x, p.y - polyDraft[i - 1].y) > 2);
    if (pts.length < 3) { setPolyDraft(null); setPolyHover(null); setTool('select'); return; }
    // A crossed outline ("bowtie") would shoelace to a smaller area than
    // what's visually filled and under-bill — refuse and let them fix it.
    if (polygonSelfIntersects(pts)) {
      if (polyAlertRef.current) return;
      polyAlertRef.current = true;
      try {
        await dialog.alert('The outline crosses itself — undo the last point or place the corners so the lines don\'t cross, then close the shape.');
      } finally {
        polyAlertRef.current = false;
      }
      return;
    }
    const metrics = polyMetrics(pts, ppi);
    const m: Measurement = {
      id: crypto.randomUUID(),
      name: `Shape ${measurements.length + 1}`,
      type: 'poly',
      points: pts,
      ...metrics,
      qty: 1,
      substrate_id: defaultFilmId(),
    };
    setMeasurements(prev => [...prev, m]);
    setSelectedId(m.id);
    setPolyDraft(null);
    setPolyHover(null);
    setTool('select');
  };

  const cancelPoly = () => { setPolyDraft(null); setPolyHover(null); setTool('select'); };
  const undoPolyPoint = () => setPolyDraft(d => (d && d.length > 1 ? d.slice(0, -1) : null));

  // Keyboard shortcuts while drawing a shape (Enter close, Esc cancel,
  // Backspace undo). Re-subscribed every render so the handlers see fresh
  // state; skipped entirely when no draft is active.
  useEffect(() => {
    if (!polyDraft) return;
    const onKey = (e: KeyboardEvent) => {
      if (polyAlertRef.current) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') cancelPoly();
      else if (e.key === 'Enter') void closePoly();
      else if (e.key === 'Backspace') { e.preventDefault(); undoPolyPoint(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool === 'select' || !imgDim) return;
    if (tool !== 'calibrate' && !template?.px_per_in) return;
    const p = svgPoint(e);
    if (!p) return;
    if (tool === 'poly') {
      const draft = polyDraft || [];
      if (closesPoly(p, draft)) { closePoly(); return; }
      setPolyDraft([...draft, polySnapped(p, draft)]);
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = svgPoint(e);
    if (!p) return;
    if (tool === 'poly') {
      setPolyHover(polyDraft && polyDraft.length > 0 ? polySnapped(p, polyDraft) : p);
      return;
    }
    if (editDrag) {
      const dx = p.x - editDrag.grabX, dy = p.y - editDrag.grabY;
      const ppi = num(template?.px_per_in);
      setMeasurements(prev => prev.map(m => {
        if (m.id !== editDrag.id) return m;
        if (editDrag.kind === 'lineend' && editDrag.line && editDrag.lineNo) {
          // Dead zone: a jittery tap on an endpoint (touchscreens emit a
          // move during most taps) must not rewrite a hand-typed dim with
          // the line's drawn length. Real drags clear this instantly.
          if (Math.hypot(dx, dy) < 3) return m;
          const moved = editDrag.endNo === 1
            ? { ...editDrag.line, x1: editDrag.line.x1 + dx, y1: editDrag.line.y1 + dy }
            : { ...editDrag.line, x2: editDrag.line.x2 + dx, y2: editDrag.line.y2 + dy };
          const lenIn = ppi > 0 ? Math.hypot(moved.x2 - moved.x1, moved.y2 - moved.y1) / ppi : 0;
          return editDrag.lineNo === 1
            ? { ...m, line1: moved, dim1_in: ppi > 0 ? lenIn : m.dim1_in }
            : { ...m, line2: moved, dim2_in: ppi > 0 ? lenIn : m.dim2_in };
        }
        if (editDrag.points) {
          if (editDrag.kind === 'move') {
            return { ...m, points: editDrag.points.map(pt => ({ x: pt.x + dx, y: pt.y + dy })) };
          }
          // vertex drag: reshape one corner and rewrite the real dims/area
          const pts = editDrag.points.map((pt, i) => i === editDrag.vertexIndex ? { x: pt.x + dx, y: pt.y + dy } : pt);
          return { ...m, points: pts, ...(ppi > 0 ? polyMetrics(pts, ppi) : {}) };
        }
        if (!m.rect || !editDrag.rect) return m;
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
      // roof/hood line pairs are numeric-first). Freeform shapes scale their
      // outline to the new bounding box and recompute the real area.
      const ppi = num(template?.px_per_in);
      if (next.type === 'box' && next.rect && ppi > 0 && ('dim1_in' in patch || 'dim2_in' in patch)) {
        next.rect = { ...next.rect, w: Math.max(2, num(next.dim1_in) * ppi), h: Math.max(2, num(next.dim2_in) * ppi) };
      }
      if (next.type === 'poly' && next.points && ppi > 0 && ('dim1_in' in patch || 'dim2_in' in patch)) {
        if (num(next.dim1_in) > 0 && num(next.dim2_in) > 0) {
          const xs = next.points.map(p => p.x), ys = next.points.map(p => p.y);
          const minX = Math.min(...xs), minY = Math.min(...ys);
          const w = Math.max(1, Math.max(...xs) - minX), h = Math.max(1, Math.max(...ys) - minY);
          const sx = (num(next.dim1_in) * ppi) / w;
          const sy = (num(next.dim2_in) * ppi) / h;
          next.points = next.points.map(p => ({ x: minX + (p.x - minX) * sx, y: minY + (p.y - minY) * sy }));
        }
        // A cleared/zero field never collapses the outline — the dims just
        // snap back to the shape's real bounding box.
        Object.assign(next, polyMetrics(next.points, ppi));
      }
      return next;
    }));
  };

  // Move/resize drag on already-drawn boxes and freeform shapes (select
  // mode). Move keeps the dimensions; dragging a box's corner handle or a
  // shape's vertex reshapes it and rewrites the inches.
  const [editDrag, setEditDrag] = useState<{
    kind: 'move' | 'resize' | 'vertex' | 'lineend';
    id: string;
    grabX: number;
    grabY: number;
    rect?: { x: number; y: number; w: number; h: number };
    points?: { x: number; y: number }[];
    vertexIndex?: number;
    // roof/hood endpoint drags: which line and which end is being moved
    line?: { x1: number; y1: number; x2: number; y2: number };
    lineNo?: 1 | 2;
    endNo?: 1 | 2;
  } | null>(null);

  // Grab an endpoint of a roof/hood line to fix where it landed — the
  // measured inches rewrite from the line's new length as it moves.
  const beginLineEndDrag = (e: React.PointerEvent, m: Measurement, lineNo: 1 | 2, endNo: 1 | 2) => {
    if (tool !== 'select') return;
    const src = lineNo === 1 ? m.line1 : m.line2;
    if (!src) return;
    e.stopPropagation();
    const pt = svgPoint(e);
    if (!pt) return;
    setSelectedId(m.id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setEditDrag({ kind: 'lineend', id: m.id, grabX: pt.x, grabY: pt.y, line: { ...src }, lineNo, endNo });
  };

  const beginEditDrag = (e: React.PointerEvent, m: Measurement, kind: 'move' | 'resize' | 'vertex', vertexIndex?: number) => {
    if (tool !== 'select') return;
    if (kind === 'vertex' || m.type === 'poly') { if (!m.points) return; } else if (!m.rect) return;
    e.stopPropagation();
    const pt = svgPoint(e);
    if (!pt) return;
    setSelectedId(m.id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setEditDrag({
      kind, id: m.id, grabX: pt.x, grabY: pt.y,
      rect: m.type === 'poly' ? undefined : m.rect ? { ...m.rect } : undefined,
      points: m.type === 'poly' && m.points ? m.points.map(p => ({ ...p })) : undefined,
      vertexIndex,
    });
  };

  const removeMeasurement = (id: string) => {
    setMeasurements(prev => prev.filter(m => m.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  // Mirror a freeform shape's outline about its own bounding-box center.
  // Reflection keeps area, perimeter, and bbox dims, so pricing and the
  // nesting piece are untouched — only the drawn geometry changes.
  const mirrorPoints = (points: { x: number; y: number }[], axis: 'h' | 'v') => {
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const sumX = Math.min(...xs) + Math.max(...xs);
    const sumY = Math.min(...ys) + Math.max(...ys);
    return points.map(p => axis === 'h' ? { x: sumX - p.x, y: p.y } : { x: p.x, y: sumY - p.y });
  };

  const flipMeasurement = (id: string, axis: 'h' | 'v') => {
    setMeasurements(prev => prev.map(m =>
      m.id === id && m.type === 'poly' && m.points ? { ...m, points: mirrorPoints(m.points, axis) } : m));
  };

  // Clone a measurement (same dims/film/qty) offset a little so the copy
  // isn't hidden under the original. `mirror` flips the copy horizontally —
  // the usual wrap move: duplicate the driver-side shape, mirrored, for the
  // passenger side.
  const duplicateMeasurement = (id: string, mirror = false) => {
    const src = measurements.find(m => m.id === id);
    if (!src) return;
    const OFFSET = 14;
    let points = src.points ? src.points.map(p => ({ x: p.x + OFFSET, y: p.y + OFFSET })) : undefined;
    if (points && mirror) points = mirrorPoints(points, 'h');
    const copy: Measurement = {
      ...src,
      id: crypto.randomUUID(),
      name: `${src.name}${mirror ? ' mirror' : ' copy'}`,
      rect: src.rect ? { ...src.rect, x: src.rect.x + OFFSET, y: src.rect.y + OFFSET } : undefined,
      line1: src.line1 ? { x1: src.line1.x1 + OFFSET, y1: src.line1.y1 + OFFSET, x2: src.line1.x2 + OFFSET, y2: src.line1.y2 + OFFSET } : undefined,
      line2: src.line2 ? { x1: src.line2.x1 + OFFSET, y1: src.line2.y1 + OFFSET, x2: src.line2.x2 + OFFSET, y2: src.line2.y2 + OFFSET } : undefined,
      points,
    };
    setMeasurements(prev => [...prev, copy]);
    setSelectedId(copy.id);
  };

  const selected = measurements.find(m => m.id === selectedId) || null;

  const resetEstimate = () => {
    setMeasurements([]);
    setSelectedId(null);
    setPendingPair(null);
    setPolyDraft(null);
    setPolyHover(null);
    setSavedQuoteId(null);
    setQuoteNumber('');
    setPackageQty('1');
    setDiscountPctOverride('');
    setPlacements({});
    setUseRollPricing(false);
  };

  // ----- Quote snapshot / save / email -----
  // Quote numbers use the shared dated sequence (K4): WQ-2608-003. Old
  // WQ-MMDDYY-N numbers stay as-is on existing quotes.
  const nextQuoteNumber = (): Promise<string> =>
    nextJobNumber(supabase, 'WQ', legacyJobNumber.wq);

  const buildSnapshot = () => {
    // With roll pricing on, the per-shape lines are informational (sizes and
    // films) and the priced rows are the per-film roll materials — so the
    // shape lines carry null prices instead of numbers that don't sum.
    const nested = totals.nested;
    const lines = measurements.map(m => {
      const p = measurementPricing(m);
      return {
        name: m.name,
        type: m.type,
        qty: Math.max(1, num(m.qty)),
        dim1_in: num(m.dim1_in),
        dim2_in: num(m.dim2_in),
        area_in2: m.area_in2 ?? null,
        perimeter_in: m.perimeter_in ?? null,
        // Snapshot stores the combined film+laminate label and effective rate
        // so quote history, preview, and the emailed document all match.
        substrate: p.sub ? { id: p.sub.id, name: filmLabel(p.sub), price_per_sqft: filmRate(p.sub), bleed_in: num(p.sub.bleed_in), film_name: p.sub.name, laminate_name: p.sub.laminate_name } : null,
        trim_area_sqft: p.trimArea,
        billed_area_sqft: p.billedArea,
        unit_price: nested ? null : p.unitPrice,
        line_total: nested ? null : p.lineTotal,
        // Canvas geometry (template-image pixels) so a saved quote can be
        // reopened in the estimator with its shapes intact.
        geometry: { rect: m.rect || null, line1: m.line1 || null, line2: m.line2 || null, poly: m.points || null },
      };
    });
    // The roll layout rides along whenever pieces are placed OR roll
    // pricing is on (so a roll-priced quote always carries the Material
    // rows its documents render, even if nothing could be placed);
    // `enabled` records whether materials were actually priced from it.
    // Placements key on measurement INDEX because measurement ids are
    // regenerated when a quote reloads.
    const measurementIndex = new Map(measurements.map((m, i) => [m.id, i]));
    let nesting: NestingSnapshot | null = null;
    if (nested || Object.keys(placements).length > 0) {
      const placementRows: NestingSnapshot['placements'] = [];
      for (const p of nestPieces) {
        const pl = placements[p.key];
        if (!pl) continue;
        const keyBits = p.key.split(':');
        const idx = measurementIndex.get(keyBits[0]);
        if (idx == null) continue;
        placementRows.push({ m: idx, copy: p.copy, set: p.set, part: parseInt(keyBits[3], 10), roll: pl.roll, x: pl.x, y: pl.y, rot: pl.rot });
      }
      nesting = {
        enabled: nested,
        roll_width_in: rollConfig.widthIn,
        roll_length_in: rollConfig.lengthIn,
        spacing_in: rollConfig.spacingIn,
        edge_margin_in: rollConfig.edgeMarginIn,
        overlap_in: rollConfig.overlapIn,
        sets: kitSets,
        films: [...nestFilmBilling.entries()].map(([filmKey, row]) => {
          const film = substrateById(filmKey || null);
          const rate = film ? filmRate(film) : 0;
          return {
            film_id: filmKey || null,
            label: film ? filmLabel(film) : 'No film',
            rate_per_sqft: rate,
            rolls: row.rolls.map(r => ({ used_length_in: r.usedLengthIn, piece_count: r.pieceCount })),
            roll_sqft: row.rollSqft,
            graphic_sqft: row.graphicSqft,
            extra_area_sqft: row.extraSqft,
            material_total: (row.rollSqft + row.extraSqft) * rate,
          };
        }),
        unplaced: nestUsage.unplaced.map(p => ({ name: p.part ? `${p.name}-${p.part}` : p.name, w_in: p.w, h_in: p.h, film_id: p.filmKey || null })),
        placements: placementRows,
      };
    }
    return {
      quote_number: quoteNumber || legacyJobNumber.wq(),
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
      package_qty: totals.kitQty,
      nesting,
      // Display snapshot of how the totals were reached; null = plain
      // single-kit quote. materials_total/labor_total below already have the
      // discount + shop minimum folded in proportionally, so the NetSuite
      // estimate and invoice (which read those columns) match the quote.
      adjustments: (totals.kitQty > 1 || totals.discount > 0.005 || totals.minBump > 0.005) ? {
        package_qty: totals.kitQty,
        kit_area_sqft: totals.kitArea,
        kit_materials: totals.kitMaterials,
        pre_materials: totals.materials,
        pre_labor: totals.labor,
        pre_subtotal: totals.preSubtotal,
        discount_pct: totals.discountPct,
        discount_amount: totals.discount,
        min_charge: totals.minCharge,
        min_bump: totals.minBump,
      } : null,
      materials_total: totals.adjMaterials,
      labor_total: totals.adjLabor,
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
      } else if (m.type === 'poly' && m.points && m.points.length >= 3) {
        ctx.fillStyle = fc + '26';
        ctx.strokeStyle = fc;
        ctx.beginPath();
        m.points.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
        ctx.closePath();
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
      const anchor = m.rect || (m.points?.length ? { x: Math.min(...m.points.map(p => p.x)), y: Math.min(...m.points.map(p => p.y)) } : m.line1 ? { x: m.line1.x1, y: m.line1.y1 } : null);
      if (anchor) {
        ctx.fillStyle = fc;
        ctx.fillText(m.name, anchor.x + fontSize / 3, anchor.y - fontSize / 3);
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
    // A crossed freeform outline shoelaces to less area than what's visually
    // filled — block the save (and therefore email/NetSuite) until it's
    // fixed rather than letting an under-billed quote out the door.
    const crossed = measurements.filter(m => m.type === 'poly' && m.points && polygonSelfIntersects(m.points));
    if (crossed.length > 0) {
      await dialog.alert(`${crossed.map(m => m.name).join(', ')} ${crossed.length === 1 ? 'has' : 'have'} an outline that crosses itself, so the area can't be billed correctly. Select the shape and drag its corners apart, then save again.`);
      return null;
    }
    const snap = buildSnapshot();
    if (!savedQuoteId) snap.quote_number = await nextQuoteNumber();
    if (!quoteNumber) setQuoteNumber(snap.quote_number);
    const diagramPath = await uploadDiagram(snap.quote_number);
    const row = diagramPath ? { ...snap, diagram_path: diagramPath } : snap;
    if (savedQuoteId) {
      const { error } = await supabase.from('wrap_quotes').update({ ...row, updated_at: new Date().toISOString() }).eq('id', savedQuoteId);
      if (error) { await dialog.alert(`Save failed: ${saveErrorMessage(error)}`); return null; }
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
    if (error || !data) { await dialog.alert(`Save failed: ${saveErrorMessage(error)}`); return null; }
    setSavedQuoteId(data.id);
    await loadAll();
    return data.id;
  };

  // Dry-run render for the compose modal — the send route returns the exact
  // email (recipients resolved, signature included) without sending or
  // marking anything sent. The modal alerts on a returned error itself.
  const fetchQuoteEmailPreview = async (fields: EmailComposeFields) => {
    if (!emailQuoteId) return { error: 'Quote not saved yet' };
    try {
      const res = await apiFetch('/api/wrap-quote/send', {
        method: 'POST',
        body: JSON.stringify({
          quoteId: emailQuoteId,
          include: sendInclude,
          preview: true,
          message: fields.message || undefined,
          emails: fields.emails.length > 0 ? fields.emails : undefined,
          attachmentPaths: fields.attachmentIds,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.preview) return { error: data.error || 'Unknown error' };
      return { preview: { to: data.to, subject: data.subject, html: data.html } };
    } catch (e: any) {
      return { error: e.message };
    }
  };

  // Opens the compose modal (saves the draft first so the server can render
  // the real thing). The actual send happens in sendQuoteEmail.
  const createAndEmail = async () => {
    if (!customer.email?.trim()) { await dialog.alert('Enter a customer email first.'); return; }
    if (measurements.length === 0) { await dialog.alert('No measurements — draw the wrap areas on the Estimator tab first.'); return; }
    if (!sendInclude.pricing && !sendInclude.diagram && !sendInclude.netsuitePdf) {
      await dialog.alert('Nothing selected to send — pick pricing, the coverage picture, or the NetSuite PDF.');
      return;
    }
    if (sendInclude.netsuitePdf && !history.find(q => q.id === savedQuoteId)?.netsuite_estimate_id) {
      await dialog.alert('This quote isn\'t in NetSuite yet — use "Create Quote in NetSuite" first.');
      return;
    }
    setSending(true);
    try {
      const id = await saveQuote();
      if (!id) return;
      setEmailQuoteId(id);
      setEmailModal(true);
    } finally {
      setSending(false);
    }
  };

  const sendQuoteEmail = async (fields: EmailComposeFields): Promise<{ ok: boolean }> => {
    if (!emailQuoteId) return { ok: false };
    const coverageOnly = !sendInclude.pricing && !sendInclude.netsuitePdf;
    setSending(true);
    try {
      const res = await apiFetch('/api/wrap-quote/send', {
        method: 'POST',
        body: JSON.stringify({
          quoteId: emailQuoteId,
          include: sendInclude,
          message: fields.message || undefined,
          emails: fields.emails,
          bccSelf: fields.bccSelf,
          attachmentPaths: fields.attachmentIds,
        }),
      });
      const data = await res.json();
      const sentTo = fields.emails.join(', ');
      if (!res.ok || !data.success) {
        await dialog.alert(`Email failed: ${data.error || 'Unknown error'}`);
        return { ok: false };
      }
      // Close before the success dialog so the alert isn't stacked on the
      // compose screen.
      setEmailModal(false);
      if (coverageOnly) {
        // The quote itself hasn't gone out — keep everything in place so
        // the real quote can still be sent after the customer sees coverage.
        await dialog.alert(`Coverage picture emailed to ${sentTo}`);
        await loadAll();
      } else {
        await dialog.alert(`Quote emailed to ${sentTo}`);
        resetAfterSend();
        await loadAll();
        setTab('history');
      }
      return { ok: true };
    } catch (e: any) {
      await dialog.alert(`Email failed: ${e.message}`);
      return { ok: false };
    } finally {
      setSending(false);
    }
  };

  // Create the typed-in customer as a real NetSuite Customer and link it to
  // this quote (fills the gap where a hand-typed name has no NetSuite record
  // and the estimate push refuses).
  const createNetsuiteCustomer = async () => {
    const name = (customer.name || '').trim();
    if (!name) { await dialog.alert('Enter the customer name first.'); return; }
    if (!(await dialog.confirm(`Create "${name}" as a new NetSuite customer? Try the search box first so you don't create a duplicate.`))) return;
    setCreatingCustomer(true);
    try {
      const res = await apiFetch('/api/wrap-quote/create-customer', {
        method: 'POST',
        body: JSON.stringify({
          companyName: name,
          email: customer.email?.trim() || undefined,
          phone: customer.phone?.trim() || undefined,
          address: customer.address?.trim() || undefined,
          city: customer.city?.trim() || undefined,
          state: customer.state?.trim() || undefined,
          zip: customer.zip?.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.existingCustomerId) {
        // Same name already in NetSuite — link the existing record instead.
        setCustomerId(data.existingCustomerId);
        await dialog.alert(`${data.error} Linked the existing record to this quote.`);
        return;
      }
      if (!res.ok || !data.success) {
        await dialog.alert(`NetSuite customer failed: ${data.error || 'Unknown error'}`);
        return;
      }
      if (data.customerId) setCustomerId(data.customerId);
      await dialog.alert(`NetSuite customer created${data.entityId ? ` (${data.entityId})` : ''}${data.customerId ? ' and linked to this quote.' : ' — run a customer sync to link it here.'}`);
    } catch (e: any) {
      await dialog.alert(`NetSuite customer failed: ${e.message}`);
    } finally {
      setCreatingCustomer(false);
    }
  };

  // Push the quote to NetSuite as an Estimate: vinyl total -> "3M Vinyl"
  // (described as the quoted vehicle), labor total -> "Graphics Install
  // Labor". Taxes are NetSuite's job. No email is sent.
  const createNetsuiteQuote = async () => {
    if (measurements.length === 0) { await dialog.alert('No measurements — draw the wrap areas on the Estimator tab first.'); return; }
    if (!customerId) { await dialog.alert('Pick the customer from the NetSuite search first — a typed-in name has no NetSuite record to attach the quote to.'); return; }
    if (!(await dialog.confirm(`Create a NetSuite quote for ${customer.name}? Vinyl ($${fmt(totals.adjMaterials)}${totals.kitQty > 1 ? `, ${totals.kitQty} kits` : ''}) maps to "3M Vinyl", labor ($${fmt(totals.adjLabor)}) to "Graphics Install Labor" — NetSuite adds tax.`))) return;
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

  // Spawn a graphics production job from a saved quote. The job lands on the
  // Graphics board as "Received" with the vehicle, customer, films, and
  // coverage areas pre-filled — no retyping. One job per quote; if one
  // already exists the badge/button opens it instead.
  const createGraphicsJob = async (q: WrapQuote) => {
    if (jobsByQuote[q.id]) { window.open(`/graphics?editJob=${jobsByQuote[q.id].id}`, '_blank'); return; }
    if (!(await dialog.confirm(`Create a graphics job from ${q.quote_number}? It lands on the Graphics board as "Received" with the vehicle, films, and coverage areas filled in.`))) return;
    setCreatingJobFor(q.id);
    try {
      const res = await apiFetch('/api/graphics/from-wrap-quote', {
        method: 'POST',
        body: JSON.stringify({ quoteId: q.id, mode: 'create' }),
      });
      const data = await res.json();
      if (res.status === 409 && data.graphicsJobId) {
        // Someone beat us to it — remember the link and offer to open it.
        setJobsByQuote(prev => ({ ...prev, [q.id]: { id: data.graphicsJobId, job_number: data.jobNumber || null } }));
        if (await dialog.confirm(`${data.error}. Open it?`)) window.open(`/graphics?editJob=${data.graphicsJobId}`, '_blank');
        return;
      }
      if (!res.ok || !data.success) {
        await dialog.alert(`Graphics job failed: ${data.error || 'Unknown error'}`);
        return;
      }
      setJobsByQuote(prev => ({ ...prev, [q.id]: { id: data.graphicsJobId, job_number: data.jobNumber || null } }));
      if (await dialog.confirm(`Graphics job ${data.jobNumber} created. Open it on the Graphics board?`)) {
        window.open(`/graphics?editJob=${data.graphicsJobId}`, '_blank');
      }
    } catch (e: any) {
      await dialog.alert(`Graphics job failed: ${e.message}`);
    } finally {
      setCreatingJobFor(null);
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
        points: l.geometry?.poly || undefined,
        area_in2: l.area_in2 != null ? num(l.area_in2) : undefined,
        perimeter_in: l.perimeter_in != null ? num(l.perimeter_in) : undefined,
      };
      // Freeform shapes missing their cached metrics (hand-edited rows)
      // recompute from the outline when the template is calibrated.
      if (m.type === 'poly' && m.points && (m.area_in2 == null || m.perimeter_in == null) && ppi > 0) {
        Object.assign(m, polyMetrics(m.points, ppi));
      }
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
    setPolyDraft(null);
    setPolyHover(null);
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
    setPackageQty(String(Math.max(1, num(q.package_qty) || 1)));
    // Pin the saved discount % (clearing the field re-derives from the
    // settings tiers); older quotes have no adjustments and stay on auto.
    setDiscountPctOverride(q.adjustments?.discount_pct != null ? String(q.adjustments.discount_pct) : '');
    // Restore the roll-nesting layout: placements were saved by measurement
    // index, so re-key them onto the freshly minted measurement ids.
    const n = q.nesting;
    if (n) {
      setRollConfig({
        widthIn: num(n.roll_width_in) || DEFAULT_ROLL.widthIn,
        lengthIn: num(n.roll_length_in) || DEFAULT_ROLL.lengthIn,
        spacingIn: n.spacing_in != null ? Math.max(0, num(n.spacing_in)) : DEFAULT_ROLL.spacingIn,
        edgeMarginIn: n.edge_margin_in != null ? Math.max(0, num(n.edge_margin_in)) : DEFAULT_ROLL.edgeMarginIn,
        overlapIn: n.overlap_in != null ? Math.max(0, num(n.overlap_in)) : DEFAULT_ROLL.overlapIn,
      });
      const restored: PlacementMap = {};
      for (const row of n.placements || []) {
        const target = ms[row.m];
        if (!target) continue;
        // Older snapshots predate split parts — treat them as whole panels.
        const part = row.part != null ? Math.trunc(num(row.part)) : -1;
        restored[pieceKey(target.id, row.copy, row.set, part, target.substrate_id || '')] =
          // Same clamp the packer applies to obstacles — a corrupt roll
          // index must not spawn phantom rolls in usage or rendering.
          { roll: Math.min(MAX_ROLLS_PER_FILM - 1, Math.max(0, Math.trunc(num(row.roll)))), x: num(row.x), y: num(row.y), rot: row.rot === 90 ? 90 : 0 };
      }
      setPlacements(restored);
      setUseRollPricing(!!n.enabled);
    } else {
      setRollConfig({ ...DEFAULT_ROLL });
      setPlacements({});
      setUseRollPricing(false);
    }
    setSendInclude({ pricing: true, lineItems: true, diagram: true, netsuitePdf: false });
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
  const addAttachments = async (files: FileList | File[] | null) => {
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
  // ── Follow-up actions on sent quotes ──
  // Quiet days since the customer last heard from us — same clock as the
  // follow-up queue: max(sent date, last logged follow-up).
  const quietDays = (q: WrapQuote): number | null => {
    const ref = [q.sent_at, q.last_followup_at]
      .filter(Boolean).map(d => new Date(d as string).getTime());
    if (ref.length === 0) return null;
    return Math.floor((Date.now() - Math.max(...ref)) / 86_400_000);
  };

  const saveFollowupNote = async () => {
    if (!followupNoteFor || fuSaving) return;
    setFuSaving(true);
    try {
      const res = await fetch('/api/quotes/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'wrap', id: followupNoteFor.id, action: 'log_followup',
          note: fuNote.trim() || undefined, remindAt: fuRemindAt || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert('Failed to log follow-up: ' + (data.error || 'Unknown error'));
      } else {
        const nowIso = new Date().toISOString();
        setHistory(prev => prev.map(q => q.id === followupNoteFor.id ? { ...q, last_followup_at: nowIso } : q));
        setFollowupNoteFor(null);
        setFuNote('');
        setFuRemindAt('');
      }
    } catch {
      await dialog.alert('Network error — please try again.');
    }
    setFuSaving(false);
  };

  const fetchFollowupEmailPreview = async (fields: EmailComposeFields) => {
    if (!followupEmailFor) return { error: 'No quote selected' };
    try {
      const res = await fetch('/api/quotes/follow-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'wrap', id: followupEmailFor.id, preview: true,
          emails: fields.emails, message: fields.message || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data.preview) return { preview: { to: data.to ?? null, subject: data.subject, html: data.html } };
      return { error: data.error || 'Unknown error' };
    } catch {
      return { error: 'Network error — please try again.' };
    }
  };

  const confirmSendFollowupEmail = async (fields: EmailComposeFields): Promise<{ ok: boolean }> => {
    if (!followupEmailFor) return { ok: false };
    try {
      const res = await fetch('/api/quotes/follow-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'wrap', id: followupEmailFor.id,
          emails: fields.emails, bccSelf: fields.bccSelf, message: fields.message || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert('Send failed: ' + (data.error || 'Unknown error'));
        return { ok: false };
      }
      const nowIso = new Date().toISOString();
      setHistory(prev => prev.map(q => q.id === followupEmailFor.id ? { ...q, last_followup_at: nowIso } : q));
      const em = data.dispatch?.email;
      await dialog.alert(`Follow-up email sent to ${em?.target || 'recipient'}${em?.bcc ? ` (bcc ${em.bcc})` : ''}. The follow-up was logged.`);
      return { ok: true };
    } catch {
      await dialog.alert('Network error — please try again.');
      return { ok: false };
    }
  };

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
      ? { name: s.name, price_per_sqft: String(s.price_per_sqft), bleed_in: String(s.bleed_in), laminate_name: s.laminate_name || '', laminate_price_per_sqft: s.laminate_price_per_sqft ? String(s.laminate_price_per_sqft) : '', labor_per_sqft: s.labor_per_sqft ? String(s.labor_per_sqft) : '', color: s.color || '', cost_per_sqft: s.cost_per_sqft != null ? String(s.cost_per_sqft) : '', laminate_cost_per_sqft: s.laminate_cost_per_sqft != null ? String(s.laminate_cost_per_sqft) : '' }
      : { name: '', price_per_sqft: '', bleed_in: '', laminate_name: '', laminate_price_per_sqft: '', labor_per_sqft: '', color: '', cost_per_sqft: '', laminate_cost_per_sqft: '' });
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
      // Empty = cost unknown (margin readout says so) rather than $0.
      cost_per_sqft: subForm.cost_per_sqft.trim() === '' ? null : num(subForm.cost_per_sqft),
      laminate_cost_per_sqft: subForm.laminate_cost_per_sqft.trim() === '' ? null : num(subForm.laminate_cost_per_sqft),
      // Default a palette color for new films so boxes are distinct from day one
      color: subForm.color || FILM_COLORS[substrates.length % FILM_COLORS.length],
      updated_at: new Date().toISOString(),
    };
    const { error } = subSel
      ? await supabase.from('wrap_substrates').update(row).eq('id', subSel)
      : await supabase.from('wrap_substrates').insert({ ...row, is_active: true });
    if (error) { await dialog.alert(`Save failed: ${saveErrorMessage(error)}`); return; }
    setSubSel(''); setSubForm({ name: '', price_per_sqft: '', bleed_in: '', laminate_name: '', laminate_price_per_sqft: '', labor_per_sqft: '', color: '', cost_per_sqft: '', laminate_cost_per_sqft: '' });
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
    try {
      const { error } = await supabase.from('wrap_quote_settings').upsert({
        id: 1,
        company: companyOverride ?? settings.company,
        tax_rate: num(settings.tax_rate),
        design: settings.design,
        preparation: settings.preparation,
        installation: settings.installation,
        min_job_charge: num(settings.min_job_charge),
        // Drop empty tier rows; keep only usable {min_qty, pct} pairs.
        qty_discounts: settings.qty_discounts
          .map(t => ({ min_qty: Math.max(1, Math.floor(num(t.min_qty))), pct: Math.min(100, Math.max(0, num(t.pct))) }))
          .filter(t => t.min_qty > 1 || t.pct > 0),
        updated_at: new Date().toISOString(),
      });
      if (error) { await dialog.alert(`Save failed: ${saveErrorMessage(error)}`); return; }
      // Re-read so the form shows what's actually stored — a save that
      // didn't land can't sit on screen looking like it did.
      await loadAll();
    } catch (e: any) {
      // Network/unexpected throw: without this the button sticks on "Saving…"
      // forever and the failure is invisible.
      await dialog.alert(`Save failed: ${e?.message || e}`);
    } finally {
      setSavingSettings(false);
    }
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
    // No duplicate templates — same identity the DB unique index enforces
    // (make, model, year, variant, name), case-insensitive.
    const newName = [tplForm.make.trim(), tplForm.model.trim(), tplForm.variant.trim()].filter(Boolean).join(' ');
    const norm = (v?: string | null) => (v || '').trim().toLowerCase();
    const dupe = templates.find(t =>
      norm(t.name) === norm(newName) && norm(t.make) === norm(tplForm.make) &&
      norm(t.model) === norm(tplForm.model) && norm(t.year) === norm(tplForm.year) &&
      norm(t.variant) === norm(tplForm.variant));
    if (dupe) {
      await dialog.alert(`A template for ${templateLabel(dupe) || newName} already exists${dupe.is_active === false ? ' (retired — reactivate it in the grid below)' : ''}.`);
      return;
    }
    setTplUploading(true);
    try {
      const safeName = tplFile.name.replace(/[^a-zA-Z0-9.-]/g, '_');
      const path = `wrapup/${Date.now()}-${safeName}`;
      const { error: upErr } = await storage.from('vehicle-templates').upload(path, tplFile, { contentType: tplFile.type || 'image/png' });
      if (upErr) { await dialog.alert(`Upload failed: ${upErr.message}`); return; }
      const { error } = await supabase.from('vehicle_templates').insert({
        name: newName,
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
      if (error) {
        await dialog.alert(error.code === '23505' ? 'A template with this year/make/model/variant already exists.' : `Save failed: ${error.message}`);
        return;
      }
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
                {m.type === 'poly' && m.points && m.points.length >= 3 && (
                  <polygon points={m.points.map(p => `${p.x},${p.y}`).join(' ')} fill={fc + '26'} stroke={fc} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                )}
                {(m.type === 'roof' || m.type === 'hood') && (
                  <>
                    {m.line1 && <line x1={m.line1.x1} y1={m.line1.y1} x2={m.line1.x2} y2={m.line1.y2} stroke="#ef4444" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
                    {m.line2 && <line x1={m.line2.x1} y1={m.line2.y1} x2={m.line2.x2} y2={m.line2.y2} stroke="#3b82f6" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
                  </>
                )}
                {(m.rect || m.line1 || m.points?.length) && (
                  <text
                    x={(m.rect ? m.rect.x : m.points?.length ? Math.min(...m.points.map(p => p.x)) : m.line1!.x1) + fontSize / 3}
                    y={(m.rect ? m.rect.y : m.points?.length ? Math.min(...m.points.map(p => p.y)) : m.line1!.y1) - fontSize / 3}
                    fontSize={fontSize} fontWeight={700} fill={fc}
                  >{m.name}</text>
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
  const quotePreview = (q: { quote_number: string; vehicle_description: string | null; customer: any; project_type: string | null; project_notes: string | null; measurements: any[]; labor: any; subtotal: number; tax_rate: number; tax_amount: number; total: number; diagram_path?: string | null; attachments?: QuoteAttachment[] | null; created_at?: string; package_qty?: number | null; adjustments?: QuoteAdjustments | null; nesting?: NestingSnapshot | null }, coverage?: React.ReactNode) => (
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
                  {fmt(l.billed_area_sqft)} ft²{l.substrate ? ` · ${l.substrate.name}` : ''}{(q.package_qty || 1) > 1 ? ' · per kit' : ''}
                </span>
              </td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{l.qty}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{l.unit_price == null ? '—' : fmt(l.unit_price)}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{l.line_total == null ? '—' : fmt(l.line_total)}</td>
            </tr>
          ))}
          {/* Roll pricing: materials bill as the vinyl cut off each film's
              roll — the shape rows above show sizes only. */}
          {q.nesting?.enabled && (q.nesting.films || []).filter(f => num(f.material_total) > 0.005).map((f, i) => (
            <tr key={`roll-${i}`} style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
              <td style={{ padding: '5px 6px', borderBottom: `1px solid ${theme.border}` }}>
                Material — {f.label}
                <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '9px', fontWeight: 400 }}>
                  {[
                    num(f.roll_sqft) > 0.005 ? `${fmt(f.roll_sqft)} ft² · ${(f.rolls || []).length > 1 ? `${f.rolls.length} rolls, ` : ''}${fmtFtIn((f.rolls || []).reduce((s, r) => s + num(r.used_length_in), 0))} of ${num(q.nesting!.roll_width_in)}" roll` : '',
                    num(f.extra_area_sqft) > 0.005 ? `${fmt(f.extra_area_sqft)} ft² billed by area` : '',
                  ].filter(Boolean).join(' + ')}{(q.nesting!.sets || 1) > 1 ? ` · ${q.nesting!.sets} sets` : ''}
                </span>
              </td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>1</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{fmt(f.material_total)}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{fmt(f.material_total)}</td>
            </tr>
          ))}
          {(q.package_qty || 1) > 1 && q.adjustments && !q.nesting?.enabled && (
            <tr style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
              <td style={{ padding: '5px 6px', borderBottom: `1px solid ${theme.border}` }}>
                Materials — {q.package_qty} kits
                <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '9px', fontWeight: 400 }}>
                  {fmt(q.adjustments.kit_area_sqft)} ft² per kit
                </span>
              </td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{q.package_qty}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{fmt(q.adjustments.kit_materials)}</td>
              <td style={{ padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${theme.border}` }}>{fmt(q.adjustments.pre_materials)}</td>
            </tr>
          )}
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
      {q.nesting?.enabled && (
        <div style={{ marginTop: '4px', fontSize: '10px', color: 'var(--text-secondary)' }}>
          <b style={{ color: 'var(--text-primary)' }}>Materials priced from nested roll layout:</b>{' '}
          {fmt((q.nesting.films || []).reduce((s, f) => s + num(f.roll_sqft), 0))} ft² of {num(q.nesting.roll_width_in)}&quot; roll
          {(q.nesting.sets || 1) > 1 ? ` · ${q.nesting.sets} sets nested together` : ''}
        </div>
      )}
      <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px', fontSize: '12px', color: 'var(--text-primary)' }}>
        {q.adjustments && (num(q.adjustments.discount_amount) > 0.005 || num(q.adjustments.min_bump) > 0.005) && (
          <div style={{ color: 'var(--text-secondary)' }}>Subtotal before adjustments <b style={{ marginLeft: '14px' }}>${fmt(num(q.adjustments.pre_subtotal))}</b></div>
        )}
        {q.adjustments && num(q.adjustments.discount_amount) > 0.005 && (
          <div style={{ color: '#a78bfa' }}>Quantity discount ({fmt(num(q.adjustments.discount_pct))}%) <b style={{ marginLeft: '14px' }}>−${fmt(num(q.adjustments.discount_amount))}</b></div>
        )}
        {q.adjustments && num(q.adjustments.min_bump) > 0.005 && (
          <div style={{ color: '#fbbf24' }}>Shop minimum <b style={{ marginLeft: '14px' }}>+${fmt(num(q.adjustments.min_bump))}</b></div>
        )}
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

      {/* Add Graphics round trip — pinned while pricing for an estimate */}
      {forEstimate && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          padding: '10px 14px', borderRadius: '10px', marginBottom: '12px',
          background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.3)',
        }}>
          <div style={{ flex: 1, minWidth: '220px' }}>
            <div style={{ fontSize: '12px', fontWeight: 800, color: '#8b5cf6' }}>
              🎨 Building graphics for Estimate {forEstimate.number}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {[forEstimate.customerName, forEstimate.vehicle].filter(Boolean).join(' · ') || 'Price the wrap, then add it to the estimate'}
            </div>
            {/* What rides along onto the estimate's customer PDF (one merged
                file: quote + these). Unchecked = price lines only. */}
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '6px' }}>
              {([
                ['diagram', 'Coverage diagram'],
                ['attachments', `Attachments${attachments.length > 0 ? ` (${attachments.length})` : ''}`],
                ['films', 'Vinyl details'],
              ] as const).map(([key, label]) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={estAttach[key]}
                    onChange={e => setEstAttach(prev => ({ ...prev, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', alignSelf: 'center' }}>→ merged into the estimate's customer PDF</span>
            </div>
          </div>
          <button
            onClick={addToEstimate}
            disabled={addingToEstimate}
            title="Save this wrap quote and add it to the estimate as materials + install lines (re-adding after edits updates the same lines)"
            style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', background: '#8b5cf6', color: '#fff', fontSize: '12px', fontWeight: 800, cursor: addingToEstimate ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}
          >
            {addingToEstimate ? 'Adding…' : `✓ Add to Estimate ${forEstimate.number}`}
          </button>
          <button
            onClick={() => router.push(`/estimates?id=${forEstimate.id}`)}
            title="Return to the estimate without adding graphics"
            style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            ← Back to estimate
          </button>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {([
          { id: 'estimator' as Tab, label: 'Estimator' },
          { id: 'nesting' as Tab, label: `Roll Nesting${nestPieces.length > 0 ? ` (${nestPieces.length})` : ''}` },
          { id: 'quote' as Tab, label: 'Quote' },
          { id: 'history' as Tab, label: `Quote History (${history.filter(q => !q.archived_at).length})` },
          { id: 'pricing' as Tab, label: 'Pricing' },
          { id: 'company' as Tab, label: 'Company Info' },
          { id: 'templates' as Tab, label: `Templates (${templates.length})` },
        ]).map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            background: tab === t.id ? 'var(--tab-active-bg)' : 'transparent',
            border: tab === t.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: tab === t.id ? 'var(--tab-active-color)' : 'var(--text-muted)',
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
            <div style={{ position: 'relative', width: '220px' }}>
              <input
                value={tplSearch}
                onChange={e => setTplSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && templateSearchMatches.length > 0) { e.preventDefault(); pickTemplate(templateSearchMatches[0]); }
                  else if (e.key === 'Escape') setTplSearch('');
                }}
                placeholder="Type to search templates…"
                style={{ ...inputStyle, width: '100%' }}
              />
              {tplSearch.trim().length >= 2 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, minWidth: '100%', width: 'max-content', maxWidth: '420px', zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '260px', overflowY: 'auto', marginTop: '2px' }}>
                  {templateSearchMatches.length === 0 ? (
                    <div style={{ padding: '8px 10px', fontSize: '11px', color: 'var(--text-muted)' }}>No templates match</div>
                  ) : templateSearchMatches.slice(0, 50).map(t => (
                    <button key={t.id} onMouseDown={e => e.preventDefault()} onClick={() => pickTemplate(t)} style={{ display: 'block', width: '100%', padding: '8px 10px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'var(--text-primary)' }}>
                      <span style={{ fontWeight: 700 }}>{templateLabel(t)}</span>
                      {t.template_code && <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '10px' }}>{t.template_code}</span>}
                    </button>
                  ))}
                  {templateSearchMatches.length > 50 && (
                    <div style={{ padding: '6px 10px', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>
                      Showing 50 of {templateSearchMatches.length} matches — keep typing to narrow
                    </div>
                  )}
                </div>
              )}
            </div>
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
                    { id: 'poly' as Tool, label: 'Draw Shape' },
                    { id: 'roof' as Tool, label: 'Draw Roof' },
                    { id: 'hood' as Tool, label: 'Draw Hood' },
                  ]).map(t => (
                    <button key={t.id} onClick={() => { setTool(t.id); setPendingPair(null); if (t.id !== 'poly') { setPolyDraft(null); setPolyHover(null); } }} disabled={!template.px_per_in} title={!template.px_per_in ? 'Calibrate the template first' : (t.id === 'roof' || t.id === 'hood') ? 'Drag line 1 along the side view, then line 2 across the front/back view — area = L1 × L2' : t.id === 'poly' ? 'Click to place connected corners; click the first point again to close the shape' : undefined} style={{
                      padding: '8px 6px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: template.px_per_in ? 'pointer' : 'default',
                      background: tool === t.id ? 'rgba(6,182,212,0.15)' : 'var(--subtle-bg)',
                      border: tool === t.id ? '1px solid rgba(6,182,212,0.4)' : '1px solid var(--border)',
                      color: tool === t.id ? '#06b6d4' : 'var(--text-secondary)',
                      opacity: template.px_per_in ? 1 : 0.5,
                    }}>{t.label}</button>
                  ))}
                </div>
                <button onClick={() => { setTool('calibrate'); setPendingPair(null); setPolyDraft(null); setPolyHover(null); }} style={{
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

                {tool === 'poly' && (!polyDraft || polyDraft.length === 0) && (
                  <div style={{ padding: '8px', borderRadius: '8px', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '10px', lineHeight: 1.5 }}>
                    <b style={{ color: '#06b6d4' }}>Freeform shape:</b> click to place each corner — the lines connect
                    as you go and snap square to the previous point. Click the <b>first point</b> again to close the
                    shape (it highlights when you&apos;re close). Pricing uses the shape&apos;s true area, not its bounding box.
                  </div>
                )}

                {polyDraft && polyDraft.length > 0 && (
                  <div style={{ padding: '8px', borderRadius: '8px', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', fontSize: '10px', fontWeight: 700, color: '#06b6d4', marginBottom: '10px' }}>
                    {polyDraft.length} point{polyDraft.length !== 1 ? 's' : ''} placed{polyDraft.length >= 3 ? ' — click the first point (or Close Shape) to finish.' : ' — keep clicking corners.'}
                    <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
                      <button onClick={closePoly} disabled={polyDraft.length < 3} style={{ ...btnStyle('#22c55e', 'rgba(34,197,94,0.1)'), opacity: polyDraft.length < 3 ? 0.5 : 1 }}>Close Shape</button>
                      <button onClick={undoPolyPoint} style={btnStyle('#f59e0b', 'transparent')}>Undo Point</button>
                      <button onClick={cancelPoly} style={btnStyle('#ef4444', 'transparent')}>Cancel</button>
                    </div>
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
                      <NumberInput min={1} value={selected.qty} onChange={e => updateMeasurement(selected.id, { qty: Math.max(1, Math.round(num(e.target.value))) })} style={{ ...inputStyle, marginBottom: '6px' }} />
                      <div style={labelStyle}>Film</div>
                      <select value={selected.substrate_id || ''} onChange={e => updateMeasurement(selected.id, { substrate_id: e.target.value || null })} style={{ ...inputStyle, marginBottom: '6px' }}>
                        <option value="">— none —</option>
                        {activeSubstrates.map(s => <option key={s.id} value={s.id}>{filmLabel(s)} (${fmt(filmRate(s))}/ft²)</option>)}
                      </select>
                      <div style={{ display: 'flex', gap: '6px', margin: '2px 0 8px', flexWrap: 'wrap' }}>
                        <button onClick={() => duplicateMeasurement(selected.id)} style={btnStyle('#06b6d4', 'rgba(6,182,212,0.08)')}>⧉ Duplicate</button>
                        {selected.type === 'poly' && (
                          <button onClick={() => duplicateMeasurement(selected.id, true)} title="Duplicate this shape flipped horizontally — driver side → passenger side" style={btnStyle('#a78bfa', 'rgba(167,139,250,0.08)')}>⧉ Mirror Copy</button>
                        )}
                        {selected.type === 'poly' && (
                          <button onClick={() => flipMeasurement(selected.id, 'h')} title="Flip this shape left↔right in place" style={btnStyle('#f59e0b', 'transparent')}>⇋ Flip</button>
                        )}
                        {selected.type === 'poly' && (
                          <button onClick={() => flipMeasurement(selected.id, 'v')} title="Flip this shape top↕bottom in place" style={btnStyle('#f59e0b', 'transparent')}>⇵ Flip</button>
                        )}
                        <button onClick={() => removeMeasurement(selected.id)} style={btnStyle('#ef4444', 'transparent')}>Delete</button>
                      </div>
                      {selected.type === 'poly' && selected.points && polygonSelfIntersects(selected.points) && (
                        <div style={{ fontSize: '10px', color: '#fbbf24', fontWeight: 700, marginBottom: '4px' }}>
                          ⚠ Outline crosses itself — the area can&apos;t be trusted. Drag the corners apart.
                        </div>
                      )}
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
                          <g key={m.id} onPointerDown={e => { if (tool === 'select') { if (m.type === 'box' && m.rect) { beginEditDrag(e, m, 'move'); } else if (m.type === 'poly' && m.points) { beginEditDrag(e, m, 'move'); } else { e.stopPropagation(); setSelectedId(m.id); } } }} style={{ cursor: tool === 'select' ? 'move' : 'pointer' }}>
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
                            {m.type === 'poly' && m.points && m.points.length >= 3 && (
                              <polygon points={m.points.map(p => `${p.x},${p.y}`).join(' ')} fill={fill} stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                            )}
                            {/* Selected shapes expose their corners for fine-tuning
                                and label each edge with its real length. */}
                            {m.type === 'poly' && m.points && sel && tool === 'select' && (
                              <>
                                {num(template.px_per_in) > 0 && m.points.map((pt, i) => {
                                  const nxt = m.points![(i + 1) % m.points!.length];
                                  const lenIn = Math.hypot(nxt.x - pt.x, nxt.y - pt.y) / num(template.px_per_in);
                                  if (lenIn < 0.5) return null;
                                  return (
                                    <text key={`edge-${i}`} x={(pt.x + nxt.x) / 2} y={(pt.y + nxt.y) / 2 - fontSize / 4} fontSize={fontSize * 0.75} fontWeight={700} fill="#f59e0b" textAnchor="middle">{lenIn.toFixed(1)}&quot;</text>
                                  );
                                })}
                                {m.points.map((pt, i) => (
                                  <circle key={`vtx-${i}`} cx={pt.x} cy={pt.y} r={Math.max(5, imgDim.w / 220)}
                                    fill="#f59e0b" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                                    style={{ cursor: 'grab' }}
                                    onPointerDown={e => beginEditDrag(e, m, 'vertex', i)}
                                  />
                                ))}
                              </>
                            )}
                            {(m.type === 'roof' || m.type === 'hood') && ([
                              [m.line1, '#ef4444', 1, num(m.dim1_in)] as const,
                              [m.line2, '#3b82f6', 2, num(m.dim2_in)] as const,
                            ]).map(([ln, color, no, dimIn]) => ln && (
                              <g key={`ln-${no}`}>
                                <line x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2} stroke={color} strokeWidth={3} vectorEffect="non-scaling-stroke" />
                                {/* Each line wears its measured length so a
                                    misdrawn width line is obvious at a glance */}
                                {dimIn > 0 && (
                                  <text x={(ln.x1 + ln.x2) / 2} y={(ln.y1 + ln.y2) / 2 - fontSize / 3} fontSize={fontSize * 0.75} fontWeight={700} fill={color} textAnchor="middle">{dimIn.toFixed(1)}&quot;</text>
                                )}
                                {sel && tool === 'select' && ([1, 2] as const).map(endNo => (
                                  <circle key={endNo}
                                    cx={endNo === 1 ? ln.x1 : ln.x2} cy={endNo === 1 ? ln.y1 : ln.y2}
                                    r={Math.max(5, imgDim.w / 220)} fill={color} stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                                    style={{ cursor: 'grab' }}
                                    onPointerDown={e => beginLineEndDrag(e, m, no, endNo)}
                                  />
                                ))}
                              </g>
                            ))}
                            {(m.rect || m.line1 || m.points?.length) && (
                              <text
                                x={(m.rect ? m.rect.x : m.points?.length ? Math.min(...m.points.map(p => p.x)) : m.line1!.x1) + fontSize / 3}
                                y={(m.rect ? m.rect.y : m.points?.length ? Math.min(...m.points.map(p => p.y)) : m.line1!.y1) - fontSize / 3}
                                fontSize={fontSize} fontWeight={700} fill={stroke}
                              >{m.name}</text>
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
                      {/* Live size readout while drawing — follows the cursor
                          so boxes can be drawn to fit the vinyl roll; flips
                          pink with a panel count once the shape is too wide
                          for the roll in both directions. */}
                      {drag && tool !== 'calibrate' && num(template.px_per_in) > 0 && (() => {
                        const ppi = num(template.px_per_in);
                        const wIn = Math.abs(drag.x2 - drag.x1) / ppi;
                        const hIn = Math.abs(drag.y2 - drag.y1) / ppi;
                        const fontSize = imgDim.w / 70;
                        const boxLike = tool === 'box' || tool === 'circle';
                        const panels = boxLike ? splitForRoll(wIn, hIn, rollConfig).length : 1;
                        const label = boxLike
                          ? `${wIn.toFixed(1)}" × ${hIn.toFixed(1)}"${panels > 1 ? ` · ${panels} panels` : ''}`
                          : `${(Math.hypot(drag.x2 - drag.x1, drag.y2 - drag.y1) / ppi).toFixed(1)}"`;
                        return (
                          <text x={drag.x2 + fontSize / 2} y={drag.y2 - fontSize / 2} fontSize={fontSize * 0.85} fontWeight={800}
                            fill={panels > 1 ? '#db2777' : '#0891b2'} stroke="#fff" strokeWidth={fontSize / 7} paintOrder="stroke"
                            style={{ pointerEvents: 'none', userSelect: 'none' }}>
                            {label}
                          </text>
                        );
                      })()}
                      {/* Same readout while resizing an existing box. */}
                      {editDrag?.kind === 'resize' && (() => {
                        const m = measurements.find(x => x.id === editDrag.id);
                        if (!m?.rect) return null;
                        const fontSize = imgDim.w / 70;
                        const panels = splitForRoll(num(m.dim1_in), num(m.dim2_in), rollConfig).length;
                        return (
                          <text x={m.rect.x + m.rect.w + fontSize / 2} y={m.rect.y + m.rect.h + fontSize} fontSize={fontSize * 0.85} fontWeight={800}
                            fill={panels > 1 ? '#db2777' : '#0891b2'} stroke="#fff" strokeWidth={fontSize / 7} paintOrder="stroke"
                            style={{ pointerEvents: 'none', userSelect: 'none' }}>
                            {num(m.dim1_in).toFixed(1)}&quot; × {num(m.dim2_in).toFixed(1)}&quot;{panels > 1 ? ` · ${panels} panels` : ''}
                          </text>
                        );
                      })()}
                      {/* Freeform shape in progress: placed corners, the live
                          edge to the cursor, per-edge lengths, and a green
                          first point when one more click closes the shape. */}
                      {tool === 'poly' && polyDraft && polyDraft.length > 0 && (() => {
                        const ppi = num(template.px_per_in);
                        const pts = polyHover ? [...polyDraft, polyHover] : polyDraft;
                        const closeReady = !!polyHover && closesPoly(polyHover, polyDraft);
                        const fontSize = imgDim.w / 70;
                        return (
                          <g>
                            <polyline points={pts.map(p => `${p.x},${p.y}`).join(' ')} fill={pts.length >= 3 ? 'rgba(6,182,212,0.08)' : 'none'} stroke="#06b6d4" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray="6 4" />
                            {ppi > 0 && pts.slice(0, -1).map((pt, i) => {
                              const nxt = pts[i + 1];
                              const lenIn = Math.hypot(nxt.x - pt.x, nxt.y - pt.y) / ppi;
                              if (lenIn < 0.5) return null;
                              return (
                                <text key={`dlen-${i}`} x={(pt.x + nxt.x) / 2} y={(pt.y + nxt.y) / 2 - fontSize / 4} fontSize={fontSize * 0.75} fontWeight={700} fill="#06b6d4" textAnchor="middle">{lenIn.toFixed(1)}&quot;</text>
                              );
                            })}
                            {polyDraft.map((pt, i) => (
                              <circle key={`dpt-${i}`} cx={pt.x} cy={pt.y}
                                r={i === 0 && polyDraft.length >= 3 ? Math.max(6, imgDim.w / 170) : Math.max(4, imgDim.w / 260)}
                                fill={i === 0 && closeReady ? '#22c55e' : i === 0 && polyDraft.length >= 3 ? 'rgba(34,197,94,0.5)' : '#06b6d4'}
                                stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                            ))}
                          </g>
                        );
                      })()}
                    </svg>
                  )}
                </div>

                {/* Footer bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', padding: '10px 14px', marginTop: '10px', background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '10px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                    {template.template_code ? `${template.template_code} · ` : ''}{templateLabel(template)} · {template.scale || '1:20'} scale
                  </div>
                  {/* Coverage = drawn (trim) area; billed film adds each film's
                      bleed per side, which is what the quote's lines, install
                      labor, and film usage are priced on. Showing both keeps
                      this footer consistent with the quote totals. */}
                  {/* The drawn canvas is one kit; qty multiplies the job. */}
                  <label title="How many of this graphics package the customer wants — one kit is what's drawn on the canvas" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    Kits ×
                    <input type="number" min="1" step="1" value={packageQty}
                      onChange={e => setPackageQty(e.target.value)}
                      style={{ width: '58px', padding: '5px 7px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 800 }} />
                  </label>
                  <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    Coverage: {fmt(totals.area)} ft²{totals.kitQty > 1 ? ` (${fmt(totals.kitArea)}/kit)` : ''}
                  </div>
                  {totals.billedArea - totals.area > 0.005 && (
                    <div title="Print area billed on the quote — each panel plus its film&#39;s bleed on every side. Set bleed per film on the Pricing tab." style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)' }}>
                      Billed film: {fmt(totals.billedArea)} ft²
                    </div>
                  )}
                  {totals.nested && (
                    <div title="Materials are priced from the nested roll layout — roll width × used length per film" style={{ fontSize: '12px', fontWeight: 800, color: '#f472b6' }}>
                      Roll: {fmt(totals.nestedRollSqft)} ft²
                    </div>
                  )}
                  <div style={{ fontSize: '12px', fontWeight: 800, color: '#22c55e' }}>Estimated Cost: ${fmt(totals.total)}</div>
                  {/* Internal materials margin — never appears on the emailed
                      quote. Compares cost against the DISCOUNTED material
                      price, so a too-generous qty discount flags itself. */}
                  {totals.adjMaterials > 0 && (totals.materialCost > 0 || totals.uncostedFilms.length > 0) && (() => {
                    const pct = totals.materialCost > 0 ? ((totals.adjMaterials - totals.materialCost) / totals.adjMaterials) * 100 : null;
                    const color = pct == null ? 'var(--text-muted)' : pct < 0 ? '#ef4444' : pct < marginFloor ? '#fbbf24' : '#22c55e';
                    return (
                      <div
                        title={totals.uncostedFilms.length > 0 ? `No cost set for: ${totals.uncostedFilms.join(', ')} — add film costs on the Pricing tab` : `Material cost $${fmt(totals.materialCost)} vs billed $${fmt(totals.adjMaterials)}${totals.discount > 0.005 ? ' (after discount)' : ''} · floor ${marginFloor}%`}
                        style={{ fontSize: '12px', fontWeight: 800, color }}
                      >
                        {pct != null
                          ? `Material Margin: ${pct.toFixed(0)}%${pct < marginFloor ? ' ⚠' : ''}${totals.uncostedFilms.length > 0 ? ' (partial)' : ''}`
                          : 'Margin: set film costs on Pricing tab'}
                      </div>
                    );
                  })()}
                  <button onClick={() => setTab('nesting')} disabled={measurements.length === 0} title="Lay the shapes out on the vinyl roll and price by material actually used" style={{
                    padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 800,
                    background: measurements.length === 0 ? 'var(--subtle-bg)' : 'rgba(244,114,182,0.12)',
                    border: measurements.length === 0 ? 'none' : '1px solid rgba(244,114,182,0.4)',
                    color: measurements.length === 0 ? 'var(--text-muted)' : '#f472b6',
                    cursor: measurements.length === 0 ? 'default' : 'pointer',
                  }}>Nest Roll →</button>
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

      {/* ================= ROLL NESTING ================= */}
      {tab === 'nesting' && (
        <div>
          {nestCapped && (
            <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', fontSize: '11px', fontWeight: 700, color: '#fbbf24' }}>
              The layout shows the first {nestPieces.length} pieces (quantity × sets is very large). Pieces beyond that
              still bill — by their area instead of roll footage — so the quote stays whole.
            </div>
          )}
          <RollNesting
            pieces={nestPieces}
            films={nestFilms}
            config={rollConfig}
            onConfigChange={setRollConfig}
            placements={placements}
            onPlacementsChange={setPlacements}
            sets={kitSets}
            onSetsChange={n => setPackageQty(String(n))}
            useRollPricing={useRollPricing}
            onUseRollPricingChange={setUseRollPricing}
            extraSqftByFilm={Object.fromEntries([...nestFilmBilling].filter(([, v]) => v.extraSqft > 0).map(([k, v]) => [k, v.extraSqft]))}
          />
          {nestPieces.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', padding: '10px 14px', marginTop: '10px', background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '10px' }}>
              <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>
                Roll material: {fmt(nestUsage.totalRollSqft)} ft²
              </div>
              <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)' }}>
                Graphics: {fmt(totals.billedArea)} ft²
              </div>
              {totals.nested && (
                <div style={{ fontSize: '12px', fontWeight: 800, color: '#f472b6' }}>Quote materials: ${fmt(totals.adjMaterials)}</div>
              )}
              <div style={{ marginLeft: 'auto', fontSize: '12px', fontWeight: 800, color: '#22c55e' }}>Estimated Cost: ${fmt(totals.total)}</div>
              <button onClick={() => setTab('quote')} style={{
                padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, border: 'none',
                background: '#22c55e', color: '#fff', cursor: 'pointer',
              }}>Quote →</button>
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
                <input value={customer[k] || ''} onChange={e => { const v = k === 'phone' ? formatPhoneInput(e.target.value) : e.target.value; setCustomer({ ...customer, [k]: v }); if (k === 'name') setCustomerId(null); }} style={inputStyle} />
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
              {customerId ? (
                <span style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
                  Linked to NetSuite customer
                </span>
              ) : (
                <>
                  <button onClick={createNetsuiteCustomer} disabled={creatingCustomer || !customer.name?.trim()} style={btnStyle('#a78bfa', 'rgba(167,139,250,0.08)')}>
                    {creatingCustomer ? 'Creating…' : 'Create Customer in NetSuite'}
                  </button>
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Not in the search? Create them without leaving this screen.</span>
                </>
              )}
            </div>
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
            {sectionHead('Job Pricing')}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
              <div>
                <div style={labelStyle}>Kits (qty)</div>
                <input type="number" min="1" step="1" value={packageQty} onChange={e => setPackageQty(e.target.value)} style={{ ...inputStyle, width: '70px' }} />
              </div>
              <div>
                <div style={labelStyle}>Qty Discount (%)</div>
                <input type="number" min="0" max="100" step="0.5" value={discountPctOverride}
                  onChange={e => setDiscountPctOverride(e.target.value)}
                  placeholder={totals.tierPct > 0 ? `auto ${totals.tierPct}` : '0'}
                  style={{ ...inputStyle, width: '90px' }} />
              </div>
            </div>
            {totals.kitQty > 1 && (
              <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                One kit = {fmt(totals.kitArea)} ft² / ${fmt(totals.kitMaterials)} materials · × {totals.kitQty} kits
              </div>
            )}
            {totals.discount > 0.005 && (
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#a78bfa', marginBottom: '4px' }}>
                Quantity discount {fmt(totals.discountPct)}%{discountPctOverride.trim() === '' && totals.tierPct > 0 ? ` (auto — ${totals.kitQty}+ kits tier)` : ''}: −${fmt(totals.discount)}
              </div>
            )}
            {totals.minBump > 0.005 && (
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#fbbf24', marginBottom: '4px' }}>
                Shop minimum ${fmt(totals.minCharge)} applied: +${fmt(totals.minBump)}
              </div>
            )}
            <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              The drawing prices one kit; qty multiplies materials and film labor (design/prep/install stay one-time). Discount auto-fills from the Pricing tab tiers — type a % to override, clear to go back to auto.
            </div>
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
            <DropZone disabled={attaching} onFiles={files => addAttachments(files)}>
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
            </DropZone>
            <div style={{ marginBottom: '8px' }}>
              <div style={labelStyle}>Email Content</div>
              {([
                ['diagram', 'Coverage picture', 'The vehicle drawing with the wrap areas'],
                ['pricing', 'Pricing', 'Subtotal, tax, and total in the email body'],
                ['lineItems', 'Itemized line items', 'The per-area rows — uncheck for just the total'],
                ['netsuitePdf', 'NetSuite quote PDF', 'Attached; NetSuite\u2019s totals are the document of record'],
              ] as const).map(([key, label, hint]) => {
                const disabled = key === 'lineItems' && !sendInclude.pricing;
                return (
                  <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 2px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1 }}>
                    <input
                      type="checkbox"
                      checked={key === 'lineItems' ? sendInclude.lineItems && sendInclude.pricing : sendInclude[key]}
                      disabled={disabled}
                      onChange={e => setSendInclude(prev => ({ ...prev, [key]: e.target.checked }))}
                    />
                    <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>{label}</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{hint}</span>
                  </label>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button onClick={() => saveQuote()} style={btnStyle('#60a5fa', 'rgba(59,130,246,0.1)')}>{savedQuoteId ? 'Update Draft' : 'Save Draft'}</button>
              <button onClick={createAndEmail} disabled={sending} style={{ ...btnStyle('#fff', '#22c55e'), border: 'none' }}>
                {sending ? 'Working…' : (!sendInclude.pricing && !sendInclude.netsuitePdf) ? 'Preview & Email Coverage' : 'Preview & Email Quote'}
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
                {jobsByQuote[q.id] && (
                  <button
                    onClick={e => { e.stopPropagation(); window.open(`/graphics?editJob=${jobsByQuote[q.id].id}`, '_blank'); }}
                    title="Open this quote's graphics job on the Graphics board"
                    style={{ fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px', background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: 'none', cursor: 'pointer' }}
                  >{jobsByQuote[q.id].job_number || 'Job'} ↗</button>
                )}
                {q.archived_at && (
                  <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px', background: 'rgba(148,163,184,0.12)', color: '#94a3b8' }}>Archived</span>
                )}
                <span
                  title={q.status === 'rejected' ? (q.customer_rejection_reason ? `Customer requested changes: ${q.customer_rejection_reason}` : 'Marked lost') : q.status === 'accepted' && q.accepted_at ? `Accepted ${new Date(q.accepted_at).toLocaleString()}` : undefined}
                  style={{
                    fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px',
                    background: q.status === 'accepted' ? 'rgba(34,197,94,0.12)' : q.status === 'rejected' ? 'rgba(239,68,68,0.12)' : q.status === 'sent' ? 'rgba(96,165,250,0.12)' : 'rgba(148,163,184,0.12)',
                    color: q.status === 'accepted' ? '#22c55e' : q.status === 'rejected' ? '#ef4444' : q.status === 'sent' ? '#60a5fa' : '#94a3b8',
                  }}>{q.status === 'accepted' ? 'Accepted ✓' : q.status === 'rejected' ? 'Lost / Changes' : q.status === 'sent' ? `Sent${q.sent_to ? ` · ${q.sent_to}` : ''}` : 'Draft'}</span>
                <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>${fmt(q.total)}</span>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{new Date(q.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                {q.status === 'sent' && !q.archived_at && (() => {
                  const quiet = quietDays(q);
                  return (
                    <>
                      {quiet !== null && quiet >= 3 && (
                        <span title={q.last_followup_at ? `Last follow-up ${new Date(q.last_followup_at).toLocaleDateString()}` : 'No follow-up logged since sending'} style={{
                          fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px', whiteSpace: 'nowrap',
                          background: quiet >= 14 ? 'rgba(239,68,68,0.12)' : quiet >= 5 ? 'rgba(251,191,36,0.12)' : 'rgba(148,163,184,0.12)',
                          color: quiet >= 14 ? '#ef4444' : quiet >= 5 ? '#fbbf24' : '#94a3b8',
                        }}>quiet {quiet}d</span>
                      )}
                      <button
                        onClick={e => { e.stopPropagation(); setFollowupNoteFor(q); setFuNote(''); setFuRemindAt(''); }}
                        title="Log a follow-up (call/text/etc) with an optional note and reminder"
                        style={btnStyle('#60a5fa', 'transparent')}
                      >☎ Log</button>
                      <button
                        onClick={e => { e.stopPropagation(); setFollowupEmailFor(q); }}
                        title="Send a follow-up email (includes the Review & Accept link while it's valid)"
                        style={btnStyle('#60a5fa', 'transparent')}
                      >✉ Follow Up</button>
                    </>
                  );
                })()}
                {q.status === 'accepted' && (
                  <button
                    onClick={e => { e.stopPropagation(); router.push(deepLinks.signedDocument('wrap_quote', q.id)); }}
                    title="View the frozen acceptance snapshot with its integrity check"
                    style={btnStyle('#60a5fa', 'transparent')}
                  >⎙ Signed Doc</button>
                )}
                {q.status === 'sent' && q.approval_token && (
                  <button
                    onClick={async e => {
                      e.stopPropagation();
                      const url = `${window.location.origin}/approve/quote/${q.approval_token}`;
                      try { await navigator.clipboard.writeText(url); await dialog.alert('Accept link copied — paste it into a text or email.'); }
                      catch { await dialog.alert(url); }
                    }}
                    title="Copy the customer's Review & Accept link"
                    style={btnStyle('#22c55e', 'transparent')}
                  >
                    ⧉ Accept Link
                  </button>
                )}
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
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '640px', maxHeight: 'calc(90vh / var(--ts))', overflowY: 'auto' }}>
            {quotePreview(viewQuote)}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '8px' }}>
              <button onClick={() => loadQuoteForEdit(viewQuote)} style={btnStyle('#60a5fa', 'var(--card)')}>Edit / Resend</button>
              <button
                onClick={() => createGraphicsJob(viewQuote)}
                disabled={creatingJobFor === viewQuote.id}
                title={jobsByQuote[viewQuote.id] ? "Open this quote's graphics job on the Graphics board" : 'Create a graphics job pre-filled from this quote'}
                style={btnStyle('#22c55e', 'var(--card)')}
              >
                {creatingJobFor === viewQuote.id ? 'Creating…' : jobsByQuote[viewQuote.id] ? `Job ${jobsByQuote[viewQuote.id].job_number || ''} ↗` : 'Create Graphics Job'}
              </button>
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
              <div style={{ ...labelStyle, color: '#f472b6' }}>Film Cost ($/ft²)</div>
              <input type="number" value={subForm.cost_per_sqft} onChange={e => setSubForm({ ...subForm, cost_per_sqft: e.target.value })} placeholder="our cost" style={{ ...inputStyle, width: '85px' }} />
            </div>
            <div>
              <div style={{ ...labelStyle, color: '#f472b6' }}>Lam. Cost ($/ft²)</div>
              <input type="number" value={subForm.laminate_cost_per_sqft} onChange={e => setSubForm({ ...subForm, laminate_cost_per_sqft: e.target.value })} placeholder="our cost" style={{ ...inputStyle, width: '85px' }} />
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
            Film + laminate price together as one material (e.g. IJ280 + 8428) and appear as one quote line. Bleed is extra print margin added to each side of a measured area. The color is what that film's boxes look like on the vehicle, so mixing films (print layer + reflective on top) stays readable. The pink cost fields are what the material costs <b>us</b> — they never appear on a quote, they only power the internal margin readout on the estimator.
          </div>

          {isAdmin && (
            <>
              {sectionHead('Margin Floor')}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', marginBottom: '4px' }}>
                <div>
                  <div style={labelStyle}>Floor (%)</div>
                  <NumberInput
                    value={marginFloor}
                    onChange={e => setMarginFloor(num(e.target.value))}
                    onBlur={async e => {
                      const v = num(e.target.value);
                      // Silent failure here reads as "the floor won't save":
                      // surface it instead of swallowing the error.
                      try {
                        const { error } = await supabase.from('quote_settings').upsert({ id: 1, margin_floor_pct: v, updated_at: new Date().toISOString(), updated_by: user?.id || null });
                        if (error) await dialog.alert(`Margin floor didn't save: ${saveErrorMessage(error)}`);
                      } catch (err: any) {
                        await dialog.alert(`Margin floor didn't save: ${err?.message || err}`);
                      }
                    }}
                    style={{ ...inputStyle, width: '90px' }}
                  />
                </div>
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '16px' }}>
                Quotes with a margin under this get flagged in both the estimate builder and here. Saves on blur; shared across both builders.
              </div>
            </>
          )}

          {sectionHead('Taxes')}
          <div style={{ marginBottom: '16px' }}>
            <div style={labelStyle}>Tax Rate (%)</div>
            <input type="number" value={settings.tax_rate || ''} onChange={e => setSettings(prev => ({ ...prev, tax_rate: num(e.target.value) }))} style={{ ...inputStyle, width: '110px' }} />
          </div>

          {sectionHead('Job Pricing')}
          <div style={{ marginBottom: '8px' }}>
            <div style={labelStyle}>Shop Minimum ($ per job)</div>
            <input type="number" min="0" value={settings.min_job_charge || ''}
              onChange={e => setSettings(prev => ({ ...prev, min_job_charge: num(e.target.value) }))}
              placeholder="0 = off" style={{ ...inputStyle, width: '110px' }} />
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            No job quotes below this (pre-tax). A one-decal job takes real time end to end — the quote shows a visible &ldquo;shop minimum&rdquo; line instead of going out at $45.
          </div>
          <div style={labelStyle}>Quantity Discounts</div>
          {settings.qty_discounts.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <input type="number" min="2" value={t.min_qty || ''}
                onChange={e => setSettings(prev => { const tiers = [...prev.qty_discounts]; tiers[i] = { ...tiers[i], min_qty: num(e.target.value) }; return { ...prev, qty_discounts: tiers }; })}
                placeholder="qty" style={{ ...inputStyle, width: '70px' }} />
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>+ kits →</span>
              <input type="number" min="0" max="100" step="0.5" value={t.pct || ''}
                onChange={e => setSettings(prev => { const tiers = [...prev.qty_discounts]; tiers[i] = { ...tiers[i], pct: num(e.target.value) }; return { ...prev, qty_discounts: tiers }; })}
                placeholder="%" style={{ ...inputStyle, width: '70px' }} />
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>% off</span>
              <button onClick={() => setSettings(prev => ({ ...prev, qty_discounts: prev.qty_discounts.filter((_, j) => j !== i) }))} title="Remove tier" style={btnStyle('#ef4444', 'transparent')}>✕</button>
            </div>
          ))}
          <button onClick={() => setSettings(prev => ({ ...prev, qty_discounts: [...prev.qty_discounts, { min_qty: 0, pct: 0 }] }))} style={{ ...btnStyle('#a78bfa', 'rgba(167,139,250,0.08)'), marginBottom: '4px' }}>
            + Add Tier
          </button>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '16px' }}>
            Applied automatically when a quote&apos;s kit quantity reaches a tier (highest qualifying % wins) — so 100 small decals don&apos;t price like 100 separate jobs. The estimator can override the % per quote.
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
          <DropZone accept="image/*" multiple={false} onFiles={files => uploadLogo(files[0])} style={{ marginBottom: '10px' }}>
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
          </DropZone>
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
              <DropZone accept="image/*" multiple={false} onFiles={files => setTplFile(files[0])}>
              <label style={{ ...btnStyle('#a78bfa', 'rgba(167,139,250,0.08)'), display: 'inline-block' }}>
                {tplFile ? tplFile.name.slice(0, 24) : 'Choose Image'}
                <input type="file" accept="image/*" onChange={e => setTplFile(e.target.files?.[0] || null)} style={{ display: 'none' }} />
              </label>
              </DropZone>
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
                    <button onClick={() => { pickTemplate(t); setTab('estimator'); }} style={btnStyle('#06b6d4', 'rgba(6,182,212,0.08)')}>Open</button>
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

      {/* Email-the-quote compose — the standard customer email screen
          (docs/customer-email-standard.md). The Email Content checkboxes
          (sendInclude) live on the Quote tab, so they're fixed for the
          modal's lifetime; the live preview is the send route's dry run of
          the shared quote document. */}
      {emailModal && emailQuoteId && (
        <EmailComposeModal
          title="Review Email Before Sending"
          sendLabel={!sendInclude.pricing && !sendInclude.netsuitePdf ? 'Send Coverage' : 'Send Quote'}
          messagePlaceholder="Optional note to the customer — added above the quote…"
          intro={sendInclude.netsuitePdf ? (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              The NetSuite quote PDF is attached automatically in this mode.
            </div>
          ) : undefined}
          attachments={attachments.map(a => ({ id: a.path, name: a.name, sizeBytes: a.size }))}
          initialAttachmentIds={attachments.map(a => a.path)}
          fetchPreview={fetchQuoteEmailPreview}
          onSend={sendQuoteEmail}
          onClose={() => setEmailModal(false)}
        />
      )}

      {/* Follow-up email on a sent quote — standard compose screen; sending
          also logs the follow-up (resets the queue's quiet clock). */}
      {followupEmailFor && (
        <EmailComposeModal
          title={`Follow Up — Quote ${followupEmailFor.quote_number}`}
          sendLabel="Send Follow-Up"
          messagePlaceholder="Personal note — shown at the top of the follow-up email…"
          fetchPreview={fetchFollowupEmailPreview}
          onSend={confirmSendFollowupEmail}
          onClose={() => setFollowupEmailFor(null)}
        />
      )}

      {/* Log-a-follow-up dialog — same fields as /admin/quote-followups. */}
      {followupNoteFor && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
          onClick={() => !fuSaving && setFollowupNoteFor(null)}
        >
          <div onClick={e => e.stopPropagation()} style={{
            width: '100%', maxWidth: '420px', background: 'var(--card)', border: `1px solid ${theme.border}`,
            borderRadius: '14px', padding: '16px',
          }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '2px' }}>
              Log Follow-Up — {followupNoteFor.quote_number}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
              {followupNoteFor.customer?.name || 'No customer'} · ${fmt(followupNoteFor.total)}
            </div>
            <textarea
              value={fuNote}
              onChange={e => setFuNote(e.target.value)}
              placeholder="What did the customer say? (e.g. vehicles arrive in September)"
              rows={3}
              style={{
                width: '100%', padding: '10px', borderRadius: '10px', boxSizing: 'border-box',
                border: `1px solid ${theme.border}`, background: 'var(--input-bg)',
                color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical', marginBottom: '10px',
              }}
            />
            <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
              Remind me on (optional)
            </label>
            <input
              type="date"
              value={fuRemindAt}
              min={new Date().toISOString().slice(0, 10)}
              onChange={e => setFuRemindAt(e.target.value)}
              style={{
                width: '100%', padding: '9px 10px', borderRadius: '10px', boxSizing: 'border-box',
                border: `1px solid ${theme.border}`, background: 'var(--input-bg)',
                color: 'var(--text-primary)', fontSize: '13px', marginBottom: '12px',
              }}
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={saveFollowupNote}
                disabled={fuSaving}
                style={{
                  flex: 1, padding: '10px', borderRadius: '10px', border: 'none',
                  background: '#60a5fa', color: '#fff', fontWeight: 800, fontSize: '13px',
                  cursor: 'pointer', opacity: fuSaving ? 0.5 : 1,
                }}
              >{fuSaving ? 'Saving…' : 'Log Follow-Up'}</button>
              <button
                onClick={() => setFollowupNoteFor(null)}
                disabled={fuSaving}
                style={{
                  padding: '10px 16px', borderRadius: '10px', background: 'transparent',
                  border: `1px solid ${theme.border}`, color: 'var(--text-body)', fontWeight: 700,
                  fontSize: '13px', cursor: 'pointer',
                }}
              >Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
