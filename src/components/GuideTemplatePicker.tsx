'use client';

/**
 * "New from template" (R6-10).
 *
 * Templates are ranked against the vehicle typed in, never filtered by
 * it: a coordinator who knows the Sprinter template is the right starting
 * point for an odd build must still be able to reach it. Non-matches sort
 * last and say why they're a poor fit rather than being hidden.
 */

import { useCallback, useEffect, useState } from 'react';
import { theme } from '@/lib/theme';

interface RankedTemplate {
  id: string;
  name: string | null;
  year: string | null;
  make: string | null;
  model: string | null;
  score: number;
  reason: string;
  summary: string;
}

export default function GuideTemplatePicker({
  onClose, onCreated, defaultVehicle = '', defaultCustomer = '',
  graphicsJobId = null, cniJobId = null, fleetCheckinId = null,
}: {
  onClose: () => void;
  onCreated: (guideId: string) => void;
  defaultVehicle?: string;
  defaultCustomer?: string;
  graphicsJobId?: string | null;
  cniJobId?: string | null;
  fleetCheckinId?: string | null;
}) {
  const [vehicle, setVehicle] = useState(defaultVehicle);
  const [customer, setCustomer] = useState(defaultCustomer);
  const [templates, setTemplates] = useState<RankedTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (desc: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/install-guides/templates?vehicleDesc=${encodeURIComponent(desc)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setTemplates(body.templates || []);
    } catch (e: any) {
      setError(e?.message || 'Could not load templates');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(defaultVehicle); }, [load, defaultVehicle]);

  // Re-rank as they type, debounced — the list is short and the ranking
  // is server-side but cheap.
  useEffect(() => {
    const t = setTimeout(() => { load(vehicle); }, 400);
    return () => clearTimeout(t);
  }, [vehicle, load]);

  const create = async (templateId: string) => {
    setCreating(templateId);
    setError(null);
    try {
      const res = await fetch('/api/install-guides/templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'new_from_template', templateId,
          customerName: customer.trim() || null,
          vehicleDesc: vehicle.trim() || null,
          graphicsJobId, cniJobId, fleetCheckinId,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      onCreated(body.guideId);
    } catch (e: any) {
      setError(e?.message || 'Could not create the guide');
      setCreating(null);
    }
  };

  return (
    <div
      onClick={() => { if (!creating) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 400,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          width: '100%', maxWidth: '540px', maxHeight: 'calc(86vh / var(--ts))',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>New guide from a template</div>
          <div style={{ fontSize: '11.5px', color: theme.textMuted, marginTop: '3px' }}>
            The template brings its calibration, dimensions and sections. Every template stays
            listed — a poor match sorts last rather than hiding.
          </div>
          <div style={{ display: 'flex', gap: '7px', marginTop: '10px', flexWrap: 'wrap' }}>
            <input
              value={vehicle} onChange={e => setVehicle(e.target.value)}
              placeholder="Vehicle (e.g. 2024 Ford Transit 148 High Roof)"
              style={{ flex: '2 1 220px', minWidth: 0, padding: '7px 9px', fontSize: '12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary }}
            />
            <input
              value={customer} onChange={e => setCustomer(e.target.value)}
              placeholder="Customer"
              style={{ flex: '1 1 130px', minWidth: 0, padding: '7px 9px', fontSize: '12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary }}
            />
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {loading && <div style={{ fontSize: '12px', color: theme.textMuted }}>Loading templates…</div>}
          {!loading && templates.length === 0 && (
            <div style={{ fontSize: '12px', color: theme.textMuted }}>
              No templates saved yet. Open a finished guide and use “Save as template” to make the
              first one — its calibration and standard dimensions are what gets reused.
            </div>
          )}
          {templates.map(t => (
            <button
              key={t.id}
              onClick={() => create(t.id)}
              disabled={Boolean(creating)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', marginBottom: '6px',
                padding: '10px 11px', borderRadius: '10px', cursor: creating ? 'wait' : 'pointer',
                background: t.score > 0 ? 'rgba(96,165,250,0.07)' : 'var(--subtle-bg)',
                border: `1px solid ${t.score > 0 ? 'rgba(96,165,250,0.3)' : theme.border}`,
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 800, color: theme.textPrimary }}>
                {t.name || 'Untitled template'}
                {creating === t.id && <span style={{ fontWeight: 500, color: theme.textMuted }}> · creating…</span>}
              </div>
              <div style={{ fontSize: '11px', color: t.score > 0 ? '#60a5fa' : theme.textMuted, marginTop: '2px' }}>
                {t.reason}
              </div>
              <div style={{ fontSize: '10.5px', color: theme.textMuted, marginTop: '2px' }}>{t.summary}</div>
            </button>
          ))}
        </div>

        <div style={{ padding: '11px 16px', borderTop: `1px solid ${theme.border}` }}>
          {error && <div style={{ fontSize: '11.5px', color: '#f87171', marginBottom: '8px' }}>{error}</div>}
          <button
            onClick={onClose} disabled={Boolean(creating)}
            style={{ padding: '7px 13px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'transparent', color: theme.textSecondary, fontSize: '12px', fontWeight: 700, cursor: creating ? 'wait' : 'pointer' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
