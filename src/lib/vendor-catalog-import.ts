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

/** The page's own <h1> — a cleaner product name than <title>, which usually
 *  carries a site suffix ("Shelf Unit - 32\" W … | Holman"). */
function firstH1(html: string): string | null {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const t = m ? stripTags(m[1]) : '';
  return t.length > 1 && t.length <= 200 ? t : null;
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

  // twitter:image and <link rel="image_src"> are what's left when a site
  // skips og:image — worth asking before reporting "no image".
  const imageUrl = jsonLdImageUrl(ld?.image) || og.image || metaContent(html, 'twitter:image')
    || html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i)?.[1] || null;

  // The headline SKU is what the probe prints and what run-mode errors quote.
  // Fall back to the first of the page's other SKU signals so a variant-list
  // page reports the number it carries instead of a bare "—".
  const sku = ld?.sku ? String(ld.sku).trim()
    : ld?.mpn ? String(ld.mpn).trim()
    : visibleSkuSpan(html) || extractAllSkus(html)[0] || null;

  return {
    name: (ld?.name ? stripTags(String(ld.name)) : null) || (og.title ? stripTags(og.title) : null) || firstH1(html) || (titleTag ? stripTags(titleTag) : null),
    description: description && description.length > 10 ? description.slice(0, 2000) : null,
    imageUrl,
    sku,
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
  // ── Last-resort tiers, each running ONLY when everything above it came up
  // empty. A page's own structured signals always win, so related-product
  // cards can't hijack its photo.

  // 1. Embedded platform JSON. Storefronts hand the browser their product as
  //    a JSON blob (Squarespace's SQUARESPACE_CONTEXT, Shopify's meta,
  //    __NEXT_DATA__ …) where the variant part numbers live under a sku-ish
  //    key, even when the rendered markup carries no class="sku" anywhere.
  if (out.length === 0) for (const s of embeddedJsonSkus(html)) push(s);

  // 2. Visible "Part #: 022824KP" labels. Tokens must carry a digit (labels
  //    like "Part: One" match nothing).
  if (out.length === 0) {
    for (const m of html.matchAll(/part\s*(?:#|no\.?|number)?\s*:?\s*(?:<[^>]+>\s*)*([A-Z0-9][A-Z0-9._/-]{3,29})/gi)) {
      if (/\d/.test(m[1])) push(m[1]);
    }
  }

  // 3. Bare code tokens standing alone in their own element — the shape a
  //    variant picker uses when it prints the option's part number under the
  //    option's name with no label at all (legendsoftheroad.com lists
  //    "3 Pc" / "741-135-6441" per option).
  if (out.length === 0) for (const s of standaloneCodeTokens(html)) push(s);

  return out;
}

/** Part numbers under a sku-ish key inside any <script> JSON blob. */
function embeddedJsonSkus(html: string): string[] {
  const keyed = /"(?:sku|mpn|partNumber|part_number|itemNumber|item_number|productCode|product_code)"\s*:\s*"([^"\\]{3,40})"/gi;
  const out: string[] = [];
  for (const block of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const m of block[1].matchAll(keyed)) {
      const v = m[1].trim();
      if (v && /\d/.test(v) && !out.includes(v)) out.push(v);
      if (out.length >= 200) return out;
    }
  }
  return out;
}

/**
 * Elements whose ENTIRE text is one part-number-shaped token: alphanumerics
 * broken by at least one - . or / ("741-135-6441", "741-135-6441.2"). The
 * separator requirement is what keeps prose, prices and bare quantities out.
 * Junk that slips through (a date, a phone number) is harmless — matching
 * downstream is exact against item_number, so it simply hits nothing.
 */
function standaloneCodeTokens(html: string): string[] {
  const body = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  const out: string[] = [];
  for (const m of body.matchAll(/>\s*([A-Za-z0-9]+(?:[.\-/][A-Za-z0-9]+)+)\s*</g)) {
    const t = m[1].toUpperCase();
    if (t.length >= 5 && t.length <= 40 && /\d/.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= 60) break;
  }
  return out;
}

/** Measurement words a slug's tail is made of when the slug ends in the
 *  product's SIZE rather than its part number. */
const DIMENSION_TOKENS = new Set(['W', 'H', 'D', 'L', 'X', 'IN', 'INCH', 'INCHES', 'FT', 'CM', 'MM', 'LB', 'LBS', 'OZ', 'GA', 'GAUGE']);

