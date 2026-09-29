/**
 * A carrier tracking page for a tracking number the Parts Mail scan pulled
 * from a vendor email. Carrier text from the email wins; otherwise the
 * number's shape decides; anything unrecognised falls back to a web search,
 * which every carrier's number resolves through.
 */
export function trackingUrl(trackingNumber: string, carrier?: string | null): string {
  const n = trackingNumber.replace(/\s+/g, '');
  const c = (carrier || '').toLowerCase();
  const enc = encodeURIComponent(n);
  if (c.includes('ups') || /^1Z[0-9A-Z]{16}$/i.test(n)) return `https://www.ups.com/track?tracknum=${enc}`;
  if (c.includes('fedex') || c.includes('fed ex')) return `https://www.fedex.com/fedextrack/?trknbr=${enc}`;
  if (c.includes('usps') || c.includes('postal') || /^(94|93|92|95)\d{18,20}$/.test(n)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${enc}`;
  if (/^\d{12}$|^\d{15}$/.test(n)) return `https://www.fedex.com/fedextrack/?trknbr=${enc}`;
  return `https://www.google.com/search?q=${encodeURIComponent(`${carrier || ''} tracking ${n}`.trim())}`;
}
