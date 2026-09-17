'use client';

/**
 * Settings → Graphics Reminders: what the daily sweep counts as "gone quiet".
 *
 * Per-stage thresholds are the whole point of this screen. One flat number
 * is wrong twice over — outgassing is legitimately an overnight wait, so a
 * 2-day rule nags the print room about physics, while a week in Designing
 * is a genuinely lost job the same rule forgives — so every stage carries
 * its own, and 0 turns a stage off. ready_to_pickup ships at 0: a job
 * waiting on the CUSTOMER to collect it is not the designer's to hurry.
 *
 * Reads are staff-wide on purpose (anyone reminded can see why), writes are
 * admin — these numbers decide how often the whole shop is interrupted.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { STAGE_LABELS, type ReminderSettings } from '@/lib/graphics-reminders';
import NumberInput from '@/components/NumberInput';

export default function GraphicsReminderSettingsCard({ sectionStyle, canEdit }: {
  sectionStyle: React.CSSProperties;
  canEdit: boolean;
}) {
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/graphics-reminders');
      const data = await res.json();
      if (!res.ok) { setError(data?.error || 'Could not load reminder settings.'); return; }
      setSettings(data.settings);
    } catch (e: any) {
      setError(e?.message || 'Could not load reminder settings.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/admin/graphics-reminders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: settings.enabled,
          stageDays: settings.stageDays,
          dueSoonDays: settings.dueSoonDays,
          unassignedDays: settings.unassignedDays,
          escalateAfterDays: settings.escalateAfterDays,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error || 'Could not save reminder settings.'); return; }
      // Show what the sweep will actually use, not what was typed.
      setSettings(data.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e?.message || 'Could not save reminder settings.');
    } finally {
      setBusy(false);
    }
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '10px', fontWeight: 700, color: 'var(--text-label)',
    textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
  };

  if (!settings) {
    return (
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Graphics Reminders</div>
        <div style={{ fontSize: '11px', color: error ? '#ef4444' : 'var(--text-label)' }}>
          {error || 'Loading…'}
        </div>
      </div>
    );
  }

  const setStage = (status: string, days: number) =>
    setSettings({ ...settings, stageDays: { ...settings.stageDays, [status]: days } });

  // NumberInput hands back a change EVENT, not a string — reading it as a
  // value coerces to NaN and every keystroke would silently save 0.
  const numberBox = (value: number, onChange: (n: number) => void, max = 60) => (
    <NumberInput
      value={String(value)}
      min={0}
      max={max}
      onChange={e => {
        const n = Number(e.target.value);
        onChange(Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : 0);
      }}
      disabled={!canEdit}
      style={{
        width: '64px', padding: '6px 8px', borderRadius: '8px', fontSize: '12px',
        border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-body)',
      }}
    />
  );

  return (
    <div style={sectionStyle}>
      <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Graphics Reminders</div>
      <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
        Each weekday morning, anyone with graphics jobs that are overdue, due soon, stalled in a stage, or
        sitting unassigned gets <b>one</b> digest listing them. A job that stays past its threshold by the
        escalation window also reaches whoever entered it and the owners. <b>0 days turns a rule off.</b>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px', cursor: canEdit ? 'pointer' : 'default' }}>
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={!canEdit}
          onChange={e => setSettings({ ...settings, enabled: e.target.checked })}
        />
        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>
          Send reminders{settings.enabled ? '' : ' — currently off, nobody is reminded of anything'}
        </span>
      </label>

      <div style={labelStyle}>Days in a stage before it counts as stalled</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '8px', marginBottom: '14px' }}>
        {Object.entries(STAGE_LABELS).map(([status, label]) => {
          const days = settings.stageDays[status as keyof typeof settings.stageDays] ?? 0;
          return (
            <div key={status} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {numberBox(days, n => setStage(status, n))}
              <span style={{ fontSize: '11.5px', color: days === 0 ? 'var(--text-muted)' : 'var(--text-body)', fontWeight: 600 }}>
                {label}{days === 0 ? ' (off)' : ''}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '12px', marginBottom: '14px' }}>
        <div>
          <div style={labelStyle}>Warn before a due date</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {numberBox(settings.dueSoonDays, n => setSettings({ ...settings, dueSoonDays: n }), 30)}
            <span style={{ fontSize: '11.5px', color: 'var(--text-body)' }}>days ahead</span>
          </div>
        </div>
        <div>
          <div style={labelStyle}>Chase an unassigned job after</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {numberBox(settings.unassignedDays, n => setSettings({ ...settings, unassignedDays: n }), 30)}
            <span style={{ fontSize: '11.5px', color: 'var(--text-body)' }}>days</span>
          </div>
        </div>
        <div>
          <div style={labelStyle}>Escalate to the creator &amp; owners after</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {numberBox(settings.escalateAfterDays, n => setSettings({ ...settings, escalateAfterDays: n }), 60)}
            <span style={{ fontSize: '11.5px', color: 'var(--text-body)' }}>extra days</span>
          </div>
        </div>
      </div>

      {canEdit && (
        <button
          onClick={save}
          disabled={busy}
          style={{
            padding: '8px 16px', borderRadius: '8px', border: 'none',
            background: saved ? '#22c55e' : '#3b82f6', color: '#fff',
            fontSize: '12px', fontWeight: 800,
            cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? 'Saving...' : saved ? 'Saved!' : 'Save Reminders'}
        </button>
      )}
      {!canEdit && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          An admin sets these. Shown here so you can see why a reminder reached you.
        </div>
      )}
      {error && <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{error}</div>}
    </div>
  );
}
