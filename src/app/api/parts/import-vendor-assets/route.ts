import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { r2Upload } from '@/lib/r2';
import { fetchAllRows } from '@/lib/fetch-all';
import {
  extractProduct, extractAllSkus, parseSitemapLocs, matchSkuToPart, skuKeys,
  looksLikeProductUrl, looksLikeListingUrl, extractSameOriginLinks,
  extractPaginationLinks, originVariants, skuCandidatesFromUrl, ensureScheme,
  nearMatchSkuToPart, SITEMAP_CANDIDATES,
} from '@/lib/vendor-catalog-import';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// URL that tolerates a missing scheme ("www.masterack.com" — people paste
// hostnames as often as full URLs). Normalized to https:// before the
// strict check, so downstream code always sees a real URL.
const urlish = (max: number) =>
  z.preprocess(v => (typeof v === 'string' ? ensureScheme(v) : v), z.string().url().max(max));

const Schema = z.discriminatedUnion('mode', [
  // Verify extraction against one live page — no writes. vendor is only
  // echoed back as an in/out-of-scope verdict so a filter that would make
  // the real import skip everything is visible at step 1.
  z.object({ mode: z.literal('probe'), url: urlish(1000), vendor: z.string().trim().max(200).optional() }),
  // Walk the site's sitemap(s) / crawl and return product-ish URLs for the
  // client to batch through 'run'. listingUrl = "teach mode": harvest from
  // a specific category page (plus its pagination and sibling categories)
  // instead — for sites whose sitemaps and homepage nav are unreadable.
  z.object({
    mode: z.literal('discover'),
    baseUrl: urlish(300),
    /** Teach mode: harvest from these category/listing pages (plus their
     *  pagination and sibling categories) instead of sitemaps/crawl. */
    listingUrls: z.array(urlish(1000)).max(20).optional(),
  }),
  // Import a batch of product pages: extract, match SKU, upload image to
  // R2, stamp image_path + marketing_description.
  z.object({
    mode: z.literal('run'),
    urls: z.array(urlish(1000)).min(1).max(25),
    /** Restrict SKU matching to parts of this vendor (ilike). */
    vendor: z.string().trim().max(200).optional(),
    /** Replace existing photos/descriptions instead of only filling blanks. */
    overwrite: z.boolean().optional(),
    /** Opt-in: when nothing matches exactly, accept a UNIQUE containment
     *  match (page SKU inside one catalog number, or vice versa). */
    nearMatch: z.boolean().optional(),
  }),
]);

