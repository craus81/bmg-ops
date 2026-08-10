import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { r2Upload } from '@/lib/r2';
import { fetchAllRows } from '@/lib/fetch-all';
import { extractProduct, parseSitemapLocs, matchSkuToPart, skuKeys, looksLikeProductUrl } from '@/lib/vendor-catalog-import';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.discriminatedUnion('mode', [
  // Verify extraction against one live page — no writes.
  z.object({ mode: z.literal('probe'), url: z.string().url().max(1000) }),
  // Walk the site's sitemap(s) and return product-ish URLs for the client
  // to batch through 'run'.
  z.object({ mode: z.literal('discover'), baseUrl: z.string().url().max(300) }),
  // Import a batch of product pages: extract, match SKU, upload image to
  // R2, stamp image_path + marketing_description.
  z.object({
    mode: z.literal('run'),
    urls: z.array(z.string().url().max(1000)).min(1).max(25),
    /** Restrict SKU matching to parts of this vendor (ilike). */
    vendor: z.string().trim().max(200).optional(),
    /** Replace existing photos/descriptions instead of only filling blanks. */
    overwrite: z.boolean().optional(),
  }),
]);

const UA = 'BMG FleetSuite catalog importer (cgeorge@bmgfleet.com)';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchText(url: string, maxBytes = 2_000_000): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml,text/xml,*/*' }, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`Response too large (${buf.length} bytes)`);
  return buf.toString('utf8');
}

/** Active-part SKU lookup (id per skuKeys of item_number), optionally per vendor. */
async function buildPartMap(vendor?: string) {
  const { data: rows, error } = await fetchAllRows<any>((from, to) => {
    let q = supabase
      .from('netsuite_parts')
      .select('id, item_number, image_path, marketing_description')
      .eq('is_active', true)
      .not('item_number', 'is', null);
    if (vendor) q = q.ilike('vendor', `%${vendor}%`);
    return q.order('id').range(from, to);
  });
  if (error) throw new Error('Parts read failed: ' + error.message);
  const byKey = new Map<string, string>();
  const partById = new Map<string, { item_number: string; image_path: string | null; marketing_description: string | null }>();
  for (const p of rows || []) {
    for (const key of skuKeys(p.item_number)) if (!byKey.has(key)) byKey.set(key, p.id);
    partById.set(p.id, p);
  }
  return { byKey, partById };
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  try {
    if (body.mode === 'probe') {
      const html = await fetchText(body.url);
      const product = extractProduct(html);
      const { byKey } = await buildPartMap();
      const matchedPartId = matchSkuToPart(product.sku, byKey);
      return NextResponse.json({ product, matchedPartId });
    }

    if (body.mode === 'discover') {
      const origin = new URL(body.baseUrl).origin;
      const candidates = new Set<string>();
      // robots.txt Sitemap lines first, then the conventional path.
      const sitemaps: string[] = [];
      try {
        const robots = await fetchText(`${origin}/robots.txt`, 200_000);
        for (const m of robots.matchAll(/^sitemap:\s*(\S+)/gim)) sitemaps.push(m[1]);
      } catch { /* no robots.txt is fine */ }
      if (sitemaps.length === 0) sitemaps.push(`${origin}/sitemap.xml`);

      const queue = [...new Set(sitemaps)];
      let fetched = 0;
      while (queue.length > 0 && fetched < 12 && candidates.size < 3000) {
        const smUrl = queue.shift()!;
        fetched++;
        try {
          const xml = await fetchText(smUrl, 5_000_000);
          const { locs, isIndex } = parseSitemapLocs(xml);
          if (isIndex) queue.push(...locs.slice(0, 12 - fetched));
          else for (const loc of locs) if (looksLikeProductUrl(loc)) candidates.add(loc);
        } catch { /* skip unreachable child sitemaps */ }
        await sleep(400);
      }
      const urls = [...candidates];
      return NextResponse.json({ urls, total: urls.length, sample: urls.slice(0, 10) });
    }

    // mode === 'run'
    const { byKey, partById } = await buildPartMap(body.vendor);
    const results: { url: string; ok: boolean; partId?: string; sku?: string | null; imported?: string[]; error?: string }[] = [];
    let imagesSaved = 0;
    let descriptionsSaved = 0;

    for (const url of body.urls) {
      try {
        const html = await fetchText(url);
        const product = extractProduct(html);
        const partId = matchSkuToPart(product.sku, byKey);
        if (!partId) {
          results.push({ url, ok: false, sku: product.sku, error: product.sku ? 'No part matches this SKU' : 'No SKU found on page' });
          await sleep(700);
          continue;
        }
        const part = partById.get(partId)!;
        const updates: Record<string, string> = {};
        const imported: string[] = [];

        if (product.imageUrl && (body.overwrite || !part.image_path)) {
          const imgRes = await fetch(product.imageUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000), redirect: 'follow' });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            if (buf.length > 0 && buf.length <= 8_000_000) {
              const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
              const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
              const path = `parts/${partId}/vendor-${Date.now()}.${ext}`;
              const up = await r2Upload('photos', path, buf, contentType);
              if (up.success) {
                updates.image_path = path;
                imported.push('image');
                imagesSaved++;
              }
            }
          }
        }
        if (product.description && (body.overwrite || !part.marketing_description)) {
          updates.marketing_description = product.description;
          imported.push('description');
          descriptionsSaved++;
        }

        if (Object.keys(updates).length > 0) {
          const { error } = await supabase.from('netsuite_parts').update(updates).eq('id', partId);
          if (error) throw new Error(error.message);
        }
        results.push({ url, ok: true, partId, sku: product.sku, imported });
      } catch (err: any) {
        results.push({ url, ok: false, error: err?.message || 'fetch failed' });
      }
      // Polite pacing — one page at a time, ~1.5 req/s including image pulls.
      await sleep(700);
    }

    return NextResponse.json({ results, imagesSaved, descriptionsSaved });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Import failed' }, { status: 500 });
  }
}
