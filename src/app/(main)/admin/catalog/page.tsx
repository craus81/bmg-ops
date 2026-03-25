'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { storage } from '@/lib/storage';
import type { CatalogItem, CatalogProof } from '@/lib/types';

export default function CatalogPage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [proofMap, setProofMap] = useState<Record<string, CatalogProof[]>>({});
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [proofPanel, setProofPanel] = useState<string | null>(null); // catalog_id showing proof manager
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({
    part_number: '', customer: 'Masterack', end_customer: '',
    vehicle_type: '', graphic_package: '', price: '', proof_pages: '1',
  });

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    const load = async () => {
      const [catalogRes, proofsRes] = await Promise.all([
        supabase.from('catalog').select('*').order('part_number'),
        supabase.from('catalog_proofs').select('*').order('sort_order'),
      ]);
      setCatalog((catalogRes.data as CatalogItem[]) || []);

      const map: Record<string, CatalogProof[]> = {};
      (proofsRes.data || []).forEach((p: CatalogProof) => {
        if (!map[p.catalog_id]) map[p.catalog_id] = [];
        map[p.catalog_id].push(p);
      });
      setProofMap(map);
      setLoading(false);
    };
    load();
  }, [isAdmin]);

  const handleUploadProofs = async (catalogId: string, partNumber: string, files: FileList) => {
    setUploading(true);
    const newProofs: CatalogProof[] = [];
    const existingCount = (proofMap[catalogId] || []).length;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `${partNumber}/${Date.now()}_${safeName}`;

      const { error: uploadError } = await storage
        .from('proofs')
        .upload(storagePath, file, { contentType: file.type });

      if (uploadError) {
        console.error('Upload failed:', uploadError.message);
        continue;
      }

      const { data: dbData, error: dbError } = await supabase
        .from('catalog_proofs')
        .insert({
          catalog_id: catalogId,
          part_number: partNumber,
          file_name: file.name,
          file_path: storagePath,
          file_type: file.type,
          file_size: file.size,
          sort_order: existingCount + i,
          uploaded_by: user?.id || null,
        })
        .select()
        .single();

      if (dbData && !dbError) {
        newProofs.push(dbData as CatalogProof);
      }
    }

    setProofMap((prev) => ({
      ...prev,
      [catalogId]: [...(prev[catalogId] || []), ...newProofs],
    }));
    setUploading(false);
  };

  const handleDeleteProof = async (catalogId: string, proof: CatalogProof) => {
    // Delete from storage
    await storage.from('proofs').remove([proof.file_path]);
    // Delete from DB
    await supabase.from('catalog_proofs').delete().eq('id', proof.id);
    // Update local state
    setProofMap((prev) => ({
      ...prev,
      [catalogId]: (prev[catalogId] || []).filter((p) => p.id !== proof.id),
    }));
  };

  const getProofUrl = (proof: CatalogProof) => {
    const { data } = storage.from('proofs').getPublicUrl(proof.file_path);
    return data.publicUrl;
  };

  const handleAdd = async () => {
    if (!form.part_number || !form.customer) return;
    const { data, error } = await supabase
      .from('catalog')
      .insert({
        part_number: form.part_number, customer: form.customer,
        end_customer: form.end_customer, vehicle_type: form.vehicle_type,
        graphic_package: form.graphic_package, price: Number(form.price) || 0,
        proof_pages: Number(form.proof_pages) || 1,
      })
      .select()
      .single();

    if (data && !error) {
      setCatalog((prev) => [...prev, data as CatalogItem].sort((a, b) => a.part_number.localeCompare(b.part_number)));
      resetForm();
      setShowAdd(false);
    }
  };

  const handleDelete = async (id: string) => {
    // Delete all proofs for this catalog item first
    const proofs = proofMap[id] || [];
    if (proofs.length > 0) {
      await storage.from('proofs').remove(proofs.map((p) => p.file_path));
      await supabase.from('catalog_proofs').delete().eq('catalog_id', id);
    }
    const { error } = await supabase.from('catalog').delete().eq('id', id);
    if (!error) {
      setCatalog((prev) => prev.filter((c) => c.id !== id));
      const newMap = { ...proofMap };
      delete newMap[id];
      setProofMap(newMap);
    }
  };

  const startEdit = (c: CatalogItem) => {
    setEditId(c.id);
    setProofPanel(null);
    setForm({
      part_number: c.part_number, customer: c.customer, end_customer: c.end_customer,
      vehicle_type: c.vehicle_type, graphic_package: c.graphic_package,
      price: c.price.toString(), proof_pages: c.proof_pages.toString(),
    });
  };

  const saveEdit = async () => {
    if (!editId) return;
    const { error } = await supabase.from('catalog').update({
      part_number: form.part_number, customer: form.customer,
      end_customer: form.end_customer, vehicle_type: form.vehicle_type,
      graphic_package: form.graphic_package, price: Number(form.price) || 0,
      proof_pages: Number(form.proof_pages) || 1,
    }).eq('id', editId);

    if (!error) {
      setCatalog((prev) =>
        prev.map((c) =>
          c.id === editId
            ? { ...c, part_number: form.part_number, customer: form.customer, end_customer: form.end_customer, vehicle_type: form.vehicle_type, graphic_package: form.graphic_package, price: Number(form.price) || 0, proof_pages: Number(form.proof_pages) || 1 }
            : c
        ).sort((a, b) => a.part_number.localeCompare(b.part_number))
      );
      setEditId(null);
      resetForm();
    }
  };

  const resetForm = () => {
    setForm({ part_number: '', customer: 'Masterack', end_customer: '', vehicle_type: '', graphic_package: '', price: '', proof_pages: '1' });
  };

  const cancelEdit = () => { setEditId(null); resetForm(); };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Part Catalog ({catalog.length})
        </div>
        <button onClick={() => { setShowAdd(!showAdd); setEditId(null); resetForm(); }} style={{ padding: '6px 12px', borderRadius: '10px', background: 'var(--navy)', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}>
          {showAdd ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showAdd && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '12px' }}>
          <Input label="Part Number" value={form.part_number} onChange={(v) => setForm({ ...form, part_number: v })} />
          <div style={{ marginTop: '8px' }}>
            <label style={labelStyle}>Customer</label>
            <select value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} style={inputStyle}>
              <option>Masterack</option><option>Knapheide</option><option>Bodewell</option><option>Designs That Stick</option><option>Other</option>
            </select>
          </div>
          <Input label="End Customer" value={form.end_customer} onChange={(v) => setForm({ ...form, end_customer: v })} />
          <Input label="Vehicle Type" value={form.vehicle_type} onChange={(v) => setForm({ ...form, vehicle_type: v })} />
          <Input label="Graphic Package" value={form.graphic_package} onChange={(v) => setForm({ ...form, graphic_package: v })} />
          <Input label="Price" value={form.price} onChange={(v) => setForm({ ...form, price: v })} type="number" />
          <Input label="Proof Pages" value={form.proof_pages} onChange={(v) => setForm({ ...form, proof_pages: v })} type="number" />
          <button onClick={handleAdd} style={{ width: '100%', marginTop: '12px', padding: '12px', borderRadius: '14px', background: 'var(--success)', color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none' }}>
            Save Part Number
          </button>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/*,application/pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files && proofPanel) {
            const cat = catalog.find((c) => c.id === proofPanel);
            if (cat) handleUploadProofs(proofPanel, cat.part_number, e.target.files);
          }
          e.target.value = '';
        }}
      />

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search parts..."
        style={{
          width: '100%', padding: '10px 12px', borderRadius: '10px',
          border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)',
          fontSize: '13px', marginBottom: '10px',
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {catalog.filter((c) => {
          if (!search) return true;
          const q = search.toLowerCase();
          return `${c.part_number} ${c.end_customer} ${c.vehicle_type} ${c.graphic_package} ${c.customer}`.toLowerCase().includes(q);
        }).map((c) => {
          const isEditing = editId === c.id;
          const showingProofs = proofPanel === c.id;
          const proofs = proofMap[c.id] || [];

          return (
            <div key={c.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '12px' }}>
                {isEditing ? (
                  <div>
                    <Input label="Part Number" value={form.part_number} onChange={(v) => setForm({ ...form, part_number: v })} />
                    <div style={{ marginTop: '8px' }}>
                      <label style={labelStyle}>Customer</label>
                      <select value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} style={inputStyle}>
                        <option>Masterack</option><option>Knapheide</option><option>Bodewell</option><option>Designs That Stick</option><option>Other</option>
                      </select>
                    </div>
                    <Input label="End Customer" value={form.end_customer} onChange={(v) => setForm({ ...form, end_customer: v })} />
                    <Input label="Vehicle Type" value={form.vehicle_type} onChange={(v) => setForm({ ...form, vehicle_type: v })} />
                    <Input label="Graphic Package" value={form.graphic_package} onChange={(v) => setForm({ ...form, graphic_package: v })} />
                    <Input label="Price" value={form.price} onChange={(v) => setForm({ ...form, price: v })} type="number" />
                    <Input label="Proof Pages" value={form.proof_pages} onChange={(v) => setForm({ ...form, proof_pages: v })} type="number" />
                    <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                      <button onClick={saveEdit} style={{ flex: 1, padding: '10px', borderRadius: '10px', background: 'var(--success)', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}>Save</button>
                      <button onClick={cancelEdit} style={{ flex: 1, padding: '10px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700 }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div onClick={() => startEdit(c)} style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: '15px' }}>{c.part_number}</div>
                        <div style={{ fontSize: '12px', color: 'var(--navy-light)', marginTop: '1px' }}>{c.end_customer} — {c.graphic_package}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {c.vehicle_type} • {c.customer}
                          <span style={{ marginLeft: '8px', color: 'var(--navy)', fontSize: '10px' }}>tap to edit</span>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 800, fontSize: '15px', color: 'var(--success)' }}>${c.price.toFixed(2)}</div>
                      </div>
                    </div>

                    {/* Proofs toggle button */}
                    <div style={{ marginTop: '8px', display: 'flex', gap: '6px' }}>
                      <button
                        onClick={() => setProofPanel(showingProofs ? null : c.id)}
                        style={{
                          padding: '5px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                          background: proofs.length > 0 ? 'var(--tab-active-bg)' : 'var(--subtle-bg)',
                          border: `1px solid ${proofs.length > 0 ? 'var(--tab-active-border)' : 'var(--border)'}`,
                          color: proofs.length > 0 ? 'var(--tab-active-color)' : 'var(--text-muted)',
                        }}
                      >
                        📄 {proofs.length} proof{proofs.length !== 1 ? 's' : ''} {showingProofs ? '▴' : '▾'}
                      </button>
                    </div>

                    {/* Proof management panel */}
                    {showingProofs && (
                      <div style={{ marginTop: '10px', padding: '10px', background: 'var(--bg)', borderRadius: '10px', border: '1px solid var(--border)' }}>
                        {proofs.length === 0 && (
                          <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--text-muted)', fontSize: '12px' }}>
                            No proofs uploaded yet
                          </div>
                        )}

                        {/* Proof thumbnails grid */}
                        {proofs.length > 0 && (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginBottom: '10px' }}>
                            {proofs.map((p) => {
                              const url = getProofUrl(p);
                              const isImage = p.file_type.startsWith('image/');
                              return (
                                <div key={p.id} style={{ position: 'relative', borderRadius: '8px', overflow: 'hidden', background: 'var(--card)', border: '1px solid var(--border)', aspectRatio: '1' }}>
                                  {isImage ? (
                                    <img src={url} alt={p.file_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                  ) : (
                                    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4px' }}>
                                      <div style={{ fontSize: '24px' }}>📄</div>
                                      <div style={{ fontSize: '8px', color: 'var(--text-muted)', marginTop: '2px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>{p.file_name}</div>
                                    </div>
                                  )}
                                  {p.label && (
                                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'var(--overlay)', padding: '2px 4px', fontSize: '8px', fontWeight: 700, color: '#fff', textAlign: 'center' }}>
                                      {p.label}
                                    </div>
                                  )}
                                  <button
                                    onClick={() => handleDeleteProof(c.id, p)}
                                    style={{
                                      position: 'absolute', top: '2px', right: '2px',
                                      width: '18px', height: '18px', borderRadius: '50%',
                                      background: 'rgba(220,38,38,0.9)', color: '#fff',
                                      fontSize: '10px', fontWeight: 700, display: 'flex',
                                      alignItems: 'center', justifyContent: 'center',
                                      border: '1px solid rgba(255,255,255,0.3)',
                                    }}
                                  >✕</button>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Upload button */}
                        <button
                          onClick={() => { setProofPanel(c.id); fileRef.current?.click(); }}
                          disabled={uploading}
                          style={{
                            width: '100%', padding: '10px', borderRadius: '10px',
                            border: '1px dashed var(--border-strong)',
                            background: 'transparent', color: 'var(--text-secondary)',
                            fontSize: '12px', fontWeight: 700,
                            opacity: uploading ? 0.5 : 1,
                          }}
                        >
                          {uploading ? 'Uploading...' : '+ Upload Proofs (images or PDFs)'}
                        </button>
                      </div>
                    )}
                    {/* Delete Part button inside expanded proofs panel */}
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete part ${c.part_number}? This cannot be undone.`)) handleDelete(c.id);
                      }}
                      style={{
                        width: '100%', marginTop: '8px', padding: '8px', borderRadius: '10px',
                        background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
                        color: '#f87171', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                      }}
                    >
                      Delete Part
                    </button>
                  </div>
                )}
              </div>
          );
        })}
      </div>

      <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>
        ← Back
      </button>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px' };

function Input({ label, value, onChange, type }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div style={{ marginTop: '8px' }}>
      <label style={labelStyle}>{label}</label>
      <input type={type || 'text'} value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    </div>
  );
}
