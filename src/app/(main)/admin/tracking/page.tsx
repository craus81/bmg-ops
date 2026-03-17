'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import StatusBadge from '@/components/StatusBadge';
import type { FleetCheckin, VehicleTrackingStatus, VehicleStatusHistory, Profile } from '@/lib/types';
import { VEHICLE_STATUS_PIPELINE, VEHICLE_STATUS_LABELS, VEHICLE_STATUS_COLORS } from '@/lib/types';

type ViewMode = 'pipeline' | 'table';
type FilterStatus = VehicleTrackingStatus | 'all' | 'stuck';

export default function VehicleTrackingPage() {
  const router = useRouter();
  const { isAdmin, user, profile } = useAuth();
  const supabase = createClient();

  const [vehicles, setVehicles] = useState<FleetCheckin[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('pipeline');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusHistory, setStatusHistory] = useState<VehicleStatusHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState('');
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadVehicles();
    loadProfiles();
  }, [isAdmin]);

  const loadVehicles = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('fleet_checkins')
      .select('*')
      .order('updated_at', { ascending: false });
    if (data) setVehicles(data);
    setLoading(false);
  };

  const loadProfiles = async () => {
    const { data } = await supabase.from('profiles').select('id, full_name');
    if (data) {
      const map: Record<string, string> = {};
      data.forEach((p: any) => { map[p.id] = p.full_name; });
      setProfiles(map);
    }
  };

  const loadHistory = async (vehicleId: string) => {
    setHistoryLoading(true);
    const { data } = await supabase
      .from('vehicle_status_history')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('created_at', { ascending: false });
    setStatusHistory(data || []);
    setHistoryLoading(false);
  };

  const toggleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setStatusHistory([]);
    } else {
      setExpandedId(id);
      loadHistory(id);
    }
  };

  const updateStatus = async (vehicleId: string, newStatus: VehicleTrackingStatus) => {
    setUpdatingId(vehicleId);
    try {
      const res = await fetch('/api/vehicle-tracking/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId, newStatus, note: statusNote.trim() || null }),
      });
      const result = await res.json();
      if (result.success) {
        setStatusNote('');
        loadVehicles();
        if (expandedId === vehicleId) loadHistory(vehicleId);
      }
    } catch (err) {
      console.error('Status update failed:', err);
    }
    setUpdatingId(null);
  };

  // Filter & search
  const filtered = vehicles.filter(v => {
    const status = v.status as VehicleTrackingStatus;
    if (filterStatus === 'stuck') return status === 'stuck_parts' || status === 'stuck_graphics';
    if (filterStatus !== 'all') return status === filterStatus;
    return true;
  }).filter(v => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    const title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ').toLowerCase();
    return v.vin.toLowerCase().includes(s) || title.includes(s) || (v.customer_name || '').toLowerCase().includes(s);
  });

  // Pipeline counts
  const statusCounts: Record<string, number> = {};
  VEHICLE_STATUS_PIPELINE.forEach(s => { statusCounts[s] = 0; });
  vehicles.forEach(v => { if (statusCounts[v.status] !== undefined) statusCounts[v.status]++; });
  const stuckCount = (statusCounts['stuck_parts'] || 0) + (statusCounts['stuck_graphics'] || 0);

  const vehicleTitle = (v: FleetCheckin) =>
    [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle';

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{
          width: '36px', height: '36px', border: '3px solid var(--border)',
          borderTopColor: 'var(--orange)', borderRadius: '50%', margin: '0 auto',
          animation: 'spin 1s linear infinite',
        }} />
        <div style={{ color: 'var(--text-muted)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading vehicles...</div>
      </div>
    );
  }

  return (
    <div>
      {/* Page Header */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Admin
        </div>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>
          Vehicle Tracking
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '14px' }}>
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)' }}>{vehicles.length}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total</div>
        </div>
        <div style={{
          background: stuckCount > 0 ? 'var(--warning-bg)' : 'var(--card)',
          border: `1px solid ${stuckCount > 0 ? 'var(--warning-border)' : 'var(--border)'}`,
          borderRadius: '12px', padding: '12px', textAlign: 'center',
          cursor: 'pointer',
        }} onClick={() => setFilterStatus(filterStatus === 'stuck' ? 'all' : 'stuck')}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: stuckCount > 0 ? 'var(--warning)' : 'var(--text-primary)' }}>
            {stuckCount}
          </div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: stuckCount > 0 ? 'var(--warning)' : 'var(--text-muted)', textTransform: 'uppercase' }}>
            Stuck
          </div>
        </div>
        <div style={{
          background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: '12px', padding: '12px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--success)' }}>{statusCounts['complete'] || 0}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--success)', textTransform: 'uppercase' }}>Complete</div>
        </div>
      </div>

      {/* Pipeline Status Bar */}
      <div style={{
        display: 'flex', gap: '3px', marginBottom: '14px', background: 'var(--card)',
        border: '1px solid var(--border)', borderRadius: '10px', padding: '3px', overflow: 'auto',
      }}>
        <button
          onClick={() => setFilterStatus('all')}
          style={{
            padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700,
            background: filterStatus === 'all' ? 'var(--tab-active-bg)' : 'transparent',
            border: 'none', color: filterStatus === 'all' ? 'var(--text-primary)' : 'var(--text-muted)',
            whiteSpace: 'nowrap',
          }}
        >All ({vehicles.length})</button>
        {VEHICLE_STATUS_PIPELINE.map(status => {
          const count = statusCounts[status] || 0;
          const colors = VEHICLE_STATUS_COLORS[status];
          const isActive = filterStatus === status;
          return (
            <button
              key={status}
              onClick={() => setFilterStatus(isActive ? 'all' : status)}
              style={{
                padding: '6px 8px', borderRadius: '7px', fontSize: '10px', fontWeight: 700,
                background: isActive ? colors.bg : 'transparent',
                border: isActive ? `1px solid ${colors.border}` : '1px solid transparent',
                color: isActive ? colors.text : count > 0 ? 'var(--text-secondary)' : 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              {VEHICLE_STATUS_LABELS[status].split('(')[0].trim()} ({count})
            </button>
          );
        })}
      </div>

      {/* Search */}
      <input
        type="text"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        placeholder="Search by VIN, vehicle, or customer..."
        style={{
          width: '100%', padding: '10px 12px', borderRadius: '10px',
          border: '1px solid var(--border)', background: 'var(--card)',
          color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600,
          marginBottom: '12px',
        }}
      />

      {/* Vehicle List */}
      {filtered.length === 0 ? (
        <div style={{
          padding: '30px 20px', textAlign: 'center', background: 'var(--card)',
          border: '1px solid var(--border)', borderRadius: '14px',
        }}>
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>🚚</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '14px', fontWeight: 600 }}>
            {searchTerm ? 'No vehicles match your search' : 'No vehicles in this status'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filtered.map(vehicle => {
            const isExpanded = expandedId === vehicle.id;
            const status = (vehicle.status === 'checked_in' ? 'received' : vehicle.status) as VehicleTrackingStatus;

            return (
              <div key={vehicle.id} style={{
                background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
                overflow: 'hidden',
              }}>
                {/* Vehicle Row */}
                <button
                  onClick={() => toggleExpand(vehicle.id)}
                  style={{
                    width: '100%', padding: '12px 14px', textAlign: 'left',
                    background: 'transparent', border: 'none', color: 'var(--text-primary)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: '14px' }}>{vehicleTitle(vehicle)}</div>
                      <div style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-muted)', marginTop: '2px' }}>{vehicle.vin}</div>
                      {vehicle.customer_name && (
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{vehicle.customer_name}</div>
                      )}
                      {vehicle.sales_order_number && (
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>SO #{vehicle.sales_order_number}</div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '8px' }}>
                      <StatusBadge status={status} />
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        {timeAgo(vehicle.updated_at)}
                      </div>
                      {vehicle.assigned_to && profiles[vehicle.assigned_to] && (
                        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                          {profiles[vehicle.assigned_to]}
                        </div>
                      )}
                    </div>
                  </div>
                </button>

                {/* Expanded Detail Panel */}
                {isExpanded && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '14px' }}>
                    {/* Status Update Buttons */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                        Update Status
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {VEHICLE_STATUS_PIPELINE.map(s => {
                          const colors = VEHICLE_STATUS_COLORS[s];
                          const isCurrent = s === status;
                          return (
                            <button
                              key={s}
                              onClick={() => !isCurrent && updateStatus(vehicle.id, s)}
                              disabled={isCurrent || updatingId === vehicle.id}
                              style={{
                                padding: '6px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                                background: isCurrent ? colors.bg : 'transparent',
                                border: `1px solid ${isCurrent ? colors.border : 'var(--border)'}`,
                                color: isCurrent ? colors.text : 'var(--text-secondary)',
                                opacity: isCurrent ? 1 : (updatingId === vehicle.id ? 0.4 : 0.8),
                                cursor: isCurrent ? 'default' : 'pointer',
                              }}
                            >
                              {isCurrent ? `● ${VEHICLE_STATUS_LABELS[s]}` : VEHICLE_STATUS_LABELS[s]}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Note for status change */}
                    <div style={{ marginBottom: '12px' }}>
                      <input
                        type="text"
                        value={statusNote}
                        onChange={(e) => setStatusNote(e.target.value)}
                        placeholder="Add a note with the status change..."
                        style={{
                          width: '100%', padding: '8px 10px', borderRadius: '8px',
                          border: '1px solid var(--border)', background: 'var(--input-bg)',
                          color: 'var(--text-primary)', fontSize: '12px',
                        }}
                      />
                    </div>

                    {/* Vehicle Info */}
                    <div style={{
                      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px',
                    }}>
                      {vehicle.customer_name && (
                        <div>
                          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Customer</div>
                          <div style={{ fontSize: '12px', fontWeight: 600 }}>{vehicle.customer_name}</div>
                        </div>
                      )}
                      {vehicle.sales_order_number && (
                        <div>
                          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Sales Order</div>
                          <div style={{ fontSize: '12px', fontWeight: 600 }}>#{vehicle.sales_order_number}</div>
                        </div>
                      )}
                      <div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Checked In</div>
                        <div style={{ fontSize: '12px', fontWeight: 600 }}>
                          {new Date(vehicle.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </div>
                      </div>
                      {vehicle.notes && (
                        <div>
                          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Notes</div>
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{vehicle.notes}</div>
                        </div>
                      )}
                    </div>

                    {/* Status History */}
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                        Status History
                      </div>
                      {historyLoading ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading...</div>
                      ) : statusHistory.length === 0 ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>No status changes recorded yet</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {statusHistory.map(h => (
                            <div key={h.id} style={{
                              padding: '8px 10px', borderRadius: '8px',
                              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                                  {h.from_status && (
                                    <>
                                      <span style={{ color: 'var(--text-muted)' }}>
                                        {VEHICLE_STATUS_LABELS[h.from_status as VehicleTrackingStatus] || h.from_status}
                                      </span>
                                      <span style={{ color: 'var(--text-muted)' }}>→</span>
                                    </>
                                  )}
                                  <StatusBadge status={h.to_status as VehicleTrackingStatus} size="sm" />
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                                  {timeAgo(h.created_at)}
                                </div>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                  {h.changed_by_name || 'Unknown'}
                                </div>
                                {h.note && (
                                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                                    {h.note}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
