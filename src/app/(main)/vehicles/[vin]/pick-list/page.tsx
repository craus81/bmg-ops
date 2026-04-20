'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface VehicleData {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_trim: string | null;
  customer_name: string | null;
  sales_order_number: string | null;
  sales_order_memo: string | null;
  status: string;
  notes: string | null;
  scheduled_upfit_date: string | null;
  assigned_to: string | null;
  matched_graphics_job_id: string | null;
  proof_file_path: string | null;
  proof_file_name: string | null;
  qc_completed_at: string | null;
  completion_notes: string | null;
}

interface GraphicsJobData {
  id: string;
  job_number: string | null;
  title: string | null;
  part_number: string | null;
  customer: string | null;
  quantity: number | null;
  notes: string | null;
  status: string;
  scheduled_install_date: string | null;
  vinyl_type: string | null;
  vinyl_color: string | null;
  print_method: string | null;
  cut_method: string | null;
  premask: string | null;
}

interface GraphicsFile {
  id: string;
  file_name: string;
  file_type: string | null;
  storage_path: string;
}

interface Task {
  id: string;
  label: string;
  completed: boolean;
  required: boolean;
  sort_order: number;
  completed_at: string | null;
  completed_by_name: string | null;
}

interface Photo {
  id: string;
  storage_path: string;
  photo_type: 'completion' | 'before' | 'during' | 'damage' | 'other';
  taken_at: string;
}

