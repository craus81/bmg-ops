// Keyword-based detector for "this check-in's order calls for graphics".
//
// Runs in two contexts:
// - server (check-in save): scans line items from any selected
//   NetSuite SO and from the linked estimate's line items
// - client (no DB access): the same `isGraphicsLineItem` is used by
//   the inline prompt to decide whether to show the create-job CTA.
//
// Keyword matching is intentionally broad — false positives are
// surfaced as a dismissable prompt, not auto-actions, so the cost of
// over-flagging is low. Curate later if it gets noisy.

const GRAPHICS_KEYWORDS = ['graphic', 'wrap', 'decal', 'lettering', 'vinyl'];

export type GraphicsCandidate = {
  item_name?: string | null;
  description?: string | null;
  item_number?: string | null;
};

export function isGraphicsLineItem(item: GraphicsCandidate): boolean {
  const text = `${item.item_name ?? ''} ${item.description ?? ''} ${item.item_number ?? ''}`.toLowerCase();
  return GRAPHICS_KEYWORDS.some(kw => text.includes(kw));
}

// Returns the matched item's display text (description preferred, falls
// back to item name/number) for storing in `graphics_signal`. Null if no
// candidate matches.
export function firstGraphicsMatch(items: GraphicsCandidate[]): string | null {
  for (const item of items) {
    if (isGraphicsLineItem(item)) {
      return item.description || item.item_name || item.item_number || 'graphics line item';
    }
  }
  return null;
}
