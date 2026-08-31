/**
 * Does this line represent graphics work? Shared between the estimate
 * builder's "spawn or link a graphics job" panel and convert-to-SO's
 * blocking gate — the panel alone was only a prompt, so a combined
 * upfit+graphics estimate could still sail to a Sales Order with no
 * graphics job and nobody in production hearing about the work (Stage 2
 * finding, closed in Round 3).
 *
 * `catalog === 'graphics'` only covers part-backed catalog lines — the two
 * MAIN graphics paths never satisfied it:
 *   - Add Graphics (wrap-quote fold) lines have no part row, so catalog
 *     stays undefined after reload; wrap_quote_id (which round-trips
 *     through save) and the fold's two fixed NetSuite item names are the
 *     durable markers.
 *   - Quick Graphics lines are bare customs; they're stamped
 *     catalog:'graphics' at creation and matched after reload by the exact
 *     machine-generated descriptions addQuickGraphicsLines writes.
 */

export interface GraphicsLineShape {
  catalog?: string | null;
  wrap_quote_id?: string | null;
  item_number?: string | null;
  description?: string | null;
}

export const isGraphicsLine = (l: GraphicsLineShape): boolean =>
  l.catalog === 'graphics'
  || !!l.wrap_quote_id
  || l.item_number === '3M Vinyl'
  || l.item_number === 'Graphics Install Labor'
  || /\d+(\.\d+)? sqft @ \$/.test(l.description || '')
  || /^Graphics install labor/i.test(l.description || '');
