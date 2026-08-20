// Geometry for drawing engineering-style dimension lines: two picked
// points, extension lines out to an offset dimension line, arrowheads,
// and a label anchor at the midpoint. Shared by the interactive editor
// (SVG) and the PDF export (canvas), so both render identically.

export interface Pt {
  x: number;
  y: number;
}

export interface DimensionLayout {
  /** Extension line from point A toward the dimension line. */
  extA: [Pt, Pt];
  /** Extension line from point B toward the dimension line. */
  extB: [Pt, Pt];
  /** The dimension line itself (arrow tip to arrow tip). */
  dim: [Pt, Pt];
  /** Arrowhead polygons (3 points each) at the two dimension line ends. */
  arrowA: [Pt, Pt, Pt];
  arrowB: [Pt, Pt, Pt];
  /** Label anchor: midpoint of the dimension line. */
  label: Pt;
  /** Unit vector perpendicular to A→B (the offset direction actually used). */
  normal: Pt;
  /** Label rotation in degrees, kept upright (-90..90). */
  angleDeg: number;
}

/**
 * Lay out a dimension between `a` and `b`, with the dimension line pushed
 * `offset` px along the perpendicular (sign picks the side). `gap` keeps
 * extension lines from touching the picked points; `overshoot` extends
 * them slightly past the dimension line, drafting-style.
 */
export function layoutDimension(
  a: Pt,
  b: Pt,
  offset: number,
  opts?: { gap?: number; overshoot?: number; arrowLength?: number; arrowWidth?: number },
): DimensionLayout {
  const gap = opts?.gap ?? 4;
  const overshoot = opts?.overshoot ?? 6;
  const arrowLength = opts?.arrowLength ?? 10;
  const arrowWidth = opts?.arrowWidth ?? 7;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular; offset sign selects the side.
  const nx = -uy;
  const ny = ux;

  const off = offset;
  const dimA: Pt = { x: a.x + nx * off, y: a.y + ny * off };
  const dimB: Pt = { x: b.x + nx * off, y: b.y + ny * off };

  const sign = off === 0 ? 1 : Math.sign(off);
  const extStart = gap * sign;
  const extEnd = off + overshoot * sign;
  const extA: [Pt, Pt] = [
    { x: a.x + nx * extStart, y: a.y + ny * extStart },
    { x: a.x + nx * extEnd, y: a.y + ny * extEnd },
  ];
  const extB: [Pt, Pt] = [
    { x: b.x + nx * extStart, y: b.y + ny * extStart },
    { x: b.x + nx * extEnd, y: b.y + ny * extEnd },
  ];

  // Arrowheads point outward along the dimension line toward its ends.
  const arrowAt = (tip: Pt, dirX: number, dirY: number): [Pt, Pt, Pt] => {
    const bx = tip.x - dirX * arrowLength;
    const by = tip.y - dirY * arrowLength;
    const hw = arrowWidth / 2;
    return [
      { x: tip.x, y: tip.y },
      { x: bx + nx * hw, y: by + ny * hw },
      { x: bx - nx * hw, y: by - ny * hw },
    ];
  };

  let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angleDeg > 90) angleDeg -= 180;
  if (angleDeg < -90) angleDeg += 180;

  return {
    extA,
    extB,
    dim: [dimA, dimB],
    arrowA: arrowAt(dimA, -ux, -uy),
    arrowB: arrowAt(dimB, ux, uy),
    label: { x: (dimA.x + dimB.x) / 2, y: (dimA.y + dimB.y) / 2 },
    normal: { x: nx, y: ny },
    angleDeg,
  };
}

/** Distance from point p to segment ab — used for click-to-select. */
export function pointToSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}