/**
 * SKU candidates from a product URL's slug — vendors routinely end the slug
 * with the part number (…/over-the-cab-truck-rack-36-extension-otc-u6036/).
 * Returns trailing-token joins, LONGEST first (most specific wins when the
 * catalog holds both OTC-U6036 and U6036). Candidates must look like part
 * numbers (≥4 chars, a letter AND a digit); matching stays exact via
 * matchSkuToPart, so a non-SKU word tail simply matches nothing.
 *
 * Dimension tails are dropped outright: cve.holman.com names its pages by
 * size (/shelf-unit-32-w-x-46-h-x-14-d), whose trailing joins — "14-D",
 * "X-14-D", "H-X-14-D" — carry a letter and a digit and so read as part
 * numbers. Letting those through risks a shelf's photo landing on whatever
 * catalog row happens to be numbered 14D, and a wrong photo is worse than
 * none. A candidate made ENTIRELY of measurement words and bare numbers is
 * never a part number.
 */
export function skuCandidatesFromUrl(pageUrl: string): string[] {
  let path: string;
  try { path = decodeURIComponent(new URL(pageUrl).pathname); } catch { return []; }
  const slug = path.replace(/\/+$/, '').split('/').pop() || '';
  const tokens = slug.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const dimensional = (parts: string[]) => parts.every(t => DIMENSION_TOKENS.has(t) || /^\d+$/.test(t));
  const out: string[] = [];
  for (let n = Math.min(4, tokens.length); n >= 1; n--) {
    const tail = tokens.slice(tokens.length - n);
    const cand = tail.join('-');
    if (cand.length >= 4 && /\d/.test(cand) && /[A-Z]/.test(cand) && !dimensional(tail)) out.push(cand);
  }
  return out;
}

/**
 * Why a page yielded nothing. "No SKU on the page" is a dead end on its own —
 * it reads the same whether the vendor served the real product page, an
 * anti-bot interstitial, or a JavaScript shell we can't run. The probe shows
 * this verdict so step 1 says what actually came back.
 */
export type PageVerdict = 'ok' | 'empty' | 'bot-wall' | 'js-shell';

