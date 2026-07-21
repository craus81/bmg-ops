'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';

interface CalendarEvent {
  id: string;
  title: string;
  subtitle?: string;
  date: string; // YYYY-MM-DD
  time?: string;
  type: 'graphics' | 'upfit' | 'cni' | 'reminder' | 'manual' | 'google';
  color: string;
  status?: string;
  linkTo?: string;
}

const TYPE_COLORS: Record<string, string> = {
  graphics: '#c084fc',
  upfit: '#60a5fa',
  cni: '#4ade80',
  reminder: '#fbbf24',
  manual: '#f472b6',
  google: '#2dd4bf',
};

const TYPE_LABELS: Record<string, string> = {
  graphics: 'Graphics',
  upfit: 'Upfit',
  cni: 'CNI',
  reminder: 'Sales',
  manual: 'Event',
  google: 'Google',
};

export default function SchedulePage() {
  const router = useRouter();
  const { user, isAdmin, isSales, profile } = useAuth();
  const supabase = createClient();

  const [view, setView] = useState<'week' | 'month'>('week');
  const [currentDate, setCurrentDate] = useState(() => {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.getFullYear(), d.getMonth(), diff);
  });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showTypeFilter, setShowTypeFilter] = useState<string>('all');

  // Manual event creation
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ title: '', description: '', event_date: '', event_time: '', event_type: 'meeting' as string, prospect_id: '' });
  const [creating, setCreating] = useState(false);

  // Date helpers
  const ds = (d: Date) => d.toISOString().split('T')[0];
  const isToday = (d: Date) => ds(d) === ds(new Date());

  const getWeekDays = () => {
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(currentDate);
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    return days;
  };

  const getMonthDays = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startOffset = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1;
    const days: Date[] = [];
    for (let i = -startOffset; i <= lastDay.getDate() + (6 - (lastDay.getDay() === 0 ? 6 : lastDay.getDay() - 1)); i++) {
      days.push(new Date(year, month, i + 1));
    }
    return days;
  };

  const navigate = (dir: number) => {
    const d = new Date(currentDate);
    if (view === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    setCurrentDate(d);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { loadEvents(); }, [currentDate, view]);

  const loadEvents = async () => {
    setLoading(true);
    const days = view === 'week' ? getWeekDays() : getMonthDays();
    const startDate = ds(days[0]);
    const endDate = ds(days[days.length - 1]);
    const allEvents: CalendarEvent[] = [];

    // 1. Graphics jobs with install dates
    if (isAdmin || profile?.role === 'graphics_production') {
      const { data: gfx } = await supabase
        .from('graphics_jobs')
        .select('id, title, job_number, customer, scheduled_install_date, status')
        .not('status', 'in', '("cancelled","installed")')
        .gte('scheduled_install_date', startDate)
        .lte('scheduled_install_date', endDate);
      (gfx || []).forEach((g: any) => allEvents.push({
        id: `gfx-${g.id}`, title: g.title || g.job_number, subtitle: g.customer,
        date: g.scheduled_install_date.split('T')[0], type: 'graphics', color: TYPE_COLORS.graphics,
        status: g.status, linkTo: `/graphics?id=${g.id}`,
      }));
    }

    // 2. Upfit dates (fleet check-ins)
    if (isAdmin || profile?.role === 'shop_tech') {
      const { data: upfit } = await supabase
        .from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, scheduled_upfit_date, status')
        .not('status', 'in', '("shipped","complete")')
        .gte('scheduled_upfit_date', startDate)
        .lte('scheduled_upfit_date', endDate);
      (upfit || []).forEach((u: any) => allEvents.push({
        id: `upfit-${u.id}`,
        title: [u.vehicle_year, u.vehicle_make, u.vehicle_model].filter(Boolean).join(' ') || u.vin,
        subtitle: u.customer_name, date: u.scheduled_upfit_date.split('T')[0],
        type: 'upfit', color: TYPE_COLORS.upfit, status: u.status, linkTo: `/tracking?vehicle=${u.id}`,
      }));
    }

    // 3. CNI job deadlines
    if (isAdmin || profile?.role === 'installer') {
      let cniQuery = supabase
        .from('cni_jobs')
        .select('id, job_number, title, customer_name, deadline, status')
        .not('status', 'in', '("completed","cancelled")')
        .gte('deadline', startDate)
        .lte('deadline', endDate);
      if (!isAdmin) cniQuery = cniQuery.eq('installer_id', user?.id);
      const { data: cni } = await cniQuery;
      (cni || []).forEach((c: any) => allEvents.push({
        id: `cni-${c.id}`, title: c.title || c.job_number, subtitle: c.customer_name,
        date: c.deadline.split('T')[0], type: 'cni', color: TYPE_COLORS.cni,
        status: c.status, linkTo: `/admin/cni/jobs/${c.id}`,
      }));
    }

    // 4. Prospect reminders
    if (isAdmin || isSales) {
      let remQuery = supabase
        .from('prospect_reminders')
        .select('id, title, description, due_at, prospect_id')
        .is('completed_at', null)
        .gte('due_at', startDate)
        .lte('due_at', endDate + 'T23:59:59');
      if (!isAdmin) remQuery = remQuery.eq('created_by', user?.id);
      const { data: rems } = await remQuery;
      (rems || []).forEach((r: any) => allEvents.push({
        id: `rem-${r.id}`, title: r.title, subtitle: r.description,
        date: r.due_at.split('T')[0], type: 'reminder', color: TYPE_COLORS.reminder,
        linkTo: r.prospect_id ? `/admin/prospects?id=${r.prospect_id}` : '/admin/prospects',
      }));
    }

    // 5. Manual calendar events
    {
      let manQuery = supabase
        .from('calendar_events')
        .select('*')
        .is('completed_at', null)
        .gte('event_date', startDate)
        .lte('event_date', endDate);
      // Google-imported events (source 'google') are shared calendar
      // entries — everyone with the schedule sees them, not just their
      // creator.
      if (!isAdmin) manQuery = manQuery.or(`user_id.eq.${user?.id},source.eq.google`);
      const { data: manual } = await manQuery;
      (manual || []).forEach((m: any) => allEvents.push({
        id: `man-${m.id}`, title: m.title, subtitle: m.description,
        date: m.event_date, time: m.event_time,
        type: m.source === 'google' ? 'google' : 'manual',
        color: m.source === 'google' ? TYPE_COLORS.google : TYPE_COLORS.manual,
      }));
    }

    setEvents(allEvents);
    setLoading(false);
  };

  const getEventsForDay = (date: Date) => {
    const d = ds(date);
    return events.filter(e => e.date === d && (showTypeFilter === 'all' || e.type === showTypeFilter));
  };

  const createEvent = async () => {
    if (!createForm.title.trim() || !createForm.event_date) return;
    setCreating(true);
    const { data: created } = await supabase.from('calendar_events').insert({
      title: createForm.title.trim(),
      description: createForm.description.trim() || null,
      event_date: createForm.event_date,
      event_time: createForm.event_time || null,
      event_type: createForm.event_type,
      prospect_id: createForm.prospect_id || null,
      user_id: user?.id,
    }).select('id').single();
    // Mirror onto the shared Google calendar (best-effort — the event is
    // already saved here either way).
    if (created?.id) {
      apiFetch('/api/calendar/sync-event', {
        method: 'POST',
        body: JSON.stringify({ eventId: created.id }),
      }).catch(() => {});
    }
    setCreateForm({ title: '', description: '', event_date: '', event_time: '', event_type: 'meeting', prospect_id: '' });
    setShowCreate(false);
    setCreating(false);
    loadEvents();
  };

  const headerLabel = view === 'week'
    ? `${getWeekDays()[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} — ${getWeekDays()[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
    : currentDate.toLocaleDateString([], { month: 'long', year: 'numeric' });

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Schedule</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{events.length} event{events.length !== 1 ? 's' : ''} this {view}</div>
        </div>
        <button onClick={() => setShowCreate(true)} style={{
          padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
          background: 'var(--tab-active-bg)', border: '1px solid var(--tab-active-border)',
          color: 'var(--tab-active-color)', cursor: 'pointer',
        }}>+ Event</button>
      </div>

      {/* View toggle + navigation */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button onClick={() => setView('week')} style={{
            padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
            background: view === 'week' ? 'var(--tab-active-bg)' : 'transparent',
            border: view === 'week' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: view === 'week' ? 'var(--tab-active-color)' : 'var(--text-muted)', cursor: 'pointer',
          }}>Week</button>
          <button onClick={() => setView('month')} style={{
            padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
            background: view === 'month' ? 'var(--tab-active-bg)' : 'transparent',
            border: view === 'month' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: view === 'month' ? 'var(--tab-active-color)' : 'var(--text-muted)', cursor: 'pointer',
          }}>Month</button>
        </div>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{headerLabel}</div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button onClick={() => navigate(-1)} style={{ padding: '5px 10px', borderRadius: '6px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px' }}>‹</button>
          <button onClick={() => { const d = new Date(); const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1); setCurrentDate(new Date(d.getFullYear(), d.getMonth(), diff)); }} style={{ padding: '5px 8px', borderRadius: '6px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '10px', fontWeight: 700 }}>Today</button>
          <button onClick={() => navigate(1)} style={{ padding: '5px 10px', borderRadius: '6px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px' }}>›</button>
        </div>
      </div>

      {/* Type filter */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {['all', 'graphics', 'upfit', 'cni', 'reminder', 'manual', 'google'].map(t => (
          <button key={t} onClick={() => setShowTypeFilter(t)} style={{
            padding: '4px 8px', borderRadius: '5px', fontSize: '9px', fontWeight: 700,
            background: showTypeFilter === t ? (t === 'all' ? 'var(--tab-active-bg)' : `${TYPE_COLORS[t]}18`) : 'transparent',
            border: `1px solid ${showTypeFilter === t ? (t === 'all' ? 'var(--tab-active-border)' : `${TYPE_COLORS[t]}44`) : 'var(--border)'}`,
            color: showTypeFilter === t ? (t === 'all' ? 'var(--tab-active-color)' : TYPE_COLORS[t]) : 'var(--text-muted)',
            cursor: 'pointer',
          }}>{t === 'all' ? 'All' : TYPE_LABELS[t]}</button>
        ))}
      </div>

      {/* Calendar grid */}
      {view === 'week' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {getWeekDays().map(day => {
            const dayEvents = getEventsForDay(day);
            const today = isToday(day);
            return (
              <div key={ds(day)} style={{
                background: today ? 'rgba(59,130,246,0.04)' : 'var(--card)',
                border: `1px solid ${today ? 'rgba(59,130,246,0.2)' : 'var(--border)'}`,
                borderRadius: '10px', padding: '10px 12px', minHeight: '60px',
              }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: today ? '#3b82f6' : 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>
                  {day.toLocaleDateString([], { weekday: 'short' })} {day.getDate()}
                  {dayEvents.length > 0 && <span style={{ marginLeft: '6px', fontWeight: 800, color: 'var(--text-primary)' }}>({dayEvents.length})</span>}
                </div>
                {dayEvents.length === 0 ? (
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No events</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    {dayEvents.map(ev => (
                      <div key={ev.id} onClick={() => ev.linkTo && router.push(ev.linkTo)} style={{
                        padding: '6px 8px', borderRadius: '6px', cursor: ev.linkTo ? 'pointer' : 'default',
                        background: `${ev.color}10`, borderLeft: `3px solid ${ev.color}`,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>{ev.title}</span>
                          <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', background: `${ev.color}18`, color: ev.color }}>{TYPE_LABELS[ev.type]}</span>
                        </div>
                        {ev.subtitle && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>{ev.subtitle}</div>}
                        {ev.time && <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{ev.time}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* Month view */
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '2px' }}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', padding: '4px', textTransform: 'uppercase' }}>{d}</div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
            {getMonthDays().map(day => {
              const dayEvents = getEventsForDay(day);
              const today = isToday(day);
              const isCurrentMonth = day.getMonth() === currentDate.getMonth();
              return (
                <div key={ds(day)} style={{
                  minHeight: '70px', padding: '4px', borderRadius: '6px',
                  background: today ? 'rgba(59,130,246,0.06)' : isCurrentMonth ? 'var(--card)' : 'var(--subtle-bg)',
                  border: `1px solid ${today ? 'rgba(59,130,246,0.2)' : 'var(--border)'}`,
                  opacity: isCurrentMonth ? 1 : 0.4,
                }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: today ? '#3b82f6' : 'var(--text-muted)', marginBottom: '2px' }}>{day.getDate()}</div>
                  {dayEvents.slice(0, 3).map(ev => (
                    <div key={ev.id} onClick={() => ev.linkTo && router.push(ev.linkTo)} style={{
                      padding: '1px 3px', borderRadius: '3px', marginBottom: '1px', cursor: ev.linkTo ? 'pointer' : 'default',
                      background: `${ev.color}18`, fontSize: '8px', fontWeight: 700, color: ev.color,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{ev.title}</div>
                  ))}
                  {dayEvents.length > 3 && <div style={{ fontSize: '8px', color: 'var(--text-muted)', textAlign: 'center' }}>+{dayEvents.length - 3}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Create event modal */}
      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }} onClick={() => setShowCreate(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '14px', padding: '20px', width: '100%', maxWidth: '400px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '14px' }}>New Event</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Title</div>
                <input value={createForm.title} onChange={e => setCreateForm(f => ({ ...f, title: e.target.value }))} placeholder="Meeting, call, deadline..." style={{
                  width: '100%', padding: '10px', borderRadius: '8px', fontSize: '14px',
                  border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
                }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Date</div>
                  <input type="date" value={createForm.event_date} onChange={e => setCreateForm(f => ({ ...f, event_date: e.target.value }))} style={{
                    width: '100%', padding: '10px', borderRadius: '8px', fontSize: '13px',
                    border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
                  }} />
                </div>
                <div>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Time (optional)</div>
                  <input type="time" value={createForm.event_time} onChange={e => setCreateForm(f => ({ ...f, event_time: e.target.value }))} style={{
                    width: '100%', padding: '10px', borderRadius: '8px', fontSize: '13px',
                    border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
                  }} />
                </div>
              </div>
              <div>
                <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Type</div>
                <select value={createForm.event_type} onChange={e => setCreateForm(f => ({ ...f, event_type: e.target.value }))} style={{
                  width: '100%', padding: '10px', borderRadius: '8px', fontSize: '13px',
                  border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
                }}>
                  <option value="meeting">Meeting</option>
                  <option value="call">Call</option>
                  <option value="reminder">Reminder</option>
                  <option value="deadline">Deadline</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Notes</div>
                <textarea value={createForm.description} onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))} placeholder="Details..." style={{
                  width: '100%', padding: '10px', borderRadius: '8px', fontSize: '13px', minHeight: '60px', resize: 'vertical',
                  border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
                }} />
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => setShowCreate(false)} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', cursor: 'pointer' }}>Cancel</button>
                <button onClick={createEvent} disabled={creating || !createForm.title.trim() || !createForm.event_date} style={{
                  flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
                  background: creating || !createForm.title.trim() || !createForm.event_date ? 'var(--border)' : '#22c55e',
                  color: '#fff', border: 'none', cursor: 'pointer', opacity: creating || !createForm.title.trim() || !createForm.event_date ? 0.5 : 1,
                }}>{creating ? 'Creating...' : 'Create'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
