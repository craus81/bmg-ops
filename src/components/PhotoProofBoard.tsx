'use client';

import { useEffect, useRef, useState } from 'react';
import { theme } from '@/lib/theme';
import { DropZone } from '@/components/DropZone';
import PhotoCoverageProof, { type ProofFilmOption } from '@/components/PhotoCoverageProof';
import { MAX_PHOTO_PROOFS, proofLabel, type PhotoProof } from '@/lib/coverage-proof';
import { isCalibrated, sqft } from '@/lib/photo-scale';

// The photo side of the wrap estimator: several views of one vehicle (driver
// side, passenger side, rear, roof), each annotated and calibrated on its own,
// kept in the order the customer will see them.

interface Props {
  proofs: PhotoProof[];
  onChange: (proofs: PhotoProof[]) => void;
  /** Storage path → public URL (the page's R2 helper). */
  imageUrl: (path: string | null) => string;
  /** Upload and append; the parent owns storage and error reporting. */
  onAddPhotos: (files: FileList | File[] | null) => void | Promise<void>;
  onRemovePhoto: (proof: PhotoProof) => void | Promise<void>;
  uploading?: boolean;
  films: ProofFilmOption[];
  defaultFilmId?: string | null;
  onPickFilm?: (filmId: string | null) => void;
}

