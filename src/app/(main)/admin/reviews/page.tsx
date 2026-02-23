'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface ReviewVehicle {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  part_number: string | null;
  end_customer: string | null;
  review_status: string;
  review_notes: string | null;
  reviewed_at: string | null;
  submitted_at: string | null;
  scanned_by: string;
  scanned_at: string;
  photos: { id: string; storage_path: string; url?: string }[];
  scanner_name?: string;
}

export default function ReviewsPage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();
  const [vehicles, setVehicles] = useState<ReviewVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'pending' | 'approved' | 'denied' | 'all'>('pending');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [denyNotes, setDenyNotes] = useState('');
  const [processing, setProcessing] = useState<string | null>(null);
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadVehicles();
  }, [isAdmin]);

  const loadVehicles = async () => {
    const { data } = await supabase
      .from('scanned_vehicles')
      .select('*')
      .eq('submitted_for_review', true)
      .order('submitted_at', { ascending: false });

    if (!data) { setLoading(false); return; }

    // Load photos and scanner names for each vehicle
    const enriched: ReviewVehicle[] = await Promise.all(
      data.map(async (v: any) => {
        const { data: photos } = await supabase
          .from('vehicle_photos')
          .select('id, storage_path')
          .eq('vehicle_id', v.id)
          .order('taken_at');

        const photosWithUrls = (photos || []).map((p: any) => {
          const { data: urlData } = supabase.storage.from('photos').getPublicUrl(p.storage_path);
          return { ...p, url: urlData.publicUrl };
        });

        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', v.scanned_by)
          .maybeSingle();

        return { ...v, photos: photosWithUrls, scanner_name: profile?.full_name || 'Unknown' };
      })
    );

    setVehicles(enriched);
    setLoading(false);
  };

  const handleApprove = async (vehicleId: string) => {
    if (!user) return;
    setProcessing(vehicleId);

    const vehicle = vehicles.find((v) => v.id === vehicleId);

    await supabase
      .from('scanned_vehicles')
      .update({
        review_status: 'approved',
        review_notes: null,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', vehicleId);

    // Notify the installer
    if (vehicle) {
      await supabase
        .from('notifications')
        .insert({
          user_id: vehicle.scanned_by,
          type: 'review_approved',
          title: 'Photos Approved ✅',
          body: `Your photos for ${vehicleTitle(vehicle)} have been approved.`,
          vehicle_id: vehicleId,
        });

      // Get installer email
      const { data: installerProfile } = await supabase
        .from('profiles')
        .select('email, full_name')
        .eq('id', vehicle.scanned_by)
        .maybeSingle();

      // Send email via edge function
      if (installerProfile?.email) {
        try {
          await supabase.functions.invoke('send-review-email', {
            body: {
              type: 'approved',
              vehicle_id: vehicleId,
              vehicle_info: vehicleTitle(vehicle),
              vin: vehicle.vin,
              installer_email: installerProfile.email,
              installer_name: installerProfile.full_name || '',
            },
          });
        } catch (e) {
          console.error('Email send failed:', e);
        }
      }
    }

    setVehicles((prev) => prev.map((v) =>
      v.id === vehicleId ? { ...v, review_status: 'approved', review_notes: null, reviewed_at: new Date().toISOString() } : v
    ));
    setProcessing(null);
    setExpandedId(null);
  };

  const handleDeny = async (vehicleId: string) => {
    if (!user || !denyNotes.trim()) return;
    setProcessing(vehicleId);

    const vehicle = vehicles.find((v) => v.id === vehicleId);

    await supabase
      .from('scanned_vehicles')
      .update({
        review_status: 'denied',
        review_notes: denyNotes.trim(),
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        submitted_for_review: false, // Allow resubmission
      })
      .eq('id', vehicleId);

    // Notify the installer
    if (vehicle) {
      await supabase
        .from('notifications')
        .insert({
          user_id: vehicle.scanned_by,
          type: 'review_denied',
          title: 'Photos Need Rework ❌',
          body: `${vehicleTitle(vehicle)}: ${denyNotes.trim()}`,
          vehicle_id: vehicleId,
        });

      // Get installer email
      const { data: installerProfile } = await supabase
        .from('profiles')
        .select('email, full_name')
        .eq('id', vehicle.scanned_by)
        .maybeSingle();

      // Send email
      if (installerProfile?.email) {
        try {
          await supabase.functions.invoke('send-review-email', {
            body: {
              type: 'denied',
              vehicle_id: vehicleId,
              vehicle_info: vehicleTitle(vehicle),
              vin: vehicle.vin,
              review_notes: denyNotes.trim(),
              installer_email: installerProfile.email,
              installer_name: installerProfile.full_name || '',
            },
          });
        } catch (e) {
          console.error('Email send failed:', e);
        }
      }
    }

    setVehicles((prev) => prev.map((v) =>
      v.id === vehicleId ? { ...v, review_status: 'denied', review_notes: denyNotes.trim(), reviewed_at: new Date().toISOString() } : v
    ));
    setDenyNotes('');
    setProcessing(null);
    setExpandedId(null);
  };

  const vehicleTitle = (v: ReviewVehicle) =>
    [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle';

  const filtered = filter === 'all' ? vehicles : vehicles.filter((v) => v.review_status === filter);
  const pendingCount = vehicles.filter((v) => v.review_status === 'pending').length;

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  // Full-screen photo viewer
  if (viewingPhoto) {
    return (
      <div
        onClick={() => setViewingPhoto(null)}
        style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.95)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
      >
        <button onClick={() => setViewingPhoto(null)} style={{
          position: 'absolute', top: '12px', right: '16px', padding: '8px 14px',
          borderRadius: '10px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)',
          color: '#fff', fontSize: '12px', fontWeight: 700, zIndex: 210,
        }}>✕ Close</button>
        <img src={viewingPhoto} alt="Photo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px' }} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Photo Reviews ({filtered.length})
        </div>
        {pendingCount > 0 && (
          <div style={{
            padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning)',
          }}>
            {pendingCount} pending
          </div>
        )}
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
        {([
          { id: 'pending' as const, label: `Pending${pendingCount > 0 ? ` (${pendingCount})` : ''}` },
          { id: 'approved' as const, label: 'Approved' },
          { id: 'denied' as const, label: 'Denied' },
          { id: 'all' as const, label: 'All' },
        ]).map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: filter === f.id ? 'var(--tab-active-bg)' : 'transparent',
            border: filter === f.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: filter === f.id ? 'var(--tab-active-color)' : 'var(--text-muted)',
          }}>
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>
            {filter === 'pending' ? '✅' : '📷'}
          </div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>
            {filter === 'pending' ? 'No pending reviews — all caught up!' : `No ${filter} reviews`}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {filtered.map((v) => {
          const isExpanded = expandedId === v.id;
          const isPending = v.review_status === 'pending';
          const isApproved = v.review_status === 'approved';
          const isDenied = v.review_status === 'denied';
          const statusColor = isPending ? 'var(--warning)' : isApproved ? 'var(--success)' : 'var(--error)';
          const statusBg = isPending ? 'var(--warning-bg)' : isApproved ? 'var(--success-bg)' : 'var(--error-bg)';
          const statusBorder = isPending ? 'var(--warning-border)' : isApproved ? 'var(--success-border)' : 'var(--error-border)';

          return (
            <div key={v.id} style={{
              background: 'var(--card)', border: `1px solid ${isPending ? 'var(--warning-border)' : 'var(--border)'}`,
              borderRadius: '14px', overflow: 'hidden', boxShadow: 'var(--shadow-sm)',
            }}>
              {/* Header — always visible */}
              <button onClick={() => { setExpandedId(isExpanded ? null : v.id); setDenyNotes(''); }} style={{
                width: '100%', padding: '14px', textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--text-primary)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '15px' }}>{vehicleTitle(v)}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '2px' }}>{v.vin}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                      {v.scanner_name} • {v.photos.length} photo{v.photos.length !== 1 ? 's' : ''}
                      {v.part_number && ` • ${v.part_number}`}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{
                      padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                      background: statusBg, border: `1px solid ${statusBorder}`, color: statusColor,
                    }}>
                      {isPending ? '⏳ Pending' : isApproved ? '✅ Approved' : '❌ Denied'}
                    </span>
                    {v.submitted_at && (
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        {new Date(v.submitted_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Photo thumbnails — always show */}
                <div style={{ display: 'flex', gap: '4px', marginTop: '10px', overflowX: 'auto' }}>
                  {v.photos.slice(0, 5).map((p) => (
  <div key={p.id} onClick={(e) => { e.stopPropagation(); setViewingPhoto(p.url || null); }} style={{
                      width: '56px', height: '56px', borderRadius: '6px', overflow: 'hidden',
                      background: 'var(--subtle-bg)', flexShrink: 0,
                    }}>
                      {p.url && <img src={p.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                    </div>
                  ))}
                  {v.photos.length > 5 && (
                    <div style={{
                      width: '56px', height: '56px', borderRadius: '6px', background: 'var(--subtle-bg)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', flexShrink: 0,
                    }}>+{v.photos.length - 5}</div>
                  )}
                </div>
              </button>

              {/* Expanded — full photo grid + actions */}
              {isExpanded && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '14px' }}>
                  {/* Full photo grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px', marginBottom: '14px' }}>
                    {v.photos.map((p) => (
                      <button key={p.id} onClick={() => setViewingPhoto(p.url || null)} style={{
                        position: 'relative', paddingTop: '100%', borderRadius: '6px',
                        overflow: 'hidden', background: 'var(--subtle-bg)', border: 'none',
                      }}>
                        {p.url && <img src={p.url} alt="" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
                      </button>
                    ))}
                  </div>

                  {/* Denial notes if already denied */}
                  {isDenied && v.review_notes && (
                    <div style={{
                      padding: '10px', borderRadius: '8px', background: 'var(--error-bg)',
                      border: '1px solid var(--error-border)', marginBottom: '10px',
                      fontSize: '12px', color: 'var(--error)',
                    }}>
                      <strong>Denial reason:</strong> {v.review_notes}
                    </div>
                  )}

                  {/* Action buttons */}
                  {isPending && (
                    <div>
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                        <button
                          onClick={() => handleApprove(v.id)}
                          disabled={processing === v.id}
                          style={{
                            flex: 1, padding: '12px', borderRadius: '10px',
                            background: 'var(--success)', color: '#fff',
                            fontWeight: 800, fontSize: '14px', border: 'none',
                            opacity: processing === v.id ? 0.5 : 1,
                          }}
                        >
                          {processing === v.id ? 'Processing...' : '✓ Approve'}
                        </button>
                      </div>

                      {/* Deny with notes */}
                      <div style={{ padding: '10px', borderRadius: '10px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                          Deny with reason
                        </label>
                        <textarea
                          value={denyNotes}
                          onChange={(e) => setDenyNotes(e.target.value)}
                          placeholder="What needs to be fixed..."
                          rows={2}
                          style={{
                            width: '100%', padding: '10px', borderRadius: '8px',
                            border: '1px solid var(--border)', background: 'var(--bg)',
                            color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical',
                          }}
                        />
                        <button
                          onClick={() => handleDeny(v.id)}
                          disabled={!denyNotes.trim() || processing === v.id}
                          style={{
                            marginTop: '6px', width: '100%', padding: '10px', borderRadius: '8px',
                            background: 'var(--error-bg)', border: '1px solid var(--error-border)',
                            color: 'var(--error)', fontWeight: 700, fontSize: '12px',
                            opacity: !denyNotes.trim() || processing === v.id ? 0.4 : 1,
                          }}
                        >
                          ✕ Deny & Send Back
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Re-review for already reviewed */}
                  {(isApproved || isDenied) && (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {isDenied && (
                        <button onClick={() => handleApprove(v.id)} disabled={processing === v.id} style={{
                          flex: 1, padding: '10px', borderRadius: '8px',
                          background: 'var(--success-bg)', border: '1px solid var(--success-border)',
                          color: 'var(--success)', fontWeight: 700, fontSize: '12px',
                        }}>Re-approve</button>
                      )}
                      {isApproved && (
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>
                          Approved {v.reviewed_at ? new Date(v.reviewed_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button onClick={() => router.push('/more')} style={{
        width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px',
        border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
        fontSize: '13px', fontWeight: 700,
      }}>
        ← Back
      </button>
    </div>
  );
}
