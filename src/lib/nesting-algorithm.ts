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
 * Free-rectangle based bin packing (Guillotine algorithm).
 *
 * Instead of fixed-height shelves, this tracks a list of free rectangular
 * spaces on the roll. When placing an element, the algorithm:
 *  1. Finds the best free rect that fits (lowest Y first, then leftmost)
 *  2. Places the element in the top-left corner of that free rect
 *  3. Splits the remaining space into two new free rects
 *
 * This eliminates the huge wasted space that shelf packing creates when
 * tall narrow items sit next to short wide items.
 */

interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
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

  // Sort by area descending (biggest pieces first for better packing)
  const sorted = [...elementsWithBleed].sort((a, b) => {
    return (b.total_width_in * b.total_height_in) - (a.total_width_in * a.total_height_in);
  });

  // Start with one huge free rectangle (the entire roll)
  const freeRects: FreeRect[] = [{ x: 0, y: 0, w: rollWidthIn, h: maxLengthIn }];
  const placed: NestedElement[] = [];

  for (const ewb of sorted) {
    const w = ewb.total_width_in;
    const h = ewb.total_height_in;

    // Build candidate orientations
    const orientations: { pw: number; ph: number }[] = [];
    if (w <= rollWidthIn) orientations.push({ pw: w, ph: h });
    if (h <= rollWidthIn && h !== w) orientations.push({ pw: h, ph: w });

    if (orientations.length === 0) {
      console.warn(`Element "${ewb.element.element_name}" exceeds roll width. Skipping.`);
      continue;
    }

    // Find the best free rect: minimize the bottom edge of the placed element
    // (i.e. place where y + height is smallest), then leftmost X
    let bestFreeIdx = -1;
    let bestOri = orientations[0];
    let bestScore = Infinity;

    for (let fi = 0; fi < freeRects.length; fi++) {
      const fr = freeRects[fi];
      for (const ori of orientations) {
        if (ori.pw <= fr.w && ori.ph <= fr.h) {
          // Score: minimize bottom edge (y + height), then prefer leftmost
          const bottomEdge = fr.y + ori.ph;
          const score = bottomEdge * 10000 + fr.x;
          if (score < bestScore) {
            bestScore = score;
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
    });

    // Remove the used free rect
    freeRects.splice(bestFreeIdx, 1);

    // Split remaining space into two new free rects (guillotine split)
    // Choose split direction that maximizes the larger remaining rect
    const rightW = fr.w - bestOri.pw;
    const belowH = fr.h - bestOri.ph;

    // Option A: split horizontally first (right gets full height, below gets reduced width)
    // Option B: split vertically first (below gets full width, right gets reduced height)
    // Pick whichever gives a larger usable rectangle
    const areaA = Math.max(rightW * fr.h, bestOri.pw * belowH);
    const areaB = Math.max(rightW * bestOri.ph, fr.w * belowH);

    if (areaA >= areaB) {
      // Split A: right side gets full height
      if (rightW > 0.5) {
        freeRects.push({ x: px + bestOri.pw, y: fr.y, w: rightW, h: fr.h });
      }
      if (belowH > 0.5) {
        freeRects.push({ x: px, y: py + bestOri.ph, w: bestOri.pw, h: belowH });
      }
    } else {
      // Split B: below gets full width
      if (belowH > 0.5) {
        freeRects.push({ x: fr.x, y: py + bestOri.ph, w: fr.w, h: belowH });
      }
      if (rightW > 0.5) {
        freeRects.push({ x: px + bestOri.pw, y: py, w: rightW, h: bestOri.ph });
      }
    }
  }

  // Calculate actual roll length needed (max bottom edge of any placed element)
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
