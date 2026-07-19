'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePopout } from '@/components/Popout';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { DropZone } from '@/components/DropZone';
import { createClient } from '@/lib/supabase-browser';
import { decodeVIN, isValidVIN } from '@/lib/vin-decoder';
import VinScanner from '@/components/VinScanner';
import { theme } from '@/lib/theme';
import { storage } from '@/lib/storage';
import { firstGraphicsMatch } from '@/lib/graphics-detection';
import type { NetsuiteSalesOrder, GraphicsProof, FleetCheckin, VehicleTrackingStatus } from '@/lib/types';
import { VEHICLE_STATUS_PIPELINE, VEHICLE_STATUS_LABELS, VEHICLE_STATUS_COLORS } from '@/lib/types';
import NetSuitePdf from '@/components/NetSuitePdf';
import ProofThumbnail from '@/components/ProofThumbnail';

// ─── Step indicator ────────────────────────────────────────────
function StepIndicator({ current }: { current: number }) {
  const steps = ['VIN', 'Sales Order', 'Proof'];
  return (
    <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
      {steps.map((label, i) => (
        <div key={label} style={{ flex: 1, textAlign: 'center' }}>
          <div style={{
            height: '4px', borderRadius: '2px', marginBottom: '4px',
            background: i <= current ? theme.orange : theme.border,
            transition: 'background 0.2s ease',
          }} />
          <div style={{
            fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
            color: i === current ? theme.textPrimary : theme.textMuted,
          }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Vehicle Check-In wizard ───────────────────────────────────
// Extracted from the old /fleet page so it can live at the top of the
// In-Shop page (and anywhere else). onCheckedIn fires after a successful
// save so the host page can refresh its vehicle list.
export default function VehicleCheckIn({ onCheckedIn }: { onCheckedIn?: () => void }) {
  const { user, profile } = useAuth();
  const router = useRouter();
  const { open: openPopout } = usePopout();
  const supabase = createClient();
  const dialog = useDialog();

  // Workflow state
  const [step, setStep] = useState(0);

  // Step 1: VIN
  const [vin, setVin] = useState('');
  const [vinLoading, setVinLoading] = useState(false);
  const [vinError, setVinError] = useState('');
  const [vehicleData, setVehicleData] = useState<any>(null);
  const [mode, setMode] = useState<'camera' | 'text'>('text');
  const inputRef = useRef<HTMLInputElement>(null);

  // Step 2: Sales Order
  const [customerSearch, setCustomerSearch] = useState('');
  const [salesOrders, setSalesOrders] = useState<NetsuiteSalesOrder[]>([]);
  const [soLoading, setSoLoading] = useState(false);
  const [soError, setSoError] = useState('');
  // One vehicle can be checked in against multiple NetSuite sales orders.
  // selectedOrder (below, derived) keeps the "primary" — the first one
  // picked — so existing code paths (context snapshot, legacy column
  // mirror, customer/graphics matching) keep working unchanged.
  const [selectedOrders, setSelectedOrders] = useState<NetsuiteSalesOrder[]>([]);
  const selectedOrder = selectedOrders[0] || null;
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);

  // Step 3: Proof
  const [proofs, setProofs] = useState<GraphicsProof[]>([]);
  const [proofLoading, setProofLoading] = useState(false);
  const [selectedProof, setSelectedProof] = useState<GraphicsProof | null>(null);
  const [proofSearch, setProofSearch] = useState('');
  const [uploadingProof, setUploadingProof] = useState(false);
  const uploadProofInputRef = useRef<HTMLInputElement>(null);
  // URL for the directly-uploaded proof so we can mirror to proof_url on
  // save (the tracking page expanded view reads proof_url, not the
  // legacy proof_file_path).
  const [uploadedProofUrl, setUploadedProofUrl] = useState<string | null>(null);

  // Dropbox proof search
  const [dbxResults, setDbxResults] = useState<{ id: string; name: string; path: string; size: number; modified: string; folder: string }[]>([]);
  const [dbxSearching, setDbxSearching] = useState(false);
  const [dbxSelected, setDbxSelected] = useState<{ name: string; path: string } | null>(null);
  const [dbxConnected, setDbxConnected] = useState<boolean | null>(null);

  // Final
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [savedCheckin, setSavedCheckin] = useState<FleetCheckin | null>(null);
  const [notes, setNotes] = useState('');
  const [manualCustomerName, setManualCustomerName] = useState('');
  const [scheduledUpfitDate, setScheduledUpfitDate] = useState('');
  const [promisedBackDate, setPromisedBackDate] = useState('');

  // Duplicate vehicle found
  const [duplicateVehicle, setDuplicateVehicle] = useState<any>(null);
  const [updatingDupStatus, setUpdatingDupStatus] = useState(false);

  // Recent check-ins
  const [recentCheckins, setRecentCheckins] = useState<FleetCheckin[]>([]);
  const [showRecent, setShowRecent] = useState(false);

  // Partial VIN lookup (last-8 handling)
  const [partialVinMatches, setPartialVinMatches] = useState<Array<{
    vin: string;
    customerName: string | null;
    source: 'fleet_checkin' | 'scan_log';
    vehicleDescription: string | null;
    lastSeenAt: string | null;
  }>>([]);

  // Prefilled on "Check in another for same customer" or "Clone" — keeps the
  // shared job config while resetting only the VIN.
  const [keepingContext, setKeepingContext] = useState(false);

  useEffect(() => {
    if (mode === 'text' && inputRef.current) inputRef.current.focus();
  }, [mode]);

  useEffect(() => {
    loadRecentCheckins();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, []);

  const loadRecentCheckins = async () => {
    const { data } = await supabase
      .from('fleet_checkins')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    if (data) setRecentCheckins(data);
  };

  // ─── Camera / Scanner ──────────────────────────────────────
  const handleCameraScan = (scannedVin: string) => {
    setVin(scannedVin);
    handleDecodeVin(scannedVin);
  };

  const switchToCamera = () => { setMode('camera'); };
  const switchToText = () => { setMode('text'); };

  // ─── Step 1: VIN Decode ────────────────────────────────────
  const handleDecodeVin = async (v: string) => {
    setVinError('');
    setVinLoading(true);
    try {
      // Check for duplicate VIN in fleet_checkins
      const { data: existing } = await supabase
        .from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, sales_order_number, status, created_at')
        .eq('vin', v)
        .limit(1);
      if (existing && existing.length > 0) {
        setDuplicateVehicle(existing[0]);
        setVinError(`Duplicate VIN — this vehicle is already checked in (${new Date(existing[0].created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}). Update its status below or scan a different VIN.`);
        setVinLoading(false);
        return;
      }
      setDuplicateVehicle(null);
      const vehicle = await decodeVIN(v);
      setVehicleData({ vin: v, vehicle });
      setStep(1);
      // Pre-fill customer search if we find a matching sales order by VIN
    } catch {
      setVinError('Failed to decode VIN.');
    }
    setVinLoading(false);
  };

  const handleVinSubmit = async () => {
    const v = vin.trim().toUpperCase();
    if (v.length === 17) {
      if (!isValidVIN(v)) { setVinError('Invalid VIN format.'); return; }
      setPartialVinMatches([]);
      handleDecodeVin(v);
      return;
    }
    if (v.length < 8) {
      setVinError('Enter at least the last 8 characters of the VIN.');
      return;
    }
    // Partial (8-16 chars) — look up prior full VINs
    setVinError('');
    setVinLoading(true);
    setPartialVinMatches([]);
    try {
      const customer = selectedOrder?.customer_name || manualCustomerName.trim();
      const qs = new URLSearchParams({ partial: v });
      if (customer) qs.set('customer', customer);
      const res = await fetch(`/api/fleet/lookup-vin?${qs.toString()}`);
      const data = await res.json();
      const matches = (data.matches || []) as typeof partialVinMatches;
      if (matches.length === 1) {
        // Unique hit — auto-complete
        const full = matches[0].vin;
        setVin(full);
        setVinLoading(false);
        handleDecodeVin(full);
        return;
      }
      if (matches.length === 0) {
        setVinError(
          `No prior VIN ending in "${v}" found${customer ? ` for ${customer}` : ''}. Please enter the full 17-character VIN.`
        );
      } else {
        setPartialVinMatches(matches);
      }
    } catch {
      setVinError('Failed to look up partial VIN. Please enter the full 17-character VIN.');
    }
    setVinLoading(false);
  };

  const selectPartialMatch = (fullVin: string) => {
    setVin(fullVin);
    setPartialVinMatches([]);
    handleDecodeVin(fullVin);
  };

  // ─── Step 2: Sales Order Search ────────────────────────────
  const searchSalesOrders = async () => {
    if (!customerSearch.trim()) return;
    setSoLoading(true);
    setSoError('');
    setSalesOrders([]);
    try {
      const res = await fetch(`/api/netsuite/sales-orders?customer=${encodeURIComponent(customerSearch.trim())}`);
      const data = await res.json();
      if (data.found && data.data) {
        setSalesOrders(data.data);
      } else {
        setSoError(data.error || 'No sales orders found.');
      }
    } catch (e: any) {
      setSoError('Failed to search sales orders.');
    }
    setSoLoading(false);
  };

  const toggleSalesOrder = (order: NetsuiteSalesOrder) => {
    setSelectedOrders(prev => {
      const exists = prev.some(o => o.id === order.id);
      return exists ? prev.filter(o => o.id !== order.id) : [...prev, order];
    });
  };

  // Advance to the proof step using the currently selected SOs. The first
  // selected order drives the proof / Dropbox search (its customer name).
  const continueWithSelectedOrders = () => {
    const first = selectedOrders[0];
    setStep(2);
    if (first?.customer_name) {
      setProofSearch(first.customer_name);
      loadProofs(first.customer_name);
      searchDropbox(first.customer_name);
    } else {
      setProofSearch('');
      loadProofs('');
    }
  };

  const skipSalesOrder = () => {
    setSelectedOrders([]);
    setStep(2);
    setProofSearch('');
    loadProofs('');
    setDbxResults([]);
    setDbxSelected(null);
  };

  // ─── Dropbox Proof Search ─────────────────────────────────
  const searchDropbox = async (term: string) => {
    if (!term || term.length < 2) return;
    setDbxSearching(true);
    setDbxResults([]);
    try {
      const res = await fetch(`/api/dropbox/search?q=${encodeURIComponent(term)}`);
      const data = await res.json();
      if (data.connected === false) {
        setDbxConnected(false);
      } else {
        setDbxConnected(true);
        setDbxResults(data.results || []);
      }
    } catch { /* ignore */ }
    setDbxSearching(false);
  };

  // ─── Step 3: Proof Selection ───────────────────────────────
  const loadProofs = async (customerName: string) => {
    setProofLoading(true);
    let query = supabase
      .from('graphics_proofs')
      .select('*')
      .in('sync_status', ['synced', 'manual'])
      .order('created_at', { ascending: false });

    if (customerName) {
      query = query.ilike('customer_name', `%${customerName}%`);
    }

    const { data } = await query.limit(50);
    setProofs(data || []);
    setProofLoading(false);
  };

  const selectProof = (proof: GraphicsProof) => {
    setSelectedProof(proof);
    setUploadedProofUrl(null);
    setDbxSelected(null);
  };

  // Direct file upload: writes to R2 under the graphics-proofs bucket and
  // sets selectedProof to a synthetic shape so the save handler picks it
  // up the same way as a Supabase-side GraphicsProof match.
  const uploadProofFromDevice = async (file: File) => {
    setUploadingProof(true);
    try {
      const ext = file.name.split('.').pop() || 'bin';
      const path = `manual-uploads/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const { error } = await storage.from('graphics-proofs').upload(path, file, { contentType: file.type });
      if (error) {
        await dialog.alert('Upload failed: ' + (error.message || 'unknown error'));
        setUploadingProof(false);
        return;
      }
      const { data: urlData } = storage.from('graphics-proofs').getPublicUrl(path);
      setSelectedProof({
        id: `uploaded-${Date.now()}`,
        file_name: file.name,
        storage_path: path,
        customer_name: selectedOrder?.customer_name || manualCustomerName.trim() || null,
        vehicle_type: null,
      } as any);
      setUploadedProofUrl(urlData?.publicUrl || null);
      setDbxSelected(null);
    } catch (err: any) {
      await dialog.alert('Upload failed: ' + (err?.message || String(err)));
    }
    setUploadingProof(false);
  };

  const removeSelectedProof = () => {
    setSelectedProof(null);
    setDbxSelected(null);
    setUploadedProofUrl(null);
  };

  // ─── Save Check-In ────────────────────────────────────────
  const handleSave = async () => {
    setSaveError(null);
    if (!vehicleData) {
      setSaveError('No vehicle data loaded — go back and re-enter the VIN.');
      return;
    }
    if (!user) {
      setSaveError('You appear to be signed out. Please refresh and sign in again.');
      return;
    }
    setSaving(true);
    try {

    // Snapshot install context (T1.6) from the originating estimate if
    // one is linked to this sales order. Falls back to customers.delivery_instructions
    // when an estimate isn't available.
    let contextSnapshot: {
      install_instructions: string | null;
      on_site_contact_name: string | null;
      on_site_contact_phone: string | null;
      delivery_preferences: string | null;
      source_estimate_id: string | null;
    } = {
      install_instructions: null,
      on_site_contact_name: null,
      on_site_contact_phone: null,
      delivery_preferences: null,
      source_estimate_id: null,
    };

    if (selectedOrder?.id) {
      const { data: est } = await supabase
        .from('estimates')
        .select('id, install_instructions, on_site_contact_name, on_site_contact_phone, delivery_preferences')
        .eq('netsuite_so_id', selectedOrder.id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (est) {
        contextSnapshot = {
          install_instructions: est.install_instructions || null,
          on_site_contact_name: est.on_site_contact_name || null,
          on_site_contact_phone: est.on_site_contact_phone || null,
          delivery_preferences: est.delivery_preferences || null,
          source_estimate_id: est.id,
        };
      }
    }

    if (!contextSnapshot.install_instructions && (selectedOrder?.customer_name || manualCustomerName.trim())) {
      const custName = selectedOrder?.customer_name || manualCustomerName.trim();
      const { data: customer } = await supabase
        .from('customers')
        .select('delivery_instructions')
        .ilike('company_name', custName)
        .maybeSingle();
      if (customer?.delivery_instructions) {
        contextSnapshot.install_instructions = customer.delivery_instructions;
      }
    }

    // Scan SO line items + (if linked) estimate line items for graphics
    // keywords. graphics_signal stores the first matched description so
    // the inline prompt and queue tab can show *why* the flag fired.
    let graphicsSignal: string | null = null;
    const soLines = selectedOrders.flatMap(o => o.line_items || []);
    graphicsSignal = firstGraphicsMatch(soLines);
    if (!graphicsSignal && contextSnapshot.source_estimate_id) {
      const { data: estLines } = await supabase
        .from('estimate_line_items')
        .select('item_number, description')
        .eq('estimate_id', contextSnapshot.source_estimate_id);
      graphicsSignal = firstGraphicsMatch(estLines || []);
    }

    const { data, error } = await supabase
      .from('fleet_checkins')
      .insert({
        vin: vehicleData.vin,
        vehicle_year: vehicleData.vehicle.year || null,
        vehicle_make: vehicleData.vehicle.make || null,
        vehicle_model: vehicleData.vehicle.model || null,
        vehicle_trim: vehicleData.vehicle.trim || null,
        body_class: vehicleData.vehicle.bodyClass || null,
        netsuite_sales_order_id: selectedOrder?.id || null,
        sales_order_number: selectedOrder?.sales_order_number || null,
        customer_name: selectedOrder?.customer_name || manualCustomerName.trim() || null,
        sales_order_memo: selectedOrder?.memo || null,
        sales_order_total: selectedOrder?.total || null,
        proof_file_path: selectedProof?.storage_path || null,
        proof_file_name: selectedProof?.file_name || null,
        proof_dropbox_path: dbxSelected?.path || null,
        // A directly-uploaded proof needs proof_url/proof_filename set so
        // the tracking page (which reads those columns) shows it. Fall
        // back to dbxSelected for Dropbox-sourced proofs (existing flow).
        proof_url: uploadedProofUrl || null,
        proof_filename: uploadedProofUrl ? (selectedProof?.file_name || null) : (dbxSelected?.name || null),
        notes: notes.trim() || null,
        status: 'received',
        checked_in_by: user.id,
        company_id: profile?.company_id || null,
        scheduled_upfit_date: scheduledUpfitDate || null,
        promised_back_date: promisedBackDate || null,
        install_instructions: contextSnapshot.install_instructions,
        on_site_contact_name: contextSnapshot.on_site_contact_name,
        on_site_contact_phone: contextSnapshot.on_site_contact_phone,
        delivery_preferences: contextSnapshot.delivery_preferences,
        source_estimate_id: contextSnapshot.source_estimate_id,
        needs_graphics: !!graphicsSignal,
        graphics_signal: graphicsSignal,
      })
      .select()
      .single();

    if (error) {
      console.error('[fleet check-in] insert failed:', error);
      setSaveError(`Failed to save check-in: ${error.message || 'Unknown error'}${error.code ? ` (${error.code})` : ''}`);
      setSaving(false);
      return;
    }

    // Persist every selected SO into the join table so multi-SO check-ins
    // round-trip correctly. The first one is already mirrored into the
    // legacy columns above; we still insert it here so the join table is
    // the single source of truth for the tracking page list.
    if (data?.id && selectedOrders.length > 0) {
      const rows = selectedOrders.map(o => ({
        checkin_id: data.id,
        netsuite_sales_order_id: o.id,
        sales_order_number: o.sales_order_number,
        customer_name: o.customer_name,
        sales_order_memo: o.memo || null,
        sales_order_total: o.total || null,
        added_by: user.id,
      }));
      const { error: linkErr } = await supabase
        .from('fleet_checkin_sales_orders')
        .insert(rows);
      if (linkErr) console.error('Failed to link additional sales orders:', linkErr);
    }

    // Auto-match graphics job by customer name. The linkage lives on
    // fleet_checkins.matched_graphics_job_id; graphics_jobs has no
    // matched_vehicle_id column (an earlier filter referencing it caused
    // a 400 from PostgREST). Allow same graphics_job to match multiple
    // checkins — appropriate for fleet customers where one design covers
    // many vehicles.
    if (data?.id && (selectedOrder?.customer_name || manualCustomerName.trim())) {
      const custName = selectedOrder?.customer_name || manualCustomerName.trim();
      const { data: matchedJob } = await supabase
        .from('graphics_jobs')
        .select('id')
        .ilike('customer', `%${custName}%`)
        .not('status', 'in', '("installed","cancelled")')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (matchedJob) {
        await supabase.from('fleet_checkins').update({ matched_graphics_job_id: matchedJob.id }).eq('id', data.id);
      }
    }

    // Sync upfit date to Google Calendar
    if (data?.id && scheduledUpfitDate) {
      fetch('/api/calendar/sync-upfit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkinId: data.id }),
      }).catch(() => {});
    }

    // If a Dropbox proof was selected, copy it to R2 in the background
    if (dbxSelected && data?.id) {
      fetch('/api/dropbox/copy-to-r2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dropbox_path: dbxSelected.path,
          vehicle_id: data.id,
          customer_name: selectedOrder?.customer_name || manualCustomerName.trim() || '',
        }),
      }).catch(() => {}); // fire-and-forget — proof will be linked async
    }

    setSavedCheckin(data);
    setSaved(true);
    setSaving(false);
    loadRecentCheckins();
    onCheckedIn?.();
    } catch (e: any) {
      console.error('[fleet check-in] unexpected error during save:', e);
      setSaveError(`Unexpected error: ${e?.message || String(e)}`);
      setSaving(false);
    }
  };

  // ─── Reset ────────────────────────────────────────────────
  const resetAll = () => {
    setStep(0);
    setVin('');
    setVinError('');
    setSaveError(null);
    setVehicleData(null);
    setCustomerSearch('');
    setSalesOrders([]);
    setSoError('');
    setSelectedOrders([]);
    setExpandedOrder(null);
    setProofs([]);
    setSelectedProof(null);
    setDbxResults([]);
    setDbxSelected(null);
    setSaved(false);
    setSavedCheckin(null);
    setNotes('');
    setScheduledUpfitDate('');
    setPromisedBackDate('');
    setManualCustomerName('');
    setKeepingContext(false);
    setPartialVinMatches([]);
    setMode('text');
  };

  // ─── Check in another for same customer ──────────────────
  // Resets VIN-only state while keeping customer / sales order / proof /
  // scheduled date / notes. Jumps back to step 0 so the user can scan or
  // enter the next VIN without re-picking shared context.
  const checkInAnotherSameCustomer = () => {
    setStep(0);
    setVin('');
    setVinError('');
    setSaveError(null);
    setVehicleData(null);
    setDuplicateVehicle(null);
    setPartialVinMatches([]);
    setSaved(false);
    setSavedCheckin(null);
    // Intentionally preserved: selectedOrder, manualCustomerName, customerSearch,
    // selectedProof, dbxSelected, scheduledUpfitDate, notes.
    setKeepingContext(true);
    setMode('text');
  };

  // ─── Clone a prior check-in's context ─────────────────────
  // Pre-populates customer search + sales order + proof + scheduled date from
  // a prior check-in, then lands the user on step 0 to enter a fresh VIN.
  const cloneFromCheckin = async (ci: FleetCheckin) => {
    setStep(0);
    setVin('');
    setVinError('');
    setVehicleData(null);
    setDuplicateVehicle(null);
    setPartialVinMatches([]);
    setSaved(false);
    setSavedCheckin(null);

    setCustomerSearch(ci.customer_name || '');
    setManualCustomerName(ci.customer_name || '');
    setScheduledUpfitDate(ci.scheduled_upfit_date || '');
    setPromisedBackDate((ci as any).promised_back_date || '');
    setNotes('');

    // Reconstruct selectedOrders from the join table so every linked SO
    // is preserved, not just the legacy single-SO mirror.
    const { data: linkedSos } = await supabase
      .from('fleet_checkin_sales_orders')
      .select('netsuite_sales_order_id, sales_order_number, customer_name, sales_order_memo, sales_order_total')
      .eq('checkin_id', ci.id)
      .order('added_at', { ascending: true });
    if (linkedSos && linkedSos.length > 0) {
      setSelectedOrders(linkedSos.map((r: any) => ({
        id: r.netsuite_sales_order_id,
        sales_order_number: r.sales_order_number,
        customer_name: r.customer_name || '',
        memo: r.sales_order_memo || '',
        total: r.sales_order_total || 0,
        status: null,
        date: null,
        line_items: [],
      })) as any);
    } else if (ci.netsuite_sales_order_id && ci.sales_order_number) {
      // Fallback for check-ins not yet backfilled into the join table.
      setSelectedOrders([{
        id: ci.netsuite_sales_order_id,
        sales_order_number: ci.sales_order_number,
        customer_name: ci.customer_name || '',
        memo: ci.sales_order_memo || '',
        total: ci.sales_order_total || 0,
        status: null,
        date: null,
        line_items: [],
      } as any]);
    } else {
      setSelectedOrders([]);
    }

    // Restore proof selection (Supabase or Dropbox).
    if (ci.proof_file_path) {
      setSelectedProof({
        id: '',
        customer_name: ci.customer_name || '',
        vehicle_type: null,
        file_name: ci.proof_file_name || '',
        storage_path: ci.proof_file_path,
        thumbnail_path: ci.proof_thumbnail_path || null,
        file_size: null,
        file_type: null,
      } as any);
    } else {
      setSelectedProof(null);
    }
    if ((ci as any).proof_dropbox_path) {
      setDbxSelected({
        name: (ci as any).proof_filename || '',
        path: (ci as any).proof_dropbox_path,
      });
    } else {
      setDbxSelected(null);
    }

    setKeepingContext(true);
    setShowRecent(false);
    setMode('text');
  };

  // ─── Status Helpers ───────────────────────────────────────
  const statusMap: Record<string, string> = {
    A: 'Pending Approval', B: 'Pending Fulfillment', D: 'Partially Fulfilled',
    E: 'Pending Billing/Partially Fulfilled', F: 'Pending Billing',
  };

  const vehicleTitle = vehicleData
    ? [vehicleData.vehicle.year, vehicleData.vehicle.make, vehicleData.vehicle.model].filter(Boolean).join(' ')
    : '';

  // ═══════════════════════════════════════════════════════════
  // SAVED CONFIRMATION
  // ═══════════════════════════════════════════════════════════
  if (saved && savedCheckin) {
    return (
      <div>
        <div style={{ textAlign: 'center', padding: '28px 0' }}>
          <div style={{
            width: '64px', height: '64px', borderRadius: '50%', background: theme.successBg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 14px', fontSize: '30px', color: theme.success,
          }}>OK</div>
          <div style={{ fontSize: '18px', fontWeight: 800 }}>Vehicle Checked In</div>
          <div style={{ color: theme.textSecondary, fontSize: '13px', marginTop: '4px' }}>{vehicleTitle}</div>
          <div style={{ fontFamily: 'monospace', fontSize: '11px', color: theme.textMuted }}>{savedCheckin.vin}</div>
          {savedCheckin.sales_order_number ? (
            <div style={{
              marginTop: '8px', padding: '8px 12px', background: theme.successBg,
              border: `1px solid ${theme.successBorder}`, borderRadius: '10px',
              color: theme.success, fontSize: '12px', fontWeight: 700,
            }}>
              SO #{savedCheckin.sales_order_number} — {savedCheckin.customer_name}
              {selectedOrders.length > 1 && (
                <span style={{ marginLeft: '6px', fontWeight: 600, opacity: 0.85 }}>
                  +{selectedOrders.length - 1} more
                </span>
              )}
            </div>
          ) : savedCheckin.customer_name ? (
            <div style={{
              marginTop: '8px', padding: '8px 12px', background: theme.card,
              border: `1px solid ${theme.border}`, borderRadius: '10px',
              color: theme.textSecondary, fontSize: '12px', fontWeight: 700,
            }}>Customer: {savedCheckin.customer_name}</div>
          ) : null}
          {savedCheckin.proof_file_name && (
            <div style={{
              marginTop: '6px', padding: '6px 12px', background: theme.card,
              border: `1px solid ${theme.border}`, borderRadius: '10px',
              color: theme.textSecondary, fontSize: '11px',
            }}>Proof: {savedCheckin.proof_file_name}</div>
          )}
        </div>

        {/* Graphics-needed prompt — keyword scan at save time flips
            needs_graphics on fleet_checkins. We surface the matched line
            description so the installer knows why the prompt fired. */}
        {(savedCheckin as any).needs_graphics && !(savedCheckin as any).matched_graphics_job_id && (
          <div style={{
            margin: '0 0 14px', padding: '12px 14px', borderRadius: '12px',
            background: 'rgba(251,146,60,0.10)', border: '1px solid rgba(251,146,60,0.35)',
          }}>
            <div style={{ fontSize: '11px', fontWeight: 800, color: '#fb923c', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
              Graphics Needed
            </div>
            <div style={{ fontSize: '12px', color: theme.textPrimary, marginBottom: '8px' }}>
              This order includes a graphics line item
              {(savedCheckin as any).graphics_signal ? <>: <span style={{ fontStyle: 'italic' }}>{(savedCheckin as any).graphics_signal}</span></> : null}
              . Create a graphics production job?
            </div>
            <button
              onClick={() => {
                const params = new URLSearchParams({
                  new: '1',
                  vin: savedCheckin.vin || '',
                  customer: savedCheckin.customer_name || '',
                  so: savedCheckin.sales_order_number || '',
                  checkinId: savedCheckin.id || '',
                });
                router.push(`/graphics?${params.toString()}`);
              }}
              style={{
                padding: '8px 14px', borderRadius: '10px', fontSize: '12px', fontWeight: 800,
                background: '#fb923c', color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >+ Create Graphics Job</button>
          </div>
        )}

        {/* Sales Order PDF Viewer */}
        <NetSuitePdf
          type="salesOrder"
          recordId={savedCheckin.netsuite_sales_order_id}
          recordNumber={savedCheckin.sales_order_number}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
          <button
            onClick={() => router.push(`/vehicles/${savedCheckin.vin}/pick-list`)}
            style={{
              width: '100%', padding: '12px', borderRadius: '12px',
              background: 'transparent', color: theme.textPrimary,
              border: `1px solid ${theme.border}`,
              fontSize: '13px', fontWeight: 700,
            }}
          >Take check-in photos (optional)</button>
          {(savedCheckin.customer_name || savedCheckin.sales_order_number) && (
            <button onClick={checkInAnotherSameCustomer} style={{
              width: '100%', padding: '16px', borderRadius: '14px',
              background: theme.navy, color: '#fff', fontSize: '16px', fontWeight: 800, border: 'none',
            }}>Check in another for {savedCheckin.customer_name || 'same customer'}</button>
          )}
          <button onClick={resetAll} style={{
            width: '100%', padding: '14px', borderRadius: '14px',
            background: (savedCheckin.customer_name || savedCheckin.sales_order_number) ? 'transparent' : theme.navy,
            color: (savedCheckin.customer_name || savedCheckin.sales_order_number) ? theme.textPrimary : '#fff',
            border: (savedCheckin.customer_name || savedCheckin.sales_order_number) ? `1px solid ${theme.border}` : 'none',
            fontSize: '15px', fontWeight: 700,
          }}>Check in a different customer</button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 0: VIN ENTRY
  // ═══════════════════════════════════════════════════════════
  if (step === 0) {
    const heldCustomer = selectedOrder?.customer_name || manualCustomerName.trim();
    const heldSO = selectedOrder?.sales_order_number;
    const heldProof = selectedProof?.file_name || dbxSelected?.name;
    return (
      <div>
        <StepIndicator current={0} />
        <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Fleet Check-In
        </div>

        {keepingContext && (heldCustomer || heldSO || heldProof) && (
          <div style={{
            marginBottom: '12px', padding: '10px 12px', borderRadius: '12px',
            background: theme.successBg, border: `1px solid ${theme.successBorder}`,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: theme.success, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Context kept — just enter VIN
              </div>
              <div style={{ fontSize: '12px', color: theme.textSecondary, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {heldCustomer || '—'}
                {heldSO ? ` · SO #${heldSO}` : ''}
                {scheduledUpfitDate ? ` · ${new Date(scheduledUpfitDate + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}
                {heldProof ? ` · ${heldProof}` : ''}
              </div>
            </div>
            <button
              onClick={() => {
                setSelectedOrders([]);
                setManualCustomerName('');
                setCustomerSearch('');
                setSelectedProof(null);
                setDbxSelected(null);
                setScheduledUpfitDate('');
                setNotes('');
                setKeepingContext(false);
              }}
              style={{
                padding: '6px 10px', borderRadius: '8px',
                background: 'transparent', border: `1px solid ${theme.border}`,
                fontSize: '11px', fontWeight: 700, color: theme.textSecondary,
                cursor: 'pointer', flexShrink: 0,
              }}
            >Clear</button>
          </div>
        )}

        {/* Camera / Text toggle */}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', background: theme.card, borderRadius: '10px', padding: '3px' }}>
          <button onClick={switchToCamera} style={{
            flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
            background: mode === 'camera' ? theme.tabActiveBg : 'transparent', border: 'none',
            color: mode === 'camera' ? theme.navy : theme.textMuted,
          }}>Camera</button>
          <button onClick={switchToText} style={{
            flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
            background: mode === 'text' ? theme.tabActiveBg : 'transparent', border: 'none',
            color: mode === 'text' ? theme.navy : theme.textMuted,
          }}>Type / Scanner</button>
        </div>

        {mode === 'camera' ? (
          <VinScanner onScan={handleCameraScan} theme={theme} />
        ) : (
          <div>
            <input
              ref={inputRef}
              type="text"
              value={vin}
              onChange={(e) => setVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, '').slice(0, 17))}
              placeholder="Enter full 17-char VIN or last 8+ chars"
              maxLength={17}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: '10px',
                border: `1px solid ${theme.border}`, background: theme.card,
                color: theme.textPrimary, fontSize: '18px', letterSpacing: '2px',
                fontWeight: 700, textAlign: 'center',
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && vin.length >= 8) handleVinSubmit(); }}
            />
            <div style={{
              textAlign: 'center', marginTop: '4px', fontSize: '13px', fontWeight: 600,
              color: vin.length === 17 ? theme.success : (vin.length >= 8 ? theme.textSecondary : theme.textMuted),
            }}>
              {vin.length}/17 {vin.length === 17 ? 'OK' : (vin.length >= 8 ? '· partial lookup OK' : '')}
            </div>
          </div>
        )}

        {vinError && (
          <div style={{ marginTop: '8px', padding: '8px 12px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, borderRadius: '10px', color: theme.error, fontSize: '12px' }}>{vinError}</div>
        )}

        {duplicateVehicle && (
          <div style={{ marginTop: '8px', padding: '14px', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary, marginBottom: '2px' }}>
              {[duplicateVehicle.vehicle_year, duplicateVehicle.vehicle_make, duplicateVehicle.vehicle_model].filter(Boolean).join(' ')}
            </div>
            {duplicateVehicle.customer_name && (
              <div style={{ fontSize: '12px', color: theme.textSecondary, marginBottom: '2px' }}>{duplicateVehicle.customer_name}</div>
            )}
            {duplicateVehicle.sales_order_number && (
              <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '8px' }}>SO #{duplicateVehicle.sales_order_number}</div>
            )}
            <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', marginBottom: '6px' }}>Update Status</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {VEHICLE_STATUS_PIPELINE.map(s => {
                const colors = VEHICLE_STATUS_COLORS[s];
                const isCurrent = duplicateVehicle.status === s || (duplicateVehicle.status === 'checked_in' && s === 'received');
                return (
                  <button
                    key={s}
                    disabled={isCurrent || updatingDupStatus}
                    onClick={async () => {
                      setUpdatingDupStatus(true);
                      const res = await fetch('/api/vehicle-tracking/update-status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ vehicleId: duplicateVehicle.id, newStatus: s }),
                      });
                      if (res.ok) {
                        setDuplicateVehicle({ ...duplicateVehicle, status: s });
                      } else {
                        const data = await res.json().catch(() => ({}));
                        if (res.status === 422 && Array.isArray(data.missing)) {
                          await dialog.alert(`Cannot mark complete yet:\n\n• ${data.missing.join('\n• ')}`);
                        } else {
                          await dialog.alert('Update failed: ' + (data.error || 'Unknown error'));
                        }
                      }
                      setUpdatingDupStatus(false);
                    }}
                    style={{
                      padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                      background: isCurrent ? colors.bg : 'var(--subtle-bg)',
                      border: `1.5px solid ${isCurrent ? colors.border : theme.border}`,
                      color: isCurrent ? colors.text : theme.textSecondary,
                      opacity: isCurrent ? 1 : (updatingDupStatus ? 0.4 : 1),
                      cursor: isCurrent || updatingDupStatus ? 'default' : 'pointer',
                    }}
                  >
                    {isCurrent ? `● ${VEHICLE_STATUS_LABELS[s]}` : VEHICLE_STATUS_LABELS[s]}
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => { setDuplicateVehicle(null); setVinError(''); setVin(''); }}
              style={{ marginTop: '10px', width: '100%', padding: '10px', borderRadius: '10px', border: `1px solid ${theme.border}`, background: 'transparent', color: theme.textSecondary, fontSize: '13px', fontWeight: 700 }}
            >Scan Different VIN</button>
          </div>
        )}

        {vinLoading && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ width: '28px', height: '28px', border: `3px solid ${theme.border}`, borderTopColor: theme.navy, borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
            <div style={{ color: theme.textMuted, fontWeight: 600, marginTop: '8px', fontSize: '13px' }}>Decoding VIN...</div>
          </div>
        )}

        {mode === 'text' && !vinLoading && (
          <button onClick={handleVinSubmit} disabled={vin.length < 8} style={{
            width: '100%', padding: '16px', borderRadius: '14px', marginTop: '14px',
            background: vin.length >= 8 ? theme.navy : theme.border,
            color: '#fff', fontSize: '16px', fontWeight: 800,
            opacity: vin.length >= 8 ? 1 : 0.4, border: 'none',
          }}>{vin.length === 17 ? 'Decode VIN' : (vin.length >= 8 ? 'Look up partial' : 'Decode VIN')}</button>
        )}

        {partialVinMatches.length > 0 && (
          <div style={{ marginTop: '12px', padding: '12px', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
              {partialVinMatches.length} Prior VIN{partialVinMatches.length === 1 ? '' : 's'} Match — Pick One
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {partialVinMatches.map((m) => (
                <button
                  key={m.vin}
                  onClick={() => selectPartialMatch(m.vin)}
                  style={{
                    padding: '10px 12px', borderRadius: '10px', textAlign: 'left',
                    background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontFamily: 'monospace', fontSize: '12px', fontWeight: 700, color: theme.textPrimary }}>
                    {m.vin}
                  </div>
                  <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
                    {m.vehicleDescription || '—'}
                    {m.customerName ? ` · ${m.customerName}` : ''}
                    {m.lastSeenAt ? ` · ${new Date(m.lastSeenAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                    {m.source === 'scan_log' ? ' · from scan log' : ''}
                  </div>
                </button>
              ))}
            </div>
            <button
              onClick={() => setPartialVinMatches([])}
              style={{
                marginTop: '8px', width: '100%', padding: '8px', borderRadius: '10px',
                border: `1px solid ${theme.border}`, background: 'transparent',
                color: theme.textSecondary, fontSize: '12px', fontWeight: 700,
              }}
            >Cancel — enter full VIN</button>
          </div>
        )}

        {/* Recent Check-Ins */}
        <div style={{ marginTop: '24px' }}>
          <button
            onClick={() => setShowRecent(!showRecent)}
            style={{
              width: '100%', padding: '10px', borderRadius: '10px',
              background: theme.card, border: `1px solid ${theme.border}`,
              color: theme.textSecondary, fontSize: '12px', fontWeight: 700,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}
          >
            <span>Recent Check-Ins ({recentCheckins.length})</span>
            <span>{showRecent ? '▲' : '▼'}</span>
          </button>
          {showRecent && recentCheckins.length > 0 && (
            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {recentCheckins.map(ci => (
                <div
                  key={ci.id}
                  style={{
                    background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px',
                    padding: '10px 12px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <div
                      style={{ flex: 1, cursor: 'pointer', minWidth: 0 }}
                      onClick={() => openPopout('vehicles', ci.id)}
                    >
                      <div style={{ fontWeight: 700, fontSize: '13px' }}>
                        {[ci.vehicle_year, ci.vehicle_make, ci.vehicle_model].filter(Boolean).join(' ') || 'Unknown'}
                      </div>
                      <div style={{ fontSize: '11px', fontFamily: 'monospace', color: theme.textMuted }}>{ci.vin}</div>
                      {ci.customer_name && (
                        <div style={{ fontSize: '11px', color: theme.textSecondary, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ci.customer_name}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: '4px', flexShrink: 0 }}>
                      {ci.sales_order_number && (
                        <div style={{ fontSize: '11px', fontWeight: 700, color: theme.success }}>SO #{ci.sales_order_number}</div>
                      )}
                      <div style={{ fontSize: '10px', color: theme.textMuted }}>
                        {new Date(ci.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); cloneFromCheckin(ci); }}
                        style={{
                          padding: '4px 10px', borderRadius: '8px',
                          background: 'transparent', border: `1px solid ${theme.border}`,
                          fontSize: '11px', fontWeight: 700, color: theme.textSecondary,
                          cursor: 'pointer',
                        }}
                      >Clone</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 1: SALES ORDER SELECTION
  // ═══════════════════════════════════════════════════════════
  if (step === 1) {
    return (
      <div>
        <StepIndicator current={1} />

        {/* Vehicle summary card */}
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          padding: '14px', marginBottom: '14px',
        }}>
          <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase' }}>Vehicle</div>
          <div style={{ fontSize: '16px', fontWeight: 800, marginTop: '2px' }}>{vehicleTitle || 'Unknown'}</div>
          <div style={{ fontSize: '12px', fontFamily: 'monospace', color: theme.textMuted, letterSpacing: '1px' }}>{vehicleData?.vin}</div>
          {vehicleData?.vehicle?.bodyClass && (
            <div style={{ fontSize: '12px', color: theme.textSecondary, marginTop: '2px' }}>{vehicleData.vehicle.bodyClass}</div>
          )}
        </div>

        {/* Customer search */}
        <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
          Search Sales Orders, Invoices &amp; Estimates
        </div>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <input
            type="text"
            value={customerSearch}
            onChange={(e) => setCustomerSearch(e.target.value)}
            placeholder="Customer name..."
            style={{
              flex: 1, padding: '10px 12px', borderRadius: '10px',
              border: `1px solid ${theme.border}`, background: theme.card,
              color: theme.textPrimary, fontSize: '14px', fontWeight: 600,
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') searchSalesOrders(); }}
          />
          <button onClick={searchSalesOrders} disabled={soLoading || !customerSearch.trim()} style={{
            padding: '10px 16px', borderRadius: '10px', background: theme.navy,
            color: '#fff', fontWeight: 700, fontSize: '13px', border: 'none',
            opacity: soLoading || !customerSearch.trim() ? 0.4 : 1,
          }}>{soLoading ? '...' : 'Search'}</button>
        </div>

        {soError && (
          <div style={{ padding: '8px 12px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, borderRadius: '10px', color: theme.error, fontSize: '12px', marginBottom: '10px' }}>{soError}</div>
        )}

        {soLoading && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ width: '28px', height: '28px', border: `3px solid ${theme.border}`, borderTopColor: theme.navy, borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
            <div style={{ color: theme.textMuted, fontWeight: 600, marginTop: '8px', fontSize: '13px' }}>Searching NetSuite...</div>
          </div>
        )}

        {/* Sales order results — multi-select. The first selected order
            drives proof search and is mirrored into the check-in's legacy
            single-SO columns; any additional ones live in the join table. */}
        {salesOrders.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
            {salesOrders.map(so => {
              const isSelected = selectedOrders.some(o => o.id === so.id);
              return (
              <div key={so.id} style={{
                background: theme.card,
                border: `1px solid ${isSelected ? theme.success : theme.border}`,
                borderRadius: '12px', overflow: 'hidden',
              }}>
                <button
                  onClick={() => setExpandedOrder(expandedOrder === so.id ? null : so.id)}
                  style={{
                    width: '100%', padding: '12px 14px', textAlign: 'left',
                    background: 'transparent', border: 'none', color: theme.textPrimary,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
                  }}
                >
                  <div style={{
                    width: '22px', height: '22px', borderRadius: '6px', flexShrink: 0,
                    border: `2px solid ${isSelected ? theme.success : theme.border}`,
                    background: isSelected ? theme.success : 'transparent',
                    color: '#fff', fontSize: '13px', fontWeight: 800,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{isSelected ? '✓' : ''}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontWeight: 800, fontSize: '14px' }}>{so.record_type === 'Invoice' ? 'INV' : so.record_type === 'Estimate' ? 'EST' : 'SO'} #{so.sales_order_number}</span>
                      {so.record_type !== 'Sales Order' && (
                        <span style={{
                          fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px',
                          background: so.record_type === 'Invoice' ? 'rgba(52,211,153,0.1)' : 'rgba(251,191,36,0.1)',
                          color: so.record_type === 'Invoice' ? '#34d399' : '#fbbf24',
                        }}>{so.record_type}</span>
                      )}
                    </div>
                    <div style={{ fontSize: '12px', color: theme.textSecondary, marginTop: '2px' }}>{so.customer_name}</div>
                    {so.memo && <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>{so.memo}</div>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '14px', fontWeight: 700 }}>${(so.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                    <div style={{ fontSize: '10px', color: theme.textMuted }}>{statusMap[so.status] || so.status}</div>
                    <div style={{ fontSize: '10px', color: theme.textMuted }}>{so.date}</div>
                  </div>
                </button>

                {expandedOrder === so.id && (
                  <div style={{ borderTop: `1px solid ${theme.border}`, padding: '10px 14px' }}>
                    {so.line_items && so.line_items.length > 0 && (
                      <div style={{ marginBottom: '10px' }}>
                        {so.line_items.map((li, idx) => (
                          <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '12px', borderBottom: idx < so.line_items.length - 1 ? `1px solid ${theme.border}` : 'none' }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600 }}>{li.item_name || 'Item'}</div>
                              {li.description && <div style={{ fontSize: '11px', color: theme.textMuted }}>{li.description}</div>}
                            </div>
                            <div style={{ textAlign: 'right', fontSize: '12px' }}>
                              <div>{li.quantity} x ${li.rate.toFixed(2)}</div>
                              <div style={{ fontWeight: 700 }}>${li.amount.toFixed(2)}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <button onClick={() => toggleSalesOrder(so)} style={{
                      width: '100%', padding: '12px', borderRadius: '10px',
                      background: isSelected ? 'transparent' : theme.success,
                      color: isSelected ? theme.textSecondary : '#fff',
                      border: isSelected ? `1px solid ${theme.border}` : 'none',
                      fontWeight: 800, fontSize: '13px',
                    }}>{isSelected ? 'Remove from Check-In' : 'Add to Check-In'}</button>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}

        {/* Navigation buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
          {selectedOrders.length > 0 && (
            <button onClick={continueWithSelectedOrders} style={{
              width: '100%', padding: '14px', borderRadius: '14px',
              background: theme.success, color: '#fff', border: 'none',
              fontSize: '14px', fontWeight: 800,
            }}>Continue with {selectedOrders.length} order{selectedOrders.length === 1 ? '' : 's'} →</button>
          )}
          <button onClick={skipSalesOrder} style={{
            width: '100%', padding: '12px', borderRadius: '14px',
            border: `1px solid ${theme.border}`, background: 'transparent',
            color: theme.textSecondary, fontSize: '13px', fontWeight: 700,
          }}>Skip — No Order Found</button>
          <button onClick={() => { setStep(0); setVehicleData(null); setVin(''); }} style={{
            width: '100%', padding: '10px', borderRadius: '14px',
            border: `1px solid ${theme.border}`, background: 'transparent',
            color: theme.textMuted, fontSize: '12px', fontWeight: 600,
          }}>Back to VIN</button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 2: PROOF SELECTION + SAVE
  // ═══════════════════════════════════════════════════════════
  if (step === 2) {
    return (
      <div>
        <StepIndicator current={2} />

        {/* Summary cards */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <div style={{ flex: 1, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '10px' }}>
            <div style={{ fontSize: '9px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Vehicle</div>
            <div style={{ fontSize: '12px', fontWeight: 700, marginTop: '2px' }}>{vehicleTitle || 'Unknown'}</div>
            <div style={{ fontSize: '10px', fontFamily: 'monospace', color: theme.textMuted }}>{vehicleData?.vin}</div>
          </div>
          <div style={{ flex: 1, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '10px' }}>
            <div style={{ fontSize: '9px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sales Order</div>
            {selectedOrder ? (
              <>
                <div style={{ fontSize: '12px', fontWeight: 700, marginTop: '2px', color: theme.success }}>SO #{selectedOrder.sales_order_number}</div>
                <div style={{ fontSize: '10px', color: theme.textMuted }}>{selectedOrder.customer_name}</div>
              </>
            ) : (
              <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px' }}>None</div>
            )}
          </div>
        </div>

        {/* Proof browser */}
        <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
          Select Graphics Proof
        </div>

        {/* Proof search — search by end user / different customer */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
          <input
            type="text"
            value={proofSearch}
            onChange={(e) => setProofSearch(e.target.value)}
            placeholder="Search by end user name (e.g. Jerry Kelly)"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && proofSearch.trim()) loadProofs(proofSearch.trim());
            }}
            style={{
              flex: 1, padding: '10px 12px', borderRadius: '10px',
              border: `1px solid ${theme.border}`, background: theme.card,
              color: theme.textPrimary, fontSize: '13px', fontWeight: 600,
            }}
          />
          <button
            onClick={() => loadProofs(proofSearch.trim())}
            style={{
              padding: '10px 14px', borderRadius: '10px', fontWeight: 700, fontSize: '13px',
              background: theme.navy, color: '#fff', border: 'none', whiteSpace: 'nowrap',
            }}
          >Search</button>
        </div>

        {/* Upload from device + currently-selected proof. Sits above the
            Supabase/Dropbox pickers so it's the first option when none of
            the search results fit. */}
        <DropZone
          onFiles={(files) => uploadProofFromDevice(files[0])}
          accept="image/*,application/pdf,.eps,.ai,.psd"
          multiple={false}
          disabled={uploadingProof}
        >
        <input
          ref={uploadProofInputRef}
          type="file"
          accept="image/*,application/pdf,.eps,.ai,.psd"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) await uploadProofFromDevice(f);
            if (e.target) e.target.value = '';
          }}
        />
        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
          <button
            onClick={() => uploadProofInputRef.current?.click()}
            disabled={uploadingProof}
            style={{
              flex: 1, padding: '10px 12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'transparent', border: `1px dashed ${theme.border}`, color: theme.textPrimary,
              cursor: uploadingProof ? 'wait' : 'pointer', opacity: uploadingProof ? 0.6 : 1,
            }}
          >{uploadingProof ? 'Uploading...' : '+ Upload Proof from Device'}</button>
        </div>
        </DropZone>
        {(selectedProof || dbxSelected) && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '8px', padding: '8px 12px', borderRadius: '10px',
            background: theme.successBg, border: `1px solid ${theme.successBorder}`,
            marginBottom: '10px',
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase' }}>Selected Proof</div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedProof?.file_name || dbxSelected?.name}
              </div>
            </div>
            <button
              onClick={removeSelectedProof}
              style={{
                padding: '6px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                background: 'transparent', border: `1px solid ${theme.border}`,
                color: theme.textMuted, cursor: 'pointer', flexShrink: 0,
              }}
            >Remove</button>
          </div>
        )}
        {selectedOrder?.customer_name && proofSearch && proofSearch !== selectedOrder.customer_name && (
          <button
            onClick={() => { setProofSearch(''); loadProofs(selectedOrder.customer_name); }}
            style={{
              marginBottom: '10px', padding: '6px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textMuted,
            }}
          >Reset to {selectedOrder.customer_name}</button>
        )}

        {proofLoading ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ width: '28px', height: '28px', border: `3px solid ${theme.border}`, borderTopColor: theme.navy, borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
            <div style={{ color: theme.textMuted, fontWeight: 600, marginTop: '8px', fontSize: '13px' }}>Loading proofs...</div>
          </div>
        ) : proofs.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px', maxHeight: '240px', overflowY: 'auto' }}>
            {proofs.map(proof => (
              <button
                key={proof.id}
                onClick={() => selectProof(proof)}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: '10px', textAlign: 'left',
                  background: selectedProof?.id === proof.id ? theme.successBg : theme.card,
                  border: `1px solid ${selectedProof?.id === proof.id ? theme.successBorder : theme.border}`,
                  color: theme.textPrimary,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '13px' }}>{proof.file_name}</div>
                    <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>
                      {proof.customer_name}{proof.vehicle_type ? ` — ${proof.vehicle_type}` : ''}
                    </div>
                  </div>
                  {selectedProof?.id === proof.id && (
                    <div style={{ fontSize: '16px', color: theme.success }}>✓</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div style={{
            padding: '20px', textAlign: 'center', background: theme.card,
            border: `1px solid ${theme.border}`, borderRadius: '10px',
            color: theme.textMuted, fontSize: '13px', marginBottom: '12px',
          }}>
            No proofs found in app. Try searching Dropbox below.
          </div>
        )}

        {/* Dropbox Proof Search */}
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          padding: '14px', marginBottom: '14px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Dropbox Proofs
            </div>
            {dbxConnected === true && dbxResults.length > 0 && !dbxSearching && (
              <span style={{ fontSize: '10px', color: theme.textMuted }}>{dbxResults.length} found</span>
            )}
          </div>

          {dbxConnected === false ? (
            <div style={{ fontSize: '12px', color: theme.textMuted, textAlign: 'center', padding: '8px 0' }}>
              Dropbox not connected — proofs can be linked later from the vehicle record
            </div>
          ) : dbxSearching ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0' }}>
              <div style={{ width: '16px', height: '16px', border: `2px solid ${theme.border}`, borderTopColor: '#0061fe', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: '12px', color: theme.textMuted }}>Searching Dropbox...</span>
            </div>
          ) : dbxSelected ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(0,97,254,0.06)', border: '1px solid rgba(0,97,254,0.2)' }}>
              <ProofThumbnail dropboxPath={dbxSelected.path} label={dbxSelected.name} thumbSize={48} expandedSize={280} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textPrimary }}>{dbxSelected.name}</div>
                <div style={{ fontSize: '10px', color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dbxSelected.path}</div>
              </div>
              <button
                onClick={() => setDbxSelected(null)}
                style={{ padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textMuted, cursor: 'pointer' }}
              >Change</button>
            </div>
          ) : dbxResults.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflowY: 'auto' }}>
              {dbxResults.map((file) => (
                <button
                  key={file.id}
                  onClick={() => { setDbxSelected({ name: file.name, path: file.path }); setSelectedProof(null); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
                    padding: '8px 10px', borderRadius: '8px', cursor: 'pointer', textAlign: 'left',
                    background: theme.card, border: `1px solid ${theme.border}`,
                  }}
                >
                  <ProofThumbnail dropboxPath={file.path} label={file.name} thumbSize={48} expandedSize={280} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                    <div style={{ fontSize: '10px', color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {file.folder ? file.folder : file.path} · {(file.size / 1024).toFixed(0)} KB
                    </div>
                  </div>
                  <span style={{ fontSize: '10px', color: '#0061fe', fontWeight: 700, flexShrink: 0 }}>Select</span>
                </button>
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                value={proofSearch}
                onChange={(e) => setProofSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && proofSearch.trim()) searchDropbox(proofSearch.trim()); }}
                placeholder="Search Dropbox by customer..."
                style={{
                  flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
                  border: `1px solid ${theme.border}`, background: theme.bg, color: theme.textPrimary,
                }}
              />
              <button
                onClick={() => searchDropbox(proofSearch.trim())}
                disabled={!proofSearch.trim()}
                style={{
                  padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                  background: '#0061fe', color: '#fff', border: 'none',
                  opacity: !proofSearch.trim() ? 0.5 : 1, cursor: 'pointer',
                }}
              >Search</button>
            </div>
          )}
        </div>

        {/* Customer Name — shown when no sales order is linked */}
        {!selectedOrder && (
          <div style={{
            background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
            padding: '14px', marginBottom: '14px',
          }}>
            <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
              Customer Name
            </label>
            <input
              value={manualCustomerName}
              onChange={(e) => setManualCustomerName(e.target.value)}
              placeholder="Enter customer name..."
              style={{
                width: '100%', padding: '10px', borderRadius: '10px',
                border: `1px solid ${theme.border}`, background: theme.bg,
                color: theme.textPrimary, fontSize: '13px',
              }}
            />
            <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '4px' }}>
              Will be replaced if a sales order is matched later
            </div>
          </div>
        )}

        {/* Scheduled Upfit Date + Promised Back */}
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          padding: '14px', marginBottom: '14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px',
        }}>
          <div>
            <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
              Scheduled Upfit Date
            </label>
            <input
              type="date"
              value={scheduledUpfitDate}
              onChange={(e) => setScheduledUpfitDate(e.target.value)}
              style={{
                width: '100%', padding: '10px', borderRadius: '10px',
                border: `1px solid ${theme.border}`, background: theme.bg,
                color: theme.textPrimary, fontSize: '13px', boxSizing: 'border-box',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
              Customer Needs It Back
            </label>
            <input
              type="date"
              value={promisedBackDate}
              onChange={(e) => setPromisedBackDate(e.target.value)}
              style={{
                width: '100%', padding: '10px', borderRadius: '10px',
                border: `1px solid ${theme.border}`, background: theme.bg,
                color: theme.textPrimary, fontSize: '13px', boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {/* Notes */}
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          padding: '14px', marginBottom: '14px',
        }}>
          <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
            Notes / Comments
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any notes about this check-in..."
            rows={2}
            style={{
              width: '100%', padding: '10px', borderRadius: '10px',
              border: `1px solid ${theme.border}`, background: theme.bg,
              color: theme.textPrimary, fontSize: '13px', resize: 'vertical',
            }}
          />
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {saveError && (
            <div style={{
              padding: '10px 12px', borderRadius: '10px',
              background: theme.errorBg, border: `1px solid ${theme.errorBorder}`,
              color: theme.error, fontSize: '12px', fontWeight: 600,
              whiteSpace: 'pre-wrap',
            }}>
              {saveError}
            </div>
          )}
          <button onClick={handleSave} disabled={saving} style={{
            width: '100%', padding: '16px', borderRadius: '14px',
            background: theme.success, color: '#fff', fontSize: '16px', fontWeight: 800,
            border: 'none', opacity: saving ? 0.5 : 1,
          }}>{saving ? 'Saving...' : 'Complete Check-In'}</button>
          <button onClick={() => { setSaveError(null); setStep(1); }} style={{
            width: '100%', padding: '10px', borderRadius: '14px',
            border: `1px solid ${theme.border}`, background: 'transparent',
            color: theme.textSecondary, fontSize: '13px', fontWeight: 700,
          }}>Back to Sales Order</button>
        </div>
      </div>
    );
  }

  return null;
}
