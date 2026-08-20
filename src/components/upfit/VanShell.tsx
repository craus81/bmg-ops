'use client';

/**
 * The van's cargo interior, drawn parametrically from a vehicle_interiors
 * geometry row — no 3D assets anywhere: floor, translucent walls, wheel-well
 * solids, and door apertures are all boxes/planes/lines sized in inches
 * (the scene's world units, see src/lib/upfit-layout.ts for the coordinate
 * system). Walls stay translucent so the layout reads from any orbit angle;
 * the rear face is drawn as an outline only, since that's the natural
 * "looking into the van" viewpoint.
 */

import { useEffect, useMemo } from 'react';
import { BoxGeometry } from 'three';
import { Line } from '@react-three/drei';
import { InteriorGeometry, wheelwellBoxes } from '@/lib/upfit-layout';

const WALL_OPACITY = 0.14;
const WALL_COLOR = '#8899aa';
const FLOOR_COLOR = '#3d434c';
const WELL_COLOR = '#5a616c';
const DOOR_COLOR = '#c9a227';

/** A rectangle outline on a wall plane, for door apertures. */
function DoorOutline({ points }: { points: [number, number, number][] }) {
  return <Line points={[...points, points[0]]} color={DOOR_COLOR} lineWidth={1.5} dashed dashSize={3} gapSize={2} />;
}

export default function VanShell({ interior }: { interior: InteriorGeometry }) {
  const { length: L, width: W, height: H } = interior.cargo;
  const halfW = W / 2;
  const wells = wheelwellBoxes(interior);
  const side = interior.doors?.side;
  const rear = interior.doors?.rear;
  // Geometry instances aren't managed by R3F when passed as args — memoize so
  // orbiting doesn't rebuild them every render, and dispose by hand (GPU
  // buffers otherwise outlive the scene; on webview GL that memory is scarce).
  const outlineBox = useMemo(() => new BoxGeometry(W, H, L), [W, H, L]);
  useEffect(() => () => outlineBox.dispose(), [outlineBox]);

  return (
    <group>
      {/* Floor — solid, the ground everything sits on. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, L / 2]} receiveShadow>
        <planeGeometry args={[W, L]} />
        <meshStandardMaterial color={FLOOR_COLOR} roughness={0.95} />
      </mesh>

      {/* Walls + bulkhead — translucent, double-sided so the interior stays
          visible whichever side the camera is on. */}
      <mesh position={[-halfW, H / 2, L / 2]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[L, H]} />
        <meshStandardMaterial color={WALL_COLOR} transparent opacity={WALL_OPACITY} side={2} depthWrite={false} />
      </mesh>
      <mesh position={[halfW, H / 2, L / 2]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[L, H]} />
        <meshStandardMaterial color={WALL_COLOR} transparent opacity={WALL_OPACITY} side={2} depthWrite={false} />
      </mesh>
      <mesh position={[0, H / 2, 0]}>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial color={WALL_COLOR} transparent opacity={WALL_OPACITY + 0.08} side={2} depthWrite={false} />
      </mesh>

      {/* Cargo-volume outline — the box's edges, so the open rear and top
          still read as boundaries. */}
      <lineSegments position={[0, H / 2, L / 2]}>
        <edgesGeometry args={[outlineBox]} />
        <lineBasicMaterial color="#aab4c0" />
      </lineSegments>

      {/* Wheel wells — solid boxes; the layout math treats them as solids too. */}
      {wells.map((w, i) => (
        <mesh key={i} position={[(w.minX + w.maxX) / 2, (w.minY + w.maxY) / 2, (w.minZ + w.maxZ) / 2]}>
          <boxGeometry args={[w.maxX - w.minX, w.maxY - w.minY, w.maxZ - w.minZ]} />
          <meshStandardMaterial color={WELL_COLOR} roughness={0.9} />
        </mesh>
      ))}

      {/* Door apertures — dashed outlines on their walls, a reminder of what
          must stay reachable (blocking one is legal but visible). */}
      {side && (() => {
        const x = side.side === 'left' ? -halfW : halfW;
        const z0 = side.from_bulkhead;
        return (
          <DoorOutline points={[
            [x, 1, z0], [x, side.height, z0], [x, side.height, z0 + side.width], [x, 1, z0 + side.width],
          ]} />
        );
      })()}
      {rear && (() => {
        const hw = rear.width / 2;
        return (
          <DoorOutline points={[
            [-hw, 1, L], [-hw, rear.height, L], [hw, rear.height, L], [hw, 1, L],
          ]} />
        );
      })()}
    </group>
  );
}
