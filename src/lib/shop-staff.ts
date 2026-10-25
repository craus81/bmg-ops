import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Staff calendar (migration 442, owner decision 2026-10-25): capacity is
 * who's working, by department. Everyone on the roster works their normal
 * hours on their work days unless a time-off row says they're out.
 *
 * The math is pure so Shop Week, the calendar page and (later) the
 * drop-off booking warning all agree on a day's hours.
 */

export type StaffDepartment = 'upfit' | 'graphics_install';

export const STAFF_DEPARTMENTS: StaffDepartment[] = ['upfit', 'graphics_install'];

export const STAFF_DEPARTMENT_LABEL: Record<StaffDepartment, string> = {
  upfit: 'Upfit shop',
  graphics_install: 'Graphics install',
};

export interface ShopStaff {
  id: string;
  name: string;
  department: StaffDepartment;
  hours_per_day: number;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  work_days: number[];
  active: boolean;
}

export interface StaffTimeOff {
  id: string;
  staff_id: string;
  day: string; // YYYY-MM-DD
  /** Hours missed; null = the whole day. */
  hours: number | null;
  note: string | null;
}

export interface DayCapacity {
  day: string;
  hours: Record<StaffDepartment, number>;
  /** People scheduled that day who are out, with the hours they miss. */
  out: { staffId: string; name: string; department: StaffDepartment; hours: number; fullDay: boolean; note: string | null }[];
}

export const isoWeekday = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** One day's working hours per department, minus time off. Inactive people
 *  and people not scheduled that weekday contribute nothing (and aren't
 *  listed as out — they weren't expected). */
export function dayCapacity(staff: ShopStaff[], timeOff: StaffTimeOff[], day: string): DayCapacity {
  const wd = isoWeekday(day);
  const offByStaff = new Map(timeOff.filter(t => t.day === day).map(t => [t.staff_id, t]));
  const hours: Record<StaffDepartment, number> = { upfit: 0, graphics_install: 0 };
  const out: DayCapacity['out'] = [];
  for (const s of staff) {
    if (!s.active || !s.work_days.includes(wd)) continue;
    const normal = Number(s.hours_per_day) || 0;
    const off = offByStaff.get(s.id);
    const missed = off ? Math.min(normal, off.hours == null ? normal : Number(off.hours)) : 0;
    hours[s.department] += normal - missed;
    if (off) out.push({ staffId: s.id, name: s.name, department: s.department, hours: round1(missed), fullDay: missed >= normal, note: off.note });
  }
  return { day, hours: { upfit: round1(hours.upfit), graphics_install: round1(hours.graphics_install) }, out };
}

/** True when the roster can stand in for crew size × shift hours for a
 *  department — at least one active person in it. */
export function rosterCovers(staff: ShopStaff[], department: StaffDepartment): boolean {
  return staff.some(s => s.active && s.department === department);
}

/** Clamp stored rows into the shape the math trusts. */
export function normalizeStaff(row: any): ShopStaff {
  const days = Array.isArray(row.work_days)
    ? [...new Set(row.work_days.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 7))].sort() as number[]
    : [1, 2, 3, 4, 5];
  return {
    id: row.id,
    name: String(row.name || '').trim(),
    department: row.department === 'graphics_install' ? 'graphics_install' : 'upfit',
    hours_per_day: Number(row.hours_per_day) || 0,
    work_days: days,
    active: row.active !== false,
  };
}

export async function loadStaffCalendar(
  service: SupabaseClient,
  start: string,
  endExclusive: string,
): Promise<{ staff: ShopStaff[]; timeOff: StaffTimeOff[] }> {
  const [staffRes, offRes] = await Promise.all([
    service.from('shop_staff')
      .select('id, name, department, hours_per_day, work_days, active')
      .order('department').order('name').order('id'),
    service.from('staff_time_off')
      .select('id, staff_id, day, hours, note')
      .gte('day', start).lt('day', endExclusive)
      .order('day').order('id'),
  ]);
  if (staffRes.error) throw new Error(staffRes.error.message);
  if (offRes.error) throw new Error(offRes.error.message);
  return {
    staff: (staffRes.data || []).map(normalizeStaff),
    timeOff: (offRes.data || []).map((t: any) => ({
      id: t.id,
      staff_id: t.staff_id,
      day: String(t.day).slice(0, 10),
      hours: t.hours == null ? null : Number(t.hours),
      note: t.note || null,
    })),
  };
}
