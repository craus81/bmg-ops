'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import type {
  GraphicsJob, GraphicsJobStatus, GraphicsStatusHistory, Profile,
} from '@/lib/types';
import {
  GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_COLORS, GRAPHICS_STATUS_ORDER,
} from '@/lib/types';

type ViewMode = 'pipeline' | 'list';
type FilterStatus = GraphicsJobStatus | 'all' | 'active';

// Active statuses (not terminal)
const ACTIVE_STATUSES: GraphicsJobStatus[] = ['flagged', 'received', 'designing', 'revision', 'printing', 'outgassing', 'cutting', 'packing', 'ready'];

export default function GraphicsPage() {
  const router = useRouter();
  const { user, isAdmin, isProduction, isSales, profile } = useAuth();
  const supabase = createClient();

  const [jobs, setJobs] = useState<GraphicsJob[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('pipeline');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('active');
  const [search, setSearch] = useState('');
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [editingJob, setEditingJob] = useState<GraphicsJob | null>(null);
  const [statusHistory, setStatusHistory] = useState<GraphicsStatusHistory[]>([]);

  // Create job state
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    title: '', part_number: '', customer: '', quantity: 1,
    content: '', notes: '',
    vinyl_type: '', vinyl_color: '', laminate: '', print_method: '', cut_method: '', premask: '',
    priority: 'normal' as 'low' | 'normal' | 'high' | 'rush',
    due_date: '',
    scheduled_install_date: '',
    ship_to: '',
  });
  const [creating, setCreating] = useState(false);

  // Saving state
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (!isProduction && !isAdmin && !isSales) { router.push('/home'); return; }
    loadJobs();
    loadProfiles();
  }, [user, isAdmin, isProduction]);

  const loadJobs = async () => {
    const { data } = await supabase
      .from('graphics_jobs')
      .select('*')
      .order('created_at', { ascending: false });
    setJobs((data as GraphicsJob[]) || []);
    setLoading(false);
  };

  const loadProfiles = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, status')
      .eq('status', 'approved');
    setProfiles((data as Profile[]) || []);
  };

  const loadHistory = async (jobId: string) => {
    const { data } = await supabase
      .from('graphics_status_history')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false });
    setStatusHistory((data as GraphicsStatusHistory[]) || []);
  };

  // Change job status
  const changeStatus = async (job: GraphicsJob, newStatus: GraphicsJobStatus) => {
    const oldStatus = job.status;
    if (oldStatus === newStatus) return;

    const { error } = await supabase
      .from('graphics_jobs')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', job.id);

    if (!error) {
      // Log status change
      await supabase.from('graphics_status_history').insert({
        job_id: job.id,
        from_status: oldStatus,
        to_status: newStatus,
        changed_by: user?.id,
      });

      // Notify users via all channels (in-app, SMS, email) per their preferences
      const { data: prefs } = await supabase
        .from('notification_preferences')
        .select('user_id, notify_status_change, notify_ready, notify_shipped, custom_statuses');

      if (prefs) {
        const notifyUserIds = prefs
          .filter((p: any) => {
            if (p.user_id === user?.id) return false;
            if (newStatus === 'ready' && p.notify_ready) return true;
            if (newStatus === 'shipped' && p.notify_shipped) return true;
            if (p.notify_status_change) return true;
            if (p.custom_statuses?.includes(newStatus)) return true;
            return false;
          })
          .map((p: any) => p.user_id);

        if (notifyUserIds.length > 0) {
          fetch('/api/notifications/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userIds: notifyUserIds,
              type: 'graphics_status',
              title: `${job.title} → ${GRAPHICS_STATUS_LABELS[newStatus]}`,
              body: `Job #${job.job_number || job.id.slice(0, 8)} status changed to ${GRAPHICS_STATUS_LABELS[newStatus]}`,
              url: '/graphics',
              excludeUserId: user?.id,
            }),
          }).catch(() => {});
        }
      }

      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: newStatus, updated_at: new Date().toISOString() } : j));
      if (expandedJobId === job.id) loadHistory(job.id);
    }
  };

  // Save job edits
  const saveJob = async () => {
    if (!editingJob) return;
    setSaving(true);
    const { id, created_at, created_by, ...updateFields } = editingJob;
    const { error } = await supabase
      .from('graphics_jobs')
      .update({ ...updateFields, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (!error) {
      setJobs(prev => prev.map(j => j.id === id ? editingJob : j));
      setEditingJob(null);

      // Sync install date to Google Calendar (create, update, or delete event)
      fetch('/api/calendar/sync-graphics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: id }),
      }).catch(() => {});
    }
    setSaving(false);
  };

  // Create new job
  const createJob = async () => {
    setCreating(true);
    const jobNumber = `GFX-${Date.now().toString(36).toUpperCase()}`;
    const { data, error } = await supabase
      .from('graphics_jobs')
      .insert({
        job_number: jobNumber,
        title: createForm.title || 'Untitled Job',
        part_number: createForm.part_number || null,
        customer: createForm.customer || null,
        quantity: createForm.quantity || 1,
        content: createForm.content || null,
        notes: createForm.notes || null,
        vinyl_type: createForm.vinyl_type || null,
        vinyl_color: createForm.vinyl_color || null,
        laminate: createForm.laminate || null,
        print_method: createForm.print_method || null,
        cut_method: createForm.cut_method || null,
        premask: createForm.premask || null,
        priority: createForm.priority,
        due_date: createForm.due_date || null,
        scheduled_install_date: createForm.scheduled_install_date || null,
        ship_to: createForm.ship_to || null,
        status: 'received',
        created_by: user?.id,
      })
      .select()
      .single();

    if (!error && data) {
      // Log creation
      await supabase.from('graphics_status_history').insert({
        job_id: data.id,
        from_status: null,
        to_status: 'received',
        changed_by: user?.id,
        note: 'Job created manually',
      });

      // Sync install date to Google Calendar if set
      if (createForm.scheduled_install_date) {
        fetch('/api/calendar/sync-graphics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: data.id }),
        }).catch(() => {});
      }

      // Notify users via all channels per their preferences
      const { data: prefs } = await supabase
        .from('notification_preferences')
        .select('user_id, notify_new_job');
      if (prefs) {
        const notifyUserIds = prefs
          .filter((p: any) => p.notify_new_job && p.user_id !== user?.id)
          .map((p: any) => p.user_id);
        if (notifyUserIds.length > 0) {
          fetch('/api/notifications/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userIds: notifyUserIds,
              type: 'graphics_new',
              title: `New Graphics Job: ${createForm.title || 'Untitled'}`,
              body: `${createForm.customer || 'Unknown'} · ${createForm.quantity} unit${createForm.quantity !== 1 ? 's' : ''}${createForm.part_number ? ` · ${createForm.part_number}` : ''}`,
              url: '/graphics',
              excludeUserId: user?.id,
            }),
          }).catch(() => {});
        }
      }

      setJobs(prev => [data as GraphicsJob, ...prev]);
      setShowCreate(false);
      setCreateForm({
        title: '', part_number: '', customer: '', quantity: 1,
        content: '', notes: '',
        vinyl_type: '', vinyl_color: '', laminate: '', print_method: '', cut_method: '', premask: '',
        priority: 'normal', due_date: '', scheduled_install_date: '', ship_to: '',
      });
    }
    setCreating(false);
  };

  // Delete job
  const deleteJob = async (jobId: string) => {
    if (!window.confirm('Delete this graphics job? This cannot be undone.')) return;
    const { error } = await supabase.from('graphics_jobs').delete().eq('id', jobId);
    if (!error) {
      setJobs(prev => prev.filter(j => j.id !== jobId));
      setExpandedJobId(null);
      setEditingJob(null);
    }
  };

  // Filter jobs
  const filteredJobs = jobs.filter(j => {
    if (filterStatus === 'active') {
      if (!ACTIVE_STATUSES.includes(j.status)) return false;
    } else if (filterStatus !== 'all') {
      if (j.status !== filterStatus) return false;
    }
    if (search) {
      const s = search.toLowerCase();
      return (
        j.title?.toLowerCase().includes(s) ||
        j.part_number?.toLowerCase().includes(s) ||
        j.customer?.toLowerCase().includes(s) ||
        j.job_number?.toLowerCase().includes(s) ||
        j.content?.toLowerCase().includes(s)
      );
    }
    return true;
  });

  // Pipeline counts
  const statusCounts: Record<string, number> = {};
  GRAPHICS_STATUS_ORDER.forEach(s => {
    statusCounts[s] = jobs.filter(j => j.status === s).length;
  });

  const getProfileName = (userId: string | null) => {
    if (!userId) return null;
    const p = profiles.find(pr => pr.id === userId);
    return p?.full_name || p?.email || null;
  };

  const priorityColor = (p: string) => {
    switch (p) {
      case 'rush': return '#ef4444';
      case 'high': return '#f59e0b';
      case 'normal': return '#60a5fa';
      case 'low': return '#6b7280';
      default: return '#6b7280';
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px',
    border: '1px solid #2a3a4d', background: '#0f1720',
    color: '#e8ecf1', fontSize: '12px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: '#4a5f78',
    textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid #1e2d3d', borderTopColor: theme.orange, borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: '#4a5f78', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading graphics jobs...</div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800 }}>Graphics Production</div>
        <button
          onClick={() => setShowCreate(true)}
          style={{ padding: '8px 14px', borderRadius: '10px', background: theme.orange, color: '#fff', fontWeight: 800, fontSize: '12px', border: 'none', cursor: 'pointer', boxShadow: '0 2px 8px rgba(238,49,32,0.3)' }}
        >
          + New Job
        </button>
      </div>

      {/* Status Pipeline Summary */}
      <div style={{
        display: 'flex', gap: '3px', marginBottom: '12px', overflowX: 'auto',
        padding: '2px 0', WebkitOverflowScrolling: 'touch',
      }}>
        <button
          onClick={() => setFilterStatus('active')}
          style={{
            padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            background: filterStatus === 'active' ? 'rgba(59,130,246,0.2)' : '#141e2b',
            border: `1px solid ${filterStatus === 'active' ? 'rgba(59,130,246,0.4)' : '#1e2d3d'}`,
            color: filterStatus === 'active' ? '#60a5fa' : '#4a5f78',
            whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
          }}
        >
          Active ({jobs.filter(j => ACTIVE_STATUSES.includes(j.status)).length})
        </button>
        {GRAPHICS_STATUS_ORDER.filter(s => statusCounts[s] > 0 || s === 'received').map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(filterStatus === s ? 'active' : s)}
            style={{
              padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
              background: filterStatus === s ? `${GRAPHICS_STATUS_COLORS[s]}22` : '#141e2b',
              border: `1px solid ${filterStatus === s ? `${GRAPHICS_STATUS_COLORS[s]}66` : '#1e2d3d'}`,
              color: filterStatus === s ? GRAPHICS_STATUS_COLORS[s] : '#4a5f78',
              whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
            }}
          >
            {GRAPHICS_STATUS_LABELS[s].replace('Job ', '')} ({statusCounts[s] || 0})
          </button>
        ))}
        <button
          onClick={() => setFilterStatus('all')}
          style={{
            padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            background: filterStatus === 'all' ? 'rgba(59,130,246,0.2)' : '#141e2b',
            border: `1px solid ${filterStatus === 'all' ? 'rgba(59,130,246,0.4)' : '#1e2d3d'}`,
            color: filterStatus === 'all' ? '#60a5fa' : '#4a5f78',
            whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
          }}
        >
          All ({jobs.length})
        </button>
      </div>

      {/* Search */}
      <input
        placeholder="Search jobs..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{
          ...inputStyle, marginBottom: '12px',
          background: '#141e2b', border: '1px solid #1e2d3d',
        }}
      />

      {/* Job List */}
      {filteredJobs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: '#4a5f78', fontSize: '13px' }}>
          {search ? 'No matching jobs found.' : 'No graphics jobs yet.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {filteredJobs.map(job => {
            const isExpanded = expandedJobId === job.id;
            const isEditing = editingJob?.id === job.id;
            const editJob = isEditing ? editingJob : job;
            const statusColor = GRAPHICS_STATUS_COLORS[job.status];

            return (
              <div key={job.id} style={{
                borderRadius: '12px', overflow: 'hidden',
                border: `1px solid ${isExpanded ? `${statusColor}44` : '#1e2d3d'}`,
                background: '#141e2b',
              }}>
                {/* Job card header */}
                <div
                  onClick={() => {
                    if (isExpanded) {
                      setExpandedJobId(null);
                      setEditingJob(null);
                    } else {
                      setExpandedJobId(job.id);
                      loadHistory(job.id);
                    }
                  }}
                  style={{ padding: '12px', cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                        {job.priority !== 'normal' && (
                          <span style={{ fontSize: '9px', fontWeight: 800, color: priorityColor(job.priority), textTransform: 'uppercase', padding: '1px 5px', borderRadius: '3px', background: `${priorityColor(job.priority)}15`, border: `1px solid ${priorityColor(job.priority)}33` }}>
                            {job.priority}
                          </span>
                        )}
                        <div style={{ fontSize: '13px', fontWeight: 800, color: '#e8ecf1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {job.title}
                        </div>
                      </div>
                      <div style={{ fontSize: '10px', color: '#4a5f78', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {job.job_number && <span>#{job.job_number}</span>}
                        {job.customer && <span>{job.customer}</span>}
                        {job.part_number && <span>{job.part_number}</span>}
                        <span>Qty: {job.quantity}</span>
                        {job.due_date && <span style={{ color: new Date(job.due_date) < new Date() ? '#ef4444' : '#fbbf24' }}>Due: {new Date(job.due_date).toLocaleDateString()}</span>}
                        {job.scheduled_install_date && <span style={{ color: '#22d3ee' }}>Install: {new Date(job.scheduled_install_date).toLocaleDateString()}</span>}
                      </div>
                    </div>
                    <div style={{
                      padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                      background: `${statusColor}18`, border: `1px solid ${statusColor}44`,
                      color: statusColor, whiteSpace: 'nowrap', flexShrink: 0,
                    }}>
                      {GRAPHICS_STATUS_LABELS[job.status]}
                    </div>
                  </div>
                </div>

                {/* Expanded view */}
                {isExpanded && (
                  <div style={{ padding: '0 12px 14px', borderTop: '1px solid #1e2d3d' }}>

                    {/* Quick status change */}
                    <div style={{ marginTop: '10px', marginBottom: '12px' }}>
                      <div style={labelStyle}>Change Status</div>
                      <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', marginTop: '4px' }}>
                        {GRAPHICS_STATUS_ORDER.filter(s => s !== 'cancelled' && s !== 'flagged').map(s => (
                          <button
                            key={s}
                            onClick={() => changeStatus(job, s)}
                            disabled={job.status === s}
                            style={{
                              padding: '4px 8px', borderRadius: '5px', fontSize: '9px', fontWeight: 700,
                              background: job.status === s ? `${GRAPHICS_STATUS_COLORS[s]}33` : '#0f1720',
                              border: `1px solid ${job.status === s ? GRAPHICS_STATUS_COLORS[s] : '#1e2d3d'}`,
                              color: job.status === s ? GRAPHICS_STATUS_COLORS[s] : '#4a5f78',
                              cursor: job.status === s ? 'default' : 'pointer',
                              opacity: job.status === s ? 1 : 0.7,
                            }}
                          >
                            {GRAPHICS_STATUS_LABELS[s].replace('Job ', '')}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Toggle edit mode */}
                    {!isEditing ? (
                      <div>
                        {/* Job details read-only */}
                        {job.content && (
                          <div style={{ marginBottom: '10px' }}>
                            <div style={labelStyle}>Content / Special Instructions</div>
                            <div style={{ fontSize: '12px', color: '#e8ecf1', padding: '8px', borderRadius: '6px', background: '#0f1720', whiteSpace: 'pre-wrap' }}>{job.content}</div>
                          </div>
                        )}

                        {/* Vinyl specs */}
                        {(job.vinyl_type || job.vinyl_color || job.laminate || job.print_method || job.cut_method || job.premask) && (
                          <div style={{ marginBottom: '10px' }}>
                            <div style={labelStyle}>Vinyl Specifications</div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', marginTop: '4px' }}>
                              {job.vinyl_type && <div style={{ padding: '4px 6px', borderRadius: '4px', background: '#0f1720', fontSize: '10px' }}><span style={{ color: '#4a5f78' }}>Type:</span> <span style={{ color: '#e8ecf1' }}>{job.vinyl_type}</span></div>}
                              {job.vinyl_color && <div style={{ padding: '4px 6px', borderRadius: '4px', background: '#0f1720', fontSize: '10px' }}><span style={{ color: '#4a5f78' }}>Color:</span> <span style={{ color: '#e8ecf1' }}>{job.vinyl_color}</span></div>}
                              {job.laminate && <div style={{ padding: '4px 6px', borderRadius: '4px', background: '#0f1720', fontSize: '10px' }}><span style={{ color: '#4a5f78' }}>Lam:</span> <span style={{ color: '#e8ecf1' }}>{job.laminate}</span></div>}
                              {job.print_method && <div style={{ padding: '4px 6px', borderRadius: '4px', background: '#0f1720', fontSize: '10px' }}><span style={{ color: '#4a5f78' }}>Print:</span> <span style={{ color: '#e8ecf1' }}>{job.print_method}</span></div>}
                              {job.cut_method && <div style={{ padding: '4px 6px', borderRadius: '4px', background: '#0f1720', fontSize: '10px' }}><span style={{ color: '#4a5f78' }}>Cut:</span> <span style={{ color: '#e8ecf1' }}>{job.cut_method}</span></div>}
                              {job.premask && <div style={{ padding: '4px 6px', borderRadius: '4px', background: '#0f1720', fontSize: '10px' }}><span style={{ color: '#4a5f78' }}>Premask:</span> <span style={{ color: '#e8ecf1' }}>{job.premask}</span></div>}
                            </div>
                          </div>
                        )}

                        {/* Tracking */}
                        {(job.tracking_number || job.carrier || job.ship_to) && (
                          <div style={{ marginBottom: '10px' }}>
                            <div style={labelStyle}>Shipping</div>
                            <div style={{ display: 'flex', gap: '8px', fontSize: '11px', flexWrap: 'wrap' }}>
                              {job.carrier && <span style={{ color: '#e8ecf1' }}>{job.carrier}</span>}
                              {job.tracking_number && <span style={{ color: '#60a5fa', fontWeight: 700 }}>{job.tracking_number}</span>}
                              {job.ship_to && <span style={{ color: '#4a5f78' }}>→ {job.ship_to}</span>}
                            </div>
                          </div>
                        )}

                        {job.notes && (
                          <div style={{ marginBottom: '10px' }}>
                            <div style={labelStyle}>Notes</div>
                            <div style={{ fontSize: '11px', color: '#6b7a8d', whiteSpace: 'pre-wrap' }}>{job.notes}</div>
                          </div>
                        )}

                        {/* Dates & Metadata */}
                        <div style={{ fontSize: '10px', color: '#4a5f78', display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
                          <span>Created: {new Date(job.created_at).toLocaleDateString()}</span>
                          {job.due_date && <span style={{ color: new Date(job.due_date) < new Date() ? '#ef4444' : '#fbbf24' }}>Due: {new Date(job.due_date).toLocaleDateString()}</span>}
                          {job.scheduled_install_date && <span style={{ color: '#22d3ee' }}>Install: {new Date(job.scheduled_install_date).toLocaleDateString()}{job.calendar_event_id ? ' 📅' : ''}</span>}
                          {getProfileName(job.assigned_to) && <span>Assigned: {getProfileName(job.assigned_to)}</span>}
                          {getProfileName(job.created_by) && <span>By: {getProfileName(job.created_by)}</span>}
                        </div>

                        {/* Status history */}
                        {statusHistory.length > 0 && (
                          <div style={{ marginBottom: '10px' }}>
                            <div style={labelStyle}>Status History</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px', maxHeight: '120px', overflowY: 'auto' }}>
                              {statusHistory.map(h => (
                                <div key={h.id} style={{ fontSize: '10px', color: '#4a5f78', display: 'flex', gap: '6px' }}>
                                  <span style={{ color: '#6b7a8d' }}>{new Date(h.created_at).toLocaleString()}</span>
                                  {h.from_status && <span><span style={{ color: GRAPHICS_STATUS_COLORS[h.from_status as GraphicsJobStatus] || '#6b7a8d' }}>{GRAPHICS_STATUS_LABELS[h.from_status as GraphicsJobStatus] || h.from_status}</span> →</span>}
                                  <span style={{ color: GRAPHICS_STATUS_COLORS[h.to_status as GraphicsJobStatus] || '#e8ecf1', fontWeight: 700 }}>{GRAPHICS_STATUS_LABELS[h.to_status as GraphicsJobStatus] || h.to_status}</span>
                                  {getProfileName(h.changed_by) && <span>by {getProfileName(h.changed_by)}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Action buttons */}
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            onClick={() => setEditingJob({ ...job })}
                            style={{ flex: 1, padding: '10px', borderRadius: '8px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                          >
                            Edit Job
                          </button>
                          {isAdmin && (
                            <button
                              onClick={() => deleteJob(job.id)}
                              style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                            >
                              Delete
                            </button>
                          )}
                          {job.status !== 'cancelled' && (
                            <button
                              onClick={() => changeStatus(job, 'cancelled')}
                              style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(107,114,128,0.08)', border: '1px solid rgba(107,114,128,0.2)', color: '#6b7280', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      /* Edit mode */
                      <div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
                          <div style={{ gridColumn: '1 / -1' }}>
                            <div style={labelStyle}>Title</div>
                            <input style={inputStyle} value={editJob!.title} onChange={e => setEditingJob({ ...editJob!, title: e.target.value })} />
                          </div>
                          <div>
                            <div style={labelStyle}>Part Number</div>
                            <input style={inputStyle} value={editJob!.part_number || ''} onChange={e => setEditingJob({ ...editJob!, part_number: e.target.value })} />
                          </div>
                          <div>
                            <div style={labelStyle}>Customer</div>
                            <input style={inputStyle} value={editJob!.customer || ''} onChange={e => setEditingJob({ ...editJob!, customer: e.target.value })} />
                          </div>
                          <div>
                            <div style={labelStyle}>Quantity</div>
                            <input type="number" style={inputStyle} value={editJob!.quantity} onChange={e => setEditingJob({ ...editJob!, quantity: parseInt(e.target.value) || 1 })} />
                          </div>
                          <div>
                            <div style={labelStyle}>Priority</div>
                            <select style={inputStyle} value={editJob!.priority} onChange={e => setEditingJob({ ...editJob!, priority: e.target.value as any })}>
                              <option value="low">Low</option>
                              <option value="normal">Normal</option>
                              <option value="high">High</option>
                              <option value="rush">Rush</option>
                            </select>
                          </div>
                          <div>
                            <div style={labelStyle}>Due Date</div>
                            <input type="date" style={inputStyle} value={editJob!.due_date || ''} onChange={e => setEditingJob({ ...editJob!, due_date: e.target.value })} />
                          </div>
                          <div>
                            <div style={labelStyle}>Scheduled Install Date</div>
                            <input type="date" style={inputStyle} value={editJob!.scheduled_install_date || ''} onChange={e => setEditingJob({ ...editJob!, scheduled_install_date: e.target.value })} />
                            {editJob!.calendar_event_id && <div style={{ fontSize: '9px', color: '#22d3ee', marginTop: '2px' }}>Synced to Google Calendar</div>}
                          </div>
                          <div>
                            <div style={labelStyle}>Assigned To</div>
                            <select style={inputStyle} value={editJob!.assigned_to || ''} onChange={e => setEditingJob({ ...editJob!, assigned_to: e.target.value || null })}>
                              <option value="">— Unassigned —</option>
                              {profiles.filter(p => p.role === 'admin' || p.role === 'production').map(p => (
                                <option key={p.id} value={p.id}>{p.full_name || p.email}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div style={{ marginBottom: '10px' }}>
                          <div style={labelStyle}>Content / Special Instructions (unit numbers, addresses, etc.)</div>
                          <textarea
                            style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
                            value={editJob!.content || ''}
                            onChange={e => setEditingJob({ ...editJob!, content: e.target.value })}
                            placeholder="Unit numbers, addresses, or other unit-specific details..."
                          />
                        </div>

                        <div style={labelStyle}>Vinyl Specifications</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Vinyl Type</div>
                            <input style={inputStyle} value={editJob!.vinyl_type || ''} onChange={e => setEditingJob({ ...editJob!, vinyl_type: e.target.value })} placeholder="e.g. 3M IJ180Cv3" />
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Color</div>
                            <input style={inputStyle} value={editJob!.vinyl_color || ''} onChange={e => setEditingJob({ ...editJob!, vinyl_color: e.target.value })} placeholder="e.g. White" />
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Laminate</div>
                            <input style={inputStyle} value={editJob!.laminate || ''} onChange={e => setEditingJob({ ...editJob!, laminate: e.target.value })} placeholder="e.g. 3M 8518" />
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Print</div>
                            <input style={inputStyle} value={editJob!.print_method || ''} onChange={e => setEditingJob({ ...editJob!, print_method: e.target.value })} placeholder="e.g. Solvent" />
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Cut</div>
                            <input style={inputStyle} value={editJob!.cut_method || ''} onChange={e => setEditingJob({ ...editJob!, cut_method: e.target.value })} placeholder="e.g. Contour" />
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Premask</div>
                            <input style={inputStyle} value={editJob!.premask || ''} onChange={e => setEditingJob({ ...editJob!, premask: e.target.value })} placeholder="e.g. R-Tape 4075" />
                          </div>
                        </div>

                        <div style={labelStyle}>Shipping</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Carrier</div>
                            <select style={inputStyle} value={editJob!.carrier || ''} onChange={e => setEditingJob({ ...editJob!, carrier: e.target.value })}>
                              <option value="">—</option>
                              <option>UPS</option>
                              <option>FedEx</option>
                              <option>USPS</option>
                              <option>LTL</option>
                              <option>Hand Delivery</option>
                            </select>
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Tracking #</div>
                            <input style={inputStyle} value={editJob!.tracking_number || ''} onChange={e => setEditingJob({ ...editJob!, tracking_number: e.target.value })} />
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Ship To</div>
                            <input style={inputStyle} value={editJob!.ship_to || ''} onChange={e => setEditingJob({ ...editJob!, ship_to: e.target.value })} />
                          </div>
                        </div>

                        <div style={{ marginBottom: '10px' }}>
                          <div style={labelStyle}>Internal Notes</div>
                          <textarea
                            style={{ ...inputStyle, minHeight: '40px', resize: 'vertical' }}
                            value={editJob!.notes || ''}
                            onChange={e => setEditingJob({ ...editJob!, notes: e.target.value })}
                          />
                        </div>

                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            onClick={saveJob}
                            disabled={saving}
                            style={{ flex: 1, padding: '10px', borderRadius: '8px', background: '#22c55e', color: '#fff', fontSize: '12px', fontWeight: 800, border: 'none', cursor: 'pointer', opacity: saving ? 0.5 : 1 }}
                          >
                            {saving ? 'Saving...' : 'Save Changes'}
                          </button>
                          <button
                            onClick={() => setEditingJob(null)}
                            style={{ flex: 1, padding: '10px', borderRadius: '8px', background: 'transparent', border: '1px solid #1e2d3d', color: '#6b7a8d', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ═══════════ CREATE JOB MODAL ═══════════ */}
      {showCreate && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: '#141e2b', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '14px', padding: '18px', maxWidth: '500px', width: '100%', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ fontSize: '16px', fontWeight: 800, color: '#e8ecf1', marginBottom: '14px' }}>New Graphics Job</div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={labelStyle}>Job Title *</div>
                <input style={inputStyle} value={createForm.title} onChange={e => setCreateForm({ ...createForm, title: e.target.value })} placeholder="e.g. GRAPHIC KIT - FORD TRANSIT" />
              </div>
              <div>
                <div style={labelStyle}>Part Number</div>
                <input style={inputStyle} value={createForm.part_number} onChange={e => setCreateForm({ ...createForm, part_number: e.target.value })} placeholder="e.g. 02T278" />
              </div>
              <div>
                <div style={labelStyle}>Customer</div>
                <input style={inputStyle} value={createForm.customer} onChange={e => setCreateForm({ ...createForm, customer: e.target.value })} placeholder="e.g. Masterack" />
              </div>
              <div>
                <div style={labelStyle}>Quantity</div>
                <input type="number" style={inputStyle} value={createForm.quantity} onChange={e => setCreateForm({ ...createForm, quantity: parseInt(e.target.value) || 1 })} />
              </div>
              <div>
                <div style={labelStyle}>Priority</div>
                <select style={inputStyle} value={createForm.priority} onChange={e => setCreateForm({ ...createForm, priority: e.target.value as any })}>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="rush">Rush</option>
                </select>
              </div>
              <div>
                <div style={labelStyle}>Due Date</div>
                <input type="date" style={inputStyle} value={createForm.due_date} onChange={e => setCreateForm({ ...createForm, due_date: e.target.value })} />
              </div>
              <div>
                <div style={labelStyle}>Scheduled Install Date</div>
                <input type="date" style={inputStyle} value={createForm.scheduled_install_date} onChange={e => setCreateForm({ ...createForm, scheduled_install_date: e.target.value })} />
              </div>
              <div>
                <div style={labelStyle}>Ship To</div>
                <input style={inputStyle} value={createForm.ship_to} onChange={e => setCreateForm({ ...createForm, ship_to: e.target.value })} />
              </div>
            </div>

            <div style={{ marginBottom: '10px' }}>
              <div style={labelStyle}>Content / Special Instructions</div>
              <textarea
                style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
                value={createForm.content}
                onChange={e => setCreateForm({ ...createForm, content: e.target.value })}
                placeholder="Unit numbers, addresses, custom text per unit..."
              />
            </div>

            <div style={labelStyle}>Vinyl Specifications</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
              <div>
                <div style={{ ...labelStyle, fontSize: '8px' }}>Vinyl Type</div>
                <input style={inputStyle} value={createForm.vinyl_type} onChange={e => setCreateForm({ ...createForm, vinyl_type: e.target.value })} placeholder="e.g. 3M IJ180Cv3" />
              </div>
              <div>
                <div style={{ ...labelStyle, fontSize: '8px' }}>Color</div>
                <input style={inputStyle} value={createForm.vinyl_color} onChange={e => setCreateForm({ ...createForm, vinyl_color: e.target.value })} placeholder="e.g. White" />
              </div>
              <div>
                <div style={{ ...labelStyle, fontSize: '8px' }}>Laminate</div>
                <input style={inputStyle} value={createForm.laminate} onChange={e => setCreateForm({ ...createForm, laminate: e.target.value })} placeholder="e.g. 3M 8518" />
              </div>
              <div>
                <div style={{ ...labelStyle, fontSize: '8px' }}>Print</div>
                <input style={inputStyle} value={createForm.print_method} onChange={e => setCreateForm({ ...createForm, print_method: e.target.value })} placeholder="e.g. Solvent" />
              </div>
              <div>
                <div style={{ ...labelStyle, fontSize: '8px' }}>Cut</div>
                <input style={inputStyle} value={createForm.cut_method} onChange={e => setCreateForm({ ...createForm, cut_method: e.target.value })} placeholder="e.g. Contour" />
              </div>
              <div>
                <div style={{ ...labelStyle, fontSize: '8px' }}>Premask</div>
                <input style={inputStyle} value={createForm.premask} onChange={e => setCreateForm({ ...createForm, premask: e.target.value })} placeholder="e.g. R-Tape 4075" />
              </div>
            </div>

            <div style={{ marginBottom: '12px' }}>
              <div style={labelStyle}>Internal Notes</div>
              <textarea style={{ ...inputStyle, minHeight: '40px', resize: 'vertical' }} value={createForm.notes} onChange={e => setCreateForm({ ...createForm, notes: e.target.value })} />
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={createJob}
                disabled={creating || !createForm.title.trim()}
                style={{ flex: 1, padding: '12px', borderRadius: '10px', background: creating ? '#1e2d3d' : '#22c55e', color: '#fff', fontWeight: 800, fontSize: '13px', border: 'none', cursor: 'pointer', opacity: creating || !createForm.title.trim() ? 0.5 : 1 }}
              >
                {creating ? 'Creating...' : 'Create Job'}
              </button>
              <button
                onClick={() => setShowCreate(false)}
                style={{ flex: 1, padding: '12px', borderRadius: '10px', background: 'transparent', border: '1px solid #1e2d3d', color: '#6b7a8d', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
