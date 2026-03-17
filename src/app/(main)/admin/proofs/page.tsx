'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface ProofRecord {
  id: string;
  customer_name: string;
  vehicle_type: string | null;
  file_name: string;
  storage_path: string;
  file_size: number | null;
  nas_path: string | null;
  sync_status: 'synced' | 'needs_review' | 'archived' | 'manual';
  review_note: string | null;
  created_at: string;
  last_synced_at: string | null;
}

export default function ProofHygienePage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();

  const [tab, setTab] = useState<'needs_review' | 'all'>('needs_review');
  const [proofs, setProofs] = useState<ProofRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCustomer, setEditCustomer] = useState('');
  const [editVehicle, setEditVehicle] = useState('');
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [stats, setStats] = useState({ total: 0, review: 0, synced: 0 });

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadProofs();
    loadStats();
  }, [isAdmin, tab]);

  const loadProofs = async () => {
    setLoading(true);
    let query = supabase
      .from('graphics_proofs')
      .select('*')
      .order('created_at', { ascending: false });

    if (tab === 'needs_review') {
      query = query.eq('sync_status', 'needs_review');
    }

    const { data } = await query.limit(100);
    setProofs(data || []);
    setLoading(false);
  };

  const loadStats = async () => {
    const [{ count: total }, { count: review }, { count: synced }] = await Promise.all([
      supabase.from('graphics_proofs').select('*', { count: 'exact', head: true }),
      supabase.from('graphics_proofs').select('*', { count: 'exact', head: true }).eq('sync_status', 'needs_review'),
      supabase.from('graphics_proofs').select('*', { count: 'exact', head: true }).eq('sync_status', 'synced'),
    ]);
    setStats({ total: total || 0, review: review || 0, synced: synced || 0 });
  };

  const startEdit = (proof: ProofRecord) => {
    setEditingId(proof.id);
    setEditCustomer(proof.customer_name || '');
    setEditVehicle(proof.vehicle_type || '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditCustomer('');
    setEditVehicle('');
  };

  const saveAssignment = async (proofId: string) => {
    if (!editCustomer.trim()) return;
    setSaving(true);

    const { error } = await supabase
      .from('graphics_proofs')
      .update({
        customer_name: editCustomer.trim(),
        vehicle_type: editVehicle.trim() || null,
        sync_status: 'synced',
        assigned_by: user?.id,
        assigned_at: new Date().toISOString(),
      })
      .eq('id', proofId);

    if (!error) {
      setEditingId(null);
      setEditCustomer('');
      setEditVehicle('');
      loadProofs();
      loadStats();
    }
    setSaving(false);
  };

  const markArchived = async (proofId: string) => {
    await supabase
      .from('graphics_proofs')
      .update({ sync_status: 'archived' })
      .eq('id', proofId);
    loadProofs();
    loadStats();
  };

  const formatSize = (bytes: number | null) => {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  const filtered = proofs.filter(p => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    return (
      p.file_name.toLowerCase().includes(s) ||
      p.customer_name.toLowerCase().includes(s) ||
      (p.vehicle_type || '').toLowerCase().includes(s) ||
      (p.nas_path || '').toLowerCase().includes(s)
    );
  });

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{
          width: '36px', height: '36px', border: '3px solid var(--border)',
          borderTopColor: 'var(--orange)', borderRadius: '50%', margin: '0 auto',
          animation: 'spin 1s linear infinite',
        }} />
        <div style={{ color: 'var(--text-muted)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading proofs...</div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Admin</div>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Proof Hygiene</div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '14px' }}>
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)' }}>{stats.total}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total</div>
        </div>
        <div style={{
          background: stats.review > 0 ? 'var(--warning-bg)' : 'var(--card)',
          border: `1px solid ${stats.review > 0 ? 'var(--warning-border)' : 'var(--border)'}`,
          borderRadius: '12px', padding: '12px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: stats.review > 0 ? 'var(--warning)' : 'var(--text-primary)' }}>{stats.review}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: stats.review > 0 ? 'var(--warning)' : 'var(--text-muted)', textTransform: 'uppercase' }}>Needs Review</div>
        </div>
        <div style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--success)' }}>{stats.synced}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--success)', textTransform: 'uppercase' }}>Synced</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', background: 'var(--card)', borderRadius: '10px', padding: '3px' }}>
        <button onClick={() => setTab('needs_review')} style={{
          flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
          background: tab === 'needs_review' ? 'var(--tab-active-bg)' : 'transparent', border: 'none',
          color: tab === 'needs_review' ? 'var(--text-primary)' : 'var(--text-muted)',
        }}>Needs Review ({stats.review})</button>
        <button onClick={() => setTab('all')} style={{
          flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
          background: tab === 'all' ? 'var(--tab-active-bg)' : 'transparent', border: 'none',
          color: tab === 'all' ? 'var(--text-primary)' : 'var(--text-muted)',
        }}>All Proofs</button>
      </div>

      {/* Search */}
      <input
        type="text"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        placeholder="Search by filename, customer, or path..."
        style={{
          width: '100%', padding: '10px 12px', borderRadius: '10px',
          border: '1px solid var(--border)', background: 'var(--card)',
          color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600,
          marginBottom: '12px', boxSizing: 'border-box',
        }}
      />

      {/* Proof List */}
      {filtered.length === 0 ? (
        <div style={{
          padding: '30px 20px', textAlign: 'center', background: 'var(--card)',
          border: '1px solid var(--border)', borderRadius: '14px',
        }}>
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>
            {tab === 'needs_review' ? '✅' : '📄'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '14px', fontWeight: 600 }}>
            {tab === 'needs_review' ? 'All proofs are assigned — nothing to review' : 'No proofs found'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filtered.map(proof => {
            const isEditing = editingId === proof.id;

            return (
              <div key={proof.id} style={{
                background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
                padding: '12px 14px',
              }}>
                {/* File info */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                      {proof.file_name}
                    </div>
                    {proof.nas_path && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', wordBreak: 'break-all' }}>
                        {proof.nas_path}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '4px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                      <span>{proof.customer_name}</span>
                      {proof.vehicle_type && <span>· {proof.vehicle_type}</span>}
                      <span>· {formatSize(proof.file_size)}</span>
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, marginLeft: '8px' }}>
                    <span style={{
                      padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                      background: proof.sync_status === 'needs_review'
                        ? 'var(--warning-bg)' : proof.sync_status === 'synced'
                        ? 'var(--success-bg)' : 'var(--subtle-bg)',
                      border: `1px solid ${proof.sync_status === 'needs_review'
                        ? 'var(--warning-border)' : proof.sync_status === 'synced'
                        ? 'var(--success-border)' : 'var(--border)'}`,
                      color: proof.sync_status === 'needs_review'
                        ? 'var(--warning)' : proof.sync_status === 'synced'
                        ? 'var(--success)' : 'var(--text-muted)',
                    }}>
                      {proof.sync_status === 'needs_review' ? 'Needs Review' : proof.sync_status === 'synced' ? 'Synced' : proof.sync_status}
                    </span>
                  </div>
                </div>

                {/* Edit / Assign UI */}
                {isEditing ? (
                  <div style={{ marginTop: '10px', padding: '10px', background: 'var(--subtle-bg)', borderRadius: '10px' }}>
                    <div style={{ marginBottom: '6px' }}>
                      <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Customer Name</label>
                      <input
                        type="text"
                        value={editCustomer}
                        onChange={(e) => setEditCustomer(e.target.value)}
                        placeholder="Enter customer name"
                        style={{
                          width: '100%', padding: '8px 10px', borderRadius: '8px', marginTop: '3px',
                          border: '1px solid var(--border)', background: 'var(--input-bg)',
                          color: 'var(--text-primary)', fontSize: '13px', boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <div style={{ marginBottom: '8px' }}>
                      <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Vehicle Type (optional)</label>
                      <input
                        type="text"
                        value={editVehicle}
                        onChange={(e) => setEditVehicle(e.target.value)}
                        placeholder="e.g. Box Truck, Sprinter Van"
                        style={{
                          width: '100%', padding: '8px 10px', borderRadius: '8px', marginTop: '3px',
                          border: '1px solid var(--border)', background: 'var(--input-bg)',
                          color: 'var(--text-primary)', fontSize: '13px', boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        onClick={() => saveAssignment(proof.id)}
                        disabled={!editCustomer.trim() || saving}
                        style={{
                          flex: 1, padding: '10px', borderRadius: '8px', fontWeight: 700, fontSize: '13px',
                          background: editCustomer.trim() ? 'var(--navy)' : 'var(--border)',
                          color: '#fff', border: 'none', opacity: !editCustomer.trim() || saving ? 0.4 : 1,
                        }}
                      >{saving ? 'Saving...' : 'Save & Mark Synced'}</button>
                      <button
                        onClick={cancelEdit}
                        style={{
                          padding: '10px 14px', borderRadius: '8px', fontWeight: 600, fontSize: '12px',
                          background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
                        }}
                      >Cancel</button>
                    </div>
                  </div>
                ) : proof.sync_status === 'needs_review' ? (
                  <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                    <button
                      onClick={() => startEdit(proof)}
                      style={{
                        flex: 1, padding: '8px', borderRadius: '8px', fontWeight: 700, fontSize: '12px',
                        background: 'var(--navy)', color: '#fff', border: 'none',
                      }}
                    >Assign Customer</button>
                    <button
                      onClick={() => markArchived(proof.id)}
                      style={{
                        padding: '8px 12px', borderRadius: '8px', fontWeight: 600, fontSize: '12px',
                        background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
                      }}
                    >Archive</button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
