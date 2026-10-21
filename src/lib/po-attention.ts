/**
 * The "needs attention" flag on a purchase order (migration 423). Anyone
 * who can open the PO list can flag a PO with an optional note of what's
 * still to do; Done clears it and keeps the note in the PO's notes.
 * Pure helpers shared by the PO list and the PO page.
 */

export interface PoAttention {
  attention_at?: string | null;
  attention_note?: string | null;
  attention_by?: string | null;
  attention_by_name?: string | null;
}

export const ATTENTION_NOTE_MAX = 200;

/** One-tap notes on the flag form. */
export const ATTENTION_QUICK_NOTES = [
  'Missing part',
  'Waiting on drawing',
  'Needs tracking sent',
  'Needs invoice',
  'Price doesn’t match',
];

export function needsAttention(po: PoAttention | null | undefined): boolean {
  return !!po?.attention_at;
}

/** The update that flags (or re-notes) a PO. Re-noting keeps the original
 *  flagger and time, so the PO page still says who raised it first. */
export function flagUpdate(
  note: string,
  who: { id: string | null; name: string | null },
  existing: PoAttention | null | undefined,
  now: Date = new Date(),
): Required<PoAttention> {
  const clean = note.trim().slice(0, ATTENTION_NOTE_MAX) || null;
  if (needsAttention(existing)) {
    return {
      attention_at: existing!.attention_at!,
      attention_note: clean,
      attention_by: existing!.attention_by ?? null,
      attention_by_name: existing!.attention_by_name ?? null,
    };
  }
  return { attention_at: now.toISOString(), attention_note: clean, attention_by: who.id, attention_by_name: who.name };
}

export const CLEAR_ATTENTION: Required<PoAttention> = {
  attention_at: null, attention_note: null, attention_by: null, attention_by_name: null,
};

/** The po_notes line written when the flag is cleared, so the history stays. */
export function clearedNoteBody(po: PoAttention): string {
  const who = po.attention_by_name ? ` (flagged by ${po.attention_by_name})` : '';
  return po.attention_note
    ? `✓ Done: ${po.attention_note}${who}`
    : `✓ Done: cleared the needs-attention flag${who}`;
}

/** "Flagged by Valarie · Oct 21, 9:12 AM" */
export function flaggedByLine(po: PoAttention): string {
  if (!po.attention_at) return '';
  const d = new Date(po.attention_at);
  const when = isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return [`Flagged by ${po.attention_by_name || 'someone'}`, when].filter(Boolean).join(' · ');
}
