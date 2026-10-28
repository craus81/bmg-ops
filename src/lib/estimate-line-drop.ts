// Parts and kits dropped on the estimate builder from the other side of
// split screen (Craig, 2026-10-28): they land where they're let go, and a
// part that's already on the estimate goes on that line's quantity instead
// (after a warning) rather than becoming a second line.

import { kitEstimateLines, type KitEstimateLine, type KitWithMembers } from '@/lib/part-kits';
import type { DroppedLines } from '@/lib/pane-drop-targets';

interface AnyLine { key: string; part_id?: string | null; kit_group_id?: string | null }

/** The line under the drop point, and whether the point is on its top half. */
export interface DropAnchor { key: string; before: boolean }

/**
 * Where in `lines` new lines go for a drop at `anchor` (null = the end).
 * Never inside a kit: on a kit's line they go before or after the whole kit.
 */
export function dropIndex(lines: AnyLine[], anchor: DropAnchor | null): number {
  if (!anchor) return lines.length;
  const i = lines.findIndex(l => l.key === anchor.key);
  if (i < 0) return lines.length;
  const group = lines[i].kit_group_id;
  if (!group) return anchor.before ? i : i + 1;
  const members = lines.map((l, idx) => (l.kit_group_id === group ? idx : -1)).filter(idx => idx >= 0);
  return anchor.before ? members[0] : members[members.length - 1] + 1;
}

export function insertAt<T>(lines: T[], added: T[], index: number): T[] {
  const at = Math.max(0, Math.min(index, lines.length));
  return [...lines.slice(0, at), ...added, ...lines.slice(at)];
}

/** The line a second copy of this part would add to: the same part, not inside a kit. */
export function duplicatePartLine<T extends AnyLine>(lines: T[], partId: string | null | undefined): T | null {
  if (!partId) return null;
  return lines.find(l => l.part_id === partId && !l.kit_group_id) ?? null;
}

interface CatalogPartLike {
  id: string; netsuite_id: string | null; item_number: string;
  display_name?: string | null; description?: string | null;
  sales_price: number | null; labor_hours: number | null; catalog?: string | null;
  purchase_price?: number | null; avg_install_cost?: number | null;
}

/** One catalog part as an estimate line, the same as the builder's addPartLine makes. */
export function partEstimateLine(part: CatalogPartLike): KitEstimateLine {
  return {
    part_id: part.id,
    netsuite_item_id: part.netsuite_id,
    item_number: part.item_number,
    description: part.display_name || part.description || part.item_number,
    quantity: 1,
    unit_price: Number(part.sales_price) || 0,
    // NULL = labor not set on the part (the builder flags it) — migration 258.
    labor_hours: part.labor_hours ?? null,
    is_custom: false,
    catalog: part.catalog || undefined,
    purchase_price: part.purchase_price ?? null,
    avg_install_cost: part.avg_install_cost ?? null,
  };
}

/** A catalog part picked up to drag onto an estimate. */
export function partDropped(part: CatalogPartLike): DroppedLines {
  return { name: part.display_name || part.item_number, lines: [partEstimateLine(part)], partId: part.id };
}

/** A package or rack kit picked up to drag onto an estimate: its lines, the same as Add rack makes. */
export function kitDropped(kit: KitWithMembers): DroppedLines {
  return { name: kit.name || kit.item_number || 'Kit', lines: kitEstimateLines(kit), partId: null };
}

/**
 * The kit a second copy of this rack or hitch kit would add to (Craig,
 * 2026-10-28: warn when the same kit goes on twice): its group and quantity.
 * Plain packages carry no kit and just become parts.
 */
export function duplicateKit(
  lines: (AnyLine & { kit_id?: string | null; kit_quantity?: number | null; kit_name?: string | null })[],
  added: { kit_id?: string | null; kit_group_id?: string | null }[],
): { groupId: string; quantity: number; name: string } | null {
  const kitId = added.find(l => l.kit_group_id && l.kit_id)?.kit_id;
  if (!kitId) return null;
  const hit = lines.find(l => l.kit_id === kitId && l.kit_group_id);
  if (!hit?.kit_group_id) return null;
  return { groupId: hit.kit_group_id, quantity: Number(hit.kit_quantity) > 0 ? Number(hit.kit_quantity) : 1, name: hit.kit_name || 'This kit' };
}
