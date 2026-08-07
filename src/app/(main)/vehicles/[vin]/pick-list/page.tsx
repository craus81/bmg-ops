'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { DropZone } from '@/components/DropZone';
import VehiclePhotoTimeline from '@/components/VehiclePhotoTimeline';
import CompletionModal from '@/components/CompletionModal';
import { PartLabel } from '@/components/PartLabel';
import { openOrCreateVehicleThread } from '@/lib/customer-thread';
import { storageDownloadUrl } from '@/lib/storage';

interface VehicleData {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_trim: string | null;
  customer_name: string | null;
  netsuite_sales_order_id: string | null;
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
  install_instructions: string | null;
  on_site_contact_name: string | null;
  on_site_contact_phone: string | null;
  delivery_preferences: string | null;
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
  const dialog = useDialog();

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
  const [beforeCaption, setBeforeCaption] = useState('');
  const [completionCaption, setCompletionCaption] = useState('');
  const [photoRefreshKey, setPhotoRefreshKey] = useState(0);
  const [messagingCustomer, setMessagingCustomer] = useState(false);
  const [completionModalOpen, setCompletionModalOpen] = useState(false);

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

  // Open (or create) a customer thread scoped to this vehicle and deep-link
  // into /admin/inbox. Customer resolution is best-effort: match external_contacts
  // by the checkin's customer_name via the matching customers row, creating a
  // placeholder contact if none exists so the inbox always has somewhere to land.
  const openMessageCustomer = async () => {
    if (!vehicle || messagingCustomer) return;
    setMessagingCustomer(true);
    const result = await openOrCreateVehicleThread(supabase, vehicle, user?.id);
    if ('threadId' in result) {
      router.push(`/admin/inbox?thread=${result.threadId}`);
    } else {
      await dialog.alert('Failed to open thread: ' + result.error);
    }
    setMessagingCustomer(false);
  };

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

