'use client';

/**
 * The invisible raycast target a drag moves against. Which plane depends on
 * the dragged item's zone (see src/lib/upfit-layout.ts): floor items slide
 * on the floor plane (y=0), wall items slide on their wall plane, ceiling
 * items on the ceiling plane. The plane is oversized so fast pointer moves
 * can't escape it mid-drag; invisible meshes still raycast in three.js,
 * which is exactly what makes this pattern work.
 */

import type { ThreeEvent } from '@react-three/fiber';
import { InteriorGeometry, Zone } from '@/lib/upfit-layout';

export interface DragPlaneProps {
  zone: Zone;
  interior: InteriorGeometry;
  onMove: (point: [number, number, number]) => void;
  onEnd: () => void;
}

export default function DragPlane({ zone, interior, onMove, onEnd }: DragPlaneProps) {
  const { length: L, width: W, height: H } = interior.cargo;
  const halfW = W / 2;
  const SIZE = Math.max(L, W, H) * 6;

  let position: [number, number, number];
  let rotation: [number, number, number];
  switch (zone) {
    case 'wall_left':
      position = [-halfW, H / 2, L / 2];
      rotation = [0, Math.PI / 2, 0];
      break;
    case 'wall_right':
      position = [halfW, H / 2, L / 2];
      rotation = [0, -Math.PI / 2, 0];
      break;
    case 'ceiling':
      position = [0, H, L / 2];
      rotation = [Math.PI / 2, 0, 0];
      break;
    default: // floor
      position = [0, 0, L / 2];
      rotation = [-Math.PI / 2, 0, 0];
  }

  const handleMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onMove([e.point.x, e.point.y, e.point.z]);
  };

  return (
    <mesh
      position={position}
      rotation={rotation}
      visible={false}
      onPointerMove={handleMove}
      onPointerUp={e => { e.stopPropagation(); onEnd(); }}
    >
      <planeGeometry args={[SIZE, SIZE]} />
    </mesh>
  );
}
