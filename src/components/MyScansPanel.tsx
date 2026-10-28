'use client';

/**
 * "My scans" on the Scan screen (Craig, 2026-10-20: can the person who
 * scanned the vehicle look at the photos?). A full-screen list of the
 * signed-in person's own scans — today, 7 days or 30 days — grouped by
 * day, each with its VIN, parts, unit, customer, time and the photos taken.
 * Photos open in the shared viewer (arrows, zoom, print). Works for outside
 * installers too: /api/scans/mine only ever returns the caller's own scans,
 * and carries no prices or pay.
 */

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import PhotoLightbox, { type LightboxPhoto } from './PhotoLightbox';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { MY_SCANS_RANGES, type MyScansRange } from '@/lib/my-scans';

interface MyScan {
  id: string;
  vin: string;
  vehicle: string | null;
  parts: string[];
  unitNumber: string | null;
  stockNumber?: string | null;
  customer: string | null;
  location: string | null;
  scannedAt: string;
  day: string;
  photos: { path: string; url: string }[];
}

const RANGE_LABEL: Record<MyScansRange, string> = { 1: 'Today', 7: '7 days', 30: '30 days' };

function dayHeading(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const label = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return date.toDateString() === today.toDateString() ? `Today · ${label}` : label;
}

export default function MyScansPanel({ onClose, waitingPhotos = 0 }: {
  onClose: () => void;
  /** Photos still on this phone (taken offline), from the scan page's queue. */
  waitingPhotos?: number;
}) {
  const [range, setRange] = useState<MyScansRange>(1);
  const [scans, setScans] = useState<MyScan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ scanId: string; idx: number } | null>(null);

  const load = useCallback(async (days: MyScansRange) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/scans/mine?days=${days}&tz=${new Date().getTimezoneOffset()}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setScans(body.scans || []);
    } catch (e: any) {
      setError(`Could not load your scans: ${e?.message || 'unknown error'}. Check your connection and tap a range to try again.`);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(range); }, [load, range]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !viewer) onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose, viewer]);

  const viewing = viewer ? scans.find(s => s.id === viewer.scanId) : null;
  const shots: LightboxPhoto[] = (viewing?.photos || []).map(p => ({
    id: p.path,
    url: p.url,
    title: [viewing?.vehicle, viewing ? `VIN ${viewing.vin}` : null].filter(Boolean).join(' · '),
    subtitle: viewing ? [viewing.parts.join(' + '), new Date(viewing.scannedAt).toLocaleString()].filter(Boolean).join(' · ') : null,
  }));

  let lastDay = '';
  const panel = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="My scans"
      style={{
        position: 'fixed', inset: 0, zIndex: 900, background: theme.bg, overflowY: 'auto',
        paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div style={{ maxWidth: '700px', margin: '0 auto', padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
          <button type="button" onClick={onClose} style={{ fontSize: '15px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>‹ Scan</button>
          <div style={{ fontSize: '20px', fontWeight: 800, color: theme.textPrimary }}>My scans</div>
        </div>

        <div style={{ display: 'flex', border: `1px solid ${theme.border}`, borderRadius: '9px', overflow: 'hidden', marginBottom: '8px' }}>
          {MY_SCANS_RANGES.map(r => (
            <button
              key={r}
              type="button"
              onClick={() => (r === range ? load(r) : setRange(r))}
              style={{
                flex: 1, padding: '8px 0', fontSize: '13px', fontWeight: 700, border: 'none', cursor: 'pointer',
                background: r === range ? theme.accent : 'transparent', color: r === range ? '#fff' : theme.textMuted,
              }}
            >{RANGE_LABEL[r]}</button>
          ))}
        </div>

        {waitingPhotos > 0 && (
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#60a5fa', margin: '6px 0' }}>
            {waitingPhotos} photo{waitingPhotos !== 1 ? 's' : ''} still on this phone, waiting to upload. They show here once they do.
          </div>
        )}
        {error && (
          <div style={{ padding: '10px 12px', borderRadius: '8px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, color: theme.error, fontSize: '13px', fontWeight: 600, margin: '8px 0' }}>
            {error}
          </div>
        )}
        {loading && <div style={{ fontSize: '13px', color: theme.textMuted, padding: '10px 0' }}>Loading…</div>}
        {!loading && !error && scans.length === 0 && (
          <div style={{ fontSize: '13px', color: theme.textMuted, padding: '10px 0' }}>
            No scans {range === 1 ? 'today' : `in the last ${range} days`}.
          </div>
        )}

        {!loading && scans.map(s => {
          const heading = s.day !== lastDay ? dayHeading(s.day) : null;
          lastDay = s.day;
          return (
            <div key={s.id}>
              {heading && (
                <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: theme.textMuted, margin: '16px 0 6px' }}>{heading}</div>
              )}
              <div style={{ borderTop: `1px solid ${theme.border}`, padding: '10px 0', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                  <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '13px', fontWeight: 700, color: theme.textPrimary, overflowWrap: 'anywhere' }}>{s.vin}</span>
                  <span style={{ fontSize: '12px', color: theme.textMuted, whiteSpace: 'nowrap' }}>
                    {new Date(s.scannedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: theme.textSecondary }}>
                  {[s.vehicle, s.parts.join(' + '), s.unitNumber ? `Unit ${s.unitNumber}` : null, s.stockNumber ? `Stock ${s.stockNumber}` : null].filter(Boolean).join(' · ')}
                  {s.customer && <span style={{ color: '#a78bfa', fontWeight: 600 }}> · {s.customer}</span>}
                </div>
                {s.photos.length === 0 ? (
                  <div style={{ fontSize: '12px', fontWeight: 600, color: theme.warning }}>No photo taken</div>
                ) : (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                    {s.photos.map((p, i) => (
                      <button
                        key={p.path}
                        type="button"
                        onClick={() => setViewer({ scanId: s.id, idx: i })}
                        aria-label={`Photo ${i + 1} of ${s.vin}`}
                        style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer', lineHeight: 0 }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.url} alt="" loading="lazy" style={{ width: '64px', height: '64px', objectFit: 'cover', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'var(--subtle-bg)' }} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <PhotoLightbox
        photos={shots}
        index={viewer ? viewer.idx : null}
        onClose={() => setViewer(null)}
        onIndex={i => setViewer(v => (v ? { ...v, idx: i } : v))}
        printHeading={viewing ? `VIN ${viewing.vin}` : undefined}
      />
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(panel, document.body);
}
