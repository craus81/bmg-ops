'use client';

import { useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';

/**
 * Admin front-end for /api/parts/import-vendor-assets (N4-A): pull product
 * photos + descriptions from a vendor's site onto the matching parts.
 * Three steps mirror the API's modes — probe one page to verify extraction,
 * discover product URLs from the sitemap, then run the import in batches
 * with live progress. SKU matching is exact-or-dashless only, so the worst
 * case is "no match", never a wrong photo.
 */

interface ProbeResult {
  product: { name: string | null; description: string | null; imageUrl: string | null; sku: string | null };
  matchedPartId: string | null;
}

interface RunRow { url: string; ok: boolean; partId?: string; sku?: string | null; imported?: string[]; error?: string }

const BATCH = 25;

export default function ImportVendorAssetsPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const dialog = useDialog();

  const [siteUrl, setSiteUrl] = useState('https://www.rangerdesign.com');
  const [vendorScope, setVendorScope] = useState('Ranger');
  const [overwrite, setOverwrite] = useState(false);

  const [probeUrl, setProbeUrl] = useState('');
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeError, setProbeError] = useState('');

  const [discovering, setDiscovering] = useState(false);
  const [urls, setUrls] = useState<string[]>([]);
  const [discoverError, setDiscoverError] = useState('');

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [imagesSaved, setImagesSaved] = useState(0);
  const [descriptionsSaved, setDescriptionsSaved] = useState(0);
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
      setProbe(await post({ mode: 'probe', url: probeUrl.trim() }));
    } catch (e: any) {
      setProbeError(e?.message || 'Probe failed');
    }
    setProbing(false);
  };

  const doDiscover = async () => {
    setDiscovering(true);
    setDiscoverError('');
    setUrls([]);
    try {
      const d = await post({ mode: 'discover', baseUrl: siteUrl.trim() });
      setUrls(d.urls || []);
      if ((d.urls || []).length === 0) setDiscoverError('No product-looking URLs found in the sitemap — try probing a product page URL directly, or check the site URL.');
    } catch (e: any) {
      setDiscoverError(e?.message || 'Discovery failed');
    }
    setDiscovering(false);
  };

  const doRun = async () => {
    if (urls.length === 0) return;
    const ok = await dialog.confirm(
      `Import from ${urls.length} product page${urls.length !== 1 ? 's' : ''}? Photos and descriptions land on parts whose part number matches the page's SKU${vendorScope.trim() ? ` (matching only "${vendorScope.trim()}" parts)` : ''}. ${overwrite ? 'Existing photos/descriptions WILL be replaced.' : 'Existing photos/descriptions are kept; only blanks fill in.'} Pages are fetched politely (~1/sec), so this takes a while.`,
      { confirmLabel: 'Start import' },
    );
    if (!ok) return;

    setRunning(true);
    setProgress({ done: 0, total: urls.length });
    setImagesSaved(0);
    setDescriptionsSaved(0);
    setMatchedCount(0);
    setFailures([]);
    setRanTotal(urls.length);

    let images = 0, descriptions = 0, matched = 0;
    const failed: RunRow[] = [];
    for (let i = 0; i < urls.length; i += BATCH) {
      const chunk = urls.slice(i, i + BATCH);
      try {
        const d = await post({
          mode: 'run',
          urls: chunk,
          vendor: vendorScope.trim() || undefined,
          overwrite: overwrite || undefined,
        });
        images += d.imagesSaved || 0;
        descriptions += d.descriptionsSaved || 0;
        for (const r of (d.results || []) as RunRow[]) {
          if (r.ok) matched++;
          else failed.push(r);
        }
      } catch (e: any) {
        failed.push({ url: `(batch of ${chunk.length} failed)`, ok: false, error: e?.message || 'request failed' });
      }
      setProgress({ done: Math.min(i + BATCH, urls.length), total: urls.length });
      setImagesSaved(images);
      setDescriptionsSaved(descriptions);
      setMatchedCount(matched);
      setFailures([...failed]);
    }
    setRunning(false);
    setProgress(null);
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
          <label style={label}>Match only parts whose vendor contains…</label>
          <input style={input} value={vendorScope} onChange={e => setVendorScope(e.target.value)} placeholder="Ranger (blank = all parts)" />
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
                {probe.matchedPartId ? '✓ matches a part in our catalog' : probe.product.sku ? '✗ no part with this number' : '✗ no SKU on the page'}
              </div>
              {probe.product.description && <div style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>{probe.product.description.slice(0, 220)}{probe.product.description.length > 220 ? '…' : ''}</div>}
            </div>
          </div>
        )}
      </div>

      {/* Step 2: discover */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>2 · Find the product pages</div>
        <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10 }}>
          Reads the site&apos;s sitemap and collects product page URLs.
        </div>
        <button style={{ ...btn, opacity: discovering ? 0.6 : 1 }} onClick={doDiscover} disabled={discovering || !siteUrl.trim()}>
          {discovering ? 'Scanning sitemap…' : 'Find product pages'}
        </button>
        {discoverError && <div style={{ marginTop: 8, fontSize: 12, color: theme.warning }}>{discoverError}</div>}
        {urls.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            Found <strong>{urls.length.toLocaleString()}</strong> product page{urls.length !== 1 ? 's' : ''}.
            <div style={{ marginTop: 6, fontSize: 11, fontFamily: 'monospace', color: theme.textMuted, maxHeight: 100, overflow: 'auto' }}>
              {urls.slice(0, 8).map(u => <div key={u}>{u}</div>)}
              {urls.length > 8 && <div>… and {(urls.length - 8).toLocaleString()} more</div>}
            </div>
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
            <div style={{ fontSize: 12, marginBottom: 6 }}>{progress.done} / {progress.total} pages · {matchedCount} matched · {imagesSaved} photos · {descriptionsSaved} descriptions</div>
            <div style={{ height: 8, background: theme.progressTrack, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(progress.done / progress.total) * 100}%`, background: theme.orange }} />
            </div>
          </div>
        )}
        {!running && ranTotal > 0 && (
          <div style={{ marginTop: 12, fontSize: 14 }}>
            Done — <strong>{matchedCount}</strong> of {ranTotal.toLocaleString()} pages matched a part · <strong>{imagesSaved}</strong> photos and <strong>{descriptionsSaved}</strong> descriptions saved.
            <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 4 }}>
              Unmatched pages are normal — vendors list plenty of products we don&apos;t carry. Open the estimate builder&apos;s Browse Catalog to see the results.
            </div>
            {failures.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ fontSize: 12, cursor: 'pointer', color: theme.textSecondary }}>{failures.length} skipped/failed pages</summary>
                <div style={{ marginTop: 6, fontSize: 11, fontFamily: 'monospace', color: theme.textMuted, maxHeight: 160, overflow: 'auto' }}>
                  {failures.slice(0, 200).map((f, i) => <div key={i}>{f.url} — {f.error}</div>)}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
