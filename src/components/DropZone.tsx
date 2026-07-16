'use client';

import { useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';

// Matches a File against an <input accept="..."> style filter so dropped
// files obey the same rules as picked ones. Empty/missing accept = allow all.
export function fileMatchesAccept(file: File, accept?: string | null): boolean {
  if (!accept) return true;
  const rules = accept.split(',').map(r => r.trim().toLowerCase()).filter(Boolean);
  if (rules.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return rules.some(rule => {
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

// Wraps any upload area to make it a drag-and-drop target. Dropped files run
// through the same accept/multiple rules as the file input they sit beside,
// then flow into the same handler via onFiles. Highlights while a file drag
// hovers over it; inert on touch devices (drag events never fire there).
export function DropZone({
  onFiles,
  accept,
  multiple = true,
  disabled = false,
  style,
  children,
}: {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const [active, setActive] = useState(false);
  // dragenter/dragleave also fire on every child element, so track depth —
  // the highlight only clears when the drag truly leaves the zone.
  const depth = useRef(0);

  const isFileDrag = (e: DragEvent) =>
    Array.from(e.dataTransfer?.types || []).includes('Files');

  const onDragEnter = (e: DragEvent) => {
    if (disabled || !isFileDrag(e)) return;
    e.preventDefault();
    depth.current += 1;
    setActive(true);
  };

  const onDragOver = (e: DragEvent) => {
    if (disabled || !isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (e: DragEvent) => {
    if (disabled || !isFileDrag(e)) return;
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setActive(false);
  };

  const onDrop = (e: DragEvent) => {
    if (disabled || !isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth.current = 0;
    setActive(false);
    let files = Array.from(e.dataTransfer.files).filter(f => fileMatchesAccept(f, accept));
    if (!multiple) files = files.slice(0, 1);
    if (files.length > 0) onFiles(files);
  };

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        ...style,
        ...(active ? {
          outline: '2px dashed #60a5fa',
          outlineOffset: '2px',
          borderRadius: '8px',
          background: 'rgba(96,165,250,0.08)',
        } : {}),
      }}
    >
      {children}
    </div>
  );
}
