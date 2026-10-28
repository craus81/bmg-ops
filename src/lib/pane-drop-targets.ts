'use client';

// Split screen (src/lib/split-screen.ts): what a page in a pane does with
// something dropped on it from the other side (Craig, 2026-10-28).
//
//  - a Client Files file: a graphics job or saved estimate links it; with
//    nothing registered it opens in the Graphics Builder, as before;
//  - parts and kits ("lines"): the estimate builder adds them where they
//    were let go; with nothing registered there's nowhere to put them.
//
// A page that takes drops registers itself here while it's showing.
// PaneBridge tells the page around the panes the label of the page's
// target ("Let go to add it to this estimate"), passes it where the thing
// in hand is while it's over this side, and hands it the drop. The last
// one registered for a kind wins.

import { useEffect, useRef, useState } from 'react';
import { isPaneWindow } from '@/lib/split-screen';
import type { KitEstimateLine } from '@/lib/part-kits';

export interface DroppedClientFile { id: string; name: string }

/** A part or kit in hand: the estimate lines it becomes, built where it was picked up. */
export interface DroppedLines {
  name: string;
  lines: KitEstimateLine[];
  /** Set for one catalog part, so a second copy can go on its quantity instead. */
  partId: string | null;
}

/** Where the thing in hand is, in this pane's viewport px. */
export interface DropPoint { x: number; y: number }

export interface DropPayloads { 'client-file': DroppedClientFile; lines: DroppedLines }
export type DropKind = keyof DropPayloads;

export interface DropTarget<K extends DropKind = DropKind> {
  /** What the thing in hand says over this pane, e.g. "Let go to add it to this estimate". */
  label: string;
  onDrop: (payload: DropPayloads[K], at: DropPoint) => void;
  /** Over this pane (a point) or gone (null): for showing where it would land. */
  onOver?: (at: DropPoint | null) => void;
}

/** Back-compat name for the Client Files target. */
export type ClientFileDropTarget = DropTarget<'client-file'>;

const targets: { [K in DropKind]: DropTarget<K>[] } = { 'client-file': [], lines: [] };
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(fn => fn());

export function registerDropTarget<K extends DropKind>(kind: K, t: DropTarget<K>): () => void {
  const list = targets[kind] as DropTarget<K>[];
  list.push(t);
  changed();
  return () => {
    const i = list.lastIndexOf(t);
    if (i >= 0) list.splice(i, 1);
    changed();
  };
}

export const currentDropTarget = <K extends DropKind>(kind: K): DropTarget<K> | null =>
  (targets[kind] as DropTarget<K>[])[targets[kind].length - 1] ?? null;

export const registerClientFileDropTarget = (t: ClientFileDropTarget) => registerDropTarget('client-file', t);
/** The target a Client Files drop goes to now, or null to open the Graphics Builder. */
export const currentClientFileDropTarget = () => currentDropTarget('client-file');

export function onDropTargetsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export const onClientFileDropTargetsChange = onDropTargetsChange;

/** Take drops of one kind while mounted; a null label takes none. */
export function useDropTarget<K extends DropKind>(
  kind: K, label: string | null,
  onDrop: DropTarget<K>['onDrop'], onOver?: DropTarget<K>['onOver'],
) {
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const overRef = useRef(onOver);
  overRef.current = onOver;
  useEffect(() => {
    if (!label) return;
    return registerDropTarget(kind, {
      label,
      onDrop: (p, at) => dropRef.current(p, at),
      onOver: at => overRef.current?.(at),
    });
  }, [kind, label]);
}

/** Take Client Files drops while mounted; a null label takes none. */
export function useClientFileDropTarget(label: string | null, onDrop: (file: DroppedClientFile) => void) {
  useDropTarget('client-file', label, f => onDrop(f));
}

// ── Parts and kits that can be picked up ──
// A card or row marks itself with data-pane-lines="<key>" (paneLinesSource)
// and PaneBridge builds what's in hand from it when the drag starts. Only
// inside a pane, so nothing changes on a plain page.

const sources = new Map<string, () => DroppedLines>();

/** Props that make an element draggable to an estimate on the other side. */
export function paneLinesSource(key: string, build: () => DroppedLines, inPane: boolean): { 'data-pane-lines'?: string } {
  if (!inPane) return {};
  sources.set(key, build);
  return { 'data-pane-lines': key };
}

export function linesFromSource(key: string): DroppedLines | null {
  const build = sources.get(key);
  if (!build) return null;
  try { return build(); } catch { return null; }
}

/** True once mounted inside a split-screen pane (false while rendering on the server). */
export function useInPane(): boolean {
  const [inPane, setInPane] = useState(false);
  useEffect(() => { setInPane(isPaneWindow()); }, []);
  return inPane;
}
