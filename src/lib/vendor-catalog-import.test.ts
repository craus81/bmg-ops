import { describe, it, expect } from 'vitest';
import { extractProduct, parseSitemapLocs, matchSkuToPart, skuKeys, looksLikeProductUrl } from './vendor-catalog-import';

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

describe('looksLikeProductUrl', () => {
  it('keeps product paths, drops assets and blogs', () => {
    expect(looksLikeProductUrl('https://x.com/products/3-shelf-unit')).toBe(true);
    expect(looksLikeProductUrl('https://x.com/blog/van-tips')).toBe(false);
    expect(looksLikeProductUrl('https://x.com/products/spec.pdf')).toBe(false);
  });
});