/** Interstitials that answer 200 with a challenge instead of the page. */
const BOT_WALL_MARKERS: [RegExp, string][] = [
  [/_Incapsula_Resource|incap_ses_|distil_r_captcha/i, 'Imperva/Incapsula bot protection'],
  [/cf-browser-verification|cf_chl_|challenge-platform|just a moment\.\.\./i, 'Cloudflare challenge'],
  [/perimeterx|_pxhd|px-captcha/i, 'PerimeterX challenge'],
  [/reference\s*#\s*\d+\.[0-9a-f]+|access denied.{0,80}akamai/i, 'Akamai bot manager block'],
  [/(please )?enable (javascript|js) and cookies|javascript is required to (view|continue)/i, 'JavaScript/cookie gate'],
  [/are you a (human|robot)|verify (that )?you are (a )?human|unusual traffic from your/i, 'Bot verification page'],
];

export function diagnosePage(html: string): { verdict: PageVerdict; detail: string } {
  const trimmed = html.trim();
  if (trimmed.length < 120) {
    return { verdict: 'empty', detail: `The server answered with an essentially empty body (${trimmed.length} characters) — the real page never arrived.` };
  }
  for (const [re, label] of BOT_WALL_MARKERS) {
    if (re.test(html)) {
      return { verdict: 'bot-wall', detail: `${label}: the site served an anti-bot interstitial instead of the product page. Nothing on it is importable — ask the vendor to allow our importer, or get a product feed from them.` };
    }
  }
  const text = stripTags(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' '));
  const hasTitle = /<title[^>]*>\s*[^<\s]/i.test(html);
  const hasH1 = /<h1[^>]*>[\s\S]*?[^<>\s][\s\S]*?<\/h1>/i.test(html);
  if (!hasTitle && !hasH1 && text.length < 400 && /<script/i.test(html)) {
    return { verdict: 'js-shell', detail: `The served HTML is an app shell — no <title>, no <h1>, only ${text.length} characters of text — so the product details are drawn by JavaScript, which the importer doesn't run. This vendor needs a product feed or a different page source.` };
  }
  return { verdict: 'ok', detail: 'The page was readable — it just carried no part number we could match.' };
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

/**
 * Near-miss lookup for a SKU that matched nothing exactly: the dashless
 * catalog number CONTAINS the dashless SKU, or vice versa — the common
 * vendor-prefix/suffix drift (page 0091065 ↔ catalog BP-0091065, page
 * 02T408 ↔ catalog 02T408KP). Guardrails keep it honest: both strings
 * ≥5 chars, and exactly ONE catalog part may qualify — any ambiguity
 * refuses to match. Used to DIAGNOSE unmatched pages on every run, and
 * to import only when the admin explicitly opts in.
 */
export function nearMatchSkuToPart(
  sku: string | null | undefined,
  partsByKey: Map<string, string>,
): string | null {
  if (!sku) return null;
  const bare = String(sku).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (bare.length < 5) return null;
  const hits = new Set<string>();
  for (const [key, id] of partsByKey) {
    const kBare = key.replace(/[^A-Z0-9]/g, '');
    if (kBare.length < 5) continue;
    if (kBare === bare || kBare.includes(bare) || bare.includes(kBare)) {
      hits.add(id);
      if (hits.size > 1) return null; // ambiguous — refuse
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/** Static assets and feeds — never product or listing pages. */
const ASSET_URL_RE = /\.(pdf|jpe?g|png|webp|gif|xml|css|js|json|ico|svg|woff2?|ttf|eot|mp4|webm)(\?|$)/;

/** Cart/session actions (WooCommerce ?add-to-cart=… on listing cards) —
 *  fetching one performs the action on the vendor's site. Never crawl. */
const CART_ACTION_RE = /[?&](add[-_]to[-_]cart|remove_item|wc-ajax|apply_coupon)=/;

/** Product-page-ish URLs, to keep the crawl off blog posts and PDFs. */
export function looksLikeProductUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (ASSET_URL_RE.test(u) || CART_ACTION_RE.test(u)) return false;
  if (/\/feed\/?$/.test(u.split('?')[0])) return false;
  if (looksLikeListingUrl(u)) return false;
  return /\/(product|products|shop|item|catalog|p)\//.test(u);
}

/** Category/listing pages — the crawl fallback fans out through these. */
export function looksLikeListingUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (ASSET_URL_RE.test(u) || CART_ACTION_RE.test(u)) return false;
  const path = u.split('?')[0];
  // Pagination is a listing shape, never a product (…/catalog/page/2/) —
  // Masterack's paged catalog was slipping into run lists as "products".
  if (/\/page\/\d+\/?$/.test(path) || /[?&]page=\d+/.test(u)) return true;
  return /\/(product-category|product_category|collections|categories|category)\//.test(u)
    || /\/(products|shop|catalog)\/?$/.test(path);
}

/**
 * Teach mode's companion to looksLikeProductUrl: a link sitting exactly one
 * segment UNDER the category page an admin handed us. Plenty of vendors hang
 * products straight off the category path with no /product/ segment anywhere
 * (cve.holman.com: /shelving → /shelving/steel-shelving-unit), which the
 * global shape test can't see. Scoped to pages the admin explicitly pointed
 * at, so the open-web crawl keeps its narrower rule.
 */
export function looksLikeProductUnder(listingUrl: string, url: string): boolean {
  const lower = url.toLowerCase();
  if (ASSET_URL_RE.test(lower) || CART_ACTION_RE.test(lower)) return false;
  if (looksLikeListingUrl(url)) return false;
  let base: URL, u: URL;
  try { base = new URL(listingUrl); u = new URL(url); } catch { return false; }
  if (u.origin !== base.origin) return false;
  const segments = (p: string) => p.split('/').filter(Boolean);
  const baseSegs = segments(base.pathname.replace(/\/page\/\d+\/?$/, '/'));
  const urlSegs = segments(u.pathname);
  if (urlSegs.length !== baseSegs.length + 1) return false;
  return baseSegs.every((s, i) => urlSegs[i] === s);
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

/** Prepend https:// when a pasted URL has no scheme ("www.masterack.com").
 *  People paste hostnames as often as full URLs — don't reject them. */
export const ensureScheme = (u: string): string => {
  const t = u.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
};

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
 * IS the pagination on many platforms. The base's own /page/N suffix is
 * stripped before the same-path check, so /products/page/4/ still yields
 * /products/page/5/ (a widget only links a few neighbors at a time — the
 * walk has to chain through them).
 */
export function extractPaginationLinks(html: string, listingUrl: string): string[] {
  const base = new URL(listingUrl);
  const basePath = base.pathname.replace(/\/page\/\d+\/?$/, '/').replace(/\/$/, '');
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]), listingUrl);
      if (u.origin !== base.origin) continue;
      const pagedByPath = /\/page\/\d+\/?$/.test(u.pathname);
      const pageParam = u.searchParams.get('page');
      if (!pagedByPath && !/^\d+$/.test(pageParam || '')) continue;
      if (!u.pathname.startsWith(basePath)) continue;
      u.hash = '';
      // Keep ONLY the pagination signal. WooCommerce decorates listing
      // URLs with ?add-to-cart=<id> per product card — carrying that
      // along makes every card a "distinct" page (burning the crawl
      // budget refetching page N once per product) and fetching it
      // performs a cart action on the vendor's site.
      u.search = pagedByPath ? '' : `?page=${pageParam}`;
      out.add(u.toString());
    } catch { /* unparseable href */ }
  }
  return [...out];
}
