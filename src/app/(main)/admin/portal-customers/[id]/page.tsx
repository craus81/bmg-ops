'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import type { PortalCustomer, CustomerProofAssignment, ProofPart, PortalCustomerUser, GraphicsProof } from '@/lib/types';

type Tab = 'proofs' | 'users' | 'settings';

export default function PortalCustomerDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const { isAdmin, isSales } = useAuth();

  const [tab, setTab] = useState<Tab>('proofs');
  const [customer, setCustomer] = useState<PortalCustomer | null>(null);
  const [loading, setLoading] = useState(true);

  // Proofs tab
  const [assignments, setAssignments] = useState<CustomerProofAssignment[]>([]);
  const [parts, setParts] = useState<ProofPart[]>([]);
  const [proofSearch, setProofSearch] = useState('');
  const [proofResults, setProofResults] = useState<GraphicsProof[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [expandedProof, setExpandedProof] = useState<string | null>(null);
  const [addingPart, setAddingPart] = useState<string | null>(null); // proof_id
  const [newPart, setNewPart] = useState({ part_name: '', part_number: '', description: '', unit_price: '' });
  const [editingPart, setEditingPart] = useState<string | null>(null);
  const [editPartData, setEditPartData] = useState({ part_name: '', part_number: '', description: '', unit_price: '' });

  // Users tab
  const [users, setUsers] = useState<PortalCustomerUser[]>([]);
  const [showUserForm, setShowUserForm] = useState(false);
  const [newUser, setNewUser] = useState({ full_name: '', email: '', password: '', portal_role: 'user', send_invite: true });
  const [userSaving, setUserSaving] = useState(false);
  const [userError, setUserError] = useState('');
  const [createdInvite, setCreatedInvite] = useState<string | null>(null);

  // Settings tab
  const [editSettings, setEditSettings] = useState({ company_name: '', slug: '', primary_color: '' });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const appUrl = typeof window !== 'undefined' ? window.location.origin : '';

  useEffect(() => {
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    loadAll();
  }, [id, isAdmin, isSales]);

  const loadAll = async () => {
    setLoading(true);
    await Promise.all([loadCustomer(), loadAssignments(), loadParts(), loadUsers()]);
    setLoading(false);
  };

  const loadCustomer = async () => {
    const res = await fetch(`/api/admin/portal-customers/${id}`);
    if (res.ok) {
      const data = await res.json();
      setCustomer(data);
      setEditSettings({ company_name: data.company_name, slug: data.slug, primary_color: data.primary_color || '#EE3120' });
    }
  };

  const loadAssignments = async () => {
    const res = await fetch(`/api/admin/portal-customers/${id}/proofs`);
    if (res.ok) setAssignments(await res.json());
  };

  const loadParts = async () => {
    const res = await fetch(`/api/admin/portal-customers/${id}/proof-parts`);
    if (res.ok) setParts(await res.json());
  };

  const loadUsers = async () => {
    const res = await fetch(`/api/admin/portal-customers/${id}/users`);
    if (res.ok) setUsers(await res.json());
  };

  // Proof search (all graphics proofs)
  const searchProofs = async (term: string) => {
    setProofSearch(term);
    if (term.length < 2) { setProofResults([]); return; }
    setSearchLoading(true);
    const { createClient } = await import('@/lib/supabase-browser');
    const supabase = createClient();
    const { data } = await supabase
      .from('graphics_proofs')
      .select('id, customer_name, vehicle_type, file_name, thumbnail_path, created_at')
      .or(`customer_name.ilike.%${term}%,vehicle_type.ilike.%${term}%,file_name.ilike.%${term}%`)
      .limit(10);
    setProofResults(data || []);
    setSearchLoading(false);
  };

  const assignProof = async (proofId: string) => {
    const res = await fetch(`/api/admin/portal-customers/${id}/proofs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof_id: proofId }),
    });
    if (res.ok) {
      setProofSearch(''); setProofResults([]);
      await Promise.all([loadAssignments(), loadParts()]);
    }
  };

  const unassignProof = async (assignmentId: string) => {
    if (!confirm('Remove this proof from the portal?')) return;
    await fetch(`/api/admin/portal-customers/${id}/proofs`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignment_id: assignmentId }),
    });
    await Promise.all([loadAssignments(), loadParts()]);
  };

  const savePart = async (proofId: string) => {
    if (!newPart.part_name.trim()) return;
    await fetch(`/api/admin/portal-customers/${id}/proof-parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof_id: proofId, ...newPart, unit_price: parseFloat(newPart.unit_price) || 0 }),
    });
    setNewPart({ part_name: '', part_number: '', description: '', unit_price: '' });
    setAddingPart(null);
    loadParts();
  };

  const updatePart = async (partId: string) => {
    await fetch(`/api/admin/portal-customers/${id}/proof-parts`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ part_id: partId, ...editPartData, unit_price: parseFloat(editPartData.unit_price) || 0 }),
    });
    setEditingPart(null);
    loadParts();
  };

  const deletePart = async (partId: string) => {
    if (!confirm('Delete this part?')) return;
    await fetch(`/api/admin/portal-customers/${id}/proof-parts`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ part_id: partId }),
    });
    loadParts();
  };

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserSaving(true); setUserError(''); setCreatedInvite(null);
    const res = await fetch(`/api/admin/portal-customers/${id}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newUser),
    });
    const data = await res.json();
    setUserSaving(false);
    if (!res.ok) { setUserError(data.error || 'Failed to create user'); return; }
    setCreatedInvite(data.inviteLink);
    setNewUser({ full_name: '', email: '', password: '', portal_role: 'user', send_invite: true });
    loadUsers();
  };

  const removeUser = async (pcuId: string) => {
    if (!confirm('Remove this user from the portal?')) return;
    await fetch(`/api/admin/portal-customers/${id}/users`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pcu_id: pcuId }),
    });
    loadUsers();
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsSaving(true); setSettingsError('');

    let logo_url = customer?.logo_url;
    if (logoFile) {
      const formData = new FormData();
      formData.append('file', logoFile);
      formData.append('bucket', 'logos');
      formData.append('path', `portal/${id}/${logoFile.name}`);
      const uploadRes = await fetch('/api/storage', { method: 'POST', body: formData });
      if (uploadRes.ok) {
        const uploadData = await uploadRes.json();
        logo_url = uploadData.publicUrl;
      }
    }

    const res = await fetch(`/api/admin/portal-customers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...editSettings, logo_url }),
    });
    const data = await res.json();
    setSettingsSaving(false);
    if (!res.ok) { setSettingsError(data.error || 'Failed to save'); return; }
    setCustomer(data);
    setLogoFile(null);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '11px 14px', borderRadius: '10px',
    border: '1px solid var(--border)', background: 'var(--card)',
    color: 'var(--text-primary)', fontSize: '14px', marginBottom: '10px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: '5px',
  };

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}>
      <div style={{ width: '28px', height: '28px', border: '2px solid var(--border)', borderTopColor: 'var(--orange)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
    </div>
  );

  if (!customer) return (
    <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
      Portal customer not found
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <button onClick={() => router.push('/admin/portal-customers')} style={{
          background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px',
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
          {customer.logo_url ? (
            <img src={customer.logo_url} alt={customer.company_name} style={{ height: '36px', maxWidth: '80px', objectFit: 'contain' }} />
          ) : (
            <div style={{
              width: '36px', height: '36px', borderRadius: '8px',
              background: customer.primary_color || 'var(--navy)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '16px', fontWeight: 800, color: '#fff',
            }}>
              {customer.company_name.charAt(0)}
            </div>
          )}
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>{customer.company_name}</h1>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              <a href={`/portal/${customer.slug}`} target="_blank" rel="noreferrer" style={{ color: 'var(--orange)', textDecoration: 'none' }}>
                /portal/{customer.slug}
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', background: 'var(--card)', borderRadius: '10px', padding: '4px', marginBottom: '20px', border: '1px solid var(--border)' }}>
        {(['proofs', 'users', 'settings'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: '9px', borderRadius: '7px', fontSize: '13px', fontWeight: 700,
            background: tab === t ? 'var(--orange)' : 'transparent',
            color: tab === t ? '#fff' : 'var(--text-muted)',
            border: 'none', cursor: 'pointer', textTransform: 'capitalize',
          }}>
            {t === 'proofs' ? `Proofs (${assignments.length})` : t === 'users' ? `Users (${users.length})` : 'Settings'}
          </button>
        ))}
      </div>

      {/* ─── PROOFS TAB ─── */}
      {tab === 'proofs' && (
        <div>
          {/* Search to add proof */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{ position: 'relative' }}>
              <input
                value={proofSearch}
                onChange={(e) => searchProofs(e.target.value)}
                placeholder="Search proofs to assign (customer name, vehicle type…)"
                style={{ ...inputStyle, marginBottom: 0, paddingLeft: '38px' }}
              />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
            </div>
            {proofResults.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden', marginTop: '4px' }}>
                {proofResults.map((p) => {
                  const alreadyAssigned = assignments.some((a) => a.proof_id === p.id);
                  return (
                    <div key={p.id} style={{
                      padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      borderBottom: '1px solid var(--border)', opacity: alreadyAssigned ? 0.5 : 1,
                    }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>{p.customer_name}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{p.vehicle_type || p.file_name}</div>
                      </div>
                      {alreadyAssigned ? (
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Assigned</span>
                      ) : (
                        <button onClick={() => assignProof(p.id)} style={{
                          padding: '6px 14px', borderRadius: '8px', background: 'var(--orange)',
                          color: '#fff', fontSize: '13px', fontWeight: 700, border: 'none', cursor: 'pointer',
                        }}>
                          Assign
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Assigned proofs list */}
          {assignments.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '28px', marginBottom: '8px' }}>📋</div>
              <div style={{ fontWeight: 600 }}>No proofs assigned yet</div>
              <div style={{ fontSize: '13px', marginTop: '4px' }}>Search above to assign proofs to this customer</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {assignments.map((a) => {
                const proof = a.proof as any;
                const proofParts = parts.filter((p) => p.proof_id === a.proof_id);
                const isExpanded = expandedProof === a.proof_id;
                return (
                  <div key={a.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
                    {/* Proof header */}
                    <div
                      style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                      onClick={() => setExpandedProof(isExpanded ? null : a.proof_id)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {proof?.thumbnail_path && (
                          <img src={proof.thumbnail_path} alt="" style={{ width: '44px', height: '36px', objectFit: 'cover', borderRadius: '6px', background: 'var(--bg)' }} />
                        )}
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>{proof?.customer_name || '—'}</div>
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                            {proof?.vehicle_type || proof?.file_name || '—'} · {proofParts.length} part{proofParts.length !== 1 ? 's' : ''}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); unassignProof(a.id); }}
                          style={{ background: 'none', border: 'none', color: 'var(--error, #ef4444)', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
                        >
                          Remove
                        </button>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                      </div>
                    </div>

                    {/* Parts section */}
                    {isExpanded && (
                      <div style={{ borderTop: '1px solid var(--border)', padding: '14px 16px' }}>
                        <div style={{ fontWeight: 700, fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '10px' }}>
                          Orderable Parts / SKUs
                        </div>

                        {proofParts.length === 0 && addingPart !== a.proof_id && (
                          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '10px' }}>No parts defined yet</div>
                        )}

                        {proofParts.map((part) => (
                          <div key={part.id} style={{ background: 'var(--bg)', borderRadius: '8px', padding: '10px 12px', marginBottom: '8px' }}>
                            {editingPart === part.id ? (
                              <div>
                                <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                                  <input value={editPartData.part_name} onChange={(e) => setEditPartData({ ...editPartData, part_name: e.target.value })} placeholder="Part name" style={{ ...inputStyle, marginBottom: 0, flex: 2 }} />
                                  <input value={editPartData.part_number} onChange={(e) => setEditPartData({ ...editPartData, part_number: e.target.value })} placeholder="Part #" style={{ ...inputStyle, marginBottom: 0, flex: 1 }} />
                                </div>
                                <input value={editPartData.description} onChange={(e) => setEditPartData({ ...editPartData, description: e.target.value })} placeholder="Description" style={{ ...inputStyle, marginBottom: '6px' }} />
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                  <div style={{ position: 'relative', flex: 1 }}>
                                    <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}>$</span>
                                    <input value={editPartData.unit_price} onChange={(e) => setEditPartData({ ...editPartData, unit_price: e.target.value })} placeholder="0.00" type="number" step="0.01" min="0" style={{ ...inputStyle, marginBottom: 0, paddingLeft: '24px' }} />
                                  </div>
                                  <button onClick={() => updatePart(part.id)} style={{ padding: '10px 16px', borderRadius: '8px', background: 'var(--orange)', color: '#fff', fontWeight: 700, fontSize: '13px', border: 'none', cursor: 'pointer' }}>Save</button>
                                  <button onClick={() => setEditingPart(null)} style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'none', color: 'var(--text-muted)', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <div>
                                  <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
                                    {part.part_name}
                                    {part.part_number && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: '6px' }}>#{part.part_number}</span>}
                                  </div>
                                  {part.description && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{part.description}</div>}
                                  <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--orange)', marginTop: '2px' }}>
                                    ${Number(part.unit_price).toFixed(2)}
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: '6px' }}>
                                  <button onClick={() => { setEditingPart(part.id); setEditPartData({ part_name: part.part_name, part_number: part.part_number || '', description: part.description || '', unit_price: String(part.unit_price) }); }} style={{ padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--border)', background: 'none', color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer' }}>Edit</button>
                                  <button onClick={() => deletePart(part.id)} style={{ padding: '6px 12px', borderRadius: '7px', border: 'none', background: 'none', color: 'var(--error, #ef4444)', fontSize: '12px', cursor: 'pointer' }}>Delete</button>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}

                        {addingPart === a.proof_id ? (
                          <div style={{ background: 'var(--bg)', borderRadius: '8px', padding: '12px', marginTop: '4px' }}>
                            <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                              <input value={newPart.part_name} onChange={(e) => setNewPart({ ...newPart, part_name: e.target.value })} placeholder="Part name *" style={{ ...inputStyle, marginBottom: 0, flex: 2 }} />
                              <input value={newPart.part_number} onChange={(e) => setNewPart({ ...newPart, part_number: e.target.value })} placeholder="Part #" style={{ ...inputStyle, marginBottom: 0, flex: 1 }} />
                            </div>
                            <input value={newPart.description} onChange={(e) => setNewPart({ ...newPart, description: e.target.value })} placeholder="Description" style={{ ...inputStyle, marginBottom: '6px' }} />
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                              <div style={{ position: 'relative', flex: 1 }}>
                                <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}>$</span>
                                <input value={newPart.unit_price} onChange={(e) => setNewPart({ ...newPart, unit_price: e.target.value })} placeholder="0.00" type="number" step="0.01" min="0" style={{ ...inputStyle, marginBottom: 0, paddingLeft: '24px' }} />
                              </div>
                              <button onClick={() => savePart(a.proof_id)} disabled={!newPart.part_name.trim()} style={{ padding: '10px 16px', borderRadius: '8px', background: 'var(--orange)', color: '#fff', fontWeight: 700, fontSize: '13px', border: 'none', cursor: 'pointer', opacity: !newPart.part_name.trim() ? 0.5 : 1 }}>Add</button>
                              <button onClick={() => { setAddingPart(null); setNewPart({ part_name: '', part_number: '', description: '', unit_price: '' }); }} style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'none', color: 'var(--text-muted)', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <button onClick={() => { setAddingPart(a.proof_id); setExpandedProof(a.proof_id); }} style={{ marginTop: '4px', padding: '8px 14px', borderRadius: '8px', border: '1px dashed var(--border)', background: 'none', color: 'var(--text-muted)', fontSize: '13px', cursor: 'pointer', width: '100%' }}>
                            + Add Part / SKU
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─── USERS TAB ─── */}
      {tab === 'users' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Portal users can log in at /portal/{customer.slug}</div>
            <button onClick={() => { setShowUserForm(true); setUserError(''); setCreatedInvite(null); }} style={{ padding: '9px 16px', borderRadius: '9px', background: 'var(--orange)', color: '#fff', fontSize: '13px', fontWeight: 700, border: 'none', cursor: 'pointer' }}>
              + Add User
            </button>
          </div>

          {/* Create user form */}
          {showUserForm && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '18px', marginBottom: '16px' }}>
              <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', marginBottom: '14px' }}>Create Portal User</div>
              {createdInvite ? (
                <div>
                  <div style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
                    <div style={{ fontWeight: 700, color: '#34d399', marginBottom: '6px' }}>User created!</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Invite link:</div>
                    <div style={{ background: 'var(--bg)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', wordBreak: 'break-all', color: 'var(--text-secondary)' }}>{createdInvite}</div>
                    <button onClick={() => navigator.clipboard.writeText(createdInvite)} style={{ marginTop: '8px', padding: '7px 14px', borderRadius: '7px', border: '1px solid var(--border)', background: 'none', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer' }}>
                      Copy Link
                    </button>
                  </div>
                  <button onClick={() => { setShowUserForm(false); setCreatedInvite(null); }} style={{ padding: '10px 20px', borderRadius: '9px', border: '1px solid var(--border)', background: 'none', color: 'var(--text-muted)', fontSize: '13px', cursor: 'pointer' }}>Done</button>
                </div>
              ) : (
                <form onSubmit={createUser}>
                  <label style={labelStyle}>Full Name</label>
                  <input value={newUser.full_name} onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })} placeholder="Jane Smith" style={inputStyle} required />
                  <label style={labelStyle}>Email</label>
                  <input type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} placeholder="jane@company.com" style={inputStyle} required />
                  <label style={labelStyle}>Password</label>
                  <input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} placeholder="Temporary password" style={inputStyle} required />
                  <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'center' }}>
                    <label style={{ ...labelStyle, marginBottom: 0 }}>Portal Role:</label>
                    {(['user', 'admin'] as const).map((r) => (
                      <button key={r} type="button" onClick={() => setNewUser({ ...newUser, portal_role: r })} style={{
                        padding: '6px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
                        background: newUser.portal_role === r ? 'var(--orange)' : 'transparent',
                        color: newUser.portal_role === r ? '#fff' : 'var(--text-muted)',
                        border: newUser.portal_role === r ? 'none' : '1px solid var(--border)',
                        cursor: 'pointer',
                      }}>
                        {r === 'user' ? 'User' : 'Admin'}
                      </button>
                    ))}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={newUser.send_invite} onChange={(e) => setNewUser({ ...newUser, send_invite: e.target.checked })} />
                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Send invite email with portal link</span>
                  </label>
                  {userError && (
                    <div style={{ padding: '10px 14px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', borderRadius: '8px', color: 'var(--error)', fontSize: '13px', marginBottom: '12px' }}>
                      {userError}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button type="submit" disabled={userSaving || !newUser.full_name || !newUser.email || !newUser.password} style={{ flex: 1, padding: '11px', borderRadius: '9px', background: 'var(--orange)', color: '#fff', fontWeight: 700, fontSize: '14px', border: 'none', cursor: 'pointer', opacity: userSaving || !newUser.full_name || !newUser.email || !newUser.password ? 0.5 : 1 }}>
                      {userSaving ? 'Creating...' : 'Create & Invite'}
                    </button>
                    <button type="button" onClick={() => { setShowUserForm(false); setUserError(''); }} style={{ padding: '11px 18px', borderRadius: '9px', border: '1px solid var(--border)', background: 'none', color: 'var(--text-muted)', fontSize: '14px', cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* Users list */}
          {users.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '28px', marginBottom: '8px' }}>👤</div>
              <div style={{ fontWeight: 600 }}>No portal users yet</div>
              <div style={{ fontSize: '13px', marginTop: '4px' }}>Add users so they can log in to the portal</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {users.map((u) => {
                const profile = u.profile as any;
                return (
                  <div key={u.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '13px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>{profile?.full_name || '—'}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{profile?.email || '—'}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', background: u.role === 'admin' ? 'rgba(238,49,32,0.1)' : 'rgba(99,102,241,0.1)', color: u.role === 'admin' ? 'var(--orange)' : '#818cf8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        {u.role}
                      </span>
                      <button onClick={() => removeUser(u.id)} style={{ background: 'none', border: 'none', color: 'var(--error, #ef4444)', fontSize: '13px', cursor: 'pointer', fontWeight: 600 }}>Remove</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─── SETTINGS TAB ─── */}
      {tab === 'settings' && (
        <form onSubmit={saveSettings}>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '20px' }}>
            <label style={labelStyle}>Company Name</label>
            <input value={editSettings.company_name} onChange={(e) => setEditSettings({ ...editSettings, company_name: e.target.value })} style={inputStyle} required />

            <label style={labelStyle}>URL Slug</label>
            <input value={editSettings.slug} onChange={(e) => setEditSettings({ ...editSettings, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} style={inputStyle} required />
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '-6px', marginBottom: '14px' }}>
              Portal URL: <span style={{ color: 'var(--text-secondary)' }}>{appUrl}/portal/{editSettings.slug}</span>
            </div>

            <label style={labelStyle}>Brand Color</label>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '14px' }}>
              <input type="color" value={editSettings.primary_color} onChange={(e) => setEditSettings({ ...editSettings, primary_color: e.target.value })} style={{ width: '48px', height: '40px', border: 'none', borderRadius: '8px', cursor: 'pointer', padding: 0 }} />
              <input value={editSettings.primary_color} onChange={(e) => setEditSettings({ ...editSettings, primary_color: e.target.value })} placeholder="#EE3120" style={{ ...inputStyle, marginBottom: 0, width: '140px' }} />
            </div>

            <label style={labelStyle}>Logo</label>
            {customer.logo_url && (
              <div style={{ marginBottom: '10px' }}>
                <img src={customer.logo_url} alt="Current logo" style={{ height: '48px', objectFit: 'contain', borderRadius: '8px', background: 'var(--bg)', padding: '4px' }} />
              </div>
            )}
            <input ref={logoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => setLogoFile(e.target.files?.[0] || null)} />
            <button type="button" onClick={() => logoInputRef.current?.click()} style={{ padding: '9px 16px', borderRadius: '9px', border: '1px solid var(--border)', background: 'none', color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer', marginBottom: '16px' }}>
              {logoFile ? logoFile.name : 'Upload Logo'}
            </button>

            {settingsError && (
              <div style={{ padding: '10px 14px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', borderRadius: '8px', color: 'var(--error)', fontSize: '13px', marginBottom: '12px' }}>
                {settingsError}
              </div>
            )}

            <button type="submit" disabled={settingsSaving} style={{ padding: '12px 24px', borderRadius: '10px', background: 'var(--orange)', color: '#fff', fontWeight: 700, fontSize: '15px', border: 'none', cursor: 'pointer', opacity: settingsSaving ? 0.6 : 1 }}>
              {settingsSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
