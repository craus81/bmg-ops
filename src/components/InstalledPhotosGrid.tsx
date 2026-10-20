'use client';

/**
 * "This part, actually installed on a real vehicle" (R6-10, completing
 * the unshipped half of PR #463).
 *
 * A proof or a schematic shows what the part is meant to look like. This
 * shows what it looks like once a tech has fitted it — which is what
 * somebody quoting a job, or a new installer working out how it mounts,
 * actually wants.
 */

import { useCallback, useEffect, useState } from 'react';
import { theme } from '@/lib/theme';
import PhotoLightbox, { type LightboxPhoto } from './PhotoLightbox';

interface InstalledPhoto {
  id: string;
  url: string;
  vin: string | null;
  vehicle: string | null;
  installedAt: string | null;
  takenBy: string | null;
}

export default function InstalledPhotosGrid({ partNumber }: { partNumber: string }) {
  const [photos, setPhotos] = useState<InstalledPhoto[]>([]);
  const [scansSearched, setScansSearched] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/parts/install-photos?partNumber=${encodeURIComponent(partNumber)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setPhotos(body.photos || []);
      setScansSearched(body.scansSearched || 0);
    } catch (e: any) {
      setError(e?.message || 'Could not load installed photos');
    }
    setLoading(false);
  }, [partNumber]);

  useEffect(() => { load(); }, [load]);

  if (loading) return null;
  if (error) {
    return <div style={{ fontSize: '11px', color: '#f87171' }}>Installed photos: {error}</div>;
  }
  // Nothing to show and nothing to explain — stay out of the way.
  if (photos.length === 0 && scansSearched === 0) return null;

  // Arrows, zoom and Print / Print all come from the shared viewer
  // (Craig, 2026-10-20: "arrow through the photos … zoom in and print").
  const shots: LightboxPhoto[] = photos.map(p => ({
    id: p.id,
    url: p.url,
    title: [p.vehicle || 'Vehicle', p.vin ? `VIN ${p.vin}` : null].filter(Boolean).join(' · '),
    subtitle: [
      p.installedAt ? new Date(p.installedAt).toLocaleDateString() : null,
      p.takenBy,
    ].filter(Boolean).join(' · ') || null,
  }));

  return (
    <div style={{ marginTop: '10px' }}>
      <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '6px' }}>
        Installed photos {photos.length > 0 && `· ${photos.length}`}
      </div>

      {photos.length === 0 ? (
        // The distinction that matters: nobody photographed these installs,
        // which is not the same as the part never being fitted.
        <div style={{ fontSize: '11px', color: theme.textMuted }}>
          No photos yet — {scansSearched} install{scansSearched !== 1 ? 's' : ''} on record, none photographed.
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {photos.map((p, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={p.id} src={p.url} alt={p.vehicle || 'Installed'}
              onClick={() => setLightboxIdx(i)}
              style={{
                width: '82px', height: '82px', objectFit: 'cover', borderRadius: '8px',
                border: `1px solid ${theme.border}`, cursor: 'pointer', background: 'var(--subtle-bg)',
              }}
            />
          ))}
        </div>
      )}

      <PhotoLightbox
        photos={shots}
        index={lightboxIdx}
        onClose={() => setLightboxIdx(null)}
        onIndex={setLightboxIdx}
        printHeading={`Part ${partNumber} · installed photos`}
      />
    </div>
  );
}
