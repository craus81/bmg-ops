/**
 * Pack & ship checklist rules (R6-4). Pure, so the API and the bench UI
 * can never disagree about whether a line is done.
 *
 * The control this feature exists for: a packer cannot verify their own
 * work. That is enforced three times over — here for the UI, in the route
 * for the write, and as a database CHECK so no future call site can skip
 * it quietly.
 */

export interface PackItem {
  id: string;
  lineIndex: number;
  partNumber: string | null;
  description: string | null;
  quantityExpected: number | null;
  quantityPacked: number | null;
  packedBy: string | null;
  packedAt: string | null;
  checkedBy: string | null;
  checkedAt: string | null;
  photoPath: string | null;
  notes: string | null;
}

export type LineState = 'open' | 'packed' | 'verified';

export function lineState(item: PackItem): LineState {
  if (item.checkedAt && item.checkedBy) return 'verified';
  if (item.packedAt && item.packedBy) return 'packed';
  return 'open';
}

/** Why this user may not verify this line, or null when they may. */
export function blockedFromChecking(item: PackItem, userId: string): string | null {
  if (lineState(item) === 'open') return 'Pack the line before verifying it.';
  if (item.packedBy === userId) return 'Someone else has to verify what you packed.';
  if (lineState(item) === 'verified') return 'Already verified.';
  return null;
}

/** A short count is allowed but must be visible, never silently accepted. */
export function quantityFlag(item: PackItem): 'short' | 'over' | null {
  if (item.quantityPacked == null || item.quantityExpected == null) return null;
  if (item.quantityPacked < item.quantityExpected) return 'short';
  if (item.quantityPacked > item.quantityExpected) return 'over';
  return null;
}

export interface PackProgress {
  total: number;
  packed: number;
  verified: number;
  withPhoto: number;
  shortLines: number;
  /** Every line packed AND verified — what "ready to ship" means. */
  complete: boolean;
}

export function packProgress(items: PackItem[]): PackProgress {
  let packed = 0;
  let verified = 0;
  let withPhoto = 0;
  let shortLines = 0;
  for (const i of items) {
    const state = lineState(i);
    if (state === 'packed' || state === 'verified') packed++;
    if (state === 'verified') verified++;
    if (i.photoPath) withPhoto++;
    if (quantityFlag(i) === 'short') shortLines++;
  }
  return {
    total: items.length,
    packed,
    verified,
    withPhoto,
    shortLines,
    complete: items.length > 0 && verified === items.length,
  };
}

/** One line of history for the job's activity feed. */
export function packSummaryNote(progress: PackProgress): string {
  const bits = [`${progress.verified}/${progress.total} lines packed and verified`];
  if (progress.withPhoto > 0) bits.push(`${progress.withPhoto} with a photo`);
  if (progress.shortLines > 0) bits.push(`${progress.shortLines} short`);
  return `Pack check complete — ${bits.join(', ')}.`;
}
