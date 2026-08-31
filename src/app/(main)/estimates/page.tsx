'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePopout } from '@/components/Popout';
import { createClient } from '@/lib/supabase-browser';
import { useAuth, useRequireFeature } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';
import CustomerDefaultsEditor from '@/components/CustomerDefaultsEditor';
import PartCatalogBrowser, { type BrowsePart, type KitWithMembers } from '@/components/PartCatalogBrowser';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import EmailComposeModal, { type EmailComposeFields } from '@/components/EmailComposeModal';
import { flashNote } from '@/lib/focus-note';
import { decodeVIN, isValidVIN } from '@/lib/vin-decoder';
import { resolvePlatform, matchQualifiersToConfig } from '@/lib/vin-platform';
import { sameVehicleVin, vinMatchOrFilter } from '@/lib/vin-match';
import { IN_SHOP_STATUSES } from '@/lib/types';
import { deepLinks } from '@/lib/deep-links';
import { isGraphicsLine } from '@/lib/graphics-lines';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';
import { readEstimateDraft, writeEstimateDraft, clearEstimateDraft, sweepEstimateDrafts, type EstimateDraft } from '@/lib/estimate-draft';
import { FALLBACK_SALES_TAX_RATE, pctToRate, rateToPct } from '@/lib/sales-tax';
import NumberInput from '@/components/NumberInput';
import { CreateNetsuiteItemModal, type CreatedPart } from '@/components/CreateNetsuiteItemModal';
import { estimateHeadlineNumber, estimateAltNumber, estimateNumberMatches } from '@/lib/estimate-number';

interface Part {
  id: string;
  netsuite_id: string;
  item_number: string;
  display_name: string;
  description: string;
  sales_price: number;
  labor_hours: number;
  catalog: string;
  purchase_price: number | null;
  avg_install_cost: number | null;
}

interface LineItem {
  key: string; // local key for React
  part_id: string | null;
  netsuite_item_id: string | null;
  item_number: string;
  description: string;
  quantity: number;
  unit_price: number;
  labor_hours: number;
  is_custom: boolean;
  notes?: string;
  // Which wrap quote produced this line (Add Graphics flow) — preserved
  // through save so re-adding an edited quote replaces instead of duplicating.
  wrap_quote_id?: string | null;
  catalog?: string; // 'upfit' | 'graphics' — drives the graphics-job prompt
  // True-cost inputs for the margin strip: NetSuite part cost + the running
  // average of what installers actually charge us for this part.
  purchase_price?: number | null;
  avg_install_cost?: number | null;
}

// Shared with convert-to-so's blocking graphics gate — one predicate, so the
// panel here and the server-side wall can never disagree about what counts
// as graphics work.

interface LinkedGraphicsJob {
  id: string;
  job_number: string | null;
  title: string;
  status: string;
  assigned_to: string | null;
  /** Which of this job's proof files ride on the estimate's customer
   *  surfaces (migration 235) — seeds the compose screen's proof picker. */
  estimate_attach?: { file_ids?: string[] } | null;
  /** The file a proof-only send showed the customer — the picker's default
   *  when nothing is stored yet. */
  approval_proof_file_id?: string | null;
}

/** A linked job's file as the approval compose proof picker lists it. */
interface JobProofFile {
  id: string;
  job_id: string;
  file_name: string;
  file_type: string | null;
  file_size: number | null;
}

// A checked-in vehicle (fleet_checkins) as the link button/picker sees it.
interface CheckinLite {
  id: string;
  vin: string;
  status: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  customer_name: string | null;
  customer_id?: string | null;
  install_instructions?: string | null;
  on_site_contact_name?: string | null;
  on_site_contact_phone?: string | null;
  delivery_preferences?: string | null;
}

const CHECKIN_COLS = 'id, vin, status, vehicle_year, vehicle_make, vehicle_model, customer_name, customer_id, install_instructions, on_site_contact_name, on_site_contact_phone, delivery_preferences';

const checkinLabel = (c: CheckinLite) =>
  [c.vehicle_year, c.vehicle_make, c.vehicle_model].filter(Boolean).join(' ') || 'Vehicle';

const GRAPHICS_STATUS_COLORS: Record<string, string> = {
  flagged: '#ef4444',
  received: '#94a3b8',
  designing: '#a78bfa',
  revision: '#f59e0b',
  printing: '#60a5fa',
  outgassing: '#60a5fa',
  cutting: '#60a5fa',
  packing: '#60a5fa',
  ready: '#22c55e',
  ready_to_pickup: '#22c55e',
  shipped: '#22c55e',
  picked_up: '#22c55e',
  installed: '#22c55e',
  cancelled: '#64748b',
};

interface Estimate {
  id: string;
  estimate_number: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_netsuite_id: string | null;
  title: string | null;
  notes: string | null;
  status: string;
  tax_rate: number;
  tax_exempt: boolean;
  labor_rate: number;
  labor_hours: number;
  labor_hours_override: number | null;
  subtotal: number;
  labor_total: number;
  tax_amount: number;
  grand_total: number;
  netsuite_estimate_id: string | null;
  netsuite_estimate_number: string | null;
  netsuite_so_id: string | null;
  netsuite_so_number: string | null;
  // Delivery state of the LATEST approval email (Resend webhook — same
  // scheme as invoice emails). null = never emailed / pre-tracking sends.
  approval_email_status: string | null;
  approval_email_detail: string | null;
  approval_email_to: string[] | null;
  approval_email_updated_at: string | null;
  // Follow-up state (quote-followups queue) — surfaced on sent rows so
  // chasing happens from here without a trip to /admin/quote-followups.
  sent_for_approval_at: string | null;
  last_followup_at: string | null;
  pushed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  vin: string | null;
  vehicle_other: string | null;
  unit_number: string | null;
  vehicle_platform_id: string | null;
  vehicle_year: string | null;
  vehicle_wheelbase: string | null;
  vehicle_roof: string | null;
  vehicle_cab: string | null;
  vehicle_bed: string | null;
  fleet_checkin_id: string | null;
  // R3-17 lineage: set when this estimate was duplicated off a locked
  // (accepted/converted) one — the builder shows the chain both directions.
  supersedes_estimate_id: string | null;
  // Approval provenance + rejection record (Stage 3: these lived only in
  // the DB and one push notification — the builder now shows them).
  customer_approved_at: string | null;
  customer_approved_via: string | null;
  customer_rejected_at: string | null;
  customer_rejection_reason: string | null;
}

// Allowed qualifier options per platform, from vehicle_platforms.config —
// a select only renders when its platform actually has options for it.
interface PlatformConfig {
  wheelbases?: string[];
  roofs?: string[];
  cabs?: string[];
  beds?: string[];
}

interface VehiclePlatform {
  id: string;
  key: string;
  label: string;
  body_type: 'van' | 'truck' | 'other';
  sort_order: number;
  config: PlatformConfig | null;
}

// Sentinel option value for the vehicle dropdown's free-text "Other" entry
// (not a platform id — pickPlatform intercepts it).
const OTHER_VEHICLE = '__other__';

// Live feedback under the VIN input — the decode is never silent.
type VinStatus =
  | { kind: 'partial'; len: number }
  | { kind: 'invalid' }
  | { kind: 'decoding' }
  | { kind: 'filled'; summary: string; needs: string[] }
  | { kind: 'no-platform'; summary: string }
  | { kind: 'failed' };

interface Customer {
  id: string;
  netsuite_id: string | null;
  company_name: string;
  entity_id: string;
  /** True for CRM leads (prospects with no NetSuite record yet). */
  isLead?: boolean;
}

type ViewMode = 'list' | 'builder';

// Fallback only — the real rate is the company setting (quote_settings,
// Settings → Sales Tax, super admin only). Used until that load returns, or
// if it fails.
const DEFAULT_TAX_RATE = FALLBACK_SALES_TAX_RATE;
const DEFAULT_LABOR_RATE = 120;

const STATUS_COLORS: Record<string, string> = {
  draft: '#60a5fa',
  sent: '#fbbf24',
  accepted: '#22c55e',
  rejected: '#ef4444',
  pushed: '#a78bfa',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  rejected: 'Rejected',
  pushed: 'Pushed to NS',
};

function genKey() {
  return Math.random().toString(36).substring(2, 10);
}

