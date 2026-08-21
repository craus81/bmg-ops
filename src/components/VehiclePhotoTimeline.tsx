'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { storage, storageDownloadUrl } from '@/lib/storage';
import { createClient } from '@/lib/supabase-browser';
import ProofThumbnail from '@/components/ProofThumbnail';

// Files a browser <img> can actually render. Design files are often .ai /
// .psd / .eps — those get a labeled file tile instead of a broken image.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic']);
const fileExt = (item: { storagePath: string; fileName: string | null }) =>
  ((item.fileName || item.storagePath).split('.').pop() || '').toLowerCase();
const isRenderableImage = (item: { storagePath: string; fileName: string | null }) =>
  IMAGE_EXTS.has(fileExt(item));

export type PhotoCategory =
  | 'before'
  | 'during'
  | 'completion'
  | 'damage'
  | 'proof'
  | 'design_file'
  | 'other';

type Source = 'vehicle_photo' | 'graphics_proof' | 'graphics_job_file';

interface TimelineItem {
  id: string;
  source: Source;
  category: PhotoCategory;
  bucket: string;
  storagePath: string;
  fileName: string | null;
  fileType: string | null;
  isPdf: boolean;
  uploadedAt: string | null;
  uploadedByName: string | null;
  caption: string | null;
}

interface Props {
  vin: string;
  variant?: 'internal' | 'customer';
  refreshKey?: number;
}

const SECTION_ORDER: { key: string; label: string; cats: PhotoCategory[] }[] = [
  { key: 'checkin', label: 'Check-in', cats: ['before'] },
  { key: 'in_progress', label: 'In Progress', cats: ['during', 'design_file', 'proof'] },
  { key: 'completion', label: 'Completion', cats: ['completion'] },
  { key: 'issues', label: 'Issues', cats: ['damage'] },
  { key: 'other', label: 'Other', cats: ['other'] },
];

const CATEGORY_LABELS: Record<PhotoCategory, string> = {
  before: 'Before',
  during: 'During',
  completion: 'Completion',
  damage: 'Damage',
  proof: 'Proof',
  design_file: 'Design file',
  other: 'Other',
};

const ALL_CATEGORIES: PhotoCategory[] = ['before', 'during', 'completion', 'damage', 'proof', 'design_file', 'other'];

