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
  const [lightbox, setLightbox] = useState<InstalledPhoto | null>(null);

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
          {photos.map(p => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={p.id} src={p.url} alt={p.vehicle || 'Installed'}
              onClick={() => setLightbox(p)}
              style={{
                width: '82px', height: '82px', objectFit: 'cover', borderRadius: '8px',
                border: `1px solid ${theme.border}`, cursor: 'pointer', background: 'var(--subtle-bg)',
              }}
            />
          ))}
        </div>
      )}

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 500,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox.url} alt={lightbox.vehicle || 'Installed'}
            style={{ maxWidth: '100%', maxHeight: 'calc(74vh / var(--ts))', objectFit: 'contain', borderRadius: '10px' }}
          />
          <div style={{ marginTop: '10px', textAlign: 'center', color: '#fff', fontSize: '12px', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700 }}>{lightbox.vehicle || 'Vehicle'}</div>
            <div style={{ opacity: 0.8 }}>
              {lightbox.vin ? `VIN ${lightbox.vin}` : ''}
              {lightbox.installedAt ? ` · ${new Date(lightbox.installedAt).toLocaleDateString()}` : ''}
              {lightbox.takenBy ? ` · ${lightbox.takenBy}` : ''}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
