'use client';

import { useState } from 'react';
import { parseLaborHoursInput } from '@/lib/part-labor';

/**
 * The small box under an estimate line where a super admin sets the PART's
 * labor hours (Craig, 2026-10-23). Hours only — no dollar amount. Saves to
 * the catalog via /api/parts/[id]/labor; the parent fills this estimate's
 * lines from `onSaved`.
 */
export default function PartLaborEditor({
  partId,
  itemNumber,
  currentHours,
  onSaved,
  onClose,
}: {
  partId: string;
  itemNumber: string;
  currentHours: number | null;
  onSaved: (hours: number | null, message: string, filledEstimateIds: string[]) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(currentHours == null ? '' : String(currentHours));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unset = currentHours == null;

  const save = async (raw: string) => {
    const parsed = parseLaborHoursInput(raw);
    if ('error' in parsed) { setError(parsed.error); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/parts/${partId}/labor`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: parsed.hours }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || `Could not save labor (error ${res.status}).`); return; }
      const filled: { id: string; estimate_number: string | null }[] = data.filledEstimates || [];
      let msg = parsed.hours == null
        ? `Labor cleared on ${itemNumber}.`
        : `Saved ${parsed.hours}h to ${itemNumber}`;
      if (parsed.hours != null) {
        msg += filled.length
          ? ` and filled ${filled.length} open draft${filled.length !== 1 ? 's' : ''} (${filled.map(e => e.estimate_number || 'draft').join(', ')}).`
          : '.';
      }
      if (data.fillError) msg += ` Some drafts were not filled: ${data.fillError}`;
      onSaved(parsed.hours, msg, filled.map(e => e.id));
    } catch (e: any) {
      setError(e?.message || 'Could not save labor.');
    } finally {
      setSaving(false);
    }
  };

  const btn: React.CSSProperties = {
    padding: '7px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, cursor: saving ? 'wait' : 'pointer',
    border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)',
  };

  return (
    <div
      role="group"
      aria-label={`Labor hours for ${itemNumber}`}
      style={{ margin: '4px 0 8px', padding: '10px 12px', borderRadius: '8px', border: '1px solid #60a5fa', background: 'var(--input-bg)', display: 'flex', flexDirection: 'column', gap: '8px' }}
    >
      <label htmlFor={`labor-hrs-${partId}`} style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-label)' }}>
        Labor hours per part
      </label>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          id={`labor-hrs-${partId}`}
          autoFocus
          inputMode="decimal"
          placeholder="e.g. 1.5"
          value={value}
          disabled={saving}
          onChange={e => { setValue(e.target.value); setError(null); }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); save(value); }
            if (e.key === 'Escape') onClose();
          }}
          style={{ width: '80px', padding: '7px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '15px' }}
        />
        <span style={{ fontSize: '12px', color: 'var(--text-label)' }}>hours</span>
        <button type="button" disabled={saving} onClick={() => save('0')} style={btn}>0 = no labor</button>
        <button type="button" disabled={saving} onClick={() => save(value)} style={{ ...btn, background: '#2563eb', borderColor: '#2563eb', color: '#fff' }}>
          {saving ? 'Saving…' : 'Save to part'}
        </button>
        <button type="button" disabled={saving} onClick={onClose} style={btn}>Cancel</button>
      </div>
      {error && <div style={{ fontSize: '12px', fontWeight: 700, color: '#ef4444' }}>{error}</div>}
      <div style={{ fontSize: '11px', color: 'var(--text-label)', lineHeight: 1.5 }}>
        Saves to {itemNumber} in the catalog and this estimate
        {unset ? ', and fills other open draft estimates where it says "not set"' : ''}. Blank clears it back to &quot;not set&quot;.
      </div>
    </div>
  );
}
