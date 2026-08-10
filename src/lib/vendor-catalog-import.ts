/**
 * Vendor catalog asset import (roadmap N4-A, Craig 2026-08-10): pull product
 * photos + descriptions from a parts vendor's website (rangerdesign.com
 * first; Masterack etc. next) and attach them to the matching netsuite_parts
 * rows, so the estimate catalog browser looks like the vendor's own site.
 *
 * Built blind to any one site's HTML on purpose — extraction leans on the
 * signals virtually every commerce site emits, in order of trust:
 *   1. JSON-LD `Product` schema (name / description / image / sku|mpn)
 *   2. OpenGraph meta tags (og:image / og:description / og:title)
 *   3. <title> as a last-resort name
 * Product URLs come from the site's sitemap.xml (index-aware). SKU matching
 * against item_number is exact-uppercase first, dashless second — never
 * fuzzier, because the wrong photo on a part is worse than none.
 *
 * Etiquette: one request at a time with a delay, an honest User-Agent, and
 * hard caps. Assets are vendor marketing material for products BMG resells —
 * confirm with the vendor rep / dealer portal where formality matters.
 *
 * Pure helpers here; the fetch loop lives in the admin API route.
 */

export interface ExtractedProduct {
  name: string | null;
  description: string | null;
  imageUrl: string | null;
  sku: string | null;
}

/** First JSON-LD Product object in the page, searching @graph nests too. */
function findJsonLdProduct(html: string): any | null {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of blocks) {
    let parsed: any;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const queue: any[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      const type = node['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (types.includes('Product')) return node;
      if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
    }
  }
  return null;
}

const metaContent = (html: string, property: string): string | null => {
  // property= and name= variants, attribute order both ways.
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']` +
    `|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
    'i',
  );
  const m = html.match(re);
  return m ? (m[1] || m[2] || null) : null;
};

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** JSON-LD image can be a string, an array, or an ImageObject. */
function jsonLdImageUrl(image: any): string | null {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return jsonLdImageUrl(image[0]);
  if (typeof image === 'object') return image.url || image.contentUrl || null;
  return null;
}

export function extractProduct(html: string): ExtractedProduct {
  const ld = findJsonLdProduct(html);
  const og = {
    image: metaContent(html, 'og:image'),
    description: metaContent(html, 'og:description') || metaContent(html, 'description'),
    title: metaContent(html, 'og:title'),
  };
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || null;

  const description = (ld?.description ? stripTags(String(ld.description)) : null)
    || (og.description ? stripTags(og.description) : null);

  return {
    name: (ld?.name ? stripTags(String(ld.name)) : null) || (og.title ? stripTags(og.title) : null) || (titleTag ? stripTags(titleTag) : null),
    description: description && description.length > 10 ? description.slice(0, 2000) : null,
    imageUrl: jsonLdImageUrl(ld?.image) || og.image,
    sku: ld?.sku ? String(ld.sku).trim() : (ld?.mpn ? String(ld.mpn).trim() : null),
  };
}

/** <loc> entries from a sitemap or sitemap index. */
export function parseSitemapLocs(xml: string): { locs: string[]; isIndex: boolean } {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)].map(m => decodeEntities(m[1].trim()));
  return { locs, isIndex: /<sitemapindex[\s>]/i.test(xml) };
}

/** Exact uppercase key, and a dashless fallback key. */
export const skuKeys = (sku: string): string[] => {
  const up = sku.trim().toUpperCase();
  const bare = up.replace(/[^A-Z0-9]/g, '');
  return bare && bare !== up ? [up, bare] : [up];
};

/**
 * Match an extracted product to a part by SKU: exact uppercase first, then
 * dashless. `partsByKey` is built with skuKeys() over item_number. Returns
 * the part id or null — never fuzzy.
 */
export function matchSkuToPart(
  sku: string | null | undefined,
  partsByKey: Map<string, string>,
): string | null {
  if (!sku) return null;
  for (const key of skuKeys(String(sku))) {
    const hit = partsByKey.get(key);
    if (hit) return hit;
  }
  return null;
}

/** Product-page-ish URLs, to keep the crawl off blog posts and PDFs. */
export function looksLikeProductUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (/\.(pdf|jpg|jpeg|png|webp|gif|xml)(\?|$)/.test(u)) return false;
  if (looksLikeListingUrl(u)) return false;
  return /\/(product|products|shop|item|catalog|p)\//.test(u);
}

/** Category/listing pages — the crawl fallback fans out through these. */
export function looksLikeListingUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (/\.(pdf|jpg|jpeg|png|webp|gif|xml)(\?|$)/.test(u)) return false;
  return /\/(product-category|product_category|collections|categories|category)\//.test(u)
    || /\/(products|shop|catalog)\/?$/.test(u);
}

/**
 * Same-origin links from a page (href attributes, relative resolved).
 * Fragment/query stripped so pagination params don't fan out duplicates.
 */
export function extractSameOriginLinks(html: string, baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const raw = decodeEntities(m[1]);
    if (/^(mailto:|tel:|javascript:)/i.test(raw)) continue;
    try {
      const u = new URL(raw, baseUrl);
      if (u.origin !== origin) continue;
      u.hash = '';
      u.search = '';
      out.add(u.toString());
    } catch { /* unparseable href */ }
  }
  return [...out];
}

/** Conventional sitemap locations, tried when robots.txt names none —
 *  covers WordPress/Yoast (sitemap_index.xml), WP core (wp-sitemap.xml),
 *  and Shopify/most others (sitemap.xml). */
export const SITEMAP_CANDIDATES = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap-index.xml'];
