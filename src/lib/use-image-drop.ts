'use client';

import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { isHeicFile } from '@/lib/heic';

// Drag-and-drop and paste for a single picture box. Craig asked for it on
// the Create Part form and the Parts catalog record (2026-10-16): drop a
// file from the desktop, or copy an image / take a screenshot and paste it.
// The existing "choose file" button stays; phones are unaffected.

/** First image in a dropped or pasted file list (HEIC counts, since uploads convert it). */
export function firstImageFile(files: ArrayLike<File> | null | undefined): File | null {
  return imageFiles(files)[0] ?? null;
}

/** Every image in a dropped or pasted file list, in order (HEIC counts). */
export function imageFiles(files: ArrayLike<File> | null | undefined): File[] {
  if (!files) return [];
  const out: File[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if ((f.type || '').toLowerCase().startsWith('image/') || isHeicFile(f)) out.push(f);
  }
  return out;
}

/** Clipboard screenshots arrive as "image.png"; give them a usable name. */
export function namePastedImage(file: File, now = new Date()): File {
  if (file.name && file.name !== 'image.png' && file.name !== 'image.jpg') return file;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return new File([file], `pasted-${stamp}.${ext}`, { type: file.type });
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');

/**
 * Returns drag handlers to spread on the picture box and whether a file is
 * hovering over it. While `pasteEnabled` is true, pasting an image anywhere
 * on the page (outside a text field holding text) hands it to `onFile`.
 */
export function useImageDrop(onFile: (file: File) => void, opts: { disabled?: boolean; pasteEnabled?: boolean } = {}) {
  return useImagesDrop(files => onFile(files[0]), opts);
}

/**
 * Same as useImageDrop, for boxes that take several pictures at once (Scans,
 * 2026-10-28): every image dropped or pasted arrives together, never empty.
 */
export function useImagesDrop(onFiles: (files: File[]) => void, opts: { disabled?: boolean; pasteEnabled?: boolean } = {}) {
  const { disabled = false, pasteEnabled = true } = opts;
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const onFileRef = useRef(onFiles);
  onFileRef.current = onFiles;

  useEffect(() => {
    if (!pasteEnabled || disabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const imgs = imageFiles(e.clipboardData?.files);
      if (imgs.length === 0) return; // plain text paste: leave it alone
      e.preventDefault();
      onFileRef.current(imgs.map(f => namePastedImage(f)));
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [pasteEnabled, disabled]);

  useEffect(() => { if (disabled) { depth.current = 0; setDragging(false); } }, [disabled]);

  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Always prevent default over the box so a missed drop doesn't open the image in the tab.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (disabled) return;
      const imgs = imageFiles(e.dataTransfer?.files);
      if (imgs.length > 0) onFileRef.current(imgs);
    },
  };

  return { dragging, dropProps };
}
