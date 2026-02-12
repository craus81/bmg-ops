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
