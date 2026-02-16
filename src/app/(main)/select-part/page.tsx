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
  const [filter, setFilter] = useState('');
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

  const customers = Array.from(new Set(catalog.map((c) => c.customer)));
  const filtered = catalog.filter((c) => {
    if (filter && c.customer !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return `${c.part_number} ${c.end_customer} ${c.vehicle_type} ${c.graphic_package}`.toLowerCase().includes(q);
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
          border: '1px solid #1e2d3d', background: 'var(--card)', color: 'var(--text-primary)',
          fontSize: '13px', marginBottom: '8px',
        }}
      />
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <Chip label="All" active={!filter} onClick={() => setFilter('')} />
        {customers.map((c) => (
          <Chip key={c} label={c} active={filter === c} onClick={() => setFilter(c)} />
        ))}
      </div>

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
                background: isActive ? 'rgba(238,49,32,0.04)' : 'var(--card)',
                border: isActive ? '1px solid rgba(238,49,32,0.2)' : '1px solid #1e2d3d',
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
          border: '1px solid #1e2d3d', background: 'transparent', color: 'var(--text-secondary)',
          fontSize: '13px', fontWeight: 700,
        }}
      >
        ← Back
      </button>
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
        background: active ? 'var(--tab-active-bg)' : 'transparent',
        border: active ? '1px solid rgba(238,49,32,0.2)' : '1px solid #1e2d3d',
        color: active ? 'var(--navy)' : 'var(--text-muted)',
      }}
    >
      {label}
    </button>
  );
}
