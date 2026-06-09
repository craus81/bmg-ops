'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import VinScanner from '@/components/VinScanner';
import { locationBillingOverride } from '@/lib/scan-billing';

interface Part {
  id: string;
  item_number: string;
  display_name: string | null;
  description: string | null;
  billable_customer: string | null;
  catalog: string;
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

// Verizon RFID installs get an extra capture flow: after the VIN, the
// installer scans three device identifiers off the unit's label (serial,
// IMEI, ICCID). This is gated to exactly this part number — every other part
// keeps the plain VIN flow.
const VERIZON_RFID_PART = '06CS901033';
// Part numbers visually conflate O/0; normalize before comparing.
const normalizePartNumber = (s: string) => (s || '').toUpperCase().replace(/O/g, '0').replace(/\s+/g, '');

// The three device identifiers, scanned in order after the VIN.
type RfidStage = 'vin' | 'serial' | 'imei' | 'iccid' | 'review';
const RFID_ORDER: Exclude<RfidStage, 'review'>[] = ['vin', 'serial', 'imei', 'iccid'];
const RFID_LABELS: Record<Exclude<RfidStage, 'review'>, string> = {
  vin: 'VIN', serial: 'Serial # (SN)', imei: 'IMEI', iccid: 'CCID (ICCID)',
};
// Per-field acceptance. `vin` uses the scanner's built-in VIN validation
// (no override), so it's absent here. Each returns the cleaned value or null.
const validateSerial = (raw: string): string | null => {
  const c = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length >= 4 ? c : null;
};
const validateImei = (raw: string): string | null => {
  const d = raw.replace(/\D/g, '');
  return d.length === 15 ? d : null;
};
const validateIccid = (raw: string): string | null => {
  const d = raw.replace(/\D/g, '');
  return d.length >= 18 && d.length <= 22 ? d : null;
};
const RFID_VALIDATORS: Record<Exclude<RfidStage, 'review' | 'vin'>, (raw: string) => string | null> = {
  serial: validateSerial, imei: validateImei, iccid: validateIccid,
};

export default function ScanPage() {
  const { user } = useAuth();
  const supabase = createClient();

  // Step state
  const [step, setStep] = useState<'part' | 'location' | 'scan'>('part');

  // Part selection
  const [parts, setParts] = useState<Part[]>([]);
  const [partSearch, setPartSearch] = useState('');
  const [selectedParts, setSelectedParts] = useState<Part[]>([]);
  const [customJob, setCustomJob] = useState('');
  const [customCustomer, setCustomCustomer] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  // Location selection
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);

  // Scanning
  const [vin, setVin] = useState('');
  const [unitNumber, setUnitNumber] = useState('');
  const [vinLoading, setVinLoading] = useState(false);
  const [scans, setScans] = useState<ScanEntry[]>([]);
  const [scanError, setScanError] = useState('');
  const [scanSuccess, setScanSuccess] = useState('');
  // VIN captured by the camera, awaiting confirmation (+ optional unit #).
  // While set, the camera stays on but pauses detection.
  const [pendingScan, setPendingScan] = useState<string | null>(null);
  const vinRef = useRef<HTMLInputElement>(null);
  const unitRef = useRef<HTMLInputElement>(null);
  const [scanMode, setScanMode] = useState<'text' | 'camera'>('text');

  // Verizon RFID multi-field capture (only active for VERIZON_RFID_PART).
  const [rfidStage, setRfidStage] = useState<Exclude<RfidStage, never>>('vin');
  const [rfidData, setRfidData] = useState<{ vin?: string; serial?: string; imei?: string; iccid?: string }>({});
  // Value captured by the camera for the current stage, awaiting confirmation.
  const [rfidPending, setRfidPending] = useState<string | null>(null);
  const [rfidManual, setRfidManual] = useState('');
  const rfidManualRef = useRef<HTMLInputElement>(null);

  // Part files/proofs
  const [partProofs, setPartProofs] = useState<{ file_name: string; storage_path: string; bucket: 'graphics-proofs' | 'proofs' }[]>([]);
  const [showProof, setShowProof] = useState<string | null>(null);

  // Offline
  const [isOffline, setIsOffline] = useState(false);
  const [pendingOfflineScans, setPendingOfflineScans] = useState<any[]>([]);

