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

/** One attribute off an <img …> tag's attribute text. */
const tagAttr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1].trim() : null;
};

/** Largest candidate in a srcset ("a.jpg 400w, b.jpg 1200w" → b.jpg). */
const largestInSrcset = (v: string | null): string | null => {
  if (!v) return null;
  const urls = v.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
  return urls.length > 0 ? urls[urls.length - 1] : null;
};

/** Chrome that is never the product: logos, icons, payment badges, spacers. */
const IMAGE_NOISE_RE = /logo|icon|sprite|badge|placeholder|spacer|blank|pixel|avatar|favicon|social|payment|banner/i;

/** An absolute image URL sitting in the page's own embedded product JSON
 *  (Squarespace's assetUrl, Shopify's featured_image, …). */
function embeddedJsonImage(html: string): string | null {
  for (const block of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const m = block[1].match(/"(?:assetUrl|imageUrl|featured_image|originalUrl|image|src)"\s*:\s*"(https?:\\?\/\\?\/[^"]{10,400}?\.(?:jpe?g|png|webp)(?:\?[^"]{0,150})?)"/i);
    if (m && !IMAGE_NOISE_RE.test(m[1])) return m[1].replace(/\\\//g, '/');
  }
  return null;
}

/**
 * Best <img> in the page body — the last resort when a site publishes no
 * og:image at all (legendsoftheroad.com shows a full gallery and advertises
 * none of it). Header/nav/footer are cut first, chrome is filtered by name,
 * anything declaring itself under 200px is skipped, and gallery/product
 * containers win ties. It's a heuristic, which is exactly why the probe
 * renders the result: step 1 shows the photo before any import runs.
 */
function bodyImageUrl(html: string): string | null {
  const body = html.replace(/<(script|style|header|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  let best: { url: string; score: number } | null = null;
  for (const m of body.matchAll(/<img\b([^>]*)>/gi)) {
    const tag = m[1];
    const src = tagAttr(tag, 'src') || tagAttr(tag, 'data-src') || tagAttr(tag, 'data-image')
      || largestInSrcset(tagAttr(tag, 'srcset') || tagAttr(tag, 'data-srcset'));
    if (!src || /^data:/i.test(src) || /\.svg(\?|$)/i.test(src)) continue;
    const context = `${src} ${tagAttr(tag, 'alt') || ''} ${tagAttr(tag, 'class') || ''} ${tagAttr(tag, 'id') || ''}`;
    if (IMAGE_NOISE_RE.test(context)) continue;
    const w = parseInt(tagAttr(tag, 'width') || '0', 10) || 0;
    const h = parseInt(tagAttr(tag, 'height') || '0', 10) || 0;
    if ((w > 0 && w < 200) || (h > 0 && h < 200)) continue;
    let score = Math.max(w, h) || 100;
    if (/product|gallery|hero|main|primary|feature/i.test(context)) score += 500;
    if (!best || score > best.score) best = { url: src, score };
  }
  return best?.url ?? null;
}

export function extractProduct(html: string, pageUrl?: string): ExtractedProduct {
  const ld = findJsonLdProduct(html);
  const og = {
    image: metaContent(html, 'og:image'),
    description: metaContent(html, 'og:description') || metaContent(html, 'description'),
    title: metaContent(html, 'og:title'),
  };
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || null;

  const description = (ld?.description ? stripTags(String(ld.description)) : null)
    || (og.description ? stripTags(og.description) : null);

  // Image, most-declared first: the page's own structured metadata, then its
  // embedded product JSON, then the best <img> in the body. A relative hit
  // is resolved against the page URL, since the importer fetches it directly.
  const rawImage = jsonLdImageUrl(ld?.image) || og.image || metaContent(html, 'twitter:image')
    || html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i)?.[1]
    || embeddedJsonImage(html) || bodyImageUrl(html) || null;
  let imageUrl = rawImage;
  if (rawImage && pageUrl) {
    try { imageUrl = new URL(decodeEntities(rawImage), pageUrl).toString(); } catch { imageUrl = null; }
  }

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
    // A SHORT shell is usually a soft 404 — plenty of sites answer an unknown
    // path with an empty 200 skeleton rather than a real 404, so the first
    // suspect is the URL, not the vendor. (Learned the hard way on
    // cve.holman.com: a root-level slug returned 0.8 KB of nothing while the
    // site's own /shelving/<product> URLs serve real markup.)
    const kb = (trimmed.length / 1024).toFixed(1);
    if (trimmed.length < 5000) {
      return { verdict: 'js-shell', detail: `The server returned a bare ${kb} KB skeleton — no <title>, no <h1>, no text. That is usually what a site sends for a URL THAT DOESN'T EXIST, so check the address first: open the vendor's own menu and copy a product link from it (they often nest products under a category, e.g. /shelving/steel-shelving-unit, rather than at the site root). If a link straight from their navigation does the same thing, then the page really is drawn by JavaScript the importer doesn't run.` };
    }
    return { verdict: 'js-shell', detail: `The served HTML is an app shell — no <title>, no <h1>, only ${text.length} characters of text in ${kb} KB — so the product details are drawn by JavaScript, which the importer doesn't run. This vendor needs a product feed or a different page source.` };
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

// ── Physical dimensions (upfit configurator, migration 213) ─────────────────

export interface ExtractedDimensions {
  widthIn?: number;
  depthIn?: number;
  heightIn?: number;
  weightLb?: number;
}

/** Anything outside these bands is a scrape artifact (a SKU digit run, a
 *  price, a year), not a shelving dimension — refuse it. */
const dimSane = (n: number): boolean => Number.isFinite(n) && n >= 0.5 && n <= 300;
const weightSane = (n: number): boolean => Number.isFinite(n) && n >= 0.1 && n <= 2000;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Unit → inches multiplier. UN/CEFACT codes (JSON-LD unitCode) and the
 *  words/abbreviations sites put in unitText or prose. Default is inches —
 *  US van-equipment vendors publish inches when they say nothing. */
function lengthToInches(value: number, unit: string | null | undefined): number {
  const u = (unit || '').trim().toUpperCase();
  if (u === 'CMT' || u === 'CM' || u === 'CENTIMETER' || u === 'CENTIMETERS') return value / 2.54;
  if (u === 'MMT' || u === 'MM' || u === 'MILLIMETER' || u === 'MILLIMETERS') return value / 25.4;
  if (u === 'MTR' || u === 'M' || u === 'METER' || u === 'METERS') return value * 39.3701;
  if (u === 'FOT' || u === 'FT' || u === 'FOOT' || u === 'FEET') return value * 12;
  return value; // INH, IN, INCH, '', unknown → inches
}

function weightToPounds(value: number, unit: string | null | undefined): number {
  const u = (unit || '').trim().toUpperCase();
  if (u === 'KGM' || u === 'KG' || u === 'KILOGRAM' || u === 'KILOGRAMS') return value * 2.20462;
  if (u === 'GRM' || u === 'G' || u === 'GRAM' || u === 'GRAMS') return value * 0.00220462;
  if (u === 'ONZ' || u === 'OZ' || u === 'OUNCE' || u === 'OUNCES') return value / 16;
  return value; // LBR, LB, LBS, '', unknown → pounds
}

/** A JSON-LD dimension: a bare number, a string ("48", "48 in", "121.9 cm"),
 *  or a QuantitativeValue { value, unitCode?, unitText? }. */
function qvToNumber(v: any, convert: (value: number, unit: string | null | undefined) => number): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return convert(v, null);
  if (typeof v === 'string') {
    const m = v.match(/(\d+(?:\.\d+)?)\s*([a-z]*)/i);
    return m ? convert(parseFloat(m[1]), m[2] || null) : null;
  }
  if (typeof v === 'object') {
    const value = typeof v.value === 'number' ? v.value : parseFloat(String(v.value ?? ''));
    if (!Number.isFinite(value)) return null;
    return convert(value, v.unitCode || v.unitText || null);
  }
  return null;
}

/** Inch-ish number token: 52, 52.5, 52", 52″, 52 in, 52-1/2 stays out (mixed
 *  fractions are rare on the pages we crawl and mis-parse as two numbers). */
const NUM = '(\\d+(?:\\.\\d+)?)';
const INCH_MARK = '(?:"|″|”|\\s*(?:in\\.?|inch(?:es)?))?';

/**
 * Physical dimensions off a vendor product page, most-declared first —
 * same trust ladder as extractProduct:
 *   1. JSON-LD Product width/depth/height/weight (QuantitativeValue-aware)
 *   2. JSON-LD additionalProperty PropertyValue rows named Width/Depth/Height
 *   3. Letter-tagged compact prose: 52"W x 14"D x 46"H (Ranger's format), in
 *      any order, × or x, unicode inch marks included
 *   4. Labeled prose: "Width: 52 in … Depth: 14 … Height: 46"
 * Sources merge PER FIELD (a page may declare width in JSON-LD and the rest
 * in prose); insane values (a year, a price) are dropped by range check.
 * Returns null when no dimension survived — callers that need a placeable
 * part gate on all three of width/depth/height being present.
 */
export function extractDimensions(html: string): ExtractedDimensions | null {
  const out: ExtractedDimensions = {};
  const setDim = (key: 'widthIn' | 'depthIn' | 'heightIn', val: number | null | undefined) => {
    if (out[key] === undefined && val != null && dimSane(val)) out[key] = round2(val);
  };

  // 1. JSON-LD explicit dimension properties.
  const ld = findJsonLdProduct(html);
  if (ld) {
    setDim('widthIn', qvToNumber(ld.width, lengthToInches));
    setDim('depthIn', qvToNumber(ld.depth, lengthToInches));
    setDim('heightIn', qvToNumber(ld.height, lengthToInches));
    const wt = qvToNumber(ld.weight, weightToPounds);
    if (wt != null && weightSane(wt)) out.weightLb = round2(wt);

    // 2. additionalProperty PropertyValue rows.
    const props = Array.isArray(ld.additionalProperty) ? ld.additionalProperty : ld.additionalProperty ? [ld.additionalProperty] : [];
    for (const p of props) {
      const name = String(p?.name || '').toLowerCase();
      if (!name) continue;
      if (/\bwidth\b/.test(name)) setDim('widthIn', qvToNumber(p.value ?? p, lengthToInches));
      else if (/\bdepth\b/.test(name)) setDim('depthIn', qvToNumber(p.value ?? p, lengthToInches));
      else if (/\bheight\b/.test(name)) setDim('heightIn', qvToNumber(p.value ?? p, lengthToInches));
      else if (/\bweight\b/.test(name) && out.weightLb === undefined) {
        const w = qvToNumber(p.value ?? p, weightToPounds);
        if (w != null && weightSane(w)) out.weightLb = round2(w);
      }
    }
  }

  // 3 + 4. Prose, over the visible text (scripts/styles cut so a JSON blob's
  // coordinates can't masquerade as inches).
  const text = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');

  // Letter-tagged tokens: 52"W / 14" D / 46 in H, joined by x/× or just
  // nearby — capture each (number, letter) pair independently so any order
  // works (52"W x 14"D x 46"H, 46"H x 52"W…).
  for (const m of text.matchAll(new RegExp(`${NUM}\\s*${INCH_MARK}\\s*([WDH])(?:idth|epth|eight)?\\b`, 'gi'))) {
    const val = parseFloat(m[1]);
    const letter = m[2].toUpperCase();
    if (letter === 'W') setDim('widthIn', val);
    else if (letter === 'D') setDim('depthIn', val);
    else if (letter === 'H') setDim('heightIn', val);
  }

  // Labeled prose: "Width: 52 in". The [^0-9]{0,12} gap absorbs colons,
  // dashes and unit prefixes without jumping to an unrelated number.
  const labeled = (label: string): number | null => {
    const m = text.match(new RegExp(`\\b${label}\\b[^0-9]{0,12}${NUM}\\s*(cm|mm|in\\.?|inch(?:es)?|ft)?`, 'i'));
    return m ? lengthToInches(parseFloat(m[1]), m[2] || null) : null;
  };
  setDim('widthIn', labeled('width'));
  setDim('depthIn', labeled('depth'));
  setDim('heightIn', labeled('height'));
  if (out.weightLb === undefined) {
    const m = text.match(new RegExp(`\\bweight\\b[^0-9]{0,12}${NUM}\\s*(kg|g|oz|lbs?|pounds?)?`, 'i'));
    if (m) {
      const w = weightToPounds(parseFloat(m[1]), m[2] || null);
      if (weightSane(w)) out.weightLb = round2(w);
    }
  }

  return Object.keys(out).length > 0 ? out : null;
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
