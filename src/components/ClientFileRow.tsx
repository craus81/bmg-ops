'use client';

import { formatBytes, opensInGraphicsBuilder } from '@/lib/client-files';
import { deepLinks } from '@/lib/deep-links';
import { useAuth } from '@/components/AuthProvider';

/** One file as /api/client-files returns it (ClientFileItem there). */
export interface ClientFile {
  id: string;
  name: string;
  ext: string;
  kind: string;
  size: number;
  modified: string | null;
  folderPath: string;
  client: { folderId: string; name: string } | null;
  customer: { id: string; name: string; link: string | null } | null;
  copied: boolean;
  thumbUrl: string | null;
}

/** Opens (inline) or downloads one file; the route redirects to R2 or Dropbox. `name` lets the iPhone app label it. */
export function clientFileUrl(f: Pick<ClientFile, 'id' | 'name'>, download = false): string {
  const p = new URLSearchParams({ name: f.name });
  if (download) p.set('disposition', 'attachment');
  return `/api/client-files/${f.id}?${p.toString()}`;
}

const TILE_COLORS: Record<string, { bg: string; fg: string }> = {
  pdf: { bg: '#fecaca', fg: '#991b1b' },
  photo: { bg: '#bfdbfe', fg: '#1e3a8a' },
  print: { bg: '#fde68a', fg: '#92400e' },
  other: { bg: '#e5e7eb', fg: '#374151' },
};

export const fmtFileDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Thumbnail when Dropbox made one, otherwise a tile with the file type. */
export function FileTile({ file, size = 64 }: { file: ClientFile; size?: number }) {
  const c = TILE_COLORS[file.kind] || TILE_COLORS.other;
  return (
    <div style={{
      width: `${Math.round(size * 1.3)}px`, height: `${size}px`, borderRadius: '8px', flexShrink: 0, overflow: 'hidden',
      background: c.bg, color: c.fg, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 800, fontSize: size >= 60 ? '14px' : '11px', position: 'relative',
    }}>
      {(file.ext || file.kind).toUpperCase().slice(0, 4)}
      {file.thumbUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={file.thumbUrl} alt="" loading="lazy"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#fff' }}
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      )}
    </div>
  );
}

export function CopiedBadge({ copied }: { copied: boolean }) {
  return (
    <span
      title={copied ? 'Copied into FleetSuite: opens instantly' : 'Kept in Dropbox: fetched from there when you open it'}
      style={{
        fontSize: '10.5px', fontWeight: 800, borderRadius: '999px', padding: '2px 8px', whiteSpace: 'nowrap',
        background: copied ? 'rgba(22,163,74,0.15)' : 'rgba(59,130,246,0.15)',
        color: copied ? 'var(--success, #16a34a)' : '#60a5fa',
      }}
    >{copied ? 'Copied' : 'In Dropbox'}</span>
  );
}

interface RowProps {
  file: ClientFile;
  selected?: boolean;
  onSelect?: () => void;
  /** Click the client name to narrow the list to that folder. */
  onClient?: (folderId: string, name: string) => void;
  /** Hide the client name (the customer page already says whose files these are). */
  hideClient?: boolean;
  /** Click the folder path to open that folder in the folder browser (path below the client folder, "/"-separated). */
  onFolder?: (folderId: string, sub: string) => void;
  compact?: boolean;
  /** Pick mode for a zip download: shows a checkbox, and a tap on the row ticks it. */
  checked?: boolean;
  onCheck?: () => void;
}

export default function ClientFileRow({ file, selected, onSelect, onClient, hideClient, onFolder, compact, checked, onCheck }: RowProps) {
  const picking = !!onCheck;
  const { hasFeature } = useAuth();
  // A proof or picture opens in the Graphics Builder to be measured (not
  // while ticking files for a zip or a job: the tap there picks the file).
  const builder = !picking && hasFeature('graphics_builder') && opensInGraphicsBuilder(file);
  return (
    <div
      onClick={e => {
        // Links and buttons inside the row do their own thing. They must not
        // stopPropagation: the iPhone app's NativeLinkHandler listens on
        // window, and a stopped click never reaches it, so the link went to
        // Safari (no session: "Unauthorized", Craig 2026-10-16).
        if ((e.target as Element).closest?.('a, button')) return;
        (picking ? onCheck : onSelect)?.();
      }}
      style={{
        display: 'flex', alignItems: 'center', gap: compact ? '10px' : '12px',
        padding: compact ? '8px 0' : '10px 12px',
        borderRadius: compact ? 0 : '12px',
        background: compact ? 'transparent' : 'var(--card)',
        border: compact ? 'none' : `1px solid ${selected ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
        borderTop: compact ? '1px solid var(--border)' : undefined,
        cursor: onSelect || picking ? 'pointer' : 'default',
      }}
    >
      {picking && (
        <input
          type="checkbox" checked={!!checked} readOnly aria-label={`Pick ${file.name}`}
          style={{ width: '20px', height: '20px', flexShrink: 0, accentColor: 'var(--accent, #2563eb)', pointerEvents: 'none' }}
        />
      )}
      <FileTile file={file} size={compact ? 40 : 56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: compact ? '12.5px' : '14px', fontWeight: 700, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
          {file.name}
        </div>
        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '2px', overflowWrap: 'anywhere' }}>
          {!hideClient && file.client && (
            onClient ? (
              <button
                onClick={e => { e.stopPropagation(); onClient(file.client!.folderId, file.client!.name); }}
                title="Show only this client's files"
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--orange, #fb923c)', fontWeight: 700, fontSize: 'inherit' }}
              >{file.client.name}</button>
            ) : <span style={{ color: 'var(--orange, #fb923c)', fontWeight: 700 }}>{file.client.name}</span>
          )}
          {!hideClient && file.client && file.folderPath ? ' · ' : ''}
          {onFolder && file.client && file.folderPath ? (
            <button
              onClick={e => { e.stopPropagation(); onFolder(file.client!.folderId, file.folderPath.split(' › ').join('/')); }}
              title="Open this folder"
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#60a5fa', fontWeight: 600, fontSize: 'inherit', textAlign: 'left' }}
            >📁 {file.folderPath}</button>
          ) : file.folderPath}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{[fmtFileDate(file.modified), formatBytes(file.size)].filter(Boolean).join(' · ')}</span>
          <CopiedBadge copied={file.copied} />
        </div>
      </div>
      {builder && (
        <a
          href={deepLinks.graphicsBuilderFromClientFile(file.id)}
          title="Open in the Graphics Builder to measure it, then make the estimate"
          aria-label={`Open ${file.name} in the Graphics Builder`}
          style={{
            flexShrink: 0, padding: compact ? '6px 10px' : '8px 12px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
            background: 'rgba(6,182,212,0.12)', color: '#06b6d4', border: '1px solid rgba(6,182,212,0.4)',
            textDecoration: 'none', whiteSpace: 'nowrap',
          }}
        >🎨 Builder</a>
      )}
      <a
        href={clientFileUrl(file)}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          flexShrink: 0, padding: compact ? '6px 10px' : '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
          background: 'var(--accent, #2563eb)', color: '#fff', textDecoration: 'none', whiteSpace: 'nowrap',
        }}
      >Open</a>
    </div>
  );
}
