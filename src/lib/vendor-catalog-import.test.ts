import { describe, it, expect } from 'vitest';
import {
  extractProduct, extractAllSkus, parseSitemapLocs, matchSkuToPart, skuKeys,
  looksLikeProductUrl, looksLikeListingUrl, extractSameOriginLinks,
  extractPaginationLinks, originVariants, skuCandidatesFromUrl,
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
});
