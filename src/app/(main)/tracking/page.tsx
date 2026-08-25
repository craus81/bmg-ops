'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

// Check-In lives at the top of this page now (the old /fleet page
// redirects here). Lazy so the board renders before the wizard loads.
const VehicleCheckIn = lazy(() => import('@/components/VehicleCheckIn'));
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { storage } from '@/lib/storage';
import { fetchAllRows } from '@/lib/fetch-all';
import StatusBadge from '@/components/StatusBadge';
import AssignmentPicker from '@/components/AssignmentPicker';
import VehiclePhotoTimeline from '@/components/VehiclePhotoTimeline';
import { openOrCreateVehicleThread } from '@/lib/customer-thread';
import { decodeVIN, isValidVIN } from '@/lib/vin-decoder';
import { deepLinks } from '@/lib/deep-links';
import type { FleetCheckin, VehicleTrackingStatus, VehicleStatusHistory, VehiclePhoto, GraphicsJob, GraphicsInstallStatus, CheckinSalesOrder } from '@/lib/types';
import { VEHICLE_STATUS_PIPELINE, VEHICLE_STATUS_LABELS, VEHICLE_STATUS_COLORS, GRAPHICS_STATUS_LABELS, GRAPHICS_INSTALL_PIPELINE, GRAPHICS_INSTALL_LABELS, GRAPHICS_INSTALL_COLORS, IN_SHOP_STATUSES } from '@/lib/types';
import NetSuitePdf from '@/components/NetSuitePdf';
import ProofThumbnail from '@/components/ProofThumbnail';
import CompletionModal from '@/components/CompletionModal';
import { useDialog } from '@/components/DialogProvider';
import { DropZone } from '@/components/DropZone';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import { flashNote } from '@/lib/focus-note';
import MentionsInbox from '@/components/MentionsInbox';
import ShopArrivals from '@/components/ShopArrivals';

type FilterStatus = VehicleTrackingStatus | 'all' | 'stuck';

