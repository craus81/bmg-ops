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
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  const handleScan = async () => {
    const v = vin.trim().toUpperCase();
    if (!isValidVIN(v)) { setError('Invalid VIN — must be 17 characters.'); return; }
    setError('');
    setLoading(true);
    try {
      const vehicle = await decodeVIN(v);
      setResult({ vin: v, vehicle });
    } catch {
      setError('Failed to decode VIN.');
    }
    setLoading(false);
  };

  const handleConfirm = async () => {
    if (!result || !user) return;
    const { vin: v, vehicle } = result;

    // Save to database
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

    // Decrement PO if active part
    if (activePart) {
      await supabase.rpc('decrement_po_line', { p_part_number: activePart.part_number });
    }

    setSavedVehicleId(data.id);
    setConfirmed(true);
  };

  const title = result ? [result.vehicle.year, result.vehicle.make, result.vehicle.model].filter(Boolean).join(' ') : '';

  // Scan input screen
  if (!result && !loading && !confirmed) {
    return (
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Scan VIN
        </div>
        {activePart && (
          <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '10px 12px', marginBottom: '12px' }}>
            <div style={{ fontWeight: 800, fontSize: '14px' }}>{activePart.part_number} — {activePart.end_customer}</div>
            <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '1px' }}>{activePart.graphic_package} • {activePart.vehicle_type}</div>
          </div>
        )}
        <input
          ref={ref}
          type="text"
          value={vin}
          onChange={(e) => setVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, '').slice(0, 17))}
          placeholder="Enter or scan 17-char VIN"
          maxLength={17}
          style={{
            width: '100%', padding: '10px 12px', borderRadius: '8px',
            border: '1px solid #1e2d3d', background: '#141e2b', color: '#e8ecf1',
            fontSize: '18px', letterSpacing: '2px', fontWeight: 700, textAlign: 'center',
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && vin.length === 17) handleScan(); }}
        />
        <div style={{ textAlign: 'center', marginTop: '4px', fontSize: '13px', fontWeight: 600, color: vin.length === 17 ? '#22c55e' : '#4a5f78' }}>
          {vin.length}/17 {vin.length === 17 && '✓'}
        </div>
        {error && <div style={{ marginTop: '8px', padding: '8px 12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', color: '#f87171', fontSize: '12px' }}>{error}</div>}
        <button
          onClick={handleScan}
          disabled={vin.length !== 17}
          style={{
            width: '100%', padding: '16px', borderRadius: '10px', marginTop: '14px',
            background: vin.length === 17 ? '#3b82f6' : '#1e2d3d',
            color: '#fff', fontSize: '16px', fontWeight: 800,
            opacity: vin.length === 17 ? 1 : 0.4,
          }}
        >
          🔍 Decode VIN
        </button>
        <button onClick={() => router.push('/home')} style={{ width: '100%', padding: '10px', borderRadius: '10px', marginTop: '8px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>
          ← Back
        </button>
      </div>
    );
  }

  // Loading
  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid #1e2d3d', borderTopColor: '#3b82f6', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: '#93c5fd', fontWeight: 600, marginTop: '12px' }}>Decoding VIN...</div>
      </div>
    );
  }

  // Confirmed
  if (confirmed) {
    return (
      <div style={{ textAlign: 'center', padding: '28px 0' }}>
        <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(34,197,94,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: '30px', color: '#4ade80' }}>✓</div>
        <div style={{ fontSize: '18px', fontWeight: 800 }}>Vehicle Recorded</div>
        <div style={{ color: '#6b7a8d', fontSize: '13px', marginTop: '4px' }}>
          {title}<br />
          <span style={{ fontFamily: 'monospace', fontSize: '11px', color: '#4a5f78' }}>{result.vin}</span>
        </div>
        <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button onClick={() => router.push(`/photos?id=${savedVehicleId}`)} style={{ width: '100%', padding: '14px', borderRadius: '10px', background: '#8b5cf6', color: '#fff', fontWeight: 800, fontSize: '14px' }}>
            📸 Add Completion Photos
          </button>
          <button onClick={() => { setResult(null); setConfirmed(false); setVin(''); setSavedVehicleId(null); }} style={{ width: '100%', padding: '16px', borderRadius: '10px', background: '#3b82f6', color: '#fff', fontWeight: 800, fontSize: '16px' }}>
            📷 Scan Next VIN
          </button>
          <button onClick={() => router.push('/home')} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>
            ← Home
          </button>
        </div>
      </div>
    );
  }

  // Result screen
  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
        Vehicle Identified
      </div>
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
          <span style={{ color: '#4a5f78' }}> — {activePart.end_customer}</span>
        </div>
      )}
      {error && <div style={{ marginTop: '8px', padding: '8px 12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', color: '#f87171', fontSize: '12px', marginBottom: '12px' }}>{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button onClick={handleConfirm} style={{ width: '100%', padding: '16px', borderRadius: '10px', background: '#22c55e', color: '#fff', fontSize: '16px', fontWeight: 800 }}>
          ✓ Confirm — Record Vehicle
        </button>
        <button onClick={() => { setResult(null); setVin(''); }} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>
          ✕ Scan Different VIN
        </button>
      </div>
    </div>
  );
}
