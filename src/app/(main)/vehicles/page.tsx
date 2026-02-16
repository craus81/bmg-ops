'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import SwipeToDelete from '@/components/SwipeToDelete';
import { theme } from '@/lib/theme';
import type { ScannedVehicle } from '@/lib/types';

export default function VehiclesPage() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<ScannedVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ vin: '', vehicle_year: '', vehicle_make: '', vehicle_model: '', part_number: '', end_customer: '' });
  const supabase = createClient();

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from('scanned_vehicles').select('*').order('scanned_at', { ascending: false }).limit(50);
      setVehicles((data as ScannedVehicle[]) || []);
      setLoading(false);
    };
    load();
  }, []);

  const handleDelete = async (id: string) => {
    await supabase.from('vehicle_photos').delete().eq('vehicle_id', id);
    const { error } = await supabase.from('scanned_vehicles').delete().eq('id', id);
    if (!error) setVehicles((prev) => prev.filter((v) => v.id !== id));
  };

  const startEdit = (v: ScannedVehicle) => {
    setEditId(v.id);
    setEditForm({ vin: v.vin, vehicle_year: v.vehicle_year || '', vehicle_make: v.vehicle_make || '', vehicle_model: v.vehicle_model || '', part_number: v.part_number || '', end_customer: v.end_customer || '' });
  };

  const saveEdit = async () => {
    if (!editId) return;
    const { error } = await supabase.from('scanned_vehicles').update({
      vin: editForm.vin, vehicle_year: editForm.vehicle_year || null, vehicle_make: editForm.vehicle_make || null,
      vehicle_model: editForm.vehicle_model || null, part_number: editForm.part_number || null, end_customer: editForm.end_customer || null,
    }).eq('id', editId);
    if (!error) {
      setVehicles((prev) => prev.map((v) => v.id === editId ? { ...v, vin: editForm.vin, vehicle_year: editForm.vehicle_year || null, vehicle_make: editForm.vehicle_make || null, vehicle_model: editForm.vehicle_model || null, part_number: editForm.part_number || null, end_customer: editForm.end_customer || null } : v));
      setEditId(null);
    }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: theme.textMuted }}>Loading...</div>;

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
        Scanned Vehicles ({vehicles.length})
      </div>

      {vehicles.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: theme.textMuted }}>
          <div style={{ fontSize: '40px', marginBottom: '8px', opacity: 0.3 }}>🚐</div>
          <div style={{ fontWeight: 600, fontSize: '14px' }}>No vehicles scanned yet</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {vehicles.map((v) => {
          const title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle';
          const time = new Date(v.scanned_at);
          const isEditing = editId === v.id;

          return (
            <SwipeToDelete key={v.id} onDelete={() => handleDelete(v.id)}>
              <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '14px 16px', boxShadow: theme.shadowSm }}>
                {isEditing ? (
                  <div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <EditInput label="VIN" value={editForm.vin} onChange={(v) => setEditForm({ ...editForm, vin: v })} />
                      <EditInput label="Year" value={editForm.vehicle_year} onChange={(v) => setEditForm({ ...editForm, vehicle_year: v })} />
                      <EditInput label="Make" value={editForm.vehicle_make} onChange={(v) => setEditForm({ ...editForm, vehicle_make: v })} />
                      <EditInput label="Model" value={editForm.vehicle_model} onChange={(v) => setEditForm({ ...editForm, vehicle_model: v })} />
                      <EditInput label="Part #" value={editForm.part_number} onChange={(v) => setEditForm({ ...editForm, part_number: v })} />
                      <EditInput label="End Customer" value={editForm.end_customer} onChange={(v) => setEditForm({ ...editForm, end_customer: v })} />
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                      <button onClick={saveEdit} style={{ flex: 1, padding: '10px', borderRadius: '10px', background: theme.success, color: '#fff', fontSize: '13px', fontWeight: 700, border: 'none' }}>Save</button>
                      <button onClick={() => setEditId(null)} style={{ flex: 1, padding: '10px', borderRadius: '10px', background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textMuted, fontSize: '13px', fontWeight: 700 }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                    <div style={{ flex: 1 }} onClick={() => startEdit(v)}>
                      <div style={{ fontWeight: 700, fontSize: '15px', color: theme.textPrimary, letterSpacing: '-0.2px' }}>{title}</div>
                      <div style={{ fontSize: '11px', fontFamily: "'SF Mono', 'Fira Code', monospace", color: theme.textMuted, marginTop: '3px', letterSpacing: '0.3px' }}>{v.vin}</div>
                      {v.part_number && (
                        <div style={{ fontSize: '12px', color: theme.navyLight, fontWeight: 600, marginTop: '4px' }}>{v.part_number} — {v.end_customer}</div>
                      )}
                      <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '4px' }}>
                        {time.toLocaleDateString([], { month: 'short', day: 'numeric' })} at {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        <span style={{ marginLeft: '8px', color: theme.navy }}>tap to edit</span>
                      </div>
                    </div>
                    <button onClick={() => router.push(`/photos?id=${v.id}`)} style={{
                      background: 'rgba(30,74,94,0.08)', border: '1px solid rgba(30,74,94,0.15)',
                      borderRadius: '10px', padding: '8px 12px', color: theme.navyLight,
                      fontSize: '11px', fontWeight: 700, flexShrink: 0,
                    }}>📸 Photos</button>
                  </div>
                )}
              </div>
            </SwipeToDelete>
          );
        })}
      </div>
    </div>
  );
}

function EditInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '3px' }}>{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '13px' }} />
    </div>
  );
}
