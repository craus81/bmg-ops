/**
 * Where an old /quotes (or /admin/quote-followups) URL lands now that the
 * Quotes list lives on the Estimates tab. ?item= keeps the exact row; the
 * Quotes page's status groups map onto the Estimates list's filters
 * ("won" spans two there, so it opens on All).
 */
const STATUS_MAP: Record<string, string> = {
  sent: 'sent',
  working: 'draft',
  lost: 'rejected',
};

export function legacyQuotesTarget(params: { get(name: string): string | null }): string {
  const item = params.get('item');
  if (item && /^(estimate|wrap)-[\w-]+$/.test(item)) return `/estimates?item=${encodeURIComponent(item)}`;
  const status = STATUS_MAP[params.get('status') || ''];
  // A bare /quotes opened on Waiting; keep that.
  if (!params.get('status')) return '/estimates?status=sent';
  return status ? `/estimates?status=${status}` : '/estimates';
}
