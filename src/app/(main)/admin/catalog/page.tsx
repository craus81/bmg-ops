import { redirect } from 'next/navigation';

// The standalone "Part Catalog" has been unified into the Parts Catalog
// (/parts). Migration 117 already folded this screen's data — graphics
// metadata, prices, and proof images — into netsuite_parts / part_files, so
// there is now ONE catalog. This route is kept only to redirect any lingering
// bookmark or old link to the unified catalog instead of a stale second screen.
export default function CatalogRedirect() {
  redirect('/parts');
}
