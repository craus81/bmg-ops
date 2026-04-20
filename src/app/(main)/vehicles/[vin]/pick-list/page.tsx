'use client';

import { useState, useEffect, useCallback } from 'react';
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

export default function VehiclePickListPage() {
  const router = useRouter();
  const params = useParams<{ vin: string }>();
  const vin = (params?.vin || '').toUpperCase();
  const { user, isInstaller, isAdmin } = useAuth();
  const supabase = createClient();

  const [vehicle, setVehicle] = useState<VehicleData | null>(null);
  const [graphicsJob, setGraphicsJob] = useState<GraphicsJobData | null>(null);
  const [graphicsFiles, setGraphicsFiles] = useState<GraphicsFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const startInstall = async () => {
    if (!vehicle || starting) return;
    if (vehicle.status === 'in_progress') {
      router.push('/tracking');
      return;
    }
    setStarting(true);
    const { error } = await supabase
      .from('fleet_checkins')
      .update({ status: 'in_progress', updated_at: new Date().toISOString() })
      .eq('id', vehicle.id);
    if (error) {
      setError(error.message);
      setStarting(false);
      return;
    }
    // Log status history (best-effort, requires a signed-in user per RLS)
    if (user?.id) {
      await supabase.from('vehicle_status_history').insert({
        vehicle_id: vehicle.id,
        from_status: vehicle.status,
        to_status: 'in_progress',
        changed_by: user.id,
      }).catch(() => {});
    }
    setVehicle({ ...vehicle, status: 'in_progress' });
    setStarting(false);
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

  return (
    <div>
      {/* Sticky header: customer + VIN + status */}
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
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          {vehicle.vin}
        </div>
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

      {/* Start Install action */}
      {vehicle.status === 'received' && (
        <button
          onClick={startInstall}
          disabled={starting}
          style={{
            width: '100%',
            padding: '14px',
            borderRadius: '12px',
            border: 'none',
            background: 'var(--accent, #2563eb)',
            color: '#fff',
            fontSize: '15px',
            fontWeight: 700,
            cursor: 'pointer',
            marginBottom: '16px',
          }}
        >
          {starting ? 'Starting...' : 'Start Install'}
        </button>
      )}
      {vehicle.status === 'in_progress' && (
        <div style={{
          padding: '12px 14px',
          borderRadius: '12px',
          background: 'color-mix(in srgb, #4ade80 10%, var(--card))',
          border: '1px solid #4ade80',
          fontSize: '13px',
          fontWeight: 700,
          color: '#22c55e',
          marginBottom: '16px',
        }}>
          ✓ Install in progress
        </div>
      )}

      {/* Graphics section */}
      {graphicsJob && (
        <div style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: '14px',
          padding: '14px',
          marginBottom: '16px',
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

          {/* Materials */}
          {(graphicsJob.vinyl_type || graphicsJob.vinyl_color || graphicsJob.print_method || graphicsJob.cut_method || graphicsJob.premask) && (
            <div style={{
              background: 'var(--background, #fff)',
              borderRadius: '8px',
              padding: '8px 12px',
              marginBottom: '8px',
              fontSize: '12px',
              color: 'var(--text-muted)',
              display: 'grid',
              gap: '4px',
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

      {/* Proof file */}
      {proofUrl && (
        <div style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: '14px',
          padding: '14px',
          marginBottom: '16px',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
            Proof
          </div>
          <a
            href={proofUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              padding: '8px 14px',
              borderRadius: '10px',
              background: 'var(--accent, #2563eb)',
              color: '#fff',
              fontSize: '13px',
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            Open proof{vehicle.proof_file_name ? `: ${vehicle.proof_file_name}` : ''}
          </a>
        </div>
      )}

      {/* Graphics files */}
      {graphicsFiles.length > 0 && (
        <div style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: '14px',
          padding: '14px',
          marginBottom: '16px',
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
                  padding: '8px 12px',
                  borderRadius: '10px',
                  background: 'var(--background, #fff)',
                  border: '1px solid var(--border)',
                  fontSize: '13px',
                  color: 'var(--text-primary)',
                  textDecoration: 'none',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.file_name}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>↗</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* SO memo + notes */}
      {(vehicle.sales_order_memo || vehicle.notes) && (
        <div style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: '14px',
          padding: '14px',
          marginBottom: '16px',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
            Job Notes
          </div>
          {vehicle.sales_order_memo && (
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginBottom: '8px', whiteSpace: 'pre-wrap' }}>
              <strong style={{ color: 'var(--text-muted)' }}>SO memo:</strong> {vehicle.sales_order_memo}
            </div>
          )}
          {vehicle.notes && (
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
              <strong style={{ color: 'var(--text-muted)' }}>Checkin notes:</strong> {vehicle.notes}
            </div>
          )}
        </div>
      )}

      {/* Back link */}
      <button
        onClick={() => router.push('/installer/ready-for-install')}
        style={{
          padding: '10px 14px',
          borderRadius: '10px',
          border: '1px solid var(--border)',
          background: 'var(--card)',
          color: 'var(--text-primary)',
          fontSize: '13px',
          fontWeight: 700,
          cursor: 'pointer',
          width: '100%',
        }}
      >
        ← Back to ready queue
      </button>
    </div>
  );
}
