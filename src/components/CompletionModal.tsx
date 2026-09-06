'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { storage, storageDownloadUrl } from '@/lib/storage';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import ProofThumbnail from '@/components/ProofThumbnail';
import { DropZone } from '@/components/DropZone';
import PhotoSession from '@/components/PhotoSession';
import { estimateHeadlineNumber } from '@/lib/estimate-number';
import { openNetSuitePdf, openNetSuiteInvoicePdfByNumber } from '@/lib/netsuite-pdf-client';

interface Task {
  id: string;
  label: string;
  required: boolean;
  completed: boolean;
  task_key: string | null;
  sort_order: number;
  completed_at: string | null;
  completed_by_name: string | null;
}

interface Photo {
  id: string;
  storage_path: string;
  photo_type: string;
}

interface GraphicsFile {
  id: string;
  file_name: string;
  file_type: string | null;
  storage_path: string;
}

interface SalesOrderLine {
  lineNumber: number;
  partNumber: string;
  description: string;
  quantity: number;
}

interface Props {
  vehicleId: string;
  vehicleVin: string;
  vehicleLabel: string;
  customerName: string | null;
  netsuiteSalesOrderId: string | null;
  proofUrl: string | null;
  /** Named-download variant of proofUrl — open/save anchors use it so the
   *  file keeps its recorded name; thumbnails stay on the public URL. */
  proofDownloadUrl?: string | null;
  proofIsPdf: boolean;
  graphicsFiles: GraphicsFile[];
  isAdmin: boolean;
  /** Every SO linked to the check-in (join table) — the invoicing section
   *  offers one button per SO. */
  salesOrders?: { netsuite_sales_order_id: string; sales_order_number: string | null }[];
  /** The estimate the check-in snapshotted at creation, if any. */
  sourceEstimateId?: string | null;
  /** Invoice already stamped on the check-in (migration 070). */
  invoiceNumber?: string | null;
  /** Called after an invoice is created so the board can refresh. */
  onInvoiced?: () => void;
  onClose: () => void;
  onComplete: () => void;
}

interface LinkedEstimateLite {
  id: string;
  estimate_number: string;
  netsuite_estimate_number: string | null;
  netsuite_so_id: string | null;
  netsuite_so_number: string | null;
  customer_approved: boolean | null;
  grand_total: number | null;
}

const PHOTO_BUCKET = 'photos';

