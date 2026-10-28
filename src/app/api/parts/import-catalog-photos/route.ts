import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { r2Upload } from '@/lib/r2';
import { fetchAllRows } from '@/lib/fetch-all';
import { matchCatalogPhotos, BUYERS_PHOTO_DIR, type CatalogEntry, type CatalogPart } from '@/lib/buyers-catalog-photos';
import catalogIndex from '@/lib/buyers-catalog-2024.json';

const BUYERS_CATALOG = catalogIndex as unknown as Record<string, CatalogEntry>;

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const supabase = createServiceClient();

/**
 * Buyers Products 2024 catalog photos → parts catalog (Craig 2026-10-27).
 * 'match' lists every part the catalog has a photo for (no writes);
 * 'save' copies the chosen photos to R2 and stamps image_path. A part that
 * already has a photo is never touched, even if the list was stale.
 */
const Schema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('match') }),
  z.object({
    mode: z.literal('save'),
    items: z.array(z.object({
      partId: z.string().uuid(),
      catalogNumber: z.string().trim().min(1).max(60),
    })).min(1).max(25),
  }),
]);

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  try {
    if (body.mode === 'match') {
      const { data: parts, error } = await fetchAllRows<CatalogPart>((from, to) => supabase
        .from('netsuite_parts')
        .select('id, item_number, is_active, image_path')
        .not('item_number', 'is', null)
        .order('id')
        .range(from, to));
      if (error) throw new Error('Parts read failed: ' + error.message);
      const matches = matchCatalogPhotos(parts, BUYERS_CATALOG);
      return NextResponse.json({
        matches,
        catalogNumbers: Object.keys(BUYERS_CATALOG).length,
        partsSearched: parts.filter(p => p.is_active).length,
      });
    }

    const ids = body.items.map(i => i.partId);
    const { data: rows, error } = await supabase
      .from('netsuite_parts')
      .select('id, item_number, image_path')
      .in('id', ids);
    if (error) throw new Error('Parts read failed: ' + error.message);
    const partById = new Map((rows || []).map(r => [r.id as string, r]));

    const results: { partId: string; ok: boolean; error?: string }[] = [];
    let saved = 0;
    for (const item of body.items) {
      const part = partById.get(item.partId);
      const entry = BUYERS_CATALOG[item.catalogNumber];
      if (!part) { results.push({ partId: item.partId, ok: false, error: 'Part not found' }); continue; }
      if (!entry) { results.push({ partId: item.partId, ok: false, error: `${item.catalogNumber} is not in the Buyers catalog` }); continue; }
      if (part.image_path) { results.push({ partId: item.partId, ok: false, error: 'Already has a photo, left alone' }); continue; }
      try {
        const res = await fetch(`${req.nextUrl.origin}${BUYERS_PHOTO_DIR}/${entry[0]}.jpg`, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`Photo file missing (${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        const path = `parts/${item.partId}/buyers-catalog-${Date.now()}.jpg`;
        const up = await r2Upload('photos', path, buf, 'image/jpeg');
        if (!up.success) throw new Error(up.error || 'Photo upload failed');
        // Only fill a blank: someone may have added a photo since the list loaded.
        const { error: updErr } = await supabase
          .from('netsuite_parts')
          .update({ image_path: path })
          .eq('id', item.partId)
          .is('image_path', null);
        if (updErr) throw new Error(updErr.message);
        saved++;
        results.push({ partId: item.partId, ok: true });
      } catch (err: any) {
        results.push({ partId: item.partId, ok: false, error: err?.message || 'Save failed' });
      }
    }
    return NextResponse.json({ results, saved });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Catalog photo import failed' }, { status: 500 });
  }
}
