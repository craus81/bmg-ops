import { describe, it, expect } from 'vitest';
import {
  extractProduct, extractAllSkus, parseSitemapLocs, matchSkuToPart, skuKeys,
  looksLikeProductUrl, looksLikeListingUrl, looksLikeProductUnder,
  extractSameOriginLinks, extractPaginationLinks, originVariants,
  skuCandidatesFromUrl, ensureScheme, nearMatchSkuToPart, diagnosePage,
} from './vendor-catalog-import';

// Extraction is written blind to any one vendor's HTML — pin the layered
// signals (JSON-LD > OpenGraph > <title>) and the never-fuzzy SKU match.

const LD_PAGE = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"Organization","name":"Ranger Design"},
  {"@type":"Product","name":"3 Shelf Unit, 48\\" W","sku":"C4-RA24-3",
   "description":"<p>Heavy-duty &amp; adjustable shelving for cargo vans.</p>",
   "image":[{"@type":"ImageObject","url":"https://cdn.example.com/shelf.jpg"}]}
]}</script>
<meta property="og:image" content="https://cdn.example.com/og.jpg"/>
<title>Ignored</title></head></html>`;

const OG_PAGE = `<html><head>
<meta content="https://cdn.example.com/rack.webp" property="og:image"/>
<meta property="og:description" content="Max Rack drop-down ladder rack for vans &amp; trucks."/>
<meta property="og:title" content="Max Rack"/>
<title>Max Rack | Vendor</title></head></html>`;

describe('extractProduct', () => {
  it('prefers JSON-LD Product (nested in @graph), strips tags and entities', () => {
    const p = extractProduct(LD_PAGE);
    expect(p.sku).toBe('C4-RA24-3');
    expect(p.name).toContain('3 Shelf Unit');
    expect(p.description).toBe('Heavy-duty & adjustable shelving for cargo vans.');
    expect(p.imageUrl).toBe('https://cdn.example.com/shelf.jpg');
  });

  it('falls back to OpenGraph when no JSON-LD product exists', () => {
    const p = extractProduct(OG_PAGE);
    expect(p.sku).toBeNull();
    expect(p.name).toBe('Max Rack');
    expect(p.imageUrl).toBe('https://cdn.example.com/rack.webp');
    expect(p.description).toContain('drop-down ladder rack');
  });

  it('returns nulls on a page with none of the signals', () => {
    const p = extractProduct('<html><body>hello</body></html>');
    expect(p.imageUrl).toBeNull();
    expect(p.sku).toBeNull();
  });

  it('reports a variant-list page\'s number instead of a bare dash', () => {
    const html = `<html><body><h1>Kit With Sills</h1>
      <span class="code">741-135-6441</span></body></html>`;
    expect(extractProduct(html).sku).toBe('741-135-6441');
  });

  it('asks twitter:image and <link rel="image_src"> before giving up on a photo', () => {
    expect(extractProduct('<html><head><meta name="twitter:image" content="https://cdn.example.com/t.jpg"></head></html>').imageUrl)
      .toBe('https://cdn.example.com/t.jpg');
    expect(extractProduct('<html><head><link rel="image_src" href="https://cdn.example.com/l.jpg"></head></html>').imageUrl)
      .toBe('https://cdn.example.com/l.jpg');
  });

  it('uses the page <h1> for the name before the site-suffixed <title>', () => {
    const html = `<html><head><title>Shelf Unit - 32" W x 46" H x 14" D | Holman</title></head>
      <body><h1>Shelf Unit - 32&quot; W x 46&quot; H x 14&quot; D</h1></body></html>`;
    expect(extractProduct(html).name).toBe('Shelf Unit - 32" W x 46" H x 14" D');
  });

  it('falls back to a visible WooCommerce sku span (class token, not sku_wrapper)', () => {
    const html = `<html><body>
      <span class="sku_wrapper">SKU: <span class="sku">OTC-U6036</span></span>
    </body></html>`;
    expect(extractProduct(html).sku).toBe('OTC-U6036');
  });
});

describe('extractAllSkus (family pages: one page, many part numbers)', () => {
  it('collects JSON-LD variant SKUs (ProductGroup + hasVariant + offers) and all sku spans, deduped', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"ProductGroup",
        "name":"Straight Tongue Couplers - 314","sku":"314",
        "hasVariant":[{"@type":"Product","sku":"0091060"},{"@type":"Product","sku":"0091065"}],
        "offers":[{"@type":"Offer","sku":"0091070"}]}</script>
      </head><body>
      <td class="sku">0091065</td>
      <td class="sku">0091075</td>
    </body></html>`;
    const skus = extractAllSkus(html);
    expect(skus).toContain('314');
    expect(skus).toContain('0091060');
    expect(skus).toContain('0091065');
    expect(skus).toContain('0091070');
    expect(skus).toContain('0091075');
    expect(skus.filter(s => s === '0091065')).toHaveLength(1);
  });

  it('returns an empty list when nothing sku-shaped exists', () => {
    expect(extractAllSkus('<html><body>hello</body></html>')).toEqual([]);
  });

  // legendsoftheroad.com: one product page, several real part numbers listed
  // as buyable options, none of them in JSON-LD or a class="sku" element.
  it('reads variant part numbers out of embedded platform JSON', () => {
    const html = `<html><head>
      <script>window.Static = {SQUARESPACE_CONTEXT: {"product":{"title":"LEGEND StabiliGrip | Kit With Sills",
        "variants":[{"sku":"741-135-6441","attributes":{"Option":"3 Pc"}},
                    {"sku":"741-135-6441.1","attributes":{"Option":"3 Pc - Dual Rear Wheels"}},
                    {"sku":"741-135-6441.2","attributes":{"Option":"3 Pc - Dual Side Doors"}}]}}};</script>
      </head><body><h1>LEGEND StabiliGrip | Kit With Sills | Transit 148"</h1></body></html>`;
    expect(extractAllSkus(html)).toEqual(['741-135-6441', '741-135-6441.1', '741-135-6441.2']);
  });

  it('reads bare option codes standing alone in their own element', () => {
    const html = `<html><body>
      <h1>LEGEND StabiliGrip | Kit With Sills | Transit 148"</h1>
      <div class="option"><span class="name">3 Pc</span><span class="code">741-135-6441</span></div>
      <div class="option"><span class="name">3 Pc - Dual Side Doors</span><span class="code">741-135-6441.2</span></div>
      <p>Field-proven in hundreds of thousands of cargo vans.</p>
      <span>0 items</span>
    </body></html>`;
    const skus = extractAllSkus(html);
    expect(skus).toContain('741-135-6441');
    expect(skus).toContain('741-135-6441.2');
    // Prose, labels and bare counts carry no separator — never candidates.
    expect(skus).not.toContain('0');
    expect(skus.every(s => /[.\-/]/.test(s))).toBe(true);
  });

  it('keeps the structured signal when one exists — bare tokens never override it', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Product","sku":"C4-RA24-3"}</script>
      </head><body><span class="code">741-135-6441</span><span>2026-08-17</span></body></html>`;
    expect(extractAllSkus(html)).toEqual(['C4-RA24-3']);
  });

  it('falls back to visible "Part #:" labels only when no structured SKU exists', () => {
    const labeled = `<html><body>
      <p><strong>Part #:</strong> 022824KP</p>
      <p>Part Number: <span>027561KP</span></p>
      <p>Part: One</p>
    </body></html>`;
    expect(extractAllSkus(labeled)).toEqual(['022824KP', '027561KP']);

    const withJsonLd = `<html><head>
      <script type="application/ld+json">{"@type":"Product","sku":"02T408KP"}</script>
      </head><body><strong>Part #:</strong> 999111ZZ</body></html>`;
    expect(extractAllSkus(withJsonLd)).toEqual(['02T408KP']);
  });
});

