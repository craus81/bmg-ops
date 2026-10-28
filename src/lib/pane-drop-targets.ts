'use client';

// Split screen (src/lib/split-screen.ts): what a page in a pane does with a
// Client Files file dropped on it from the other side (Craig, 2026-10-28).
//
// A page that takes drops registers itself here while it's showing — a
// graphics job links the file, a saved estimate links it to the estimate.
// PaneBridge tells the page around the panes the label of the page's
// target ("Let go to add it to this estimate") and hands it the drop. With
// nothing registered, a drop opens the file in the Graphics Builder, as
// before. The last one registered wins.

import { useEffect, useRef } from 'react';

export interface DroppedClientFile { id: string; name: string }

export interface ClientFileDropTarget {
  /** What the file in hand says over this pane, e.g. "Let go to add it to this estimate". */
  label: string;
  onDrop: (file: DroppedClientFile) => void;
}

const targets: ClientFileDropTarget[] = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(fn => fn());

export function registerClientFileDropTarget(t: ClientFileDropTarget): () => void {
  targets.push(t);
  changed();
  return () => {
    const i = targets.lastIndexOf(t);
    if (i >= 0) targets.splice(i, 1);
    changed();
  };
}

/** The target a drop goes to now, or null to open the Graphics Builder. */
export const currentClientFileDropTarget = (): ClientFileDropTarget | null => targets[targets.length - 1] ?? null;

export function onClientFileDropTargetsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Take Client Files drops while mounted; a null label takes none. */
export function useClientFileDropTarget(label: string | null, onDrop: (file: DroppedClientFile) => void) {
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  useEffect(() => {
    if (!label) return;
    return registerClientFileDropTarget({ label, onDrop: f => dropRef.current(f) });
  }, [label]);
}
