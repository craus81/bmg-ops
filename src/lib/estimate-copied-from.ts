// "Copied from EST-…" under the builder's estimate number (Craig,
// 2026-10-28): a Duplicate or fleet copy says where it came from until
// someone saves it. The copy route (src/lib/estimate-copy.ts) writes the
// source number only as the first line of internal_notes, and a plain copy
// stores no source id, so both are read back from that line.

const FIRST_LINE = /^(Copied from|Fleet copy of) (\S+?)(?: for unit .*)? \(\d{4}-\d{2}-\d{2}\)\.?$/;

/** Inserted copies get created_at = updated_at; any builder save moves updated_at. */
const SAVE_SLACK_MS = 2000;

export interface CopiedFrom {
  /** What the label says, e.g. "Copied from EST-2610-094". */
  text: string;
  /** The source's FleetSuite estimate number, to open the original. */
  sourceNumber: string;
}

export function estimateCopiedFrom(est: {
  internal_notes?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
} | null | undefined): CopiedFrom | null {
  if (!est?.internal_notes) return null;
  const m = FIRST_LINE.exec(est.internal_notes.split('\n')[0].trim());
  if (!m) return null;
  if (est.updated_at && est.created_at) {
    const created = Date.parse(est.created_at);
    const updated = Date.parse(est.updated_at);
    if (Number.isFinite(created) && Number.isFinite(updated) && updated - created > SAVE_SLACK_MS) return null;
  }
  return { text: `${m[1]} ${m[2]}`, sourceNumber: m[2] };
}

/** The label for an unsaved estimate filled from an old NetSuite or QuickBooks record. */
export function oldRecordCopiedFrom(src: { system: 'QuickBooks' | 'NetSuite'; typeLabel: string; number: string } | null | undefined): string | null {
  if (!src?.number) return null;
  return `Copied from ${src.system} ${src.typeLabel || 'record'} ${src.system === 'QuickBooks' ? '#' : ''}${src.number}`;
}
