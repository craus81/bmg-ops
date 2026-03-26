'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import type { InstallerAppointment, OutsideInstaller, GraphicsJob } from '@/lib/types';

// ─── Event types ──────────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  type: 'graphics_install' | 'production_schedule' | 'installer_appointment';
  color: string;
  bgColor: string;
  data: any;
}

const EVENT_COLORS = {
  graphics_install: { color: '#60a5fa', bgColor: 'rgba(96,165,250,0.15)', border: 'rgba(96,165,250,0.4)' },
  production_schedule: { color: '#34d399', bgColor: 'rgba(52,211,153,0.15)', border: 'rgba(52,211,153,0.4)' },
  installer_appointment: { color: '#fb923c', bgColor: 'rgba(251,146,60,0.15)', border: 'rgba(251,146,60,0.4)' },
};

// ─── Date helpers ─────────────────────────────────────────────────────────────

function toYMD(d: Date): string {
  return d.toISOString().split('T')[0];
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  r.setDate(r.getDate() - r.getDay()); // Sunday start
  return r;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function formatMonthYear(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(t: string | null): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ─── Event pill ──────────────────────────────────────────────────────────────

function EventPill({ event, onClick }: { event: CalendarEvent; onClick: () => void }) {
  const c = EVENT_COLORS[event.type];
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '2px 5px', borderRadius: '4px', marginBottom: '2px',
        background: c.bgColor, border: `1px solid ${c.border}`,
        color: c.color, fontSize: '10px', fontWeight: 600,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        cursor: 'pointer',
      }}
      title={event.title}
    >
      {event.title}
    </button>
  );
}

// ─── Event detail modal ───────────────────────────────────────────────────────

function EventModal({ event, onClose, isAdmin }: { event: CalendarEvent; onClose: () => void; isAdmin: boolean }) {
  const c = EVENT_COLORS[event.type];
  const d = event.data;

  const typeLabel = {
    graphics_install: '🔵 Graphics Install',
    production_schedule: '🟢 Production Schedule',
    installer_appointment: '🟠 Installer Appointment',
  }[event.type];

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        zIndex: 200, padding: '0',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: theme.card, borderRadius: '20px 20px 0 0',
          padding: '20px 20px 32px', width: '100%', maxWidth: '480px',
          borderTop: `3px solid ${c.color}`,
        }}
      >
        {/* Handle */}
        <div style={{ width: '36px', height: '4px', background: theme.border, borderRadius: '2px', margin: '0 auto 16px' }} />

        {/* Type badge */}
        <div style={{
          display: 'inline-block', padding: '3px 8px', borderRadius: '6px',
          background: c.bgColor, border: `1px solid ${c.border}`,
          color: c.color, fontSize: '11px', fontWeight: 700, marginBottom: '10px',
        }}>{typeLabel}</div>

        <div style={{ fontSize: '18px', fontWeight: 800, marginBottom: '4px' }}>{event.title}</div>
        <div style={{ fontSize: '13px', color: theme.textSecondary, marginBottom: '16px' }}>
          {formatDate(new Date(event.date + 'T00:00:00'))}
        </div>

        {/* Details by type */}
        {event.type === 'graphics_install' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {d.job_number && <DetailRow label="Job #" value={d.job_number} />}
            {d.customer && <DetailRow label="Customer" value={d.customer} />}
            {d.part_number && <DetailRow label="Part #" value={d.part_number} />}
            {d.quantity && <DetailRow label="Qty" value={String(d.quantity)} />}
            {d.ship_to && <DetailRow label="Ship To" value={d.ship_to} />}
            {d.notes && <DetailRow label="Notes" value={d.notes} />}
            <DetailRow label="Status" value={d.status} />
          </div>
        )}

        {event.type === 'production_schedule' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {d.sales_order_number && <DetailRow label="SO #" value={d.sales_order_number} />}
            {d.customer_name && <DetailRow label="Customer" value={d.customer_name} />}
            {d.vin && <DetailRow label="VIN" value={d.vin} />}
            {d.notes && <DetailRow label="Notes" value={d.notes} />}
            <DetailRow label="Status" value={d.status} />
          </div>
        )}

        {event.type === 'installer_appointment' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {d.outside_installer && (
              <DetailRow
                label="Installer"
                value={`${d.outside_installer.name}${d.outside_installer.company_name ? ` — ${d.outside_installer.company_name}` : ''}`}
              />
            )}
            {d.outside_installer?.phone && <DetailRow label="Phone" value={d.outside_installer.phone} />}
            {(d.start_time || d.end_time) && (
              <DetailRow
                label="Time"
                value={[formatTime(d.start_time), formatTime(d.end_time)].filter(Boolean).join(' – ')}
              />
            )}
            {d.graphics_job && (
              <DetailRow
                label="Linked Job"
                value={`${d.graphics_job.job_number || d.graphics_job.title}${d.graphics_job.customer ? ` — ${d.graphics_job.customer}` : ''}`}
              />
            )}
            {d.description && <DetailRow label="Notes" value={d.description} />}
            <DetailRow label="Status" value={d.status} />
          </div>
        )}

        <button
          onClick={onClose}
          style={{
            marginTop: '20px', width: '100%', padding: '14px', borderRadius: '12px',
            background: theme.border, border: 'none', color: theme.textPrimary,
            fontWeight: 700, fontSize: '14px', cursor: 'pointer',
          }}
        >Close</button>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textMuted, minWidth: '80px', flexShrink: 0 }}>{label}</div>
      <div style={{ fontSize: '13px', color: theme.textPrimary, flex: 1 }}>{value}</div>
    </div>
  );
}