export default function VehiclePickListPage() {
  const router = useRouter();
  const params = useParams<{ vin: string }>();
  const vin = (params?.vin || '').toUpperCase();
  const { user, profile, isInstaller, isAdmin } = useAuth();
  const supabase = createClient();

  const [vehicle, setVehicle] = useState<VehicleData | null>(null);
  const [graphicsJob, setGraphicsJob] = useState<GraphicsJobData | null>(null);
  const [graphicsFiles, setGraphicsFiles] = useState<GraphicsFile[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completionNote, setCompletionNote] = useState('');
  const [uploadingPhotoType, setUploadingPhotoType] = useState<'before' | 'completion' | null>(null);
  const [missingRequirements, setMissingRequirements] = useState<string[] | null>(null);

  const beforeFileRef = useRef<HTMLInputElement>(null);
  const completionFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const { data: v, error: vErr } = await supabase
      .from('fleet_checkins')
      .select('*')
      .eq('vin', vin)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (vErr || !v) {
      setError(vErr?.message || 'Vehicle not found');
      setLoading(false);
      return;
    }
    setVehicle(v as VehicleData);

    if (v.matched_graphics_job_id) {
      const { data: g } = await supabase
        .from('graphics_jobs')
        .select('id, job_number, title, part_number, customer, quantity, notes, status, scheduled_install_date, vinyl_type, vinyl_color, print_method, cut_method, premask')
        .eq('id', v.matched_graphics_job_id)
        .single();
      if (g) setGraphicsJob(g as GraphicsJobData);

      const { data: files } = await supabase
        .from('graphics_job_files')
        .select('id, file_name, file_type, storage_path')
        .eq('job_id', v.matched_graphics_job_id)
        .order('uploaded_at', { ascending: false });
      setGraphicsFiles((files || []) as GraphicsFile[]);
    }

    const [taskRes, photoRes] = await Promise.all([
      supabase
        .from('job_tasks')
        .select('id, label, completed, required, sort_order, completed_at, completed_by_name')
        .eq('job_type', 'fleet_checkin')
        .eq('job_id', v.id)
        .order('sort_order'),
      supabase
        .from('vehicle_photos')
        .select('id, storage_path, photo_type, taken_at')
        .eq('vehicle_id', v.id)
        .order('taken_at', { ascending: false }),
    ]);
    setTasks((taskRes.data || []) as Task[]);
    setPhotos((photoRes.data || []) as Photo[]);

    setLoading(false);
  }, [vin, supabase]);

  useEffect(() => {
    if (!user) return;
    if (!isInstaller && !isAdmin) {
      router.push('/home');
      return;
    }
    load();
  }, [user, isInstaller, isAdmin, router, load]);

  const postStatusChange = async (newStatus: string, opts: { note?: string; force?: boolean } = {}) => {
    if (!vehicle) return;
    setActionLoading(true);
    setMissingRequirements(null);
    try {
      const res = await fetch('/api/vehicle-tracking/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId: vehicle.id,
          newStatus,
          note: opts.note || null,
          force: opts.force,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 422 && Array.isArray(data.missing)) {
        setMissingRequirements(data.missing);
        setActionLoading(false);
        return;
      }
      if (!res.ok) {
        setError(data.error || 'Update failed');
        setActionLoading(false);
        return;
      }
      await load();
    } catch (err: any) {
      setError(err.message || 'Network error');
    }
    setActionLoading(false);
  };

  const startInstall = () => postStatusChange('in_progress');
  const markComplete = () => postStatusChange('complete', { note: completionNote.trim() || undefined });
  const forceComplete = () => postStatusChange('complete', { note: completionNote.trim() || undefined, force: true });

  const toggleTask = async (task: Task) => {
    if (!vehicle) return;
    const newCompleted = !task.completed;
    const update: Record<string, any> = {
      completed: newCompleted,
      completed_at: newCompleted ? new Date().toISOString() : null,
      completed_by: newCompleted ? user?.id : null,
      completed_by_name: newCompleted ? (profile?.full_name || user?.email || null) : null,
    };
    const { error } = await supabase.from('job_tasks').update(update).eq('id', task.id);
    if (!error) {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...update } as Task : t));
    }
  };

  const uploadPhoto = async (type: 'before' | 'completion', file: File) => {
    if (!vehicle || !user) return;
    setUploadingPhotoType(type);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `vehicles/${vehicle.id}/${type}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('photos').upload(path, file, { contentType: file.type });
      if (upErr) {
        alert('Upload failed: ' + upErr.message);
      } else {
        const { error: dbErr } = await supabase.from('vehicle_photos').insert({
          vehicle_id: vehicle.id,
          storage_path: path,
          photo_type: type,
          taken_by: user.id,
        });
        if (dbErr) {
          alert('Failed to save photo: ' + dbErr.message);
        } else {
          await load();
        }
      }
    } finally {
      setUploadingPhotoType(null);
      if (beforeFileRef.current) beforeFileRef.current.value = '';
      if (completionFileRef.current) completionFileRef.current.value = '';
    }
  };

  const onPhotoPick = (type: 'before' | 'completion') => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      await uploadPhoto(type, f);
    }
  };

  const photoUrl = (storagePath: string) => {
    const { data } = supabase.storage.from('photos').getPublicUrl(storagePath);
    return data.publicUrl;
  };

  const fileUrl = (storagePath: string) => {
    const { data } = supabase.storage.from('graphics-proofs').getPublicUrl(storagePath);
    return data.publicUrl;
  };

  const proofUrl = vehicle?.proof_file_path
    ? supabase.storage.from('graphics-proofs').getPublicUrl(vehicle.proof_file_path).data.publicUrl
    : null;

  const formatDate = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }
  if (error || !vehicle) {
    return (
      <div style={{ padding: '20px' }}>
        <div style={{ color: 'var(--danger, #ef4444)', marginBottom: '12px' }}>{error || 'Vehicle not found'}</div>
        <button
          onClick={() => router.back()}
          style={{ padding: '8px 16px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer' }}
        >
          Back
        </button>
      </div>
    );
  }

  const beforePhotos = photos.filter(p => p.photo_type === 'before');
  const completionPhotos = photos.filter(p => p.photo_type === 'completion');
  const canStart = vehicle.status === 'received';
  const canComplete = vehicle.status === 'in_progress';
  const isComplete = vehicle.status === 'complete' || vehicle.status === 'shipped';

  const requiredTasksRemaining = tasks.filter(t => t.required && !t.completed).length;
  const allRequiredDone = requiredTasksRemaining === 0;
  const hasCompletionPhoto = completionPhotos.length > 0;
  const readyToComplete = allRequiredDone && hasCompletionPhoto;

  return (
    <div>
      {/* Sticky header */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: 'var(--background, #fff)',
        borderBottom: '1px solid var(--border)',
        padding: '12px 0',
        marginBottom: '16px',
      }}>
        <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '2px' }}>
          {vehicle.customer_name || 'Unknown customer'}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{vehicle.vin}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
          {[vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model, vehicle.vehicle_trim].filter(Boolean).join(' ') || '—'}
        </div>
        <div style={{ marginTop: '8px', display: 'flex', gap: '10px', fontSize: '11px', flexWrap: 'wrap' }}>
          <span style={{
            padding: '3px 8px',
            borderRadius: '8px',
            background: 'color-mix(in srgb, var(--accent, #2563eb) 15%, transparent)',
            color: 'var(--accent, #2563eb)',
            fontWeight: 700,
          }}>
            Status: {vehicle.status}
          </span>
          {vehicle.sales_order_number && (
            <span style={{ color: 'var(--text-muted)' }}>SO: {vehicle.sales_order_number}</span>
          )}
          {vehicle.scheduled_upfit_date && (
            <span style={{ color: 'var(--text-muted)' }}>Install: {formatDate(vehicle.scheduled_upfit_date)}</span>
          )}
        </div>
      </div>

      {/* Primary action */}
      {canStart && (
        <button
          onClick={startInstall}
          disabled={actionLoading}
          style={{
            width: '100%', padding: '14px', borderRadius: '12px',
            border: 'none', background: 'var(--accent, #2563eb)', color: '#fff',
            fontSize: '15px', fontWeight: 700, cursor: 'pointer', marginBottom: '16px',
          }}
        >{actionLoading ? 'Starting...' : 'Start Install'}</button>
      )}

      {isComplete && (
        <div style={{
          padding: '12px 14px', borderRadius: '12px',
          background: 'color-mix(in srgb, #4ade80 10%, var(--card))',
          border: '1px solid #4ade80',
          fontSize: '13px', fontWeight: 700, color: '#22c55e',
          marginBottom: '16px',
        }}>
          ✓ {vehicle.status === 'shipped' ? 'Delivered' : 'Install complete'}
          {vehicle.qc_completed_at && ` · ${new Date(vehicle.qc_completed_at).toLocaleString()}`}
        </div>
      )}

      {/* Checklist (only while in_progress or complete, if any tasks exist) */}
      {(canComplete || isComplete) && tasks.length > 0 && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: '14px', padding: '14px', marginBottom: '16px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
              QC Checklist
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {tasks.filter(t => t.completed).length}/{tasks.length} done
              {requiredTasksRemaining > 0 && ` · ${requiredTasksRemaining} required left`}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {tasks.map(t => (
              <label
                key={t.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: '10px',
                  padding: '10px 12px', borderRadius: '10px',
                  background: 'var(--background, #fff)',
                  border: `1px solid ${t.completed ? '#4ade80' : 'var(--border)'}`,
                  cursor: canComplete ? 'pointer' : 'default',
                  opacity: canComplete ? 1 : 0.7,
                }}
              >
                <input
                  type="checkbox"
                  checked={t.completed}
                  disabled={!canComplete}
                  onChange={() => toggleTask(t)}
                  style={{ marginTop: '2px', flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                    {t.required && <span style={{ color: 'var(--danger, #ef4444)', marginRight: '4px' }}>*</span>}
                    {t.label}
                  </div>
                  {t.completed && t.completed_by_name && (
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {t.completed_by_name}
                      {t.completed_at && ` · ${new Date(t.completed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
                    </div>
                  )}
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Check-in photos — always available, optional */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: '14px', padding: '14px', marginBottom: '16px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            Check-in Photos (optional)
          </div>
          <button
            onClick={() => beforeFileRef.current?.click()}
            disabled={uploadingPhotoType === 'before'}
            style={{
              padding: '6px 12px', borderRadius: '8px',
              border: '1px solid var(--border)', background: 'var(--card)',
              fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            }}
          >{uploadingPhotoType === 'before' ? 'Uploading...' : '+ Add'}</button>
          <input
            ref={beforeFileRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={onPhotoPick('before')}
            style={{ display: 'none' }}
          />
        </div>
        {beforePhotos.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Document prior damage or arrival condition before work begins.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px' }}>
            {beforePhotos.map(p => (
              <a key={p.id} href={photoUrl(p.storage_path)} target="_blank" rel="noopener noreferrer">
                <img
                  src={photoUrl(p.storage_path)}
                  alt="before"
                  style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '8px', border: '1px solid var(--border)' }}
                />
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Completion photos (only during in_progress/complete) */}
      {(canComplete || isComplete) && (
        <div style={{
          background: 'var(--card)',
          border: `1px solid ${canComplete && !hasCompletionPhoto ? 'var(--warning, #f59e0b)' : 'var(--border)'}`,
          borderRadius: '14px', padding: '14px', marginBottom: '16px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
              Completion Photos {canComplete && !hasCompletionPhoto && <span style={{ color: 'var(--warning, #f59e0b)' }}>· required</span>}
            </div>
            {canComplete && (
              <>
                <button
                  onClick={() => completionFileRef.current?.click()}
                  disabled={uploadingPhotoType === 'completion'}
                  style={{
                    padding: '6px 12px', borderRadius: '8px',
                    border: '1px solid var(--border)', background: 'var(--card)',
                    fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                  }}
                >{uploadingPhotoType === 'completion' ? 'Uploading...' : '+ Add'}</button>
                <input
                  ref={completionFileRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  onChange={onPhotoPick('completion')}
                  style={{ display: 'none' }}
                />
              </>
            )}
          </div>
          {completionPhotos.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Upload at least one finished-install photo before marking complete.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px' }}>
              {completionPhotos.map(p => (
                <a key={p.id} href={photoUrl(p.storage_path)} target="_blank" rel="noopener noreferrer">
                  <img
                    src={photoUrl(p.storage_path)}
                    alt="completion"
                    style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '8px', border: '1px solid var(--border)' }}
                  />
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Mark Complete block (in_progress only) */}
      {canComplete && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: '14px', padding: '14px', marginBottom: '16px',
        }}>
          <label style={{ display: 'block', marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Completion notes (optional)</div>
            <textarea
              value={completionNote}
              onChange={(e) => setCompletionNote(e.target.value)}
              rows={2}
              placeholder="Anything worth noting for the record?"
              style={{
                width: '100%', padding: '8px 10px', borderRadius: '8px',
                border: '1px solid var(--border)', background: 'var(--background, #fff)',
                fontSize: '13px', fontFamily: 'inherit', resize: 'vertical',
              }}
            />
          </label>

          {missingRequirements && missingRequirements.length > 0 && (
            <div style={{
              padding: '10px 12px', borderRadius: '10px', marginBottom: '10px',
              background: 'color-mix(in srgb, var(--danger, #ef4444) 10%, var(--card))',
              border: '1px solid var(--danger, #ef4444)',
              fontSize: '12px', color: 'var(--danger, #ef4444)',
            }}>
              <div style={{ fontWeight: 700, marginBottom: '4px' }}>Cannot mark complete yet:</div>
              <ul style={{ margin: 0, paddingLeft: '18px' }}>
                {missingRequirements.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
              {isAdmin && (
                <button
                  onClick={forceComplete}
                  disabled={actionLoading}
                  style={{
                    marginTop: '8px', padding: '6px 12px', borderRadius: '8px',
                    border: '1px solid var(--danger, #ef4444)', background: 'transparent',
                    color: 'var(--danger, #ef4444)', fontSize: '11px', fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >Admin override · mark complete anyway</button>
              )}
            </div>
          )}

          <button
            onClick={markComplete}
            disabled={actionLoading || !readyToComplete}
            style={{
              width: '100%', padding: '14px', borderRadius: '12px',
              border: 'none',
              background: readyToComplete ? '#22c55e' : 'var(--border)',
              color: '#fff', fontSize: '15px', fontWeight: 700,
              cursor: readyToComplete ? 'pointer' : 'not-allowed',
              opacity: readyToComplete ? 1 : 0.5,
            }}
          >
            {actionLoading ? 'Marking complete...' : (readyToComplete ? 'Mark Complete' : `Finish checklist + photo to enable`)}
          </button>
        </div>
      )}

      {/* Graphics section */}
      {graphicsJob && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: '14px', padding: '14px', marginBottom: '16px',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
            Graphics
          </div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
            {graphicsJob.title || graphicsJob.part_number || graphicsJob.job_number || '—'}
          </div>
          {graphicsJob.part_number && graphicsJob.title !== graphicsJob.part_number && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>
              Part: {graphicsJob.part_number}
            </div>
          )}
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            Status: <span style={{ fontWeight: 700, color: '#4ade80' }}>{graphicsJob.status}</span>
            {graphicsJob.quantity ? ` · Qty: ${graphicsJob.quantity}` : ''}
          </div>

          {(graphicsJob.vinyl_type || graphicsJob.vinyl_color || graphicsJob.print_method || graphicsJob.cut_method || graphicsJob.premask) && (
            <div style={{
              background: 'var(--background, #fff)', borderRadius: '8px',
              padding: '8px 12px', marginBottom: '8px',
              fontSize: '12px', color: 'var(--text-muted)', display: 'grid', gap: '4px',
            }}>
              {graphicsJob.vinyl_type && <div>Vinyl: {graphicsJob.vinyl_type}{graphicsJob.vinyl_color ? ` · ${graphicsJob.vinyl_color}` : ''}</div>}
              {graphicsJob.print_method && <div>Print: {graphicsJob.print_method}</div>}
              {graphicsJob.cut_method && <div>Cut: {graphicsJob.cut_method}</div>}
              {graphicsJob.premask && <div>Premask: {graphicsJob.premask}</div>}
            </div>
          )}

          {graphicsJob.notes && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', fontStyle: 'italic' }}>
              {graphicsJob.notes}
            </div>
          )}
        </div>
      )}

      {proofUrl && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: '14px', padding: '14px', marginBottom: '16px',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
            Proof
          </div>
          <a
            href={proofUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block', padding: '8px 14px', borderRadius: '10px',
              background: 'var(--accent, #2563eb)', color: '#fff',
              fontSize: '13px', fontWeight: 700, textDecoration: 'none',
            }}
          >
            Open proof{vehicle.proof_file_name ? `: ${vehicle.proof_file_name}` : ''}
          </a>
        </div>
      )}

      {graphicsFiles.length > 0 && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: '14px', padding: '14px', marginBottom: '16px',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
            Design Files ({graphicsFiles.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {graphicsFiles.map(f => (
              <a
                key={f.id}
                href={fileUrl(f.storage_path)}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: '8px 12px', borderRadius: '10px',
                  background: 'var(--background, #fff)', border: '1px solid var(--border)',
                  fontSize: '13px', color: 'var(--text-primary)', textDecoration: 'none',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file_name}</span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>↗</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {(vehicle.sales_order_memo || vehicle.notes || vehicle.completion_notes) && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: '14px', padding: '14px', marginBottom: '16px',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
            Notes
          </div>
          {vehicle.sales_order_memo && (
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginBottom: '8px', whiteSpace: 'pre-wrap' }}>
              <strong style={{ color: 'var(--text-muted)' }}>SO memo:</strong> {vehicle.sales_order_memo}
            </div>
          )}
          {vehicle.notes && (
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', marginBottom: '8px' }}>
              <strong style={{ color: 'var(--text-muted)' }}>Checkin notes:</strong> {vehicle.notes}
            </div>
          )}
          {vehicle.completion_notes && (
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
              <strong style={{ color: 'var(--text-muted)' }}>Completion notes:</strong> {vehicle.completion_notes}
            </div>
          )}
        </div>
      )}

      <button
        onClick={() => router.push('/installer/ready-for-install')}
        style={{
          padding: '10px 14px', borderRadius: '10px',
          border: '1px solid var(--border)', background: 'var(--card)',
          color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700,
          cursor: 'pointer', width: '100%',
        }}
      >
        ← Back to ready queue
      </button>
    </div>
  );
}
