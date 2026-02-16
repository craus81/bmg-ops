'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useApp } from '@/components/AppProvider';
import type { CatalogItem } from '@/lib/types';

export default function SelectPartPage() {
  const router = useRouter();
  const { activePart, setActivePart } = useApp();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('catalog')
        .select('*')
        .eq('active', true)
        .order('part_number');
      setCatalog(data || []);
      setLoading(false);
    };
    load();
  }, []);

  const filtered = catalog.filter((c) => {
    if (search) {
      const q = search.toLowerCase();
      return `${c.part_number} ${c.end_customer} ${c.vehicle_type} ${c.graphic_package} ${c.customer}`.toLowerCase().includes(q);
    }
    return true;
  });

  const handleSelect = (item: CatalogItem) => {
    setActivePart(item);
    router.push('/home');
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading catalog...</div>;

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
        Select Active Part Number
      </div>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search..."
        autoFocus
        style={{
          width: '100%', padding: '10px 12px', borderRadius: '10px',
          border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)',
          fontSize: '13px', marginBottom: '12px',
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {filtered.map((c) => {
          const isActive = activePart?.id === c.id;
          return (
            <button
              key={c.id}
              onClick={() => handleSelect(c)}
              style={{
                width: '100%', textAlign: 'left', padding: '12px', borderRadius: '14px',
                cursor: 'pointer',
                background: isActive ? 'var(--orange-soft)' : 'var(--card)',
                border: isActive ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
                color: 'var(--text-primary)',
              }}
            >
              <div style={{ fontWeight: 800, fontSize: '15px' }}>{c.part_number}</div>
              <div style={{ fontSize: '12px', color: 'var(--navy-light)', marginTop: '1px' }}>
                {c.end_customer} — {c.graphic_package}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {c.vehicle_type} • {c.customer}
              </div>
            </button>
          );
        })}
      </div>

      <button
        onClick={() => router.back()}
        style={{
          width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px',
          border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
          fontSize: '13px', fontWeight: 700,
        }}
      >
        ← Back
      </button>
    </div>
  );
}
