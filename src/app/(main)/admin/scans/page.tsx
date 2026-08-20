'use client';

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { PartLabel } from '@/components/PartLabel';
import { DropZone } from '@/components/DropZone';
import { CreateNetsuiteItemModal, type CreatedPart } from '@/components/CreateNetsuiteItemModal';
import EmailInvoicesModal, { type EmailableInvoice } from '@/components/EmailInvoicesModal';
import PhoneInput from '@/components/PhoneInput';
import { theme } from '@/lib/theme';
import { locationBillingOverride } from '@/lib/scan-billing';
import { findExistingScanVins, sameVehicleVin, vinTail, fetchScansMatchingVins, pickScanForLine } from '@/lib/vin-match';
import { scanLifecycle } from '@/lib/scan-state';
import { customerRequiresPo, loadBillableCustomers, matchesBillableCustomer, DEFAULT_BILLABLE_CUSTOMERS, type BillableCustomer } from '@/lib/billable-customers';
import { decodeVinsBatch } from '@/lib/vin-decoder';
import { storage } from '@/lib/storage';
import { fetchAllRows } from '@/lib/fetch-all';

interface ScanLog {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  part_number: string | null;
  part_description: string | null;
  billable_customer: string | null;
  unit_number: string | null;
  serial_number: string | null;
  imei: string | null;
  iccid: string | null;
  location_name: string | null;
  po_id: string | null;
  po_number: string | null;
  po_line_item_id: string | null;
  scanned_by: string | null;
  scanned_by_company: string | null;
  scanned_at: string;
  exported_at: string | null;
  exported_by: string | null;
  archived_at: string | null;
  invoice_number?: string | null;
  date_invoiced?: string | null;
  is_paid?: boolean;
  requires_po?: boolean;
  install_cost?: number | null;
  installer_name?: string | null;
  vendor_invoice_id?: string | null;
}

type ViewTab = 'all' | 'ready' | 'waiting' | 'exported' | 'archived' | 'bulk' | 'vendor';

