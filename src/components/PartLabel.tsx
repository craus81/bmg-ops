'use client';

import { CSSProperties } from 'react';
import { usePartInfo } from '@/lib/parts-cache';
import { deepLinks } from '@/lib/deep-links';

interface Props {
  partNumber: string | null | undefined;
  /** Description from the source record (PO line, scan log, etc.). Used
   *  only if netsuite_parts has nothing better. */
  fallbackDescription?: string | null;
  /** Render just the kit name (no part-number prefix). */
  nameOnly?: boolean;
  style?: CSSProperties;
}

// Just the part number, linked to its record on the Parts page when the
// netsuite_parts cache knows it (plain text otherwise). For dense spots that
// don't want the kit-name suffix PartLabel adds.
export function PartNumberLink({ partNumber, style }: { partNumber: string; style?: CSSProperties }) {
  const info = usePartInfo(partNumber);
  if (!info?.id) return <span style={style}>{partNumber}</span>;
  return (
    <a
      className="part-link"
      href={deepLinks.part(info.id)}
      target="_blank"
      rel="noreferrer"
      title="Open part record"
      onClick={e => e.stopPropagation()}
      style={style}
    >{partNumber}</a>
  );
}

// Renders a part number alongside its kit/display name pulled from the
// netsuite_parts cache. Falls back to whatever description the caller
// passes in, and finally to just the part number if nothing else is known.
// When the cache knows the part, the number links to its record on the
// Parts page (new tab, so list workflows aren't lost mid-task).
export function PartLabel({ partNumber, fallbackDescription, nameOnly, style }: Props) {
  const info = usePartInfo(partNumber);
  const name = info?.display_name || info?.description || fallbackDescription || null;

  if (nameOnly) {
    return <span style={style}>{name || partNumber || ''}</span>;
  }

  return (
    <span style={style}>
      {partNumber && (info?.id ? (
        <a
          className="part-link"
          href={deepLinks.part(info.id)}
          target="_blank"
          rel="noreferrer"
          title="Open part record"
          onClick={e => e.stopPropagation()}
          style={{ fontFamily: 'monospace', fontWeight: 700 }}
        >{partNumber}</a>
      ) : (
        <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{partNumber}</span>
      ))}
      {name && (
        <span style={{ marginLeft: partNumber ? '6px' : 0, color: 'var(--text-muted)', fontWeight: 400 }}>
          {partNumber ? '· ' : ''}{name}
        </span>
      )}
    </span>
  );
}
