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
  scanned_at: string;
}

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

  // Part files/proofs
  const [partProofs, setPartProofs] = useState<{ file_name: string; storage_path: string }[]>([]);
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
    try { localStorage.removeItem('scan_session'); } catch {}
  };

  const loadParts = async () => {
    const { data } = await supabase
      .from('netsuite_parts')
      .select('id, item_number, display_name, description, billable_customer, catalog')
      .eq('is_active', true)
      .order('item_number');
    setParts((data || []) as Part[]);
    try { localStorage.setItem('cached_parts', JSON.stringify(data || [])); } catch {}
  };

  const loadPartProofs = async (partId: string) => {
    const { data } = await supabase.from('part_files').select('file_name, storage_path').eq('part_id', partId);
    setPartProofs((data || []) as { file_name: string; storage_path: string }[]);
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
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, unit_number, scanned_at')
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

  const handleScan = async () => {
    const v = vin.trim().toUpperCase();
    const ok = await processVin(v, unitNumber);
    if (ok) setUnitNumber('');
  };

  const processVin = async (v: string, unit?: string): Promise<boolean> => {
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
        const { data, error } = await supabase.from('scan_logs').insert(scanData).select('id, vin, vehicle_year, vehicle_make, vehicle_model, unit_number, scanned_at').single();
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

  const filteredParts = partSearch
    ? parts.filter(p => {
        const s = partSearch.toLowerCase();
        return p.item_number.toLowerCase().includes(s) ||
          p.display_name?.toLowerCase().includes(s) ||
          p.description?.toLowerCase().includes(s) ||
          p.billable_customer?.toLowerCase().includes(s);
      }).slice(0, 20)
    : [];

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
                      loadPartProofs(p.id);
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
                        <div style={{ fontWeight: 700, fontSize: '14px', color: theme.textPrimary }}>{p.item_number}</div>
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
              <button onClick={() => { setStep('part'); setSelectedParts([]); setCustomJob(''); setCustomCustomer(''); setSelectedLocation(null); setScans([]); setShowCustom(false); setPendingScan(null); setUnitNumber(''); try { localStorage.removeItem('scan_session'); } catch {} }} style={{
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
                <button key={i} onClick={() => setShowProof(storage.from('graphics-proofs').getPublicUrl(pf.storage_path).data.publicUrl)} style={{
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

          {scanMode === 'camera' ? (
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