describe('skuCandidatesFromUrl (slug fallback, exact match downstream)', () => {
  it('yields trailing-token joins longest-first, part-number-looking only', () => {
    const c = skuCandidatesFromUrl('https://x.com/products/over-the-cab-truck-rack-36-extension-otc-u6036/');
    expect(c).toContain('OTC-U6036');
    expect(c).toContain('U6036');
    expect(c.indexOf('OTC-U6036')).toBeLessThan(c.indexOf('U6036'));
    // "36" alone: too short, no letter — never a candidate.
    expect(c).not.toContain('36');
  });

  it('survives percent-encoded characters in the slug', () => {
    const c = skuCandidatesFromUrl('https://x.com/products/shelving-36%e2%80%b3-wide-3-trays-n4-ra36-3x12/');
    expect(c).toContain('N4-RA36-3X12');
  });

  it('returns nothing for word-only slugs', () => {
    expect(skuCandidatesFromUrl('https://x.com/products/heavy-duty-van-shelving/')).toEqual([]);
  });

  // cve.holman.com names pages by size, not part number. "14-D" / "X-14-D"
  // carry a letter and a digit, so without the dimension guard they'd be
  // offered as SKUs — and a shelf's photo could land on catalog row 14D.
  it('drops dimension tails (…-32-w-x-46-h-x-14-d)', () => {
    expect(skuCandidatesFromUrl('https://cve.holman.com/shelf-unit-32-w-x-46-h-x-14-d')).toEqual([]);
    expect(skuCandidatesFromUrl('https://x.com/products/folding-shelf-unit-48-w-x-20-d')).toEqual([]);
  });

  it('still keeps a real part number that follows dimensions', () => {
    const c = skuCandidatesFromUrl('https://x.com/products/shelf-unit-32-w-x-14-d-48320a');
    expect(c).toContain('48320A');
    expect(c).not.toContain('14-D');
  });
});

