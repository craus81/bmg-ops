/**
 * Labor hours set from an estimate line (Craig, 2026-10-23). A super admin
 * taps a line's Labor cell and types hours for the PART: it saves to the
 * catalog (`netsuite_parts.labor_hours`), fills this estimate's lines for
 * that part, and — only when the part was "not set" — fills the same part's
 * still-unset lines on other DRAFT estimates (src/lib/part-labor-fill.ts). Changing hours a part already
 * had never touches other estimates, so quotes already priced don't shift.
 *
 * Migration 258: NULL = not set yet, 0 = no labor charged.
 */

export const MAX_PART_LABOR_HOURS = 200;

/** Blank → null ("not set"), else a non-negative number of hours. */
export function parseLaborHoursInput(raw: string): { hours: number | null } | { error: string } {
  const s = raw.trim();
  if (s === '') return { hours: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PART_LABOR_HOURS) {
    return { error: 'Enter hours as a number, like 1.5. Use 0 for no labor.' };
  }
  return { hours: Math.round(n * 100) / 100 };
}

interface LaborLine {
  part_id: string | null;
  netsuite_item_id: string | null;
  labor_hours: number | null;
  is_custom?: boolean;
}

/** Does this line carry the given catalog part? */
export function lineIsPart(line: LaborLine, part: { id: string; netsuite_id: string | null }): boolean {
  if (line.part_id) return line.part_id === part.id;
  return !!part.netsuite_id && line.netsuite_item_id === part.netsuite_id;
}

/** Every line of this part gets the new hours (this estimate only). */
export function applyPartLaborToLines<T extends LaborLine>(
  lines: T[],
  part: { id: string; netsuite_id: string | null },
  hours: number | null,
): T[] {
  return lines.map(l => (lineIsPart(l, part) ? { ...l, labor_hours: hours } : l));
}
