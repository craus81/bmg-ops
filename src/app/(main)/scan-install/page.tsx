'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/components/AppProvider';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import { storage } from '@/lib/storage';
import type { CatalogProof } from '@/lib/types';

export default function ScanInstallPage() {
  const router = useRouter();
  const { clockStatus, activePart } = useApp();
  const { user } = useAuth();
  const supabase = createClient();

  const [proofs, setProofs] = useState<CatalogProof[]>([]);
  const [viewingProof, setViewingProof] = useState(false);
  const [viewIdx, setViewIdx] = useState(0);
  const [assignedVehicles, setAssignedVehicles] = useState<any[]>([]);
  const [assignedLoading, setAssignedLoading] = useState(true);

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

  // Load vehicles assigned to this user
  useEffect(() => {
    if (!user?.id) return;
    const loadAssigned = async () => {
      setAssignedLoading(true);
      const { data: assignments } = await supabase
        .from('job_assignments')
        .select('job_id')
        .eq('job_type', 'scanned_vehicle')
        .eq('user_id', user.id);

      if (assignments && assignments.length > 0) {
        const jobIds = assignments.map((a: any) => a.job_id);
        const { data: vehicles } = await supabase
          .from('fleet_checkins')
          .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, status, updated_at')
          .in('id', jobIds)
          .order('updated_at', { ascending: false });
        setAssignedVehicles(vehicles || []);
      } else {
        setAssignedVehicles([]);
      }
      setAssignedLoading(false);
    };
    loadAssigned();
  }, [user?.id]);

  const getProofUrl = (proof: CatalogProof) => {
    const { data } = storage.from('proofs').getPublicUrl(proof.file_path);
    return data.publicUrl;
  };

  const handlePrint = () => {
    const proof = proofs[viewIdx];
    if (!proof) return;
    const url = getProofUrl(proof);
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

        <div style={{ flex: 1, overflow: 'hidden' }}>
          {isImage ? (
            <div style={{ width: '100%', height: '100%', overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px' }}>
              <img src={url} alt="Proof" style={{ maxWidth: '100%', objectFit: 'contain' }} />
            </div>
          ) : (
            <iframe src={`${url}#toolbar=0`} style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }} title="Proof" />
          )}
        </div>

        {total > 1 && (
          <div style={{
            display: 'flex', justifyContent: 'center', gap: '12px', padding: '12px',
            background: 'var(--header-bg)', borderTop: '1px solid var(--border)',
          }}>
            <button
              disabled={viewIdx <= 0}
              onClick={() => setViewIdx(viewIdx - 1)}
              style={{
                padding: '10px 24px', borderRadius: '10px', fontWeight: 700, fontSize: '13px',
                background: viewIdx <= 0 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.12)',
                color: viewIdx <= 0 ? 'rgba(255,255,255,0.3)' : '#fff', border: 'none',
              }}
            >← Prev</button>
            <button
              disabled={viewIdx >= total - 1}
              onClick={() => setViewIdx(viewIdx + 1)}
              style={{
                padding: '10px 24px', borderRadius: '10px', fontWeight: 700, fontSize: '13px',
                background: viewIdx >= total - 1 ? 'rgba(255,255,255,0.05)' : 'var(--orange)',
                color: viewIdx >= total - 1 ? 'rgba(255,255,255,0.3)' : '#fff', border: 'none',
              }}
            >Next →</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '18px', fontWeight: 800, color: theme.textPrimary }}>Scan & Install</div>
        <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px' }}>
          {activePart ? `Active: ${activePart.part_number}` : 'Select a part number to get started'}
        </div>
      </div>

      {/* Assigned Vehicles */}
      {!assignedLoading && assignedVehicles.length > 0 && (
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`,
          borderRadius: '14px', padding: '14px 16px', marginBottom: '14px',
          boxShadow: theme.shadowSm,
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textMuted, marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            My Assigned Vehicles ({assignedVehicles.length})
          </div>
          {assignedVehicles.slice(0, 5).map((v: any) => (
            <button
              key={v.id}
              onClick={() => router.push(`/fleet/${v.id}`)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '10px 12px', borderRadius: '8px', marginBottom: '4px',
                background: 'var(--input-bg)', border: '1px solid var(--border)', cursor: 'pointer',
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 600, color: theme.textPrimary }}>
                {v.vehicle_year} {v.vehicle_make} {v.vehicle_model}
              </div>
              <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '1px' }}>
                {v.vin} {v.customer_name ? `• ${v.customer_name}` : ''}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Active Part Card */}
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
                fontSize: '11px', fontWeight: 700, cursor: 'pointer',
              }}>Change</button>
            </div>
          </div>

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
                    <div style={{ width: '100%', height: '220px', overflow: 'hidden', position: 'relative', background: '#fff', borderRadius: '0 0 10px 0' }}>
                      <iframe
                        src={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
                        style={{
                          width: '300%', height: '300%', border: 'none',
                          position: 'absolute', top: 0, left: 0,
                          transform: 'scale(0.333)', transformOrigin: 'top left',
                          pointerEvents: 'none',
                        }}
                        title="Proof preview"
                      />
                    </div>
                  )}
                  <div style={{ position: 'absolute', bottom: '8px', right: '8px', display: 'flex', gap: '4px' }}>
                    {proofs.length > 1 && (
                      <span style={{ background: 'rgba(0,0,0,0.75)', borderRadius: '6px', padding: '3px 8px', fontSize: '10px', fontWeight: 700, color: '#fff' }}>{proofs.length} proofs</span>
                    )}
                    <span style={{ background: 'rgba(238,49,32,0.9)', borderRadius: '6px', padding: '3px 8px', fontSize: '10px', fontWeight: 700, color: '#fff' }}>Tap to view & print</span>
                  </div>
                </div>
              </button>
            );
          })()}
        </div>
      )}

      {/* Action Buttons */}
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
      boxShadow: theme.shadowSm, transition: 'all 0.15s', cursor: disabled ? 'default' : 'pointer',
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
