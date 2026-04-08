'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { storage } from '@/lib/storage';
import StatusBadge from '@/components/StatusBadge';
import AssignmentPicker from '@/components/AssignmentPicker';
import type { FleetCheckin, VehicleTrackingStatus, VehicleStatusHistory, VehiclePhoto } from '@/lib/types';
import { VEHICLE_STATUS_PIPELINE, VEHICLE_STATUS_LABELS, VEHICLE_STATUS_COLORS } from '@/lib/types';
import NetSuitePdf from '@/components/NetSuitePdf';
import ProofThumbnail from '@/components/ProofThumbnail';

type FilterStatus = VehicleTrackingStatus | 'all' | 'stuck';

export default function TrackingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin, user, profile } = useAuth();
  const supabase = createClient();

  const [vehicles, setVehicles] = useState<FleetCheckin[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const PAGE_SIZE = 50;
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusHistory, setStatusHistory] = useState<VehicleStatusHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState('');
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [updateSuccess, setUpdateSuccess] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [vehicleAssignments, setVehicleAssignments] = useState<Record<string, string[]>>({});
  const [assignmentSaving, setAssignmentSaving] = useState(false);

  // Photos state
  const [vehiclePhotos, setVehiclePhotos] = useState<Record<string, (VehiclePhoto & { url?: string })[]>>({});
  const [photosLoading, setPhotosLoading] = useState<Record<string, boolean>>({});
  const [photoUploading, setPhotoUploading] = useState(false);
  const [showCompletionPrompt, setShowCompletionPrompt] = useState<string | null>(null); // vehicleId
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Notes state
  interface VehicleNote {
    id: string;
    vehicle_id: string;
    note: string;
    created_by: string;
    created_by_name: string;
    created_at: string;
  }
  const [vehicleNotes, setVehicleNotes] = useState<Record<string, VehicleNote[]>>({});
  const [notesLoading, setNotesLoading] = useState<Record<string, boolean>>({});
  const [noteInput, setNoteInput] = useState<Record<string, string>>({});
  const [noteSaving, setNoteSaving] = useState(false);

  // Sales order linking state
  const [soSearchOpen, setSoSearchOpen] = useState<string | null>(null); // vehicleId
  const [soSearchTerm, setSoSearchTerm] = useState('');
  const [soSearchResults, setSoSearchResults] = useState<any[]>([]);
  const [soSearching, setSoSearching] = useState(false);
  const [soLinking, setSoLinking] = useState(false);

  // Dropbox proof search state
  const [dbxSearchOpen, setDbxSearchOpen] = useState<string | null>(null); // vehicleId
  const [dbxSearchTerm, setDbxSearchTerm] = useState('');
  const [dbxResults, setDbxResults] = useState<{ id: string; name: string; path: string; size: number; modified: string; folder: string }[]>([]);
  const [dbxSearching, setDbxSearching] = useState(false);
  const [dbxCopying, setDbxCopying] = useState(false);
  const [dbxConnected, setDbxConnected] = useState<boolean | null>(null); // null = unknown

  useEffect(() => {
    loadVehicles();
    loadProfiles();

    // Handle Dropbox OAuth redirect
    const dbxParam = searchParams.get('dropbox');
    if (dbxParam === 'connected') {
      setDbxConnected(true);
      setUpdateSuccess('Dropbox connected successfully');
      setTimeout(() => setUpdateSuccess(null), 3000);
    }
  }, []);

  // Auto-expand vehicle from URL param (deep link from check-in page)
  useEffect(() => {
    if (loading) return;
    const vehicleId = searchParams.get('vehicle');
    if (vehicleId && vehicles.some(v => v.id === vehicleId)) {
      setExpandedId(vehicleId);
      loadHistory(vehicleId);
      loadAssignments(vehicleId);
      loadPhotos(vehicleId);
      loadNotes(vehicleId);
    }
  }, [loading]);

  const loadVehicles = async (append = false) => {
    if (append) setLoadingMore(true); else setLoading(true);
    const offset = append ? vehicles.length : 0;
    const { data } = await supabase
      .from('fleet_checkins')
      .select('*')
      .order('updated_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (data) {
      if (append) {
        setVehicles(prev => [...prev, ...data]);
      } else {
        setVehicles(data);
      }
      setHasMore(data.length === PAGE_SIZE);
    }
    if (append) setLoadingMore(false); else setLoading(false);
  };

  const loadProfiles = async () => {
    const { data } = await supabase.from('profiles').select('id, full_name');
    if (data) {
      const map: Record<string, string> = {};
      data.forEach((p: any) => { map[p.id] = p.full_name; });
      setProfiles(map);
    }
  };

  const loadHistory = async (vehicleId: string) => {
    setHistoryLoading(true);
    const { data } = await supabase
      .from('vehicle_status_history')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('created_at', { ascending: false });
    setStatusHistory(data || []);
    setHistoryLoading(false);
  };

  const loadAssignments = async (vehicleId: string) => {
    const { data } = await supabase
      .from('job_assignments')
      .select('user_id')
      .eq('job_type', 'scanned_vehicle')
      .eq('job_id', vehicleId);
    if (data) {
      setVehicleAssignments(prev => ({
        ...prev,
        [vehicleId]: data.map((a: any) => a.user_id),
      }));
    }
  };

  const loadPhotos = async (vehicleId: string) => {
    setPhotosLoading(prev => ({ ...prev, [vehicleId]: true }));
    const { data } = await supabase
      .from('vehicle_photos')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('taken_at', { ascending: false });

    if (data) {
      const photosWithUrls = data.map((p: VehiclePhoto) => ({
        ...p,
        url: storage.from('photos').getPublicUrl(p.storage_path).data.publicUrl,
      }));
      setVehiclePhotos(prev => ({ ...prev, [vehicleId]: photosWithUrls }));
    }
    setPhotosLoading(prev => ({ ...prev, [vehicleId]: false }));
  };

  const uploadPhoto = async (vehicleId: string, file: File) => {
    setPhotoUploading(true);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `${vehicleId}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await storage.from('photos').upload(path, file, { contentType: file.type });
      if (uploadErr) {
        console.error('Photo upload error:', uploadErr.message);
        alert('Photo upload failed: ' + uploadErr.message);
        setPhotoUploading(false);
        return;
      }

      const { error: dbErr } = await supabase.from('vehicle_photos').insert({
        vehicle_id: vehicleId,
        storage_path: path,
        photo_type: 'completion',
        taken_by: user?.id,
      });

      if (dbErr) {
        console.error('Photo DB insert error:', dbErr.message);
        alert('Photo upload failed: ' + dbErr.message);
        setPhotoUploading(false);
        return;
      }

      await loadPhotos(vehicleId);
    } catch (err: any) {
      console.error('Photo upload error:', err);
      alert('Photo upload failed');
    }
    setPhotoUploading(false);
  };

  const handlePhotoFiles = async (vehicleId: string, files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
      await uploadPhoto(vehicleId, files[i]);
    }
  };

  const deletePhoto = async (vehicleId: string, photoId: string, storagePath: string) => {
    if (!confirm('Delete this photo?')) return;
    await storage.from('photos').remove([storagePath]);
    await supabase.from('vehicle_photos').delete().eq('id', photoId);
    await loadPhotos(vehicleId);
  };

  const loadNotes = async (vehicleId: string) => {
    setNotesLoading(prev => ({ ...prev, [vehicleId]: true }));
    const { data } = await supabase
      .from('vehicle_notes')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('created_at', { ascending: false });
    if (data) setVehicleNotes(prev => ({ ...prev, [vehicleId]: data }));
    setNotesLoading(prev => ({ ...prev, [vehicleId]: false }));
  };

  const addNote = async (vehicleId: string) => {
    const text = (noteInput[vehicleId] || '').trim();
    if (!text) return;
    setNoteSaving(true);
    try {
      await supabase.from('vehicle_notes').insert({
        vehicle_id: vehicleId,
        note: text,
        created_by: user?.id,
        created_by_name: profile?.full_name || 'Unknown',
      });
      setNoteInput(prev => ({ ...prev, [vehicleId]: '' }));
      await loadNotes(vehicleId);
    } catch (err) {
      console.error('Note save error:', err);
    }
    setNoteSaving(false);
  };

  const deleteNote = async (vehicleId: string, noteId: string) => {
    if (!confirm('Delete this note?')) return;
    await supabase.from('vehicle_notes').delete().eq('id', noteId);
    await loadNotes(vehicleId);
  };

  // Sales order search & link
  const searchSalesOrders = async () => {
    if (!soSearchTerm.trim()) return;
    setSoSearching(true);
    setSoSearchResults([]);
    try {
      const res = await fetch(`/api/netsuite/sales-orders?customer=${encodeURIComponent(soSearchTerm.trim())}`);
      const data = await res.json();
      if (data.found && data.data) {
        setSoSearchResults(data.data);
      }
    } catch (err) {
      console.error('SO search error:', err);
    }
    setSoSearching(false);
  };

  const linkSalesOrder = async (vehicleId: string, order: any) => {
    setSoLinking(true);
    try {
      const { error } = await supabase.from('fleet_checkins').update({
        netsuite_sales_order_id: order.id,
        sales_order_number: order.sales_order_number,
        customer_name: order.customer_name,
        sales_order_memo: order.memo || null,
        sales_order_total: order.total || null,
      }).eq('id', vehicleId);

      if (error) {
        alert('Failed to link sales order: ' + error.message);
      } else {
        // Update local state
        setVehicles(prev => prev.map(v =>
          v.id === vehicleId ? {
            ...v,
            netsuite_sales_order_id: order.id,
            sales_order_number: order.sales_order_number,
            customer_name: order.customer_name,
            sales_order_memo: order.memo || null,
            sales_order_total: order.total || null,
          } : v
        ));
        setSoSearchOpen(null);
        setSoSearchTerm('');
        setSoSearchResults([]);
        setUpdateSuccess('Sales order linked');
        setTimeout(() => setUpdateSuccess(null), 2000);
      }
    } catch (err) {
      console.error('Link SO error:', err);
      alert('Failed to link sales order');
    }
    setSoLinking(false);
  };

  const unlinkSalesOrder = async (vehicleId: string) => {
    if (!confirm('Remove the linked sales order from this vehicle?')) return;
    const { error } = await supabase.from('fleet_checkins').update({
      netsuite_sales_order_id: null,
      sales_order_number: null,
      sales_order_memo: null,
      sales_order_total: null,
    }).eq('id', vehicleId);

    if (!error) {
      setVehicles(prev => prev.map(v =>
        v.id === vehicleId ? {
          ...v,
          netsuite_sales_order_id: null,
          sales_order_number: null,
          sales_order_memo: null,
          sales_order_total: null,
        } as any : v
      ));
      setUpdateSuccess('Sales order unlinked');
      setTimeout(() => setUpdateSuccess(null), 2000);
    }
  };

  // ── Dropbox Proof Search ──
  const searchDropboxProofs = async (customerName?: string) => {
    const term = customerName || dbxSearchTerm.trim();
    if (!term) return;
    setDbxSearching(true);
    setDbxResults([]);
    try {
      const res = await fetch(`/api/dropbox/search?q=${encodeURIComponent(term)}`);
      const data = await res.json();
      if (data.connected === false) {
        setDbxConnected(false);
        setDbxSearching(false);
        return;
      }
      setDbxConnected(true);
      setDbxResults(data.results || []);
    } catch { /* ignore */ }
    setDbxSearching(false);
  };

  const copyProofToR2 = async (vehicleId: string, dropboxPath: string, customerName: string) => {
    setDbxCopying(true);
    try {
      const res = await fetch('/api/dropbox/copy-to-r2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dropbox_path: dropboxPath, vehicle_id: vehicleId, customer_name: customerName }),
      });
      const data = await res.json();
      if (data.success) {
        // Update local state
        setVehicles(prev => prev.map(v =>
          v.id === vehicleId ? { ...v, proof_url: data.publicUrl, proof_filename: data.filename, proof_dropbox_path: dropboxPath } as any : v
        ));
        setDbxSearchOpen(null);
        setDbxSearchTerm('');
        setDbxResults([]);
        setUpdateSuccess('Proof linked from Dropbox');
        setTimeout(() => setUpdateSuccess(null), 3000);
      } else {
        alert(`Failed to copy proof: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
    setDbxCopying(false);
  };

  const connectDropbox = async () => {
    try {
      const res = await fetch('/api/dropbox/auth?action=url');
      const data = await res.json();
      if (data.authUrl) {
        window.location.href = data.authUrl;
      } else {
        alert('Dropbox not configured. Add DROPBOX_APP_KEY and DROPBOX_APP_SECRET to environment variables.');
      }
    } catch {
      alert('Failed to start Dropbox connection');
    }
  };

  const saveAssignments = async (vehicleId: string, userIds: string[]) => {
    setVehicleAssignments(prev => ({ ...prev, [vehicleId]: userIds }));
    setAssignmentSaving(true);
    try {
      await fetch('/api/jobs/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobType: 'scanned_vehicle',
          jobId: vehicleId,
          userIds,
          assignedBy: user?.id,
          notifyUsers: true,
          jobTitle: vehicles.find(v => v.id === vehicleId)
            ? [vehicles.find(v => v.id === vehicleId)!.vehicle_year, vehicles.find(v => v.id === vehicleId)!.vehicle_make, vehicles.find(v => v.id === vehicleId)!.vehicle_model].filter(Boolean).join(' ')
            : undefined,
        }),
      });
    } catch (err) {
      console.error('Assignment save error:', err);
    }
    setAssignmentSaving(false);
  };

  const toggleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setStatusHistory([]);
      setStatusNote('');
    } else {
      setExpandedId(id);
      setStatusNote('');
      loadHistory(id);
      loadAssignments(id);
      loadPhotos(id);
      loadNotes(id);
    }
  };

  const updateStatus = useCallback(async (vehicleId: string, newStatus: VehicleTrackingStatus) => {
    setUpdatingId(vehicleId);
    setUpdateSuccess(null);
    try {
      // Get current status first
      const { data: vehicle, error: fetchErr } = await supabase
        .from('fleet_checkins')
        .select('status')
        .eq('id', vehicleId)
        .single();

      if (fetchErr || !vehicle) {
        alert('Vehicle not found');
        setUpdatingId(null);
        return;
      }

      const fromStatus = vehicle.status;

      // Update the status
      const { error: updateErr } = await supabase
        .from('fleet_checkins')
        .update({ status: newStatus })
        .eq('id', vehicleId);

      if (updateErr) {
        alert('Update failed: ' + updateErr.message);
        setUpdatingId(null);
        return;
      }

      // Log to status history
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (authUser) {
        await supabase.from('vehicle_status_history').insert({
          vehicle_id: vehicleId,
          from_status: fromStatus,
          to_status: newStatus,
          note: statusNote.trim() || null,
          changed_by: authUser.id,
          changed_by_name: profile?.full_name || authUser.email || 'Unknown',
        });
      }

      setStatusNote('');
      setUpdateSuccess(`Updated to ${VEHICLE_STATUS_LABELS[newStatus]}`);
      setTimeout(() => setUpdateSuccess(null), 2000);
      await loadVehicles();
      if (expandedId === vehicleId) loadHistory(vehicleId);

      // Prompt for completion photos when marking as complete
      if (newStatus === 'complete') {
        setShowCompletionPrompt(vehicleId);
        loadPhotos(vehicleId);
      }
    } catch (err) {
      alert('Network error — please try again');
    }
    setUpdatingId(null);
  }, [statusNote, expandedId, profile]);

  const deleteVehicle = async (vehicleId: string) => {
    setDeletingId(vehicleId);
    try {
      const res = await fetch('/api/vehicles/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert('Delete failed: ' + (data.error || 'Unknown error'));
      } else {
        setVehicles(prev => prev.filter(v => v.id !== vehicleId));
        setExpandedId(null);
        setUpdateSuccess('Vehicle deleted');
        setTimeout(() => setUpdateSuccess(null), 2000);
      }
    } catch {
      alert('Network error — please try again');
    }
    setDeletingId(null);
  };

  const archiveVehicle = async (vehicleId: string, unarchive = false) => {
    setArchivingId(vehicleId);
    try {
      const res = await fetch('/api/vehicles/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId, unarchive }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert('Archive failed: ' + (data.error || 'Unknown error'));
      } else {
        setVehicles(prev => prev.map(v =>
          v.id === vehicleId ? { ...v, archived_at: unarchive ? null : new Date().toISOString() } as any : v
        ));
        setExpandedId(null);
        setUpdateSuccess(unarchive ? 'Vehicle restored' : 'Vehicle archived');
        setTimeout(() => setUpdateSuccess(null), 2000);
      }
    } catch {
      alert('Network error — please try again');
    }
    setArchivingId(null);
  };

  // Filter & search
  const activeVehicles = vehicles.filter(v => !(v as any).archived_at);
  const archivedVehicles = vehicles.filter(v => !!(v as any).archived_at);

  const filtered = (showArchived ? archivedVehicles : activeVehicles).filter(v => {
    const status = v.status as VehicleTrackingStatus;
    if (filterStatus === 'stuck') return status === 'stuck_parts' || status === 'stuck_graphics';
    if (filterStatus === 'shipped') return status === 'shipped';
    if (filterStatus !== 'all') return status === filterStatus;
    // "All" tab excludes shipped — shipped only shows on its own tab
    return status !== 'shipped';
  }).filter(v => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    const title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ').toLowerCase();
    return v.vin.toLowerCase().includes(s) || title.includes(s) || (v.customer_name || '').toLowerCase().includes(s);
  });

  // Pipeline counts (active vehicles only)
  const statusCounts: Record<string, number> = {};
  VEHICLE_STATUS_PIPELINE.forEach(s => { statusCounts[s] = 0; });
  activeVehicles.forEach(v => { if (statusCounts[v.status] !== undefined) statusCounts[v.status]++; });
  const stuckCount = (statusCounts['stuck_parts'] || 0) + (statusCounts['stuck_graphics'] || 0);

  // Group filtered vehicles by customer/SO
  const grouped = filtered.reduce((acc: Record<string, FleetCheckin[]>, v) => {
    const key = v.customer_name || v.sales_order_number || 'Unassigned';
    if (!acc[key]) acc[key] = [];
    acc[key].push(v);
    return acc;
  }, {});
  const groupKeys = Object.keys(grouped).sort((a, b) => a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b));

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const vehicleTitle = (v: FleetCheckin) =>
    [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle';

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{
          width: '36px', height: '36px', border: '3px solid var(--border)',
          borderTopColor: 'var(--orange)', borderRadius: '50%', margin: '0 auto',
          animation: 'spin 1s linear infinite',
        }} />
        <div style={{ color: 'var(--text-muted)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading vehicles...</div>
      </div>
    );
  }

  return (
    <div>
      {/* Page Header */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>
          In-Shop
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '14px' }}>
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)' }}>{activeVehicles.filter(v => v.status !== 'shipped').length}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>In Shop</div>
        </div>
        <div
          onClick={() => setFilterStatus(filterStatus === 'stuck' ? 'all' : 'stuck')}
          style={{
            background: stuckCount > 0 ? 'var(--warning-bg)' : 'var(--card)',
            border: `1px solid ${stuckCount > 0 ? 'var(--warning-border)' : 'var(--border)'}`,
            borderRadius: '12px', padding: '12px', textAlign: 'center', cursor: 'pointer',
          }}
        >
          <div style={{ fontSize: '24px', fontWeight: 800, color: stuckCount > 0 ? 'var(--warning)' : 'var(--text-primary)' }}>
            {stuckCount}
          </div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: stuckCount > 0 ? 'var(--warning)' : 'var(--text-muted)', textTransform: 'uppercase' }}>
            Stuck
          </div>
        </div>
        <div style={{
          background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: '12px', padding: '12px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--success)' }}>{statusCounts['complete'] || 0}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--success)', textTransform: 'uppercase' }}>Complete</div>
        </div>
      </div>

      {/* Pipeline Status Filter Bar */}
      <div style={{
        display: 'flex', gap: '3px', marginBottom: '14px', background: 'var(--card)',
        border: '1px solid var(--border)', borderRadius: '10px', padding: '3px', overflow: 'auto',
      }}>
        <button
          onClick={() => setFilterStatus('all')}
          style={{
            padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700,
            background: filterStatus === 'all' ? 'var(--tab-active-bg)' : 'transparent',
            border: 'none', color: filterStatus === 'all' ? 'var(--text-primary)' : 'var(--text-muted)',
            whiteSpace: 'nowrap',
          }}
        >On Ground ({activeVehicles.filter(v => v.status !== 'shipped').length})</button>
        {VEHICLE_STATUS_PIPELINE.map(status => {
          const count = statusCounts[status] || 0;
          const colors = VEHICLE_STATUS_COLORS[status];
          const isActive = filterStatus === status;
          return (
            <button
              key={status}
              onClick={() => setFilterStatus(isActive ? 'all' : status)}
              style={{
                padding: '6px 8px', borderRadius: '7px', fontSize: '10px', fontWeight: 700,
                background: isActive ? colors.bg : 'transparent',
                border: isActive ? `1px solid ${colors.border}` : '1px solid transparent',
                color: isActive ? colors.text : count > 0 ? 'var(--text-secondary)' : 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              {VEHICLE_STATUS_LABELS[status].split('(')[0].trim()} ({count})
            </button>
          );
        })}
      </div>

      {/* Search + Archive Toggle */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by VIN, vehicle, or customer..."
          style={{
            flex: 1, padding: '10px 12px', borderRadius: '10px',
            border: '1px solid var(--border)', background: 'var(--card)',
            color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600,
            boxSizing: 'border-box',
          }}
        />
        {archivedVehicles.length > 0 && (
          <button
            onClick={() => { setShowArchived(!showArchived); setFilterStatus('all'); }}
            style={{
              padding: '10px 12px', borderRadius: '10px', fontSize: '11px', fontWeight: 700,
              background: showArchived ? 'rgba(167,139,250,0.1)' : 'var(--card)',
              border: `1px solid ${showArchived ? 'rgba(167,139,250,0.3)' : 'var(--border)'}`,
              color: showArchived ? '#a78bfa' : 'var(--text-muted)',
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {showArchived ? `Active (${activeVehicles.length})` : `Archived (${archivedVehicles.length})`}
          </button>
        )}
      </div>

      {/* Success Toast */}
      {updateSuccess && (
        <div style={{
          padding: '8px 14px', marginBottom: '10px', borderRadius: '10px',
          background: 'var(--success-bg)', border: '1px solid var(--success-border)',
          color: 'var(--success)', fontSize: '13px', fontWeight: 700, textAlign: 'center',
        }}>
          {updateSuccess}
        </div>
      )}

      {/* Archived banner */}
      {showArchived && (
        <div style={{
          padding: '8px 14px', marginBottom: '10px', borderRadius: '10px',
          background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)',
          color: '#a78bfa', fontSize: '12px', fontWeight: 700, textAlign: 'center',
        }}>
          Viewing Archived Vehicles
        </div>
      )}

      {/* Vehicle List */}
      {filtered.length === 0 ? (
        <div style={{
          padding: '30px 20px', textAlign: 'center', background: 'var(--card)',
          border: '1px solid var(--border)', borderRadius: '14px',
        }}>
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>🚚</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '14px', fontWeight: 600 }}>
            {showArchived ? 'No archived vehicles' : searchTerm ? 'No vehicles match your search' : 'No vehicles in this status'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {groupKeys.map(groupKey => {
            const groupVehicles = grouped[groupKey];
            const isCollapsed = collapsedGroups.has(groupKey);
            const statusSummary: Record<string, number> = {};
            groupVehicles.forEach(v => {
              const s = v.status === 'checked_in' ? 'received' : v.status;
              statusSummary[s] = (statusSummary[s] || 0) + 1;
            });

            return (
              <div key={groupKey}>
                {/* Group header */}
                <div
                  onClick={() => toggleGroup(groupKey)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 14px', borderRadius: '10px', cursor: 'pointer',
                    background: 'var(--card)', border: '1px solid var(--border)',
                    marginBottom: isCollapsed ? 0 : '6px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', transition: 'transform 0.15s', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                    <span style={{ fontWeight: 800, fontSize: '13px', color: 'var(--text-primary)' }}>{groupKey}</span>
                    {groupVehicles[0]?.sales_order_number && groupKey !== groupVehicles[0].sales_order_number && (
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>SO #{groupVehicles[0].sales_order_number}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {Object.entries(statusSummary).map(([s, count]) => {
                      const sc = VEHICLE_STATUS_COLORS[s as VehicleTrackingStatus];
                      return (
                        <span key={s} style={{
                          fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                          background: sc?.bg || 'var(--subtle-bg)',
                          color: sc?.text || 'var(--text-muted)',
                        }}>{count}</span>
                      );
                    })}
                    <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>{groupVehicles.length} VIN{groupVehicles.length !== 1 ? 's' : ''}</span>
                  </div>
                </div>

                {/* Vehicle cards */}
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingLeft: '12px' }}>
                    {groupVehicles.map(vehicle => {
            const isExpanded = expandedId === vehicle.id;
            const status = (vehicle.status === 'checked_in' ? 'received' : vehicle.status) as VehicleTrackingStatus;

            return (
              <div key={vehicle.id} style={{
                background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
                overflow: 'hidden',
              }}>
                {/* Vehicle Row — tap to expand */}
                <div
                  onClick={() => toggleExpand(vehicle.id)}
                  role="button"
                  tabIndex={0}
                  style={{
                    width: '100%', padding: '12px 14px', textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: '14px', color: 'var(--text-primary)' }}>{vehicle.customer_name || 'No Customer'}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{vehicleTitle(vehicle)}</div>
                      <div style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-muted)', marginTop: '2px' }}>{vehicle.vin}</div>
                      {vehicle.sales_order_number && (
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>SO #{vehicle.sales_order_number}</div>
                      )}
                      {(vehicle as any).scheduled_upfit_date && (
                        <div style={{ fontSize: '11px', color: '#3b82f6', fontWeight: 600, marginTop: '1px' }}>Upfit: {new Date((vehicle as any).scheduled_upfit_date + 'T12:00:00').toLocaleDateString()}</div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '8px' }}>
                      <StatusBadge status={status} />
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        {timeAgo(vehicle.updated_at)}
                      </div>
                      {vehicle.assigned_to && profiles[vehicle.assigned_to] && (
                        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                          {profiles[vehicle.assigned_to]}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Expanded Detail Panel */}
                {isExpanded && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{ borderTop: '1px solid var(--border)', padding: '14px' }}
                  >
                    {/* Status Update Buttons — available to all roles */}
                    <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                          Update Status
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {VEHICLE_STATUS_PIPELINE.map(s => {
                            const colors = VEHICLE_STATUS_COLORS[s];
                            const isCurrent = s === status;
                            const isUpdating = updatingId === vehicle.id;
                            return (
                              <button
                                key={s}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  if (!isCurrent && !isUpdating) {
                                    updateStatus(vehicle.id, s);
                                  }
                                }}
                                disabled={isCurrent || isUpdating}
                                style={{
                                  padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                  background: isCurrent ? colors.bg : 'var(--subtle-bg)',
                                  border: `1.5px solid ${isCurrent ? colors.border : 'var(--border)'}`,
                                  color: isCurrent ? colors.text : 'var(--text-secondary)',
                                  opacity: isCurrent ? 1 : (isUpdating ? 0.4 : 1),
                                  cursor: isCurrent || isUpdating ? 'default' : 'pointer',
                                  transition: 'all 0.15s',
                                }}
                              >
                                {isCurrent ? `● ${VEHICLE_STATUS_LABELS[s]}` : VEHICLE_STATUS_LABELS[s]}
                              </button>
                            );
                          })}
                        </div>

                        {/* Note input */}
                        <input
                          type="text"
                          value={statusNote}
                          onChange={(e) => setStatusNote(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="Add a note with the status change..."
                          style={{
                            width: '100%', padding: '8px 10px', borderRadius: '8px', marginTop: '8px',
                            border: '1px solid var(--border)', background: 'var(--input-bg)',
                            color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
                          }}
                        />
                      </div>

                    {/* Vehicle Info */}
                    <div style={{
                      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px',
                    }}>
                      {vehicle.customer_name && (
                        <div>
                          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Customer</div>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>{vehicle.customer_name}</div>
                        </div>
                      )}
                      {vehicle.sales_order_number && (
                        <div>
                          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Sales Order</div>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>#{vehicle.sales_order_number}</div>
                        </div>
                      )}
                      <div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Checked In</div>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                          {new Date(vehicle.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </div>
                      </div>
                      {vehicle.notes && (
                        <div>
                          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Notes</div>
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{vehicle.notes}</div>
                        </div>
                      )}
                    </div>

                    {/* Scheduled Upfit Date */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Scheduled Upfit Date</div>
                      <input
                        type="date"
                        value={(vehicle as any).scheduled_upfit_date || ''}
                        onClick={(e) => e.stopPropagation()}
                        onChange={async (e) => {
                          const newDate = e.target.value || null;
                          await supabase.from('fleet_checkins').update({ scheduled_upfit_date: newDate, updated_at: new Date().toISOString() }).eq('id', vehicle.id);
                          setVehicles(prev => prev.map(v => v.id === vehicle.id ? { ...v, scheduled_upfit_date: newDate } as any : v));
                          // Sync to Google Calendar
                          if (newDate) {
                            fetch('/api/calendar/sync-upfit', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ checkinId: vehicle.id }),
                            }).catch(() => {});
                          }
                        }}
                        style={{
                          width: '100%', padding: '8px 10px', borderRadius: '8px',
                          border: '1px solid var(--border)', background: 'var(--input-bg)',
                          color: 'var(--text-primary)', fontSize: '12px',
                        }}
                      />
                    </div>

                    {/* Sales Order Section */}
                    {vehicle.netsuite_sales_order_id && vehicle.sales_order_number ? (
                      <div style={{ marginBottom: '12px' }}>
                        <NetSuitePdf
                          type="salesOrder"
                          recordId={vehicle.netsuite_sales_order_id}
                          recordNumber={vehicle.sales_order_number}
                        />
                        {isAdmin && (
                          <button
                            onClick={() => unlinkSalesOrder(vehicle.id)}
                            style={{
                              marginTop: '4px', padding: '4px 10px', fontSize: '10px', fontWeight: 600,
                              background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px',
                              color: 'var(--text-muted)', cursor: 'pointer',
                            }}
                          >Unlink Sales Order</button>
                        )}
                      </div>
                    ) : (
                      <div style={{ marginBottom: '12px' }}>
                        {soSearchOpen === vehicle.id ? (
                          <div style={{
                            padding: '12px', borderRadius: '10px',
                            background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                          }}>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>
                              Search NetSuite Sales Orders
                            </div>
                            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                              <input
                                value={soSearchTerm}
                                onChange={(e) => setSoSearchTerm(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') searchSalesOrders(); }}
                                placeholder="Customer name..."
                                style={{
                                  flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '13px',
                                  border: '1px solid var(--border)', background: 'var(--input-bg)',
                                  color: 'var(--text-primary)',
                                }}
                              />
                              <button
                                onClick={searchSalesOrders}
                                disabled={soSearching || !soSearchTerm.trim()}
                                style={{
                                  padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                  background: 'var(--navy)', color: '#fff', border: 'none',
                                  opacity: soSearching || !soSearchTerm.trim() ? 0.5 : 1, cursor: 'pointer',
                                }}
                              >{soSearching ? '...' : 'Search'}</button>
                              <button
                                onClick={() => { setSoSearchOpen(null); setSoSearchTerm(''); setSoSearchResults([]); }}
                                style={{
                                  padding: '8px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                  background: 'transparent', border: '1px solid var(--border)',
                                  color: 'var(--text-muted)', cursor: 'pointer',
                                }}
                              >Cancel</button>
                            </div>
                            {soSearchResults.length > 0 && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                                {soSearchResults.map((so: any) => (
                                  <div
                                    key={so.id}
                                    onClick={() => linkSalesOrder(vehicle.id, so)}
                                    style={{
                                      padding: '8px 10px', borderRadius: '8px', cursor: 'pointer',
                                      background: 'var(--card)', border: '1px solid var(--border)',
                                    }}
                                  >
                                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                                      SO #{so.sales_order_number}
                                    </div>
                                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                      {so.customer_name} · {so.date} · ${so.total?.toLocaleString() || '0'}
                                    </div>
                                    {so.memo && (
                                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{so.memo}</div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                            {soSearching && (
                              <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>Searching NetSuite...</div>
                            )}
                          </div>
                        ) : (
                          <button
                            onClick={() => setSoSearchOpen(vehicle.id)}
                            style={{
                              width: '100%', padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                              background: 'rgba(59,130,246,0.08)', border: '1px dashed rgba(59,130,246,0.3)',
                              color: 'rgb(59,130,246)', cursor: 'pointer',
                            }}
                          >+ Link Sales Order</button>
                        )}
                      </div>
                    )}

                    {/* Proof File (Dropbox) */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                        Proof File
                      </div>
                      {(vehicle as any).proof_url ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)' }}>
                          <ProofThumbnail
                            pdfUrl={(vehicle as any).proof_url}
                            dropboxPath={(vehicle as any).proof_dropbox_path || undefined}
                            label={(vehicle as any).proof_filename || 'Proof'}
                            thumbSize={48}
                            expandedSize={300}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <a
                              href={(vehicle as any).proof_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: '12px', fontWeight: 700, color: '#22c55e', textDecoration: 'none' }}
                            >
                              {(vehicle as any).proof_filename || 'View Proof'}
                            </a>
                            {(vehicle as any).proof_dropbox_path && (
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                Dropbox: {(vehicle as any).proof_dropbox_path}
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => {
                              setDbxSearchOpen(vehicle.id);
                              if (vehicle.customer_name) {
                                setDbxSearchTerm(vehicle.customer_name);
                                searchDropboxProofs(vehicle.customer_name);
                              }
                            }}
                            style={{ padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}
                          >Replace</button>
                        </div>
                      ) : dbxSearchOpen === vehicle.id ? (
                        <div style={{ padding: '12px', borderRadius: '10px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                          {dbxConnected === false ? (
                            <div style={{ textAlign: 'center', padding: '12px 0' }}>
                              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>Dropbox is not connected yet</div>
                              <button
                                onClick={connectDropbox}
                                style={{ padding: '10px 20px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: '#0061fe', color: '#fff', border: 'none', cursor: 'pointer' }}
                              >Connect Dropbox</button>
                            </div>
                          ) : (
                            <>
                              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>
                                Search Dropbox for Proof
                              </div>
                              <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                                <input
                                  value={dbxSearchTerm}
                                  onChange={(e) => setDbxSearchTerm(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') searchDropboxProofs(); }}
                                  placeholder="Customer or file name..."
                                  autoFocus
                                  style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }}
                                />
                                <button
                                  onClick={() => searchDropboxProofs()}
                                  disabled={dbxSearching || !dbxSearchTerm.trim()}
                                  style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: '#0061fe', color: '#fff', border: 'none', opacity: dbxSearching || !dbxSearchTerm.trim() ? 0.5 : 1, cursor: 'pointer' }}
                                >{dbxSearching ? '...' : 'Search'}</button>
                                <button
                                  onClick={() => { setDbxSearchOpen(null); setDbxSearchTerm(''); setDbxResults([]); }}
                                  style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}
                                >Cancel</button>
                              </div>
                              {dbxSearching && (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>Searching Dropbox...</div>
                              )}
                              {!dbxSearching && dbxResults.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '250px', overflowY: 'auto' }}>
                                  {dbxResults.map((file) => (
                                    <button
                                      key={file.id}
                                      onClick={() => copyProofToR2(vehicle.id, file.path, vehicle.customer_name || '')}
                                      disabled={dbxCopying}
                                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderRadius: '8px', cursor: dbxCopying ? 'wait' : 'pointer', background: 'var(--card)', border: '1px solid var(--border)', textAlign: 'left', width: '100%' }}
                                    >
                                      <ProofThumbnail dropboxPath={file.path} label={file.name} thumbSize={48} expandedSize={280} />
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          {file.folder ? file.folder : file.path} · {(file.size / 1024).toFixed(0)} KB
                                        </div>
                                      </div>
                                      <span style={{ fontSize: '10px', color: '#0061fe', fontWeight: 700, flexShrink: 0 }}>{dbxCopying ? 'Copying...' : 'Use This'}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                              {!dbxSearching && dbxSearchTerm.length >= 2 && dbxResults.length === 0 && (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>No files found in Dropbox</div>
                              )}
                            </>
                          )}
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setDbxSearchOpen(vehicle.id);
                            // Auto-populate search with customer name
                            if (vehicle.customer_name) {
                              setDbxSearchTerm(vehicle.customer_name);
                              searchDropboxProofs(vehicle.customer_name);
                            }
                          }}
                          style={{ width: '100%', padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(0,97,254,0.08)', border: '1px dashed rgba(0,97,254,0.3)', color: '#0061fe', cursor: 'pointer' }}
                        >Find Proof in Dropbox</button>
                      )}
                    </div>

                    {/* Completion Photos */}
                    <div style={{ marginBottom: '12px' }}>
                      {/* Completion prompt banner */}
                      {showCompletionPrompt === vehicle.id && (
                        <div style={{
                          padding: '12px', borderRadius: '10px', marginBottom: '10px',
                          background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)',
                        }}>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: '#22c55e', marginBottom: '4px' }}>
                            Vehicle marked as complete!
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                            Add completion photos to document the finished work. The more photos, the better!
                          </div>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                cameraInputRef.current?.click();
                              }}
                              style={{
                                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)',
                                color: '#22c55e', cursor: 'pointer',
                              }}
                            >
                              Take Photos
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                photoInputRef.current?.click();
                              }}
                              style={{
                                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)',
                                color: '#22c55e', cursor: 'pointer',
                              }}
                            >
                              From Gallery
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowCompletionPrompt(null);
                              }}
                              style={{
                                padding: '10px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                                color: 'var(--text-muted)', cursor: 'pointer',
                              }}
                            >
                              Skip
                            </button>
                          </div>
                        </div>
                      )}

                      <div style={{
                        fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      }}>
                        <span>Completion Photos {(vehiclePhotos[vehicle.id]?.length || 0) > 0 ? `(${vehiclePhotos[vehicle.id].length})` : ''}</span>
                        {showCompletionPrompt !== vehicle.id && (
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); cameraInputRef.current?.click(); }}
                              disabled={photoUploading}
                              style={{
                                padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                                background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                                color: '#3b82f6', cursor: photoUploading ? 'wait' : 'pointer',
                              }}
                            >
                              Camera
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); photoInputRef.current?.click(); }}
                              disabled={photoUploading}
                              style={{
                                padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                                background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                                color: '#3b82f6', cursor: photoUploading ? 'wait' : 'pointer',
                              }}
                            >
                              Gallery
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Hidden file inputs */}
                      <input
                        ref={cameraInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(e) => { handlePhotoFiles(vehicle.id, e.target.files); e.target.value = ''; }}
                      />
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(e) => { handlePhotoFiles(vehicle.id, e.target.files); e.target.value = ''; }}
                      />

                      {/* Upload progress */}
                      {photoUploading && (
                        <div style={{
                          padding: '10px', borderRadius: '8px', marginBottom: '8px',
                          background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                          fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'center',
                        }}>
                          Uploading photo...
                        </div>
                      )}

                      {/* Photo grid */}
                      {photosLoading[vehicle.id] ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading photos...</div>
                      ) : (vehiclePhotos[vehicle.id]?.length || 0) === 0 ? (
                        <div style={{
                          fontSize: '12px', color: 'var(--text-muted)', padding: '16px',
                          textAlign: 'center', borderRadius: '8px',
                          background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                        }}>
                          No photos yet — add photos to document the work
                        </div>
                      ) : (
                        <div style={{
                          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px',
                        }}>
                          {vehiclePhotos[vehicle.id].map(photo => (
                            <div key={photo.id} style={{ position: 'relative' }}>
                              <div style={{
                                paddingTop: '100%', position: 'relative', borderRadius: '8px',
                                overflow: 'hidden', background: 'var(--subtle-bg)',
                              }}>
                                <img
                                  src={photo.url}
                                  alt="Completion photo"
                                  style={{
                                    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                                    objectFit: 'cover',
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    window.open(photo.url, '_blank');
                                  }}
                                />
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deletePhoto(vehicle.id, photo.id, photo.storage_path);
                                }}
                                style={{
                                  position: 'absolute', top: '4px', right: '4px',
                                  width: '22px', height: '22px', borderRadius: '50%',
                                  background: 'rgba(0,0,0,0.6)', border: 'none',
                                  color: '#fff', fontSize: '12px', cursor: 'pointer',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                }}
                              >
                                ×
                              </button>
                              <div style={{
                                fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px', textAlign: 'center',
                              }}>
                                {new Date(photo.taken_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Installer Assignment */}
                    {isAdmin && (
                      <div style={{ marginBottom: '12px' }}>
                        <AssignmentPicker
                          jobType="scanned_vehicle"
                          jobId={vehicle.id}
                          selectedIds={vehicleAssignments[vehicle.id] || []}
                          onChange={(ids) => saveAssignments(vehicle.id, ids)}
                          roles={['installer', 'admin']}
                          label="Assigned Installers"
                        />
                      </div>
                    )}

                    {/* Install Notes */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{
                        fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px',
                      }}>
                        Install Notes {(vehicleNotes[vehicle.id]?.length || 0) > 0 ? `(${vehicleNotes[vehicle.id].length})` : ''}
                      </div>

                      {/* Add note input */}
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                        <input
                          type="text"
                          value={noteInput[vehicle.id] || ''}
                          onChange={(e) => setNoteInput(prev => ({ ...prev, [vehicle.id]: e.target.value }))}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !noteSaving) addNote(vehicle.id); }}
                          placeholder="Add a note... (measurements, brackets, techniques, etc.)"
                          style={{
                            flex: 1, padding: '8px 10px', borderRadius: '8px',
                            border: '1px solid var(--border)', background: 'var(--input-bg)',
                            color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
                          }}
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); addNote(vehicle.id); }}
                          disabled={noteSaving || !(noteInput[vehicle.id] || '').trim()}
                          style={{
                            padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                            background: (noteInput[vehicle.id] || '').trim() ? 'rgba(59,130,246,0.15)' : 'var(--subtle-bg)',
                            border: `1px solid ${(noteInput[vehicle.id] || '').trim() ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
                            color: (noteInput[vehicle.id] || '').trim() ? '#3b82f6' : 'var(--text-muted)',
                            cursor: noteSaving || !(noteInput[vehicle.id] || '').trim() ? 'default' : 'pointer',
                          }}
                        >
                          {noteSaving ? '...' : 'Add'}
                        </button>
                      </div>

                      {/* Notes list */}
                      {notesLoading[vehicle.id] ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading notes...</div>
                      ) : (vehicleNotes[vehicle.id]?.length || 0) === 0 ? (
                        <div style={{
                          fontSize: '12px', color: 'var(--text-muted)', padding: '12px',
                          textAlign: 'center', borderRadius: '8px',
                          background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                        }}>
                          No install notes yet
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {vehicleNotes[vehicle.id].map(n => (
                            <div key={n.id} style={{
                              padding: '8px 10px', borderRadius: '8px',
                              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                            }}>
                              <div style={{ fontSize: '12px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                {n.note}
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                                  {n.created_by_name} · {new Date(n.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                </div>
                                {n.created_by === user?.id && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); deleteNote(vehicle.id, n.id); }}
                                    style={{
                                      fontSize: '10px', color: 'var(--text-muted)', background: 'none',
                                      border: 'none', cursor: 'pointer', padding: '2px 4px',
                                    }}
                                  >
                                    Delete
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Status History */}
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                        Status History
                      </div>
                      {historyLoading ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading...</div>
                      ) : statusHistory.length === 0 ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>No status changes recorded yet</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {statusHistory.map(h => (
                            <div key={h.id} style={{
                              padding: '8px 10px', borderRadius: '8px',
                              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                                  {h.from_status && (
                                    <>
                                      <span style={{ color: 'var(--text-muted)' }}>
                                        {VEHICLE_STATUS_LABELS[h.from_status as VehicleTrackingStatus] || h.from_status}
                                      </span>
                                      <span style={{ color: 'var(--text-muted)' }}>→</span>
                                    </>
                                  )}
                                  <StatusBadge status={h.to_status as VehicleTrackingStatus} size="sm" />
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                                  {timeAgo(h.created_at)}
                                </div>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                  {h.changed_by_name || 'Unknown'}
                                </div>
                                {h.note && (
                                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                                    {h.note}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Archive & Delete Actions */}
                    {isAdmin && (
                      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                        {(vehicle as any).archived_at ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); archiveVehicle(vehicle.id, true); }}
                            disabled={archivingId === vehicle.id}
                            style={{
                              flex: 1, padding: '10px', borderRadius: '10px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                              background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', color: '#a78bfa',
                            }}
                          >
                            {archivingId === vehicle.id ? 'Restoring...' : 'Restore from Archive'}
                          </button>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); archiveVehicle(vehicle.id); }}
                            disabled={archivingId === vehicle.id}
                            style={{
                              flex: 1, padding: '10px', borderRadius: '10px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                              background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', color: '#a78bfa',
                            }}
                          >
                            {archivingId === vehicle.id ? 'Archiving...' : 'Archive Vehicle'}
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`Permanently delete this vehicle (${vehicle.vin})? This cannot be undone.`)) {
                              deleteVehicle(vehicle.id);
                            }
                          }}
                          disabled={deletingId === vehicle.id}
                          style={{
                            padding: '10px 16px', borderRadius: '10px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                            background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171',
                          }}
                        >
                          {deletingId === vehicle.id ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {hasMore && !searchTerm && (
            <button
              onClick={() => loadVehicles(true)}
              disabled={loadingMore}
              style={{
                width: '100%', padding: '14px', borderRadius: '10px', marginTop: '8px',
                fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                color: loadingMore ? 'var(--text-muted)' : '#60a5fa',
              }}
            >
              {loadingMore ? 'Loading...' : `Load More Vehicles (${vehicles.length} loaded)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