// Local calendar date (YYYY-MM-DD) — scan date filters work in the user's day,
// matching how the dashboard counts "scans today".
const toLocalDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function AdminScansPage() {
  const { user } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();

  const [scans, setScans] = useState<ScanLog[]>([]);
  const [archivedScans, setArchivedScans] = useState<ScanLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ViewTab>('ready');
  const [search, setSearch] = useState('');
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [selectedScans, setSelectedScans] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [matching, setMatching] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Part requires_po_match lookup
  const [poRequired, setPoRequired] = useState<Record<string, boolean>>({});
  // Customer-level PO waiver: invoice-first customers (billable_customers.
  // requires_po = FALSE, e.g. Reading Truck) skip Waiting for PO entirely.
  const [billableCustomers, setBillableCustomers] = useState<BillableCustomer[]>(DEFAULT_BILLABLE_CUSTOMERS);
  // scan_log_id → completion-photo storage paths (K8), loaded after the list.
  const [photosByScanId, setPhotosByScanId] = useState<Record<string, string[]>>({});
  // scan_log_id → CNI job number, for the source column/filter (a scan is "CNI"
  // when a cni_job_vins row points at it). See docs/cni-redesign.md §3.4.
  const [cniByScanId, setCniByScanId] = useState<Record<string, string>>({});
  // Attribution context for CNI scans: the job's assigned company name and who
  // completed the VIN — inputs to the installer derivation below.
  const [cniCompanyByScanId, setCniCompanyByScanId] = useState<Record<string, string>>({});
  const [cniCompletedByScanId, setCniCompletedByScanId] = useState<Record<string, string>>({});
  // scan_log_id → crew credited for the install (live install_credits rows) —
  // the authoritative "who did the work" record (docs/pay-splits-design.md),
  // which survives admin re-tagging of the crew.
  const [crewByScanId, setCrewByScanId] = useState<Record<string, string[]>>({});
  // profile id → their company + whether they're an installer-type account
  // (CNI installer / field installer) rather than office staff. Drives the
  // scanner fallback: a self-scanning installer counts as the installer, an
  // admin logging on a crew's behalf never does.
  const [profileMeta, setProfileMeta] = useState<Record<string, { companyId: string | null; installer: boolean }>>({});
  const [sourceFilter, setSourceFilter] = useState<'all' | 'cni' | 'field'>('all');
  // Filters work off the ATTRIBUTED installer/company (credits crew, CNI job
  // company, vendor stamp — see installerIdsOf/installerCompanyOf), not the
  // account that logged the scan; scannerFilter covers the latter separately.
  // Internal BMG work carries no company — matched via the sentinel below.
  const BMG_COMPANY = '__bmg_internal__';
  const [scannerFilter, setScannerFilter] = useState('');
  const [installerFilter, setInstallerFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  // All Scans tab ordering: newest first, or grouped A→Z by installer company
  // or installer (ties fall back to newest first).
  const [sortBy, setSortBy] = useState<'date' | 'company' | 'installer'>('date');
  // Date-range filter for the All Scans tab (local YYYY-MM-DD, '' = unbounded)
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const searchParams = useSearchParams();

  // Deep links: ?tab=all&range=today|7d|30d (dashboard stats) or explicit
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD.
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && ['all', 'ready', 'waiting', 'exported', 'archived', 'bulk', 'vendor'].includes(t)) setTab(t as ViewTab);
    const range = searchParams.get('range');
    if (range === 'today' || range === '7d' || range === '30d') {
      const today = new Date();
      const start = new Date(today);
      if (range === '7d') start.setDate(start.getDate() - 6);
      if (range === '30d') start.setDate(start.getDate() - 29);
      setDateFrom(toLocalDateStr(start));
      setDateTo(toLocalDateStr(today));
    } else {
      const from = searchParams.get('from');
      const to = searchParams.get('to');
      if (from) setDateFrom(from);
      if (to) setDateTo(to);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read the URL once on mount
  }, []);

  // Bulk upload state
  const [allParts, setAllParts] = useState<{ id: string; item_number: string; display_name: string | null; billable_customer: string | null; vehicle_type: string | null; graphic_package: string | null }[]>([]);
  const [allLocations, setAllLocations] = useState<{ id: string; name: string }[]>([]);
  const [bulkParts, setBulkParts] = useState<{ id: string; label: string; partNumber: string; description: string | null; customer: string | null }[]>([]);
  const [bulkPartSearch, setBulkPartSearch] = useState('');
  const [bulkLocation, setBulkLocation] = useState<string>('');
  const [bulkCustomer, setBulkCustomer] = useState('');
  // Vendor (CNI company) doing the installs — stamps installer_name on the
  // bulk-created scans so costs and reports attribute correctly.
  const [bulkVendor, setBulkVendor] = useState('');
  const [vendorCompanies, setVendorCompanies] = useState<{ id: string; name: string }[]>([]);
  const [custMatches, setCustMatches] = useState<{ id: string; company_name: string; entity_id: string | null }[]>([]);
  const [showCustDropdown, setShowCustDropdown] = useState(false);
  const [createItemFor, setCreateItemFor] = useState<string | null>(null);
  const [bulkVins, setBulkVins] = useState('');
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<{ success: number; failed: number; skipped?: number } | null>(null);
  const [scanningWorksheet, setScanningWorksheet] = useState(false);
  // Each worksheet page is reviewed independently — multi-page PDFs are a
  // week's worth of separate jobs, each with its own part number and VINs.
  type WSRow = { row_number: number; partial_vin: string; unit_number: string | null; include: boolean };
  type WSPage = { page: number; header: any; rows: WSRow[]; notes: string | null };
  const [worksheetReview, setWorksheetReview] = useState<{ pages: WSPage[] } | null>(null);
  const [worksheetCommitting, setWorksheetCommitting] = useState(false);
  const [worksheetNotes, setWorksheetNotes] = useState<string | null>(null);

  // Direct invoice state
  const [invoicing, setInvoicing] = useState(false);
  const [invoiceResult, setInvoiceResult] = useState<{ results: { customer: string; po?: string | null; invoiceId?: string; invoiceNumber?: string; vehicleCount: number; status: string; error?: string }[]; summary: { success: number; errors: number } } | null>(null);
  // Email-invoices flow lives in the shared EmailInvoicesModal.
  const [emailTarget, setEmailTarget] = useState<{ customerName: string; invoices: EmailableInvoice[] } | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { loadAll(); }, []);

  // Debounced NetSuite customer search for the bulk-upload Customer field
  useEffect(() => {
    const q = bulkCustomer.trim();
    if (q.length < 2) { setCustMatches([]); return; }
    const t = setTimeout(async () => {
      const escaped = q.replace(/[%,()]/g, ' ');
      const { data } = await supabase
        .from('customers')
        .select('id, company_name, entity_id')
        .or(`company_name.ilike.%${escaped}%,entity_id.ilike.%${escaped}%`)
        .order('company_name')
        .limit(8);
      setCustMatches((data || []) as { id: string; company_name: string; entity_id: string | null }[]);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [bulkCustomer]);

  const loadAll = async () => {
    setLoading(true);
    loadBillableCustomers(supabase).then(setBillableCustomers);
    const [scansRes, archivedRes, profilesRes, partsRes, fullPartsRes, locsRes, posRes, cniVinsRes, companiesRes, creditsRes] = await Promise.all([
      supabase.from('scan_logs').select('*').is('archived_at', null).order('scanned_at', { ascending: false }).limit(1000),
      // Paginate archived scans — Supabase caps responses at 1000 rows by default
      (async () => {
        let all: any[] = [];
        let pg = 0;
        let more = true;
        while (more) {
          const { data } = await supabase
            .from('scan_logs').select('*')
            .not('archived_at', 'is', null)
            .order('archived_at', { ascending: false })
            .range(pg * 1000, (pg + 1) * 1000 - 1);
          all = [...all, ...(data || [])];
          more = (data || []).length === 1000;
          pg++;
        }
        return { data: all };
      })(),
      supabase.from('profiles').select('id, full_name, role, roles, is_field_installer, company_id'),
      // Paginated: a truncated map shows "Waiting on PO" for scans whose
      // no-PO part sorts past the 1000-row cap.
      fetchAllRows<{ item_number: string; requires_po_match: boolean | null }>((from, to) =>
        supabase.from('netsuite_parts').select('item_number, requires_po_match').order('id').range(from, to)),
      // All active parts — paginate to get all
      (async () => {
        let all: any[] = [];
        let pg = 0;
        let more = true;
        while (more) {
          const { data } = await supabase.from('netsuite_parts').select('id, item_number, display_name, billable_customer, vehicle_type, graphic_package').eq('is_active', true).order('item_number').range(pg * 1000, (pg + 1) * 1000 - 1);
          all = [...all, ...(data || [])];
          more = (data || []).length === 1000;
          pg++;
        }
        return { data: all };
      })(),
      supabase.from('work_locations').select('id, name').eq('is_active', true).order('name'),
      supabase.from('purchase_orders').select('id, po_number, customer, line_items:po_line_items(id, part_number, quantity, installed)').in('status', ['open', 'complete']).order('po_number'),
      // CNI job VINs that produced a scan — maps scan_log_id → job number so the
      // Scan Log can flag CNI work and filter to it (§3.4). Paginated like the
      // archived scans, since this grows with every CNI vehicle completed.
      (async () => {
        let all: any[] = [];
        let pg = 0;
        let more = true;
        while (more) {
          const { data } = await supabase
            .from('cni_job_vins')
            .select('id, scan_log_id, completed_by, cni_jobs(job_number, assigned_company_id)')
            .not('scan_log_id', 'is', null)
            .range(pg * 1000, (pg + 1) * 1000 - 1);
          all = [...all, ...(data || [])];
          more = (data || []).length === 1000;
          pg++;
        }
        return { data: all };
      })(),
      // Vendor companies for the bulk tab's vendor picker (same list the
      // vendor-invoice flow uses).
      supabase.from('companies').select('id, name').order('name'),
      // Live pay credits — who was actually credited for each scanned vehicle.
      // Ordered so the pagination is stable; paginated like the other
      // per-vehicle tables since this grows with every completed install.
      (async () => {
        let all: any[] = [];
        let pg = 0;
        let more = true;
        while (more) {
          const { data } = await supabase
            .from('install_credits')
            .select('scan_log_id, cni_job_vin_id, profile_id')
            .is('voided_at', null)
            .order('created_at', { ascending: true })
            .range(pg * 1000, (pg + 1) * 1000 - 1);
          all = [...all, ...(data || [])];
          more = (data || []).length === 1000;
          pg++;
        }
        return { data: all };
      })(),
    ]);
    setAllParts((fullPartsRes.data || []) as typeof allParts);
    setAllLocations((locsRes.data || []) as typeof allLocations);
    setAllPOs((posRes.data || []) as typeof allPOs);
    setVendorCompanies((companiesRes.data || []) as { id: string; name: string }[]);

    setScans((scansRes.data || []) as ScanLog[]);
    setArchivedScans((archivedRes.data || []) as ScanLog[]);

    const pMap: Record<string, string> = {};
    const metaMap: Record<string, { companyId: string | null; installer: boolean }> = {};
    (profilesRes.data || []).forEach((p: any) => {
      pMap[p.id] = p.full_name;
      const roles: string[] = p.roles?.length ? p.roles : (p.role ? [p.role] : []);
      metaMap[p.id] = {
        companyId: p.company_id || null,
        installer: roles.includes('installer') || roles.includes('field_tech') || !!p.is_field_installer,
      };
    });
    setProfiles(pMap);
    setProfileMeta(metaMap);

    const poMap: Record<string, boolean> = {};
    (partsRes.data || []).forEach((p: any) => { poMap[p.item_number] = p.requires_po_match !== false; });
    setPoRequired(poMap);

    const companyName = new Map<string, string>((companiesRes.data || []).map((c: any) => [c.id, c.name]));
    const cniMap: Record<string, string> = {};
    const cniCompanyMap: Record<string, string> = {};
    const cniCompletedMap: Record<string, string> = {};
    // cni_job_vins row id → scan_log_id, to attach credits keyed only on the
    // VIN row (pre-scan-linkage history) to their scan.
    const scanIdByVinRowId: Record<string, string> = {};
    (cniVinsRes.data || []).forEach((r: any) => {
      if (!r.scan_log_id) return;
      // The embed is a to-one FK, but Supabase can surface it as an array.
      const job = Array.isArray(r.cni_jobs) ? r.cni_jobs[0] : r.cni_jobs;
      cniMap[r.scan_log_id] = job?.job_number || 'CNI';
      const assignedCompany = job?.assigned_company_id ? companyName.get(job.assigned_company_id) : null;
      if (assignedCompany) cniCompanyMap[r.scan_log_id] = assignedCompany;
      if (r.completed_by) cniCompletedMap[r.scan_log_id] = r.completed_by;
      if (r.id) scanIdByVinRowId[r.id] = r.scan_log_id;
    });
    setCniByScanId(cniMap);
    setCniCompanyByScanId(cniCompanyMap);
    setCniCompletedByScanId(cniCompletedMap);

    const crewMap: Record<string, string[]> = {};
    (creditsRes.data || []).forEach((c: any) => {
      const scanId = c.scan_log_id || scanIdByVinRowId[c.cni_job_vin_id || ''];
      if (!scanId || !c.profile_id) return;
      const arr = crewMap[scanId] || (crewMap[scanId] = []);
      if (!arr.includes(c.profile_id)) arr.push(c.profile_id);
    });
    setCrewByScanId(crewMap);

    setSelectedScans(new Set());
    setLoading(false);

    // Completion photos (K8) — chunked .in() over the loaded scans; non-fatal
    // and loaded after the list renders so the log itself never waits on it.
    try {
      const allIds = [...(scansRes.data || []), ...(archivedRes.data || [])].map((s: any) => s.id);
      const photoMap: Record<string, string[]> = {};
      for (let i = 0; i < allIds.length; i += 200) {
        const { data: photoRows } = await supabase
          .from('scan_photos')
          .select('scan_log_id, storage_path')
          .in('scan_log_id', allIds.slice(i, i + 200));
        for (const p of photoRows || []) {
          (photoMap[p.scan_log_id] || (photoMap[p.scan_log_id] = [])).push(p.storage_path);
        }
      }
      setPhotosByScanId(photoMap);
    } catch { /* photos are an enhancement, not required for the log */ }
  };

  const needsPO = (scan: ScanLog) =>
    poRequired[scan.part_number || ''] !== false
    && customerRequiresPo(scan.billable_customer, billableCustomers);

  // Quick-pick chips for customer fields — the same billable_customers list
  // the tech scan flow offers, so admins land on canonical NetSuite names
  // (one click for Reading Truck / Masterack) instead of retyping variants.
  // Free text stays for everyone else; clicking the active chip clears it.
  const customerQuickPick = (current: string, onPick: (name: string) => void) => (
    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
      {billableCustomers.map(c => {
        const active = matchesBillableCustomer(c, current);
        return (
          <button
            key={c.name}
            type="button"
            onMouseDown={e => e.preventDefault()}
            onClick={() => onPick(active ? '' : c.name)}
            style={{
              padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${active ? 'rgba(167,139,250,0.5)' : theme.border}`,
              background: active ? 'rgba(167,139,250,0.12)' : 'transparent',
              color: active ? '#a78bfa' : 'var(--text-muted)',
            }}
          >{c.label}</button>
        );
      })}
    </div>
  );

  // Categorize scans
  const pending = scans.filter(s => !s.exported_at);
  const readyToExport = pending.filter(s => s.po_id || !needsPO(s));
  const waitingForPO = pending.filter(s => !s.po_id && needsPO(s));
  const exported = scans.filter(s => s.exported_at);

  // Every scan regardless of lifecycle state — the All Scans tab is the raw
  // scan history (ready, waiting, exported, archived, invoiced) in one list.
  const allScans = [...scans, ...archivedScans]
    .sort((a, b) => new Date(b.scanned_at).getTime() - new Date(a.scanned_at).getTime());

  // Lifecycle chip for the All Scans tab — labels come from the shared
  // scanLifecycle derivation; this only adds colors.
  const scanStatus = (s: ScanLog) => {
    const { state, label } = scanLifecycle(s, (part, cust) =>
      poRequired[part || ''] !== false && customerRequiresPo(cust, billableCustomers));
    if (state === 'invoiced') {
      return s.is_paid
        ? { label, color: '#4ade80', bg: 'rgba(74,222,128,0.12)' }
        : { label, color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' };
    }
    const styles = {
      archived: { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
      exported: { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
      ready: { color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
      waiting: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    } as const;
    return { label, ...styles[state] };
  };

  const getTabScans = () => {
    if (tab === 'all') return allScans;
    if (tab === 'ready') return readyToExport;
    if (tab === 'waiting') return waitingForPO;
    if (tab === 'exported') return exported;
    if (tab === 'archived') return archivedScans;
    return [];
  };

  // The scan-list chrome (search, filters, empty state, grouped list) applies
  // to every tab except the two self-contained upload tabs.
  const isScanListTab = tab !== 'bulk' && tab !== 'vendor';

  // ── Installer attribution ─────────────────────────────────────────────
  // A scan's "installer" is whoever was CREDITED for the install (the live
  // install_credits crew), not whoever happened to log it — an admin
  // scanning or bulk-uploading on a crew's behalf stays on record as the
  // scanner but is never presented as the installer. Fallbacks when no
  // credits exist: the CNI VIN's completed_by, then the scanner themselves
  // but only if they're an installer-type account.
  const companyNameById: Record<string, string> = Object.fromEntries(vendorCompanies.map(c => [c.id, c.name]));
  const installerIdsOf = (s: ScanLog): string[] => {
    const crew = crewByScanId[s.id];
    if (crew && crew.length > 0) return crew;
    const completedBy = cniCompletedByScanId[s.id];
    if (completedBy) return [completedBy];
    if (s.scanned_by && profileMeta[s.scanned_by]?.installer) return [s.scanned_by];
    return [];
  };
  const installerNamesOf = (s: ScanLog): string[] =>
    installerIdsOf(s).map(id => profiles[id]).filter(Boolean);
  // The company that did the install: the CNI job's assigned company, the
  // vendor stamped by bulk upload / vendor invoices, the scanner's own
  // company (installer self-scans), then the credited crew's company.
  // Null = BMG's own (internal) work.
  const installerCompanyOf = (s: ScanLog): string | null => {
    if (cniCompanyByScanId[s.id]) return cniCompanyByScanId[s.id];
    if (s.installer_name) return s.installer_name;
    if (s.scanned_by_company) return s.scanned_by_company;
    for (const id of installerIdsOf(s)) {
      const companyId = profileMeta[id]?.companyId;
      if (companyId && companyNameById[companyId]) return companyNameById[companyId];
    }
    return null;
  };

  // Dropdown options: every installer, company, and scanner that appears in
  // the loaded scans (live + archived), so the filters always offer what's
  // actually there.
  const allLoadedScans = [...scans, ...archivedScans];
  const installerOptions = (() => {
    const ids = new Set<string>();
    for (const s of allLoadedScans) for (const id of installerIdsOf(s)) ids.add(id);
    return [...ids]
      .map(id => {
        const companyId = profileMeta[id]?.companyId;
        return { id, name: profiles[id] || 'Unknown', company: (companyId && companyNameById[companyId]) || null };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  })();
  const scannerOptions = [...new Set(allLoadedScans.map(s => s.scanned_by).filter(Boolean) as string[])]
    .map(id => ({ id, name: profiles[id] || 'Unknown' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const companyOptions = [...new Set(allLoadedScans.map(installerCompanyOf).filter(Boolean) as string[])].sort();
  const NO_LOCATION = '__none__';
  const locationOptions = [...new Set(allLoadedScans.map(s => s.location_name).filter(Boolean) as string[])].sort();

  const tabScans = getTabScans().filter(s => {
    // Source filter: CNI scans are the ones a cni_job_vins row points at.
    if (sourceFilter === 'cni' && !cniByScanId[s.id]) return false;
    if (sourceFilter === 'field' && cniByScanId[s.id]) return false;
    // Who did the work (attributed installer + their company) and, separately,
    // who logged the scan. BMG's own installs carry no company — the BMG
    // option matches those rows.
    if (installerFilter && !installerIdsOf(s).includes(installerFilter)) return false;
    if (scannerFilter && s.scanned_by !== scannerFilter) return false;
    const installerCompany = installerCompanyOf(s);
    if (companyFilter === BMG_COMPANY && installerCompany) return false;
    if (companyFilter && companyFilter !== BMG_COMPANY && installerCompany !== companyFilter) return false;
    // Location filter ("No location" matches scans with none recorded).
    if (locationFilter === NO_LOCATION && s.location_name) return false;
    if (locationFilter && locationFilter !== NO_LOCATION && s.location_name !== locationFilter) return false;
    // Date-range filter (All Scans tab) compares local calendar dates.
    if (tab === 'all' && (dateFrom || dateTo)) {
      const day = toLocalDateStr(new Date(s.scanned_at));
      if (dateFrom && day < dateFrom) return false;
      if (dateTo && day > dateTo) return false;
    }
    if (!search) return true;
    const q = search.toLowerCase();
    return s.vin.toLowerCase().includes(q) ||
      s.part_number?.toLowerCase().includes(q) ||
      s.billable_customer?.toLowerCase().includes(q) ||
      s.unit_number?.toLowerCase().includes(q) ||
      s.location_name?.toLowerCase().includes(q) ||
      s.po_number?.toLowerCase().includes(q) ||
      (cniByScanId[s.id] || '').toLowerCase().includes(q) ||
      installerNamesOf(s).join(' ').toLowerCase().includes(q) ||
      (installerCompanyOf(s) || '').toLowerCase().includes(q) ||
      (profiles[s.scanned_by || ''] || '').toLowerCase().includes(q) ||
      (s.scanned_by_company || '').toLowerCase().includes(q) ||
      [s.vehicle_year, s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ').toLowerCase().includes(q);
  });

  // Sort — All Scans tab only (the other tabs group by customer/part).
  // Company/installer sorts run A→Z with newest-first inside equal keys;
  // unattributed rows sink to the bottom.
  if (tab === 'all' && sortBy !== 'date') {
    const keyOf = (s: ScanLog) =>
      sortBy === 'company' ? (installerCompanyOf(s) || '') : (installerNamesOf(s)[0] || '');
    tabScans.sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka !== kb) {
        if (!ka) return 1;
        if (!kb) return -1;
        return ka.localeCompare(kb);
      }
      return new Date(b.scanned_at).getTime() - new Date(a.scanned_at).getTime();
    });
  }

  // Group by billable customer → PO (ready tab) or part + location (other tabs)
  const grouped = tabScans.reduce((acc: Record<string, Record<string, ScanLog[]>>, s) => {
    const customer = s.billable_customer || 'No Customer';
    let subKey: string;
    if (tab === 'ready' && s.po_number) {
      // Ready tab: group by PO so one invoice = one PO with multiple part lines
      subKey = `PO #${s.po_number}`;
    } else {
      const poSuffix = tab === 'archived' && s.po_number ? ` · PO #${s.po_number}` : '';
      // On the archived tab, include invoice_number in the key so scans invoiced on
      // different invoices don't lump into the same visual sub-group (even if they
      // share the same part · location · PO).
      const invSuffix = tab === 'archived' && s.invoice_number ? ` · ${s.invoice_number}` : '';
      subKey = `${s.part_number || 'No Part'} · ${s.location_name || 'No Location'}${poSuffix}${invSuffix}`;
    }
    if (!acc[customer]) acc[customer] = {};
    if (!acc[customer][subKey]) acc[customer][subKey] = [];
    acc[customer][subKey].push(s);
    return acc;
  }, {});
  // Compare two invoice numbers numerically when possible, else lexicographically.
  // Returns positive if b > a (so a sorts after b, i.e. highest first).
  const compareInvoice = (a: string, b: string) => {
    const an = parseFloat(a.replace(/[^0-9.]/g, ''));
    const bn = parseFloat(b.replace(/[^0-9.]/g, ''));
    if (!isNaN(an) && !isNaN(bn) && an !== bn) return bn - an;
    return b.localeCompare(a);
  };

  const maxInvoiceIn = (list: ScanLog[]): string => {
    let max = '';
    for (const s of list) {
      const inv = s.invoice_number || '';
      if (inv && (!max || compareInvoice(inv, max) < 0)) max = inv;
    }
    return max;
  };

  const customerKeys = Object.keys(grouped).sort((a, b) => {
    if (a === 'No Customer') return 1;
    if (b === 'No Customer') return -1;
    if (tab === 'archived') {
      const aMax = maxInvoiceIn(Object.values(grouped[a]).flat());
      const bMax = maxInvoiceIn(Object.values(grouped[b]).flat());
      if (aMax && bMax) return compareInvoice(aMax, bMax);
      if (aMax) return -1;
      if (bMax) return 1;
    }
    return a.localeCompare(b);
  });

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  };

  const toggleSelectGroup = (ids: string[]) => {
    setSelectedScans(prev => {
      const n = new Set(prev);
      const allSelected = ids.every(id => n.has(id));
      if (allSelected) { ids.forEach(id => n.delete(id)); } else { ids.forEach(id => n.add(id)); }
      return n;
    });
  };

  const toggleSelect = (id: string) => {
    setSelectedScans(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const selectAllVisible = () => {
    if (selectedScans.size === tabScans.length) setSelectedScans(new Set());
    else setSelectedScans(new Set(tabScans.map(s => s.id)));
  };

  // Trigger retroactive PO matching
  const runAutoMatch = async () => {
    setMatching(true);
    try {
      const res = await fetch('/api/scans/match-po', { method: 'POST' });
      const data = await res.json();
      await dialog.alert(`Matched ${data.matched} of ${data.total} unmatched scans`);
      await loadAll();
    } catch {
      await dialog.alert('Match failed');
    }
    setMatching(false);
  };

  // Build and download a CSV of the given scans. Shared by the workflow
  // export (selected scans, stamps exported_at) and the plain filtered
  // download (whatever the current filters show, stamps nothing).
  const downloadScansCsv = async (rows: ScanLog[]) => {
    // Vendor columns come from the invoice-recording stamps on the scan
    // itself (install_cost = newest priced line, installer_name,
    // vendor_invoice_id — see restampScans) rather than re-deriving from
    // lines; only the invoice number/total need one extra fetch. Invoice
    // Total covers grand-total-only invoices that have no per-VIN pricing.
    const invById = new Map<string, { vendor_name: string | null; invoice_number: string | null; total_amount: number | null }>();
    try {
      const invoiceIds = [...new Set(rows.map(s => s.vendor_invoice_id).filter((id): id is string => !!id))];
      if (invoiceIds.length > 0) {
        const { data: invs } = await supabase
          .from('vendor_invoices')
          .select('id, vendor_name, invoice_number, total_amount')
          .in('id', invoiceIds);
        for (const inv of invs || []) invById.set(inv.id, { vendor_name: inv.vendor_name, invoice_number: inv.invoice_number, total_amount: inv.total_amount });
      }
    } catch { /* vendor columns are best-effort — the export still works */ }

    const headers = ['VIN', 'Year', 'Make', 'Model', 'Part Number', 'Description', 'Billable Customer', 'Unit #', 'Serial #', 'IMEI', 'CCID', 'Location', 'PO Number', 'Vendor', 'Vendor Invoice #', 'Vendor Cost', 'Vendor Invoice Total', 'CNI Job', 'Installer(s)', 'Installer Company', 'Scanned By', 'Scanner Company', 'Date', 'Status'];
    const data = rows.map(s => {
      const inv = invById.get(s.vendor_invoice_id || '');
      return [
        s.vin, s.vehicle_year || '', s.vehicle_make || '', s.vehicle_model || '',
        s.part_number || '', s.part_description || '', s.billable_customer || '',
        s.unit_number || '', s.serial_number || '', s.imei || '', s.iccid || '',
        s.location_name || '', s.po_number || '',
        s.installer_name || inv?.vendor_name || '', inv?.invoice_number || '',
        s.install_cost != null ? Number(s.install_cost).toFixed(2) : '',
        inv?.total_amount != null ? Number(inv.total_amount).toFixed(2) : '',
        cniByScanId[s.id] || '',
        installerNamesOf(s).join('; '), installerCompanyOf(s) || 'BMG',
        profiles[s.scanned_by || ''] || '', s.scanned_by_company || 'BMG', new Date(s.scanned_at).toLocaleString(),
        scanStatus(s).label,
      ];
    });
    const csv = [headers, ...data].map(r => r.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scans-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Workflow export: download the SELECTED scans and stamp them exported so
  // they move to the Exported tab.
  const exportCSV = async () => {
    const toExport = tabScans.filter(s => selectedScans.has(s.id));
    if (toExport.length === 0) return;
    setExporting(true);
    await downloadScansCsv(toExport);
    await supabase.from('scan_logs').update({ exported_at: new Date().toISOString(), exported_by: user?.id }).in('id', toExport.map(s => s.id));
    setExporting(false);
    loadAll();
  };

  // Plain download of everything the current tab + filters show (source,
  // user, company, date range, search). Deliberately does NOT stamp
  // exported_at — it's a report, not the invoicing workflow.
  const downloadFilteredCsv = async () => {
    if (tabScans.length === 0) return;
    await downloadScansCsv(tabScans);
  };

  const archiveExported = async () => {
    const ids = [...selectedScans];
    if (ids.length === 0) return;
    await supabase.from('scan_logs').update({ archived_at: new Date().toISOString() }).in('id', ids);
    loadAll();
  };

  const unarchiveScans = async () => {
    const ids = [...selectedScans];
    if (ids.length === 0) return;
    await supabase.from('scan_logs').update({ archived_at: null }).in('id', ids);
    loadAll();
  };

  // Un-export: put scans back into the invoicing workflow. exported_at is
  // load-bearing — it removes a scan from the invoice queue, the Ready/
  // Waiting ops counts, and de-prioritizes it in PO auto-matching — so the
  // confirm spells out the consequences, and the write goes through
  // bulk-update for the audit trail.
  const unexportScans = async () => {
    const ids = [...selectedScans];
    if (ids.length === 0) return;
    const invoicedCount = tabScans.filter(s => selectedScans.has(s.id) && s.invoice_number).length;
    const msg =
      `Un-export ${ids.length} scan${ids.length !== 1 ? 's' : ''}? They return to the Ready/Waiting queues and count as uninvoiced work again (invoice page, ops dashboard, PO auto-match).` +
      (invoicedCount > 0 ? `\n\n${invoicedCount} of them already carry an invoice # — un-exporting does NOT undo the NetSuite invoice, it only re-queues the scan.` : '');
    if (!(await dialog.confirm(msg))) return;
    const res = await fetch('/api/scans/bulk-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanIds: ids, updates: { exported_at: null, exported_by: null } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      await dialog.alert(`Un-export failed: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    setSelectedScans(new Set());
    loadAll();
  };

  // Create direct invoice in NetSuite (no PO/SO needed)
  const createInvoice = async () => {
    const ids = [...selectedScans];
    if (ids.length === 0) return;
    if (!(await dialog.confirm(`Create NetSuite invoice for ${ids.length} scan${ids.length !== 1 ? 's' : ''}? This will bill the customer directly.`))) return;
    setInvoicing(true);
    setInvoiceResult(null);
    try {
      const res = await fetch('/api/netsuite/invoice-vehicles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert(`Invoice failed: ${data.error || 'Unknown error'}`);
      } else {
        setInvoiceResult(data);

        // The endpoint now stamps invoice_number / date_invoiced / archived_at
        // (plus exported_at) on each successfully invoiced group itself, so
        // there's no client-side follow-up call to keep in sync (§3.3).
        loadAll();
      }
    } catch (e: any) {
      await dialog.alert(`Invoice failed: ${e.message}`);
    }
    setInvoicing(false);
  };

  // Edit scan
  const [editingScan, setEditingScan] = useState<ScanLog | null>(null);
  const saveEditScan = async () => {
    if (!editingScan) return;
    const { id, vin, vehicle_year, vehicle_make, vehicle_model, part_number, part_description, billable_customer, unit_number, serial_number, imei, iccid, location_name } = editingScan;
    await supabase.from('scan_logs').update({ vin, vehicle_year, vehicle_make, vehicle_model, part_number, part_description, billable_customer, unit_number, serial_number: serial_number || null, imei: imei || null, iccid: iccid || null, location_name }).eq('id', id);
    setEditingScan(null);
    loadAll();
  };

  // Delete — via the server route, which also removes the scan's unpaid pay
  // credits (a direct scan_logs delete is refused by the credits FK, which is
  // why deletes used to silently do nothing).
  const deleteScans = async (ids: string[]): Promise<void> => {
    try {
      const res = await fetch('/api/scans/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        await dialog.alert(`Delete failed: ${data.error || `request failed (${res.status})`}`);
      } else if ((data.blocked || []).length > 0) {
        const vins = data.blocked.map((b: any) => b.vin).filter(Boolean).join(', ');
        await dialog.alert(
          `${data.blocked.length} scan${data.blocked.length !== 1 ? 's' : ''} not deleted — pay credits are already on a payout${vins ? ` (${vins})` : ''}. Remove them from the payout first.`,
        );
      }
    } catch (err: any) {
      await dialog.alert(`Delete failed: ${err.message || 'network error'}`);
    }
  };

  const deleteScan = async (id: string) => {
    if (!(await dialog.confirm('Delete this scan?', { destructive: true, confirmLabel: 'Delete' }))) return;
    await deleteScans([id]);
    loadAll();
  };

  const bulkDelete = async () => {
    const count = selectedScans.size;
    if (count === 0) return;
    if (!(await dialog.confirm(`Delete ${count} scan${count !== 1 ? 's' : ''}? This cannot be undone.`, { destructive: true, confirmLabel: 'Delete' }))) return;
    await deleteScans([...selectedScans]);
    setSelectedScans(new Set());
    loadAll();
  };

  // Bulk edit — apply part/customer/location to all selected
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [bulkEditPart, setBulkEditPart] = useState('');
  const [bulkEditPartPicked, setBulkEditPartPicked] = useState<{ id: string; item_number: string; display_name: string | null; billable_customer: string | null } | null>(null);
  const [bulkEditCustomer, setBulkEditCustomer] = useState('');
  const [bulkEditLocation, setBulkEditLocation] = useState('');
  const [bulkEditPO, setBulkEditPO] = useState('');
  const [allPOs, setAllPOs] = useState<{ id: string; po_number: string; customer: string; line_items: { id: string; part_number: string; quantity: number; installed: number }[] }[]>([]);
  const applyBulkEdit = async () => {
    const ids = [...selectedScans];
    if (ids.length === 0) return;
    const updates: any = {};
    if (bulkEditPart) {
      if (bulkEditPartPicked) {
        updates.part_number = bulkEditPartPicked.item_number;
        updates.part_description = bulkEditPartPicked.display_name;
        if (!bulkEditCustomer) updates.billable_customer = bulkEditPartPicked.billable_customer;
      } else {
        updates.part_number = bulkEditPart.trim();
      }
    }
    if (bulkEditCustomer) updates.billable_customer = bulkEditCustomer;
    if (bulkEditLocation) {
      const loc = allLocations.find(l => l.id === bulkEditLocation);
      if (loc) { updates.location_id = loc.id; updates.location_name = loc.name; }
    }
    if (bulkEditPO) {
      if (bulkEditPO === '__clear__') {
        updates.po_id = null;
        updates.po_number = null;
        updates.po_line_item_id = null;
      } else {
        const po = allPOs.find(p => p.id === bulkEditPO);
        if (po) {
          updates.po_id = po.id;
          updates.po_number = po.po_number;
          // Try to match line item by part number from first selected scan
          const firstScan = scans.find(s => ids.includes(s.id)) || archivedScans.find(s => ids.includes(s.id));
          const matchedLine = firstScan?.part_number
            ? po.line_items.find(li => li.part_number.toUpperCase() === firstScan.part_number!.toUpperCase())
            : null;
          updates.po_line_item_id = matchedLine?.id || null;
        }
      }
    }
    if (Object.keys(updates).length === 0) { setShowBulkEdit(false); return; }
    try {
      const res = await fetch('/api/scans/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanIds: ids, updates }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        await dialog.alert(`Failed to update: ${data.error || 'Unknown error'}`);
        return;
      }
    } catch (err: any) {
      await dialog.alert(`Update failed: ${err.message}`);
      return;
    }
    setShowBulkEdit(false);
    setBulkEditPart('');
    setBulkEditPartPicked(null);
    setBulkEditCustomer('');
    setBulkEditLocation('');
    setBulkEditPO('');
    loadAll();
  };

  // Bulk upload handler
  // Insert scans for each worksheet page using that page's own part
  // numbers and customer. Multi-page worksheets are typically a week's
  // worth of separate jobs, so we never merge pages together.
  const commitWorksheetPages = async () => {
    if (!worksheetReview) return;
    setWorksheetCommitting(true);
    let totalInserted = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    const selectedLoc = allLocations.find(l => l.id === bulkLocation);
    const locationOverrideCustomer = locationBillingOverride(selectedLoc?.name);

    try {
      for (const pg of worksheetReview.pages) {
        const vins = pg.rows
          .filter(r => r.include && r.partial_vin)
          .map(r => r.partial_vin.trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, ''))
          .filter(v => v.length >= 5);
        if (vins.length === 0) continue;

        const partNumberTokens = (pg.header.part_number || '')
          .split('/').map((p: string) => p.trim()).filter(Boolean);
        const matchedParts = partNumberTokens
          .map((pn: string) => allParts.find(p => p.item_number.toUpperCase().includes(pn.toUpperCase())))
          .filter(Boolean) as typeof allParts;
        // Fall back to a single null entry if no parts match — the scan
        // still gets recorded with the raw VIN, just unmatched.
        const partsToProcess: (typeof allParts[0] | null)[] = matchedParts.length > 0 ? matchedParts : [null];

        // Find unit_number per VIN from this page's rows.
        const unitByVin: Record<string, string | null> = {};
        for (const r of pg.rows) {
          if (!r.include || !r.partial_vin) continue;
          const cleaned = r.partial_vin.trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, '');
          if (cleaned) unitByVin[cleaned] = r.unit_number || null;
        }

        // Dedup against existing scan_logs rows on this page's parts —
        // matched on the VIN's last 8 so partial worksheet entries collide
        // with full scans of the same vehicle (and with repeats on the page).
        const vinPartPairs: { vin: string; part: typeof partsToProcess[0] }[] = [];
        for (const part of partsToProcess) {
          const partNum = part?.item_number || '';
          const existingScanVins = await findExistingScanVins(supabase, vins, partNum || null);
          const seenTails = new Set<string>();
          for (const vin of vins) {
            if (existingScanVins.some(e => sameVehicleVin(e, vin)) || seenTails.has(vinTail(vin))) {
              totalSkipped++;
            } else {
              seenTails.add(vinTail(vin));
              vinPartPairs.push({ vin, part });
            }
          }
        }

        for (const { vin, part } of vinPartPairs) {
          let vehicleData: any = {};
          try {
            const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${vin}?format=json`);
            const json = await res.json();
            const results = json.Results || [];
            const get = (id: number) => results.find((r: any) => r.VariableId === id)?.Value || null;
            vehicleData = { vehicle_year: get(29), vehicle_make: get(26), vehicle_model: get(28), vehicle_trim: get(38), body_class: get(5) };
          } catch {}

          const { error } = await supabase.from('scan_logs').insert({
            vin,
            ...vehicleData,
            part_number: part?.item_number || null,
            part_description: part?.display_name || null,
            // The worksheet's own customer beats the location default —
            // Reading work happens inside Masterack buildings now, so the
            // location can only fill in when the document names nobody.
            billable_customer: pg.header.customer || locationOverrideCustomer || part?.billable_customer || null,
            unit_number: unitByVin[vin] || null,
            location_id: selectedLoc?.id || null,
            location_name: selectedLoc?.name || null,
            installer_name: vendorCompanies.find(c => c.id === bulkVendor)?.name || null,
            scanned_by: user?.id,
          });
          if (error) totalFailed++; else totalInserted++;
        }
      }

      setWorksheetNotes(`Inserted ${totalInserted} scan${totalInserted === 1 ? '' : 's'} · ${totalSkipped} duplicate${totalSkipped === 1 ? '' : 's'} skipped${totalFailed > 0 ? ` · ${totalFailed} failed` : ''}`);
      setWorksheetReview(null);
      loadAll();
    } catch (err: any) {
      console.error('[worksheet commit] failed:', err);
      setWorksheetNotes(`Commit failed: ${err?.message || err}`);
    }
    setWorksheetCommitting(false);
  };

  const handleBulkUpload = async () => {
    if (!bulkVins.trim()) return;
    const selectedPartsList = bulkParts;
    const selectedLoc = allLocations.find(l => l.id === bulkLocation);
    const locationOverrideCustomer = locationBillingOverride(selectedLoc?.name);

    // Parse VINs — one per line, strip whitespace, skip empty
    const vins = bulkVins.split(/[\n,]+/).map(v => v.trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, '')).filter(v => v.length >= 5);
    if (vins.length === 0) { setBulkResult({ success: 0, failed: 0 }); return; }

    // If no parts selected, use a single null entry so VINs still upload
    const partsToProcess = selectedPartsList.length > 0 ? selectedPartsList : [null];

    setBulkProcessing(true);
    setBulkResult(null);

    // Check for duplicates across all selected part numbers. Matching is on
    // the VIN's last 8 (not exact string), so a last-8 entry here collides
    // with an earlier full 17-char scan of the same vehicle and vice versa.
    // The same rule also de-dupes repeats within the pasted list itself.
    let totalDupes = 0;
    const vinPartPairs: { vin: string; part: typeof partsToProcess[0] }[] = [];
    for (const part of partsToProcess) {
      const partNum = part?.partNumber || '';
      const existingScanVins = await findExistingScanVins(supabase, vins, partNum || null);
      const seenTails = new Set<string>();
      for (const vin of vins) {
        if (existingScanVins.some(e => sameVehicleVin(e, vin)) || seenTails.has(vinTail(vin))) {
          totalDupes++;
        } else {
          seenTails.add(vinTail(vin));
          vinPartPairs.push({ vin, part });
        }
      }
    }

    if (vinPartPairs.length === 0) {
      await dialog.alert(`All VINs already exist for the selected part number${partsToProcess.length > 1 ? 's' : ''}.`);
      setBulkProcessing(false);
      return;
    }
    if (totalDupes > 0) {
      if (!(await dialog.confirm(`${totalDupes} duplicate${totalDupes !== 1 ? 's' : ''} will be skipped.\n\nContinue uploading ${vinPartPairs.length} scan${vinPartPairs.length !== 1 ? 's' : ''}?`))) {
        setBulkProcessing(false);
        return;
      }
    }

    let success = 0, failed = 0, skipped = totalDupes;

    // Decode all unique VINs through NHTSA's batch endpoint (50 per call)
    // instead of one request per VIN — 119 VINs used to mean 119 sequential
    // round-trips (minutes); now it's 3. A failed batch just means those
    // VINs upload without year/make/model.
    const uniqueVins = [...new Set(vinPartPairs.map(p => p.vin))];
    const decoded = await decodeVinsBatch(uniqueVins, (done, total) =>
      setBulkProgress(`Decoding VINs ${done}/${total}…`));

    // Insert in chunks; if a chunk fails as a whole, retry its rows one by
    // one so a single bad row doesn't sink (or miscount) the rest.
    const rows = vinPartPairs.map(({ vin, part }) => ({
      vin,
      ...(decoded.get(vin) || {}),
      part_number: part?.partNumber || null,
      part_description: part?.description || null,
      // The admin's explicit Customer field beats the location default —
      // same-building Reading/Masterack work means the location alone can't
      // decide who's billed anymore.
      billable_customer: bulkCustomer.trim() || locationOverrideCustomer || part?.customer || null,
      location_id: selectedLoc?.id || null,
      location_name: selectedLoc?.name || null,
      installer_name: vendorCompanies.find(c => c.id === bulkVendor)?.name || null,
      scanned_by: user?.id,
    }));
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      setBulkProgress(`Saving ${Math.min(i + 50, rows.length)}/${rows.length}…`);
      const { error } = await supabase.from('scan_logs').insert(chunk);
      if (!error) {
        success += chunk.length;
      } else {
        for (const row of chunk) {
          const { error: rowErr } = await supabase.from('scan_logs').insert(row);
          if (rowErr) failed++; else success++;
        }
      }
    }

    setBulkProgress(null);
    setBulkResult({ success, failed, skipped });
    setBulkProcessing(false);
    // Clear VINs for the next batch, but keep customer/part/location sticky for the session
    if (success > 0) { setBulkVins(''); loadAll(); }
  };

  const importVinFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setBulkVins(prev => prev ? prev + '\n' + text : text);
    };
    reader.readAsText(file);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importVinFile(file);
    e.target.value = '';
  };

  const handleWorksheetScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    await scanWorksheetFile(file);
  };

  const scanWorksheetFile = async (file: File) => {
    setScanningWorksheet(true);
    setWorksheetNotes(null);
    setBulkResult(null);

    try {
      // Convert to base64 using FileReader (handles all binary data safely)
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(',')[1]); // strip data:xxx;base64, prefix
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
      const mediaType = file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');

      const res = await fetch('/api/scan-worksheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mediaType }),
      });
      const result = await res.json();

      if (!res.ok || !result.data) {
        setWorksheetNotes(`Scan failed: ${result.error || 'Unknown error'}`);
        setScanningWorksheet(false);
        return;
      }

      const pagesRaw: any[] = Array.isArray(result.data?.pages) ? result.data.pages : [];
      const pages: WSPage[] = pagesRaw.map((p: any, i: number) => ({
        page: p.page ?? i + 1,
        header: p.header || {},
        rows: (p.rows || []).map((r: any) => ({
          row_number: r.row_number ?? 0,
          partial_vin: r.partial_vin || '',
          unit_number: r.unit_number || null,
          include: true,
        })),
        notes: p.notes || null,
      }));
      if (pages.length === 0) {
        setWorksheetNotes('Scan returned no pages. Try a clearer scan.');
        setScanningWorksheet(false);
        return;
      }
      setWorksheetReview({ pages });
    } catch (err: any) {
      setWorksheetNotes(`Scan error: ${err.message}`);
    }
    setScanningWorksheet(false);
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
        Scan Log
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {([
          { id: 'ready' as ViewTab, label: `Ready to Export (${readyToExport.length})` },
          { id: 'waiting' as ViewTab, label: `Waiting for PO (${waitingForPO.length})` },
          { id: 'exported' as ViewTab, label: `Exported (${exported.length})` },
          { id: 'archived' as ViewTab, label: `Archived (${archivedScans.length})` },
          { id: 'all' as ViewTab, label: `All Scans (${allScans.length})` },
          { id: 'bulk' as ViewTab, label: 'Bulk Upload' },
          { id: 'vendor' as ViewTab, label: 'Vendor Invoices' },
        ]).map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSelectedScans(new Set()); setExpandedGroups(new Set()); }} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: tab === t.id ? 'var(--tab-active-bg)' : 'transparent',
            border: tab === t.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: tab === t.id ? 'var(--tab-active-color)' : 'var(--text-muted)',
          }}>{t.label}</button>
        ))}
      </div>

      {/* Search */}
      {isScanListTab && <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search VIN, part, customer, location, PO, CNI job, installer, company..."
        style={{ width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '13px', border: `1px solid ${theme.border}`, background: theme.card, color: theme.textPrimary, fontWeight: 600, marginBottom: '10px' }} />}

      {/* Source filter — CNI installs vs. field scans (§3.4) */}
      {isScanListTab && (
        <div style={{ display: 'flex', gap: '4px', marginBottom: '10px', flexWrap: 'wrap' }}>
          {([
            { id: 'all' as const, label: 'All sources' },
            { id: 'cni' as const, label: 'CNI' },
            { id: 'field' as const, label: 'Field' },
          ]).map(f => (
            <button key={f.id} onClick={() => setSourceFilter(f.id)} style={{
              padding: '5px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: sourceFilter === f.id ? 'var(--tab-active-bg)' : 'transparent',
              border: sourceFilter === f.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
              color: sourceFilter === f.id ? '#06b6d4' : 'var(--text-muted)',
            }}>{f.label}</button>
          ))}
          {/* Filter by who DID the install (credited crew / CNI installer /
              field installer) and by the installing company. */}
          <select
            value={installerFilter}
            onChange={e => setInstallerFilter(e.target.value)}
            title="Filter by the installer credited with the work"
            style={{
              padding: '5px 8px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: installerFilter ? 'var(--tab-active-bg)' : 'transparent',
              border: installerFilter ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
              color: installerFilter ? '#06b6d4' : 'var(--text-muted)', maxWidth: '160px',
            }}
          >
            <option value="">All installers</option>
            {installerOptions.map(u => <option key={u.id} value={u.id}>{u.name}{u.company ? ` — ${u.company}` : ''}</option>)}
          </select>
          <select
            value={companyFilter}
            onChange={e => setCompanyFilter(e.target.value)}
            title="Filter by the company that did the install — BMG (internal) covers BMG's own work"
            style={{
              padding: '5px 8px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: companyFilter ? 'var(--tab-active-bg)' : 'transparent',
              border: companyFilter ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
              color: companyFilter ? '#06b6d4' : 'var(--text-muted)', maxWidth: '160px',
            }}
          >
            <option value="">All companies</option>
            <option value={BMG_COMPANY}>BMG (internal)</option>
            {companyOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {/* Separate from the installer filters: who LOGGED the scan (admins
              included) — the audit-side view of the same rows. */}
          <select
            value={scannerFilter}
            onChange={e => setScannerFilter(e.target.value)}
            title="Filter by who logged the scan (the account that recorded it, not necessarily the installer)"
            style={{
              padding: '5px 8px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: scannerFilter ? 'var(--tab-active-bg)' : 'transparent',
              border: scannerFilter ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
              color: scannerFilter ? '#06b6d4' : 'var(--text-muted)', maxWidth: '160px',
            }}
          >
            <option value="">Scanned by: anyone</option>
            {scannerOptions.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select
            value={locationFilter}
            onChange={e => setLocationFilter(e.target.value)}
            style={{
              padding: '5px 8px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: locationFilter ? 'var(--tab-active-bg)' : 'transparent',
              border: locationFilter ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
              color: locationFilter ? '#06b6d4' : 'var(--text-muted)', maxWidth: '160px',
            }}
          >
            <option value="">All locations</option>
            <option value={NO_LOCATION}>No location</option>
            {locationOptions.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <button
            onClick={downloadFilteredCsv}
            disabled={tabScans.length === 0}
            title="Download a CSV of every scan the current tab and filters show — does not mark anything as exported"
            style={{
              marginLeft: 'auto', padding: '5px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
              background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e',
              cursor: tabScans.length === 0 ? 'default' : 'pointer', opacity: tabScans.length === 0 ? 0.5 : 1,
            }}
          >
            Export CSV ({tabScans.length})
          </button>
        </div>
      )}

      {/* Date-range filter — All Scans tab only. Filters on when the scan
          happened, ignoring what happened to it afterwards. */}
      {tab === 'all' && (
        <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          {(() => {
            const today = new Date();
            const daysAgo = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return toLocalDateStr(d); };
            const presets = [
              { label: 'Today', from: toLocalDateStr(today), to: toLocalDateStr(today) },
              { label: '7 days', from: daysAgo(6), to: toLocalDateStr(today) },
              { label: '30 days', from: daysAgo(29), to: toLocalDateStr(today) },
              { label: 'All time', from: '', to: '' },
            ];
            return presets.map(p => {
              const active = dateFrom === p.from && dateTo === p.to;
              return (
                <button key={p.label} onClick={() => { setDateFrom(p.from); setDateTo(p.to); }} style={{
                  padding: '5px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                  background: active ? 'var(--tab-active-bg)' : 'transparent',
                  border: active ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
                  color: active ? '#06b6d4' : 'var(--text-muted)',
                }}>{p.label}</button>
              );
            });
          })()}
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: '8px', fontSize: '11px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }} />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>–</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: '8px', fontSize: '11px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }} />
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as typeof sortBy)}
            style={{
              padding: '5px 8px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: sortBy !== 'date' ? 'var(--tab-active-bg)' : 'transparent',
              border: sortBy !== 'date' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
              color: sortBy !== 'date' ? '#06b6d4' : 'var(--text-muted)',
            }}
          >
            <option value="date">Sort: newest first</option>
            <option value="company">Sort: installer company</option>
            <option value="installer">Sort: installer</option>
          </select>
          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', marginLeft: 'auto' }}>
            {tabScans.length} scan{tabScans.length !== 1 ? 's' : ''}{(dateFrom || dateTo) ? ' in range' : ''}
          </span>
        </div>
      )}

      {/* Actions */}
      {tab !== 'vendor' && <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <button onClick={selectAllVisible} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          {selectedScans.size === tabScans.length && tabScans.length > 0 ? 'Deselect All' : `Select All (${tabScans.length})`}
        </button>
        {tab === 'waiting' && waitingForPO.length > 0 && (
          <button onClick={runAutoMatch} disabled={matching} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            {matching ? 'Matching...' : 'Try Auto-Match POs'}
          </button>
        )}
        {(tab === 'ready' || tab === 'waiting') && selectedScans.size > 0 && (
          <>
            <button onClick={exportCSV} disabled={exporting} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', cursor: 'pointer' }}>
              {exporting ? 'Exporting...' : `Export ${selectedScans.size} to CSV`}
            </button>
            <button onClick={createInvoice} disabled={invoicing} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24', cursor: 'pointer' }}>
              {invoicing ? 'Creating...' : `Create Invoice (${selectedScans.size})`}
            </button>
          </>
        )}
        {tab === 'exported' && selectedScans.size > 0 && (
          <>
            <button onClick={createInvoice} disabled={invoicing} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24', cursor: 'pointer' }}>
              {invoicing ? 'Creating...' : `Create Invoice (${selectedScans.size})`}
            </button>
            <button onClick={exportCSV} disabled={exporting} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', cursor: 'pointer' }}>
              {exporting ? 'Exporting...' : `Download CSV (${selectedScans.size})`}
            </button>
            <button onClick={archiveExported} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              Archive {selectedScans.size}
            </button>
            <button onClick={unexportScans} title="Move back to the Ready/Waiting queues — the scans count as uninvoiced work again" style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              Un-export {selectedScans.size}
            </button>
          </>
        )}
        {tab === 'archived' && selectedScans.size > 0 && (
          <button onClick={unarchiveScans} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24', cursor: 'pointer' }}>
            Unarchive {selectedScans.size}
          </button>
        )}
        {tab !== 'bulk' && selectedScans.size > 0 && (
          <>
            <button onClick={() => setShowBulkEdit(true)} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#60a5fa', cursor: 'pointer' }}>
              Edit {selectedScans.size}
            </button>
            <button onClick={bulkDelete} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444', cursor: 'pointer' }}>
              Delete {selectedScans.size}
            </button>
          </>
        )}
      </div>}

      {/* What "Exported" actually means — the meeting concluded it had no
          system meaning; it does, so say it where the tab lives. */}
      {tab === 'exported' && (
        <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '10px', background: 'rgba(96,165,250,0.07)', border: '1px solid rgba(96,165,250,0.2)', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <b style={{ color: '#60a5fa' }}>Exported</b> = out of the invoicing workflow: these scans are hidden from the invoice queue and the Ready/Waiting counts, and PO auto-match deprioritizes them. Scans land here when their CSV is exported or when invoicing back-stamps them (each row says which). <b>Un-export</b> puts selected scans back in the queue; <b>Create Invoice</b> bills them from here as-is.
        </div>
      )}

      {/* Invoice result banner */}
      {invoiceResult && (
        <div style={{ padding: '12px 14px', borderRadius: '10px', marginBottom: '12px', background: 'var(--card)', border: `1px solid ${invoiceResult.summary.errors > 0 ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: invoiceResult.results.length > 0 ? '8px' : 0 }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Invoice Result: {invoiceResult.summary.success} created{invoiceResult.summary.errors > 0 ? `, ${invoiceResult.summary.errors} failed` : ''}
            </div>
            <button onClick={() => setInvoiceResult(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '14px', cursor: 'pointer' }}>✕</button>
          </div>
          {invoiceResult.results.map((r, i) => (
            <div key={i} style={{ fontSize: '11px', fontWeight: 600, color: r.status === 'success' ? '#22c55e' : '#ef4444', marginBottom: '2px' }}>
              {r.customer}{r.po ? ` · PO #${r.po}` : ''} ({r.vehicleCount} VIN{r.vehicleCount !== 1 ? 's' : ''})
              {r.status === 'success' ? ` → Invoice #${r.invoiceNumber}` : ` — ${r.error}`}
            </div>
          ))}
          {invoiceResult.summary.success > 0 && (() => {
            const successByCustomer: Record<string, { invoiceId: string; invoiceNumber: string; po?: string }[]> = {};
            for (const r of invoiceResult.results) {
              if (r.status === 'success' && r.invoiceId && r.invoiceNumber) {
                if (!successByCustomer[r.customer]) successByCustomer[r.customer] = [];
                successByCustomer[r.customer].push({ invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, po: r.po || undefined });
              }
            }
            return (
              <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {Object.entries(successByCustomer).map(([customer, invs]) => (
                  <button key={customer} onClick={() => setEmailTarget({ customerName: customer, invoices: invs })} style={{ padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#60a5fa', cursor: 'pointer' }}>
                    Email {invs.length} Invoice{invs.length !== 1 ? 's' : ''} to {customer}
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Email invoices modal (shared component, same flow as the Invoicing hub) */}
      {emailTarget && (
        <EmailInvoicesModal
          customerName={emailTarget.customerName}
          invoices={emailTarget.invoices}
          onClose={() => setEmailTarget(null)}
        />
      )}

      {/* Bulk edit modal */}
      {showBulkEdit && (
        <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
          {(() => {
            // Find the common part number across selected scans for PO filtering
            const selectedScanList = [...selectedScans].map(id => scans.find(s => s.id === id) || archivedScans.find(s => s.id === id)).filter(Boolean) as ScanLog[];
            const selectedPartNumbers = [...new Set(selectedScanList.map(s => s.part_number?.toUpperCase()).filter(Boolean))];
            const hasOnePart = selectedPartNumbers.length === 1;
            const selectedPart = hasOnePart ? selectedPartNumbers[0] : null;

            // Filter POs to only those containing the selected part number
            const matchingPOs = selectedPart
              ? allPOs.filter(po => po.line_items.some(li => li.part_number.toUpperCase() === selectedPart))
              : allPOs;

            return (<>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '10px' }}>Edit {selectedScans.size} Scan{selectedScans.size !== 1 ? 's' : ''}{selectedPart ? <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: '6px' }}>({selectedPart})</span> : ''}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <div style={{ position: 'relative' }}>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Part Number</div>
              <input
                value={bulkEditPart}
                onChange={e => { setBulkEditPart(e.target.value); setBulkEditPartPicked(null); }}
                placeholder="No change"
                style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '11px' }}
              />
              {bulkEditPart.length >= 2 && !bulkEditPartPicked && (() => {
                const q = bulkEditPart.toLowerCase();
                const matches = allParts.filter(p =>
                  p.item_number.toLowerCase().includes(q) ||
                  p.display_name?.toLowerCase().includes(q) ||
                  p.billable_customer?.toLowerCase().includes(q)
                ).slice(0, 8);
                if (matches.length === 0) return null;
                return (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '200px', overflowY: 'auto', marginTop: '2px' }}>
                    {matches.map(p => (
                      <button
                        key={p.id}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => {
                          setBulkEditPart(p.item_number);
                          setBulkEditPartPicked(p);
                          if (p.billable_customer) setBulkEditCustomer(p.billable_customer);
                        }}
                        style={{ display: 'block', width: '100%', padding: '6px 8px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '11px', color: 'var(--text-primary)' }}
                      >
                        <span style={{ fontWeight: 700 }}>{p.item_number}</span>
                        {p.billable_customer && <span style={{ color: '#a78bfa', marginLeft: '6px' }}>{p.billable_customer}</span>}
                        {p.display_name && <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{p.display_name}</div>}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
            <div style={{ position: 'relative' }}>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Billable Customer</div>
              <input
                value={bulkEditCustomer}
                onChange={e => setBulkEditCustomer(e.target.value)}
                placeholder="No change"
                style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '11px' }}
              />
              {customerQuickPick(bulkEditCustomer, setBulkEditCustomer)}
              {bulkEditCustomer.length >= 1 && (() => {
                const q = bulkEditCustomer.toLowerCase();
                const set = new Set<string>();
                for (const p of allParts) {
                  const c = (p.billable_customer || '').trim();
                  if (c && c.toLowerCase() !== q && c.toLowerCase().includes(q)) set.add(c);
                }
                const matches = [...set].sort().slice(0, 8);
                if (matches.length === 0) return null;
                return (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '200px', overflowY: 'auto', marginTop: '2px' }}>
                    {matches.map(c => (
                      <button
                        key={c}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => setBulkEditCustomer(c)}
                        style={{ display: 'block', width: '100%', padding: '6px 8px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '11px', color: 'var(--text-primary)' }}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
            <div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Location</div>
              <select value={bulkEditLocation} onChange={e => setBulkEditLocation(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '11px' }}>
                <option value="">— No change —</option>
                {allLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Assign to PO</div>
              <select value={bulkEditPO} onChange={e => setBulkEditPO(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '11px' }}>
                <option value="">— No change —</option>
                <option value="__clear__">Clear PO assignment</option>
                {matchingPOs.map(p => {
                  const matchedLine = selectedPart ? p.line_items.find(li => li.part_number.toUpperCase() === selectedPart) : null;
                  const remaining = matchedLine ? matchedLine.quantity - matchedLine.installed : null;
                  return <option key={p.id} value={p.id}>PO #{p.po_number} — {p.customer}{remaining !== null ? ` (${remaining} remaining)` : ''}</option>;
                })}
              </select>
              {hasOnePart && matchingPOs.length === 0 && (
                <div style={{ fontSize: '9px', color: '#fbbf24', marginTop: '3px' }}>No POs found with part {selectedPart}</div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={applyBulkEdit} style={{ padding: '8px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}>Apply Changes</button>
            <button onClick={() => setShowBulkEdit(false)} style={{ padding: '8px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'transparent', border: `1px solid ${theme.border}`, color: 'var(--text-muted)', cursor: 'pointer' }}>Cancel</button>
          </div>
          </>); })()}
        </div>
      )}

      {/* Worksheet Review Modal — per-page sections (each page is its own
          worksheet with its own part numbers, customer, and VIN list). */}
      {worksheetReview && (() => {
        const totalSelected = worksheetReview.pages.reduce((s, pg) => s + pg.rows.filter(r => r.include).length, 0);
        const totalRows = worksheetReview.pages.reduce((s, pg) => s + pg.rows.length, 0);
        const updatePage = (pageIdx: number, fn: (p: WSPage) => WSPage) => {
          setWorksheetReview(prev => {
            if (!prev) return prev;
            const pages = [...prev.pages];
            pages[pageIdx] = fn(pages[pageIdx]);
            return { ...prev, pages };
          });
        };
        return (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }} onClick={() => setWorksheetReview(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '14px', padding: '18px', width: '100%', maxWidth: '640px', maxHeight: 'calc(90vh / var(--ts))', overflowY: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>Review Worksheet Scan</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {worksheetReview.pages.length} page{worksheetReview.pages.length === 1 ? '' : 's'} · {totalSelected} of {totalRows} VINs selected
                </div>
              </div>
              <button onClick={() => setWorksheetReview(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            {(() => {
              const override = locationBillingOverride(allLocations.find(l => l.id === bulkLocation)?.name);
              if (!override) return null;
              return (
                <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '12px', background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                  All scans will be billed to {override} (location override)
                </div>
              );
            })()}

            {worksheetReview.pages.map((pg, pageIdx) => {
              const partNumbers = (pg.header.part_number || '').split('/').map((p: string) => p.trim()).filter(Boolean);
              const matchResults = partNumbers.map((pn: any) => ({
                partNumber: pn,
                match: allParts.find(p => p.item_number.toUpperCase().includes(pn.toUpperCase())),
              }));
              const pageSelected = pg.rows.filter(r => r.include).length;
              return (
                <div key={pageIdx} style={{
                  marginBottom: '14px', padding: '12px',
                  border: '1px solid var(--border)', borderRadius: '10px',
                  background: 'var(--subtle-bg)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Page {pg.page}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                      {pageSelected} of {pg.rows.length} selected
                      {pg.notes && <span> · {pg.notes}</span>}
                    </div>
                  </div>

                  {/* Header inputs */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '8px' }}>
                    <div>
                      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Part Number(s)</div>
                      <input
                        value={pg.header.part_number || ''}
                        onChange={e => updatePage(pageIdx, p => ({ ...p, header: { ...p.header, part_number: e.target.value } }))}
                        style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700 }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Customer</div>
                      <input
                        value={pg.header.customer || ''}
                        onChange={e => updatePage(pageIdx, p => ({ ...p, header: { ...p.header, customer: e.target.value } }))}
                        style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }}
                      />
                    </div>
                  </div>

                  {/* Part-match status */}
                  {matchResults.length > 0 && (
                    <div style={{ marginBottom: '8px' }}>
                      {matchResults.map((r: any, i: any) => (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                          padding: '5px 9px', borderRadius: '6px', marginBottom: '3px',
                          background: r.match ? 'rgba(34,197,94,0.06)' : 'rgba(251,191,36,0.06)',
                          border: `1px solid ${r.match ? 'rgba(34,197,94,0.2)' : 'rgba(251,191,36,0.2)'}`,
                        }}>
                          <div>
                            <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>{r.partNumber}</span>
                            {r.match && <span style={{ fontSize: '10px', color: '#4ade80', marginLeft: '6px' }}>✓ {r.match.display_name || r.match.item_number}{r.match.billable_customer ? ` — ${r.match.billable_customer}` : ''}</span>}
                            {!r.match && <span style={{ fontSize: '10px', color: '#fbbf24', marginLeft: '6px' }}>Not in catalog</span>}
                          </div>
                          {!r.match && (
                            <button
                              onClick={async () => {
                                // The item may already exist in NetSuite — mirror
                                // it into the catalog instead of creating a
                                // manual duplicate that gets re-flagged forever.
                                try {
                                  const res = await fetch('/api/parts/mirror', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ partNumber: r.partNumber }),
                                  });
                                  const data = await res.json().catch(() => ({}));
                                  if (res.ok && data.found && data.part) {
                                    let all: any[] = [];
                                    let p3 = 0;
                                    let more3 = true;
                                    while (more3) {
                                      const { data: pageData } = await supabase.from('netsuite_parts').select('id, item_number, display_name, billable_customer, vehicle_type, graphic_package').eq('is_active', true).order('item_number').range(p3 * 1000, (p3 + 1) * 1000 - 1);
                                      all = [...all, ...(pageData || [])];
                                      more3 = (pageData || []).length === 1000;
                                      p3++;
                                    }
                                    setAllParts(all as typeof allParts);
                                    return;
                                  }
                                } catch { /* fall through to manual add */ }

                                // Not in NetSuite — guard against duplicates: the
                                // part may already exist (a manual row, or one not
                                // in the loaded set). ilike is a case-insensitive
                                // superset — confirm an exact match before inserting.
                                const { data: candidates } = await supabase
                                  .from('netsuite_parts')
                                  .select('id, item_number')
                                  .ilike('item_number', r.partNumber);
                                const dupe = ((candidates as any[]) || []).some(
                                  (c) => (c.item_number || '').toUpperCase() === (r.partNumber || '').toUpperCase()
                                );
                                let error: any = null;
                                if (!dupe) {
                                  // Manual row (no NetSuite item): netsuite_id NULL +
                                  // source 'manual' so a NetSuite sync won't wipe it.
                                  ({ error } = await supabase.from('netsuite_parts').insert({
                                    netsuite_id: null,
                                    item_number: r.partNumber,
                                    display_name: r.partNumber,
                                    catalog: 'graphics',
                                    source: 'manual',
                                    billable_customer: pg.header.customer || null,
                                    is_active: true,
                                  }));
                                }
                                if (error) {
                                  await dialog.alert(`Failed to add: ${error.message}`);
                                } else {
                                  let all: any[] = [];
                                  let p2 = 0;
                                  let more = true;
                                  while (more) {
                                    const { data } = await supabase.from('netsuite_parts').select('id, item_number, display_name, billable_customer').eq('is_active', true).order('item_number').range(p2 * 1000, (p2 + 1) * 1000 - 1);
                                    all = [...all, ...(data || [])];
                                    more = (data || []).length === 1000;
                                    p2++;
                                  }
                                  setAllParts(all as typeof allParts);
                                }
                              }}
                              style={{ padding: '3px 9px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#60a5fa', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
                            >+ Add to Catalog</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* VIN rows */}
                  {pg.rows.map((row, idx) => (
                    <div key={idx} style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      padding: '5px 7px', marginBottom: '3px', borderRadius: '6px',
                      background: row.include ? 'rgba(34,197,94,0.04)' : 'rgba(239,68,68,0.04)',
                      border: `1px solid ${row.include ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}`,
                      opacity: row.include ? 1 : 0.5,
                    }}>
                      <input
                        type="checkbox"
                        checked={row.include}
                        onChange={() => updatePage(pageIdx, p => {
                          const rows = [...p.rows];
                          rows[idx] = { ...rows[idx], include: !rows[idx].include };
                          return { ...p, rows };
                        })}
                        style={{ width: '14px', height: '14px', flexShrink: 0, accentColor: '#22c55e' }}
                      />
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', width: '20px', flexShrink: 0 }}>{row.row_number}</span>
                      <input
                        value={row.partial_vin || ''}
                        onChange={e => updatePage(pageIdx, p => {
                          const rows = [...p.rows];
                          rows[idx] = { ...rows[idx], partial_vin: e.target.value.toUpperCase() };
                          return { ...p, rows };
                        })}
                        style={{ flex: 1, padding: '5px 7px', borderRadius: '5px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, fontFamily: 'monospace' }}
                      />
                      <input
                        value={row.unit_number || ''}
                        onChange={e => updatePage(pageIdx, p => {
                          const rows = [...p.rows];
                          rows[idx] = { ...rows[idx], unit_number: e.target.value };
                          return { ...p, rows };
                        })}
                        placeholder="Unit #"
                        style={{ width: '110px', padding: '5px 7px', borderRadius: '5px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-secondary)', fontSize: '11px', flexShrink: 0 }}
                      />
                    </div>
                  ))}
                </div>
              );
            })}

            {/* Actions */}
            <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
              <button
                onClick={() => commitWorksheetPages()}
                disabled={worksheetCommitting || totalSelected === 0}
                style={{
                  flex: 1, padding: '12px', borderRadius: '10px',
                  background: worksheetCommitting || totalSelected === 0 ? 'var(--subtle-bg)' : '#22c55e',
                  color: worksheetCommitting || totalSelected === 0 ? 'var(--text-muted)' : '#fff',
                  fontWeight: 800, fontSize: '13px', border: 'none',
                  cursor: worksheetCommitting || totalSelected === 0 ? 'default' : 'pointer',
                }}
              >
                {worksheetCommitting ? 'Inserting…' : `Insert ${totalSelected} scan${totalSelected === 1 ? '' : 's'} across ${worksheetReview.pages.length} page${worksheetReview.pages.length === 1 ? '' : 's'}`}
              </button>
              <button
                onClick={() => setWorksheetReview(null)}
                style={{ flex: 1, padding: '12px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Bulk Upload tab */}
      {tab === 'bulk' && (
        <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginBottom: '12px' }}>
            <div style={{ position: 'relative' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Part Number(s)</div>
              {/* Selected parts chips */}
              {bulkParts.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }}>
                  {bulkParts.map(bp => (
                    <div key={bp.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', borderRadius: '6px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {bp.label}
                      <button onClick={() => setBulkParts(prev => prev.filter(p => p.id !== bp.id))} style={{ background: 'none', border: 'none', color: '#f87171', fontSize: '12px', cursor: 'pointer', padding: '0 2px' }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              {/* Search to add parts */}
              <div>
                <input value={bulkPartSearch} onChange={e => setBulkPartSearch(e.target.value)} placeholder="Search to add part..." style={{ width: '100%', padding: bulkParts.length > 0 ? '6px 8px' : '10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: bulkParts.length > 0 ? '11px' : '13px' }} />
                {bulkPartSearch.length >= 2 && (() => {
                  const q = bulkPartSearch.toLowerCase();
                  const selectedIds = new Set(bulkParts.map(bp => bp.id));
                  // Single source: netsuite_parts is the unified catalog
                  // (migration 117 folded the legacy graphics catalog into it
                  // — searching both showed every graphics part twice).
                  // vehicle_type/graphic_package keep the graphics-specific
                  // search terms the old catalog matched on.
                  const matches = allParts
                    .filter(p => !selectedIds.has(p.id) && (p.item_number.toLowerCase().includes(q) || p.display_name?.toLowerCase().includes(q) || p.billable_customer?.toLowerCase().includes(q) || p.vehicle_type?.toLowerCase().includes(q) || p.graphic_package?.toLowerCase().includes(q)))
                    .slice(0, 12)
                    .map(p => ({
                      key: `part:${p.id}`,
                      id: p.id,
                      title: p.item_number,
                      customer: p.billable_customer,
                      sub: p.display_name,
                      tag: null as string | null,
                      add: { id: p.id, label: `${p.item_number}${p.billable_customer ? ` — ${p.billable_customer}` : ''}`, partNumber: p.item_number, description: p.display_name, customer: p.billable_customer },
                    }));
                  return (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '240px', overflowY: 'auto', marginTop: '2px' }}>
                      {matches.length === 0 && (
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '8px 10px' }}>No matching parts</div>
                      )}
                      {matches.map(m => (
                        <button key={m.key} onClick={() => { setBulkParts(prev => [...prev, m.add]); setBulkPartSearch(''); }} style={{
                          display: 'block', width: '100%', padding: '8px 10px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`,
                          background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'var(--text-primary)',
                        }}>
                          <span style={{ fontWeight: 700 }}>{m.title}</span>
                          {m.customer && <span style={{ color: '#a78bfa', marginLeft: '6px' }}>{m.customer}</span>}
                          {m.tag && <span style={{ fontSize: '9px', fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', borderRadius: '4px', padding: '1px 5px', marginLeft: '6px' }}>{m.tag}</span>}
                          {m.sub && <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{m.sub}</div>}
                        </button>
                      ))}
                      <button onMouseDown={e => e.preventDefault()} onClick={() => setCreateItemFor(bulkPartSearch.trim())} style={{
                        display: 'block', width: '100%', padding: '8px 10px', textAlign: 'left', border: 'none',
                        background: 'rgba(34,197,94,0.06)', cursor: 'pointer', fontSize: '12px', fontWeight: 700, color: '#22c55e',
                      }}>
                        + Create &quot;{bulkPartSearch.trim()}&quot; in NetSuite
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Location</div>
              <select value={bulkLocation} onChange={e => setBulkLocation(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px' }}>
                <option value="">— Select Location —</option>
                {allLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Vendor / Installer</div>
              <select value={bulkVendor} onChange={e => setBulkVendor(e.target.value)} title="Who performed the installs — stamps the vendor on every scan in this batch" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px' }}>
                <option value="">— No vendor —</option>
                {vendorCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div style={{ position: 'relative' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Customer</div>
              <input
                value={bulkCustomer}
                onChange={e => { setBulkCustomer(e.target.value); setShowCustDropdown(true); }}
                onFocus={() => setShowCustDropdown(true)}
                onBlur={() => setTimeout(() => setShowCustDropdown(false), 150)}
                placeholder="Search NetSuite customers…"
                style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px' }}
              />
              {customerQuickPick(bulkCustomer, n => { setBulkCustomer(n); setShowCustDropdown(false); })}
              {showCustDropdown && bulkCustomer.trim().length >= 2 && (() => {
                const matches = custMatches.filter(c => c.company_name.toLowerCase() !== bulkCustomer.trim().toLowerCase());
                if (matches.length === 0) return null;
                return (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '200px', overflowY: 'auto', marginTop: '2px' }}>
                    {matches.map(c => (
                      <button
                        key={c.id}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => { setBulkCustomer(c.company_name); setShowCustDropdown(false); }}
                        style={{ display: 'block', width: '100%', padding: '8px 10px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'var(--text-primary)' }}
                      >
                        <span style={{ fontWeight: 700 }}>{c.company_name}</span>
                        {c.entity_id && <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '10px' }}>{c.entity_id}</span>}
                      </button>
                    ))}
                  </div>
                );
              })()}
              {(() => {
                // An explicit customer now beats the location default (same-
                // building Reading/Masterack work), so only surface the
                // fallback when the field is blank.
                const override = locationBillingOverride(allLocations.find(l => l.id === bulkLocation)?.name);
                if (!override || bulkCustomer.trim()) return null;
                return (
                  <div style={{ fontSize: '10px', fontWeight: 700, color: '#a78bfa', marginTop: '4px' }}>
                    Will be billed to {override} (location default — pick a customer to override)
                  </div>
                );
              })()}
            </div>
          </div>

          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>VINs (one per line, or paste from spreadsheet)</div>
          <textarea
            value={bulkVins}
            onChange={e => setBulkVins(e.target.value)}
            placeholder={'Paste VINs here, one per line...\n1FTBR1Y82TKA82014\n1FTBR1Y84TKA82175\n1FTBR1Y88TKA82180'}
            style={{
              width: '100%', minHeight: '150px', padding: '12px', borderRadius: '8px',
              border: `1px solid ${theme.border}`, background: 'var(--input-bg)',
              color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace',
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <DropZone accept=".csv,.txt,.tsv" multiple={false} onFiles={files => importVinFile(files[0])}>
            <label style={{
              padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`,
              color: 'var(--text-secondary)', cursor: 'pointer',
            }}>
              Upload CSV
              <input type="file" accept=".csv,.txt,.tsv" onChange={handleFileUpload} style={{ display: 'none' }} />
            </label>
            </DropZone>
            <DropZone accept="image/*,.pdf" multiple={false} disabled={scanningWorksheet} onFiles={files => scanWorksheetFile(files[0])}>
            <label style={{
              padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: scanningWorksheet ? 'var(--card-hover)' : 'var(--subtle-bg)',
              border: '1px solid var(--border-strong)',
              color: 'var(--text-secondary)', cursor: scanningWorksheet ? 'default' : 'pointer',
              opacity: scanningWorksheet ? 0.6 : 1,
            }}>
              {scanningWorksheet ? 'Scanning...' : 'Scan Worksheet (OCR)'}
              <input type="file" accept="image/*,.pdf" capture="environment" onChange={handleWorksheetScan} disabled={scanningWorksheet} style={{ display: 'none' }} />
            </label>
            </DropZone>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', flex: 1 }}>
              {bulkVins.split(/[\n,]+/).filter(v => v.trim().length >= 5).length} VINs detected
            </span>
            <button
              onClick={handleBulkUpload}
              disabled={bulkProcessing || !bulkVins.trim()}
              style={{
                padding: '10px 20px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
                background: bulkProcessing || !bulkVins.trim() ? theme.border : '#22c55e',
                color: '#fff', border: 'none', cursor: bulkProcessing || !bulkVins.trim() ? 'default' : 'pointer',
                opacity: bulkProcessing || !bulkVins.trim() ? 0.5 : 1,
              }}
            >
              {bulkProcessing ? (bulkProgress || 'Processing…') : 'Upload VINs'}
            </button>
          </div>
          {worksheetNotes && (
            <div style={{ marginTop: '10px', padding: '10px 14px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600, whiteSpace: 'pre-wrap' }}>
              {worksheetNotes}
            </div>
          )}
          {bulkResult && (
            <div style={{ marginTop: '10px', padding: '10px 14px', borderRadius: '8px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)', color: '#22c55e', fontSize: '12px', fontWeight: 700 }}>
              {bulkResult.success} VIN{bulkResult.success !== 1 ? 's' : ''} uploaded{bulkResult.failed > 0 ? ` · ${bulkResult.failed} failed` : ''}{bulkResult.skipped ? ` · ${bulkResult.skipped} duplicate${bulkResult.skipped !== 1 ? 's' : ''} skipped` : ''}
            </div>
          )}
        </div>
      )}

      {/* Vendor Invoices tab — record what a CNI installer billed us per VIN */}
      {tab === 'vendor' && (
        <VendorInvoicesTab
          allParts={allParts}
          allLocations={allLocations}
          poRequired={poRequired}
          billableCustomers={billableCustomers}
          onCommitted={loadAll}
          onPartAdded={p => setAllParts(prev => prev.some(x => x.id === p.id) ? prev.map(x => x.id === p.id ? p : x) : [p, ...prev])}
        />
      )}

      {/* Empty state */}
      {isScanListTab && tabScans.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          {tab === 'ready' ? 'No scans ready to export' : tab === 'waiting' ? 'No scans waiting for PO — all matched!' : tab === 'all' ? ((dateFrom || dateTo) ? 'No scans in this date range' : 'No scans yet') : 'No exported scans'}
        </div>
      )}

      {/* All Scans tab — flat chronological list, newest first, with a
          lifecycle chip per scan. Capped to keep huge histories responsive;
          the date filter narrows the set. */}
      {tab === 'all' && (() => {
        const CAP = 500;
        const visible = tabScans.slice(0, CAP);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {visible.map(scan => {
              const st = scanStatus(scan);
              return (
                <div key={scan.id} style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '6px 10px', borderRadius: '6px',
                  background: 'var(--card)', border: '1px solid var(--border)',
                }}>
                  <input type="checkbox" checked={selectedScans.has(scan.id)} onChange={() => toggleSelect(scan.id)} style={{ width: '14px', height: '14px', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {[scan.vehicle_year, scan.vehicle_make, scan.vehicle_model].filter(Boolean).join(' ') || 'Unknown'}
                      {scan.billable_customer && <span style={{ fontWeight: 600, color: '#a78bfa', marginLeft: '6px' }}>{scan.billable_customer}</span>}
                    </div>
                    <div style={{ fontSize: '9px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{scan.vin}</div>
                    {(scan.part_number || scan.location_name) && (
                      <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginTop: '1px' }}>
                        {scan.part_number && (
                          <PartLabel partNumber={scan.part_number} fallbackDescription={scan.part_description} />
                        )}
                        {scan.location_name && <span style={{ color: 'var(--text-muted)' }}>{scan.part_number ? ' · ' : ''}{scan.location_name}</span>}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                    <span style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: st.bg, color: st.color, whiteSpace: 'nowrap' }}>
                      {st.label}
                    </span>
                    {scan.unit_number && (
                      <span style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                        Unit {scan.unit_number}
                      </span>
                    )}
                    {scan.po_number && (
                      <span style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
                        PO #{scan.po_number}
                      </span>
                    )}
                    {cniByScanId[scan.id] && (
                      <span style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(6,182,212,0.12)', color: '#06b6d4' }}>
                        {cniByScanId[scan.id]}
                      </span>
                    )}
                    {scan.install_cost != null && (
                      <span title={scan.installer_name ? `Paid to ${scan.installer_name}` : 'Installer cost'} style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(244,114,182,0.12)', color: '#f472b6' }}>
                        ${Number(scan.install_cost).toFixed(2)}
                      </span>
                    )}
                    {/* Who did the install (person + company) — the scanning
                        account stays on the tooltip and in the Edit modal. */}
                    <div
                      title={profiles[scan.scanned_by || ''] ? `Scanned by ${profiles[scan.scanned_by || '']}` : undefined}
                      style={{ fontSize: '9px', color: 'var(--text-muted)', textAlign: 'right' }}
                    >
                      {installerNamesOf(scan).length > 0 && (<>{installerNamesOf(scan).join(', ')}<br /></>)}
                      {installerCompanyOf(scan) && (<>{installerCompanyOf(scan)}<br /></>)}
                      {new Date(scan.scanned_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </div>
                    <button onClick={() => setEditingScan({ ...scan })} style={{ padding: '2px 5px', borderRadius: '4px', border: 'none', background: 'rgba(59,130,246,0.08)', color: '#60a5fa', fontSize: '9px', fontWeight: 700, cursor: 'pointer' }}>Edit</button>
                    <button onClick={() => deleteScan(scan.id)} style={{ padding: '2px 5px', borderRadius: '4px', border: 'none', background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: '9px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
                  </div>
                </div>
              );
            })}
            {tabScans.length > CAP && (
              <div style={{ textAlign: 'center', padding: '10px 0', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 600 }}>
                Showing first {CAP} of {tabScans.length} scans — narrow the date range or search to see the rest
              </div>
            )}
          </div>
        );
      })()}

      {/* Grouped list */}
      {isScanListTab && tab !== 'all' && <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {customerKeys.map(customer => {
          const subGroups = grouped[customer];
          const subKeys = Object.keys(subGroups).sort((a, b) => {
            if (tab === 'archived') {
              const aMax = maxInvoiceIn(subGroups[a]);
              const bMax = maxInvoiceIn(subGroups[b]);
              if (aMax && bMax) return compareInvoice(aMax, bMax);
              if (aMax) return -1;
              if (bMax) return 1;
            }
            return a.localeCompare(b);
          });
          const totalVins = subKeys.reduce((sum, k) => sum + subGroups[k].length, 0);
          const isCustomerCollapsed = !expandedGroups.has(customer);

          const customerScanIds = subKeys.flatMap(k => subGroups[k].map(s => s.id));
          const allCustomerSelected = customerScanIds.length > 0 && customerScanIds.every(id => selectedScans.has(id));

          return (
            <div key={customer}>
              {/* Customer header */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px', borderRadius: '10px',
                background: 'var(--card)', border: '1px solid var(--border)', marginBottom: isCustomerCollapsed ? 0 : '6px',
              }}>
                <div onClick={() => toggleGroup(customer)} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', flex: 1 }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', transition: 'transform 0.15s', transform: isCustomerCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                  <span style={{ fontWeight: 800, fontSize: '14px', color: 'var(--text-primary)' }}>{customer}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {tab === 'archived' && (() => {
                    const selectedCustomerScans = customerScanIds.filter(id => selectedScans.has(id));
                    const sourceScans = selectedCustomerScans.length > 0
                      ? subKeys.flatMap(k => subGroups[k]).filter(s => selectedScans.has(s.id))
                      : subKeys.flatMap(k => subGroups[k]);
                    const invoiceMap = new Map<string, { invoiceNumber: string; po?: string }>();
                    for (const s of sourceScans) {
                      if (s.invoice_number && !invoiceMap.has(s.invoice_number)) {
                        invoiceMap.set(s.invoice_number, {
                          invoiceNumber: s.invoice_number,
                          po: s.po_number || undefined,
                        });
                      }
                    }
                    const invoicesForCustomer = [...invoiceMap.values()]
                      .sort((a, b) => compareInvoice(a.invoiceNumber, b.invoiceNumber));
                    if (invoicesForCustomer.length === 0) return null;
                    return (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEmailTarget({ customerName: customer, invoices: invoicesForCustomer });
                        }}
                        style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', cursor: 'pointer', whiteSpace: 'nowrap' }}
                        title={selectedCustomerScans.length > 0 ? 'Email invoices for selected scans' : 'Email all invoices for this customer'}
                      >
                        Email {invoicesForCustomer.length} Invoice{invoicesForCustomer.length !== 1 ? 's' : ''}
                      </button>
                    );
                  })()}
                  <button onClick={(e) => { e.stopPropagation(); toggleSelectGroup(customerScanIds); }} style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: allCustomerSelected ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', cursor: 'pointer' }}>
                    {allCustomerSelected ? 'Deselect' : 'Select'} All
                  </button>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>{totalVins} VIN{totalVins !== 1 ? 's' : ''}</span>
                </div>
              </div>

              {!isCustomerCollapsed && (
                <div style={{ paddingLeft: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {subKeys.map(subKey => {
                    const groupScans = subGroups[subKey];
                    const subCollapsed = !expandedGroups.has(`${customer}|${subKey}`);
                    const isPOGroup = subKey.startsWith('PO #');
                    const uniqueParts = isPOGroup ? [...new Set(groupScans.map(s => s.part_number).filter(Boolean))] : [];
                    const [partLabel, locLabel] = isPOGroup
                      ? [subKey, groupScans[0]?.location_name || '']
                      : subKey.split(' · ');
                    const groupIds = groupScans.map(s => s.id);
                    const allGroupSelected = groupIds.length > 0 && groupIds.every(id => selectedScans.has(id));

                    return (
                      <div key={subKey}>
                        {/* Part + location sub-header */}
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '6px 10px', borderRadius: '8px',
                          background: 'var(--subtle-bg)', border: '1px solid var(--border)', marginBottom: subCollapsed ? 0 : '3px',
                        }}>
                          <div onClick={() => toggleGroup(`${customer}|${subKey}`)} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: '9px', color: 'var(--text-muted)', transform: subCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', flexShrink: 0 }}>▼</span>
                            <span style={{ fontSize: '12px', fontWeight: 700, color: isPOGroup ? '#22c55e' : 'var(--text-primary)', flexShrink: 0 }}>{partLabel}</span>
                            {isPOGroup ? (
                              uniqueParts.length > 0 && <span style={{ fontSize: '10px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{uniqueParts.join(', ')}</span>
                            ) : groupScans[0]?.part_description ? (
                              <span style={{ fontSize: '10px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{groupScans[0].part_description}</span>
                            ) : null}
                            {locLabel && <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>{locLabel}</span>}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <button onClick={(e) => { e.stopPropagation(); toggleSelectGroup(groupIds); }} style={{ padding: '2px 6px', borderRadius: '4px', fontSize: '8px', fontWeight: 700, background: allGroupSelected ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', cursor: 'pointer' }}>
                              {allGroupSelected ? 'Deselect' : 'Select'}
                            </button>
                            {!isPOGroup && groupScans[0]?.po_number && <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>PO #{groupScans[0].po_number}</span>}
                            <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>{groupScans.length}</span>
                          </div>
                        </div>

                        {/* Invoice tracking for archived groups */}
                        {tab === 'archived' && (() => {
                          const first = groupScans[0];
                          const invNum = (first as any).invoice_number || '';
                          const invDate = (first as any).date_invoiced || '';
                          const isPaid = (first as any).is_paid || false;
                          const updateGroupInvoice = async (field: string, value: any) => {
                            await supabase.from('scan_logs').update({ [field]: value }).in('id', groupIds);
                            setArchivedScans(prev => prev.map(s => groupIds.includes(s.id) ? { ...s, [field]: value } as any : s));
                          };
                          return (
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', padding: '5px 10px', flexWrap: 'wrap' }}>
                              <input
                                value={invNum}
                                placeholder="Invoice #"
                                onClick={(e) => e.stopPropagation()}
                                onBlur={async (e) => { await updateGroupInvoice('invoice_number', e.target.value || null); }}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setArchivedScans(prev => prev.map(s => groupIds.includes(s.id) ? { ...s, invoice_number: val } as any : s));
                                }}
                                style={{ width: '100px', padding: '4px 6px', borderRadius: '4px', fontSize: '10px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }}
                              />
                              <input
                                type="date"
                                value={invDate}
                                onClick={(e) => e.stopPropagation()}
                                onChange={async (e) => { await updateGroupInvoice('date_invoiced', e.target.value || null); }}
                                style={{ width: '120px', padding: '4px 6px', borderRadius: '4px', fontSize: '10px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }}
                              />
                              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }} onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={isPaid}
                                  onChange={async (e) => { await updateGroupInvoice('is_paid', e.target.checked); }}
                                  style={{ width: '12px', height: '12px', accentColor: '#22c55e' }}
                                />
                                <span style={{ fontSize: '10px', fontWeight: 700, color: isPaid ? '#4ade80' : '#fbbf24' }}>
                                  {isPaid ? 'Paid' : 'Unpaid'}
                                </span>
                              </label>
                            </div>
                          );
                        })()}

                        {/* VIN list */}
                        {!subCollapsed && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '10px' }}>
                            {groupScans.map(scan => (
                              <div key={scan.id}>
                              <div style={{
                                display: 'flex', alignItems: 'center', gap: '8px',
                                padding: '6px 10px', borderRadius: '6px',
                                background: 'var(--card)', border: `1px solid ${scan.po_id ? 'rgba(34,197,94,0.15)' : 'var(--border)'}`,
                              }}>
                                <input type="checkbox" checked={selectedScans.has(scan.id)} onChange={() => toggleSelect(scan.id)} style={{ width: '14px', height: '14px', flexShrink: 0 }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>
                                    {[scan.vehicle_year, scan.vehicle_make, scan.vehicle_model].filter(Boolean).join(' ') || 'Unknown'}
                                  </div>
                                  <div style={{ fontSize: '9px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{scan.vin}</div>
                                  {scan.part_number && (
                                    <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginTop: '1px' }}>
                                      <PartLabel
                                        partNumber={scan.part_number}
                                        fallbackDescription={scan.part_description}
                                      />
                                    </div>
                                  )}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                                  {scan.unit_number && (
                                    <span style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                                      Unit {scan.unit_number}
                                    </span>
                                  )}
                                  {scan.po_number && (
                                    <span style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
                                      PO #{scan.po_number}
                                    </span>
                                  )}
                                  {/* Why this scan is in Exported: which path stamped it, when, by whom (K9). */}
                                  {tab === 'exported' && scan.exported_at && (
                                    <span
                                      title={`Exported ${new Date(scan.exported_at).toLocaleString()}${profiles[scan.exported_by || ''] ? ` by ${profiles[scan.exported_by || '']}` : ''}${scan.invoice_number ? ` — back-stamped by invoicing (#${scan.invoice_number})` : ' — via CSV export'}`}
                                      style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(96,165,250,0.12)', color: '#60a5fa', whiteSpace: 'nowrap' }}
                                    >
                                      {scan.invoice_number ? `Invoiced #${scan.invoice_number}` : 'CSV export'}
                                      {' · '}{new Date(scan.exported_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                      {profiles[scan.exported_by || ''] ? ` · ${profiles[scan.exported_by || '']}` : ''}
                                    </span>
                                  )}
                                  {cniByScanId[scan.id] && (
                                    <span style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(6,182,212,0.12)', color: '#06b6d4' }}>
                                      {cniByScanId[scan.id]}
                                    </span>
                                  )}
                                  {(photosByScanId[scan.id]?.length ?? 0) > 0 && (
                                    <a
                                      href={storage.from('photos').getPublicUrl(photosByScanId[scan.id][0]).data.publicUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title={`${photosByScanId[scan.id].length} completion photo${photosByScanId[scan.id].length !== 1 ? 's' : ''} — click to view`}
                                      onClick={e => e.stopPropagation()}
                                      style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', color: '#22c55e', textDecoration: 'none' }}
                                    >
                                      {photosByScanId[scan.id].length} photo{photosByScanId[scan.id].length !== 1 ? 's' : ''}
                                    </a>
                                  )}
                                  {scan.install_cost != null && (
                                    <span title={scan.installer_name ? `Paid to ${scan.installer_name}` : 'Installer cost'} style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(244,114,182,0.12)', color: '#f472b6' }}>
                                      ${Number(scan.install_cost).toFixed(2)}
                                    </span>
                                  )}
                                  {/* Who did the install — scanner on the tooltip. */}
                                  <div
                                    title={profiles[scan.scanned_by || ''] ? `Scanned by ${profiles[scan.scanned_by || '']}` : undefined}
                                    style={{ fontSize: '9px', color: 'var(--text-muted)', textAlign: 'right' }}
                                  >
                                    {installerNamesOf(scan).length > 0 && (<>{installerNamesOf(scan).join(', ')}<br /></>)}
                                    {installerCompanyOf(scan) && (<>{installerCompanyOf(scan)}<br /></>)}
                                    {new Date(scan.scanned_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                  </div>
                                  <button onClick={() => setEditingScan({ ...scan })} style={{ padding: '2px 5px', borderRadius: '4px', border: 'none', background: 'rgba(59,130,246,0.08)', color: '#60a5fa', fontSize: '9px', fontWeight: 700, cursor: 'pointer' }}>Edit</button>
                                  <button onClick={() => deleteScan(scan.id)} style={{ padding: '2px 5px', borderRadius: '4px', border: 'none', background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: '9px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
                                </div>
                              </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>}

      {/* Edit scan modal */}
      {editingScan && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }} onClick={() => setEditingScan(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '14px', padding: '20px', width: '100%', maxWidth: '450px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '12px' }}>Edit Scan</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>VIN</div>
                <input value={editingScan.vin} onChange={e => setEditingScan({ ...editingScan, vin: e.target.value.toUpperCase() })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace' }} />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Year</div>
                <input value={editingScan.vehicle_year || ''} onChange={e => setEditingScan({ ...editingScan, vehicle_year: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Make</div>
                <input value={editingScan.vehicle_make || ''} onChange={e => setEditingScan({ ...editingScan, vehicle_make: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Model</div>
                <input value={editingScan.vehicle_model || ''} onChange={e => setEditingScan({ ...editingScan, vehicle_model: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
              </div>
              <div style={{ position: 'relative' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Part Number</div>
                <input
                  value={editingScan.part_number || ''}
                  onChange={e => setEditingScan({ ...editingScan, part_number: e.target.value })}
                  style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }}
                />
                {(editingScan.part_number || '').length >= 2 && (() => {
                  const q = (editingScan.part_number || '').toLowerCase();
                  const matches = allParts.filter(p =>
                    p.item_number.toLowerCase() !== q && (
                      p.item_number.toLowerCase().includes(q) ||
                      p.display_name?.toLowerCase().includes(q) ||
                      p.billable_customer?.toLowerCase().includes(q)
                    )
                  ).slice(0, 8);
                  if (matches.length === 0) return null;
                  return (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '180px', overflowY: 'auto', marginTop: '2px' }}>
                      {matches.map(p => (
                        <button
                          key={p.id}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => setEditingScan({
                            ...editingScan,
                            part_number: p.item_number,
                            part_description: p.display_name,
                            ...(editingScan.billable_customer ? {} : { billable_customer: p.billable_customer }),
                          })}
                          style={{ display: 'block', width: '100%', padding: '6px 8px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '11px', color: 'var(--text-primary)' }}
                        >
                          <span style={{ fontWeight: 700 }}>{p.item_number}</span>
                          {p.billable_customer && <span style={{ color: '#a78bfa', marginLeft: '6px' }}>{p.billable_customer}</span>}
                          {p.display_name && <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{p.display_name}</div>}
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
              <div style={{ position: 'relative' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Billable Customer</div>
                <input
                  value={editingScan.billable_customer || ''}
                  onChange={e => setEditingScan({ ...editingScan, billable_customer: e.target.value })}
                  style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }}
                />
                {customerQuickPick(editingScan.billable_customer || '', n => setEditingScan({ ...editingScan, billable_customer: n || null }))}
                {(editingScan.billable_customer || '').length >= 1 && (() => {
                  const q = (editingScan.billable_customer || '').toLowerCase();
                  const set = new Set<string>();
                  for (const p of allParts) {
                    const c = (p.billable_customer || '').trim();
                    if (c && c.toLowerCase() !== q && c.toLowerCase().includes(q)) set.add(c);
                  }
                  const matches = [...set].sort().slice(0, 8);
                  if (matches.length === 0) return null;
                  return (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '180px', overflowY: 'auto', marginTop: '2px' }}>
                      {matches.map(c => (
                        <button
                          key={c}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => setEditingScan({ ...editingScan, billable_customer: c })}
                          style={{ display: 'block', width: '100%', padding: '6px 8px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '11px', color: 'var(--text-primary)' }}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Unit #</div>
                <input value={editingScan.unit_number || ''} onChange={e => setEditingScan({ ...editingScan, unit_number: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Location</div>
                <input value={editingScan.location_name || ''} onChange={e => setEditingScan({ ...editingScan, location_name: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
              </div>
            </div>

            {/* Verizon RFID device identifiers — shown for the Verizon part or any
                scan that already carries device data. */}
            {((editingScan.part_number || '').toUpperCase().replace(/O/g, '0').replace(/\s+/g, '') === '06CS901033'
              || editingScan.serial_number || editingScan.imei || editingScan.iccid) && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '12px' }}>
                <div>
                  <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Serial # (SN)</div>
                  <input value={editingScan.serial_number || ''} onChange={e => setEditingScan({ ...editingScan, serial_number: e.target.value.toUpperCase() })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'monospace' }} />
                </div>
                <div>
                  <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>IMEI</div>
                  <input value={editingScan.imei || ''} onChange={e => setEditingScan({ ...editingScan, imei: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'monospace' }} />
                </div>
                <div>
                  <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>CCID</div>
                  <input value={editingScan.iccid || ''} onChange={e => setEditingScan({ ...editingScan, iccid: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'monospace' }} />
                </div>
              </div>
            )}
            {/* Attribution record — read-only. The installer is whoever the
                work is credited to; the scanner is the account that logged
                the row (kept for the audit trail even when it's an admin). */}
            {(() => {
              const names = installerNamesOf(editingScan);
              const company = installerCompanyOf(editingScan);
              return (
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.6 }}>
                  <span style={{ fontWeight: 700 }}>Installer:</span>{' '}
                  {names.length > 0 ? names.join(', ') : (company || '—')}
                  {names.length > 0 && company ? ` · ${company}` : ''}
                  <br />
                  <span style={{ fontWeight: 700 }}>Scanned by:</span>{' '}
                  {profiles[editingScan.scanned_by || ''] || '—'} · {new Date(editingScan.scanned_at).toLocaleString()}
                </div>
              );
            })()}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setEditingScan(null)} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'transparent', border: `1px solid ${theme.border}`, color: 'var(--text-body)', cursor: 'pointer' }}>Cancel</button>
              <button onClick={saveEditScan} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {createItemFor !== null && (
        <CreateNetsuiteItemModal
          initialPartNumber={createItemFor}
          billableCustomer={bulkCustomer.trim() || null}
          onClose={() => setCreateItemFor(null)}
          onCreated={(part: CreatedPart) => {
            setAllParts(prev => [{ id: part.id, item_number: part.item_number, display_name: part.display_name, billable_customer: part.billable_customer, vehicle_type: null, graphic_package: null }, ...prev]);
            setBulkParts(prev => [...prev, {
              id: part.id,
              label: `${part.item_number}${part.billable_customer ? ` — ${part.billable_customer}` : ''}`,
              partNumber: part.item_number,
              description: part.display_name,
              customer: part.billable_customer,
            }]);
            setBulkPartSearch('');
            setCreateItemFor(null);
          }}
        />
      )}
    </div>
  );
}

// ---------- Vendor Invoices tab ----------
// Upload (or hand-enter) a CNI installer's invoice: AI pulls the vendor,
// invoice number, total, and per-VIN amounts; everything is editable before
// committing. VINs already in the system get the cost stamped on their
// existing scan without touching its lifecycle state; new VINs become fresh
// scan_logs rows. Installers not in the system yet can be added inline
// (creates the company + the NetSuite vendor).

interface VendorLine {
  key: number; // stable identity — index-based updates misfire when rows are removed mid-flight
  vin: string;
  partNumber: string;
  amount: string;
  existing: string | null; // lifecycle label when the VIN is already a scan
  lastChecked?: string; // vin|part key of the last existing-scan lookup, to skip redundant queries
  selected?: boolean; // multi-select for applying a part to many lines at once
}

interface VendorReview {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  totalAmount: string;
  notes: string;
  lines: VendorLine[];
}

interface VendorCompany { id: string; name: string; netsuite_vendor_id: string | null }

interface VendorInvoiceRecord {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  vendor_name: string;
  total_amount: number | null;
  location_name: string | null;
  file_name: string | null;
  storage_path: string | null;
  notes: string | null;
  created_at: string;
  status: string;
  rejection_reason: string | null;
  netsuite_bill_id: string | null;
  company: VendorCompany | null;
  lines: { id: string; vin: string; part_number: string | null; amount: number | null; was_existing_scan: boolean; scan_log_id: string | null }[];
}

// Payment-pipeline chip per vendor_invoices.status (see /admin/ap for the queue).
const INVOICE_STATUS_CHIP: Record<string, { label: string; color: string; bg: string }> = {
  recorded: { label: 'Not Submitted', color: 'var(--text-muted)', bg: 'rgba(148,163,184,0.12)' },
  submitted: { label: 'Awaiting Approval', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  approved: { label: 'Approved', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  rejected: { label: 'Rejected', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  billed: { label: 'Billed', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
  paid: { label: 'Paid', color: '#34d399', bg: 'rgba(52,211,153,0.12)' },
};

function VendorInvoicesTab({ allParts, allLocations, poRequired, billableCustomers, onCommitted, onPartAdded }: {
  allParts: { id: string; item_number: string; display_name: string | null; billable_customer: string | null; vehicle_type: string | null; graphic_package: string | null }[];
  allLocations: { id: string; name: string }[];
  poRequired: Record<string, boolean>;
  // The customer-level PO waiver list, for the same lifecycle labels the
  // parent's tabs derive (invoice-first customers are Ready without a PO).
  billableCustomers: BillableCustomer[];
  onCommitted: () => void;
  onPartAdded: (p: { id: string; item_number: string; display_name: string | null; billable_customer: string | null; vehicle_type: string | null; graphic_package: string | null }) => void;
}) {
  const dialog = useDialog();
  const supabase = createClient();

  const [extracting, setExtracting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<VendorReview | null>(null);
  const [stagedFile, setStagedFile] = useState<{ storagePath: string; fileName: string } | null>(null);

  // Vendor picker
  const [companies, setCompanies] = useState<VendorCompany[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<VendorCompany | null>(null);
  const [showVendorDropdown, setShowVendorDropdown] = useState(false);
  const [addVendorOpen, setAddVendorOpen] = useState(false);
  const [addVendorEmail, setAddVendorEmail] = useState('');
  const [addVendorPhone, setAddVendorPhone] = useState('');
  const [addingVendor, setAddingVendor] = useState(false);

  const [vLocation, setVLocation] = useState('');
  const [partSearchKey, setPartSearchKey] = useState<number | null>(null);
  const lineKeyRef = useRef(0);
  // Bulk-upload style default part: fills every line that doesn't carry its
  // own part number (per-line entries and scan-matched parts win).
  const [defaultPart, setDefaultPart] = useState<{ item_number: string; display_name: string | null } | null>(null);
  const [defaultPartSearch, setDefaultPartSearch] = useState('');
  const [addVendorName, setAddVendorName] = useState('');
  // Live NetSuite vendor search results — existing NetSuite vendors get
  // LINKED to a company here instead of a duplicate being created. The
  // search state is surfaced in the dropdown so "not in NetSuite" and
  // "NetSuite search unavailable" are distinguishable at a glance.
  const [nsVendors, setNsVendors] = useState<{ id: string; entityId: string; companyName: string }[]>([]);
  const [nsSearchState, setNsSearchState] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [nsError, setNsError] = useState<string | null>(null);
  const [linkingVendor, setLinkingVendor] = useState(false);
  // The selected vendor's remembered per-part rates (newest priced invoice
  // line per part) — auto-fills empty amounts.
  const [vendorRates, setVendorRates] = useState<Record<string, { amount: number; invoiceNumber: string | null; date: string | null }>>({});
  // "Apply part/price to selected lines" bar
  const [applyPartSearch, setApplyPartSearch] = useState('');
  const [applyAmount, setApplyAmount] = useState('');
  const [showApplyPartDropdown, setShowApplyPartDropdown] = useState(false);

  // Retroactive upload: the invoice was already processed and paid outside
  // the app — record it as paid, skipping the approval pipeline.
  const [alreadyPaid, setAlreadyPaid] = useState(false);
  // Bulk add: paste VIN / part / amount rows straight from a spreadsheet.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);

  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<{
    updated: { vin: string; state: string }[];
    created: { vin: string; state: string }[];
    failed: { vin: string; error: string }[];
  } | null>(null);

  const [history, setHistory] = useState<VendorInvoiceRecord[]>([]);
  const [expandedInvoices, setExpandedInvoices] = useState<Set<string>>(new Set());
  const [deletingInvoice, setDeletingInvoice] = useState<string | null>(null);
  const [submittingInvoice, setSubmittingInvoice] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from('companies').select('id, name, netsuite_vendor_id').order('name');
      setCompanies((data || []) as VendorCompany[]);
    };
    load();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, []);

  const loadHistory = async () => {
    try {
      const res = await fetch('/api/vendor-invoices');
      const data = await res.json();
      if (res.ok) setHistory(data.invoices || []);
    } catch { /* history is non-critical */ }
  };

  // Debounced NetSuite vendor search while typing in the picker.
  const vendorQuery = review && !selectedCompany ? review.vendorName.trim() : '';
  useEffect(() => {
    if (vendorQuery.length < 2) { setNsVendors([]); setNsSearchState('idle'); setNsError(null); return; }
    setNsSearchState('searching');
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/cni/search-vendors?q=${encodeURIComponent(vendorQuery)}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok && !data.error) {
          setNsVendors(data.vendors || []);
          setNsError(null);
          setNsSearchState('done');
        } else {
          setNsVendors([]);
          setNsError(data.error || `search failed (${res.status})`);
          setNsSearchState('error');
        }
      } catch (err: any) {
        setNsVendors([]);
        setNsError(err.message || 'network error');
        setNsSearchState('error');
      }
    }, 350);
    return () => clearTimeout(t);
  }, [vendorQuery]);

  // Pull the vendor's remembered per-part rates and fill any empty amounts —
  // "this installer charges $145 for 06T895" carries forward automatically.
  const applyRememberedRates = async (vendor: { companyId?: string; vendorName?: string }) => {
    if (!vendor.companyId && !vendor.vendorName?.trim()) return;
    try {
      const params = vendor.companyId
        ? `companyId=${vendor.companyId}`
        : `vendorName=${encodeURIComponent(vendor.vendorName!.trim())}`;
      const res = await fetch(`/api/vendor-invoices/rates?${params}`);
      const data = await res.json();
      if (!res.ok) return;
      const rates: Record<string, { amount: number; invoiceNumber: string | null; date: string | null }> = data.rates || {};
      setVendorRates(rates);
      setReview(prev => prev ? {
        ...prev,
        lines: prev.lines.map(l => {
          const rate = l.partNumber.trim() ? rates[l.partNumber.trim().toUpperCase()] : undefined;
          return !l.amount.trim() && rate ? { ...l, amount: String(rate.amount) } : l;
        }),
      } : prev);
    } catch { /* best-effort */ }
  };

  // Link an existing NetSuite vendor to a FleetSuite company (creating the
  // company row if needed) — never mints a duplicate NetSuite vendor.
  const linkNsVendor = async (v: { id: string; entityId: string; companyName: string }) => {
    setLinkingVendor(true);
    try {
      const res = await fetch('/api/cni/create-vendor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: v.companyName || v.entityId, netsuiteVendorId: v.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        await dialog.alert(`Failed to link NetSuite vendor: ${data.error || 'unknown error'}`);
      } else {
        const company: VendorCompany = { id: data.companyId, name: data.companyName, netsuite_vendor_id: data.netsuiteVendorId || null };
        setCompanies(prev => prev.some(c => c.id === company.id) ? prev.map(c => c.id === company.id ? company : c) : [...prev, company].sort((a, b) => a.name.localeCompare(b.name)));
        setSelectedCompany(company);
        setReview(prev => prev ? { ...prev, vendorName: company.name } : prev);
        setShowVendorDropdown(false);
        if (data.vendorError) setNotice(data.vendorError);
        applyRememberedRates({ companyId: company.id });
      }
    } catch (err: any) {
      await dialog.alert(`Failed to link NetSuite vendor: ${err.message}`);
    }
    setLinkingVendor(false);
  };

  // A part the local catalog doesn't know may still exist in NetSuite —
  // check there and mirror it in, so it's found now and forever after.
  const [mirroringPart, setMirroringPart] = useState(false);
  const mirrorPartFromNetsuite = async (query: string): Promise<{ item_number: string } | null> => {
    const pn = query.trim();
    if (pn.length < 2) return null;
    setMirroringPart(true);
    try {
      const res = await fetch('/api/parts/mirror', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partNumber: pn }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.found && data.part) {
        onPartAdded({
          id: data.part.id,
          item_number: data.part.item_number,
          display_name: data.part.display_name,
          billable_customer: data.part.billable_customer,
          vehicle_type: data.part.vehicle_type ?? null,
          graphic_package: data.part.graphic_package ?? null,
        });
        if (data.mirrored) setNotice(`${data.part.item_number} found in NetSuite — added to the catalog. It won't be flagged again.`);
        return data.part;
      }
      setNotice(`"${pn}" isn't in NetSuite items either — check the number, or create it with "+ Create in NetSuite" on the Bulk Upload tab.`);
      return null;
    } catch (err: any) {
      setNotice(`NetSuite item check failed: ${err.message}`);
      return null;
    } finally {
      setMirroringPart(false);
    }
  };

  const applyPartToSelected = (partNumber: string) => {
    const part = partNumber.trim();
    const amount = applyAmount.trim();
    if ((!part && !amount) || !review) return;
    setReview(prev => prev ? {
      ...prev,
      lines: prev.lines.map(l => l.selected ? {
        ...l,
        ...(part ? { partNumber: part } : {}),
        ...(amount ? { amount } : {}),
        selected: false,
      } : l),
    } : prev);
    setApplyPartSearch('');
    setApplyAmount('');
    setShowApplyPartDropdown(false);
    if (part) {
      // The newly assigned part may have a remembered rate for this vendor.
      applyRememberedRates(selectedCompany ? { companyId: selectedCompany.id } : { vendorName: review.vendorName });
      // Re-tag the lines the part landed on — a badge inherited from a
      // different install on the same vehicle (e.g. "Invoiced #…") must be
      // re-derived for THIS part, not linger from the old guess.
      recheckLines(review.lines.filter(l => l.selected).map(l => ({ ...l, partNumber: part })));
    }
  };

  // Same lifecycle labels the scan tabs derive (shared scanLifecycle), for
  // the "already in system" badges shown before committing.
  const stateLabelFor = (s: { part_number: string | null; po_id: string | null; exported_at: string | null; archived_at: string | null; billable_customer?: string | null; invoice_number?: string | null; date_invoiced?: string | null; is_paid?: boolean | null }): string =>
    scanLifecycle(s, (part, cust) =>
      poRequired[part || ''] !== false && customerRequiresPo(cust, billableCustomers)).label;

  // Look up which of the review VINs are already scans and tag each line
  // with the state its record is in — the same matching rule the commit
  // endpoint applies (same-vehicle last-8; part-aware attachment).
  const checkExistingVins = async (lines: VendorLine[]): Promise<VendorLine[]> => {
    const scans = await fetchScansMatchingVins<{ vin: string; part_number: string | null; po_id: string | null; exported_at: string | null; archived_at: string | null; billable_customer: string | null; invoice_number: string | null; date_invoiced: string | null; is_paid: boolean | null }>(
      supabase,
      lines.map(l => l.vin),
      'vin, part_number, po_id, exported_at, archived_at, billable_customer, invoice_number, date_invoiced, is_paid, scanned_at',
    );
    return lines.map(line => {
      const match = pickScanForLine(scans, line.vin, line.partNumber.trim() || null);
      // The matched scan already knows what was installed — adopt its part
      // when the line doesn't have one, so the invoice imports like a scan.
      const partNumber = line.partNumber.trim() || match?.part_number || line.partNumber;
      return {
        ...line,
        partNumber,
        existing: match ? stateLabelFor(match) : null,
        lastChecked: `${line.vin.trim().replace(/[^A-Za-z0-9]/g, '')}|${partNumber.trim().toUpperCase()}`,
      };
    });
  };

  const blankLine = (): VendorLine => ({ key: ++lineKeyRef.current, vin: '', partNumber: defaultPart?.item_number || '', amount: '', existing: null });

  // One definition of "this line has a usable VIN" — the commit filter, the
  // button count, and the recheck all share it.
  const vinOk = (l: VendorLine) => l.vin.trim().replace(/[^A-Za-z0-9]/g, '').length >= 5;

  const startManualEntry = () => {
    setNotice(null);
    setCommitResult(null);
    setVendorRates({});
    setNsVendors([]);
    setReview({ vendorName: '', invoiceNumber: '', invoiceDate: '', dueDate: '', totalAmount: '', notes: '', lines: [blankLine()] });
  };

  // Files beyond Vercel's ~4.5MB request-body ceiling can't reach the
  // extract endpoint at all — skip the call instead of letting it fail.
  const MAX_EXTRACT_BYTES = 3.5 * 1024 * 1024;

  const handleInvoiceFile = async (file: File) => {
    setNotice(null);
    setCommitResult(null);
    setExtracting(true);
    try {
      const mediaType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');

      // Stage the original invoice in R2 so the record keeps its source doc —
      // kicked off first and always awaited, whatever extraction does.
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
      const storagePath = `vendor-invoices/${Date.now()}-${safeName}`;
      const uploadPromise = storage.from('invoices').upload(storagePath, file, { contentType: mediaType });

      let extracted: any = null;
      let extractError: string | null = null;
      if (file.size > MAX_EXTRACT_BYTES) {
        extractError = `This file is too large for AI extraction (${(file.size / 1048576).toFixed(1)}MB, limit ~3.5MB). It still attaches to the record — enter the details manually below.`;
      } else {
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
          });
          const res = await fetch('/api/vendor-invoices/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileBase64: base64, mediaType }),
          });
          // Oversized/platform errors come back as non-JSON — don't throw past the upload await.
          const result = await res.json().catch(() => ({}));
          if (!res.ok || !result.data) extractError = result.error || `AI extraction failed (${res.status})`;
          else extracted = result.data;
        } catch (err: any) {
          extractError = err.message || 'AI extraction failed';
        }
      }

      const { error: upErr } = await uploadPromise;
      setStagedFile(upErr ? null : { storagePath, fileName: file.name });
      if (upErr) setNotice(`Invoice file could not be attached (${upErr.message}) — the record will save without the file.`);

      if (!extracted) {
        // Extraction failing never blocks the flow — fall back to manual entry.
        setNotice(prev => [prev, `AI couldn't read this invoice: ${extractError}`].filter(Boolean).join('\n'));
        setReview({ vendorName: '', invoiceNumber: '', invoiceDate: '', dueDate: '', totalAmount: '', notes: '', lines: [blankLine()] });
      } else {
        const d = extracted;
        let lines: VendorLine[] = (d.lines || []).map((l: any) => ({
          key: ++lineKeyRef.current,
          vin: l.vin || '',
          partNumber: l.part_number || '',
          amount: l.amount != null ? String(l.amount) : '',
          existing: null,
        }));
        if (lines.length === 0) lines = [blankLine()];
        lines = await checkExistingVins(lines);
        const matchedCompany = d.vendor_name
          ? companies.find(c => c.name.toLowerCase() === d.vendor_name.toLowerCase()) || null
          : null;
        setSelectedCompany(matchedCompany);
        setVendorRates({});
        setReview({
          vendorName: matchedCompany?.name || d.vendor_name || '',
          invoiceNumber: d.invoice_number || '',
          invoiceDate: d.invoice_date || '',
          dueDate: d.due_date || '',
          totalAmount: d.total_amount != null ? String(d.total_amount) : '',
          notes: d.notes || '',
          lines,
        });
        // Remembered rates fill any amounts the invoice didn't spell out.
        applyRememberedRates(matchedCompany ? { companyId: matchedCompany.id } : { vendorName: d.vendor_name || '' });
      }
    } catch (err: any) {
      setNotice(`Upload failed: ${err.message}`);
    }
    setExtracting(false);
  };

  const updateLine = (key: number, patch: Partial<VendorLine>) => {
    setReview(prev => prev ? { ...prev, lines: prev.lines.map(l => l.key === key ? { ...l, ...patch } : l) } : prev);
  };

  // Debounce timers for the live while-typing recheck, keyed by line.
  const vinCheckTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  // Re-check "already in system" for a batch of lines. Takes line VALUES
  // (not indexes — rows can be removed while the query is in flight), skips
  // lines whose vin|part combination hasn't changed since their last check,
  // and cancels any pending debounced check so a stale result can't land on
  // top of a fresh one. Matching is part-aware (pickScanForLine), so this
  // must run on EVERY part change — correcting a part that was adopted from
  // a different install flips the line from "Invoiced #…" back to "New scan".
  const recheckLines = async (lines: VendorLine[]) => {
    const keyOf = (l: VendorLine) => `${l.vin.trim().replace(/[^A-Za-z0-9]/g, '')}|${l.partNumber.trim().toUpperCase()}`;
    const stale = lines.filter(l => l.lastChecked !== keyOf(l));
    if (stale.length === 0) return;
    for (const l of stale) clearTimeout(vinCheckTimers.current[l.key]);
    const checked = await checkExistingVins(stale.filter(vinOk));
    const byKey = new Map(checked.map(c => [c.key, c]));
    setReview(prev => prev ? {
      ...prev,
      lines: prev.lines.map(l => {
        const s = stale.find(x => x.key === l.key);
        if (!s) return l;
        const c = byKey.get(l.key);
        return { ...l, existing: c?.existing ?? null, lastChecked: c?.lastChecked ?? keyOf(s) };
      }),
    } : prev);
  };
  const recheckLine = (line: VendorLine) => recheckLines([line]);

  // Live version of the check while a VIN or part is being typed — debounced
  // so a 17-character VIN doesn't fire 17 queries. Answers "new scan or
  // update?" before the user ever leaves the field.
  const scheduleRecheck = (line: VendorLine) => {
    clearTimeout(vinCheckTimers.current[line.key]);
    vinCheckTimers.current[line.key] = setTimeout(() => recheckLines([line]), 400);
  };

  // Tri-state for the line badge: has the current vin|part combination
  // actually been looked up yet?
  const lineChecked = (line: VendorLine) => {
    const cleaned = line.vin.trim().replace(/[^A-Za-z0-9]/g, '');
    return cleaned.length >= 5 && line.lastChecked === `${cleaned}|${line.partNumber.trim().toUpperCase()}`;
  };

  const splitTotalEvenly = () => {
    if (!review) return;
    const total = parseFloat(review.totalAmount);
    const n = review.lines.length;
    if (!total || total <= 0 || n === 0) return;
    // Integer-cent split; remainder cents go to the first lines.
    const totalCents = Math.round(total * 100);
    const base = Math.floor(totalCents / n);
    const remainder = totalCents - base * n;
    setReview(prev => prev ? {
      ...prev,
      lines: prev.lines.map((l, i) => ({ ...l, amount: ((base + (i < remainder ? 1 : 0)) / 100).toFixed(2) })),
    } : prev);
  };

  // Early duplicate warning against the loaded history (the commit endpoint
  // + DB unique indexes are the authoritative guard).
  const duplicateOf = review && review.invoiceNumber.trim()
    ? history.find(h =>
        (h.invoice_number || '').toLowerCase() === review.invoiceNumber.trim().toLowerCase() &&
        (selectedCompany
          ? h.company?.id === selectedCompany.id
          : h.vendor_name.toLowerCase() === review.vendorName.trim().toLowerCase())) || null
    : null;

  const linesSum = review
    ? review.lines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0)
    : 0;
  const statedTotal = review ? parseFloat(review.totalAmount) || 0 : 0;
  const totalMismatch = review && statedTotal > 0 && Math.abs(linesSum - statedTotal) > 0.01;

  const handleAddVendor = async () => {
    if (!addVendorName.trim()) return;
    setAddingVendor(true);
    try {
      const res = await fetch('/api/cni/create-vendor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addVendorName.trim(),
          email: addVendorEmail.trim() || undefined,
          phone: addVendorPhone.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        await dialog.alert(`Failed to add installer: ${data.error || 'unknown error'}`);
      } else {
        const company: VendorCompany = { id: data.companyId, name: data.companyName, netsuite_vendor_id: data.netsuiteVendorId || null };
        setCompanies(prev => prev.some(c => c.id === company.id) ? prev.map(c => c.id === company.id ? company : c) : [...prev, company].sort((a, b) => a.name.localeCompare(b.name)));
        setSelectedCompany(company);
        setReview(prev => prev ? { ...prev, vendorName: company.name } : prev);
        setAddVendorOpen(false);
        setAddVendorEmail('');
        setAddVendorPhone('');
        if (data.vendorError) {
          await dialog.alert(`${company.name} was added to FleetSuite, but the NetSuite vendor could not be created: ${data.vendorError}\n\nYou can add the vendor ID later on the company page.`);
        } else if (data.netsuiteVendorId) {
          setNotice(`${company.name} added — NetSuite vendor #${data.netsuiteVendorId}${data.alreadyExists ? ' (already existed)' : ' created'}.`);
        }
      }
    } catch (err: any) {
      await dialog.alert(`Failed to add installer: ${err.message}`);
    }
    setAddingVendor(false);
  };

  // Parse pasted VIN rows (one per line, straight from a spreadsheet or the
  // bulk-upload sheet format): VIN alone, or VIN / part / amount separated by
  // tabs (spreadsheet paste) or commas. Header rows and junk lines fall out
  // because their first cell doesn't clean to a 5+ character VIN.
  const bulkAddLines = async () => {
    if (!review) return;
    setBulkBusy(true);
    const parsed: VendorLine[] = [];
    for (const row of bulkText.split(/\r?\n/)) {
      const cols = (row.includes('\t') ? row.split('\t') : row.split(/[,;]/)).map(c => c.trim());
      const vin = (cols[0] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (vin.length < 5) continue;
      const part = cols[1] || '';
      const amtRaw = (cols[2] || '').replace(/[$,\s]/g, '');
      const amount = amtRaw !== '' && !isNaN(parseFloat(amtRaw)) ? parseFloat(amtRaw) : null;
      parsed.push({
        key: ++lineKeyRef.current,
        vin,
        partNumber: part || defaultPart?.item_number || '',
        amount: amount != null ? String(amount) : '',
        existing: null,
      });
    }
    if (parsed.length === 0) {
      setBulkBusy(false);
      await dialog.alert('No VINs found — paste one row per vehicle: VIN, or VIN / part / amount separated by tabs or commas.');
      return;
    }
    const checked = await checkExistingVins(parsed);
    setReview(prev => prev ? {
      ...prev,
      // Fully-empty placeholder rows give way to the pasted ones.
      lines: [...prev.lines.filter(l => l.vin.trim() || l.partNumber.trim() || l.amount.trim()), ...checked],
    } : prev);
    setBulkText('');
    setBulkOpen(false);
    setBulkBusy(false);
    applyRememberedRates(selectedCompany ? { companyId: selectedCompany.id } : { vendorName: review.vendorName });
  };

  // Straight recorded/rejected → paid for invoices settled outside the app.
  const markPaidInvoice = async (inv: VendorInvoiceRecord) => {
    const label = `${inv.vendor_name} invoice${inv.invoice_number ? ` #${inv.invoice_number}` : ''}`;
    if (!(await dialog.confirm(`Mark the ${label} as paid WITHOUT sending it through approval? Use this only for invoices that were already processed and paid outside FleetSuite.`, { confirmLabel: 'Mark Paid' }))) return;
    setMarkingPaid(inv.id);
    try {
      const res = await fetch('/api/vendor-invoices/workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_paid', id: inv.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) await dialog.alert(`Mark paid failed: ${data.error || 'unknown error'}`);
      else loadHistory();
    } catch (err: any) {
      await dialog.alert(`Mark paid failed: ${err.message}`);
    }
    setMarkingPaid(null);
  };

  const handleCommit = async () => {
    if (!review) return;
    const validLines = review.lines.filter(vinOk);
    if (!review.vendorName.trim()) { await dialog.alert('Pick or enter the CNI installer this invoice is from.'); return; }
    if (validLines.length === 0) { await dialog.alert('Add at least one VIN (5+ characters).'); return; }
    const skipped = review.lines.length - validLines.length;
    if (skipped > 0 && !(await dialog.confirm(`${skipped} line${skipped !== 1 ? 's' : ''} with a missing/short VIN will be skipped. Continue?`))) return;
    // Location and invoice date drive the profitability report — nudge, don't block.
    if (!vLocation && !(await dialog.confirm('No location selected — profitability reporting groups by location. Record without one?'))) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(review.invoiceDate) && !(await dialog.confirm("No invoice date — reports will fall back to today's recorded date. Continue without one?"))) return;

    setCommitting(true);
    try {
      const res = await fetch('/api/vendor-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorName: review.vendorName.trim(),
          companyId: selectedCompany?.id || null,
          invoiceNumber: review.invoiceNumber.trim() || null,
          invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(review.invoiceDate) ? review.invoiceDate : null,
          dueDate: /^\d{4}-\d{2}-\d{2}$/.test(review.dueDate) ? review.dueDate : null,
          totalAmount: parseFloat(review.totalAmount) >= 0 ? parseFloat(review.totalAmount) : null,
          locationId: vLocation || null,
          notes: review.notes.trim() || null,
          file: stagedFile,
          lines: validLines.map(l => ({
            vin: l.vin.trim(),
            partNumber: l.partNumber.trim() || null,
            amount: parseFloat(l.amount) >= 0 ? parseFloat(l.amount) : null,
          })),
          ...(alreadyPaid ? { alreadyPaid: true } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        await dialog.alert(`Failed to record invoice: ${data.error || 'unknown error'}`);
      } else {
        setCommitResult({ updated: data.updated || [], created: data.created || [], failed: data.failed || [] });
        setReview(null);
        setStagedFile(null);
        setSelectedCompany(null);
        setAlreadyPaid(false);
        setBulkOpen(false);
        setBulkText('');
        setNotice(null);
        loadHistory();
        onCommitted();
        if ((data.updated || []).length > 0) {
          await dialog.alert(
            `${data.updated.length} VIN${data.updated.length !== 1 ? 's were' : ' was'} already in the system — the records were updated with the installer cost and left in their current state. ${data.created.length} new scan${data.created.length !== 1 ? 's' : ''} added.`,
            { title: 'VINs already scanned' },
          );
        }
      }
    } catch (err: any) {
      await dialog.alert(`Failed to record invoice: ${err.message}`);
    }
    setCommitting(false);
  };

  const deleteInvoice = async (inv: VendorInvoiceRecord) => {
    if (!(await dialog.confirm(`Delete the ${inv.vendor_name} invoice${inv.invoice_number ? ` #${inv.invoice_number}` : ''}? Installer costs stamped on its scans will be cleared (the scans themselves stay).`, { destructive: true, confirmLabel: 'Delete' }))) return;
    setDeletingInvoice(inv.id);
    try {
      const res = await fetch('/api/vendor-invoices', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: inv.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) await dialog.alert(`Delete failed: ${data.error || 'unknown error'}`);
      else { loadHistory(); onCommitted(); }
    } catch (err: any) {
      await dialog.alert(`Delete failed: ${err.message}`);
    }
    setDeletingInvoice(null);
  };

  const submitInvoice = async (inv: VendorInvoiceRecord) => {
    setSubmittingInvoice(inv.id);
    try {
      const res = await fetch('/api/vendor-invoices/workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit', id: inv.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) await dialog.alert(`Submit failed: ${data.error || 'unknown error'}`);
      else loadHistory();
    } catch (err: any) {
      await dialog.alert(`Submit failed: ${err.message}`);
    }
    setSubmittingInvoice(null);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`,
    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px',
  };
  const fmtMoney = (n: number) => `$${n.toFixed(2)}`;

  return (
    <div>
      {/* Commit result — the "these VINs were already scanned" alert lives here */}
      {commitResult && (
        <div style={{ padding: '12px 14px', borderRadius: '10px', marginBottom: '12px', background: 'var(--card)', border: `1px solid ${commitResult.failed.length > 0 ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Vendor invoice recorded — {commitResult.updated.length} existing record{commitResult.updated.length !== 1 ? 's' : ''} updated · {commitResult.created.length} new scan{commitResult.created.length !== 1 ? 's' : ''} added{commitResult.failed.length > 0 ? ` · ${commitResult.failed.length} failed` : ''}
            </div>
            <button onClick={() => setCommitResult(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '14px', cursor: 'pointer' }}>✕</button>
          </div>
          {commitResult.updated.length > 0 && (
            <div style={{ marginBottom: '6px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#fbbf24', marginBottom: '3px' }}>
                ⚠ Already in the system — updated with installer cost, state unchanged:
              </div>
              {commitResult.updated.map((u, i) => (
                <div key={i} style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                  {u.vin} <span style={{ fontFamily: 'inherit', color: 'var(--text-muted)' }}>— {u.state}</span>
                </div>
              ))}
            </div>
          )}
          {commitResult.created.length > 0 && (
            <div style={{ fontSize: '11px', color: '#22c55e' }}>
              New scans: {commitResult.created.map(c => c.vin).join(', ')}
            </div>
          )}
          {commitResult.failed.map((f, i) => (
            <div key={i} style={{ fontSize: '11px', color: '#ef4444' }}>{f.vin}: {f.error}</div>
          ))}
        </div>
      )}

      {notice && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', background: 'rgba(244,114,182,0.06)', border: '1px solid rgba(244,114,182,0.2)', color: '#f472b6', fontSize: '12px', fontWeight: 600, whiteSpace: 'pre-wrap' }}>
          {notice}
        </div>
      )}

      {/* Upload / manual entry */}
      {!review && (
        <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '16px', marginBottom: '14px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            Upload an invoice from a CNI installer (PDF or photo). AI pulls the installer, invoice number, VINs, and prices — everything is editable before saving. VINs already in the system are updated with the cost and stay in whatever state they&apos;re in.
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <DropZone accept="application/pdf,image/*" multiple={false} disabled={extracting} onFiles={files => handleInvoiceFile(files[0])}>
              <label style={{
                display: 'block', padding: '28px 40px', borderRadius: '12px', textAlign: 'center',
                border: '2px dashed rgba(244,114,182,0.4)', background: extracting ? 'rgba(244,114,182,0.1)' : 'rgba(244,114,182,0.04)',
                color: '#f472b6', fontSize: '13px', fontWeight: 700, cursor: extracting ? 'default' : 'pointer',
              }}>
                {extracting ? 'Reading invoice…' : 'Upload Vendor Invoice (AI extract)'}
                <input type="file" accept="application/pdf,image/*" disabled={extracting} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleInvoiceFile(f); }} style={{ display: 'none' }} />
              </label>
            </DropZone>
            <button onClick={startManualEntry} disabled={extracting} style={{
              padding: '28px 24px', borderRadius: '12px', border: `1px solid ${theme.border}`,
              background: 'var(--subtle-bg)', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
            }}>
              ✎ Enter Manually
            </button>
          </div>
        </div>
      )}

      {/* Review + edit */}
      {review && (
        <div style={{ background: 'var(--card)', border: '1px solid rgba(244,114,182,0.3)', borderRadius: '14px', padding: '16px', marginBottom: '14px' }}>
          <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '12px' }}>
            Review Vendor Invoice{stagedFile ? <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', marginLeft: '8px' }}>{stagedFile.fileName}</span> : null}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            {/* Vendor picker: local companies + live NetSuite vendor search
                (existing NetSuite vendors get linked, never re-created). */}
            <div style={{ position: 'relative' }}>
              <div style={labelStyle}>CNI Installer / Vendor</div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  value={review.vendorName}
                  onChange={e => { setReview({ ...review, vendorName: e.target.value }); setSelectedCompany(null); setShowVendorDropdown(true); }}
                  onFocus={() => setShowVendorDropdown(true)}
                  onBlur={() => setTimeout(() => setShowVendorDropdown(false), 150)}
                  placeholder="Search installers + NetSuite vendors…"
                  style={{ ...inputStyle, flex: 1, borderColor: selectedCompany ? 'rgba(34,197,94,0.4)' : theme.border }}
                />
                <button
                  onClick={() => { setAddVendorName(review.vendorName.trim()); setAddVendorOpen(true); setShowVendorDropdown(false); }}
                  title="Add a new installer — creates the FleetSuite company and the NetSuite vendor"
                  style={{ padding: '8px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 800, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
                >
                  + Add Installer
                </button>
              </div>
              {selectedCompany && (
                <div style={{ fontSize: '9px', color: '#22c55e', marginTop: '2px', fontWeight: 700 }}>
                  ✓ In system{selectedCompany.netsuite_vendor_id ? ` · NetSuite vendor #${selectedCompany.netsuite_vendor_id}` : ' · no NetSuite vendor yet'}
                </div>
              )}
              {showVendorDropdown && review.vendorName.trim().length >= 1 && !selectedCompany && (() => {
                const q = review.vendorName.trim().toLowerCase();
                const matches = companies.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
                const linkedNsIds = new Set(companies.map(c => c.netsuite_vendor_id).filter(Boolean));
                const nsMatches = nsVendors.filter(v => !linkedNsIds.has(v.id)).slice(0, 6);
                return (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '260px', overflowY: 'auto', marginTop: '2px' }}>
                    {matches.map(c => (
                      <button
                        key={c.id}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => { setSelectedCompany(c); setReview(prev => prev ? { ...prev, vendorName: c.name } : prev); setShowVendorDropdown(false); applyRememberedRates({ companyId: c.id }); }}
                        style={{ display: 'block', width: '100%', padding: '7px 9px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '11px', color: 'var(--text-primary)' }}
                      >
                        <span style={{ fontWeight: 700 }}>{c.name}</span>
                        {c.netsuite_vendor_id ? (
                          <span style={{ fontSize: '9px', fontWeight: 700, color: '#22c55e', background: 'rgba(34,197,94,0.12)', borderRadius: '4px', padding: '1px 5px', marginLeft: '6px' }}>✓ NetSuite #{c.netsuite_vendor_id}</span>
                        ) : (
                          <span style={{ fontSize: '9px', fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.1)', borderRadius: '4px', padding: '1px 5px', marginLeft: '6px' }}>not linked to NetSuite</span>
                        )}
                      </button>
                    ))}
                    {nsMatches.map(v => (
                      <button
                        key={`ns-${v.id}`}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => linkNsVendor(v)}
                        disabled={linkingVendor}
                        style={{ display: 'block', width: '100%', padding: '7px 9px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'rgba(96,165,250,0.04)', cursor: 'pointer', fontSize: '11px', color: 'var(--text-primary)', opacity: linkingVendor ? 0.6 : 1 }}
                      >
                        <span style={{ fontWeight: 700 }}>{v.companyName || v.entityId}</span>
                        <span style={{ fontSize: '9px', fontWeight: 700, color: '#60a5fa', background: 'rgba(96,165,250,0.12)', borderRadius: '4px', padding: '1px 5px', marginLeft: '6px' }}>NetSuite #{v.id}</span>
                        <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{linkingVendor ? 'Linking…' : 'Already a NetSuite vendor — click to link'}</div>
                      </button>
                    ))}
                    {/* NetSuite search status — so "not in NetSuite" and
                        "search unavailable" are visibly different answers. */}
                    {nsSearchState === 'searching' && (
                      <div style={{ padding: '6px 9px', fontSize: '10px', color: 'var(--text-muted)', borderBottom: `1px solid ${theme.border}` }}>
                        Searching NetSuite vendors…
                      </div>
                    )}
                    {nsSearchState === 'done' && nsMatches.length === 0 && (
                      <div style={{ padding: '6px 9px', fontSize: '10px', color: 'var(--text-muted)', borderBottom: `1px solid ${theme.border}` }}>
                        No NetSuite vendor matches &quot;{review.vendorName.trim()}&quot;
                      </div>
                    )}
                    {nsSearchState === 'error' && (
                      <div style={{ padding: '6px 9px', fontSize: '10px', fontWeight: 600, color: '#fbbf24', background: 'rgba(251,191,36,0.06)', borderBottom: `1px solid ${theme.border}` }}>
                        ⚠ NetSuite vendor search unavailable — {nsError}. Showing FleetSuite installers only.
                      </div>
                    )}
                    <button
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => { setAddVendorName(review.vendorName.trim()); setAddVendorOpen(true); setShowVendorDropdown(false); }}
                      style={{ display: 'block', width: '100%', padding: '7px 9px', textAlign: 'left', border: 'none', background: 'rgba(34,197,94,0.06)', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#22c55e' }}
                    >
                      + Add &quot;{review.vendorName.trim()}&quot; as new installer (FleetSuite + NetSuite vendor)
                    </button>
                  </div>
                );
              })()}
            </div>
            <div>
              <div style={labelStyle}>Invoice #</div>
              <input value={review.invoiceNumber} onChange={e => setReview({ ...review, invoiceNumber: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>Invoice Date</div>
              <input type="date" value={review.invoiceDate} onChange={e => setReview({ ...review, invoiceDate: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>Due Date</div>
              <input type="date" value={review.dueDate} onChange={e => setReview({ ...review, dueDate: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>Invoice Total ($)</div>
              <input type="number" step="0.01" min="0" value={review.totalAmount} onChange={e => setReview({ ...review, totalAmount: e.target.value })} placeholder="0.00" style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>Location</div>
              <select value={vLocation} onChange={e => setVLocation(e.target.value)} style={inputStyle}>
                <option value="">— Select Location —</option>
                {allLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>Notes</div>
              <input value={review.notes} onChange={e => setReview({ ...review, notes: e.target.value })} placeholder="Optional" style={inputStyle} />
            </div>
          </div>

          {/* Inline add-installer form */}
          {addVendorOpen && (
            <div style={{ padding: '10px 12px', borderRadius: '10px', marginBottom: '10px', background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.25)' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#22c55e', marginBottom: '8px' }}>
                Add a new installer — creates the company in FleetSuite and a matching NetSuite vendor (subsidiary BMG Fleet Installations). If they might already be a NetSuite vendor, search them in the field above first and link instead.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr auto auto', gap: '6px', alignItems: 'end' }}>
                <div>
                  <div style={labelStyle}>Installer / Company Name</div>
                  <input value={addVendorName} onChange={e => setAddVendorName(e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <div style={labelStyle}>Email (optional)</div>
                  <input value={addVendorEmail} onChange={e => setAddVendorEmail(e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <div style={labelStyle}>Phone (optional)</div>
                  <PhoneInput value={addVendorPhone} onChange={v => setAddVendorPhone(v)} style={inputStyle} />
                </div>
                <button onClick={handleAddVendor} disabled={addingVendor || !addVendorName.trim()} style={{ padding: '8px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer', opacity: addingVendor || !addVendorName.trim() ? 0.6 : 1 }}>
                  {addingVendor ? 'Adding…' : 'Add Installer'}
                </button>
                <button onClick={() => setAddVendorOpen(false)} style={{ padding: '8px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'transparent', border: `1px solid ${theme.border}`, color: 'var(--text-muted)', cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Duplicate warning — this vendor + invoice number already exists */}
          {duplicateOf && (
            <div style={{ padding: '10px 12px', borderRadius: '10px', marginBottom: '10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.35)', fontSize: '12px', fontWeight: 600, color: '#fbbf24' }}>
              ⚠ Possible duplicate: invoice #{duplicateOf.invoice_number} from {duplicateOf.vendor_name} was already recorded on {new Date(duplicateOf.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              {duplicateOf.total_amount != null ? ` for $${Number(duplicateOf.total_amount).toFixed(2)}` : ''} — see the history below. Recording it again is blocked; a corrected re-issue needs a distinct number (e.g. &quot;{review.invoiceNumber.trim()}-A&quot;).
            </div>
          )}

          {/* Default part — turns the invoice into a bulk upload: one pick
              fills every line that doesn't carry its own part number. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
            <div style={{ ...labelStyle, marginBottom: 0 }}>Default Part</div>
            {defaultPart ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', borderRadius: '6px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>
                {defaultPart.item_number}
                <button onClick={() => setDefaultPart(null)} style={{ background: 'none', border: 'none', color: '#f87171', fontSize: '12px', cursor: 'pointer', padding: '0 2px' }}>✕</button>
              </div>
            ) : (
              <div style={{ position: 'relative', minWidth: '220px' }}>
                <input
                  value={defaultPartSearch}
                  onChange={e => setDefaultPartSearch(e.target.value)}
                  placeholder="Search part to apply to all lines…"
                  style={{ ...inputStyle, fontSize: '11px', padding: '6px 8px' }}
                />
                {defaultPartSearch.length >= 2 && (() => {
                  const q = defaultPartSearch.toLowerCase();
                  const matches = allParts.filter(p =>
                    p.item_number.toLowerCase().includes(q) ||
                    p.display_name?.toLowerCase().includes(q) ||
                    p.billable_customer?.toLowerCase().includes(q)
                  ).slice(0, 8);
                  if (matches.length === 0) {
                    return (
                      <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', marginTop: '2px' }}>
                        <button
                          onMouseDown={e => e.preventDefault()}
                          onClick={async () => {
                            const p = await mirrorPartFromNetsuite(defaultPartSearch);
                            if (p) {
                              setDefaultPart({ item_number: p.item_number, display_name: (p as any).display_name ?? null });
                              setDefaultPartSearch('');
                              setReview(prev => prev ? {
                                ...prev,
                                lines: prev.lines.map(l => l.partNumber.trim() ? l : { ...l, partNumber: p.item_number }),
                              } : prev);
                              applyRememberedRates(selectedCompany ? { companyId: selectedCompany.id } : { vendorName: review.vendorName });
                              // Part-aware match — refresh badges on the filled lines.
                              recheckLines(review.lines.filter(l => !l.partNumber.trim()).map(l => ({ ...l, partNumber: p.item_number })));
                            }
                          }}
                          disabled={mirroringPart}
                          style={{ display: 'block', width: '100%', padding: '7px 9px', textAlign: 'left', border: 'none', background: 'rgba(96,165,250,0.06)', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#60a5fa', opacity: mirroringPart ? 0.6 : 1 }}
                        >
                          {mirroringPart ? 'Checking NetSuite…' : `Not in catalog — check NetSuite for "${defaultPartSearch.trim()}"`}
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '200px', overflowY: 'auto', marginTop: '2px' }}>
                      {matches.map(p => (
                        <button
                          key={p.id}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => {
                            setDefaultPart({ item_number: p.item_number, display_name: p.display_name });
                            setDefaultPartSearch('');
                            setReview(prev => prev ? {
                              ...prev,
                              lines: prev.lines.map(l => l.partNumber.trim() ? l : { ...l, partNumber: p.item_number }),
                            } : prev);
                            applyRememberedRates(selectedCompany ? { companyId: selectedCompany.id } : { vendorName: review.vendorName });
                            // Part-aware match — refresh badges on the filled lines.
                            recheckLines(review.lines.filter(l => !l.partNumber.trim()).map(l => ({ ...l, partNumber: p.item_number })));
                          }}
                          style={{ display: 'block', width: '100%', padding: '7px 9px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '11px', color: 'var(--text-primary)' }}
                        >
                          <span style={{ fontWeight: 700 }}>{p.item_number}</span>
                          {p.billable_customer && <span style={{ color: '#a78bfa', marginLeft: '6px' }}>{p.billable_customer}</span>}
                          {p.display_name && <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{p.display_name}</div>}
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
              Fills lines without a part — per-line parts and matched scans win.
            </span>
          </div>

          {/* Lines */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={review.lines.length > 0 && review.lines.every(l => l.selected)}
                onChange={e => setReview({ ...review, lines: review.lines.map(l => ({ ...l, selected: e.target.checked })) })}
                title="Select all lines"
                style={{ width: '13px', height: '13px', accentColor: '#f472b6' }}
              />
              <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                VINs on this invoice ({review.lines.length})
              </span>
            </label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={splitTotalEvenly} disabled={!statedTotal} title="Divide the invoice total evenly across all VIN lines" style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer', opacity: statedTotal ? 1 : 0.4 }}>
                Split total evenly
              </button>
              <button onClick={() => setBulkOpen(o => !o)} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: bulkOpen ? 'var(--subtle-bg)' : 'rgba(167,139,250,0.1)', border: `1px solid ${bulkOpen ? theme.border : 'rgba(167,139,250,0.25)'}`, color: bulkOpen ? 'var(--text-muted)' : '#a78bfa', cursor: 'pointer' }}>
                {bulkOpen ? 'Close bulk add' : '⇪ Bulk Add VINs'}
              </button>
              <button onClick={() => setReview({ ...review, lines: [...review.lines, blankLine()] })} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', cursor: 'pointer' }}>
                + Add VIN
              </button>
            </div>
          </div>

          {/* Bulk paste panel — spreadsheet-style VIN entry */}
          {bulkOpen && (
            <div style={{ padding: '10px 12px', borderRadius: '10px', marginBottom: '8px', background: 'rgba(167,139,250,0.05)', border: '1px solid rgba(167,139,250,0.25)' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#a78bfa', marginBottom: '6px' }}>
                Paste VINs — one per line, straight from a spreadsheet. Optional columns after the VIN: part number, amount (tab or comma separated). Lines whose first cell isn&apos;t a VIN (like headers) are skipped; the Default Part fills any line without its own part.
              </div>
              <textarea
                value={bulkText}
                onChange={e => setBulkText(e.target.value)}
                placeholder={'1FTBW2CM5HKA12345\n1FTBW2CM5HKA12346\t06N5TR\t125.00\nKA12347, 06N5TR, 125.00'}
                autoFocus
                style={{ ...inputStyle, minHeight: '110px', resize: 'vertical', fontFamily: 'monospace', fontSize: '11px', marginBottom: '6px' }}
              />
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <button
                  onClick={bulkAddLines}
                  disabled={bulkBusy || !bulkText.trim()}
                  style={{ padding: '6px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: bulkBusy || !bulkText.trim() ? theme.border : '#a78bfa', color: '#fff', border: 'none', cursor: bulkBusy ? 'default' : 'pointer' }}
                >
                  {bulkBusy ? 'Adding…' : 'Add to Invoice'}
                </button>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                  Pasted VINs are checked against existing scans, and this vendor&apos;s remembered rates fill empty amounts.
                </span>
              </div>
            </div>
          )}

          {/* Apply a part and/or price to all selected lines in one go */}
          {(() => {
            const selectedCount = review.lines.filter(l => l.selected).length;
            if (selectedCount === 0) return null;
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', marginBottom: '6px', borderRadius: '8px', background: 'rgba(244,114,182,0.06)', border: '1px solid rgba(244,114,182,0.25)', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#f472b6' }}>{selectedCount} selected</span>
                <div style={{ position: 'relative', minWidth: '220px' }}>
                  <input
                    value={applyPartSearch}
                    onChange={e => { setApplyPartSearch(e.target.value); setShowApplyPartDropdown(true); }}
                    onFocus={() => setShowApplyPartDropdown(true)}
                    onBlur={() => setTimeout(() => setShowApplyPartDropdown(false), 150)}
                    placeholder="Part # for selected lines…"
                    style={{ ...inputStyle, fontSize: '11px', padding: '6px 8px' }}
                  />
                  {showApplyPartDropdown && applyPartSearch.length >= 2 && (() => {
                    const q = applyPartSearch.toLowerCase();
                    const matches = allParts.filter(p =>
                      p.item_number.toLowerCase().includes(q) ||
                      p.display_name?.toLowerCase().includes(q) ||
                      p.billable_customer?.toLowerCase().includes(q)
                    ).slice(0, 8);
                    return (
                      <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '180px', overflowY: 'auto', marginTop: '2px' }}>
                        {matches.map(p => (
                          <button
                            key={p.id}
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => applyPartToSelected(p.item_number)}
                            style={{ display: 'block', width: '100%', padding: '6px 8px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '11px', color: 'var(--text-primary)' }}
                          >
                            <span style={{ fontWeight: 700 }}>{p.item_number}</span>
                            {p.billable_customer && <span style={{ color: '#a78bfa', marginLeft: '6px' }}>{p.billable_customer}</span>}
                            {p.display_name && <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{p.display_name}</div>}
                          </button>
                        ))}
                        {matches.length === 0 && (
                          <button
                            onMouseDown={e => e.preventDefault()}
                            onClick={async () => {
                              const p = await mirrorPartFromNetsuite(applyPartSearch);
                              if (p) applyPartToSelected(p.item_number);
                            }}
                            disabled={mirroringPart}
                            style={{ display: 'block', width: '100%', padding: '7px 9px', textAlign: 'left', border: 'none', background: 'rgba(96,165,250,0.06)', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#60a5fa', opacity: mirroringPart ? 0.6 : 1 }}
                          >
                            {mirroringPart ? 'Checking NetSuite…' : `Not in catalog — check NetSuite for "${applyPartSearch.trim()}"`}
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </div>
                <input
                  type="number" step="0.01" min="0"
                  value={applyAmount}
                  onChange={e => setApplyAmount(e.target.value)}
                  placeholder="$ / VIN"
                  title="Price to set on every selected line — works with or without a part number"
                  style={{ ...inputStyle, fontSize: '11px', padding: '6px 8px', width: '90px' }}
                />
                <button onClick={() => applyPartToSelected(applyPartSearch)} disabled={!applyPartSearch.trim() && !applyAmount.trim()} style={{ padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: '#f472b6', color: '#fff', border: 'none', cursor: 'pointer', opacity: applyPartSearch.trim() || applyAmount.trim() ? 1 : 0.4 }}>
                  Apply to {selectedCount}
                </button>
                <button onClick={() => setReview({ ...review, lines: review.lines.map(l => ({ ...l, selected: false })) })} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'transparent', border: `1px solid ${theme.border}`, color: 'var(--text-muted)', cursor: 'pointer' }}>
                  Clear
                </button>
              </div>
            );
          })()}

          {review.lines.map(line => (
            <div key={line.key} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 7px', marginBottom: '3px', borderRadius: '6px', background: line.selected ? 'rgba(244,114,182,0.05)' : 'var(--subtle-bg)', border: `1px solid ${line.selected ? 'rgba(244,114,182,0.35)' : line.existing ? 'rgba(251,191,36,0.35)' : 'var(--border)'}` }}>
              <input
                type="checkbox"
                checked={!!line.selected}
                onChange={e => updateLine(line.key, { selected: e.target.checked })}
                style={{ width: '13px', height: '13px', flexShrink: 0, accentColor: '#f472b6' }}
              />
              <input
                value={line.vin}
                onChange={e => {
                  const vin = e.target.value.toUpperCase();
                  updateLine(line.key, { vin });
                  scheduleRecheck({ ...line, vin });
                }}
                onBlur={e => recheckLine({ ...line, vin: e.target.value.toUpperCase() })}
                placeholder="VIN (full or last 8)"
                style={{ flex: 2, padding: '6px 8px', borderRadius: '5px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', minWidth: 0 }}
              />
              <div style={{ position: 'relative', flex: 2, minWidth: 0 }}>
                <input
                  value={line.partNumber}
                  onChange={e => {
                    const partNumber = e.target.value;
                    updateLine(line.key, { partNumber });
                    setPartSearchKey(line.key);
                    // Matching is part-aware — hand-typed part edits refresh
                    // the already-in-system badge just like dropdown picks.
                    scheduleRecheck({ ...line, partNumber });
                  }}
                  onFocus={() => setPartSearchKey(line.key)}
                  onBlur={e => {
                    const partNumber = e.target.value;
                    setTimeout(() => setPartSearchKey(prev => prev === line.key ? null : prev), 150);
                    recheckLine({ ...line, partNumber });
                  }}
                  placeholder="Part # (optional)"
                  style={{ width: '100%', padding: '6px 8px', borderRadius: '5px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '11px' }}
                />
                {partSearchKey === line.key && line.partNumber.length >= 2 && (() => {
                  const q = line.partNumber.toLowerCase();
                  const matches = allParts.filter(p =>
                    p.item_number.toLowerCase() !== q && (
                      p.item_number.toLowerCase().includes(q) ||
                      p.display_name?.toLowerCase().includes(q) ||
                      p.billable_customer?.toLowerCase().includes(q)
                    )
                  ).slice(0, 8);
                  const exactLocal = allParts.some(p => p.item_number.toLowerCase() === q);
                  return (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '180px', overflowY: 'auto', marginTop: '2px' }}>
                      {matches.map(p => (
                        <button
                          key={p.id}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => { updateLine(line.key, { partNumber: p.item_number }); setPartSearchKey(null); recheckLine({ ...line, partNumber: p.item_number }); }}
                          style={{ display: 'block', width: '100%', padding: '6px 8px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '11px', color: 'var(--text-primary)' }}
                        >
                          <span style={{ fontWeight: 700 }}>{p.item_number}</span>
                          {p.billable_customer && <span style={{ color: '#a78bfa', marginLeft: '6px' }}>{p.billable_customer}</span>}
                          {p.display_name && <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{p.display_name}</div>}
                        </button>
                      ))}
                      {matches.length === 0 && !exactLocal && (
                        <button
                          onMouseDown={e => e.preventDefault()}
                          onClick={async () => {
                            const p = await mirrorPartFromNetsuite(line.partNumber);
                            setPartSearchKey(null);
                            if (p) { updateLine(line.key, { partNumber: p.item_number }); recheckLine({ ...line, partNumber: p.item_number }); }
                          }}
                          disabled={mirroringPart}
                          style={{ display: 'block', width: '100%', padding: '7px 9px', textAlign: 'left', border: 'none', background: 'rgba(96,165,250,0.06)', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#60a5fa', opacity: mirroringPart ? 0.6 : 1 }}
                        >
                          {mirroringPart ? 'Checking NetSuite…' : `Not in catalog — check NetSuite for "${line.partNumber.trim()}"`}
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
              <input
                type="number" step="0.01" min="0"
                value={line.amount}
                onChange={e => updateLine(line.key, { amount: e.target.value })}
                placeholder={(() => {
                  const r = line.partNumber.trim() ? vendorRates[line.partNumber.trim().toUpperCase()] : undefined;
                  return r ? r.amount.toFixed(2) : '$';
                })()}
                title={(() => {
                  const r = line.partNumber.trim() ? vendorRates[line.partNumber.trim().toUpperCase()] : undefined;
                  return r ? `This vendor last billed $${r.amount.toFixed(2)} for ${line.partNumber.trim()}${r.invoiceNumber ? ` (Inv #${r.invoiceNumber}` : ''}${r.invoiceNumber && r.date ? `, ${r.date})` : r.invoiceNumber ? ')' : r.date ? ` on ${r.date}` : ''}` : '';
                })()}
                style={{ width: '90px', padding: '6px 8px', borderRadius: '5px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', flexShrink: 0 }}
              />
              {line.existing ? (
                <span title="This VIN is already in the system — its record will be updated with the cost and keep this state" style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(251,191,36,0.12)', color: '#fbbf24', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  ↻ {line.existing}
                </span>
              ) : lineChecked(line) ? (
                <span title="No scan on file for this VIN — committing creates a fresh scan record" style={{ fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', background: 'rgba(34,197,94,0.12)', color: '#22c55e', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  ＋ New scan
                </span>
              ) : null}
              <button onClick={() => setReview({ ...review, lines: review.lines.filter(l => l.key !== line.key) })} style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: '11px', fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>✕</button>
            </div>
          ))}

          {/* Totals + actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: totalMismatch ? '#fbbf24' : 'var(--text-secondary)' }}>
              Lines total: {fmtMoney(linesSum)}{statedTotal > 0 ? ` / invoice ${fmtMoney(statedTotal)}` : ''}
              {totalMismatch ? ' — doesn’t match the invoice total' : ''}
            </span>
            <span style={{ flex: 1 }} />
            <label
              title="For invoices that were already processed and paid outside FleetSuite — records them as Paid, skipping the approval and payment pipeline"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', padding: '6px 10px', borderRadius: '8px', background: alreadyPaid ? 'rgba(52,211,153,0.1)' : 'transparent', border: `1px solid ${alreadyPaid ? 'rgba(52,211,153,0.35)' : theme.border}` }}
            >
              <input type="checkbox" checked={alreadyPaid} onChange={e => setAlreadyPaid(e.target.checked)} style={{ width: '13px', height: '13px', accentColor: '#34d399' }} />
              <span style={{ fontSize: '11px', fontWeight: 700, color: alreadyPaid ? '#34d399' : 'var(--text-muted)' }}>Already paid — record only</span>
            </label>
            <button onClick={() => { setReview(null); setStagedFile(null); setSelectedCompany(null); setAddVendorOpen(false); setAlreadyPaid(false); setBulkOpen(false); setBulkText(''); }} style={{ padding: '10px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'transparent', border: `1px solid ${theme.border}`, color: 'var(--text-muted)', cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleCommit} disabled={committing} style={{ padding: '10px 20px', borderRadius: '8px', fontSize: '13px', fontWeight: 800, background: committing ? theme.border : alreadyPaid ? '#34d399' : '#f472b6', color: '#fff', border: 'none', cursor: committing ? 'default' : 'pointer' }}>
              {committing ? 'Recording…' : `${alreadyPaid ? 'Record as Paid' : 'Record Invoice'} (${review.lines.filter(vinOk).length} VINs)`}
            </button>
          </div>
        </div>
      )}

      {/* History */}
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '8px' }}>
        Recorded Vendor Invoices ({history.length})
      </div>
      {history.length === 0 && (
        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: '12px', fontWeight: 600 }}>
          No vendor invoices recorded yet
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {history.map(inv => {
          const isExpanded = expandedInvoices.has(inv.id);
          const updatedCount = inv.lines.filter(l => l.was_existing_scan).length;
          const chip = INVOICE_STATUS_CHIP[inv.status] || INVOICE_STATUS_CHIP.recorded;
          const canSubmit = inv.status === 'recorded' || inv.status === 'rejected';
          // Once an invoice enters the payment pipeline, deleting it here would
          // pull it out from under finance — manage it from /admin/ap instead.
          // Paid-with-no-bill = marked paid outside the pipeline; still ours.
          const canDelete = inv.status === 'recorded' || inv.status === 'rejected'
            || (inv.status === 'paid' && !inv.netsuite_bill_id);
          return (
            <div key={inv.id} style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '10px', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px' }}>
                <div onClick={() => setExpandedInvoices(prev => { const n = new Set(prev); if (n.has(inv.id)) n.delete(inv.id); else n.add(inv.id); return n; })} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {inv.vendor_name}{inv.invoice_number ? ` · #${inv.invoice_number}` : ''}
                    {inv.total_amount != null && <span style={{ color: '#f472b6', marginLeft: '8px' }}>{fmtMoney(Number(inv.total_amount))}</span>}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>
                    {inv.lines.length} VIN{inv.lines.length !== 1 ? 's' : ''}{updatedCount > 0 ? ` (${updatedCount} pre-existing)` : ''}
                    {inv.location_name ? ` · ${inv.location_name}` : ''}
                    {inv.invoice_date ? ` · ${inv.invoice_date}` : ''}
                    {inv.due_date ? ` · due ${inv.due_date}` : ''} · recorded {new Date(inv.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    {inv.netsuite_bill_id ? ` · NS bill ${inv.netsuite_bill_id}` : ''}
                  </div>
                </div>
                <span style={{ padding: '3px 8px', borderRadius: '5px', fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: chip.color, background: chip.bg, flexShrink: 0 }}>
                  {chip.label}
                </span>
                {canSubmit && (
                  <button
                    onClick={() => submitInvoice(inv)}
                    disabled={submittingInvoice === inv.id}
                    style={{ padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399', cursor: 'pointer', flexShrink: 0 }}
                  >
                    {submittingInvoice === inv.id ? '…' : inv.status === 'rejected' ? 'Resubmit' : 'Submit for Payment'}
                  </button>
                )}
                {canSubmit && (
                  <button
                    onClick={() => markPaidInvoice(inv)}
                    disabled={markingPaid === inv.id}
                    title="Record this invoice as already paid outside FleetSuite — skips the approval and payment pipeline"
                    style={{ padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer', flexShrink: 0 }}
                  >
                    {markingPaid === inv.id ? '…' : '✓ Mark Paid'}
                  </button>
                )}
                {inv.storage_path && (
                  <a
                    href={storage.from('invoices').getPublicUrl(inv.storage_path).data.publicUrl}
                    target="_blank" rel="noreferrer"
                    style={{ padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', textDecoration: 'none', flexShrink: 0 }}
                  >
                    File
                  </a>
                )}
                {canDelete && (
                  <button onClick={() => deleteInvoice(inv)} disabled={deletingInvoice === inv.id} style={{ padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444', cursor: 'pointer', flexShrink: 0 }}>
                    {deletingInvoice === inv.id ? '…' : '✕'}
                  </button>
                )}
              </div>
              {inv.status === 'rejected' && inv.rejection_reason && (
                <div style={{ padding: '6px 12px', borderTop: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.05)', fontSize: '10px', color: '#ef4444', fontWeight: 600 }}>
                  Rejected: {inv.rejection_reason}
                </div>
              )}
              {isExpanded && (
                <div style={{ borderTop: `1px solid ${theme.border}`, padding: '8px 12px' }}>
                  {inv.notes && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>{inv.notes}</div>}
                  {inv.lines.map(l => (
                    <div key={l.id} style={{ display: 'flex', gap: '8px', fontSize: '11px', padding: '2px 0', color: 'var(--text-secondary)' }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.vin}</span>
                      {l.part_number && <span style={{ color: 'var(--text-muted)' }}>{l.part_number}</span>}
                      <span style={{ flex: 1 }} />
                      {l.was_existing_scan && <span style={{ fontSize: '9px', color: '#fbbf24' }}>pre-existing</span>}
                      <span style={{ fontWeight: 700, color: '#f472b6' }}>{l.amount != null ? fmtMoney(Number(l.amount)) : '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
