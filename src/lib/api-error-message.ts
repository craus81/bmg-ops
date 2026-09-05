/**
 * Human-readable message for a failed JSON API response body.
 *
 * Validation failures from `validateBody()` (src/lib/validate.ts) answer
 * `{ error: 'Invalid request', details: [{ path, message }] }` — the field
 * that was refused lives in `details`, so a UI that shows only `error`
 * leaves the reader with an unactionable "Invalid request" (the #799
 * estimate-save bug looked like exactly that). Fold the details in.
 */
export function apiErrorMessage(data: unknown, fallback = 'Unknown error'): string {
  const d = (data && typeof data === 'object' ? data : {}) as { error?: unknown; details?: unknown };
  const base = typeof d.error === 'string' && d.error.trim() ? d.error : fallback;
  const details = Array.isArray(d.details)
    ? d.details
        .map((x: any) => [x?.path, x?.message].filter(Boolean).join(': '))
        .filter(Boolean)
        .join('; ')
    : '';
  return details ? `${base} (${details})` : base;
}
