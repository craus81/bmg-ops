'use client';

/**
 * Vehicle condition report (R6-10): record the odometer, the fuel level
 * and each piece of pre-existing damage, then send the customer a link to
 * confirm the record is accurate.
 *
 * The send freezes a fingerprint of exactly what was sent. Editing after
 * that invalidates the live link rather than changing what the customer
 * is agreeing to — so the card stops being editable once acknowledged,
 * and says so.
 */

import { useCallback, useEffect, useState } from 'react';
import { theme } from '@/lib/theme';
import {
  SEVERITIES, FUEL_LEVELS, fuelLabel, severityLabel, severityTone,
  formatOdometer, summarizeCondition, conditionNote, type Severity, type FuelLevel,
} from '@/lib/vehicle-condition';

const TONE_COLOR = { ok: '#94a3b8', warn: '#f59e0b', bad: '#f87171' } as const;

interface Finding {
  id?: string;
  location: string;
  severity: Severity;
  description: string;
  photo_paths?: string[] | null;
}

export default function ConditionReportCard({ checkinId }: { checkinId: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [odometer, setOdometer] = useState('');
  const [fuel, setFuel] = useState<FuelLevel | ''>('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [ack, setAck] = useState<{ at: string | null; name: string | null }>({ at: null, name: null });
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/checkins/condition?checkinId=${encodeURIComponent(checkinId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setOdometer(body.checkin.odometer_miles === null || body.checkin.odometer_miles === undefined
        ? '' : String(body.checkin.odometer_miles));
      setFuel((body.checkin.fuel_level || '') as FuelLevel | '');
      setFindings((body.findings || []).map((f: any) => ({
        id: f.id, location: f.location || '', severity: f.severity,
        description: f.description, photo_paths: f.photo_paths,
      })));
      setAck({ at: body.checkin.condition_ack_at, name: body.checkin.condition_ack_name });
      setSentAt(body.checkin.condition_sent_at);
      setLink(body.checkin.condition_token ? `/approve/condition/${body.checkin.condition_token}` : null);
    } catch (e: any) {
      setError(e?.message || 'Could not load the condition report');
    }
    setLoading(false);
  }, [checkinId]);

  useEffect(() => { load(); }, [load]);

  const save = async (send: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/checkins/condition', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checkinId,
          odometerMiles: odometer.trim() === '' ? null : parseInt(odometer, 10),
          fuelLevel: fuel || null,
          findings: findings
            .filter(f => f.description.trim())
            .map(f => ({
              location: f.location.trim() || null,
              severity: f.severity,
              description: f.description.trim(),
              photoPaths: f.photo_paths || [],
            })),
          send,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Could not save');
    }
    setSaving(false);
  };

  const locked = Boolean(ack.at);
  const summary = summarizeCondition(findings.map(f => ({
    location: f.location, severity: f.severity, description: f.description,
    photo_paths: f.photo_paths || [],
  })));

  if (loading) return null;

  return (
    <div style={{
      background: theme.card, border: `1px solid ${theme.border}`,
      borderRadius: '14px', padding: '14px', marginBottom: '16px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', marginBottom: '10px' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Condition on arrival
        </div>
        <div style={{ fontSize: '11px', color: theme.textMuted }}>{conditionNote(summary)}</div>
      </div>

      {locked && (
        <div style={{
          padding: '9px 11px', borderRadius: '9px', marginBottom: '11px', fontSize: '11.5px',
          background: 'rgba(52,211,153,0.09)', border: '1px solid rgba(52,211,153,0.3)', color: 'var(--text-body)',
        }}>
          ✓ Acknowledged by {ack.name || 'the customer'} on {new Date(ack.at!).toLocaleString()}.
          This record is now locked — a signature has to stay attached to what was actually shown.
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <div>
          <div style={{ fontSize: '10px', color: theme.textMuted, marginBottom: '3px' }}>Odometer</div>
          {locked ? (
            <div style={{ fontSize: '13px', fontWeight: 700 }}>{formatOdometer(parseInt(odometer, 10)) || 'Not recorded'}</div>
          ) : (
            <input
              type="number" min="0" value={odometer} onChange={e => setOdometer(e.target.value)}
              placeholder="miles"
              style={{ width: '110px', padding: '6px 8px', fontSize: '13px', borderRadius: '7px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary }}
            />
          )}
        </div>
        <div>
          <div style={{ fontSize: '10px', color: theme.textMuted, marginBottom: '3px' }}>Fuel</div>
          {locked ? (
            <div style={{ fontSize: '13px', fontWeight: 700 }}>{fuelLabel(fuel) || 'Not recorded'}</div>
          ) : (
            <select
              value={fuel} onChange={e => setFuel(e.target.value as FuelLevel | '')}
              style={{ padding: '6px 8px', fontSize: '13px', borderRadius: '7px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary }}
            >
              <option value="">—</option>
              {FUEL_LEVELS.map(f => <option key={f} value={f}>{fuelLabel(f)}</option>)}
            </select>
          )}
        </div>
      </div>

      {findings.map((f, i) => (
        <div key={f.id || i} style={{
          padding: '9px', borderRadius: '9px', marginBottom: '5px',
          background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`,
        }}>
          {locked ? (
            <>
              <div style={{ fontSize: '12.5px', fontWeight: 700, color: TONE_COLOR[severityTone(f.severity)] }}>
                {severityLabel(f.severity)}{f.location ? ` — ${f.location}` : ''}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-body)' }}>{f.description}</div>
            </>
          ) : (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                value={f.severity}
                onChange={e => setFindings(prev => prev.map((x, j) => j === i ? { ...x, severity: e.target.value as Severity } : x))}
                style={{ padding: '5px 7px', fontSize: '12px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: TONE_COLOR[severityTone(f.severity)], fontWeight: 700 }}
              >
                {SEVERITIES.map(s => <option key={s} value={s}>{severityLabel(s)}</option>)}
              </select>
              <input
                value={f.location} placeholder="Where on the vehicle"
                onChange={e => setFindings(prev => prev.map((x, j) => j === i ? { ...x, location: e.target.value } : x))}
                style={{ flex: '1 1 140px', minWidth: 0, padding: '5px 7px', fontSize: '12px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary }}
              />
              <input
                value={f.description} placeholder="What it is"
                onChange={e => setFindings(prev => prev.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                style={{ flex: '2 1 180px', minWidth: 0, padding: '5px 7px', fontSize: '12px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary }}
              />
              <button
                onClick={() => setFindings(prev => prev.filter((_, j) => j !== i))}
                title="Remove this finding"
                style={{ background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer', fontSize: '14px', padding: '2px 5px' }}
              >✕</button>
            </div>
          )}
          {(f.photo_paths || []).length === 0 && !locked && (
            <div style={{ fontSize: '10.5px', color: '#f59e0b', marginTop: '4px' }}>
              No photo on this one — it is the finding that gets argued about.
            </div>
          )}
        </div>
      ))}

      {!locked && (
        <button
          onClick={() => setFindings(prev => [...prev, { location: '', severity: 'minor', description: '', photo_paths: [] }])}
          style={{ padding: '6px 11px', borderRadius: '8px', border: `1px dashed ${theme.border}`, background: 'transparent', color: theme.textSecondary, fontSize: '11.5px', fontWeight: 700, cursor: 'pointer', marginBottom: '10px' }}
        >+ Add a finding</button>
      )}

      {error && <div style={{ fontSize: '11.5px', color: '#f87171', marginBottom: '8px' }}>{error}</div>}

      {!locked && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={() => save(false)} disabled={saving}
            style={{ padding: '7px 13px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'transparent', color: theme.textSecondary, fontSize: '12px', fontWeight: 700, cursor: saving ? 'wait' : 'pointer' }}
          >{saving ? 'Saving…' : 'Save'}</button>
          <button
            onClick={() => save(true)} disabled={saving}
            title="Mint a fresh link and freeze this record — editing afterwards invalidates it"
            style={{ padding: '7px 13px', borderRadius: '8px', border: 'none', background: '#2563eb', color: '#fff', fontSize: '12px', fontWeight: 800, cursor: saving ? 'wait' : 'pointer' }}
          >{sentAt ? 'Re-send for acknowledgment' : 'Send for acknowledgment'}</button>
          {link && (
            <a
              href={link} target="_blank" rel="noreferrer"
              style={{ fontSize: '11px', color: '#60a5fa' }}
            >
              Open the customer’s link{sentAt ? ` · sent ${new Date(sentAt).toLocaleDateString()}` : ''}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
