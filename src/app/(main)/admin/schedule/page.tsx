'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth, useRequireFeature } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { storage, storageDownloadUrl } from '@/lib/storage';
import { DropZone } from '@/components/DropZone';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import { flashNote } from '@/lib/focus-note';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';
import UploadProgressBar, { type UploadProgress } from '@/components/UploadProgressBar';

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
  /** Raw calendar_events id — set for manual/google rows, opens the card. */
  cardId?: string;
  noteCount?: number;
  fileCount?: number;
}

const TYPE_COLORS: Record<string, string> = {
  graphics: '#c084fc',
  upfit: '#60a5fa',
  cni: '#4ade80',
  reminder: '#fbbf24',
  manual: '#f472b6',
  google: '#2dd4bf',
};

/** "14:30" / "14:30:00" → "2:30 PM". Passes through anything unparseable. */
const fmt12h = (t: string) => {
  const [h, m] = t.split(':');
  const hour = parseInt(h, 10);
  if (isNaN(hour) || m == null) return t;
  return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
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
  const searchParams = useSearchParams();
  const { user, isAdmin, isSales, profile } = useAuth();
  useRequireFeature('schedule');
  const dialog = useDialog();
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

  // Deep link (mentions inbox): ?card=<calendar_events id> opens that event's
  // card directly — openCard fetches by id, so it works whatever week is shown.
  useEffect(() => {
    const cardId = searchParams.get('card');
    if (cardId) openCard(cardId);
    // A mention deep link (&note=<id>) scroll-flashes that note once the
    // card modal's notes load.
    const noteId = searchParams.get('note');
    if (noteId) flashNote(`cev-note-${noteId}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: open once on mount
  }, []);

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
        linkTo: r.prospect_id ? `/admin/prospects/${r.prospect_id}` : '/admin/prospects',
      }));
    }

    // 5. Manual calendar events
    {
      let manQuery = supabase
        .from('calendar_events')
        .select('*, calendar_event_notes(count), calendar_event_files(count)')
        .is('completed_at', null)
        // Converted cards live on as graphics jobs — the job entry replaces
        // the raw event on this board.
        .is('linked_graphics_job_id', null)
        .gte('event_date', startDate)
        .lte('event_date', endDate);
      // Google-imported events (source 'google') are shared calendar
      // entries — everyone with the schedule sees them, not just their
      // creator.
      if (!isAdmin) manQuery = manQuery.or(`user_id.eq.${user?.id},source.eq.google`);
      let { data: manual, error: manErr } = await manQuery;
      if (manErr) {
        // Migration 172 not applied yet (card tables/column missing) —
        // degrade to the plain query rather than blanking the board.
        let fallback = supabase
          .from('calendar_events')
          .select('*')
          .is('completed_at', null)
          .gte('event_date', startDate)
          .lte('event_date', endDate);
        if (!isAdmin) fallback = fallback.or(`user_id.eq.${user?.id},source.eq.google`);
        manual = (await fallback).data;
      }
      (manual || []).forEach((m: any) => allEvents.push({
        id: `man-${m.id}`, title: m.title, subtitle: m.description,
        date: m.event_date, time: m.event_time,
        type: m.source === 'google' ? 'google' : 'manual',
        color: m.source === 'google' ? TYPE_COLORS.google : TYPE_COLORS.manual,
        cardId: m.id,
        noteCount: m.calendar_event_notes?.[0]?.count || 0,
        fileCount: m.calendar_event_files?.[0]?.count || 0,
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

  // ── Event card: notes + files + convert-to-job for manual/Google events ──
  const [cardEvent, setCardEvent] = useState<any | null>(null);
  const [cardNotes, setCardNotes] = useState<any[]>([]);
  const [cardFiles, setCardFiles] = useState<any[]>([]);
  const [cardNoteDraft, setCardNoteDraft] = useState('');
  const [cardBusy, setCardBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);

  // Inline edit of the event itself (title/date/time/description) — saved
  // edits push back to Google when the event lives there too.
  const [cardEdit, setCardEdit] = useState<{ title: string; event_date: string; event_time: string; description: string } | null>(null);

  const openCard = async (cardId: string) => {
    const [{ data: ev }, { data: notes }, { data: files }] = await Promise.all([
      supabase.from('calendar_events').select('*').eq('id', cardId).maybeSingle(),
      supabase.from('calendar_event_notes').select('*').eq('event_id', cardId).order('created_at', { ascending: true }),
      supabase.from('calendar_event_files').select('*').eq('event_id', cardId).order('created_at', { ascending: true }),
    ]);
    if (!ev) return;
    setCardEvent(ev);
    setCardNotes(notes || []);
    setCardFiles(files || []);
    setCardNoteDraft('');
    setCardEdit(null);
  };

  const saveCardEdit = async () => {
    if (!cardEvent || !cardEdit || !cardEdit.title.trim() || !cardEdit.event_date) return;
    setCardBusy(true);
    try {
      const updates = {
        title: cardEdit.title.trim(),
        event_date: cardEdit.event_date,
        event_time: cardEdit.event_time || null,
        description: cardEdit.description.trim() || null,
      };
      const { error } = await supabase.from('calendar_events').update(updates).eq('id', cardEvent.id);
      if (error) { await dialog.alert(`Save failed: ${error.message}`); return; }
      // Mirror the edit to Google (updates the existing event in place;
      // creates one for app events that never synced).
      apiFetch('/api/calendar/sync-event', {
        method: 'POST',
        body: JSON.stringify({ eventId: cardEvent.id }),
      }).catch(() => {});
      setCardEvent({ ...cardEvent, ...updates });
      setCardEdit(null);
      loadEvents();
    } finally {
      setCardBusy(false);
    }
  };

  const addCardNote = async () => {
    const text = cardNoteDraft.trim();
    if (!text || !cardEvent) return;
    const { data: inserted, error } = await supabase.from('calendar_event_notes').insert({
      event_id: cardEvent.id,
      note: text,
      created_by: user?.id || null,
      created_by_name: profile?.full_name || null,
    }).select('id').single();
    if (!error) {
      // Carry the note id so a mention deep link scrolls straight to it.
      reportMentions({
        text,
        sourceType: 'calendar_event_note',
        sourceId: cardEvent.id,
        contextLabel: `Schedule — ${cardEvent.title}`,
        contextUrl: `/admin/schedule?card=${cardEvent.id}${inserted?.id ? `&note=${inserted.id}` : ''}`,
      });
      setCardNoteDraft('');
      const { data: notes } = await supabase.from('calendar_event_notes').select('*').eq('event_id', cardEvent.id).order('created_at', { ascending: true });
      setCardNotes(notes || []);
      loadEvents();
    }
  };

  const uploadCardFiles = async (files: File[]) => {
    if (!cardEvent || files.length === 0) return;
    setCardBusy(true);
    for (const [i, file] of files.entries()) {
      const path = `calendar-events/${cardEvent.id}/${Date.now()}-${file.name.replace(/[^\w.\-]+/g, '_')}`;
      setUploadProgress({ fileName: file.name, fileIndex: i + 1, fileCount: files.length, loaded: 0, total: file.size });
      const { error: upErr } = await storage.from('graphics-proofs').upload(path, file, {
        contentType: file.type,
        onProgress: (loaded, total) => setUploadProgress({ fileName: file.name, fileIndex: i + 1, fileCount: files.length, loaded, total }),
      });
      if (!upErr) {
        await supabase.from('calendar_event_files').insert({
          event_id: cardEvent.id,
          file_name: file.name,
          file_type: file.type || null,
          file_size: file.size,
          storage_path: path,
          uploaded_by: user?.id || null,
        });
      }
    }
    setUploadProgress(null);
    const { data: rows } = await supabase.from('calendar_event_files').select('*').eq('event_id', cardEvent.id).order('created_at', { ascending: true });
    setCardFiles(rows || []);
    setCardBusy(false);
    loadEvents();
  };

  const deleteCardFile = async (f: any) => {
    if (!(await dialog.confirm(`Delete ${f.file_name}?`, { destructive: true }))) return;
    await storage.from('graphics-proofs').remove([f.storage_path]).catch(() => {});
    await supabase.from('calendar_event_files').delete().eq('id', f.id);
    setCardFiles(prev => prev.filter(x => x.id !== f.id));
    loadEvents();
  };

  // Serve through the download route so a save keeps the original file_name —
  // the raw public URL saves as the prefixed storage key.
  const fileUrl = (f: { storage_path: string; file_name: string }) =>
    storageDownloadUrl('graphics-proofs', f.storage_path, f.file_name);

  // Turn the card into a real graphics job: the job inherits the title,
  // install date, description, notes, and files, and takes over the Google
  // event (calendar_event_id) so drags on Google keep moving the job. The
  // raw event disappears from this board — the job entry replaces it.
  const convertCardToJob = async () => {
    if (!cardEvent || cardBusy) return;
    if (!(await dialog.confirm(`Create a graphics job from "${cardEvent.title}"? Its notes and files carry over, and the calendar entry stays linked.`, { confirmLabel: 'Create job' }))) return;
    setCardBusy(true);
    try {
      const { data: job, error } = await supabase.from('graphics_jobs').insert({
        job_number: await nextJobNumber(supabase, 'GFX', () => legacyJobNumber.gfx()),
        job_category: 'production',
        title: cardEvent.title,
        notes: cardEvent.description || null,
        quantity: 1,
        priority: 'normal',
        status: 'received',
        scheduled_install_date: cardEvent.event_date,
        calendar_event_id: cardEvent.google_event_id || null,
        created_by: user?.id || null,
      }).select('id, job_number').single();
      if (error || !job) {
        await dialog.alert(`Could not create the job: ${error?.message || 'unknown error'}`);
        return;
      }

      await supabase.from('graphics_status_history').insert({
        job_id: job.id,
        from_status: null,
        to_status: 'received',
        changed_by: user?.id || null,
        note: `Created from schedule event "${cardEvent.title}"`,
      });
      // Carry the card's notes and files onto the job so nothing is lost.
      for (const n of cardNotes) {
        await supabase.from('graphics_status_history').insert({
          job_id: job.id, from_status: 'received', to_status: 'received',
          changed_by: n.created_by || null,
          note: n.note,
        });
      }
      if (cardFiles.length > 0) {
        await supabase.from('graphics_job_files').insert(cardFiles.map(f => ({
          job_id: job.id,
          file_name: f.file_name,
          file_type: f.file_type,
          file_size: f.file_size,
          storage_path: f.storage_path,
          uploaded_by: f.uploaded_by,
        })));
      }
      await supabase.from('calendar_events').update({ linked_graphics_job_id: job.id }).eq('id', cardEvent.id);

      setCardEvent(null);
      loadEvents();
      if (await dialog.confirm(`Graphics job ${job.job_number} created. Open it on the Graphics board?`)) {
        router.push(`/graphics?editJob=${job.id}`);
      }
    } finally {
      setCardBusy(false);
    }
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
                      <div key={ev.id} onClick={() => ev.cardId ? openCard(ev.cardId) : ev.linkTo && router.push(ev.linkTo)} style={{
                        padding: '6px 8px', borderRadius: '6px', cursor: (ev.cardId || ev.linkTo) ? 'pointer' : 'default',
                        background: `${ev.color}10`, borderLeft: `3px solid ${ev.color}`,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>{ev.title}</span>
                          <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', background: `${ev.color}18`, color: ev.color }}>{TYPE_LABELS[ev.type]}</span>
                        </div>
                        {ev.subtitle && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>{ev.subtitle}</div>}
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          {ev.time && <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{fmt12h(ev.time)}</span>}
                          {(ev.noteCount || 0) > 0 && <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{ev.noteCount} note{(ev.noteCount || 0) !== 1 ? 's' : ''}</span>}
                          {(ev.fileCount || 0) > 0 && <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{ev.fileCount} file{(ev.fileCount || 0) !== 1 ? 's' : ''}</span>}
                        </div>
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
                    <div key={ev.id} onClick={() => ev.cardId ? openCard(ev.cardId) : ev.linkTo && router.push(ev.linkTo)} style={{
                      padding: '1px 3px', borderRadius: '3px', marginBottom: '1px', cursor: (ev.cardId || ev.linkTo) ? 'pointer' : 'default',
                      background: `${ev.color}18`, fontSize: '8px', fontWeight: 700, color: ev.color,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{((ev.noteCount || 0) > 0 || (ev.fileCount || 0) > 0) ? '• ' : ''}{ev.title}</div>
                  ))}
                  {dayEvents.length > 3 && <div style={{ fontSize: '8px', color: 'var(--text-muted)', textAlign: 'center' }}>+{dayEvents.length - 3}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Create event modal */}
      {/* ═══ Event card: notes, files, convert to job ═══ */}
      {cardEvent && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }} onClick={() => setCardEvent(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '14px', padding: '20px', width: '100%', maxWidth: '480px', maxHeight: 'calc(88vh / var(--ts))', overflowY: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: '4px' }}>
              {cardEdit ? (
                <input
                  value={cardEdit.title}
                  onChange={e => setCardEdit({ ...cardEdit, title: e.target.value })}
                  style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '15px', fontWeight: 800, border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)' }}
                />
              ) : (
                <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>{cardEvent.title}</div>
              )}
              <span style={{
                fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px', whiteSpace: 'nowrap',
                background: `${cardEvent.source === 'google' ? TYPE_COLORS.google : TYPE_COLORS.manual}18`,
                color: cardEvent.source === 'google' ? TYPE_COLORS.google : TYPE_COLORS.manual,
              }}>{cardEvent.source === 'google' ? 'From Google Calendar' : 'FleetSuite event'}</span>
            </div>
            {cardEdit ? (
              <div style={{ marginBottom: '12px' }}>
                <div style={{ display: 'flex', gap: '8px', margin: '8px 0' }}>
                  <input
                    type="date"
                    value={cardEdit.event_date}
                    onChange={e => setCardEdit({ ...cardEdit, event_date: e.target.value })}
                    style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '12px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-body)' }}
                  />
                  <input
                    type="time"
                    value={cardEdit.event_time}
                    onChange={e => setCardEdit({ ...cardEdit, event_time: e.target.value })}
                    style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '12px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-body)' }}
                  />
                </div>
                <textarea
                  value={cardEdit.description}
                  onChange={e => setCardEdit({ ...cardEdit, description: e.target.value })}
                  placeholder="Description"
                  rows={3}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', fontSize: '12px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-body)', resize: 'vertical', fontFamily: 'inherit', marginBottom: '8px' }}
                />
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button onClick={saveCardEdit} disabled={cardBusy || !cardEdit.title.trim() || !cardEdit.event_date} style={{
                    padding: '7px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 800,
                    background: 'var(--orange)', color: '#fff', border: 'none', cursor: 'pointer',
                  }}>{cardBusy ? 'Saving…' : `Save${cardEvent.google_event_id || cardEvent.source === 'google' ? ' & update Google' : ''}`}</button>
                  <button onClick={() => setCardEdit(null)} style={{ padding: '7px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--subtle-bg)', color: 'var(--text-muted)', border: `1px solid ${theme.border}`, cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {new Date(cardEvent.event_date + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                    {cardEvent.event_time ? ` · ${fmt12h(cardEvent.event_time)}` : ''}
                  </span>
                  <button
                    onClick={() => setCardEdit({ title: cardEvent.title || '', event_date: cardEvent.event_date || '', event_time: cardEvent.event_time ? cardEvent.event_time.slice(0, 5) : '', description: cardEvent.description || '' })}
                    style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '5px', background: 'var(--subtle-bg)', color: '#60a5fa', border: `1px solid ${theme.border}`, cursor: 'pointer' }}
                  >✎ Edit</button>
                </div>
                {cardEvent.description && (
                  <div style={{ fontSize: '12px', color: 'var(--text-body)', whiteSpace: 'pre-wrap', background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`, borderRadius: '8px', padding: '8px 10px', marginBottom: '12px' }}>
                    {cardEvent.description}
                  </div>
                )}
              </>
            )}

            {/* Notes */}
            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '6px' }}>Notes</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
              {cardNotes.length === 0 && <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No notes yet.</div>}
              {cardNotes.map(n => (
                <div key={n.id} id={`cev-note-${n.id}`} style={{ background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`, borderRadius: '8px', padding: '7px 10px' }}>
                  <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>
                    {n.created_by_name || 'Someone'} · {new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-body)', whiteSpace: 'pre-wrap' }}>{n.note}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
              <MentionTextArea
                value={cardNoteDraft}
                onChange={setCardNoteDraft}
                placeholder="Add a note — @ tags a teammate"
                rows={1}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addCardNote(); } }}
                style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '12px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-body)', resize: 'none' }}
              />
              <button onClick={addCardNote} disabled={!cardNoteDraft.trim()} style={{
                padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, alignSelf: 'flex-end',
                background: cardNoteDraft.trim() ? 'var(--orange)' : 'var(--subtle-bg)', color: cardNoteDraft.trim() ? '#fff' : 'var(--text-muted)', border: 'none', cursor: 'pointer',
              }}>Add</button>
            </div>

            {/* Files */}
            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '6px' }}>Files</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
              {cardFiles.length === 0 && <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No files yet.</div>}
              {cardFiles.map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`, borderRadius: '8px', padding: '6px 10px' }}>
                  <a href={fileUrl(f)} target="_blank" rel="noopener noreferrer" style={{ flex: 1, fontSize: '12px', fontWeight: 600, color: '#60a5fa', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.file_name}
                  </a>
                  <button onClick={() => deleteCardFile(f)} title="Delete file" style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '12px', fontWeight: 700 }}>✕</button>
                </div>
              ))}
            </div>
            <DropZone onFiles={uploadCardFiles} multiple>
              <label style={{ display: 'block', border: `1px dashed ${theme.border}`, borderRadius: '8px', padding: '12px', textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)', cursor: 'pointer', marginBottom: '14px' }}>
                {cardBusy ? 'Uploading…' : 'Drop proof files here or tap to browse'}
                <input
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={e => {
                    const files = Array.from(e.target.files || []);
                    if (files.length > 0) uploadCardFiles(files);
                    e.target.value = '';
                  }}
                />
              </label>
            </DropZone>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <button onClick={convertCardToJob} disabled={cardBusy} style={{
                padding: '9px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 800,
                background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.35)', cursor: 'pointer',
              }}>
                {cardBusy ? 'Working…' : '→ Create Graphics Job'}
              </button>
              <button onClick={() => setCardEvent(null)} style={{ padding: '9px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--subtle-bg)', color: 'var(--text-muted)', border: `1px solid ${theme.border}`, cursor: 'pointer' }}>Close</button>
            </div>
          </div>
        </div>
      )}

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

      <UploadProgressBar progress={uploadProgress} />
    </div>
  );
}