describe('diagnosePage (why a page yielded nothing)', () => {
  it('names an anti-bot interstitial', () => {
    const incapsula = `<html><head><meta name="robots" content="noindex"></head><body>
      <iframe src="/_Incapsula_Resource?SWUDNSAI=31&xinfo=8-1234"></iframe>
      </body></html>`.padEnd(200, ' ');
    const d = diagnosePage(incapsula);
    expect(d.verdict).toBe('bot-wall');
    expect(d.detail).toContain('Incapsula');

    expect(diagnosePage(`<html><head><title>Just a moment...</title></head>
      <body><div class="cf-browser-verification"></div></body></html>`.padEnd(200, ' ')).verdict).toBe('bot-wall');
  });

  it('names a JavaScript app shell (no title, no h1, all script)', () => {
    const shell = `<html><head><meta charset="utf-8"><link rel="stylesheet" href="/a.css"></head>
      <body><div id="root"></div><script src="/bundle.js"></script>
      <script>window.__CFG__={api:"/graphql",locale:"en-US"}</script></body></html>`;
    const d = diagnosePage(shell);
    expect(d.verdict).toBe('js-shell');
    expect(d.detail).toContain('app shell');
  });

  it('calls an essentially empty body what it is', () => {
    expect(diagnosePage('<html><body></body></html>').verdict).toBe('empty');
  });

  it('says "readable" for a real page that simply has no part number', () => {
    const real = `<html><head><title>Shelf Unit | Vendor</title></head><body>
      <h1>Shelf Unit</h1>
      <p>${'Adjustable steel shelving for cargo vans, sold by the unit. '.repeat(12)}</p>
      </body></html>`;
    expect(diagnosePage(real).verdict).toBe('ok');
  });
});

describe('parseSitemapLocs', () => {
  it('reads urlset locs and flags sitemap indexes', () => {
    const index = parseSitemapLocs('<sitemapindex><sitemap><loc>https://x.com/a.xml</loc></sitemap></sitemapindex>');
    expect(index.isIndex).toBe(true);
    expect(index.locs).toEqual(['https://x.com/a.xml']);
    const urlset = parseSitemapLocs('<urlset><url><loc> https://x.com/products/shelf </loc></url></urlset>');
    expect(urlset.isIndex).toBe(false);
    expect(urlset.locs).toEqual(['https://x.com/products/shelf']);
  });
});

describe('SKU matching (never fuzzy — wrong photo is worse than none)', () => {
  const map = new Map<string, string>();
  for (const key of skuKeys('C4-RA24-3')) map.set(key, 'part-1');

  it('matches exact uppercase and dashless variants', () => {
    expect(matchSkuToPart('c4-ra24-3', map)).toBe('part-1');
    expect(matchSkuToPart('C4RA243', map)).toBe('part-1');
  });

  it('refuses near-misses', () => {
    expect(matchSkuToPart('C4-RA24', map)).toBeNull();
    expect(matchSkuToPart('C4-RA24-31', map)).toBeNull();
    expect(matchSkuToPart(null, map)).toBeNull();
  });
});

