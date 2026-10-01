'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { resolveStoredFileUrl, storage } from '@/lib/storage';
import ProofThumbnail from '@/components/ProofThumbnail';
import ProofViewer from '@/components/ProofViewer';
import VehiclePhotoTimeline from '@/components/VehiclePhotoTimeline';

interface LinkedVehicle {
  id: string;
  vin: string;
  year: string | null;
  make: string | null;
  model: string | null;
  salesOrderNumber: string | null;
  checkedInAt: string | null;
  proof: { url: string | null; dropboxPath: string | null; filePath: string | null; fileName: string | null } | null;
}

// Past this many vehicles the rows start collapsed, so a fleet job doesn't
// load every vehicle's photos at once.
const EXPAND_UP_TO = 2;

const isPdfName = (name: string | null | undefined) => /\.pdf(?:$|\?)/i.test(name || '');

function proofUrl(p: NonNullable<LinkedVehicle['proof']>): string | null {
  if (p.url) return resolveStoredFileUrl(p.url);
  if (p.filePath) return storage.from('graphics-proofs').getPublicUrl(p.filePath).data.publicUrl;
  return null;
}

/**
 * "From vehicles" on the graphics job page: the proof pulled and the photos
 * taken when each linked vehicle was checked in. Linked, not copied — the
 * files stay on the vehicle, so photos added there later show up here too.
 */
export default function GraphicsJobVehicleFiles({ jobId, cardStyle, labelStyle }: {
  jobId: string;
  cardStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
}) {
  const [vehicles, setVehicles] = useState<LinkedVehicle[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<LinkedVehicle | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/graphics-jobs/${encodeURIComponent(jobId)}/vehicles`);
        const data = res.ok ? await res.json() : { vehicles: [] };
        if (cancelled) return;
        const list = (data.vehicles || []) as LinkedVehicle[];
        setVehicles(list);
        setOpen(list.length <= EXPAND_UP_TO ? new Set(list.map(v => v.id)) : new Set());
      } catch {
        if (!cancelled) setVehicles([]);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  if (!vehicles || vehicles.length === 0) return null;

  const toggle = (id: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div style={cardStyle}>
      <div style={labelStyle}>From {vehicles.length === 1 ? 'vehicle' : `vehicles (${vehicles.length})`}</div>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '8px' }}>
        Proof and check-in photos from the vehicle record.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {vehicles.map(v => {
          const isOpen = open.has(v.id);
          const ymm = [v.year, v.make, v.model].filter(Boolean).join(' ');
          const url = v.proof ? proofUrl(v.proof) : null;
          return (
            <div key={v.id} style={{ borderRadius: '10px', background: 'var(--subtle-bg)', padding: '8px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => toggle(v.id)}
                  aria-expanded={isOpen}
                  style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px', padding: 0, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text-body)' }}
                >
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', width: '10px', flexShrink: 0 }}>{isOpen ? '▾' : '▸'}</span>
                  <span style={{ fontSize: '12px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ymm || 'Vehicle'} · {v.vin.slice(-8)}
                  </span>
                  {v.salesOrderNumber && (
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>{v.salesOrderNumber}</span>
                  )}
                </button>
                <a
                  href={deepLinks.vehicle(v.id)}
                  style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none', flexShrink: 0 }}
                >Open vehicle</a>
              </div>

              {isOpen && (
                <div style={{ marginTop: '8px' }}>
                  {v.proof && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                      <ProofThumbnail
                        pdfUrl={url && isPdfName(v.proof.fileName || v.proof.url || v.proof.filePath) ? url : undefined}
                        imageUrl={url && !isPdfName(v.proof.fileName || v.proof.url || v.proof.filePath) && !v.proof.dropboxPath ? url : undefined}
                        dropboxPath={v.proof.dropboxPath || undefined}
                        label={v.proof.fileName || 'Proof'}
                        thumbSize={48}
                        onOpen={() => setViewing(v)}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <button
                          type="button"
                          onClick={() => setViewing(v)}
                          style={{ display: 'block', maxWidth: '100%', padding: 0, background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', fontSize: '12px', fontWeight: 700, color: '#22c55e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {v.proof.fileName || 'View Proof'}
                        </button>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Proof from check-in · tap to view or print</div>
                      </div>
                    </div>
                  )}
                  <VehiclePhotoTimeline
                    vin={v.vin}
                    visit={v.id}
                    only={['before', 'damage', 'proof']}
                    emptyText="No check-in photos on this vehicle."
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {viewing?.proof && (
        <ProofViewer
          url={proofUrl(viewing.proof)}
          filename={viewing.proof.fileName}
          dropboxPath={viewing.proof.dropboxPath}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
