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

/** First JSON-LD Product (or ProductGroup — family pages) in the page,
 *  searching @graph nests too. */
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
      if (types.includes('Product') || types.includes('ProductGroup')) return node;
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

/** WooCommerce-style visible SKU: <span class="sku">OTC-U6036</span>.
 *  Class-token match ("sku" exactly, not "sku_wrapper"). */
function visibleSkuSpan(html: string): string | null {
  const m = html.match(/class=["'](?:[^"']*\s)?sku(?:\s[^"']*)?["'][^>]*>\s*([^<>\s][^<>]{0,58}?)\s*</i);
  return m ? m[1].trim() : null;
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
    sku: ld?.sku ? String(ld.sku).trim() : (ld?.mpn ? String(ld.mpn).trim() : visibleSkuSpan(html)),
  };
}

/**
 * Every SKU signal on the page, primary first: JSON-LD sku/mpn (including
 * offers and hasVariant entries — family pages advertise a whole model
 * line's part numbers) plus every visible class="sku" element. Downstream
 * matching stays exact-or-dashless per SKU, so extra non-SKU strings here
 * simply match nothing.
 */
export function extractAllSkus(html: string): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (v == null || typeof v === 'object') return;
    const s = String(v).trim();
    if (s && s.length <= 60 && !out.includes(s)) out.push(s);
  };
  const ld = findJsonLdProduct(html);
  if (ld) {
    push(ld.sku);
    push(ld.mpn);
    const offers = Array.isArray(ld.offers) ? ld.offers : ld.offers ? [ld.offers] : [];
    for (const o of offers) { push(o?.sku); push(o?.mpn); }
    const variants = Array.isArray(ld.hasVariant) ? ld.hasVariant : [];
    for (const v of variants) { push(v?.sku); push(v?.mpn); }
  }
  for (const m of html.matchAll(/class=["'](?:[^"']*\s)?sku(?:\s[^"']*)?["'][^>]*>\s*([^<>\s][^<>]{0,58}?)\s*</gi)) {
    push(m[1]);
  }
  return out;
}

/**
 * SKU candidates from a product URL's slug — vendors routinely end the slug
 * with the part number (…/over-the-cab-truck-rack-36-extension-otc-u6036/).
 * Returns trailing-token joins, LONGEST first (most specific wins when the
 * catalog holds both OTC-U6036 and U6036). Candidates must look like part
 * numbers (≥4 chars, a letter AND a digit); matching stays exact via
 * matchSkuToPart, so a non-SKU word tail simply matches nothing.
 */
export function skuCandidatesFromUrl(pageUrl: string): string[] {
  let path: string;
  try { path = decodeURIComponent(new URL(pageUrl).pathname); } catch { return []; }
  const slug = path.replace(/\/+$/, '').split('/').pop() || '';
  const tokens = slug.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (let n = Math.min(4, tokens.length); n >= 1; n--) {
    const cand = tokens.slice(tokens.length - n).join('-');
    if (cand.length >= 4 && /\d/.test(cand) && /[A-Z]/.test(cand)) out.push(cand);
  }
  return out;
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
 *  Shopify's product sitemap, and most others (sitemap.xml). */
export const SITEMAP_CANDIDATES = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap-index.xml', '/sitemap_products_1.xml'];

/** Both host spellings — a site can serve (or block) www and apex differently. */
export function originVariants(baseUrl: string): string[] {
  const u = new URL(baseUrl);
  const hosts = u.hostname.startsWith('www.')
    ? [u.hostname, u.hostname.slice(4)]
    : [u.hostname, `www.${u.hostname}`];
  return hosts.map(h => `${u.protocol}//${h}`);
}

/**
 * Pagination links of a listing page: same-origin URLs on the same path
 * (or /page/N children) carrying a page indicator. Query is kept — ?page=2
 * IS the pagination on many platforms.
 */
export function extractPaginationLinks(html: string, listingUrl: string): string[] {
  const base = new URL(listingUrl);
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]), listingUrl);
      if (u.origin !== base.origin) continue;
      const paged = /\/page\/\d+\/?$/.test(u.pathname) || /(^|&)page=\d+/.test(u.search.slice(1));
      if (!paged) continue;
      if (!u.pathname.startsWith(base.pathname.replace(/\/$/, '')) ) continue;
      u.hash = '';
      out.add(u.toString());
    } catch { /* unparseable href */ }
  }
  return [...out];
}
