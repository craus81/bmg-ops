'use client';

/**
 * Click-to-sort table headers — the app-wide pattern for sortable tables.
 * No separate sort dropdown: clicking a header sorts by that column, and
 * clicking it again flips the direction. The active column shows ▲/▼;
 * inactive sortable columns show a faint ↕ so sortability is discoverable.
 *
 * Usage:
 *   const { sorted, sort, toggle } = useTableSort(rows, {
 *     date:   r => r.dateIso,          // string compare (ISO dates sort right)
 *     amount: r => r.total,            // numeric compare
 *   }, { key: 'date', dir: 'desc' });
 *   ...
 *   <SortableTh label="Date" sortKey="date" sort={sort} onToggle={toggle}
 *     defaultDir="desc" style={thStyle} />
 *
 * Null/undefined values always sort last regardless of direction, so rows
 * missing a due date (etc.) don't float to the top of an ascending sort.
 */

import { useMemo, useState, useCallback } from 'react';

export interface SortState { key: string; dir: 'asc' | 'desc' }
export type SortGetter<T> = (row: T) => string | number | null | undefined;

export function useTableSort<T>(
  rows: T[],
  columns: Record<string, SortGetter<T>>,
  initial?: SortState,
) {
  const [sort, setSort] = useState<SortState | null>(initial ?? null);

  const toggle = useCallback((key: string, defaultDir: 'asc' | 'desc' = 'asc') => {
    setSort(prev => (prev?.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: defaultDir }));
  }, []);

  // Programmatic sort (deep links like ?sort=ytd_spend) — same state the
  // header clicks drive, so the ▲/▼ indicators stay in agreement.
  const set = useCallback((next: SortState | null) => setSort(next), []);

  const sorted = useMemo(() => {
    const get = sort ? columns[sort.key] : null;
    if (!sort || !get) return rows;
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * mul;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- columns is a stable per-table literal
  }, [rows, sort]);

  return { sorted, sort, toggle, set };
}

export function SortableTh({ label, sortKey, sort, onToggle, defaultDir = 'asc', style, align }: {
  label: string;
  sortKey: string;
  sort: SortState | null;
  onToggle: (key: string, defaultDir?: 'asc' | 'desc') => void;
  defaultDir?: 'asc' | 'desc';
  style?: React.CSSProperties;
  align?: 'left' | 'right';
}) {
  const active = sort?.key === sortKey;
  return (
    <th
      onClick={() => onToggle(sortKey, defaultDir)}
      aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      title={`Sort by ${label.toLowerCase()}`}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', textAlign: align || 'left', ...style }}
    >
      {label}{' '}
      <span aria-hidden style={{ opacity: active ? 1 : 0.35, fontSize: '9px' }}>
        {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </th>
  );
}
