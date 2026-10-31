/**
 * "Last sync 2:14 PM" for stock figures read from the netsuite_parts mirror
 * (inventory-sync refreshes it a few times an hour, parts-sync every 2h), so
 * whoever is ordering can tell how old the count is. Craig doesn't fully
 * trust FleetSuite's inventory yet (2026-10-30), so the age is always shown.
 */
export function syncedText(syncedAt: string | null, now: Date = new Date()): string {
  if (!syncedAt) return 'Last sync time unknown';
  const d = new Date(syncedAt);
  if (isNaN(d.getTime())) return 'Last sync time unknown';
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Last sync ${sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`}`;
}