export default function TrackingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin, user, profile, hasFeature } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();

  const [vehicles, setVehicles] = useState<FleetCheckin[]>([]);
  // Check-in panel (merged from the old /fleet page); ?checkin=1 auto-opens.
  const [showCheckIn, setShowCheckIn] = useState(() => searchParams?.get('checkin') === '1');
  // When each vehicle entered its current status (latest transition).
  const [stageSince, setStageSince] = useState<Record<string, string>>({});
  const stageFetchedRef = useRef<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  // Exact count of ACTIVE (non-archived) vehicles from the paged query —
  // drives Load More visibility and its "X of Y" label, so the button can't
  // linger when the whole shop is already on screen. Archived vehicles are
  // excluded from the paging and the count entirely (field ask 2026-08-21:
  // "only vehicles that are at the shop should be on that list") and load
  // separately the first time the Archived view opens.
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [archivedCount, setArchivedCount] = useState<number | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const archivedLoadedRef = useRef(false);
  const PAGE_SIZE = 50;
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Estimates tied to the expanded vehicle: rows whose fleet_checkin_id
  // points here (the estimate builder's Link Checked-In Vehicle button),
  // plus the originating estimate the check-in snapshotted at creation
  // (source_estimate_id — written since migration 080, displayed nowhere
  // until now).
  const [linkedEstimates, setLinkedEstimates] = useState<{ id: string; estimate_number: string; title: string | null; status: string; grand_total: number | null }[]>([]);
  const [statusHistory, setStatusHistory] = useState<VehicleStatusHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (!expandedId) { setLinkedEstimates([]); return; }
    const src = (vehicles.find(x => x.id === expandedId) as any)?.source_estimate_id as string | null | undefined;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('estimates')
        .select('id, estimate_number, title, status, grand_total')
        .or(`fleet_checkin_id.eq.${expandedId}${src ? `,id.eq.${src}` : ''}`)
        .order('created_at', { ascending: false });
      if (!cancelled) setLinkedEstimates(data || []);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [expandedId, vehicles]);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState('');
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [searchTerm, setSearchTerm] = useState('');
  // Deep link: ?q=<term> (universal search "View all" on vehicles) prefills
  // the board search.
  useEffect(() => {
    const q = searchParams?.get('q');
    if (q) setSearchTerm(q);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: read once on mount
  }, []);
  const [updateSuccess, setUpdateSuccess] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  // All NetSuite sales orders linked to each check-in (keyed by checkin id).
  // The first one added is also mirrored into FleetCheckin's legacy columns
  // so other readers — pick list, fleet page, universal search — keep working.
  const [vehicleSalesOrders, setVehicleSalesOrders] = useState<Record<string, CheckinSalesOrder[]>>({});
  // Invoices billed from each linked SO (keyed by the SO's NetSuite id),
  // looked up live when a vehicle record opens. Once an SO has an invoice
  // it's basically dead paper — the record shows the invoice in its place.
  // undefined = not looked up yet; [] = looked up, nothing billed.
  const [soInvoices, setSoInvoices] = useState<Record<string, { id: string; tranid: string }[]>>({});
  const soInvoiceFetchRef = useRef<Set<string>>(new Set());
  const [vehicleAssignments, setVehicleAssignments] = useState<Record<string, string[]>>({});
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  // Per-vehicle generation counter for assignment loads. Bumped by saves so
  // that an in-flight load can detect it's stale and skip overwriting state.
  const assignmentsLoadGen = useRef<Record<string, number>>({});

  // Checklist state
  interface ChecklistTask {
    id: string;
    label: string;
    required: boolean;
    completed: boolean;
    task_key: string | null;
    sort_order: number;
    completed_at: string | null;
    completed_by_name: string | null;
  }
  const [vehicleTasks, setVehicleTasks] = useState<Record<string, ChecklistTask[]>>({});
  const [tasksLoading, setTasksLoading] = useState<Record<string, boolean>>({});

  // Matched graphics job (looked up via fleet_checkins.matched_graphics_job_id)
  const [graphicsJobs, setGraphicsJobs] = useState<Record<string, GraphicsJob | null>>({});

  // Message Customer in-flight flag (per-vehicle so two clicks on different rows don't fight)
  const [messagingVehicleId, setMessagingVehicleId] = useState<string | null>(null);

  // Photos state
  const [vehiclePhotos, setVehiclePhotos] = useState<Record<string, (VehiclePhoto & { url?: string })[]>>({});
  const [photosLoading, setPhotosLoading] = useState<Record<string, boolean>>({});
  const [photoUploading, setPhotoUploading] = useState(false);
  const [showCompletionPrompt, setShowCompletionPrompt] = useState<string | null>(null); // vehicleId
  // What the next uploaded photos are stamped as. Defaults to completion
  // (the historical behavior, and what the completion gate counts) — the
  // picker lets staff add Before/During shots to a vehicle that's already
  // in the shop, landing them in the photo timeline's matching section.
  const [photoType, setPhotoType] = useState<'before' | 'during' | 'completion'>('completion');
  // Notes edit on the record modal (same pattern as the VIN editor).
  const [notesEdits, setNotesEdits] = useState<Record<string, string>>({});
  const [notesSaving, setNotesSaving] = useState<string | null>(null);
  const [completionModalVehicleId, setCompletionModalVehicleId] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Notes state
  interface VehicleNote {
    id: string;
    vehicle_id: string;
    note: string;
    created_by: string;
    created_by_name: string;
    created_at: string;
  }
  const [vehicleNotes, setVehicleNotes] = useState<Record<string, VehicleNote[]>>({});
  const [notesLoading, setNotesLoading] = useState<Record<string, boolean>>({});
  const [noteInput, setNoteInput] = useState<Record<string, string>>({});
  const [noteSaving, setNoteSaving] = useState(false);

  // Sales order linking state
  const [soSearchOpen, setSoSearchOpen] = useState<string | null>(null); // vehicleId
  const [soSearchTerm, setSoSearchTerm] = useState('');
  const [soSearchResults, setSoSearchResults] = useState<any[]>([]);
  const [soSearchHasMore, setSoSearchHasMore] = useState(false);
  const [soSearching, setSoSearching] = useState(false);
  const [soLinking, setSoLinking] = useState(false);

  // Dropbox proof search state
  const [dbxSearchOpen, setDbxSearchOpen] = useState<string | null>(null); // vehicleId
  const [dbxSearchTerm, setDbxSearchTerm] = useState('');
  const [dbxResults, setDbxResults] = useState<{ id: string; name: string; path: string; size: number; modified: string; folder: string }[]>([]);
  const [dbxSearching, setDbxSearching] = useState(false);
  const [dbxCopying, setDbxCopying] = useState(false);
  const [dbxConnected, setDbxConnected] = useState<boolean | null>(null); // null = unknown

  // VIN editing — for fixing a wrong/mis-scanned VIN. Keyed by vehicle id;
  // when a vehicle id is in the map, that row is in edit mode with the
  // current draft value.
  const [vinEdits, setVinEdits] = useState<Record<string, string>>({});
  const [vinSaving, setVinSaving] = useState<string | null>(null);
  const [vinError, setVinError] = useState<Record<string, string>>({});
  // Customer attach/edit on a checked-in vehicle — field request: trucks get
  // checked in without a customer and need one attached afterwards. Same
  // type-ahead over the synced NetSuite customer list as the check-in wizard.
  const [custEditFor, setCustEditFor] = useState<string | null>(null);
  const [custEditSearch, setCustEditSearch] = useState('');
  const [custEditMatches, setCustEditMatches] = useState<{ id: string; company_name: string; entity_id: string | null }[]>([]);
  const [custEditSaving, setCustEditSaving] = useState(false);

  // Debounced customer type-ahead for the attach/edit control (same query
  // shape as the check-in wizard's manual picker).
  useEffect(() => {
    const q = custEditSearch.trim();
    if (!custEditFor || q.length < 2) { setCustEditMatches([]); return; }
    const t = setTimeout(async () => {
      const escaped = q.replace(/[%,()]/g, ' ');
      const { data } = await supabase
        .from('customers')
        .select('id, company_name, entity_id')
        .or(`company_name.ilike.%${escaped}%,entity_id.ilike.%${escaped}%`)
        .order('company_name')
        .limit(8);
      setCustEditMatches((data || []) as typeof custEditMatches);
    }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [custEditSearch, custEditFor]);

  const attachCustomer = async (vehicleId: string, cust: { id: string; company_name: string; entity_id: string | null }) => {
    setCustEditSaving(true);
    const name = cust.company_name || cust.entity_id || '';
    const { error } = await supabase.from('fleet_checkins').update({
      customer_id: cust.id,
      customer_name: name,
      updated_at: new Date().toISOString(),
    } as any).eq('id', vehicleId);
    setCustEditSaving(false);
    if (error) {
      await dialog.alert('Failed to attach customer: ' + error.message);
      return;
    }
    setVehicles(prev => prev.map(v =>
      v.id === vehicleId ? { ...v, customer_id: cust.id, customer_name: name } as any : v
    ));
    setCustEditFor(null);
    setCustEditSearch('');
    setCustEditMatches([]);
    setUpdateSuccess('Customer attached');
    setTimeout(() => setUpdateSuccess(null), 2000);
  };

  // Notes edit on the record modal — same shape as the VIN editor.
  const saveNotesEdit = async (id: string) => {
    const draft = (notesEdits[id] ?? '').trim();
    setNotesSaving(id);
    const { error } = await supabase
      .from('fleet_checkins')
      .update({ notes: draft || null, updated_at: new Date().toISOString() })
      .eq('id', id);
    setNotesSaving(null);
    if (error) {
      await dialog.alert('Failed to save notes: ' + error.message);
      return;
    }
    setVehicles(prev => prev.map(v => v.id === id ? { ...v, notes: draft || null } as any : v));
    setNotesEdits(prev => { const next = { ...prev }; delete next[id]; return next; });
    setUpdateSuccess('Notes saved');
    setTimeout(() => setUpdateSuccess(null), 2000);
  };

  const startVinEdit = (id: string, currentVin: string) => {
    setVinEdits(prev => ({ ...prev, [id]: currentVin || '' }));
    setVinError(prev => ({ ...prev, [id]: '' }));
  };
  const cancelVinEdit = (id: string) => {
    setVinEdits(prev => { const next = { ...prev }; delete next[id]; return next; });
    setVinError(prev => { const next = { ...prev }; delete next[id]; return next; });
  };
  const saveVinEdit = async (id: string) => {
    const draft = (vinEdits[id] || '').trim().toUpperCase();
    if (!isValidVIN(draft)) {
      setVinError(prev => ({ ...prev, [id]: 'VIN must be 17 characters and cannot contain I, O, or Q' }));
      return;
    }
    setVinSaving(id);
    // Re-decode so the vehicle year/make/model/trim/body_class follow the
    // corrected VIN. Falls back to whatever decodeVIN returns (offline map
    // when NHTSA is unreachable); we only overwrite fields the decoder
    // actually populated so we don't blow away good data with blanks.
    let decoded: Awaited<ReturnType<typeof decodeVIN>> | null = null;
    try { decoded = await decodeVIN(draft); } catch { decoded = null; }

    const update: Record<string, any> = { vin: draft, updated_at: new Date().toISOString() };
    if (decoded?.year) update.vehicle_year = decoded.year;
    if (decoded?.make) update.vehicle_make = decoded.make;
    if (decoded?.model) update.vehicle_model = decoded.model;
    if (decoded?.trim) update.vehicle_trim = decoded.trim;
    if (decoded?.bodyClass) update.body_class = decoded.bodyClass;

    const { error } = await supabase
      .from('fleet_checkins')
      .update(update)
      .eq('id', id);
    setVinSaving(null);
    if (error) {
      setVinError(prev => ({ ...prev, [id]: error.message || 'Failed to save VIN' }));
      return;
    }
    setVehicles(prev => prev.map(v => v.id === id ? { ...v, ...update } as any : v));
    cancelVinEdit(id);
  };

  useEffect(() => {
    loadVehicles();
    loadArchivedCount();
    loadProfiles();

    // Handle Dropbox OAuth redirect
    const dbxParam = searchParams.get('dropbox');
    if (dbxParam === 'connected') {
      setDbxConnected(true);
      setUpdateSuccess('Dropbox connected successfully');
      setTimeout(() => setUpdateSuccess(null), 3000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, []);

  // First open of the Archived view (toggle click or archived deep link)
  // pulls the archived rows in.
  useEffect(() => {
    if (showArchived) loadArchived();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadArchived is recreated per render
  }, [showArchived]);

  // Deep link from check-in page/search: switch to whichever tab actually
  // shows the vehicle (shipped and archived hide from "All"), expand it,
  // and scroll it into view.
  useEffect(() => {
    if (loading) return;
    const vehicleId = searchParams.get('vehicle');
    if (!vehicleId) return;
    const focus = (target: FleetCheckin) => {
      setShowArchived(!!(target as any).archived_at);
      setFilterStatus(target.status === 'shipped' ? 'shipped' : 'all');
      setSearchTerm('');
      setExpandedId(vehicleId);
      loadHistory(vehicleId);
      loadAssignments(vehicleId);
      loadPhotos(vehicleId);
      loadNotes(vehicleId);
      // A mention deep link (&note=<id>) scroll-flashes that note inside the
      // detail modal once it loads; otherwise center the vehicle card.
      const noteId = searchParams.get('note');
      if (noteId) {
        flashNote(`vnote-${noteId}`);
      } else {
        setTimeout(() => {
          document.getElementById(`vehicle-${vehicleId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 200);
      }
    };
    const target = vehicles.find(v => v.id === vehicleId);
    if (target) { focus(target); return; }
    // The list pages 50 rows at a time by recency, so an older vehicle's
    // deep link can miss the loaded window — fetch it by id and prepend
    // instead of silently doing nothing.
    (async () => {
      const { data } = await supabase.from('fleet_checkins').select('*').eq('id', vehicleId).maybeSingle();
      if (!data) return;
      setVehicles(prev => prev.some(v => v.id === data.id) ? prev : [data as FleetCheckin, ...prev]);
      focus(data as FleetCheckin);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [loading, searchParams]);

  // When a vehicle record opens, look up invoices billed from its linked
  // SOs (live from NetSuite — covers invoices created there directly and
  // ones FleetSuite raised, with no sync lag). One lookup per SO id.
  useEffect(() => {
    if (!expandedId) return;
    const linked = vehicleSalesOrders[expandedId] || [];
    for (const so of linked) {
      const soId = so.netsuite_sales_order_id;
      if (!soId || soInvoiceFetchRef.current.has(soId)) continue;
      soInvoiceFetchRef.current.add(soId);
      fetch(`/api/netsuite/so-invoices?soId=${encodeURIComponent(soId)}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data && Array.isArray(data.invoices)) {
            setSoInvoices(prev => ({ ...prev, [soId]: data.invoices }));
          } else {
            // Lookup failed — allow a retry the next time a record opens.
            soInvoiceFetchRef.current.delete(soId);
          }
        })
        .catch(() => { soInvoiceFetchRef.current.delete(soId); });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed lookups; ref dedupes
  }, [expandedId, vehicleSalesOrders]);

  // Lock body scroll and bind Escape while a vehicle detail modal is open
  useEffect(() => {
    if (!expandedId) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpandedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [expandedId]);

  // Stage-entry times for loaded vehicles (latest status transition each).
  useEffect(() => {
    const missing = vehicles.map(v => v.id).filter(id => !stageFetchedRef.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) stageFetchedRef.current.add(id);
    (async () => {
      const since: Record<string, string> = {};
      for (let i = 0; i < missing.length; i += 200) {
        // Paginated: .limit(3000) was still capped at 1000 by PostgREST, so
        // busy boards silently fell back to created_at for "days in stage".
        const chunk = missing.slice(i, i + 200);
        const { data } = await fetchAllRows<{ vehicle_id: string; created_at: string }>((from, to) => supabase
          .from('vehicle_status_history')
          .select('vehicle_id, created_at')
          .in('vehicle_id', chunk)
          .order('created_at', { ascending: false })
          .order('id')
          .range(from, to));
        for (const h of data || []) {
          if (!since[h.vehicle_id]) since[h.vehicle_id] = h.created_at;
        }
      }
      setStageSince(prev => ({ ...prev, ...since }));
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [vehicles]);

  // Offset for Load More comes from how many rows we actually FETCHED, not
  // vehicles.length — the ?vehicle= deep-link fallback can prepend a row
  // outside the paged window, and counting it would skip a DB row on the
  // next page. Appends also dedupe by id for when that row pages back in.
  const fetchedCountRef = useRef(0);
  const loadVehicles = async (append = false) => {
    if (append) setLoadingMore(true); else setLoading(true);
    const offset = append ? fetchedCountRef.current : 0;
    const { data, count } = await supabase
      .from('fleet_checkins')
      .select('*', { count: 'exact' })
      .is('archived_at', null)
      .order('updated_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (data) {
      fetchedCountRef.current = offset + data.length;
      if (append) {
        setVehicles(prev => [...prev, ...data.filter((d: FleetCheckin) => !prev.some(p => p.id === d.id))]);
      } else {
        // Full reload: replace the active window but keep any archived rows
        // already loaded for the Archived view (they page separately).
        setVehicles(prev => [
          ...data,
          ...prev.filter(v => (v as any).archived_at && !data.some((d: FleetCheckin) => d.id === v.id)),
        ]);
      }
      // The exact count says whether anything is actually left — the old
      // full-page heuristic (data.length === PAGE_SIZE) left a dead Load
      // More button whenever the table size was a multiple of the page, or
      // after a delete shrank a full page (the "49 loaded" button).
      if (typeof count === 'number') {
        setTotalCount(count);
        setHasMore(offset + data.length < count);
      } else {
        setHasMore(data.length === PAGE_SIZE);
      }
      loadCheckinSalesOrders(data.map((v: FleetCheckin) => v.id));
    }
    if (append) setLoadingMore(false); else setLoading(false);
  };

  // Archived vehicles load on demand (first open of the Archived view) —
  // they're out of the main paging so the shop list and its count stay
  // shop-only. The toggle's badge comes from a cheap head-count on mount.
  const loadArchivedCount = async () => {
    const { count } = await supabase
      .from('fleet_checkins')
      .select('id', { count: 'exact', head: true })
      .not('archived_at', 'is', null);
    if (typeof count === 'number') setArchivedCount(count);
  };

  const loadArchived = async () => {
    if (archivedLoadedRef.current || archivedLoading) return;
    setArchivedLoading(true);
    const { data } = await fetchAllRows<FleetCheckin>((from, to) => supabase
      .from('fleet_checkins')
      .select('*')
      .not('archived_at', 'is', null)
      .order('updated_at', { ascending: false })
      .order('id')
      .range(from, to));
    if (data) {
      archivedLoadedRef.current = true;
      setVehicles(prev => [...prev, ...data.filter(d => !prev.some(p => p.id === d.id))]);
      setArchivedCount(data.length);
      loadCheckinSalesOrders(data.map(v => v.id));
    }
    setArchivedLoading(false);
  };

  const loadCheckinSalesOrders = async (checkinIds: string[]) => {
    if (checkinIds.length === 0) return;
    const { data } = await supabase
      .from('fleet_checkin_sales_orders')
      .select('*')
      .in('checkin_id', checkinIds)
      .order('added_at', { ascending: true });
    if (!data) return;
    const grouped: Record<string, CheckinSalesOrder[]> = {};
    for (const row of data as CheckinSalesOrder[]) {
      (grouped[row.checkin_id] ||= []).push(row);
    }
    setVehicleSalesOrders(prev => ({ ...prev, ...grouped }));
  };

  const loadProfiles = async () => {
    const { data } = await supabase.from('profiles').select('id, full_name');
    if (data) {
      const map: Record<string, string> = {};
      data.forEach((p: any) => { map[p.id] = p.full_name; });
      setProfiles(map);
    }
  };

  const loadHistory = async (vehicleId: string) => {
    setHistoryLoading(true);
    const { data } = await supabase
      .from('vehicle_status_history')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('created_at', { ascending: false });
    setStatusHistory(data || []);
    setHistoryLoading(false);
  };

  const loadAssignments = async (vehicleId: string) => {
    // Bump generation so a concurrent save can invalidate this load. Without
    // this guard, a load fired on expand can resolve AFTER the user clicks an
    // installer and clobber the optimistic state with stale DB data.
    const gen = (assignmentsLoadGen.current[vehicleId] || 0) + 1;
    assignmentsLoadGen.current[vehicleId] = gen;
    const { data } = await supabase
      .from('job_assignments')
      .select('user_id')
      .eq('job_type', 'scanned_vehicle')
      .eq('job_id', vehicleId);
    if (assignmentsLoadGen.current[vehicleId] !== gen) return;
    if (data) {
      setVehicleAssignments(prev => ({
        ...prev,
        [vehicleId]: data.map((a: any) => a.user_id),
      }));
    }
  };

  const loadTasks = async (vehicleId: string) => {
    setTasksLoading(prev => ({ ...prev, [vehicleId]: true }));
    const { data } = await supabase
      .from('job_tasks')
      .select('id, label, required, completed, task_key, sort_order, completed_at, completed_by_name')
      .eq('job_type', 'fleet_checkin')
      .eq('job_id', vehicleId)
      .order('sort_order');
    setVehicleTasks(prev => ({ ...prev, [vehicleId]: (data || []) as ChecklistTask[] }));
    setTasksLoading(prev => ({ ...prev, [vehicleId]: false }));
  };

  const loadGraphicsJob = async (vehicle: FleetCheckin) => {
    const gjId = (vehicle as any).matched_graphics_job_id;
    if (!gjId) {
      setGraphicsJobs(prev => ({ ...prev, [vehicle.id]: null }));
      return;
    }
    const { data } = await supabase
      .from('graphics_jobs')
      .select('*')
      .eq('id', gjId)
      .maybeSingle();
    setGraphicsJobs(prev => ({ ...prev, [vehicle.id]: (data as GraphicsJob | null) || null }));
  };

  const messageCustomer = async (vehicle: FleetCheckin) => {
    if (messagingVehicleId === vehicle.id) return;
    setMessagingVehicleId(vehicle.id);
    const result = await openOrCreateVehicleThread(supabase, vehicle, user?.id);
    if ('threadId' in result) {
      router.push(`/admin/inbox?thread=${result.threadId}`);
    } else {
      await dialog.alert('Failed to open thread: ' + result.error);
    }
    setMessagingVehicleId(null);
  };

  const loadPhotos = async (vehicleId: string) => {
    setPhotosLoading(prev => ({ ...prev, [vehicleId]: true }));
    const { data } = await supabase
      .from('vehicle_photos')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('taken_at', { ascending: false });

    if (data) {
      const photosWithUrls = data.map((p: VehiclePhoto) => ({
        ...p,
        url: storage.from('photos').getPublicUrl(p.storage_path).data.publicUrl,
      }));
      setVehiclePhotos(prev => ({ ...prev, [vehicleId]: photosWithUrls }));
    }
    setPhotosLoading(prev => ({ ...prev, [vehicleId]: false }));
  };

  const uploadPhoto = async (vehicleId: string, file: File) => {
    setPhotoUploading(true);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `${vehicleId}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await storage.from('photos').upload(path, file, { contentType: file.type });
      if (uploadErr) {
        console.error('Photo upload error:', uploadErr.message);
        await dialog.alert('Photo upload failed: ' + uploadErr.message);
        setPhotoUploading(false);
        return;
      }

      const { error: dbErr } = await supabase.from('vehicle_photos').insert({
        vehicle_id: vehicleId,
        storage_path: path,
        photo_type: photoType,
        taken_by: user?.id,
      });

      if (dbErr) {
        console.error('Photo DB insert error:', dbErr.message);
        await dialog.alert('Photo upload failed: ' + dbErr.message);
        setPhotoUploading(false);
        return;
      }

      await loadPhotos(vehicleId);
    } catch (err: any) {
      console.error('Photo upload error:', err);
      await dialog.alert('Photo upload failed');
    }
    setPhotoUploading(false);
  };

  const handlePhotoFiles = async (vehicleId: string, files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
      await uploadPhoto(vehicleId, files[i]);
    }
  };

  const deletePhoto = async (vehicleId: string, photoId: string, storagePath: string) => {
    if (!(await dialog.confirm('Delete this photo?', { destructive: true, confirmLabel: 'Delete' }))) return;
    await storage.from('photos').remove([storagePath]);
    await supabase.from('vehicle_photos').delete().eq('id', photoId);
    await loadPhotos(vehicleId);
  };

  const loadNotes = async (vehicleId: string) => {
    setNotesLoading(prev => ({ ...prev, [vehicleId]: true }));
    const { data } = await supabase
      .from('vehicle_notes')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('created_at', { ascending: false });
    if (data) setVehicleNotes(prev => ({ ...prev, [vehicleId]: data }));
    setNotesLoading(prev => ({ ...prev, [vehicleId]: false }));
  };

  const addNote = async (vehicleId: string) => {
    const text = (noteInput[vehicleId] || '').trim();
    if (!text) return;
    setNoteSaving(true);
    try {
      const { data: inserted } = await supabase.from('vehicle_notes').insert({
        vehicle_id: vehicleId,
        note: text,
        created_by: user?.id,
        created_by_name: profile?.full_name || 'Unknown',
      }).select('id').single();
      setNoteInput(prev => ({ ...prev, [vehicleId]: '' }));
      await loadNotes(vehicleId);
      const v = vehicles.find(x => x.id === vehicleId);
      // Carry the note id so a mention deep link can scroll straight to it.
      reportMentions({
        text,
        sourceType: 'vehicle_note',
        sourceId: vehicleId,
        contextLabel: v ? `${vehicleTitle(v)} — ${v.customer_name || 'vehicle'}` : 'In-Shop vehicle',
        contextUrl: `/tracking?vehicle=${vehicleId}${inserted?.id ? `&note=${inserted.id}` : ''}`,
      });
    } catch (err) {
      console.error('Note save error:', err);
    }
    setNoteSaving(false);
  };

  const deleteNote = async (vehicleId: string, noteId: string) => {
    if (!(await dialog.confirm('Delete this note?', { destructive: true, confirmLabel: 'Delete' }))) return;
    await supabase.from('vehicle_notes').delete().eq('id', noteId);
    await loadNotes(vehicleId);
  };

  // Sales order search & link — paged 20 at a time (the API's default);
  // `append` powers the "load more" affordance for big customers.
  const searchSalesOrders = async (append = false) => {
    if (!soSearchTerm.trim()) return;
    setSoSearching(true);
    if (!append) setSoSearchResults([]);
    try {
      const offset = append ? soSearchResults.length : 0;
      const res = await fetch(`/api/netsuite/sales-orders?customer=${encodeURIComponent(soSearchTerm.trim())}&limit=20&offset=${offset}`);
      const data = await res.json();
      if (data.found && data.data) {
        setSoSearchResults(prev => {
          const base = append ? prev : [];
          const seen = new Set(base.map((o: any) => o.id));
          return [...base, ...data.data.filter((o: any) => !seen.has(o.id))];
        });
        setSoSearchHasMore(!!data.hasMore);
      } else if (!append) {
        setSoSearchHasMore(false);
      }
    } catch (err) {
      console.error('SO search error:', err);
    }
    setSoSearching(false);
  };

  const linkSalesOrder = async (vehicleId: string, order: any) => {
    setSoLinking(true);
    try {
      const existing = vehicleSalesOrders[vehicleId] || [];
      if (existing.some(s => s.netsuite_sales_order_id === order.id)) {
        setUpdateSuccess('Sales order already linked');
        setTimeout(() => setUpdateSuccess(null), 2000);
        setSoSearchOpen(null);
        setSoSearchTerm('');
        setSoSearchResults([]);
        setSoLinking(false);
        return;
      }

      // Always record the link in the join table so the full list of
      // SOs on this check-in is preserved.
      const { data: inserted, error: insertError } = await supabase
        .from('fleet_checkin_sales_orders')
        .insert({
          checkin_id: vehicleId,
          netsuite_sales_order_id: order.id,
          sales_order_number: order.sales_order_number,
          customer_name: order.customer_name,
          sales_order_memo: order.memo || null,
          sales_order_total: order.total || null,
          added_by: user?.id || null,
        })
        .select()
        .single();

      if (insertError) {
        // 23505 = unique_violation. Happens when the join table already
        // contains this (checkin, SO) pair — usually because the legacy
        // primary was backfilled in migration 093 and our in-memory
        // vehicleSalesOrders cache hadn't caught up yet. Reconcile from
        // the server instead of treating it as a hard failure.
        if ((insertError as any).code === '23505') {
          await loadCheckinSalesOrders([vehicleId]);
          setSoSearchOpen(null);
          setSoSearchTerm('');
          setSoSearchResults([]);
          setUpdateSuccess('Sales order already linked');
          setTimeout(() => setUpdateSuccess(null), 2000);
          setSoLinking(false);
          return;
        }
        await dialog.alert('Failed to link sales order: ' + insertError.message);
        setSoLinking(false);
        return;
      }

      // Mirror to the legacy single-SO columns only when this is the
      // first SO — otherwise the existing readers (pick list, search)
      // would jump to whichever SO was linked last.
      const isPrimary = existing.length === 0;
      if (isPrimary) {
        await supabase.from('fleet_checkins').update({
          netsuite_sales_order_id: order.id,
          sales_order_number: order.sales_order_number,
          customer_name: order.customer_name,
          sales_order_memo: order.memo || null,
          sales_order_total: order.total || null,
        }).eq('id', vehicleId);
      }

      setVehicleSalesOrders(prev => ({
        ...prev,
        [vehicleId]: [...(prev[vehicleId] || []), inserted as CheckinSalesOrder],
      }));
      if (isPrimary) {
        setVehicles(prev => prev.map(v =>
          v.id === vehicleId ? {
            ...v,
            netsuite_sales_order_id: order.id,
            sales_order_number: order.sales_order_number,
            customer_name: order.customer_name,
            sales_order_memo: order.memo || null,
            sales_order_total: order.total || null,
          } : v
        ));
      }
      setSoSearchOpen(null);
      setSoSearchTerm('');
      setSoSearchResults([]);
      setUpdateSuccess('Sales order linked');
      setTimeout(() => setUpdateSuccess(null), 2000);
    } catch (err) {
      console.error('Link SO error:', err);
      await dialog.alert('Failed to link sales order');
    }
    setSoLinking(false);
  };

  const unlinkSalesOrder = async (vehicleId: string, soRowId: string) => {
    const list = vehicleSalesOrders[vehicleId] || [];
    const target = list.find(s => s.id === soRowId);
    if (!target) return;
    if (!(await dialog.confirm(`Remove SO #${target.sales_order_number || target.netsuite_sales_order_id} from this vehicle?`, { destructive: true, confirmLabel: 'Remove' }))) return;

    const { error } = await supabase
      .from('fleet_checkin_sales_orders')
      .delete()
      .eq('id', soRowId);
    if (error) {
      await dialog.alert('Failed to unlink sales order: ' + error.message);
      return;
    }

    const remaining = list.filter(s => s.id !== soRowId);
    setVehicleSalesOrders(prev => ({ ...prev, [vehicleId]: remaining }));

    // If we removed the SO mirrored into the legacy columns, promote the
    // next oldest (or clear) so single-SO readers stay accurate.
    const vehicle = vehicles.find(v => v.id === vehicleId);
    if (vehicle?.netsuite_sales_order_id === target.netsuite_sales_order_id) {
      const promote = remaining[0];
      const legacy = promote ? {
        netsuite_sales_order_id: promote.netsuite_sales_order_id,
        sales_order_number: promote.sales_order_number,
        customer_name: promote.customer_name,
        sales_order_memo: promote.sales_order_memo,
        sales_order_total: promote.sales_order_total,
      } : {
        netsuite_sales_order_id: null,
        sales_order_number: null,
        sales_order_memo: null,
        sales_order_total: null,
      };
      await supabase.from('fleet_checkins').update(legacy).eq('id', vehicleId);
      setVehicles(prev => prev.map(v =>
        v.id === vehicleId ? { ...v, ...legacy } as any : v
      ));
    }
    setUpdateSuccess('Sales order unlinked');
    setTimeout(() => setUpdateSuccess(null), 2000);
  };

  // ── Dropbox Proof Search ──
  const searchDropboxProofs = async (customerName?: string) => {
    const term = customerName || dbxSearchTerm.trim();
    if (!term) return;
    setDbxSearching(true);
    setDbxResults([]);
    try {
      const res = await fetch(`/api/dropbox/search?q=${encodeURIComponent(term)}`);
      const data = await res.json();
      if (data.connected === false) {
        setDbxConnected(false);
        setDbxSearching(false);
        return;
      }
      setDbxConnected(true);
      setDbxResults(data.results || []);
    } catch { /* ignore */ }
    setDbxSearching(false);
  };

  const uploadProofForVehicle = async (vehicleId: string, file: File) => {
    try {
      const ext = file.name.split('.').pop() || 'bin';
      const path = `manual-uploads/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const { error: upErr } = await storage.from('graphics-proofs').upload(path, file, { contentType: file.type });
      if (upErr) {
        await dialog.alert('Upload failed: ' + (upErr.message || 'unknown'));
        return;
      }
      const { data: urlData } = storage.from('graphics-proofs').getPublicUrl(path);
      const publicUrl = urlData?.publicUrl || null;
      const { error: dbErr } = await supabase.from('fleet_checkins').update({
        proof_url: publicUrl,
        proof_filename: file.name,
        proof_dropbox_path: null,
      } as any).eq('id', vehicleId);
      if (dbErr) {
        await dialog.alert('Saved the file but failed to attach it: ' + dbErr.message);
        return;
      }
      setVehicles(prev => prev.map(v =>
        v.id === vehicleId
          ? { ...v, proof_url: publicUrl, proof_filename: file.name, proof_dropbox_path: null } as any
          : v
      ));
      setUpdateSuccess('Proof uploaded');
      setTimeout(() => setUpdateSuccess(null), 2000);
    } catch (err: any) {
      await dialog.alert('Upload failed: ' + (err?.message || String(err)));
    }
  };

  const removeProofForVehicle = async (vehicleId: string) => {
    if (!(await dialog.confirm('Remove the proof file from this vehicle?', { destructive: true, confirmLabel: 'Remove' }))) return;
    const { error } = await supabase.from('fleet_checkins').update({
      proof_url: null,
      proof_filename: null,
      proof_dropbox_path: null,
    } as any).eq('id', vehicleId);
    if (error) {
      await dialog.alert('Failed to remove proof: ' + error.message);
      return;
    }
    setVehicles(prev => prev.map(v =>
      v.id === vehicleId
        ? { ...v, proof_url: null, proof_filename: null, proof_dropbox_path: null } as any
        : v
    ));
    setUpdateSuccess('Proof removed');
    setTimeout(() => setUpdateSuccess(null), 2000);
  };

  const copyProofToR2 = async (vehicleId: string, dropboxPath: string, customerName: string) => {
    setDbxCopying(true);
    try {
      const res = await fetch('/api/dropbox/copy-to-r2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dropbox_path: dropboxPath, vehicle_id: vehicleId, customer_name: customerName }),
      });
      const data = await res.json();
      if (data.success) {
        // Update local state
        setVehicles(prev => prev.map(v =>
          v.id === vehicleId ? { ...v, proof_url: data.publicUrl, proof_filename: data.filename, proof_dropbox_path: dropboxPath } as any : v
        ));
        setDbxSearchOpen(null);
        setDbxSearchTerm('');
        setDbxResults([]);
        setUpdateSuccess('Proof linked from Dropbox');
        setTimeout(() => setUpdateSuccess(null), 3000);
      } else {
        await dialog.alert(`Failed to copy proof: ${data.error}`);
      }
    } catch (err: any) {
      await dialog.alert(`Error: ${err.message}`);
    }
    setDbxCopying(false);
  };

  const connectDropbox = async () => {
    try {
      const res = await fetch('/api/dropbox/auth?action=url');
      const data = await res.json();
      if (data.authUrl) {
        window.location.href = data.authUrl;
      } else {
        await dialog.alert('Dropbox not configured. Add DROPBOX_APP_KEY and DROPBOX_APP_SECRET to environment variables.');
      }
    } catch {
      await dialog.alert('Failed to start Dropbox connection');
    }
  };

  const saveAssignments = async (vehicleId: string, userIds: string[]) => {
    // Invalidate any in-flight load so it can't overwrite this save.
    assignmentsLoadGen.current[vehicleId] = (assignmentsLoadGen.current[vehicleId] || 0) + 1;
    setVehicleAssignments(prev => ({ ...prev, [vehicleId]: userIds }));
    setAssignmentSaving(true);
    try {
      await fetch('/api/jobs/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobType: 'scanned_vehicle',
          jobId: vehicleId,
          userIds,
          assignedBy: user?.id,
          notifyUsers: true,
          jobTitle: vehicles.find(v => v.id === vehicleId)
            ? [vehicles.find(v => v.id === vehicleId)!.vehicle_year, vehicles.find(v => v.id === vehicleId)!.vehicle_make, vehicles.find(v => v.id === vehicleId)!.vehicle_model].filter(Boolean).join(' ')
            : undefined,
        }),
      });
    } catch (err) {
      console.error('Assignment save error:', err);
    }
    setAssignmentSaving(false);
  };

  const toggleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setStatusHistory([]);
      setStatusNote('');
    } else {
      setExpandedId(id);
      setStatusNote('');
      loadHistory(id);
      loadAssignments(id);
      loadPhotos(id);
      loadNotes(id);
      loadTasks(id);
      const v = vehicles.find(x => x.id === id);
      if (v) loadGraphicsJob(v);
    }
  };

  const updateStatus = useCallback(async (vehicleId: string, newStatus: VehicleTrackingStatus, opts: { force?: boolean } = {}) => {
    setUpdatingId(vehicleId);
    setUpdateSuccess(null);
    try {
      const res = await fetch('/api/vehicle-tracking/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId,
          newStatus,
          note: statusNote.trim() || null,
          force: opts.force,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 422 && Array.isArray(data.missing)) {
        // Completion requirements missing — surface the list and offer
        // admin override.
        const lines = data.missing.join('\n• ');
        const isAdmin = profile?.role === 'admin';
        let proceed = false;
        if (isAdmin) {
          proceed = await dialog.confirm(`Cannot mark complete yet:\n\n• ${lines}\n\nOverride and mark complete anyway?`);
        } else {
          await dialog.alert(`Cannot mark complete yet:\n\n• ${lines}\n\nFinish the checklist and upload a completion photo, then try again.`);
        }
        if (proceed) {
          await updateStatus(vehicleId, newStatus, { force: true });
        }
        setUpdatingId(null);
        return;
      }

      if (!res.ok) {
        await dialog.alert('Update failed: ' + (data.error || 'Unknown error'));
        setUpdatingId(null);
        return;
      }

      setStatusNote('');
      setUpdateSuccess(`Updated to ${VEHICLE_STATUS_LABELS[newStatus]}`);
      setTimeout(() => setUpdateSuccess(null), 2000);
      await loadVehicles();
      if (expandedId === vehicleId) {
        loadHistory(vehicleId);
        loadTasks(vehicleId);
      }

      // Prompt for completion photos when marking as complete
      if (newStatus === 'complete') {
        setShowCompletionPrompt(vehicleId);
        loadPhotos(vehicleId);
      }
    } catch (err) {
      await dialog.alert('Network error — please try again');
    }
    setUpdatingId(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [statusNote, expandedId, profile]);

  // Graphics install lane (migration 085) — runs in parallel to the upfit
  // pipeline driven by updateStatus above. Independent state machine, but
  // the completion ceremony in update-status gates on this being 'complete'
  // or 'n/a' when a graphics job is linked.
  const updateGraphicsInstall = useCallback(async (vehicleId: string, newStatus: GraphicsInstallStatus) => {
    setUpdatingId(vehicleId);
    setUpdateSuccess(null);
    try {
      const res = await fetch('/api/vehicle-tracking/graphics-install-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId,
          newStatus,
          note: statusNote.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        await dialog.alert('Graphics install update failed: ' + (data.error || 'Unknown error'));
        setUpdatingId(null);
        return;
      }
      setStatusNote('');
      setUpdateSuccess(`Graphics: ${GRAPHICS_INSTALL_LABELS[newStatus]}`);
      setTimeout(() => setUpdateSuccess(null), 2000);
      await loadVehicles();
      if (expandedId === vehicleId) {
        loadHistory(vehicleId);
        const v = vehicles.find(x => x.id === vehicleId);
        if (v) loadGraphicsJob(v);
      }
    } catch {
      await dialog.alert('Network error — please try again');
    }
    setUpdatingId(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [statusNote, expandedId, vehicles]);

  const deleteVehicle = async (vehicleId: string) => {
    setDeletingId(vehicleId);
    try {
      const res = await fetch('/api/vehicles/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId }),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert('Delete failed: ' + (data.error || 'Unknown error'));
      } else {
        const wasArchived = !!(vehicles.find(v => v.id === vehicleId) as any)?.archived_at;
        setVehicles(prev => prev.filter(v => v.id !== vehicleId));
        if (wasArchived) setArchivedCount(prev => (prev === null ? prev : Math.max(0, prev - 1)));
        else setTotalCount(prev => (prev === null ? prev : Math.max(0, prev - 1)));
        setExpandedId(null);
        setUpdateSuccess('Vehicle deleted');
        setTimeout(() => setUpdateSuccess(null), 2000);
      }
    } catch {
      await dialog.alert('Network error — please try again');
    }
    setDeletingId(null);
  };

  const archiveVehicle = async (vehicleId: string, unarchive = false) => {
    setArchivingId(vehicleId);
    try {
      const res = await fetch('/api/vehicles/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId, unarchive }),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert('Archive failed: ' + (data.error || 'Unknown error'));
      } else {
        setVehicles(prev => prev.map(v =>
          v.id === vehicleId ? { ...v, archived_at: unarchive ? null : new Date().toISOString() } as any : v
        ));
        // The vehicle moves between the shop list and the archived list —
        // keep both exact counts in step without a refetch.
        setTotalCount(prev => (prev === null ? prev : Math.max(0, prev + (unarchive ? 1 : -1))));
        setArchivedCount(prev => (prev === null ? prev : Math.max(0, prev + (unarchive ? -1 : 1))));
        setExpandedId(null);
        setUpdateSuccess(unarchive ? 'Vehicle restored' : 'Vehicle archived');
        setTimeout(() => setUpdateSuccess(null), 2000);
      }
    } catch {
      await dialog.alert('Network error — please try again');
    }
    setArchivingId(null);
  };

  // Filter & search
  const activeVehicles = vehicles.filter(v => !(v as any).archived_at);
  const archivedVehicles = vehicles.filter(v => !!(v as any).archived_at);

  const filtered = (showArchived ? archivedVehicles : activeVehicles).filter(v => {
    const status = v.status as VehicleTrackingStatus;
    if (filterStatus === 'stuck') return status === 'stuck_parts' || status === 'stuck_graphics';
    if (filterStatus === 'shipped') return status === 'shipped';
    if (filterStatus !== 'all') return status === filterStatus;
    // "All" tab excludes shipped — shipped only shows on its own tab
    return status !== 'shipped';
  }).filter(v => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    const title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ').toLowerCase();
    return v.vin.toLowerCase().includes(s) || title.includes(s) || (v.customer_name || '').toLowerCase().includes(s);
  });

  // Pipeline counts (active vehicles only)
  const statusCounts: Record<string, number> = {};
  VEHICLE_STATUS_PIPELINE.forEach(s => { statusCounts[s] = 0; });
  activeVehicles.forEach(v => { if (statusCounts[v.status] !== undefined) statusCounts[v.status]++; });
  const stuckCount = (statusCounts['stuck_parts'] || 0) + (statusCounts['stuck_graphics'] || 0);

  // Group filtered vehicles by customer/SO
  const grouped = filtered.reduce((acc: Record<string, FleetCheckin[]>, v) => {
    const key = v.customer_name || v.sales_order_number || 'Unassigned';
    if (!acc[key]) acc[key] = [];
    acc[key].push(v);
    return acc;
  }, {});
  const groupKeys = Object.keys(grouped).sort((a, b) => a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b));

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const vehicleTitle = (v: FleetCheckin) =>
    [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle';

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{
          width: '36px', height: '36px', border: '3px solid var(--border)',
          borderTopColor: 'var(--orange)', borderRadius: '50%', margin: '0 auto',
          animation: 'spin 1s linear infinite',
        }} />
        <div style={{ color: 'var(--text-muted)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading vehicles...</div>
      </div>
    );
  }

  // ── Board metrics (graphics-board treatment) ──
  const vStageDays = (v: FleetCheckin): number => {
    const since = stageSince[v.id] || v.created_at;
    return Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000);
  };
  const todayISO = new Date().toISOString().slice(0, 10);
  const weekISO = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const onGround = activeVehicles.filter(v => IN_SHOP_STATUSES.includes(v.status));
  const overdueBack = onGround.filter(v => (v as any).promised_back_date && (v as any).promised_back_date < todayISO).length;
  const dueBackWeek = onGround.filter(v => {
    const d = (v as any).promised_back_date;
    return d && d >= todayISO && d <= weekISO;
  }).length;
  const stuckInStage = onGround.filter(v => vStageDays(v) >= 3).length;

  const backRisk = (v: FleetCheckin): { label: string; color: string } | null => {
    const d = (v as any).promised_back_date;
    if (!d || !IN_SHOP_STATUSES.includes(v.status)) return null;
    if (d < todayISO) {
      const days = Math.floor((Date.now() - new Date(d + 'T12:00:00').getTime()) / 86_400_000);
      return { label: `needed back ${days}d ago`, color: '#ef4444' };
    }
    const daysUntil = Math.floor((new Date(d + 'T12:00:00').getTime() - Date.now()) / 86_400_000);
    if (daysUntil > 2) return null;
    const weekday = new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short' });
    return { label: `back by ${weekday}`, color: daysUntil <= 0 ? '#ef4444' : '#fbbf24' };
  };

  return (
    <div>
      {/* Page Header */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>
          In-Shop
        </div>
      </div>

      <MentionsInbox />

      {/* Arrival schedule — merged from the old Shop Board tab */}
      <ShopArrivals />

      {/* Check In Vehicle — merged from the old /fleet page. Pops out as a
          persistent overlay (same idiom as the vehicle detail modal below):
          inline, the wizard scrolled away after a VIN scan swapped in the
          next step, stranding the user down-page. ?checkin=1 still opens it. */}
      {(isAdmin || hasFeature('fleet_checkin')) && (
        <>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', marginBottom: '14px', overflow: 'hidden' }}>
            <button
              onClick={() => setShowCheckIn(true)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
                padding: '13px 16px', background: 'transparent', border: 'none', cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
                ➕ Check In Vehicle
              </span>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>↗</span>
            </button>
          </div>
          {showCheckIn && (
            <>
              {/* Backdrop — deliberately not click-to-close: a stray tap
                  mid-check-in would throw away a scanned VIN and picked
                  sales order. The ✕ in the header closes. */}
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000 }} />
              <div
                style={{
                  position: 'fixed', top: '50%', left: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: 'min(720px, calc(96vw / var(--ts)))', maxHeight: 'calc(92vh / var(--ts))',
                  display: 'flex', flexDirection: 'column', overflow: 'hidden',
                  background: 'var(--card)', borderRadius: '14px',
                  boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
                  border: '1px solid var(--border)',
                  zIndex: 1001,
                }}
              >
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  gap: '12px', padding: '12px 14px', flexShrink: 0,
                  background: 'var(--card)', borderBottom: '1px solid var(--border)',
                }}>
                  <span style={{ fontSize: '14px', fontWeight: 800, color: 'var(--orange)' }}>➕ Check In Vehicle</span>
                  <button
                    onClick={() => setShowCheckIn(false)}
                    aria-label="Close"
                    style={{
                      width: '32px', height: '32px', borderRadius: '8px',
                      background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                      color: 'var(--text-muted)', fontSize: '16px', fontWeight: 700,
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >✕</button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>
                  <Suspense fallback={<div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>Loading check-in…</div>}>
                    <VehicleCheckIn onCheckedIn={() => loadVehicles(false)} />
                  </Suspense>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* Summary / metrics strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: '8px', marginBottom: '14px' }}>
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)' }}>{activeVehicles.filter(v => v.status !== 'shipped').length}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>In Shop</div>
        </div>
        <div
          onClick={() => setFilterStatus(filterStatus === 'stuck' ? 'all' : 'stuck')}
          style={{
            background: stuckCount > 0 ? 'var(--warning-bg)' : 'var(--card)',
            border: `1px solid ${stuckCount > 0 ? 'var(--warning-border)' : 'var(--border)'}`,
            borderRadius: '12px', padding: '12px', textAlign: 'center', cursor: 'pointer',
          }}
        >
          <div style={{ fontSize: '24px', fontWeight: 800, color: stuckCount > 0 ? 'var(--warning)' : 'var(--text-primary)' }}>
            {stuckCount}
          </div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: stuckCount > 0 ? 'var(--warning)' : 'var(--text-muted)', textTransform: 'uppercase' }}>
            Stuck
          </div>
        </div>
        <div style={{
          background: overdueBack > 0 ? 'var(--error-bg)' : 'var(--card)',
          border: `1px solid ${overdueBack > 0 ? 'var(--error-border)' : 'var(--border)'}`,
          borderRadius: '12px', padding: '12px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: overdueBack > 0 ? 'var(--error)' : 'var(--text-primary)' }}>{overdueBack}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: overdueBack > 0 ? 'var(--error)' : 'var(--text-muted)', textTransform: 'uppercase' }}>Overdue Back</div>
        </div>
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: dueBackWeek > 0 ? '#fbbf24' : 'var(--text-primary)' }}>{dueBackWeek}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Back This Wk</div>
        </div>
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: stuckInStage > 0 ? '#fbbf24' : 'var(--text-primary)' }}>{stuckInStage}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>3d+ In Stage</div>
        </div>
        <div style={{
          background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: '12px', padding: '12px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--success)' }}>{statusCounts['complete'] || 0}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--success)', textTransform: 'uppercase' }}>Complete</div>
        </div>
      </div>

      {/* Pipeline Status Filter Bar */}
      <div style={{
        display: 'flex', gap: '3px', marginBottom: '14px', background: 'var(--card)',
        border: '1px solid var(--border)', borderRadius: '10px', padding: '3px', overflow: 'auto',
      }}>
        <button
          onClick={() => setFilterStatus('all')}
          style={{
            padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700,
            background: filterStatus === 'all' ? 'var(--tab-active-bg)' : 'transparent',
            border: 'none', color: filterStatus === 'all' ? 'var(--text-primary)' : 'var(--text-muted)',
            whiteSpace: 'nowrap',
          }}
        >On Ground ({activeVehicles.filter(v => v.status !== 'shipped').length})</button>
        {VEHICLE_STATUS_PIPELINE.map(status => {
          const count = statusCounts[status] || 0;
          const colors = VEHICLE_STATUS_COLORS[status];
          const isActive = filterStatus === status;
          return (
            <button
              key={status}
              onClick={() => setFilterStatus(isActive ? 'all' : status)}
              style={{
                padding: '6px 8px', borderRadius: '7px', fontSize: '10px', fontWeight: 700,
                background: isActive ? colors.bg : 'transparent',
                border: isActive ? `1px solid ${colors.border}` : '1px solid transparent',
                color: isActive ? colors.text : count > 0 ? 'var(--text-secondary)' : 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              {VEHICLE_STATUS_LABELS[status].split('(')[0].trim()} ({count})
            </button>
          );
        })}
      </div>

      {/* Search + Archive Toggle */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by VIN, vehicle, or customer..."
          style={{
            flex: 1, padding: '10px 12px', borderRadius: '10px',
            border: '1px solid var(--border)', background: 'var(--card)',
            color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600,
            boxSizing: 'border-box',
          }}
        />
        {((archivedCount ?? 0) > 0 || archivedVehicles.length > 0) && (
          <button
            onClick={() => { setShowArchived(!showArchived); setFilterStatus('all'); }}
            style={{
              padding: '10px 12px', borderRadius: '10px', fontSize: '11px', fontWeight: 700,
              background: showArchived ? 'rgba(148,163,184,0.22)' : 'var(--card)',
              border: `1px solid ${showArchived ? 'rgba(148,163,184,0.5)' : 'var(--border)'}`,
              color: showArchived ? 'var(--text-primary)' : 'var(--text-muted)',
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {showArchived ? `Active (${totalCount ?? activeVehicles.length})` : `Archived (${archivedCount ?? archivedVehicles.length})`}
          </button>
        )}
      </div>

      {/* Success Toast */}
      {updateSuccess && (
        <div style={{
          padding: '8px 14px', marginBottom: '10px', borderRadius: '10px',
          background: 'var(--success-bg)', border: '1px solid var(--success-border)',
          color: 'var(--success)', fontSize: '13px', fontWeight: 700, textAlign: 'center',
        }}>
          {updateSuccess}
        </div>
      )}

      {/* Archived banner */}
      {showArchived && (
        <div style={{
          padding: '8px 14px', marginBottom: '10px', borderRadius: '10px',
          background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)',
          color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, textAlign: 'center',
        }}>
          Viewing Archived Vehicles
        </div>
      )}

      {/* Vehicle List */}
      {filtered.length === 0 ? (
        <div style={{
          padding: '30px 20px', textAlign: 'center', background: 'var(--card)',
          border: '1px solid var(--border)', borderRadius: '14px',
        }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '14px', fontWeight: 600 }}>
            {showArchived ? (archivedLoading ? 'Loading archived vehicles…' : 'No archived vehicles') : searchTerm ? 'No vehicles match your search' : 'No vehicles in this status'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {groupKeys.map(groupKey => {
            const groupVehicles = grouped[groupKey];
            const isCollapsed = collapsedGroups.has(groupKey);
            const statusSummary: Record<string, number> = {};
            groupVehicles.forEach(v => {
              const s = v.status === 'checked_in' ? 'received' : v.status;
              statusSummary[s] = (statusSummary[s] || 0) + 1;
            });

            return (
              <div key={groupKey}>
                {/* Group header */}
                <div
                  onClick={() => toggleGroup(groupKey)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 14px', borderRadius: '10px', cursor: 'pointer',
                    background: 'var(--card)', border: '1px solid var(--border)',
                    marginBottom: isCollapsed ? 0 : '6px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', transition: 'transform 0.15s', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                    <span style={{ fontWeight: 800, fontSize: '13px', color: 'var(--text-primary)' }}>{groupKey}</span>
                    {groupVehicles[0]?.sales_order_number && groupKey !== groupVehicles[0].sales_order_number && (
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>SO #{groupVehicles[0].sales_order_number}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {Object.entries(statusSummary).map(([s, count]) => {
                      const sc = VEHICLE_STATUS_COLORS[s as VehicleTrackingStatus];
                      return (
                        <span key={s} style={{
                          fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                          background: sc?.bg || 'var(--subtle-bg)',
                          color: sc?.text || 'var(--text-muted)',
                        }}>{count}</span>
                      );
                    })}
                    <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>{groupVehicles.length} VIN{groupVehicles.length !== 1 ? 's' : ''}</span>
                  </div>
                </div>

                {/* Vehicle cards */}
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingLeft: '12px' }}>
                    {groupVehicles.map(vehicle => {
            const isExpanded = expandedId === vehicle.id;
            const status = (vehicle.status === 'checked_in' ? 'received' : vehicle.status) as VehicleTrackingStatus;

            return (
              <div key={vehicle.id} id={`vehicle-${vehicle.id}`} style={{
                background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
                overflow: 'hidden',
              }}>
                {/* Vehicle Row — tap to expand */}
                <div
                  onClick={() => toggleExpand(vehicle.id)}
                  role="button"
                  tabIndex={0}
                  style={{
                    width: '100%', padding: '12px 14px', textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: '14px', color: 'var(--text-primary)' }}>{vehicle.customer_name || 'No Customer'}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{vehicleTitle(vehicle)}</div>
                      <div style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-muted)', marginTop: '2px' }}>{vehicle.vin}</div>
                      {vehicle.sales_order_number && (
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>SO #{vehicle.sales_order_number}</div>
                      )}
                      {(vehicle as any).scheduled_upfit_date && (
                        <div style={{ fontSize: '11px', color: '#3b82f6', fontWeight: 600, marginTop: '1px' }}>Upfit: {new Date((vehicle as any).scheduled_upfit_date + 'T12:00:00').toLocaleDateString()}</div>
                      )}
                      {/* Graphics-board-style chips: due-back risk + time in stage */}
                      {(() => {
                        const risk = backRisk(vehicle);
                        const days = IN_SHOP_STATUSES.includes(vehicle.status) ? vStageDays(vehicle) : 0;
                        const showStage = days >= 3;
                        if (!risk && !showStage) return null;
                        const stageColor = days >= 6 ? '#ef4444' : '#fbbf24';
                        return (
                          <div style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' }}>
                            {risk && (
                              <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: `${risk.color}18`, border: `1px solid ${risk.color}44`, color: risk.color }}>
                                ⚠ {risk.label}
                              </span>
                            )}
                            {showStage && (
                              <span
                                title={`In ${VEHICLE_STATUS_LABELS[status] || vehicle.status} since ${new Date(stageSince[vehicle.id] || vehicle.created_at).toLocaleDateString()}`}
                                style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: `${stageColor}18`, border: `1px solid ${stageColor}44`, color: stageColor }}
                              >
                                ⏱ in {(VEHICLE_STATUS_LABELS[status] || vehicle.status).toLowerCase()} {days}d
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      {(vehicle as any).needs_graphics && !(vehicle as any).matched_graphics_job_id && (
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            const params = new URLSearchParams({
                              new: '1',
                              vin: vehicle.vin || '',
                              customer: vehicle.customer_name || '',
                              so: vehicle.sales_order_number || '',
                              checkinId: vehicle.id,
                            });
                            router.push(`/graphics?${params.toString()}`);
                          }}
                          role="button"
                          style={{
                            display: 'inline-block', marginTop: '4px', padding: '2px 8px',
                            borderRadius: '999px', fontSize: '10px', fontWeight: 800,
                            background: 'rgba(251,146,60,0.12)', color: '#fb923c',
                            border: '1px solid rgba(251,146,60,0.35)', cursor: 'pointer',
                          }}
                          title={(vehicle as any).graphics_signal || 'Needs graphics job'}
                        >Needs Graphics</div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '8px' }}>
                      <StatusBadge status={status} />
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        {timeAgo(vehicle.updated_at)}
                      </div>
                      {vehicle.assigned_to && profiles[vehicle.assigned_to] && (
                        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                          {profiles[vehicle.assigned_to]}
                        </div>
                      )}
                      {/* Quick archive/restore — clear an old job off the board
                          without drilling into the detail modal (admin-only). */}
                      {isAdmin && (
                        (vehicle as any).archived_at ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); archiveVehicle(vehicle.id, true); }}
                            disabled={archivingId === vehicle.id}
                            title="Restore to the active board"
                            style={{
                              marginTop: '6px', padding: '3px 9px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                              background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer',
                            }}
                          >
                            {archivingId === vehicle.id ? 'Restoring…' : 'Restore'}
                          </button>
                        ) : (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (await dialog.confirm(`Archive ${vehicleTitle(vehicle)} (${vehicle.vin}) off the In-Shop board? You can restore it later.`, { confirmLabel: 'Archive' })) {
                                archiveVehicle(vehicle.id);
                              }
                            }}
                            disabled={archivingId === vehicle.id}
                            title="Archive off the In-Shop board"
                            style={{
                              marginTop: '6px', padding: '3px 9px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                              background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer',
                            }}
                          >
                            {archivingId === vehicle.id ? 'Archiving…' : 'Archive'}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </div>

                {/* Expanded Detail — popout modal (overlay + centered card) */}
                {isExpanded && (
                  <>
                    {/* Backdrop */}
                    <div
                      onClick={() => setExpandedId(null)}
                      style={{
                        position: 'fixed', inset: 0,
                        background: 'rgba(0,0,0,0.55)',
                        zIndex: 1000,
                      }}
                    />
                    {/* Modal */}
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: 'fixed', top: '50%', left: '50%',
                        transform: 'translate(-50%, -50%)',
                        width: 'min(720px, calc(96vw / var(--ts)))', maxHeight: 'calc(92vh / var(--ts))',
                        overflow: 'auto',
                        background: 'var(--card)', borderRadius: '14px',
                        boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
                        border: '1px solid var(--border)',
                        zIndex: 1001,
                      }}
                    >
                      {/* Sticky header with vehicle identity + close */}
                      <div style={{
                        position: 'sticky', top: 0, zIndex: 2,
                        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                        gap: '12px', padding: '14px 14px 10px',
                        background: 'var(--card)', borderBottom: '1px solid var(--border)',
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 800, fontSize: '15px', color: 'var(--text-primary)' }}>{vehicle.customer_name || 'No Customer'}</div>
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{vehicleTitle(vehicle)}</div>
                          <div style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{vehicle.vin}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                          <StatusBadge status={status} />
                          <button
                            onClick={() => setExpandedId(null)}
                            aria-label="Close"
                            style={{
                              width: '32px', height: '32px', borderRadius: '8px',
                              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                              color: 'var(--text-muted)', fontSize: '16px', fontWeight: 700,
                              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}
                          >✕</button>
                        </div>
                      </div>
                      <div style={{ padding: '14px' }}>
                    {/* VIN — editable, in case it was scanned or typed wrong */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>VIN</div>
                        {vinEdits[vehicle.id] === undefined ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); startVinEdit(vehicle.id, vehicle.vin); }}
                            style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                          >Edit</button>
                        ) : null}
                      </div>
                      {vinEdits[vehicle.id] === undefined ? (
                        <div style={{ fontSize: '13px', fontFamily: 'monospace', color: 'var(--text-primary)', padding: '8px 10px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                          {vehicle.vin}
                        </div>
                      ) : (
                        <>
                          <input
                            type="text"
                            value={vinEdits[vehicle.id]}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setVinEdits(prev => ({ ...prev, [vehicle.id]: e.target.value.toUpperCase() }))}
                            maxLength={17}
                            placeholder="17-character VIN"
                            style={{
                              width: '100%', padding: '8px 10px', borderRadius: '8px',
                              border: '1px solid var(--border)', background: 'var(--input-bg)',
                              color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace',
                              letterSpacing: '0.5px', boxSizing: 'border-box', textTransform: 'uppercase',
                            }}
                          />
                          {vinError[vehicle.id] && (
                            <div style={{ fontSize: '11px', color: '#f87171', marginTop: '4px' }}>{vinError[vehicle.id]}</div>
                          )}
                          <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); saveVinEdit(vehicle.id); }}
                              disabled={vinSaving === vehicle.id}
                              style={{
                                flex: 1, padding: '8px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                                background: '#22c55e', border: 'none', color: '#fff',
                                opacity: vinSaving === vehicle.id ? 0.5 : 1,
                              }}
                            >{vinSaving === vehicle.id ? 'Decoding & saving...' : 'Save VIN'}</button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); cancelVinEdit(vehicle.id); }}
                              disabled={vinSaving === vehicle.id}
                              style={{
                                padding: '8px 14px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                                background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)',
                              }}
                            >Cancel</button>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Status Update Buttons — available to all roles */}
                    <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                          Update Status
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {VEHICLE_STATUS_PIPELINE.map(s => {
                            const colors = VEHICLE_STATUS_COLORS[s];
                            const isCurrent = s === status;
                            const isUpdating = updatingId === vehicle.id;
                            return (
                              <button
                                key={s}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  if (!isCurrent && !isUpdating) {
                                    if (s === 'complete') {
                                      // Marking complete must go through the completion
                                      // process (checklist + photos), not a direct status flip.
                                      setCompletionModalVehicleId(vehicle.id);
                                    } else {
                                      updateStatus(vehicle.id, s);
                                    }
                                  }
                                }}
                                disabled={isCurrent || isUpdating}
                                style={{
                                  padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                  background: isCurrent ? colors.bg : 'var(--subtle-bg)',
                                  border: `1.5px solid ${isCurrent ? colors.border : 'var(--border)'}`,
                                  color: isCurrent ? colors.text : 'var(--text-secondary)',
                                  opacity: isCurrent ? 1 : (isUpdating ? 0.4 : 1),
                                  cursor: isCurrent || isUpdating ? 'default' : 'pointer',
                                  transition: 'all 0.15s',
                                }}
                              >
                                {isCurrent ? `● ${VEHICLE_STATUS_LABELS[s]}` : VEHICLE_STATUS_LABELS[s]}
                              </button>
                            );
                          })}
                        </div>

                        {/* Note input */}
                        <input
                          type="text"
                          value={statusNote}
                          onChange={(e) => setStatusNote(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="Add a note with the status change..."
                          style={{
                            width: '100%', padding: '8px 10px', borderRadius: '8px', marginTop: '8px',
                            border: '1px solid var(--border)', background: 'var(--input-bg)',
                            color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
                          }}
                        />

                        {/* Action buttons: Run Completion Process + Message Customer */}
                        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                          {status !== 'complete' && status !== 'shipped' && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setCompletionModalVehicleId(vehicle.id);
                              }}
                              style={{
                                flex: 1, padding: '12px', borderRadius: '10px',
                                fontSize: '13px', fontWeight: 800, cursor: 'pointer',
                                background: '#22c55e', border: '1px solid #22c55e', color: '#fff',
                                transition: 'all 0.15s',
                              }}
                            >
                              Run Completion Process
                            </button>
                          )}
                          {vehicle.customer_name && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                messageCustomer(vehicle);
                              }}
                              disabled={messagingVehicleId === vehicle.id}
                              style={{
                                flex: 1, padding: '12px', borderRadius: '10px',
                                fontSize: '13px', fontWeight: 800,
                                cursor: messagingVehicleId === vehicle.id ? 'wait' : 'pointer',
                                background: 'rgba(96,165,250,0.12)',
                                border: '1px solid rgba(96,165,250,0.4)',
                                color: '#60a5fa',
                                transition: 'all 0.15s',
                                opacity: messagingVehicleId === vehicle.id ? 0.6 : 1,
                              }}
                            >
                              {messagingVehicleId === vehicle.id ? 'Opening…' : 'Message Customer'}
                            </button>
                          )}
                        </div>
                      </div>

                    {/* Graphics Install Lane (migration 085) — runs in parallel
                        to the upfit pipeline above, no forced ordering. The
                        completion ceremony in /api/vehicle-tracking/update-status
                        gates on this being 'complete' or 'n/a' when a graphics
                        job is linked. Hidden for pure-upfit jobs whose lane is
                        backfilled to 'pending' or 'n/a' with no matched job. */}
                    {(() => {
                      const lane = ((vehicle as any).graphics_install_status as GraphicsInstallStatus) || 'pending';
                      const hasGraphics = !!(vehicle as any).matched_graphics_job_id;
                      const showLane = hasGraphics || (lane !== 'pending' && lane !== 'n/a');
                      if (!showLane) return null;
                      const isUpdating = updatingId === vehicle.id;
                      const isAdmin = profile?.role === 'admin';
                      // 'n/a' is opt-out and only really makes sense if an
                      // admin needs to bypass the gate without doing the work
                      // (e.g. graphics shipped direct to customer); hide it
                      // from non-admins to keep the row tidy.
                      const visibleStates = GRAPHICS_INSTALL_PIPELINE.filter(s => s !== 'n/a' || isAdmin);
                      return (
                        <div style={{ marginBottom: '12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                              Graphics Install
                            </div>
                            {hasGraphics && graphicsJobs[vehicle.id] && (
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                                #{graphicsJobs[vehicle.id]?.job_number || (graphicsJobs[vehicle.id]?.id || '').slice(0, 8)} · {GRAPHICS_STATUS_LABELS[graphicsJobs[vehicle.id]!.status] || graphicsJobs[vehicle.id]!.status}
                              </div>
                            )}
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {visibleStates.map(s => {
                              const colors = GRAPHICS_INSTALL_COLORS[s];
                              const isCurrent = s === lane;
                              return (
                                <button
                                  key={s}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    if (!isCurrent && !isUpdating) {
                                      updateGraphicsInstall(vehicle.id, s);
                                    }
                                  }}
                                  disabled={isCurrent || isUpdating}
                                  style={{
                                    padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                    background: isCurrent ? colors.bg : 'var(--subtle-bg)',
                                    border: `1.5px solid ${isCurrent ? colors.border : 'var(--border)'}`,
                                    color: isCurrent ? colors.text : 'var(--text-secondary)',
                                    opacity: isCurrent ? 1 : (isUpdating ? 0.4 : 1),
                                    cursor: isCurrent || isUpdating ? 'default' : 'pointer',
                                    transition: 'all 0.15s',
                                  }}
                                >
                                  {isCurrent ? `● ${GRAPHICS_INSTALL_LABELS[s]}` : GRAPHICS_INSTALL_LABELS[s]}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Vehicle Info */}
                    <div style={{
                      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px',
                    }}>
                      {/* Customer — always shown, editable: trucks get checked
                          in without a customer and need one attached later. */}
                      <div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Customer</div>
                        {/* The attach/edit control is a real button — a bare
                            10px link next to the label read as decoration on
                            phones, and nobody found it (field report). */}
                        {custEditFor !== vehicle.id && !vehicle.customer_name && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setCustEditFor(vehicle.id); setCustEditSearch(''); setCustEditMatches([]); }}
                            style={{
                              marginTop: '4px', width: '100%', padding: '10px', borderRadius: '8px',
                              border: '1px dashed rgba(96,165,250,0.55)', background: 'rgba(96,165,250,0.08)',
                              color: '#60a5fa', fontSize: '12px', fontWeight: 800, cursor: 'pointer', textAlign: 'center',
                            }}
                          >+ Attach Customer</button>
                        )}
                        {custEditFor === vehicle.id ? (
                          <div style={{ position: 'relative', marginTop: '2px' }} onClick={(e) => e.stopPropagation()}>
                            <input
                              autoFocus
                              value={custEditSearch}
                              onChange={(e) => setCustEditSearch(e.target.value)}
                              placeholder="Search NetSuite customers…"
                              style={{
                                width: '100%', padding: '7px 9px', borderRadius: '7px',
                                border: '1px solid var(--border)', background: 'var(--input-bg)',
                                color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
                              }}
                            />
                            {custEditMatches.length > 0 && (
                              <div style={{
                                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5,
                                background: 'var(--card)', border: '1px solid var(--border-strong)',
                                borderRadius: '8px', marginTop: '4px',
                                boxShadow: 'var(--shadow-md)', maxHeight: '180px', overflowY: 'auto',
                              }}>
                                {custEditMatches.map(c => (
                                  <button
                                    key={c.id}
                                    type="button"
                                    disabled={custEditSaving}
                                    onClick={() => attachCustomer(vehicle.id, c)}
                                    style={{
                                      display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px',
                                      background: 'transparent', border: 'none', cursor: 'pointer',
                                      color: 'var(--text-body)', fontSize: '12px',
                                    }}
                                  >
                                    <span style={{ fontWeight: 700 }}>{c.company_name}</span>
                                    {c.entity_id && <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '11px' }}>{c.entity_id}</span>}
                                  </button>
                                ))}
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => { setCustEditFor(null); setCustEditSearch(''); setCustEditMatches([]); }}
                              style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0 0' }}
                            >Cancel</button>
                          </div>
                        ) : vehicle.customer_name ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>{vehicle.customer_name}</div>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setCustEditFor(vehicle.id); setCustEditSearch(''); setCustEditMatches([]); }}
                              style={{
                                padding: '3px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                                background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)',
                                color: '#60a5fa', cursor: 'pointer', flexShrink: 0,
                              }}
                            >Edit</button>
                          </div>
                        ) : null}
                      </div>
                      {vehicle.sales_order_number && (
                        <div>
                          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Sales Order</div>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>#{vehicle.sales_order_number}</div>
                        </div>
                      )}
                      <div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Checked In</div>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                          {new Date(vehicle.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </div>
                      </div>
                      {/* Notes — always shown, editable (field request: fix a
                          check-in's notes after the vehicle is in the shop). */}
                      <div style={{ gridColumn: '1 / -1' }}>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Notes</div>
                        {notesEdits[vehicle.id] === undefined ? (
                          vehicle.notes
                            ? <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginTop: '2px' }}>
                                <div style={{ flex: 1, fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{vehicle.notes}</div>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setNotesEdits(prev => ({ ...prev, [vehicle.id]: vehicle.notes || '' })); }}
                                  style={{
                                    padding: '3px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                                    background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)',
                                    color: '#60a5fa', cursor: 'pointer', flexShrink: 0,
                                  }}
                                >Edit</button>
                              </div>
                            : <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setNotesEdits(prev => ({ ...prev, [vehicle.id]: '' })); }}
                                style={{
                                  marginTop: '4px', width: '100%', padding: '10px', borderRadius: '8px',
                                  border: '1px dashed rgba(96,165,250,0.55)', background: 'rgba(96,165,250,0.08)',
                                  color: '#60a5fa', fontSize: '12px', fontWeight: 800, cursor: 'pointer', textAlign: 'center',
                                }}
                              >+ Add Notes</button>
                        ) : (
                          <div onClick={(e) => e.stopPropagation()}>
                            <textarea
                              value={notesEdits[vehicle.id]}
                              onChange={(e) => setNotesEdits(prev => ({ ...prev, [vehicle.id]: e.target.value }))}
                              rows={3}
                              placeholder="Notes about this vehicle…"
                              style={{
                                width: '100%', padding: '8px 10px', borderRadius: '8px', boxSizing: 'border-box',
                                border: '1px solid var(--border)', background: 'var(--input-bg)',
                                color: 'var(--text-primary)', fontSize: '12px', resize: 'vertical', marginTop: '2px',
                              }}
                            />
                            <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                              <button
                                type="button"
                                onClick={() => saveNotesEdit(vehicle.id)}
                                disabled={notesSaving === vehicle.id}
                                style={{
                                  flex: 1, padding: '8px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                                  background: '#22c55e', color: '#fff', border: 'none',
                                  opacity: notesSaving === vehicle.id ? 0.5 : 1,
                                }}
                              >{notesSaving === vehicle.id ? 'Saving…' : 'Save Notes'}</button>
                              <button
                                type="button"
                                onClick={() => setNotesEdits(prev => { const next = { ...prev }; delete next[vehicle.id]; return next; })}
                                style={{
                                  padding: '8px 14px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                                  background: 'transparent', color: 'var(--text-body)', border: '1px solid var(--border)',
                                }}
                              >Cancel</button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Install Context — sales-order memo, install instructions, on-site contact, delivery prefs.
                        Snapshotted from the originating estimate at check-in time (migration 076). */}
                    {(() => {
                      const memo = vehicle.sales_order_memo;
                      const inst = (vehicle as any).install_instructions as string | null | undefined;
                      const contactName = (vehicle as any).on_site_contact_name as string | null | undefined;
                      const contactPhone = (vehicle as any).on_site_contact_phone as string | null | undefined;
                      const delivery = (vehicle as any).delivery_preferences as string | null | undefined;
                      if (!memo && !inst && !contactName && !contactPhone && !delivery) return null;
                      return (
                        <div style={{
                          marginBottom: '12px', padding: '10px', borderRadius: '8px',
                          background: 'rgba(96,165,250,0.05)', border: '1px solid rgba(96,165,250,0.18)',
                        }}>
                          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                            Install Context
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {memo && (
                              <div>
                                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>SO Memo</div>
                                <div style={{ fontSize: '12px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{memo}</div>
                              </div>
                            )}
                            {inst && (
                              <div>
                                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Install Instructions</div>
                                <div style={{ fontSize: '12px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{inst}</div>
                              </div>
                            )}
                            {(contactName || contactPhone) && (
                              <div>
                                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>On-site Contact</div>
                                <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                                  {contactName || ''}
                                  {contactName && contactPhone && ' · '}
                                  {contactPhone && (
                                    <a href={`tel:${contactPhone}`} style={{ color: 'var(--accent, #2563eb)' }}>{contactPhone}</a>
                                  )}
                                </div>
                              </div>
                            )}
                            {delivery && (
                              <div>
                                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Delivery Preferences</div>
                                <div style={{ fontSize: '12px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{delivery}</div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Completion Notes — what the installer wrote when finishing the job. */}
                    {(vehicle as any).completion_notes && (
                      <div style={{
                        marginBottom: '12px', padding: '10px', borderRadius: '8px',
                        background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)',
                      }}>
                        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                          Completion Notes
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                          {(vehicle as any).completion_notes}
                        </div>
                      </div>
                    )}

                    {/* Matched Graphics Job — show the linked job, or a CTA
                        to create one and link it to this vehicle. */}
                    {(() => {
                      const gj = graphicsJobs[vehicle.id];
                      if (gj) {
                        const spec = [gj.vinyl_color, gj.vinyl_type].filter(Boolean).join(' · ');
                        return (
                          <div style={{
                            marginBottom: '12px', padding: '10px', borderRadius: '8px',
                            background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)',
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                Matched Graphics Job
                              </div>
                              <a
                                href={`/graphics?editJob=${gj.id}`}
                                onClick={(e) => e.stopPropagation()}
                                style={{ fontSize: '11px', fontWeight: 700, color: 'var(--accent, #2563eb)', textDecoration: 'none' }}
                              >Open ↗</a>
                            </div>
                            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                              {gj.title}
                              {gj.job_number && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: '6px' }}>#{gj.job_number}</span>}
                            </div>
                            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                              <span><strong style={{ color: 'var(--text-muted)' }}>Status:</strong> {GRAPHICS_STATUS_LABELS[gj.status] || gj.status}</span>
                              <span><strong style={{ color: 'var(--text-muted)' }}>Qty:</strong> {gj.quantity}</span>
                              {spec && <span><strong style={{ color: 'var(--text-muted)' }}>Vinyl:</strong> {spec}</span>}
                            </div>
                          </div>
                        );
                      }
                      // No graphics job linked yet — show creation CTA that
                      // prefills VIN/customer/SO and the checkin id so the new
                      // job comes back linked to this vehicle.
                      const flagged = !!(vehicle as any).needs_graphics;
                      return (
                        <div style={{ marginBottom: '12px' }}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const params = new URLSearchParams({
                                new: '1',
                                vin: vehicle.vin || '',
                                customer: vehicle.customer_name || '',
                                so: vehicle.sales_order_number || '',
                                checkinId: vehicle.id,
                              });
                              router.push(`/graphics?${params.toString()}`);
                            }}
                            style={{
                              width: '100%', padding: '12px', borderRadius: '10px',
                              fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                              background: flagged ? 'rgba(251,146,60,0.1)' : 'var(--subtle-bg)',
                              border: `1px dashed ${flagged ? 'rgba(251,146,60,0.45)' : 'var(--border-strong)'}`,
                              color: flagged ? '#fb923c' : 'var(--text-secondary)',
                            }}
                          >
                            + Create Graphics Job for this Vehicle
                          </button>
                          {flagged && (vehicle as any).graphics_signal && (
                            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px', textAlign: 'center' }}>
                              Flagged: {(vehicle as any).graphics_signal}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Estimates linked to this vehicle — via the estimate
                        builder's Link Checked-In Vehicle button, or the
                        originating estimate snapshotted at check-in. */}
                    {linkedEstimates.length > 0 && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                          Linked Estimate{linkedEstimates.length === 1 ? '' : 's'}
                        </div>
                        {linkedEstimates.map(est => (
                          <button
                            key={est.id}
                            onClick={(e) => { e.stopPropagation(); router.push(deepLinks.estimate(est.id)); }}
                            title="Open this estimate in the builder"
                            style={{
                              display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 10px',
                              marginBottom: '4px', borderRadius: '8px', textAlign: 'left', cursor: 'pointer',
                              background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.25)',
                              fontSize: '12px', color: 'var(--text-primary)',
                            }}
                          >
                            <span style={{ fontWeight: 800, color: '#60a5fa' }}>{est.estimate_number}</span>
                            {est.title && <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{est.title}</span>}
                            <span style={{ flex: 1 }} />
                            {est.grand_total != null && <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>${Number(est.grand_total).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>}
                            <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'var(--subtle-bg)', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                              {est.status}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Invoice tracking — shown for archived vehicles */}
                    {showArchived && (
                      <div style={{
                        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px',
                        padding: '10px', borderRadius: '8px',
                        background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                      }}>
                        <div>
                          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Invoice #</div>
                          <input
                            value={(vehicle as any).invoice_number || ''}
                            placeholder="Invoice number"
                            onClick={(e) => e.stopPropagation()}
                            onChange={async (e) => {
                              const val = e.target.value || null;
                              await supabase.from('fleet_checkins').update({ invoice_number: val, updated_at: new Date().toISOString() }).eq('id', vehicle.id);
                              setVehicles(prev => prev.map(v => v.id === vehicle.id ? { ...v, invoice_number: val } as any : v));
                            }}
                            style={{
                              width: '100%', padding: '6px 8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
                              border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
                              boxSizing: 'border-box',
                            }}
                          />
                        </div>
                        <div>
                          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Date Invoiced</div>
                          <input
                            type="date"
                            value={(vehicle as any).date_invoiced || ''}
                            onClick={(e) => e.stopPropagation()}
                            onChange={async (e) => {
                              const val = e.target.value || null;
                              await supabase.from('fleet_checkins').update({ date_invoiced: val, updated_at: new Date().toISOString() }).eq('id', vehicle.id);
                              setVehicles(prev => prev.map(v => v.id === vehicle.id ? { ...v, date_invoiced: val } as any : v));
                            }}
                            style={{
                              width: '100%', padding: '6px 8px', borderRadius: '6px', fontSize: '12px',
                              border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
                              boxSizing: 'border-box',
                            }}
                          />
                        </div>
                        <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <input
                            type="checkbox"
                            checked={(vehicle as any).is_paid || false}
                            onClick={(e) => e.stopPropagation()}
                            onChange={async (e) => {
                              const val = e.target.checked;
                              await supabase.from('fleet_checkins').update({ is_paid: val, updated_at: new Date().toISOString() }).eq('id', vehicle.id);
                              setVehicles(prev => prev.map(v => v.id === vehicle.id ? { ...v, is_paid: val } as any : v));
                            }}
                            style={{ width: '16px', height: '16px', accentColor: '#22c55e', cursor: 'pointer' }}
                          />
                          <span style={{
                            fontSize: '12px', fontWeight: 700,
                            color: (vehicle as any).is_paid ? '#4ade80' : '#fbbf24',
                          }}>
                            {(vehicle as any).is_paid ? 'Paid' : 'Unpaid'}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Scheduled Upfit Date + Promised Back */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
                      <div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Scheduled Upfit Date</div>
                        <input
                          type="date"
                          value={(vehicle as any).scheduled_upfit_date || ''}
                          onClick={(e) => e.stopPropagation()}
                          onChange={async (e) => {
                            const newDate = e.target.value || null;
                            await supabase.from('fleet_checkins').update({ scheduled_upfit_date: newDate, updated_at: new Date().toISOString() }).eq('id', vehicle.id);
                            setVehicles(prev => prev.map(v => v.id === vehicle.id ? { ...v, scheduled_upfit_date: newDate } as any : v));
                            // Sync to Google Calendar
                            if (newDate) {
                              fetch('/api/calendar/sync-upfit', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ checkinId: vehicle.id }),
                              }).catch(() => {});
                            }
                          }}
                          style={{
                            width: '100%', padding: '8px 10px', borderRadius: '8px',
                            border: '1px solid var(--border)', background: 'var(--input-bg)',
                            color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
                          }}
                        />
                      </div>
                      <div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Customer Needs It Back</div>
                        <input
                          type="date"
                          value={(vehicle as any).promised_back_date || ''}
                          onClick={(e) => e.stopPropagation()}
                          onChange={async (e) => {
                            const newDate = e.target.value || null;
                            await supabase.from('fleet_checkins').update({ promised_back_date: newDate, updated_at: new Date().toISOString() }).eq('id', vehicle.id);
                            setVehicles(prev => prev.map(v => v.id === vehicle.id ? { ...v, promised_back_date: newDate } as any : v));
                          }}
                          style={{
                            width: '100%', padding: '8px 10px', borderRadius: '8px',
                            border: '1px solid var(--border)', background: 'var(--input-bg)',
                            color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
                          }}
                        />
                      </div>
                    </div>

                    {/* Sales Orders — a vehicle may be linked to more than
                        one NetSuite SO (e.g. upfit billed against several). */}
                    {(() => {
                      const linkedSos = vehicleSalesOrders[vehicle.id] || [];
                      return (
                        <div style={{ marginBottom: '12px' }}>
                          {linkedSos.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
                              {linkedSos.map(so => {
                                // Once an SO has been invoiced (in NetSuite or
                                // via FleetSuite's completion flow), the SO is
                                // dead paper — show the invoice(s) in its place
                                // so staff see billing happened and open the
                                // document that matters now.
                                const invoices = soInvoices[so.netsuite_sales_order_id] || [];
                                return (
                                  <div key={so.id}>
                                    {invoices.length > 0 ? (
                                      <>
                                        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--success)', marginBottom: '4px' }}>
                                          ✓ SO #{so.sales_order_number || so.netsuite_sales_order_id} invoiced
                                        </div>
                                        {invoices.map(inv => (
                                          <NetSuitePdf
                                            key={inv.id}
                                            type="invoice"
                                            recordId={inv.id}
                                            recordNumber={inv.tranid}
                                            label="Invoice"
                                          />
                                        ))}
                                      </>
                                    ) : (
                                      <NetSuitePdf
                                        type="salesOrder"
                                        recordId={so.netsuite_sales_order_id}
                                        recordNumber={so.sales_order_number || so.netsuite_sales_order_id}
                                      />
                                    )}
                                    {isAdmin && (
                                      <button
                                        onClick={() => unlinkSalesOrder(vehicle.id, so.id)}
                                        style={{
                                          marginTop: '4px', padding: '4px 10px', fontSize: '10px', fontWeight: 600,
                                          background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px',
                                          color: 'var(--text-muted)', cursor: 'pointer',
                                        }}
                                      >Unlink Sales Order</button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {soSearchOpen === vehicle.id ? (
                            <div style={{
                              padding: '12px', borderRadius: '10px',
                              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                            }}>
                              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>
                                Search NetSuite Sales Orders
                              </div>
                              <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                                <input
                                  value={soSearchTerm}
                                  onChange={(e) => setSoSearchTerm(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') searchSalesOrders(); }}
                                  placeholder="Customer name..."
                                  style={{
                                    flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '13px',
                                    border: '1px solid var(--border)', background: 'var(--input-bg)',
                                    color: 'var(--text-primary)',
                                  }}
                                />
                                <button
                                  onClick={() => searchSalesOrders()}
                                  disabled={soSearching || !soSearchTerm.trim()}
                                  style={{
                                    padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                    background: 'var(--navy)', color: '#fff', border: 'none',
                                    opacity: soSearching || !soSearchTerm.trim() ? 0.5 : 1, cursor: 'pointer',
                                  }}
                                >{soSearching ? '...' : 'Search'}</button>
                                <button
                                  onClick={() => { setSoSearchOpen(null); setSoSearchTerm(''); setSoSearchResults([]); }}
                                  style={{
                                    padding: '8px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                    background: 'transparent', border: '1px solid var(--border)',
                                    color: 'var(--text-muted)', cursor: 'pointer',
                                  }}
                                >Cancel</button>
                              </div>
                              {soSearchResults.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                                  {soSearchResults.map((so: any) => {
                                    const alreadyLinked = linkedSos.some(l => l.netsuite_sales_order_id === so.id);
                                    return (
                                      <div
                                        key={so.id}
                                        onClick={() => { if (!alreadyLinked) linkSalesOrder(vehicle.id, so); }}
                                        style={{
                                          padding: '8px 10px', borderRadius: '8px',
                                          cursor: alreadyLinked ? 'default' : 'pointer',
                                          opacity: alreadyLinked ? 0.5 : 1,
                                          background: 'var(--card)', border: '1px solid var(--border)',
                                        }}
                                      >
                                        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                                          SO #{so.sales_order_number}
                                          {alreadyLinked && <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>· already linked</span>}
                                        </div>
                                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                          {so.customer_name} · {so.date} · ${so.total?.toLocaleString() || '0'}
                                        </div>
                                        {so.memo && (
                                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{so.memo}</div>
                                        )}
                                      </div>
                                    );
                                  })}
                                  {soSearchHasMore && !soSearching && (
                                    <button onClick={() => searchSalesOrders(true)} style={{
                                      width: '100%', padding: '8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                                      border: '1px dashed var(--border)', background: 'transparent',
                                      color: 'var(--text-secondary)', cursor: 'pointer',
                                    }}>Load 20 more</button>
                                  )}
                                </div>
                              )}
                              {soSearching && (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>Searching NetSuite...</div>
                              )}
                            </div>
                          ) : (
                            <button
                              onClick={() => setSoSearchOpen(vehicle.id)}
                              style={{
                                width: '100%', padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                background: 'rgba(59,130,246,0.08)', border: '1px dashed rgba(59,130,246,0.3)',
                                color: 'rgb(59,130,246)', cursor: 'pointer',
                              }}
                            >+ {linkedSos.length > 0 ? 'Add Another Sales Order' : 'Link Sales Order'}</button>
                          )}
                        </div>
                      );
                    })()}

                    {/* Proof File (Dropbox) */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                        Proof File
                      </div>
                      {(vehicle as any).proof_url ? (
                        <DropZone
                          onFiles={(files) => uploadProofForVehicle(vehicle.id, files[0])}
                          accept="image/*,application/pdf,.eps,.ai,.psd"
                          multiple={false}
                          style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)' }}>
                          <ProofThumbnail
                            pdfUrl={(vehicle as any).proof_url}
                            dropboxPath={(vehicle as any).proof_dropbox_path || undefined}
                            label={(vehicle as any).proof_filename || 'Proof'}
                            thumbSize={48}
                            expandedSize={300}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <a
                              href={(vehicle as any).proof_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: '12px', fontWeight: 700, color: '#22c55e', textDecoration: 'none' }}
                            >
                              {(vehicle as any).proof_filename || 'View Proof'}
                            </a>
                            {(vehicle as any).proof_dropbox_path && (
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                Dropbox: {(vehicle as any).proof_dropbox_path}
                              </div>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                            <input
                              type="file"
                              id={`proof-replace-${vehicle.id}`}
                              accept="image/*,application/pdf,.eps,.ai,.psd"
                              style={{ display: 'none' }}
                              onChange={async (e) => {
                                const f = e.target.files?.[0];
                                if (f) await uploadProofForVehicle(vehicle.id, f);
                                if (e.target) e.target.value = '';
                              }}
                            />
                            <button
                              onClick={() => document.getElementById(`proof-replace-${vehicle.id}`)?.click()}
                              style={{ padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}
                            >Upload</button>
                            <button
                              onClick={() => {
                                setDbxSearchOpen(vehicle.id);
                                if (vehicle.customer_name) {
                                  setDbxSearchTerm(vehicle.customer_name);
                                  searchDropboxProofs(vehicle.customer_name);
                                }
                              }}
                              style={{ padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}
                            >Dropbox</button>
                            <button
                              onClick={() => removeProofForVehicle(vehicle.id)}
                              style={{ padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'transparent', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', cursor: 'pointer' }}
                            >Remove</button>
                          </div>
                        </DropZone>
                      ) : dbxSearchOpen === vehicle.id ? (
                        <div style={{ padding: '12px', borderRadius: '10px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                          {dbxConnected === false ? (
                            <div style={{ textAlign: 'center', padding: '12px 0' }}>
                              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>Dropbox is not connected yet</div>
                              <button
                                onClick={connectDropbox}
                                style={{ padding: '10px 20px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: '#0061fe', color: '#fff', border: 'none', cursor: 'pointer' }}
                              >Connect Dropbox</button>
                            </div>
                          ) : (
                            <>
                              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>
                                Search Dropbox for Proof
                              </div>
                              <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                                <input
                                  value={dbxSearchTerm}
                                  onChange={(e) => setDbxSearchTerm(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') searchDropboxProofs(); }}
                                  placeholder="Customer or file name..."
                                  autoFocus
                                  style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }}
                                />
                                <button
                                  onClick={() => searchDropboxProofs()}
                                  disabled={dbxSearching || !dbxSearchTerm.trim()}
                                  style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: '#0061fe', color: '#fff', border: 'none', opacity: dbxSearching || !dbxSearchTerm.trim() ? 0.5 : 1, cursor: 'pointer' }}
                                >{dbxSearching ? '...' : 'Search'}</button>
                                <button
                                  onClick={() => { setDbxSearchOpen(null); setDbxSearchTerm(''); setDbxResults([]); }}
                                  style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}
                                >Cancel</button>
                              </div>
                              {dbxSearching && (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>Searching Dropbox...</div>
                              )}
                              {!dbxSearching && dbxResults.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '250px', overflowY: 'auto' }}>
                                  {dbxResults.map((file) => (
                                    <button
                                      key={file.id}
                                      onClick={() => copyProofToR2(vehicle.id, file.path, vehicle.customer_name || '')}
                                      disabled={dbxCopying}
                                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderRadius: '8px', cursor: dbxCopying ? 'wait' : 'pointer', background: 'var(--card)', border: '1px solid var(--border)', textAlign: 'left', width: '100%' }}
                                    >
                                      <ProofThumbnail dropboxPath={file.path} label={file.name} thumbSize={48} expandedSize={280} />
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          {file.folder ? file.folder : file.path} · {(file.size / 1024).toFixed(0)} KB
                                        </div>
                                      </div>
                                      <span style={{ fontSize: '10px', color: '#0061fe', fontWeight: 700, flexShrink: 0 }}>{dbxCopying ? 'Copying...' : 'Use This'}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                              {!dbxSearching && dbxSearchTerm.length >= 2 && dbxResults.length === 0 && (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>No files found in Dropbox</div>
                              )}
                            </>
                          )}
                        </div>
                      ) : (
                        <DropZone
                          onFiles={(files) => uploadProofForVehicle(vehicle.id, files[0])}
                          accept="image/*,application/pdf,.eps,.ai,.psd"
                          multiple={false}
                          style={{ display: 'flex', gap: '6px' }}
                        >
                          <input
                            type="file"
                            id={`proof-add-${vehicle.id}`}
                            accept="image/*,application/pdf,.eps,.ai,.psd"
                            style={{ display: 'none' }}
                            onChange={async (e) => {
                              const f = e.target.files?.[0];
                              if (f) await uploadProofForVehicle(vehicle.id, f);
                              if (e.target) e.target.value = '';
                            }}
                          />
                          <button
                            onClick={() => document.getElementById(`proof-add-${vehicle.id}`)?.click()}
                            style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(34,197,94,0.08)', border: '1px dashed rgba(34,197,94,0.3)', color: '#22c55e', cursor: 'pointer' }}
                          >Upload Proof</button>
                          <button
                            onClick={() => {
                              setDbxSearchOpen(vehicle.id);
                              if (vehicle.customer_name) {
                                setDbxSearchTerm(vehicle.customer_name);
                                searchDropboxProofs(vehicle.customer_name);
                              }
                            }}
                            style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(0,97,254,0.08)', border: '1px dashed rgba(0,97,254,0.3)', color: '#0061fe', cursor: 'pointer' }}
                          >Find in Dropbox</button>
                        </DropZone>
                      )}
                    </div>

                    {/* Completion Photos */}
                    <DropZone
                      onFiles={(files) => handlePhotoFiles(vehicle.id, files)}
                      accept="image/*"
                      disabled={photoUploading}
                      style={{ marginBottom: '12px' }}
                    >
                      {/* Completion prompt banner */}
                      {showCompletionPrompt === vehicle.id && (
                        <div style={{
                          padding: '12px', borderRadius: '10px', marginBottom: '10px',
                          background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)',
                        }}>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: '#22c55e', marginBottom: '4px' }}>
                            Vehicle marked as complete!
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                            Add completion photos to document the finished work. The more photos, the better!
                          </div>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPhotoType('completion');
                                cameraInputRef.current?.click();
                              }}
                              style={{
                                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)',
                                color: '#22c55e', cursor: 'pointer',
                              }}
                            >
                              Take Photos
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPhotoType('completion');
                                photoInputRef.current?.click();
                              }}
                              style={{
                                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)',
                                color: '#22c55e', cursor: 'pointer',
                              }}
                            >
                              From Gallery
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowCompletionPrompt(null);
                              }}
                              style={{
                                padding: '10px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                                color: 'var(--text-muted)', cursor: 'pointer',
                              }}
                            >
                              Skip
                            </button>
                          </div>
                        </div>
                      )}

                      <div style={{
                        fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      }}>
                        <span>Photos {(vehiclePhotos[vehicle.id]?.length || 0) > 0 ? `(${vehiclePhotos[vehicle.id].length})` : ''}</span>
                        {showCompletionPrompt !== vehicle.id && (
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); cameraInputRef.current?.click(); }}
                              disabled={photoUploading}
                              style={{
                                padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                                background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                                color: '#3b82f6', cursor: photoUploading ? 'wait' : 'pointer',
                              }}
                            >
                              Camera
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); photoInputRef.current?.click(); }}
                              disabled={photoUploading}
                              style={{
                                padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                                background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                                color: '#3b82f6', cursor: photoUploading ? 'wait' : 'pointer',
                              }}
                            >
                              Gallery
                            </button>
                          </div>
                        )}
                      </div>

                      {/* What the next uploads are stamped as — Before/During
                          land in the timeline's matching sections; Completion
                          (default) is what the completion gate counts. */}
                      <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }} onClick={(e) => e.stopPropagation()}>
                        {([['before', 'Before'], ['during', 'During'], ['completion', 'Completion']] as const).map(([key, label]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setPhotoType(key)}
                            style={{
                              flex: 1, padding: '5px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                              background: photoType === key ? 'rgba(59,130,246,0.15)' : 'var(--subtle-bg)',
                              border: `1px solid ${photoType === key ? 'rgba(59,130,246,0.4)' : 'var(--border)'}`,
                              color: photoType === key ? '#3b82f6' : 'var(--text-muted)',
                              cursor: 'pointer',
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>

                      {/* Hidden file inputs */}
                      <input
                        ref={cameraInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        multiple
                        style={{ display: 'none' }}
                        onChange={async (e) => {
                          const hadFiles = !!(e.target.files && e.target.files.length);
                          await handlePhotoFiles(vehicle.id, e.target.files);
                          e.target.value = '';
                          // Mobile camera capture is single-shot; re-open it so
                          // the installer keeps shooting until they cancel.
                          if (hadFiles) cameraInputRef.current?.click();
                        }}
                      />
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(e) => { handlePhotoFiles(vehicle.id, e.target.files); e.target.value = ''; }}
                      />

                      {/* Upload progress */}
                      {photoUploading && (
                        <div style={{
                          padding: '10px', borderRadius: '8px', marginBottom: '8px',
                          background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                          fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'center',
                        }}>
                          Uploading photo...
                        </div>
                      )}

                      {/* Photo grid */}
                      {photosLoading[vehicle.id] ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading photos...</div>
                      ) : (vehiclePhotos[vehicle.id]?.length || 0) === 0 ? (
                        <div style={{
                          fontSize: '12px', color: 'var(--text-muted)', padding: '16px',
                          textAlign: 'center', borderRadius: '8px',
                          background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                        }}>
                          No photos yet — add photos to document the work
                        </div>
                      ) : (
                        <div style={{
                          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px',
                        }}>
                          {vehiclePhotos[vehicle.id].map(photo => (
                            <div key={photo.id} style={{ position: 'relative' }}>
                              <div style={{
                                paddingTop: '100%', position: 'relative', borderRadius: '8px',
                                overflow: 'hidden', background: 'var(--subtle-bg)',
                              }}>
                                <img
                                  src={photo.url}
                                  alt="Completion photo"
                                  style={{
                                    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                                    objectFit: 'cover',
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    window.open(photo.url, '_blank');
                                  }}
                                />
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deletePhoto(vehicle.id, photo.id, photo.storage_path);
                                }}
                                style={{
                                  position: 'absolute', top: '4px', right: '4px',
                                  width: '22px', height: '22px', borderRadius: '50%',
                                  background: 'rgba(0,0,0,0.6)', border: 'none',
                                  color: '#fff', fontSize: '12px', cursor: 'pointer',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                }}
                              >
                                ×
                              </button>
                              <div style={{
                                fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px', textAlign: 'center',
                              }}>
                                {new Date(photo.taken_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </DropZone>

                    {/* Photo Timeline — unified check-in / during / completion / design files / proofs */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                        Photo Timeline
                      </div>
                      <VehiclePhotoTimeline
                        vin={vehicle.vin}
                        variant="internal"
                        refreshKey={vehiclePhotos[vehicle.id]?.length || 0}
                      />
                    </div>

                    {/* Installer Assignment */}
                    {isAdmin && (
                      <div style={{ marginBottom: '12px' }}>
                        <AssignmentPicker
                          jobType="scanned_vehicle"
                          jobId={vehicle.id}
                          selectedIds={vehicleAssignments[vehicle.id] || []}
                          onChange={(ids) => saveAssignments(vehicle.id, ids)}
                          roles={['installer', 'admin']}
                          label="Assigned Installers"
                        />
                      </div>
                    )}

                    {/* Install Notes */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{
                        fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px',
                      }}>
                        Install Notes {(vehicleNotes[vehicle.id]?.length || 0) > 0 ? `(${vehicleNotes[vehicle.id].length})` : ''}
                      </div>

                      {/* Add note input — @mention a teammate to ping them */}
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }} onClick={(e) => e.stopPropagation()}>
                        <MentionTextArea
                          value={noteInput[vehicle.id] || ''}
                          onChange={(v) => setNoteInput(prev => ({ ...prev, [vehicle.id]: v }))}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !noteSaving) { e.preventDefault(); addNote(vehicle.id); } }}
                          placeholder="Add a note... @name to tag a teammate"
                          style={{
                            flex: 1, padding: '8px 10px', borderRadius: '8px',
                            border: '1px solid var(--border)', background: 'var(--input-bg)',
                            color: 'var(--text-primary)', fontSize: '12px',
                          }}
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); addNote(vehicle.id); }}
                          disabled={noteSaving || !(noteInput[vehicle.id] || '').trim()}
                          style={{
                            padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                            background: (noteInput[vehicle.id] || '').trim() ? 'rgba(59,130,246,0.15)' : 'var(--subtle-bg)',
                            border: `1px solid ${(noteInput[vehicle.id] || '').trim() ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
                            color: (noteInput[vehicle.id] || '').trim() ? '#3b82f6' : 'var(--text-muted)',
                            cursor: noteSaving || !(noteInput[vehicle.id] || '').trim() ? 'default' : 'pointer',
                          }}
                        >
                          {noteSaving ? '...' : 'Add'}
                        </button>
                      </div>

                      {/* Notes list */}
                      {notesLoading[vehicle.id] ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading notes...</div>
                      ) : (vehicleNotes[vehicle.id]?.length || 0) === 0 ? (
                        <div style={{
                          fontSize: '12px', color: 'var(--text-muted)', padding: '12px',
                          textAlign: 'center', borderRadius: '8px',
                          background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                        }}>
                          No install notes yet
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {vehicleNotes[vehicle.id].map(n => (
                            <div key={n.id} id={`vnote-${n.id}`} style={{
                              padding: '8px 10px', borderRadius: '8px',
                              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                            }}>
                              <div style={{ fontSize: '12px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                {n.note}
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                                  {n.created_by_name} · {new Date(n.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                </div>
                                {n.created_by === user?.id && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); deleteNote(vehicle.id, n.id); }}
                                    style={{
                                      fontSize: '10px', color: 'var(--text-muted)', background: 'none',
                                      border: 'none', cursor: 'pointer', padding: '2px 4px',
                                    }}
                                  >
                                    Delete
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* QC Checklist (read-only) */}
                    <div style={{ marginBottom: '12px' }}>
                      {(() => {
                        const tasks = vehicleTasks[vehicle.id] || [];
                        const loadingTasks = !!tasksLoading[vehicle.id];
                        const done = tasks.filter(t => t.completed).length;
                        return (
                          <>
                            <div style={{
                              fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
                              textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px',
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            }}>
                              <span>QC Checklist {tasks.length > 0 ? `· ${done}/${tasks.length} done` : ''}</span>
                            </div>
                            {loadingTasks ? (
                              <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading checklist…</div>
                            ) : tasks.length === 0 ? (
                              <div style={{
                                fontSize: '12px', color: 'var(--text-muted)', padding: '12px',
                                textAlign: 'center', borderRadius: '8px',
                                background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                              }}>
                                No checklist for this vehicle yet — it's instantiated when status moves to In Progress.
                              </div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {tasks.map(t => (
                                  <div key={t.id} style={{
                                    padding: '8px 10px', borderRadius: '8px',
                                    border: `1px solid ${t.completed ? 'rgba(34,197,94,0.4)' : 'var(--border)'}`,
                                    background: 'var(--subtle-bg)',
                                  }}>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                                      <div style={{
                                        flexShrink: 0, width: '16px', height: '16px', borderRadius: '4px',
                                        marginTop: '1px',
                                        background: t.completed ? '#22c55e' : 'transparent',
                                        border: `1.5px solid ${t.completed ? '#22c55e' : 'var(--border)'}`,
                                        color: '#fff', fontSize: '11px', fontWeight: 800,
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      }}>
                                        {t.completed ? '✓' : ''}
                                      </div>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                                          {t.required && <span style={{ color: 'var(--danger, #ef4444)', marginRight: '4px' }}>*</span>}
                                          {t.label}
                                        </div>
                                        {t.completed && (t.completed_by_name || t.completed_at) && (
                                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                                            {t.completed_by_name || 'Unknown'}
                                            {t.completed_at && ` · ${new Date(t.completed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>

                    {/* Status History */}
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                        Status History
                      </div>
                      {historyLoading ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading...</div>
                      ) : statusHistory.length === 0 ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>No status changes recorded yet</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {statusHistory.map(h => (
                            <div key={h.id} style={{
                              padding: '8px 10px', borderRadius: '8px',
                              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                                  {h.from_status && (
                                    <>
                                      <span style={{ color: 'var(--text-muted)' }}>
                                        {h.from_status.startsWith('graphics:')
                                          ? `Graphics: ${GRAPHICS_INSTALL_LABELS[h.from_status.slice('graphics:'.length) as GraphicsInstallStatus] || h.from_status.slice('graphics:'.length)}`
                                          : VEHICLE_STATUS_LABELS[h.from_status as VehicleTrackingStatus] || h.from_status}
                                      </span>
                                      <span style={{ color: 'var(--text-muted)' }}>→</span>
                                    </>
                                  )}
                                  <StatusBadge status={h.to_status} size="sm" />
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                                  {timeAgo(h.created_at)}
                                </div>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                  {h.changed_by_name || 'Unknown'}
                                </div>
                                {h.note && (
                                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                                    {h.note}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Archive & Delete Actions */}
                    {isAdmin && (
                      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                        {(vehicle as any).archived_at ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); archiveVehicle(vehicle.id, true); }}
                            disabled={archivingId === vehicle.id}
                            style={{
                              flex: 1, padding: '10px', borderRadius: '10px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                              background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)',
                            }}
                          >
                            {archivingId === vehicle.id ? 'Restoring...' : 'Restore from Archive'}
                          </button>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); archiveVehicle(vehicle.id); }}
                            disabled={archivingId === vehicle.id}
                            style={{
                              flex: 1, padding: '10px', borderRadius: '10px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                              background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)',
                            }}
                          >
                            {archivingId === vehicle.id ? 'Archiving...' : 'Archive Vehicle'}
                          </button>
                        )}
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (await dialog.confirm(`Permanently delete this vehicle (${vehicle.vin})? This cannot be undone.`, { destructive: true, confirmLabel: 'Delete' })) {
                              deleteVehicle(vehicle.id);
                            }
                          }}
                          disabled={deletingId === vehicle.id}
                          style={{
                            padding: '10px 16px', borderRadius: '10px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                            background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171',
                          }}
                        >
                          {deletingId === vehicle.id ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    )}
                      </div>{/* end modal padding wrapper */}
                    </div>{/* end modal */}
                  </>
                )}
              </div>
            );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {hasMore && !searchTerm && !showArchived && (
            <button
              onClick={() => loadVehicles(true)}
              disabled={loadingMore}
              style={{
                width: '100%', padding: '14px', borderRadius: '10px', marginTop: '8px',
                fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                color: loadingMore ? 'var(--text-muted)' : '#60a5fa',
              }}
            >
              {loadingMore ? 'Loading...' : `Load More Vehicles (${activeVehicles.length}${totalCount !== null ? ` of ${totalCount}` : ''} loaded)`}
            </button>
          )}
        </div>
      )}

      {completionModalVehicleId && (() => {
        const v = vehicles.find(x => x.id === completionModalVehicleId);
        if (!v) return null;
        const proofName = (v.proof_file_name || v.proof_file_path || '').toLowerCase();
        return (
          <CompletionModal
            vehicleId={v.id}
            vehicleVin={v.vin}
            vehicleLabel={[v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle'}
            customerName={v.customer_name}
            netsuiteSalesOrderId={v.netsuite_sales_order_id}
            proofUrl={(v as any).proof_url || null}
            proofIsPdf={proofName.endsWith('.pdf')}
            graphicsFiles={[]}
            isAdmin={!!isAdmin}
            salesOrders={(vehicleSalesOrders[v.id] || []).map(so => ({ netsuite_sales_order_id: so.netsuite_sales_order_id, sales_order_number: so.sales_order_number }))}
            sourceEstimateId={(v as any).source_estimate_id || null}
            invoiceNumber={(v as any).invoice_number || null}
            onInvoiced={() => loadVehicles()}
            onClose={() => setCompletionModalVehicleId(null)}
            onComplete={() => {
              setCompletionModalVehicleId(null);
              loadVehicles();
              if (expandedId) {
                loadHistory(expandedId);
                loadTasks(expandedId);
              }
            }}
          />
        );
      })()}
    </div>
  );
}
