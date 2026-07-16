'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { DropZone } from '@/components/DropZone';

const REQUIRED_TYPES = ['front', 'back', 'driver_side', 'passenger_side', 'vin_plate'];
const ALL_TYPES = [...REQUIRED_TYPES, 'detail', 'other'];
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
  review_status: string;
  review_notes: string | null;
  uploaded_at: string;
}

export default function InstallerPhotoUploadPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { user } = useAuth();
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [job, setJob] = useState<any>(null);
  const [vins, setVins] = useState<any[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [selectedVin, setSelectedVin] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState('front');

  useEffect(() => {
    if (!user) return;
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user, jobId]);

  const loadData = async () => {
    const { data: jobData } = await supabase
      .from('cni_jobs')
      .select('id, job_number, title, status, assigned_installer_id, is_multi_unit, vin_count')
      .eq('id', jobId)
      .single();
    if (!jobData) { router.push('/installer'); return; }
    setJob(jobData);

    const { data: vinData } = await supabase
      .from('cni_job_vins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, status')
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
      .order('uploaded_at', { ascending: false });
    setPhotos(photoData || []);

    setLoading(false);
  };

  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);

  const uploadPhotos = async (files: File[]) => {
    if (!user || !job || files.length === 0) return;
    setUploading(true);
    setUploadProgress({ done: 0, total: files.length });

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = file.name.split('.').pop() || 'jpg';
        const path = `cni-photos/${job.id}/${selectedVin || 'general'}/${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

        const formData = new FormData();
        formData.append('file', file);
        formData.append('bucket', 'photos');
        formData.append('path', path);

        const res = await fetch('/api/storage', { method: 'POST', body: formData });
        const result = await res.json();

        if (result.success) {
          await supabase.from('cni_job_photos').insert({
            job_id: job.id,
            vin_id: selectedVin,
            storage_path: result.key || path,
            photo_type: selectedType,
            uploaded_by: user.id,
          });
        }

        setUploadProgress({ done: i + 1, total: files.length });
      }

      // Update photos_submitted flag once after the batch
      if (selectedVin) {
        const { data: allVinPhotos } = await supabase
          .from('cni_job_photos')
          .select('photo_type')
          .eq('job_id', job.id)
          .eq('vin_id', selectedVin);
        const typesCovered = new Set((allVinPhotos || []).map((p: any) => p.photo_type));
        if (REQUIRED_TYPES.every(t => typesCovered.has(t))) {
          await supabase.from('cni_job_vins').update({ photos_submitted: true }).eq('id', selectedVin);
        }
      }

      await loadData();
    } catch (err) {
      console.error('Upload error:', err);
    }

    setUploading(false);
    setUploadProgress(null);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      uploadPhotos(Array.from(files));
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (loading || !job) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  const currentVinPhotos = photos.filter(p => p.vin_id === selectedVin);
  const uploadedTypes = new Set(currentVinPhotos.map(p => p.photo_type));
  const missingRequired = REQUIRED_TYPES.filter(t => !uploadedTypes.has(t));
  const allRequiredMet = missingRequired.length === 0;

  const sectionStyle: React.CSSProperties = {
    padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
    background: 'var(--card)', border: '1px solid var(--border)',
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push(`/installer/jobs/${jobId}`)} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Completion Photos</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{job.job_number} • {job.title}</div>
        </div>
      </div>

      {/* VIN Selector */}
      {vins.length > 1 && (
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', marginBottom: '14px', paddingBottom: '4px' }}>
          {vins.map(v => {
            const vinPhotos = photos.filter(p => p.vin_id === v.id);
            const vinTypesCovered = new Set(vinPhotos.map(p => p.photo_type));
            const vinComplete = REQUIRED_TYPES.every(t => vinTypesCovered.has(t));
            return (
              <button
                key={v.id}
                onClick={() => setSelectedVin(v.id)}
                style={{
                  padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                  whiteSpace: 'nowrap', flexShrink: 0,
                  background: selectedVin === v.id ? 'var(--orange)' : vinComplete ? 'var(--success-bg)' : 'var(--input-bg)',
                  color: selectedVin === v.id ? '#fff' : vinComplete ? 'var(--success)' : 'var(--text-primary)',
                  border: selectedVin === v.id ? '1px solid var(--orange)' : vinComplete ? '1px solid var(--success-border)' : '1px solid var(--border)',
                }}
              >
                {vinComplete ? '✓ ' : ''}{v.vin.slice(-6)}
              </button>
            );
          })}
        </div>
      )}

      {/* Progress */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>
          REQUIRED PHOTOS ({REQUIRED_TYPES.length - missingRequired.length}/{REQUIRED_TYPES.length})
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {REQUIRED_TYPES.map(t => (
            <span key={t} style={{
              fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '6px',
              background: uploadedTypes.has(t) ? 'var(--success-bg)' : 'var(--error-bg)',
              color: uploadedTypes.has(t) ? 'var(--success)' : 'var(--error)',
              border: uploadedTypes.has(t) ? '1px solid var(--success-border)' : '1px solid var(--error-border)',
            }}>
              {uploadedTypes.has(t) ? '✓' : '✕'} {TYPE_LABELS[t]}
            </span>
          ))}
        </div>
        {allRequiredMet && (
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--success)', marginTop: '8px' }}>
            All required photos submitted for this VIN
          </div>
        )}
      </div>

      {/* Upload Controls */}
      {(job.status === 'in_progress' || job.status === 'scheduled_confirmed') && (
        <DropZone onFiles={uploadPhotos} accept="image/*" disabled={uploading} style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>UPLOAD PHOTO</div>

          <div style={{ marginBottom: '10px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>
              Photo Type
            </label>
            <select
              value={selectedType}
              onChange={e => setSelectedType(e.target.value)}
              style={{
                width: '100%', padding: '10px 14px', borderRadius: '10px',
                border: '1px solid var(--border)', background: 'var(--input-bg)',
                color: 'var(--text-body)', fontSize: '14px',
              }}
            >
              {ALL_TYPES.map(t => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]} {uploadedTypes.has(t) ? '(uploaded)' : REQUIRED_TYPES.includes(t) ? '(required)' : ''}
                </option>
              ))}
            </select>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{
                flex: 1, padding: '14px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
                background: uploading ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
              }}
            >
              {uploading
                ? uploadProgress
                  ? `Uploading ${uploadProgress.done}/${uploadProgress.total}...`
                  : 'Uploading...'
                : 'Take / Choose Photos'}
            </button>
          </div>
        </DropZone>
      )}

      {/* Uploaded Photos */}
      {currentVinPhotos.length > 0 && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>
            UPLOADED ({currentVinPhotos.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {currentVinPhotos.map(p => (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', borderRadius: '8px',
                background: 'var(--input-bg)', border: '1px solid var(--border)',
              }}>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {TYPE_LABELS[p.photo_type] || p.photo_type}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {new Date(p.uploaded_at).toLocaleString()}
                  </div>
                </div>
                <span style={{
                  fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
                  background: p.review_status === 'approved' ? 'var(--success-bg)'
                    : p.review_status === 'denied' ? 'var(--error-bg)'
                    : p.review_status === 'conditionally_approved' ? 'var(--warning-bg)'
                    : 'var(--subtle-bg)',
                  color: p.review_status === 'approved' ? 'var(--success)'
                    : p.review_status === 'denied' ? 'var(--error)'
                    : p.review_status === 'conditionally_approved' ? 'var(--warning)'
                    : 'var(--text-muted)',
                }}>
                  {p.review_status === 'approved' ? '✓ Approved'
                    : p.review_status === 'denied' ? '✕ Denied'
                    : p.review_status === 'conditionally_approved' ? '⚠ Conditional'
                    : 'Pending'}
                </span>
              </div>
            ))}
          </div>
          {currentVinPhotos.some(p => p.review_status === 'denied' && p.review_notes) && (
            <div style={{ marginTop: '10px', padding: '10px', borderRadius: '8px', background: 'var(--error-bg)', border: '1px solid var(--error-border)' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--error)', marginBottom: '4px' }}>Review Notes</div>
              {currentVinPhotos.filter(p => p.review_status === 'denied' && p.review_notes).map(p => (
                <div key={p.id} style={{ fontSize: '12px', color: 'var(--error)', marginBottom: '4px' }}>
                  {TYPE_LABELS[p.photo_type]}: {p.review_notes}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