export default function VehiclePhotoTimeline({ vin, variant = 'internal', refreshKey }: Props) {
  const supabase = createClient();
  const [items, setItems] = useState<TimelineItem[]>([]);
  // Per-tile load fallback: R2 first (where uploads live), then legacy
  // Supabase storage (some photos were uploaded there by the pick-list
  // page's old raw-storage path), then a labeled file tile instead of the
  // browser's broken-image glyph.
  const [srcState, setSrcState] = useState<Record<string, 'legacy' | 'failed'>>({});
  const failedIds = useMemo(() => new Set(Object.keys(srcState).filter(id => srcState[id] === 'failed')), [srcState]);
  const [loading, setLoading] = useState(true);
  const [selectedCats, setSelectedCats] = useState<Set<PhotoCategory>>(() => new Set(ALL_CATEGORIES));
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/vehicles/${encodeURIComponent(vin)}/photos`);
    if (!res.ok) {
      setItems([]);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setItems((data.items || []) as TimelineItem[]);
    setLoading(false);
  }, [vin]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Hide damage photos in customer variant by default
  useEffect(() => {
    if (variant === 'customer') {
      setSelectedCats(new Set(ALL_CATEGORIES.filter(c => c !== 'damage')));
    }
  }, [variant]);

  // Files are uploaded through the @/lib/storage R2 shim, so URLs must come
  // from it too — this component used the raw supabase-js storage client,
  // whose URLs pointed at a Supabase bucket that doesn't exist (plus an
  // unavailable image-transform endpoint), so every tile rendered broken.
  const fullUrl = useCallback((item: TimelineItem) =>
    storage.from(item.bucket).getPublicUrl(item.storagePath).data.publicUrl, []);

  const imgSrc = useCallback((item: TimelineItem) =>
    srcState[item.id] === 'legacy'
      ? supabase.storage.from(item.bucket).getPublicUrl(item.storagePath).data.publicUrl
      : fullUrl(item),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  [srcState, fullUrl]);

  const onImgError = useCallback((id: string) => {
    setSrcState(prev => ({ ...prev, [id]: prev[id] === 'legacy' ? 'failed' : 'legacy' }));
  }, []);

  const visibleItems = useMemo(
    () => items.filter(i => selectedCats.has(i.category)),
    [items, selectedCats]
  );

  const grouped = useMemo(() => {
    return SECTION_ORDER.map(section => ({
      ...section,
      items: visibleItems.filter(i => section.cats.includes(i.category)),
    })).filter(s => s.items.length > 0);
  }, [visibleItems]);

  const toggleCat = (cat: PhotoCategory) => {
    setSelectedCats(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  // Lightbox keyboard navigation
  useEffect(() => {
    if (lightboxIdx === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxIdx(null);
      else if (e.key === 'ArrowLeft') setLightboxIdx(i => i === null ? null : Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setLightboxIdx(i => i === null ? null : Math.min(visibleItems.length - 1, i + 1));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxIdx, visibleItems.length]);

  if (loading) {
    return <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>Loading photos...</div>;
  }

  if (items.length === 0) {
    return (
      <div style={{
        padding: '20px', textAlign: 'center', borderRadius: '12px',
        background: 'var(--card)', border: '1px solid var(--border)',
        color: 'var(--text-muted)', fontSize: '13px',
      }}>
        No photos or design files for this vehicle yet.
      </div>
    );
  }

  const categoriesInData = Array.from(new Set(items.map(i => i.category)));
  const availableFilters = ALL_CATEGORIES.filter(c =>
    categoriesInData.includes(c) && !(variant === 'customer' && c === 'damage')
  );

  return (
    <div>
      {/* Category filter chips */}
      {availableFilters.length > 1 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
          {availableFilters.map(cat => {
            const active = selectedCats.has(cat);
            const count = items.filter(i => i.category === cat).length;
            return (
              <button
                key={cat}
                onClick={() => toggleCat(cat)}
                style={{
                  padding: '6px 12px',
                  borderRadius: '999px',
                  fontSize: '11px',
                  fontWeight: 700,
                  border: `1px solid ${active ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
                  background: active ? 'var(--accent, #2563eb)' : 'var(--card)',
                  color: active ? '#fff' : 'var(--text-secondary, #475569)',
                  cursor: 'pointer',
                }}
              >
                {CATEGORY_LABELS[cat]} <span style={{ opacity: 0.7 }}>· {count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Grouped sections */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {grouped.map(section => (
          <div key={section.key}>
            <div style={{
              fontSize: '11px', fontWeight: 700,
              color: 'var(--text-muted)', textTransform: 'uppercase',
              letterSpacing: '0.8px', marginBottom: '8px',
            }}>
              {section.label} ({section.items.length})
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px' }}>
              {section.items.map(item => {
                const globalIdx = visibleItems.findIndex(v => v.id === item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => setLightboxIdx(globalIdx)}
                    style={{
                      position: 'relative',
                      padding: 0,
                      border: '1px solid var(--border)',
                      borderRadius: '10px',
                      overflow: 'hidden',
                      background: 'var(--card)',
                      cursor: 'pointer',
                      aspectRatio: '1',
                    }}
                    title={item.caption || item.fileName || CATEGORY_LABELS[item.category]}
                  >
                    {item.isPdf ? (
                      <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'var(--subtle-bg, #f8fafc)',
                      }}>
                        <ProofThumbnail pdfUrl={fullUrl(item)} label="PDF" thumbSize={100} />
                      </div>
                    ) : isRenderableImage(item) && !failedIds.has(item.id) ? (
                      <img
                        src={imgSrc(item)}
                        loading="lazy"
                        alt={item.caption || CATEGORY_LABELS[item.category]}
                        onError={() => onImgError(item.id)}
                        style={{
                          position: 'absolute', inset: 0,
                          width: '100%', height: '100%', objectFit: 'cover',
                        }}
                      />
                    ) : (
                      <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px',
                        background: 'var(--subtle-bg, #f8fafc)', color: 'var(--text-muted)',
                      }}>
                        <span style={{ fontSize: '22px' }}>📄</span>
                        <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{fileExt(item) || 'file'}</span>
                      </div>
                    )}
                    {item.caption && (
                      <div style={{
                        position: 'absolute', bottom: 0, left: 0, right: 0,
                        background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)',
                        color: '#fff', fontSize: '10px', padding: '6px 8px',
                        textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {item.caption}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Lightbox */}
      {lightboxIdx !== null && visibleItems[lightboxIdx] && (
        <div
          onClick={() => setLightboxIdx(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '20px',
          }}
        >
          {(() => {
            const item = visibleItems[lightboxIdx];
            const url = isRenderableImage(item) && !failedIds.has(item.id) ? imgSrc(item) : fullUrl(item);
            return (
              <>
                {item.isPdf || !isRenderableImage(item) || failedIds.has(item.id) ? (
                  <a
                    href={storageDownloadUrl(item.bucket, item.storagePath, item.fileName || '')}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    style={{
                      padding: '16px 24px', borderRadius: '12px',
                      background: '#fff', color: '#111',
                      fontSize: '14px', fontWeight: 700, textDecoration: 'none',
                    }}
                  >
                    Open {item.isPdf ? 'PDF' : 'file'}: {item.fileName || item.storagePath.split('/').pop() || 'file'} ↗
                  </a>
                ) : (
                  <img
                    src={url}
                    alt={item.caption || 'photo'}
                    onClick={e => e.stopPropagation()}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px' }}
                  />
                )}

                {/* Navigation + close */}
                <div
                  onClick={e => e.stopPropagation()}
                  style={{ position: 'absolute', top: '20px', right: '20px', color: '#fff', fontSize: '24px', fontWeight: 700, cursor: 'pointer' }}
                >
                  <button
                    onClick={() => setLightboxIdx(null)}
                    style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '28px', cursor: 'pointer' }}
                  >✕</button>
                </div>
                {lightboxIdx > 0 && (
                  <button
                    onClick={e => { e.stopPropagation(); setLightboxIdx(lightboxIdx - 1); }}
                    style={{
                      position: 'absolute', left: '20px', top: '50%', transform: 'translateY(-50%)',
                      background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none',
                      borderRadius: '50%', width: '44px', height: '44px',
                      fontSize: '20px', cursor: 'pointer',
                    }}
                  >‹</button>
                )}
                {lightboxIdx < visibleItems.length - 1 && (
                  <button
                    onClick={e => { e.stopPropagation(); setLightboxIdx(lightboxIdx + 1); }}
                    style={{
                      position: 'absolute', right: '20px', top: '50%', transform: 'translateY(-50%)',
                      background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none',
                      borderRadius: '50%', width: '44px', height: '44px',
                      fontSize: '20px', cursor: 'pointer',
                    }}
                  >›</button>
                )}

                {/* Caption + meta */}
                {(item.caption || item.uploadedByName || item.uploadedAt) && (
                  <div
                    onClick={e => e.stopPropagation()}
                    style={{
                      position: 'absolute', bottom: '20px', left: '20px', right: '20px',
                      background: 'rgba(0,0,0,0.7)', color: '#fff',
                      padding: '10px 14px', borderRadius: '10px', fontSize: '12px',
                      maxWidth: '600px', margin: '0 auto',
                    }}
                  >
                    {item.caption && <div style={{ fontWeight: 700, marginBottom: '4px' }}>{item.caption}</div>}
                    <div style={{ opacity: 0.8 }}>
                      {CATEGORY_LABELS[item.category]}
                      {item.uploadedByName && ` · ${item.uploadedByName}`}
                      {item.uploadedAt && ` · ${new Date(item.uploadedAt).toLocaleString()}`}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
