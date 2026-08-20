'use client';

/**
 * One placed product in the 3D scene: a category-colored box with edges and
 * an item-number label. Parametric on purpose (v1 renders every SKU as its
 * dimensioned box) — `resolveItemMesh` is the single seam where per-SKU GLB
 * meshes plug in later (a model_path column + a GLTF branch here), without
 * touching the scene, the layout math, or the page.
 */

import { memo } from 'react';
import { Edges, Html } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { PlacedItem as PlacedItemData, categoryColor, footprint } from '@/lib/upfit-layout';

export interface PlacedItemProps {
  item: PlacedItemData;
  selected: boolean;
  /** Any layout warning (overlap / out of shell / on a wheel well). */
  warning: boolean;
  showLabel: boolean;
  onPointerDown: (e: ThreeEvent<PointerEvent>, item: PlacedItemData) => void;
}

/** The mesh for one item. v1: a box from the snapshotted dims. Later: branch
 *  on a per-SKU model reference here and fall back to the box. */
function resolveItemMesh(item: PlacedItemData, color: string, warning: boolean, selected: boolean) {
  const { fw, fd } = footprint(item);
  return (
    <>
      <boxGeometry args={[fw, item.h, fd]} />
      <meshStandardMaterial
        color={warning ? '#b34040' : color}
        transparent
        opacity={selected ? 0.95 : 0.85}
        roughness={0.7}
      />
    </>
  );
}

function PlacedItemMesh({ item, selected, warning, showLabel, onPointerDown }: PlacedItemProps) {
  const color = categoryColor(item.category);
  const { fw, fd } = footprint(item);
  const [cx, by, cz] = item.pos;
  return (
    <group position={[cx, by + item.h / 2, cz]}>
      <mesh
        onPointerDown={e => onPointerDown(e, item)}
        castShadow
      >
        {resolveItemMesh(item, color, warning, selected)}
        <Edges color={selected ? '#ffffff' : warning ? '#ff6b6b' : '#1f2530'} lineWidth={selected ? 2 : 1} />
      </mesh>
      {(showLabel || selected) && (
        <Html
          position={[0, item.h / 2 + 3, 0]}
          center
          distanceFactor={140}
          style={{ pointerEvents: 'none', userSelect: 'none' }}
          zIndexRange={[10, 0]}
        >
          <div style={{
            padding: '2px 7px', borderRadius: '6px', whiteSpace: 'nowrap',
            background: selected ? 'rgba(37,99,235,0.92)' : 'rgba(15,18,24,0.82)',
            color: '#fff', fontSize: '11px', fontWeight: 700, fontFamily: 'system-ui, sans-serif',
            border: warning ? '1px solid #ff6b6b' : '1px solid rgba(255,255,255,0.15)',
          }}>
            {item.item_number}
            <span style={{ opacity: 0.75, fontWeight: 500 }}> · {fw}×{fd}×{item.h}&quot;</span>
          </div>
        </Html>
      )}
    </group>
  );
}

export default memo(PlacedItemMesh);
