'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface Installer {
  id: string;
  full_name: string;
  company_name: string;
  company_id: string;
}

interface Assignment {
  id: string;
  vehicle_id: string;
  installer_id: string;
  scheduled_date: string;
  notes: string | null;
  status: string;
  vehicle_year?: string;
  vehicle_make?: string;
  vehicle_model?: string;
  vin?: string;
  end_customer?: string;
  part_number?: string;
}

interface UnassignedVehicle {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  end_customer: string | null;
  part_number: string | null;
  scanned_at: string;
}

export default function SchedulePage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();

  const [view, setView] = useState<'week' | 'month'>('week');
  const [currentDate, setCurrentDate] = useState(() => {
    const d = new Date();
    // Start on Monday of current week
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
  });
  const [installers, setInstallers] = useState<Installer[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [unassigned, setUnassigned] = useState<UnassignedVehicle[]>([]);
  const [loading, setLoading] = useState(true);

  // Assign modal state
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignInstaller, setAssignInstaller] = useState<string | null>(null);
  const [assignDate, setAssignDate] = useState<string | null>(null);
  const [assignSearch, setAssignSearch] = useState('');
  const [assignNotes, setAssignNotes] = useState('');
  const [assigning, setAssigning] = useState(false);

  // Edit modal state
  const [editingAssignment, setEditingAssignment] = useState<Assignment | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editInstaller, setEditInstaller] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
  }, [isAdmin]);

  useEffect(() => {
    if (installers.length > 0) loadAssignments();
  }, [currentDate, view]);

  const loadData = async () => {
    // Load all approved installers with company info
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, company_id')
      .eq('status', 'approved')
      .order('full_name');

    const { data: companies } = await supabase.from('companies').select('*');

    const installerList: Installer[] = (profiles || []).map((p: any) => {
      const company = (companies || []).find((c: any) => c.id === p.company_id);
      return { id: p.id, full_name: p.full_name || 'Unknown', company_name: company?.name || 'Unassigned', company_id: p.company_id || '' };
    });
    setInstallers(installerList);

    // Load unassigned vehicles (no schedule_assignment with status != complete)
    const { data: allVehicles } = await supabase
      .from('scanned_vehicles')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, end_customer, part_number, scanned_at')
      .order('scanned_at', { ascending: false });

    const { data: assignedVehicleIds } = await supabase
      .from('schedule_assignments')
      .select('vehicle_id')
      .neq('status', 'complete');

    const assignedSet = new Set((assignedVehicleIds || []).map((a: any) => a.vehicle_id));
    setUnassigned((allVehicles || []).filter((v: any) => !assignedSet.has(v.id)));

    await loadAssignments();
    setLoading(false);
  };

  const loadAssignments = async () => {
    const { start, end } = getDateRange();
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    const { data } = await supabase
      .from('schedule_assignments')
      .select('*')
      .gte('scheduled_date', startStr)
      .lte('scheduled_date', endStr);

    if (!data) return;

    // Enrich with vehicle info
    const vehicleIds = [...new Set(data.map((a: any) => a.vehicle_id))];
    const { data: vehicles } = await supabase
      .from('scanned_vehicles')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, end_customer, part_number')
      .in('id', vehicleIds.length > 0 ? vehicleIds : ['none']);

    const vehicleMap = new Map((vehicles || []).map((v: any) => [v.id, v]));

    const enriched = data.map((a: any) => {
      const v = vehicleMap.get(a.vehicle_id);
      return { ...a, vin: v?.vin, vehicle_year: v?.vehicle_year, vehicle_make: v?.vehicle_make, vehicle_model: v?.vehicle_model, end_customer: v?.end_customer, part_number: v?.part_number };
    });

    setAssignments(enriched);
  };

  const getDateRange = () => {
    if (view === 'week') {
      const start = new Date(currentDate);
      const end = new Date(currentDate);
      end.setDate(end.getDate() + 4); // Mon-Fri
      return { start, end };
    } else {
      const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const end = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
      return { start, end };
    }
  };

  const weekDays = useMemo(() => {
    const days: Date[] = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(currentDate);
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    return days;
  }, [currentDate]);

  const monthDays = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startOffset = (firstDay.getDay() + 6) % 7; // Monday start
    const days: (Date | null)[] = [];
    for (let i = 0; i < startOffset; i++) days.push(null);
    for (let d = 1; d <= lastDay.getDate(); d++) days.push(new Date(year, month, d));
    return days;
  }, [currentDate]);

  const navigateWeek = (dir: number) => {
    setCurrentDate((prev) => {
      const d = new Date(prev);
      d.setDate(d.getDate() + (dir * 7));
      return d;
    });
  };

  const navigateMonth = (dir: number) => {
    setCurrentDate((prev) => {
      const d = new Date(prev);
      d.setMonth(d.getMonth() + dir);
      d.setDate(1);
      return d;
    });
  };

  const goToToday = () => {
    const d = new Date();
    if (view === 'week') {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      setCurrentDate(new Date(d.setDate(diff)));
    } else {
      setCurrentDate(new Date(d.getFullYear(), d.getMonth(), 1));
    }
  };

  const dateStr = (d: Date) => d.toISOString().split('T')[0];
  const isToday = (d: Date) => dateStr(d) === dateStr(new Date());

  const vehicleTitle = (a: Assignment | UnassignedVehicle) =>
    [a.vehicle_year, a.vehicle_make, a.vehicle_model].filter(Boolean).join(' ') || 'Unknown';

  const getAssignments = (installerId: string, date: string) =>
    assignments.filter((a) => a.installer_id === installerId && a.scheduled_date === date);

  const openAssignModal = (installerId: string, date: string) => {
    setAssignInstaller(installerId);
    setAssignDate(date);
    setAssignSearch('');
    setAssignNotes('');
    setShowAssignModal(true);
  };

  const handleAssign = async (vehicleId: string) => {
    if (!user || !assignInstaller || !assignDate) return;
    setAssigning(true);
    await supabase.from('schedule_assignments').insert({
      vehicle_id: vehicleId,
      installer_id: assignInstaller,
      scheduled_date: assignDate,
      notes: assignNotes || null,
      assigned_by: user.id,
    });
    setUnassigned((prev) => prev.filter((v) => v.id !== vehicleId));
    setShowAssignModal(false);
    setAssigning(false);
    setAssignNotes('');
    await loadAssignments();
  };

  const openEditModal = (assignment: Assignment) => {
    setEditingAssignment(assignment);
    setEditDate(assignment.scheduled_date);
    setEditInstaller(assignment.installer_id);
    setEditNotes(assignment.notes || '');
    setEditStatus(assignment.status);
  };

  const handleSaveEdit = async () => {
    if (!editingAssignment) return;
    setSaving(true);
    await supabase.from('schedule_assignments').update({
      scheduled_date: editDate,
      installer_id: editInstaller,
      notes: editNotes || null,
      status: editStatus,
      updated_at: new Date().toISOString(),
    }).eq('id', editingAssignment.id);

    if (editStatus === 'complete') {
      setUnassigned((prev) => {
        if (prev.find((v) => v.id === editingAssignment.vehicle_id)) return prev;
        return prev;
      });
    }

    setEditingAssignment(null);
    setSaving(false);
    await loadAssignments();
  };

  const handleDeleteAssignment = async (id: string, vehicleId: string) => {
    if (!window.confirm('Remove this assignment?')) return;
    await supabase.from('schedule_assignments').delete().eq('id', id);
    await loadAssignments();
    await loadData();
  };

  const filteredUnassigned = unassigned.filter((v) => {
    if (!assignSearch) return true;
    const search = assignSearch.toLowerCase();
    return (
      v.vin?.toLowerCase().includes(search) ||
      vehicleTitle(v as any).toLowerCase().includes(search) ||
      v.end_customer?.toLowerCase().includes(search) ||
      v.part_number?.toLowerCase().includes(search)
    );
  });

  const statusColors: Record<string, { bg: string; color: string; border: string }> = {
    scheduled: { bg: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: 'var(--border)' },
    in_progress: { bg: 'var(--warning-bg)', color: 'var(--warning)', border: 'var(--warning-border)' },
    complete: { bg: 'var(--success-bg)', color: 'var(--success)', border: 'var(--success-border)' },
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  // Assign Modal
  if (showAssignModal) {
    const installer = installers.find((i) => i.id === assignInstaller);
    return (
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
          Assign Job
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{installer?.full_name}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {assignDate ? new Date(assignDate + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) : ''}
          </div>
        </div>

        <input
          type="text"
          value={assignSearch}
          onChange={(e) => setAssignSearch(e.target.value)}
          placeholder="Search VIN, vehicle, customer..."
          style={{
            width: '100%', padding: '10px 12px', borderRadius: '10px', marginBottom: '8px',
            border: '1px solid var(--border)', background: 'var(--bg)',
            color: 'var(--text-primary)', fontSize: '13px',
          }}
        />

        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>
          Unassigned Vehicles ({filteredUnassigned.length})
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '400px', overflowY: 'auto', marginBottom: '12px' }}>
          {filteredUnassigned.length === 0 && (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '12px' }}>
              No unassigned vehicles found
            </div>
          )}
          {filteredUnassigned.map((v) => (
            <button
              key={v.id}
              onClick={() => handleAssign(v.id)}
              disabled={assigning}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px', textAlign: 'left',
                border: '1px solid var(--border)', background: 'var(--card)',
                color: 'var(--text-primary)', opacity: assigning ? 0.5 : 1,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: '13px' }}>{vehicleTitle(v as any)}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '1px' }}>{v.vin}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>
                {v.end_customer || v.part_number || ''}
                {' • '}{new Date(v.scanned_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              </div>
            </button>
          ))}
        </div>

        <button onClick={() => setShowAssignModal(false)} style={{
          width: '100%', padding: '10px', borderRadius: '10px',
          border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700,
        }}>← Cancel</button>
      </div>
    );
  }

  // Edit Modal
  if (editingAssignment) {
    return (
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
          Edit Assignment
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', marginBottom: '12px' }}>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{vehicleTitle(editingAssignment)}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{editingAssignment.vin}</div>
          {editingAssignment.end_customer && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{editingAssignment.end_customer}</div>}
        </div>

        <div style={{ marginBottom: '10px' }}>
          <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Date</label>
          <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} style={{
            width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)',
            background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px',
          }} />
        </div>

        <div style={{ marginBottom: '10px' }}>
          <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Installer</label>
          <select value={editInstaller} onChange={(e) => setEditInstaller(e.target.value)} style={{
            width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)',
            background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px',
          }}>
            {installers.map((i) => <option key={i.id} value={i.id}>{i.full_name} ({i.company_name})</option>)}
          </select>
        </div>

        <div style={{ marginBottom: '10px' }}>
          <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Status</label>
          <div style={{ display: 'flex', gap: '6px' }}>
            {['scheduled', 'in_progress', 'complete'].map((s) => (
              <button key={s} onClick={() => setEditStatus(s)} style={{
                flex: 1, padding: '8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                background: editStatus === s ? statusColors[s].bg : 'transparent',
                border: `1px solid ${editStatus === s ? statusColors[s].border : 'var(--border)'}`,
                color: editStatus === s ? statusColors[s].color : 'var(--text-muted)',
              }}>
                {s === 'scheduled' ? '📅 Scheduled' : s === 'in_progress' ? '🔧 In Progress' : '✅ Complete'}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Notes</label>
          <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} placeholder="Optional notes..." rows={2} style={{
            width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)',
            background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical',
          }} />
        </div>

        <button onClick={handleSaveEdit} disabled={saving} style={{
          width: '100%', padding: '14px', borderRadius: '14px', marginBottom: '8px',
          background: 'var(--navy)', color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
          opacity: saving ? 0.5 : 1,
        }}>{saving ? 'Saving...' : 'Save Changes'}</button>

        <button onClick={() => handleDeleteAssignment(editingAssignment.id, editingAssignment.vehicle_id)} style={{
          width: '100%', padding: '10px', borderRadius: '10px', marginBottom: '8px',
          background: 'var(--error-bg)', border: '1px solid var(--error-border)',
          color: 'var(--error)', fontSize: '12px', fontWeight: 700,
        }}>Remove Assignment</button>

        <button onClick={() => setEditingAssignment(null)} style={{
          width: '100%', padding: '10px', borderRadius: '10px',
          border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700,
        }}>← Cancel</button>
      </div>
    );
  }

  // Main calendar view
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Schedule
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button onClick={() => setView('week')} style={{
            padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            background: view === 'week' ? 'var(--tab-active-bg)' : 'transparent',
            border: view === 'week' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: view === 'week' ? 'var(--tab-active-color)' : 'var(--text-muted)',
          }}>Week</button>
          <button onClick={() => setView('month')} style={{
            padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            background: view === 'month' ? 'var(--tab-active-bg)' : 'transparent',
            border: view === 'month' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: view === 'month' ? 'var(--tab-active-color)' : 'var(--text-muted)',
          }}>Month</button>
        </div>
      </div>

      {/* Navigation */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', gap: '8px' }}>
        <button onClick={() => view === 'week' ? navigateWeek(-1) : navigateMonth(-1)} style={{
          padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)',
          background: 'var(--card)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '16px',
        }}>‹</button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 800, fontSize: '15px', color: 'var(--text-primary)' }}>
            {view === 'week'
              ? `${weekDays[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} — ${weekDays[4].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
              : currentDate.toLocaleDateString([], { month: 'long', year: 'numeric' })
            }
          </div>
          <button onClick={goToToday} style={{
            fontSize: '10px', fontWeight: 700, color: 'var(--navy)', background: 'transparent',
            border: 'none', padding: '2px 0', textDecoration: 'underline',
          }}>Today</button>
        </div>
        <button onClick={() => view === 'week' ? navigateWeek(1) : navigateMonth(1)} style={{
          padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)',
          background: 'var(--card)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '16px',
        }}>›</button>
      </div>

      {/* Unassigned count */}
      {unassigned.length > 0 && (
        <div style={{
          padding: '8px 12px', borderRadius: '10px', marginBottom: '12px',
          background: 'var(--warning-bg)', border: '1px solid var(--warning-border)',
          fontSize: '12px', fontWeight: 700, color: 'var(--warning)',
        }}>
          📋 {unassigned.length} unassigned vehicle{unassigned.length !== 1 ? 's' : ''}
        </div>
      )}

      {/* WEEK VIEW */}
      {view === 'week' && (
        <div style={{ overflowX: 'auto' }}>
          {installers.map((installer) => (
            <div key={installer.id} style={{ marginBottom: '14px' }}>
              <div style={{
                fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)',
                padding: '6px 0', borderBottom: '1px solid var(--border)', marginBottom: '6px',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span>{installer.full_name}</span>
                <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)' }}>{installer.company_name}</span>
              </div>
              <div style={{ display: 'flex', gap: '4px' }}>
                {weekDays.map((day) => {
                  const ds = dateStr(day);
                  const dayAssignments = getAssignments(installer.id, ds);
                  const today = isToday(day);
                  return (
                    <div key={ds} style={{
                      flex: 1, minWidth: '60px', borderRadius: '10px', padding: '6px',
                      background: today ? 'rgba(30,74,94,0.08)' : 'var(--card)',
                      border: `1px solid ${today ? 'rgba(30,74,94,0.25)' : 'var(--border)'}`,
                    }}>
                      <div style={{
                        fontSize: '9px', fontWeight: 700, color: today ? 'var(--navy)' : 'var(--text-muted)',
                        textTransform: 'uppercase', textAlign: 'center', marginBottom: '4px',
                      }}>
                        {day.toLocaleDateString([], { weekday: 'short' })} {day.getDate()}
                      </div>
                      {dayAssignments.map((a) => {
                        const sc = statusColors[a.status] || statusColors.scheduled;
                        return (
                          <button key={a.id} onClick={() => openEditModal(a)} style={{
                            width: '100%', padding: '4px 6px', borderRadius: '6px', marginBottom: '3px',
                            background: sc.bg, border: `1px solid ${sc.border}`, textAlign: 'left',
                            fontSize: '9px', fontWeight: 700, color: sc.color, lineHeight: '1.3',
                          }}>
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {vehicleTitle(a)}
                            </div>
                            {a.end_customer && (
                              <div style={{ fontSize: '8px', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {a.end_customer}
                              </div>
                            )}
                          </button>
                        );
                      })}
                      <button onClick={() => openAssignModal(installer.id, ds)} style={{
                        width: '100%', padding: '4px', borderRadius: '6px', marginTop: '2px',
                        border: '1px dashed var(--border)', background: 'transparent',
                        color: 'var(--text-muted)', fontSize: '12px', fontWeight: 700,
                      }}>+</button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* MONTH VIEW */}
      {view === 'month' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '4px' }}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div key={d} style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textAlign: 'center', padding: '4px' }}>{d}</div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
            {monthDays.map((day, i) => {
              if (!day) return <div key={`empty-${i}`} />;
              const ds = dateStr(day);
              const today = isToday(day);
              const dayAssignments = assignments.filter((a) => a.scheduled_date === ds);
              return (
                <div key={ds} style={{
                  minHeight: '60px', borderRadius: '6px', padding: '4px',
                  background: today ? 'rgba(30,74,94,0.08)' : 'var(--card)',
                  border: `1px solid ${today ? 'rgba(30,74,94,0.25)' : 'var(--border)'}`,
                }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: today ? 'var(--navy)' : 'var(--text-muted)', marginBottom: '2px' }}>
                    {day.getDate()}
                  </div>
                  {dayAssignments.slice(0, 3).map((a) => {
                    const installer = installers.find((i) => i.id === a.installer_id);
                    const sc = statusColors[a.status] || statusColors.scheduled;
                    return (
                      <button key={a.id} onClick={() => openEditModal(a)} style={{
                        width: '100%', padding: '2px 3px', borderRadius: '4px', marginBottom: '1px',
                        background: sc.bg, border: 'none', textAlign: 'left',
                        fontSize: '7px', fontWeight: 700, color: sc.color, lineHeight: '1.3',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {installer?.full_name?.split(' ')[0]}: {vehicleTitle(a)}
                      </button>
                    );
                  })}
                  {dayAssignments.length > 3 && (
                    <div style={{ fontSize: '7px', color: 'var(--text-muted)', textAlign: 'center' }}>+{dayAssignments.length - 3} more</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button onClick={() => router.push('/more')} style={{
        width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px',
        border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
        fontSize: '13px', fontWeight: 700,
      }}>← Back</button>
    </div>
  );
}