// Browser-standard headers: several vendor sites (buyersproducts.com 403s,
// for one) reject anything that doesn't look like a browser before serving a
// byte. We still identify ourselves honestly via the standard From header,
// and the polite pacing below keeps volume at ~1 req/s.
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  From: 'cgeorge@bmgfleet.com',
  'Accept-Language': 'en-US,en;q=0.9',
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchText(url: string, maxBytes = 2_000_000): Promise<string> {
  const res = await fetch(url, {
    headers: { ...FETCH_HEADERS, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`Response too large (${buf.length} bytes)`);
  return buf.toString('utf8');
}

interface MappedPart { item_number: string; vendor: string | null; image_path: string | null; marketing_description: string | null }

/**
 * Active-part SKU lookup (id per skuKeys of item_number) over the WHOLE
 * catalog, plus an in-scope predicate for the vendor filter. The filter is
 * applied after matching — not in the query — so an out-of-scope match can
 * be reported as exactly that ("vendor is X, outside your filter") instead
 * of a bogus "no part matches this SKU". NetSuite's item-record vendor
 * field is optional and often blank, so a filter can silently exclude the
 * entire catalog; scopedCount lets callers fail fast on that.
 */
async function buildPartMap(vendor?: string) {
  const { data: rows, error } = await fetchAllRows<any>((from, to) => supabase
    .from('netsuite_parts')
    .select('id, item_number, vendor, image_path, marketing_description')
    .eq('is_active', true)
    .not('item_number', 'is', null)
    .order('id')
    .range(from, to));
  if (error) throw new Error('Parts read failed: ' + error.message);

  const needle = vendor?.trim().toLowerCase() || null;
  const inScope = (p: MappedPart) => !needle || (p.vendor || '').toLowerCase().includes(needle);

  const byKey = new Map<string, string>();
  const partById = new Map<string, MappedPart>();
  let scopedCount = 0;
  const vendorsSeen = new Set<string>();
  // In-scope parts claim SKU keys first so a cross-vendor SKU collision
  // resolves to the part the filter asks for.
  const all: any[] = rows || [];
  for (const p of [...all.filter(inScope), ...all.filter((p: MappedPart) => !inScope(p))]) {
    for (const key of skuKeys(p.item_number)) if (!byKey.has(key)) byKey.set(key, p.id);
    partById.set(p.id, p);
    if (inScope(p)) scopedCount++;
    if (p.vendor) vendorsSeen.add(p.vendor);
  }
  return { byKey, partById, inScope, scopedCount, total: all.length, vendorsSeen };
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
      const { byKey, partById, inScope } = await buildPartMap(body.vendor);
      // Family pages can carry a whole model line's part numbers — match
      // them all; the slug is the fallback when the page yields nothing.
      const matchedIds = [...new Set(
        extractAllSkus(html).map(s => matchSkuToPart(s, byKey)).filter((id): id is string => !!id),
      )];
      if (matchedIds.length === 0) {
        const slugHit = skuCandidatesFromUrl(body.url).map(c => matchSkuToPart(c, byKey)).find(Boolean);
        if (slugHit) matchedIds.push(slugHit);
      }
      const matchedParts = matchedIds.map(id => {
        const p = partById.get(id)!;
        return { itemNumber: p.item_number, vendor: p.vendor, inScope: inScope(p) };
      });
      return NextResponse.json({
        product,
        matchedPartId: matchedIds[0] || null,
        matchedPart: matchedParts[0] || null,
        matchedParts,
      });
    }

    if (body.mode === 'discover') {
      const candidates = new Set<string>();
      const checked: string[] = [];
      const note = (url: string, msg: string) => checked.push(`${url} — ${msg}`);

      // Category-page-ish, generously: the standard shapes plus paths like
      // /trazer-truck-products/ (rangerdesign.com's other category flavor).
      const listingish = (u: string) => looksLikeListingUrl(u) || /-products?\/?$/.test(new URL(u).pathname);

      // Harvest one listing page: product links into candidates, pagination +
      // sibling category links back to the caller for the queue.
      const harvestListing = async (listing: string): Promise<string[]> => {
        try {
          const page = await fetchText(listing);
          let found = 0;
          const links = extractSameOriginLinks(page, listing);
          for (const l of links) if (looksLikeProductUrl(l)) { candidates.add(l); found++; }
          note(listing, `${found} product links`);
          return [
            ...extractPaginationLinks(page, listing),
            ...links.filter(listingish),
          ];
        } catch (err: any) {
          note(listing, `fetch failed: ${err?.message || 'error'}`);
          return [];
        }
      };

      // ── Teach mode: Craig hands us category pages; we fan out through
      // their pagination and sibling categories. No sitemap guessing.
      if (body.listingUrls && body.listingUrls.length > 0) {
        const seen = new Set<string>();
        const queue = [...new Set(body.listingUrls)];
        let fetched = 0;
        while (queue.length > 0 && fetched < 25 && candidates.size < 3000) {
          const listing = queue.shift()!;
          const key = listing.replace(/\/$/, '');
          if (seen.has(key)) continue;
          seen.add(key);
          fetched++;
          for (const next of await harvestListing(listing)) {
            if (!seen.has(next.replace(/\/$/, ''))) queue.push(next);
          }
          await sleep(300);
        }
        const urls = [...candidates];
        return NextResponse.json({ urls, total: urls.length, sample: urls.slice(0, 10), via: 'listing', checked: checked.slice(0, 30) });
      }

      // ── Sitemap pass over BOTH host spellings (www and apex can behave
      // differently), robots.txt Sitemap lines first.
      const origins = originVariants(body.baseUrl);
      const sitemaps: string[] = [];
      for (const origin of origins) {
        try {
          const robots = await fetchText(`${origin}/robots.txt`, 200_000);
          for (const m of robots.matchAll(/^sitemap:\s*(\S+)/gim)) sitemaps.push(m[1]);
        } catch { /* no robots.txt is fine */ }
      }
      if (sitemaps.length === 0) {
        for (const origin of origins) sitemaps.push(...SITEMAP_CANDIDATES.map(p => `${origin}${p}`));
      }

      const queue = [...new Set(sitemaps)];
      let fetched = 0;
      while (queue.length > 0 && fetched < 15 && candidates.size < 3000) {
        const smUrl = queue.shift()!;
        fetched++;
        try {
          const xml = await fetchText(smUrl, 5_000_000);
          const { locs, isIndex } = parseSitemapLocs(xml);
          if (isIndex) {
            queue.push(...locs.slice(0, 15 - fetched));
            note(smUrl, `index with ${locs.length} child sitemaps`);
          } else {
            const before = candidates.size;
            for (const loc of locs) if (looksLikeProductUrl(loc)) candidates.add(loc);
            note(smUrl, `${locs.length} locs, ${candidates.size - before} product-like`);
          }
        } catch (err: any) {
          note(smUrl, err?.message || 'fetch failed');
        }
        await sleep(300);
      }

      // ── Crawl fallback: homepage links (both spellings) → listing pages.
      let via: 'sitemap' | 'crawl' = 'sitemap';
      if (candidates.size === 0) {
        via = 'crawl';
        for (const origin of origins) {
          try {
            const home = await fetchText(origin);
            const homeLinks = extractSameOriginLinks(home, origin);
            let found = 0;
            for (const l of homeLinks) if (looksLikeProductUrl(l)) { candidates.add(l); found++; }
            const listings = homeLinks.filter(l => listingish(l)).slice(0, 10);
            note(origin, `homepage: ${homeLinks.length} links, ${found} product-like, ${listings.length} category-like`);
            for (const listing of listings) {
              await harvestListing(listing);
              await sleep(300);
              if (candidates.size >= 3000) break;
            }
            if (candidates.size > 0) break;
          } catch (err: any) {
            note(origin, `homepage fetch failed: ${err?.message || 'error'}`);
          }
        }
      }

      const urls = [...candidates];
      return NextResponse.json({ urls, total: urls.length, sample: urls.slice(0, 10), via, checked: checked.slice(0, 30) });
    }

    // mode === 'run'
    const { byKey, partById, inScope, scopedCount, total, vendorsSeen } = await buildPartMap(body.vendor);
    if (body.vendor && scopedCount === 0) {
      const sample = [...vendorsSeen].sort().slice(0, 8);
      return NextResponse.json({
        error: `No active parts have a vendor containing "${body.vendor}" — the import would match nothing. `
          + (sample.length > 0 ? `Vendors on file include: ${sample.join(', ')}${vendorsSeen.size > sample.length ? `, +${vendorsSeen.size - sample.length} more` : ''}. ` : `No parts have a vendor set at all (${total.toLocaleString()} active parts). `)
          + 'Clear the vendor box to match by part number across the whole catalog.',
      }, { status: 400 });
    }
    const results: { url: string; ok: boolean; partId?: string; sku?: string | null; matched?: number; imported?: string[]; error?: string; nearItemNumber?: string }[] = [];
    let imagesSaved = 0;
    let descriptionsSaved = 0;

    for (const url of body.urls) {
      try {
        const html = await fetchText(url);
        const product = extractProduct(html);
        // Family pages carry a whole model line's part numbers — match every
        // SKU signal on the page (slug fallback when the page yields none).
        // Each match is still exact-or-dashless against item_number.
        const allSkus = extractAllSkus(html);
        const skuPool = [...allSkus, ...skuCandidatesFromUrl(url)];
        const matchedIds = [...new Set(
          allSkus.map(s => matchSkuToPart(s, byKey)).filter((id): id is string => !!id),
        )];
        if (matchedIds.length === 0) {
          const slugHit = skuCandidatesFromUrl(url).map(c => matchSkuToPart(c, byKey)).find(Boolean);
          if (slugHit) matchedIds.push(slugHit);
        }
        // Opt-in near matching: unique containment only (page 0091065 ↔
        // catalog BP-0091065). Never runs unless the admin asked for it.
        if (matchedIds.length === 0 && body.nearMatch) {
          for (const s of skuPool) {
            const id = nearMatchSkuToPart(s, byKey);
            if (id && !matchedIds.includes(id)) matchedIds.push(id);
          }
        }
        if (matchedIds.length === 0) {
          // Diagnose, even when near matching is off: report what a unique
          // containment match WOULD hit, so the summary can show the
          // prefix/suffix drift pattern instead of a bare "no match".
          let nearItemNumber: string | undefined;
          let nearSku: string | undefined;
          for (const s of skuPool) {
            const id = nearMatchSkuToPart(s, byKey);
            if (id) { nearItemNumber = partById.get(id)!.item_number; nearSku = s; break; }
          }
          results.push({
            url, ok: false, sku: product.sku ?? nearSku ?? null, nearItemNumber,
            error: product.sku ? 'No part matches this SKU' : 'No SKU on page (or in the URL) matches a part',
          });
          await sleep(700);
          continue;
        }
        const inScopeIds = matchedIds.filter(id => inScope(partById.get(id)!));
        if (inScopeIds.length === 0) {
          const first = partById.get(matchedIds[0])!;
          results.push({ url, ok: false, partId: matchedIds[0], sku: product.sku, error: `SKU matches ${first.item_number}${matchedIds.length > 1 ? ` (+${matchedIds.length - 1} more)` : ''}, but that part's vendor is ${first.vendor ? `"${first.vendor}"` : 'blank'} — outside your "${body.vendor}" filter` });
          await sleep(700);
          continue;
        }

        // Pull the page's image bytes once; each matched part gets its own
        // R2 copy (paths are per-part).
        let imgBuf: Buffer | null = null;
        let imgType = 'image/jpeg';
        const wantsImage = product.imageUrl && inScopeIds.some(id => body.overwrite || !partById.get(id)!.image_path);
        if (wantsImage) {
          const imgRes = await fetch(product.imageUrl!, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(20_000), redirect: 'follow' });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            if (buf.length > 0 && buf.length <= 8_000_000) {
              imgBuf = buf;
              imgType = imgRes.headers.get('content-type') || 'image/jpeg';
            }
          }
        }

        const imported: string[] = [];
        for (const partId of inScopeIds) {
          const part = partById.get(partId)!;
          const updates: Record<string, string> = {};
          if (imgBuf && (body.overwrite || !part.image_path)) {
            const ext = imgType.includes('png') ? 'png' : imgType.includes('webp') ? 'webp' : 'jpg';
            const path = `parts/${partId}/vendor-${Date.now()}.${ext}`;
            const up = await r2Upload('photos', path, imgBuf, imgType);
            if (up.success) {
              updates.image_path = path;
              imported.push(`image→${part.item_number}`);
              imagesSaved++;
            }
          }
          if (product.description && (body.overwrite || !part.marketing_description)) {
            updates.marketing_description = product.description;
            imported.push(`description→${part.item_number}`);
            descriptionsSaved++;
          }
          if (Object.keys(updates).length > 0) {
            const { error } = await supabase.from('netsuite_parts').update(updates).eq('id', partId);
            if (error) throw new Error(error.message);
          }
        }
        results.push({ url, ok: true, partId: inScopeIds[0], sku: product.sku, matched: inScopeIds.length, imported });
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
