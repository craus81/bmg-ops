'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import type { CatalogItem } from '@/lib/types';

export default function CatalogPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const supabase = createClient();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    part_number: '', customer: 'Masterack', end_customer: '',
    vehicle_type: '', graphic_package: '', price: '', proof_pages: '1',
  });

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    const load = async () => {
      const { data } = await supabase.from('catalog').select('*').order('part_number');
      setCatalog(data || []);
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
      setCatalog((prev) => [...prev, data].sort((a, b) => a.part_number.localeCompare(b.part_number)));
      setForm({ part_number: '', customer: 'Masterack', end_customer: '', vehicle_type: '', graphic_package: '', price: '', proof_pages: '1' });
      setShowAdd(false);
    }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Part Catalog ({catalog.length})
        </div>
        <button onClick={() => setShowAdd(!showAdd)} style={{ padding: '6px 12px', borderRadius: '8px', background: '#3b82f6', color: '#fff', fontSize: '12px', fontWeight: 700 }}>
          {showAdd ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showAdd && (
        <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
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
          <button onClick={handleAdd} style={{ width: '100%', marginTop: '12px', padding: '12px', borderRadius: '10px', background: '#22c55e', color: '#fff', fontWeight: 800, fontSize: '14px' }}>
            Save Part Number
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {catalog.map((c) => (
          <div key={c.id} style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: '15px' }}>{c.part_number}</div>
                <div style={{ fontSize: '12px', color: '#93c5fd', marginTop: '1px' }}>{c.end_customer} — {c.graphic_package}</div>
                <div style={{ fontSize: '11px', color: '#4a5f78' }}>{c.vehicle_type} • {c.customer}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 800, fontSize: '15px', color: '#4ade80' }}>${c.price.toFixed(2)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '10px', marginTop: '14px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>
        ← Back
      </button>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '10px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #1e2d3d', background: '#0f1720', color: '#e8ecf1', fontSize: '13px' };

function Input({ label, value, onChange, type }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div style={{ marginTop: '8px' }}>
      <label style={labelStyle}>{label}</label>
      <input type={type || 'text'} value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    </div>
  );
}
