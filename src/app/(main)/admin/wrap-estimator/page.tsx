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
  const [proofDataUrl, setProofDataUrl] = useState<string | null>(null);
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
    const reader = new FileReader();
    reader.onload = () => setProofDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  };

  const analyze = async () => {
    if (!selectedVehicle || !proofFile) return;
    setAnalyzing(true);
    setAnalysis(null);
    setError(null);
    try {
      const mediaType = proofFile.type || (proofFile.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');

      // Upload the proof straight to R2 via the presigned-PUT helper.
      // This bypasses the platform's ~4.5MB request-body limit that
      // 413'd PDF uploads when we POSTed base64 inline. The server
      // then fetches the file by URL.
      const ext = (proofFile.name.split('.').pop() || 'bin').toLowerCase();
      const rand = Math.random().toString(36).slice(2, 8);
      const path = `wrap-estimator/${Date.now()}-${rand}.${ext}`;
      const up = await storage.from('quote-proofs').upload(path, proofFile, { contentType: mediaType });
      if (up.error) {
        setError(`Upload failed: ${up.error.message}`);
        setAnalyzing(false);
        return;
      }
      const fileUrl = storage.from('quote-proofs').getPublicUrl(path).data.publicUrl;

      const res = await fetch('/api/wrap-estimator/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileUrl,
          mediaType,
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
          {!proofDataUrl ? (
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
              {proofFile?.type.startsWith('image/') ? (
                <img
                  id="wrap-estimator-proof-img"
                  src={proofDataUrl}
                  alt="Proof"
                  style={{ maxWidth: '100%', maxHeight: '420px', borderRadius: '8px', display: 'block', margin: '0 auto' }}
                />
              ) : (
                <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--subtle-bg)', fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center' }}>
                  PDF loaded: {proofFile?.name}
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                <button
                  onClick={analyze}
                  disabled={analyzing}
                  style={{
                    flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                    background: analyzing ? 'var(--subtle-bg)' : '#3b82f6',
                    color: analyzing ? 'var(--text-muted)' : '#fff',
                    border: 'none', cursor: analyzing ? 'default' : 'pointer',
                  }}
                >{analyzing ? 'Analyzing with AI…' : 'Analyze with AI'}</button>
                <button
                  onClick={() => { setProofFile(null); setProofDataUrl(null); setAnalysis(null); }}
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

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {analysis.elements.map((el, i) => (
              <ElementRow
                key={i}
                idx={i}
                element={el}
                proofDataUrl={proofDataUrl}
                isImage={!!proofFile?.type.startsWith('image/')}
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

// Crop a region from the proof image using canvas for the thumbnail. Skips
// rendering the crop for PDFs (no client-side rasterization in this MVP —
// users still get the dimensions and label).
function ElementRow({
  idx, element, proofDataUrl, isImage, onChange, onRemove,
}: {
  idx: number;
  element: Element;
  proofDataUrl: string | null;
  isImage: boolean;
  onChange: (patch: Partial<Element>) => void;
  onRemove: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);

  // Build the cropped thumbnail when we have an image + a bbox.
  const bbox = element.bbox;
  const bboxKey = useMemo(
    () => bbox ? `${bbox.x},${bbox.y},${bbox.width},${bbox.height}` : '',
    [bbox]
  );

  useEffect(() => {
    if (!isImage || !proofDataUrl || !bbox) { setThumb(null); return; }
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
    img.src = proofDataUrl;
    return () => { cancelled = true; };
  }, [proofDataUrl, isImage, bboxKey, bbox]);

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
