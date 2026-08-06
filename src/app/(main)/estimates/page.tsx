'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePopout } from '@/components/Popout';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';
import CustomerDefaultsEditor from '@/components/CustomerDefaultsEditor';
import PhoneInput from '@/components/PhoneInput';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import { flashNote } from '@/lib/focus-note';
import { deepLinks } from '@/lib/deep-links';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';

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
  catalog?: string; // 'upfit' | 'graphics' — drives the graphics-job prompt
  // True-cost inputs for the margin strip: NetSuite part cost + the running
  // average of what installers actually charge us for this part.
  purchase_price?: number | null;
  avg_install_cost?: number | null;
}

interface LinkedGraphicsJob {
  id: string;
  job_number: string | null;
  title: string;
  status: string;
  assigned_to: string | null;
}

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
  pushed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface Customer {
  id: string;
  netsuite_id: string;
  company_name: string;
  entity_id: string;
}

type ViewMode = 'list' | 'builder';

const DEFAULT_TAX_RATE = 0.0795;
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
  const dialog = useDialog();
  const supabase = createClient();

  const [view, setView] = useState<ViewMode>('list');
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Builder state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerNsId, setCustomerNsId] = useState<string | null>(null);
  const [taxRate, setTaxRate] = useState(DEFAULT_TAX_RATE);
  const [taxExempt, setTaxExempt] = useState(false);
  const [laborRate, setLaborRate] = useState(DEFAULT_LABOR_RATE);
  const [laborOverride, setLaborOverride] = useState<number | null>(null);
  const [lines, setLines] = useState<LineItem[]>([]);
  // Margin floor (%) below which a quote gets flagged — admin-set, shared
  // with the wrap-quote builder via the quote_settings singleton.
  const [marginFloor, setMarginFloor] = useState(30);
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
  const sortedLines = estSortCol ? [...lines].sort((a, b) => {
    const av = a[estSortCol] ?? 0; const bv = b[estSortCol] ?? 0;
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return estSortDir === 'asc' ? cmp : -cmp;
  }) : lines;
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [convertingToSO, setConvertingToSO] = useState(false);
  const [sendingForApproval, setSendingForApproval] = useState(false);

  // Part search
  const [partSearch, setPartSearch] = useState('');
  const [partResults, setPartResults] = useState<Part[]>([]);
  const [partSearching, setPartSearching] = useState(false);
  const partSearchRef = useRef<HTMLInputElement>(null);

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
    const { data } = await supabase
      .from('customers')
      .select('id, netsuite_id, company_name, entity_id')
      .or(`company_name.ilike.%${q}%,entity_id.ilike.%${q}%`)
      .limit(8);
    setCustResults((data as Customer[]) || []);
    setCustSearching(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchCustomers(custSearch), 300);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [custSearch]);

  useEffect(() => {
    supabase.from('quote_settings').select('margin_floor_pct').eq('id', 1).maybeSingle()
      .then(({ data }: any) => { if (data?.margin_floor_pct != null) setMarginFloor(Number(data.margin_floor_pct)); });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, []);

  const saveMarginFloor = async (v: number) => {
    setMarginFloor(v);
    await supabase.from('quote_settings').upsert({
      id: 1, margin_floor_pct: v, updated_at: new Date().toISOString(), updated_by: user?.id || null,
    });
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
      part_id: part.id,
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

  // ── Add part as line item ──
  const addPartLine = (part: Part) => {
    const line: LineItem = {
      key: genKey(),
      part_id: part.id,
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

  // Lines with no NetSuite item id would silently vanish from the pushed
  // NetSuite Estimate (NetSuite estimate lines require a real item id — there
  // is no free-text line type), so pushing is blocked until every line is
  // matched to a catalog item.
  const unmatchedLines = lines.filter(l => !l.netsuite_item_id);

  // ── Computed totals ──
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const autoLaborHours = lines.reduce((s, l) => s + (l.labor_hours * l.quantity), 0);
  const effectiveLaborHours = laborOverride !== null ? laborOverride : autoLaborHours;
  const laborTotal = effectiveLaborHours * laborRate;
  const taxableAmount = subtotal; // Tax on parts/materials only, not labor
  const taxAmount = taxExempt ? 0 : taxableAmount * taxRate;
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
  const saveEstimate = async (status: string = 'draft') => {
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
        })),
        created_by: user?.id,
      };

      const res = await fetch('/api/estimates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (data.success) {
        if (!editingId) setEditingId(data.id);
        // Notify teammates newly @mentioned in the internal notes this save.
        if (internalNotes !== savedInternalNotesRef.current) {
          reportMentions({
            text: internalNotes,
            previousText: savedInternalNotesRef.current,
            sourceType: 'estimate_note',
            sourceId: editingId || data.id,
            contextLabel: `Estimate — ${title || customerName || 'untitled'}`,
            contextUrl: deepLinks.estimate(editingId || data.id, { flashNotes: true }),
          });
          savedInternalNotesRef.current = internalNotes;
        }
        await loadEstimates(true);
      } else {
        await dialog.alert('Save failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      await dialog.alert('Network error — please try again');
    }
    setSaving(false);
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
    if (unmatchedLines.length > 0) {
      await dialog.alert(
        `${unmatchedLines.length} line item${unmatchedLines.length !== 1 ? 's are' : ' is'} not matched to a NetSuite item: `
        + unmatchedLines.map(l => l.item_number || l.description || 'untitled line').join(', ')
        + '. NetSuite estimate lines require a real item — pick one for each line (use "Match NetSuite item" below the line) before pushing.'
      );
      return;
    }

    const confirmMsg = isSync
      ? 'Sync changes to NetSuite? This will update the existing Estimate in NetSuite.'
      : 'Push this estimate to NetSuite? This will create an Estimate record in NetSuite.';
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

  // ── Convert Estimate to Sales Order in NetSuite ──
  const sendForApproval = async () => {
    if (!editingId || sendingForApproval) return;
    if (!customerId) { await dialog.alert('Pick a customer first.'); return; }
    setSendingForApproval(true);
    // Save current state first so the sent estimate reflects the latest edits
    await saveEstimate('sent');
    const res = await fetch(`/api/estimates/${editingId}/send-for-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    setSendingForApproval(false);
    if (!res.ok) {
      await dialog.alert('Send failed: ' + (data.error || 'Unknown error'));
      return;
    }
    const emailInfo = data.dispatch?.email
      ? (data.dispatch.email.ok ? `Email sent to ${data.dispatch.email.target}` : `Email failed: ${data.dispatch.email.error || 'unknown'}`)
      : null;
    const smsInfo = data.dispatch?.sms
      ? (data.dispatch.sms.skipped
          ? `SMS skipped (provider disabled) — link still works via email`
          : data.dispatch.sms.ok
            ? `SMS sent to ${data.dispatch.sms.target}`
            : `SMS failed: ${data.dispatch.sms.error || 'unknown'}`)
      : null;
    await dialog.alert(`Approval link sent. Link: ${data.approvalUrl}\n\n${[emailInfo, smsInfo].filter(Boolean).join('\n')}`);
    loadEstimates(true);
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
      const res = await fetch('/api/estimates/convert-to-so', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateId: editingId, ...(overrideReason ? { overrideReason } : {}) }),
      });
      const data = await res.json();
      if (res.ok && data.status === 'created') {
        await dialog.alert(`Sales Order created!\nSO #: ${data.salesOrderNumber || data.salesOrderId}\nLine items: ${data.lineItemCount}${data.skippedItems ? '\nSkipped (no NS item): ' + data.skippedItems.join(', ') : ''}`);
        // Stay in the estimate so the new SO number is visible in context.
        await loadEstimates(true);
      } else if (data.status === 'already_created') {
        await dialog.alert(data.message);
      } else {
        await dialog.alert('Failed: ' + (data.error || 'Unknown error'));
      }
    } catch {
      await dialog.alert('Network error — please try again');
    }
    setConvertingToSO(false);
  };

  // ── Load customer-level operations defaults ──
  const loadCustomerDefaults = useCallback(async (cid: string | null) => {
    if (!cid) { setCustomerDefaults(null); return; }
    const { data } = await supabase
      .from('customers')
      .select('delivery_instructions, billing_contact_name, billing_contact_email, ap_email, internal_notes')
      .eq('id', cid)
      .maybeSingle();
    setCustomerDefaults(data as any || null);
  }, [supabase]);

  // ── Open estimate for editing ──
  const openEstimate = async (est: Estimate) => {
    setEditingId(est.id);
    setTitle(est.title || '');
    setNotes(est.notes || '');
    setCustomerId(est.customer_id);
    setCustomerName(est.customer_name || '');
    setCustomerNsId(est.customer_netsuite_id);
    setTaxRate(est.tax_rate || DEFAULT_TAX_RATE);
    setTaxExempt(est.tax_exempt);
    setLaborRate(est.labor_rate || DEFAULT_LABOR_RATE);
    setLaborOverride(est.labor_hours_override);

    // Load install context + line items + customer defaults in parallel
    const [{ data: fullEst }, { data: lineData }] = await Promise.all([
      supabase
        .from('estimates')
        .select('install_instructions, on_site_contact_name, on_site_contact_phone, delivery_preferences, internal_notes')
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
      catalog: l.part_id ? infoByPart[l.part_id]?.catalog : undefined,
      purchase_price: l.part_id ? infoByPart[l.part_id]?.purchase_price ?? null : null,
      avg_install_cost: l.part_id ? infoByPart[l.part_id]?.avg_install_cost ?? null : null,
    })));

    if (est.customer_id) loadCustomerDefaults(est.customer_id);
    loadLinkedGraphicsJobs(est.id);

    setView('builder');
  };

  // ── Graphics job linkage ──
  const loadLinkedGraphicsJobs = useCallback(async (estimateId: string) => {
    const { data } = await supabase
      .from('graphics_jobs')
      .select('id, job_number, title, status, assigned_to')
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
    setTaxRate(DEFAULT_TAX_RATE);
    setTaxExempt(false);
    setLaborRate(DEFAULT_LABOR_RATE);
    setLaborOverride(null);
    setLines([]);
    setPartSearch('');
    setPartResults([]);
    setCustSearch('');
    setCustResults([]);
    setInstallInstructions('');
    setOnSiteContactName('');
    setOnSiteContactPhone('');
    setDeliveryPreferences('');
    setInternalNotes('');
    savedInternalNotesRef.current = '';
    setCustomerDefaults(null);
    setLinkedGraphicsJobs([]);
    setShowGraphicsPicker(false);
    setGraphicsPickerSearch('');
    setGraphicsPickerResults([]);
  };

  // Prefill install_instructions from the customer's delivery_instructions
  // when a customer is picked on a NEW estimate (don't clobber existing
  // values on edit or when the sales rep has already typed something).
  useEffect(() => {
    if (editingId) return;
    if (!customerId) return;
    loadCustomerDefaults(customerId).then(() => {
      setInstallInstructions(prev => prev || '');
    });
  }, [customerId, editingId, loadCustomerDefaults]);

  useEffect(() => {
    if (customerDefaults?.delivery_instructions && !installInstructions && !editingId) {
      setInstallInstructions(customerDefaults.delivery_instructions);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
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

  const deleteEstimate = async (id: string, hasNsId: boolean = false) => {
    const msg = hasNsId
      ? 'Delete this estimate? This will ALSO delete it from NetSuite. This cannot be undone.'
      : 'Delete this estimate? This cannot be undone.';
    if (!(await dialog.confirm(msg, { destructive: true, confirmLabel: 'Delete' }))) return;

    setDeleting(true);
    try {
      const res = await fetch('/api/estimates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!data.success && data.error) {
        await dialog.alert('Delete failed: ' + data.error);
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
        e.estimate_number?.toLowerCase().includes(s) ||
        e.customer_name?.toLowerCase().includes(s) ||
        e.title?.toLowerCase().includes(s)
      );
    });

    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ fontSize: '22px', fontWeight: 800 }}>Estimates</div>
          <button
            onClick={() => { resetBuilder(); setView('builder'); }}
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
                          {est.title || est.estimate_number}
                        </div>
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-label)', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <span>#{est.estimate_number}</span>
                        {est.customer_name && <span>{est.customer_name}</span>}
                        <span style={{ color: 'var(--text-body)', fontWeight: 700 }}>{fmt(est.grand_total)}</span>
                        <span>{new Date(est.created_at).toLocaleDateString()}</span>
                        {est.netsuite_estimate_number && <span style={{ color: '#a78bfa' }}>NS: {est.netsuite_estimate_number}</span>}
                        {est.netsuite_so_number && <span style={{ color: '#22c55e' }}>SO: {est.netsuite_so_number}</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
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
                      setCustomerId(c.id);
                      setCustomerName(c.company_name);
                      setCustomerNsId(c.netsuite_id);
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
                    <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>{c.entity_id} · NS #{c.netsuite_id}</div>
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

      {/* ── INSTALL CONTEXT (T1.6) ── */}
      <details style={{
        marginBottom: '12px', padding: '10px 12px', borderRadius: '10px',
        background: 'var(--subtle-bg, #f8fafc)', border: '1px solid var(--border)',
      }} open={!!(installInstructions || onSiteContactName || onSiteContactPhone || deliveryPreferences || internalNotes)}>
        <summary style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary, #475569)' }}>
          Install Context
          {customerDefaults?.delivery_instructions && !installInstructions && !editingId && (
            <span style={{ marginLeft: '8px', fontSize: '10px', fontWeight: 700, color: 'var(--accent, #2563eb)' }}>
              · prefilled from customer defaults
            </span>
          )}
        </summary>
        <div style={{ marginTop: '10px', display: 'grid', gap: '8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <div>
              <div style={labelStyle}>On-site Contact Name</div>
              <input
                style={inputStyle}
                value={onSiteContactName}
                onChange={e => setOnSiteContactName(e.target.value)}
                placeholder="Name"
              />
            </div>
            <div>
              <div style={labelStyle}>On-site Contact Phone</div>
              <PhoneInput
                style={inputStyle}
                value={onSiteContactPhone}
                onChange={v => setOnSiteContactPhone(v)}
                placeholder="(555) 555-5555"
              />
            </div>
          </div>
          <div>
            <div style={labelStyle}>Install Instructions</div>
            <textarea
              style={{ ...inputStyle, minHeight: '52px', resize: 'vertical', fontFamily: 'inherit' }}
              value={installInstructions}
              onChange={e => setInstallInstructions(e.target.value)}
              placeholder="Any job-specific install notes the installer needs"
            />
          </div>
          <div>
            <div style={labelStyle}>Delivery Preferences</div>
            <input
              style={inputStyle}
              value={deliveryPreferences}
              onChange={e => setDeliveryPreferences(e.target.value)}
              placeholder="Dock hours, shipping method, etc."
            />
          </div>
          <div id="est-notes-field">
            <div style={labelStyle}>Internal Notes (ops-only)</div>
            <MentionTextArea
              style={{ ...inputStyle, minHeight: '40px', resize: 'vertical', fontFamily: 'inherit' }}
              value={internalNotes}
              onChange={setInternalNotes}
              placeholder="Not shown to the customer — @ tags a teammate"
            />
          </div>
          {customerId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
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
      </details>

      {/* Customer defaults modal */}
      {editingCustomerDefaults && customerId && (
        <CustomerDefaultsEditor
          initial={customerDefaults}
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

        {/* Part search */}
        {(
          <div style={{ position: 'relative', marginBottom: '8px' }}>
            <input
              ref={partSearchRef}
              placeholder="Search parts catalog to add..."
              value={partSearch}
              onChange={e => setPartSearch(e.target.value)}
              style={{ ...inputStyle, background: 'var(--subtle-bg)' }}
            />
            {partResults.length > 0 && (
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
              </div>
            )}
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 60px 80px 80px 60px 30px', gap: '4px', padding: '4px 0', fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase' }}>
              <div onClick={() => toggleEstSort('item_number')} style={{ cursor: 'pointer', color: estSortCol === 'item_number' ? '#60a5fa' : undefined }}>Item #{estSortIndicator('item_number')}</div>
              <div>Description</div>
              <div onClick={() => toggleEstSort('quantity')} style={{ textAlign: 'center', cursor: 'pointer', color: estSortCol === 'quantity' ? '#60a5fa' : undefined }}>Qty{estSortIndicator('quantity')}</div>
              <div onClick={() => toggleEstSort('unit_price')} style={{ textAlign: 'right', cursor: 'pointer', color: estSortCol === 'unit_price' ? '#60a5fa' : undefined }}>Price{estSortIndicator('unit_price')}</div>
              <div style={{ textAlign: 'right' }}>Total</div>
              <div onClick={() => toggleEstSort('labor_hours')} style={{ textAlign: 'center', cursor: 'pointer', color: estSortCol === 'labor_hours' ? '#60a5fa' : undefined }}>Labor{estSortIndicator('labor_hours')}</div>
              <div></div>
            </div>

            {sortedLines.map(line => {
              const unmatched = !line.netsuite_item_id;
              return (
              <div key={line.key}>
                <div
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr 2fr 60px 80px 80px 60px 30px',
                    gap: '4px', alignItems: 'center',
                    padding: '6px 0', borderBottom: unmatched ? 'none' : '1px solid var(--border)',
                  }}
                >
                  {line.is_custom ? (
                    <input
                      style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px' }}
                      value={line.item_number}
                      onChange={e => updateLine(line.key, 'item_number', e.target.value)}
                      placeholder="Item #"
                    />
                  ) : (
                    <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {line.item_number}
                    </div>
                  )}

                  {/* Editable on every line, not just custom ones — reps add
                      placement notes etc. It pushes as the NetSuite transaction
                      line's description (a per-transaction override; the item
                      record is never modified). Cleared = NetSuite falls back
                      to the item's default description. */}
                  <input
                    style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px' }}
                    value={line.description}
                    onChange={e => updateLine(line.key, 'description', e.target.value)}
                    placeholder="Description / placement notes"
                    title={line.description}
                  />


                  <input
                    type="number"
                    style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px', textAlign: 'center' }}
                    value={line.quantity}
                    onChange={e => updateLine(line.key, 'quantity', parseFloat(e.target.value) || 0)}

                    min={0}
                  />

                  <input
                    type="number"
                    style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px', textAlign: 'right' }}
                    value={line.unit_price}
                    onChange={e => updateLine(line.key, 'unit_price', parseFloat(e.target.value) || 0)}

                    step={0.01}
                  />

                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-body)', textAlign: 'right' }}>
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

                  <div style={{ fontSize: '10px', color: line.labor_hours > 0 ? '#fbbf24' : 'var(--text-label)', textAlign: 'center' }}>
                    {line.labor_hours > 0 ? `${(line.labor_hours * line.quantity).toFixed(1)}h` : '—'}
                  </div>

                  {(
                    <button
                      onClick={() => removeLine(line.key)}
                      style={{ background: 'transparent', border: 'none', color: '#f87171', fontSize: '14px', cursor: 'pointer', padding: '2px' }}
                    >
                      ×
                    </button>
                  )}
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
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                            No catalog items match. Ask an admin to add it via Parts Sync.
                          </div>
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
      {editingId && (lines.some(l => l.catalog === 'graphics') || linkedGraphicsJobs.length > 0) && (
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
            <input
              type="number"
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
            <input
              type="number"
              style={inputStyle}
              value={(taxRate * 100).toFixed(2)}
              onChange={e => setTaxRate((parseFloat(e.target.value) || 0) / 100)}
  
              step={0.01}
            />
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
              <span>Sales Tax on Parts ({(taxRate * 100).toFixed(2)}%)</span>
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
            onClick={() => saveEstimate(isPushed ? 'pushed' : 'draft')}
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

        {/* Push or Sync to NetSuite */}
        {editingId && customerNsId && lines.length > 0 && (
          <>
            <button
              onClick={() => pushToNetSuite(!!isPushed)}
              disabled={pushing || syncing || unmatchedLines.length > 0}
              title={unmatchedLines.length > 0 ? 'Match every line to a NetSuite item first' : undefined}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px',
                background: (pushing || syncing) ? 'var(--subtle-bg)' : 'rgba(167,139,250,0.15)',
                border: '1px solid rgba(167,139,250,0.3)',
                color: '#a78bfa', fontWeight: 800, fontSize: '13px',
                cursor: unmatchedLines.length > 0 ? 'not-allowed' : 'pointer',
                opacity: (pushing || syncing || unmatchedLines.length > 0) ? 0.5 : 1,
              }}
            >
              {pushing ? 'Pushing to NetSuite...' : syncing ? 'Syncing to NetSuite...' : isPushed ? 'Sync Changes to NetSuite' : 'Push to NetSuite as Estimate'}
            </button>
            {unmatchedLines.length > 0 && (
              <div style={{ fontSize: '10px', color: '#fbbf24', fontWeight: 700, textAlign: 'center', marginTop: '-2px' }}>
                {unmatchedLines.length} line{unmatchedLines.length !== 1 ? 's' : ''} need a NetSuite item match before pushing
              </div>
            )}
          </>
        )}

        {/* Send for Customer Approval (magic link) */}
        {editingId && customerId && lines.length > 0 && !(estimates.find(e => e.id === editingId) as any)?.customer_approved && (
          <button
            onClick={sendForApproval}
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
            {deleting ? 'Deleting...' : isPushed ? '🗑️ Delete Estimate (Supabase + NetSuite)' : '🗑️ Delete Estimate'}
          </button>
        )}
      </div>
    </div>
  );
}
