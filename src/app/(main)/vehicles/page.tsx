'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import type { ScannedVehicle } from '@/lib/types';

export default function VehiclesPage() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<ScannedVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('scanned_vehicles')
        .select('*')
        .order('scanned_at', { ascending: false })
        .limit(50);
      setVehicles(data || []);
      setLoading(false);
    };
    load();
  }, []);

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>Loading...</div>;

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
        Scanned Vehicles ({vehicles.length})
      </div>

      {vehicles.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: '#4a5f78' }}>
          <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>🚐</div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No vehicles scanned yet</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {vehicles.map((v) => {
          const title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle';
          const time = new Date(v.scanned_at);
          return (
            <div
              key={v.id}
              style={{
                background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px',
                padding: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'start',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: '14px' }}>{title}</div>
                <div style={{ fontSize: '11px', fontFamily: 'monospace', color: '#4a5f78', marginTop: '2px' }}>{v.vin}</div>
                {v.part_number && (
                  <div style={{ fontSize: '11px', color: '#93c5fd', marginTop: '3px' }}>
                    {v.part_number} — {v.end_customer}
                  </div>
                )}
                <div style={{ fontSize: '10px', color: '#4a5f78', marginTop: '3px' }}>
                  {time.toLocaleDateString([], { month: 'short', day: 'numeric' })} at {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
              <button
                onClick={() => router.push(`/photos?id=${v.id}`)}
                style={{
                  background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)',
                  borderRadius: '8px', padding: '6px 10px', color: '#a78bfa',
                  fontSize: '11px', fontWeight: 700, flexShrink: 0,
                }}
              >
                📸 Photos
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
