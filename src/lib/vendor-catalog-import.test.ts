import { describe, it, expect } from 'vitest';
import {
  extractProduct, parseSitemapLocs, matchSkuToPart, skuKeys,
  looksLikeProductUrl, looksLikeListingUrl, extractSameOriginLinks,
  extractPaginationLinks, originVariants,
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
