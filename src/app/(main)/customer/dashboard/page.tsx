'use client';

/**
 * The customer portal, rebuilt on live data. Reads /api/customer/portal —
 * scoped server-side by the login's NetSuite customer link — instead of
 * the retired scanned_vehicles table and hand-maintained per-vehicle
 * assignments. Shows every vehicle in the shop with plain-language status,
 * finished work with completion photos, and graphics orders with tracking.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/AuthProvider';

interface PortalVehicle {
  id: string;
  vin: string;
  label: string;
  status: string;
  statusLabel: string;
  statusColor: string;
  checkedInAt: string;
  updatedAt: string;
  completedAt: string | null;
  photos: { url: string; takenAt: string | null }[];
}

interface PortalGraphics {
  id: string;
  title: string;
  jobNumber: string | null;
  status: string;
  statusLabel: string;
  trackingNumber: string | null;
  carrier: string | null;
  scheduledInstallDate: string | null;
  updatedAt: string;
}

interface PortalData {
  linked: boolean;
  companyName?: string;
  vehicles: { active: PortalVehicle[]; recent: PortalVehicle[]; history: PortalVehicle[] };
  graphics: { active: PortalGraphics[]; recent: PortalGraphics[] };
}

const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';

const upsTracking = (carrier: string | null, tracking: string) =>
  (carrier || '').toLowerCase().includes('ups') || /^1Z/i.test(tracking)
    ? `https://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`
    : null;

export default function CustomerDashboardPage() {
  const { user, profile } = useAuth();
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/customer/portal');
      const body = await res.json();
      if (res.ok) setData(body);
    } catch { /* empty state covers it */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
  }, [user, load]);

  const card: React.CSSProperties = {
    background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
    padding: '14px 16px', marginBottom: '10px',
  };
  const sectionLabel: React.CSSProperties = {
    fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase',
    letterSpacing: '0.8px', margin: '18px 0 8px',
  };

  if (loading) {
    return <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading your vehicles…</div>;
  }

  if (!data?.linked) {
    return (
      <div>
        <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>My Vehicles</div>
        <div style={{ ...card, marginTop: '14px', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--warning)' }}>Account not linked yet</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: 1.5 }}>
            Your login isn&apos;t connected to your company&apos;s account yet, so there&apos;s nothing to show.
            Contact BMG Fleet Installations and we&apos;ll connect it — after that, every vehicle you have with us appears here automatically.
          </div>
        </div>
      </div>
    );
  }

  const { vehicles, graphics } = data;
  const vehicleCard = (v: PortalVehicle, showPhotos: boolean) => (
    <div key={v.id} style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '180px' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>{v.label}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'monospace' }}>
            VIN {v.vin}
          </div>
        </div>
        <span style={{
          fontSize: '11px', fontWeight: 800, padding: '4px 12px', borderRadius: '8px',
          background: `${v.statusColor}1a`, border: `1px solid ${v.statusColor}44`, color: v.statusColor,
        }}>
          {v.statusLabel}
        </span>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
        Checked in {fmtDate(v.checkedInAt)}
        {v.completedAt && ` · completed ${fmtDate(v.completedAt)}`}
      </div>
      {showPhotos && v.photos.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' }}>
          {v.photos.map((p, i) => (
            /* eslint-disable-next-line @next/next/no-img-element -- external storage URL, unknown dimensions */
            <img
              key={i}
              src={p.url}
              alt={`${v.label} completed work`}
              onClick={() => setLightbox(p.url)}
              style={{ width: '84px', height: '84px', objectFit: 'cover', borderRadius: '8px', border: '1px solid var(--border)', cursor: 'pointer' }}
            />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>My Vehicles</div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>{data.companyName}</div>

      {/* Summary strip */}
      <div style={{ display: 'flex', gap: '8px', margin: '12px 0 4px', flexWrap: 'wrap' }}>
        {[
          { label: 'In our shop', value: vehicles.active.length, color: '#60a5fa' },
          { label: 'Finished (30d)', value: vehicles.recent.length, color: '#22c55e' },
          { label: 'Graphics orders', value: graphics.active.length, color: '#a78bfa' },
        ].map(t => (
          <div key={t.label} style={{ flex: 1, minWidth: '90px', padding: '10px 12px', borderRadius: '12px', background: 'var(--card)', border: '1px solid var(--border)', textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: 800, color: t.color }}>{t.value}</div>
            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t.label}</div>
          </div>
        ))}
      </div>

      {/* Active vehicles */}
      <div style={sectionLabel}>In Our Shop ({vehicles.active.length})</div>
      {vehicles.active.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
          No vehicles in our shop right now
        </div>
      ) : vehicles.active.map(v => vehicleCard(v, true))}

      {/* Recently finished with photos */}
      {vehicles.recent.length > 0 && (
        <>
          <div style={sectionLabel}>Recently Finished ({vehicles.recent.length})</div>
          {vehicles.recent.map(v => vehicleCard(v, true))}
        </>
      )}

      {/* Graphics orders */}
      {(graphics.active.length > 0 || graphics.recent.length > 0) && (
        <>
          <div style={sectionLabel}>Graphics Orders</div>
          {[...graphics.active, ...graphics.recent].map(g => (
            <div key={g.id} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '160px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{g.title}</div>
                  {g.jobNumber && <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{g.jobNumber}</div>}
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: '7px', background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                  {g.statusLabel}
                </span>
              </div>
              {(g.trackingNumber || g.scheduledInstallDate) && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  {g.trackingNumber && (() => {
                    const url = upsTracking(g.carrier, g.trackingNumber);
                    return url
                      ? <a href={url} target="_blank" rel="noreferrer" style={{ color: '#60a5fa', fontWeight: 700 }}>Track shipment: {g.trackingNumber}</a>
                      : <span>Tracking{g.carrier ? ` (${g.carrier})` : ''}: {g.trackingNumber}</span>;
                  })()}
                  {g.trackingNumber && g.scheduledInstallDate && ' · '}
                  {g.scheduledInstallDate && `Install scheduled ${fmtDate(g.scheduledInstallDate)}`}
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {/* History */}
      {vehicles.history.length > 0 && (
        <>
          <div style={sectionLabel}>
            <button
              onClick={() => setShowHistory(s => !s)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', cursor: 'pointer', padding: 0 }}
            >
              {showHistory ? '▾' : '▸'} History ({vehicles.history.length})
            </button>
          </div>
          {showHistory && vehicles.history.map(v => vehicleCard(v, false))}
        </>
      )}

      <div style={{ ...card, marginTop: '18px', background: 'var(--subtle-bg)' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Questions about a vehicle? Reply to any of our status emails, or contact your BMG rep — this page updates live as work progresses.
        </div>
      </div>

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', cursor: 'zoom-out' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- external storage URL */}
          <img src={lightbox} alt="Completed work" style={{ maxWidth: '100%', maxHeight: '90vh', borderRadius: '10px' }} />
        </div>
      )}
      <div style={{ height: '80px' }} />
    </div>
  );
}