  const uploadPhoto = async (type: 'before' | 'completion', file: File, caption?: string) => {
    if (!vehicle || !user) return;
    setUploadingPhotoType(type);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `vehicles/${vehicle.id}/${type}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('photos').upload(path, file, { contentType: file.type });
      if (upErr) {
        await dialog.alert('Upload failed: ' + upErr.message);
      } else {
        const { error: dbErr } = await supabase.from('vehicle_photos').insert({
          vehicle_id: vehicle.id,
          storage_path: path,
          photo_type: type,
          taken_by: user.id,
          caption: caption?.trim() || null,
        });
        if (dbErr) {
          await dialog.alert('Failed to save photo: ' + dbErr.message);
        } else {
          await load();
          setPhotoRefreshKey(k => k + 1);
        }
      }
    } finally {
      setUploadingPhotoType(null);
      if (beforeFileRef.current) beforeFileRef.current.value = '';
      if (completionFileRef.current) completionFileRef.current.value = '';
    }
  };

  const uploadPhotos = async (type: 'before' | 'completion', files: File[]) => {
    const caption = type === 'before' ? beforeCaption : completionCaption;
    for (const f of files) {
      // Only attach the caption to the first file in a multi-select.
      await uploadPhoto(type, f, files.indexOf(f) === 0 ? caption : undefined);
    }
    if (type === 'before') setBeforeCaption('');
    else setCompletionCaption('');
  };

  const onPhotoPick = (type: 'before' | 'completion') => (e: React.ChangeEvent<HTMLInputElement>) =>
    uploadPhotos(type, Array.from(e.target.files || []));

  // Serve through the download route so a save keeps the original file_name —
  // the raw public URL saves as the randomized storage key.
  const fileUrl = (f: { storage_path: string; file_name: string }) =>
    storageDownloadUrl('graphics-proofs', f.storage_path, f.file_name);

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

      {/* Install context (T1.6) — snapshot from estimate/customer defaults */}
      {(vehicle.install_instructions || vehicle.on_site_contact_name || vehicle.on_site_contact_phone || vehicle.delivery_preferences) && (
        <div style={{
          background: 'color-mix(in srgb, var(--accent, #2563eb) 6%, var(--card))',
          border: '1px solid var(--accent, #2563eb)',
          borderRadius: '14px',
          padding: '14px',
          marginBottom: '16px',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent, #2563eb)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '8px' }}>
            Install Context
          </div>
          {vehicle.install_instructions && (
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', marginBottom: '8px' }}>
              {vehicle.install_instructions}
            </div>
          )}
          {(vehicle.on_site_contact_name || vehicle.on_site_contact_phone) && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary, #475569)', marginBottom: '4px' }}>
              <strong style={{ color: 'var(--text-muted)' }}>On-site:</strong>{' '}
              {vehicle.on_site_contact_name}
              {vehicle.on_site_contact_phone && (
                <>
                  {' · '}
                  <a href={`tel:${vehicle.on_site_contact_phone}`} style={{ color: 'var(--accent, #2563eb)', textDecoration: 'none', fontWeight: 700 }}>
                    {vehicle.on_site_contact_phone}
                  </a>
                </>
              )}
            </div>
          )}
          {vehicle.delivery_preferences && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary, #475569)' }}>
              <strong style={{ color: 'var(--text-muted)' }}>Delivery:</strong> {vehicle.delivery_preferences}
            </div>
          )}
        </div>
      )}

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

      {(isAdmin || isInstaller) && (
        <button
          onClick={openMessageCustomer}
          disabled={messagingCustomer}
          style={{
            width: '100%', padding: '10px', borderRadius: '10px',
            border: '1px solid var(--border)', background: 'var(--card)',
            fontSize: '13px', fontWeight: 700, cursor: 'pointer', marginBottom: '12px',
          }}
        >{messagingCustomer ? 'Opening thread...' : '💬 Message Customer'}</button>
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

      {/* Compact checklist summary while in_progress — full UX lives in CompletionModal */}
      {canComplete && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: '14px', padding: '14px', marginBottom: '16px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
        }}>
          <div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
              QC Checklist
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '4px' }}>
              {tasks.length === 0 ? 'No checklist yet' : (
                <>
                  {tasks.filter(t => t.completed).length}/{tasks.length} done
                  {requiredTasksRemaining > 0 && (
                    <span style={{ color: 'var(--warning, #f59e0b)', fontWeight: 700 }}> · {requiredTasksRemaining} required left</span>
                  )}
                </>
              )}
            </div>
          </div>
          <button
            onClick={() => setCompletionModalOpen(true)}
            style={{
              padding: '10px 14px', borderRadius: '10px', border: 'none',
              background: '#22c55e', color: '#fff', fontSize: '13px', fontWeight: 800,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >Run Completion Checklist</button>
        </div>
      )}

      {/* Photo upload controls (check-in optional, completion required while in_progress) */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: '14px', padding: '14px', marginBottom: '16px',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
          Add Photos
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: (canComplete || isComplete) ? '1fr 1fr' : '1fr', gap: '10px' }}>
          {/* Check-in (before) */}
          <DropZone
            onFiles={files => uploadPhotos('before', files)}
            accept="image/*"
            disabled={uploadingPhotoType === 'before'}
            style={{ padding: '10px', borderRadius: '10px', background: 'var(--background, #fff)', border: '1px solid var(--border)' }}
          >
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary, #475569)', marginBottom: '6px' }}>Check-in (optional)</div>
            <input
              type="text"
              value={beforeCaption}
              onChange={e => setBeforeCaption(e.target.value)}
              placeholder="Caption (e.g. dent on left bumper)"
              style={{
                width: '100%', padding: '6px 8px', borderRadius: '8px',
                border: '1px solid var(--border)', background: 'var(--background, #fff)',
                fontSize: '12px', marginBottom: '6px',
              }}
            />
            <button
              onClick={() => beforeFileRef.current?.click()}
              disabled={uploadingPhotoType === 'before'}
              style={{
                width: '100%', padding: '8px 12px', borderRadius: '8px',
                border: '1px dashed var(--border)', background: 'transparent',
                fontSize: '12px', fontWeight: 700, cursor: 'pointer',
              }}
            >{uploadingPhotoType === 'before' ? 'Uploading...' : '+ Take / upload'}</button>
            <input
              ref={beforeFileRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              onChange={onPhotoPick('before')}
              style={{ display: 'none' }}
            />
          </DropZone>

          {/* Completion (only while in_progress/complete) */}
          {(canComplete || isComplete) && (
            <DropZone
              onFiles={files => uploadPhotos('completion', files)}
              accept="image/*"
              disabled={uploadingPhotoType === 'completion' || !canComplete}
              style={{
                padding: '10px', borderRadius: '10px',
                background: canComplete && !hasCompletionPhoto ? 'color-mix(in srgb, var(--warning, #f59e0b) 5%, var(--background, #fff))' : 'var(--background, #fff)',
                border: `1px solid ${canComplete && !hasCompletionPhoto ? 'var(--warning, #f59e0b)' : 'var(--border)'}`,
              }}
            >
              <div style={{ fontSize: '11px', fontWeight: 700, color: canComplete && !hasCompletionPhoto ? 'var(--warning, #f59e0b)' : 'var(--text-secondary, #475569)', marginBottom: '6px' }}>
                Completion {canComplete && !hasCompletionPhoto && '· required'}
              </div>
              <input
                type="text"
                value={completionCaption}
                onChange={e => setCompletionCaption(e.target.value)}
                placeholder="Caption (optional)"
                disabled={!canComplete}
                style={{
                  width: '100%', padding: '6px 8px', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'var(--background, #fff)',
                  fontSize: '12px', marginBottom: '6px',
                }}
              />
              <button
                onClick={() => completionFileRef.current?.click()}
                disabled={uploadingPhotoType === 'completion' || !canComplete}
                style={{
                  width: '100%', padding: '8px 12px', borderRadius: '8px',
                  border: '1px dashed var(--border)', background: 'transparent',
                  fontSize: '12px', fontWeight: 700, cursor: canComplete ? 'pointer' : 'not-allowed',
                  opacity: canComplete ? 1 : 0.5,
                }}
              >{uploadingPhotoType === 'completion' ? 'Uploading...' : '+ Take / upload'}</button>
              <input
                ref={completionFileRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                onChange={onPhotoPick('completion')}
                style={{ display: 'none' }}
              />
            </DropZone>
          )}
        </div>
      </div>

      {/* Unified photo timeline (check-in + in-progress + completion + design files + proofs) */}
      <div style={{ marginBottom: '16px' }}>
        <VehiclePhotoTimeline vin={vin} refreshKey={photoRefreshKey} variant="internal" />
      </div>

      {/* Mark Complete UX lives in CompletionModal. The compact summary above
          is the entry point; the modal renders the full checklist + photo
          capture + proof preview + SO line items in one focused screen. */}

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
              Part: <PartLabel partNumber={graphicsJob.part_number} />
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
                href={fileUrl(f)}
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

      {completionModalOpen && (
        <CompletionModal
          vehicleId={vehicle.id}
          vehicleVin={vehicle.vin}
          vehicleLabel={[vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model].filter(Boolean).join(' ') || '—'}
          customerName={vehicle.customer_name}
          netsuiteSalesOrderId={vehicle.netsuite_sales_order_id}
          proofUrl={proofUrl}
          proofIsPdf={(vehicle.proof_file_name || '').toLowerCase().endsWith('.pdf') || (vehicle.proof_file_path || '').toLowerCase().endsWith('.pdf')}
          graphicsFiles={graphicsFiles}
          isAdmin={!!isAdmin}
          onClose={() => setCompletionModalOpen(false)}
          onComplete={() => { setCompletionModalOpen(false); load(); }}
        />
      )}
    </div>
  );
}