describe('nearMatchSkuToPart (unique containment only — the opt-in bridge)', () => {
  const map = new Map<string, string>();
  for (const key of skuKeys('BP-0091065')) map.set(key, 'buyers-1');
  for (const key of skuKeys('02T408KP')) map.set(key, 'masterack-1');

  it('bridges a vendor prefix (page 0091065 → catalog BP-0091065)', () => {
    expect(nearMatchSkuToPart('0091065', map)).toBe('buyers-1');
  });

  it('bridges a suffix the other way (page 02T408 → catalog 02T408KP)', () => {
    expect(nearMatchSkuToPart('02T408', map)).toBe('masterack-1');
  });

  it('bridges page-side extra tokens (page BP-0091065-XL → catalog BP-0091065)', () => {
    expect(nearMatchSkuToPart('BP-0091065-XL', map)).toBe('buyers-1');
  });

  it('refuses short SKUs and ambiguity', () => {
    expect(nearMatchSkuToPart('0091', map)).toBeNull();
    const ambiguous = new Map(map);
    for (const key of skuKeys('CP-0091065')) ambiguous.set(key, 'other-1');
    expect(nearMatchSkuToPart('0091065', ambiguous)).toBeNull();
    expect(nearMatchSkuToPart(null, map)).toBeNull();
  });
});

describe('looksLikeProductUrl / looksLikeListingUrl', () => {
  it('keeps product paths, drops assets and blogs', () => {
    expect(looksLikeProductUrl('https://x.com/products/3-shelf-unit')).toBe(true);
    expect(looksLikeProductUrl('https://x.com/blog/van-tips')).toBe(false);
    expect(looksLikeProductUrl('https://x.com/products/spec.pdf')).toBe(false);
  });

  it('classifies category/listing pages as listings, not products', () => {
    expect(looksLikeListingUrl('https://x.com/product-category/shelving/')).toBe(true);
    expect(looksLikeListingUrl('https://x.com/products/')).toBe(true);
    expect(looksLikeProductUrl('https://x.com/product-category/shelving/')).toBe(false);
    expect(looksLikeListingUrl('https://x.com/products/3-shelf-unit')).toBe(false);
  });

  it('treats pagination as a listing shape, never a product (masterack /catalog/page/N/)', () => {
    expect(looksLikeListingUrl('https://www.masterack.com/catalog/page/2/')).toBe(true);
    expect(looksLikeProductUrl('https://www.masterack.com/catalog/page/2/')).toBe(false);
    expect(looksLikeListingUrl('https://x.com/catalog/?page=3')).toBe(true);
    expect(looksLikeProductUrl('https://www.masterack.com/product/chevy-trax-cargo-partition/')).toBe(true);
  });

  it('drops assets and feeds from both classifications', () => {
    expect(looksLikeProductUrl('https://x.com/wp-content/plugins/x/assets/css/product/global.0f804f5f.css')).toBe(false);
    expect(looksLikeProductUrl('https://x.com/catalog/feed/')).toBe(false);
    expect(looksLikeListingUrl('https://x.com/catalog/theme.js')).toBe(false);
  });
});

describe('looksLikeProductUnder (teach mode: no /product/ segment anywhere)', () => {
  const listing = 'https://cve.holman.com/shelving';

  it('accepts a page one level under the category the admin pasted', () => {
    expect(looksLikeProductUnder(listing, 'https://cve.holman.com/shelving/steel-shelving-unit')).toBe(true);
    expect(looksLikeProductUrl('https://cve.holman.com/shelving/steel-shelving-unit')).toBe(false);
  });

  it('refuses anything not exactly one level down, or off-origin', () => {
    expect(looksLikeProductUnder(listing, 'https://cve.holman.com/shelving')).toBe(false);
    expect(looksLikeProductUnder(listing, 'https://cve.holman.com/shelving/a/b')).toBe(false);
    expect(looksLikeProductUnder(listing, 'https://cve.holman.com/van-equipment/partition')).toBe(false);
    expect(looksLikeProductUnder(listing, 'https://other.com/shelving/steel-shelving-unit')).toBe(false);
  });

  it('still refuses assets, cart actions and pagination', () => {
    expect(looksLikeProductUnder(listing, 'https://cve.holman.com/shelving/spec.pdf')).toBe(false);
    expect(looksLikeProductUnder(listing, 'https://cve.holman.com/shelving/unit?add-to-cart=12')).toBe(false);
    expect(looksLikeProductUnder(listing, 'https://cve.holman.com/shelving/page/2')).toBe(false);
  });

  it('chains from a paginated category page', () => {
    expect(looksLikeProductUnder('https://cve.holman.com/shelving/page/3', 'https://cve.holman.com/shelving/steel-shelving-unit')).toBe(true);
  });
});

