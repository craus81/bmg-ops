import { randomBytes } from 'crypto';
import { chicagoDay } from './exec-metrics';

/**
 * Outreach "Pick a time" / "Have <rep> call me" (migration 440). Every
 * Outreach email carries both buttons; the person who got it picks one on
 * /meet/<token>. A booked time is a 20-minute phone call on the rep's
 * FleetSuite schedule (calendar_events, category 'sales').
 *
 * Times are shop time (America/Chicago), stored as the schedule stores
 * them: event_date + event_time, local.
 */

export const MEET_MINUTES = 20;
/** Weekday hours a call can start: 9:00 through 15:40. */
export const MEET_START = '09:00';
export const MEET_END = '16:00';
/** Days shown, from tomorrow on, weekends skipped. */
export const MEET_DAYS = 8;

const TOKEN_RE = /^[a-f0-9]{40}$/;
export const isMeetToken = (t: string): boolean => TOKEN_RE.test(t);
export const mintMeetToken = (): string => randomBytes(20).toString('hex');

const baseUrl = (): string =>
  (process.env.NEXT_PUBLIC_APP_URL || 'https://go.bmgfleet.com').replace(/\/$/, '');

export const meetUrl = (token: string, opts?: { call?: boolean }): string =>
  `${baseUrl()}/meet/${token}${opts?.call ? '?call=1' : ''}`;

export const firstName = (full: string | null | undefined): string =>
  String(full || '').trim().split(/\s+/)[0] || 'us';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The two buttons, under the message and above the signature. */
export function meetButtonsHtml(token: string, repFullName: string | null | undefined): string {
  const who = escapeHtml(firstName(repFullName));
  const btn = (href: string, label: string, solid: boolean) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 16px;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none;${solid ? 'background:#1d4ed8;color:#ffffff;' : 'border:1px solid #1d4ed8;color:#1d4ed8;'}">${label}</a>`;
  return `<div style="margin:4px 0 18px;">${btn(meetUrl(token), 'Pick a time to talk', true)}${btn(meetUrl(token, { call: true }), `Have ${who} call me`, false)}</div>`;
}

export function meetButtonsText(token: string, repFullName: string | null | undefined): string {
  return `\n\nPick a time to talk: ${meetUrl(token)}\nHave ${firstName(repFullName)} call me: ${meetUrl(token, { call: true })}`;
}

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};
const fromMin = (n: number): string => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

export interface BusyBlock { date: string; time: string | null; minutes: number | null }
export interface MeetDay { day: string; times: string[] }

/** YYYY-MM-DD plus n days. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The weekdays a call can be booked on, starting tomorrow (shop time). */
export function meetDays(now: Date = new Date()): string[] {
  const out: string[] = [];
  let day = chicagoDay(now);
  while (out.length < MEET_DAYS) {
    day = addDays(day, 1);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(day);
  }
  return out;
}

/**
 * Open call times per day: every 20 minutes in the window, minus anything
 * that overlaps a timed event already on the rep's schedule. All-day
 * entries (reminders, deadlines) don't block a call.
 */
export function openSlots(days: string[], busy: BusyBlock[]): MeetDay[] {
  const start = toMin(MEET_START);
  const end = toMin(MEET_END);
  return days.map(day => {
    const blocks = busy.filter(b => b.date === day && b.time)
      .map(b => { const s = toMin(b.time!.slice(0, 5)); return [s, s + Math.max(b.minutes || 60, 1)] as const; });
    const times: string[] = [];
    for (let t = start; t + MEET_MINUTES <= end; t += MEET_MINUTES) {
      if (blocks.some(([s, e]) => t < e && t + MEET_MINUTES > s)) continue;
      times.push(fromMin(t));
    }
    return { day, times };
  });
}

/** "2026-10-27" + "09:20" (Chicago) → the UTC instant. */
export function chicagoInstant(day: string, time: string): Date {
  // Try both offsets the shop can be on (CDT -5, CST -6); keep the one that
  // reads back as the same Chicago wall time.
  for (const offset of [5, 6]) {
    const guess = new Date(`${day}T${time}:00Z`);
    guess.setUTCHours(guess.getUTCHours() + offset);
    const wall = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(guess);
    if (wall === time && chicagoDay(guess) === day) return guess;
  }
  const fallback = new Date(`${day}T${time}:00Z`);
  fallback.setUTCHours(fallback.getUTCHours() + 6);
  return fallback;
}

export const fmtTime12 = (t: string): string => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

export const fmtDayLong = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
