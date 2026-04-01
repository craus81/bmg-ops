'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { decodeVIN, isValidVIN } from '@/lib/vin-decoder';
import { theme } from '@/lib/theme';
import type { NetsuiteSalesOrder, GraphicsProof, FleetCheckin } from '@/lib/types';
import SalesOrderPdf from '@/components/SalesOrderPdf';

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

// ─── Main Fleet Page ───────────────────────────────────────────
export default function FleetPage() {
  const { user, profile } = useAuth();
  const router = useRouter();
  const supabase = createClient();

  // Workflow state
  const [step, setStep] = useState(0);

  // Step 1: VIN
  const [vin, setVin] = useState('');
  const [vinLoading, setVinLoading] = useState(false);
  const [vinError, setVinError] = useState('');
  const [vehicleData, setVehicleData] = useState<any>(null);
  const [mode, setMode] = useState<'camera' | 'text'>('text');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [lastScanned, setLastScanned] = useState('');
  const [scanCount, setScanCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<any>(null);
  const foundVinRef = useRef(false);
  const readerRef = useRef<any>(null);
  const scanCountRef = useRef(0);

  // Step 2: Sales Order
  const [customerSearch, setCustomerSearch] = useState('');
  const [salesOrders, setSalesOrders] = useState<NetsuiteSalesOrder[]>([]);
  const [soLoading, setSoLoading] = useState(false);
  const [soError, setSoError] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<NetsuiteSalesOrder | null>(null);
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);

  // Step 3: Proof
  const [proofs, setProofs] = useState<GraphicsProof[]>([]);
  const [proofLoading, setProofLoading] = useState(false);
  const [selectedProof, setSelectedProof] = useState<GraphicsProof | null>(null);
  const [proofSearch, setProofSearch] = useState('');

  // Dropbox proof search
  const [dbxResults, setDbxResults] = useState<{ id: string; name: string; path: string; size: number; modified: string; folder: string }[]>([]);
  const [dbxSearching, setDbxSearching] = useState(false);
  const [dbxSelected, setDbxSelected] = useState<{ name: string; path: string } | null>(null);
  const [dbxConnected, setDbxConnected] = useState<boolean | null>(null);

  // Final
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedCheckin, setSavedCheckin] = useState<FleetCheckin | null>(null);
  const [notes, setNotes] = useState('');
  const [manualCustomerName, setManualCustomerName] = useState('');

  // Recent check-ins
  const [recentCheckins, setRecentCheckins] = useState<FleetCheckin[]>([]);
  const [showRecent, setShowRecent] = useState(false);

  useEffect(() => {
    if (mode === 'text' && inputRef.current) inputRef.current.focus();
  }, [mode]);

  useEffect(() => {
    return () => { stopCamera(); };
  }, []);

  useEffect(() => {
    loadRecentCheckins();
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
  const stopCamera = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if ((streamRef as any)?._refocusInterval) { clearInterval((streamRef as any)._refocusInterval); (streamRef as any)._refocusInterval = null; }
    if ((streamRef as any)?._focusKickInterval) { clearInterval((streamRef as any)._focusKickInterval); (streamRef as any)._focusKickInterval = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
  };

  const startCamera = async () => {
    setCameraError('');
    foundVinRef.current = false;
    setLastScanned('');
    setScanCount(0);
    scanCountRef.current = 0;
    try {
      const zxingLibrary = await import('@zxing/library');
      const formats = [
        zxingLibrary.BarcodeFormat.CODE_128, zxingLibrary.BarcodeFormat.CODE_39,
        zxingLibrary.BarcodeFormat.CODE_93, zxingLibrary.BarcodeFormat.DATA_MATRIX,
        zxingLibrary.BarcodeFormat.QR_CODE, zxingLibrary.BarcodeFormat.PDF_417,
        zxingLibrary.BarcodeFormat.ITF,
      ];
      const hints = new Map();
      hints.set(zxingLibrary.DecodeHintType.POSSIBLE_FORMATS, formats);
      hints.set(zxingLibrary.DecodeHintType.TRY_HARDER, true);
      const reader = new zxingLibrary.MultiFormatReader();
      reader.setHints(hints);
      readerRef.current = reader;

      // Start with basic constraints — don't include focusMode in getUserMedia
      // as some Android devices reject or ignore it entirely
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraActive(true);

      // Android autofocus: apply focus AFTER stream starts via track constraints
      const track = stream.getVideoTracks()[0];
      if (track) {
        try {
          const caps = track.getCapabilities?.() as any;
          const supportedModes: string[] = caps?.focusMode || [];
          console.log('[Camera] Focus capabilities:', supportedModes);

          if (supportedModes.includes('continuous')) {
            await (track as any).applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
            console.log('[Camera] Set continuous focus');
          } else if (supportedModes.includes('single-shot')) {
            // Trigger single-shot autofocus repeatedly
            const refocusInterval = setInterval(async () => {
              try {
                await (track as any).applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
              } catch { }
            }, 2000);
            (streamRef as any)._refocusInterval = refocusInterval;
            console.log('[Camera] Using periodic single-shot focus');
          }

          // Also try ImageCapture API for devices that support it
          if (typeof ImageCapture !== 'undefined') {
            const imgCapture = new (ImageCapture as any)(track);
            const photoCapabilities = await imgCapture.getPhotoCapabilities?.().catch(() => null);
            console.log('[Camera] ImageCapture available, photo caps:', photoCapabilities);
            // grabFrame forces many Android cameras to autofocus
            const focusKick = setInterval(async () => {
              try { await imgCapture.grabFrame(); } catch { }
            }, 3000);
            (streamRef as any)._focusKickInterval = focusKick;
          }
        } catch (e) { console.log('[Camera] Focus setup error:', e); }
      }

      intervalRef.current = setInterval(() => scanFrame(zxingLibrary), 200);
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') setCameraError('Camera permission denied.');
      else if (e?.name === 'NotFoundError') setCameraError('No camera found.');
      else setCameraError('Camera error: ' + (e?.message || 'Unknown'));
    }
  };

  const scanFrame = (zxingLibrary: any) => {
    if (foundVinRef.current) return;
    if (!videoRef.current || !canvasRef.current || !readerRef.current) return;
    const video = videoRef.current;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    scanCountRef.current++;
    setScanCount(scanCountRef.current);
    try {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const len = imageData.data.length / 4;
      const luminances = new Uint8ClampedArray(len);
      for (let i = 0; i < len; i++) {
        luminances[i] = Math.round(0.299 * imageData.data[i * 4] + 0.587 * imageData.data[i * 4 + 1] + 0.114 * imageData.data[i * 4 + 2]);
      }
      const source = new zxingLibrary.RGBLuminanceSource(luminances, canvas.width, canvas.height);
      const bitmap = new zxingLibrary.BinaryBitmap(new zxingLibrary.HybridBinarizer(source));
      const decoded = readerRef.current.decode(bitmap);
      const raw = decoded.getText().trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
      setLastScanned(raw);
      if (raw.length === 17 && isValidVIN(raw)) {
        foundVinRef.current = true;
        stopCamera();
        setVin(raw);
        handleDecodeVin(raw);
      }
    } catch { /* no barcode in frame */ }
  };

  const switchToCamera = () => { setMode('camera'); setTimeout(() => startCamera(), 300); };
  const switchToText = () => { stopCamera(); setMode('text'); };

  // ─── Step 1: VIN Decode ────────────────────────────────────
  const handleDecodeVin = async (v: string) => {
    setVinError('');
    setVinLoading(true);
    try {
      const vehicle = await decodeVIN(v);
      setVehicleData({ vin: v, vehicle });
      setStep(1);
      // Pre-fill customer search if we find a matching sales order by VIN
    } catch {
      setVinError('Failed to decode VIN.');
    }
    setVinLoading(false);
  };

  const handleVinSubmit = () => {
    const v = vin.trim().toUpperCase();
    if (!isValidVIN(v)) { setVinError('Invalid VIN - must be 17 characters.'); return; }
    handleDecodeVin(v);
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

  const selectSalesOrder = (order: NetsuiteSalesOrder) => {
    setSelectedOrder(order);
    setStep(2);
    setProofSearch(order.customer_name || '');
    loadProofs(order.customer_name);
    if (order.customer_name) searchDropbox(order.customer_name);
  };

  const skipSalesOrder = () => {
    setSelectedOrder(null);
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
  };

  // ─── Save Check-In ────────────────────────────────────────
  const handleSave = async () => {
    if (!vehicleData || !user) return;
    setSaving(true);
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
        proof_filename: dbxSelected?.name || null,
        notes: notes.trim() || null,
        status: 'received',
        checked_in_by: user.id,
        company_id: profile?.company_id || null,
      })
      .select()
      .single();

    if (error) {
      setVinError('Failed to save: ' + error.message);
      setSaving(false);
      return;
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
  };

  // ─── Reset ────────────────────────────────────────────────
  const resetAll = () => {
    setStep(0);
    setVin('');
    setVinError('');
    setVehicleData(null);
    setCustomerSearch('');
    setSalesOrders([]);
    setSoError('');
    setSelectedOrder(null);
    setExpandedOrder(null);
    setProofs([]);
    setSelectedProof(null);
    setDbxResults([]);
    setDbxSelected(null);
    setSaved(false);
    setSavedCheckin(null);
    setNotes('');
    setLastScanned('');
    foundVinRef.current = false;
    setScanCount(0);
    scanCountRef.current = 0;
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
            }}>SO #{savedCheckin.sales_order_number} — {savedCheckin.customer_name}</div>
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

        {/* Sales Order PDF Viewer */}
        <SalesOrderPdf
          salesOrderId={savedCheckin.netsuite_sales_order_id}
          salesOrderNumber={savedCheckin.sales_order_number}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
          <button onClick={resetAll} style={{
            width: '100%', padding: '16px', borderRadius: '14px',
            background: theme.navy, color: '#fff', fontSize: '16px', fontWeight: 800, border: 'none',
          }}>Check In Next Vehicle</button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 0: VIN ENTRY
  // ═══════════════════════════════════════════════════════════
  if (step === 0) {
    return (
      <div>
        <StepIndicator current={0} />
        <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Fleet Check-In
        </div>

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
          <div>
            {cameraError ? (
              <div style={{ padding: '20px', textAlign: 'center', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, borderRadius: '14px' }}>
                <div style={{ color: theme.error, fontSize: '13px', marginBottom: '12px' }}>{cameraError}</div>
                <button onClick={switchToText} style={{ padding: '10px 20px', borderRadius: '10px', background: theme.navy, color: '#fff', fontWeight: 700, fontSize: '13px', border: 'none' }}>Switch to Text Input</button>
              </div>
            ) : (
              <div>
                <div style={{ position: 'relative', borderRadius: '12px', overflow: 'hidden', background: '#000', height: '300px', marginBottom: '8px' }}>
                  <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <div style={{ position: 'absolute', top: '50%', left: '3%', right: '3%', height: '70px', marginTop: '-35px', border: '3px solid rgba(238,49,32,0.7)', borderRadius: '10px', pointerEvents: 'none', boxShadow: '0 0 20px rgba(238,49,32,0.2)' }} />
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '10px', background: 'rgba(0,0,0,0.7)' }}>
                    {cameraActive ? (
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '13px', color: '#fff', fontWeight: 700 }}>Hold 4-8 in from barcode</div>
                        {lastScanned ? (
                          <div style={{ fontSize: '13px', color: theme.warning, marginTop: '3px', fontFamily: 'monospace', fontWeight: 800 }}>FOUND: {lastScanned} ({lastScanned.length} chars)</div>
                        ) : (
                          <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '3px' }}>Scanning... {scanCount} frames</div>
                        )}
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', fontSize: '13px', color: '#9ca3af' }}>Starting camera...</div>
                    )}
                  </div>
                </div>
                <canvas ref={canvasRef} style={{ display: 'none' }} />
              </div>
            )}
          </div>
        ) : (
          <div>
            <input
              ref={inputRef}
              type="text"
              value={vin}
              onChange={(e) => setVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, '').slice(0, 17))}
              placeholder="Enter or scan 17-char VIN"
              maxLength={17}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: '10px',
                border: `1px solid ${theme.border}`, background: theme.card,
                color: theme.textPrimary, fontSize: '18px', letterSpacing: '2px',
                fontWeight: 700, textAlign: 'center',
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && vin.length === 17) handleVinSubmit(); }}
            />
            <div style={{ textAlign: 'center', marginTop: '4px', fontSize: '13px', fontWeight: 600, color: vin.length === 17 ? theme.success : theme.textMuted }}>
              {vin.length}/17 {vin.length === 17 ? 'OK' : ''}
            </div>
          </div>
        )}

        {vinError && (
          <div style={{ marginTop: '8px', padding: '8px 12px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, borderRadius: '10px', color: theme.error, fontSize: '12px' }}>{vinError}</div>
        )}

        {vinLoading && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ width: '28px', height: '28px', border: `3px solid ${theme.border}`, borderTopColor: theme.navy, borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
            <div style={{ color: theme.textMuted, fontWeight: 600, marginTop: '8px', fontSize: '13px' }}>Decoding VIN...</div>
          </div>
        )}

        {mode === 'text' && !vinLoading && (
          <button onClick={handleVinSubmit} disabled={vin.length !== 17} style={{
            width: '100%', padding: '16px', borderRadius: '14px', marginTop: '14px',
            background: vin.length === 17 ? theme.navy : theme.border,
            color: '#fff', fontSize: '16px', fontWeight: 800,
            opacity: vin.length === 17 ? 1 : 0.4, border: 'none',
          }}>Decode VIN</button>
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
                  onClick={() => router.push(`/tracking?vehicle=${ci.id}`)}
                  style={{
                    background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px',
                    padding: '10px 12px', cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: '13px' }}>
                        {[ci.vehicle_year, ci.vehicle_make, ci.vehicle_model].filter(Boolean).join(' ') || 'Unknown'}
                      </div>
                      <div style={{ fontSize: '11px', fontFamily: 'monospace', color: theme.textMuted }}>{ci.vin}</div>
                    </div>
                    <div style={{ textAlign: 'right', marginRight: '8px' }}>
                      {ci.sales_order_number && (
                        <div style={{ fontSize: '11px', fontWeight: 700, color: theme.success }}>SO #{ci.sales_order_number}</div>
                      )}
                      <div style={{ fontSize: '10px', color: theme.textMuted }}>
                        {new Date(ci.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </div>
                    </div>
                    <span style={{ color: theme.textMuted, fontSize: '14px' }}>›</span>
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
          Search Sales Orders
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

        {/* Sales order results */}
        {salesOrders.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
            {salesOrders.map(so => (
              <div key={so.id} style={{
                background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px',
                overflow: 'hidden',
              }}>
                <button
                  onClick={() => setExpandedOrder(expandedOrder === so.id ? null : so.id)}
                  style={{
                    width: '100%', padding: '12px 14px', textAlign: 'left',
                    background: 'transparent', border: 'none', color: theme.textPrimary,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '14px' }}>SO #{so.sales_order_number}</div>
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
                    <button onClick={() => selectSalesOrder(so)} style={{
                      width: '100%', padding: '12px', borderRadius: '10px',
                      background: theme.success, color: '#fff', fontWeight: 800,
                      fontSize: '13px', border: 'none',
                    }}>Select This Order</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Navigation buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
          <button onClick={skipSalesOrder} style={{
            width: '100%', padding: '12px', borderRadius: '14px',
            border: `1px solid ${theme.border}`, background: 'transparent',
            color: theme.textSecondary, fontSize: '13px', fontWeight: 700,
          }}>Skip — No Sales Order</button>
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
              <span style={{ fontSize: '16px' }}>📄</span>
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
                  <span style={{ fontSize: '14px', flexShrink: 0 }}>📄</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                    <div style={{ fontSize: '10px', color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {file.folder ? `📁 ${file.folder}` : file.path} · {(file.size / 1024).toFixed(0)} KB
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
          <button onClick={handleSave} disabled={saving} style={{
            width: '100%', padding: '16px', borderRadius: '14px',
            background: theme.success, color: '#fff', fontSize: '16px', fontWeight: 800,
            border: 'none', opacity: saving ? 0.5 : 1,
          }}>{saving ? 'Saving...' : 'Complete Check-In'}</button>
          <button onClick={() => setStep(1)} style={{
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
