/**
 * Local autosave for the estimate builder ("crash insurance").
 *
 * The builder holds everything in component state until the user presses
 * Save, so a browser crash, a stray Back, or an in-app navigation used to
 * discard the whole draft. The builder now snapshots its state into
 * localStorage (debounced) while it's dirty, and offers to restore the
 * snapshot the next time that estimate — or the blank builder, for drafts
 * that were never saved — is opened on the same device.
 *
 * Storage is per-device by design (same as the text-size setting): these
 * are unsaved edits, so there is no server row to hang them on, and the
 * restore prompt makes clear they're a local backup. Keyed per estimate id
 * ('new' for the not-yet-saved builder) so drafts for different estimates
 * never collide. Cleared on successful save/delete; anything left behind
 * (abandoned restores) is swept after MAX_AGE_DAYS.
 */

const PREFIX = 'bmg-estimate-draft:v1:';
const MAX_AGE_DAYS = 14;

export interface EstimateDraft {
  savedAt: string;
  /** The builder's field snapshot — shape owned by the estimates page. */
  fields: Record<string, any>;
}

const keyFor = (estimateId: string | null) => `${PREFIX}${estimateId || 'new'}`;

export function readEstimateDraft(estimateId: string | null): EstimateDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(keyFor(estimateId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.savedAt || typeof parsed.fields !== 'object') return null;
    return parsed as EstimateDraft;
  } catch {
    return null;
  }
}

export function writeEstimateDraft(estimateId: string | null, fields: Record<string, any>): void {
  if (typeof window === 'undefined') return;
  try {
    const draft: EstimateDraft = { savedAt: new Date().toISOString(), fields };
    window.localStorage.setItem(keyFor(estimateId), JSON.stringify(draft));
  } catch {
    // Quota/private-mode failures degrade to no backup — never break editing.
  }
}

export function clearEstimateDraft(estimateId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(keyFor(estimateId));
  } catch {
    // ignore
  }
}

/** Drop abandoned drafts so declined restores don't accumulate forever. */
export function sweepEstimateDrafts(maxAgeDays: number = MAX_AGE_DAYS): void {
  if (typeof window === 'undefined') return;
  try {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) || '');
        const at = Date.parse(parsed?.savedAt || '');
        if (!Number.isFinite(at) || at < cutoff) stale.push(key);
      } catch {
        stale.push(key); // unparseable = unusable — drop it
      }
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
