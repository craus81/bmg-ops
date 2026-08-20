import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { r2Upload } from '@/lib/r2';
import { fetchAllRows } from '@/lib/fetch-all';
import {
  extractProduct, extractAllSkus, extractDimensions, parseSitemapLocs, matchSkuToPart, skuKeys,
  looksLikeProductUrl, looksLikeListingUrl, looksLikeProductUnder,
  extractSameOriginLinks, extractPaginationLinks, originVariants,
  skuCandidatesFromUrl, ensureScheme, nearMatchSkuToPart, diagnosePage,
  SITEMAP_CANDIDATES,
} from '@/lib/vendor-catalog-import';
import { detectFitment } from '@/lib/vehicle-fitment';

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
     *  pagination and sibling categories) instead of sitemaps/crawl. Each
     *  call fetches ~25 listing pages and returns the remaining queue as
     *  pendingListings — the client loops until the chain is walked (big
     *  catalogs paginate into hundreds of pages; rangerdesign.com is 470). */
    listingUrls: z.array(urlish(1000)).max(500).optional(),
    /** Listing URLs already fetched in earlier calls of this walk. */
    visited: z.array(z.string().trim().max(1000)).max(5000).optional(),
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
    /** Assign this vendor name to matched parts whose vendor is blank —
     *  we know exactly whose site the assets came from. Never replaces a
     *  NetSuite-provided vendor. */
    setVendor: z.string().trim().min(1).max(200).optional(),
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

interface FetchedPage { html: string; status: number; finalUrl: string; bytes: number; contentType: string | null }

/** The fetch, with the evidence kept: the probe reports status / redirect /
 *  size so "we read nothing off this page" can be told apart from "the site
 *  bounced us somewhere else". */
