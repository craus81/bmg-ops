/**
 * The 02 / 06 part-number rule for imported POs.
 *
 * On Masterack-style POs the Item Number column carries a prefix that says
 * what the line IS:
 *   02… — the physical part (a rack, a graphic kit, a shelf)
 *   06… — the installation charge for that same part
 * The two share a suffix (02T278 is the part, 06T278 is its install), which
 * is exactly why they get mixed up: reading a PO table, the digits are the
 * only thing telling them apart, and a misread turns an install charge into
 * a second physical part (or vice versa) — wrong line on the PO, wrong
 * graphics flag, wrong invoice.
 *
 * The saving grace is that the description says so: a line described as an
 * install is ALWAYS an 06. That's the invariant these helpers enforce, and
 * it's checked after every extraction (AI or positional-text parse) so a
 * misread digit can't survive into the PO.
 *
 * Only the install direction is corrected. A physical-part line whose
 * description simply doesn't happen to say "install" is not proof of a
 * misread, so 06 → 02 is left alone rather than guessed at.
 */

/** Physical-part prefix. */
export const PART_PREFIX = '02';
/** Installation-charge prefix. */
export const INSTALL_PREFIX = '06';

// "INSTALL" in any form (install / installs / installed / installation), plus
// the abbreviations these POs use. Word-bounded so a part number or a longer
// unrelated word can't trip it.
const INSTALL_RE = /\binstall\w*\b|\binstl\b|\binstal\b|\binst\b/i;

/** Does this line's description mark it as an installation charge? */
export function isInstallDescription(description: string | null | undefined): boolean {
  return INSTALL_RE.test(String(description || ''));
}

/**
 * Correct one part number against the rule. Returns the number to use and
 * whether it changed, so callers can tell people what was fixed rather than
 * silently rewriting what they read on the PDF.
 */
export function correctInstallPartNumber(
  partNumber: string | null | undefined,
  description: string | null | undefined,
): { value: string; corrected: boolean } {
  const value = String(partNumber || '').trim();
  if (!value || !isInstallDescription(description)) return { value, corrected: false };
  if (!value.toUpperCase().startsWith(PART_PREFIX)) return { value, corrected: false };
  return { value: INSTALL_PREFIX + value.slice(PART_PREFIX.length), corrected: true };
}

export interface InstallRuleLine {
  part_number?: string | null;
  supplier_part?: string | null;
  description?: string | null;
  /** "Drawing Number & Revision" — extracted into its own field precisely so
   *  it can be told apart from the part number. */
  drawing_number?: string | null;
  /** Set when this line's number was corrected, so the review panel can say so. */
  install_prefix_corrected?: boolean;
  /** Set when the part number was read out of the drawing column and the rule
   *  couldn't repair it — a human has to pick the right number. */
  part_from_drawing_column?: boolean;
  [key: string]: any;
}

/**
 * Did this line's part number come out of the "Drawing Number & Revision"
 * column? On these POs the drawing number is the same suffix under a
 * different prefix (item 06U233 / drawing 02U233), so reading the far-right
 * column instead of the one left of the description produces a plausible —
 * and wrong — part number. Identical values in both fields means the same
 * column was read twice.
 */
export function partNumberIsDrawingNumber(line: InstallRuleLine | null | undefined): boolean {
  const norm = (v: string | null | undefined) => String(v || '').trim().toUpperCase();
  const pn = norm(line?.part_number);
  const dn = norm(line?.drawing_number);
  return !!pn && !!dn && pn === dn;
}

/**
 * Apply the rule across a set of extracted lines. Both the buyer part number
 * and BMG's supplier part carry the same prefix scheme, so both are checked.
 * Returns new line objects; the input is left alone.
 */
export function applyInstallPartRule<T extends InstallRuleLine>(
  lines: T[] | null | undefined,
): { lines: T[]; correctedCount: number; drawingColumnCount: number } {
  let correctedCount = 0;
  let drawingColumnCount = 0;
  const out = (lines || []).map(line => {
    const part = correctInstallPartNumber(line?.part_number, line?.description);
    const supplier = correctInstallPartNumber(line?.supplier_part, line?.description);
    // Read off the drawing column? On an install line the rule below already
    // knows the answer (the 06 number), so the repair also fixes the misread.
    // On any other line we can't reconstruct the item number — flag it and
    // let a human read it off the PDF rather than invent one.
    const fromDrawing = partNumberIsDrawingNumber(line);
    if (fromDrawing && !part.corrected) drawingColumnCount++;
    if (!part.corrected && !supplier.corrected && !fromDrawing) return line;
    if (part.corrected || supplier.corrected) correctedCount++;
    return {
      ...line,
      ...(part.corrected ? { part_number: part.value } : {}),
      ...(supplier.corrected ? { supplier_part: supplier.value } : {}),
      ...(part.corrected || supplier.corrected ? { install_prefix_corrected: true } : {}),
      ...(fromDrawing && !part.corrected ? { part_from_drawing_column: true } : {}),
    };
  });
  return { lines: out, correctedCount, drawingColumnCount };
}
