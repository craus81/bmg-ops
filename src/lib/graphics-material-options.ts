/**
 * Graphics job material drop-downs (Vinyl Type, Laminate, Premask).
 * The lists live in graphics_material_options (migration 459) so admins
 * can add to them; the job keeps plain text, so anything typed under
 * "Other…" saves and shows exactly like a list item.
 */

export const MATERIAL_KINDS = ['vinyl', 'laminate', 'premask'] as const;
export type MaterialKind = typeof MATERIAL_KINDS[number];

export const MATERIAL_KIND_LABEL: Record<MaterialKind, string> = {
  vinyl: 'Vinyl Type',
  laminate: 'Laminate',
  premask: 'Premask',
};

export interface MaterialOption {
  id: string;
  kind: MaterialKind;
  name: string;
  sort_order: number;
}

export type MaterialOptionLists = Record<MaterialKind, MaterialOption[]>;

export const emptyMaterialLists = (): MaterialOptionLists => ({ vinyl: [], laminate: [], premask: [] });

/** Trim and collapse inner whitespace; what gets stored and compared. */
export function cleanOptionName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function groupMaterialOptions(rows: MaterialOption[]): MaterialOptionLists {
  const lists = emptyMaterialLists();
  for (const r of rows) {
    if ((MATERIAL_KINDS as readonly string[]).includes(r.kind)) lists[r.kind].push(r);
  }
  for (const k of MATERIAL_KINDS) {
    lists[k].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }
  return lists;
}

/**
 * The list item a saved value matches (case and spacing don't matter), or
 * null when it's free text and the drop-down should show "Other…".
 */
export function matchOption(value: string | null | undefined, options: MaterialOption[]): MaterialOption | null {
  const v = cleanOptionName(value || '').toLowerCase();
  if (!v) return null;
  return options.find(o => cleanOptionName(o.name).toLowerCase() === v) || null;
}
