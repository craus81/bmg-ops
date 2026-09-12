'use client';

/**
 * The vehicle record for work done OUTSIDE the shop.
 *
 * A vehicle a CNI or field installer completes in a customer's yard never
 * gets a check-in, so it had no record and its photos were reachable only by
 * knowing which job to open. This is that vehicle's page: what was installed,
 * where, for whom, by whom — and every photo taken of it.
 *
 * Shop visits are deliberately NOT rendered here; they have their own
 * screens (tracking board, pick-list) and this links across to them.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import PhotoLightbox, { type LightboxPhoto } from '@/components/PhotoLightbox';
import { deepLinks } from '@/lib/deep-links';

interface InstallPhoto {
  id: string;
  url: string;
  kind: 'installer' | 'completion';
  label: string;
  takenAt: string | null;
  takenByName: string | null;
}

interface Install {
  id: string;
  kind: 'completed' | 'in_progress';
  at: string | null;
  locationName: string | null;
  billableCustomer: string | null;
  partNumber: string | null;
  partDescription: string | null;
  unitNumber: string | null;
  serialNumber: string | null;
  imei: string | null;
  iccid: string | null;
  byName: string | null;
  companyName: string | null;
  job: { id: string; number: string | null; title: string | null } | null;
  photos: InstallPhoto[];
  status?: string;
}

interface VehicleRecord {
  vin: string;
  vehicle: { year: string | null; make: string | null; model: string | null };
  installs: Install[];
  shopVisits: { id: string; at: string; status: string; archived: boolean }[];
  capped: boolean;
}

export default function VehicleRecordPage() {
  const params = useParams();
  const router = useRouter();
  const vin = String(params.vin || '').toUpperCase();
  const { loading: authLoading } = useAuth();

  const [record, setRecord] = useState<VehicleRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Lightbox paging stays inside ONE install's photo set — paging from a
  // 2024 install into a 2026 one would be a confusing jump.
  const [viewer, setViewer] = useState<{ installId: string; idx: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/vehicles/${encodeURIComponent(vin)}/installs`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setRecord(body);
    } catch (e: any) {
      // An empty page would read as "this vehicle has no installs", which is
      // the wrong conclusion to draw from a failed request.
      setError(e?.message || 'Could not load the vehicle record');
    }
    setLoading(false);
  }, [vin]);

  useEffect(() => {
    if (authLoading) return;
    load();
  }, [authLoading, load]);

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>;
  }

  const vehicleName = record
    ? [record.vehicle.year, record.vehicle.make, record.vehicle.model].filter(Boolean).join(' ')
    : '';

  const openInstall = viewer ? record?.installs.find(i => i.id === viewer.installId) : null;
  const shots: LightboxPhoto[] = (openInstall?.photos || []).map(p => ({
    id: p.id,
    url: p.url,
    title: `${vin} · ${p.label}`,
    subtitle: [
      p.kind === 'installer' ? 'Installer photo' : 'Completion photo',
      openInstall?.job?.number,
      p.takenByName,
      p.takenAt ? new Date(p.takenAt).toLocaleString() : null,
    ].filter(Boolean).join(' · '),
  }));

  const card: React.CSSProperties = {
    padding: '14px 16px', borderRadius: '12px', marginBottom: '12px',
    background: 'var(--card)', border: '1px solid var(--border)',
  };
  const fieldLabel: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.4px',
  };
  const fieldValue: React.CSSProperties = {
    fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '2px',
  };

  const field = (label: string, value: string | null | undefined) => (
    value ? (
      <div>
        <div style={fieldLabel}>{label}</div>
        <div style={fieldValue}>{value}</div>
      </div>
    ) : null
  );

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.back()} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {vin}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {vehicleName || 'Vehicle record'}
            {record && ` • ${record.installs.length} install${record.installs.length !== 1 ? 's' : ''}`}
          </div>
        </div>
      </div>

      {error && (
        <div style={{
          ...card,
          background: 'var(--error-bg)', border: '1px solid var(--error-border)',
          color: 'var(--error)', fontSize: '13px', fontWeight: 600,
        }}>
          Could not load this vehicle: {error}
        </div>
      )}

      {/* Shop visits — links only; the shop has its own screens. */}
      {record && record.shopVisits.length > 0 && (
        <div style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>
            Also came through the shop:
          </span>
          {record.shopVisits.map(v => (
            <button
              key={v.id}
              onClick={() => router.push(`/vehicles/${encodeURIComponent(vin)}/pick-list?visit=${v.id}`)}
              style={{
                padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                color: 'var(--text-secondary)', cursor: 'pointer',
              }}
            >
              {new Date(v.at).toLocaleDateString()}{v.archived ? ' (archived)' : ''} →
            </button>
          ))}
        </div>
      )}

      {/* Installs */}
      {record && record.installs.length === 0 && !error && (
        <div style={{ ...card, textAlign: 'center', padding: '30px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-muted)' }}>No installs recorded</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            Nothing has been scanned or completed against this VIN outside the shop.
          </div>
        </div>
      )}

      {record?.installs.map(install => (
        <div key={install.id} style={card}>
          {/* When + status */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', marginBottom: '10px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
              {install.at ? new Date(install.at).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : 'Date unknown'}
            </div>
            <span style={{
              fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
              background: install.kind === 'completed' ? 'var(--success-bg)' : 'var(--warning-bg)',
              color: install.kind === 'completed' ? 'var(--success)' : 'var(--warning)',
            }}>
              {install.kind === 'completed' ? 'Completed' : 'In progress'}
            </span>
          </div>

          {/* The record itself */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px', marginBottom: '12px' }}>
            {field('Install location', install.locationName)}
            {field('Billable customer', install.billableCustomer)}
            {field('Part', install.partNumber
              ? `${install.partNumber}${install.partDescription ? ` — ${install.partDescription}` : ''}`
              : null)}
            {field('Unit #', install.unitNumber)}
            {field('Installed by', [install.byName, install.companyName].filter(Boolean).join(' · ') || null)}
            {field('Serial', install.serialNumber)}
            {field('IMEI', install.imei)}
            {field('CCID', install.iccid)}
          </div>

          {install.job && (
            <button
              onClick={() => router.push(deepLinks.cniJob(install.job!.id))}
              style={{
                padding: 0, background: 'transparent', border: 'none', marginBottom: '10px',
                fontSize: '11px', fontWeight: 700, color: 'var(--orange)', cursor: 'pointer',
              }}
            >
              {install.job.number || 'CNI job'}{install.job.title ? ` — ${install.job.title}` : ''} →
            </button>
          )}

          {/* Photos */}
          {install.photos.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No photos on this install
            </div>
          ) : (
            <>
              <div style={{ ...fieldLabel, marginBottom: '6px' }}>
                {install.photos.length} photo{install.photos.length !== 1 ? 's' : ''}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '8px' }}>
                {install.photos.map((p, i) => (
                  <button
                    key={p.id}
                    onClick={() => setViewer({ installId: install.id, idx: i })}
                    title={`${p.label} — view full screen`}
                    style={{
                      padding: 0, border: '1px solid var(--border)', borderRadius: '8px',
                      overflow: 'hidden', background: 'var(--input-bg)', cursor: 'zoom-in',
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.url}
                      alt={p.label}
                      loading="lazy"
                      style={{ display: 'block', width: '100%', height: '90px', objectFit: 'cover' }}
                      onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                    />
                    <div style={{
                      fontSize: '9px', fontWeight: 700, padding: '4px 6px', textAlign: 'left',
                      color: p.kind === 'installer' ? 'var(--text-secondary)' : 'var(--success)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {p.label}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ))}

      {record?.capped && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: '12px' }}>
          Showing the most recent {record.installs.length} installs for this VIN.
        </div>
      )}

      <PhotoLightbox
        photos={shots}
        index={viewer ? viewer.idx : null}
        onClose={() => setViewer(null)}
        onIndex={i => setViewer(v => (v ? { ...v, idx: i } : v))}
      />

      <div style={{ height: '80px' }} />
    </div>
  );
}
