'use client';

/**
 * Standalone, from-scratch wrap estimator (v2). Lives at
 * /admin/wrap-estimator so it can iterate without disturbing the
 * existing estimating tool at /admin/quotes.
 *
 * Flow:
 *   1. Pick a vehicle from vehicle_templates (panel dims used as scale)
 *   2. Upload a proof (image or PDF)
 *   3. Send to /api/wrap-estimator/analyze — Claude vision identifies
 *      graphic elements and sizes them in inches using the panel as ref
 *   4. Render results: cropped thumbnails of each element (via canvas),
 *      editable dimensions, running total sq ft
 *
 * No DB persistence in this MVP — verify the AI output is useful first.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';

interface VehicleTemplate {
  id: string;
  name: string;
  make: string | null;
  model: string | null;
  variant: string | null;
  year: string | null;
  overall_length_in: number | null;
  overall_height_in: number | null;
  wheelbase_in: number | null;
  panel_data: any[] | null;
}

interface Element {
  label: string;
  panel?: string | null;
  reference_panel?: string | null;
  measurement_basis?: string | null;
  // 1-based index into proofPages — which rendered page this element is
  // on. Defaults to 1 for single-image proofs or if the AI omits it.
  page?: number;
  width_in: number;
  height_in: number;
  area_sqft: number;
  bbox?: { x: number; y: number; width: number; height: number };
  notes?: string;
}

interface AnalysisResult {
  vehicle: string;
  elements: Element[];
  total_sqft: number;
  notes: string | null;
}

export default function WrapEstimatorPage() {
  const router = useRouter();
  const { isAdmin, isSales, isGraphicsProduction, user } = useAuth();
  const hasAccess = isAdmin || isSales || isGraphicsProduction;
  const supabase = createClient();

  // Vehicle picker
  const [vehicleQuery, setVehicleQuery] = useState('');
  const [vehicleMatches, setVehicleMatches] = useState<VehicleTemplate[]>([]);
  const [vehicleLoading, setVehicleLoading] = useState(false);
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleTemplate | null>(null);

  // Proof upload
  const [proofFile, setProofFile] = useState<File | null>(null);
  // High-res rasterized pages. Image uploads → one entry (the image).
  // PDFs → one PNG per page rendered at high resolution via pdfjs, so
  // each page gets its own resolution budget when sent to the AI
  // (instead of one downscaled multi-panel sheet). Indexed 0-based;
  // element.page is 1-based into this array.
  const [proofPages, setProofPages] = useState<string[]>([]);
  const [rasterizing, setRasterizing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Analysis
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    if (!hasAccess) router.push('/home');
  }, [user, hasAccess, router]);

  // Debounced vehicle search
  useEffect(() => {
    const q = vehicleQuery.trim();
    if (q.length < 2) {
      setVehicleMatches([]);
      return;
    }
    const t = setTimeout(async () => {
      setVehicleLoading(true);
      // PostgREST's .or() filter grammar treats , ( ) . as structural and
      // % _ as ilike wildcards. Raw user text containing any of these
      // (e.g. "Transit (mid roof)") produces a malformed filter that the
      // browser/Supabase rejects. Strip everything that isn't a word
      // char, space, hyphen, or slash before interpolating.
      const clean = q
        .toLowerCase()
        .replace(/[^\w\s/-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const terms = clean.split(' ').filter(t => t.length >= 2);
      if (terms.length === 0) {
        setVehicleMatches([]);
        setVehicleLoading(false);
        return;
      }
      const orParts: string[] = [];
      for (const term of terms) {
        orParts.push(`name.ilike.%${term}%`);
        orParts.push(`make.ilike.%${term}%`);
        orParts.push(`model.ilike.%${term}%`);
        orParts.push(`variant.ilike.%${term}%`);
      }
      const { data, error: qErr } = await supabase
        .from('vehicle_templates')
        .select('id, name, make, model, variant, year, overall_length_in, overall_height_in, wheelbase_in, panel_data')
        .or(orParts.join(','))
        .limit(50);
      if (qErr) {
        console.error('[wrap-estimator] vehicle search failed:', qErr);
        setError(`Vehicle search failed: ${qErr.message}`);
        setVehicleMatches([]);
        setVehicleLoading(false);
        return;
      }
      // Strict AND filter client-side — match every term in the haystack
      const filtered = (data || []).filter((d: any) => {
        const hay = `${d.name || ''} ${d.make || ''} ${d.model || ''} ${d.variant || ''}`.toLowerCase();
        return terms.every(t => hay.includes(t));
      });
      setVehicleMatches((filtered.length > 0 ? filtered : (data || [])).slice(0, 15) as VehicleTemplate[]);
      setVehicleLoading(false);
    }, 200);
    return () => clearTimeout(t);
  }, [vehicleQuery, supabase]);

  const onFilePick = async (file: File) => {
    setProofFile(file);
    setAnalysis(null);
    setError(null);
    setProofPages([]);

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error('Failed to read file'));
      r.readAsDataURL(file);
    });

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      // Image: the data URL is already a usable raster (single page).
      setProofPages([dataUrl]);
      return;
    }

    // PDF: rasterize EVERY page at high resolution. Sending each page
    // as its own image gives the AI a full resolution budget per page
    // instead of one downscaled multi-panel sheet, which is what made
    // small elements (logos) hard to size.
    setRasterizing(true);
    try {
      const pdfjsLib: any = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      const base64 = dataUrl.split(',')[1] || '';
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      const pages: string[] = [];
      const MAX_PAGES = 12; // sanity bound on enormous PDFs
      const pageCount = Math.min(pdf.numPages, MAX_PAGES);
      for (let p = 1; p <= pageCount; p++) {
        const page = await pdf.getPage(p);
        const base = page.getViewport({ scale: 1 });
        // Target ~2200px long edge. Anthropic resizes images down to
        // ~1568px, so this guarantees we hand it the sharpest input it
        // will accept rather than letting its own PDF rasterizer pick a
        // lower DPI.
        const scale = Math.min(2200 / Math.max(base.width, base.height), 3);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;
        // JPEG keeps the upload small; quality 0.9 is plenty for sizing.
        pages.push(canvas.toDataURL('image/jpeg', 0.9));
      }
      setProofPages(pages);
    } catch (err: any) {
      console.error('[wrap-estimator] PDF rasterize failed:', err);
      // Non-fatal — analysis still works; we just won't have the
      // overlay/crops for this PDF.
    }
    setRasterizing(false);
  };

  const analyze = async () => {
    if (!selectedVehicle || !proofFile) return;
    if (proofPages.length === 0) {
      setError(rasterizing ? 'Still rendering the proof — try again in a moment.' : 'Proof not ready yet.');
      return;
    }
    setAnalyzing(true);
    setAnalysis(null);
    setError(null);
    try {
      // We send the high-res RASTERIZED pages, not the original file.
      // For a PDF this means each panel/page is its own large JPEG, so
      // the AI gets a full resolution budget per page instead of one
      // downscaled multi-panel sheet (the thing that made small logos
      // hard to size). Upload each page to R2 via the presigned-PUT
      // helper (bypasses the platform's ~4.5MB request-body limit) and
      // hand the server just the URLs.
      const stamp = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const fileUrls: string[] = [];
      for (let i = 0; i < proofPages.length; i++) {
        const blob = await (await fetch(proofPages[i])).blob();
        const path = `wrap-estimator/${stamp}-${rand}-p${i + 1}.jpg`;
        const up = await storage.from('quote-proofs').upload(path, blob, { contentType: 'image/jpeg' });
        if (up.error) {
          setError(`Upload failed (page ${i + 1}): ${up.error.message}`);
          setAnalyzing(false);
          return;
        }
        fileUrls.push(storage.from('quote-proofs').getPublicUrl(path).data.publicUrl);
      }

      const res = await fetch('/api/wrap-estimator/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileUrls,
          mediaType: 'image/jpeg',
          vehicle: {
            name: selectedVehicle.name,
            make: selectedVehicle.make,
            model: selectedVehicle.model,
            variant: selectedVehicle.variant,
            overall_length_in: selectedVehicle.overall_length_in,
            overall_height_in: selectedVehicle.overall_height_in,
            wheelbase_in: selectedVehicle.wheelbase_in,
            panel_data: selectedVehicle.panel_data,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
      } else {
        setAnalysis(data);
      }
    } catch (err: any) {
      setError(err?.message || 'Analysis request failed');
    }
    setAnalyzing(false);
  };

  // Edit element dimensions inline → recompute total locally
  const updateElement = (idx: number, patch: Partial<Element>) => {
    setAnalysis(prev => {
      if (!prev) return prev;
      const next = [...prev.elements];
      const merged = { ...next[idx], ...patch };
      const w = parseFloat(String(merged.width_in)) || 0;
      const h = parseFloat(String(merged.height_in)) || 0;
      merged.width_in = w;
      merged.height_in = h;
      merged.area_sqft = Math.round((w * h / 144) * 100) / 100;
      next[idx] = merged;
      const total = Math.round(next.reduce((s, e) => s + (e.area_sqft || 0), 0) * 100) / 100;
      return { ...prev, elements: next, total_sqft: total };
    });
  };

  const removeElement = (idx: number) => {
    setAnalysis(prev => {
      if (!prev) return prev;
      const next = prev.elements.filter((_, i) => i !== idx);
      const total = Math.round(next.reduce((s, e) => s + (e.area_sqft || 0), 0) * 100) / 100;
      return { ...prev, elements: next, total_sqft: total };
    });
  };

  if (!user) return null;
  if (!hasAccess) return null;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Wrap Estimator v2</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', maxWidth: '720px' }}>
          Pick a vehicle, upload a proof, and let the AI identify each graphic element, size it
          against the vehicle&apos;s known panel dimensions, and tally total square footage.
          Standalone tool — won&apos;t touch the existing estimating flow.
        </div>
      </div>

      {/* Step 1: Vehicle */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
          1 · Vehicle
        </div>
        {selectedVehicle ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{selectedVehicle.name}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {selectedVehicle.overall_length_in ? `L ${selectedVehicle.overall_length_in}"` : '—'}
                {selectedVehicle.overall_height_in ? ` · H ${selectedVehicle.overall_height_in}"` : ''}
                {Array.isArray(selectedVehicle.panel_data) ? ` · ${selectedVehicle.panel_data.length} panels` : ''}
              </div>
            </div>
            <button onClick={() => { setSelectedVehicle(null); setAnalysis(null); }} style={{
              padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
              background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
            }}>Change</button>
          </div>
        ) : (
          <>
            <input
              value={vehicleQuery}
              onChange={(e) => setVehicleQuery(e.target.value)}
              placeholder="Search vehicle (e.g. Ford Transit Mid Roof)…"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                borderRadius: '8px', border: '1px solid var(--border)',
                background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px',
              }}
            />
            {vehicleLoading && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>Searching…</div>}
            {vehicleMatches.length > 0 && (
              <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '280px', overflowY: 'auto' }}>
                {vehicleMatches.map(v => (
                  <button
                    key={v.id}
                    onClick={() => setSelectedVehicle(v)}
                    style={{
                      padding: '8px 10px', borderRadius: '8px', textAlign: 'left',
                      background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                      cursor: 'pointer', fontSize: '12px',
                    }}
                  >
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{v.name}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {v.overall_length_in ? `L ${v.overall_length_in}"` : ''}
                      {v.overall_height_in ? ` · H ${v.overall_height_in}"` : ''}
                      {Array.isArray(v.panel_data) ? ` · ${v.panel_data.length} panels` : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Step 2: Proof */}
      {selectedVehicle && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
            2 · Proof
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf,.pdf"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFilePick(f); if (e.target) e.target.value = ''; }}
            style={{ display: 'none' }}
          />
          {!proofFile ? (
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{
                width: '100%', padding: '24px', borderRadius: '10px',
                background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                color: 'var(--text-muted)', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
              }}
            >Click to upload a proof image or PDF</button>
          ) : (
            <div>
              {proofPages.length > 0 ? (
                <div>
                  <img
                    id="wrap-estimator-proof-img"
                    src={proofPages[0]}
                    alt="Proof"
                    style={{ maxWidth: '100%', maxHeight: '420px', borderRadius: '8px', display: 'block', margin: '0 auto' }}
                  />
                  {proofPages.length > 1 && (
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', textAlign: 'center' }}>
                      {proofPages.length} pages rendered at high resolution — each is sent to the AI separately.
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--subtle-bg)', fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center' }}>
                  {rasterizing ? 'Rendering proof at high resolution…' : `Loading: ${proofFile?.name}`}
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                <button
                  onClick={analyze}
                  disabled={analyzing || rasterizing || proofPages.length === 0}
                  style={{
                    flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                    background: (analyzing || rasterizing || proofPages.length === 0) ? 'var(--subtle-bg)' : '#3b82f6',
                    color: (analyzing || rasterizing || proofPages.length === 0) ? 'var(--text-muted)' : '#fff',
                    border: 'none', cursor: (analyzing || rasterizing || proofPages.length === 0) ? 'default' : 'pointer',
                  }}
                >{analyzing ? 'Analyzing with AI…' : rasterizing ? 'Rendering…' : 'Analyze with AI'}</button>
                <button
                  onClick={() => { setProofFile(null); setProofPages([]); setAnalysis(null); }}
                  style={{
                    padding: '10px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                    background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >Replace</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 3: Results */}
      {error && (
        <div style={{
          padding: '10px 12px', borderRadius: '10px', marginBottom: '12px',
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
          color: '#ef4444', fontSize: '12px',
        }}>
          {error}
        </div>
      )}

      {analysis && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' }}>
            <div>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                3 · Elements ({analysis.elements.length})
              </div>
              {analysis.notes && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', fontStyle: 'italic', maxWidth: '640px' }}>
                  {analysis.notes}
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Total</div>
              <div style={{ fontSize: '20px', fontWeight: 800, color: '#22c55e' }}>{analysis.total_sqft.toFixed(2)} sq ft</div>
            </div>
          </div>

          {/* Annotated proof — one image per rendered page, with numbered
              pins matching the element row numbers below. Elements are
              grouped onto the page the AI assigned them (1-based el.page). */}
          {proofPages.length > 0 && (
            <div style={{ marginBottom: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {proofPages.map((pageUrl, pageIdx) => {
                const pageNo = pageIdx + 1;
                // Each element keeps its original index (used for the pin
                // number + row alignment). Default missing/invalid page to 1.
                const onThisPage = analysis.elements
                  .map((el, i) => ({ el, i }))
                  .filter(({ el }) => (el.page && el.page >= 1 ? el.page : 1) === pageNo);
                if (proofPages.length > 1 && onThisPage.length === 0) return null;
                return (
                  <div key={pageIdx}>
                    {proofPages.length > 1 && (
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                        Page {pageNo}
                      </div>
                    )}
                    <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border)' }}>
                      <img src={pageUrl} alt={`Proof page ${pageNo}`} style={{ display: 'block', maxWidth: '100%', maxHeight: '480px' }} />
                      {/* Numbered pins at each bbox center. The AI's boxes
                          are imprecise, so we deliberately DON'T draw
                          rectangles — a pin just says "roughly here", and
                          the real basis for the size is the
                          measurement_basis text on each row. */}
                      {onThisPage.map(({ el, i }) => {
                        const b = el.bbox;
                        if (!b) return null;
                        const cx = Math.max(0, Math.min(1, b.x + b.width / 2)) * 100;
                        const cy = Math.max(0, Math.min(1, b.y + b.height / 2)) * 100;
                        return (
                          <span
                            key={i}
                            title={el.label}
                            style={{
                              position: 'absolute',
                              left: `${cx}%`,
                              top: `${cy}%`,
                              transform: 'translate(-50%, -50%)',
                              minWidth: '20px', height: '20px', padding: '0 5px',
                              background: '#3b82f6', color: '#fff',
                              fontSize: '11px', fontWeight: 800, lineHeight: '20px',
                              textAlign: 'center', borderRadius: '10px',
                              border: '2px solid #fff',
                              boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                              pointerEvents: 'none',
                            }}
                          >{i + 1}</span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                Pins mark the AI&apos;s rough location for each element — they are not how it measures.
                Each element&apos;s size comes from the &quot;Basis&quot; reasoning shown in its row.
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {analysis.elements.map((el, i) => (
              <ElementRow
                key={i}
                idx={i}
                element={el}
                rasterUrl={proofPages[(el.page && el.page >= 1 ? el.page : 1) - 1] || proofPages[0] || null}
                onChange={(patch) => updateElement(i, patch)}
                onRemove={() => removeElement(i)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Crop a region from the rasterized proof using canvas for the thumbnail.
// rasterUrl is set for both image uploads (passthrough) and PDFs (page 1
// rendered via pdfjs), so crops now work for proofs that are PDFs too.
function ElementRow({
  idx, element, rasterUrl, onChange, onRemove,
}: {
  idx: number;
  element: Element;
  rasterUrl: string | null;
  onChange: (patch: Partial<Element>) => void;
  onRemove: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);

  // Build the cropped thumbnail when we have a raster + a bbox.
  const bbox = element.bbox;
  const bboxKey = useMemo(
    () => bbox ? `${bbox.x},${bbox.y},${bbox.width},${bbox.height}` : '',
    [bbox]
  );

  useEffect(() => {
    if (!rasterUrl || !bbox) { setThumb(null); return; }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const x = Math.max(0, Math.min(1, bbox.x)) * img.naturalWidth;
      const y = Math.max(0, Math.min(1, bbox.y)) * img.naturalHeight;
      const w = Math.max(1, Math.min(1, bbox.width) * img.naturalWidth);
      const h = Math.max(1, Math.min(1, bbox.height) * img.naturalHeight);
      const canvas = document.createElement('canvas');
      const target = 120;
      const scale = Math.min(target / w, target / h, 1);
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
      setThumb(canvas.toDataURL('image/png'));
    };
    img.src = rasterUrl;
    return () => { cancelled = true; };
  }, [rasterUrl, bboxKey, bbox]);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '8px', borderRadius: '8px', background: 'var(--subtle-bg)',
      border: '1px solid var(--border)',
    }}>
      <div style={{
        width: '64px', height: '64px', flexShrink: 0,
        background: 'var(--card)', borderRadius: '6px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', border: '1px solid var(--border)',
      }}>
        {thumb ? (
          <img src={thumb} alt="" style={{ maxWidth: '100%', maxHeight: '100%' }} />
        ) : (
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>#{idx + 1}</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <input
          value={element.label}
          onChange={(e) => onChange({ label: e.target.value })}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '4px 6px',
            borderRadius: '4px', border: '1px solid transparent',
            background: 'transparent', color: 'var(--text-primary)',
            fontSize: '13px', fontWeight: 700,
          }}
        />
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: '6px' }}>
          {element.panel || ''}
          {element.notes ? `${element.panel ? ' · ' : ''}${element.notes}` : ''}
        </div>
        {element.measurement_basis && (
          <div style={{
            fontSize: '10px', color: 'var(--text-secondary)', marginLeft: '6px',
            marginTop: '3px', lineHeight: 1.4,
          }}>
            <span style={{ fontWeight: 700, color: 'var(--text-muted)' }}>Basis: </span>
            {element.measurement_basis}
            {element.reference_panel ? (
              <span style={{ color: 'var(--text-muted)' }}> (ref: {element.reference_panel})</span>
            ) : null}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
        <input
          type="number"
          step="0.1"
          value={element.width_in}
          onChange={(e) => onChange({ width_in: parseFloat(e.target.value) })}
          style={inputStyleSmall}
        />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>×</span>
        <input
          type="number"
          step="0.1"
          value={element.height_in}
          onChange={(e) => onChange({ height_in: parseFloat(e.target.value) })}
          style={inputStyleSmall}
        />
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>in</span>
      </div>
      <div style={{ width: '70px', textAlign: 'right', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
        {element.area_sqft.toFixed(2)} sf
      </div>
      <button
        onClick={onRemove}
        style={{
          padding: '4px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700,
          background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
          color: '#ef4444', cursor: 'pointer',
        }}
      >×</button>
    </div>
  );
}

const inputStyleSmall: React.CSSProperties = {
  width: '52px', padding: '4px 6px', borderRadius: '4px',
  border: '1px solid var(--border)', background: 'var(--input-bg)',
  color: 'var(--text-primary)', fontSize: '12px', textAlign: 'center',
};
