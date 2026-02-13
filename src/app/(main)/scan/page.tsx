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
  const [mode, setMode] = useState<'camera' | 'text'>('text');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<any>(null);

  useEffect(() => {
    if (mode === 'text' && ref.current) ref.current.focus();
  }, [mode]);

  useEffect(() => {
    return () => { stopCamera(); };
  }, []);

  const stopCamera = async () => {
    if (scannerRef.current) {
      try {
        const state = scannerRef.current.getState();
        if (state === 2) {
          await scannerRef.current.stop();
        }
        scannerRef.current.clear();
      } catch (e) {
        // ignore cleanup errors
      }
      scannerRef.current = null;
    }
    setCameraActive(false);
  };

  const startCamera = async () => {
    setCameraError('');
    try {
      const { Html5Qrcode } = await import('html5-qrcode');
      await stopCamera();
      const scanner = new Html5Qrcode('barcode-reader');
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 280, height: 100 }, aspectRatio: 1.777 },
        (decodedText: string) => {
          const raw = decodedText.trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
          if (raw.length === 17 && isValidVIN(raw)) {
            stopCamera();
            setVin(raw);
            handleScanVin(raw);
          }
        },
        () => {}
      );
      setCameraActive(true);
    } catch (e: any) {
      if (e?.message?.includes('Permission')) {
        setCameraError('Camera permission denied. Allow camera access and try again, or use text input.');
      } else if (e?.message?.includes('NotFound') || e?.message?.includes('Requested device not found')) {
        setCameraError('No camera found. Use text input instead.');
      } else {
        setCameraError('Camera error: ' + (e?.message || 'Unknown error'));
      }
    }
  };

  const handleScanVin = async (v: string) => {
    setError('');
    setLoading(true);
    try {
      const vehicle = await decodeVIN(v);
      setResult({ vin: v, vehicle });
    } catch (e) {
      setError('Failed to decode VIN.');
    }
    setLoading(false);
  };

  const switchToCamera = () => {
    setMode('camera');
    setTimeout(() => startCamera(), 200);
  };

  const switchToText = () => {
    stopCamera();
    setMode('text');
  };

  const handleScan = async () => {
    const v = vin.trim().toUpperCase();
    if (!isValidVIN(v)) { setError('Invalid VIN - must be 17 characters.'); return; }
    handleScanVin(v);
  };

  const handleConfirm = async () => {
    if (!result || !user) return;
    const { vin: v, vehicle } = result;
    const { data, error: dbErr } = await supabase
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
        scanned_by: user.id,
      })
      .select()
      .single();
    if (dbErr) { setError('Failed to save: ' + dbErr.message); return; }
    if (activePart) {
      await supabase.rpc('decrement_po_line', { p_part_number: activePart.part_number });
    }
    setSavedVehicleId(data.id);
    setConfirmed(true);
  };

  const resetScan = () => {
    setResult(null);
    setConfirmed(false);
    setVin('');
    setSavedVehicleId(null);
    setError('');
  };

  const title = result ? [result.vehicle.year, result.vehicle.make, result.vehicle.model].filter(Boolean).join(' ') : '';

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
                <div id="barcode-reader" style={{ borderRadius: '12px', overflow: 'hidden', marginBottom: '12px' }}></div>
                {cameraActive && (
                  <div style={{ textAlign: 'center', fontSize: '11px', color: '#93c5fd', fontWeight: 600 }}>Point at VIN barcode...</div>
                )}
                {!cameraActive && !cameraError && (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: '#4a5f78', fontSize: '13px' }}>Starting camera...</div>
                )}
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
        <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(34,197,94,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: '30px', color: '#4ade80' }}>OK</div>
        <div style={{ fontSize: '18px', fontWeight: 800 }}>Vehicle Recorded</div>
        <div style={{ color: '#6b7a8d', fontSize: '13px', marginTop: '4px' }}>{title}</div>
        <div style={{ fontFamily: 'monospace', fontSize: '11px', color: '#4a5f78' }}>{result.vin}</div>
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
