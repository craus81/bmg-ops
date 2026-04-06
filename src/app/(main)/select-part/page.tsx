'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { useApp } from '@/components/AppProvider';
import type { CatalogItem, CatalogProof } from '@/lib/types';

export default function SelectPartPage() {
  const router = useRouter();
  const { activePart, setActivePart } = useApp();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [proofMap, setProofMap] = useState<Record<string, CatalogProof[]>>({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewingProofs, setViewingProofs] = useState<{ part: string; proofs: CatalogProof[] } | null>(null);
  const [viewIdx, setViewIdx] = useState(0);
  const supabase = createClient();

  useEffect(() => {
    const load = async () => {
      const [catalogRes, proofsRes] = await Promise.all([
        supabase.from('catalog').select('*').eq('active', true).order('part_number'),
        supabase.from('catalog_proofs').select('*').order('sort_order'),
      ]);
      setCatalog(catalogRes.data || []);

      // Group proofs by catalog_id
      const map: Record<string, CatalogProof[]> = {};
      (proofsRes.data || []).forEach((p: CatalogProof) => {
        if (!map[p.catalog_id]) map[p.catalog_id] = [];
        map[p.catalog_id].push(p);
      });
      setProofMap(map);
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
    router.push('/scan');
  };

  const getProofUrl = (proof: CatalogProof) => {
    const { data } = storage.from('proofs').getPublicUrl(proof.file_path);
    return data.publicUrl;
  };

  const openProofs = (partNumber: string, proofs: CatalogProof[]) => {
    setViewingProofs({ part: partNumber, proofs });
    setViewIdx(0);
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading catalog...</div>;

  // Proof viewer overlay
  if (viewingProofs) {
    const proof = viewingProofs.proofs[viewIdx];
    const url = getProofUrl(proof);
    const isImage = proof.file_type.startsWith('image/');
    const isPdf = proof.file_type === 'application/pdf';
    const total = viewingProofs.proofs.length;

    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'var(--overlay)', display: 'flex', flexDirection: 'column' }}>
        {/* Header bar */}
        <div style={{
          padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'var(--header-bg)', borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: '14px', color: '#fff' }}>{viewingProofs.part}</div>
            {proof.label && <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '1px' }}>{proof.label}</div>}
            {total > 1 && <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginTop: '1px' }}>{viewIdx + 1} of {total}</div>}
          </div>
          <button onClick={() => setViewingProofs(null)} style={{
            padding: '8px 16px', borderRadius: '10px', background: 'rgba(255,255,255,0.1)',
            color: '#fff', fontSize: '13px', fontWeight: 700, border: '1px solid rgba(255,255,255,0.15)',
          }}>✕ Close</button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          {isImage && (
            <img src={url} alt={proof.file_name} style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: '8px', objectFit: 'contain' }} />
          )}
          {isPdf && (
            <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
              <iframe src={url} style={{ width: '100%', flex: 1, borderRadius: '8px', border: 'none' }} />
              <a href={url} target="_blank" rel="noopener noreferrer" style={{
                padding: '10px 20px', borderRadius: '10px', background: 'var(--navy)',
                color: '#fff', fontSize: '13px', fontWeight: 700, textDecoration: 'none',
              }}>Open PDF in New Tab</a>
            </div>
          )}
          {!isImage && !isPdf && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '14px', marginBottom: '8px', fontWeight: 700, color: 'var(--text-muted)' }}>File</div>
              <div style={{ fontSize: '13px', fontWeight: 600 }}>{proof.file_name}</div>
              <a href={url} target="_blank" rel="noopener noreferrer" style={{
                display: 'inline-block', marginTop: '12px', padding: '10px 20px', borderRadius: '10px',
                background: 'var(--navy)', color: '#fff', fontSize: '13px', fontWeight: 700, textDecoration: 'none',
              }}>Download File</a>
            </div>
          )}
        </div>

        {/* Navigation arrows */}
        {total > 1 && (
          <div style={{
            padding: '12px 20px', display: 'flex', gap: '8px', justifyContent: 'center',
            background: 'var(--header-bg)', borderTop: '1px solid var(--border)',
          }}>
            <button onClick={() => setViewIdx(Math.max(0, viewIdx - 1))} disabled={viewIdx === 0} style={{
              padding: '10px 24px', borderRadius: '10px', background: 'rgba(255,255,255,0.1)',
              color: '#fff', fontWeight: 700, fontSize: '13px', opacity: viewIdx === 0 ? 0.3 : 1,
              border: '1px solid rgba(255,255,255,0.15)',
            }}>← Prev</button>
            <button onClick={() => setViewIdx(Math.min(total - 1, viewIdx + 1))} disabled={viewIdx === total - 1} style={{
              padding: '10px 24px', borderRadius: '10px', background: 'rgba(255,255,255,0.1)',
              color: '#fff', fontWeight: 700, fontSize: '13px', opacity: viewIdx === total - 1 ? 0.3 : 1,
              border: '1px solid rgba(255,255,255,0.15)',
            }}>Next →</button>
          </div>
        )}
      </div>
    );
  }

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
          const proofs = proofMap[c.id] || [];
          const hasProofs = proofs.length > 0;
          const firstImageProof = proofs.find((p) => p.file_type.startsWith('image/'));

          return (
            <div
              key={c.id}
              style={{
                borderRadius: '14px',
                background: isActive ? 'var(--orange-soft)' : 'var(--card)',
                border: isActive ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
                overflow: 'hidden',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'stretch' }}>
                {/* Proof thumbnail */}
                {firstImageProof && (
                  <button
                    onClick={(e) => { e.stopPropagation(); openProofs(c.part_number, proofs); }}
                    style={{
                      width: '64px', minHeight: '64px', flexShrink: 0,
                      background: 'var(--subtle-bg)', borderRight: '1px solid var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: 0, cursor: 'pointer', position: 'relative',
                    }}
                  >
                    <img
                      src={getProofUrl(firstImageProof)}
                      alt="Proof"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    {proofs.length > 1 && (
                      <div style={{
                        position: 'absolute', bottom: '2px', right: '2px',
                        background: 'rgba(0,0,0,0.7)', borderRadius: '4px',
                        padding: '1px 4px', fontSize: '9px', fontWeight: 700, color: '#fff',
                      }}>+{proofs.length - 1}</div>
                    )}
                  </button>
                )}

                {/* Part info — tap to select */}
                <button
                  onClick={() => handleSelect(c)}
                  style={{
                    flex: 1, textAlign: 'left', padding: '12px',
                    cursor: 'pointer', background: 'transparent',
                    color: 'var(--text-primary)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <div style={{ fontWeight: 800, fontSize: '15px' }}>{c.part_number}</div>
                    {hasProofs && !firstImageProof && (
                      <button
                        onClick={(e) => { e.stopPropagation(); openProofs(c.part_number, proofs); }}
                        style={{
                          padding: '2px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                          background: 'var(--tab-active-bg)', color: 'var(--tab-active-color)',
                          border: '1px solid var(--tab-active-border)',
                        }}
                      >{proofs.length} proof{proofs.length > 1 ? 's' : ''}</button>
                    )}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--navy-light)', marginTop: '1px' }}>
                    {c.end_customer} — {c.graphic_package}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {c.vehicle_type} • {c.customer}
                  </div>
                </button>
              </div>
            </div>
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
