'use client';

import { useEffect, useRef, useState } from 'react';

// "Select all" + "Change film to…" over a wrap quote's element list, so a
// whole quote (or just the checked pieces) can move to another vinyl in one
// step instead of clicking each shape. The list rows own their checkboxes;
// this bar owns the select-all toggle and the apply.

interface Props {
  /** Elements on the quote that can be checked. */
  total: number;
  /** How many of them are checked right now. */
  checked: number;
  onToggleAll: (all: boolean) => void;
  films: { id: string; label: string }[];
  /** Give every checked element this film. */
  onApply: (filmId: string) => void;
  /** What the elements are called in the hint ("shapes", "boxes"). */
  noun?: string;
}

export default function BulkFilmBar({ total, checked, onToggleAll, films, onApply, noun = 'shapes' }: Props) {
  const allRef = useRef<HTMLInputElement>(null);
  const [filmId, setFilmId] = useState('');
  const all = total > 0 && checked === total;

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = checked > 0 && checked < total;
  }, [checked, total]);

  if (total === 0) return null;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', padding: '6px 8px', marginBottom: '6px',
      borderRadius: '6px', background: checked > 0 ? 'rgba(6,182,212,0.08)' : 'var(--subtle-bg)',
      border: `1px solid ${checked > 0 ? 'rgba(6,182,212,0.35)' : 'var(--border)'}`,
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer' }}>
        <input ref={allRef} type="checkbox" checked={all} onChange={e => onToggleAll(e.target.checked)} aria-label="Select all" />
        {checked > 0 ? `${checked} of ${total} selected` : 'Select all'}
      </label>
      {checked > 0 && (
        <>
          <select
            value={filmId}
            onChange={e => setFilmId(e.target.value)}
            aria-label="Change film to"
            style={{
              flex: 1, minWidth: '120px', padding: '4px 6px', borderRadius: '6px', fontSize: '11px',
              background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)',
            }}
          >
            <option value="">Change film to…</option>
            {films.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <button
            onClick={() => { if (filmId) { onApply(filmId); setFilmId(''); } }}
            disabled={!filmId}
            title={`Give the ${checked} checked ${noun} this film`}
            style={{
              padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
              background: 'rgba(6,182,212,0.1)', border: '1px solid #06b6d4', color: '#06b6d4',
              cursor: filmId ? 'pointer' : 'default', opacity: filmId ? 1 : 0.5,
            }}
          >Apply</button>
        </>
      )}
    </div>
  );
}