export default function PhotoProofBoard({
  proofs, onChange, imageUrl, onAddPhotos, onRemovePhoto, uploading, films, defaultFilmId, onPickFilm,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(proofs[0]?.id || null);
  const lastCount = useRef(proofs.length);

  // Follow the list: a photo just uploaded becomes the active one (you add it
  // to draw on it), and a removed active photo hands off rather than leaving
  // the board blank.
  useEffect(() => {
    const grew = proofs.length > lastCount.current;
    lastCount.current = proofs.length;
    if (proofs.length === 0) { setActiveId(null); return; }
    if (grew || !activeId || !proofs.some(p => p.id === activeId)) {
      setActiveId(proofs[proofs.length - 1].id);
    }
  }, [proofs, activeId]);

  const activeIndex = Math.max(0, proofs.findIndex(p => p.id === activeId));
  const active = proofs[activeIndex] || null;

  const patchActive = (patch: Partial<PhotoProof>) => {
    if (!active) return;
    onChange(proofs.map(p => (p.id === active.id ? { ...p, ...patch } : p)));
  };

  const move = (delta: number) => {
    const to = activeIndex + delta;
    if (!active || to < 0 || to >= proofs.length) return;
    const next = [...proofs];
    [next[activeIndex], next[to]] = [next[to], next[activeIndex]];
    onChange(next);
  };

  const full = proofs.length >= MAX_PHOTO_PROOFS;

  const addTile = (
    <label
      title={full ? `${MAX_PHOTO_PROOFS} photos is the limit for one quote` : 'Add another view of this vehicle'}
      style={{
        width: '96px', height: '72px', flexShrink: 0, borderRadius: '8px',
        border: `1px dashed ${theme.border}`, background: 'var(--subtle-bg)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
        cursor: full || uploading ? 'default' : 'pointer', opacity: full || uploading ? 0.5 : 1,
      }}
    >
      {uploading ? 'Uploading…' : full ? 'Limit reached' : '+ Add photo'}
      <input
        type="file" accept="image/*" multiple disabled={full || uploading}
        onChange={e => { onAddPhotos(e.target.files); e.target.value = ''; }}
        style={{ display: 'none' }}
      />
    </label>
  );

  if (proofs.length === 0) {
    return (
      <DropZone accept="image/*" disabled={uploading} onFiles={files => onAddPhotos(files)}>
        <div style={{ textAlign: 'center', padding: '36px 16px', border: `1px dashed ${theme.border}`, borderRadius: '12px', background: 'var(--card)' }}>
          <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>Start from photos</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.6 }}>
            Drop photos of the vehicle here (or take them on your phone) — one per view, as many as the job needs.<br />
            Draw boxes over what gets wrapped, then set a scale on each photo to price them.
          </div>
          <label style={{
            display: 'inline-block', padding: '8px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: 'rgba(6,182,212,0.08)', border: '1px solid #06b6d4', color: '#06b6d4',
            cursor: uploading ? 'default' : 'pointer', opacity: uploading ? 0.6 : 1,
          }}>
            {uploading ? 'Uploading…' : 'Choose Photos'}
            <input type="file" accept="image/*" multiple disabled={uploading} onChange={e => { onAddPhotos(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
          </label>
        </div>
      </DropZone>
    );
  }

  return (
    <div>
      {/* Film strip — the order the customer sees them in. */}
      <DropZone accept="image/*" disabled={uploading || full} onFiles={files => onAddPhotos(files)}>
        <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '6px', marginBottom: '10px' }}>
          {proofs.map((p, i) => {
            const activeTile = p.id === active?.id;
            const areaSqft = p.boxes.reduce((s, b) => s + (b.area_in2 ? sqft(b.area_in2) * Math.max(1, b.qty || 1) : 0), 0);
            return (
              <button
                key={p.id}
                onClick={() => setActiveId(p.id)}
                title={proofLabel(p, i)}
                style={{
                  flexShrink: 0, width: '96px', padding: 0, borderRadius: '8px', cursor: 'pointer',
                  background: 'var(--card)', overflow: 'hidden', textAlign: 'left',
                  border: activeTile ? '2px solid #06b6d4' : `1px solid ${theme.border}`,
                }}
              >
                <div style={{ position: 'relative', height: '56px', background: '#000' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- photo dimensions are unknown */}
                  <img src={imageUrl(p.path)} alt={proofLabel(p, i)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  <span style={{
                    position: 'absolute', top: '2px', left: '2px', padding: '1px 4px', borderRadius: '4px',
                    fontSize: '9px', fontWeight: 800, background: 'rgba(0,0,0,0.6)', color: '#fff',
                  }}>{i + 1}</span>
                  <span
                    title={isCalibrated(p.calibration) ? 'Scale set — boxes are measured' : 'No scale on this photo yet'}
                    style={{
                      position: 'absolute', top: '2px', right: '2px', width: '8px', height: '8px', borderRadius: '50%',
                      background: isCalibrated(p.calibration) ? '#22c55e' : '#fbbf24',
                    }}
                  />
                </div>
                <div style={{ padding: '3px 5px', fontSize: '9px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {proofLabel(p, i)}
                </div>
                <div style={{ padding: '0 5px 4px', fontSize: '9px', color: 'var(--text-muted)' }}>
                  {p.boxes.length} box{p.boxes.length === 1 ? '' : 'es'}{areaSqft > 0 ? ` · ${areaSqft.toFixed(0)} ft²` : ''}
                </div>
              </button>
            );
          })}
          {addTile}
        </div>
      </DropZone>

      {active && (
        <>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={active.label}
              onChange={e => patchActive({ label: e.target.value })}
              placeholder={`What this view is — e.g. "Driver side" (photo ${activeIndex + 1})`}
              style={{
                flex: 1, minWidth: '220px', padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
                background: 'var(--input-bg)', border: `1px solid ${theme.border}`, color: 'var(--text-primary)',
              }}
            />
            <button
              onClick={() => move(-1)} disabled={activeIndex === 0}
              title="Move this photo earlier in the order the customer sees"
              style={orderBtn(activeIndex === 0)}
            >◀ Earlier</button>
            <button
              onClick={() => move(1)} disabled={activeIndex >= proofs.length - 1}
              title="Move this photo later"
              style={orderBtn(activeIndex >= proofs.length - 1)}
            >Later ▶</button>
            <button
              onClick={() => onRemovePhoto(active)}
              style={{
                padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                background: 'transparent', border: '1px solid #ef4444', color: '#ef4444',
              }}
            >Remove Photo</button>
          </div>

          <PhotoCoverageProof
            key={active.id}
            src={imageUrl(active.path)}
            proof={active}
            onChange={patchActive}
            films={films}
            defaultFilmId={defaultFilmId}
            onPickFilm={onPickFilm}
          />
        </>
      )}
    </div>
  );
}

const orderBtn = (disabled: boolean): React.CSSProperties => ({
  padding: '8px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
  background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)',
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
});
