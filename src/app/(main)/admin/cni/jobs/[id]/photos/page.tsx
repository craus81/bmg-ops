'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { storageDownloadUrl } from '@/lib/storage';

const TYPE_LABELS: Record<string, string> = {
  front: 'Front',
  back: 'Back',
  driver_side: 'Driver Side',
  passenger_side: 'Passenger Side',
  vin_plate: 'VIN Plate',
  detail: 'Detail / Close-up',
  other: 'Other',
};

interface Photo {
  id: string;
  vin_id: string | null;
  storage_path: string;
  photo_type: string;
  uploaded_at: string;
  uploaded_by: string;
  // Advisory pre-screen (R6-8) — the automatic check that runs at upload so
  // the installer can retake a bad shot while still at the vehicle. It is
  // shown here as context, including that it did not run ('not_screened',
  // which is NOT a pass). It has never been a verdict, and since migration
  // 307 retired the photo review there is no verdict at all.
  prescreen_verdict?: string | null;
  prescreen_notes?: string | null;
}

/** Photos taken by the outside installer on this job, as a gallery. */
export default function JobPhotosPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { isAdmin, hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();

  const [job, setJob] = useState<any>(null);
  const [vins, setVins] = useState<any[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  // null = the job-level set (photos uploaded without a VIN, which a
  // single-unit job produces).
  const [selectedVin, setSelectedVin] = useState<string | null>(null);
  const [uploaderNames, setUploaderNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!hasFeature('cni_admin')) { router.push('/home'); return; }
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin, jobId]);

  const loadData = async () => {
    const { data: jobData } = await supabase
      .from('cni_jobs')
      .select('id, job_number, title, status, assigned_installer_id')
      .eq('id', jobId)
      .single();
    if (!jobData) { router.push('/admin/cni'); return; }
    setJob(jobData);

    const { data: vinData } = await supabase
      .from('cni_job_vins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, photos_submitted')
      .eq('job_id', jobId)
      .order('sort_order');
    setVins(vinData || []);

    const { data: photoData } = await supabase
      .from('cni_job_photos')
      .select('id, vin_id, storage_path, photo_type, uploaded_at, uploaded_by, prescreen_verdict, prescreen_notes')
      .eq('job_id', jobId)
      .order('uploaded_at');
    const loaded = (photoData || []) as Photo[];
    setPhotos(loaded);

    // Who took them. A gallery whose every caption says "an installer" is
    // no use when a company runs a three-person crew on one job.
    const ids = Array.from(new Set(loaded.map(p => p.uploaded_by).filter(Boolean)));
    if (ids.length > 0) {
      const { data: people } = await supabase
        .from('profiles').select('id, full_name, email').in('id', ids);
      const names: Record<string, string> = {};
      for (const p of people || []) names[p.id] = p.full_name || p.email || 'Installer';
      setUploaderNames(names);
    }

    // Land on the first VIN that actually has photos, so the page never
    // opens on an empty set while photos sit one chip away.
    setSelectedVin(prev => {
      if (prev !== null) return prev;
      const firstWithPhotos = (vinData || []).find((v: any) => loaded.some(p => p.vin_id === v.id));
      if (firstWithPhotos) return firstWithPhotos.id;
      if (loaded.some(p => !p.vin_id)) return null;
      return (vinData || [])[0]?.id ?? null;
    });

    setLoading(false);
  };

  if (loading || !job) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  const jobLevelPhotos = photos.filter(p => !p.vin_id);
  const currentPhotos = selectedVin === null
    ? jobLevelPhotos
    : photos.filter(p => p.vin_id === selectedVin);

  // R3-2: storage_path rows carry either the full R2 key ('photos/cni-photos/…',
  // from the upload response) or the bucket-relative path (legacy fallback
  // rows); split accordingly and serve through the credentialed download route.
  const photoUrl = (storagePath: string) => {
    const rel = storagePath.startsWith('photos/') ? storagePath.slice('photos/'.length) : storagePath;
    return storageDownloadUrl('photos', rel, rel.split('/').pop() || 'photo.jpg');
  };

  const vinLabel = (v: any) =>
    [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || v.vin;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push(`/admin/cni/jobs/${jobId}`)} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Installer Photos</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {job.job_number} • {job.title} • {photos.length} photo{photos.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {/* VIN selector — one chip per vehicle, plus a job-level chip when
          photos were uploaded without a VIN (single-unit jobs). Those used to
          be unreachable: the page filtered on the selected VIN only, so a
          null-VIN photo rendered nowhere. */}
      {(vins.length > 1 || jobLevelPhotos.length > 0) && (
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', marginBottom: '14px', paddingBottom: '4px' }}>
          {jobLevelPhotos.length > 0 && (
            <button
              onClick={() => setSelectedVin(null)}
              style={{
                padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                whiteSpace: 'nowrap', flexShrink: 0,
                background: selectedVin === null ? 'var(--orange)' : 'var(--input-bg)',
                color: selectedVin === null ? '#fff' : 'var(--text-primary)',
                border: selectedVin === null ? '1px solid var(--orange)' : '1px solid var(--border)',
              }}
            >
              Job ({jobLevelPhotos.length})
            </button>
          )}
          {vins.map(v => {
            const count = photos.filter(p => p.vin_id === v.id).length;
            const active = selectedVin === v.id;
            return (
              <button
                key={v.id}
                onClick={() => setSelectedVin(v.id)}
                title={vinLabel(v)}
                style={{
                  padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                  whiteSpace: 'nowrap', flexShrink: 0,
                  background: active ? 'var(--orange)' : 'var(--input-bg)',
                  color: active ? '#fff' : count > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                  border: active ? '1px solid var(--orange)' : '1px solid var(--border)',
                }}
              >
                {v.vin.slice(-6)} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Photo list */}
      {currentPhotos.length === 0 ? (
        <div style={{
          padding: '30px', textAlign: 'center', borderRadius: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-muted)' }}>No Photos</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {selectedVin === null ? 'No job-level photos' : 'No photos submitted for this VIN yet'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {currentPhotos.map(photo => (
            <div key={photo.id} style={{
              padding: '14px', borderRadius: '14px',
              background: 'var(--card)', border: '1px solid var(--border)',
            }}>
              {/* Photo header */}
              <div style={{ marginBottom: '8px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {TYPE_LABELS[photo.photo_type] || photo.photo_type}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {new Date(photo.uploaded_at).toLocaleString()}
                  {uploaderNames[photo.uploaded_by] ? ` • ${uploaderNames[photo.uploaded_by]}` : ''}
                </div>
                {photo.prescreen_verdict && photo.prescreen_verdict !== 'pass' && (
                  <div style={{
                    fontSize: '11px', marginTop: '2px', fontWeight: 600,
                    color: photo.prescreen_verdict === 'retake' ? 'var(--error)'
                      : photo.prescreen_verdict === 'unsure' ? 'var(--warning, #f59e0b)'
                      : 'var(--text-muted)',
                  }}>
                    {photo.prescreen_verdict === 'not_screened' ? 'Not auto-checked' : 'Auto-check flagged'}
                    {photo.prescreen_notes ? `: ${photo.prescreen_notes}` : ''}
                  </div>
                )}
              </div>

              {/* Photo */}
              <a
                href={photoUrl(photo.storage_path)}
                target="_blank"
                rel="noopener noreferrer"
                title="Open full size"
                style={{
                  display: 'flex', width: '100%', height: '220px', borderRadius: '8px',
                  background: 'var(--input-bg)', border: '1px solid var(--border)',
                  alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                }}
              >
                <img
                  src={photoUrl(photo.storage_path)}
                  alt={TYPE_LABELS[photo.photo_type] || photo.photo_type}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                  onError={e => {
                    // Say WHAT failed instead of leaving a silent grey box.
                    const el = e.target as HTMLImageElement;
                    el.style.display = 'none';
                    const parent = el.parentElement;
                    if (parent && !parent.querySelector('[data-imgfail]')) {
                      const msg = document.createElement('div');
                      msg.setAttribute('data-imgfail', '1');
                      msg.textContent = 'Photo failed to load. Open it directly: ' + photo.storage_path;
                      msg.style.cssText = 'font-size:11px;color:var(--error);padding:10px;text-align:center;word-break:break-all;';
                      parent.appendChild(msg);
                    }
                  }}
                />
              </a>
            </div>
          ))}
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
