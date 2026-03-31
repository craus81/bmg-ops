'use client';

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { isValidVIN } from '@/lib/vin-decoder';
import StatusBadge from '@/components/StatusBadge';
import type { FleetCheckin, VehicleTrackingStatus, VehicleStatusHistory } from '@/lib/types';
import { VEHICLE_STATUS_PIPELINE, VEHICLE_STATUS_LABELS, VEHICLE_STATUS_COLORS } from '@/lib/types';

export default function FleetUpdatePage() {
  const { user, profile } = useAuth();
  const supabase = createClient();

  // Flow state
  const [step, setStep] = useState<'scan' | 'select' | 'update' | 'done'>('scan');

  // VIN input
  const [vin, setVin] = useState('');
  const [vinError, setVinError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Camera scanning
  const [mode, setMode] = useState<'text' | 'camera'>('text');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<any>(null);
  const readerRef = useRef<any>(null);
  const foundRef = useRef(false);

  // Vehicle selection (if multiple matches)
  const [matchingVehicles, setMatchingVehicles] = useState<FleetCheckin[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Selected vehicle
  const [vehicle, setVehicle] = useState<FleetCheckin | null>(null);
  const [statusHistory, setStatusHistory] = useState<VehicleStatusHistory[]>([]);

  // Status update
  const [newStatus, setNewStatus] = useState<VehicleTrackingStatus | null>(null);
  const [note, setNote] = useState('');
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState('');

  useEffect(() => {
    if (step === 'scan' && mode === 'text' && inputRef.current) inputRef.current.focus();
  }, [step, mode]);

  useEffect(() => {
    return () => stopCamera();
  }, []);

  // ── Camera scanner ──────────────────────────────────────
  const stopCamera = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
  };

  const startCamera = async () => {
    setCameraError('');
    foundRef.current = false;
    try {
      const zxing = await import('@zxing/library');
      const hints = new Map();
      hints.set(zxing.DecodeHintType.POSSIBLE_FORMATS, [
        zxing.BarcodeFormat.CODE_128, zxing.BarcodeFormat.CODE_39,
        zxing.BarcodeFormat.CODE_93, zxing.BarcodeFormat.DATA_MATRIX,
        zxing.BarcodeFormat.QR_CODE, zxing.BarcodeFormat.PDF_417,
        zxing.BarcodeFormat.ITF,
      ]);
      hints.set(zxing.DecodeHintType.TRY_HARDER, true);
      const reader = new zxing.MultiFormatReader();
      reader.setHints(hints);
      readerRef.current = reader;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 },
          // @ts-ignore — focusMode is valid for Android but not in all TS definitions
          focusMode: 'continuous',
          advanced: [{ focusMode: 'continuous' } as any],
        },
      });
      streamRef.current = stream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraActive(true);
      intervalRef.current = setInterval(() => scanFrame(zxing), 200);
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') setCameraError('Camera permission denied.');
      else if (e?.name === 'NotFoundError') setCameraError('No camera found.');
      else setCameraError('Camera error: ' + (e?.message || 'Unknown'));
    }
  };

  const scanFrame = (zxing: any) => {
    if (foundRef.current || !videoRef.current || !canvasRef.current || !readerRef.current) return;
    const video = videoRef.current;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    try {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const len = imageData.data.length / 4;
      const luminances = new Uint8ClampedArray(len);
      for (let i = 0; i < len; i++) {
        luminances[i] = Math.round(0.299 * imageData.data[i * 4] + 0.587 * imageData.data[i * 4 + 1] + 0.114 * imageData.data[i * 4 + 2]);
      }
      const source = new zxing.RGBLuminanceSource(luminances, canvas.width, canvas.height);
      const bitmap = new zxing.BinaryBitmap(new zxing.HybridBinarizer(source));
      const decoded = readerRef.current.decode(bitmap);
      const raw = decoded.getText().trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
      if (raw.length === 17 && isValidVIN(raw)) {
        foundRef.current = true;
        stopCamera();
        setVin(raw);
        searchByVin(raw);
      }
    } catch { /* no barcode */ }
  };

  // ── Search by VIN ───────────────────────────────────────
  const searchByVin = async (vinInput: string) => {
    const v = vinInput.trim().toUpperCase();
    if (!v || v.length < 6) { setVinError('Enter at least 6 characters of the VIN'); return; }
    setVinError('');
    setSearchLoading(true);
    setMatchingVehicles([]);

    const { data, error } = await supabase
      .from('fleet_checkins')
      .select('*')
      .ilike('vin', `%${v}%`)
      .neq('status', 'shipped')
      .order('updated_at', { ascending: false })
      .limit(20);

    setSearchLoading(false);

    if (error) { setVinError('Search failed: ' + error.message); return; }
    if (!data || data.length === 0) { setVinError('No active vehicles found matching this VIN'); return; }

    if (data.length === 1) {
      selectVehicle(data[0]);
    } else {
      setMatchingVehicles(data);
      setStep('select');
    }
  };

  const selectVehicle = async (v: FleetCheckin) => {
    setVehicle(v);
    setStep('update');

    // Load history
    const { data } = await supabase
      .from('vehicle_status_history')
      .select('*')
      .eq('vehicle_id', v.id)
      .order('created_at', { ascending: false })
      .limit(5);
    setStatusHistory(data || []);
  };

  // ── Update status ───────────────────────────────────────
  const handleUpdate = async () => {
    if (!vehicle || !newStatus) return;
    setUpdating(true);
    setUpdateError('');

    try {
      const res = await fetch('/api/vehicle-tracking/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId: vehicle.id,
          newStatus,
          note: note.trim() || null,
        }),
      });
      const result = await res.json();
      if (result.success) {
        setStep('done');
      } else {
        setUpdateError(result.error || 'Failed to update status');
      }
    } catch {
      setUpdateError('Network error — please try again');
    }
    setUpdating(false);
  };

  // ── Reset ───────────────────────────────────────────────
  const resetAll = () => {
    setStep('scan');
    setVin('');
    setVinError('');
    setMatchingVehicles([]);
    setVehicle(null);
    setStatusHistory([]);
    setNewStatus(null);
    setNote('');
    setUpdateError('');
    foundRef.current = false;
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

  // ═══════════════════════════════════════════════════════
  // DONE STATE
  // ═══════════════════════════════════════════════════════
  if (step === 'done' && vehicle && newStatus) {
    const colors = VEHICLE_STATUS_COLORS[newStatus];
    return (
      <div>
        <div style={{ textAlign: 'center', padding: '28px 0' }}>
          <div style={{
            width: '64px', height: '64px', borderRadius: '50%',
            background: colors.bg, border: `2px solid ${colors.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 14px', fontSize: '28px',
          }}>✓</div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Status Updated</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
            {vehicleTitle(vehicle)}
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-muted)' }}>{vehicle.vin}</div>
          <div style={{ marginTop: '10px' }}>
            <StatusBadge status={newStatus} size="md" />
          </div>
          {note && (
            <div style={{
              marginTop: '8px', padding: '8px 14px', background: 'var(--card)',
              border: '1px solid var(--border)', borderRadius: '10px',
              color: 'var(--text-secondary)', fontSize: '12px', fontStyle: 'italic',
            }}>"{note}"</div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
          <button onClick={resetAll} style={{
            width: '100%', padding: '16px', borderRadius: '14px',
            background: 'var(--navy)', color: '#fff', fontSize: '16px', fontWeight: 800, border: 'none',
          }}>Update Another Vehicle</button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════
  // UPDATE STATE — pick status + note
  // ═══════════════════════════════════════════════════════
  if (step === 'update' && vehicle) {
    const currentStatus = (vehicle.status === 'checked_in' ? 'received' : vehicle.status) as VehicleTrackingStatus;

    return (
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Update Vehicle Status
        </div>

        {/* Vehicle card */}
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
          padding: '14px', marginBottom: '14px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: '16px' }}>{vehicleTitle(vehicle)}</div>
              <div style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{vehicle.vin}</div>
              {vehicle.customer_name && (
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>{vehicle.customer_name}</div>
              )}
            </div>
            <StatusBadge status={currentStatus} size="md" />
          </div>
        </div>

        {/* Status selection */}
        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
          Select New Status
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
          {VEHICLE_STATUS_PIPELINE.map(status => {
            const colors = VEHICLE_STATUS_COLORS[status];
            const isCurrent = status === currentStatus;
            const isSelected = status === newStatus;
            return (
              <button
                key={status}
                onClick={() => !isCurrent && setNewStatus(status)}
                disabled={isCurrent}
                style={{
                  width: '100%', padding: '14px 16px', borderRadius: '12px',
                  textAlign: 'left', fontSize: '15px', fontWeight: 700,
                  background: isSelected ? colors.bg : isCurrent ? 'var(--subtle-bg)' : 'var(--card)',
                  border: isSelected ? `2px solid ${colors.text}` : `1px solid ${isCurrent ? 'var(--border-strong)' : 'var(--border)'}`,
                  color: isSelected ? colors.text : isCurrent ? 'var(--text-muted)' : 'var(--text-primary)',
                  opacity: isCurrent ? 0.5 : 1,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
              >
                <span>{VEHICLE_STATUS_LABELS[status]}</span>
                {isCurrent && <span style={{ fontSize: '11px', fontWeight: 600 }}>Current</span>}
                {isSelected && <span style={{ fontSize: '16px' }}>✓</span>}
              </button>
            );
          })}
        </div>

        {/* Note */}
        <div style={{ marginBottom: '14px' }}>
          <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
            Note (optional)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note about this status change..."
            rows={2}
            style={{
              width: '100%', padding: '10px 12px', borderRadius: '10px',
              border: '1px solid var(--border)', background: 'var(--input-bg)',
              color: 'var(--text-primary)', fontSize: '14px', resize: 'vertical',
            }}
          />
        </div>

        {updateError && (
          <div style={{
            padding: '8px 12px', background: 'var(--error-bg)', border: '1px solid var(--error-border)',
            borderRadius: '10px', color: 'var(--error)', fontSize: '12px', marginBottom: '10px',
          }}>{updateError}</div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            onClick={handleUpdate}
            disabled={!newStatus || updating}
            style={{
              width: '100%', padding: '16px', borderRadius: '14px',
              background: newStatus ? VEHICLE_STATUS_COLORS[newStatus].text : 'var(--border)',
              color: '#fff', fontSize: '16px', fontWeight: 800, border: 'none',
              opacity: !newStatus || updating ? 0.4 : 1,
            }}
          >
            {updating ? 'Updating...' : newStatus ? `Set ${VEHICLE_STATUS_LABELS[newStatus]}` : 'Select a Status'}
          </button>
          <button onClick={resetAll} style={{
            width: '100%', padding: '10px', borderRadius: '14px',
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-muted)', fontSize: '12px', fontWeight: 600,
          }}>Cancel</button>
        </div>

        {/* Recent History */}
        {statusHistory.length > 0 && (
          <div style={{ marginTop: '16px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
              Recent History
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {statusHistory.map(h => (
                <div key={h.id} style={{
                  padding: '6px 10px', borderRadius: '8px',
                  background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
                    <StatusBadge status={h.to_status as VehicleTrackingStatus} size="sm" />
                    {h.note && <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}> — {h.note}</span>}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{timeAgo(h.created_at)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════
  // SELECT STATE — multiple vehicles found
  // ═══════════════════════════════════════════════════════
  if (step === 'select') {
    return (
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Multiple Vehicles Found
        </div>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
          {matchingVehicles.length} vehicles match that VIN. Select one:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {matchingVehicles.map(v => {
            const status = (v.status === 'checked_in' ? 'received' : v.status) as VehicleTrackingStatus;
            return (
              <button
                key={v.id}
                onClick={() => selectVehicle(v)}
                style={{
                  width: '100%', padding: '12px 14px', borderRadius: '12px', textAlign: 'left',
                  background: 'var(--card)', border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{vehicleTitle(v)}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{v.vin}</div>
                    {v.customer_name && (
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{v.customer_name}</div>
                    )}
                  </div>
                  <StatusBadge status={status} />
                </div>
              </button>
            );
          })}
        </div>
        <button onClick={resetAll} style={{
          width: '100%', padding: '10px', borderRadius: '14px', marginTop: '12px',
          border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--text-muted)', fontSize: '12px', fontWeight: 600,
        }}>Back to Search</button>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════
  // SCAN STATE — VIN entry
  // ═══════════════════════════════════════════════════════
  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
        Update Vehicle Status
      </div>

      {/* Camera / Text toggle */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', background: 'var(--card)', borderRadius: '10px', padding: '3px' }}>
        <button onClick={() => { setMode('text'); stopCamera(); }} style={{
          flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
          background: mode === 'text' ? 'var(--tab-active-bg)' : 'transparent', border: 'none',
          color: mode === 'text' ? 'var(--text-primary)' : 'var(--text-muted)',
        }}>Type / Scanner</button>
        <button onClick={() => { setMode('camera'); setTimeout(() => startCamera(), 300); }} style={{
          flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
          background: mode === 'camera' ? 'var(--tab-active-bg)' : 'transparent', border: 'none',
          color: mode === 'camera' ? 'var(--text-primary)' : 'var(--text-muted)',
        }}>Camera</button>
      </div>

      {mode === 'camera' ? (
        <div>
          {cameraError ? (
            <div style={{ padding: '20px', textAlign: 'center', background: 'var(--error-bg)', border: '1px solid var(--error-border)', borderRadius: '14px' }}>
              <div style={{ color: 'var(--error)', fontSize: '13px', marginBottom: '12px' }}>{cameraError}</div>
              <button onClick={() => { setMode('text'); stopCamera(); }} style={{ padding: '10px 20px', borderRadius: '10px', background: 'var(--navy)', color: '#fff', fontWeight: 700, fontSize: '13px', border: 'none' }}>Switch to Text</button>
            </div>
          ) : (
            <div>
              <div style={{ position: 'relative', borderRadius: '12px', overflow: 'hidden', background: '#000', height: '250px', marginBottom: '8px' }}>
                <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <div style={{ position: 'absolute', top: '50%', left: '3%', right: '3%', height: '60px', marginTop: '-30px', border: '3px solid rgba(238,49,32,0.7)', borderRadius: '10px', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '10px', background: 'rgba(0,0,0,0.7)', textAlign: 'center' }}>
                  <div style={{ fontSize: '13px', color: '#fff', fontWeight: 700 }}>Scan VIN barcode</div>
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
            placeholder="Enter VIN (full or partial)"
            maxLength={17}
            style={{
              width: '100%', padding: '12px 14px', borderRadius: '10px',
              border: '1px solid var(--border)', background: 'var(--card)',
              color: 'var(--text-primary)', fontSize: '18px', letterSpacing: '2px',
              fontWeight: 700, textAlign: 'center',
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && vin.length >= 6) searchByVin(vin); }}
          />
          <div style={{ textAlign: 'center', marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
            Enter full or partial VIN to find vehicle
          </div>
        </div>
      )}

      {vinError && (
        <div style={{ marginTop: '8px', padding: '8px 12px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', borderRadius: '10px', color: 'var(--error)', fontSize: '12px' }}>{vinError}</div>
      )}

      {searchLoading && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ width: '28px', height: '28px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
          <div style={{ color: 'var(--text-muted)', fontWeight: 600, marginTop: '8px', fontSize: '13px' }}>Searching...</div>
        </div>
      )}

      {mode === 'text' && !searchLoading && (
        <button
          onClick={() => searchByVin(vin)}
          disabled={vin.length < 6}
          style={{
            width: '100%', padding: '16px', borderRadius: '14px', marginTop: '14px',
            background: vin.length >= 6 ? 'var(--navy)' : 'var(--border)',
            color: '#fff', fontSize: '16px', fontWeight: 800,
            opacity: vin.length >= 6 ? 1 : 0.4, border: 'none',
          }}
        >Find Vehicle</button>
      )}
    </div>
  );
}
