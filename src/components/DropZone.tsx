'use client';

import { useCallback, useRef, useState, ReactNode, CSSProperties } from 'react';

/**
 * Returns true if `file` satisfies an HTML input `accept` string
 * (e.g. "image/*", "application/pdf,image/*", ".csv,.txt").
 * An empty/undefined accept matches everything.
 */
export function fileMatchesAccept(file: File, accept?: string): boolean {
  if (!accept || !accept.trim()) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return accept.split(',').some((raw) => {
    const token = raw.trim().toLowerCase();
    if (!token) return false;
    if (token.startsWith('.')) {
      // Extension match. Files dragged from disk always have a name.
      return name.endsWith(token);
    }
    if (token.endsWith('/*')) {
      // Wildcard MIME, e.g. "image/*".
      const prefix = token.slice(0, token.length - 1); // keep trailing slash
      return type.startsWith(prefix);
    }
    return type === token;
  });
}

/** Pull the dropped files off a drag event and apply accept/multiple filtering. */
export function filesFromDataTransfer(
  dataTransfer: DataTransfer | null,
  accept?: string,
  multiple = true
): File[] {
  if (!dataTransfer) return [];
  let files = Array.from(dataTransfer.files || []);
  if (accept) files = files.filter((f) => fileMatchesAccept(f, accept));
  if (!multiple) files = files.slice(0, 1);
  return files;
}

interface DragHandlers {
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

/**
 * Headless drag-and-drop file logic. Returns `isDragging` plus the handlers
 * to spread onto whatever element should act as the drop target. Use this when
 * wrapping content in an extra <div> would break layout; otherwise prefer the
 * <DropZone> component below.
 */
export function useFileDrop(
  onFiles: (files: File[]) => void,
  opts: { accept?: string; multiple?: boolean; disabled?: boolean } = {}
): { isDragging: boolean; dragHandlers: DragHandlers } {
  const { accept, multiple = true, disabled = false } = opts;
  const [isDragging, setIsDragging] = useState(false);
  // Counter so dragging across child elements doesn't flicker the highlight.
  const depth = useRef(0);

  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types || []).includes('Files');

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current += 1;
      setIsDragging(true);
    },
    [disabled]
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    },
    [disabled]
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setIsDragging(false);
    },
    [disabled]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setIsDragging(false);
      const files = filesFromDataTransfer(e.dataTransfer, accept, multiple);
      if (files.length) onFiles(files);
    },
    [disabled, accept, multiple, onFiles]
  );

  return { isDragging, dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}

interface DropZoneProps {
  /** Called with the dropped files (already filtered by `accept`/`multiple`). */
  onFiles: (files: File[]) => void;
  /** Same syntax as an <input accept> attribute. Non-matching files are ignored. */
  accept?: string;
  /** If false, only the first matching file is passed. Defaults to true. */
  multiple?: boolean;
  /** When true, drops are ignored and no highlight is shown. */
  disabled?: boolean;
  children: ReactNode;
  /** Extra styles for the wrapper element. */
  style?: CSSProperties;
  className?: string;
  /** Text shown in the highlight overlay while dragging. */
  overlayLabel?: string;
}

/**
 * Wraps existing upload UI to add drag-and-drop. The wrapped UI keeps working
 * exactly as before (button + hidden <input>); dropping files onto it calls
 * `onFiles` with the same File[] the input would have produced.
 */
export default function DropZone({
  onFiles,
  accept,
  multiple = true,
  disabled = false,
  children,
  style,
  className,
  overlayLabel = 'Drop file to upload',
}: DropZoneProps) {
  const { isDragging, dragHandlers } = useFileDrop(onFiles, { accept, multiple, disabled });

  return (
    <div
      {...dragHandlers}
      className={className}
      style={{ position: 'relative', ...style }}
    >
      {children}
      {isDragging && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'inherit',
            border: '2px dashed var(--orange)',
            background: 'var(--orange-soft)',
            color: 'var(--orange)',
            fontSize: '13px',
            fontWeight: 700,
            pointerEvents: 'none',
            textAlign: 'center',
            padding: '8px',
          }}
        >
          {overlayLabel}
        </div>
      )}
    </div>
  );
}
