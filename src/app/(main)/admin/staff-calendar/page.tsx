'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useAuth, useRequireFeature } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import {
  dayCapacity, rosterCovers, isoWeekday,
  STAFF_DEPARTMENTS, STAFF_DEPARTMENT_LABEL,
  type ShopStaff, type StaffTimeOff, type StaffDepartment,
} from '@/lib/shop-staff';

/**
 * Staff calendar (migration 442): who does the work, by department, and
 * the days they'll be out. Everyone on the roster is assumed to work their
 * normal hours unless marked out here. Shop Week's upfit capacity comes
 * from this once anyone is on the upfit roster.
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const shiftMonth = (first: string, n: number) => {
  const [y, m] = first.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
};

interface Draft {
  id?: string;
  name: string;
  department: StaffDepartment;
  hoursPerDay: string;
  workDays: number[];
}
const emptyDraft = (department: StaffDepartment = 'upfit'): Draft => ({ name: '', department, hoursPerDay: '8', workDays: [1, 2, 3, 4, 5] });

const btn = (primary = false): React.CSSProperties => ({
  padding: '6px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
  background: primary ? '#3b82f6' : 'var(--subtle-bg)', color: primary ? '#fff' : 'var(--text-muted)',
  border: primary ? 'none' : '1px solid var(--border)',
});
const input: React.CSSProperties = {
  padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg, var(--card))',
  color: 'var(--text-primary)', fontSize: '16px',
};

export default function StaffCalendarPage() {
  const { isAdmin } = useAuth();
  useRequireFeature('schedule');
  const dialog = useDialog();

  const today = ymd(new Date());
  const [month, setMonth] = useState(monthStart(today));
  const [staff, setStaff] = useState<ShopStaff[]>([]);
  const [timeOff, setTimeOff] = useState<StaffTimeOff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickedDay, setPickedDay] = useState<string | null>(null);

  // The grid runs Monday-to-Sunday weeks covering the whole month.
  const gridStart = useMemo(() => addDays(month, -(isoWeekday(month) - 1)), [month]);
  const gridEnd = useMemo(() => {
    const last = addDays(shiftMonth(month, 1), -1);
    return addDays(last, 8 - isoWeekday(last)); // exclusive
  }, [month]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/shop-staff?start=${gridStart}&end=${gridEnd}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setStaff(body.staff || []);
      setTimeOff(body.timeOff || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    }
    setLoading(false);
  }, [gridStart, gridEnd]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const post = async (payload: any): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/admin/shop-staff', { method: 'POST', body: JSON.stringify(payload) });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      await load();
      return true;
    } catch (e: any) {
      await dialog.alert(`Couldn't save: ${e?.message || 'unknown error'}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    const hours = Number(draft.hoursPerDay);
    if (!draft.name.trim()) { await dialog.alert('Enter a name.'); return; }
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) { await dialog.alert('Hours per day must be between 0 and 24.'); return; }
    const ok = await post({
      action: 'save_staff', id: draft.id, name: draft.name.trim(), department: draft.department,
      hoursPerDay: hours, workDays: draft.workDays,
    });
    if (ok) setDraft(null);
  };

  const removePerson = async (s: ShopStaff) => {
    if (!await dialog.confirm(`Remove ${s.name} from the staff calendar? Their marked days off go too.`, { destructive: true, confirmLabel: 'Remove' })) return;
    await post({ action: 'remove_staff', id: s.id });
  };

  const setOff = async (s: ShopStaff, day: string, mode: 'working' | 'full' | 'part', current?: StaffTimeOff) => {
    if (mode === 'working') { await post({ action: 'clear_off', staffId: s.id, day }); return; }
    if (mode === 'full') { await post({ action: 'set_off', staffId: s.id, day, hours: null, note: current?.note || undefined }); return; }
    const raw = await dialog.prompt(`How many hours will ${s.name} miss?`, current?.hours != null ? String(current.hours) : '4', { confirmLabel: 'Save' });
    if (raw == null) return;
    const h = Number(raw);
    if (!Number.isFinite(h) || h <= 0 || h > 24) { await dialog.alert('Enter hours between 0 and 24.'); return; }
    await post({ action: 'set_off', staffId: s.id, day, hours: h, note: current?.note || undefined });
  };

  const editNote = async (s: ShopStaff, day: string, current: StaffTimeOff) => {
    const note = await dialog.prompt(`Note for ${s.name}'s time off (optional)`, current.note || '', { confirmLabel: 'Save', placeholder: 'Vacation, doctor…' });
    if (note == null) return;
    await post({ action: 'set_off', staffId: s.id, day, hours: current.hours, note: note.trim() || undefined });
  };

  if (!isAdmin) {
    return <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '20px 0' }}>The staff calendar is for admins.</div>;
  }

  const hasGraphics = rosterCovers(staff, 'graphics_install');
  const days: string[] = [];
  for (let d = gridStart; d < gridEnd; d = addDays(d, 1)) days.push(d);
  const monthLabel = new Date(month + 'T12:00:00').toLocaleDateString([], { month: 'long', year: 'numeric' });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Staff Calendar</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', maxWidth: '560px' }}>
            Everyone listed is assumed to work their normal hours. Mark the days someone will be out, and
            Shop Week uses what&apos;s left as each day&apos;s capacity.
          </div>
        </div>
        <Link href="/admin/shop-week" style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: '8px' }}>Shop Week →</Link>
      </div>

      {error && <div style={{ fontSize: '12px', color: '#ef4444', marginBottom: '10px' }}>{error}</div>}

      {/* Roster */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '12px', marginBottom: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>Who works</div>
          {!draft && <button onClick={() => setDraft(emptyDraft())} style={btn(true)}>+ Add person</button>}
        </div>

        {draft && (
          <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '10px', marginBottom: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>
              Name
              <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} style={{ ...input, width: '180px' }} autoFocus />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>
              Department
              <select value={draft.department} onChange={e => setDraft({ ...draft, department: e.target.value as StaffDepartment })} style={input}>
                {STAFF_DEPARTMENTS.map(d => <option key={d} value={d}>{STAFF_DEPARTMENT_LABEL[d]}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>
              Hours per day
              <input type="number" min={0} max={24} step={0.5} value={draft.hoursPerDay} onChange={e => setDraft({ ...draft, hoursPerDay: e.target.value })} style={{ ...input, width: '80px' }} />
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>
              Work days
              <div style={{ display: 'flex', gap: '3px' }}>
                {WEEKDAYS.map((w, i) => {
                  const iso = i + 1;
                  const on = draft.workDays.includes(iso);
                  return (
                    <button key={w} type="button" onClick={() => setDraft({ ...draft, workDays: on ? draft.workDays.filter(n => n !== iso) : [...draft.workDays, iso].sort() })} style={{
                      padding: '6px 7px', borderRadius: '5px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                      background: on ? 'rgba(59,130,246,0.15)' : 'transparent', color: on ? '#60a5fa' : 'var(--text-muted)',
                      border: `1px solid ${on ? 'rgba(59,130,246,0.4)' : 'var(--border)'}`,
                    }}>{w}</button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={saveDraft} disabled={saving} style={{ ...btn(true), opacity: saving ? 0.5 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
              <button onClick={() => setDraft(null)} style={btn()}>Cancel</button>
            </div>
          </div>
        )}

        {loading && staff.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>}
        {!loading && staff.length === 0 && !draft && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Nobody yet. Add each person who works in the upfit shop or installs graphics.</div>
        )}
        {STAFF_DEPARTMENTS.map(dept => {
          const people = staff.filter(s => s.department === dept);
          if (people.length === 0) return null;
          const total = people.filter(s => s.active).reduce((n, s) => n + s.hours_per_day * s.work_days.length, 0);
          return (
            <div key={dept} style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--text-label)', textTransform: 'uppercase', margin: '6px 0 4px' }}>
                {STAFF_DEPARTMENT_LABEL[dept]} · {people.length} {people.length === 1 ? 'person' : 'people'} · {Math.round(total * 10) / 10}h a normal week
              </div>
              {people.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 0', borderTop: '1px solid var(--border)', fontSize: '12px', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)', minWidth: '140px' }}>{s.name}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{s.hours_per_day}h · {s.work_days.map(n => WEEKDAYS[n - 1]).join(' ')}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
                    <button onClick={() => setDraft({ id: s.id, name: s.name, department: s.department, hoursPerDay: String(s.hours_per_day), workDays: s.work_days })} style={btn()}>Edit</button>
                    <button onClick={() => removePerson(s)} style={{ ...btn(), color: '#ef4444' }}>Remove</button>
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Month calendar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{monthLabel}</div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button onClick={() => setMonth(shiftMonth(month, -1))} style={btn()}>‹</button>
          <button onClick={() => setMonth(monthStart(today))} style={btn()}>This month</button>
          <button onClick={() => setMonth(shiftMonth(month, 1))} style={btn()}>›</button>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(92px, 1fr))', gap: '4px', minWidth: '660px' }}>
          {WEEKDAYS.map(w => <div key={w} style={{ fontSize: '10px', fontWeight: 800, color: 'var(--text-label)', textAlign: 'center' }}>{w}</div>)}
          {days.map(day => {
            const cap = dayCapacity(staff, timeOff, day);
            const inMonth = day.slice(0, 7) === month.slice(0, 7);
            const picked = pickedDay === day;
            return (
              <button key={day} onClick={() => setPickedDay(picked ? null : day)} style={{
                textAlign: 'left', minHeight: '78px', padding: '6px', borderRadius: '8px', cursor: 'pointer',
                background: picked ? 'rgba(59,130,246,0.08)' : 'var(--card)',
                border: `1px solid ${picked ? 'rgba(59,130,246,0.5)' : day === today ? 'rgba(59,130,246,0.25)' : 'var(--border)'}`,
                opacity: inMonth ? 1 : 0.45, color: 'var(--text-primary)',
              }}>
                <div style={{ fontSize: '11px', fontWeight: 800, color: day === today ? '#3b82f6' : 'var(--text-primary)' }}>{Number(day.slice(8))}</div>
                {staff.length > 0 && (
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    Upfit {cap.hours.upfit}h{hasGraphics ? ` · Gfx ${cap.hours.graphics_install}h` : ''}
                  </div>
                )}
                {cap.out.map(o => (
                  <div key={o.staffId} style={{ fontSize: '9px', fontWeight: 700, color: '#f59e0b', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {o.name}{o.fullDay ? ' out' : ` −${o.hours}h`}
                  </div>
                ))}
              </button>
            );
          })}
        </div>
      </div>

      {/* Day editor */}
      {pickedDay && (() => {
        const wd = isoWeekday(pickedDay);
        const scheduled = staff.filter(s => s.active && s.work_days.includes(wd));
        const label = new Date(pickedDay + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
        return (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '12px', marginTop: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{label}</div>
              <button onClick={() => setPickedDay(null)} style={btn()}>Close</button>
            </div>
            {scheduled.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Nobody on the roster normally works this day.</div>}
            {scheduled.map(s => {
              const off = timeOff.find(t => t.staff_id === s.id && t.day === pickedDay);
              const mode: 'working' | 'full' | 'part' = !off ? 'working' : off.hours == null ? 'full' : 'part';
              return (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', minWidth: '140px' }}>{s.name}</span>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', minWidth: '90px' }}>{STAFF_DEPARTMENT_LABEL[s.department]}</span>
                  <select value={mode} disabled={saving} onChange={e => setOff(s, pickedDay, e.target.value as any, off)} style={input}>
                    <option value="working">Working ({s.hours_per_day}h)</option>
                    <option value="full">Out all day</option>
                    <option value="part">{mode === 'part' && off ? `Out ${off.hours}h` : 'Out part of the day'}</option>
                  </select>
                  {off && (
                    <button onClick={() => editNote(s, pickedDay, off)} style={btn()}>{off.note ? `Note: ${off.note}` : 'Add note'}</button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}
