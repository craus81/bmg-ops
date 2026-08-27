'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { useAuth, useRequireFeature } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import VinScanner from '@/components/VinScanner';
import RfidCapture, { type RfidCompletion } from '@/components/RfidCapture';
import { locationBillingOverride } from '@/lib/scan-billing';
import { loadBillableCustomers, findBillableCustomer, matchesBillableCustomer, type BillableCustomer } from '@/lib/billable-customers';
import { isVerizonRfidPart } from '@/lib/rfid';
import NumberInput from '@/components/NumberInput';

interface Part {
  id: string;
  item_number: string;
  display_name: string | null;
  description: string | null;
  billable_customer: string | null;
  catalog: string;
  source: string;
}

interface Location {
  id: string;
  name: string;
}

interface ScanEntry {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  unit_number: string | null;
  serial_number: string | null;
  imei: string | null;
  iccid: string | null;
  scanned_at: string;
}

// Verizon RFID installs (VERIZON_RFID_PART) get an extra capture flow handled by
// the shared <RfidCapture> component — VIN then serial / IMEI / CCID. Every
// other part keeps the plain VIN flow below. The RFID part counts whether it
// was picked from the catalog or typed as a custom job name.

export default function ScanPage() {
  const { user, isAdmin } = useAuth();
  useRequireFeature('scan');
  const supabase = createClient();

  // Step state
  const [step, setStep] = useState<'customer' | 'part' | 'location' | 'scan'>('customer');

  // Customer selection — who gets invoiced for this shift's work. Asked
  // explicitly (not inferred from the location or the part) because Reading
  // Truck and Masterack graphics get installed in the SAME buildings while
  // the companies merge — see src/lib/billable-customers.ts. The choice
  // filters the parts list and is stamped on every scan.
  const [billableCustomers, setBillableCustomers] = useState<BillableCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<{ name: string; label: string } | null>(null);
  const [otherCustomer, setOtherCustomer] = useState('');
  const [showOtherCustomer, setShowOtherCustomer] = useState(false);

  // Part selection
  const [parts, setParts] = useState<Part[]>([]);
  // Non-empty when the parts catalog failed to load — shown instead of a
  // silently empty search (which reads as "no parts exist" to a tech).
  const [partsError, setPartsError] = useState('');
  const [partSearch, setPartSearch] = useState('');
  const [selectedParts, setSelectedParts] = useState<Part[]>([]);
  const [customJob, setCustomJob] = useState('');
  const [customCustomer, setCustomCustomer] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  // Location selection
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);
  // Admin-only inline "add a location" form on the location step, for job
  // sites that aren't in work_locations yet (RLS restricts writes to
  // internal staff; the UI additionally gates to admins).
  const [showAddLocation, setShowAddLocation] = useState(false);
  const [newLocation, setNewLocation] = useState({ name: '', city: '', state: '' });
  const [addingLocation, setAddingLocation] = useState(false);
  const [addLocationError, setAddLocationError] = useState('');

  // Scanning
  const [vin, setVin] = useState('');
  const [unitNumber, setUnitNumber] = useState('');
  const [vinLoading, setVinLoading] = useState(false);
  const [scans, setScans] = useState<ScanEntry[]>([]);
  const [scanError, setScanError] = useState('');
  const [scanSuccess, setScanSuccess] = useState('');
  // K8: optional completion photo for the scan just logged. photoTargets
  // holds the scan_logs ids the last capture created (empty offline — no
  // server rows to attach to yet). Skipping costs zero taps.
  const [photoTargets, setPhotoTargets] = useState<string[]>([]);
  const [photoCount, setPhotoCount] = useState(0);
  const [photoUploading, setPhotoUploading] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const uploadScanPhoto = async (file: File) => {
    if (photoTargets.length === 0) return;
    setPhotoUploading(true);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `scans/${photoTargets[0]}/${Date.now()}.${ext}`;
      const { error: upErr } = await storage.from('photos').upload(path, file, { contentType: file.type });
      if (upErr) { setScanError('Photo upload failed: ' + upErr.message); return; }
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/scans/photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ scanIds: photoTargets, storagePath: path, contentType: file.type || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setScanError('Photo save failed: ' + (json.error || `HTTP ${res.status}`)); return; }
      setPhotoCount(c => c + 1);
    } finally {
      setPhotoUploading(false);
    }
  };
  // VIN captured by the camera, awaiting confirmation (+ optional unit #).
  // While set, the camera stays on but pauses detection.
  const [pendingScan, setPendingScan] = useState<string | null>(null);
  const vinRef = useRef<HTMLInputElement>(null);
  const unitRef = useRef<HTMLInputElement>(null);
  const [scanMode, setScanMode] = useState<'text' | 'camera'>('text');

  // Part files/proofs
  const [partProofs, setPartProofs] = useState<{ file_name: string; storage_path: string; bucket: 'graphics-proofs' | 'proofs' }[]>([]);
  const [showProof, setShowProof] = useState<string | null>(null);

  // Offline
  const [isOffline, setIsOffline] = useState(false);
  const [pendingOfflineScans, setPendingOfflineScans] = useState<any[]>([]);

  // Crew shift (pay splits): scans carry a shift_id so each vehicle's pay
  // splits across whoever's tagged in. Solo scanning gets an implicit
  // one-person shift on first scan. The ref mirrors state so back-to-back
  // awaits in one scan don't race the setState.
  const [shiftId, setShiftId] = useState<string | null>(null);
  const shiftIdRef = useRef<string | null>(null);
  const [crewInfo, setCrewInfo] = useState<{
    shift: { id: string; started_by: string; members: { profile_id: string; full_name: string; share_weight: number }[] } | null;
    roster: { profile_id: string; full_name: string }[];
    ratePerVehicle: number | null;
  } | null>(null);
  const [crewOpen, setCrewOpen] = useState(false);
  const [crewDraft, setCrewDraft] = useState<Map<string, number>>(new Map());
  const [crewError, setCrewError] = useState('');
  const [crewBusy, setCrewBusy] = useState(false);

  const setActiveShift = (id: string | null) => {
    shiftIdRef.current = id;
    setShiftId(id);
  };

  useEffect(() => {
    loadParts();
    loadLocations();
    loadBillableCustomers(supabase).then(setBillableCustomers);

    const handleOffline = () => setIsOffline(true);
    const handleOnline = () => { setIsOffline(false); syncOfflineScans(); };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    setIsOffline(!navigator.onLine);

    try {
      const cached = localStorage.getItem('offline_scans');
      if (cached) setPendingOfflineScans(JSON.parse(cached));
    } catch {}

    // Restore active session (part + location)
    let restoredJob = false;
    try {
      const session = localStorage.getItem('scan_session');
      if (session) {
        const s = JSON.parse(session);
        if (s.selectedParts) { setSelectedParts(s.selectedParts); }
        else if (s.selectedPart) { setSelectedParts([s.selectedPart]); } // migrate old sessions
        if (s.billableCustomer?.name) { setSelectedCustomer(s.billableCustomer); }
        if (s.customJob) { setCustomJob(s.customJob); setShowCustom(true); }
        if (s.customCustomer) { setCustomCustomer(s.customCustomer); }
        if (s.selectedLocation) { setSelectedLocation(s.selectedLocation); }
        if (s.shiftId) { shiftIdRef.current = s.shiftId; setShiftId(s.shiftId); }
        if (s.selectedParts?.length || s.selectedPart || s.customJob) { setStep(s.selectedLocation ? 'scan' : 'location'); restoredJob = true; }
        else if (s.billableCustomer?.name) { setStep('part'); }
      }
    } catch {}
    if (!restoredJob) prefillCustomJobDefaults();

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, []);

  // Persist active session (customer included: the choice survives app
  // reloads for the whole shift, and only End Shift clears it)
  useEffect(() => {
    if (selectedParts.length > 0 || customJob || selectedCustomer) {
      try {
        localStorage.setItem('scan_session', JSON.stringify({ selectedParts, customJob, customCustomer, selectedLocation, shiftId, billableCustomer: selectedCustomer }));
      } catch {}
    }
  }, [selectedParts, customJob, customCustomer, selectedLocation, shiftId, selectedCustomer]);

  // Stopgap while the CNI custom-job process is in flux: remember the last
  // custom job/customer beyond End Shift / Switch Part (scan_session only
  // survives within a shift) so the part number doesn't get retyped every
  // shift. Overwritten the next time a custom job is continued.
  const saveCustomJobDefaults = () => {
    try { localStorage.setItem('custom_job_defaults', JSON.stringify({ customJob, customCustomer })); } catch {}
  };
  const prefillCustomJobDefaults = () => {
    try {
      const raw = localStorage.getItem('custom_job_defaults');
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.customJob) {
        setCustomJob(d.customJob);
        setCustomCustomer(d.customCustomer || '');
        setShowCustom(true);
      }
    } catch {}
  };

  // ── Crew shift (pay splits) ──
  const authHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    } as Record<string, string>;
  };

  const loadCrew = useCallback(async () => {
    if (isOffline) return;
    try {
      const sid = shiftIdRef.current;
      const res = await fetch(`/api/shifts?context=field${sid ? `&shiftId=${sid}` : ''}`, { headers: await authHeaders() });
      if (!res.ok) return;
      const json = await res.json();
      setCrewInfo(json);
      // Stale shift (ended elsewhere / not found): drop it so the next scan
      // starts a fresh one.
      if (sid && !json.shift) setActiveShift(null);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOffline]);

  useEffect(() => {
    if (step === 'scan') loadCrew();
  }, [step, shiftId, loadCrew]);

  /**
   * The shift to attach scans to. Lazily starts an implicit solo shift on the
   * first scan if the crew was never tagged — solo is just a crew of one.
   * Returns null offline (queued scans keep whatever shift id existed).
   */
  const ensureShift = async (): Promise<string | null> => {
    if (shiftIdRef.current) return shiftIdRef.current;
    if (isOffline) return null;
    try {
      const res = await fetch('/api/shifts', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          context: 'field',
          partNumber: selectedParts[0]?.item_number || customJob || null,
          locationId: selectedLocation?.id || null,
          locationName: selectedLocation?.name || null,
          members: [...crewDraft.entries()].map(([profileId, weight]) => ({ profileId, weight })),
        }),
      });
      if (!res.ok) return null;
      const json = await res.json();
      setActiveShift(json.shift.id);
      setCrewInfo(prev => ({ shift: json.shift, roster: prev?.roster || [], ratePerVehicle: json.ratePerVehicle ?? prev?.ratePerVehicle ?? null }));
      return json.shift.id as string;
    } catch {
      return null;
    }
  };

  const openCrewPanel = () => {
    const draft = new Map<string, number>();
    if (crewInfo?.shift) {
      for (const m of crewInfo.shift.members) draft.set(m.profile_id, m.share_weight);
    } else if (user) {
      draft.set(user.id, 1);
    }
    setCrewDraft(draft);
    setCrewError('');
    setCrewOpen(true);
  };

  const saveCrew = async () => {
    if (!user) return;
    setCrewBusy(true);
    setCrewError('');
    try {
      const headers = await authHeaders();
      if (!shiftIdRef.current) {
        const res = await fetch('/api/shifts', {
          method: 'POST', headers,
          body: JSON.stringify({
            context: 'field',
            partNumber: selectedParts[0]?.item_number || customJob || null,
            locationId: selectedLocation?.id || null,
            locationName: selectedLocation?.name || null,
            members: [...crewDraft.entries()].map(([profileId, weight]) => ({ profileId, weight })),
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { setCrewError(json.error || 'Failed to start shift'); return; }
        setActiveShift(json.shift.id);
      } else {
        const current = new Map((crewInfo?.shift?.members || []).map(m => [m.profile_id, m.share_weight]));
        const add = [...crewDraft.entries()].filter(([id]) => !current.has(id)).map(([profileId, weight]) => ({ profileId, weight }));
        const remove = [...current.keys()].filter(id => !crewDraft.has(id));
        const setWeight = [...crewDraft.entries()]
          .filter(([id, w]) => current.has(id) && current.get(id) !== w)
          .map(([profileId, weight]) => ({ profileId, weight }));
        const res = await fetch('/api/shifts/members', {
          method: 'POST', headers,
          body: JSON.stringify({ shiftId: shiftIdRef.current, add, remove, setWeight }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { setCrewError(json.error || 'Failed to update crew'); return; }
      }
      setCrewOpen(false);
      await loadCrew();
    } finally {
      setCrewBusy(false);
    }
  };

  // End the server-side crew shift (fire-and-forget; scans already carry it).
  const closeServerShift = () => {
    const sid = shiftIdRef.current;
    setActiveShift(null);
    setCrewInfo(prev => prev ? { ...prev, shift: null } : prev);
    if (!sid) return;
    authHeaders().then(headers =>
      fetch('/api/shifts/end', { method: 'POST', headers, body: JSON.stringify({ shiftId: sid }) })
    ).catch(() => {});
  };

  // Your cut per vehicle on the current crew (display only — the server
  // snapshots the real amounts per scan).
  const myCut = (() => {
    if (!crewInfo?.shift || crewInfo.ratePerVehicle == null || !user) return null;
    const me = crewInfo.shift.members.find(m => m.profile_id === user.id);
    if (!me) return null;
    const total = crewInfo.shift.members.reduce((s, m) => s + m.share_weight, 0);
    if (total <= 0) return null;
    return (crewInfo.ratePerVehicle * me.share_weight) / total;
  })();

  const endShift = () => {
    closeServerShift();
    setStep('customer');
    setSelectedCustomer(null);
    setShowOtherCustomer(false);
    setOtherCustomer('');
    setSelectedParts([]);
    setCustomJob('');
    setCustomCustomer('');
    setSelectedLocation(null);
    setScans([]);
    setShowCustom(false);
    setVin('');
    setUnitNumber('');
    setPendingScan(null);
    try { localStorage.removeItem('scan_session'); } catch {}
    prefillCustomJobDefaults();
  };

  // The unified netsuite_parts catalog now carries both NetSuite-synced parts
  // and the graphics-only parts folded in from the old proof catalog (migration
  // 117, source='manual') — so the parts that used to live only in the graphics
  // catalog (e.g. 06U183) are visible here without a second query. De-dupe by
  // item number, preferring the NetSuite-synced row when a manual one collides
  // (it carries upstream NetSuite/PO billing context).
  const loadParts = async () => {
    try {
      const netsuiteParts = await loadNetsuiteParts();
      const byItem = new Map<string, Part>();
      for (const p of netsuiteParts) {
        const key = p.item_number.toUpperCase();
        const existing = byItem.get(key);
        if (!existing || (p.source === 'netsuite' && existing.source !== 'netsuite')) {
          byItem.set(key, p);
        }
      }
      const all = [...byItem.values()].sort((a, b) =>
        a.item_number.localeCompare(b.item_number)
      );
      setParts(all);
      setPartsError('');
      try { localStorage.setItem('cached_parts', JSON.stringify(all)); } catch {}
    } catch (err: any) {
      // Fall back to the last good list (also covers working offline), and
      // surface the failure so it doesn't read as an empty catalog.
      try {
        const cached = JSON.parse(localStorage.getItem('cached_parts') || '[]');
        if (Array.isArray(cached) && cached.length > 0) setParts(cached);
      } catch {}
      setPartsError(err?.message || 'Failed to load parts');
    }
  };

  // Parts come from /api/parts (service role) rather than a direct client
  // read of netsuite_parts: techs' and installers' sessions hit RLS variance
  // on that table, and a client-side read failure was silent — the picker
  // just looked empty. The API errors loudly instead.
  const loadNetsuiteParts = async (): Promise<Part[]> => {
    const res = await fetch('/api/parts');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to load parts (${res.status})`);
    return (data.parts || []) as Part[];
  };

  const loadPartProofs = async (part: Part) => {
    // Proofs live in part_files; the bucket column says where the object is —
    // `graphics-proofs` natively, or `proofs` for images folded in from the old
    // proof catalog by migration 117.
    const { data } = await supabase
      .from('part_files')
      .select('file_name, storage_path, bucket')
      .eq('part_id', part.id);
    setPartProofs((data || []).map((p: any) => ({
      file_name: p.file_name,
      storage_path: p.storage_path,
      bucket: (p.bucket || 'graphics-proofs') as 'graphics-proofs' | 'proofs',
    })));
  };

  const loadLocations = async () => {
    const { data } = await supabase
      .from('work_locations')
      .select('id, name')
      .eq('is_active', true)
      .order('name');
    setLocations((data || []) as Location[]);
    try { localStorage.setItem('cached_locations', JSON.stringify(data || [])); } catch {}
  };

  // Admin-only: create a work location from the picker and select it right
  // away, so a new job site doesn't block scanning until someone finds the
  // locations manager elsewhere.
  const addLocation = async () => {
    const name = newLocation.name.trim();
    if (!name || addingLocation) return;
    if (locations.some(l => l.name.toLowerCase() === name.toLowerCase())) {
      setAddLocationError('A location with that name already exists — pick it from the list.');
      return;
    }
    setAddingLocation(true);
    setAddLocationError('');
    const { data, error } = await supabase
      .from('work_locations')
      .insert({ name, city: newLocation.city.trim() || null, state: newLocation.state.trim() || null })
      .select('id, name')
      .single();
    setAddingLocation(false);
    if (error || !data) {
      setAddLocationError(error?.message || 'Could not create the location');
      return;
    }
    setShowAddLocation(false);
    setNewLocation({ name: '', city: '', state: '' });
    loadLocations();
    setSelectedLocation(data as Location);
    setStep('scan');
  };

  const loadTodayScans = useCallback(async () => {
    if (selectedParts.length === 0 && !customJob) return;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let query = supabase
      .from('scan_logs')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, unit_number, serial_number, imei, iccid, scanned_at')
      .eq('scanned_by', user?.id)
      .gte('scanned_at', todayStart.toISOString())
      .order('scanned_at', { ascending: false });

    if (selectedParts.length > 0) query = query.in('part_number', selectedParts.map(p => p.item_number));
    else if (customJob) query = query.eq('part_number', customJob);
    if (selectedLocation) query = query.eq('location_id', selectedLocation.id);

    const { data } = await query;
    setScans((data || []) as ScanEntry[]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [selectedParts, customJob, selectedLocation, user?.id]);

  useEffect(() => {
    if (step === 'scan') loadTodayScans();
  }, [step, loadTodayScans]);

  // Camera detected a VIN — hold it for confirmation so the user can add an
  // optional unit number. This pauses the scanner (camera stays on) until the
  // scan is logged or discarded.
  const handleCameraScan = (scannedVin: string) => {
    setScanError('');
    setScanSuccess('');
    setUnitNumber('');
    setPendingScan(scannedVin);
    setTimeout(() => unitRef.current?.focus(), 100);
  };

  const confirmPendingScan = async () => {
    if (!pendingScan) return;
    const ok = await processVin(pendingScan, unitNumber);
    if (ok) { setPendingScan(null); setUnitNumber(''); }
    // On failure (e.g. duplicate) keep the card open so the error is visible
    // and the user can discard.
  };

  const discardPendingScan = () => {
    setPendingScan(null);
    setUnitNumber('');
    setScanError('');
  };

  // ── Unified scan logging ──
  // Every scan (plain VIN or Verizon RFID) writes through /api/scans/log so
  // validation, de-duplication, and company attribution live in one place
  // (shared with the CNI flow). Offline, queue locally and sync when online.
  const postScanRecord = async (record: any): Promise<{ ok: boolean; error?: string; id?: string }> => {
    if (isOffline) {
      const offlineScan = { ...record, id: crypto.randomUUID(), scanned_at: new Date().toISOString() };
      const updated = [...pendingOfflineScans, offlineScan];
      setPendingOfflineScans(updated);
      try { localStorage.setItem('offline_scans', JSON.stringify(updated)); } catch {}
      return { ok: true, id: offlineScan.id };
    }
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/scans/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify(record),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json.error || 'Failed to save' };
    return { ok: true, id: json.scanLogId };
  };

  // Decode the VIN, then log one row per selected part. Returns the last entry +
  // a label for the success toast, or an error string. Owns no page state of its
  // own (callers handle success/error UI), so it's reused by both the plain VIN
  // flow and the Verizon RFID flow.
  const logVehicle = async (
    v: string,
    unit?: string,
    deviceFields?: { serial_number: string; imei: string; iccid: string },
  ): Promise<{ ok: boolean; error?: string; entry?: ScanEntry; label?: string; parts: number; offline: boolean; createdIds: string[] }> => {
    const unitClean = unit?.trim() || null;

    const partsToScan = selectedParts.length > 0
      ? selectedParts.map(p => ({ partNumber: p.item_number, partDesc: p.display_name || p.description || p.item_number, billable: p.billable_customer || customCustomer || null }))
      : [{ partNumber: customJob, partDesc: customJob, billable: customCustomer || null }];

    // Crew shift for pay credits — implicit solo shift if none was tagged.
    const sid = await ensureShift();

    let vehicleData: any = {};
    try {
      const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${v}?format=json`);
      const json = await res.json();
      const results = json.Results || [];
      const get = (id: number) => results.find((r: any) => r.VariableId === id)?.Value || null;
      vehicleData = { vehicle_year: get(29), vehicle_make: get(26), vehicle_model: get(28), vehicle_trim: get(38), body_class: get(5) };
    } catch {}

    // The tech's explicit customer choice wins over everything: Reading and
    // Masterack work happens in the same buildings now, so neither the
    // location nor the part can settle who's paying. The location override
    // (any Masterack facility bills Masterack) only applies to sessions that
    // predate the customer step.
    const explicitCustomer = selectedCustomer?.name || null;
    const locationOverrideCustomer = locationBillingOverride(selectedLocation?.name);

    let entry: ScanEntry | undefined;
    const createdIds: string[] = [];
    for (const pt of partsToScan) {
      const record = {
        vin: v,
        ...vehicleData,
        part_number: pt.partNumber,
        part_description: pt.partDesc,
        billable_customer: explicitCustomer ?? locationOverrideCustomer ?? pt.billable,
        unit_number: unitClean,
        serial_number: deviceFields?.serial_number ?? null,
        imei: deviceFields?.imei ?? null,
        iccid: deviceFields?.iccid ?? null,
        location_id: selectedLocation?.id || null,
        location_name: selectedLocation?.name || null,
        shift_id: sid,
      };
      const result = await postScanRecord(record);
      if (!result.ok) return { ok: false, error: result.error, parts: partsToScan.length, offline: isOffline, createdIds: [] };
      if (result.id) createdIds.push(result.id);
      entry = {
        id: result.id || crypto.randomUUID(),
        vin: v,
        vehicle_year: vehicleData.vehicle_year ?? null,
        vehicle_make: vehicleData.vehicle_make ?? null,
        vehicle_model: vehicleData.vehicle_model ?? null,
        unit_number: unitClean,
        serial_number: record.serial_number,
        imei: record.imei,
        iccid: record.iccid,
        scanned_at: new Date().toISOString(),
      };
    }

    const label = [vehicleData.vehicle_year, vehicleData.vehicle_make, vehicleData.vehicle_model].filter(Boolean).join(' ') || (isOffline ? v : 'Scan logged');
    return { ok: true, entry, label, parts: partsToScan.length, offline: isOffline, createdIds };
  };

  // Verizon RFID capture finished — log it. Returns an error string for the
  // <RfidCapture> review screen, or null on success.
  const handleRfidComplete = async (d: RfidCompletion): Promise<string | null> => {
    const r = await logVehicle(d.vin, d.unit_number || undefined, { serial_number: d.serial_number, imei: d.imei, iccid: d.iccid });
    if (!r.ok) return r.error || 'Failed to save';
    if (r.entry) setScans(prev => [r.entry!, ...prev]);
    const unitSuffix = d.unit_number ? ` · Unit ${d.unit_number}` : '';
    setScanSuccess(`${r.offline ? 'Saved offline: ' : ''}${r.label}${unitSuffix}`);
    setPhotoTargets(r.offline ? [] : r.createdIds);
    setPhotoCount(0);
    return null;
  };

  const handleScan = async () => {
    const v = vin.trim().toUpperCase();
    const ok = await processVin(v, unitNumber);
    if (ok) setUnitNumber('');
  };

  const processVin = async (
    v: string,
    unit?: string,
    deviceFields?: { serial_number: string; imei: string; iccid: string },
  ): Promise<boolean> => {
    if (v.length < 5) { setScanError('VIN too short'); return false; }
    setScanError('');
    setScanSuccess('');
    setVinLoading(true);
    const r = await logVehicle(v, unit, deviceFields);
    setVinLoading(false);
    if (!r.ok) { setScanError(r.error || 'Failed to save'); return false; }
    if (r.entry) setScans(prev => [r.entry!, ...prev]);
    const unitSuffix = unit?.trim() ? ` · Unit ${unit.trim()}` : '';
    setScanSuccess(`${r.offline ? 'Saved offline: ' : ''}${r.label}${unitSuffix}${r.parts > 1 ? ` (${r.parts} parts)` : ''}`);
    setPhotoTargets(r.offline ? [] : r.createdIds);
    setPhotoCount(0);
    setVin('');
    setTimeout(() => vinRef.current?.focus(), 100);
    return true;
  };

  const syncOfflineScans = async () => {
    try {
      const cached = localStorage.getItem('offline_scans');
      if (!cached) return;
      const offlineScans = JSON.parse(cached);
      if (offlineScans.length === 0) return;
      const { data: { session } } = await supabase.auth.getSession();
      const headers = { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) };
      for (const scan of offlineScans) {
        const { id, scanned_at, ...rest } = scan;
        await fetch('/api/scans/log', { method: 'POST', headers, body: JSON.stringify(rest) }).catch(() => {});
      }
      localStorage.removeItem('offline_scans');
      setPendingOfflineScans([]);
      loadTodayScans();
    } catch {}
  };

  // Part numbers visually conflate O and 0 (e.g. "O6U183" vs "06U183") — some
  // are stored one way, some the other depending on the source (NetSuite sync
  // vs PO import vs hand entry). Normalize both sides of the search so a query
  // for one finds the other. The slice cap is generous so a broad query like
  // "06u" doesn't hide later matches alphabetically.
  const normalizePartSearch = (s: string) => s.toLowerCase().replace(/o/g, '0');
  // Scope the picker to the chosen customer's tagged parts (plus untagged
  // ones — most of the catalog carries no tag). Reading and Masterack part
  // numbers look nothing alike, so cross-customer noise is real. An "Other"
  // customer isn't in the list, so it searches the whole catalog.
  const selectedEntry = findBillableCustomer(billableCustomers, selectedCustomer?.name);
  const customerParts = selectedEntry
    ? parts.filter(p => !p.billable_customer || matchesBillableCustomer(selectedEntry, p.billable_customer))
    : parts;
  const filteredParts = partSearch
    ? (() => {
        const s = normalizePartSearch(partSearch);
        return customerParts.filter(p =>
          normalizePartSearch(p.item_number || '').includes(s) ||
          normalizePartSearch(p.display_name || '').includes(s) ||
          normalizePartSearch(p.description || '').includes(s) ||
          normalizePartSearch(p.billable_customer || '').includes(s)
        ).slice(0, 50);
      })()
    : [];

  // Active when the Verizon RFID part is the sole selected part OR the custom
  // job name IS that part number (the CNI custom-job stopgap means techs often
  // type it rather than pick it from the catalog). The server rejects RFID-part
  // scans without device IDs either way, so the client must match its logic —
  // a plain VIN form here is a dead end ("Serial, IMEI, and CCID are all
  // required"). Combining it with other parts is blocked at the picker.
  const isVerizonRfid = selectedParts.length === 1
    ? isVerizonRfidPart(selectedParts[0].item_number)
    : selectedParts.length === 0 && isVerizonRfidPart(customJob);

  // Multi-part batches can't carry per-vehicle device IDs, and the server
  // hard-rejects the RFID part without them — block the combination up front.
  const rfidInMulti = selectedParts.length > 1
    && selectedParts.some(p => isVerizonRfidPart(p.item_number));

  const partLabel = selectedParts.length > 0
    ? selectedParts.map(p => p.item_number).join(' / ')
    : customJob || '';
  const partDesc = selectedParts.length > 0
    ? selectedParts.map(p => p.display_name || p.description || '').filter(Boolean).join(', ')
    : null;

  return (
    <div>
      {isOffline && (
        <div style={{
          padding: '8px 12px', borderRadius: '8px', marginBottom: '12px',
          background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)',
          color: '#f59e0b', fontSize: '12px', fontWeight: 700, textAlign: 'center',
        }}>
          Offline — scans will sync when back online
          {pendingOfflineScans.length > 0 && ` (${pendingOfflineScans.length} pending)`}
        </div>
      )}

      {/* ─── STEP 0: Pick Customer ─── */}
      {step === 'customer' && (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '4px' }}>
            Who are you working for?
          </div>
          <div style={{ fontSize: '12px', color: theme.textMuted, marginBottom: '14px' }}>
            The company that gets invoiced for this work.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {billableCustomers.map(c => (
              <button key={c.name} onClick={() => {
                setSelectedCustomer({ name: c.name, label: c.label });
                setShowOtherCustomer(false);
                setStep('part');
              }} style={{
                width: '100%', padding: '16px', borderRadius: '12px', textAlign: 'left',
                border: `1px solid ${selectedCustomer?.name === c.name ? 'rgba(34,197,94,0.4)' : theme.border}`,
                background: selectedCustomer?.name === c.name ? 'rgba(34,197,94,0.06)' : theme.card,
                cursor: 'pointer', fontSize: '16px', fontWeight: 800, color: theme.textPrimary,
              }}>
                {c.label}
                {c.label !== c.name && (
                  <div style={{ fontSize: '11px', fontWeight: 600, color: theme.textMuted, marginTop: '2px' }}>{c.name}</div>
                )}
              </button>
            ))}
          </div>

          {!showOtherCustomer ? (
            <button onClick={() => setShowOtherCustomer(true)} style={{
              width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'transparent', border: `1px dashed ${theme.border}`,
              color: theme.textSecondary, cursor: 'pointer', marginTop: '8px',
            }}>
              + Other Customer
            </button>
          ) : (
            <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginTop: '8px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '6px' }}>Customer Name</div>
              <input value={otherCustomer} onChange={e => setOtherCustomer(e.target.value)} placeholder='e.g. "Uhaul"' autoFocus style={{
                width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '14px',
                border: `1px solid ${theme.border}`, background: 'var(--input-bg)',
                color: theme.textPrimary, fontWeight: 600, marginBottom: '10px',
              }} />
              <button onClick={() => {
                const n = otherCustomer.trim();
                if (n) { setSelectedCustomer({ name: n, label: n }); setStep('part'); }
              }} disabled={!otherCustomer.trim()} style={{
                width: '100%', padding: '12px', borderRadius: '10px', fontSize: '14px', fontWeight: 800,
                background: otherCustomer.trim() ? theme.navy : theme.border, color: '#fff', border: 'none',
                cursor: otherCustomer.trim() ? 'pointer' : 'default', opacity: otherCustomer.trim() ? 1 : 0.5,
              }}>Continue</button>
            </div>
          )}
        </div>
      )}

      {/* ─── STEP 1: Pick Part ─── */}
      {step === 'part' && (
        <div>
          {selectedCustomer && (
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 12px', borderRadius: '10px', marginBottom: '10px',
              background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.2)',
            }}>
              <span style={{ fontSize: '12px', color: theme.textSecondary }}>
                Working for <span style={{ fontWeight: 800, color: '#a78bfa' }}>{selectedCustomer.label}</span>
              </span>
              <button onClick={() => setStep('customer')} style={{
                padding: '3px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                background: 'transparent', border: `1px solid ${theme.border}`,
                color: theme.textMuted, cursor: 'pointer',
              }}>Change</button>
            </div>
          )}
          <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
            What are you working on?
          </div>

          {partsError && (
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
              padding: '10px 12px', borderRadius: '10px', marginBottom: '10px',
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
            }}>
              <div style={{ fontSize: '12px', color: '#f87171', fontWeight: 600 }}>
                Parts failed to load{parts.length > 0 ? ' — showing the last saved list' : ''}. ({partsError})
              </div>
              <button
                onClick={loadParts}
                style={{ flexShrink: 0, padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: '#f87171', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
              >Retry</button>
            </div>
          )}

          <input
            value={partSearch}
            onChange={e => setPartSearch(e.target.value)}
            placeholder="Search parts by number, name, or customer..."
            autoFocus
            style={{
              width: '100%', padding: '14px 16px', borderRadius: '12px', fontSize: '15px',
              border: `1px solid ${theme.border}`, background: theme.card,
              color: theme.textPrimary, fontWeight: 600, marginBottom: '8px',
            }}
          />

          {partSearch && (
            <div style={{ fontSize: '10px', color: theme.textMuted, marginBottom: '8px', textAlign: 'right' }}>
              {filteredParts.length === 0
                ? `No matches in ${customerParts.length} active parts${selectedEntry ? ` for ${selectedEntry.label}` : ''}`
                : `${filteredParts.length}${filteredParts.length === 50 ? '+' : ''} of ${customerParts.length} parts`}
            </div>
          )}

          {filteredParts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px' }}>
              {filteredParts.map(p => {
                const isSelected = selectedParts.some(sp => sp.id === p.id);
                return (
                  <button key={p.id} onClick={() => {
                    if (isSelected) {
                      setSelectedParts(prev => prev.filter(sp => sp.id !== p.id));
                    } else {
                      setSelectedParts(prev => [...prev, p]);
                      loadPartProofs(p);
                    }
                  }} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                    padding: '12px 14px', borderRadius: '10px', textAlign: 'left',
                    border: `1px solid ${isSelected ? 'rgba(34,197,94,0.4)' : theme.border}`,
                    background: isSelected ? 'rgba(34,197,94,0.06)' : theme.card, cursor: 'pointer',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{
                        width: '20px', height: '20px', borderRadius: '4px', flexShrink: 0,
                        border: isSelected ? '2px solid #22c55e' : `2px solid ${theme.border}`,
                        background: isSelected ? '#22c55e' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#fff', fontSize: '12px', fontWeight: 800,
                      }}>{isSelected ? '✓' : ''}</div>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <div style={{ fontWeight: 700, fontSize: '14px', color: theme.textPrimary }}>{p.item_number}</div>
                          {p.catalog === 'graphics' && (
                            <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'rgba(251,191,36,0.12)', color: '#fbbf24', letterSpacing: '0.3px' }}>
                              GRAPHICS
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>{p.display_name || p.description || ''}</div>
                      </div>
                    </div>
                    {p.billable_customer && (
                      <span style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', background: 'rgba(167,139,250,0.1)', color: '#a78bfa', flexShrink: 0 }}>
                        {p.billable_customer}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Continue button when parts are selected */}
          {rfidInMulti && (
            <div style={{
              padding: '10px 12px', borderRadius: '10px', marginTop: '12px',
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
              color: '#f87171', fontSize: '12px', fontWeight: 600,
            }}>
              The Verizon RFID part captures a serial, IMEI, and CCID for each vehicle,
              so it has to be scanned on its own — deselect the other parts to continue.
            </div>
          )}
          {selectedParts.length > 0 && (
            <button onClick={() => { if (!rfidInMulti) setStep('location'); }} disabled={rfidInMulti} style={{
              width: '100%', padding: '14px', borderRadius: '12px', fontSize: '15px', fontWeight: 800,
              background: rfidInMulti ? theme.border : theme.navy, color: '#fff', border: 'none',
              cursor: rfidInMulti ? 'default' : 'pointer', opacity: rfidInMulti ? 0.5 : 1,
              marginTop: '12px', marginBottom: '8px',
            }}>
              Continue with {selectedParts.length} part{selectedParts.length > 1 ? 's' : ''} →
            </button>
          )}

          {!showCustom ? (
            <button onClick={() => setShowCustom(true)} style={{
              width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'transparent', border: `1px dashed ${theme.border}`,
              color: theme.textSecondary, cursor: 'pointer', marginTop: '8px',
            }}>
              + Custom Job (no part number)
            </button>
          ) : (
            <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginTop: '8px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '6px' }}>Job Name</div>
              <input value={customJob} onChange={e => setCustomJob(e.target.value)} placeholder='e.g. "Uhaul Regular"' autoFocus style={{
                width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '14px',
                border: `1px solid ${theme.border}`, background: 'var(--input-bg)',
                color: theme.textPrimary, fontWeight: 600, marginBottom: '10px',
              }} />
              {/* No Billable Customer input here anymore — the customer step
                  already asked, and the selection stamps every scan. The old
                  customCustomer value still backstops restored pre-step
                  sessions in logVehicle's fallback chain. */}
              {selectedCustomer && (
                <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '10px' }}>
                  Bills to <span style={{ fontWeight: 700, color: '#a78bfa' }}>{selectedCustomer.label}</span>
                </div>
              )}
              <button onClick={() => { if (customJob.trim()) { saveCustomJobDefaults(); setStep('location'); } }} disabled={!customJob.trim()} style={{
                width: '100%', padding: '12px', borderRadius: '10px', fontSize: '14px', fontWeight: 800,
                background: customJob.trim() ? theme.navy : theme.border, color: '#fff', border: 'none',
                cursor: customJob.trim() ? 'pointer' : 'default', opacity: customJob.trim() ? 1 : 0.5,
              }}>Continue</button>
            </div>
          )}
        </div>
      )}

      {/* ─── STEP 2: Pick Location ─── */}
      {step === 'location' && (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '4px' }}>
            Where are you working?
          </div>
          <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary }}>{partLabel}</div>
          {partDesc && <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '14px' }}>{partDesc}</div>}
          {!partDesc && <div style={{ marginBottom: '14px' }} />}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {locations.map(loc => (
              <button key={loc.id} onClick={() => { setSelectedLocation(loc); setStep('scan'); }} style={{
                width: '100%', padding: '14px 16px', borderRadius: '12px', textAlign: 'left',
                border: `1px solid ${theme.border}`, background: theme.card,
                cursor: 'pointer', fontSize: '15px', fontWeight: 700, color: theme.textPrimary,
              }}>{loc.name}</button>
            ))}
          </div>

          {isAdmin && !showAddLocation && (
            <button onClick={() => { setShowAddLocation(true); setAddLocationError(''); }} style={{
              width: '100%', padding: '12px 16px', borderRadius: '12px', marginTop: '6px', textAlign: 'center',
              border: `1px dashed ${theme.border}`, background: 'transparent',
              cursor: 'pointer', fontSize: '13px', fontWeight: 700, color: '#60a5fa',
            }}>+ Add Location</button>
          )}
          {isAdmin && showAddLocation && (
            <div style={{ marginTop: '6px', padding: '12px', borderRadius: '12px', border: `1px solid ${theme.border}`, background: theme.card }}>
              <input
                value={newLocation.name}
                onChange={e => setNewLocation({ ...newLocation, name: e.target.value })}
                placeholder="Location name *"
                autoFocus
                style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', fontSize: '14px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, marginBottom: '6px' }}
              />
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '6px', marginBottom: '6px' }}>
                <input
                  value={newLocation.city}
                  onChange={e => setNewLocation({ ...newLocation, city: e.target.value })}
                  placeholder="City"
                  style={{ padding: '10px 12px', borderRadius: '10px', fontSize: '14px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary }}
                />
                <input
                  value={newLocation.state}
                  onChange={e => setNewLocation({ ...newLocation, state: e.target.value })}
                  placeholder="State"
                  maxLength={2}
                  style={{ padding: '10px 12px', borderRadius: '10px', fontSize: '14px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, textTransform: 'uppercase' }}
                />
              </div>
              {addLocationError && (
                <div style={{ fontSize: '11px', color: '#f87171', fontWeight: 600, marginBottom: '6px' }}>{addLocationError}</div>
              )}
              <div style={{ display: 'flex', gap: '6px' }}>
                <button onClick={addLocation} disabled={addingLocation || !newLocation.name.trim()} style={{
                  flex: 1, padding: '10px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                  background: newLocation.name.trim() ? '#3b82f6' : theme.border, color: '#fff', border: 'none',
                  cursor: 'pointer', opacity: addingLocation ? 0.6 : 1,
                }}>{addingLocation ? 'Adding…' : 'Add & Select'}</button>
                <button onClick={() => { setShowAddLocation(false); setNewLocation({ name: '', city: '', state: '' }); setAddLocationError(''); }} style={{
                  padding: '10px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                  background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textMuted, cursor: 'pointer',
                }}>Cancel</button>
              </div>
            </div>
          )}

          <button onClick={() => setStep('part')} style={{
            width: '100%', padding: '10px', borderRadius: '10px', marginTop: '12px',
            fontSize: '12px', fontWeight: 700, background: 'transparent',
            border: `1px solid ${theme.border}`, color: theme.textMuted, cursor: 'pointer',
          }}>← Back</button>
        </div>
      )}

      {/* ─── STEP 3: Scan VINs ─── */}
      {step === 'scan' && (
        <div>
          {/* Locked banner */}
          <div style={{
            padding: '10px 14px', borderRadius: '10px', marginBottom: '12px',
            background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)',
          }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary }}>{partLabel}</div>
            {partDesc && <div style={{ fontSize: '11px', color: theme.textSecondary }}>{partDesc}</div>}
            {(selectedCustomer || locationBillingOverride(selectedLocation?.name)) && (
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#a78bfa', marginTop: '2px' }}>
                Billing: {selectedCustomer?.label ?? locationBillingOverride(selectedLocation?.name)}
              </div>
            )}
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
              {selectedLocation?.name || 'No location'}
              <span style={{ margin: '0 8px' }}>•</span>
              <span style={{ fontWeight: 700, color: '#60a5fa' }}>{scans.length} scanned today</span>
            </div>
            {!isOffline && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                <span style={{ fontSize: '11px', color: theme.textMuted }}>
                  Crew:{' '}
                  <span style={{ fontWeight: 700, color: theme.textPrimary }}>
                    {crewInfo?.shift
                      ? crewInfo.shift.members.map(m =>
                          `${m.profile_id === user?.id ? 'you' : m.full_name}${m.share_weight !== 1 ? ` ×${m.share_weight}` : ''}`
                        ).join(' + ')
                      : 'just you'}
                  </span>
                  {myCut != null && (
                    <span style={{ fontWeight: 700, color: '#22c55e' }}> · ${myCut.toFixed(2)}/vehicle to you</span>
                  )}
                </span>
                <button onClick={openCrewPanel} style={{
                  padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                  background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
                  color: '#60a5fa', cursor: 'pointer',
                }}>{crewInfo?.shift ? 'Edit' : 'Tag Crew'}</button>
                <a href="/earnings" style={{
                  padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                  background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)',
                  color: '#22c55e', textDecoration: 'none',
                }}>My Earnings</a>
              </div>
            )}
            <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
              <button onClick={() => { closeServerShift(); setStep('part'); setSelectedParts([]); setCustomJob(''); setCustomCustomer(''); setSelectedLocation(null); setScans([]); setShowCustom(false); setPendingScan(null); setUnitNumber(''); try { localStorage.removeItem('scan_session'); } catch {} prefillCustomJobDefaults(); }} style={{
                padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                background: 'rgba(107,114,128,0.08)', border: '1px solid rgba(107,114,128,0.2)',
                color: '#6b7280', cursor: 'pointer',
              }}>Switch Part</button>
              <button onClick={endShift} style={{
                padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                color: '#ef4444', cursor: 'pointer',
              }}>End Shift</button>
            </div>
          </div>

          {/* Proof files */}
          {partProofs.length > 0 && (
            <div style={{ display: 'flex', gap: '4px', marginBottom: '10px', flexWrap: 'wrap' }}>
              {partProofs.map((pf, i) => (
                <button key={i} onClick={() => setShowProof(storage.from(pf.bucket).getPublicUrl(pf.storage_path).data.publicUrl)} style={{
                  padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                  background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
                  color: '#60a5fa', cursor: 'pointer',
                }}>View Proof: {pf.file_name}</button>
              ))}
            </div>
          )}

          {/* Proof viewer modal */}
          {showProof && (
            <div onClick={() => setShowProof(null)} style={{
              position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.9)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
            }}>
              <button onClick={() => setShowProof(null)} style={{ position: 'absolute', top: '12px', right: '16px', padding: '8px 14px', borderRadius: '10px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', fontSize: '12px', fontWeight: 700, zIndex: 210 }}>✕ Close</button>
              {showProof.toLowerCase().includes('.pdf') ? (
                <iframe src={showProof} style={{ width: '100%', maxWidth: '600px', height: 'calc(80vh / var(--ts))', borderRadius: '8px', border: 'none' }} />
              ) : (
                <img src={showProof} alt="Proof" style={{ maxWidth: '100%', maxHeight: 'calc(90vh / var(--ts))', objectFit: 'contain', borderRadius: '8px' }} onClick={e => e.stopPropagation()} />
              )}
            </div>
          )}

          {/* Camera / Text toggle (the RFID flow has its own inside the component) */}
          {!isVerizonRfid && (
            <div style={{ display: 'flex', gap: '4px', marginBottom: '10px', background: theme.card, borderRadius: '10px', padding: '3px' }}>
              <button onClick={() => setScanMode('camera')} style={{
                flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
                background: scanMode === 'camera' ? 'var(--tab-active-bg)' : 'transparent', border: 'none',
                color: scanMode === 'camera' ? 'var(--tab-active-color)' : theme.textMuted,
              }}>Camera</button>
              <button onClick={() => { setScanMode('text'); discardPendingScan(); }} style={{
                flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
                background: scanMode === 'text' ? 'var(--tab-active-bg)' : 'transparent', border: 'none',
                color: scanMode === 'text' ? 'var(--tab-active-color)' : theme.textMuted,
              }}>Type / Scanner</button>
            </div>
          )}

          {isVerizonRfid ? (
            <div style={{ marginBottom: '10px' }}>
              <RfidCapture
                includeVin
                showUnit
                onComplete={handleRfidComplete}
                theme={theme as unknown as Record<string, string>}
              />
            </div>
          ) : scanMode === 'camera' ? (
            <div style={{ marginBottom: '10px' }}>
              <VinScanner onScan={handleCameraScan} continuous paused={!!pendingScan} theme={theme as unknown as Record<string, string>} />

              {/* Confirm captured VIN + optional unit number */}
              {pendingScan && (
                <div style={{
                  marginTop: '8px', padding: '14px', borderRadius: '12px',
                  background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)',
                }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                    Captured VIN
                  </div>
                  <div style={{ fontSize: '15px', fontWeight: 800, fontFamily: 'monospace', letterSpacing: '1px', color: theme.textPrimary, marginBottom: '10px', wordBreak: 'break-all' }}>
                    {pendingScan}
                  </div>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                    Unit # (optional)
                  </div>
                  <input
                    ref={unitRef}
                    value={unitNumber}
                    onChange={e => setUnitNumber(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !vinLoading) confirmPendingScan(); }}
                    placeholder="e.g. 4012"
                    style={{
                      width: '100%', padding: '12px 14px', borderRadius: '10px', fontSize: '15px',
                      fontWeight: 700, border: `1px solid ${theme.border}`, background: theme.card,
                      color: theme.textPrimary, marginBottom: '10px',
                    }}
                  />
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={confirmPendingScan} disabled={vinLoading} style={{
                      flex: 1, padding: '14px', borderRadius: '10px', fontSize: '15px', fontWeight: 800,
                      background: vinLoading ? theme.border : '#22c55e', color: '#fff', border: 'none',
                      cursor: vinLoading ? 'default' : 'pointer', opacity: vinLoading ? 0.6 : 1,
                    }}>{vinLoading ? 'Saving...' : 'Log & Scan Next'}</button>
                    <button onClick={discardPendingScan} disabled={vinLoading} style={{
                      padding: '14px 18px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                      background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textMuted,
                      cursor: vinLoading ? 'default' : 'pointer',
                    }}>Discard</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                ref={vinRef}
                value={vin}
                onChange={e => setVin(e.target.value.toUpperCase())}
                onKeyDown={e => { if (e.key === 'Enter' && vin.trim()) handleScan(); }}
                placeholder="Scan or type VIN..."
                autoFocus
                style={{
                  flex: 1, padding: '14px 16px', borderRadius: '12px', fontSize: '16px',
                  fontFamily: 'monospace', fontWeight: 700, letterSpacing: '1px',
                  border: `1px solid ${theme.border}`, background: theme.card, color: theme.textPrimary,
                }}
              />
              <button onClick={handleScan} disabled={vinLoading || !vin.trim()} style={{
                padding: '14px 20px', borderRadius: '12px', fontSize: '15px', fontWeight: 800,
                background: vinLoading || !vin.trim() ? theme.border : theme.navy,
                color: '#fff', border: 'none',
                cursor: vinLoading || !vin.trim() ? 'default' : 'pointer',
                opacity: vinLoading || !vin.trim() ? 0.5 : 1,
              }}>{vinLoading ? '...' : 'Log'}</button>
            </div>
            <input
              value={unitNumber}
              onChange={e => setUnitNumber(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && vin.trim()) handleScan(); }}
              placeholder="Unit # (optional)"
              style={{
                width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '13px',
                fontWeight: 600, border: `1px solid ${theme.border}`, background: theme.card,
                color: theme.textPrimary,
              }}
            />
          </div>
          )}

          {/* Crew tag checklist (field installers; weights default to an even split) */}
          {crewOpen && (
            <div onClick={() => setCrewOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '520px', background: theme.card, borderTopLeftRadius: '18px', borderTopRightRadius: '18px', padding: '16px', maxHeight: 'calc(92vh / var(--ts))', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>Who&apos;s working this shift?</div>
                  <button onClick={() => setCrewOpen(false)} style={{ fontSize: '12px', fontWeight: 700, color: theme.textMuted, background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
                </div>
                <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '12px' }}>
                  Each scanned vehicle splits its pay across the tagged crew. Even split by default —
                  change a share for an uneven split (2 = double share). Tag/untag anytime; it only
                  affects vehicles scanned after the change.
                </div>

                {(() => {
                  const byId = new Map((crewInfo?.roster || []).map(r => [r.profile_id, r.full_name]));
                  for (const m of crewInfo?.shift?.members || []) {
                    if (!byId.has(m.profile_id)) byId.set(m.profile_id, m.full_name);
                  }
                  if (user && !byId.has(user.id)) byId.set(user.id, 'You');
                  return [...byId.entries()].map(([id, name]) => {
                    const checked = crewDraft.has(id);
                    return (
                      <div key={id} style={{
                        display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                        borderRadius: '10px', marginBottom: '6px',
                        background: checked ? 'rgba(34,197,94,0.06)' : theme.card,
                        border: checked ? '1px solid rgba(34,197,94,0.3)' : `1px solid ${theme.border}`,
                      }}>
                        <button
                          onClick={() => {
                            const next = new Map(crewDraft);
                            if (checked) next.delete(id); else next.set(id, 1);
                            setCrewDraft(next);
                          }}
                          style={{
                            width: '22px', height: '22px', borderRadius: '6px', flexShrink: 0,
                            border: checked ? '2px solid #22c55e' : `2px solid ${theme.border}`,
                            background: checked ? '#22c55e' : 'transparent',
                            color: '#fff', fontSize: '13px', fontWeight: 800, cursor: 'pointer',
                          }}
                        >{checked ? '✓' : ''}</button>
                        <div style={{ flex: 1, fontSize: '13px', fontWeight: 700, color: theme.textPrimary }}>
                          {id === user?.id ? (name === 'You' ? 'You' : `${name} (you)`) : name}
                        </div>
                        {checked && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>share</span>
                            <NumberInput
                              min="0.5" step="0.5" value={crewDraft.get(id)}
                              onChange={e => {
                                const w = parseFloat(e.target.value);
                                if (!isNaN(w) && w > 0) setCrewDraft(new Map(crewDraft).set(id, w));
                              }}
                              style={{
                                width: '56px', padding: '6px 8px', borderRadius: '8px', fontSize: '13px',
                                fontWeight: 700, textAlign: 'center',
                                border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: theme.textPrimary,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}

                {crewError && (
                  <div style={{ padding: '8px 12px', borderRadius: '8px', margin: '8px 0', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, color: theme.error, fontSize: '12px', fontWeight: 600 }}>{crewError}</div>
                )}

                <button
                  onClick={saveCrew}
                  disabled={crewBusy || crewDraft.size === 0}
                  style={{
                    width: '100%', padding: '14px', borderRadius: '10px', fontSize: '14px', fontWeight: 800,
                    marginTop: '8px', border: 'none', color: '#fff',
                    background: crewBusy || crewDraft.size === 0 ? theme.border : '#22c55e',
                    cursor: crewBusy || crewDraft.size === 0 ? 'default' : 'pointer',
                  }}
                >
                  {crewBusy ? 'Saving...' : crewInfo?.shift ? 'Update Crew' : `Tag ${crewDraft.size} ${crewDraft.size === 1 ? 'person' : 'people'} In`}
                </button>
              </div>
            </div>
          )}

          {scanError && (
            <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '8px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, color: theme.error, fontSize: '12px', fontWeight: 600 }}>{scanError}</div>
          )}
          {scanSuccess && (
            <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '8px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)', color: '#22c55e', fontSize: '12px', fontWeight: 700 }}>
              ✓ {scanSuccess}
              {/* Optional completion photo (K8) — one tap to add, zero to skip. */}
              {photoTargets.length > 0 && (
                <span style={{ marginLeft: '8px' }}>
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) await uploadScanPhoto(f);
                    }}
                  />
                  <button
                    onClick={() => photoInputRef.current?.click()}
                    disabled={photoUploading}
                    style={{ padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(34,197,94,0.35)', background: 'transparent', color: '#22c55e', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: photoUploading ? 0.6 : 1 }}
                  >
                    {photoUploading ? 'Uploading…' : photoCount > 0 ? `${photoCount} added · add another` : 'Add photo (optional)'}
                  </button>
                </span>
              )}
            </div>
          )}

          {scans.length > 0 && (
            <div>
              <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                Today&apos;s Scans ({scans.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {scans.map(s => (
                  <div key={s.id} style={{
                    padding: '8px 12px', borderRadius: '8px',
                    background: theme.card, border: `1px solid ${theme.border}`,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textPrimary }}>
                        {[s.vehicle_year, s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ') || 'Unknown'}
                      </div>
                      <div style={{ fontSize: '10px', fontFamily: 'monospace', color: theme.textMuted }}>{s.vin}</div>
                      {s.imei && (
                        <div style={{ fontSize: '9px', fontFamily: 'monospace', color: theme.textMuted, marginTop: '1px' }}>
                          IMEI {s.imei}{s.iccid ? ` · CCID ${s.iccid}` : ''}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                      {s.unit_number && (
                        <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '6px', background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                          Unit {s.unit_number}
                        </span>
                      )}
                      <div style={{ fontSize: '10px', color: theme.textMuted }}>
                        {new Date(s.scanned_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
