'use client';

/**
 * The three.js boundary of the upfit designer. This file (and the upfit/
 * components it renders) is the ONLY place three enters the module graph,
 * and the page imports it through next/dynamic with ssr:false — keep it
 * that way so the ~350KB 3D chunk stays out of the app's first load.
 *
 * The scene is a pure view: layout state lives in the page (useReducer over
 * src/lib/upfit-layout.ts ops), items/selection/warnings arrive as props,
 * and edits leave as callbacks. The only state owned here is the transient
 * pointer-drag bookkeeping (which item, which plane, the grab offset).
 *
 * Capacitor/WebGL notes: frameloop="demand" only renders on state changes
 * (webview battery), dpr is capped, preserveDrawingBuffer stays on so
 * captureSnapshot() can read the canvas, and a webglcontextlost listener
 * tells the parent to remount (iOS reclaims GL contexts on backgrounding).
 */

import { useState, useEffect } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Line } from '@react-three/drei';
import {
  InteriorGeometry, PlacedItem as PlacedItemData, Zone,
} from '@/lib/upfit-layout';
import VanShell from './VanShell';
import PlacedItem from './PlacedItem';
import DragPlane from './DragPlane';

export interface UpfitSceneProps {
  interior: InteriorGeometry;
  items: PlacedItemData[];
  selectedUid: string | null;
  /** uids with any layout warning (overlap / out of shell / on a well). */
  warningUids: string[];
  /** Snap guide planes to draw during a drag. */
  guides: { axis: 'x' | 'z'; at: number }[];
  showLabels: boolean;
  /** false = viewer mode (template preview, review step) — no drag. */
  editable: boolean;
  onSelect: (uid: string | null) => void;
  /**
   * Drag stream: 'move' carries the proposed [x,y,z] (already grab-offset
   * corrected; the page applies zone rules + snapping), 'end' closes the
   * gesture (pos is null).
   */
  onItemMove: (uid: string, pos: [number, number, number] | null, phase: 'move' | 'end') => void;
  onContextLost: () => void;
  /**
   * Hands the parent a capture function (PNG of the current view — for the
   * design thumbnail and the layout PDF). A callback prop rather than a ref
   * because next/dynamic — the only way this component is ever imported —
   * does not forward refs.
   */
  onCaptureReady?: (fn: () => Promise<Blob | null>) => void;
}

/** Registers the snapshot function with the parent ref — needs useThree, so
 *  it must live inside the Canvas. Renders explicitly first: with
 *  frameloop="demand" the last painted frame can be stale. */
function CaptureBridge({ register }: { register: (fn: () => Promise<Blob | null>) => void }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    register(() => new Promise(resolve => {
      gl.render(scene, camera);
      gl.domElement.toBlob(b => resolve(b), 'image/png');
    }));
  }, [gl, scene, camera, register]);
  return null;
}

interface DragState {
  uid: string;
  zone: Zone;
  offset: [number, number, number];
}

export default function UpfitScene(
  { interior, items, selectedUid, warningUids, guides, showLabels, editable, onSelect, onItemMove, onContextLost, onCaptureReady }: UpfitSceneProps,
) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const warnSet = new Set(warningUids);

  const { length: L, width: W, height: H } = interior.cargo;

  const handleItemPointerDown = (e: ThreeEvent<PointerEvent>, item: PlacedItemData) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.stopPropagation();
    onSelect(item.uid);
    if (!editable) return;
    setDrag({
      uid: item.uid,
      zone: item.zone,
      offset: [item.pos[0] - e.point.x, item.pos[1] - e.point.y, item.pos[2] - e.point.z],
    });
  };

  const handleDragMove = (point: [number, number, number]) => {
    if (!drag) return;
    onItemMove(drag.uid, [point[0] + drag.offset[0], point[1] + drag.offset[1], point[2] + drag.offset[2]], 'move');
  };

  const endDrag = () => {
    if (!drag) return;
    onItemMove(drag.uid, null, 'end');
    setDrag(null);
  };

  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 1.5]}
      gl={{ preserveDrawingBuffer: true, antialias: true }}
      camera={{ position: [W * 1.1, H * 1.4, L * 1.55], fov: 40, near: 1, far: 4000 }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener('webglcontextlost', e => {
          e.preventDefault();
          onContextLost();
        });
      }}
      onPointerMissed={() => onSelect(null)}
      // Pointer leaving the canvas mid-drag would otherwise strand the item
      // on the cursor — treat it as a drop.
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      style={{ touchAction: 'none' }}
    >
      <ambientLight intensity={0.85} />
      <directionalLight position={[W, H * 2.2, L * 0.4]} intensity={0.9} />
      <directionalLight position={[-W, H * 1.6, L * 1.4]} intensity={0.35} />

      <VanShell interior={interior} />

      {items.map(item => (
        <PlacedItem
          key={item.uid}
          item={item}
          selected={item.uid === selectedUid}
          warning={warnSet.has(item.uid)}
          showLabel={showLabels}
          onPointerDown={handleItemPointerDown}
        />
      ))}

      {drag && (
        <DragPlane zone={drag.zone} interior={interior} onMove={handleDragMove} onEnd={endDrag} />
      )}

      {drag && guides.map((g, i) => (
        <Line
          key={`${g.axis}-${g.at}-${i}`}
          points={g.axis === 'x'
            ? [[g.at, 0.3, 0], [g.at, 0.3, L]]
            : [[-W / 2, 0.3, g.at], [W / 2, 0.3, g.at]]}
          color="#4da3ff"
          lineWidth={1.5}
          dashed
          dashSize={2.5}
          gapSize={1.5}
        />
      ))}

      <OrbitControls
        makeDefault
        enabled={!drag}
        target={[0, H / 2.5, L / 2]}
        maxPolarAngle={Math.PI / 2 - 0.02}
        minDistance={30}
        maxDistance={L * 4}
      />
      {onCaptureReady && <CaptureBridge register={onCaptureReady} />}
    </Canvas>
  );
}