  useEffect(() => {
    loadParts();
    loadLocations();

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
    try {
      const session = localStorage.getItem('scan_session');
      if (session) {
        const s = JSON.parse(session);
        if (s.selectedParts) { setSelectedParts(s.selectedParts); }
        else if (s.selectedPart) { setSelectedParts([s.selectedPart]); } // migrate old sessions
        if (s.customJob) { setCustomJob(s.customJob); setShowCustom(true); }
        if (s.customCustomer) { setCustomCustomer(s.customCustomer); }
        if (s.selectedLocation) { setSelectedLocation(s.selectedLocation); }
        if (s.selectedParts?.length || s.selectedPart || s.customJob) { setStep(s.selectedLocation ? 'scan' : 'location'); }
      }
    } catch {}

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, []);

  // Persist active session
  useEffect(() => {
    if (selectedParts.length > 0 || customJob) {
      try {
        localStorage.setItem('scan_session', JSON.stringify({ selectedParts, customJob, customCustomer, selectedLocation }));
      } catch {}
    }
  }, [selectedParts, customJob, customCustomer, selectedLocation]);

  const resetRfid = () => {
    setRfidStage('vin');
    setRfidData({});
    setRfidPending(null);
    setRfidManual('');
  };

  const endShift = () => {
    setStep('part');
    setSelectedParts([]);
    setCustomJob('');
    setCustomCustomer('');
    setSelectedLocation(null);
    setScans([]);
    setShowCustom(false);
    setVin('');
    setUnitNumber('');
    setPendingScan(null);
    resetRfid();
    try { localStorage.removeItem('scan_session'); } catch {}
  };

  // Two catalogs feed the picker:
  //   * netsuite_parts — synced from NetSuite + PO-imported parts (used by
  //     /parts, by invoicing, etc.)
  //   * catalog        — the graphics catalog at /admin/catalog (proofs,
  //     vehicle types, end customers — what graphics installers track).
  // They're separate tables and historically the scan picker only saw
  // netsuite_parts, so parts that lived only in the graphics catalog
  // (e.g. 06U183) were silently invisible here. Load both, normalize into
  // the Part shape, and de-dupe by item_number (prefer netsuite_parts when
  // both exist — it carries upstream NetSuite/PO billing context).
  const loadParts = async () => {
    const [netsuiteParts, catalogParts] = await Promise.all([
      loadNetsuiteParts(),
      loadCatalogParts(),
    ]);

    const byItem = new Map<string, Part>();
    for (const p of catalogParts) byItem.set(p.item_number.toUpperCase(), p);
    for (const p of netsuiteParts) byItem.set(p.item_number.toUpperCase(), p);

    const all = [...byItem.values()].sort((a, b) =>
      a.item_number.localeCompare(b.item_number)
    );
    setParts(all);
    try { localStorage.setItem('cached_parts', JSON.stringify(all)); } catch {}
  };

  const loadNetsuiteParts = async (): Promise<Part[]> => {
    const all: Part[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data } = await supabase
        .from('netsuite_parts')
        .select('id, item_number, display_name, description, billable_customer, catalog')
        .eq('is_active', true)
        .order('item_number')
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      all.push(...(data as Part[]));
      if (data.length < 1000) break;
    }
    return all;
  };

