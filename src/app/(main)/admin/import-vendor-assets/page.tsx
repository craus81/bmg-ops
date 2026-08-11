'use client';

import { useState, useEffect, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';
import { ensureScheme } from '@/lib/vendor-catalog-import';

/**
 * Admin front-end for /api/parts/import-vendor-assets (N4-A): pull product
 * photos + descriptions from a vendor's site onto the matching parts.
 * Three steps mirror the API's modes — probe one page to verify extraction,
 * discover product URLs from the sitemap, then run the import in batches
 * with live progress. SKU matching is exact-or-dashless only, so the worst
 * case is "no match", never a wrong photo.
 */

interface MatchedPart { itemNumber: string; vendor: string | null; inScope: boolean; active?: boolean }

interface ProbeResult {
  product: { name: string | null; description: string | null; imageUrl: string | null; sku: string | null };
  matchedPartId: string | null;
  matchedPart?: MatchedPart | null;
  /** Family pages (one page, a table of variant part numbers) match many. */
  matchedParts?: MatchedPart[];
  /** How many catalog parts the match ran against — a suspiciously round
   *  number here (1000…) means the part read is being truncated. */
  catalogSearched?: { active: number; all: number };
  /** No match → the catalog rows nearest this SKU (spelling/active truth). */
  closest?: { itemNumber: string; active: boolean; vendor: string | null }[];
}

interface RunRow { url: string; ok: boolean; partId?: string; sku?: string | null; matched?: number; imported?: string[]; error?: string; nearItemNumber?: string }

const BATCH = 25;

export default function ImportVendorAssetsPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const dialog = useDialog();

  const [siteUrl, setSiteUrl] = useState('https://www.rangerdesign.com');
  // Blank = match by part number across the whole catalog. NetSuite's
  // item-record vendor field is often blank, so a prefilled filter can
  // silently exclude everything — opt in only when you know the values.
  const [vendorScope, setVendorScope] = useState('');
  // Vendor name stamped onto matched parts whose vendor is blank — we know
  // whose site the assets came from (Craig 2026-08-11). Fill-blank only.
  // Picked from NetSuite's vendor list so names match exactly; free text
  // only as a fallback when the list can't load.
  const [setVendorName, setSetVendorName] = useState('');
  const [nsVendors, setNsVendors] = useState<{ id: string; name: string }[] | null>(null);
  const [nsVendorsError, setNsVendorsError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/netsuite/vendors')
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (cancelled) return;
        if (ok && Array.isArray(d.vendors) && d.vendors.length > 0) setNsVendors(d.vendors);
        else { setNsVendors([]); setNsVendorsError(d?.error || 'No vendors returned'); }
      })
      .catch(e => { if (!cancelled) { setNsVendors([]); setNsVendorsError(e?.message || 'Vendor list failed'); } });
    return () => { cancelled = true; };
  }, []);
  const [overwrite, setOverwrite] = useState(false);

  const [probeUrl, setProbeUrl] = useState('');
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeError, setProbeError] = useState('');

  const [discovering, setDiscovering] = useState(false);
  const [urls, setUrls] = useState<string[]>([]);
  const [discoverError, setDiscoverError] = useState('');
  const [discoverVia, setDiscoverVia] = useState<'sitemap' | 'crawl' | 'listing' | ''>('');
  const [discoverChecked, setDiscoverChecked] = useState<string[]>([]);
  const [listingUrlsText, setListingUrlsText] = useState('');

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [imagesSaved, setImagesSaved] = useState(0);
  const [descriptionsSaved, setDescriptionsSaved] = useState(0);
  const [vendorsTagged, setVendorsTagged] = useState(0);
  const [matchedCount, setMatchedCount] = useState(0);
  const [failures, setFailures] = useState<RunRow[]>([]);
  const [ranTotal, setRanTotal] = useState(0);

  if (isAdmin === false) { router.push('/home'); return null; }

  const post = async (body: unknown) => {
    const res = await fetch('/api/parts/import-vendor-assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d) throw new Error(d?.error || `HTTP ${res.status}`);
    return d;
  };

  const doProbe = async () => {
    if (!probeUrl.trim()) return;
    setProbing(true);
    setProbe(null);
    setProbeError('');
    try {
      setProbe(await post({ mode: 'probe', url: ensureScheme(probeUrl), vendor: vendorScope.trim() || undefined }));
    } catch (e: any) {
      setProbeError(e?.message || 'Probe failed');
    }
    setProbing(false);
  };

  const doDiscover = async () => {
    // Teach mode: category page URLs (one per line) override sitemap/crawl.
    // Scheme optional — pasted hostnames get https:// prepended, not dropped.
    const listingUrls = listingUrlsText
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.includes('.'))
      .map(ensureScheme)
      .slice(0, 20);
    setDiscovering(true);
    setDiscoverError('');
    setUrls([]);
    setDiscoverVia('');
    setDiscoverChecked([]);
    try {
      const d = await post({
        mode: 'discover',
        baseUrl: ensureScheme(siteUrl),
        listingUrls: listingUrls.length > 0 ? listingUrls : undefined,
      });
      setUrls(d.urls || []);
      setDiscoverVia(d.via || '');
      setDiscoverChecked(d.checked || []);
      if ((d.urls || []).length === 0) {
        setDiscoverError(listingUrls.length > 0
          ? 'No product links found on those category pages — check "What was checked" below for what each page returned.'
          : 'No product pages found via sitemaps or a site crawl. Paste one or more category page URLs into the box above (one per line) and try again — I’ll harvest product links straight from them, pagination included.');
      }
    } catch (e: any) {
      setDiscoverError(e?.message || 'Discovery failed');
    }
    setDiscovering(false);
  };

  // Shared batch runner. A near-miss retry ADDS to the finished run's
  // tallies and replaces just the retried failure rows; a fresh run resets.
  const runBatches = async (urlList: string[], opts: { nearMatch?: boolean } = {}) => {
    setRunning(true);
    setProgress({ done: 0, total: urlList.length });
    let images = opts.nearMatch ? imagesSaved : 0;
    let descriptions = opts.nearMatch ? descriptionsSaved : 0;
    let matched = opts.nearMatch ? matchedCount : 0;
    let vendors = opts.nearMatch ? vendorsTagged : 0;
    const retried = new Set(urlList);
    const failed: RunRow[] = opts.nearMatch ? failures.filter(f => !retried.has(f.url)) : [];
    if (!opts.nearMatch) {
      setImagesSaved(0);
      setDescriptionsSaved(0);
      setMatchedCount(0);
      setVendorsTagged(0);
      setFailures([]);
      setRanTotal(urlList.length);
    }

    for (let i = 0; i < urlList.length; i += BATCH) {
      const chunk = urlList.slice(i, i + BATCH);
      try {
        const d = await post({
          mode: 'run',
          urls: chunk,
          vendor: vendorScope.trim() || undefined,
          overwrite: overwrite || undefined,
          nearMatch: opts.nearMatch || undefined,
          setVendor: setVendorName.trim() || undefined,
        });
        images += d.imagesSaved || 0;
        descriptions += d.descriptionsSaved || 0;
        vendors += d.vendorsSet || 0;
        for (const r of (d.results || []) as RunRow[]) {
          if (r.ok) matched += r.matched ?? 1; // family pages can match several parts
          else failed.push(r);
        }
      } catch (e: any) {
        failed.push({ url: `(batch of ${chunk.length} failed)`, ok: false, error: e?.message || 'request failed' });
      }
      setProgress({ done: Math.min(i + BATCH, urlList.length), total: urlList.length });
      setImagesSaved(images);
      setDescriptionsSaved(descriptions);
      setMatchedCount(matched);
      setVendorsTagged(vendors);
      setFailures([...failed]);
    }
    setRunning(false);
    setProgress(null);
  };

  const doRun = async () => {
    if (urls.length === 0) return;
    const ok = await dialog.confirm(
      `Import from ${urls.length} product page${urls.length !== 1 ? 's' : ''}? Photos and descriptions land on parts whose part number matches the page's SKU${vendorScope.trim() ? ` (matching only "${vendorScope.trim()}" parts)` : ''}.${setVendorName.trim() ? ` Matched parts with no vendor get tagged "${setVendorName.trim()}".` : ''} ${overwrite ? 'Existing photos/descriptions WILL be replaced.' : 'Existing photos/descriptions are kept; only blanks fill in.'} Pages are fetched politely (~1/sec), so this takes a while.`,
      { confirmLabel: 'Start import' },
    );
    if (!ok) return;
    await runBatches(urls);
  };

  // Re-run just the pages whose SKU sits inside exactly one catalog part
  // number (or vice versa) with containment matching enabled.
  const doNearRetry = async () => {
    const list = failures.filter(f => f.nearItemNumber && !f.url.startsWith('(')).map(f => f.url);
    if (list.length === 0) return;
    const ok = await dialog.confirm(
      `Retry ${list.length} unmatched page${list.length !== 1 ? 's' : ''} with prefix/suffix matching?\n\nA page SKU then also matches when exactly ONE catalog part number contains it (or vice versa) — e.g. page 0091065 → catalog BP-0091065. Anything ambiguous still refuses to match, so a photo can't land on the wrong part.`,
      { confirmLabel: 'Retry near-misses' },
    );
    if (!ok) return;
    await runBatches(list, { nearMatch: true });
  };

  const card: CSSProperties = { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 16, marginBottom: 16 };
  const label: CSSProperties = { display: 'block', fontSize: 12, color: theme.textSecondary, marginBottom: 4, fontWeight: 600 };
  const input: CSSProperties = { width: '100%', background: theme.inputBg, color: theme.textPrimary, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 14 };
  const btn: CSSProperties = { background: theme.orange, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer' };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 16, color: theme.textPrimary }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Import Vendor Assets</h1>
      <p style={{ color: theme.textSecondary, fontSize: 14, marginBottom: 16 }}>
        Pull product <strong>photos and descriptions</strong> from a vendor&apos;s website onto the matching parts in the catalog —
        so the estimate browser looks like the vendor&apos;s own site. Matching is by exact part number (SKU), so the worst case
        is &quot;no match&quot;, never a wrong photo. Works for any vendor whose parts we carry (Ranger Design, Masterack, …).
      </p>

      {/* Setup */}
      <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <div>
          <label style={label}>Vendor website *</label>
          <input style={input} value={siteUrl} onChange={e => setSiteUrl(e.target.value)} placeholder="https://www.rangerdesign.com" />
        </div>
        <div>
          <label style={label}>Tag matched parts with this vendor (optional)</label>
          {nsVendors === null || nsVendors.length > 0 ? (
            <select
              style={input}
              value={setVendorName}
              onChange={e => setSetVendorName(e.target.value)}
              disabled={nsVendors === null}
            >
              <option value="">{nsVendors === null ? 'Loading NetSuite vendors…' : 'Don’t tag vendors'}</option>
              {(nsVendors || []).map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
            </select>
          ) : (
            <>
              <input style={input} value={setVendorName} onChange={e => setSetVendorName(e.target.value)} placeholder="e.g. Masterack — fills blank vendors only" />
              <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 2 }}>
                NetSuite vendor list unavailable ({nsVendorsError}) — type the name carefully.
              </div>
            </>
          )}
        </div>
        <div>
          <label style={label}>Match only parts whose vendor contains… (optional)</label>
          <input style={input} value={vendorScope} onChange={e => setVendorScope(e.target.value)} placeholder="blank = all parts (matching is by exact part number)" />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 4 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />
            Replace existing photos/descriptions
          </label>
        </div>
      </div>

      {/* Step 1: probe */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>1 · Test one product page</div>
        <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10 }}>
          Paste any product page URL from the vendor&apos;s site to verify we can read it before running the whole catalog.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...input, flex: 1 }} value={probeUrl} onChange={e => setProbeUrl(e.target.value)} placeholder={`${siteUrl.replace(/\/$/, '')}/products/…`} />
          <button style={{ ...btn, opacity: probing ? 0.6 : 1 }} onClick={doProbe} disabled={probing}>{probing ? 'Reading…' : 'Probe'}</button>
        </div>
        {probeError && <div style={{ marginTop: 8, fontSize: 12, color: theme.warning }}>{probeError}</div>}
        {probe && (
          <div style={{ display: 'flex', gap: 14, marginTop: 12, alignItems: 'flex-start' }}>
            {probe.product.imageUrl
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={probe.product.imageUrl} alt="" style={{ width: 120, height: 90, objectFit: 'cover', borderRadius: 8, border: `1px solid ${theme.border}` }} />
              : <div style={{ width: 120, height: 90, borderRadius: 8, border: `1px dashed ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: theme.textMuted }}>no image</div>}
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <div><strong>{probe.product.name || '(no name found)'}</strong></div>
              <div style={{ fontFamily: 'monospace', fontSize: 12 }}>SKU: {probe.product.sku || '—'}</div>
              <div style={{ color: probe.matchedPartId ? theme.success : theme.warning, fontWeight: 700, fontSize: 12 }}>
                {probe.matchedPartId
                  ? (probe.matchedParts && probe.matchedParts.length > 1
                    ? `✓ matches ${probe.matchedParts.length} parts in our catalog: ${probe.matchedParts.slice(0, 6).map(p => `${p.itemNumber}${p.active === false ? ' (inactive)' : ''}`).join(', ')}${probe.matchedParts.length > 6 ? ` +${probe.matchedParts.length - 6} more` : ''}`
                    : `✓ matches ${probe.matchedPart?.itemNumber || 'a part'} in our catalog${probe.matchedPart?.vendor ? ` (vendor: ${probe.matchedPart.vendor})` : ''}`)
                  : probe.product.sku ? '✗ no part with this number' : '✗ no SKU on the page'}
              </div>
              {(() => {
                const inactive = (probe.matchedParts || (probe.matchedPart ? [probe.matchedPart] : [])).filter(p => p.active === false);
                if (inactive.length === 0) return null;
                return (
                  <div style={{ color: theme.warning, fontWeight: 700, fontSize: 12 }}>
                    ⚠ {inactive.length === 1 ? `${inactive[0].itemNumber} is INACTIVE` : `${inactive.length} of these parts are INACTIVE`} in the catalog —
                    the import only stamps active parts. Reactivate in NetSuite, let the parts sync run, then re-import.
                  </div>
                );
              })()}
              {probe.catalogSearched && (
                <div style={{ fontSize: 11, color: theme.textMuted }}>
                  searched {probe.catalogSearched.active.toLocaleString()} active parts ({probe.catalogSearched.all.toLocaleString()} incl. inactive)
                </div>
              )}
              {!probe.matchedPartId && probe.closest && (
                <div style={{ fontSize: 12, marginTop: 2 }}>
                  {probe.closest.length > 0 ? (
                    <>
                      <span style={{ color: theme.textSecondary, fontWeight: 700 }}>Closest catalog numbers: </span>
                      <span style={{ fontFamily: 'monospace' }}>
                        {probe.closest.map(c => `${c.itemNumber}${c.active ? '' : ' (inactive)'}`).join(', ')}
                      </span>
                    </>
                  ) : (
                    <span style={{ color: theme.textMuted }}>Nothing in the catalog contains this number&apos;s core.</span>
                  )}
                </div>
              )}
              {(() => {
                const out = (probe.matchedParts || (probe.matchedPart ? [probe.matchedPart] : [])).filter(p => !p.inScope);
                if (out.length === 0) return null;
                return (
                  <div style={{ color: theme.warning, fontWeight: 700, fontSize: 12 }}>
                    ⚠ {out.length === 1
                      ? `${out[0].itemNumber}'s vendor is ${out[0].vendor ? `“${out[0].vendor}”` : 'blank'}, which doesn't contain “${vendorScope.trim()}”`
                      : `${out.length} of these parts have vendors that don't contain “${vendorScope.trim()}”`}
                    {' '}— the import would skip {out.length === 1 ? 'it' : 'them'}. Clear or fix the vendor box above.
                  </div>
                );
              })()}
              {probe.product.description && <div style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>{probe.product.description.slice(0, 220)}{probe.product.description.length > 220 ? '…' : ''}</div>}
            </div>
          </div>
        )}
      </div>

      {/* Step 2: discover */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>2 · Find the product pages</div>
        <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10 }}>
          Reads the site&apos;s sitemap and collects product page URLs. If that comes up empty (some sites hide their
          sitemap and build their menus with scripts we can&apos;t read), paste <strong>category page URLs</strong> below —
          one per line — and product links are harvested straight from those pages instead, pagination and sibling
          categories included.
        </div>
        <textarea
          style={{ ...input, minHeight: 64, fontFamily: 'monospace', fontSize: 12, marginBottom: 10, resize: 'vertical' }}
          value={listingUrlsText}
          onChange={e => setListingUrlsText(e.target.value)}
          placeholder={`Optional — category pages, one per line, e.g.\n${siteUrl.replace(/\/$/, '')}/product-category/van-shelving-gallery/`}
        />
        <button style={{ ...btn, opacity: discovering ? 0.6 : 1 }} onClick={doDiscover} disabled={discovering || !siteUrl.trim()}>
          {discovering ? 'Scanning…' : 'Find product pages'}
        </button>
        {discoverError && (
          <div style={{ marginTop: 8, fontSize: 12, color: theme.warning }}>
            {discoverError}
            {discoverChecked.length > 0 && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: 'pointer' }}>What was checked</summary>
                <div style={{ fontFamily: 'monospace', fontSize: 10, color: theme.textMuted, marginTop: 4 }}>
                  {discoverChecked.map(c => <div key={c}>{c}</div>)}
                </div>
              </details>
            )}
          </div>
        )}
        {urls.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            Found <strong>{urls.length.toLocaleString()}</strong> product page{urls.length !== 1 ? 's' : ''}
            {discoverVia && <span style={{ color: theme.textMuted, fontSize: 11 }}> · via {discoverVia === 'crawl' ? 'site crawl' : discoverVia === 'listing' ? 'your category pages' : 'sitemap'}</span>}.
            <div style={{ marginTop: 6, fontSize: 11, fontFamily: 'monospace', color: theme.textMuted, maxHeight: 100, overflow: 'auto' }}>
              {urls.slice(0, 8).map(u => <div key={u}>{u}</div>)}
              {urls.length > 8 && <div>… and {(urls.length - 8).toLocaleString()} more</div>}
            </div>
            {discoverChecked.length > 0 && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12, color: theme.textSecondary }}>What was checked</summary>
                <div style={{ fontFamily: 'monospace', fontSize: 10, color: theme.textMuted, marginTop: 4 }}>
                  {discoverChecked.map(c => <div key={c}>{c}</div>)}
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      {/* Step 3: run */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>3 · Run the import</div>
        <button style={{ ...btn, background: theme.success, opacity: running || urls.length === 0 ? 0.5 : 1 }} onClick={doRun} disabled={running || urls.length === 0}>
          {running ? 'Importing…' : urls.length > 0 ? `Import from ${urls.length.toLocaleString()} pages` : 'Find product pages first'}
        </button>
        {progress && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>{progress.done} / {progress.total} pages · {matchedCount} parts matched · {imagesSaved} photos · {descriptionsSaved} descriptions{vendorsTagged > 0 ? ` · ${vendorsTagged} vendors tagged` : ''}</div>
            <div style={{ height: 8, background: theme.progressTrack, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(progress.done / progress.total) * 100}%`, background: theme.orange }} />
            </div>
          </div>
        )}
        {!running && ranTotal > 0 && (
          <div style={{ marginTop: 12, fontSize: 14 }}>
            Done — <strong>{matchedCount}</strong> catalog part{matchedCount !== 1 ? 's' : ''} matched across {ranTotal.toLocaleString()} pages · <strong>{imagesSaved}</strong> photos and <strong>{descriptionsSaved}</strong> descriptions saved{vendorsTagged > 0 ? <> · <strong>{vendorsTagged}</strong> part{vendorsTagged !== 1 ? 's' : ''} tagged &quot;{setVendorName.trim()}&quot;</> : null}.
            <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 4 }}>
              Unmatched pages are normal — vendors list plenty of products we don&apos;t carry. Open the estimate builder&apos;s Browse Catalog to see the results.
            </div>
            {(() => {
              const near = failures.filter(f => f.nearItemNumber);
              if (near.length === 0) return null;
              return (
                <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', fontSize: 12, lineHeight: 1.5 }}>
                  <strong>{near.length}</strong> unmatched page{near.length !== 1 ? 's' : ''} look like <strong>prefix/suffix near-misses</strong> —
                  the page&apos;s SKU sits inside exactly one catalog part number (or the other way around):
                  <div style={{ fontFamily: 'monospace', fontSize: 11, margin: '6px 0', color: theme.textSecondary }}>
                    {near.slice(0, 4).map(f => <div key={f.url}>page {f.sku} ↔ catalog {f.nearItemNumber}</div>)}
                    {near.length > 4 && <div>… and {near.length - 4} more</div>}
                  </div>
                  <button onClick={doNearRetry} disabled={running} style={{ ...btn, padding: '8px 16px', fontSize: 12 }}>
                    Retry {near.length} near-miss page{near.length !== 1 ? 's' : ''} with this matching
                  </button>
                </div>
              );
            })()}
            {failures.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ fontSize: 12, cursor: 'pointer', color: theme.textSecondary }}>{failures.length} skipped/failed pages</summary>
                <div style={{ marginTop: 6, fontSize: 11, fontFamily: 'monospace', color: theme.textMuted, maxHeight: 160, overflow: 'auto' }}>
                  {failures.slice(0, 200).map((f, i) => (
                    <div key={i}>{f.url} — {f.error}{f.sku ? ` (SKU: ${f.sku})` : ''}{f.nearItemNumber ? ` — near-miss: ${f.nearItemNumber}` : ''}</div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
