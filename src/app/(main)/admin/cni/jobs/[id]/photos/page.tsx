'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { r2PublicUrl } from '@/lib/r2';

const TYPE_LABELS: Record<string, string> = {
  front: 'Front',
  back: 'Back',
  driver_side: 'Driver Side',
  passenger_side: 'Passenger Side',
  vin_plate: 'VIN Plate',
  detail: 'Detail / Close-up',
  other: 'Other',
};

const REQUIRED_TYPES = ['front', 'back', 'driver_side', 'passenger_side', 'vin_plate'];

interface Photo {
  id: string;
  vin_id: string | null;
  storage_path: string;
  photo_type: string;
  review_status: string;
  review_notes: string | null;
  uploaded_at: string;
  uploaded_by: string;
}

export default function PhotoReviewPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { isAdmin, user, hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();

  const [job, setJob] = useState<any>(null);
  const [vins, setVins] = useState<any[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [selectedVin, setSelectedVin] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});

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
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, photos_submitted, photos_approved')
      .eq('job_id', jobId)
      .order('sort_order');
    setVins(vinData || []);
    if (vinData && vinData.length > 0 && !selectedVin) {
      setSelectedVin(vinData[0].id);
    }

    const { data: photoData } = await supabase
      .from('cni_job_photos')
      .select('*')
      .eq('job_id', jobId)
      .order('uploaded_at');
    setPhotos(photoData || []);

    setLoading(false);
  };

  const reviewPhoto = async (photoId: string, status: string) => {
    if (!user) return;
    setUpdating(true);
    // Through the API (audit item 16): the route writes the verdict, keeps
    // the deny-side QC note, and — the part the browser write could never
    // do — notifies the installer who has to reshoot. Before this, a denial
    // surfaced only when their invoice stalled.
    try {
      await fetch('/api/cni/review-photo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId, status, note: reviewNotes[photoId] || null }),
      });
    } catch { /* loadData below shows the true state either way */ }

    await loadData();
    setUpdating(false);
  };

  const approveAllForVin = async (vinId: string) => {
    if (!user) return;
    setUpdating(true);

    const vinPhotos = photos.filter(p => p.vin_id === vinId && p.review_status === 'pending');
    for (const photo of vinPhotos) {
      await supabase.from('cni_job_photos').update({
        review_status: 'approved',
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      }).eq('id', photo.id);
    }

    // Mark VIN photos as approved
    await supabase.from('cni_job_vins').update({ photos_approved: true }).eq('id', vinId);

    await loadData();
    setUpdating(false);
  };

  if (loading || !job) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  const currentVinPhotos = photos.filter(p => p.vin_id === selectedVin);
  const pendingCount = photos.filter(p => p.review_status === 'pending').length;
  const approvedCount = photos.filter(p => p.review_status === 'approved').length;
  const deniedCount = photos.filter(p => p.review_status === 'denied').length;

  const sectionStyle: React.CSSProperties = {
    padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
    background: 'var(--card)', border: '1px solid var(--border)',
  };

  const getPublicUrl = (path: string) => {
    // Construct URL from R2 public domain
    return `/api/storage/view?bucket=photos&path=${encodeURIComponent(path)}`;
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push(`/admin/cni/jobs/${jobId}`)} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Photo Review</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{job.job_number} • {job.title}</div>
        </div>
      </div>

      {/* Summary */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '14px',
      }}>
        <div style={{
          padding: '10px', borderRadius: '10px', textAlign: 'center',
          background: 'var(--warning-bg)', border: '1px solid var(--warning-border)',
        }}>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--warning)' }}>{pendingCount}</div>
          <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)' }}>Pending</div>
        </div>
        <div style={{
          padding: '10px', borderRadius: '10px', textAlign: 'center',
          background: 'var(--success-bg)', border: '1px solid var(--success-border)',
        }}>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--success)' }}>{approvedCount}</div>
          <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)' }}>Approved</div>
        </div>
        <div style={{
          padding: '10px', borderRadius: '10px', textAlign: 'center',
          background: 'var(--error-bg)', border: '1px solid var(--error-border)',
        }}>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--error)' }}>{deniedCount}</div>
          <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)' }}>Denied</div>
        </div>
      </div>

      {/* VIN Selector */}
      {vins.length > 1 && (
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', marginBottom: '14px', paddingBottom: '4px' }}>
          {vins.map(v => {
            const vinPhotos = photos.filter(p => p.vin_id === v.id);
            const allApproved = vinPhotos.length > 0 && vinPhotos.every(p => p.review_status === 'approved');
            const hasDenied = vinPhotos.some(p => p.review_status === 'denied');
            return (
              <button
                key={v.id}
                onClick={() => setSelectedVin(v.id)}
                style={{
                  padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                  whiteSpace: 'nowrap', flexShrink: 0,
                  background: selectedVin === v.id ? 'var(--orange)' : allApproved ? 'var(--success-bg)' : hasDenied ? 'var(--error-bg)' : 'var(--input-bg)',
                  color: selectedVin === v.id ? '#fff' : allApproved ? 'var(--success)' : hasDenied ? 'var(--error)' : 'var(--text-primary)',
                  border: selectedVin === v.id ? '1px solid var(--orange)' : '1px solid var(--border)',
                }}
              >
                {allApproved ? '✓ ' : hasDenied ? '✕ ' : ''}{v.vin.slice(-6)}
              </button>
            );
          })}
        </div>
      )}

      {/* Bulk approve */}
      {selectedVin && currentVinPhotos.some(p => p.review_status === 'pending') && (
        <button
          onClick={() => approveAllForVin(selectedVin)}
          disabled={updating}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px', marginBottom: '14px',
            fontSize: '13px', fontWeight: 700,
            background: 'var(--success)', color: '#fff', border: 'none',
          }}
        >
          ✓ Approve All Pending for This VIN ({currentVinPhotos.filter(p => p.review_status === 'pending').length})
        </button>
      )}

      {/* Photo List */}
      {currentVinPhotos.length === 0 ? (
        <div style={{
          padding: '30px', textAlign: 'center', borderRadius: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-muted)' }}>No Photos</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No photos submitted for this VIN yet</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {currentVinPhotos.map(photo => (
            <div key={photo.id} style={{
              padding: '14px', borderRadius: '14px',
              background: photo.review_status === 'denied' ? 'color-mix(in srgb, var(--error) 5%, var(--card))'
                : photo.review_status === 'approved' ? 'color-mix(in srgb, var(--success) 5%, var(--card))'
                : 'var(--card)',
              border: photo.review_status === 'denied' ? '1px solid var(--error-border)'
                : photo.review_status === 'approved' ? '1px solid var(--success-border)'
                : '1px solid var(--border)',
            }}>
              {/* Photo header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {TYPE_LABELS[photo.photo_type] || photo.photo_type}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {new Date(photo.uploaded_at).toLocaleString()}
                  </div>
                </div>
                <span style={{
                  fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
                  background: photo.review_status === 'approved' ? 'var(--success-bg)'
                    : photo.review_status === 'denied' ? 'var(--error-bg)'
                    : photo.review_status === 'conditionally_approved' ? 'var(--warning-bg)'
                    : 'var(--subtle-bg)',
                  color: photo.review_status === 'approved' ? 'var(--success)'
                    : photo.review_status === 'denied' ? 'var(--error)'
                    : photo.review_status === 'conditionally_approved' ? 'var(--warning)'
                    : 'var(--text-muted)',
                }}>
                  {photo.review_status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </span>
              </div>

              {/* Photo preview */}
              <div style={{
                width: '100%', height: '200px', borderRadius: '8px', marginBottom: '10px',
                background: 'var(--input-bg)', border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden',
              }}>
                <img
                  src={getPublicUrl(photo.storage_path)}
                  alt={TYPE_LABELS[photo.photo_type]}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>

              {/* Review notes */}
              {photo.review_notes && (
                <div style={{ fontSize: '12px', color: 'var(--error)', marginBottom: '8px', fontStyle: 'italic' }}>
                  Note: {photo.review_notes}
                </div>
              )}

              {/* Review actions */}
              {photo.review_status === 'pending' && (
                <>
                  <input
                    type="text"
                    placeholder="Review notes (optional)..."
                    value={reviewNotes[photo.id] || ''}
                    onChange={e => setReviewNotes({ ...reviewNotes, [photo.id]: e.target.value })}
                    style={{
                      width: '100%', padding: '8px 12px', borderRadius: '8px', marginBottom: '8px',
                      border: '1px solid var(--border)', background: 'var(--input-bg)',
                      color: 'var(--text-body)', fontSize: '12px',
                    }}
                  />
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => reviewPhoto(photo.id, 'approved')}
                      disabled={updating}
                      style={{
                        flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                        background: 'var(--success)', color: '#fff', border: 'none',
                      }}
                    >
                      ✓ Approve
                    </button>
                    <button
                      onClick={() => reviewPhoto(photo.id, 'conditionally_approved')}
                      disabled={updating}
                      style={{
                        flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                        background: 'var(--warning)', color: '#fff', border: 'none',
                      }}
                    >
                      ⚠ Conditional
                    </button>
                    <button
                      onClick={() => reviewPhoto(photo.id, 'denied')}
                      disabled={updating}
                      style={{
                        flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                        background: 'var(--error)', color: '#fff', border: 'none',
                      }}
                    >
                      ✕ Deny
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
