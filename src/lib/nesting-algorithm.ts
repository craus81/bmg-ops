import type { GraphicElement, ElementWithBleed, NestedElement, RollNestingResult } from './types';

/**
 * Apply bleed margin to graphic elements
 */
export function applyBleed(elements: GraphicElement[], bleedIn: number): ElementWithBleed[] {
  return elements.map(el => ({
    element: el,
    bleed_in: bleedIn,
    total_width_in: el.width_in + bleedIn * 2,
    total_height_in: el.height_in + bleedIn * 2,
  }));
}

/**
 * Maximal Rectangles Best Area Fit (MAXRECTS-BAF) bin packing.
 *
 * Key improvements over the previous guillotine approach:
 *  1. Always tries BOTH orientations (normal + rotated 90°) and picks whichever
 *     fits better — critical for tall narrow elements like bed stripes that
 *     should lay horizontally on a 60" wide roll.
 *  2. Uses "best short side fit" scoring: among all free rects that can hold
 *     the element, pick the one where the leftover space on the shorter side
 *     is minimized. This produces tighter packing.
 *  3. Maintains a maximal free rectangles list with overlap merging, which
 *     recovers usable space that guillotine splits lose.
 */

interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Split oversized elements (both dimensions > rollWidth) into panels.
 * Each panel's shorter dimension ≤ rollWidth so it can be rotated onto the roll.
 * Panels are named "{element_name}-1", "{element_name}-2", etc.
 */
function panelizeOversized(
  elements: ElementWithBleed[],
  rollWidthIn: number
): ElementWithBleed[] {
  const result: ElementWithBleed[] = [];

  for (const ewb of elements) {
    const tw = ewb.total_width_in;
    const th = ewb.total_height_in;

    // If at least one dimension fits the roll, no split needed
    if (tw <= rollWidthIn || th <= rollWidthIn) {
      result.push(ewb);
      continue;
    }

    // Both dimensions exceed roll width.
    // Split the shorter dimension into panels ≤ rollWidth.
    // Each panel can then be rotated (short side as width) to fit the roll.
    const shorter = Math.min(tw, th);
    const longer = Math.max(tw, th);
    const splitWidth = tw === shorter; // true → split along width

    const numPanels = Math.ceil(shorter / rollWidthIn);
    const panelShorter = Math.round((shorter / numPanels) * 10) / 10;

    for (let i = 0; i < numPanels; i++) {
      const panelTW = splitWidth ? panelShorter : longer;
      const panelTH = splitWidth ? longer : panelShorter;

      result.push({
        element: {
          ...ewb.element,
          element_name: `${ewb.element.element_name}-${i + 1}`,
          width_in: panelTW - ewb.bleed_in * 2,
          height_in: panelTH - ewb.bleed_in * 2,
        },
        bleed_in: ewb.bleed_in,
        total_width_in: panelTW,
        total_height_in: panelTH,
      });
    }
  }

  return result;
}

