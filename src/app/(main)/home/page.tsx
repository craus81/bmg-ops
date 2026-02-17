'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/components/AppProvider';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import type { CatalogProof } from '@/lib/types';

export default function HomePage() {
  const router = useRouter();
  const { clockStatus, activePart } = useApp();
  const { isAdmin } = useAuth();
  const supabase = createClient();

  const [proofs, setProofs] = useState<CatalogProof[]>([]);
  const [viewingProof, setViewingProof] = useState(false);
  const [viewIdx, setViewIdx] = useState(0);

  useEffect(() => {
    if (!activePart) { setProofs([]); return; }
    const load = async () => {
      const { data } = await supabase
        .from('catalog_proofs')
        .select('*')
        .eq('catalog_id', activePart.id)
        .order('sort_order');
      setProofs(data || []);
    };
    load();
  }, [activePart?.id]);

  const getProofUrl = (proof: CatalogProof) => {
    const { data } = supabase.storage.from('proofs').getPublicUrl(proof.file_path);
    return data.publicUrl;
  };

  const handlePrint = () => {
    const proof = proofs[viewIdx];
    if (!proof) return;
    const url = getProofUrl(proof);
    // Open in new tab — works for both PDFs and images
    window.open(url, '_blank');
  };

  // Full-screen proof viewer
  if (viewingProof && proofs.length > 0) {
    const proof = proofs[viewIdx];
    const url = getProofUrl(proof);
    const isImage = proof.file_type.startsWith('image/');
    const total = proofs.length;

    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#000', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{
          padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'var(--header-bg)', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: '14px', color: '#fff' }}>{activePart?.part_number}</div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '1px' }}>
              {activePart?.end_customer} — {activePart?.graphic_package}
              {proof.label && ` • ${proof.label}`}
            </div>
            {total > 1 && <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginTop: '1px' }}>{viewIdx + 1} of {total}</div>}
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={handlePrint} style={{
              padding: '8px 14px', borderRadius: '10px', background: 'var(--orange)',
              color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none',
              boxShadow: '0 2px 8px rgba(238,49,32,0.3)',
            }}>🖨 Print</button>
            <button onClick={() => setViewingProof(false)} style={{
              padding: '8px 14px', borderRadius: '10px', background: 'rgba(255,255,255,0.1)',
              color: '#fff', fontSize: '12px', fontWeight: 700, border: '1px solid rgba(255,255,255,0.15)',
            }}>✕ Close</button>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {isImage ? (
            <div style={{ width: '100%', height: '100%', overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px' }}>
              <img src={url} alt={proof.file_name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '4px' }} />
            </div>
          ) : (
            <iframe
              src={url}
              style={{ width: '100%', height: '100%', border: 'none' }}
              title={proof.file_name}
            />
          )}
        </div>

        {/* Navigation */}
        {total > 1 && (
          <div style={{
            padding: '12px 16px', display: 'flex', gap: '8px', justifyContent: 'center',
            background: 'var(--header-bg)', borderTop: '1px solid var(--border)', flexShrink: 0,
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
      {clockStatus === 'out' && (
        <button onClick={() => router.push('/time')} style={{
          width: '100%', padding: '12px 16px', borderRadius: '14px', marginBottom: '14px',
          background: theme.warningBg, border: `1px solid ${theme.warningBorder}`,
          color: theme.warning, fontSize: '13px', fontWeight: 600, textAlign: 'left',
          display: 'flex', alignItems: 'center', gap: '8px',
        }}>
          ⏰ Not clocked in — tap to start your day
        </button>
      )}

      {activePart && (
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`,
          borderLeft: `3px solid ${theme.orange}`,
          borderRadius: '4px 14px 14px 4px', marginBottom: '14px',
          boxShadow: theme.shadowSm, overflow: 'hidden',
        }}>
          <div style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
              <div>
                <div style={{ fontSize: '10px', color: theme.orange, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Active Part Number</div>
                <div style={{ fontWeight: 800, fontSize: '20px', color: theme.textPrimary, marginTop: '2px', letterSpacing: '-0.5px' }}>{activePart.part_number}</div>
                <div style={{ fontSize: '12px', color: theme.textSecondary, marginTop: '3px' }}>{activePart.end_customer} • {activePart.graphic_package}</div>
                <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>{activePart.vehicle_type} • {activePart.customer}</div>
              </div>
              <button onClick={() => router.push('/select-part')} style={{
                background: 'transparent', border: `1px solid ${theme.borderStrong}`,
                borderRadius: '8px', color: theme.textSecondary, padding: '5px 10px',
                fontSize: '11px', fontWeight: 700,
              }}>Change</button>
            </div>
          </div>

          {/* Proof preview */}
          {proofs.length > 0 && (() => {
            const proof = proofs[0];
            const url = getProofUrl(proof);
            const isImage = proof.file_type.startsWith('image/');

            return (
              <button
                onClick={() => { setViewIdx(0); setViewingProof(true); }}
                style={{
                  width: '100%', display: 'block', cursor: 'pointer',
                  borderTop: `1px solid ${theme.border}`,
                  background: 'transparent', padding: 0,
                }}
              >
                <div style={{ position: 'relative' }}>
                  {isImage ? (
                    <img src={url} alt="Proof" style={{ width: '100%', maxHeight: '200px', objectFit: 'contain', background: 'var(--subtle-bg)', display: 'block' }} />
                  ) : (
                    /* PDF thumbnail — use embedded iframe at small scale */
                    <div style={{ width: '100%', height: '200px', overflow: 'hidden', position: 'relative', background: '#fff' }}>
                      <iframe
                        src={`${url}#toolbar=0&navpanes=0&scrollbar=0`}
                        style={{
                          width: '100%', height: '600px', border: 'none',
                          position: 'absolute', top: 0, left: 0,
                          transform: 'scale(0.34)', transformOrigin: 'top left',
                          pointerEvents: 'none',
                        }}
                        title="Proof preview"
                      />
                    </div>
                  )}
                  <div style={{
                    position: 'absolute', bottom: '8px', right: '8px',
                    display: 'flex', gap: '4px',
                  }}>
                    {proofs.length > 1 && (
                      <span style={{
                        background: 'rgba(0,0,0,0.75)', borderRadius: '6px',
                        padding: '3px 8px', fontSize: '10px', fontWeight: 700, color: '#fff',
                      }}>{proofs.length} proofs</span>
                    )}
                    <span style={{
                      background: 'rgba(238,49,32,0.9)', borderRadius: '6px',
                      padding: '3px 8px', fontSize: '10px', fontWeight: 700, color: '#fff',
                    }}>Tap to view & print</span>
                  </div>
                </div>
              </button>
            );
          })()}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <ActionBtn icon="📷" title="Scan VIN"
          sub={activePart ? `${activePart.part_number} — ${activePart.end_customer}` : 'Select a part number first'}
          onClick={() => router.push('/scan')} primary disabled={!activePart} />
        <ActionBtn icon="🔧" title="Set Active Part Number"
          sub={activePart ? 'Change what you\'re installing' : 'Choose before scanning'}
          onClick={() => router.push('/select-part')} highlight={!activePart} />
      </div>
    </div>
  );
}

function ActionBtn({ icon, title, sub, onClick, primary, highlight, disabled }: {
  icon: string; title: string; sub?: string; onClick: () => void;
  primary?: boolean; highlight?: boolean; disabled?: boolean;
}) {
  return (
    <button onClick={disabled ? undefined : onClick} style={{
      display: 'flex', alignItems: 'center', gap: '14px', width: '100%',
      padding: '16px', borderRadius: '14px', textAlign: 'left',
      border: primary ? '1px solid rgba(238,49,32,0.12)' : highlight ? `1px solid ${theme.warningBorder}` : `1px solid ${theme.border}`,
      background: primary ? 'rgba(238,49,32,0.04)' : highlight ? theme.warningBg : theme.card,
      color: theme.textPrimary, opacity: disabled ? 0.4 : 1,
      boxShadow: theme.shadowSm, transition: 'all 0.15s',
    }}>
      <div style={{
        width: '44px', height: '44px', borderRadius: '12px',
        background: primary ? 'rgba(238,49,32,0.08)' : 'rgba(255,255,255,0.03)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '20px', flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '-0.2px' }}>{title}</div>
        {sub && <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px' }}>{sub}</div>}
      </div>
    </button>
  );
}
