'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import EmailProofSearch, { type EmailProofFile } from '@/components/EmailProofSearch';
import DropboxProofSearch, { type DropboxProofFile } from '@/components/DropboxProofSearch';
import { CreateNetsuiteItemModal } from '@/components/CreateNetsuiteItemModal';
import { DropZone } from '@/components/DropZone';

interface Part {
  id: string;
  netsuite_id: string;
  item_number: string;
  display_name: string | null;
  description: string | null;
  item_type: string | null;
  catalog: 'upfit' | 'graphics';
  sales_price: number;
  purchase_price: number;
  quantity_on_hand: number;
  quantity_available: number;
  labor_hours: number;
  ns_class: string | null;
  ns_department: string | null;
  vendor: string | null;
  billable_customer: string | null;
  requires_po_match: boolean;
  is_active: boolean;
  last_synced_at: string;
  // Graphics metadata (folded in from the old catalog; local, not NetSuite-synced)
  vehicle_type: string | null;
  graphic_package: string | null;
  customer: string | null;
  proof_pages: number | null;
  // Running average of what CNI installers billed us per unit (from
  // vendor_invoice_lines, maintained by recompute_part_install_cost)
  avg_install_cost: number | null;
  install_cost_count: number | null;
}

interface SyncLog {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  parts_synced: number;
  error: string | null;
}

// Time window for the "completed" (scan) count. Calendar-period-to-date.
type CompletedRange = 'day' | 'week' | 'month' | 'year' | 'all';
const RANGES: { id: CompletedRange; label: string }[] = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'all', label: 'All' },
];
const RANGE_PHRASE: Record<CompletedRange, string> = {
  day: 'today', week: 'this week', month: 'this month', year: 'this year', all: 'all time',
};

// Part fields an admin can edit inline. The "NetSuite" set writes back to
// NetSuite via /api/parts/[id]; the "graphics" set is local-only metadata
// (folded in from the old catalog, never overwritten by the sync) and updates
// netsuite_parts directly.
type EditableField =
  | 'item_number' | 'display_name' | 'sales_price' | 'purchase_price'
  | 'vehicle_type' | 'graphic_package' | 'customer' | 'proof_pages';
const NETSUITE_FIELDS: EditableField[] = ['item_number', 'display_name', 'sales_price', 'purchase_price'];
const TEXT_FIELDS: EditableField[] = ['item_number', 'display_name', 'vehicle_type', 'graphic_package', 'customer'];

// A real NetSuite-synced part has a numeric internal id, not a local placeholder.
const isRealNsPart = (p: { netsuite_id: string | null }) => !!p.netsuite_id && !/^(LOCAL-|bmg-)/i.test(p.netsuite_id);
// Pick the best survivor when merging duplicates: prefer a real NetSuite row,
// then one with a real display name, then one with a price.
const partScore = (p: Part) =>
  (isRealNsPart(p) ? 4 : 0) +
  (p.display_name && p.display_name !== p.item_number ? 2 : 0) +
  ((p.sales_price || 0) > 0 ? 1 : 0);
const bestKeeperId = (g: Part[]) => [...g].sort((a, b) => partScore(b) - partScore(a))[0].id;