  const loadCatalogParts = async (): Promise<Part[]> => {
    const all: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data } = await supabase
        .from('catalog')
        .select('id, part_number, customer, end_customer, vehicle_type, graphic_package, active')
        .eq('active', true)
        .order('part_number')
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < 1000) break;
    }
    return all.map((c): Part => ({
      // Synthetic prefixed id so it can't collide with netsuite_parts UUIDs.
      // We branch on this prefix when loading proofs (catalog_proofs vs
      // part_files, different storage buckets).
      id: `cat:${c.id}`,
      item_number: c.part_number,
      display_name: [c.vehicle_type, c.graphic_package].filter(Boolean).join(' · ') || c.part_number,
      description: null,
      billable_customer: c.end_customer || c.customer || null,
      catalog: 'graphics',
    }));
  };

  const loadPartProofs = async (part: Part) => {
    if (part.id.startsWith('cat:')) {
      // Catalog items keep their proofs in `catalog_proofs` (storage bucket
      // `proofs`), not `part_files` (`graphics-proofs`).
      const catalogId = part.id.slice(4);
      const { data } = await supabase
        .from('catalog_proofs')
        .select('file_name, file_path')
        .eq('catalog_id', catalogId);
      setPartProofs((data || []).map((p: any) => ({
        file_name: p.file_name,
        storage_path: p.file_path,
        bucket: 'proofs' as const,
      })));
    } else {
      const { data } = await supabase
        .from('part_files')
        .select('file_name, storage_path')
        .eq('part_id', part.id);
      setPartProofs((data || []).map((p: any) => ({
        file_name: p.file_name,
        storage_path: p.storage_path,
        bucket: 'graphics-proofs' as const,
      })));
    }
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

  // ── Verizon RFID multi-field capture ──
  // Camera detected a value for the current stage — hold it for confirmation.
  const handleRfidCameraScan = (value: string) => {
    setScanError('');
    setScanSuccess('');
    setRfidPending(value);
  };

  // Store the value for the current stage and advance to the next one (or to
  // the review screen after the last field).
  const advanceRfid = (value: string) => {
    setRfidData(prev => ({ ...prev, [rfidStage]: value }));
    setRfidPending(null);
    setRfidManual('');
    const idx = RFID_ORDER.indexOf(rfidStage as Exclude<RfidStage, 'review'>);
    setRfidStage(idx < RFID_ORDER.length - 1 ? RFID_ORDER[idx + 1] : 'review');
  };

  const confirmRfidPending = () => {
    if (rfidPending) advanceRfid(rfidPending);
  };

  const rescanRfid = () => {
    setRfidPending(null);
    setScanError('');
  };

  // Manual (typed / hardware-scanner) entry for the current stage.
  const captureRfidManual = () => {
    const raw = rfidManual;
    if (rfidStage === 'review') return;
    if (rfidStage === 'vin') {
      const v = raw.trim().toUpperCase();
      if (v.length < 5) { setScanError('VIN too short'); return; }
      advanceRfid(v);
      return;
    }
    const validator = RFID_VALIDATORS[rfidStage];
    const accepted = validator(raw);
    if (!accepted) { setScanError(`Invalid ${RFID_LABELS[rfidStage]} — check the number and try again`); return; }
    setScanError('');
    advanceRfid(accepted);
  };

  // Jump back to a specific field from the review screen to re-capture it.
  const editRfidStage = (stage: Exclude<RfidStage, 'review'>) => {
    setRfidPending(null);
    setRfidManual('');
    setScanError('');
    setRfidStage(stage);
  };

  // Log the completed device record (VIN + all three identifiers).
  const logRfid = async () => {
    const { vin: rVin, serial, imei, iccid } = rfidData;
    if (!rVin || !serial || !imei || !iccid) {
      setScanError('Missing one or more required fields');
      return;
    }
    const ok = await processVin(rVin, unitNumber, { serial_number: serial, imei, iccid });
    if (ok) {
      resetRfid();
      setUnitNumber('');
    }
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
    const unitClean = unit?.trim() || null;

    // Build list of parts to scan (multiple parts = multiple records)
    const partsToScan = selectedParts.length > 0
      ? selectedParts.map(p => ({ partNumber: p.item_number, partDesc: p.display_name || p.description || p.item_number, billable: p.billable_customer || customCustomer || null }))
      : [{ partNumber: customJob, partDesc: customJob, billable: customCustomer || null }];

    // Check for duplicate VIN+part combos
    for (const pt of partsToScan) {
      const { data: existing } = await supabase.from('scan_logs').select('id, scanned_at').eq('vin', v).eq('part_number', pt.partNumber).limit(1);
      if (existing && existing.length > 0) {
        setScanError(`Duplicate — ${v} already scanned for ${pt.partNumber} on ${new Date(existing[0].scanned_at).toLocaleDateString()}`);
        setVinLoading(false);
        return false;
      }
    }

    // IMEI uniquely identifies a device — guard against logging the same unit
    // twice (e.g. re-scanning a vehicle that's already in the system).
    if (deviceFields?.imei) {
      const { data: dupImei } = await supabase.from('scan_logs').select('id, scanned_at').eq('imei', deviceFields.imei).limit(1);
      if (dupImei && dupImei.length > 0) {
        setScanError(`Duplicate — IMEI ${deviceFields.imei} already logged on ${new Date(dupImei[0].scanned_at).toLocaleDateString()}`);
        setVinLoading(false);
        return false;
      }
    }

    let vehicleData: any = {};
    try {
      const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${v}?format=json`);
      const json = await res.json();
      const results = json.Results || [];
      const get = (id: number) => results.find((r: any) => r.VariableId === id)?.Value || null;
      vehicleData = {
        vehicle_year: get(29),
        vehicle_make: get(26),
        vehicle_model: get(28),
        vehicle_trim: get(38),
        body_class: get(5),
      };
    } catch {}

    let lastData: any = null;
    let lastError: any = null;

    // Some locations bill the facility (e.g. Masterack) regardless of the
    // part's end customer — apply that override so the scan_log lands under
    // the right customer in the export/invoice flow.
    const locationOverrideCustomer = locationBillingOverride(selectedLocation?.name);

    for (const pt of partsToScan) {
      const scanData = {
        vin: v,
        ...vehicleData,
        part_number: pt.partNumber,
        part_description: pt.partDesc,
        billable_customer: locationOverrideCustomer ?? pt.billable,
        unit_number: unitClean,
        serial_number: deviceFields?.serial_number ?? null,
        imei: deviceFields?.imei ?? null,
        iccid: deviceFields?.iccid ?? null,
        location_id: selectedLocation?.id || null,
        location_name: selectedLocation?.name || null,
        scanned_by: user?.id,
      };

      if (isOffline) {
        const offlineScan = { ...scanData, id: crypto.randomUUID(), scanned_at: new Date().toISOString() };
        const updated = [...pendingOfflineScans, offlineScan];
        setPendingOfflineScans(updated);
        try { localStorage.setItem('offline_scans', JSON.stringify(updated)); } catch {}
        lastData = offlineScan;
      } else {
        const { data, error } = await supabase.from('scan_logs').insert(scanData).select('id, vin, vehicle_year, vehicle_make, vehicle_model, unit_number, serial_number, imei, iccid, scanned_at').single();
        if (error) lastError = error;
        else lastData = data;
      }
    }

    const unitSuffix = unitClean ? ` · Unit ${unitClean}` : '';
    if (isOffline && lastData) {
      setScans(prev => [lastData as ScanEntry, ...prev]);
      setScanSuccess(`Saved offline: ${[vehicleData.vehicle_year, vehicleData.vehicle_make, vehicleData.vehicle_model].filter(Boolean).join(' ') || v}${unitSuffix} (${partsToScan.length} part${partsToScan.length > 1 ? 's' : ''})`);
    } else if (lastError) {
      setScanError('Failed to save: ' + lastError.message);
      setVinLoading(false);
      return false;
    } else if (lastData) {
      setScans(prev => [lastData as ScanEntry, ...prev]);
      const label = [vehicleData.vehicle_year, vehicleData.vehicle_make, vehicleData.vehicle_model].filter(Boolean).join(' ') || 'Scan logged';
      setScanSuccess(`${label}${unitSuffix}${partsToScan.length > 1 ? ` (${partsToScan.length} parts)` : ''}`);
    }

    setVin('');
    setVinLoading(false);
    setTimeout(() => vinRef.current?.focus(), 100);
    return true;
  };

  const syncOfflineScans = async () => {
    try {
      const cached = localStorage.getItem('offline_scans');
      if (!cached) return;
      const offlineScans = JSON.parse(cached);
      if (offlineScans.length === 0) return;
      for (const scan of offlineScans) {
        const { id, scanned_at, ...rest } = scan;
        await supabase.from('scan_logs').insert({ ...rest, scanned_at });
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
  const filteredParts = partSearch
    ? (() => {
        const s = normalizePartSearch(partSearch);
        return parts.filter(p =>
          normalizePartSearch(p.item_number || '').includes(s) ||
          normalizePartSearch(p.display_name || '').includes(s) ||
          normalizePartSearch(p.description || '').includes(s) ||
          normalizePartSearch(p.billable_customer || '').includes(s)
        ).slice(0, 50);
      })()
    : [];

  // Active only when the Verizon RFID part is the sole selected part — combining
  // it with other parts falls back to the plain VIN flow (the device fields
  // belong to one part, not a multi-part batch).
  const isVerizonRfid = selectedParts.length === 1
    && normalizePartNumber(selectedParts[0].item_number) === VERIZON_RFID_PART;

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

      {/* ─── STEP 1: Pick Part ─── */}
      {step === 'part' && (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
            What are you working on?
          </div>

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
                ? `No matches in ${parts.length} active parts`
                : `${filteredParts.length}${filteredParts.length === 50 ? '+' : ''} of ${parts.length} parts`}
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
                          {p.id.startsWith('cat:') && (
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
          {selectedParts.length > 0 && (
            <button onClick={() => setStep('location')} style={{
              width: '100%', padding: '14px', borderRadius: '12px', fontSize: '15px', fontWeight: 800,
              background: theme.navy, color: '#fff', border: 'none', cursor: 'pointer',
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
                color: theme.textPrimary, fontWeight: 600, marginBottom: '8px',
              }} />
              <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '6px' }}>Billable Customer</div>
              <input value={customCustomer} onChange={e => setCustomCustomer(e.target.value)} placeholder='e.g. "Designs That Stick"' style={{
                width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '14px',
                border: `1px solid ${theme.border}`, background: 'var(--input-bg)',
                color: theme.textPrimary, fontWeight: 600, marginBottom: '10px',
              }} />
              <button onClick={() => { if (customJob.trim()) setStep('location'); }} disabled={!customJob.trim()} style={{
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
            {locationBillingOverride(selectedLocation?.name) && (
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#a78bfa', marginTop: '2px' }}>
                Billing: {locationBillingOverride(selectedLocation?.name)}
              </div>
            )}
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
              {selectedLocation?.name || 'No location'}
              <span style={{ margin: '0 8px' }}>•</span>
              <span style={{ fontWeight: 700, color: '#60a5fa' }}>{scans.length} scanned today</span>
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
              <button onClick={() => { setStep('part'); setSelectedParts([]); setCustomJob(''); setCustomCustomer(''); setSelectedLocation(null); setScans([]); setShowCustom(false); setPendingScan(null); setUnitNumber(''); resetRfid(); try { localStorage.removeItem('scan_session'); } catch {} }} style={{
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
                <iframe src={showProof} style={{ width: '100%', maxWidth: '600px', height: '80vh', borderRadius: '8px', border: 'none' }} />
              ) : (
                <img src={showProof} alt="Proof" style={{ maxWidth: '100%', maxHeight: '90vh', objectFit: 'contain', borderRadius: '8px' }} onClick={e => e.stopPropagation()} />
              )}
            </div>
          )}

          {/* Camera / Text toggle */}
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

          {isVerizonRfid ? (
            <div style={{ marginBottom: '10px' }}>
              {/* Progress: VIN → SN → IMEI → CCID. Tap a captured field to redo it. */}
              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                {RFID_ORDER.map(st => {
                  const val = rfidData[st];
                  const isCurrent = rfidStage === st;
                  return (
                    <button key={st} onClick={() => editRfidStage(st)} disabled={!val && !isCurrent} style={{
                      flex: '1 1 0', minWidth: '70px', padding: '8px 6px', borderRadius: '8px', textAlign: 'left',
                      border: `1px solid ${val ? 'rgba(34,197,94,0.4)' : isCurrent ? 'rgba(59,130,246,0.5)' : theme.border}`,
                      background: val ? 'rgba(34,197,94,0.06)' : isCurrent ? 'rgba(59,130,246,0.08)' : theme.card,
                      cursor: (val || isCurrent) ? 'pointer' : 'default', opacity: (val || isCurrent) ? 1 : 0.5,
                    }}>
                      <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.4px', color: theme.textMuted, textTransform: 'uppercase' }}>{RFID_LABELS[st]}</div>
                      <div style={{ fontSize: '11px', fontWeight: 700, fontFamily: 'monospace', color: val ? '#22c55e' : theme.textMuted, marginTop: '2px', wordBreak: 'break-all' }}>
                        {val ? (val.length > 10 ? `…${val.slice(-9)}` : val) : isCurrent ? 'scanning…' : '—'}
                      </div>
                    </button>
                  );
                })}
              </div>

              {rfidStage !== 'review' ? (
                <>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textPrimary, marginBottom: '8px' }}>
                    Step {RFID_ORDER.indexOf(rfidStage as Exclude<RfidStage, 'review'>) + 1} of 4 — scan the <span style={{ color: '#60a5fa' }}>{RFID_LABELS[rfidStage]}</span>
                  </div>

                  {scanMode === 'camera' ? (
                    <div>
                      <VinScanner
                        onScan={handleRfidCameraScan}
                        continuous
                        paused={!!rfidPending}
                        validate={rfidStage === 'vin' ? undefined : RFID_VALIDATORS[rfidStage as Exclude<RfidStage, 'review' | 'vin'>]}
                        scanLabel={RFID_LABELS[rfidStage]}
                        theme={theme as unknown as Record<string, string>}
                      />

                      {rfidPending && (
                        <div style={{ marginTop: '8px', padding: '14px', borderRadius: '12px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)' }}>
                          <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                            Captured {RFID_LABELS[rfidStage]}
                          </div>
                          <div style={{ fontSize: '16px', fontWeight: 800, fontFamily: 'monospace', letterSpacing: '1px', color: theme.textPrimary, marginBottom: '10px', wordBreak: 'break-all' }}>
                            {rfidPending}
                          </div>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button onClick={confirmRfidPending} style={{
                              flex: 1, padding: '14px', borderRadius: '10px', fontSize: '15px', fontWeight: 800,
                              background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer',
                            }}>{rfidStage === 'iccid' ? 'Confirm — Review' : 'Confirm & Next'}</button>
                            <button onClick={rescanRfid} style={{
                              padding: '14px 18px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                              background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textMuted, cursor: 'pointer',
                            }}>Rescan</button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
                      <input
                        ref={rfidManualRef}
                        value={rfidManual}
                        onChange={e => setRfidManual(e.target.value.toUpperCase())}
                        onKeyDown={e => { if (e.key === 'Enter' && rfidManual.trim()) captureRfidManual(); }}
                        placeholder={`Scan or type ${RFID_LABELS[rfidStage]}...`}
                        autoFocus
                        style={{
                          flex: 1, padding: '14px 16px', borderRadius: '12px', fontSize: '16px',
                          fontFamily: 'monospace', fontWeight: 700, letterSpacing: '1px',
                          border: `1px solid ${theme.border}`, background: theme.card, color: theme.textPrimary,
                        }}
                      />
                      <button onClick={captureRfidManual} disabled={!rfidManual.trim()} style={{
                        padding: '14px 20px', borderRadius: '12px', fontSize: '15px', fontWeight: 800,
                        background: !rfidManual.trim() ? theme.border : theme.navy, color: '#fff', border: 'none',
                        cursor: !rfidManual.trim() ? 'default' : 'pointer', opacity: !rfidManual.trim() ? 0.5 : 1,
                      }}>Next</button>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ padding: '14px', borderRadius: '12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)' }}>
                  <div style={{ fontSize: '11px', fontWeight: 800, color: theme.textPrimary, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>
                    Review device
                  </div>
                  {RFID_ORDER.map(st => (
                    <div key={st} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${theme.border}` }}>
                      <div>
                        <div style={{ fontSize: '9px', fontWeight: 800, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{RFID_LABELS[st]}</div>
                        <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace', color: theme.textPrimary, wordBreak: 'break-all' }}>{rfidData[st] || '—'}</div>
                      </div>
                      <button onClick={() => editRfidStage(st)} style={{
                        padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                        background: 'rgba(107,114,128,0.08)', border: '1px solid rgba(107,114,128,0.2)', color: '#6b7280', cursor: 'pointer', flexShrink: 0,
                      }}>Redo</button>
                    </div>
                  ))}
                  <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', margin: '10px 0 4px' }}>
                    Unit # (optional)
                  </div>
                  <input
                    value={unitNumber}
                    onChange={e => setUnitNumber(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !vinLoading) logRfid(); }}
                    placeholder="e.g. 4012"
                    style={{
                      width: '100%', padding: '12px 14px', borderRadius: '10px', fontSize: '15px', fontWeight: 700,
                      border: `1px solid ${theme.border}`, background: theme.card, color: theme.textPrimary, marginBottom: '10px',
                    }}
                  />
                  <button onClick={logRfid} disabled={vinLoading} style={{
                    width: '100%', padding: '14px', borderRadius: '10px', fontSize: '15px', fontWeight: 800,
                    background: vinLoading ? theme.border : '#22c55e', color: '#fff', border: 'none',
                    cursor: vinLoading ? 'default' : 'pointer', opacity: vinLoading ? 0.6 : 1,
                  }}>{vinLoading ? 'Saving...' : 'Log & Scan Next'}</button>
                </div>
              )}
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

          {scanError && (
            <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '8px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, color: theme.error, fontSize: '12px', fontWeight: 600 }}>{scanError}</div>
          )}
          {scanSuccess && (
            <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '8px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)', color: '#22c55e', fontSize: '12px', fontWeight: 700 }}>✓ {scanSuccess}</div>
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
