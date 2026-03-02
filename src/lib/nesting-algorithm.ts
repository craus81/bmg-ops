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
 * Shelf-packing algorithm: nest rectangles on a fixed-width roll.
 * Sorts by height descending, packs into horizontal shelves.
 * Returns the positioned elements and total roll dimensions.
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

  // Sort by height descending (taller items first = better shelf packing)
  const sorted = [...elementsWithBleed].sort(
    (a, b) => b.total_height_in - a.total_height_in
  );

  // Shelves track: y position, shelf height, and items placed
  const shelves: { y: number; height: number; usedWidth: number; items: NestedElement[] }[] = [];
  let totalHeight = 0;

  for (const ewb of sorted) {
    // If element is wider than roll, rotate it (swap width/height)
    let w = ewb.total_width_in;
    let h = ewb.total_height_in;
    if (w > rollWidthIn && h <= rollWidthIn) {
      w = ewb.total_height_in;
      h = ewb.total_width_in;
    }

    // Skip elements that can't fit even after rotation
    if (w > rollWidthIn) {
      console.warn(`Element "${ewb.element.element_name}" (${w.toFixed(1)}" wide) exceeds roll width of ${rollWidthIn}". Skipping.`);
      continue;
    }

    // Try to fit in an existing shelf
    let placed = false;
    for (const shelf of shelves) {
      if (shelf.usedWidth + w <= rollWidthIn) {
        shelf.items.push({
          ...ewb,
          total_width_in: w,
          total_height_in: h,
          x_in: shelf.usedWidth,
          y_in: shelf.y,
        });
        shelf.usedWidth += w;
        // Expand shelf height if this item is taller (shouldn't happen with height-sort, but safety)
        if (h > shelf.height) {
          totalHeight += h - shelf.height;
          shelf.height = h;
        }
        placed = true;
        break;
      }
    }

    // Create new shelf if not placed
    if (!placed) {
      const newShelf = {
        y: totalHeight,
        height: h,
        usedWidth: w,
        items: [{
          ...ewb,
          total_width_in: w,
          total_height_in: h,
          x_in: 0,
          y_in: totalHeight,
        }] as NestedElement[],
      };
      shelves.push(newShelf);
      totalHeight += h;
    }

    if (totalHeight > maxLengthIn) {
      console.warn(`Roll length ${totalHeight.toFixed(1)}" exceeds max ${maxLengthIn}".`);
    }
  }

  // Flatten all items
  const nestedElements = shelves.flatMap(s => s.items);

  // Calculate efficiency
  const elementArea = nestedElements.reduce(
    (sum, el) => sum + el.total_width_in * el.total_height_in, 0
  );
  const rollArea = rollWidthIn * totalHeight;
  const efficiency = rollArea > 0 ? (elementArea / rollArea) * 100 : 0;

  return {
    roll_width_in: rollWidthIn,
    roll_length_in: Math.ceil(totalHeight * 10) / 10, // round up to nearest 0.1"
    roll_area_sqft: (rollWidthIn * totalHeight) / 144,
    nested_elements: nestedElements,
    efficiency_pct: Math.round(efficiency * 10) / 10,
  };
}