export default function PartsPage() {
  const router = useRouter();
  const { user, isAdmin, isSales, loading: authLoading } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();

  const [parts, setParts] = useState<Part[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<'upfit' | 'graphics'>('upfit');
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [lastSync, setLastSync] = useState<SyncLog | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  // Duplicate cleanup: groups of rows sharing a part number, the chosen survivor
  // per group, and which group is mid-merge.
  const [duplicateGroups, setDuplicateGroups] = useState<Part[][]>([]);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [keeperByGroup, setKeeperByGroup] = useState<Record<string, string>>({});
  const [merging, setMerging] = useState<string | null>(null);
  // Deep-link focus: the item number to open + scroll to once parts load, and
  // the row to briefly highlight so it's obvious where the search landed you.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [editingLabor, setEditingLabor] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<'item_number' | 'sales_price' | 'quantity_on_hand' | 'labor_hours'>('item_number');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [laborValue, setLaborValue] = useState('');

  // Completed (scan) + PO-quantity stats, keyed by uppercased item number.
  const [range, setRange] = useState<CompletedRange>('all');
  const [scanRows, setScanRows] = useState<{ part: string; at: string }[]>([]);
  const [poRemainingByPart, setPoRemainingByPart] = useState<Record<string, number>>({});
  const [poAllByPart, setPoAllByPart] = useState<Record<string, number>>({});
  const [statsLoading, setStatsLoading] = useState(true);

  // Local-only part being pushed to NetSuite via the create-item modal.
  const [nsCreatePart, setNsCreatePart] = useState<Part | null>(null);

  // Billable customer editing
  const [editingCustomer, setEditingCustomer] = useState<string | null>(null);
  const [customerValue, setCustomerValue] = useState('');

  // Description editing (writes back to NetSuite for synced parts)
  const [editingDescription, setEditingDescription] = useState<string | null>(null);
  const [descValue, setDescValue] = useState('');
  const [savingDescription, setSavingDescription] = useState(false);
  const [descError, setDescError] = useState<string | null>(null);

  // Core synced-field editing (display name, sales/purchase price). Edits write
  // back to NetSuite via /api/parts/[id], then mirror locally. One field edits
  // at a time across the whole list, so a single set of state vars is enough.
  const [editField, setEditField] = useState<{ id: string; field: EditableField } | null>(null);
  const [editFieldValue, setEditFieldValue] = useState('');
  const [savingField, setSavingField] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Part files
  interface PartFile { id: string; part_id: string; file_name: string; file_type: string | null; file_size: number | null; storage_path: string; bucket: string | null; }
  const [partFiles, setPartFiles] = useState<Record<string, PartFile[]>>({});

  // Installed-on-vehicle photos: completion photos techs/CNI installers took
  // when scanning this part onto real vehicles (see /api/parts/install-photos).
  interface InstallPhoto { id: string; source: string; bucket: string; storagePath: string; fileName: string | null; photoType: string; vin: string | null; vehicle: string | null; uploadedAt: string | null; uploadedByName: string | null; }
  const [installPhotos, setInstallPhotos] = useState<Record<string, InstallPhoto[] | 'loading'>>({});
  const [installPhotoView, setInstallPhotoView] = useState<InstallPhoto | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const partFileRef = useRef<HTMLInputElement>(null);
  // Which part (if any) has a proof-search panel open, and from which source.
  // Only one panel is open at a time so the two sources don't stack.
  const [proofSearch, setProofSearch] = useState<{ partId: string; source: 'email' | 'dropbox' } | null>(null);
  // Monotonic token to ignore stale loadParts() responses. A deep-link switches
  // catalog right after mount, so a slower earlier load must not clobber it.
  const loadReqRef = useRef(0);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    // loadParts() is driven by the [catalog] effect below (fires on mount too),
    // so we don't call it here — a second call just races the first.
    loadLastSync();
    loadStats();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin, isSales]);

  useEffect(() => {
    loadParts();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [catalog]);

  // Deep-link from global search: /parts?catalog=graphics&q=06U183
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const c = params.get('catalog');
    const q = params.get('q');
    if (c === 'graphics' || c === 'upfit') setCatalog(c);
    if (q) { setSearch(q); setPendingFocus(q.toUpperCase()); }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read URL once on mount
  }, []);

  const loadParts = async () => {
    const reqId = ++loadReqRef.current;
    setLoading(true);
    // Supabase returns max 1000 rows by default — paginate to get all
    let allParts: Part[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data } = await supabase
        .from('netsuite_parts')
        .select('*')
        .eq('catalog', catalog)
        .eq('is_active', true)
        .order('item_number', { ascending: true })
        .range(from, to);
      const batch = (data || []) as Part[];
      allParts = allParts.concat(batch);
      hasMore = batch.length === pageSize;
      page++;
    }
    // Collapse duplicate rows for the same item number (legacy data: pre-merge
    // mirrors, repeated "add to catalog", etc.) — keep the most authoritative.
    const isRealNs = (p: Part) => !!p.netsuite_id && !/^(LOCAL-|bmg-)/i.test(p.netsuite_id);
    const score = (p: Part) =>
      (isRealNs(p) ? 4 : 0) +
      (p.display_name && p.display_name !== p.item_number ? 2 : 0) +
      ((p.sales_price || 0) > 0 ? 1 : 0);
    const byItem = new Map<string, Part>();
    for (const p of allParts) {
      const key = (p.item_number || '').toUpperCase();
      const cur = byItem.get(key);
      if (!cur || score(p) > score(cur)) byItem.set(key, p);
    }
    if (loadReqRef.current !== reqId) return; // superseded by a newer load
    setParts([...byItem.values()].sort((a, b) => a.item_number.localeCompare(b.item_number)));

    // Duplicate groups (>1 row sharing a part number) for the merge panel — the
    // display above collapses them, so this is the only place they're surfaced.
    const groups = new Map<string, Part[]>();
    for (const p of allParts) {
      const k = (p.item_number || '').trim().toLowerCase();
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(p);
    }
    setDuplicateGroups(
      [...groups.values()]
        .filter((g) => g.length > 1)
        .sort((a, b) => a[0].item_number.localeCompare(b[0].item_number)),
    );
    setLoading(false);
  };

  const loadLastSync = async () => {
    const { data } = await supabase
      .from('parts_sync_log')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(1)
      .single();
    if (data) setLastSync(data as SyncLog);
  };

  // Pull scans ("completed") + PO quantities once and aggregate per part. Runs
  // in the background after parts so the catalog itself renders immediately.
  const loadStats = async () => {
    setStatsLoading(true);

    const fetchAll = async (table: string, cols: string): Promise<any[]> => {
      let all: any[] = [];
      let pg = 0;
      let more = true;
      while (more) {
        const { data } = await supabase.from(table).select(cols).range(pg * 1000, pg * 1000 + 999);
        const batch = data || [];
        all = all.concat(batch);
        more = batch.length === 1000;
        pg++;
      }
      return all;
    };

    const [scanData, poData, lineData] = await Promise.all([
      fetchAll('scan_logs', 'part_number, scanned_at'),
      fetchAll('purchase_orders', 'id, status'),
      fetchAll('po_line_items', 'part_number, quantity, installed, po_id'),
    ]);

    setScanRows(
      scanData
        .filter((s) => s.part_number)
        .map((s) => ({ part: String(s.part_number).toUpperCase(), at: s.scanned_at }))
    );

    // PO status by id, so line-item quantities can be split into open vs. all.
    const poStatus = new Map<string, string>();
    for (const p of poData) poStatus.set(p.id, p.status);

    // "remaining" = units still to do on OPEN POs (ordered minus installed);
    // "all" = total ever ordered across every PO.
    const remaining: Record<string, number> = {};
    const all: Record<string, number> = {};
    for (const l of lineData) {
      if (!l.part_number) continue;
      const key = String(l.part_number).toUpperCase();
      const q = l.quantity || 0;
      all[key] = (all[key] || 0) + q;
      if (poStatus.get(l.po_id) === 'open') {
        remaining[key] = (remaining[key] || 0) + Math.max(0, q - (l.installed || 0));
      }
    }
    setPoRemainingByPart(remaining);
    setPoAllByPart(all);
    setStatsLoading(false);
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage('Syncing parts from NetSuite...');

    try {
      const res = await fetch('/api/parts/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user?.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setSyncMessage(`Sync failed: ${data.error || 'Unknown error'}`);
      } else {
        const details = [
          `${data.synced} parts synced`,
          data.itemsWithPrice ? `${data.itemsWithPrice} with price` : null,
          data.itemsWithQty ? `${data.itemsWithQty} with qty` : null,
        ].filter(Boolean).join(', ');
        setSyncMessage(details);
        loadParts();
        loadLastSync();
      }
    } catch (err: any) {
      setSyncMessage(`Sync error: ${err.message}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMessage(''), 5000);
    }
  };

  // Re-file a part into the other catalog. Sets catalog_override so the
  // NetSuite parts sync keeps the manual assignment instead of re-deriving it
  // from ns_class / item-number prefix on the next run.
  const movePartCatalog = async (part: Part) => {
    const target = part.catalog === 'graphics' ? 'upfit' : 'graphics';
    if (!(await dialog.confirm(
      `Move ${part.item_number} to the ${target} catalog? The NetSuite sync will keep it there.`
    ))) return;
    setMovingId(part.id);
    const { error } = await supabase
      .from('netsuite_parts')
      .update({ catalog: target, catalog_override: target, updated_at: new Date().toISOString() })
      .eq('id', part.id);
    if (error) {
      await dialog.alert(`Move failed: ${error.message}`);
    } else {
      // The list only holds the active catalog's parts — drop the moved row.
      setParts(prev => prev.filter(p => p.id !== part.id));
      setExpandedId(null);
    }
    setMovingId(null);
  };

  const updateLaborHours = async (partId: string) => {
    const hours = parseFloat(laborValue);
    if (isNaN(hours) || hours < 0) return;

    await supabase
      .from('netsuite_parts')
      .update({ labor_hours: hours, updated_at: new Date().toISOString() })
      .eq('id', partId);

    setEditingLabor(null);
    setLaborValue('');
    loadParts();
  };

  const updateBillableCustomer = async (partId: string) => {
    await supabase.from('netsuite_parts').update({ billable_customer: customerValue.trim() || null }).eq('id', partId);
    setParts(prev => prev.map(p => p.id === partId ? { ...p, billable_customer: customerValue.trim() || null } : p));
    setEditingCustomer(null);
    setCustomerValue('');
  };

  // Save an edited description. For NetSuite-synced parts the server writes it
  // back to NetSuite first (so the next sync doesn't revert it), then mirrors it
  // locally; we reflect the saved value in the list on success.
  const saveDescription = async (partId: string) => {
    setSavingDescription(true);
    setDescError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      const res = await fetch(`/api/parts/${partId}/description`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ description: descValue }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDescError(body.error || `Save failed (${res.status})`);
        return;
      }
      setParts(prev => prev.map(p => p.id === partId ? { ...p, description: body.description } : p));
      setEditingDescription(null);
      setDescValue('');
    } finally {
      setSavingDescription(false);
    }
  };

  const startFieldEdit = (partId: string, field: EditableField, current: string) => {
    setEditField({ id: partId, field });
    setEditFieldValue(current);
    setFieldError(null);
  };

  const cancelFieldEdit = () => {
    setEditField(null);
    setEditFieldValue('');
    setFieldError(null);
  };

  // Save an edited part field. NetSuite-backed fields (number, name, prices) go
  // through /api/parts/[id], which writes the change back to NetSuite before
  // mirroring it locally. Graphics metadata (vehicle type, package, brand, proof
  // pages) is local-only — the sync never touches it — so it updates the row
  // directly.
  const savePartField = async (partId: string) => {
    if (!editField) return;
    const { field } = editField;

    let value: string | number;
    if (TEXT_FIELDS.includes(field)) {
      const v = editFieldValue.trim();
      if (field === 'item_number' && !v) { setFieldError('Part number cannot be empty'); return; }
      value = v;
    } else {
      const num = field === 'proof_pages' ? parseInt(editFieldValue, 10) : parseFloat(editFieldValue);
      if (isNaN(num) || num < 0) { setFieldError('Enter a valid number'); return; }
      value = field === 'proof_pages' ? Math.max(1, num) : num;
    }

    setSavingField(true);
    setFieldError(null);
    try {
      if (NETSUITE_FIELDS.includes(field)) {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token;
        const res = await fetch(`/api/parts/${partId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ [field]: value }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setFieldError(body.error || `Save failed (${res.status})`);
          return;
        }
        // On a rename, the server also carries old part-number strings (scans, PO
        // lines, estimates, …) over to the new number — confirm how many moved.
        if (field === 'item_number' && typeof body.sweptReferences === 'number' && body.sweptReferences > 0) {
          const n = body.sweptReferences;
          setSyncMessage(`Renamed — updated ${n} historical reference${n === 1 ? '' : 's'} to the new number.`);
          setTimeout(() => setSyncMessage(''), 5000);
        }
      } else {
        // Local-only graphics metadata — admins can update netsuite_parts under RLS.
        const { error } = await supabase
          .from('netsuite_parts')
          .update({ [field]: value, updated_at: new Date().toISOString() })
          .eq('id', partId);
        if (error) { setFieldError(error.message); return; }
      }
      setParts(prev => prev.map(p => p.id === partId ? ({ ...p, [field]: value } as Part) : p));
      cancelFieldEdit();
    } finally {
      setSavingField(false);
    }
  };

  // Delete a part from FleetSuite only (the local mirror) — NetSuite is left
  // alone. For clearing duplicates / rows that are wrong locally but right in
  // NetSuite. If the item still lives in NetSuite, a later sync may re-add it.
  const deletePart = async (part: Part) => {
    if (!(await dialog.confirm(
      `Delete "${part.item_number}" from FleetSuite?\n\n` +
      `This removes it from this app only — NetSuite is not changed. If the item ` +
      `still exists in NetSuite, a future sync may re-add it.`,
      { confirmLabel: 'Delete', destructive: true },
    ))) return;

    setDeletingId(part.id);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      const res = await fetch(`/api/parts/${part.id}`, {
        method: 'DELETE',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSyncMessage(`Delete failed: ${body.error || res.status}`);
        setTimeout(() => setSyncMessage(''), 5000);
        return;
      }
      setParts(prev => prev.filter(p => p.id !== part.id));
      setExpandedId(null);
      setSyncMessage(`Deleted "${part.item_number}" from FleetSuite.`);
      setTimeout(() => setSyncMessage(''), 5000);
    } finally {
      setDeletingId(null);
    }
  };

  // Fold a group of duplicate rows into the chosen survivor. Proofs, PO lines,
  // scans and estimates move to the keeper; the rest are removed. Local only.
  const mergeGroup = async (groupKey: string, group: Part[]) => {
    const keepId = keeperByGroup[groupKey] || bestKeeperId(group);
    const mergeIds = group.filter(p => p.id !== keepId).map(p => p.id);
    if (mergeIds.length === 0) return;
    const itemNumber = group.find(p => p.id === keepId)?.item_number || group[0].item_number;
    if (!(await dialog.confirm(
      `Merge ${mergeIds.length} duplicate row${mergeIds.length === 1 ? '' : 's'} of "${itemNumber}" into the selected one?\n\n` +
      `Proofs, PO lines, scans and estimates move to the kept part; the others are removed. NetSuite is not changed.`,
      { confirmLabel: 'Merge' },
    ))) return;

    setMerging(groupKey);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      const res = await fetch('/api/parts/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ keepId, mergeIds }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSyncMessage(`Merge failed: ${body.error || res.status}`);
        setTimeout(() => setSyncMessage(''), 6000);
        return;
      }
      const moved = body.movedReferences ? ` · moved ${body.movedReferences} reference${body.movedReferences === 1 ? '' : 's'}` : '';
      const warn = body.netsuiteDuplicateWarning ? ' (a NetSuite-side duplicate may return on the next sync)' : '';
      setSyncMessage(`Merged ${body.mergedCount} duplicate${body.mergedCount === 1 ? '' : 's'} of "${itemNumber}"${moved}.${warn}`);
      setTimeout(() => setSyncMessage(''), 7000);
      await loadParts(); // recomputes the duplicate groups
    } finally {
      setMerging(null);
    }
  };

  const loadPartFiles = async (partId: string) => {
    const { data } = await supabase.from('part_files').select('*').eq('part_id', partId).order('uploaded_at', { ascending: false });
    if (data) setPartFiles(prev => ({ ...prev, [partId]: data as PartFile[] }));
  };

  // The gallery is keyed by part id but queried by item number — install
  // photos hang off scan records (part_number text), not catalog rows.
  const loadInstallPhotos = async (partId: string) => {
    const part = parts.find(p => p.id === partId);
    if (!part?.item_number) return;
    setInstallPhotos(prev => ({ ...prev, [partId]: Array.isArray(prev[partId]) ? prev[partId] : 'loading' }));
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      const res = await fetch(`/api/parts/install-photos?part=${encodeURIComponent(part.item_number)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const json = await res.json().catch(() => ({}));
      setInstallPhotos(prev => ({ ...prev, [partId]: res.ok ? (json.items || []) : [] }));
    } catch {
      setInstallPhotos(prev => ({ ...prev, [partId]: [] }));
    }
  };

  // Once parts have loaded, open + scroll to the deep-linked item (exact item
  // number match from global search) and highlight it briefly.
  useEffect(() => {
    if (!pendingFocus || parts.length === 0) return;
    const target = parts.find(p => (p.item_number || '').toUpperCase() === pendingFocus);
    if (!target) return;
    setPendingFocus(null);
    setExpandedId(target.id);
    loadPartFiles(target.id);
    loadInstallPhotos(target.id);
    setHighlightId(target.id);
    const t = setTimeout(() => setHighlightId(null), 2500);
    requestAnimationFrame(() => {
      document.getElementById(`part-row-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once parts arrive
  }, [parts, pendingFocus]);

  const uploadPartFile = async (partId: string, file: File) => {
    setUploadingFile(true);
    const ext = file.name.split('.').pop() || 'bin';
    const path = `part-files/${partId}/${Date.now()}.${ext}`;
    const { error: upErr } = await storage.from('graphics-proofs').upload(path, file, { contentType: file.type });
    if (!upErr) {
      await supabase.from('part_files').insert({ part_id: partId, file_name: file.name, file_type: file.type || null, file_size: file.size, storage_path: path, uploaded_by: user?.id });
      await loadPartFiles(partId);
    }
    setUploadingFile(false);
  };

  // Pull a proof straight out of email and attach it to this part. The server
  // downloads the chosen Gmail attachment, stores it in the graphics-proofs
  // bucket, and records a part_files row — same end state as a manual upload.
  const attachEmailProof = async (partId: string, file: EmailProofFile) => {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    const res = await fetch(`/api/parts/${partId}/attach-proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ messageId: file.messageId, attachmentId: file.attachmentId, filename: file.filename }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Attach failed (${res.status})`);
    }
    await loadPartFiles(partId);
  };

  // Same as attachEmailProof, but the server pulls the file from Dropbox.
  const attachDropboxProof = async (partId: string, file: DropboxProofFile) => {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    const res = await fetch(`/api/parts/${partId}/attach-dropbox-proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ dropboxPath: file.path, filename: file.name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Attach failed (${res.status})`);
    }
    await loadPartFiles(partId);
  };

  const deletePartFile = async (file: PartFile) => {
    if (!(await dialog.confirm(`Delete "${file.file_name}"?`, { confirmLabel: 'Delete', destructive: true }))) return;
    await storage.from(file.bucket || 'graphics-proofs').remove([file.storage_path]);
    await supabase.from('part_files').delete().eq('id', file.id);
    setPartFiles(prev => ({ ...prev, [file.part_id]: (prev[file.part_id] || []).filter(f => f.id !== file.id) }));
  };

  // Folded-in proofs from the old catalog live in the 'proofs' bucket; native
  // part files live in 'graphics-proofs'. Honor each file's own bucket.
  const getFileUrl = (file: PartFile) => storage.from(file.bucket || 'graphics-proofs').getPublicUrl(file.storage_path).data.publicUrl;

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };
  const sortIndicator = (col: typeof sortCol) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  // Start of the selected window (ms). Recompute completed counts client-side
  // from the loaded scans, so changing the range needs no refetch.
  const rangeStartMs = useMemo(() => {
    if (range === 'all') return 0;
    const now = new Date();
    if (range === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (range === 'week') { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); d.setDate(d.getDate() - d.getDay()); return d.getTime(); }
    if (range === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return new Date(now.getFullYear(), 0, 1).getTime(); // year
  }, [range]);

  const completedByPart = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of scanRows) {
      if (rangeStartMs && new Date(r.at).getTime() < rangeStartMs) continue;
      m[r.part] = (m[r.part] || 0) + 1;
    }
    return m;
  }, [scanRows, rangeStartMs]);

  // Catalog-wide roll-up for the header line.
  const catalogTotals = useMemo(() => {
    let completed = 0, remaining = 0;
    for (const p of parts) {
      const k = (p.item_number || '').toUpperCase();
      completed += completedByPart[k] || 0;
      remaining += poRemainingByPart[k] || 0;
    }
    return { completed, remaining };
  }, [parts, completedByPart, poRemainingByPart]);

  const filtered = parts.filter(p => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      p.item_number.toLowerCase().includes(s) ||
      p.display_name?.toLowerCase().includes(s) ||
      p.description?.toLowerCase().includes(s)
    );
  }).sort((a, b) => {
    const av = a[sortCol] ?? 0;
    const bv = b[sortCol] ?? 0;
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const formatCurrency = (val: number) => {
    return val ? `$${val.toFixed(2)}` : '$0.00';
  };

  const formatQty = (val: number) => {
    return val % 1 === 0 ? val.toString() : val.toFixed(1);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-primary)', fontSize: '12px',
  };

  if (!isAdmin && !isSales) return null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Parts Catalog</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {parts.length} {catalog} parts {lastSync?.completed_at ? `· Last synced ${new Date(lastSync.completed_at).toLocaleString()}` : ''}
          </div>
        </div>
        {isAdmin && (
          <button
            onClick={handleSync}
            disabled={syncing}
            style={{
              padding: '8px 14px', borderRadius: '10px',
              background: syncing ? 'var(--subtle-bg)' : 'var(--accent)',
              color: '#fff', fontWeight: 800, fontSize: '12px',
              border: 'none', cursor: syncing ? 'not-allowed' : 'pointer',
              opacity: syncing ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        )}
      </div>

      {/* Sync message */}
      {syncMessage && (
        <div style={{
          padding: '8px 12px', borderRadius: '8px', marginBottom: '10px',
          background: syncMessage.includes('fail') || syncMessage.includes('error')
            ? 'var(--error-bg)' : 'rgba(16,185,129,0.1)',
          border: `1px solid ${syncMessage.includes('fail') || syncMessage.includes('error')
            ? 'var(--error-border)' : 'rgba(16,185,129,0.2)'}`,
          color: syncMessage.includes('fail') || syncMessage.includes('error')
            ? 'var(--error)' : '#34d399',
          fontSize: '12px', fontWeight: 600,
        }}>
          {syncMessage}
        </div>
      )}

      {/* Catalog tabs */}
      <div style={{
        display: 'flex', gap: '4px', padding: '4px',
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: '12px', marginBottom: '10px',
      }}>
        {([
          { id: 'upfit' as const, label: 'Upfit Parts', desc: 'Fleet & install' },
          { id: 'graphics' as const, label: 'Graphic Parts', desc: 'Decals & wraps' },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => { setCatalog(tab.id); setExpandedId(null); }}
            style={{
              flex: 1, padding: '10px 8px', borderRadius: '10px',
              fontSize: '13px', fontWeight: 700, textAlign: 'center',
              background: catalog === tab.id ? 'var(--tab-active-bg)' : 'transparent',
              border: catalog === tab.id ? '1px solid var(--tab-active-border)' : '1px solid transparent',
              color: catalog === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
              transition: 'all 0.15s',
            }}
          >
            <div>{tab.label}</div>
            <div style={{ fontSize: '9px', fontWeight: 400, marginTop: '1px', color: 'var(--text-muted)' }}>{tab.desc}</div>
          </button>
        ))}
      </div>

      {/* Duplicate cleanup — merge rows that share a part number */}
      {isAdmin && duplicateGroups.length > 0 && (
        <div style={{ marginBottom: '10px' }}>
          <button
            onClick={() => setShowDuplicates(s => !s)}
            style={{
              width: '100%', padding: '9px 12px', borderRadius: '10px', textAlign: 'left',
              background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.30)',
              color: '#f59e0b', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
            }}
          >
            <span>⚠ {duplicateGroups.length} duplicate part number{duplicateGroups.length === 1 ? '' : 's'} in {catalog}</span>
            <span style={{ whiteSpace: 'nowrap' }}>{showDuplicates ? 'Hide ▴' : 'Review & merge ▾'}</span>
          </button>

          {showDuplicates && (
            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {duplicateGroups.map(group => {
                const gk = (group[0].item_number || '').trim().toLowerCase();
                const keepId = keeperByGroup[gk] || bestKeeperId(group);
                const isMerging = merging === gk;
                return (
                  <div key={gk} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '10px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
                      {group[0].item_number} <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>×{group.length}</span>
                    </div>
                    <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
                      Keep which row?
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                      {group.map(p => {
                        const selected = p.id === keepId;
                        return (
                          <label key={p.id} style={{
                            display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px', cursor: 'pointer',
                            background: selected ? 'var(--tab-active-bg)' : 'var(--subtle-bg)',
                            border: `1px solid ${selected ? 'var(--tab-active-border)' : 'var(--border)'}`,
                          }}>
                            <input type="radio" name={`keep-${gk}`} checked={selected}
                              onChange={() => setKeeperByGroup(prev => ({ ...prev, [gk]: p.id }))} />
                            <span style={{
                              fontSize: '9px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px', whiteSpace: 'nowrap',
                              background: isRealNsPart(p) ? 'rgba(52,211,153,0.12)' : 'rgba(148,163,184,0.15)',
                              border: `1px solid ${isRealNsPart(p) ? 'rgba(52,211,153,0.3)' : 'rgba(148,163,184,0.3)'}`,
                              color: isRealNsPart(p) ? '#34d399' : 'var(--text-muted)',
                            }}>{isRealNsPart(p) ? 'NetSuite' : 'local'}</span>
                            <span style={{ fontSize: '11px', fontWeight: 700, color: '#34d399', minWidth: '54px' }}>{formatCurrency(p.sales_price)}</span>
                            <span style={{ fontSize: '11px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {p.display_name || p.description || '—'}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <button onClick={() => mergeGroup(gk, group)} disabled={isMerging}
                      style={{
                        width: '100%', marginTop: '8px', padding: '8px', borderRadius: '8px',
                        background: isMerging ? 'var(--subtle-bg)' : 'var(--accent)', color: '#fff',
                        fontSize: '11px', fontWeight: 800, border: 'none',
                        cursor: isMerging ? 'default' : 'pointer', opacity: isMerging ? 0.6 : 1,
                      }}>
                      {isMerging ? 'Merging…' : `Merge ${group.length - 1} other${group.length - 1 === 1 ? '' : 's'} into selected`}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Search */}
      <input
        placeholder={`Search ${catalog} parts...`}
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ ...inputStyle, marginBottom: '10px' }}
      />

      {/* Completed time-range filter + catalog roll-up */}
      <div style={{ marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '10px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>Completed</span>
          {RANGES.map(r => (
            <button key={r.id} onClick={() => setRange(r.id)} style={{
              padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
              background: range === r.id ? 'var(--tab-active-bg)' : 'transparent',
              border: range === r.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
              color: range === r.id ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'pointer',
            }}>{r.label}</button>
          ))}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
          {statsLoading ? 'Loading stats…' : (
            <>
              <span style={{ color: '#34d399', fontWeight: 800 }}>{catalogTotals.completed}</span> completed {RANGE_PHRASE[range]}
              {' · '}
              <span style={{ color: '#60a5fa', fontWeight: 800 }}>{formatQty(catalogTotals.remaining)}</span> open on POs
            </>
          )}
        </div>
      </div>

      {/* Parts list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading parts...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '13px', marginBottom: '8px', fontWeight: 700, color: 'var(--text-muted)' }}>—</div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>
            {parts.length === 0 ? 'No parts synced yet' : 'No matching parts'}
          </div>
          <div style={{ fontSize: '11px', marginTop: '4px' }}>
            {parts.length === 0 ? 'Hit "Sync Now" to pull parts from NetSuite.' : 'Try different search terms.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {/* Column headers */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 70px 50px 50px',
            padding: '6px 12px', fontSize: '9px', fontWeight: 700,
            color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px',
          }}>
            <div onClick={() => toggleSort('item_number')} style={{ cursor: 'pointer', color: sortCol === 'item_number' ? '#60a5fa' : undefined }}>Part{sortIndicator('item_number')}</div>
            <div onClick={() => toggleSort('sales_price')} style={{ textAlign: 'right', cursor: 'pointer', color: sortCol === 'sales_price' ? '#60a5fa' : undefined }}>Sale ${sortIndicator('sales_price')}</div>
            <div onClick={() => toggleSort('quantity_on_hand')} style={{ textAlign: 'right', cursor: 'pointer', color: sortCol === 'quantity_on_hand' ? '#60a5fa' : undefined }}>Qty{sortIndicator('quantity_on_hand')}</div>
            <div onClick={() => toggleSort('labor_hours')} style={{ textAlign: 'right', cursor: 'pointer', color: sortCol === 'labor_hours' ? '#60a5fa' : undefined }}>Labor{sortIndicator('labor_hours')}</div>
          </div>

          {filtered.map(part => {
            const isExpanded = expandedId === part.id;
            const isEditingLabor = editingLabor === part.id;
            const fieldEditing = (f: EditableField) => editField?.id === part.id && editField?.field === f;
            const fieldErr = (f: EditableField) => (fieldEditing(f) ? fieldError : null);
            // Graphics metadata is relevant on the graphics catalog, or on any
            // part that already carries some — show its editors there.
            const showGraphics = isAdmin && (catalog === 'graphics'
              || !!(part.vehicle_type || part.graphic_package || part.customer || (part.proof_pages && part.proof_pages !== 1)));
            const key = (part.item_number || '').toUpperCase();
            const completed = completedByPart[key] || 0;
            const margin = part.sales_price > 0 && part.purchase_price > 0
              ? ((part.sales_price - part.purchase_price) / part.sales_price * 100).toFixed(1)
              : null;

            return (
              <div key={part.id} id={`part-row-${part.id}`} style={{
                borderRadius: '10px',
                background: 'var(--card)',
                border: highlightId === part.id ? '1px solid #60a5fa' : '1px solid var(--border)',
                boxShadow: highlightId === part.id ? '0 0 0 2px rgba(96,165,250,0.5)' : undefined,
                transition: 'box-shadow 0.3s ease, border-color 0.3s ease',
                overflow: 'hidden',
              }}>
                {/* Row summary */}
                <div
                  onClick={() => { const newId = isExpanded ? null : part.id; setExpandedId(newId); if (newId) { loadPartFiles(newId); loadInstallPhotos(newId); } }}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr 70px 50px 50px',
                    padding: '10px 12px', cursor: 'pointer', alignItems: 'center',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {part.item_number}
                      </span>
                      {part.vendor && (
                        <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {part.vendor}
                        </span>
                      )}
                      {!isRealNsPart(part) && (
                        <span title="Exists in FleetSuite only — not yet created in NetSuite" style={{ fontSize: '8px', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.30)', color: '#f59e0b', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          local
                        </span>
                      )}
                      {completed > 0 && (
                        <span title={`Completed ${RANGE_PHRASE[range]}`} style={{ fontSize: '8px', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          ✓ {completed}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {part.display_name || part.description || '—'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: '12px', fontWeight: 700, color: '#34d399' }}>
                    {formatCurrency(part.sales_price)}
                  </div>
                  <div style={{ textAlign: 'right', fontSize: '12px', fontWeight: 600, color: part.quantity_on_hand > 0 ? 'var(--text-primary)' : 'var(--error)' }}>
                    {formatQty(part.quantity_on_hand)}
                  </div>
                  <div style={{ textAlign: 'right', fontSize: '12px', fontWeight: 600, color: part.labor_hours > 0 ? '#c084fc' : 'var(--text-muted)' }}>
                    {part.labor_hours > 0 ? `${part.labor_hours}h` : '—'}
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '10px' }}>
                      {isAdmin ? (
                        <InlineEditField
                          label="Sales Price" display={formatCurrency(part.sales_price)} color="#34d399"
                          isEditing={fieldEditing('sales_price')} value={editFieldValue} onValueChange={setEditFieldValue}
                          onEdit={() => startFieldEdit(part.id, 'sales_price', part.sales_price ? String(part.sales_price) : '')}
                          onSave={() => savePartField(part.id)} onCancel={cancelFieldEdit}
                          saving={savingField} error={fieldErr('sales_price')} inputType="number" step="0.01"
                        />
                      ) : (
                        <DetailField label="Sales Price" value={formatCurrency(part.sales_price)} color="#34d399" />
                      )}
                      {isAdmin ? (
                        <InlineEditField
                          label="Purchase Price" display={formatCurrency(part.purchase_price)} color="#60a5fa"
                          isEditing={fieldEditing('purchase_price')} value={editFieldValue} onValueChange={setEditFieldValue}
                          onEdit={() => startFieldEdit(part.id, 'purchase_price', part.purchase_price ? String(part.purchase_price) : '')}
                          onSave={() => savePartField(part.id)} onCancel={cancelFieldEdit}
                          saving={savingField} error={fieldErr('purchase_price')} inputType="number" step="0.01"
                        />
                      ) : (
                        <DetailField label="Purchase Price" value={formatCurrency(part.purchase_price)} color="#60a5fa" />
                      )}
                      <DetailField label="Qty On Hand" value={formatQty(part.quantity_on_hand)} color={part.quantity_on_hand > 0 ? 'var(--text-primary)' : 'var(--error)'} />
                      <DetailField label="Qty Available" value={formatQty(part.quantity_available)} color={part.quantity_available > 0 ? 'var(--text-primary)' : 'var(--error)'} />
                      <DetailField label={`Completed · ${RANGE_PHRASE[range]}`} value={statsLoading ? '…' : completed.toString()} color="#34d399" />
                      <DetailField label="Open on POs" value={statsLoading ? '…' : formatQty(poRemainingByPart[key] || 0)} color="#60a5fa" />
                      <DetailField label="On All POs" value={statsLoading ? '…' : formatQty(poAllByPart[key] || 0)} color="var(--text-secondary)" />
                      {margin && (
                        <DetailField label="Margin" value={`${margin}%`} color={parseFloat(margin) > 30 ? '#34d399' : '#f59e0b'} />
                      )}
                      {part.avg_install_cost != null && (
                        <DetailField
                          label={`Avg Installer Cost (${part.install_cost_count || 0} VIN${(part.install_cost_count || 0) !== 1 ? 's' : ''})`}
                          value={formatCurrency(part.avg_install_cost)}
                          color="#f472b6"
                        />
                      )}
                      <div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>
                          Labor Hours
                        </div>
                        {isEditingLabor ? (
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <input
                              type="number"
                              step="0.25"
                              min="0"
                              value={laborValue}
                              onChange={e => setLaborValue(e.target.value)}
                              style={{ ...inputStyle, padding: '4px 6px', width: '70px' }}
                              autoFocus
                              onKeyDown={e => { if (e.key === 'Enter') updateLaborHours(part.id); if (e.key === 'Escape') setEditingLabor(null); }}
                            />
                            <button
                              onClick={() => updateLaborHours(part.id)}
                              style={{ padding: '4px 8px', borderRadius: '6px', background: 'var(--accent)', color: '#fff', fontSize: '10px', fontWeight: 700, border: 'none', cursor: 'pointer' }}
                            >
                              Save
                            </button>
                          </div>
                        ) : (
                          <div
                            onClick={() => { if (isAdmin) { setEditingLabor(part.id); setLaborValue(part.labor_hours.toString()); } }}
                            style={{ fontSize: '14px', fontWeight: 700, color: '#c084fc', cursor: isAdmin ? 'pointer' : 'default' }}
                          >
                            {part.labor_hours > 0 ? `${part.labor_hours}h` : '—'}
                            {isAdmin && <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginLeft: '4px' }}>Edit</span>}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Part Number & Display Name (editable by admins; written back to NetSuite) */}
                    {isAdmin && (
                      <div style={{ marginTop: '10px' }}>
                        <InlineEditField
                          label="Part Number"
                          display={part.item_number}
                          color="var(--text-primary)"
                          isEditing={fieldEditing('item_number')} value={editFieldValue} onValueChange={setEditFieldValue}
                          onEdit={() => startFieldEdit(part.id, 'item_number', part.item_number)}
                          onSave={() => savePartField(part.id)} onCancel={cancelFieldEdit}
                          saving={savingField} error={fieldErr('item_number')} placeholder="Part number"
                        />
                      </div>
                    )}
                    {isAdmin && (
                      <div style={{ marginTop: '10px' }}>
                        <InlineEditField
                          label="Display Name"
                          display={part.display_name || '— Set display name'}
                          color={part.display_name ? 'var(--text-primary)' : 'var(--text-muted)'}
                          isEditing={fieldEditing('display_name')} value={editFieldValue} onValueChange={setEditFieldValue}
                          onEdit={() => startFieldEdit(part.id, 'display_name', part.display_name || '')}
                          onSave={() => savePartField(part.id)} onCancel={cancelFieldEdit}
                          saving={savingField} error={fieldErr('display_name')} placeholder="Display name"
                        />
                      </div>
                    )}

                    {/* Graphics metadata (local-only; folded in from the old catalog) */}
                    {showGraphics && (
                      <div style={{ marginTop: '12px' }}>
                        <div style={{ fontSize: '9px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '6px' }}>Graphics</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                          <InlineEditField
                            label="Vehicle Type" display={part.vehicle_type || '—'}
                            color={part.vehicle_type ? 'var(--text-primary)' : 'var(--text-muted)'}
                            isEditing={fieldEditing('vehicle_type')} value={editFieldValue} onValueChange={setEditFieldValue}
                            onEdit={() => startFieldEdit(part.id, 'vehicle_type', part.vehicle_type || '')}
                            onSave={() => savePartField(part.id)} onCancel={cancelFieldEdit}
                            saving={savingField} error={fieldErr('vehicle_type')} placeholder="e.g. Transit 148"
                          />
                          <InlineEditField
                            label="Graphic Package" display={part.graphic_package || '—'}
                            color={part.graphic_package ? 'var(--text-primary)' : 'var(--text-muted)'}
                            isEditing={fieldEditing('graphic_package')} value={editFieldValue} onValueChange={setEditFieldValue}
                            onEdit={() => startFieldEdit(part.id, 'graphic_package', part.graphic_package || '')}
                            onSave={() => savePartField(part.id)} onCancel={cancelFieldEdit}
                            saving={savingField} error={fieldErr('graphic_package')} placeholder="Package"
                          />
                          <InlineEditField
                            label="Brand" display={part.customer || '—'}
                            color={part.customer ? 'var(--text-primary)' : 'var(--text-muted)'}
                            isEditing={fieldEditing('customer')} value={editFieldValue} onValueChange={setEditFieldValue}
                            onEdit={() => startFieldEdit(part.id, 'customer', part.customer || '')}
                            onSave={() => savePartField(part.id)} onCancel={cancelFieldEdit}
                            saving={savingField} error={fieldErr('customer')} placeholder="e.g. Masterack"
                          />
                          <InlineEditField
                            label="Proof Pages" display={String(part.proof_pages ?? 1)} color="var(--text-primary)"
                            isEditing={fieldEditing('proof_pages')} value={editFieldValue} onValueChange={setEditFieldValue}
                            onEdit={() => startFieldEdit(part.id, 'proof_pages', String(part.proof_pages ?? 1))}
                            onSave={() => savePartField(part.id)} onCancel={cancelFieldEdit}
                            saving={savingField} error={fieldErr('proof_pages')} inputType="number" step="1"
                          />
                        </div>
                      </div>
                    )}

                    {/* Extra info */}
                    <div style={{ marginTop: '10px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {part.item_type && (
                        <Tag label={part.item_type} />
                      )}
                      {part.ns_class && (
                        <Tag label={part.ns_class} />
                      )}
                      {part.ns_department && (
                        <Tag label={part.ns_department} />
                      )}
                    </div>

                    {/* Description (editable by admins; writes back to NetSuite) */}
                    <div style={{ marginTop: '10px' }}>
                      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Description</div>
                      {editingDescription === part.id ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <textarea value={descValue} onChange={e => setDescValue(e.target.value)} autoFocus rows={3}
                            onKeyDown={e => { if (e.key === 'Escape') { setEditingDescription(null); setDescError(null); } }}
                            style={{ ...inputStyle, padding: '6px 8px', width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
                          {descError && <div style={{ fontSize: '10px', color: '#ef4444' }}>{descError}</div>}
                          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                            <button onClick={() => saveDescription(part.id)} disabled={savingDescription}
                              style={{ padding: '6px 10px', borderRadius: '6px', background: '#22c55e', color: '#fff', fontSize: '10px', fontWeight: 700, border: 'none', cursor: savingDescription ? 'default' : 'pointer', opacity: savingDescription ? 0.6 : 1 }}>
                              {savingDescription ? 'Saving…' : 'Save'}</button>
                            <button onClick={() => { setEditingDescription(null); setDescError(null); }} disabled={savingDescription}
                              style={{ padding: '6px 10px', borderRadius: '6px', background: 'var(--subtle-bg)', color: 'var(--text-secondary)', fontSize: '10px', fontWeight: 700, border: '1px solid var(--border)', cursor: 'pointer' }}>Cancel</button>
                            {part.netsuite_id && <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Saves to NetSuite</span>}
                          </div>
                        </div>
                      ) : isAdmin ? (
                        <div onClick={() => { setEditingDescription(part.id); setDescValue(part.description || ''); setDescError(null); }}
                          style={{ fontSize: '11px', color: part.description ? 'var(--text-muted)' : 'var(--text-muted)', lineHeight: 1.5, cursor: 'pointer' }}>
                          {part.description || '— Add description'}
                          <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginLeft: '4px', fontWeight: 700 }}>Edit</span>
                        </div>
                      ) : (
                        part.description && <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{part.description}</div>
                      )}
                    </div>

                    {/* Billable Customer */}
                    {isAdmin && (
                      <div style={{ marginTop: '10px' }}>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Billable Customer</div>
                        {editingCustomer === part.id ? (
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <input value={customerValue} onChange={e => setCustomerValue(e.target.value)} placeholder="e.g. Masterack" autoFocus
                              onKeyDown={e => { if (e.key === 'Enter') updateBillableCustomer(part.id); if (e.key === 'Escape') setEditingCustomer(null); }}
                              style={{ ...inputStyle, padding: '6px 8px', flex: 1 }} />
                            <button onClick={() => updateBillableCustomer(part.id)} style={{ padding: '6px 10px', borderRadius: '6px', background: '#22c55e', color: '#fff', fontSize: '10px', fontWeight: 700, border: 'none', cursor: 'pointer' }}>Save</button>
                          </div>
                        ) : (
                          <div onClick={() => { setEditingCustomer(part.id); setCustomerValue(part.billable_customer || ''); }}
                            style={{ fontSize: '13px', fontWeight: 700, color: part.billable_customer ? '#a78bfa' : 'var(--text-muted)', cursor: 'pointer' }}>
                            {part.billable_customer || '— Set Customer'}
                            <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginLeft: '4px' }}>Edit</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Part Files */}
                    <DropZone onFiles={files => uploadPartFile(part.id, files[0])} accept="image/*,.pdf,.eps,.ai,.svg" multiple={false} disabled={!isAdmin || uploadingFile} style={{ marginTop: '10px' }}>
                      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Files &amp; Proofs</div>
                      {(partFiles[part.id] || []).map(f => (
                        <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px', borderRadius: '6px', background: 'var(--subtle-bg)', marginBottom: '3px' }}>
                          <a href={getFileUrl(f)} target="_blank" rel="noopener noreferrer"
                            style={{ flex: 1, fontSize: '11px', fontWeight: 600, color: '#60a5fa', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.file_name}
                          </a>
                          {isAdmin && (
                            <button onClick={() => deletePartFile(f)} style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: 'rgba(248,113,113,0.1)', color: '#f87171', fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
                          )}
                        </div>
                      ))}
                      {isAdmin && (
                        <>
                          <input ref={partFileRef} type="file" accept="image/*,.pdf,.eps,.ai,.svg" style={{ display: 'none' }}
                            onChange={async (e) => { const f = e.target.files?.[0]; if (f) await uploadPartFile(part.id, f); e.target.value = ''; }} />
                          <button onClick={() => partFileRef.current?.click()} disabled={uploadingFile} style={{
                            width: '100%', padding: '6px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                            background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                            color: uploadingFile ? 'var(--text-muted)' : 'var(--text-secondary)', cursor: 'pointer',
                          }}>{uploadingFile ? 'Uploading...' : '+ Upload Proof / File'}</button>
                          <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                            <button onClick={() => setProofSearch(prev => prev?.partId === part.id && prev.source === 'email' ? null : { partId: part.id, source: 'email' })} style={{
                              flex: 1, padding: '6px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                              background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                              color: proofSearch?.partId === part.id && proofSearch.source === 'email' ? '#ea4335' : 'var(--text-secondary)', cursor: 'pointer',
                            }}>{proofSearch?.partId === part.id && proofSearch.source === 'email' ? '✕ Close Email' : '🔎 Search Email'}</button>
                            <button onClick={() => setProofSearch(prev => prev?.partId === part.id && prev.source === 'dropbox' ? null : { partId: part.id, source: 'dropbox' })} style={{
                              flex: 1, padding: '6px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                              background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                              color: proofSearch?.partId === part.id && proofSearch.source === 'dropbox' ? '#0061fe' : 'var(--text-secondary)', cursor: 'pointer',
                            }}>{proofSearch?.partId === part.id && proofSearch.source === 'dropbox' ? '✕ Close Dropbox' : '🔎 Search Dropbox'}</button>
                          </div>
                          {proofSearch?.partId === part.id && proofSearch.source === 'email' && (
                            <div style={{ marginTop: '6px' }}>
                              <EmailProofSearch
                                defaultQuery={part.billable_customer || part.display_name || part.item_number}
                                autoSearch
                                useLabel="Attach to Part"
                                embedded
                                onUse={(file) => attachEmailProof(part.id, file)}
                              />
                            </div>
                          )}
                          {proofSearch?.partId === part.id && proofSearch.source === 'dropbox' && (
                            <div style={{ marginTop: '6px' }}>
                              <DropboxProofSearch
                                defaultQuery={part.billable_customer || part.display_name || part.item_number}
                                autoSearch
                                useLabel="Attach to Part"
                                embedded
                                onUse={(file) => attachDropboxProof(part.id, file)}
                              />
                            </div>
                          )}
                        </>
                      )}
                    </DropZone>

                    {/* Installed Photos — completion photos from field/CNI scans
                        of this part, searchable here like a proof but showing
                        the real install on a vehicle. */}
                    {(() => {
                      const state = installPhotos[part.id];
                      const photos = Array.isArray(state) ? state : [];
                      return (
                        <div style={{ marginTop: '10px' }}>
                          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
                            Installed Photos{photos.length > 0 ? ` (${photos.length})` : ''}
                          </div>
                          {state === 'loading' ? (
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Loading…</div>
                          ) : photos.length === 0 ? (
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                              No install photos yet — techs can attach completion photos from the Scan page.
                            </div>
                          ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: '5px' }}>
                              {photos.map(ph => (
                                <button key={ph.id} onClick={() => setInstallPhotoView(ph)} title={[ph.vehicle, ph.vin].filter(Boolean).join(' · ')} style={{
                                  padding: 0, border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden',
                                  background: 'var(--subtle-bg)', cursor: 'pointer', aspectRatio: '1',
                                }}>
                                  <img
                                    src={storage.from(ph.bucket).getPublicUrl(ph.storagePath).data.publicUrl}
                                    alt={ph.vehicle || 'Install photo'}
                                    loading="lazy"
                                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                                  />
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Push a local-only part to NetSuite: creates the NetSuite
                        item and links its internal id to this catalog row. */}
                    {isAdmin && !isRealNsPart(part) && (
                      <div style={{
                        marginTop: '12px', padding: '10px', borderRadius: '10px',
                        background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)',
                      }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: '#f59e0b', marginBottom: '8px' }}>
                          This part exists only in FleetSuite — it hasn&apos;t been created in NetSuite yet.
                        </div>
                        <button
                          onClick={() => setNsCreatePart(part)}
                          style={{
                            width: '100%', padding: '10px', borderRadius: '10px',
                            background: 'rgba(34,197,94,0.9)', border: 'none',
                            color: '#fff', fontSize: '12px', fontWeight: 800, cursor: 'pointer',
                          }}
                        >
                          Create in NetSuite
                        </button>
                      </div>
                    )}

                    {/* Re-file into the other catalog (sticks across syncs) */}
                    {isAdmin && (
                      <button
                        onClick={() => movePartCatalog(part)}
                        disabled={movingId === part.id}
                        title="Moves this part to the other catalog tab; the NetSuite sync keeps the manual assignment"
                        style={{
                          width: '100%', marginTop: '12px', padding: '10px', borderRadius: '10px',
                          background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)',
                          color: '#60a5fa', fontSize: '12px', fontWeight: 800,
                          cursor: movingId === part.id ? 'default' : 'pointer',
                          opacity: movingId === part.id ? 0.6 : 1,
                        }}
                      >
                        {movingId === part.id
                          ? 'Moving…'
                          : `⇄  Move to ${part.catalog === 'graphics' ? 'Upfit' : 'Graphics'} Catalog`}
                      </button>
                    )}

                    {/* Delete from FleetSuite (local mirror only; NetSuite untouched) */}
                    {isAdmin && (
                      <button
                        onClick={() => deletePart(part)}
                        disabled={deletingId === part.id}
                        style={{
                          width: '100%', marginTop: '12px', padding: '10px', borderRadius: '10px',
                          background: deletingId === part.id ? 'var(--subtle-bg)' : '#ef4444',
                          border: '1px solid #ef4444',
                          color: '#fff', fontSize: '12px', fontWeight: 800,
                          cursor: deletingId === part.id ? 'default' : 'pointer',
                          opacity: deletingId === part.id ? 0.6 : 1,
                        }}
                      >
                        {deletingId === part.id ? 'Deleting…' : '🗑  Delete from FleetSuite'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Part count */}
      {!loading && filtered.length > 0 && (
        <div style={{ textAlign: 'center', padding: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
          Showing {filtered.length} of {parts.length} {catalog} parts
        </div>
      )}

      {/* Create-in-NetSuite modal for a local-only catalog part */}
      {nsCreatePart && (
        <CreateNetsuiteItemModal
          initialPartNumber={nsCreatePart.item_number}
          initialDisplayName={nsCreatePart.display_name}
          initialDescription={nsCreatePart.description}
          initialPrice={nsCreatePart.sales_price || null}
          billableCustomer={nsCreatePart.billable_customer}
          catalog={nsCreatePart.catalog}
          existingPartId={nsCreatePart.id}
          onCreated={(created, info) => {
            setNsCreatePart(null);
            setSyncMessage(info?.priceWarning
              ? `"${created.item_number}" created in NetSuite, but its price failed to set there — edit the sales price to retry. (${info.priceWarning})`
              : `"${created.item_number}" created in NetSuite and linked to this catalog entry.`);
            setTimeout(() => setSyncMessage(''), 8000);
            loadParts();
          }}
          onClose={() => setNsCreatePart(null)}
        />
      )}

      {/* Install-photo lightbox: the photo full-size with its vehicle context */}
      {installPhotoView && (
        <div onClick={() => setInstallPhotoView(null)} style={{
          position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.9)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '16px',
        }}>
          <button onClick={() => setInstallPhotoView(null)} style={{ position: 'absolute', top: '12px', right: '16px', padding: '8px 14px', borderRadius: '10px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>✕ Close</button>
          <img
            src={storage.from(installPhotoView.bucket).getPublicUrl(installPhotoView.storagePath).data.publicUrl}
            alt={installPhotoView.vehicle || 'Install photo'}
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '100%', maxHeight: '80vh', objectFit: 'contain', borderRadius: '8px' }}
          />
          <div onClick={e => e.stopPropagation()} style={{ marginTop: '10px', textAlign: 'center', color: '#fff', fontSize: '13px', fontWeight: 700 }}>
            {[installPhotoView.vehicle, installPhotoView.vin].filter(Boolean).join(' · ') || 'Install photo'}
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginTop: '2px' }}>
              {[
                installPhotoView.uploadedAt ? new Date(installPhotoView.uploadedAt).toLocaleDateString() : null,
                installPhotoView.uploadedByName ? `by ${installPhotoView.uploadedByName}` : null,
                installPhotoView.source === 'cni_job' ? 'CNI job photo' : 'Scan photo',
              ].filter(Boolean).join(' · ')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailField({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>
        {label}
      </div>
      <div style={{ fontSize: '14px', fontWeight: 700, color }}>
        {value}
      </div>
    </div>
  );
}

// Click-to-edit detail field. Shows the value with an "Edit" hint; clicking
// swaps in an input with Save/cancel. Used for the NetSuite-backed core fields
// (display name, sales/purchase price) so admins can edit them in place.
function InlineEditField({
  label, display, color, isEditing, value, onValueChange, onEdit, onSave, onCancel, saving, error, inputType = 'text', step, placeholder,
}: {
  label: string;
  display: string;
  color: string;
  isEditing: boolean;
  value: string;
  onValueChange: (v: string) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  inputType?: string;
  step?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>
        {label}
      </div>
      {isEditing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            <input
              type={inputType}
              step={step}
              min={inputType === 'number' ? '0' : undefined}
              value={value}
              placeholder={placeholder}
              autoFocus
              onChange={e => onValueChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }}
              style={{
                flex: 1, minWidth: 0, padding: '5px 7px', borderRadius: '6px',
                border: '1px solid var(--border)', background: 'var(--input-bg)',
                color: 'var(--text-primary)', fontSize: '12px',
              }}
            />
            <button onClick={onSave} disabled={saving} style={{ padding: '5px 9px', borderRadius: '6px', background: '#22c55e', color: '#fff', fontSize: '10px', fontWeight: 700, border: 'none', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? '…' : 'Save'}</button>
            <button onClick={onCancel} disabled={saving} style={{ padding: '5px 8px', borderRadius: '6px', background: 'var(--subtle-bg)', color: 'var(--text-secondary)', fontSize: '10px', fontWeight: 700, border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
          </div>
          {error && <div style={{ fontSize: '10px', color: '#ef4444' }}>{error}</div>}
        </div>
      ) : (
        <div onClick={onEdit} style={{ fontSize: '14px', fontWeight: 700, color, cursor: 'pointer' }}>
          {display}
          <span style={{
            fontSize: '10px', fontWeight: 800, color: 'var(--accent)', marginLeft: '6px',
            whiteSpace: 'nowrap', border: '1px solid var(--accent)', borderRadius: '5px',
            padding: '0 5px', opacity: 0.9,
          }}>✎ Edit</span>
        </div>
      )}
    </div>
  );
}

function Tag({ label }: { label: string }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: '4px',
      background: 'var(--subtle-bg)', border: '1px solid var(--border)',
      color: 'var(--text-muted)', fontSize: '9px', fontWeight: 700,
    }}>
      {label}
    </span>
  );
}
