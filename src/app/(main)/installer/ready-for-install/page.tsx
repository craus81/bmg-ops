'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface ReadyVehicle {
  id: string;
  vin: string;
  vehicleYear: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  customerName: string | null;
  salesOrderNumber: string | null;
  salesOrderMemo: string | null;
  status: string;
  notes: string | null;
  scheduledUpfitDate: string | null;
  assignedTo: string | null;
  graphicsJob: {
    id: string;
    jobNumber: string | null;
    title: string | null;
    partNumber: string | null;
    status: string;
    scheduledInstallDate: string | null;
    updatedAt: string | null;
  };
  daysInReady: number | null;
  stale: boolean;
}

export default function ReadyForInstallPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isInstaller, isAdmin } = useAuth();
  const supabase = createClient();

  const [vehicles, setVehicles] = useState<ReadyVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'mine' | 'all'>('mine');
  // ?job=<graphics job id> deep link ("Graphics ready" notifications):
  // highlight that job's vehicles and scroll the first one into view.
  const [highlightJobId, setHighlightJobId] = useState<string | null>(null);
  const [editingDateId, setEditingDateId] = useState<string | null>(null);
  const [pendingDate, setPendingDate] = useState<string>('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const q = filter === 'mine' ? '?mine=1' : '';
    const res = await fetch(`/api/installer/ready-for-install${q}`);
    if (!res.ok) {
      setVehicles([]);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setVehicles(data.vehicles || []);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    if (!user) return;
    if (!isInstaller && !isAdmin) {
      router.push('/home');
      return;
    }
    load();
  }, [user, isInstaller, isAdmin, router, load]);

  useEffect(() => {
    const jobId = searchParams?.get('job');
    if (!jobId || loading) return;
    const matches = vehicles.filter(v => v.graphicsJob.id === jobId);
    // The linked job's vehicles may all be assigned to someone else —
    // widen from the default "mine" filter instead of showing an empty page.
    if (matches.length === 0 && filter === 'mine') { setFilter('all'); return; }
    if (matches.length === 0) return;
    setHighlightJobId(jobId);
    requestAnimationFrame(() => {
      document.getElementById(`rfi-${matches[0].id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const t = setTimeout(() => setHighlightJobId(null), 4000);
    return () => clearTimeout(t);
  }, [searchParams, loading, vehicles, filter]);

  const startEditDate = (v: ReadyVehicle) => {
    setEditingDateId(v.id);
    setPendingDate(v.scheduledUpfitDate || new Date().toISOString().slice(0, 10));
  };

  const cancelEditDate = () => {
    setEditingDateId(null);
    setPendingDate('');
  };

  const saveDate = async (vehicleId: string) => {
    if (!pendingDate) return;
    setSavingId(vehicleId);
    const { error } = await supabase
      .from('fleet_checkins')
      .update({ scheduled_upfit_date: pendingDate, updated_at: new Date().toISOString() })
      .eq('id', vehicleId);
    if (!error) {
      // Sync calendar (fire and forget)
      fetch('/api/calendar/sync-upfit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkinId: vehicleId }),
      }).catch(() => {});
      setVehicles(prev => prev.map(v =>
        v.id === vehicleId ? { ...v, scheduledUpfitDate: pendingDate } : v
      ));
    }
    setEditingDateId(null);
    setPendingDate('');
    setSavingId(null);
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const rowColor = (v: ReadyVehicle) => {
    if (v.stale) return 'var(--danger-bg, #fef2f2)';
    if (!v.scheduledUpfitDate) return 'var(--warning-bg, #fffbeb)';
    return 'var(--card)';
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px', marginBottom: '4px' }}>
          Ready for Install
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Vehicles whose graphics are done
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {(['mine', 'all'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '8px 14px',
              borderRadius: '10px',
              fontSize: '12px',
              fontWeight: 700,
              border: '1px solid var(--border)',
              background: filter === f ? 'var(--accent, #2563eb)' : 'var(--card)',
              color: filter === f ? '#fff' : 'var(--text-primary)',
              cursor: 'pointer',
            }}
          >
            {f === 'mine' ? 'Assigned to Me' : 'All Vehicles'}
          </button>
        ))}
      </div>

      {vehicles.length === 0 ? (
        <div style={{
          padding: '30px', textAlign: 'center', borderRadius: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            No vehicles are ready to install right now.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {vehicles.map(v => (
            <div
              key={v.id}
              id={`rfi-${v.id}`}
              style={{
                background: rowColor(v),
                border: highlightJobId === v.graphicsJob.id
                  ? '2px solid var(--accent, #2563eb)'
                  : `1px solid ${v.stale ? 'var(--danger, #ef4444)' : 'var(--border)'}`,
                borderRadius: '14px',
                padding: '14px',
                transition: 'border-color 0.3s',
              }}
            >
              <button
                onClick={() => router.push(`/vehicles/${v.vin}/pick-list`)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  display: 'block',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px' }}>
                      {v.customerName || 'Unknown customer'}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                      {v.vin}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {[v.vehicleYear, v.vehicleMake, v.vehicleModel].filter(Boolean).join(' ') || '—'}
                    </div>
                  </div>
                  {v.stale && (
                    <div style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      color: 'var(--danger, #ef4444)',
                      padding: '2px 8px',
                      borderRadius: '8px',
                      background: 'rgba(239, 68, 68, 0.1)',
                      whiteSpace: 'nowrap',
                    }}>
                      {v.daysInReady}d ready
                    </div>
                  )}
                </div>

                <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
                  Graphics: <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                    {v.graphicsJob.title || v.graphicsJob.partNumber || v.graphicsJob.jobNumber || 'Ready'}
                  </span>
                  {' · '}Status: <span style={{ fontWeight: 700, color: '#4ade80' }}>{v.graphicsJob.status}</span>
                </div>
              </button>

              {/* Inline scheduling */}
              <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Install date:</span>
                {editingDateId === v.id ? (
                  <>
                    <input
                      type="date"
                      value={pendingDate}
                      onChange={e => setPendingDate(e.target.value)}
                      style={{
                        padding: '6px 10px',
                        fontSize: '13px',
                        borderRadius: '8px',
                        border: '1px solid var(--border)',
                        background: 'var(--card)',
                        color: 'var(--text-primary)',
                      }}
                    />
                    <button
                      onClick={() => saveDate(v.id)}
                      disabled={savingId === v.id}
                      style={{
                        padding: '6px 12px',
                        fontSize: '12px',
                        fontWeight: 700,
                        borderRadius: '8px',
                        border: '1px solid var(--accent, #2563eb)',
                        background: 'var(--accent, #2563eb)',
                        color: '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      {savingId === v.id ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={cancelEditDate}
                      style={{
                        padding: '6px 12px',
                        fontSize: '12px',
                        fontWeight: 700,
                        borderRadius: '8px',
                        border: '1px solid var(--border)',
                        background: 'var(--card)',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : v.scheduledUpfitDate ? (
                  <button
                    onClick={() => startEditDate(v)}
                    style={{
                      padding: '6px 10px',
                      fontSize: '12px',
                      fontWeight: 700,
                      borderRadius: '8px',
                      border: '1px solid var(--border)',
                      background: 'var(--card)',
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                    }}
                  >
                    {formatDate(v.scheduledUpfitDate)} · Edit
                  </button>
                ) : (
                  <button
                    onClick={() => startEditDate(v)}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontWeight: 700,
                      borderRadius: '8px',
                      border: '1px solid var(--warning, #f59e0b)',
                      background: 'rgba(245, 158, 11, 0.1)',
                      color: 'var(--warning, #f59e0b)',
                      cursor: 'pointer',
                    }}
                  >
                    Schedule install
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
