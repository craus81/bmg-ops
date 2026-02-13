'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useApp } from '@/components/AppProvider';
import { useAuth } from '@/components/AuthProvider';
import { decodeVIN, isValidVIN } from '@/lib/vin-decoder';

export default function ScanPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { activePart } = useApp();
  const supabase = createClient();

  const [vin, setVin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [savedVehicleId, setSavedVehicleId] = useState<string | null>(null);
  const [poWarning, setPoWarning] = useState('');
  const [poMatch, setPoMatch] = useState('');
  const [mode, setMode] = useState<'camera' | 'text'>('text');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [lastScanned, setLastScanned] = useState('');
  const [scanCount, setScanCount] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<any>(null);
  const foundVinRef = useRef(false);
  const readerRef = useRef<any>(null);
  const scanCountRef = useRef(0);

  useEffect(() => {
    if (mode === 'text' && ref.current) ref.current.focus();
  }, [mode]);

  useEffect(() => {
    return () => { stopCamera(); };
  }, []);

  const stopCamera = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(function(t) { t.stop(); });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  };

  const startCamera = async () => {
    setCameraError('');
    foundVinRef.current = false;
    setLastScanned('');
    setScanCount(0);
    scanCountRef.current = 0;
    try {
      var zxingLibrary = await import('@zxing/library');

      var formats = [
        zxingLibrary.BarcodeFormat.CODE_128,
        zxingLibrary.BarcodeFormat.CODE_39,
        zxingLibrary.BarcodeFormat.CODE_93,
        zxingLibrary.BarcodeFormat.DATA_MATRIX,
        zxingLibrary.BarcodeFormat.QR_CODE,
        zxingLibrary.BarcodeFormat.PDF_417,
        zxingLibrary.BarcodeFormat.ITF,
      ];

      var hints = new Map();
      hints.set(zxingLibrary.DecodeHintType.POSSIBLE_FORMATS, formats);
      hints.set(zxingLibrary.DecodeHintType.TRY_HARDER, true);

      var reader = new zxingLibrary.MultiFormatReader();
      reader.setHints(hints);
      readerRef.current = reader;

      var stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        }
      });
      streamRef.current = stream;

      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraActive(true);

      intervalRef.current = setInterval(function() {
        scanFrame(zxingLibrary);
      }, 200);

    } catch (e: any) {
      if (e?.name === 'NotAllowedError' || e?.message?.includes('Permission')) {
        setCameraError('Camera permission denied. Allow camera access in your browser settings, or use text input.');
      } else if (e?.name === 'NotFoundError') {
        setCameraError('No camera found. Use text input instead.');
      } else {
        setCameraError('Camera error: ' + (e?.message || 'Unknown error'));
      }
    }
  };

  const scanFrame = (zxingLibrary: any) => {
    if (foundVinRef.current) return;
    if (!videoRef.current || !canvasRef.current || !readerRef.current) return;
    var video = videoRef.current;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) return;

    var canvas = canvasRef.current;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    scanCountRef.current = scanCountRef.current + 1;
    setScanCount(scanCountRef.current);

    try {
      var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var len = imageData.data.length / 4;
      var luminances = new Uint8ClampedArray(len);
      for (var i = 0; i < len; i++) {
        var r = imageData.data[i * 4];
        var g = imageData.data[i * 4 + 1];
        var b = imageData.data[i * 4 + 2];
        luminances[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }
      var source = new zxingLibrary.RGBLuminanceSource(luminances, canvas.width, canvas.height);
      var bitmap = new zxingLibrary.BinaryBitmap(new zxingLibrary.HybridBinarizer(source));
      var decoded = readerRef.current.decode(bitmap);
      var raw = decoded.getText().trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
      setLastScanned(raw);
      if (raw.length === 17 && isValidVIN(raw)) {
        foundVinRef.current = true;
        stopCamera();
        setVin(raw);
        handleScanVin(raw);
      }
    } catch (e: any) {
      // no barcode found in this frame
    }
  };

  const handleScanVin = async (v: string) => {
    setError('');
    setLoading(true);
    try {
      var vehicle = await decodeVIN(v);
      setResult({ vin: v, vehicle: vehicle });
    } catch (e) {
      setError('Failed to decode VIN.');
    }
    setLoading(false);
  };

  const switchToCamera = () => {
    setMode('camera');
    setTimeout(function() { startCamera(); }, 300);
  };

  const switchToText = () => {
    stopCamera();
    setMode('text');
  };

  const handleScan = async () => {
    var v = vin.trim().toUpperCase();
    if (!isValidVIN(v)) { setError('Invalid VIN - must be 17 characters.'); return; }
    handleScanVin(v);
  };

  const handleConfirm = async () => {
    if (!result || !user) return;
    var v = result.vin;
    var vehicle = result.vehicle;
    var matchedPoLineId: string | null = null;
    var matchedPoNumber: string | null = null;

    setPoWarning('');
    setPoMatch('');
    setError('');

    // Auto-match to open PO if we have a part number
    if (activePart) {
      // Find open PO line items matching this part number with remaining quantity
      var { data: poLines } = await supabase
        .from('po_line_items')
        .select('*, purchase_orders!inner(id, po_number, status)')
        .eq('part_number', activePart.part_number)
        .eq('purchase_orders.status', 'open');

      var availableLine = (poLines || []).find(function(line: any) {
        return line.installed < line.quantity;
      });

      if (availableLine) {
        matchedPoLineId = availableLine.id;
        matchedPoNumber = (availableLine as any).purchase_orders.po_number;
        setPoMatch('PO #' + matchedPoNumber + ' (' + (availableLine.installed + 1) + '/' + availableLine.quantity + ')');
      } else {
        setPoWarning('No open PO found for part ' + activePart.part_number);
      }
    }

    var insertResult = await supabase
      .from('scanned_vehicles')
      .insert({
        vin: v,
        vehicle_year: vehicle.year,
        vehicle_make: vehicle.make,
        vehicle_model: vehicle.model,
        vehicle_trim: vehicle.trim,
        body_class: vehicle.bodyClass,
        drive_type: vehicle.driveType,
        fuel_type: vehicle.fuelType,
        gvwr: vehicle.gvwr,
        catalog_id: activePart?.id || null,
        part_number: activePart?.part_number || null,
        customer: activePart?.customer || null,
        end_customer: activePart?.end_customer || null,
        po_line_item_id: matchedPoLineId,
        scanned_by: user.id,
      })
      .select()
      .single();
    if (insertResult.error) { setError('Failed to save: ' + insertResult.error.message); return; }

    // Increment installed count on the matched PO line
    if (matchedPoLineId) {
      await supabase.rpc('increment_po_installed', { p_line_id: matchedPoLineId });

      // Check if entire PO is now fulfilled
      var matchedLine = (poLines || []).find(function(l: any) { return l.id === matchedPoLineId; });
      if (matchedLine) {
        var poId = (matchedLine as any).purchase_orders.id;
        var { data: allLines } = await supabase
          .from('po_line_items')
          .select('quantity, installed')
          .eq('po_id', poId);
        var allFulfilled = (allLines || []).every(function(l: any) {
          return l.installed >= l.quantity;
        });
        if (allFulfilled) {
          await supabase.from('purchase_orders').update({ status: 'complete' }).eq('id', poId);
          setPoMatch(function(prev: string) { return prev + ' - PO COMPLETE!'; });
        }
      }
    }

    setSavedVehicleId(insertResult.data.id);
    setConfirmed(true);
  };

  const resetScan = () => {
    setResult(null);
    setConfirmed(false);
    setVin('');
    setSavedVehicleId(null);
    setError('');
    setPoWarning('');
    setPoMatch('');
    setLastScanned('');
    foundVinRef.current = false;
    setScanCount(0);
    scanCountRef.current = 0;
    setMode('camera');
    setTimeout(function() { startCamera(); }, 300);
  };

  var title = result ? [result.vehicle.year, result.vehicle.make, result.vehicle.model].filter(Boolean).join(' ') : '';

  if (!result && !loading && !confirmed) {
    return (
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>Scan VIN</div>
        {activePart && (
          <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '10px 12px', marginBottom: '12px' }}>
            <div style={{ fontWeight: 800, fontSize: '14px' }}>{activePart.part_number} - {activePart.end_customer}</div>
            <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '1px' }}>{activePart.graphic_package} | {activePart.vehicle_type}</div>
          </div>
        )}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', background: '#141e2b', borderRadius: '8px', padding: '3px' }}>
          <button onClick={switchToCamera} style={{ flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, background: mode === 'camera' ? 'rgba(59,130,246,0.15)' : 'transparent', border: 'none', color: mode === 'camera' ? '#60a5fa' : '#4a5f78' }}>Camera</button>
          <button onClick={switchToText} style={{ flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, background: mode === 'text' ? 'rgba(59,130,246,0.15)' : 'transparent', border: 'none', color: mode === 'text' ? '#60a5fa' : '#4a5f78' }}>Type / Scanner</button>
        </div>
        {mode === 'camera' ? (
          <div>
            {cameraError ? (
              <div style={{ padding: '20px', textAlign: 'center', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px' }}>
                <div style={{ color: '#f87171', fontSize: '13px', marginBottom: '12px' }}>{cameraError}</div>
                <button onClick={switchToText} style={{ padding: '10px 20px', borderRadius: '8px', background: '#3b82f6', color: '#fff', fontWeight: 700, fontSize: '13px', border: 'none' }}>Switch to Text Input</button>
              </div>
            ) : (
              <div>
                <div style={{ position: 'relative', borderRadius: '12px', overflow: 'hidden', background: '#000', height: '300px', marginBottom: '8px' }}>
                  <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <div style={{ position: 'absolute', top: '50%', left: '3%', right: '3%', height: '70px', marginTop: '-35px', border: '3px solid rgba(59,130,246,0.8)', borderRadius: '8px', pointerEvents: 'none', boxShadow: '0 0 20px rgba(59,130,246,0.3)' }} />
                  <div style={{ position: 'absolute', bottom: '0', left: '0', right: '0', padding: '10px', background: 'rgba(0,0,0,0.7)' }}>
                    {cameraActive ? (
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '13px', color: '#fff', fontWeight: 700 }}>Hold 4-8 in from barcode</div>
                        {lastScanned ? (
                          <div style={{ fontSize: '13px', color: '#fbbf24', marginTop: '3px', fontFamily: 'monospace', fontWeight: 800 }}>FOUND: {lastScanned} ({lastScanned.length} chars)</div>
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
            <input ref={ref} type="text" value={vin} onChange={(e) => setVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, '').slice(0, 17))} placeholder="Enter or scan 17-char VIN" maxLength={17} style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #1e2d3d', background: '#141e2b', color: '#e8ecf1', fontSize: '18px', letterSpacing: '2px', fontWeight: 700, textAlign: 'center' }} onKeyDown={(e) => { if (e.key === 'Enter' && vin.length === 17) handleScan(); }} />
            <div style={{ textAlign: 'center', marginTop: '4px', fontSize: '13px', fontWeight: 600, color: vin.length === 17 ? '#22c55e' : '#4a5f78' }}>{vin.length}/17 {vin.length === 17 ? 'OK' : ''}</div>
          </div>
        )}
        {error && <div style={{ marginTop: '8px', padding: '8px 12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', color: '#f87171', fontSize: '12px' }}>{error}</div>}
        {mode === 'text' && (
          <button onClick={handleScan} disabled={vin.length !== 17} style={{ width: '100%', padding: '16px', borderRadius: '10px', marginTop: '14px', background: vin.length === 17 ? '#3b82f6' : '#1e2d3d', color: '#fff', fontSize: '16px', fontWeight: 800, opacity: vin.length === 17 ? 1 : 0.4, border: 'none' }}>Decode VIN</button>
        )}
        <button onClick={() => router.push('/home')} style={{ width: '100%', padding: '10px', borderRadius: '10px', marginTop: '8px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>Back</button>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid #1e2d3d', borderTopColor: '#3b82f6', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: '#93c5fd', fontWeight: 600, marginTop: '12px' }}>Decoding VIN...</div>
      </div>
    );
  }

  if (confirmed) {
    return (
      <div style={{ textAlign: 'center', padding: '28px 0' }}>
        <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: poWarning ? 'rgba(251,191,36,0.12)' : 'rgba(34,197,94,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: '30px', color: poWarning ? '#fbbf24' : '#4ade80' }}>{poWarning ? '!' : 'OK'}</div>
        <div style={{ fontSize: '18px', fontWeight: 800 }}>Vehicle Recorded</div>
        <div style={{ color: '#6b7a8d', fontSize: '13px', marginTop: '4px' }}>{title}</div>
        <div style={{ fontFamily: 'monospace', fontSize: '11px', color: '#4a5f78' }}>{result.vin}</div>
        {poMatch && (
          <div style={{ marginTop: '8px', padding: '8px 12px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: '8px', color: '#4ade80', fontSize: '12px', fontWeight: 700 }}>{poMatch}</div>
        )}
        {poWarning && (
          <div style={{ marginTop: '8px', padding: '8px 12px', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '8px', color: '#fbbf24', fontSize: '12px', fontWeight: 700 }}>{poWarning}</div>
        )}
        <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button onClick={() => router.push('/photos?id=' + savedVehicleId)} style={{ width: '100%', padding: '14px', borderRadius: '10px', background: '#8b5cf6', color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none' }}>Add Completion Photos</button>
          <button onClick={() => resetScan()} style={{ width: '100%', padding: '16px', borderRadius: '10px', background: '#3b82f6', color: '#fff', fontWeight: 800, fontSize: '16px', border: 'none' }}>Scan Next VIN</button>
          <button onClick={() => router.push('/home')} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>Home</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>Vehicle Identified</div>
      <div style={{ background: 'linear-gradient(135deg, #1a2a3f, #1e3350)', border: '1px solid #2a4a6f', borderRadius: '14px', padding: '18px', marginBottom: '12px' }}>
        <div style={{ fontSize: '10px', color: '#4a5f78', fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase' }}>VIN</div>
        <div style={{ fontSize: '13px', fontFamily: 'monospace', color: '#93c5fd', fontWeight: 700, letterSpacing: '1.5px', marginTop: '2px', marginBottom: '10px' }}>{result.vin}</div>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>{title || 'Unknown'}</div>
        {result.vehicle.bodyClass && <div style={{ fontSize: '13px', color: '#6b7a8d', marginTop: '2px' }}>{result.vehicle.bodyClass}</div>}
      </div>
      {activePart && (
        <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '10px 12px', marginBottom: '12px', fontSize: '12px' }}>
          <span style={{ color: '#4a5f78' }}>Recording as </span>
          <span style={{ fontWeight: 700, color: '#60a5fa' }}>{activePart.part_number}</span>
          <span style={{ color: '#4a5f78' }}> - {activePart.end_customer}</span>
        </div>
      )}
      {error && <div style={{ marginTop: '8px', padding: '8px 12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', color: '#f87171', fontSize: '12px', marginBottom: '12px' }}>{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button onClick={handleConfirm} style={{ width: '100%', padding: '16px', borderRadius: '10px', background: '#22c55e', color: '#fff', fontSize: '16px', fontWeight: 800, border: 'none' }}>Confirm - Record Vehicle</button>
        <button onClick={() => { setResult(null); setVin(''); }} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>Scan Different VIN</button>
      </div>
    </div>
  );
}
