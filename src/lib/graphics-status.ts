import type { GraphicsJobStatus } from '@/lib/types';

/**
 * Graphics job transition rules.
 *
 * Before this existed, the job page wrote `status` straight to Supabase with
 * only an oldStatus === newStatus no-op check, so any status could jump to any
 * status in either direction from the browser — a sales rep opening a
 * notification link could flip a job from Designing to Shipped.
 *
 * The rules encode how the floor actually works (owner decision, 2026-08-28):
 *
 *   - FORWARD SKIPS ARE LEGAL. Production genuinely runs ahead of the buttons
 *     — Printing straight to Shipped is a real thing, not a mistake — so any
 *     forward move is allowed with no friction. The original author expected
 *     this too: the material-usage prompt at graphics/[id]/page.tsx treats
 *     leaving `printing` for anything outside a small set as "job advanced".
 *   - BACKWARD MOVES ARE LEGAL BUT NEVER SILENT. Going back up the pipeline is
 *     usually a rework, and the reason is the useful part. It requires a typed
 *     reason, which lands in graphics_status_history.
 *   - SIDE STATES ARE FREE. flagged / revision / cancelled are escape hatches,
 *     reachable from anywhere and leavable from anywhere. Requiring a reason to
 *     flag a problem would just train people not to flag problems.
 *
 * Pure and client-safe — no DB, no fetch — so the same rules can be asserted in
 * a unit test and reused by any server route that later fronts these writes.
 */

/** The production pipeline, in the order work actually moves through it. */
export const GRAPHICS_PIPELINE: GraphicsJobStatus[] = [
  'received', 'designing', 'printing', 'outgassing', 'cutting',
  'packing', 'ready', 'ready_to_pickup', 'shipped', 'picked_up', 'installed',
];

/** Off-pipeline states: reachable from anywhere, leavable to anywhere. */
export const GRAPHICS_SIDE_STATES: GraphicsJobStatus[] = ['flagged', 'revision', 'cancelled'];

export type TransitionKind = 'same' | 'forward' | 'backward' | 'side';

export function classifyTransition(
  from: GraphicsJobStatus,
  to: GraphicsJobStatus,
): TransitionKind {
  if (from === to) return 'same';
  if (GRAPHICS_SIDE_STATES.includes(to) || GRAPHICS_SIDE_STATES.includes(from)) return 'side';
  const a = GRAPHICS_PIPELINE.indexOf(from);
  const b = GRAPHICS_PIPELINE.indexOf(to);
  // An unknown status on either end is treated as a side move rather than
  // guessed at — a status added later must not start silently failing.
  if (a === -1 || b === -1) return 'side';
  return b > a ? 'forward' : 'backward';
}

/** Backward moves must carry a reason; everything else is friction-free. */
export function requiresReason(from: GraphicsJobStatus, to: GraphicsJobStatus): boolean {
  return classifyTransition(from, to) === 'backward';
}

/**
 * The proof gate: printing without an approved proof defeats the entire
 * e-sign loop, so it takes an admin plus a recorded reason (owner decision,
 * 2026-08-28 — matching the convert-to-SO and vehicle-completion overrides,
 * which are both admin-with-reason).
 *
 * Deliberately gates only the move INTO `printing`. A job already past
 * printing is not re-gated on its way forward, or a legitimate late approval
 * would strand work mid-pipeline.
 */
export function proofGateApplies(
  to: GraphicsJobStatus,
  job: { customer_approved?: boolean | null },
): boolean {
  return to === 'printing' && !job?.customer_approved;
}
