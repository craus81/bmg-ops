export function fmtTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

export function fmtClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(date: Date): string {
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Phone formatting ────────────────────────────────────────────────────────

/**
 * Format a US phone number as it's typed: 5551234567 → (555) 123-4567.
 * Deliberately conservative — anything that isn't a plain 10-digit US
 * number passes through untouched so international numbers ("+44…"),
 * extensions ("x204"), and letters survive as entered. Display-only:
 * stored values are whatever the user saw; outbound SMS normalizes to
 * E.164 separately (src/lib/sms-provider).
 */
export function formatPhoneInput(raw: string): string {
  if (!raw) return raw;
  if (/[+a-zA-Z]/.test(raw)) return raw;
  const d = raw.replace(/\D/g, '');
  if (d.length > 10) return raw;
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
