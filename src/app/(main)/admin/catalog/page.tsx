'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import SwipeToDelete from '@/components/SwipeToDelete';
import type { CatalogItem } from '@/lib/types';

export default function CatalogPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const supabase = createClient();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({
    part_number: '', customer: 'Masterack', end_customer: '',
    vehicle_type: '', graphic_package: '', price: '', proof_pages: '1',
  });

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    const load = async () => {
      const { data } = await supabase.from('catalog').select('*').order('part_number');
      setCatalog((data as CatalogItem[]) || []);
      setLoading(false);
    };
    load();
  }, [isAdmin]);

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
    const { error } = await supabase.from('catalog').delete().eq('id', id);
    if (!error) {
      setCatalog((prev) => prev.filter((c) => c.id !== id));
    }
  };

  const startEdit = (c: CatalogItem) => {
    setEditId(c.id);
    setForm({
      part_number: c.part_number,
      customer: c.customer,
      end_customer: c.end_customer,
      vehicle_type: c.vehicle_type,
      graphic_package: c.graphic_package,
      price: c.price.toString(),
      proof_pages: c.proof_pages.toString(),
    });
  };

  const saveEdit = async () => {
    if (!editId) return;
    const { error } = await supabase
      .from('catalog')
      .update({
        part_number: form.part_number, customer: form.customer,
        end_customer: form.end_customer, vehicle_type: form.vehicle_type,
        graphic_package: form.graphic_package, price: Number(form.price) || 0,
        proof_pages: Number(form.proof_pages) || 1,
      })
      .eq('id', editId);

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

  const cancelEdit = () => {
    setEditId(null);
    resetForm();
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: '#506070' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#506070', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Part Catalog ({catalog.length})
        </div>
        <button onClick={() => { setShowAdd(!showAdd); setEditId(null); resetForm(); }} style={{ padding: '6px 12px', borderRadius: '10px', background: '#1e4a5e', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}>
          {showAdd ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showAdd && (
        <div style={{ background: '#161f2b', border: '1px solid #1e2d3d', borderRadius: '14px', padding: '14px', marginBottom: '12px' }}>
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
          <button onClick={handleAdd} style={{ width: '100%', marginTop: '12px', padding: '12px', borderRadius: '14px', background: '#059669', color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none' }}>
            Save Part Number
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {catalog.map((c) => {
          const isEditing = editId === c.id;

          return (
            <SwipeToDelete
              key={c.id}
              onDelete={() => handleDelete(c.id)}
              confirmMessage={`Delete part ${c.part_number}? This cannot be undone.`}
            >
              <div style={{ background: '#161f2b', border: '1px solid #1e2d3d', borderRadius: '14px', padding: '12px' }}>
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
                      <button onClick={saveEdit} style={{ flex: 1, padding: '10px', borderRadius: '10px', background: '#059669', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}>
                        Save
                      </button>
                      <button onClick={cancelEdit} style={{ flex: 1, padding: '10px', borderRadius: '10px', background: 'transparent', border: '1px solid #1e2d3d', color: '#8e9baa', fontSize: '12px', fontWeight: 700 }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div onClick={() => startEdit(c)} style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: '15px' }}>{c.part_number}</div>
                      <div style={{ fontSize: '12px', color: '#2a6178', marginTop: '1px' }}>{c.end_customer} — {c.graphic_package}</div>
                      <div style={{ fontSize: '11px', color: '#506070' }}>
                        {c.vehicle_type} • {c.customer}
                        <span style={{ marginLeft: '8px', color: '#1e4a5e', fontSize: '10px' }}>tap to edit</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 800, fontSize: '15px', color: '#34d399' }}>${c.price.toFixed(2)}</div>
                    </div>
                  </div>
                )}
              </div>
            </SwipeToDelete>
          );
        })}
      </div>

      <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px', border: '1px solid #1e2d3d', background: 'transparent', color: '#8e9baa', fontSize: '13px', fontWeight: 700 }}>
        ← Back
      </button>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '10px', fontWeight: 700, color: '#506070', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid #1e2d3d', background: '#0f1720', color: '#e8ecf1', fontSize: '13px' };

function Input({ label, value, onChange, type }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div style={{ marginTop: '8px' }}>
      <label style={labelStyle}>{label}</label>
      <input type={type || 'text'} value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    </div>
  );
}
