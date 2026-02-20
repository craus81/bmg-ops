'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface Photo {
  id: string;
  storage_path: string;
  taken_at: string;
  url?: string;
}

export default function PhotosPage() {
  const router = useRouter();
  const params = useSearchParams();
  const vehicleId = params.get('id');
  const { user } = useAuth();
  const supabase = createClient();

  const [photos, setPhotos] = useState<Photo[]>([]);
  const [vehicle, setVehicle] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!vehicleId) return;
    const load = async () => {
      const { data: v } = await supabase
        .from('scanned_vehicles')
        .select('*')
        .eq('id', vehicleId)
        .single();
      setVehicle(v);
      setSubmitted(v?.submitted_for_review || false);

      const { data: p } = await supabase
        .from('vehicle_photos')
        .select('*')
        .eq('vehicle_id', vehicleId)
        .order('taken_at', { ascending: true });

      const photosWithUrls = await Promise.all(
        (p || []).map(async (photo: Photo) => {
          const { data } = supabase.storage.from('photos').getPublicUrl(photo.storage_path);
          return { ...photo, url: data.publicUrl };
        })
      );
      setPhotos(photosWithUrls);
      setLoading(false);
    };
    load();
  }, [vehicleId]);

  const handleUpload = async (file: File) => {
    if (!vehicleId || !user) return;
    setUploading(true);

    const ext = file.name.split('.').pop() || 'jpg';
    const path = `${vehicleId}/${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from('photos')
      .upload(path, file, { contentType: file.type });

    if (upErr) {
      alert('Upload failed: ' + upErr.message);
      setUploading(false);
      return;
    }

    const { data: record } = await supabase
      .from('vehicle_photos')
      .insert({
        vehicle_id: vehicleId,
        storage_path: path,
        photo_type: 'completion',
        taken_by: user.id,
      })
      .select()
      .single();

    if (record) {
      const { data: urlData } = supabase.storage.from('photos').getPublicUrl(path);
      setPhotos((prev) => [...prev, { ...record, url: urlData.publicUrl }]);
    }
    setUploading(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    e.target.value = '';
  };

  const handleSubmitForReview = async () => {
    if (!vehicleId || !user || photos.length === 0) return;
    setSubmitting(true);

    // Update vehicle status
    await supabase
      .from('scanned_vehicles')
      .update({
        submitted_for_review: true,
        submitted_at: new Date().toISOString(),
        review_status: 'pending',
      })
      .eq('id', vehicleId);

    // Get all admin users
    const { data: admins } = await supabase
      .from('profiles')
      .select('id, email')
      .eq('role', 'admin')
      .eq('status', 'approved');

    // Create notification for each admin
    if (admins && admins.length > 0) {
      const title = vehicle
        ? `Photo review: ${[vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model].filter(Boolean).join(' ')}`
        : 'New photo review submitted';

      await supabase
        .from('notifications')
        .insert(admins.map((admin: any) => ({
          user_id: admin.id,
          type: 'review_submitted',
          title,
          body: `${photos.length} photo${photos.length !== 1 ? 's' : ''} submitted for VIN ${vehicle?.vin || 'unknown'}`,
          vehicle_id: vehicleId,
        })));

      // Call edge function to send email
      try {
        await supabase.functions.invoke('send-review-email', {
          body: {
            type: 'submitted',
            vehicle_id: vehicleId,
            vehicle_info: vehicle ? `${vehicle.vehicle_year || ''} ${vehicle.vehicle_make || ''} ${vehicle.vehicle_model || ''}`.trim() : 'Unknown',
            vin: vehicle?.vin || '',
            photo_count: photos.length,
            submitted_by: user.id,
            admin_emails: admins.map((a: any) => a.email),
          },
        });
      } catch (e) {
        console.error('Email send failed:', e);
        // Don't block the submission if email fails
      }
    }

    setSubmitted(true);
    setSubmitting(false);
  };

  if (!vehicleId) return <div style={{ color: 'var(--error)', padding: '20px' }}>No vehicle ID</div>;
  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  const title = vehicle
    ? [vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model].filter(Boolean).join(' ')
    : 'Vehicle';

  const reviewStatus = vehicle?.review_status || 'none';

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
        Completion Photos
      </div>
      <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '4px', color: 'var(--text-primary)' }}>{title}</div>
      {vehicle?.vin && (
        <div style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-muted)', marginBottom: '8px' }}>{vehicle.vin}</div>
      )}

      {/* Review status banner */}
      {reviewStatus === 'pending' && (
        <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>⏳</span>
          <div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--warning)' }}>Pending Review</div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Waiting for admin approval</div>
          </div>
        </div>
      )}
      {reviewStatus === 'approved' && (
        <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'var(--success-bg)', border: '1px solid var(--success-border)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>✅</span>
          <div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--success)' }}>Approved</div>
            {vehicle?.review_notes && <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{vehicle.review_notes}</div>}
          </div>
        </div>
      )}
      {reviewStatus === 'denied' && (
        <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '16px' }}>❌</span>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--error)' }}>Needs Rework</div>
              {vehicle?.review_notes && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{vehicle.review_notes}</div>}
            </div>
          </div>
          <button
            onClick={() => { setSubmitted(false); }}
            style={{
              marginTop: '8px', width: '100%', padding: '8px', borderRadius: '8px',
              background: 'transparent', border: '1px solid var(--error-border)',
              color: 'var(--error)', fontSize: '11px', fontWeight: 700,
            }}
          >
            Upload new photos and resubmit
          </button>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      {/* Upload buttons — hide if already approved */}
      {reviewStatus !== 'approved' && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            style={{
              flex: 1, padding: '14px', borderRadius: '10px',
              background: 'var(--navy)', color: '#fff', fontWeight: 700, fontSize: '14px',
              opacity: uploading ? 0.5 : 1, border: 'none',
            }}
          >
            {uploading ? 'Uploading...' : '📸 Take Photo'}
          </button>
          <button
            onClick={() => {
              if (fileRef.current) {
                fileRef.current.removeAttribute('capture');
                fileRef.current.click();
                fileRef.current.setAttribute('capture', 'environment');
              }
            }}
            disabled={uploading}
            style={{
              padding: '14px 18px', borderRadius: '10px',
              border: '1px solid var(--border)', background: 'var(--card)',
              color: 'var(--text-muted)', fontWeight: 700, fontSize: '14px',
            }}
          >
            📁
          </button>
        </div>
      )}

      {photos.length === 0 && (
        <div style={{ textAlign: 'center', padding: '28px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>📷</div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No photos yet — tap to add</div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' }}>
        {photos.map((p) => (
          <div key={p.id} style={{ position: 'relative', paddingTop: '100%', borderRadius: '8px', overflow: 'hidden', background: 'var(--card)' }}>
            {p.url && (
              <img
                src={p.url}
                alt="Vehicle photo"
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
              />
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {/* Submit for Review button */}
        {photos.length > 0 && reviewStatus !== 'approved' && !submitted && (
          <button
            onClick={handleSubmitForReview}
            disabled={submitting}
            style={{
              width: '100%', padding: '14px', borderRadius: '14px',
              background: 'var(--orange)', color: '#fff',
              fontWeight: 800, fontSize: '15px', border: 'none',
              boxShadow: '0 4px 16px rgba(238,49,32,0.3)',
              opacity: submitting ? 0.5 : 1,
            }}
          >
            {submitting ? 'Submitting...' : `✓ Submit ${photos.length} Photo${photos.length !== 1 ? 's' : ''} for Review`}
          </button>
        )}

        {submitted && reviewStatus === 'pending' && (
          <div style={{
            width: '100%', padding: '14px', borderRadius: '14px', textAlign: 'center',
            background: 'var(--warning-bg)', border: '1px solid var(--warning-border)',
            color: 'var(--warning)', fontWeight: 700, fontSize: '13px',
          }}>
            ⏳ Submitted — waiting for admin review
          </div>
        )}

        <button
          onClick={() => router.push('/scan')}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px',
            background: 'var(--tab-active-bg)', border: '1px solid var(--tab-active-border)',
            color: 'var(--tab-active-color)', fontWeight: 700, fontSize: '13px',
          }}
        >
          📷 Scan Next VIN
        </button>
        <button
          onClick={() => router.back()}
          style={{
            width: '100%', padding: '10px', borderRadius: '10px',
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700,
          }}
        >
          ← Back
        </button>
      </div>
    </div>
  );
}
