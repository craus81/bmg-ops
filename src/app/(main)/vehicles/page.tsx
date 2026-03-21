'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import type { ScannedVehicle } from '@/lib/types';

export default function VehiclesPage() {
  const router = useRouter();
  const { user, isAdmin } = useAuth();
  const [vehicles, setVehicles] = useState<ScannedVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ vin: '', vehicle_year: '', vehicle_make: '', vehicle_model: '', part_number: '', end_customer: '' });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [submittingAll, setSubmittingAll] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ count: number } | null>(null);
  const supabase = createClient();

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      let query = supabase.from('scanned_vehicles').select('*').order('scanned_at', { ascending: false }).limit(50);
      if (!isAdmin) {
        query = query.eq('scanned_by', user.id);
      }
      const { data } = await query;
      setVehicles((data as ScannedVehicle[]) || []);
      setLoading(false);
    };
    load();
  }, [user, isAdmin]);

  const unsubmittedVehicles = vehicles.filter((v: any) => !v.submitted_for_review);

  const handleSubmitAll = async () => {
    if (!user || unsubmittedVehicles.length === 0) return;
    setSubmittingAll(true);
    setSubmitResult(null);

    // Find which unsubmitted vehicles actually have photos
    const withPhotos: ScannedVehicle[] = [];
    for (const v of unsubmittedVehicles) {
      const { count } = await supabase
        .from('vehicle_photos')
        .select('*', { count: 'exact', head: true })
        .eq('vehicle_id', v.id);
      if (count && count > 0) withPhotos.push(v);
    }

    if (withPhotos.length === 0) {
      alert('No unsubmitted vehicles have photos to submit.');
      setSubmittingAll(false);
      return;
    }

    const now = new Date().toISOString();
    const ids = withPhotos.map((v) => v.id);

    // Batch update all vehicles
    await supabase
      .from('scanned_vehicles')
      .update({
        submitted_for_review: true,
        submitted_at: now,
        review_status: 'pending',
      })
      .in('id', ids);

    // Get admin users for notifications
    const { data: admins } = await supabase
      .from('profiles')
      .select('id, email')
      .eq('role', 'admin')
      .eq('status', 'approved');

    if (admins && admins.length > 0) {
      // Create one notification per admin for the batch
      await supabase
        .from('notifications')
        .insert(admins.map((admin: any) => ({
          user_id: admin.id,
          type: 'review_submitted',
          title: `Batch submission: ${withPhotos.length} vehicle${withPhotos.length !== 1 ? 's' : ''}`,
          body: `${withPhotos.length} vehicle${withPhotos.length !== 1 ? 's' : ''} submitted for photo review`,
        })));

      // Send batch email notification
      try {
        const { data: { session } } = await supabase.auth.getSession();
        await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-review-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
            'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
          },
          body: JSON.stringify({
            type: 'submitted',
            vehicle_info: `Batch: ${withPhotos.length} vehicles`,
            vin: withPhotos.map((v) => v.vin).join(', '),
            photo_count: withPhotos.length,
            submitted_by: user.id,
            admin_emails: admins.map((a: any) => a.email),
          }),
        });
      } catch (e) {
        console.error('Email send failed:', e);
      }
    }

    // Update local state
    setVehicles((prev) =>
      prev.map((v: any) =>
        ids.includes(v.id) ? { ...v, submitted_for_review: true, submitted_at: now, review_status: 'pending' } : v
      )
    );

    setSubmitResult({ count: withPhotos.length });
    setSubmittingAll(false);
    setTimeout(() => setSubmitResult(null), 5000);
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch('/api/vehicles/delete-scanned', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId: id }),
      });
      const data = await res.json();
      if (data.success) {
        setVehicles((prev) => prev.filter((v) => v.id !== id));
        setExpandedId(null);
      }
    } catch {
      alert('Delete failed — please try again');
    }
    setDeletingId(null);
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
        {isAdmin ? 'Scanned Vehicles' : 'My Scanned Vehicles'} ({vehicles.length})
      </div>

      {/* Submit All button */}
      {unsubmittedVehicles.length > 0 && (
        <button
          onClick={handleSubmitAll}
          disabled={submittingAll}
          style={{
            width: '100%', padding: '14px', borderRadius: '14px', marginBottom: '12px',
            background: 'var(--orange)', color: '#fff',
            fontWeight: 800, fontSize: '14px', border: 'none',
            boxShadow: '0 4px 16px rgba(238,49,32,0.3)',
            opacity: submittingAll ? 0.5 : 1,
          }}
        >
          {submittingAll ? 'Submitting...' : `✓ Submit All for Review (${unsubmittedVehicles.length} unsubmitted)`}
        </button>
      )}

      {/* Success banner */}
      {submitResult && (
        <div style={{
          padding: '10px 14px', borderRadius: '10px', marginBottom: '12px',
          background: 'var(--success-bg)', border: '1px solid var(--success-border)',
          color: 'var(--success)', fontSize: '13px', fontWeight: 700, textAlign: 'center',
        }}>
          ✅ Submitted {submitResult.count} vehicle{submitResult.count !== 1 ? 's' : ''} for review
        </div>
      )}

      {vehicles.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: theme.textMuted }}>
          <div style={{ fontSize: '40px', marginBottom: '8px', opacity: 0.3 }}>🚐</div>
          <div style={{ fontWeight: 600, fontSize: '14px' }}>{isAdmin ? 'No vehicles scanned yet' : 'You haven\'t scanned any vehicles yet'}</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {vehicles.map((v) => {
          const title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle';
          const time = new Date(v.scanned_at);
          const isEditing = editId === v.id;
          const isSubmitted = (v as any).submitted_for_review;
          const reviewStatus = (v as any).review_status;

          const isExpanded = expandedId === v.id;
          return (
              <div key={v.id} style={{
                background: theme.card,
                border: `1px solid ${isSubmitted && reviewStatus === 'pending' ? 'var(--warning-border)' : reviewStatus === 'approved' ? 'var(--success-border)' : reviewStatus === 'denied' ? 'var(--error-border)' : theme.border}`,
                borderRadius: '14px', overflow: 'hidden', boxShadow: theme.shadowSm,
              }}>
                {isEditing ? (
                  <div style={{ padding: '14px 16px' }}>
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
                  <>
                    <div
                      onClick={() => setExpandedId(isExpanded ? null : v.id)}
                      style={{ padding: '14px 16px', cursor: 'pointer' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <div style={{ fontWeight: 700, fontSize: '15px', color: theme.textPrimary, letterSpacing: '-0.2px' }}>{title}</div>
                            {isSubmitted && (
                              <span style={{
                                padding: '2px 7px', borderRadius: '6px', fontSize: '9px', fontWeight: 700,
                                background: reviewStatus === 'approved' ? 'var(--success-bg)' : reviewStatus === 'denied' ? 'var(--error-bg)' : 'var(--warning-bg)',
                                border: `1px solid ${reviewStatus === 'approved' ? 'var(--success-border)' : reviewStatus === 'denied' ? 'var(--error-border)' : 'var(--warning-border)'}`,
                                color: reviewStatus === 'approved' ? 'var(--success)' : reviewStatus === 'denied' ? 'var(--error)' : 'var(--warning)',
                              }}>
                                {reviewStatus === 'approved' ? '✅' : reviewStatus === 'denied' ? '❌' : '⏳'} {reviewStatus === 'approved' ? 'Approved' : reviewStatus === 'denied' ? 'Rework' : 'Pending'}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '11px', fontFamily: "'SF Mono', 'Fira Code', monospace", color: theme.textMuted, marginTop: '3px', letterSpacing: '0.3px' }}>{v.vin}</div>
                          {v.part_number && (
                            <div style={{ fontSize: '12px', color: theme.navyLight, fontWeight: 600, marginTop: '4px' }}>{v.part_number} — {v.end_customer}</div>
                          )}
                          <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '4px' }}>
                            {time.toLocaleDateString([], { month: 'short', day: 'numeric' })} at {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                        <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '4px' }}>
                          {isExpanded ? '▲' : '▼'}
                        </div>
                      </div>
                    </div>

                    {isExpanded && (
                      <div style={{ borderTop: `1px solid ${theme.border}`, padding: '12px 16px' }}>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button onClick={() => startEdit(v)} style={{
                            flex: 1, padding: '10px', borderRadius: '10px',
                            background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
                            color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                          }}>Edit</button>
                          <button onClick={() => router.push(`/photos?id=${v.id}`)} style={{
                            flex: 1, padding: '10px', borderRadius: '10px',
                            background: 'rgba(30,74,94,0.08)', border: '1px solid rgba(30,74,94,0.15)',
                            color: theme.navyLight, fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                          }}>📸 Photos</button>
                        </div>
                        <button
                          onClick={() => {
                            if (window.confirm(`Delete this vehicle (${v.vin})? This cannot be undone.`)) handleDelete(v.id);
                          }}
                          disabled={deletingId === v.id}
                          style={{
                            width: '100%', marginTop: '8px', padding: '10px', borderRadius: '10px',
                            background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
                            color: '#f87171', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                          }}
                        >
                          {deletingId === v.id ? 'Deleting...' : 'Delete Vehicle'}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
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
