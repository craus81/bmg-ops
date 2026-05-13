'use client';

import { CSSProperties } from 'react';
import { usePartInfo } from '@/lib/parts-cache';

interface Props {
  partNumber: string | null | undefined;
  /** Description from the source record (PO line, scan log, etc.). Used
   *  only if netsuite_parts has nothing better. */
  fallbackDescription?: string | null;
  /** Render just the kit name (no part-number prefix). */
  nameOnly?: boolean;
  style?: CSSProperties;
}

// Renders a part number alongside its kit/display name pulled from the
// netsuite_parts cache. Falls back to whatever description the caller
// passes in, and finally to just the part number if nothing else is known.
export function PartLabel({ partNumber, fallbackDescription, nameOnly, style }: Props) {
  const info = usePartInfo(partNumber);
  const name = info?.display_name || info?.description || fallbackDescription || null;

  if (nameOnly) {
    return <span style={style}>{name || partNumber || ''}</span>;
  }

  return (
    <span style={style}>
      {partNumber && (
        <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{partNumber}</span>
      )}
      {name && (
        <span style={{ marginLeft: partNumber ? '6px' : 0, color: 'var(--text-muted)', fontWeight: 400 }}>
          {partNumber ? '· ' : ''}{name}
        </span>
      )}
    </span>
  );
}