export function nestElementsOnRoll(
  elementsWithBleed: ElementWithBleed[],
  rollWidthIn: number = 60,
  maxLengthIn: number = 1800
): RollNestingResult {
  if (elementsWithBleed.length === 0) {
    return {
      roll_width_in: rollWidthIn,
      roll_length_in: 0,
      roll_area_sqft: 0,
      nested_elements: [],
      efficiency_pct: 0,
    };
  }

  // Split oversized elements (both dims > roll width) into panels
  const panelized = panelizeOversized(elementsWithBleed, rollWidthIn);

  // Sort by height descending — place tallest pieces first so shorter ones
  // can fill gaps beside them. Break ties by area descending.
  const sorted = [...panelized].sort((a, b) => {
    const maxA = Math.max(a.total_width_in, a.total_height_in);
    const maxB = Math.max(b.total_width_in, b.total_height_in);
    if (Math.abs(maxB - maxA) > 0.1) return maxB - maxA;
    return (b.total_width_in * b.total_height_in) - (a.total_width_in * a.total_height_in);
  });

  // Start with one large free rectangle (the entire roll)
  let freeRects: FreeRect[] = [{ x: 0, y: 0, w: rollWidthIn, h: maxLengthIn }];
  const placed: NestedElement[] = [];

  for (const ewb of sorted) {
    const ew = ewb.total_width_in;
    const eh = ewb.total_height_in;

    // Build candidate orientations — always try both
    const orientations: { pw: number; ph: number; rotated: boolean }[] = [];
    if (ew <= rollWidthIn) orientations.push({ pw: ew, ph: eh, rotated: false });
    if (eh <= rollWidthIn && Math.abs(eh - ew) > 0.01) orientations.push({ pw: eh, ph: ew, rotated: true });

    if (orientations.length === 0) {
      console.warn(`Element "${ewb.element.element_name}" exceeds roll width. Skipping.`);
      continue;
    }

    // Find the best free rect using "Best Short Side Fit":
    // Place where min(leftover_w, leftover_h) is smallest — tightest fit.
    // Among ties, prefer lower Y (pack towards the top of the roll).
    let bestFreeIdx = -1;
    let bestOri = orientations[0];
    let bestShortSide = Infinity;
    let bestY = Infinity;

    for (let fi = 0; fi < freeRects.length; fi++) {
      const fr = freeRects[fi];
      for (const ori of orientations) {
        if (ori.pw <= fr.w && ori.ph <= fr.h) {
          const leftoverW = fr.w - ori.pw;
          const leftoverH = fr.h - ori.ph;
          const shortSide = Math.min(leftoverW, leftoverH);
          const y = fr.y;
          if (shortSide < bestShortSide || (shortSide === bestShortSide && y < bestY)) {
            bestShortSide = shortSide;
            bestY = y;
            bestFreeIdx = fi;
            bestOri = ori;
          }
        }
      }
    }

    if (bestFreeIdx < 0) {
      console.warn(`No space for "${ewb.element.element_name}". Skipping.`);
      continue;
    }

    const fr = freeRects[bestFreeIdx];
    const px = fr.x;
    const py = fr.y;

    placed.push({
      element: ewb.element,
      bleed_in: ewb.bleed_in,
      total_width_in: bestOri.pw,
      total_height_in: bestOri.ph,
      x_in: px,
      y_in: py,
      rotated: bestOri.rotated,
    });

    // The placed rectangle
    const usedRect: FreeRect = { x: px, y: py, w: bestOri.pw, h: bestOri.ph };

    // Split every existing free rect that overlaps with the placed element
    const newFreeRects: FreeRect[] = [];
    for (const rect of freeRects) {
      if (!rectsOverlap(rect, usedRect)) {
        newFreeRects.push(rect);
        continue;
      }
      // Generate up to 4 sub-rectangles from the non-overlapping portions
      // Top strip
      if (usedRect.y > rect.y) {
        newFreeRects.push({ x: rect.x, y: rect.y, w: rect.w, h: usedRect.y - rect.y });
      }
      // Bottom strip
      const usedBottom = usedRect.y + usedRect.h;
      const rectBottom = rect.y + rect.h;
      if (usedBottom < rectBottom) {
        newFreeRects.push({ x: rect.x, y: usedBottom, w: rect.w, h: rectBottom - usedBottom });
      }
      // Left strip
      if (usedRect.x > rect.x) {
        newFreeRects.push({ x: rect.x, y: rect.y, w: usedRect.x - rect.x, h: rect.h });
      }
      // Right strip
      const usedRight = usedRect.x + usedRect.w;
      const rectRight = rect.x + rect.w;
      if (usedRight < rectRight) {
        newFreeRects.push({ x: usedRight, y: rect.y, w: rectRight - usedRight, h: rect.h });
      }
    }

    // Remove any free rect that is fully contained inside another (prune redundant)
    freeRects = pruneContained(newFreeRects);
  }

  // Calculate actual roll length needed
  const totalHeight = placed.reduce(
    (max, el) => Math.max(max, el.y_in + el.total_height_in), 0
  );

  const elementArea = placed.reduce(
    (sum, el) => sum + el.total_width_in * el.total_height_in, 0
  );
  const rollArea = rollWidthIn * totalHeight;
  const efficiency = rollArea > 0 ? (elementArea / rollArea) * 100 : 0;

  return {
    roll_width_in: rollWidthIn,
    roll_length_in: Math.ceil(totalHeight * 10) / 10,
    roll_area_sqft: (rollWidthIn * totalHeight) / 144,
    nested_elements: placed,
    efficiency_pct: Math.round(efficiency * 10) / 10,
  };
}

/** Check if two rectangles overlap (exclusive — touching edges don't count) */
function rectsOverlap(a: FreeRect, b: FreeRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Remove free rects that are fully contained inside another free rect */
function pruneContained(rects: FreeRect[]): FreeRect[] {
  const result: FreeRect[] = [];
  for (let i = 0; i < rects.length; i++) {
    // Skip very small rects (< 0.5" on either side)
    if (rects[i].w < 0.5 || rects[i].h < 0.5) continue;
    let contained = false;
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue;
      if (rects[j].x <= rects[i].x && rects[j].y <= rects[i].y &&
          rects[j].x + rects[j].w >= rects[i].x + rects[i].w &&
          rects[j].y + rects[j].h >= rects[i].y + rects[i].h) {
        contained = true;
        break;
      }
    }
    if (!contained) result.push(rects[i]);
  }
  return result;
}

/**
 * Recalculate roll dimensions from manually positioned elements.
 * Used after drag-and-drop repositioning.
 */
export function recalcFromPositions(
  elements: NestedElement[],
  rollWidthIn: number = 60
): RollNestingResult {
  const totalHeight = elements.reduce(
    (max, el) => Math.max(max, el.y_in + el.total_height_in), 0
  );
  const elementArea = elements.reduce(
    (sum, el) => sum + el.total_width_in * el.total_height_in, 0
  );
  const rollArea = rollWidthIn * totalHeight;
  const efficiency = rollArea > 0 ? (elementArea / rollArea) * 100 : 0;

  return {
    roll_width_in: rollWidthIn,
    roll_length_in: Math.ceil(totalHeight * 10) / 10,
    roll_area_sqft: (rollWidthIn * totalHeight) / 144,
    nested_elements: elements,
    efficiency_pct: Math.round(efficiency * 10) / 10,
  };
}
