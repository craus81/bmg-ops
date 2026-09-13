'use client';

/**
 * useFormTelemetry(formId, { active }) — the opt-in for form friction
 * telemetry (R7-4). Two parts, both required:
 *
 *   1. `data-form="<id>"` on the form's root element, so the document-level
 *      capture listener in <UsageTelemetry /> can attribute the first
 *      keystroke to this form (add `data-form-manual="true"` when typing
 *      is NOT the start signal, e.g. the scan page — call markStarted()
 *      yourself).
 *   2. This hook in the component that owns the form state.
 *
 * An attempt STARTS on the first input/change inside the root (or
 * markStarted()), is SUBMITTED when markSubmitted() runs — call it ONLY
 * after the save resolved ok — and is ABANDONED when `active` flips false,
 * the component unmounts (exit 'close'), the pathname changes ('navigate')
 * or the page is hidden for good ('pagehide'). An attempt nobody touched
 * produces no rows at all.
 *
 * Nothing about the form's content is read: fields are counted by element
 * reference in a WeakSet (src/lib/usage-telemetry.ts); values, names and
 * ids are never touched.
 */

import { useEffect, useMemo } from 'react';
import { installUsageTelemetry } from '@/lib/usage-telemetry';
import type { FormExit } from '@/lib/usage-telemetry-sanitize';

export interface FormTelemetry {
  /** Non-keystroke start (VIN decoded, camera scan, slot picked). */
  markStarted: (step?: number) => void;
  /** Wizard position, reported on submit/abandon as `step`. */
  markStep: (step: number) => void;
  /** Call ONLY after the POST/insert resolved ok. Closes the attempt. */
  markSubmitted: () => void;
  /** Explicit discard path (e.g. a "discard pending scan" button). */
  markAbandoned: (exit?: FormExit) => void;
}

export function useFormTelemetry(formId: string, opts?: { active?: boolean }): FormTelemetry {
  const active = opts?.active ?? true;

  useEffect(() => {
    if (!active) return;
    const api = installUsageTelemetry();
    if (!api.enabled) return;
    api.registerForm(formId);
    // Deactivation and unmount both mean "closed without saving" for any
    // started attempt; a never-started one produces nothing here.
    return () => api.unregisterForm(formId, 'close');
  }, [formId, active]);

  return useMemo<FormTelemetry>(() => ({
    markStarted: (step) => installUsageTelemetry().markStarted(formId, step),
    markStep: (step) => installUsageTelemetry().markStep(formId, step),
    markSubmitted: () => installUsageTelemetry().markSubmitted(formId),
    markAbandoned: (exit = 'close') => installUsageTelemetry().markAbandoned(formId, exit),
  }), [formId]);
}
