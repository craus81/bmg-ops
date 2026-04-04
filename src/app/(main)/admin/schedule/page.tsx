'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface Installer { id: string; full_name: string; company_name: string; }
interface Location { id: string; name: string; }
interface CatalogItem { id: string; part_number: string; customer: string; end_customer: string; vehicle_type: string; graphic_package: string; }
interface ScheduleEntry {
  id: string; installer_id: string; scheduled_date: string; catalog_id: string;
  quantity: number; location_id: string | null; notes: string | null; status: string;
  part_number?: string; customer?: string; end_customer?: string;
  vehicle_type?: string; graphic_package?: string; location_name?: string;
}
interface GraphicsInstall {
  id: string; title: string; job_number: string; customer: string | null;
  part_number: string | null; quantity: number; scheduled_install_date: string;
  status: string; ship_to: string | null;
}

export default function SchedulePage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();

  const [view, setView] = useState<'week' | 'month'>('week');
  const [currentDate, setCurrentDate] = useState(() => {
    const d = new Date(); const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
  });
  const [installers, setInstallers] = useState<Installer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [graphicsInstalls, setGraphicsInstalls] = useState<GraphicsInstall[]>([]);
  const [loading, setLoading] = useState(true);

  // Create state
  const [showCreate, setShowCreate] = useState(false);
  const [cInstaller, setCInstaller] = useState('');
  const [cDate, setCDate] = useState('');
  const [cCatalog, setCCatalog] = useState('');
  const [cQty, setCQty] = useState(1);
  const [cLoc, setCLoc] = useState('');
  const [cNotes, setCNotes] = useState('');
  const [catSearch, setCatSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newLocName, setNewLocName] = useState('');
  const [showNewLoc, setShowNewLoc] = useState(false);

  // Edit state
  const [editing, setEditing] = useState<ScheduleEntry | null>(null);
  const [eDate, setEDate] = useState('');
  const [eInstaller, setEInstaller] = useState('');
  const [eQty, setEQty] = useState(1);
  const [eLoc, setELoc] = useState('');
  const [eNotes, setENotes] = useState('');
  const [eStatus, setEStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!isAdmin) { router.push('/home'); return; } loadData(); }, [isAdmin]);
  useEffect(() => { if (catalogItems.length > 0) loadEntries(); }, [currentDate, view, catalogItems, locations]);

  const loadData = async () => {
    const { data: profiles } = await supabase.from('profiles').select('id, full_name, company_id').eq('status', 'approved').order('full_name');
    const { data: companies } = await supabase.from('companies').select('*');
    setInstallers((profiles || []).map((p: any) => {
      const co = (companies || []).find((c: any) => c.id === p.company_id);
      return { id: p.id, full_name: p.full_name || 'Unknown', company_name: co?.name || 'Unassigned' };
    }));
    const { data: locs } = await supabase.from('locations').select('*').order('name');
    setLocations(locs || []);
    const { data: cat } = await supabase.from('catalog').select('id, part_number, customer, end_customer, vehicle_type, graphic_package').eq('active', true).order('end_customer');
    setCatalogItems(cat || []);
    setLoading(false);
  };

  const loadEntries = async () => {
    const { start, end } = getDateRange();
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];
    const { data } = await supabase.from('schedule_entries').select('*').gte('scheduled_date', startStr).lte('scheduled_date', endStr);
    if (!data) { setEntries([]); } else {
      setEntries(data.map((e: any) => {
        const cat = catalogItems.find((c) => c.id === e.catalog_id);
        const loc = locations.find((l) => l.id === e.location_id);
        return { ...e, part_number: cat?.part_number, customer: cat?.customer, end_customer: cat?.end_customer, vehicle_type: cat?.vehicle_type, graphic_package: cat?.graphic_package, location_name: loc?.name };
      }));
    }
    // Load graphics jobs with install dates in this range
    const { data: gfx } = await supabase
      .from('graphics_jobs')
      .select('id, title, job_number, customer, part_number, quantity, scheduled_install_date, status, ship_to')
      .not('scheduled_install_date', 'is', null)
      .neq('status', 'cancelled')
      .gte('scheduled_install_date', startStr)
      .lte('scheduled_install_date', endStr);
    setGraphicsInstalls((gfx || []) as GraphicsInstall[]);
  };

  const getDateRange = () => {
    if (view === 'week') { const s = new Date(currentDate); const e = new Date(currentDate); e.setDate(e.getDate() + 4); return { start: s, end: e }; }
    return { start: new Date(currentDate.getFullYear(), currentDate.getMonth(), 1), end: new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0) };
  };

  const weekDays = useMemo(() => { const d: Date[] = []; for (let i = 0; i < 5; i++) { const x = new Date(currentDate); x.setDate(x.getDate() + i); d.push(x); } return d; }, [currentDate]);
  const monthDays = useMemo(() => {
    const y = currentDate.getFullYear(), m = currentDate.getMonth();
    const f = new Date(y, m, 1), l = new Date(y, m + 1, 0), off = (f.getDay() + 6) % 7;
    const d: (Date | null)[] = []; for (let i = 0; i < off; i++) d.push(null);
    for (let i = 1; i <= l.getDate(); i++) d.push(new Date(y, m, i)); return d;
  }, [currentDate]);

  const navWeek = (dir: number) => setCurrentDate(p => { const d = new Date(p); d.setDate(d.getDate() + dir * 7); return d; });
  const navMonth = (dir: number) => setCurrentDate(p => { const d = new Date(p); d.setMonth(d.getMonth() + dir); d.setDate(1); return d; });
  const goToday = () => { const d = new Date(); if (view === 'week') { const day = d.getDay(); d.setDate(d.getDate() - day + (day === 0 ? -6 : 1)); setCurrentDate(new Date(d)); } else setCurrentDate(new Date(d.getFullYear(), d.getMonth(), 1)); };

  const ds = (d: Date) => d.toISOString().split('T')[0];
  const isToday = (d: Date) => ds(d) === ds(new Date());
  const getEnt = (iid: string, date: string) => entries.filter(e => e.installer_id === iid && e.scheduled_date === date);
  const getGfx = (date: string) => graphicsInstalls.filter(g => g.scheduled_install_date === date);

  const openCreate = (iid: string, date: string) => { setCInstaller(iid); setCDate(date); setCCatalog(''); setCQty(1); setCLoc(locations.length > 0 ? locations[0].id : ''); setCNotes(''); setCatSearch(''); setShowCreate(true); setShowNewLoc(false); };

  const addNewLocation = async () => {
    if (!newLocName.trim()) return;
    const { data, error } = await supabase.from('locations').insert({ name: newLocName.trim() }).select().single();
    if (error) { alert('Failed: ' + error.message); return; }
    setLocations(p => [...p, data as Location].sort((a, b) => a.name.localeCompare(b.name)));
    setCLoc((data as Location).id); setNewLocName(''); setShowNewLoc(false);
  };

  const handleCreate = async () => {
    if (!user || !cInstaller || !cDate || !cCatalog) return;
    setCreating(true);
    await supabase.from('schedule_entries').insert({ installer_id: cInstaller, scheduled_date: cDate, catalog_id: cCatalog, quantity: cQty, location_id: cLoc || null, notes: cNotes || null, assigned_by: user.id });
    setShowCreate(false); setCreating(false); await loadEntries();
  };

  const openEdit = (entry: ScheduleEntry) => { setEditing(entry); setEDate(entry.scheduled_date); setEInstaller(entry.installer_id); setEQty(entry.quantity); setELoc(entry.location_id || ''); setENotes(entry.notes || ''); setEStatus(entry.status); };

  const handleSave = async () => {
    if (!editing) return; setSaving(true);
    await supabase.from('schedule_entries').update({ scheduled_date: eDate, installer_id: eInstaller, quantity: eQty, location_id: eLoc || null, notes: eNotes || null, status: eStatus, updated_at: new Date().toISOString() }).eq('id', editing.id);
    setEditing(null); setSaving(false); await loadEntries();
  };

  const handleDelete = async (id: string) => { if (!confirm('Remove?')) return; await supabase.from('schedule_entries').delete().eq('id', id); setEditing(null); await loadEntries(); };

  const filtCat = catalogItems.filter(c => { if (!catSearch) return true; const s = catSearch.toLowerCase(); return c.part_number.toLowerCase().includes(s) || c.end_customer.toLowerCase().includes(s) || c.vehicle_type.toLowerCase().includes(s) || c.customer.toLowerCase().includes(s); });

  const sc: Record<string, { bg: string; color: string; border: string }> = {
    scheduled: { bg: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: 'var(--border)' },
    in_progress: { bg: 'var(--warning-bg)', color: 'var(--warning)', border: 'var(--warning-border)' },
    complete: { bg: 'var(--success-bg)', color: 'var(--success)', border: 'var(--success-border)' },
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  // CREATE MODAL
  if (showCreate) {
    const inst = installers.find(i => i.id === cInstaller);
    return (<div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>Add to Schedule</div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', marginBottom: '12px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{inst?.full_name}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{cDate ? new Date(cDate + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) : ''}</div>
      </div>

      <div style={{ marginBottom: '10px' }}>
        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Part / Job</label>
        <input type="text" value={catSearch} onChange={e => setCatSearch(e.target.value)} placeholder="Search parts, customers..." style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px', marginBottom: '6px' }} />
        <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {filtCat.map(c => (<button key={c.id} onClick={() => { setCCatalog(c.id); setCatSearch(c.part_number + ' - ' + c.end_customer); }} style={{ width: '100%', padding: '10px', borderRadius: '8px', textAlign: 'left', border: cCatalog === c.id ? '2px solid var(--success)' : '1px solid var(--border)', background: cCatalog === c.id ? 'var(--success-bg)' : 'var(--card)', fontSize: '12px', color: 'var(--text-primary)' }}>
            <div style={{ fontWeight: 700 }}>{c.part_number} — {c.end_customer}</div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{c.vehicle_type} • {c.graphic_package}</div>
          </button>))}
        </div>
      </div>

      <div style={{ marginBottom: '10px' }}>
        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Quantity (vehicles)</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button onClick={() => setCQty(Math.max(1, cQty - 1))} style={{ width: '40px', height: '40px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>−</button>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)', minWidth: '40px', textAlign: 'center' }}>{cQty}</div>
          <button onClick={() => setCQty(cQty + 1)} style={{ width: '40px', height: '40px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>+</button>
        </div>
      </div>

      <div style={{ marginBottom: '10px' }}>
        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Location</label>
        <select value={cLoc} onChange={e => { if (e.target.value === '__new__') { setShowNewLoc(true); } else { setCLoc(e.target.value); setShowNewLoc(false); } }} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px' }}>
          <option value="">No location</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          <option value="__new__">+ Add New Location</option>
        </select>
        {showNewLoc && (<div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
          <input type="text" value={newLocName} onChange={e => setNewLocName(e.target.value)} placeholder="Location name..." style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px' }} onKeyDown={e => { if (e.key === 'Enter') addNewLocation(); }} />
          <button onClick={addNewLocation} disabled={!newLocName.trim()} style={{ padding: '10px 16px', borderRadius: '10px', background: 'var(--navy)', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none', opacity: !newLocName.trim() ? 0.4 : 1 }}>Add</button>
        </div>)}
      </div>

      <div style={{ marginBottom: '14px' }}>
        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Notes</label>
        <textarea value={cNotes} onChange={e => setCNotes(e.target.value)} placeholder="Special instructions..." rows={2} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical' }} />
      </div>

      <button onClick={handleCreate} disabled={creating || !cCatalog} style={{ width: '100%', padding: '14px', borderRadius: '14px', background: 'var(--navy)', color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none', opacity: creating || !cCatalog ? 0.4 : 1, marginBottom: '8px' }}>{creating ? 'Adding...' : 'Add to Schedule'}</button>
      <button onClick={() => setShowCreate(false)} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>← Cancel</button>
    </div>);
  }

  // EDIT MODAL
  if (editing) {
    return (<div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>Edit Entry</div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', marginBottom: '12px' }}>
        <div style={{ fontWeight: 700, fontSize: '14px' }}>{editing.end_customer} — {editing.vehicle_type}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{editing.part_number} • {editing.graphic_package}</div>
      </div>

      <div style={{ marginBottom: '10px' }}>
        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Date</label>
        <input type="date" value={eDate} onChange={e => setEDate(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px' }} />
      </div>

      <div style={{ marginBottom: '10px' }}>
        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Installer</label>
        <select value={eInstaller} onChange={e => setEInstaller(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px' }}>
          {installers.map(i => <option key={i.id} value={i.id}>{i.full_name} ({i.company_name})</option>)}
        </select>
      </div>

      <div style={{ marginBottom: '10px' }}>
        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Quantity</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button onClick={() => setEQty(Math.max(1, eQty - 1))} style={{ width: '40px', height: '40px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>−</button>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)', minWidth: '40px', textAlign: 'center' }}>{eQty}</div>
          <button onClick={() => setEQty(eQty + 1)} style={{ width: '40px', height: '40px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>+</button>
        </div>
      </div>

      <div style={{ marginBottom: '10px' }}>
        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Location</label>
        <select value={eLoc} onChange={e => setELoc(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px' }}>
          <option value="">No location</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      <div style={{ marginBottom: '10px' }}>
        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Status</label>
        <div style={{ display: 'flex', gap: '6px' }}>
          {(['scheduled', 'in_progress', 'complete'] as const).map(s => {
            const colors = sc[s] || sc.scheduled;
            return (<button key={s} onClick={() => setEStatus(s)} style={{ flex: 1, padding: '8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: eStatus === s ? colors.bg : 'transparent', border: `1px solid ${eStatus === s ? colors.border : 'var(--border)'}`, color: eStatus === s ? colors.color : 'var(--text-muted)' }}>
              {s === 'scheduled' ? '📅' : s === 'in_progress' ? '🔧' : '✅'} {s.replace('_', ' ')}
            </button>);
          })}
        </div>
      </div>

      <div style={{ marginBottom: '14px' }}>
        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Notes</label>
        <textarea value={eNotes} onChange={e => setENotes(e.target.value)} placeholder="Special instructions..." rows={2} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical' }} />
      </div>

      <button onClick={handleSave} disabled={saving} style={{ width: '100%', padding: '14px', borderRadius: '14px', background: 'var(--navy)', color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none', opacity: saving ? 0.5 : 1, marginBottom: '8px' }}>{saving ? 'Saving...' : 'Save Changes'}</button>
      <button onClick={() => handleDelete(editing.id)} style={{ width: '100%', padding: '10px', borderRadius: '10px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>Remove Entry</button>
      <button onClick={() => setEditing(null)} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>← Cancel</button>
    </div>);
  }

  // MAIN CALENDAR
  return (<div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Schedule</div>
      <div style={{ display: 'flex', gap: '4px' }}>
        <button onClick={() => setView('week')} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: view === 'week' ? 'var(--tab-active-bg)' : 'transparent', border: view === 'week' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)', color: view === 'week' ? 'var(--tab-active-color)' : 'var(--text-muted)' }}>Week</button>
        <button onClick={() => setView('month')} style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: view === 'month' ? 'var(--tab-active-bg)' : 'transparent', border: view === 'month' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)', color: view === 'month' ? 'var(--tab-active-color)' : 'var(--text-muted)' }}>Month</button>
      </div>
    </div>

    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', gap: '8px' }}>
      <button onClick={() => view === 'week' ? navWeek(-1) : navMonth(-1)} style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '16px' }}>‹</button>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 800, fontSize: '15px', color: 'var(--text-primary)' }}>
          {view === 'week' ? `${weekDays[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} — ${weekDays[4].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : currentDate.toLocaleDateString([], { month: 'long', year: 'numeric' })}
        </div>
        <button onClick={goToday} style={{ fontSize: '10px', fontWeight: 700, color: 'var(--navy)', background: 'transparent', border: 'none', padding: '2px 0', textDecoration: 'underline' }}>Today</button>
      </div>
      <button onClick={() => view === 'week' ? navWeek(1) : navMonth(1)} style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '16px' }}>›</button>
    </div>

    {/* WEEK VIEW */}
    {view === 'week' && (<div style={{ overflowX: 'auto' }}>
      {installers.map(installer => (
        <div key={installer.id} style={{ marginBottom: '14px' }}>
          <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', padding: '6px 0', borderBottom: '1px solid var(--border)', marginBottom: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{installer.full_name}</span>
            <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)' }}>{installer.company_name}</span>
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            {weekDays.map(day => {
              const d = ds(day); const dayEntries = getEnt(installer.id, d); const today = isToday(day);
              return (<div key={d} style={{ flex: 1, minWidth: '60px', borderRadius: '10px', padding: '6px', background: today ? 'rgba(30,74,94,0.08)' : 'var(--card)', border: `1px solid ${today ? 'rgba(30,74,94,0.25)' : 'var(--border)'}` }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: today ? 'var(--navy)' : 'var(--text-muted)', textTransform: 'uppercase', textAlign: 'center', marginBottom: '4px' }}>{day.toLocaleDateString([], { weekday: 'short' })} {day.getDate()}</div>
                {dayEntries.map(e => {
                  const colors = sc[e.status] || sc.scheduled;
                  return (<button key={e.id} onClick={() => openEdit(e)} style={{ width: '100%', padding: '4px 6px', borderRadius: '6px', marginBottom: '3px', background: colors.bg, border: `1px solid ${colors.border}`, textAlign: 'left', fontSize: '9px', fontWeight: 700, color: colors.color, lineHeight: '1.3' }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.end_customer || e.part_number || 'Job'}</div>
                    <div style={{ fontSize: '8px', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.vehicle_type}{e.quantity > 1 ? ` ×${e.quantity}` : ''}</div>
                  </button>);
                })}
                <button onClick={() => openCreate(installer.id, d)} style={{ width: '100%', padding: '4px', borderRadius: '6px', marginTop: '2px', border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '12px', fontWeight: 700 }}>+</button>
              </div>);
            })}
          </div>
        </div>
      ))}

      {/* Graphics Install Dates */}
      {graphicsInstalls.length > 0 && (
        <div style={{ marginBottom: '14px' }}>
          <div style={{ fontSize: '12px', fontWeight: 800, color: '#f97316', padding: '6px 0', borderBottom: '1px solid var(--border)', marginBottom: '6px' }}>
            Graphics Installs
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            {weekDays.map(day => {
              const d = ds(day); const dayGfx = getGfx(d); const today = isToday(day);
              return (<div key={`gfx-${d}`} style={{ flex: 1, minWidth: '60px', borderRadius: '10px', padding: '6px', background: today ? 'rgba(30,74,94,0.08)' : 'var(--card)', border: `1px solid ${today ? 'rgba(30,74,94,0.25)' : 'var(--border)'}` }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: today ? 'var(--navy)' : 'var(--text-muted)', textTransform: 'uppercase', textAlign: 'center', marginBottom: '4px' }}>{day.toLocaleDateString([], { weekday: 'short' })} {day.getDate()}</div>
                {dayGfx.map(g => (
                  <div key={g.id} style={{ width: '100%', padding: '4px 6px', borderRadius: '6px', marginBottom: '3px', background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.25)', textAlign: 'left', fontSize: '9px', fontWeight: 700, color: '#f97316', lineHeight: '1.3' }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</div>
                    <div style={{ fontSize: '8px', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.customer}{g.quantity > 1 ? ` ×${g.quantity}` : ''}</div>
                  </div>
                ))}
              </div>);
            })}
          </div>
        </div>
      )}
    </div>)}

    {/* MONTH VIEW */}
    {view === 'month' && (<div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '4px' }}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (<div key={d} style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textAlign: 'center', padding: '4px' }}>{d}</div>))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
        {monthDays.map((day, i) => {
          if (!day) return <div key={`e-${i}`} />;
          const d = ds(day); const today = isToday(day);
          const dayEntries = entries.filter(e => e.scheduled_date === d);
          const dayGfx = getGfx(d);
          const totalItems = dayEntries.length + dayGfx.length;
          return (<div key={d} style={{ minHeight: '60px', borderRadius: '6px', padding: '4px', background: today ? 'rgba(30,74,94,0.08)' : 'var(--card)', border: `1px solid ${today ? 'rgba(30,74,94,0.25)' : 'var(--border)'}` }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: today ? 'var(--navy)' : 'var(--text-muted)', marginBottom: '2px' }}>{day.getDate()}</div>
            {dayEntries.slice(0, 3).map(e => {
              const inst = installers.find(ii => ii.id === e.installer_id);
              const colors = sc[e.status] || sc.scheduled;
              return (<button key={e.id} onClick={() => openEdit(e)} style={{ width: '100%', padding: '2px 3px', borderRadius: '4px', marginBottom: '1px', background: colors.bg, border: 'none', textAlign: 'left', fontSize: '7px', fontWeight: 700, color: colors.color, lineHeight: '1.3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {inst?.full_name?.split(' ')[0]}: {e.end_customer || e.part_number}
              </button>);
            })}
            {dayGfx.slice(0, Math.max(0, 3 - dayEntries.length)).map(g => (
              <div key={g.id} style={{ width: '100%', padding: '2px 3px', borderRadius: '4px', marginBottom: '1px', background: 'rgba(249,115,22,0.1)', textAlign: 'left', fontSize: '7px', fontWeight: 700, color: '#f97316', lineHeight: '1.3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {g.title}
              </div>
            ))}
            {totalItems > 3 && <div style={{ fontSize: '7px', color: 'var(--text-muted)', textAlign: 'center' }}>+{totalItems - 3}</div>}
          </div>);
        })}
      </div>
    </div>)}

    <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>← Back</button>
  </div>);
}