// ─── New Appointment Modal ────────────────────────────────────────────────────

interface NewApptModalProps {
  installers: OutsideInstaller[];
  initialDate?: string;
  onClose: () => void;
  onCreated: (appt: InstallerAppointment) => void;
  isAdmin: boolean;
}

function NewAppointmentModal({ installers, initialDate, onClose, onCreated, isAdmin }: NewApptModalProps) {
  const [installerId, setInstallerId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(initialDate || toYMD(new Date()));
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [linkedJobSearch, setLinkedJobSearch] = useState('');
  const [linkedJobId, setLinkedJobId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canSubmit = installerId && title.trim() && date;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outside_installer_id: installerId,
          title: title.trim(),
          description: description.trim() || null,
          scheduled_date: date,
          start_time: startTime || null,
          end_time: endTime || null,
          graphics_job_id: linkedJobId || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create appointment');
      onCreated(data);
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: theme.card, borderRadius: '20px 20px 0 0',
          padding: '20px 20px 32px', width: '100%', maxWidth: '480px',
          borderTop: `3px solid ${EVENT_COLORS.installer_appointment.color}`,
          maxHeight: '90vh', overflowY: 'auto',
        }}
      >
        <div style={{ width: '36px', height: '4px', background: theme.border, borderRadius: '2px', margin: '0 auto 16px' }} />
        <div style={{ fontSize: '16px', fontWeight: 800, marginBottom: '16px' }}>New Installer Appointment</div>

        {error && (
          <div style={{ padding: '8px 12px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, borderRadius: '8px', color: theme.error, fontSize: '12px', marginBottom: '12px' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Installer picker */}
          <div>
            <label style={labelStyle}>Outside Installer *</label>
            <select
              value={installerId}
              onChange={(e) => setInstallerId(e.target.value)}
              style={inputStyle}
            >
              <option value="">Select installer...</option>
              {installers.map(i => (
                <option key={i.id} value={i.id}>
                  {i.name}{i.company_name ? ` — ${i.company_name}` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Title */}
          <div>
            <label style={labelStyle}>Title *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Vehicle wrap install"
              style={inputStyle}
            />
          </div>

          {/* Date */}
          <div>
            <label style={labelStyle}>Date *</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
          </div>

          {/* Time range */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Start Time</label>
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>End Time</label>
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} style={inputStyle} />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label style={labelStyle}>Notes</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Any additional details..."
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
          <button onClick={onClose} style={{
            flex: 1, padding: '14px', borderRadius: '12px',
            background: theme.border, border: 'none', color: theme.textPrimary,
            fontWeight: 700, fontSize: '14px', cursor: 'pointer',
          }}>Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || saving}
            style={{
              flex: 2, padding: '14px', borderRadius: '12px',
              background: canSubmit ? EVENT_COLORS.installer_appointment.color : theme.border,
              border: 'none', color: '#fff',
              fontWeight: 800, fontSize: '14px', cursor: canSubmit ? 'pointer' : 'default',
              opacity: saving ? 0.6 : 1,
            }}
          >{saving ? 'Creating...' : 'Create Appointment'}</button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '10px', fontWeight: 700,
  color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.5px', marginBottom: '5px',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: '10px',
  border: `1px solid var(--border)`, background: 'var(--input-bg)',
  color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600,
  boxSizing: 'border-box',
};

// ─── Main Calendar Page ───────────────────────────────────────────────────────

export default function CalendarPage() {
  const { profile } = useAuth();
  const supabase = createClient();
  const isAdmin = profile?.role === 'admin' || (profile?.roles || []).includes('admin' as any);

  const [view, setView] = useState<'month' | 'week'>('month');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [showNewAppt, setShowNewAppt] = useState(false);
  const [newApptDate, setNewApptDate] = useState<string | undefined>();
  const [installers, setInstallers] = useState<OutsideInstaller[]>([]);

  // Compute visible date range
  const visibleRange = useCallback((): { start: Date; end: Date } => {
    if (view === 'week') {
      const s = startOfWeek(currentDate);
      return { start: s, end: addDays(s, 6) };
    } else {
      const s = startOfMonth(currentDate);
      const e = endOfMonth(currentDate);
      // Pad to full weeks
      return { start: addDays(s, -s.getDay()), end: addDays(e, 6 - e.getDay()) };
    }
  }, [view, currentDate]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    const { start, end } = visibleRange();
    const startStr = toYMD(start);
    const endStr = toYMD(end);

    const collected: CalendarEvent[] = [];

    // 1. Graphics install dates
    const { data: gfxJobs } = await supabase
      .from('graphics_jobs')
      .select('id, title, job_number, customer, part_number, quantity, ship_to, notes, status, scheduled_install_date')
      .not('scheduled_install_date', 'is', null)
      .neq('status', 'cancelled')
      .gte('scheduled_install_date', startStr)
      .lte('scheduled_install_date', endStr);

    for (const j of gfxJobs || []) {
      collected.push({
        id: `gfx-${j.id}`,
        date: j.scheduled_install_date,
        title: `${j.title}${j.customer ? ` — ${j.customer}` : ''}`,
        type: 'graphics_install',
        color: EVENT_COLORS.graphics_install.color,
        bgColor: EVENT_COLORS.graphics_install.bgColor,
        data: j,
      });
    }

    // 2. Production schedule dates
    const { data: checkins } = await supabase
      .from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, sales_order_number, notes, status, production_schedule_date')
      .not('production_schedule_date', 'is', null)
      .gte('production_schedule_date', startStr)
      .lte('production_schedule_date', endStr);

    for (const c of checkins || []) {
      const vehicle = [c.vehicle_year, c.vehicle_make, c.vehicle_model].filter(Boolean).join(' ') || c.vin;
      collected.push({
        id: `prod-${c.id}`,
        date: c.production_schedule_date,
        title: `${vehicle}${c.customer_name ? ` — ${c.customer_name}` : ''}`,
        type: 'production_schedule',
        color: EVENT_COLORS.production_schedule.color,
        bgColor: EVENT_COLORS.production_schedule.bgColor,
        data: c,
      });
    }

    // 3. Installer appointments
    const { data: appts } = await supabase
      .from('installer_appointments')
      .select(`
        *,
        outside_installer:outside_installers(id, name, company_name, phone),
        graphics_job:graphics_jobs(id, title, job_number, customer)
      `)
      .neq('status', 'cancelled')
      .gte('scheduled_date', startStr)
      .lte('scheduled_date', endStr);

    for (const a of appts || []) {
      const installer = a.outside_installer;
      collected.push({
        id: `appt-${a.id}`,
        date: a.scheduled_date,
        title: `${a.title}${installer ? ` — ${installer.name}` : ''}`,
        type: 'installer_appointment',
        color: EVENT_COLORS.installer_appointment.color,
        bgColor: EVENT_COLORS.installer_appointment.bgColor,
        data: a,
      });
    }

    collected.sort((a, b) => a.date.localeCompare(b.date));
    setEvents(collected);
    setLoading(false);
  }, [visibleRange, supabase]);

  const loadInstallers = useCallback(async () => {
    const res = await fetch('/api/installers');
    if (res.ok) {
      const data = await res.json();
      setInstallers(data);
    }
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    loadInstallers();
  }, [loadInstallers]);

  const eventsOnDate = (dateStr: string) => events.filter(e => e.date === dateStr);

  const navigate = (dir: -1 | 1) => {
    if (view === 'week') {
      setCurrentDate(d => addDays(d, dir * 7));
    } else {
      setCurrentDate(d => {
        const nd = new Date(d);
        nd.setMonth(nd.getMonth() + dir);
        return nd;
      });
    }
  };

  const today = toYMD(new Date());

  // ─── Month View ─────────────────────────────────────────────────────────────

  const renderMonthView = () => {
    const { start, end } = visibleRange();
    const days: Date[] = [];
    let cur = new Date(start);
    while (cur <= end) {
      days.push(new Date(cur));
      cur = addDays(cur, 1);
    }

    const isThisMonth = (d: Date) => d.getMonth() === currentDate.getMonth();

    return (
      <div>
        {/* Day headers */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: '2px' }}>
          {DAY_LABELS.map(l => (
            <div key={l} style={{
              textAlign: 'center', fontSize: '10px', fontWeight: 700,
              color: theme.textMuted, padding: '4px 0',
              textTransform: 'uppercase', letterSpacing: '0.5px',
            }}>{l}</div>
          ))}
        </div>

        {/* Day cells */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
          {days.map((d) => {
            const dateStr = toYMD(d);
            const dayEvents = eventsOnDate(dateStr);
            const isToday = dateStr === today;
            const inMonth = isThisMonth(d);

            return (
              <div
                key={dateStr}
                onClick={() => { setNewApptDate(dateStr); if (isAdmin) setShowNewAppt(true); }}
                style={{
                  minHeight: '80px', padding: '4px',
                  background: isToday ? 'rgba(238,49,32,0.06)' : theme.card,
                  border: `1px solid ${isToday ? 'rgba(238,49,32,0.3)' : theme.border}`,
                  borderRadius: '8px',
                  opacity: inMonth ? 1 : 0.4,
                  cursor: isAdmin ? 'pointer' : 'default',
                }}
              >
                <div style={{
                  fontSize: '12px', fontWeight: isToday ? 800 : 600,
                  color: isToday ? 'var(--orange)' : (inMonth ? theme.textPrimary : theme.textMuted),
                  marginBottom: '4px',
                  width: '20px', height: '20px', borderRadius: '50%',
                  background: isToday ? 'rgba(238,49,32,0.15)' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{d.getDate()}</div>
                {dayEvents.slice(0, 3).map(ev => (
                  <EventPill key={ev.id} event={ev} onClick={() => setSelectedEvent(ev)} />
                ))}
                {dayEvents.length > 3 && (
                  <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>
                    +{dayEvents.length - 3} more
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ─── Week View ──────────────────────────────────────────────────────────────

  const renderWeekView = () => {
    const { start } = visibleRange();
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

    return (
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>
          {days.map((d) => {
            const dateStr = toYMD(d);
            const dayEvents = eventsOnDate(dateStr);
            const isToday = dateStr === today;

            return (
              <div key={dateStr} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {/* Day header */}
                <div
                  onClick={() => { setNewApptDate(dateStr); if (isAdmin) setShowNewAppt(true); }}
                  style={{
                    textAlign: 'center', padding: '6px 2px',
                    background: isToday ? 'rgba(238,49,32,0.12)' : theme.card,
                    border: `1px solid ${isToday ? 'rgba(238,49,32,0.35)' : theme.border}`,
                    borderRadius: '8px', cursor: isAdmin ? 'pointer' : 'default',
                  }}
                >
                  <div style={{ fontSize: '9px', fontWeight: 700, color: isToday ? 'var(--orange)' : theme.textMuted, textTransform: 'uppercase' }}>
                    {DAY_LABELS[d.getDay()]}
                  </div>
                  <div style={{ fontSize: '16px', fontWeight: isToday ? 800 : 600, color: isToday ? 'var(--orange)' : theme.textPrimary }}>
                    {d.getDate()}
                  </div>
                </div>

                {/* Events */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {dayEvents.map(ev => (
                    <EventPill key={ev.id} event={ev} onClick={() => setSelectedEvent(ev)} />
                  ))}
                  {dayEvents.length === 0 && (
                    <div style={{ height: '40px', borderRadius: '6px', border: `1px dashed ${theme.border}` }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ─── Legend ─────────────────────────────────────────────────────────────────

  const renderLegend = () => (
    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
      {([
        { type: 'graphics_install', label: 'Graphics Install' },
        { type: 'production_schedule', label: 'Production' },
        { type: 'installer_appointment', label: 'Installer Appt' },
      ] as const).map(({ type, label }) => {
        const c = EVENT_COLORS[type];
        return (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <div style={{ width: '10px', height: '10px', borderRadius: '3px', background: c.color }} />
            <span style={{ fontSize: '11px', color: theme.textSecondary, fontWeight: 600 }}>{label}</span>
          </div>
        );
      })}
    </div>
  );

  // ─── Heading label ───────────────────────────────────────────────────────────

  const headingLabel = () => {
    if (view === 'month') return formatMonthYear(currentDate);
    const { start, end } = visibleRange();
    if (start.getMonth() === end.getMonth()) {
      return `${start.toLocaleDateString('en-US', { month: 'long' })} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
    }
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  };

  return (
    <div style={{ padding: '16px 16px 100px' }}>
      {/* Header */}
      <div style={{ marginBottom: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>Calendar</h1>
          {isAdmin && (
            <button
              onClick={() => { setNewApptDate(today); setShowNewAppt(true); }}
              style={{
                padding: '8px 14px', borderRadius: '10px', background: EVENT_COLORS.installer_appointment.color,
                border: 'none', color: '#fff', fontWeight: 700, fontSize: '13px', cursor: 'pointer',
              }}
            >+ Appointment</button>
          )}
        </div>

        {/* View toggle */}
        <div style={{ display: 'flex', gap: '4px', background: theme.card, borderRadius: '10px', padding: '3px', marginBottom: '10px' }}>
          {(['month', 'week'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                flex: 1, padding: '7px', borderRadius: '7px', fontSize: '12px', fontWeight: 700,
                background: view === v ? theme.tabActiveBg : 'transparent', border: 'none',
                color: view === v ? 'var(--tab-active-color)' : theme.textMuted, cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >{v}</button>
          ))}
        </div>

        {/* Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button
            onClick={() => navigate(-1)}
            style={{ padding: '6px 12px', borderRadius: '8px', background: theme.card, border: `1px solid ${theme.border}`, color: theme.textPrimary, fontWeight: 700, cursor: 'pointer' }}
          >‹</button>
          <div style={{ fontSize: '15px', fontWeight: 800 }}>{headingLabel()}</div>
          <button
            onClick={() => navigate(1)}
            style={{ padding: '6px 12px', borderRadius: '8px', background: theme.card, border: `1px solid ${theme.border}`, color: theme.textPrimary, fontWeight: 700, cursor: 'pointer' }}
          >›</button>
        </div>
      </div>

      {renderLegend()}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div style={{ width: '28px', height: '28px', border: `3px solid ${theme.border}`, borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
          <div style={{ color: theme.textMuted, marginTop: '10px', fontSize: '13px' }}>Loading events...</div>
        </div>
      ) : (
        view === 'month' ? renderMonthView() : renderWeekView()
      )}

      {/* Today button */}
      <button
        onClick={() => setCurrentDate(new Date())}
        style={{
          position: 'fixed', bottom: '80px', right: '16px',
          padding: '8px 14px', borderRadius: '10px',
          background: theme.navy, color: '#fff',
          fontWeight: 700, fontSize: '12px', border: 'none', cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          zIndex: 50,
        }}
      >Today</button>

      {/* Modals */}
      {selectedEvent && (
        <EventModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          isAdmin={isAdmin}
        />
      )}

      {showNewAppt && isAdmin && (
        <NewAppointmentModal
          installers={installers}
          initialDate={newApptDate}
          onClose={() => setShowNewAppt(false)}
          onCreated={(appt) => {
            setShowNewAppt(false);
            loadEvents();
          }}
          isAdmin={isAdmin}
        />
      )}
    </div>
  );
}
