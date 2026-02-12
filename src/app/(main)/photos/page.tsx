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

  if (!vehicleId) return <div style={{ color: '#f87171', padding: '20px' }}>No vehicle ID</div>;
  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>Loading...</div>;

  const title = vehicle
    ? [vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model].filter(Boolean).join(' ')
    : 'Vehicle';

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
        Completion Photos
      </div>
      <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '4px' }}>{title}</div>
      {vehicle?.vin && (
        <div style={{ fontSize: '11px', fontFamily: 'monospace', color: '#4a5f78', marginBottom: '16px' }}>{vehicle.vin}</div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          style={{
            flex: 1, padding: '14px', borderRadius: '10px',
            background: '#3b82f6', color: '#fff', fontWeight: 700, fontSize: '14px',
            opacity: uploading ? 0.5 : 1,
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
            border: '1px solid #1e2d3d', background: '#141e2b',
            color: '#6b7a8d', fontWeight: 700, fontSize: '14px',
          }}
        >
          📁
        </button>
      </div>

      {photos.length === 0 && (
        <div style={{ textAlign: 'center', padding: '28px 0', color: '#4a5f78' }}>
          <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>📷</div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No photos yet — tap to add</div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' }}>
        {photos.map((p) => (
          <div key={p.id} style={{ position: 'relative', paddingTop: '100%', borderRadius: '8px', overflow: 'hidden', background: '#141e2b' }}>
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
        <button
          onClick={() => router.push('/scan')}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px',
            background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)',
            color: '#60a5fa', fontWeight: 700, fontSize: '13px',
          }}
        >
          📷 Scan Next VIN
        </button>
        <button
          onClick={() => router.back()}
          style={{
            width: '100%', padding: '10px', borderRadius: '10px',
            border: '1px solid #1e2d3d', background: 'transparent',
            color: '#6b7a8d', fontSize: '13px', fontWeight: 700,
          }}
        >
          ← Back
        </button>
      </div>
    </div>
  );
}
