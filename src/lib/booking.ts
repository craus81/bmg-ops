import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Pickup & drop-off booking (R5-17): settings, token resolution, and the
 * slot grid. Both ends of a shop visit were phone tag — the completion
 * email said "contact us to arrange pickup" and nothing captured when
 * approved work would arrive. Server-only (routes import this; pages get
 * plain JSON).
 *
 * Tokens (E-SIGN hygiene: regex-validated, rate-limited, 404 on miss,
 * never surfaced to staff clients):
 *  - pickup  → fleet_checkins.customer_portal_token — 64-hex, auto-minted
 *    per check-in since migration 001 and unused until now.
 *  - dropoff → estimates.approval_token — the same 30-day link the customer
 *    approved on; booking only opens once the estimate is approved.
 */

export interface BookingSettings {
  enabled: boolean;
  /** ISO weekday numbers accepting bookings (1 = Monday … 7 = Sunday). */
  businessDays: number[];
  startHour: number; // first slot, 24h
  endHour: number; // slots start strictly before this hour
  slotMinutes: number;
  /** Cap on total bookings per day (slot uniqueness caps per-slot at 1). */
  maxPerDay: number;
  /** Earliest bookable day = today + leadDays. */
  leadDays: number;
  /** How far out the grid extends. */
  horizonDays: number;
  blockedDates: string[]; // YYYY-MM-DD
  /** Days after completion before the first automated pickup reminder;
   *  escalation to the sales rep fires at 2× this. */
  nudgeDays: number;
}

export const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  enabled: true,
  businessDays: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 16,
  slotMinutes: 60,
  maxPerDay: 6,
  leadDays: 1,
  horizonDays: 21,
  blockedDates: [],
  nudgeDays: 3,
};

/** Clamp arbitrary stored JSON into a safe settings shape — the page and
 *  slot math trust these bounds. */
export function sanitizeBookingSettings(raw: any): BookingSettings {
  const d = DEFAULT_BOOKING_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  const int = (v: any, min: number, max: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const days = Array.isArray(raw.businessDays)
    ? [...new Set(raw.businessDays.map((v: any) => Number(v)).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 7))].sort() as number[]
    : d.businessDays;
  const startHour = int(raw.startHour, 0, 23, d.startHour);
  return {
    enabled: raw.enabled !== false,
    businessDays: days.length > 0 ? days : d.businessDays,
    startHour,
    endHour: Math.max(startHour + 1, int(raw.endHour, 1, 24, d.endHour)),
    slotMinutes: [30, 60, 90, 120].includes(Number(raw.slotMinutes)) ? Number(raw.slotMinutes) : d.slotMinutes,
    maxPerDay: int(raw.maxPerDay, 1, 50, d.maxPerDay),
    leadDays: int(raw.leadDays, 0, 30, d.leadDays),
    horizonDays: int(raw.horizonDays, 7, 60, d.horizonDays),
    blockedDates: Array.isArray(raw.blockedDates)
      ? raw.blockedDates.filter((s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)).slice(0, 100)
      : [],
    nudgeDays: int(raw.nudgeDays, 1, 30, d.nudgeDays),
  };
}

const SETTINGS_KEY = 'booking_settings';

export async function loadBookingSettings(service: SupabaseClient): Promise<BookingSettings> {
  const { data } = await service.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
  const raw = data?.value != null && typeof data.value === 'string' ? JSON.parse(data.value) : data?.value;
  return sanitizeBookingSettings(raw);
}

export async function saveBookingSettings(service: SupabaseClient, settings: BookingSettings): Promise<void> {
  const { error } = await service.from('app_settings').upsert(
    { key: SETTINGS_KEY, value: settings, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) throw new Error(error.message);
}

// ── Slot grid ────────────────────────────────────────────────────────────

const addDays = (day: string, n: number): string => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const isoWeekday = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
};