export default function CompletionModal({
  vehicleId, vehicleVin, vehicleLabel, customerName, netsuiteSalesOrderId,
  proofUrl, proofDownloadUrl, proofIsPdf, graphicsFiles, isAdmin, salesOrders, sourceEstimateId,
  invoiceNumber, onInvoiced, onClose, onComplete,
}: Props) {
  const supabase = createClient();
  const { user, profile } = useAuth();
  const dialog = useDialog();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [soLines, setSoLines] = useState<SalesOrderLine[]>([]);
  const [soLinesLoading, setSoLinesLoading] = useState(false);
  const [soLinesError, setSoLinesError] = useState<string | null>(null);
  const [soLineChecked, setSoLineChecked] = useState<Record<number, boolean>>({});

  const [completionNote, setCompletionNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [caption, setCaption] = useState('');

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  // In-app camera session (PhotoSession): tap once, shoot many, Done.
  const [photoSession, setPhotoSession] = useState(false);

  // ── Admin invoicing (turn the vehicle's SO or estimate into a NetSuite
  // invoice, right from the completion process) ──
  const [invNumber, setInvNumber] = useState<string | null>(invoiceNumber || null);
  // Internal id of the invoice created in THIS session (opens the PDF
  // directly); a pre-stamped number is resolved by number instead.
  const [invId, setInvId] = useState<string | null>(null);
  const [fulNumber, setFulNumber] = useState<string | null>(null);
  const [invPdfBusy, setInvPdfBusy] = useState(false);
  const [invWorking, setInvWorking] = useState<string | null>(null); // SO id in flight
  const [invError, setInvError] = useState<string | null>(null);
  const [linkedEstimates, setLinkedEstimates] = useState<LinkedEstimateLite[]>([]);
  const [overrideFor, setOverrideFor] = useState<string | null>(null); // estimate id awaiting override reason
  const [overrideReason, setOverrideReason] = useState('');

  // The SO list the section offers: the join-table list, else the legacy
  // primary column.
  const invoiceSos = (salesOrders && salesOrders.length > 0)
    ? salesOrders
    : netsuiteSalesOrderId ? [{ netsuite_sales_order_id: netsuiteSalesOrderId, sales_order_number: null }] : [];

  // Estimates tied to this vehicle — the fallback when no SO is linked yet.
  useEffect(() => {
    if (!isAdmin || invoiceSos.length > 0) return;
    (async () => {
      const { data } = await supabase
        .from('estimates')
        .select('id, estimate_number, netsuite_estimate_number, netsuite_so_id, netsuite_so_number, customer_approved, grand_total')
        .or(`fleet_checkin_id.eq.${vehicleId}${sourceEstimateId ? `,id.eq.${sourceEstimateId}` : ''}`)
        .order('created_at', { ascending: false });
      setLinkedEstimates((data || []) as LinkedEstimateLite[]);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one load per open
  }, [isAdmin, vehicleId, sourceEstimateId]);

  const invoiceSalesOrder = async (salesOrderId: string) => {
    setInvWorking(salesOrderId);
    setInvError(null);
    try {
      const res = await fetch('/api/vehicle-tracking/invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkinId: vehicleId, salesOrderId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        // 409 already-invoiced still tells us the number — show it.
        if (data.invoiceNumber) setInvNumber(data.invoiceNumber);
        setInvError(data.error || 'Invoice create failed');
        return;
      }
      setInvNumber(data.invoiceNumber || data.invoiceId || null);
      setInvId(data.invoiceId ? String(data.invoiceId) : null);
      setFulNumber(data.fulfillmentNumber || null);
      onInvoiced?.();
    } catch (e: any) {
      setInvError(e?.message || 'Network error creating the invoice');
    } finally {
      setInvWorking(null);
    }
  };

  // Estimate path: convert to SO first (with the approval gate — an admin
  // can override with a recorded reason), then invoice the fresh SO.
  const convertAndInvoice = async (est: LinkedEstimateLite, reason?: string) => {
    if (est.netsuite_so_id) { await invoiceSalesOrder(est.netsuite_so_id); return; }
    setInvWorking(est.id);
    setInvError(null);
    try {
      const res = await fetch('/api/estimates/convert-to-so', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateId: est.id, ...(reason ? { overrideReason: reason } : {}) }),
      });
      const data = await res.json();
      if (res.status === 409 && data.step === 'not_approved') {
        if (data.canOverride) { setOverrideFor(est.id); setOverrideReason(''); }
        else setInvError(data.error || 'The estimate has not been accepted by the customer.');
        return;
      }
      if (!res.ok || !data.salesOrderId) {
        setInvError(data.error || 'Could not convert the estimate to a sales order');
        return;
      }
      setOverrideFor(null);
      // The fresh SO isn't linked to the check-in yet — link it so the
      // invoice route's ownership check (and the card's SO list) see it.
      await supabase.from('fleet_checkin_sales_orders').upsert({
        checkin_id: vehicleId,
        netsuite_sales_order_id: String(data.salesOrderId),
        sales_order_number: data.salesOrderNumber || null,
      }, { onConflict: 'checkin_id,netsuite_sales_order_id', ignoreDuplicates: true });
      setLinkedEstimates(prev => prev.map(e => e.id === est.id
        ? { ...e, netsuite_so_id: String(data.salesOrderId), netsuite_so_number: data.salesOrderNumber || null }
        : e));
      await invoiceSalesOrder(String(data.salesOrderId));
    } catch (e: any) {
      setInvError(e?.message || 'Network error converting the estimate');
    } finally {
      setInvWorking(prev => (prev === est.id ? null : prev));
    }
  };

  const refresh = useCallback(async () => {
    const [taskRes, photoRes] = await Promise.all([
      supabase
        .from('job_tasks')
        .select('id, label, required, completed, task_key, sort_order, completed_at, completed_by_name')
        .eq('job_type', 'fleet_checkin')
        .eq('job_id', vehicleId)
        .order('sort_order'),
      supabase
        .from('vehicle_photos')
        .select('id, storage_path, photo_type')
        .eq('vehicle_id', vehicleId)
        .eq('photo_type', 'completion')
        .order('taken_at', { ascending: false }),
    ]);
    setTasks((taskRes.data || []) as Task[]);
    setPhotos((photoRes.data || []) as Photo[]);
  }, [vehicleId, supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  // Lazy-load SO line items the first time the upfit task is expanded.
  // forceReload skips the "already loaded" check so the Retry button can
  // re-run after a transient failure.
  const ensureSoLines = useCallback(async (opts: { forceReload?: boolean } = {}) => {
    if (!netsuiteSalesOrderId) return;
    if (!opts.forceReload && (soLines.length > 0 || soLinesLoading)) return;
    setSoLinesLoading(true);
    setSoLinesError(null);
    try {
      const res = await fetch(`/api/netsuite/sales-order-lines/${encodeURIComponent(netsuiteSalesOrderId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // NetSuite hiccups (auth expired, rate-limited, transient 5xx)
        // used to disappear here. Surface the actual error so the user
        // sees why the list is empty and so devtools can pick it up.
        const msg = data?.error || `HTTP ${res.status}`;
        console.error('[completion modal] failed to load SO lines:', msg);
        setSoLinesError(msg);
      } else {
        setSoLines(data.lines || []);
      }
    } catch (err: any) {
      console.error('[completion modal] SO lines fetch threw:', err);
      setSoLinesError(err?.message || 'Network error contacting NetSuite');
    }
    setSoLinesLoading(false);
  }, [netsuiteSalesOrderId, soLines.length, soLinesLoading]);

  const toggleTask = async (task: Task) => {
    const newCompleted = !task.completed;
    const update = {
      completed: newCompleted,
      completed_at: newCompleted ? new Date().toISOString() : null,
      completed_by: newCompleted ? (user?.id ?? null) : null,
      completed_by_name: newCompleted ? (profile?.full_name || user?.email || null) : null,
    };
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...update } as Task : t));
    const { error: updateErr } = await supabase.from('job_tasks').update(update).eq('id', task.id);
    if (updateErr) {
      console.error('Failed to update task', updateErr);
      setError(`Couldn't save: ${updateErr.message}`);
      setTasks(prev => prev.map(t => t.id === task.id ? task : t));
    }
  };

  const toggleExpand = (key: string) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
    if (key === 'task_upfit_per_spec') ensureSoLines();
  };

  const photoUrl = (path: string) => storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;

  const uploadPhotos = async (files: File[]) => {
    if (!files.length || !user) return false;
    setUploading(true);
    let uploadedAny = false;
    try {
      for (let idx = 0; idx < files.length; idx++) {
        const file = files[idx];
        const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
        const path = `vehicles/${vehicleId}/completion-${Date.now()}-${idx}.${ext}`;
        const { error: upErr } = await storage.from(PHOTO_BUCKET).upload(path, file, { contentType: file.type });
        if (upErr) { await dialog.alert('Upload failed: ' + upErr.message); continue; }
        await supabase.from('vehicle_photos').insert({
          vehicle_id: vehicleId,
          storage_path: path,
          photo_type: 'completion',
          taken_by: user.id,
          caption: idx === 0 && caption.trim() ? caption.trim() : null,
        });
        uploadedAny = true;
      }
      setCaption('');
      if (fileRef.current) fileRef.current.value = '';
      await refresh();
    } finally {
      setUploading(false);
    }
    return uploadedAny;
  };

  const onPhotoPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await uploadPhotos(Array.from(e.target.files || []));
  };

  const submit = async (force = false) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setMissing(null);
    try {
      const res = await fetch('/api/vehicle-tracking/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId,
          newStatus: 'complete',
          note: completionNote.trim() || null,
          force,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 422 && Array.isArray(data.missing)) {
        setMissing(data.missing);
      } else if (!res.ok) {
        setError(data.error || 'Submit failed');
      } else {
        onComplete();
      }
    } catch (e: any) {
      setError(e?.message || 'Network error');
    }
    setSubmitting(false);
  };

  const resetChecklist = async () => {
    if (!(await dialog.confirm('Reset the checklist for this vehicle from the active template? Existing check-offs will be lost.', { destructive: true, confirmLabel: 'Reset' }))) return;
    setResetting(true);
    const res = await fetch(`/api/vehicle-tracking/${vehicleId}/refresh-checklist`, { method: 'POST' });
    setResetting(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      await dialog.alert('Reset failed: ' + (d.error || 'Unknown error'));
      return;
    }
    refresh();
  };

  const requiredRemaining = tasks.filter(t => t.required && !t.completed).length;
  const hasCompletionPhoto = photos.length > 0;
  const ready = requiredRemaining === 0 && hasCompletionPhoto;

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      // zIndex 1500 keeps this on top of /tracking's vehicle popout modal
      // (which uses 1001) — otherwise "Run Completion Process" mounts the
      // modal behind the popout card and looks like nothing happened.
      zIndex: 1500, padding: '20px', overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--card)', borderRadius: '14px', maxWidth: '720px', width: '100%',
        border: '1px solid var(--border)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)',
        margin: 'auto 0',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Complete Install</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {customerName ? customerName + ' · ' : ''}{vehicleLabel}
              <span style={{ fontFamily: 'monospace', marginLeft: '8px' }}>{vehicleVin}</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px 8px' }}>✕</button>
        </div>

        <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Photo block */}
          <DropZone onFiles={uploadPhotos} accept="image/*" multiple disabled={uploading}>
          <div style={{
            padding: '12px', borderRadius: '10px',
            border: `1px solid ${hasCompletionPhoto ? '#4ade80' : 'var(--warning, #f59e0b)'}`,
            background: hasCompletionPhoto ? 'color-mix(in srgb, #4ade80 6%, var(--card))' : 'color-mix(in srgb, var(--warning, #f59e0b) 6%, var(--card))',
          }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
              Completion photos {hasCompletionPhoto ? `· ${photos.length} uploaded` : '· at least one required'}
            </div>
            {hasCompletionPhoto && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: '6px', marginBottom: '8px' }}>
                {photos.map(p => (
                  <a key={p.id} href={photoUrl(p.storage_path)} target="_blank" rel="noopener noreferrer">
                    <img src={photoUrl(p.storage_path)} alt="completion" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '6px', border: '1px solid var(--border)' }} />
                  </a>
                ))}
              </div>
            )}
            <input
              type="text"
              placeholder="Optional caption for next photo"
              value={caption}
              onChange={e => setCaption(e.target.value)}
              style={{ width: '100%', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', marginBottom: '6px' }}
            />
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                onClick={() => setPhotoSession(true)}
                disabled={uploading}
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: '8px',
                  border: '1px solid rgba(34,197,94,0.35)', background: 'rgba(34,197,94,0.08)',
                  color: '#16a34a',
                  fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                }}
              >{uploading ? 'Uploading…' : '📷 Take completion photos'}</button>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                style={{
                  padding: '8px 12px', borderRadius: '8px',
                  border: '1px dashed var(--border)', background: 'var(--card)',
                  color: 'var(--text-primary)',
                  fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                }}
              >Upload</button>
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple onChange={onPhotoPick} style={{ display: 'none' }} />
            <PhotoSession
              open={photoSession}
              title="Completion photos"
              subtitle="Tap Done when finished — each shot uploads as you go"
              onShot={(file) => uploadPhotos([file]).then(() => undefined)}
              onClose={() => setPhotoSession(false)}
            />
          </div>
          </DropZone>

          {/* Tasks */}
          {tasks.length === 0 ? (
            <div style={{ padding: '16px', textAlign: 'center', borderRadius: '10px', background: 'var(--subtle-bg, #f8fafc)', border: '1px solid var(--border)', fontSize: '12px', color: 'var(--text-muted)' }}>
              No checklist tasks for this vehicle. {isAdmin && (
                <button onClick={resetChecklist} disabled={resetting} style={{ marginLeft: '6px', padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                  {resetting ? 'Resetting…' : 'Generate from active template'}
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {tasks.map(t => {
                const isExpandable = t.task_key === 'graphics_per_proof' || t.task_key === 'upfit_per_spec';
                const expandKey = `task_${t.task_key}`;
                const isExpanded = expandKey ? !!expanded[expandKey] : false;
                return (
                  <div key={t.id} style={{
                    borderRadius: '10px',
                    border: `1px solid ${t.completed ? '#4ade80' : 'var(--border)'}`,
                    background: 'var(--card)',
                    overflow: 'hidden',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 12px' }}>
                      <input
                        type="checkbox"
                        checked={t.completed}
                        onChange={() => toggleTask(t)}
                        style={{ marginTop: '2px', flexShrink: 0, width: '18px', height: '18px', cursor: 'pointer' }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                          {t.required && <span style={{ color: 'var(--danger, #ef4444)', marginRight: '4px' }}>*</span>}
                          {t.label}
                        </div>
                        {t.completed && t.completed_by_name && (
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            ✓ {t.completed_by_name}
                            {t.completed_at && ` · ${new Date(t.completed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
                          </div>
                        )}
                      </div>
                      {isExpandable && (
                        <button
                          onClick={() => toggleExpand(expandKey)}
                          style={{ background: 'transparent', border: 'none', color: 'var(--accent, #2563eb)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', padding: '2px 6px' }}
                        >{isExpanded ? 'Hide' : 'Show'}</button>
                      )}
                    </div>

                    {isExpanded && t.task_key === 'graphics_per_proof' && (
                      <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', background: 'var(--subtle-bg, #f8fafc)' }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Proof reference</div>
                        {proofUrl ? (
                          proofIsPdf ? (
                            <div>
                              <ProofThumbnail pdfUrl={proofUrl} label="Proof PDF" thumbSize={120} expandedSize={400} />
                              <a href={proofDownloadUrl || proofUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: '8px', fontSize: '12px', color: 'var(--accent, #2563eb)' }}>Open full proof ↗</a>
                            </div>
                          ) : (
                            <a href={proofDownloadUrl || proofUrl} target="_blank" rel="noopener noreferrer">
                              <img src={proofUrl} alt="proof" style={{ maxWidth: '100%', borderRadius: '8px', border: '1px solid var(--border)' }} />
                            </a>
                          )
                        ) : (
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No proof attached to this vehicle.</div>
                        )}
                        {graphicsFiles.length > 0 && (
                          <div style={{ marginTop: '10px' }}>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>Design files</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              {graphicsFiles.map(f => {
                                const url = storageDownloadUrl('graphics-proofs', f.storage_path, f.file_name);
                                return (
                                  <a key={f.id} href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: 'var(--accent, #2563eb)', textDecoration: 'none' }}>
                                    {f.file_name} ↗
                                  </a>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {isExpanded && t.task_key === 'upfit_per_spec' && (
                      <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', background: 'var(--subtle-bg, #f8fafc)' }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                          Sales order line items {netsuiteSalesOrderId ? '' : '· no SO linked'}
                        </div>
                        {soLinesLoading && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading from NetSuite…</div>}
                        {!soLinesLoading && soLinesError && (
                          <div style={{
                            padding: '8px 10px', borderRadius: '6px', marginBottom: '6px',
                            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                            color: '#ef4444', fontSize: '11px',
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
                          }}>
                            <span>NetSuite error: {soLinesError}</span>
                            <button
                              type="button"
                              onClick={() => ensureSoLines({ forceReload: true })}
                              style={{ padding: '3px 9px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, background: 'transparent', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', cursor: 'pointer' }}
                            >Retry</button>
                          </div>
                        )}
                        {!soLinesLoading && !soLinesError && soLines.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {soLines.map(line => {
                              const checked = !!soLineChecked[line.lineNumber];
                              return (
                                <label key={line.lineNumber} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '6px 8px', borderRadius: '6px', background: 'var(--card)', cursor: 'pointer' }}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => setSoLineChecked(prev => ({ ...prev, [line.lineNumber]: !checked }))}
                                    style={{ marginTop: '2px' }}
                                  />
                                  <div style={{ flex: 1, fontSize: '12px' }}>
                                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                                      {line.partNumber || '—'}
                                      <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '8px' }}>× {line.quantity}</span>
                                    </div>
                                    {line.description && <div style={{ color: 'var(--text-muted)', marginTop: '1px' }}>{line.description}</div>}
                                  </div>
                                </label>
                              );
                            })}
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '4px' }}>
                              Sub-checks are visual aids — only the parent task counts toward completion.
                            </div>
                          </div>
                        )}
                        {!soLinesLoading && !soLinesError && soLines.length === 0 && netsuiteSalesOrderId && (
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No line items found for this SO.</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Completion notes */}
          <label>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Completion notes (optional)</div>
            <textarea
              value={completionNote}
              onChange={e => setCompletionNote(e.target.value)}
              rows={2}
              placeholder="Anything worth noting for the record"
              style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'inherit', resize: 'vertical' }}
            />
          </label>

          {/* Admin invoicing — turn the vehicle's SO (or its estimate,
              converted first) into a NetSuite invoice without leaving the
              completion process. */}
          {isAdmin && (
            <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                NetSuite Invoice <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>· admin</span>
              </div>
              {invNumber ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: '#22c55e' }}>
                    ✓ Invoice #{invNumber} created for this vehicle.{fulNumber ? ` Sales order fulfilled (${fulNumber}).` : ''}
                  </div>
                  <button
                    type="button"
                    disabled={invPdfBusy}
                    title="Open this invoice's NetSuite PDF in a new tab to print or save"
                    onClick={async () => {
                      setInvPdfBusy(true);
                      setInvError(null);
                      const r = invId ? await openNetSuitePdf('invoice', invId) : await openNetSuiteInvoicePdfByNumber(invNumber);
                      if (!r.ok) setInvError(`Could not open the invoice PDF: ${r.error}`);
                      setInvPdfBusy(false);
                    }}
                    style={{ padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-primary)', opacity: invPdfBusy ? 0.6 : 1 }}
                  >
                    {invPdfBusy ? 'Opening…' : '🖨 Print / PDF'}
                  </button>
                </div>
              ) : invoiceSos.length > 0 ? (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {invoiceSos.map(so => (
                    <button key={so.netsuite_sales_order_id}
                      onClick={() => invoiceSalesOrder(so.netsuite_sales_order_id)}
                      disabled={!!invWorking}
                      title="Fulfil every line of the sales order, bill it as a NetSuite invoice, and stamp it on this vehicle"
                      style={{ padding: '7px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', opacity: invWorking ? 0.6 : 1 }}>
                      {invWorking === so.netsuite_sales_order_id ? 'Invoicing…' : `Invoice SO ${so.sales_order_number || `#${so.netsuite_sales_order_id}`}`}
                    </button>
                  ))}
                </div>
              ) : linkedEstimates.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {linkedEstimates.map(est => (
                    <div key={est.id}>
                      <button
                        onClick={() => convertAndInvoice(est)}
                        disabled={!!invWorking}
                        title={est.netsuite_so_id ? 'Bill the estimate’s sales order as a NetSuite invoice' : 'Convert the estimate to a sales order, then bill it as a NetSuite invoice'}
                        style={{ padding: '7px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', opacity: invWorking ? 0.6 : 1 }}>
                        {invWorking === est.id || invWorking === est.netsuite_so_id ? 'Working…'
                          : est.netsuite_so_id ? `Invoice SO ${est.netsuite_so_number || `#${est.netsuite_so_id}`} (${estimateHeadlineNumber(est)})`
                          : `Convert ${estimateHeadlineNumber(est)} to SO & Invoice`}
                      </button>
                      {overrideFor === est.id && (
                        <div style={{ marginTop: '6px', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                          <input value={overrideReason} onChange={e => setOverrideReason(e.target.value)}
                            placeholder="Not customer-approved — record the override reason (e.g. approved by phone)"
                            style={{ flex: 1, minWidth: '220px', padding: '7px 9px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
                          <button onClick={() => convertAndInvoice(est, overrideReason.trim())}
                            disabled={overrideReason.trim().length < 3 || !!invWorking}
                            style={{ padding: '7px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.4)', color: '#f59e0b', opacity: overrideReason.trim().length < 3 ? 0.5 : 1 }}>
                            Convert anyway
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  No sales order or estimate is linked to this vehicle — link one on the card first.
                </div>
              )}
              {invError && (
                <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--danger, #ef4444)' }}>{invError}</div>
              )}
            </div>
          )}

          {/* Errors / missing list */}
          {missing && missing.length > 0 && (
            <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'color-mix(in srgb, var(--danger, #ef4444) 8%, var(--card))', border: '1px solid var(--danger, #ef4444)', fontSize: '12px', color: 'var(--danger, #ef4444)' }}>
              <div style={{ fontWeight: 700, marginBottom: '4px' }}>Cannot mark complete yet:</div>
              <ul style={{ margin: 0, paddingLeft: '18px' }}>
                {missing.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
              {isAdmin && (
                <button
                  onClick={() => submit(true)}
                  disabled={submitting}
                  style={{ marginTop: '8px', padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--danger, #ef4444)', background: 'transparent', color: 'var(--danger, #ef4444)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                >Admin override · mark complete anyway</button>
              )}
            </div>
          )}
          {error && (
            <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'color-mix(in srgb, var(--danger, #ef4444) 8%, var(--card))', border: '1px solid var(--danger, #ef4444)', fontSize: '12px', color: 'var(--danger, #ef4444)' }}>{error}</div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            {isAdmin && tasks.length > 0 && (
              <button onClick={resetChecklist} disabled={resetting} style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                {resetting ? 'Resetting…' : 'Reset checklist'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={onClose} style={{ padding: '10px 14px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
            <button
              onClick={() => submit(false)}
              disabled={!ready || submitting}
              style={{
                padding: '10px 18px', borderRadius: '10px', border: 'none',
                background: ready ? '#22c55e' : 'var(--border)',
                color: '#fff', fontSize: '14px', fontWeight: 800,
                cursor: ready && !submitting ? 'pointer' : 'not-allowed',
                opacity: ready && !submitting ? 1 : 0.5,
              }}
            >{submitting ? 'Submitting…' : ready ? 'Mark Complete' : `${requiredRemaining} req. left${hasCompletionPhoto ? '' : ' + photo'}`}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
