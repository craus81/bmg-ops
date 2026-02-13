'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

interface Photo {
  id: string;
  storage_path: string;
  taken_at: string;
  url?: string;
}

export default function PublicVehicleView() {
  const params = useParams();
  const vehicleId = params.id as string;
  const supabase = createClient();

  const [vehicle, setVehicle] = useState<any>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    if (!vehicleId) return;
    var load = async () => {
      var { data: v, error } = await supabase
        .from('scanned_vehicles')
        .select('*')
        .eq('id', vehicleId)
        .single();

      if (error || !v) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setVehicle(v);

      var { data: p } = await supabase
        .from('vehicle_photos')
        .select('*')
        .eq('vehicle_id', vehicleId)
        .order('taken_at', { ascending: true });

      var photosWithUrls = await Promise.all(
        (p || []).map(async function(photo: Photo) {
          var { data } = supabase.storage.from('photos').getPublicUrl(photo.storage_path);
          return { ...photo, url: data.publicUrl };
        })
      );
      setPhotos(photosWithUrls);
      setLoading(false);
    };
    load();
  }, [vehicleId]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#0a1017', color: '#e8ecf1', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: '36px', height: '36px', border: '3px solid #1e2d3d', borderTopColor: '#3b82f6', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{ color: '#4a5f78', marginTop: '12px', fontSize: '13px' }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div style={{ minHeight: '100vh', background: '#0a1017', color: '#e8ecf1', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '48px', marginBottom: '12px', opacity: 0.4 }}>🚫</div>
          <div style={{ fontWeight: 700, fontSize: '16px' }}>Vehicle Not Found</div>
          <div style={{ color: '#4a5f78', fontSize: '13px', marginTop: '4px' }}>This link may be invalid or expired.</div>
        </div>
      </div>
    );
  }

  var title = vehicle
    ? [vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model].filter(Boolean).join(' ')
    : 'Vehicle';

  return (
    <div style={{ minHeight: '100vh', background: '#0a1017', color: '#e8ecf1' }}>
      <div style={{ maxWidth: '600px', margin: '0 auto', padding: '20px 16px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(59,130,246,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: 800, color: '#3b82f6' }}>B</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: '11px', color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '1px' }}>BMG Fleet Installations</div>
            <div style={{ fontSize: '10px', color: '#3a4a5c' }}>Vehicle Completion Report</div>
          </div>
        </div>

        {/* Vehicle info */}
        <div style={{ background: 'linear-gradient(135deg, #1a2a3f, #1e3350)', border: '1px solid #2a4a6f', borderRadius: '14px', padding: '18px', marginBottom: '16px' }}>
          <div style={{ fontSize: '10px', color: '#4a5f78', fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase' }}>VIN</div>
          <div style={{ fontSize: '13px', fontFamily: 'monospace', color: '#93c5fd', fontWeight: 700, letterSpacing: '1.5px', marginTop: '2px', marginBottom: '10px', wordBreak: 'break-all' }}>{vehicle.vin}</div>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>{title || 'Unknown Vehicle'}</div>
          {vehicle.body_class && <div style={{ fontSize: '13px', color: '#6b7a8d', marginTop: '2px' }}>{vehicle.body_class}</div>}
          {vehicle.part_number && (
            <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(42,74,111,0.5)' }}>
              <div style={{ fontSize: '12px', color: '#60a5fa', fontWeight: 700 }}>{vehicle.part_number}</div>
              {vehicle.end_customer && <div style={{ fontSize: '11px', color: '#4a5f78' }}>{vehicle.end_customer}</div>}
            </div>
          )}
          {vehicle.scanned_at && (
            <div style={{ fontSize: '11px', color: '#3a4a5c', marginTop: '8px' }}>
              Completed: {new Date(vehicle.scanned_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
            </div>
          )}
        </div>

        {/* Photos */}
        {photos.length > 0 ? (
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>
              Completion Photos ({photos.length})
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px' }}>
              {photos.map(function(p) {
                return (
                  <div key={p.id} onClick={function() { setLightbox(p.url || null); }} style={{ position: 'relative', paddingTop: '75%', borderRadius: '10px', overflow: 'hidden', background: '#141e2b', cursor: 'pointer' }}>
                    {p.url && (
                      <img
                        src={p.url}
                        alt="Vehicle completion photo"
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '28px 0', color: '#4a5f78' }}>
            <div style={{ fontSize: '13px', fontWeight: 600 }}>No completion photos available</div>
          </div>
        )}

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: '32px', paddingTop: '16px', borderTop: '1px solid #1e2d3d' }}>
          <div style={{ fontSize: '11px', color: '#3a4a5c' }}>BMG Fleet Installations LLC</div>
        </div>
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div onClick={function() { setLightbox(null); }} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
          <img src={lightbox} alt="Full size" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px' }} />
          <div style={{ position: 'absolute', top: '20px', right: '20px', color: '#fff', fontSize: '24px', fontWeight: 700, cursor: 'pointer' }}>✕</div>
        </div>
      )}
    </div>
  );
}