export default function EstimatesPage() {
  const router = useRouter();
  const { open: openPopout } = usePopout();
  const searchParams = useSearchParams();
  const { user, isAdmin, isSales, isGraphicsProduction, profile, loading: authLoading } = useAuth();
  // The nav tab was feature-gated but the URL itself was open — the exact
  // gated-by-nav-only pattern the role cleanup ended (audit item 9). Same
  // key now guards every /api/estimates route server-side.
  useRequireFeature('estimates');
  const dialog = useDialog();
  const supabase = createClient();

  const [view, setView] = useState<ViewMode>('list');
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // Deep link: ?q=<term> (universal search "View all") prefills the list search.
  useEffect(() => {
    const q = searchParams.get('q');
    if (q) setSearch(q);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: read once on mount
  }, []);

  // Builder state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerNsId, setCustomerNsId] = useState<string | null>(null);
  // Sales tax is company-wide and NOT editable here — it comes from
  // quote_settings and only a super admin can change it (Settings → Sales
  // Tax). `taxRate` still holds a per-estimate value because an already-saved
  // estimate keeps the rate it was quoted at.
  const [taxRate, setTaxRate] = useState(DEFAULT_TAX_RATE);
  const [companyTaxRate, setCompanyTaxRate] = useState(DEFAULT_TAX_RATE);
  // Ref so resetBuilder/applyDraft read the current company rate without
  // re-creating themselves on every settings load.
  const companyTaxRateRef = useRef(DEFAULT_TAX_RATE);
  const [taxExempt, setTaxExempt] = useState(false);
  const [laborRate, setLaborRate] = useState(DEFAULT_LABOR_RATE);
  const [laborOverride, setLaborOverride] = useState<number | null>(null);
  const [lines, setLines] = useState<LineItem[]>([]);
  // Margin floor (%) below which a quote gets flagged — admin-set, shared
  // with the wrap-quote builder via the quote_settings singleton.
  const [linkingSO, setLinkingSO] = useState(false);
  const [marginFloor, setMarginFloor] = useState(30);
  // K5: vehicle identity — prints on the estimate document, pushes to
  // NetSuite's VIN field, and feeds the Shop Board's Arriving row.
  const [vin, setVin] = useState('');
  // Order header fields NetSuite entry has that we didn't: the customer's
  // PO (→ NS otherRefNum, wins over our estimate number on the SO) and the
  // quote's expiration date (→ NS "Expires"/dueDate).
  const [poNumber, setPoNumber] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  // Checked-in vehicle link: the fleet_checkins row (In-Shop board) this
  // estimate is for. Linked by the button/picker below, or suggested when
  // the typed VIN matches a vehicle currently on the ground.
  const [fleetCheckinId, setFleetCheckinId] = useState<string | null>(null);
  const [linkedCheckin, setLinkedCheckin] = useState<CheckinLite | null>(null);
  const [checkinPickerOpen, setCheckinPickerOpen] = useState(false);
  const [checkinOptions, setCheckinOptions] = useState<CheckinLite[]>([]);
  const [checkinSearch, setCheckinSearch] = useState('');
  const [checkinSuggestion, setCheckinSuggestion] = useState<CheckinLite | null>(null);
  // N4-B2 phase 3: the vehicle LIVES on the estimate whether or not a VIN
  // exists — platform (make+model), year, and the qualifiers that gate
  // fitment: roof/wheelbase for vans, cab/bed for trucks. Selects cascade
  // from vehicle_platforms.config so only options that exist for the chosen
  // platform are offered; a VIN decode auto-fills what it can.
  const [platforms, setPlatforms] = useState<VehiclePlatform[]>([]);
  const [vehiclePlatformId, setVehiclePlatformId] = useState<string | null>(null);
  // Free-text vehicle for anything the platforms table doesn't cover — a
  // VIN decode fills it when no platform matches, or staff type it by hand
  // via the "Other" option (field ask 2026-08-21: any vehicle selectable).
  const [vehicleOther, setVehicleOther] = useState('');
  const [vehicleOtherMode, setVehicleOtherMode] = useState(false);
  const [vehicleYear, setVehicleYear] = useState('');
  const [vehicleWheelbase, setVehicleWheelbase] = useState('');
  const [vehicleRoof, setVehicleRoof] = useState('');
  const [vehicleCab, setVehicleCab] = useState('');
  const [vehicleBed, setVehicleBed] = useState('');
  const selectedPlatform = platforms.find(p => p.id === vehiclePlatformId) || null;
  const platformConfig: PlatformConfig = selectedPlatform?.config || {};

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('vehicle_platforms')
      .select('id, key, label, body_type, sort_order, config')
      .eq('active', true)
      .order('sort_order')
      .then(({ data }: { data: VehiclePlatform[] | null }) => { if (!cancelled && data) setPlatforms(data); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- platform vocabulary loads once
  }, []);

  // Manual platform switch: keep qualifier values the new platform also
  // offers (same roof label etc.), drop the ones it doesn't.
  const pickPlatform = (id: string | null) => {
    if (id === OTHER_VEHICLE) {
      // "Other" — free-text vehicle, no platform (and no fitment filtering).
      setVehiclePlatformId(null);
      setVehicleOtherMode(true);
      setVehicleWheelbase(''); setVehicleRoof(''); setVehicleCab(''); setVehicleBed('');
      return;
    }
    setVehiclePlatformId(id);
    setVehicleOtherMode(false);
    if (id) setVehicleOther('');
    const cfg: PlatformConfig = platforms.find(p => p.id === id)?.config || {};
    setVehicleWheelbase(prev => (cfg.wheelbases || []).includes(prev) ? prev : '');
    setVehicleRoof(prev => (cfg.roofs || []).includes(prev) ? prev : '');
    setVehicleCab(prev => (cfg.cabs || []).includes(prev) ? prev : '');
    setVehicleBed(prev => (cfg.beds || []).includes(prev) ? prev : '');
  };

  // The decode is never silent (Craig 2026-08-12: "I don't see the vin field
  // doing anything") — every state the VIN box can be in reports under it:
  // partial length, invalid characters, decoding, filled-with-summary, or
  // decoded-but-unrecognized.
  const [vinStatus, setVinStatus] = useState<VinStatus | null>(null);

  useEffect(() => {
    if (!vin) { setVinStatus(null); return; }
    if (vin.length < 17) { setVinStatus({ kind: 'partial', len: vin.length }); return; }
    if (!isValidVIN(vin)) { setVinStatus({ kind: 'invalid' }); return; }
    let cancelled = false;
    setVinStatus({ kind: 'decoding' });
    const t = setTimeout(async () => {
      try {
        const decoded = await decodeVIN(vin);
        if (cancelled) return;
        if (!decoded || (decoded.make === 'Unknown' && decoded.model === 'Vehicle')) {
          setVinStatus({ kind: 'failed' });
          return;
        }
        const res = resolvePlatform({ make: decoded.make, model: decoded.model, series: decoded.series, year: decoded.year }, vin);
        if (decoded.year) setVehicleYear(decoded.year);
        const vehicleName = [decoded.year, decoded.make, decoded.model === 'Vehicle' ? '' : decoded.model]
          .filter(Boolean).join(' ');
        // Off-platform vehicle: still land the decode on the estimate as the
        // free-text vehicle (year lives in its own field) instead of leaving
        // the picker empty.
        const fillOther = () => {
          const makeModel = [decoded.make, decoded.model === 'Vehicle' ? '' : decoded.model]
            .filter(Boolean).join(' ');
          if (!makeModel) return;
          setVehiclePlatformId(prev => {
            if (!prev) {
              setVehicleOther(makeModel);
              setVehicleOtherMode(true);
            }
            return prev;
          });
        };
        if (!res.platformKey) {
          fillOther();
          setVinStatus({ kind: 'no-platform', summary: vehicleName });
          return;
        }
        const { data: plat } = await supabase
          .from('vehicle_platforms')
          .select('id, label, config')
          .eq('key', res.platformKey)
          .eq('active', true)
          .maybeSingle();
        if (cancelled) return;
        if (!plat) {
          fillOther();
          setVinStatus({ kind: 'no-platform', summary: vehicleName });
          return;
        }
        const cfg: PlatformConfig = plat.config || {};
        // VIN-encoded qualifiers (Transit body code, Sprinter WB) win;
        // vPIC's dimensional fields fill the rest where unambiguous.
        const matched = matchQualifiersToConfig(decoded, cfg);
        const wb = res.wheelbase || matched.wheelbase;
        const roof = res.roof && (cfg.roofs || []).includes(res.roof) ? res.roof : null;
        const cab = matched.cab;
        const bed = matched.bed;
        setVehiclePlatformId(plat.id);
        setVehicleOtherMode(false);
        setVehicleOther('');
        // Fill only what the decode actually produced; a hand-picked
        // qualifier survives unless it doesn't exist on this platform.
        setVehicleWheelbase(prev => wb || ((cfg.wheelbases || []).includes(prev) ? prev : ''));
        setVehicleRoof(prev => roof || ((cfg.roofs || []).includes(prev) ? prev : ''));
        setVehicleCab(prev => cab || ((cfg.cabs || []).includes(prev) ? prev : ''));
        setVehicleBed(prev => bed || ((cfg.beds || []).includes(prev) ? prev : ''));
        const got = [
          decoded.year, plat.label,
          roof && `${roof} roof`,
          wb && (/^\d/.test(wb) ? `${wb}" WB` : `${wb} WB`),
          cab && `${cab} cab`,
          bed && `${bed}' bed`,
        ].filter(Boolean).join(' · ');
        const needs = [
          cfg.roofs?.length && !roof ? 'roof height' : null,
          cfg.wheelbases?.length && !wb ? 'wheelbase' : null,
          cfg.cabs?.length && !cab ? 'cab size' : null,
          cfg.beds?.length && !bed ? 'bed length' : null,
        ].filter((n): n is string => !!n);
        setVinStatus({ kind: 'filled', summary: got, needs });
      } catch {
        if (!cancelled) setVinStatus({ kind: 'failed' });
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- decode purely from vin
  }, [vin]);
  const [unitNumber, setUnitNumber] = useState('');
  // N4-A: the visual faceted catalog browser (Ranger-style pick-from-list).
  const [showCatalogBrowser, setShowCatalogBrowser] = useState(false);
  // T1.6 install context
  const [installInstructions, setInstallInstructions] = useState('');
  const [onSiteContactName, setOnSiteContactName] = useState('');
  const [onSiteContactPhone, setOnSiteContactPhone] = useState('');
  const [deliveryPreferences, setDeliveryPreferences] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  // The internal notes as last loaded/saved — lets the mention report skip
  // teammates who were already @mentioned before this edit.
  const savedInternalNotesRef = useRef('');
  const [customerDefaults, setCustomerDefaults] = useState<{
    delivery_instructions: string | null;
    billing_contact_name: string | null;
    billing_contact_email: string | null;
    ap_email: string | null;
    internal_notes: string | null;
    tax_exempt: boolean;
    tax_exempt_cert_number: string | null;
    tax_exempt_expires_at: string | null;
  } | null>(null);
  const [editingCustomerDefaults, setEditingCustomerDefaults] = useState(false);
  const [savingCustomerDefaults, setSavingCustomerDefaults] = useState(false);
  const [estSortCol, setEstSortCol] = useState<'item_number' | 'quantity' | 'unit_price' | 'labor_hours' | null>(null);
  const [estSortDir, setEstSortDir] = useState<'asc' | 'desc'>('asc');
  const toggleEstSort = (col: typeof estSortCol) => {
    if (estSortCol === col) { if (estSortDir === 'desc') { setEstSortCol(null); } else { setEstSortDir('desc'); } }
    else { setEstSortCol(col); setEstSortDir('asc'); }
  };
  const estSortIndicator = (col: NonNullable<typeof estSortCol>) => estSortCol === col ? (estSortDir === 'asc' ? ' ▲' : ' ▼') : '';

  // ── Drag-to-reorder lines (≡ handle) ──
  // Pointer-based (works with touch — HTML5 drag events don't on iOS).
  // While dragging, the row under the pointer is found via elementFromPoint
  // (both are viewport coordinates, so text-size zoom needs no correction)
  // and the dragged line takes its place live. Only meaningful in natural
  // order — the handle is inert while a column sort is active. Saving
  // persists the order (sort_order = array index).
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const onDragHandleDown = (e: React.PointerEvent, key: string) => {
    if (estSortCol) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDraggingKey(key);
  };
  const onDragHandleMove = (e: React.PointerEvent) => {
    if (!draggingKey) return;
    const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-linekey]') as HTMLElement | null;
    const overKey = el?.dataset.linekey;
    if (!overKey || overKey === draggingKey) return;
    setLines(prev => {
      const from = prev.findIndex(l => l.key === draggingKey);
      const to = prev.findIndex(l => l.key === overKey);
      if (from < 0 || to < 0 || from === to) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  const onDragHandleUp = () => setDraggingKey(null);
  const sortedLines = estSortCol ? [...lines].sort((a, b) => {
    const av = a[estSortCol] ?? 0; const bv = b[estSortCol] ?? 0;
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return estSortDir === 'asc' ? cmp : -cmp;
  }) : lines;
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [convertingToSO, setConvertingToSO] = useState(false);
  // Busy while the estimate saves ahead of opening the compose screen.
  const [sendingForApproval, setSendingForApproval] = useState(false);
  // Approval email goes through the standard compose screen (E4 +
  // docs/customer-email-standard.md): editable recipients, bcc-me,
  // personal note, and the exact rendered document as a live preview.
  const [approvalModal, setApprovalModal] = useState(false);
  // Filename of the merged estimate PDF the send will auto-attach (linked
  // wrap quotes with estimate_attach) — from the preview response; null =
  // no attachment.
  const [approvalPdfName, setApprovalPdfName] = useState<string | null>(null);
  // Proof picker for the approval compose (linked graphics jobs): each
  // job's files, and which are checked to ride on the send. Approving the
  // estimate will also approve the jobs whose proofs are included.
  const [approvalProofFiles, setApprovalProofFiles] = useState<Record<string, JobProofFile[]>>({});
  const [approvalProofSelections, setApprovalProofSelections] = useState<Record<string, string[]>>({});
  // Email-the-PDF compose modal (FleetSuite enhanced-estimate copy).
  const [pdfEmailModal, setPdfEmailModal] = useState(false);
  // Follow-up actions on sent estimates (list rows): compose modal target
  // and the log-a-note dialog — same machinery as /admin/quote-followups.
  const [followupEmailFor, setFollowupEmailFor] = useState<Estimate | null>(null);
  const [followupNoteFor, setFollowupNoteFor] = useState<Estimate | null>(null);
  const [fuNote, setFuNote] = useState('');
  const [fuRemindAt, setFuRemindAt] = useState('');
  const [fuSaving, setFuSaving] = useState(false);

  // Part search
  const [partSearch, setPartSearch] = useState('');
  const [partResults, setPartResults] = useState<Part[]>([]);
  const [partSearching, setPartSearching] = useState(false);
  const partSearchRef = useRef<HTMLInputElement>(null);
  // "+ New part" without leaving the estimate (admin-only — the create-item
  // API requires the admin role). Launched from the part search dropdown
  // (forLineKey null → lands as a new line) or from a custom line's matcher
  // (forLineKey set → resolves that line to the just-created item).
  const [createPartCtx, setCreatePartCtx] = useState<{ query: string; forLineKey: string | null } | null>(null);

  // Per-line NetSuite item matcher — lets a custom line (typed description +
  // price, no item) get resolved to a real catalog item without deleting and
  // re-adding it. NetSuite silently drops estimate lines with no item id, so
  // this is required before push, not optional cleanup.
  const [matchingLineKey, setMatchingLineKey] = useState<string | null>(null);
  const [lineMatchQuery, setLineMatchQuery] = useState('');
  const [lineMatchResults, setLineMatchResults] = useState<Part[]>([]);
  const [viewingPdf, setViewingPdf] = useState(false);

  // Customer search
  const [custSearch, setCustSearch] = useState('');
  const [custResults, setCustResults] = useState<Customer[]>([]);
  const [custSearching, setCustSearching] = useState(false);
  const [showCustDropdown, setShowCustDropdown] = useState(false);

  // Graphics-job linkage (for spawning / linking a graphics job to this estimate)
  const [linkedGraphicsJobs, setLinkedGraphicsJobs] = useState<LinkedGraphicsJob[]>([]);
  const [graphicsLinking, setGraphicsLinking] = useState(false);
  const [showGraphicsPicker, setShowGraphicsPicker] = useState(false);
  const [graphicsPickerSearch, setGraphicsPickerSearch] = useState('');
  const [graphicsPickerResults, setGraphicsPickerResults] = useState<LinkedGraphicsJob[]>([]);

  useEffect(() => {
    if (!user) return;
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin && !isSales && !isGraphicsProduction) { router.push('/home'); return; }
    loadEstimates();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, user, isAdmin, isSales, isGraphicsProduction]);

  // Auto-open estimate from URL param (deep link from notifications/search).
  // One-shot per id: ?id= stays in the URL, and the effect re-runs whenever
  // its deps change — without the guard a re-run would silently re-open the
  // deep-linked estimate over whatever the user moved on to.
  // Distinct ids still focus (deps include searchParams), so clicking a
  // second estimate's notification from the bell works.
  const handledEstimateId = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const estId = searchParams.get('id');
    if (estId && handledEstimateId.current !== estId) {
      handledEstimateId.current = estId;
      const focus = (est: any) => {
        openEstimate(est);
        // A mention on the Internal Notes field (&note=field) scroll-flashes
        // it once the estimate form renders.
        if (searchParams.get('note') === 'field') flashNote('est-notes-field');
      };
      const est = estimates.find(e => e.id === estId);
      if (est) {
        focus(est);
      } else {
        // Not in the list response (older than the 1000-row read cap, or a
        // status the list filtered out) — fetch it by id so the deep link
        // still lands instead of silently doing nothing.
        (async () => {
          try {
            const res = await fetch(`/api/estimates?id=${estId}`);
            const data = await res.json();
            if (res.ok && data.estimates?.[0]) focus(data.estimates[0]);
          } catch { /* deep link degrades to the plain list */ }
        })();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [loading, searchParams]);

  // ?new=1[&customer=<customers.id>] (deepLinks.newEstimate) opens the
  // builder on a fresh estimate, pre-selecting the customer when one is
  // given — the straight path from entering a new client to quoting them.
  // One-shot: ?id= (an existing-estimate deep link) always wins over ?new=.
  const handledNewParam = useRef(false);
  useEffect(() => {
    if (loading || handledNewParam.current) return;
    if (searchParams.get('new') !== '1' || searchParams.get('id')) return;
    handledNewParam.current = true;
    (async () => {
      // A restored autosave backup carries its own customer — only prefill
      // from the deep link when the builder really starts blank.
      if (await openNewEstimate()) return;
      const custId = searchParams.get('customer');
      if (custId) {
        const { data } = await supabase
          .from('customers')
          .select('id, netsuite_id, company_name, entity_id')
          .eq('id', custId)
          .maybeSingle();
        // No match (bad/stale id) degrades to a blank builder — the customer
        // search is right there.
        if (data) {
          setCustomerId(data.id);
          setCustomerName(data.company_name || data.entity_id || '');
          setCustomerNsId(data.netsuite_id);
        }
        return;
      }
      // ?prospect= — a CRM lead (no NetSuite record yet). The estimate rides
      // on the name alone; pushing it to NetSuite promotes the lead then.
      const prospectId = searchParams.get('prospect');
      if (!prospectId) return;
      const { data: lead } = await supabase
        .from('prospects')
        .select('id, company_name, netsuite_id')
        .eq('id', prospectId)
        .maybeSingle();
      if (lead?.company_name) {
        setCustomerName(lead.company_name);
        setCustomerNsId(lead.netsuite_id || null);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: apply once after load
  }, [loading, searchParams]);

  // `silent` skips the `loading` toggle so mid-session refreshes (after a
  // Save/Sync/Convert) don't unmount the builder behind the full-page spinner.
  const loadEstimates = async (silent: boolean = false) => {
    if (!silent) setLoading(true);
    const res = await fetch('/api/estimates');
    const data = await res.json();
    setEstimates(data.estimates || []);
    if (!silent) setLoading(false);
  };

  // ── Customer search ──
  const searchCustomers = useCallback(async (q: string) => {
    if (q.length < 2) { setCustResults([]); return; }
    setCustSearching(true);
    // Two sources: the NetSuite mirror, and CRM leads (lead tier — records
    // not yet promoted). A lead's estimate rides on the name; pushing it to
    // NetSuite promotes the lead automatically.
    const [mirror, leads] = await Promise.all([
      supabase
        .from('customers')
        .select('id, netsuite_id, company_name, entity_id')
        .or(`company_name.ilike.%${q}%,entity_id.ilike.%${q}%`)
        .limit(8),
      supabase
        .from('prospects')
        .select('id, company_name')
        .ilike('company_name', `%${q}%`)
        .is('netsuite_id', null)
        .neq('record_type', 'vendor')
        .limit(5),
    ]);
    const rows: Customer[] = [
      ...((mirror.data as Customer[]) || []),
      ...((leads.data || []).map((l: { id: string; company_name: string }) => ({
        id: l.id, netsuite_id: null, company_name: l.company_name, entity_id: '', isLead: true,
      }))),
    ];
    setCustResults(rows);
    setCustSearching(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchCustomers(custSearch), 300);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [custSearch]);

  useEffect(() => {
    supabase.from('quote_settings').select('margin_floor_pct, sales_tax_rate_pct').eq('id', 1).maybeSingle()
      .then(({ data }: any) => {
        if (data?.margin_floor_pct != null) setMarginFloor(Number(data.margin_floor_pct));
        if (data?.sales_tax_rate_pct != null) {
          const rate = pctToRate(data.sales_tax_rate_pct);
          setCompanyTaxRate(rate);
          companyTaxRateRef.current = rate;
          // Only the estimate being started fresh adopts the current rate;
          // one already loaded from the database keeps its quoted rate.
          setTaxRate(prev => (editingId ? prev : rate));
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, []);

  const saveMarginFloor = async (v: number) => {
    setMarginFloor(v);
    await supabase.from('quote_settings').upsert({
      id: 1, margin_floor_pct: v, updated_at: new Date().toISOString(), updated_by: user?.id || null,
    });
  };

  // ── Local autosave (crash insurance) ──
  // The builder holds unsaved work in component state only, so a crash, a
  // stray Back, or an in-app navigation used to discard it all. While the
  // builder is dirty its full field state is snapshotted into localStorage
  // (debounced), keyed by estimate id ('new' before the first save);
  // openEstimate/openNewEstimate offer the snapshot back, and a successful
  // save retires it. See src/lib/estimate-draft.ts.
  const draftFields = {
    editingId, title, notes, customerId, customerName, customerNsId,
    taxRate, taxExempt, laborRate, laborOverride, lines,
    vin, unitNumber, vehiclePlatformId, vehicleOther, vehicleOtherMode,
    vehicleYear, vehicleWheelbase, vehicleRoof, vehicleCab, vehicleBed,
    installInstructions, onSiteContactName, onSiteContactPhone,
    deliveryPreferences, poNumber, expirationDate, internalNotes,
    fleetCheckinId,
  };
  const draftSerialized = JSON.stringify(draftFields);
  // Bumped whenever builder state was just made to mirror persisted reality
  // (open, reset, save) — the persist effect re-baselines instead of writing.
  const [draftSession, setDraftSession] = useState(0);
  const draftSessionSeenRef = useRef(-1);
  const draftBaselineRef = useRef('');
  const lastVinKindRef = useRef<string | null>(null);
  const pendingDraftRef = useRef<{ id: string | null; fields: Record<string, any> } | null>(null);
  const vinKind = vinStatus?.kind || null;

  // Write out a snapshot still inside the debounce window — leaving the
  // builder, switching estimates, unmounting, and unloading all route
  // through here so the backup never trails the screen by a keystroke burst.
  const flushPendingDraft = useCallback(() => {
    if (pendingDraftRef.current) {
      writeEstimateDraft(pendingDraftRef.current.id, pendingDraftRef.current.fields);
      pendingDraftRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (view !== 'builder') { flushPendingDraft(); return; }
    const sessionChanged = draftSessionSeenRef.current !== draftSession;
    // A completed VIN decode also re-baselines: its fills (year, platform,
    // qualifiers) are re-derived from the VIN on restore anyway, and counting
    // them as edits produced a phantom "unsaved changes" backup on every open
    // of an estimate whose saved vehicle fields lag what its VIN decodes to.
    const vinFillLanded = lastVinKindRef.current !== vinKind
      && (vinKind === 'filled' || vinKind === 'no-platform');
    lastVinKindRef.current = vinKind;
    if (sessionChanged || vinFillLanded) {
      draftSessionSeenRef.current = draftSession;
      draftBaselineRef.current = draftSerialized;
      pendingDraftRef.current = null;
      return;
    }
    if (draftSerialized === draftBaselineRef.current) { pendingDraftRef.current = null; return; }
    // Content gate: a customer arriving via deep link (?new=1&customer=) or a
    // lone dropdown change isn't worth a restore prompt later.
    const meaningful = lines.length > 0 || !!(title.trim() || notes.trim() || internalNotes.trim()
      || installInstructions.trim() || vin.trim() || unitNumber.trim() || poNumber.trim());
    if (!meaningful) { pendingDraftRef.current = null; return; }
    pendingDraftRef.current = { id: editingId, fields: draftFields };
    const t = setTimeout(() => {
      writeEstimateDraft(editingId, draftFields);
      pendingDraftRef.current = null;
    }, 800);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- draftSerialized covers every snapshotted field
  }, [draftSerialized, view, draftSession, vinKind]);

  useEffect(() => {
    window.addEventListener('beforeunload', flushPendingDraft);
    sweepEstimateDrafts();
    return () => { flushPendingDraft(); window.removeEventListener('beforeunload', flushPendingDraft); };
  }, [flushPendingDraft]);

  // Put a backed-up snapshot into the builder. Loaders for the display-only
  // side records (linked check-in, customer defaults) re-run from the ids.
  const applyDraft = (id: string | null, draft: EstimateDraft) => {
    const f = draft.fields || {};
    setEditingId(id);
    setTitle(f.title || '');
    setNotes(f.notes || '');
    setCustomerId(f.customerId ?? null);
    setCustomerName(f.customerName || '');
    setCustomerNsId(f.customerNsId ?? null);
    setTaxRate(typeof f.taxRate === 'number' ? f.taxRate : companyTaxRateRef.current);
    setTaxExempt(!!f.taxExempt);
    setLaborRate(typeof f.laborRate === 'number' ? f.laborRate : DEFAULT_LABOR_RATE);
    setLaborOverride(typeof f.laborOverride === 'number' ? f.laborOverride : null);
    setLines(Array.isArray(f.lines)
      ? f.lines.map((l: any) => ({ ...l, key: l.key || genKey() }))
      : []);
    setVin(f.vin || '');
    setUnitNumber(f.unitNumber || '');
    setVehiclePlatformId(f.vehiclePlatformId ?? null);
    setVehicleOther(f.vehicleOther || '');
    setVehicleOtherMode(!!f.vehicleOtherMode);
    setVehicleYear(f.vehicleYear || '');
    setVehicleWheelbase(f.vehicleWheelbase || '');
    setVehicleRoof(f.vehicleRoof || '');
    setVehicleCab(f.vehicleCab || '');
    setVehicleBed(f.vehicleBed || '');
    setInstallInstructions(f.installInstructions || '');
    setOnSiteContactName(f.onSiteContactName || '');
    setOnSiteContactPhone(f.onSiteContactPhone || '');
    setDeliveryPreferences(f.deliveryPreferences || '');
    setPoNumber(f.poNumber || '');
    setExpirationDate(f.expirationDate || '');
    setInternalNotes(f.internalNotes || '');
    setFleetCheckinId(f.fleetCheckinId ?? null);
    if (f.fleetCheckinId) loadLinkedCheckin(f.fleetCheckinId);
    else setLinkedCheckin(null);
    if (f.customerId) loadCustomerDefaults(f.customerId);
  };

  // Offer the device-local backup for this estimate (null = the unsaved
  // builder). True = restored. Declining discards the backup.
  const maybeOfferDraft = async (id: string | null, est?: Estimate): Promise<boolean> => {
    const draft = readEstimateDraft(id);
    if (!draft) return false;
    const savedAt = new Date(draft.savedAt);
    const staleNote = est?.updated_at && new Date(est.updated_at) > savedAt
      ? '\n\nNote: this estimate has been saved more recently (possibly on another device) than this backup — restoring brings back the older unsaved edits.'
      : '';
    const lineCount = Array.isArray(draft.fields?.lines) ? draft.fields.lines.length : 0;
    const label = draft.fields?.title || draft.fields?.customerName || '';
    const ok = await dialog.confirm(
      `Unsaved work${label ? ` (“${label}”)` : ''} from ${savedAt.toLocaleString()} was backed up on this device — ` +
      `${lineCount} line item${lineCount === 1 ? '' : 's'}. Restore it?${staleNote}`,
      { title: 'Restore unsaved estimate?', confirmLabel: 'Restore', cancelLabel: 'Discard backup' },
    );
    if (!ok) { clearEstimateDraft(id); return false; }
    applyDraft(id, draft);
    return true;
  };

  // New-estimate entry point (button + ?new=1 deep link): blank builder,
  // then offer any backed-up never-saved draft. True = a backup was restored.
  const openNewEstimate = async (): Promise<boolean> => {
    flushPendingDraft(); // don't lose the tail of whatever was open before
    resetBuilder();
    setView('builder');
    return maybeOfferDraft(null);
  };

  // ── Part search ──
  const searchParts = useCallback(async (q: string) => {
    if (q.length < 2) { setPartResults([]); return; }
    setPartSearching(true);
    const { data } = await supabase
      .from('netsuite_parts')
      .select('id, netsuite_id, item_number, display_name, description, sales_price, labor_hours, catalog, purchase_price, avg_install_cost')
      .eq('is_active', true)
      .or(`item_number.ilike.%${q}%,display_name.ilike.%${q}%,description.ilike.%${q}%`)
      .limit(10);
    setPartResults((data as Part[]) || []);
    setPartSearching(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchParts(partSearch), 300);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [partSearch]);

  // ── Match a custom line to a real NetSuite item ──
  const searchLineMatch = useCallback(async (q: string) => {
    if (q.length < 2) { setLineMatchResults([]); return; }
    const { data } = await supabase
      .from('netsuite_parts')
      .select('id, netsuite_id, item_number, display_name, description, sales_price, labor_hours, catalog, purchase_price, avg_install_cost')
      .eq('is_active', true)
      .or(`item_number.ilike.%${q}%,display_name.ilike.%${q}%,description.ilike.%${q}%`)
      .limit(10);
    setLineMatchResults((data as Part[]) || []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, []);

  useEffect(() => {
    if (!matchingLineKey) return;
    const t = setTimeout(() => searchLineMatch(lineMatchQuery), 300);
    return () => clearTimeout(t);
  }, [lineMatchQuery, matchingLineKey, searchLineMatch]);

  // Resolve a custom line to a picked catalog part — keeps whatever qty/price
  // the rep already typed, fills in the real NetSuite item id + description.
  const matchLineToPart = (key: string, part: Part) => {
    setLines(prev => prev.map(l => l.key === key ? {
      ...l,
      part_id: part.id || null,
      netsuite_item_id: part.netsuite_id,
      item_number: part.item_number,
      description: l.description || part.display_name || part.description,
      catalog: part.catalog,
      purchase_price: part.purchase_price,
      avg_install_cost: part.avg_install_cost,
    } : l));
    setMatchingLineKey(null);
    setLineMatchQuery('');
    setLineMatchResults([]);
  };

  // A part just created in NetSuite (CreateNetsuiteItemModal) as a builder
  // Part. When the local catalog mirror failed, `id` is NetSuite's internal
  // id rather than a netsuite_parts uuid — it must not become part_id (the
  // FK would reject the save), so blank it; netsuite_item_id alone still
  // carries the line onto the pushed Estimate.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const partFromCreated = (created: CreatedPart): Part => ({
    id: UUID_RE.test(created.id) ? created.id : '',
    netsuite_id: created.netsuite_id || '',
    item_number: created.item_number,
    display_name: created.display_name || created.item_number,
    description: created.display_name || created.item_number,
    sales_price: created.sales_price || 0,
    labor_hours: 0,
    catalog: created.catalog || 'upfit',
    purchase_price: null,
    avg_install_cost: null,
  });

  // ── Add part as line item ──
  const addPartLine = (part: Part) => {
    const line: LineItem = {
      key: genKey(),
      part_id: part.id || null,
      netsuite_item_id: part.netsuite_id,
      item_number: part.item_number,
      description: part.display_name || part.description || part.item_number,
      quantity: 1,
      unit_price: part.sales_price || 0,
      labor_hours: part.labor_hours || 0,
      is_custom: false,
      catalog: part.catalog,
      purchase_price: part.purchase_price,
      avg_install_cost: part.avg_install_cost,
    };
    setLines(prev => [...prev, line]);
    setPartSearch('');
    setPartResults([]);
    partSearchRef.current?.focus();
  };

  // ── Packages (N4-B): explode a kit template into ordinary lines ──
  // Each member arrives as a normal item line, so inventory downstream is
  // untouched machinery: members commit on SO conversion and decrement on
  // invoice, exactly like hand-picked parts. The package itself never
  // reaches NetSuite.
  const addKitLines = (kit: KitWithMembers) => {
    const memberLines = kit.members.map(m => ({
      key: genKey(),
      part_id: m.part.id,
      netsuite_item_id: m.part.netsuite_id,
      item_number: m.part.item_number,
      description: m.part.display_name || m.part.marketing_description || m.part.description || m.part.item_number,
      quantity: m.quantity,
      unit_price: m.part.sales_price || 0,
      labor_hours: m.part.labor_hours || 0,
      is_custom: false,
      catalog: m.part.catalog || undefined,
      purchase_price: m.part.purchase_price,
      avg_install_cost: m.part.avg_install_cost,
    }));
    // Package-level assembly overhead rides as its own visible, editable
    // zero-price line — labor beyond what the member parts carry.
    const adderLine = kit.labor_adder_hours > 0 ? [{
      key: genKey(),
      part_id: null,
      netsuite_item_id: null,
      item_number: '',
      description: `${kit.name} — assembly labor`,
      quantity: 1,
      unit_price: 0,
      labor_hours: kit.labor_adder_hours,
      is_custom: true,
    }] : [];
    setLines(prev => [...prev, ...memberLines, ...adderLine]);
  };

  // Reverse direction: this estimate's catalog lines become a reusable
  // template. Quantities merge per part; custom lines can't travel.
  const saveLinesAsPackage = async () => {
    const eligible = lines.filter(l => l.part_id && !l.is_custom);
    if (eligible.length === 0) return;
    const name = await dialog.prompt(
      `Save ${eligible.length} catalog line${eligible.length !== 1 ? 's' : ''} as a reusable package?`,
      '',
      { placeholder: 'e.g. Contractor Package — Transit 148', confirmLabel: 'Save package' },
    );
    if (!name?.trim()) return;
    const vehicleLabel = await dialog.prompt(
      'Vehicle (optional — shown on the package card):',
      '',
      { placeholder: 'e.g. Transit 148 MR — blank to skip', confirmLabel: 'Next' },
    );
    if (vehicleLabel === null) return; // cancelled
    const adderRaw = await dialog.prompt(
      'Extra assembly labor hours for the package as a whole (beyond the lines’ own labor)?',
      '0',
      { confirmLabel: 'Save package' },
    );
    if (adderRaw === null) return; // cancelled
    const laborAdder = Math.max(0, parseFloat(adderRaw) || 0);

    const byPart = new Map<string, number>();
    for (const l of eligible) byPart.set(l.part_id!, (byPart.get(l.part_id!) || 0) + (l.quantity || 1));

    const { data: kit, error } = await supabase
      .from('part_kits')
      .insert({
        name: name.trim(),
        vehicle_label: vehicleLabel.trim() || null,
        labor_adder_hours: laborAdder,
        created_by: user?.id || null,
      })
      .select('id')
      .single();
    if (error || !kit) { await dialog.alert(`Package save failed: ${error?.message || 'unknown error'}`); return; }
    const items = [...byPart.entries()].map(([partId, qty], idx) => ({ kit_id: kit.id, part_id: partId, quantity: qty, sort_order: idx }));
    const { error: itemsErr } = await supabase.from('part_kit_items').insert(items);
    if (itemsErr) { await dialog.alert(`Package save failed: ${itemsErr.message}`); return; }

    const skipped = lines.length - eligible.length;
    await dialog.alert(
      `Package "${name.trim()}" saved with ${items.length} part${items.length !== 1 ? 's' : ''}.` +
      (skipped > 0 ? ` ${skipped} custom line${skipped !== 1 ? 's' : ''} skipped (no catalog part).` : '') +
      ' Find it under Browse Catalog → Packages.',
    );
  };

  // ── Add custom line ──
  const addCustomLine = () => {
    const line: LineItem = {
      key: genKey(),
      part_id: null,
      netsuite_item_id: null,
      item_number: '',
      description: '',
      quantity: 1,
      unit_price: 0,
      labor_hours: 0,
      is_custom: true,
    };
    setLines(prev => [...prev, line]);
  };

  const updateLine = (key: string, field: keyof LineItem, value: any) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  };

  const removeLine = (key: string) => {
    setLines(prev => prev.filter(l => l.key !== key));
  };

  // NetSuite estimate lines require a real item id (no free-text line type),
  // but lines without one still push: the API lands them on the FS-CUSTOM
  // placeholder item with description/qty/price intact (same as convert-to-
  // so). This list only feeds the pre-push heads-up — it no longer disables
  // the button, which silently locked out pushing any estimate carrying a
  // custom line or a package's assembly-labor line.
  const unmatchedLines = lines.filter(l => !l.netsuite_item_id);

  // ── Computed totals ──
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const autoLaborHours = lines.reduce((s, l) => s + (l.labor_hours * l.quantity), 0);
  const effectiveLaborHours = laborOverride !== null ? laborOverride : autoLaborHours;
  const laborTotal = effectiveLaborHours * laborRate;
  const taxableAmount = subtotal; // Tax on parts/materials only, not labor
  const taxAmount = taxExempt ? 0 : taxableAmount * taxRate;
  // Compare at the precision the rate is displayed and stored at — a float
  // round-trip through the database is not a "different rate".
  const atCompanyRate = Math.abs(rateToPct(taxRate) - rateToPct(companyTaxRate)) < 0.005;
  const grandTotal = subtotal + laborTotal + taxAmount;

  // ── Margin (internal only — never on the customer-facing quote) ──
  // True cost per line = NetSuite part cost + avg installer cost. Lines with
  // neither (custom lines, parts NetSuite has no cost for) are excluded and
  // counted so the strip says what it's missing instead of lying.
  const lineTrueCost = (l: LineItem) => (l.purchase_price ?? 0) + (l.avg_install_cost ?? 0);
  const lineHasCost = (l: LineItem) => l.purchase_price != null || l.avg_install_cost != null;
  const lineMarginPct = (l: LineItem): number | null =>
    lineHasCost(l) && l.unit_price > 0 ? ((l.unit_price - lineTrueCost(l)) / l.unit_price) * 100 : null;
  const costedLines = lines.filter(lineHasCost);
  const trueCostTotal = costedLines.reduce((s, l) => s + l.quantity * lineTrueCost(l), 0);
  const costedRevenue = costedLines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const marginDollars = costedRevenue - trueCostTotal;
  const marginPct = costedRevenue > 0 ? (marginDollars / costedRevenue) * 100 : null;
  const uncostedCount = lines.length - costedLines.length;
  const marginColor = (pct: number) => pct < 0 ? '#ef4444' : pct < marginFloor ? '#fbbf24' : '#22c55e';

  // ── Save estimate ──
  // opts.offerRevision: on the revision lock (non-admin, accepted estimate),
  // offer "duplicate as revision" and land the edits there. Opt-in because
  // it switches editingId mid-save: only safe from flows that end at the
  // save (the Save button, Duplicate's pre-save) — pushToNetSuite/PDF/email/
  // send-for-approval save first and then act on editingId, so a silent jump
  // would point them at the wrong estimate.
  const saveEstimate = async (status: string = 'draft', opts?: { offerRevision?: boolean }) => {
    setSaving(true);
    try {
      const body = {
        id: editingId || undefined,
        customer_id: customerId,
        customer_name: customerName,
        customer_netsuite_id: customerNsId,
        title, notes, status,
        tax_rate: taxRate,
        tax_exempt: taxExempt,
        labor_rate: laborRate,
        labor_hours_override: laborOverride,
        install_instructions: installInstructions,
        on_site_contact_name: onSiteContactName,
        on_site_contact_phone: onSiteContactPhone,
        delivery_preferences: deliveryPreferences,
        internal_notes: internalNotes,
        vin,
        unit_number: unitNumber,
        po_number: poNumber,
        expiration_date: expirationDate || null,
        fleet_checkin_id: fleetCheckinId,
        vehicle_platform_id: vehiclePlatformId,
        vehicle_other: vehiclePlatformId ? null : vehicleOther,
        vehicle_year: vehicleYear,
        vehicle_wheelbase: vehicleWheelbase,
        vehicle_roof: vehicleRoof,
        vehicle_cab: vehicleCab,
        vehicle_bed: vehicleBed,
        line_items: lines.map(l => ({
          part_id: l.part_id,
          netsuite_item_id: l.netsuite_item_id,
          item_number: l.item_number,
          description: l.description,
          quantity: l.quantity,
          unit_price: l.unit_price,
          labor_hours: l.labor_hours,
          is_custom: l.is_custom,
          notes: l.notes || null,
          wrap_quote_id: l.wrap_quote_id || null,
        })),
        created_by: user?.id,
      };

      let res = await fetch('/api/estimates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      let data = await res.json();

      // Revision lock: the customer signed this document, so its contents are
      // frozen. An admin can still save with a recorded reason — ask for it
      // and retry once. Anyone else gets the plain refusal below.
      if (res.status === 409 && data.step === 'accepted_locked' && data.canOverride) {
        const reason = await dialog.prompt(
          'This estimate was accepted by the customer, so its contents are locked. Saving anyway is recorded in the audit log. Why are you changing it?',
          '',
          { placeholder: 'e.g. customer approved the added part by phone', confirmLabel: 'Save anyway' },
        );
        if (!reason?.trim()) { setSaving(false); return undefined; }
        res = await fetch('/api/estimates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, overrideReason: reason.trim() }),
        });
        data = await res.json();
      }

      // Same lock, non-admin: no override, but the escape hatch the lock
      // message points at is one click — duplicate as a revision and land
      // the on-screen edits on the fresh draft (R3-17).
      let revisionJumped = false;
      let revisionNotes: string | null = null;
      if (res.status === 409 && data.step === 'accepted_locked' && !data.canOverride && opts?.offerRevision && editingId) {
        const wantsRevision = await dialog.confirm(
          'This estimate was accepted by the customer, so its contents are locked. Duplicate it as a new revision draft with your changes? The signed original stays untouched.',
          { confirmLabel: 'Duplicate as Revision' },
        );
        if (!wantsRevision) { setSaving(false); return undefined; }
        const dupRes = await fetch(`/api/estimates/${editingId}/duplicate`, { method: 'POST' });
        const dup = await dupRes.json().catch(() => ({}));
        if (!dupRes.ok || !dup.success) {
          await dialog.alert('Could not create the revision: ' + (dup.error || 'Unknown error'));
          setSaving(false);
          return undefined;
        }
        // Re-save the builder's current state onto the revision, keeping
        // the provenance line the server stamped into its internal notes.
        revisionNotes = [dup.provenance_note, internalNotes].filter(Boolean).join('\n');
        res = await fetch('/api/estimates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, id: dup.id, status: 'draft', internal_notes: revisionNotes }),
        });
        data = await res.json();
        revisionJumped = data.success === true;
      }

      if (data.success) {
        // Both API paths return the row id; on a revision jump it's the NEW
        // id, and everything below must follow it, not editingId.
        const savedId = (data.id || editingId) as string;
        // The just-saved state is the new baseline — retire the local backup
        // ('new' on a first save, which then re-keys under the real id).
        clearEstimateDraft(editingId);
        if (savedId !== editingId) clearEstimateDraft(savedId);
        setDraftSession(s => s + 1);
        if (!editingId || revisionJumped) setEditingId(savedId);
        // On a revision jump the saved notes carry the provenance line —
        // mirror it into the builder so the next Save doesn't strip it.
        const savedNotes = revisionJumped && revisionNotes !== null ? revisionNotes : internalNotes;
        if (revisionJumped && revisionNotes !== null) setInternalNotes(revisionNotes);
        // The revision starts with no attached graphics jobs — refresh the
        // panel so it doesn't keep showing the original's links.
        if (revisionJumped) loadLinkedGraphicsJobs(savedId);
        // Notify teammates newly @mentioned in the internal notes this save.
        if (savedNotes !== savedInternalNotesRef.current) {
          reportMentions({
            text: savedNotes,
            previousText: savedInternalNotesRef.current,
            sourceType: 'estimate_note',
            sourceId: savedId,
            contextLabel: `Estimate — ${title || customerName || 'untitled'}`,
            contextUrl: deepLinks.estimate(savedId, { flashNotes: true }),
          });
          savedInternalNotesRef.current = savedNotes;
        }
        await loadEstimates(true);
        setSaving(false);
        return savedId;
      } else {
        await dialog.alert('Save failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      await dialog.alert('Network error — please try again');
    }
    setSaving(false);
    return null;
  };

  // ── Quick graphics entry (no estimator) ──
  // Field request: adding graphics to an estimate shouldn't force the wrap
  // estimator's measuring canvas — sometimes the rep already knows the
  // square footage and film. This types those in directly and lands them
  // as ordinary custom lines (push handles them via FS-CUSTOM).
  const [quickGfxOpen, setQuickGfxOpen] = useState(false);
  const [substrates, setSubstrates] = useState<{ id: string; name: string; price_per_sqft: number }[] | null>(null);
  const [qgFilmName, setQgFilmName] = useState('');
  const [qgRate, setQgRate] = useState('');
  const [qgSqft, setQgSqft] = useState('');
  const [qgLabor, setQgLabor] = useState('');

  const openQuickGraphics = async () => {
    setQuickGfxOpen(v => !v);
    if (substrates === null) {
      const { data } = await supabase
        .from('wrap_substrates')
        .select('id, name, price_per_sqft')
        .order('name');
      setSubstrates((data || []) as any);
    }
  };

  const addQuickGraphicsLines = () => {
    const sqft = parseFloat(qgSqft) || 0;
    const rate = parseFloat(qgRate) || 0;
    const labor = parseFloat(qgLabor) || 0;
    const film = qgFilmName.trim() || 'Vinyl';
    if (sqft <= 0 && labor <= 0) return;
    const newLines: LineItem[] = [];
    if (sqft > 0) {
      newLines.push({
        key: genKey(),
        part_id: null,
        netsuite_item_id: null,
        item_number: '',
        description: `${film} — ${sqft} sqft @ $${rate.toFixed(2)}/sqft`,
        quantity: sqft,
        unit_price: rate,
        labor_hours: 0,
        is_custom: true,
        // Trips the graphics-job panel immediately; after reload the
        // machine-made description keeps isGraphicsLine true.
        catalog: 'graphics',
      });
    }
    if (labor > 0) {
      newLines.push({
        key: genKey(),
        part_id: null,
        netsuite_item_id: null,
        item_number: '',
        description: `Graphics install labor${film !== 'Vinyl' ? ` — ${film}` : ''}`,
        quantity: 1,
        unit_price: labor,
        labor_hours: 0,
        is_custom: true,
        catalog: 'graphics',
      });
    }
    setLines(prev => [...prev, ...newLines]);
    setQgSqft('');
    setQgLabor('');
    setQuickGfxOpen(false);
  };

  // ── Add Graphics (wrap-quote round trip) ──
  // Saves first — the builder holds unsaved work in the browser, and the
  // wrap screen is a navigation away — then hands off to the wrap-quote
  // builder, which returns here via /estimates?id= with the graphics lines
  // already written by /api/estimates/[id]/add-wrap-quote.
  const addGraphics = async () => {
    // Preserve the record's current status — the bare saveEstimate() default
    // is 'draft', which silently demoted a pushed estimate (dropping it from
    // the sales-performance report) every time someone added graphics.
    const currentStatus = estimates.find(e => e.id === editingId)?.status || 'draft';
    const id = await saveEstimate(currentStatus);
    if (id) router.push(`/admin/wrap-quote?forEstimate=${id}`);
  };

  // ── Push to NetSuite (initial push or sync update) ──
  const pushToNetSuite = async (isSync: boolean = false) => {
    if (!editingId) {
      await dialog.alert('Please save the estimate first');
      return;
    }
    if (!customerNsId) {
      await dialog.alert('Please select a customer with a NetSuite ID');
      return;
    }
    if (lines.length === 0) {
      await dialog.alert('Please add at least one line item');
      return;
    }
    // Unmatched lines don't block the push — the API routes them through the
    // FS-CUSTOM placeholder item — but say so up front, so FS-CUSTOM lines
    // on the NetSuite copy never come as a surprise.
    const unmatchedNote = unmatchedLines.length > 0
      ? `\n\n${unmatchedLines.length} line${unmatchedLines.length !== 1 ? 's have' : ' has'} no NetSuite item match (`
        + unmatchedLines.map(l => l.item_number || l.description || 'untitled line').join(', ')
        + ') — pushed as the FS-CUSTOM placeholder item with description, quantity, and price kept. Use "Match NetSuite item" under a line first if it should be a real catalog item.'
      : '';
    const confirmMsg = (isSync
      ? 'Sync changes to NetSuite? This will update the existing Estimate in NetSuite.'
      : 'Push this estimate to NetSuite? This will create an Estimate record in NetSuite.')
      + unmatchedNote;
    if (!(await dialog.confirm(confirmMsg))) return;

    // Save first to ensure latest data
    await saveEstimate(isSync ? 'pushed' : 'draft');

    if (isSync) {
      setSyncing(true);
    } else {
      setPushing(true);
    }

    try {
      const res = await fetch('/api/estimates/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateId: editingId, userId: user?.id }),
      });
      const data = await res.json();
      if (data.success) {
        let msg = data.updated
          ? 'Estimate synced to NetSuite!'
          : `Estimate pushed to NetSuite!\nEstimate #: ${data.netsuite_estimate_number || data.netsuite_estimate_id}`;
        if (data.customLines?.length) {
          msg += `\n\nPushed via FS-CUSTOM placeholder (no catalog match): ${data.customLines.join(', ')}`;
        }
        if (data.unmappedItems?.length) {
          msg += `\n\n⚠ Could NOT push (FS-CUSTOM item missing in NetSuite): ${data.unmappedItems.join(', ')}`;
        }
        // Labor is a whole line the NetSuite copy either has or doesn't.
        // It used to be dropped silently when no labor item resolved, so
        // NetSuite estimates went out short by the labor amount with the
        // push reporting success — say which it was, every time.
        if (data.laborSkipped) {
          msg += `\n\n⚠ Labor was NOT sent — no labor item is set up in NetSuite, so the NetSuite copy is short ${data.laborHours} hrs`
            + `${data.laborAmount ? ` ($${Number(data.laborAmount).toFixed(2)})` : ''}.`
            + ` Set Settings → NetSuite Labor Item, then Sync again.`;
        } else if (data.laborItem) {
          msg += `\n\nLabor billed to NetSuite item "${data.laborItem}".`;
        }
        await dialog.alert(msg);
        // Stay in the estimate — the NetSuite banner re-derives from the
        // refreshed list, and bouncing to the list view lost the user's place.
        await loadEstimates(true);
      } else {
        await dialog.alert((isSync ? 'Sync' : 'Push') + ' failed: ' + (data.error || 'Unknown error'));
      }
    } catch {
      await dialog.alert('Network error — please try again');
    }
    setPushing(false);
    setSyncing(false);
  };

  // ── Open the NetSuite estimate PDF in a new tab ──
  const viewEstimatePdf = async () => {
    const nsId = estimates.find(e => e.id === editingId)?.netsuite_estimate_id;
    if (!nsId) return;
    setViewingPdf(true);
    const { ok, error } = await openNetSuitePdf('estimate', nsId);
    if (!ok) await dialog.alert(`Could not open the NetSuite PDF: ${error}`);
    setViewingPdf(false);
  };

  // ── FleetSuite enhanced-estimate PDF: view / print in a new tab ──
  // The endpoint renders the same customer-facing copy as the approval email
  // (photos + product links) as a real PDF. The tab must open inside the
  // click gesture (popup blockers), so open it blank, save so the PDF
  // matches the screen, then point it at the endpoint.
  const openFleetsuitePdf = (print = false) => {
    if (!editingId) return;
    const w = window.open('', '_blank');
    const currentStatus = estimates.find(e => e.id === editingId)?.status || 'draft';
    saveEstimate(currentStatus).then(() => {
      const url = `/api/estimates/${editingId}/pdf${print ? '?print=1' : ''}`;
      if (w) w.location.href = url;
      else window.open(url, '_blank');
    });
  };

  // ── Email the enhanced-estimate PDF (standard compose screen) ──
  const openPdfEmailModal = async () => {
    if (!editingId) return;
    // Persist current edits so the attached PDF matches what's on screen.
    const currentStatus = estimates.find(e => e.id === editingId)?.status || 'draft';
    await saveEstimate(currentStatus);
    setPdfEmailModal(true);
  };

  const fetchPdfEmailPreview = async (fields: EmailComposeFields) => {
    if (!editingId) return { error: 'No estimate open' };
    try {
      const res = await fetch(`/api/estimates/${editingId}/email-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preview: true,
          emails: fields.emails,
          message: fields.message || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data.preview) return { preview: { to: data.to ?? null, subject: data.subject, html: data.html } };
      return { error: data.error || 'Unknown error' };
    } catch {
      return { error: 'Network error — please try again.' };
    }
  };

  const confirmSendPdfEmail = async (fields: EmailComposeFields): Promise<{ ok: boolean }> => {
    if (!editingId) return { ok: false };
    try {
      const res = await fetch(`/api/estimates/${editingId}/email-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emails: fields.emails,
          bccSelf: fields.bccSelf,
          message: fields.message || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert('Send failed: ' + (data.error || 'Unknown error'));
        return { ok: false };
      }
      const em = data.dispatch?.email;
      await dialog.alert(`Estimate PDF sent to ${em?.target || 'recipient'}${em?.bcc ? ` (bcc ${em.bcc})` : ''}.`);
      return { ok: true };
    } catch {
      await dialog.alert('Network error — please try again.');
      return { ok: false };
    }
  };

  // ── Follow-up actions on sent estimates ──
  // Quiet days since the customer last heard from us — same clock as the
  // follow-up queue: max(sent date, last logged follow-up).
  const quietDays = (est: Estimate): number | null => {
    const ref = [est.sent_for_approval_at, est.last_followup_at]
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
          type: 'estimate', id: followupNoteFor.id, action: 'log_followup',
          note: fuNote.trim() || undefined, remindAt: fuRemindAt || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert('Failed to log follow-up: ' + (data.error || 'Unknown error'));
      } else {
        const nowIso = new Date().toISOString();
        setEstimates(prev => prev.map(e => e.id === followupNoteFor.id ? { ...e, last_followup_at: nowIso } : e));
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
    if (!followupEmailFor) return { error: 'No estimate selected' };
    try {
      const res = await fetch('/api/quotes/follow-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'estimate', id: followupEmailFor.id, preview: true,
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
          type: 'estimate', id: followupEmailFor.id,
          emails: fields.emails, bccSelf: fields.bccSelf, message: fields.message || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert('Send failed: ' + (data.error || 'Unknown error'));
        return { ok: false };
      }
      const nowIso = new Date().toISOString();
      setEstimates(prev => prev.map(e => e.id === followupEmailFor.id ? { ...e, last_followup_at: nowIso } : e));
      const em = data.dispatch?.email;
      await dialog.alert(`Follow-up email sent to ${em?.target || 'recipient'}${em?.bcc ? ` (bcc ${em.bcc})` : ''}. The follow-up was logged.`);
      return { ok: true };
    } catch {
      await dialog.alert('Network error — please try again.');
      return { ok: false };
    }
  };

  // ── Send the estimate to the customer for approval (magic link) ──
  // Compose + preview flow (E4): open the modal, persist edits so the preview
  // matches, then render the exact email before the staffer commits to send.

  // The compose picker's selection as the API expects it — the FULL desired
  // state across linked jobs (a job with nothing checked contributes
  // nothing, and the send clears its stored selection).
  const approvalProofSelectionPayload = () =>
    Object.entries(approvalProofSelections)
      .map(([jobId, fileIds]) => ({ jobId, fileIds }))
      .filter(s => s.fileIds.length > 0);

  const fetchApprovalPreview = async (fields: EmailComposeFields) => {
    if (!editingId) return { error: 'No estimate open' };
    try {
      const res = await fetch(`/api/estimates/${editingId}/send-for-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preview: true,
          emails: fields.emails,
          message: fields.message || undefined,
          proofSelections: approvalProofSelectionPayload(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.preview) {
        // Linked wrap quotes → the send auto-attaches the merged estimate
        // PDF; the server names it so the compose screen can say so.
        setApprovalPdfName((Array.isArray(data.attachments) && data.attachments[0]) || null);
        return { preview: { to: data.to ?? null, subject: data.subject, html: data.html } };
      }
      return { error: data.error || 'Unknown error' };
    } catch {
      return { error: 'Network error — please try again.' };
    }
  };

  const openApprovalModal = async () => {
    if (!editingId || sendingForApproval) return;
    if (!customerName.trim()) { await dialog.alert('Pick a customer first.'); return; }
    // Persist current edits so the preview and the sent email match. Keep the
    // estimate's current status — the send itself flips draft → sent
    // server-side, so opening a preview never marks anything sent.
    setSendingForApproval(true);
    const currentStatus = estimates.find(e => e.id === editingId)?.status || 'draft';
    await saveEstimate(currentStatus);

    // Proof picker: the linked graphics jobs' files, with defaults per job —
    // the stored selection, else the file a proof-only send already showed
    // the customer, else the newest upload (the artist's usual last step).
    const files: Record<string, JobProofFile[]> = {};
    const selections: Record<string, string[]> = {};
    if (linkedGraphicsJobs.length > 0) {
      const { data: fileRows } = await supabase
        .from('graphics_job_files')
        .select('id, job_id, file_name, file_type, file_size, uploaded_at')
        .in('job_id', linkedGraphicsJobs.map(j => j.id))
        .order('uploaded_at', { ascending: false });
      for (const j of linkedGraphicsJobs) {
        const jobFiles = ((fileRows || []) as (JobProofFile & { uploaded_at: string })[]).filter(f => f.job_id === j.id);
        if (jobFiles.length === 0) continue;
        files[j.id] = jobFiles;
        const stored = (j.estimate_attach?.file_ids || []).filter(id => jobFiles.some(f => f.id === id));
        const fallback = j.approval_proof_file_id && jobFiles.some(f => f.id === j.approval_proof_file_id)
          ? [j.approval_proof_file_id]
          : [jobFiles[0].id];
        selections[j.id] = stored.length > 0 ? stored : fallback;
      }
    }
    setApprovalProofFiles(files);
    setApprovalProofSelections(selections);

    setSendingForApproval(false);
    setApprovalPdfName(null);
    setApprovalModal(true);
  };

  const confirmSendApproval = async (fields: EmailComposeFields): Promise<{ ok: boolean }> => {
    if (!editingId) return { ok: false };
    let data: any;
    try {
      const res = await fetch(`/api/estimates/${editingId}/send-for-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emails: fields.emails,
          bccSelf: fields.bccSelf,
          message: fields.message || undefined,
          proofSelections: approvalProofSelectionPayload(),
        }),
      });
      data = await res.json();
      if (!res.ok) {
        await dialog.alert('Send failed: ' + (data.error || 'Unknown error'));
        return { ok: false };
      }
    } catch {
      await dialog.alert('Network error — please try again.');
      return { ok: false };
    }
    const emailInfo = data.dispatch?.email
      ? (data.dispatch.email.ok
          ? `Email sent to ${data.dispatch.email.target}${data.dispatch.email.bcc ? ` (bcc ${data.dispatch.email.bcc})` : ''}`
          : `Email failed: ${data.dispatch.email.error || 'unknown'}`)
      : null;
    const smsInfo = data.dispatch?.sms
      ? (data.dispatch.sms.skipped
          ? `SMS skipped (provider disabled) — link still works via email`
          : data.dispatch.sms.ok
            ? `SMS sent to ${data.dispatch.sms.target}`
            : `SMS failed: ${data.dispatch.sms.error || 'unknown'}`)
      : null;
    await dialog.alert(`Approval link sent.\n\n${[emailInfo, smsInfo].filter(Boolean).join('\n') || 'Delivery is on its way to the customer.'}`);
    loadEstimates(true);
    // The send persisted the proof selection onto the linked jobs
    // (estimate_attach) — refresh so the panel reflects it.
    if (editingId) loadLinkedGraphicsJobs(editingId);
    return { ok: true };
  };

  const convertToSalesOrder = async () => {
    if (!editingId) return;
    const est = estimates.find(e => e.id === editingId);
    if (est?.netsuite_so_id) {
      await dialog.alert(`This estimate already has a Sales Order: SO #${est.netsuite_so_number || est.netsuite_so_id}`);
      return;
    }

    // Conversion is gated server-side on customer approval. Admins can
    // override for phone/email/PO approvals — the reason lands in the
    // audit log with their name on it.
    let overrideReason: string | undefined;
    if (!(est as any)?.customer_approved) {
      if (!isAdmin) {
        await dialog.alert('This estimate has not been accepted by the customer yet. Send it for approval first, or ask an admin to override.');
        return;
      }
      const reason = await dialog.prompt(
        'The customer has not accepted this estimate in the app. How was it approved? (recorded in the audit log)',
        '',
        { title: 'Convert without in-app approval', confirmLabel: 'Convert' },
      );
      if (reason === null) return;
      if (reason.trim().length < 3) {
        await dialog.alert('An override reason is required (e.g. "approved by phone, spoke to Dana 8/6").');
        return;
      }
      overrideReason = reason.trim();
    } else if (!(await dialog.confirm('Create a Sales Order in NetSuite from this estimate?'))) {
      return;
    }

    setConvertingToSO(true);
    try {
      let res = await fetch('/api/estimates/convert-to-so', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateId: editingId, ...(overrideReason ? { overrideReason } : {}) }),
      });
      let data = await res.json();
      // Graphics gate: the server refuses when graphics lines have no linked
      // graphics job. "Convert anyway" is a conscious choice, not a default.
      if (res.status === 409 && data.step === 'graphics_job_missing' && data.canSkip) {
        const anyway = await dialog.confirm(`${data.error}`, { confirmLabel: 'Convert anyway', destructive: true });
        if (!anyway) { setConvertingToSO(false); return; }
        res = await fetch('/api/estimates/convert-to-so', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ estimateId: editingId, skipGraphicsCheck: true, ...(overrideReason ? { overrideReason } : {}) }),
        });
        data = await res.json();
      }
      if (res.ok && data.status === 'created') {
        // NOTE: the API's dropped-lines key is `unmappedLines` — this dialog
        // read `skippedItems` (a key the API never sent), so dropped custom
        // lines were never surfaced to the person clicking Convert.
        const warnings = [
          data.unmappedLines?.length ? `⚠ Dropped (create FS-CUSTOM in NetSuite): ${data.unmappedLines.join(', ')}` : '',
          data.laborSkipped
            ? `⚠ Labor was NOT pushed — no labor item is set up in NetSuite, so the SO is short ${data.laborHours ?? ''} hrs`
              + `${data.laborAmount ? ` ($${Number(data.laborAmount).toFixed(2)})` : ''}.`
              + ' Set Settings → NetSuite Labor Item and add the line in NetSuite.'
            : (data.laborItem ? `Labor billed to NetSuite item "${data.laborItem}".` : ''),
          data.upfitProject?.created ? 'Upfit project created — parts readiness is on the Upfit tab.' : '',
        ].filter(Boolean).join('\n');
        await dialog.alert(`Sales Order created!\nSO #: ${data.salesOrderNumber || data.salesOrderId}\nLine items: ${data.lineItemCount}${warnings ? '\n\n' + warnings : ''}`);
        // Stay in the estimate so the new SO number is visible in context.
        await loadEstimates(true);
      } else if (data.status === 'already_created') {
        await dialog.alert(data.message);
      } else if (data.status === 'created_unlinked') {
        // The SO is REAL in NetSuite, we just couldn't record it. Offer the
        // repair right here with the number prefilled — telling someone to
        // "link it by hand" and then giving them no way to do it is how
        // SO1064 sat orphaned.
        const fix = await dialog.confirm(
          `${data.error}\n\nLink SO #${data.salesOrderNumber || data.salesOrderId} to this estimate now?`,
          { confirmLabel: 'Link it now' },
        );
        setConvertingToSO(false);
        if (fix) await linkExistingSalesOrder(data.salesOrderNumber || '');
        return;
      } else {
        await dialog.alert('Failed: ' + (data.error || 'Unknown error'));
      }
    } catch {
      await dialog.alert('Network error — please try again');
    }
    setConvertingToSO(false);
  };

  // Attach an SO that already exists in NetSuite. Recovery for a conversion
  // that created the order but couldn't write it back, and the only way to
  // clear an estimate that is otherwise one click from a duplicate SO.
  const linkExistingSalesOrder = async (prefill: string = '') => {
    if (!editingId) return;
    const entered = await dialog.prompt(
      'Enter the Sales Order number exactly as NetSuite shows it (e.g. SO1064). It is verified against NetSuite before anything is saved.',
      prefill,
      { title: 'Link an existing Sales Order', confirmLabel: 'Link' },
    );
    if (entered === null || !entered.trim()) return;
    setLinkingSO(true);
    try {
      const res = await fetch(`/api/estimates/${editingId}/link-so`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salesOrderNumber: entered.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert(data.error || 'Could not link that Sales Order.');
      } else {
        await dialog.alert(data.message);
        await loadEstimates(true);
      }
    } catch {
      await dialog.alert('Network error — please try again');
    }
    setLinkingSO(false);
  };

  // ── Load customer-level operations defaults ──
  const loadCustomerDefaults = useCallback(async (cid: string | null) => {
    if (!cid) { setCustomerDefaults(null); return; }
    const { data } = await supabase
      .from('customers')
      .select('delivery_instructions, billing_contact_name, billing_contact_email, ap_email, internal_notes, tax_exempt, tax_exempt_cert_number, tax_exempt_expires_at')
      .eq('id', cid)
      .maybeSingle();
    setCustomerDefaults(data as any || null);
  }, [supabase]);

  // ── Open estimate for editing ──
  const openEstimate = async (est: Estimate) => {
    flushPendingDraft(); // don't lose the tail of whatever was open before
    setEditingId(est.id);
    setTitle(est.title || '');
    setNotes(est.notes || '');
    setCustomerId(est.customer_id);
    setCustomerName(est.customer_name || '');
    setCustomerNsId(est.customer_netsuite_id);
    setTaxRate(est.tax_rate || companyTaxRateRef.current);
    setTaxExempt(est.tax_exempt);
    setLaborRate(est.labor_rate || DEFAULT_LABOR_RATE);
    setLaborOverride(est.labor_hours_override);
    setVin(est.vin || '');
    setUnitNumber(est.unit_number || '');
    setVehiclePlatformId(est.vehicle_platform_id || null);
    setVehicleOther(est.vehicle_other || '');
    setVehicleOtherMode(!est.vehicle_platform_id && !!est.vehicle_other);
    setVehicleYear(est.vehicle_year || '');
    setVehicleWheelbase(est.vehicle_wheelbase || '');
    setVehicleRoof(est.vehicle_roof || '');
    setVehicleCab(est.vehicle_cab || '');
    setVehicleBed(est.vehicle_bed || '');
    setFleetCheckinId(est.fleet_checkin_id || null);
    setCheckinSuggestion(null);
    setCheckinPickerOpen(false);
    if (est.fleet_checkin_id) loadLinkedCheckin(est.fleet_checkin_id);
    else setLinkedCheckin(null);

    // Load install context + line items + customer defaults in parallel
    const [{ data: fullEst }, { data: lineData }] = await Promise.all([
      supabase
        .from('estimates')
        .select('install_instructions, on_site_contact_name, on_site_contact_phone, delivery_preferences, internal_notes, po_number, expiration_date')
        .eq('id', est.id)
        .maybeSingle(),
      supabase
        .from('estimate_line_items')
        .select('*')
        .eq('estimate_id', est.id)
        .order('sort_order'),
    ]);

    setInstallInstructions(fullEst?.install_instructions || '');
    setOnSiteContactName(fullEst?.on_site_contact_name || '');
    setOnSiteContactPhone(fullEst?.on_site_contact_phone || '');
    setDeliveryPreferences(fullEst?.delivery_preferences || '');
    setPoNumber(fullEst?.po_number || '');
    setExpirationDate(fullEst?.expiration_date || '');
    setInternalNotes(fullEst?.internal_notes || '');
    savedInternalNotesRef.current = fullEst?.internal_notes || '';

    // Look up catalog + cost data for any line items backed by a real part —
    // catalog drives the graphics-job prompt, costs drive the margin strip.
    const partIds = (lineData || [])
      .map((l: any) => l.part_id)
      .filter((id: string | null): id is string => !!id);
    let infoByPart: Record<string, { catalog: string; purchase_price: number | null; avg_install_cost: number | null }> = {};
    if (partIds.length > 0) {
      const { data: parts } = await supabase
        .from('netsuite_parts')
        .select('id, catalog, purchase_price, avg_install_cost')
        .in('id', partIds);
      infoByPart = Object.fromEntries((parts || []).map((p: any) => [p.id, p]));
    }

    setLines((lineData || []).map((l: any) => ({
      key: genKey(),
      part_id: l.part_id,
      netsuite_item_id: l.netsuite_item_id,
      item_number: l.item_number || '',
      description: l.description || '',
      quantity: l.quantity || 1,
      unit_price: l.unit_price || 0,
      labor_hours: l.labor_hours || 0,
      is_custom: l.is_custom || false,
      notes: l.notes || '',
      wrap_quote_id: l.wrap_quote_id || null,
      catalog: l.part_id ? infoByPart[l.part_id]?.catalog : undefined,
      purchase_price: l.part_id ? infoByPart[l.part_id]?.purchase_price ?? null : null,
      avg_install_cost: l.part_id ? infoByPart[l.part_id]?.avg_install_cost ?? null : null,
    })));

    if (est.customer_id) loadCustomerDefaults(est.customer_id);
    loadLinkedGraphicsJobs(est.id);

    // Loaded server state = the autosave baseline; then offer any local
    // backup of unsaved edits (crash / stray navigation) on top of it.
    setDraftSession(s => s + 1);
    setView('builder');
    await maybeOfferDraft(est.id, est);
  };

  // ── Checked-in vehicle linkage (fleet_checkins / In-Shop board) ──
  const loadLinkedCheckin = async (id: string) => {
    const { data } = await supabase.from('fleet_checkins').select(CHECKIN_COLS).eq('id', id).maybeSingle();
    setLinkedCheckin((data as CheckinLite) || null);
  };

  const openCheckinPicker = async () => {
    setCheckinPickerOpen(true);
    const { data } = await supabase
      .from('fleet_checkins')
      .select(CHECKIN_COLS)
      .in('status', IN_SHOP_STATUSES)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(150);
    setCheckinOptions((data as CheckinLite[]) || []);
  };

  const linkCheckin = async (c: CheckinLite) => {
    setFleetCheckinId(c.id);
    setLinkedCheckin(c);
    setCheckinPickerOpen(false);
    setCheckinSearch('');
    setCheckinSuggestion(null);
    // Prefill what the estimate doesn't have yet — never clobber typed
    // values. A full VIN triggers the decode effect, which fills
    // year/platform/qualifiers on its own.
    if (!vin.trim() && c.vin) setVin(c.vin.toUpperCase());
    else if (!vehicleYear && c.vehicle_year) setVehicleYear(c.vehicle_year);
    if (!installInstructions.trim() && c.install_instructions) setInstallInstructions(c.install_instructions);
    if (!onSiteContactName.trim() && c.on_site_contact_name) setOnSiteContactName(c.on_site_contact_name);
    if (!onSiteContactPhone.trim() && c.on_site_contact_phone) setOnSiteContactPhone(c.on_site_contact_phone);
    if (!deliveryPreferences.trim() && c.delivery_preferences) setDeliveryPreferences(c.delivery_preferences);
    // Customer: newer check-ins carry the real customers row (customer_id,
    // migration 220) — use it directly. Older ones have only a NAME: link
    // the record when exactly one matches, else leave the picker to the
    // human.
    if (!customerId) {
      if (c.customer_id) {
        const { data: cust } = await supabase
          .from('customers')
          .select('id, company_name, entity_id, netsuite_id')
          .eq('id', c.customer_id)
          .maybeSingle();
        if (cust) {
          setCustomerId(cust.id);
          setCustomerName(cust.company_name || cust.entity_id || c.customer_name || '');
          setCustomerNsId(cust.netsuite_id);
          return;
        }
      }
      if (c.customer_name?.trim()) {
        const { data: matches } = await supabase
          .from('customers')
          .select('id, company_name, entity_id, netsuite_id')
          .ilike('company_name', c.customer_name.trim())
          .limit(2);
        if (matches && matches.length === 1) {
          setCustomerId(matches[0].id);
          setCustomerName(matches[0].company_name || matches[0].entity_id || c.customer_name);
          setCustomerNsId(matches[0].netsuite_id);
        } else if (!customerName.trim()) {
          setCustomerName(c.customer_name);
        }
      }
    }
  };

  const unlinkCheckin = () => {
    setFleetCheckinId(null);
    setLinkedCheckin(null);
  };

  // When the typed VIN matches a vehicle currently on the ground and the
  // estimate isn't linked yet, offer the link instead of waiting to be asked
  // — the exact "I made an estimate for a checked-in vehicle" case.
  useEffect(() => {
    if (view !== 'builder' || fleetCheckinId || vin.trim().length < 8) { setCheckinSuggestion(null); return; }
    const filter = vinMatchOrFilter(vin);
    if (!filter) { setCheckinSuggestion(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('fleet_checkins')
        .select(CHECKIN_COLS)
        .or(filter)
        .in('status', IN_SHOP_STATUSES)
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(1);
      if (!cancelled) setCheckinSuggestion((data?.[0] as CheckinLite) || null);
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [view, vin, fleetCheckinId]);

  // Picker rows: text filter, best matches first — the estimate's VIN, then
  // its customer, then shop recency (openCheckinPicker's load order).
  const checkinMatches = useMemo(() => {
    const q = checkinSearch.trim().toLowerCase();
    return checkinOptions
      .filter(c => !q || [c.vin, c.customer_name, c.vehicle_year, c.vehicle_make, c.vehicle_model]
        .filter(Boolean).join(' ').toLowerCase().includes(q))
      .map(c => ({
        ...c,
        vinMatch: !!vin.trim() && sameVehicleVin(vin, c.vin),
        customerMatch: !!customerName.trim() && (c.customer_name || '').trim().toLowerCase() === customerName.trim().toLowerCase(),
      }))
      .sort((a, b) => (Number(b.vinMatch) * 2 + Number(b.customerMatch)) - (Number(a.vinMatch) * 2 + Number(a.customerMatch)));
  }, [checkinOptions, checkinSearch, vin, customerName]);

  // ── Graphics job linkage ──
  const loadLinkedGraphicsJobs = useCallback(async (estimateId: string) => {
    const { data } = await supabase
      .from('graphics_jobs')
      .select('id, job_number, title, status, assigned_to, estimate_attach, approval_proof_file_id')
      .eq('estimate_id', estimateId)
      .order('created_at', { ascending: true });
    setLinkedGraphicsJobs((data as LinkedGraphicsJob[]) || []);
  }, [supabase]);

  const spawnGraphicsJob = async () => {
    if (!editingId) return;
    setGraphicsLinking(true);
    try {
      const res = await fetch('/api/graphics/from-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateId: editingId, mode: 'create', userId: user?.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        await dialog.alert('Failed to spawn graphics job: ' + (data.error || 'Unknown error'));
        return;
      }
      await loadLinkedGraphicsJobs(editingId);
      const open = await dialog.confirm(`Graphics job ${data.jobNumber} created. Open it now?`);
      if (open) router.push(`/graphics?id=${data.graphicsJobId}`);
    } catch {
      await dialog.alert('Network error — please try again');
    }
    setGraphicsLinking(false);
  };

  const searchGraphicsJobs = useCallback(async (q: string) => {
    if (q.length < 2) { setGraphicsPickerResults([]); return; }
    const { data } = await supabase
      .from('graphics_jobs')
      .select('id, job_number, title, status, assigned_to, estimate_id')
      .is('estimate_id', null)
      .not('status', 'in', '("installed","cancelled")')
      .or(`job_number.ilike.%${q}%,title.ilike.%${q}%,customer.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .limit(10);
    setGraphicsPickerResults((data as LinkedGraphicsJob[]) || []);
  }, [supabase]);

  useEffect(() => {
    const t = setTimeout(() => searchGraphicsJobs(graphicsPickerSearch), 300);
    return () => clearTimeout(t);
  }, [graphicsPickerSearch, searchGraphicsJobs]);

  const linkGraphicsJob = async (jobId: string) => {
    if (!editingId) return;
    setGraphicsLinking(true);
    try {
      const res = await fetch('/api/graphics/from-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateId: editingId, mode: 'link', existingJobId: jobId, userId: user?.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        await dialog.alert('Failed to link: ' + (data.error || 'Unknown error'));
        return;
      }
      await loadLinkedGraphicsJobs(editingId);
      setShowGraphicsPicker(false);
      setGraphicsPickerSearch('');
      setGraphicsPickerResults([]);
    } catch {
      await dialog.alert('Network error — please try again');
    }
    setGraphicsLinking(false);
  };

  const resetBuilder = () => {
    setEditingId(null);
    setTitle('');
    setNotes('');
    setCustomerId(null);
    setCustomerName('');
    setCustomerNsId(null);
    setTaxRate(companyTaxRateRef.current);
    setTaxExempt(false);
    setLaborRate(DEFAULT_LABOR_RATE);
    setLaborOverride(null);
    setLines([]);
    setPartSearch('');
    setPartResults([]);
    setCustSearch('');
    setCustResults([]);
    setVin('');
    setUnitNumber('');
    setVehiclePlatformId(null);
    setVehicleOther('');
    setVehicleOtherMode(false);
    setVehicleYear('');
    setVehicleWheelbase('');
    setVehicleRoof('');
    setVehicleCab('');
    setVehicleBed('');
    setInstallInstructions('');
    setOnSiteContactName('');
    setOnSiteContactPhone('');
    setDeliveryPreferences('');
    setPoNumber('');
    setExpirationDate('');
    setFleetCheckinId(null);
    setLinkedCheckin(null);
    setCheckinSuggestion(null);
    setCheckinPickerOpen(false);
    setCheckinSearch('');
    setInternalNotes('');
    savedInternalNotesRef.current = '';
    setCustomerDefaults(null);
    setLinkedGraphicsJobs([]);
    setShowGraphicsPicker(false);
    setGraphicsPickerSearch('');
    setGraphicsPickerResults([]);
    // Blank builder = persisted reality; re-baseline the autosave.
    setDraftSession(s => s + 1);
  };

  // Load customer defaults when a customer is picked on a NEW estimate —
  // feeds the tax-exempt prefill and the "Edit defaults" editor. (This used
  // to also copy delivery_instructions into install_instructions; that field
  // left the builder with the Install Context section, 2026-08-12.)
  useEffect(() => {
    if (editingId) return;
    if (!customerId) return;
    loadCustomerDefaults(customerId);
  }, [customerId, editingId, loadCustomerDefaults]);

  // Prefill the tax-exempt flag from the customer default on a NEW estimate
  // (existing estimates keep whatever was saved on them).
  useEffect(() => {
    if (customerDefaults?.tax_exempt && !editingId) {
      setTaxExempt(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: apply once when defaults load
  }, [customerDefaults, editingId]);

  // Save customer operations defaults (inline editor)
  const saveCustomerDefaults = async (defaults: typeof customerDefaults) => {
    if (!customerId || !defaults) return;
    setSavingCustomerDefaults(true);
    const { error } = await supabase
      .from('customers')
      .update({
        delivery_instructions: defaults.delivery_instructions || null,
        billing_contact_name: defaults.billing_contact_name || null,
        billing_contact_email: defaults.billing_contact_email || null,
        ap_email: defaults.ap_email || null,
        internal_notes: defaults.internal_notes || null,
        tax_exempt: !!defaults.tax_exempt,
        tax_exempt_cert_number: defaults.tax_exempt_cert_number || null,
        tax_exempt_expires_at: defaults.tax_exempt_expires_at || null,
      })
      .eq('id', customerId);
    setSavingCustomerDefaults(false);
    if (error) {
      await dialog.alert('Failed to save customer defaults: ' + error.message);
      return;
    }
    setCustomerDefaults(defaults);
    setEditingCustomerDefaults(false);
  };

  // R3-17: copy the open estimate (header + lines) into a fresh draft and
  // switch the builder to it. The server decides plain-copy vs revision from
  // the source's lock state; on an editable source we save first so the copy
  // matches what's on screen, not the last save.
  const duplicateEstimate = async () => {
    if (!editingId || duplicating) return;
    const est = estimates.find(e => e.id === editingId);
    const locked = !!(est && ((est as any).customer_approved || est.status === 'accepted' || est.netsuite_so_id));
    if (!locked) {
      // Preserve status — a bare 'draft' save silently demotes a pushed
      // estimate (the addGraphics lesson above).
      const savedId = await saveEstimate(est?.status || 'draft', { offerRevision: true });
      if (!savedId) return; // save failed or was cancelled — don't copy stale rows
      // The save itself can jump to a fresh revision (someone accepted the
      // estimate under us) — that IS the duplicate, don't make a second one.
      if (savedId !== editingId) return;
    }
    setDuplicating(true);
    try {
      const res = await fetch(`/api/estimates/${editingId}/duplicate`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        await dialog.alert('Duplicate failed: ' + (data.error || 'Unknown error'));
        return;
      }
      // Open the copy: the single-row fetch (not the list, which may be
      // mid-refresh) then the normal open path so lines/notes load fresh.
      const rowRes = await fetch(`/api/estimates?id=${data.id}`);
      const rowData = await rowRes.json().catch(() => ({}));
      await loadEstimates(true);
      const newRow = rowData.estimates?.[0];
      if (newRow) {
        await openEstimate(newRow);
      } else {
        await dialog.alert(`Created ${data.estimate_number} — open it from the list.`);
      }
    } catch {
      await dialog.alert('Network error — please try again');
    } finally {
      setDuplicating(false);
    }
  };

  const deleteEstimate = async (id: string, hasNsId: boolean = false) => {
    const msg = hasNsId
      ? 'Delete this estimate? This will ALSO delete it from NetSuite. This cannot be undone.'
      : 'Delete this estimate? This cannot be undone.';
    if (!(await dialog.confirm(msg, { destructive: true, confirmLabel: 'Delete' }))) return;

    setDeleting(true);
    try {
      let res = await fetch('/api/estimates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      let data = await res.json();
      // Accepted/converted estimates are delete-locked like the Save path;
      // an admin can proceed with a recorded reason (audited, and the audit
      // row preserves the signed snapshot's storage key).
      if (res.status === 409 && data.step === 'accepted_locked' && data.canOverride) {
        const reason = await dialog.prompt(
          'This estimate was accepted (or already has a Sales Order) — deleting it destroys the signed record. Deleting anyway is recorded in the audit log. Why?',
          '',
          { placeholder: 'e.g. duplicate of EST-1042, customer re-signed there', confirmLabel: 'Delete anyway' },
        );
        if (!reason?.trim()) { setDeleting(false); return; }
        res = await fetch('/api/estimates', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, overrideReason: reason.trim() }),
        });
        data = await res.json();
      }
      if (!data.success && data.error) {
        await dialog.alert('Delete failed: ' + data.error);
      } else {
        clearEstimateDraft(id);
      }
    } catch {
      await dialog.alert('Network error — please try again');
    }
    setDeleting(false);
    await loadEstimates();
  };

  const fmt = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-body)', fontSize: '12px',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: 'var(--text-label)',
    textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: theme.orange, borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: 'var(--text-label)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading estimates...</div>
      </div>
    );
  }

  // ═══════════ LIST VIEW ═══════════
  if (view === 'list') {
    const filteredEstimates = estimates.filter(e => {
      if (!search) return true;
      const s = search.toLowerCase();
      return (
        estimateNumberMatches(e, s) ||
        e.customer_name?.toLowerCase().includes(s) ||
        e.title?.toLowerCase().includes(s) ||
        e.vin?.toLowerCase().includes(s) ||
        e.unit_number?.toLowerCase().includes(s)
      );
    });

    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ fontSize: '22px', fontWeight: 800 }}>Estimates</div>
          <button
            onClick={() => { openNewEstimate(); }}
            style={{ padding: '8px 14px', borderRadius: '10px', background: theme.orange, color: '#fff', fontWeight: 800, fontSize: '12px', border: 'none', cursor: 'pointer', boxShadow: '0 2px 8px rgba(238,49,32,0.3)' }}
          >
            + New Estimate
          </button>
        </div>

        <input
          placeholder="Search estimates..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, marginBottom: '12px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}
        />

        {filteredEstimates.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-label)', fontSize: '13px' }}>
            {search ? 'No matching estimates.' : 'No estimates yet. Create one to get started.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {filteredEstimates.map(est => {
              const statusColor = STATUS_COLORS[est.status] || '#6b7280';
              return (
                <button
                  key={est.id}
                  onClick={() => openEstimate(est)}
                  style={{
                    width: '100%', textAlign: 'left',
                    borderRadius: '12px', overflow: 'hidden',
                    border: `1px solid var(--border)`, background: 'var(--subtle-bg)',
                    padding: '12px', cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {est.title || estimateHeadlineNumber(est)}
                        </div>
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-label)', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <span>#{estimateHeadlineNumber(est)}</span>
                        {est.customer_name && <span>{est.customer_name}</span>}
                        <span style={{ color: 'var(--text-body)', fontWeight: 700 }}>{fmt(est.grand_total)}</span>
                        <span>{new Date(est.created_at).toLocaleDateString()}</span>
                        {estimateAltNumber(est) && <span style={{ color: '#a78bfa' }} title="FleetSuite's own estimate number — NetSuite's is the one shown first">FS: {estimateAltNumber(est)}</span>}
                        {est.netsuite_so_number && <span style={{ color: '#22c55e' }}>SO: {est.netsuite_so_number}</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
                      {est.status === 'sent' && (() => {
                        const quiet = quietDays(est);
                        return (
                          <>
                            {quiet !== null && quiet >= 3 && (
                              <div title={est.last_followup_at ? `Last follow-up ${new Date(est.last_followup_at).toLocaleDateString()}` : 'No follow-up logged since sending'} style={{
                                padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap',
                                background: quiet >= 14 ? 'rgba(239,68,68,0.1)' : quiet >= 5 ? 'rgba(251,191,36,0.1)' : 'var(--subtle-bg)',
                                border: `1px solid ${quiet >= 14 ? 'rgba(239,68,68,0.3)' : quiet >= 5 ? 'rgba(251,191,36,0.3)' : 'var(--border)'}`,
                                color: quiet >= 14 ? '#ef4444' : quiet >= 5 ? '#fbbf24' : 'var(--text-muted)',
                              }}>
                                quiet {quiet}d
                              </div>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); setFollowupNoteFor(est); setFuNote(''); setFuRemindAt(''); }}
                              title="Log a follow-up (call/text/etc) with an optional note and reminder"
                              style={{
                                padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                                background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)',
                                color: '#60a5fa', cursor: 'pointer', whiteSpace: 'nowrap',
                              }}
                            >☎ Log</button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setFollowupEmailFor(est); }}
                              title="Send a follow-up email (includes the Review & Accept link while it's valid)"
                              style={{
                                padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                                background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)',
                                color: '#60a5fa', cursor: 'pointer', whiteSpace: 'nowrap',
                              }}
                            >✉ Follow Up</button>
                          </>
                        );
                      })()}
                      {['bounced', 'failed', 'complained'].includes(est.approval_email_status || '') && (
                        <div title={`The approval email did not reach the customer${est.approval_email_detail ? ` — ${est.approval_email_detail}` : ''}. Open the estimate to resend.`} style={{
                          padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                          background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)',
                          color: '#ef4444', whiteSpace: 'nowrap',
                        }}>
                          ✉ Bounced
                        </div>
                      )}
                      {est.netsuite_estimate_id && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            const { ok, error } = await openNetSuitePdf('estimate', est.netsuite_estimate_id as string);
                            if (!ok) await dialog.alert(`Could not open the NetSuite PDF: ${error}`);
                          }}
                          style={{
                            padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                            background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)',
                            color: '#a78bfa', cursor: 'pointer',
                          }}
                        >
                          PDF
                        </button>
                      )}
                      <div style={{
                        padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                        background: `${statusColor}18`, border: `1px solid ${statusColor}44`,
                        color: statusColor, whiteSpace: 'nowrap',
                      }}>
                        {STATUS_LABELS[est.status] || est.status}
                      </div>
                      {isAdmin && (
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteEstimate(est.id, !!est.netsuite_estimate_id); }}
                          disabled={deleting}
                          style={{
                            padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                            background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
                            color: '#f87171', cursor: 'pointer',
                            opacity: deleting ? 0.5 : 1,
                          }}
                        >
                          Del
                        </button>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ═══════════ BUILDER VIEW ═══════════
  const isPushed = editingId && estimates.find(e => e.id === editingId)?.netsuite_estimate_id;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <button
          onClick={() => { setView('list'); }}
          style={{ background: 'transparent', border: 'none', color: '#60a5fa', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
        >
          ← Back to Estimates
        </button>
        <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>
          {editingId ? 'Editing' : 'New Estimate'}
        </div>
      </div>

      {/* Customer Selection */}
      <div style={{ marginBottom: '12px', position: 'relative' }}>
        <div style={labelStyle}>Customer</div>
        {customerName ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              flex: 1, padding: '8px 10px', borderRadius: '8px',
              background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
              color: 'var(--text-body)', fontSize: '12px', fontWeight: 700,
            }}>
              {customerName}
              {customerNsId && <span style={{ color: 'var(--text-label)', fontWeight: 400, marginLeft: '6px' }}>NS #{customerNsId}</span>}
            </div>
            {(
              <button
                onClick={() => { setCustomerId(null); setCustomerName(''); setCustomerNsId(null); setCustSearch(''); }}
                style={{ padding: '6px 10px', borderRadius: '6px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
              >
                Change
              </button>
            )}
          </div>
        ) : (
          <div>
            <input
              placeholder="Search customers..."
              value={custSearch}
              onChange={e => { setCustSearch(e.target.value); setShowCustDropdown(true); }}
              onFocus={() => setShowCustDropdown(true)}
              style={inputStyle}
            />
            {showCustDropdown && custResults.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                maxHeight: '200px', overflowY: 'auto', marginTop: '2px',
              }}>
                {custResults.map(c => (
                  <button
                    key={c.id}
                    onClick={() => {
                      // A lead has no customers-mirror row: the estimate
                      // carries the name only until push promotes it.
                      setCustomerId(c.isLead ? null : c.id);
                      setCustomerName(c.company_name);
                      setCustomerNsId(c.isLead ? null : c.netsuite_id);
                      setCustSearch('');
                      setShowCustDropdown(false);
                    }}
                    style={{
                      width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
                      background: 'transparent', color: 'var(--text-body)', fontSize: '12px',
                      cursor: 'pointer', borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>{c.company_name}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>
                      {c.isLead ? 'Lead — not in NetSuite yet' : `${c.entity_id} · NS #${c.netsuite_id}`}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Title & Notes */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
        <div>
          <div style={labelStyle}>Estimate Title</div>
          <input
            style={inputStyle}
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Fleet Upfit — 10 Transits"
          />
        </div>
        <div>
          <div style={labelStyle}>Customer-facing Notes</div>
          <input
            style={inputStyle}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Appears on the NS SO memo"
          />
        </div>
      </div>

      {/* Order header fields — the trio NetSuite entry has that pushes from
          here used to drop. PO → the NS PO/Reference field; Delivery rides
          the NS memo; Expiration → the NS estimate's Expires date. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px', marginBottom: '12px' }}>
        <div>
          <div style={labelStyle}>Customer PO #</div>
          <input
            style={inputStyle}
            value={poNumber}
            onChange={e => setPoNumber(e.target.value)}
            maxLength={60}
            placeholder="Their PO — fills NS PO/Reference"
          />
        </div>
        <div>
          <div style={labelStyle}>Delivery Method</div>
          <input
            style={inputStyle}
            value={deliveryPreferences}
            onChange={e => setDeliveryPreferences(e.target.value)}
            placeholder="e.g. Pickup, deliver to site…"
          />
        </div>
        <div>
          <div style={labelStyle}>Expiration Date</div>
          <input
            type="date"
            style={inputStyle}
            value={expirationDate}
            onChange={e => setExpirationDate(e.target.value)}
          />
        </div>
      </div>

      {/* ── Vehicle (K5 + N4-B2) — identity prints on the estimate + pushes
          to the NS VIN field; platform/qualifiers gate the catalog browser.
          A VIN auto-fills what it encodes, but every field works by hand. ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px', marginBottom: '8px' }}>
        <div>
          <div style={labelStyle}>VIN</div>
          <input
            style={{ ...inputStyle, textTransform: 'uppercase' }}
            value={vin}
            onChange={e => setVin(e.target.value.toUpperCase())}
            maxLength={17}
            placeholder="Full 17 auto-fills the vehicle below — prints on the estimate"
          />
          {vinStatus && (
            <div style={{
              marginTop: '4px', fontSize: '11px', fontWeight: 700,
              color: vinStatus.kind === 'filled' || vinStatus.kind === 'no-platform' ? '#34d399'
                : vinStatus.kind === 'partial' || vinStatus.kind === 'decoding' ? 'var(--text-muted)'
                : '#fbbf24',
            }}>
              {vinStatus.kind === 'partial' && (
                <span style={{ fontWeight: 400 }}>
                  {vinStatus.len} of 17 characters — a full VIN auto-fills the vehicle fields below
                </span>
              )}
              {vinStatus.kind === 'invalid' && '⚠ Not a valid VIN — check for typos (VINs never contain I, O, or Q)'}
              {vinStatus.kind === 'decoding' && <span style={{ fontWeight: 400 }}>Decoding VIN…</span>}
              {vinStatus.kind === 'filled' && (
                <>
                  {'✓ '}{vinStatus.summary}{' — vehicle fields filled below'}
                  {vinStatus.needs.length > 0 && (
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                      {' '}(not in this VIN, pick by hand: {vinStatus.needs.join(', ')})
                    </span>
                  )}
                </>
              )}
              {vinStatus.kind === 'no-platform' && `✓ Decoded${vinStatus.summary ? `: ${vinStatus.summary}` : ''} — filled in as a typed vehicle (not in the parts-fitment list)`}
              {vinStatus.kind === 'failed' && '⚠ Couldn’t decode this VIN — pick the vehicle below or type it in'}
            </div>
          )}
        </div>
        <div>
          <div style={labelStyle}>Unit/Stock #</div>
          <input
            style={inputStyle}
            value={unitNumber}
            onChange={e => setUnitNumber(e.target.value)}
            placeholder="Customer's unit or stock #"
          />
        </div>
      </div>

      {/* Checked-in vehicle link — ties this estimate to the fleet_checkins
          row on the In-Shop board. Linked: a chip that opens the vehicle on
          /tracking. Not linked: a picker button, plus an automatic offer
          when the typed VIN matches a vehicle currently on the ground. */}
      <div style={{ marginBottom: '12px' }}>
        {linkedCheckin ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              onClick={() => router.push(deepLinks.vehicle(linkedCheckin.id))}
              title="Open this vehicle on the In-Shop board"
              style={{
                display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 12px', borderRadius: '8px',
                background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', cursor: 'pointer',
                fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)',
              }}
            >
              🚗 In Shop: {checkinLabel(linkedCheckin)}
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>VIN {linkedCheckin.vin}</span>
              <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', background: 'rgba(34,197,94,0.15)', color: '#22c55e', textTransform: 'uppercase' }}>
                {(linkedCheckin.status || '').replace(/_/g, ' ')}
              </span>
            </button>
            <button onClick={unlinkCheckin} title="Unlink this vehicle (takes effect on Save)" style={{
              padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            }}>✕ Unlink</button>
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <button onClick={() => (checkinPickerOpen ? setCheckinPickerOpen(false) : openCheckinPicker())} style={{
                padding: '7px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa',
              }}>
                {checkinPickerOpen ? 'Close' : '🚗 Link Checked-In Vehicle'}
              </button>
              {checkinSuggestion && (
                <button onClick={() => linkCheckin(checkinSuggestion)} title="This VIN matches a vehicle currently on the In-Shop board — click to link it" style={{
                  padding: '7px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                  background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.4)', color: '#f59e0b',
                }}>
                  ⚡ This VIN is checked in — {checkinLabel(checkinSuggestion)}{checkinSuggestion.customer_name ? ` (${checkinSuggestion.customer_name})` : ''} · Link it
                </button>
              )}
            </div>
            {checkinPickerOpen && (
              <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 60, marginTop: '4px', width: 'min(520px, 92vw)', background: 'var(--card)', border: '1px solid var(--border-strong)', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.25)', padding: '10px' }}>
                <input
                  autoFocus
                  value={checkinSearch}
                  onChange={e => setCheckinSearch(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') setCheckinPickerOpen(false); }}
                  placeholder="Search vehicles in the shop — VIN, customer, make, model…"
                  style={{ ...inputStyle, marginBottom: '6px' }}
                />
                <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
                  {checkinMatches.length === 0 ? (
                    <div style={{ padding: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
                      {checkinOptions.length === 0 ? 'No vehicles currently in the shop.' : 'No in-shop vehicles match that search.'}
                    </div>
                  ) : checkinMatches.map(c => (
                    <button key={c.id} onClick={() => linkCheckin(c)} style={{
                      display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 10px',
                      textAlign: 'left', border: 'none', borderBottom: '1px solid var(--border)',
                      background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'var(--text-primary)',
                    }}>
                      <span style={{ fontWeight: 700 }}>{checkinLabel(c)}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>VIN {c.vin}</span>
                      {c.customer_name && <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>{c.customer_name}</span>}
                      <span style={{ flex: 1 }} />
                      {c.vinMatch && (
                        <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', background: 'rgba(251,191,36,0.15)', color: '#f59e0b' }}>VIN MATCH</span>
                      )}
                      <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'var(--subtle-bg)', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                        {(c.status || '').replace(/_/g, ' ')}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px', marginBottom: '12px' }}>
        <div>
          <div style={labelStyle}>Vehicle (Make & Model)</div>
          <select
            style={inputStyle}
            value={vehiclePlatformId || (vehicleOtherMode ? OTHER_VEHICLE : '')}
            onChange={e => pickPlatform(e.target.value || null)}
          >
            <option value="">— select vehicle —</option>
            <optgroup label="Vans">
              {platforms.filter(p => p.body_type === 'van').map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </optgroup>
            <optgroup label="Trucks">
              {platforms.filter(p => p.body_type === 'truck').map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </optgroup>
            {platforms.some(p => p.body_type === 'other') && (
              <optgroup label="Other">
                {platforms.filter(p => p.body_type === 'other').map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </optgroup>
            )}
            <option value={OTHER_VEHICLE}>Other — type it in…</option>
          </select>
          {vehicleOtherMode && (
            <input
              style={{ ...inputStyle, marginTop: '6px' }}
              value={vehicleOther}
              onChange={e => setVehicleOther(e.target.value)}
              placeholder="Make & model — e.g. Honda Civic, Isuzu NPR box truck"
              autoFocus={!vehicleOther}
            />
          )}
          {vehicleOtherMode && (
            <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
              Prints on the estimate and pushes to NetSuite. Catalog fitment filtering only works for vehicles in the list above.
            </div>
          )}
          {selectedPlatform && (
            <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
              Browse Catalog will filter to parts that fit the {selectedPlatform.label}
              {vehicleRoof ? ` · ${vehicleRoof} roof` : ''}
              {vehicleWheelbase ? ` · ${/^\d/.test(vehicleWheelbase) ? `${vehicleWheelbase}" WB` : vehicleWheelbase}` : ''}
            </div>
          )}
        </div>
        <div>
          <div style={labelStyle}>Year</div>
          <input
            style={inputStyle}
            value={vehicleYear}
            onChange={e => setVehicleYear(e.target.value.replace(/\D/g, ''))}
            maxLength={4}
            inputMode="numeric"
            placeholder="e.g. 2025"
          />
        </div>
      </div>
      {selectedPlatform && (platformConfig.roofs || platformConfig.wheelbases || platformConfig.cabs || platformConfig.beds) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px', marginBottom: '12px' }}>
          {platformConfig.roofs && platformConfig.roofs.length > 0 && (
            <div>
              <div style={labelStyle}>Roof Height</div>
              <select style={inputStyle} value={vehicleRoof} onChange={e => setVehicleRoof(e.target.value)}>
                <option value="">— roof —</option>
                {platformConfig.roofs.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          )}
          {platformConfig.wheelbases && platformConfig.wheelbases.length > 0 && (
            <div>
              <div style={labelStyle}>Wheelbase</div>
              <select style={inputStyle} value={vehicleWheelbase} onChange={e => setVehicleWheelbase(e.target.value)}>
                <option value="">— wheelbase —</option>
                {platformConfig.wheelbases.map(w => <option key={w} value={w}>{/^\d/.test(w) ? `${w}"` : w}</option>)}
              </select>
            </div>
          )}
          {platformConfig.cabs && platformConfig.cabs.length > 0 && (
            <div>
              <div style={labelStyle}>Cab Size</div>
              <select style={inputStyle} value={vehicleCab} onChange={e => setVehicleCab(e.target.value)}>
                <option value="">— cab —</option>
                {platformConfig.cabs.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          {platformConfig.beds && platformConfig.beds.length > 0 && (
            <div>
              <div style={labelStyle}>Bed Length</div>
              <select style={inputStyle} value={vehicleBed} onChange={e => setVehicleBed(e.target.value)}>
                <option value="">— bed —</option>
                {platformConfig.beds.map(b => <option key={b} value={b}>{b}&apos;</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {/* ── Internal notes — the surviving piece of the old Install Context
          section (removed 2026-08-12; the retired fields still round-trip
          through load + save so existing estimates keep their data). ── */}
      <div id="est-notes-field" style={{ marginBottom: '12px' }}>
        <div style={labelStyle}>Internal Notes (ops-only)</div>
        <MentionTextArea
          style={{ ...inputStyle, minHeight: '40px', resize: 'vertical', fontFamily: 'inherit' }}
          value={internalNotes}
          onChange={setInternalNotes}
          placeholder="Not shown to the customer — @ tags a teammate"
        />
        {customerId && (
          <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
            <span>Customer-wide defaults:</span>
            <span>{customerDefaults?.delivery_instructions ? '✓ set' : '(none)'}</span>
            <button
              type="button"
              onClick={() => setEditingCustomerDefaults(true)}
              style={{ padding: '3px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
            >Edit defaults</button>
          </div>
        )}
      </div>

      {/* Customer defaults modal */}
      {editingCustomerDefaults && customerId && (
        <CustomerDefaultsEditor
          initial={customerDefaults}
          customerId={customerId}
          customerName={customerName}
          saving={savingCustomerDefaults}
          onSave={saveCustomerDefaults}
          onClose={() => setEditingCustomerDefaults(false)}
        />
      )}

      {/* ── LINE ITEMS ── */}
      <div style={{ marginBottom: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
          <div style={labelStyle}>Line Items</div>
          {(
            <button
              onClick={addCustomLine}
              style={{ padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', cursor: 'pointer' }}
            >
              + Custom Line
            </button>
          )}
        </div>

        {/* Part search + visual catalog browser (N4-A) */}
        {(
          <div style={{ position: 'relative', marginBottom: '8px', display: 'flex', gap: '8px' }}>
            <input
              ref={partSearchRef}
              placeholder="Search parts catalog to add..."
              value={partSearch}
              onChange={e => setPartSearch(e.target.value)}
              style={{ ...inputStyle, background: 'var(--subtle-bg)', flex: 1 }}
            />
            <button
              type="button"
              onClick={() => setShowCatalogBrowser(true)}
              title="Browse the catalog by category and vendor, with photos"
              style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              Browse Catalog
            </button>
            <button
              type="button"
              onClick={addGraphics}
              disabled={saving}
              title="Save this estimate and price vehicle graphics in the wrap-quote builder — the result comes back as lines on this estimate"
              style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 800, cursor: saving ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}
            >
              🎨 Add Graphics
            </button>
            <button
              type="button"
              onClick={openQuickGraphics}
              title="Skip the estimator — type in square footage, vinyl type, and labor directly"
              style={{ padding: '8px 14px', borderRadius: '8px', border: `1px solid ${quickGfxOpen ? 'rgba(96,165,250,0.4)' : 'var(--border)'}`, background: quickGfxOpen ? 'rgba(96,165,250,0.08)' : 'var(--card)', color: quickGfxOpen ? '#60a5fa' : 'var(--text-primary)', fontSize: '12px', fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              + Graphics Line
            </button>
            {lines.some(l => l.part_id && !l.is_custom) && (
              <button
                type="button"
                onClick={saveLinesAsPackage}
                title="Save this estimate's catalog lines as a reusable package (Browse Catalog → Packages)"
                style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                Save as Package
              </button>
            )}
            {(partResults.length > 0 || (isAdmin && !partSearching && partSearch.trim().length >= 2)) && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                maxHeight: '250px', overflowY: 'auto', marginTop: '2px',
              }}>
                {partResults.map(p => (
                  <button
                    key={p.id}
                    onClick={() => addPartLine(p)}
                    style={{
                      width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
                      background: 'transparent', color: 'var(--text-body)', fontSize: '12px',
                      cursor: 'pointer', borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <div>
                        <span style={{ fontWeight: 700 }}>{p.item_number}</span>
                        <span style={{ color: 'var(--text-label)', marginLeft: '8px' }}>{p.display_name || p.description}</span>
                      </div>
                      <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
                        <span style={{ color: '#22c55e', fontWeight: 700 }}>{fmt(p.sales_price)}</span>
                        {p.labor_hours > 0 && <span style={{ color: '#fbbf24', fontSize: '10px' }}>{p.labor_hours}h labor</span>}
                        <span style={{ color: 'var(--text-label)', fontSize: '10px', textTransform: 'uppercase' }}>{p.catalog}</span>
                      </div>
                    </div>
                  </button>
                ))}
                {/* Not in the catalog yet → create it in NetSuite right here
                    and it lands as a line (admin-only: the create-item API
                    requires the admin role). */}
                {isAdmin && !partSearching && partSearch.trim().length >= 2 && (
                  <button
                    onClick={() => setCreatePartCtx({ query: partSearch.trim(), forLineKey: null })}
                    style={{
                      width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
                      background: 'rgba(34,197,94,0.08)', color: '#22c55e', fontSize: '12px',
                      fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    ＋ {partResults.length === 0 ? 'No catalog match — create' : 'Not listed? Create'} &ldquo;{partSearch.trim()}&rdquo; as a new part…
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Quick graphics entry — type sqft/film/labor, no estimator. */}
        {quickGfxOpen && (
          <div style={{
            padding: '12px', borderRadius: '10px', marginBottom: '8px',
            background: 'rgba(96,165,250,0.05)', border: '1px solid rgba(96,165,250,0.25)',
          }}>
            <div style={{ fontSize: '10px', fontWeight: 800, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
              Quick Graphics Line
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '2 1 180px' }}>
                <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Vinyl / film</label>
                <input
                  list="qg-substrates"
                  value={qgFilmName}
                  onChange={e => {
                    const name = e.target.value;
                    setQgFilmName(name);
                    const match = (substrates || []).find(s => s.name === name);
                    if (match) setQgRate(String(match.price_per_sqft));
                  }}
                  placeholder={substrates === null ? 'Loading films…' : 'Pick a film or type one'}
                  style={{ ...inputStyle, width: '100%' }}
                />
                <datalist id="qg-substrates">
                  {(substrates || []).map(s => (
                    <option key={s.id} value={s.name}>{`$${Number(s.price_per_sqft).toFixed(2)}/sqft`}</option>
                  ))}
                </datalist>
              </div>
              <div style={{ flex: '1 1 90px' }}>
                <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Sq ft</label>
                <NumberInput value={qgSqft} onChange={e => setQgSqft(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
              </div>
              <div style={{ flex: '1 1 90px' }}>
                <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>$ / sq ft</label>
                <NumberInput value={qgRate} onChange={e => setQgRate(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
              </div>
              <div style={{ flex: '1 1 100px' }}>
                <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Install labor $</label>
                <NumberInput value={qgLabor} onChange={e => setQgLabor(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
              </div>
              <button
                type="button"
                onClick={addQuickGraphicsLines}
                disabled={(parseFloat(qgSqft) || 0) <= 0 && (parseFloat(qgLabor) || 0) <= 0}
                style={{
                  padding: '9px 16px', borderRadius: '8px', border: 'none',
                  background: '#60a5fa', color: '#fff', fontSize: '12px', fontWeight: 800,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  opacity: (parseFloat(qgSqft) || 0) <= 0 && (parseFloat(qgLabor) || 0) <= 0 ? 0.5 : 1,
                }}
              >
                Add {(parseFloat(qgSqft) || 0) > 0 && (parseFloat(qgRate) || 0) >= 0
                  ? `· ${fmt((parseFloat(qgSqft) || 0) * (parseFloat(qgRate) || 0) + (parseFloat(qgLabor) || 0))}`
                  : ''}
              </button>
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px' }}>
              Lands as regular lines you can edit — materials as sqft × rate, labor as its own line. Films and rates come from the wrap-quote price list.
            </div>
          </div>
        )}

        {/* Line item rows */}
        {lines.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-label)', fontSize: '12px', border: '1px dashed var(--border)', borderRadius: '8px' }}>
            Search for parts above or add a custom line item
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {/* Header row */}
            <div className="est-line est-line-head" style={{ padding: '4px 0', fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase' }}>
              <div onClick={() => toggleEstSort('item_number')} style={{ cursor: 'pointer', color: estSortCol === 'item_number' ? '#60a5fa' : undefined }}>Item #{estSortIndicator('item_number')}</div>
              <div>Description</div>
              <div onClick={() => toggleEstSort('quantity')} style={{ textAlign: 'center', cursor: 'pointer', color: estSortCol === 'quantity' ? '#60a5fa' : undefined }}>Qty{estSortIndicator('quantity')}</div>
              <div onClick={() => toggleEstSort('unit_price')} style={{ textAlign: 'right', cursor: 'pointer', color: estSortCol === 'unit_price' ? '#60a5fa' : undefined }}>Price{estSortIndicator('unit_price')}</div>
              <div style={{ textAlign: 'right' }}>Total</div>
              <div onClick={() => toggleEstSort('labor_hours')} style={{ textAlign: 'center', cursor: 'pointer', color: estSortCol === 'labor_hours' ? '#60a5fa' : undefined }}>Labor{estSortIndicator('labor_hours')}</div>
              <div></div>
              <div></div>
            </div>

            {sortedLines.map(line => {
              const unmatched = !line.netsuite_item_id;
              return (
              <div
                key={line.key}
                data-linekey={line.key}
                style={draggingKey === line.key ? { background: 'rgba(96,165,250,0.08)', borderRadius: '8px' } : undefined}
              >
                <div
                  className="est-line"
                  style={{ padding: '6px 0', borderBottom: unmatched ? 'none' : '1px solid var(--border)' }}
                >
                  {line.is_custom ? (
                    <input
                      className="est-c-item"
                      style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px' }}
                      value={line.item_number}
                      onChange={e => updateLine(line.key, 'item_number', e.target.value)}
                      placeholder="Item #"
                    />
                  ) : (
                    <div className="est-c-item" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {line.part_id ? (
                        <a className="part-link" href={deepLinks.part(line.part_id)} target="_blank" rel="noreferrer" title="Open part record">
                          {line.item_number}
                        </a>
                      ) : line.item_number}
                    </div>
                  )}

                  {/* Editable on every line, not just custom ones — reps add
                      placement notes etc. It pushes as the NetSuite transaction
                      line's description (a per-transaction override; the item
                      record is never modified). Cleared = NetSuite falls back
                      to the item's default description. */}
                  <input
                    className="est-c-desc"
                    style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px' }}
                    value={line.description}
                    onChange={e => updateLine(line.key, 'description', e.target.value)}
                    placeholder="Description / placement notes"
                    title={line.description}
                  />

                  <div className="est-c-qty">
                    <div className="est-cell-label" style={{ textAlign: 'center' }}>Qty</div>
                    <NumberInput
                      style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px', textAlign: 'center' }}
                      value={line.quantity}
                      onChange={e => updateLine(line.key, 'quantity', parseFloat(e.target.value) || 0)}
                      min={0}
                    />
                  </div>

                  <div className="est-c-price">
                    <div className="est-cell-label" style={{ textAlign: 'right' }}>Price</div>
                    <NumberInput
                      style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px', textAlign: 'right' }}
                      value={line.unit_price}
                      onChange={e => updateLine(line.key, 'unit_price', parseFloat(e.target.value) || 0)}
                      step={0.01}
                    />
                  </div>

                  <div className="est-c-total" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-body)', textAlign: 'right' }}>
                    <div className="est-cell-label">Total</div>
                    {fmt(line.quantity * line.unit_price)}
                    {(() => {
                      const pct = lineMarginPct(line);
                      if (pct == null) return null;
                      return (
                        <div title={`True cost ${fmt(lineTrueCost(line))}/ea (part ${fmt(line.purchase_price ?? 0)} + install ${fmt(line.avg_install_cost ?? 0)})`}
                          style={{ fontSize: '9px', fontWeight: 700, color: marginColor(pct) }}>
                          {pct.toFixed(0)}% m
                        </div>
                      );
                    })()}
                  </div>

                  <div className="est-c-labor" style={{ fontSize: '10px', color: line.labor_hours > 0 ? '#fbbf24' : 'var(--text-label)', textAlign: 'center' }}>
                    <div className="est-cell-label">Labor</div>
                    {line.labor_hours > 0 ? `${(line.labor_hours * line.quantity).toFixed(1)}h` : '—'}
                  </div>

                  {(
                    <button
                      className="est-c-x"
                      onClick={() => removeLine(line.key)}
                      title="Remove line"
                      style={{ background: 'transparent', border: 'none', color: '#f87171', fontSize: '14px', cursor: 'pointer', padding: '2px' }}
                    >
                      ×
                    </button>
                  )}

                  {/* Drag handle — pointer-based reorder; inert while a
                      column sort is active (dragging a sorted view lies). */}
                  <div
                    className="est-c-drag"
                    title={estSortCol ? 'Clear the column sort to reorder lines' : 'Drag to reorder'}
                    onPointerDown={(e) => onDragHandleDown(e, line.key)}
                    onPointerMove={onDragHandleMove}
                    onPointerUp={onDragHandleUp}
                    onPointerCancel={onDragHandleUp}
                    style={{
                      touchAction: 'none', userSelect: 'none',
                      cursor: estSortCol ? 'not-allowed' : (draggingKey === line.key ? 'grabbing' : 'grab'),
                      color: estSortCol ? 'var(--border)' : 'var(--text-muted)',
                      fontSize: '14px', lineHeight: 1, textAlign: 'center', padding: '4px 2px',
                    }}
                  >
                    ≡
                  </div>
                </div>

                {/* NetSuite item id required — a line without one silently
                    drops off the pushed Estimate. Force a catalog match here
                    instead of letting it disappear invisibly at push time. */}
                {unmatched && (
                  <div style={{
                    padding: '6px 8px', marginBottom: '4px', borderRadius: '6px',
                    background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ fontSize: '10px', fontWeight: 700, color: '#fbbf24' }}>
                        ⚠ No NetSuite item matched — this line won&apos;t reach the pushed Estimate until matched.
                      </span>
                      <button
                        onClick={() => { setMatchingLineKey(matchingLineKey === line.key ? null : line.key); setLineMatchQuery(''); setLineMatchResults([]); }}
                        style={{
                          padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700,
                          background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.35)',
                          color: '#fbbf24', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                        }}
                      >
                        {matchingLineKey === line.key ? 'Cancel' : 'Match NetSuite item'}
                      </button>
                    </div>

                    {matchingLineKey === line.key && (
                      <div style={{ position: 'relative', marginTop: '6px' }}>
                        <input
                          autoFocus
                          placeholder="Search parts catalog…"
                          value={lineMatchQuery}
                          onChange={e => setLineMatchQuery(e.target.value)}
                          style={{ ...inputStyle, background: 'var(--card)' }}
                        />
                        {lineMatchResults.length > 0 && (
                          <div style={{
                            position: 'relative', zIndex: 50, marginTop: '2px',
                            background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px',
                            maxHeight: '220px', overflowY: 'auto',
                          }}>
                            {lineMatchResults.map(p => (
                              <button
                                key={p.id}
                                onClick={() => matchLineToPart(line.key, p)}
                                style={{
                                  width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
                                  background: 'transparent', color: 'var(--text-body)', fontSize: '12px',
                                  cursor: 'pointer', borderBottom: '1px solid var(--border)',
                                }}
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                  <div>
                                    <span style={{ fontWeight: 700 }}>{p.item_number}</span>
                                    <span style={{ color: 'var(--text-label)', marginLeft: '8px' }}>{p.display_name || p.description}</span>
                                  </div>
                                  <span style={{ color: '#22c55e', fontWeight: 700, flexShrink: 0 }}>{fmt(p.sales_price)}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                        {lineMatchQuery.length >= 2 && lineMatchResults.length === 0 && (
                          isAdmin ? (
                            <button
                              onClick={() => setCreatePartCtx({ query: lineMatchQuery.trim(), forLineKey: line.key })}
                              style={{
                                width: '100%', textAlign: 'left', marginTop: '4px', padding: '8px 10px',
                                borderRadius: '6px', border: '1px solid rgba(34,197,94,0.3)',
                                background: 'rgba(34,197,94,0.08)', color: '#22c55e',
                                fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                              }}
                            >
                              ＋ No catalog match — create &ldquo;{lineMatchQuery.trim()}&rdquo; in NetSuite and use it for this line…
                            </button>
                          ) : (
                            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                              No catalog items match. Ask an admin to add it via Parts Sync.
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── GRAPHICS JOBS PANEL ──
          Visible once the estimate is saved AND either has a graphics-catalog
          line or already has linked graphics jobs. Drives the "spawn or link
          a graphics job for production" prompt for combined upfit+graphics
          deals — see migrations/084-graphics-upfit-project-link.sql for the
          downstream upfit_project linkage. */}
      {editingId && (lines.some(isGraphicsLine) || linkedGraphicsJobs.length > 0) && (
        <div style={{
          background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '10px',
          padding: '12px', marginBottom: '12px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={labelStyle}>Graphics Jobs</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                onClick={spawnGraphicsJob}
                disabled={graphicsLinking}
                style={{
                  padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                  background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.3)',
                  color: '#a78bfa', cursor: graphicsLinking ? 'wait' : 'pointer',
                }}
              >
                {graphicsLinking ? '…' : '+ Spawn graphics job'}
              </button>
              <button
                onClick={() => setShowGraphicsPicker(s => !s)}
                disabled={graphicsLinking}
                style={{
                  padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                  background: 'var(--card)', border: '1px solid var(--border)',
                  color: 'var(--text-body)', cursor: 'pointer',
                }}
              >
                Link existing
              </button>
            </div>
          </div>

          {/* Empty-state prompt when graphics line is present but nothing is linked */}
          {linkedGraphicsJobs.length === 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: showGraphicsPicker ? '8px' : '0' }}>
              This estimate has graphics work. Spawn a new graphics job for production
              (auto-assigns to the graphics team) or link to one Brian has already started.
            </div>
          )}

          {/* Linked job list */}
          {linkedGraphicsJobs.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {linkedGraphicsJobs.map(j => (
                <div
                  key={j.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '6px 8px', borderRadius: '6px', background: 'var(--card)',
                    border: '1px solid var(--border)', fontSize: '12px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <span style={{ fontWeight: 700, fontSize: '11px' }}>{j.job_number || j.id.slice(0, 8)}</span>
                    <span style={{
                      fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                      background: GRAPHICS_STATUS_COLORS[j.status] || '#94a3b8', color: '#fff',
                      textTransform: 'uppercase',
                    }}>{j.status.replace(/_/g, ' ')}</span>
                    <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.title}</span>
                  </div>
                  <button
                    onClick={() => openPopout('graphics_jobs', j.id)}
                    style={{
                      padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 700,
                      background: 'transparent', border: '1px solid var(--border)',
                      color: 'var(--text-body)', cursor: 'pointer', flexShrink: 0,
                    }}
                  >Open</button>
                </div>
              ))}
            </div>
          )}

          {/* Inline picker for "Link existing" */}
          {showGraphicsPicker && (
            <div style={{ position: 'relative', marginTop: '8px' }}>
              <input
                placeholder="Search graphics jobs (job #, title, customer)…"
                value={graphicsPickerSearch}
                onChange={e => setGraphicsPickerSearch(e.target.value)}
                style={{ ...inputStyle, background: 'var(--card)' }}
                autoFocus
              />
              {graphicsPickerResults.length > 0 && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                  maxHeight: '250px', overflowY: 'auto', marginTop: '2px',
                }}>
                  {graphicsPickerResults.map(j => (
                    <button
                      key={j.id}
                      onClick={() => linkGraphicsJob(j.id)}
                      disabled={graphicsLinking}
                      style={{
                        width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
                        background: 'transparent', color: 'var(--text-body)', fontSize: '12px',
                        cursor: graphicsLinking ? 'wait' : 'pointer', borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 700, fontSize: '11px' }}>{j.job_number || j.id.slice(0, 8)}</span>
                        <span style={{
                          fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                          background: GRAPHICS_STATUS_COLORS[j.status] || '#94a3b8', color: '#fff',
                          textTransform: 'uppercase',
                        }}>{j.status.replace(/_/g, ' ')}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{j.title}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {graphicsPickerSearch.length >= 2 && graphicsPickerResults.length === 0 && (
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  No unlinked graphics jobs match. Try "Spawn" to create a new one.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── LABOR & TAX SECTION ── */}
      <div style={{
        background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '10px',
        padding: '12px', marginBottom: '12px',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '10px' }}>
          <div>
            <div style={labelStyle}>Labor Rate ($/hr)</div>
            <NumberInput
              style={inputStyle}
              value={laborRate}
              onChange={e => setLaborRate(parseFloat(e.target.value) || 0)}
  
              step={0.01}
            />
          </div>
          <div>
            <div style={labelStyle}>Auto Labor Hours</div>
            <div style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: '#fbbf24', fontSize: '12px', fontWeight: 700 }}>
              {autoLaborHours.toFixed(1)}h
              <span style={{ color: 'var(--text-label)', fontWeight: 400, fontSize: '10px', marginLeft: '4px' }}>(from parts)</span>
            </div>
          </div>
          <div>
            <div style={labelStyle}>Labor Override</div>
            <input
              type="number"
              style={inputStyle}
              value={laborOverride ?? ''}
              onChange={e => {
                const v = e.target.value;
                setLaborOverride(v === '' ? null : parseFloat(v) || 0);
              }}
              placeholder={autoLaborHours.toFixed(1)}
  
              step={0.1}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>Tax Rate</div>
            {/* Read-only by design: the rate is a company setting a super
                admin owns (Settings → Sales Tax), not a per-quote field. */}
            <div
              style={{ ...inputStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', background: 'var(--subtle-bg)', cursor: 'default' }}
              title={atCompanyRate
                ? 'Company sales tax rate — changed in Settings → Sales Tax (super admin only)'
                : `This estimate was quoted at ${rateToPct(taxRate).toFixed(2)}%. The current company rate is ${rateToPct(companyTaxRate).toFixed(2)}%.`}
            >
              <span style={{ fontWeight: 700 }}>{rateToPct(taxRate).toFixed(2)}%</span>
              <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                {atCompanyRate ? 'company rate' : 'as quoted'}
              </span>
            </div>
          </div>
          <div style={{ paddingTop: '14px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={taxExempt}
                onChange={e => setTaxExempt(e.target.checked)}


                style={{ width: '16px', height: '16px', accentColor: theme.orange }}
              />
              <span style={{ fontSize: '12px', fontWeight: 700, color: taxExempt ? '#22c55e' : 'var(--text-label)' }}>
                Tax Exempt
              </span>
            </label>
            {customerDefaults?.tax_exempt && (() => {
              const exp = customerDefaults.tax_exempt_expires_at;
              const cert = customerDefaults.tax_exempt_cert_number;
              let tone = 'var(--text-muted)';
              const parts = ['Customer default'];
              if (cert) parts.push(`cert #${cert}`);
              if (exp) {
                const d = new Date(exp + 'T00:00:00');
                const days = Math.floor((d.getTime() - Date.now()) / 86400000);
                const mmYYYY = `${d.getMonth() + 1}/${d.getFullYear()}`;
                if (days < 0) { tone = '#f59e0b'; parts.push(`cert EXPIRED ${mmYYYY}`); }
                else if (days <= 60) { tone = '#f59e0b'; parts.push(`cert expires ${mmYYYY}`); }
                else parts.push(`exp ${mmYYYY}`);
              }
              return <div style={{ fontSize: '10px', color: tone, marginTop: '4px', maxWidth: '160px' }}>{parts.join(' · ')}</div>;
            })()}
          </div>
        </div>

        {/* Totals */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-body)', marginBottom: '4px' }}>
            <span>Parts Subtotal</span>
            <span>{fmt(subtotal)}</span>
          </div>
          {/* Margin strip — internal readout, never on the customer quote */}
          {costedLines.length > 0 && marginPct != null && (
            <div style={{
              padding: '8px 10px', borderRadius: '8px', margin: '2px 0 6px',
              background: 'var(--card)',
              border: `1px solid ${marginPct < 0 ? 'rgba(239,68,68,0.4)' : marginPct < marginFloor ? 'rgba(251,191,36,0.4)' : 'rgba(34,197,94,0.25)'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-label)', marginBottom: '2px' }}>
                <span>True Parts Cost (cost + avg install)</span>
                <span>−{fmt(trueCostTotal)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: 800, color: marginColor(marginPct) }}>
                <span>
                  Parts Margin
                  {marginPct < marginFloor && (
                    <span style={{ marginLeft: '6px' }}>
                      {marginPct < 0 ? '⚠ BELOW COST' : `⚠ below ${marginFloor.toFixed(0)}% floor`}
                    </span>
                  )}
                </span>
                <span>{fmt(marginDollars)} ({marginPct.toFixed(1)}%)</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '10px', color: 'var(--text-label)', marginTop: '3px' }}>
                <span>
                  {uncostedCount > 0
                    ? `${uncostedCount} line${uncostedCount !== 1 ? 's' : ''} without cost data excluded`
                    : 'All lines have cost data'}
                </span>
                {isAdmin ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    floor
                    <input
                      type="number"
                      defaultValue={marginFloor}
                      key={`floor-${marginFloor}`}
                      onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v !== marginFloor) saveMarginFloor(v); }}
                      style={{ ...inputStyle, width: '52px', padding: '2px 4px', fontSize: '10px', textAlign: 'right' }}
                      step={1}
                    />%
                  </span>
                ) : (
                  <span>floor {marginFloor.toFixed(0)}%</span>
                )}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#fbbf24', marginBottom: '4px' }}>
            <span>Labor ({effectiveLaborHours.toFixed(1)}h × {fmt(laborRate)}/hr)</span>
            <span>{fmt(laborTotal)}</span>
          </div>
          {!taxExempt && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-body)', marginBottom: '4px' }}>
              <span>Sales Tax on Parts ({rateToPct(taxRate).toFixed(2)}%)</span>
              <span>{fmt(taxAmount)}</span>
            </div>
          )}
          {taxExempt && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#22c55e', marginBottom: '4px' }}>
              <span>Tax Exempt</span>
              <span>{fmt(0)}</span>
            </div>
          )}
          <div style={{
            display: 'flex', justifyContent: 'space-between', fontSize: '16px', fontWeight: 800,
            color: 'var(--text-body)', borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '4px',
          }}>
            <span>Total</span>
            <span>{fmt(grandTotal)}</span>
          </div>
        </div>
      </div>

      {/* ── ACTION BUTTONS ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {/* NS status banner for pushed estimates */}
        {isPushed && (
          <div style={{
            padding: '10px 14px', borderRadius: '10px',
            background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#a78bfa' }}>
                Pushed to NetSuite
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>
                NS Estimate #: {estimates.find(e => e.id === editingId)?.netsuite_estimate_number || 'N/A'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>
                Edit below &amp; sync changes
              </div>
              <button
                onClick={viewEstimatePdf}
                disabled={viewingPdf}
                style={{
                  padding: '6px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                  background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)',
                  color: '#a78bfa', cursor: viewingPdf ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {viewingPdf ? 'Opening…' : 'View PDF'}
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={() => saveEstimate(isPushed ? 'pushed' : 'draft', { offerRevision: true })}
            disabled={saving}
            style={{
              flex: 1, padding: '12px', borderRadius: '10px',
              background: saving ? 'var(--subtle-bg)' : '#22c55e',
              color: '#fff', fontWeight: 800, fontSize: '13px', border: 'none', cursor: 'pointer',
              opacity: saving ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving...' : (editingId ? 'Save Changes' : 'Save Draft')}
          </button>
          <button
            onClick={() => { setView('list'); }}
            style={{
              padding: '12px 20px', borderRadius: '10px',
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--text-body)', fontWeight: 700, fontSize: '13px', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>

        {/* FleetSuite enhanced-estimate PDF — view, print, or email the
            customer-facing copy (photos + product links). Works on any saved
            estimate; no NetSuite push required. */}
        {editingId && lines.length > 0 && (() => {
          const pdfBtn: React.CSSProperties = {
            flex: 1, padding: '10px', borderRadius: '10px',
            background: 'var(--card)', border: '1px solid var(--border)',
            color: 'var(--text-body)', fontWeight: 700, fontSize: '12px',
            cursor: 'pointer', whiteSpace: 'nowrap',
          };
          return (
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={() => openFleetsuitePdf(false)} style={pdfBtn} title="Open the customer-facing estimate PDF in a new tab">
                Estimate PDF
              </button>
              <button onClick={() => openFleetsuitePdf(true)} style={pdfBtn} title="Open the PDF with the print dialog ready">
                Print
              </button>
              <button onClick={openPdfEmailModal} style={pdfBtn} title="Email the estimate PDF to the customer">
                Email PDF
              </button>
            </div>
          );
        })()}

        {/* Push or Sync to NetSuite */}
        {editingId && customerNsId && lines.length > 0 && (
          <>
            <button
              onClick={() => pushToNetSuite(!!isPushed)}
              disabled={pushing || syncing}
              title={unmatchedLines.length > 0 ? 'Lines without a NetSuite match push as the FS-CUSTOM placeholder item' : undefined}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px',
                background: (pushing || syncing) ? 'var(--subtle-bg)' : 'rgba(167,139,250,0.15)',
                border: '1px solid rgba(167,139,250,0.3)',
                color: '#a78bfa', fontWeight: 800, fontSize: '13px',
                cursor: 'pointer',
                opacity: (pushing || syncing) ? 0.5 : 1,
              }}
            >
              {pushing ? 'Pushing to NetSuite...' : syncing ? 'Syncing to NetSuite...' : isPushed ? 'Sync Changes to NetSuite' : 'Push to NetSuite as Estimate'}
            </button>
            {unmatchedLines.length > 0 && (
              <div style={{ fontSize: '10px', color: '#fbbf24', fontWeight: 700, textAlign: 'center', marginTop: '-2px' }}>
                {unmatchedLines.length} line{unmatchedLines.length !== 1 ? 's' : ''} without a NetSuite match will push as FS-CUSTOM placeholder line{unmatchedLines.length !== 1 ? 's' : ''}
              </div>
            )}
          </>
        )}

        {/* Send for Customer Approval (magic link) */}
        {editingId && customerId && lines.length > 0 && !(estimates.find(e => e.id === editingId) as any)?.customer_approved && (
          <button
            onClick={openApprovalModal}
            disabled={sendingForApproval}
            style={{
              width: '100%', padding: '12px', borderRadius: '10px',
              background: sendingForApproval ? 'var(--subtle-bg)' : 'rgba(59,130,246,0.15)',
              border: '1px solid rgba(59,130,246,0.3)',
              color: '#3b82f6', fontWeight: 800, fontSize: '13px', cursor: 'pointer',
              opacity: sendingForApproval ? 0.5 : 1,
            }}
          >
            {sendingForApproval ? 'Sending...' : 'Send to Customer for Approval'}
          </button>
        )}

        {/* Preview the customer's approval page. Deliberately NOT a link to
            the customer's own magic link: that URL carries the approval
            token and anyone who opens it can accept, which would record an
            E-SIGN acceptance in the customer's name from a staff look. This
            route is staff-guarded, keyed by estimate id, and read-only. */}
        {editingId && lines.length > 0 && (
          <button
            onClick={() => router.push(`/estimates/${editingId}/approval-preview`)}
            style={{
              width: '100%', padding: '10px', borderRadius: '10px',
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--text-body)', fontWeight: 700, fontSize: '12px', cursor: 'pointer',
            }}
          >
            Preview Customer Approval Page
          </button>
        )}

        {/* Delivery state of the latest approval email (Resend webhook).
            A bounce used to be invisible — the app said "sent" while the
            customer never saw the estimate. */}
        {editingId && (() => {
          const est = estimates.find(e => e.id === editingId);
          const st = est?.approval_email_status;
          if (!est || !st) return null;
          const to = (est.approval_email_to || []).join(', ');
          const when = est.approval_email_updated_at ? new Date(est.approval_email_updated_at).toLocaleString() : null;
          const bad = ['bounced', 'failed', 'complained'].includes(st);
          const meta = bad
            ? {
                color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)',
                text: `⚠ Approval email ${st === 'complained' ? 'marked as spam' : st === 'failed' ? 'failed' : 'bounced'}${to ? ` (${to})` : ''} — the customer did not get it.${est.approval_email_detail ? ` ${est.approval_email_detail}.` : ''} Fix the address and resend.`,
              }
            : st === 'delivered'
              ? { color: '#22c55e', bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.2)', text: `✓ Approval email delivered${to ? ` to ${to}` : ''}` }
              : st === 'delivery_delayed'
                ? { color: '#f59e0b', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.25)', text: `Approval email delayed — the receiving server is retrying${to ? ` (${to})` : ''}` }
                : { color: 'var(--text-muted)', bg: 'var(--subtle-bg)', border: 'var(--border)', text: `Approval email sent${to ? ` to ${to}` : ''} — awaiting delivery confirmation` };
          return (
            <div style={{
              width: '100%', padding: '8px 12px', borderRadius: '10px', textAlign: 'center',
              background: meta.bg, border: `1px solid ${meta.border}`,
              fontSize: '11px', fontWeight: 700, color: meta.color,
            }}>
              {meta.text}{when ? <span style={{ fontWeight: 400 }}> · {when}</span> : null}
            </div>
          );
        })()}

        {/* R3-17 lineage — both directions. "Revision of" on the copy links
            back to the signed original; "Superseded by" on the original
            warns that newer content lives elsewhere before anyone re-sends
            or converts the old document. Rows outside the list's 1000-row
            window degrade to an unlinked label. */}
        {editingId && (() => {
          const est = estimates.find(e => e.id === editingId);
          const sourceId = est?.supersedes_estimate_id || null;
          const source = sourceId ? estimates.find(e => e.id === sourceId) : null;
          const replacements = estimates.filter(e => e.supersedes_estimate_id === editingId);
          if (!sourceId && replacements.length === 0) return null;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {sourceId && (
                <button
                  onClick={() => source && openEstimate(source)}
                  disabled={!source}
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: '10px', textAlign: 'center',
                    background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.25)',
                    color: '#60a5fa', fontWeight: 700, fontSize: '11px',
                    cursor: source ? 'pointer' : 'default',
                  }}
                >
                  ↩ Revision of {source ? `${source.estimate_number} — open the original` : 'an earlier estimate'}
                </button>
              )}
              {replacements.map(r => (
                <button
                  key={r.id}
                  onClick={() => openEstimate(r)}
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: '10px', textAlign: 'center',
                    background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)',
                    color: '#f59e0b', fontWeight: 700, fontSize: '11px', cursor: 'pointer',
                  }}
                >
                  ⚠ Superseded by {r.estimate_number} ({r.status}) — open the revision
                </button>
              ))}
            </div>
          );
        })()}

        {/* Approval provenance / rejection record (Stage 3): the customer's
            decision and its when/how, previously invisible in-app. */}
        {editingId && (() => {
          const est = estimates.find(e => e.id === editingId);
          if (!est) return null;
          if (est.customer_rejected_at) {
            return (
              <div style={{
                width: '100%', padding: '10px 12px', borderRadius: '10px',
                background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
                fontSize: '12px', color: '#f87171',
              }}>
                <div style={{ fontWeight: 800 }}>✗ Customer declined {new Date(est.customer_rejected_at).toLocaleDateString()}</div>
                <div style={{ marginTop: '3px', fontWeight: 500, color: 'var(--text-body)' }}>
                  “{est.customer_rejection_reason || 'No reason given'}”
                </div>
              </div>
            );
          }
          if ((est as any).customer_approved && est.customer_approved_at) {
            return (
              <div style={{
                width: '100%', padding: '8px 12px', borderRadius: '10px', textAlign: 'center',
                background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)',
                fontSize: '11px', fontWeight: 700, color: '#22c55e',
              }}>
                ✓ Approved by the customer {new Date(est.customer_approved_at).toLocaleString()}
                {est.customer_approved_via ? ` via ${est.customer_approved_via === 'sms_link' ? 'SMS link' : 'email link'}` : ''}
              </div>
            );
          }
          return null;
        })()}

        {/* Signed E-SIGN snapshot — the frozen document the customer accepted,
            with an integrity verdict (audit item 11). */}
        {editingId && (estimates.find(e => e.id === editingId) as any)?.customer_approved && (
          <button
            onClick={() => router.push(deepLinks.signedDocument('estimate', editingId))}
            style={{
              width: '100%', padding: '10px', borderRadius: '10px', marginBottom: '8px',
              background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.25)',
              color: '#60a5fa', fontWeight: 700, fontSize: '12px', cursor: 'pointer',
            }}
          >
            View signed acceptance snapshot
          </button>
        )}
        {/* Convert to Sales Order — gated on customer approval; admins can
            override with a recorded reason (phone/email/PO approvals). */}
        {editingId && customerNsId && lines.length > 0 && !estimates.find(e => e.id === editingId)?.netsuite_so_id && (() => {
          const approved = !!(estimates.find(e => e.id === editingId) as any)?.customer_approved;
          const locked = !approved && !isAdmin;
          return (
            <button
              onClick={convertToSalesOrder}
              disabled={convertingToSO || locked}
              title={locked ? 'Waiting on customer approval — send the estimate for approval, or ask an admin to override.' : undefined}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px',
                background: convertingToSO || locked ? 'var(--subtle-bg)' : 'rgba(34,197,94,0.12)',
                border: '1px solid rgba(34,197,94,0.3)',
                color: locked ? 'var(--text-muted)' : '#22c55e', fontWeight: 800, fontSize: '13px',
                cursor: locked ? 'not-allowed' : 'pointer',
                opacity: convertingToSO ? 0.5 : 1,
              }}
            >
              {convertingToSO ? 'Creating Sales Order...'
                : locked ? 'Convert to Sales Order — waiting on customer approval'
                : approved ? 'Convert to Sales Order in NetSuite'
                : 'Convert to Sales Order (admin override)'}
            </button>
          );
        })()}

        {/* Link an SO that already exists in NetSuite. Shown alongside
            Convert because the case it repairs — an SO created but not
            recorded — leaves the estimate looking unconverted. */}
        {editingId && !estimates.find(e => e.id === editingId)?.netsuite_so_id && (
          <button
            onClick={() => linkExistingSalesOrder()}
            disabled={linkingSO || convertingToSO}
            title="Use this when a Sales Order already exists in NetSuite for this estimate but isn't showing here."
            style={{
              width: '100%', padding: '9px', borderRadius: '10px', marginTop: '8px',
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--text-label)', fontWeight: 700, fontSize: '12px',
              cursor: linkingSO || convertingToSO ? 'not-allowed' : 'pointer',
              opacity: linkingSO ? 0.5 : 1,
            }}
          >
            {linkingSO ? 'Linking...' : 'Link an existing Sales Order'}
          </button>
        )}

        {/* Show SO number if already converted */}
        {editingId && estimates.find(e => e.id === editingId)?.netsuite_so_id && (
          <div style={{
            width: '100%', padding: '10px 12px', borderRadius: '10px',
            background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)',
            fontSize: '12px', fontWeight: 700, color: '#22c55e', textAlign: 'center',
          }}>
            Sales Order: SO #{estimates.find(e => e.id === editingId)?.netsuite_so_number || estimates.find(e => e.id === editingId)?.netsuite_so_id}
          </div>
        )}

        {/* Duplicate (R3-17) — copy header + lines into a fresh draft. On a
            locked source this is the revision escape hatch; on an editable
            one it saves first so the copy matches the screen. */}
        {editingId && (() => {
          const est = estimates.find(e => e.id === editingId);
          const locked = !!(est && ((est as any).customer_approved || est.status === 'accepted' || est.netsuite_so_id));
          return (
            <button
              onClick={duplicateEstimate}
              disabled={duplicating || saving}
              title={locked
                ? 'Copies everything into a new draft marked as a revision of this one. This signed original stays untouched.'
                : 'Saves, then copies this estimate into a new draft (approval and NetSuite state are not copied).'}
              style={{
                width: '100%', padding: '10px', borderRadius: '10px',
                background: duplicating ? 'var(--subtle-bg)' : 'rgba(96,165,250,0.08)',
                border: '1px solid rgba(96,165,250,0.25)',
                color: '#60a5fa', fontWeight: 700, fontSize: '12px', cursor: 'pointer',
                opacity: duplicating || saving ? 0.5 : 1,
              }}
            >
              {duplicating ? 'Duplicating…' : locked ? 'Duplicate as New Revision' : 'Duplicate Estimate'}
            </button>
          );
        })()}

        {/* Delete — only for saved estimates */}
        {editingId && isAdmin && (
          <button
            onClick={() => deleteEstimate(editingId, !!isPushed)}
            disabled={deleting}
            style={{
              width: '100%', padding: '10px', borderRadius: '10px',
              background: deleting ? 'var(--subtle-bg)' : 'rgba(248,113,113,0.08)',
              border: '1px solid rgba(248,113,113,0.2)',
              color: '#f87171', fontWeight: 700, fontSize: '12px', cursor: 'pointer',
              opacity: deleting ? 0.5 : 1,
            }}
          >
            {deleting ? 'Deleting...' : isPushed ? 'Delete Estimate (also deletes in NetSuite)' : 'Delete Estimate'}
          </button>
        )}
      </div>

      {/* Approval email — standard compose screen (E4 + the customer-email
          standard): edit recipients, bcc yourself, add a note, and see the
          exact document before it goes out. */}
      {approvalModal && (
        <EmailComposeModal
          title="Review Approval Email Before Sending"
          sendLabel="Send for Approval"
          messagePlaceholder="Optional note to the customer — added above the estimate…"
          allowSendWithoutTo
          emptyToNote="No email on file — add a contact, or it sends by SMS only if a phone is on file."
          previewKey={JSON.stringify(approvalProofSelections)}
          intro={(approvalPdfName || Object.keys(approvalProofFiles).length > 0) ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Proof picker: which linked graphics-job files ride on this
                  send. Approving the estimate then also approves those
                  jobs' proofs — one customer click for design + price. */}
              {Object.keys(approvalProofFiles).length > 0 && (
                <div style={{ padding: '10px', borderRadius: '8px', background: 'var(--bg)', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                    Include graphic proofs — customer approves design + price together
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '160px', overflowY: 'auto' }}>
                    {linkedGraphicsJobs.filter(j => approvalProofFiles[j.id]?.length).map(j => (
                      <div key={j.id}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '3px' }}>
                          {[j.job_number ? `Job #${j.job_number}` : null, j.title].filter(Boolean).join(' — ')}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          {approvalProofFiles[j.id].map(f => {
                            const checked = (approvalProofSelections[j.id] || []).includes(f.id);
                            return (
                              <label key={f.id} style={{
                                display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px',
                                borderRadius: '6px', cursor: 'pointer', fontSize: '11px',
                                background: checked ? 'rgba(59,130,246,0.08)' : 'var(--subtle-bg)',
                                border: '1px solid ' + (checked ? 'rgba(59,130,246,0.3)' : 'var(--border)'),
                                color: 'var(--text-secondary)',
                              }}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => setApprovalProofSelections(prev => {
                                    const cur = prev[j.id] || [];
                                    return {
                                      ...prev,
                                      [j.id]: checked ? cur.filter(id => id !== f.id) : [...cur, f.id],
                                    };
                                  })}
                                  style={{ accentColor: '#3b82f6' }}
                                />
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file_name}</span>
                                {f.file_type && (
                                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>{f.file_type.split('/')[1] || f.file_type}</span>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px' }}>
                    Checked files appear in the email, on the approval page, and in the attached PDF.
                    When the customer accepts, the proof is approved for production too — no separate proof send needed.
                  </div>
                </div>
              )}
              {approvalPdfName && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  📎 <b style={{ color: 'var(--text-secondary)' }}>{approvalPdfName}</b> is attached automatically — the merged estimate PDF with the linked coverage pictures, proofs, and vinyl details.
                </div>
              )}
            </div>
          ) : undefined}
          fetchPreview={fetchApprovalPreview}
          onSend={confirmSendApproval}
          onClose={() => setApprovalModal(false)}
        />
      )}

      {/* Follow-up email on a sent estimate — standard compose screen;
          sending also logs the follow-up (resets the queue's quiet clock). */}
      {followupEmailFor && (
        <EmailComposeModal
          title={`Follow Up — Estimate #${estimateHeadlineNumber(followupEmailFor)}`}
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
            width: '100%', maxWidth: '420px', background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: '14px', padding: '16px',
          }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '2px' }}>
              Log Follow-Up — #{estimateHeadlineNumber(followupNoteFor)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
              {followupNoteFor.customer_name || 'No customer'} · {fmt(followupNoteFor.grand_total)}
            </div>
            <textarea
              value={fuNote}
              onChange={e => setFuNote(e.target.value)}
              placeholder="What did the customer say? (e.g. vehicles arrive in September)"
              rows={3}
              style={{
                width: '100%', padding: '10px', borderRadius: '10px', boxSizing: 'border-box',
                border: '1px solid var(--border)', background: 'var(--input-bg)',
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
                border: '1px solid var(--border)', background: 'var(--input-bg)',
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
                  border: '1px solid var(--border)', color: 'var(--text-body)', fontWeight: 700,
                  fontSize: '13px', cursor: 'pointer',
                }}
              >Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Email the enhanced-estimate PDF — standard compose screen; the
          attachment is the same file the Estimate PDF button opens. */}
      {pdfEmailModal && (
        <EmailComposeModal
          title="Email Estimate PDF"
          sendLabel="Send PDF"
          messagePlaceholder="Optional note to the customer — shown in the email above the attached PDF…"
          fetchPreview={fetchPdfEmailPreview}
          onSend={confirmSendPdfEmail}
          onClose={() => setPdfEmailModal(false)}
        />
      )}

      {/* N4-A: Ranger-style visual catalog — add straight into the estimate */}
      <PartCatalogBrowser
        open={showCatalogBrowser}
        onClose={() => setShowCatalogBrowser(false)}
        isAdmin={isAdmin}
        initialPlatformId={vehiclePlatformId || undefined}
        initialWheelbase={vehicleWheelbase || undefined}
        initialRoof={vehicleRoof || undefined}
        onAddKit={addKitLines}
        onAdd={(p: BrowsePart) => addPartLine({
          id: p.id,
          netsuite_id: p.netsuite_id || '',
          item_number: p.item_number,
          display_name: p.display_name || p.item_number,
          description: p.marketing_description || p.description || '',
          sales_price: p.sales_price || 0,
          labor_hours: p.labor_hours || 0,
          catalog: p.catalog,
          purchase_price: p.purchase_price,
          avg_install_cost: p.avg_install_cost,
        })}
      />

      {/* "+ New part" from the search dropdown or a custom line's matcher:
          creates the item in NetSuite + the local catalog, then lands it on
          this estimate without leaving the builder. Seeded from the query —
          and, for the line flow, from what the rep already typed on the line. */}
      {createPartCtx && (() => {
        const forLine = createPartCtx.forLineKey ? lines.find(l => l.key === createPartCtx.forLineKey) : undefined;
        return (
          <CreateNetsuiteItemModal
            initialPartNumber={createPartCtx.query || forLine?.item_number || ''}
            initialDisplayName={forLine?.description || null}
            initialPrice={forLine && forLine.unit_price > 0 ? forLine.unit_price : null}
            catalog="upfit"
            chooseCatalog
            onClose={() => setCreatePartCtx(null)}
            onCreated={created => {
              const p = partFromCreated(created);
              if (createPartCtx.forLineKey) matchLineToPart(createPartCtx.forLineKey, p);
              else addPartLine(p);
              setCreatePartCtx(null);
            }}
          />
        );
      })()}
    </div>
  );
}