async function fetchPage(url: string, maxBytes = 2_000_000): Promise<FetchedPage> {
  const res = await fetch(url, {
    headers: { ...FETCH_HEADERS, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`Response too large (${buf.length} bytes)`);
  return {
    html: buf.toString('utf8'),
    status: res.status,
    finalUrl: res.url || url,
    bytes: buf.length,
    contentType: res.headers.get('content-type'),
  };
}

async function fetchText(url: string, maxBytes = 2_000_000): Promise<string> {
  return (await fetchPage(url, maxBytes)).html;
}

interface MappedPart { item_number: string; vendor: string | null; is_active: boolean; image_path: string | null; marketing_description: string | null; product_url: string | null; width_in: number | null; depth_in: number | null; height_in: number | null; dims_source: string | null }

/**
 * SKU lookup (id per skuKeys of item_number) over the WHOLE catalog —
 * inactive rows included, so "that part exists but is INACTIVE" can be
 * reported instead of a bogus "no part matches this SKU". Imports still
 * only stamp active parts; the vendor filter is likewise applied after
 * matching so an out-of-scope match reports as exactly that. Key-claim
 * priority: active+in-scope > active > inactive — a live row always wins
 * a number shared with a retired duplicate. scopedCount counts ACTIVE
 * in-scope parts so callers can fail fast on a filter that excludes the
 * entire catalog (NetSuite's item-record vendor field is often blank).
 */
async function buildPartMap(vendor?: string) {
  const { data: rows, error } = await fetchAllRows<any>((from, to) => supabase
    .from('netsuite_parts')
    .select('id, item_number, vendor, is_active, image_path, marketing_description, product_url, width_in, depth_in, height_in, dims_source')
    .not('item_number', 'is', null)
    .order('id')
    .range(from, to));
  if (error) throw new Error('Parts read failed: ' + error.message);

  const needle = vendor?.trim().toLowerCase() || null;
  const inScope = (p: MappedPart) => !needle || (p.vendor || '').toLowerCase().includes(needle);

  const byKey = new Map<string, string>();
  const partById = new Map<string, MappedPart>();
  let scopedCount = 0;
  let activeTotal = 0;
  const vendorsSeen = new Set<string>();
  const all: (MappedPart & { id: string })[] = rows || [];
  const tiers = [
    all.filter(p => p.is_active && inScope(p)),
    all.filter(p => p.is_active && !inScope(p)),
    all.filter(p => !p.is_active),
  ];
  for (const p of tiers.flat()) {
    for (const key of skuKeys(p.item_number)) if (!byKey.has(key)) byKey.set(key, p.id);
    partById.set(p.id, p);
    if (p.is_active) {
      activeTotal++;
      if (inScope(p)) scopedCount++;
      if (p.vendor) vendorsSeen.add(p.vendor);
    }
  }
  return { byKey, partById, inScope, scopedCount, total: activeTotal, allTotal: all.length, vendorsSeen };
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  try {
    if (body.mode === 'probe') {
      const page = await fetchPage(body.url);
      const html = page.html;
      const product = extractProduct(html, page.finalUrl);
      const { byKey, partById, inScope, total, allTotal } = await buildPartMap(body.vendor);
      // Family pages can carry a whole model line's part numbers — match
      // them all; the slug is the fallback when the page yields nothing.
      const pageSkus = extractAllSkus(html);
      const slugSkus = skuCandidatesFromUrl(body.url);
      const matchedIds = [...new Set(
        pageSkus.map(s => matchSkuToPart(s, byKey)).filter((id): id is string => !!id),
      )];
      if (matchedIds.length === 0) {
        const slugHit = slugSkus.map(c => matchSkuToPart(c, byKey)).find(Boolean);
        if (slugHit) matchedIds.push(slugHit);
      }
      const matchedParts = matchedIds.map(id => {
        const p = partById.get(id)!;
        return { itemNumber: p.item_number, vendor: p.vendor, inScope: inScope(p), active: p.is_active };
      });
      // No match → show what the catalog holds NEAR this number (ilike on
      // the SKU's distinctive middle), so "not matching" is debuggable from
      // the probe alone: wrong spelling, inactive row, or truly absent.
      let closest: { itemNumber: string; active: boolean; vendor: string | null }[] | undefined;
      if (matchedIds.length === 0 && product.sku) {
        const bare = String(product.sku).toUpperCase().replace(/[^A-Z0-9]/g, '');
        const core = bare.length >= 6 ? bare.slice(2, bare.length - 2) : bare;
        if (core) {
          const { data: rows } = await supabase
            .from('netsuite_parts')
            .select('item_number, is_active, vendor')
            .ilike('item_number', `%${core}%`)
            .limit(5);
          closest = (rows || []).map(r => ({ itemNumber: r.item_number, active: r.is_active, vendor: r.vendor }));
        }
      }
      return NextResponse.json({
        product,
        matchedPartId: matchedIds[0] || null,
        matchedPart: matchedParts[0] || null,
        matchedParts,
        catalogSearched: { active: total, all: allTotal },
        closest,
        // What we actually received, and what we made of it — so a page that
        // yields nothing says WHY (bot wall / JS shell / readable but no SKU)
        // instead of a bare "no SKU on the page".
        fetched: { status: page.status, finalUrl: page.finalUrl, bytes: page.bytes, contentType: page.contentType },
        diagnosis: diagnosePage(html),
        skuCandidates: [...new Set([...pageSkus, ...slugSkus])].slice(0, 12),
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
          // Product shape globally, OR a page hanging one level under this
          // category — vendors like cve.holman.com have no /product/ segment
          // at all (/shelving → /shelving/steel-shelving-unit).
          for (const l of links) {
            if (looksLikeProductUrl(l) || looksLikeProductUnder(listing, l)) { candidates.add(l); found++; }
          }
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
      // Resumable: ~25 listing fetches per call (the serverless budget),
      // remaining queue returned for the client to continue with.
      if (body.listingUrls && body.listingUrls.length > 0) {
        const seen = new Set((body.visited || []).map(u => u.replace(/\/$/, '')));
        const queue = [...new Set(body.listingUrls)];
        const fetchedListings: string[] = [];
        while (queue.length > 0 && fetchedListings.length < 25 && candidates.size < 3000) {
          const listing = queue.shift()!;
          const key = listing.replace(/\/$/, '');
          if (seen.has(key)) continue;
          seen.add(key);
          fetchedListings.push(listing);
          for (const next of await harvestListing(listing)) {
            if (!seen.has(next.replace(/\/$/, ''))) queue.push(next);
          }
          await sleep(300);
        }
        const pendingListings = [...new Set(queue)]
          .filter(u => !seen.has(u.replace(/\/$/, '')))
          .slice(0, 500);
        const urls = [...candidates];
        return NextResponse.json({
          urls, total: urls.length, sample: urls.slice(0, 10), via: 'listing',
          checked: checked.slice(0, 30), pendingListings, fetchedListings,
        });
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
    let vendorsSet = 0;
    let dimsSaved = 0;

    // N4-B2: vendor pages name the vehicles a part fits ("Fits Transit 130"
    // and 148" WB", masterack ?vehicle= slugs, Ranger per-vehicle pages) —
    // harvest fitment tags for matched parts. Advisory, source='vendor_site',
    // deduped in-memory and upserted once after the page loop.
    const { data: platRows } = await supabase
      .from('vehicle_platforms').select('id, key').eq('active', true);
    const platformIdByKey = new Map<string, string>((platRows || []).map((p: any) => [p.key, p.id]));
    const fitmentRows = new Map<string, { part_id: string; platform_id: string; wheelbase_label: string | null; roof_label: string | null; source: string }>();

    for (const url of body.urls) {
      try {
        const html = await fetchText(url);
        const product = extractProduct(html, url);
        const dims = extractDimensions(html);
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
            if (id) {
              const p = partById.get(id)!;
              nearItemNumber = p.is_active ? p.item_number : `${p.item_number} (inactive)`;
              nearSku = s;
              break;
            }
          }
          results.push({
            url, ok: false, sku: product.sku ?? nearSku ?? null, nearItemNumber,
            error: product.sku ? 'No part matches this SKU' : 'No SKU on page (or in the URL) matches a part',
          });
          await sleep(700);
          continue;
        }
        const activeIds = matchedIds.filter(id => partById.get(id)!.is_active);
        if (activeIds.length === 0) {
          const first = partById.get(matchedIds[0])!;
          results.push({ url, ok: false, partId: matchedIds[0], sku: product.sku, error: `SKU matches ${first.item_number}${matchedIds.length > 1 ? ` (+${matchedIds.length - 1} more)` : ''}, but that part is INACTIVE in the catalog — reactivate it in NetSuite and re-run` });
          await sleep(700);
          continue;
        }
        const inScopeIds = activeIds.filter(id => inScope(partById.get(id)!));
        if (inScopeIds.length === 0) {
          const first = partById.get(activeIds[0])!;
          results.push({ url, ok: false, partId: activeIds[0], sku: product.sku, error: `SKU matches ${first.item_number}${activeIds.length > 1 ? ` (+${activeIds.length - 1} more)` : ''}, but that part's vendor is ${first.vendor ? `"${first.vendor}"` : 'blank'} — outside your "${body.vendor}" filter` });
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
          const updates: Record<string, string | number> = {};
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
          // Physical dims for the 3D upfit designer (migration 213): only a
          // COMPLETE W×D×H set is worth writing (a partial can't place the
          // part), only into blanks — and a manual set is never overwritten,
          // even with the overwrite flag: vendor pages change, a human's
          // tape measure doesn't.
          if (dims && dims.widthIn != null && dims.depthIn != null && dims.heightIn != null) {
            const blank = part.width_in == null && part.depth_in == null && part.height_in == null;
            if (blank || (body.overwrite && part.dims_source !== 'manual')) {
              updates.width_in = dims.widthIn;
              updates.depth_in = dims.depthIn;
              updates.height_in = dims.heightIn;
              if (dims.weightLb != null) updates.weight_lb = dims.weightLb;
              updates.dims_source = 'vendor_site';
              part.width_in = dims.widthIn; // in-memory too — a later page in this batch matching the same part must see it filled
              part.depth_in = dims.depthIn;
              part.height_in = dims.heightIn;
              part.dims_source = 'vendor_site';
              imported.push(`dims→${part.item_number}`);
              dimsSaved++;
            }
          }
          // The page we matched this SKU on IS the vendor product page —
          // capture it so the enhanced estimate can link "View product".
          if (body.overwrite || !part.product_url) {
            updates.product_url = url;
          }
          // Fill-blank only — a NetSuite-provided vendor is never replaced.
          // (Both sync paths preserve this assignment while NetSuite's
          // item-record vendor field stays blank.)
          if (body.setVendor && !part.vendor) {
            updates.vendor = body.setVendor;
            part.vendor = body.setVendor; // in-memory too, so later pages in this batch don't re-count it
            vendorsSet++;
          }
          if (Object.keys(updates).length > 0) {
            const { error } = await supabase.from('netsuite_parts').update(updates).eq('id', partId);
            if (error) throw new Error(error.message);
          }
        }
        // Harvest vehicle fitment from the page: URL slug + product name +
        // description all carry vehicle signals.
        const fitHits = detectFitment([url, product.name, product.description].filter(Boolean).join(' '));
        for (const hit of fitHits) {
          const platformId = platformIdByKey.get(hit.platformKey);
          if (!platformId) continue;
          imported.push(`fits→${hit.platformKey}`);
          for (const partId of inScopeIds) {
            const key = `${partId}|${platformId}|${hit.wheelbase || ''}|${hit.roof || ''}`;
            if (!fitmentRows.has(key)) {
              fitmentRows.set(key, {
                part_id: partId, platform_id: platformId,
                wheelbase_label: hit.wheelbase, roof_label: hit.roof,
                source: 'vendor_site',
              });
            }
          }
        }
        results.push({ url, ok: true, partId: inScopeIds[0], sku: product.sku, matched: inScopeIds.length, imported });
      } catch (err: any) {
        results.push({ url, ok: false, error: err?.message || 'fetch failed' });
      }
      // Polite pacing — one page at a time, ~1.5 req/s including image pulls.
      await sleep(700);
    }

    // Upsert harvested fitment; the COALESCE unique index makes re-runs
    // no-ops, and (as in the auto-tag sweep) its conflicts aren't
    // addressable via onConflict columns — fall back to per-row inserts.
    let fitmentTagged = 0;
    const fitRows = [...fitmentRows.values()];
    for (let i = 0; i < fitRows.length; i += 500) {
      const chunk = fitRows.slice(i, i + 500);
      const { error: insErr, count } = await supabase
        .from('part_fitment')
        .upsert(chunk, { onConflict: 'part_id,platform_id,wheelbase_label,roof_label', ignoreDuplicates: true, count: 'exact' });
      if (insErr) {
        for (const r of chunk) {
          const { error: oneErr } = await supabase.from('part_fitment').insert(r);
          if (!oneErr) fitmentTagged++;
        }
      } else {
        fitmentTagged += count ?? chunk.length;
      }
    }

    return NextResponse.json({ results, imagesSaved, descriptionsSaved, vendorsSet, dimsSaved, fitmentTagged });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Import failed' }, { status: 500 });
  }
}