describe('extractSameOriginLinks (crawl fallback)', () => {
  const html = `
    <a href="/products/shelf-1/">Shelf</a>
    <a href="https://x.com/product-category/racks/?page=2#top">Racks</a>
    <a href="https://other.com/products/external">External</a>
    <a href="mailto:sales@x.com">Mail</a>
    <a href="/products/shelf-1/">Duplicate</a>`;

  it('resolves relative links, stays same-origin, strips query/hash, dedupes', () => {
    const links = extractSameOriginLinks(html, 'https://x.com/');
    expect(links).toContain('https://x.com/products/shelf-1/');
    expect(links).toContain('https://x.com/product-category/racks/');
    expect(links).toHaveLength(2);
  });
});

describe('ensureScheme (pasted hostnames vs full URLs)', () => {
  it('prepends https:// only when a scheme is missing', () => {
    expect(ensureScheme('www.masterack.com')).toBe('https://www.masterack.com');
    expect(ensureScheme('  masterack.com/catalog/?category=partition#products ')).toBe('https://masterack.com/catalog/?category=partition#products');
    expect(ensureScheme('https://www.masterack.com')).toBe('https://www.masterack.com');
    expect(ensureScheme('http://x.com/a')).toBe('http://x.com/a');
  });
});

describe('originVariants (www and apex can behave differently)', () => {
  it('returns both spellings, input host first', () => {
    expect(originVariants('https://www.rangerdesign.com')).toEqual([
      'https://www.rangerdesign.com',
      'https://rangerdesign.com',
    ]);
    expect(originVariants('https://rangerdesign.com/some/page')).toEqual([
      'https://rangerdesign.com',
      'https://www.rangerdesign.com',
    ]);
  });
});

describe('extractPaginationLinks (teach mode fan-out)', () => {
  const listing = 'https://x.com/product-category/shelving/';
  const html = `
    <a href="/product-category/shelving/page/2/">2</a>
    <a href="https://x.com/product-category/shelving/?page=3#list">3</a>
    <a href="/product-category/racks/page/2/">other category</a>
    <a href="https://other.com/product-category/shelving/page/2/">external</a>
    <a href="/product-category/shelving/">current page</a>`;

  it('keeps /page/N and ?page=N on the same listing path only', () => {
    const links = extractPaginationLinks(html, listing);
    expect(links).toContain('https://x.com/product-category/shelving/page/2/');
    expect(links).toContain('https://x.com/product-category/shelving/?page=3');
    expect(links).toHaveLength(2);
  });

  it('chains through a paginated base: /products/page/4/ still yields page/5', () => {
    const midWalk = `
      <a href="/products/page/3/">prev</a>
      <a href="/products/page/5/">next</a>
      <a href="/products/page/470/">last</a>
      <a href="/other/page/5/">other section</a>`;
    const links = extractPaginationLinks(midWalk, 'https://x.com/products/page/4/');
    expect(links).toContain('https://x.com/products/page/5/');
    expect(links).toContain('https://x.com/products/page/470/');
    expect(links).not.toContain('https://x.com/other/page/5/');
  });

  it('strips cart-action decorations so page N is ONE page, not one per product card', () => {
    const woo = `
      <a href="/product-category/van-accessories-gallery/page/5/?add-to-cart=9340">Add</a>
      <a href="/product-category/van-accessories-gallery/page/5/?add-to-cart=9341">Add</a>
      <a href="/product-category/van-accessories-gallery/page/5/">5</a>
      <a href="/product-category/van-accessories-gallery/?page=6&add-to-cart=9342">6</a>`;
    const links = extractPaginationLinks(woo, 'https://x.com/product-category/van-accessories-gallery/');
    expect(links).toContain('https://x.com/product-category/van-accessories-gallery/page/5/');
    expect(links).toContain('https://x.com/product-category/van-accessories-gallery/?page=6');
    expect(links).toHaveLength(2);
  });
});

describe('cart-action URLs are never product or listing pages', () => {
  it('rejects add-to-cart decorated URLs in both classifiers', () => {
    expect(looksLikeListingUrl('https://x.com/product-category/racks/page/5/?add-to-cart=9340')).toBe(false);
    expect(looksLikeProductUrl('https://x.com/products/shelf-1/?add-to-cart=9340')).toBe(false);
  });
});