export interface DaySlots {
  day: string;
  /** Open start times, 'HH:MM'. */
  times: string[];
}

/**
 * The open slot grid: business days inside [today+leadDays, +horizonDays),
 * minus blocked dates, minus taken slots, minus full days. Pure — the
 * route feeds it today's Chicago date and the active-booking counts.
 * `ignore` lets a reschedule keep its own current slot selectable.
 */
export function generateSlots(
  settings: BookingSettings,
  today: string,
  taken: { slot_date: string; slot_time: string }[],
  ignore?: { slot_date: string; slot_time: string } | null,
): DaySlots[] {
  const takenSet = new Set<string>();
  const dayCounts = new Map<string, number>();
  for (const t of taken) {
    if (ignore && t.slot_date === ignore.slot_date && t.slot_time === ignore.slot_time) continue;
    const hhmm = t.slot_time.slice(0, 5);
    takenSet.add(`${t.slot_date}|${hhmm}`);
    dayCounts.set(t.slot_date, (dayCounts.get(t.slot_date) || 0) + 1);
  }

  const out: DaySlots[] = [];
  const first = addDays(today, settings.leadDays);
  for (let i = 0; i < settings.horizonDays; i++) {
    const day = addDays(first, i);
    if (!settings.businessDays.includes(isoWeekday(day))) continue;
    if (settings.blockedDates.includes(day)) continue;
    if ((dayCounts.get(day) || 0) >= settings.maxPerDay) continue;
    const times: string[] = [];
    for (let mins = settings.startHour * 60; mins < settings.endHour * 60; mins += settings.slotMinutes) {
      const hh = String(Math.floor(mins / 60)).padStart(2, '0');
      const mm = String(mins % 60).padStart(2, '0');
      if (!takenSet.has(`${day}|${hh}:${mm}`)) times.push(`${hh}:${mm}`);
    }
    if (times.length > 0) out.push({ day, times });
  }
  return out;
}

// ── Token resolution ─────────────────────────────────────────────────────

export type BookingTarget =
  | {
      kind: 'pickup';
      checkin: {
        id: string; vin: string | null; customer_name: string | null; customer_id: string | null;
        vehicle_year: string | null; vehicle_make: string | null; vehicle_model: string | null;
        status: string; archived_at: string | null;
      };
    }
  | {
      kind: 'dropoff';
      estimate: {
        id: string; estimate_number: string | null; title: string | null; customer_name: string | null;
        customer_approved: boolean; approval_token_expires_at: string | null; status: string;
      };
    };

/**
 * Resolve a booking token to its record — 64-hex is a check-in's portal
 * token (pickup), a UUID is an estimate's approval token (drop-off).
 * Returns null on any miss; callers 404 without distinguishing why.
 */
export async function resolveBookingToken(service: SupabaseClient, token: string): Promise<BookingTarget | null> {
  if (/^[0-9a-f]{64}$/i.test(token)) {
    const { data } = await service
      .from('fleet_checkins')
      .select('id, vin, customer_name, customer_id, vehicle_year, vehicle_make, vehicle_model, status, archived_at')
      .eq('customer_portal_token', token)
      .maybeSingle();
    return data ? { kind: 'pickup', checkin: data } : null;
  }
  if (/^[0-9a-f-]{36}$/i.test(token)) {
    const { data } = await service
      .from('estimates')
      .select('id, estimate_number, title, customer_name, customer_approved, approval_token_expires_at, status')
      .eq('approval_token', token)
      .maybeSingle();
    return data ? { kind: 'dropoff', estimate: data } : null;
  }
  return null;
}

export const bookingVehicleLabel = (c: { vehicle_year: string | null; vehicle_make: string | null; vehicle_model: string | null; vin: string | null }): string =>
  [c.vehicle_year, c.vehicle_make, c.vehicle_model].filter(Boolean).join(' ')
    || (c.vin ? `VIN ending ${String(c.vin).slice(-8)}` : 'your vehicle');
