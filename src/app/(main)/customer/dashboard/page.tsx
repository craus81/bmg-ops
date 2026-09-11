'use client';

/**
 * The customer portal, rebuilt on live data. Reads /api/customer/portal —
 * scoped server-side by the login's NetSuite customer link — instead of
 * the retired scanned_vehicles table and hand-maintained per-vehicle
 * assignments. Shows every vehicle in the shop with plain-language status,
 * finished work with completion photos, and graphics orders with tracking.
 *
 * Parity (R6-11): a login now sees everything the shared-link portal shows
 * — the Action Center, purchase orders and estimates — on top of the
 * vehicles and photos only the login has. It used to see strictly less
 * than a forwarded link, which is backwards: this is the channel where we
 * actually know who is reading.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/AuthProvider';
import type { PortalData as PoPortalData } from '@/lib/po-portal';
import type { PortalAction } from '@/lib/portal-actions';

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
  /** Purchase orders, estimates and outstanding approvals — the shared-link
   *  portal's payload. null means the load FAILED, which the page says out
   *  loud rather than rendering an empty list that reads as "you have none". */
  portal?: PoPortalData | null;
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Outstanding approvals, pinned (R6-11). Same data as the shared-link
 *  portal's strip; themed for the app rather than fixed-light. A lapsed
 *  link carries no button here either — the fresh-link request lives on
 *  the tokenized page, and a logged-in customer has their rep a click
 *  away, so the honest thing is to say the link expired and why. */
function ActionStrip({ actions }: { actions: PortalAction[] }) {
  if (actions.length === 0) return null;
  const waiting = actions.filter(a => a.state === 'awaiting').length;
  return (
    <div style={{
      background: 'var(--warning-bg)', border: '1px solid var(--warning-border)',
      borderRadius: '14px', padding: '14px 16px', marginBottom: '10px',
    }}>
      <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--warning)', marginBottom: '8px' }}>
        Action needed{waiting > 0 ? ` — ${waiting} waiting on your approval` : ''}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {actions.map(a => (
          <div key={`${a.kind}-${a.id}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                {a.ref}{a.title ? <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}> — {a.title}</span> : null}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                {a.kindLabel}{a.sentAt ? ` · sent ${fmtDate(a.sentAt)}` : ''}{a.total != null ? ` · ${usd(a.total)}` : ''}
              </div>
            </div>
            {a.state === 'awaiting' && a.approveUrl ? (
              <a href={a.approveUrl} target="_blank" rel="noreferrer" style={{ fontSize: '11px', fontWeight: 800, padding: '6px 12px', borderRadius: '8px', background: 'var(--accent)', color: '#fff', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                {a.actionLabel}
              </a>
            ) : (
              <span style={{ fontSize: '10px', fontWeight: 700, padding: '4px 10px', borderRadius: '7px', background: 'var(--subtle-bg)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                Link expired — ask your rep
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Billing card (R5-14): balance + aging + open invoices from the same
 *  id-keyed loader as the tokenized portal. Fails quiet — a NetSuite
 *  hiccup never takes down the vehicle board. */
function BillingCard() {
  const [billing, setBilling] = useState<{
    linked: boolean; balance?: number; pastDue?: number; invoiceCount?: number;
    invoices?: { id: string; tranid: string; dueDate: string | null; unpaid: number; daysPastDue: number }[];
  } | null>(null);
  useEffect(() => {
    fetch('/api/customer/billing')
      .then(r => r.ok ? r.json() : null)
      .then(body => { if (body?.linked) setBilling(body); })
      .catch(() => { /* card simply doesn't render */ });
  }, []);
  if (!billing || billing.invoiceCount === 0) return null;

  const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const fmtDue = (iso: string | null) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
  return (
    <div style={{ margin: '12px 0 4px', padding: '14px 16px', borderRadius: '12px', background: 'var(--card)', border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)' }}>Billing</div>
        <div>
          <span style={{ fontSize: '18px', fontWeight: 900, color: 'var(--text-primary)' }}>{usd(billing.balance || 0)}</span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '6px' }}>open balance</span>
          {(billing.pastDue || 0) > 0.005 && (
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#ef4444', marginLeft: '10px' }}>{usd(billing.pastDue!)} past due</span>
          )}
        </div>
      </div>
      <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {(billing.invoices || []).slice(0, 6).map(inv => (
          <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px' }}>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{inv.tranid}</span>
            <span style={{ color: inv.daysPastDue > 0 ? '#ef4444' : 'var(--text-muted)' }}>
              due {fmtDue(inv.dueDate)}{inv.daysPastDue > 0 ? ` · ${inv.daysPastDue}d late` : ''}
            </span>
            <span style={{ fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{usd(inv.unpaid)}</span>
          </div>
        ))}
        {(billing.invoices || []).length > 6 && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>+ {(billing.invoices || []).length - 6} more open invoice{(billing.invoices || []).length - 6 !== 1 ? 's' : ''}</div>
        )}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '8px' }}>
        PDFs and statements are on your billing portal link — ask your BMG contact if you need a fresh one.
      </div>
    </div>
  );
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

      <ActionStrip actions={data.portal?.actions || []} />

      <BillingCard />

      {/* Purchase orders and estimates (R6-11 parity) — the shared-link
          portal's own sections, id-scoped through buildPoPortalData. */}
      {data.portal === null && (
        <div style={{ ...card, background: 'var(--subtle-bg)' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            We couldn&apos;t load your purchase orders and estimates just now — refresh in a moment.
            This is a display problem on our side, not a change to your orders.
          </div>
        </div>
      )}

      {(data.portal?.pos || []).filter(p => p.status === 'open').length > 0 && (
        <>
          <div style={sectionLabel}>Open Purchase Orders ({data.portal!.pos.filter(p => p.status === 'open').length})</div>
          {data.portal!.pos.filter(p => p.status === 'open').map(po => (
            <div key={po.id} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '160px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>PO {po.poNumber}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                    {po.orderedDate ? `Ordered ${fmtDate(po.orderedDate)}` : `Received ${fmtDate(po.receivedAt)}`}
                    {po.requestedDeliveryDate ? ` · wanted by ${fmtDate(po.requestedDeliveryDate)}` : ''}
                  </div>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: '7px', background: `${po.stage.color}1a`, border: `1px solid ${po.stage.color}44`, color: po.stage.color }}>
                  {po.stage.label}
                </span>
              </div>
              {po.ordered > 0 && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  {po.installed} of {po.ordered} installed
                  {po.stage.detail ? ` · ${po.stage.detail}` : ''}
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {(data.portal?.estimates || []).length > 0 && (
        <>
          <div style={sectionLabel}>Your Estimates ({data.portal!.estimates.length})</div>
          {data.portal!.estimates.map((e, i) => (
            <div key={`${e.number || 'est'}-${i}`} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '160px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {e.number || 'Estimate'}{e.title ? <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}> — {e.title}</span> : null}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                    Sent {fmtDate(e.sentAt)}{e.total != null ? ` · ${usd(e.total)}` : ''}
                  </div>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: '7px', background: `${e.color}1a`, border: `1px solid ${e.color}44`, color: e.color }}>
                  {e.stateLabel}
                </span>
              </div>
            </div>
          ))}
        </>
      )}

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
          <img src={lightbox} alt="Completed work" style={{ maxWidth: '100%', maxHeight: 'calc(90vh / var(--ts))', borderRadius: '10px' }} />
        </div>
      )}
      <div style={{ height: '80px' }} />
    </div>
  );
}
