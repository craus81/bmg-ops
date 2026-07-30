'use client';

/**
 * The "Filter ▾" button + popover — the app-wide companion to SortableTh.
 * Sorting lives on the column headers; everything that narrows the list
 * (dropdowns, tier pills, toggles) lives inside this one popover instead of
 * a row of always-visible controls. The button shows a count badge and
 * turns blue while any filter is active so a narrowed list is never a
 * mystery.
 *
 * The caller owns the filter state and renders its controls as children;
 * this component only owns open/close behavior and the button/panel chrome.
 */

import { useEffect, useRef, useState } from 'react';

export function FilterLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '9px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px',
      color: 'var(--text-muted)', margin: '10px 0 4px',
    }}>{children}</div>
  );
}

export default function FilterButton({ activeCount, onClear, children }: {
  activeCount: number;
  /** Clears the popover's filters; renders the "✕ Clear filters" link when provided and any filter is active. */
  onClear?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const active = activeCount > 0;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          padding: '7px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
          background: 'var(--subtle-bg)',
          border: `1px solid ${active ? 'rgba(96,165,250,0.5)' : 'var(--border)'}`,
          color: active ? '#60a5fa' : 'var(--text-secondary)',
          display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap',
        }}
      >
        Filter
        {active && (
          <span style={{ background: 'rgba(96,165,250,0.15)', borderRadius: '999px', fontSize: '10px', padding: '0 6px', color: '#60a5fa' }}>
            {activeCount}
          </span>
        )}
        {' ▾'}
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 50, width: '280px',
          background: 'var(--card)', border: '1px solid var(--border-strong)', borderRadius: '12px',
          boxShadow: 'var(--shadow-md)', padding: '14px',
        }}>
          {children}
          {onClear && active && (
            <button
              onClick={onClear}
              style={{
                display: 'inline-block', marginTop: '12px', fontSize: '11px', fontWeight: 700,
                color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}
            >✕ Clear filters</button>
          )}
        </div>
      )}
    </div>
  );
}
