'use client';

import { useState } from 'react';
import { theme } from '@/lib/theme';
import { partNumberKey } from '@/lib/loose-search';
import { addExtraParts, type ExtraPartCatalogItem } from '@/lib/scan-extra-parts';

/**
 * "Extra parts for this vehicle" on the Scan screen: part numbers saved with
 * each vehicle on top of the shift's parts (a unit-number decal next to the
 * decal kit). The list stays from truck to truck until the installer removes
 * a part (×) or taps Clear.
 */
export default function ScanExtraParts({
  parts, onChange, catalog, baseParts,
}: {
  parts: string[];
  onChange: (parts: string[]) => void;
  catalog: ExtraPartCatalogItem[];
  baseParts: string[];
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  // Same loose match as the part picker: O and 0 alike, dashes ignored.
  const norm = (s: string) => s.toLowerCase().replace(/o/g, '0');
  const q = norm(text.trim());
  const qKey = norm(partNumberKey(text.trim()));
  const taken = new Set([...parts, ...baseParts].map(p => p.toUpperCase()));
  const suggestions = q
    ? catalog.filter(c => !taken.has(c.item_number.toUpperCase()) && (
        norm(c.item_number).includes(q)
        || (!!qKey && norm(partNumberKey(c.item_number)).includes(qKey))
        || norm(c.display_name || '').includes(q)
      )).slice(0, 4)
    : [];

  const add = (value: string) => {
    if (!value.trim()) return;
    const r = addExtraParts(parts, value, { catalog, baseParts });
    if (r.error) { setError(r.error); return; }
    setError('');
    onChange(r.parts);
    setText('');
  };

  return (
    <div style={{ border: `1px dashed ${theme.borderStrong}`, borderRadius: '12px', padding: '10px', marginBottom: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Extra parts for this vehicle
        </div>
        {parts.length > 0 && (
          <button type="button" onClick={() => { onChange([]); setError(''); }} style={{
            background: 'transparent', border: 'none', color: theme.textMuted, fontSize: '11px', fontWeight: 700, cursor: 'pointer',
          }}>Clear</button>
        )}
      </div>
      <div style={{ fontSize: '11px', color: theme.textMuted, margin: '2px 0 8px' }}>
        {parts.length > 0 ? 'Saved with every vehicle until you remove them.' : 'Unit-number decals or other parts on top of the kit.'}
      </div>

      {parts.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
          {parts.map(p => (
            <span key={p} style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 4px 4px 10px', borderRadius: '8px',
              background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.4)',
              color: '#22c55e', fontFamily: 'monospace', fontSize: '13px', fontWeight: 700,
            }}>
              {p}
              <button type="button" aria-label={`Remove ${p}`} onClick={() => onChange(parts.filter(x => x !== p))} style={{
                background: 'transparent', border: 'none', color: 'inherit', fontSize: '15px', cursor: 'pointer', padding: '0 4px', lineHeight: 1,
              }}>×</button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px' }}>
        <input
          value={text}
          onChange={e => { setText(e.target.value); setError(''); }}
          onKeyDown={e => {
            // Enter adds the part here; it never logs the vehicle.
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(text); }
          }}
          placeholder="Type or search part #"
          aria-label="Add extra part number"
          autoComplete="off"
          style={{
            flex: 1, minWidth: 0, padding: '10px 14px', borderRadius: '10px', fontSize: '13px',
            fontWeight: 600, border: `1px solid ${theme.border}`, background: theme.card, color: theme.textPrimary,
          }}
        />
        <button type="button" onClick={() => add(text)} disabled={!text.trim()} style={{
          padding: '10px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 800, border: 'none',
          background: text.trim() ? theme.accent : theme.border, color: '#fff',
          cursor: text.trim() ? 'pointer' : 'default', opacity: text.trim() ? 1 : 0.5,
        }}>Add</button>
      </div>

      {text.trim() && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
          {suggestions.map(c => (
            <button key={c.item_number} type="button" onClick={() => add(c.item_number)} style={{
              textAlign: 'left', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${theme.border}`,
              background: theme.card, color: theme.textPrimary, cursor: 'pointer',
            }}>
              <div style={{ fontWeight: 700, fontSize: '13px' }}>{c.item_number}</div>
              {(c.display_name || c.description) && (
                <div style={{ fontSize: '11px', color: theme.textMuted }}>{c.display_name || c.description}</div>
              )}
            </button>
          ))}
          {suggestions.length === 0 && (
            <div style={{ fontSize: '11px', color: theme.textMuted }}>
              Not in the parts list. Tap Add to use &ldquo;{text.trim()}&rdquo; as typed.
            </div>
          )}
        </div>
      )}

      {error && <div style={{ marginTop: '6px', fontSize: '12px', fontWeight: 600, color: '#ef4444' }}>{error}</div>}
    </div>
  );
}
