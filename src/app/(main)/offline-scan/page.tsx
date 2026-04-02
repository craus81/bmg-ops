'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { decodeVIN, isValidVIN } from '@/lib/vin-decoder';
import VinScanner from '@/components/VinScanner';
import {
  saveOfflineScan,
  getAllOfflineScans,
  getPendingScans,
  markScanSynced,
  deleteSyncedScans,
  cacheParts,
  getCachedParts,
  getPartsLastCached,
  setPartsLastCached,
  type OfflineScan,
  type CachedPart,
} from '@/lib/offline-db';

type View = 'main' | 'scan' | 'queue';

export default function OfflineScanPage() {
  const router = useRouter();
  const { user, profile } = useAuth();
  const supabase = createClient();

  // Connection status
  const [isOnline, setIsOnline] = useState(true);

  // Parts
  const [parts, setParts] = useState<CachedPart[]>([]);
  const [partSearch, setPartSearch] = useState('');
  const [selectedPart, setSelectedPart] = useState<CachedPart | null>(null);
  const [loadingParts, setLoadingParts] = useState(false);
  const [partsLastCached, setPartsLastCachedState] = useState<string | null>(null);

  // Scanning
  const [view, setView] = useState<View>('main');
  const [mode, setMode] = useState<'camera' | 'text'>('text');
  const [vin, setVin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [saved, setSaved] = useState(false);

  // Queue
  const [queue, setQueue] = useState<OfflineScan[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);

  // Track online/offline status
  useEffect(() => {
    setIsOnline(navigator.onLine);
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Load cached parts and queue on mount
  useEffect(() => {
    loadCachedParts();
    loadQueue();
  }, []);

  useEffect(() => {
    if (view === 'scan' && mode === 'text' && inputRef.current) inputRef.current.focus();
  }, [view, mode]);

  const loadCachedParts = async () => {
    const cached = await getCachedParts('upfit');
    setParts(cached);
    const ts = await getPartsLastCached();
    setPartsLastCachedState(ts);
  };

  const loadQueue = async () => {
    const all = await getAllOfflineScans();
    setQueue(all.sort((a, b) => b.scanned_at.localeCompare(a.scanned_at)));
  };

  // Download parts from Supabase into IndexedDB
  const downloadParts = async () => {
    setLoadingParts(true);
    try {
      let allParts: any[] = [];
      let page = 0;
      const pageSize = 1000;
      let hasMore = true;
      while (hasMore) {
        const from = page * pageSize;
        const to = from + pageSize - 1;
        const { data } = await supabase
          .from('netsuite_parts')
          .select('id, netsuite_id, item_number, display_name, description, catalog')
          .eq('catalog', 'upfit')
          .eq('is_active', true)
          .order('item_number', { ascending: true })
          .range(from, to);
        const batch = data || [];
        allParts = allParts.concat(batch);
        hasMore = batch.length === pageSize;
        page++;
      }
      await cacheParts(allParts as CachedPart[]);
      await setPartsLastCached();
      setParts(allParts as CachedPart[]);
      setPartsLastCachedState(new Date().toISOString());
    } catch (err: any) {
      alert('Failed to download parts: ' + (err.message || 'Network error'));
    }
    setLoadingParts(false);
  };

  // VIN scanning
  const handleCameraScan = (scannedVin: string) => {
    setVin(scannedVin);
    handleScanVin(scannedVin);
  };

  const handleScanVin = async (v: string) => {
    setError('');
    setLoading(true);
    try {
      // Check local queue for duplicate
      const existing = queue.find(s => s.vin === v);
      if (existing) {
        setError('Duplicate — this VIN is already in your offline queue.');
        setLoading(false);
        return;
      }
      // Decode VIN (uses NHTSA API with offline fallback)
      const vehicle = await decodeVIN(v);
      setResult({ vin: v, vehicle });
    } catch {
      setError('Failed to decode VIN.');
    }
    setLoading(false);
  };

  const handleManualScan = () => {
    const v = vin.trim().toUpperCase();
    if (!isValidVIN(v)) { setError('Invalid VIN — must be 17 characters.'); return; }
    handleScanVin(v);
  };

  // Save to IndexedDB
  const handleSaveOffline = async () => {
    if (!result) return;
    const scan: OfflineScan = {
      id: crypto.randomUUID(),
      vin: result.vin,
      vehicle_year: result.vehicle.year || '',
      vehicle_make: result.vehicle.make || '',
      vehicle_model: result.vehicle.model || '',
      vehicle_trim: result.vehicle.trim || '',
      body_class: result.vehicle.bodyClass || '',
      drive_type: result.vehicle.driveType || '',
      fuel_type: result.vehicle.fuelType || '',
      gvwr: result.vehicle.gvwr || '',
      part_number: selectedPart?.item_number || null,
      part_display_name: selectedPart?.display_name || null,
      scanned_at: new Date().toISOString(),
      synced: false,
    };
    await saveOfflineScan(scan);
    setSaved(true);
    await loadQueue();
  };

  const resetScan = () => {
    setResult(null);
    setSaved(false);
    setVin('');
    setError('');
    setView('scan');
  };

  // Sync queue to Supabase
  const syncQueue = async () => {
    setSyncing(true);
    setSyncResult('');
    const pending = await getPendingScans();
    if (pending.length === 0) {
      setSyncResult('Nothing to sync.');
      setSyncing(false);
      return;
    }

    let synced = 0;
    let errors = 0;
    for (const scan of pending) {
      try {
        const { error: insertError } = await supabase
          .from('scanned_vehicles')
          .insert({
            vin: scan.vin,
            vehicle_year: scan.vehicle_year,
            vehicle_make: scan.vehicle_make,
            vehicle_model: scan.vehicle_model,
            vehicle_trim: scan.vehicle_trim,
            body_class: scan.body_class,
            drive_type: scan.drive_type,
            fuel_type: scan.fuel_type,
            gvwr: scan.gvwr,
            part_number: scan.part_number,
            scanned_by: user?.id || null,
            company_id: profile?.company_id || null,
          });
        if (insertError) {
          // Duplicate VIN is ok — mark synced
          if (insertError.message?.includes('duplicate') || insertError.code === '23505') {
            await markScanSynced(scan.id);
            synced++;
          } else {
            errors++;
          }
        } else {
          await markScanSynced(scan.id);
          synced++;
        }
      } catch {
        errors++;
      }
    }

    await deleteSyncedScans();
    await loadQueue();
    setSyncResult(`Synced ${synced} of ${pending.length}${errors > 0 ? ` (${errors} failed)` : ''}`);
    setSyncing(false);
  };

  const pendingCount = queue.filter(s => !s.synced).length;

  const filteredParts = parts.filter(p => {
    if (!partSearch.trim()) return false; // Don't show all parts — require search
    const q = partSearch.toLowerCase();
    return (
      p.item_number.toLowerCase().includes(q) ||
      p.display_name?.toLowerCase().includes(q) ||
      p.description?.toLowerCase().includes(q)
    );
  });

  const title = result
    ? [result.vehicle.year, result.vehicle.make, result.vehicle.model].filter(Boolean).join(' ')
    : '';

  // ─── Queue View ───────────────────────────────────

  if (view === 'queue') {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Offline Queue ({queue.length})
          </div>
          <StatusBadge isOnline={isOnline} />
        </div>

        {isOnline && pendingCount > 0 && (
          <button
            onClick={syncQueue}
            disabled={syncing}
            style={{
              width: '100%', padding: '14px', borderRadius: '14px', marginBottom: '12px',
              background: syncing ? 'var(--border)' : 'var(--success)', color: '#fff',
              fontSize: '14px', fontWeight: 800, border: 'none',
            }}
          >
            {syncing ? 'Syncing...' : `Sync ${pendingCount} Scan${pendingCount !== 1 ? 's' : ''} to Server`}
          </button>
        )}

        {syncResult && (
          <div style={{
            padding: '8px 12px', borderRadius: '10px', marginBottom: '12px', fontSize: '12px',
            background: syncResult.includes('failed') ? 'var(--error-bg)' : 'var(--success-bg)',
            color: syncResult.includes('failed') ? 'var(--error)' : 'var(--success)',
            border: `1px solid ${syncResult.includes('failed') ? 'rgba(248,113,113,0.15)' : 'rgba(52,211,153,0.15)'}`,
          }}>
            {syncResult}
          </div>
        )}

        {queue.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '13px' }}>
            No scans in queue
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {queue.map(scan => (
              <div key={scan.id} style={{
                padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)',
                background: 'var(--card)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 700 }}>
                      {[scan.vehicle_year, scan.vehicle_make, scan.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle'}
                    </div>
                    <div style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{scan.vin}</div>
                    {scan.part_number && (
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Part: {scan.part_number}
                      </div>
                    )}
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {new Date(scan.scanned_at).toLocaleString()}
                    </div>
                  </div>
                  <span style={{
                    fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                    background: scan.synced ? 'var(--success-bg)' : 'rgba(251,191,36,0.12)',
                    color: scan.synced ? 'var(--success)' : 'var(--warning)',
                  }}>
                    {scan.synced ? 'SYNCED' : 'PENDING'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        <button
          onClick={() => setView('main')}
          style={{
            width: '100%', padding: '10px', borderRadius: '14px', marginTop: '12px',
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700,
          }}
        >
          Back
        </button>
      </div>
    );
  }

  // ─── Scan View ────────────────────────────────────

  if (view === 'scan') {
    // Saved confirmation
    if (saved) {
      return (
        <div style={{ textAlign: 'center', padding: '28px 0' }}>
          <div style={{
            width: '64px', height: '64px', borderRadius: '50%', background: 'var(--success-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 14px', fontSize: '30px', color: 'var(--success)',
          }}>OK</div>
          <div style={{ fontSize: '18px', fontWeight: 800 }}>Saved to Offline Queue</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '4px' }}>{title}</div>
          <div style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-muted)' }}>{result.vin}</div>
          {selectedPart && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Part: {selectedPart.item_number}
            </div>
          )}
          <div style={{ fontSize: '11px', color: 'var(--warning)', marginTop: '8px', fontWeight: 600 }}>
            Will sync when back online
          </div>
          <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button onClick={resetScan} style={{ width: '100%', padding: '16px', borderRadius: '14px', background: 'var(--navy)', color: '#fff', fontWeight: 800, fontSize: '16px', border: 'none' }}>
              Scan Next VIN
            </button>
            <button onClick={() => setView('main')} style={{ width: '100%', padding: '10px', borderRadius: '14px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>
              Back
            </button>
          </div>
        </div>
      );
    }

    // Vehicle decoded — confirm
    if (result) {
      return (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>Vehicle Identified</div>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', marginBottom: '12px' }}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase' }}>VIN</div>
            <div style={{ fontSize: '13px', fontFamily: 'monospace', color: 'var(--navy-light)', fontWeight: 700, letterSpacing: '1.5px', marginTop: '2px', marginBottom: '10px' }}>{result.vin}</div>
            <div style={{ fontSize: '20px', fontWeight: 800 }}>{title || 'Unknown'}</div>
            {result.vehicle.bodyClass && <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>{result.vehicle.bodyClass}</div>}
          </div>
          {selectedPart && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '10px 12px', marginBottom: '12px', fontSize: '12px' }}>
              <span style={{ color: 'var(--text-muted)' }}>Part: </span>
              <span style={{ fontWeight: 700, color: 'var(--navy)' }}>{selectedPart.item_number}</span>
              {selectedPart.display_name && <span style={{ color: 'var(--text-muted)' }}> — {selectedPart.display_name}</span>}
            </div>
          )}
          {error && <div style={{ marginTop: '8px', padding: '8px 12px', background: 'var(--error-bg)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: '10px', color: 'var(--error)', fontSize: '12px', marginBottom: '12px' }}>{error}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button onClick={handleSaveOffline} style={{ width: '100%', padding: '16px', borderRadius: '14px', background: 'var(--success)', color: '#fff', fontSize: '16px', fontWeight: 800, border: 'none' }}>
              Save to Offline Queue
            </button>
            <button onClick={() => { setResult(null); setVin(''); }} style={{ width: '100%', padding: '10px', borderRadius: '14px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>
              Scan Different VIN
            </button>
          </div>
        </div>
      );
    }

    // Loading
    if (loading) {
      return (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
          <div style={{ color: 'var(--navy-light)', fontWeight: 600, marginTop: '12px' }}>Decoding VIN...</div>
        </div>
      );
    }

    // Scanner input
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Offline Scan
          </div>
          <StatusBadge isOnline={isOnline} />
        </div>
        {selectedPart && (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '10px 12px', marginBottom: '12px' }}>
            <div style={{ fontWeight: 800, fontSize: '14px' }}>{selectedPart.item_number}</div>
            {selectedPart.display_name && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>{selectedPart.display_name}</div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', background: 'var(--card)', borderRadius: '10px', padding: '3px' }}>
          <button onClick={() => setMode('camera')} style={{ flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, background: mode === 'camera' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: mode === 'camera' ? 'var(--navy)' : 'var(--text-muted)' }}>Camera</button>
          <button onClick={() => setMode('text')} style={{ flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, background: mode === 'text' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: mode === 'text' ? 'var(--navy)' : 'var(--text-muted)' }}>Type / Scanner</button>
        </div>
        {mode === 'camera' ? (
          <VinScanner onScan={handleCameraScan} theme={{}} />
        ) : (
          <div>
            <input
              ref={inputRef}
              type="text"
              value={vin}
              onChange={(e) => setVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, '').slice(0, 17))}
              placeholder="Enter or scan 17-char VIN"
              maxLength={17}
              style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '18px', letterSpacing: '2px', fontWeight: 700, textAlign: 'center' }}
              onKeyDown={(e) => { if (e.key === 'Enter' && vin.length === 17) handleManualScan(); }}
            />
            <div style={{ textAlign: 'center', marginTop: '4px', fontSize: '13px', fontWeight: 600, color: vin.length === 17 ? 'var(--success)' : 'var(--text-muted)' }}>{vin.length}/17 {vin.length === 17 ? 'OK' : ''}</div>
          </div>
        )}
        {error && <div style={{ marginTop: '8px', padding: '8px 12px', background: 'var(--error-bg)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: '10px', color: 'var(--error)', fontSize: '12px' }}>{error}</div>}
        {mode === 'text' && (
          <button onClick={handleManualScan} disabled={vin.length !== 17} style={{ width: '100%', padding: '16px', borderRadius: '14px', marginTop: '14px', background: vin.length === 17 ? 'var(--navy)' : 'var(--border)', color: '#fff', fontSize: '16px', fontWeight: 800, opacity: vin.length === 17 ? 1 : 0.4, border: 'none' }}>Decode VIN</button>
        )}
        <button onClick={() => setView('main')} style={{ width: '100%', padding: '10px', borderRadius: '14px', marginTop: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>Back</button>
      </div>
    );
  }

  // ─── Main View (Part Selection + Actions) ─────────

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Offline Scanner</div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {parts.length} parts cached
            {partsLastCached && <span> · {new Date(partsLastCached).toLocaleDateString()}</span>}
          </div>
        </div>
        <StatusBadge isOnline={isOnline} />
      </div>

      {/* Download parts for offline use */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '12px' }}>
        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
          Parts Catalog (Offline Cache)
        </div>
        <button
          onClick={downloadParts}
          disabled={loadingParts || !isOnline}
          style={{
            width: '100%', padding: '10px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
            background: !isOnline ? 'var(--border)' : loadingParts ? 'var(--border)' : 'rgba(59,130,246,0.12)',
            border: '1px solid rgba(59,130,246,0.2)', color: !isOnline ? 'var(--text-muted)' : '#60a5fa',
            cursor: !isOnline || loadingParts ? 'not-allowed' : 'pointer',
          }}
        >
          {loadingParts ? 'Downloading...' : !isOnline ? 'Go online to download parts' : `Download Upfit Parts (${parts.length} cached)`}
        </button>
      </div>

      {/* Part search & selection */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '12px' }}>
        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
          Select Part Number
        </div>
        {selectedPart ? (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 800 }}>{selectedPart.item_number}</div>
                {selectedPart.display_name && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{selectedPart.display_name}</div>}
              </div>
              <button
                onClick={() => setSelectedPart(null)}
                style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', cursor: 'pointer' }}
              >
                Change
              </button>
            </div>
          </div>
        ) : (
          <div>
            <input
              type="text"
              placeholder="Search part number..."
              value={partSearch}
              onChange={(e) => setPartSearch(e.target.value)}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)',
                background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '14px',
              }}
            />
            {parts.length === 0 && (
              <div style={{ textAlign: 'center', padding: '12px 0', color: 'var(--text-muted)', fontSize: '12px' }}>
                No parts cached — download them first while online
              </div>
            )}
            {filteredParts.length > 0 && (
              <div style={{ marginTop: '8px', maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {filteredParts.slice(0, 20).map(part => (
                  <button
                    key={part.id}
                    onClick={() => { setSelectedPart(part); setPartSearch(''); }}
                    style={{
                      padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)',
                      background: 'var(--bg)', textAlign: 'left', cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{part.item_number}</div>
                    {part.display_name && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>{part.display_name}</div>}
                  </button>
                ))}
                {filteredParts.length > 20 && (
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', padding: '4px' }}>
                    {filteredParts.length - 20} more — refine search
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button
          onClick={() => { setView('scan'); setVin(''); setResult(null); setSaved(false); setError(''); }}
          style={{
            width: '100%', padding: '16px', borderRadius: '14px',
            background: 'var(--navy)', color: '#fff', fontSize: '16px', fontWeight: 800, border: 'none',
          }}
        >
          Scan VIN
        </button>

        <button
          onClick={() => setView('queue')}
          style={{
            width: '100%', padding: '14px', borderRadius: '14px',
            background: pendingCount > 0 ? 'rgba(251,191,36,0.12)' : 'var(--card)',
            border: '1px solid ' + (pendingCount > 0 ? 'rgba(251,191,36,0.3)' : 'var(--border)'),
            color: pendingCount > 0 ? 'var(--warning)' : 'var(--text-secondary)',
            fontSize: '14px', fontWeight: 700,
          }}
        >
          View Queue {pendingCount > 0 ? `(${pendingCount} pending)` : `(${queue.length})`}
        </button>

        <button onClick={() => router.push('/home')} style={{ width: '100%', padding: '10px', borderRadius: '14px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>Home</button>
      </div>
    </div>
  );
}

function StatusBadge({ isOnline }: { isOnline: boolean }) {
  return (
    <span style={{
      fontSize: '9px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
      background: isOnline ? 'var(--success-bg)' : 'rgba(248,113,113,0.12)',
      color: isOnline ? 'var(--success)' : 'var(--error)',
    }}>
      {isOnline ? 'ONLINE' : 'OFFLINE'}
    </span>
  );
}
