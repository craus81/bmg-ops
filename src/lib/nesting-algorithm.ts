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
 * A shelf in the strip-packing layout.
 * Each shelf sits at a fixed y position and has a fixed height.
 * Items are placed left-to-right within the shelf.
 */
interface Shelf {
  y: number;        // top edge of the shelf
  height: number;   // fixed once created (height of the first item)
  usedWidth: number; // how much horizontal space is consumed
}

/**
 * Nest rectangles on a fixed-width roll using a Best-Fit Shelf algorithm.
 *
 * Guarantees:
 *  - No rectangles overlap
 *  - Each rectangle fits entirely within the roll width
 *  - Tries both orientations (original and rotated 90°) to minimize wasted space
 *  - Minimizes total roll length by choosing the best shelf for each piece
 *
 * The algorithm:
 *  1. Sort elements by max(width, height) descending — biggest pieces first
 *  2. For each element, try to fit it on every existing shelf (in both orientations)
 *     picking the shelf that wastes the least remaining width
 *  3. If no shelf fits, open a new shelf sized to the element
 */
export function nestElementsOnRoll(
  elementsWithBleed: ElementWithBleed[],
  rollWidthIn: number = 60,
  maxLengthIn: number = 1800 // 150 feet
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

  // Sort by the longer dimension descending — helps create efficient shelves
  const sorted = [...elementsWithBleed].sort((a, b) => {
    const aMax = Math.max(a.total_width_in, a.total_height_in);
    const bMax = Math.max(b.total_width_in, b.total_height_in);
    return bMax - aMax;
  });

  const shelves: Shelf[] = [];
  const placed: NestedElement[] = [];
  let totalHeight = 0;

  for (const ewb of sorted) {
    const w = ewb.total_width_in;
    const h = ewb.total_height_in;

    // Build candidate orientations that fit within the roll width
    const orientations: { placeW: number; placeH: number }[] = [];
    if (w <= rollWidthIn) orientations.push({ placeW: w, placeH: h });
    if (h <= rollWidthIn && (h !== w)) orientations.push({ placeW: h, placeH: w }); // rotated 90°

    if (orientations.length === 0) {
      // Element too large for the roll in any orientation — skip it
      console.warn(
        `Element "${ewb.element.element_name}" (${w.toFixed(1)}" × ${h.toFixed(1)}") exceeds roll width ${rollWidthIn}". Skipping.`
      );
      continue;
    }

    // Try to find the best existing shelf (least wasted width after placing)
    let bestShelfIdx = -1;
    let bestOrientation = orientations[0];
    let bestRemainder = Infinity;

    for (let si = 0; si < shelves.length; si++) {
      const shelf = shelves[si];
      for (const ori of orientations) {
        // Item must fit horizontally AND vertically within the shelf's height
        if (shelf.usedWidth + ori.placeW <= rollWidthIn && ori.placeH <= shelf.height) {
          const remainder = rollWidthIn - (shelf.usedWidth + ori.placeW);
          if (remainder < bestRemainder) {
            bestRemainder = remainder;
            bestShelfIdx = si;
            bestOrientation = ori;
          }
        }
      }
    }

    if (bestShelfIdx >= 0) {
      // Place on existing shelf
      const shelf = shelves[bestShelfIdx];
      placed.push({
        element: ewb.element,
        bleed_in: ewb.bleed_in,
        total_width_in: bestOrientation.placeW,
        total_height_in: bestOrientation.placeH,
        x_in: shelf.usedWidth,
        y_in: shelf.y,
      });
      shelf.usedWidth += bestOrientation.placeW;
    } else {
      // No existing shelf fits — open a new one
      // Pick the orientation that makes the shortest new shelf (minimizes roll length)
      let chosenOri = orientations[0];
      for (const ori of orientations) {
        if (ori.placeH < chosenOri.placeH) {
          chosenOri = ori;
        }
      }

      const newShelf: Shelf = {
        y: totalHeight,
        height: chosenOri.placeH,
        usedWidth: chosenOri.placeW,
      };
      shelves.push(newShelf);

      placed.push({
        element: ewb.element,
        bleed_in: ewb.bleed_in,
        total_width_in: chosenOri.placeW,
        total_height_in: chosenOri.placeH,
        x_in: 0,
        y_in: totalHeight,
      });

      totalHeight += chosenOri.placeH;
    }

    if (totalHeight > maxLengthIn) {
      console.warn(`Roll length ${totalHeight.toFixed(1)}" exceeds max ${maxLengthIn}".`);
    }
  }

  // Calculate efficiency
  const elementArea = placed.reduce(
    (sum, el) => sum + el.total_width_in * el.total_height_in, 0
  );
  const rollArea = rollWidthIn * totalHeight;
  const efficiency = rollArea > 0 ? (elementArea / rollArea) * 100 : 0;

  return {
    roll_width_in: rollWidthIn,
    roll_length_in: Math.ceil(totalHeight * 10) / 10, // round up to nearest 0.1"
    roll_area_sqft: (rollWidthIn * totalHeight) / 144,
    nested_elements: placed,
    efficiency_pct: Math.round(efficiency * 10) / 10,
  };
}
