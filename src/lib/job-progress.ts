/**
 * Job progress bar (Valarie's mockup; Craig said Ship it 2026-11-06, thread
 * "Redesign job progress stages like Valarie's mockup"). One bar for an
 * approved estimate / sales order, shown on the estimate, the sales order
 * page, the graphics job page and the In-Shop vehicle card, plus the Job
 * stages board that lists every open order by stage.
 *
 *   Submitted        the customer said yes (there's a sales order)
 *   Parts ordered    every part asked for is on a PO
 *   Graphics         one step whose word changes: Graphic design → Design in
 *                    revision → Design approved (the proof approval). Skipped
 *                    when the job has no graphics. "Needs graphics job"
 *                    (orange, tap to create) when the order has graphics
 *                    lines but nobody made the job (Craig 2026-11-06).
 *   Parts in         every PO line received, or Mark all parts in
 *   Scheduled        a drop-off or install date is set
 *   Vehicle arrived  the vehicle is checked in. On-site jobs read "Tech on
 *                    site" and move on the install day.
 *   Install          a tech started work in the app (Graphics or Upfit in
 *                    progress on the In-Shop card); on-site, the install day
 *   Complete         the vehicle is Complete / Shipped, the graphics are
 *                    installed or picked up, or the order is billed
 *
 * Everything moves on its own from what already happens. The blue step is
 * the one after the furthest step reached. An earlier step that still has
 * open work (parts not in while the van is in the bay) shows amber as
 * "held up" instead of pretending to be green.
 *
 * Pure and client-safe: job-progress-server.ts loads the rows, this decides
 * what they mean, so tests pin it.
 */

export type JobStageKey =
  | 'submitted' | 'parts_ordered' | 'graphics' | 'parts_in'
  | 'scheduled' | 'arrived' | 'install' | 'complete';

export const JOB_STAGES: { key: JobStageKey; label: string; boardLabel: string }[] = [
  { key: 'submitted', label: 'Submitted', boardLabel: 'Submitted' },
  { key: 'parts_ordered', label: 'Parts ordered', boardLabel: 'Parts ordered' },
  { key: 'graphics', label: 'Graphic design', boardLabel: 'Graphics' },
  { key: 'parts_in', label: 'Parts in', boardLabel: 'Parts in' },
  { key: 'scheduled', label: 'Scheduled', boardLabel: 'Scheduled' },
  { key: 'arrived', label: 'Vehicle arrived', boardLabel: 'Arrived' },
  { key: 'install', label: 'Install', boardLabel: 'Install' },
  { key: 'complete', label: 'Complete', boardLabel: 'Complete' },
];

export function isJobStageKey(v: unknown): v is JobStageKey {
  return typeof v === 'string' && JOB_STAGES.some(s => s.key === v);
}

/** Graphics job statuses past the proof: printing onward means the design
 *  was approved even when nobody recorded the approval. */
const GRAPHICS_PAST_DESIGN = new Set([
  'printing', 'outgassing', 'cutting', 'packing', 'ready', 'ready_to_pickup', 'shipped', 'picked_up', 'installed',
]);

export interface JobProgressInput {
  approved: boolean;
  approvedAt: string | null;
  /** One entry per part number (requests + drop ships), already folded. */
  parts: { total: number; ordered: number; received: number; orderedAt: string | null; receivedAt: string | null };
  /** Mark all parts in, by hand. */
  partsAllInAt: string | null;
  /** Live graphics jobs (not cancelled / flagged). */
  graphics: { status: string; approved: boolean; approvedAt: string | null }[];
  /** The order has graphics lines (src/lib/graphics-lines.ts). With no live
   *  job, the step reads "Needs graphics job" instead of being skipped. */
  graphicsLines?: boolean;
  schedule: { date: string; time: string | null; place: 'shop' | 'onsite' } | null;
  /** Graphics installed at the customer and no vehicle comes to the shop. */
  onsite: boolean;
  arrivedAt: string | null;
  installStartedAt: string | null;
  /** In-Shop crew line while installing, e.g. "Upfit In Progress". */
  installLabel: string | null;
  complete: { at: string | null; label: string } | null;
  invoiced: { at: string | null; number: string | null } | null;
  /** Today in Chicago, YYYY-MM-DD. */
  today: string;
}

export type JobStageState = 'done' | 'now' | 'todo' | 'skip' | 'held';

export interface JobStageView {
  key: JobStageKey;
  label: string;
  state: JobStageState;
  detail: string;
  /** Graphics step only: the order has graphics lines and no job yet. */
  needsJob?: boolean;
}

export interface JobProgressView {
  stages: JobStageView[];
  /** The blue step (or 'complete' when everything is done). */
  current: JobStageKey;
  currentLabel: string;
  currentDetail: string;
  /** When the job reached the step before the blue one (days in stage). */
  since: string | null;
  nextStep: string;
  parts: { text: string; ok: boolean };
  /** Earlier steps still open, by label ("Parts in"). */
  heldUp: string[];
  done: boolean;
}

const TZ = 'America/Chicago';

/** "Nov 6" — date-only strings stay on their own day. */
export function fmtDay(iso: string | null | undefined, opts: { weekday?: boolean } = {}): string {
  if (!iso) return '';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(dateOnly ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    timeZone: dateOnly ? 'UTC' : TZ,
    ...(opts.weekday ? { weekday: 'short' } : {}),
    month: 'short', day: 'numeric',
  });
}

/** "08:00:00" → "8:00 AM". */
function fmtTimeOfDay(t: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Today's date in Chicago as YYYY-MM-DD. */
export function chicagoToday(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: TZ });
}

function designApproved(g: JobProgressInput['graphics'][number]): boolean {
  return g.approved || GRAPHICS_PAST_DESIGN.has(g.status);
}

export function deriveJobProgress(input: JobProgressInput): JobProgressView {
  const p = input.parts;
  const hasGraphics = input.graphics.length > 0;
  const needsJob = !hasGraphics && !!input.graphicsLines;
  const allDesignsApproved = hasGraphics && input.graphics.every(designApproved);
  const inRevision = input.graphics.some(g => g.status === 'revision' && !designApproved(g));
  const installDay = !!(input.onsite && input.schedule && input.schedule.date <= input.today);
  const partsIn = !!input.partsAllInAt || (p.total > 0 && p.received >= p.total);

  const reached: Record<JobStageKey, boolean> = {
    submitted: input.approved,
    parts_ordered: p.total > 0 && p.ordered >= p.total,
    graphics: allDesignsApproved,
    parts_in: partsIn,
    scheduled: !!input.schedule,
    arrived: !!input.arrivedAt || installDay,
    install: !!input.installStartedAt || installDay,
    complete: !!input.complete || !!input.invoiced,
  };
  const reachedAt: Record<JobStageKey, string | null> = {
    submitted: input.approvedAt,
    parts_ordered: p.orderedAt,
    graphics: input.graphics.map(g => g.approvedAt).filter(Boolean).sort().pop() || null,
    parts_in: input.partsAllInAt || p.receivedAt,
    scheduled: null,
    arrived: input.arrivedAt || (installDay ? input.schedule!.date : null),
    install: input.installStartedAt || (installDay ? input.schedule!.date : null),
    complete: input.complete?.at || input.invoiced?.at || null,
  };
  // Open work that keeps an earlier step from being green.
  const stillOpen: Record<JobStageKey, boolean> = {
    submitted: false,
    parts_ordered: p.total > 0 && p.ordered < p.total,
    graphics: (hasGraphics && !allDesignsApproved) || needsJob,
    parts_in: p.total > 0 && !partsIn,
    scheduled: false,
    arrived: false,
    install: false,
    complete: false,
  };
  const skip = (k: JobStageKey) => k === 'graphics' && !hasGraphics && !needsJob;

  let furthest = -1;
  JOB_STAGES.forEach((s, i) => { if (!skip(s.key) && reached[s.key]) furthest = i; });
  const done = reached.complete;
  let nowIdx = -1;
  if (!done) {
    for (let i = furthest + 1; i < JOB_STAGES.length; i++) {
      if (!skip(JOB_STAGES[i].key)) { nowIdx = i; break; }
    }
  }

  const label = (k: JobStageKey, state: JobStageState): string => {
    if (k === 'graphics') {
      if (needsJob) return 'Needs graphics job';
      if (!hasGraphics) return 'No graphics';
      if (state === 'done') return 'Design approved';
      if ((state === 'now' || state === 'held') && inRevision) return 'Design in revision';
      return 'Graphic design';
    }
    if (k === 'arrived' && input.onsite) return 'Tech on site';
    return JOB_STAGES.find(s => s.key === k)!.label;
  };

  const detail = (k: JobStageKey, state: JobStageState): string => {
    switch (k) {
      case 'submitted':
        return input.approvedAt ? `Approved ${fmtDay(input.approvedAt)}` : 'Approved';
      case 'parts_ordered':
        if (p.total === 0) return state === 'done' ? 'Nothing needed ordering' : 'Nothing requested yet';
        if (p.ordered >= p.total) return [p.total === 1 ? 'The part is ordered' : `All ${p.total} parts ordered`, fmtDay(p.orderedAt)].filter(Boolean).join(' · ');
        return `${p.ordered} of ${p.total} parts on a PO or in stock`;
      case 'graphics': {
        if (needsJob) return 'The order has graphics lines but no graphics job yet';
        if (!hasGraphics) return 'No graphics on this job';
        if (state === 'done') return reachedAt.graphics ? `Proof approved ${fmtDay(reachedAt.graphics)}` : 'Proof approved';
        if (inRevision) return 'Changes requested. Waiting on a new proof or the customer.';
        return 'Designer is working on the proof';
      }
      case 'parts_in':
        if (input.partsAllInAt) return `Marked all in ${fmtDay(input.partsAllInAt)}`;
        if (p.total === 0) return state === 'done' ? 'Nothing to wait on' : 'Nothing on order';
        if (partsIn) return [`All ${p.total} received`, fmtDay(p.receivedAt)].filter(Boolean).join(' · ');
        return `${p.received} of ${p.total} parts received`;
      case 'scheduled': {
        const s = input.schedule;
        if (!s) return 'No date set';
        const time = fmtTimeOfDay(s.time);
        const where = s.place === 'onsite' ? (time ? `on site, arriving ${time}` : 'on site') : (time ? `drop off ${time}` : 'at the shop');
        return `${fmtDay(s.date, { weekday: true })} · ${where}`;
      }
      case 'arrived':
        if (input.arrivedAt) return `Checked in ${fmtDay(input.arrivedAt, { weekday: true })}`;
        if (installDay) return `Install day ${fmtDay(input.schedule!.date, { weekday: true })}`;
        return input.onsite ? 'Moves on the install day' : 'Not checked in yet';
      case 'install':
        if (input.installLabel && input.installStartedAt) return `${input.installLabel} · started ${fmtDay(input.installStartedAt, { weekday: true })}`;
        if (input.installStartedAt) return `Started ${fmtDay(input.installStartedAt, { weekday: true })}`;
        if (installDay) return 'Installing on site';
        return 'Not started';
      case 'complete':
        if (input.complete) return [input.complete.label, fmtDay(input.complete.at, { weekday: true })].filter(Boolean).join(' · ');
        if (input.invoiced) return [input.invoiced.number ? `Invoice ${input.invoiced.number}` : 'Billed', fmtDay(input.invoiced.at)].filter(Boolean).join(' · ');
        return 'Not finished';
    }
  };

  const stages: JobStageView[] = JOB_STAGES.map((s, i) => {
    let state: JobStageState;
    if (skip(s.key)) state = 'skip';
    else if (done) state = 'done';
    else if (i === nowIdx) state = 'now';
    else if (i > nowIdx) state = 'todo';
    else state = stillOpen[s.key] ? 'held' : 'done';
    return {
      key: s.key, label: label(s.key, state), state, detail: detail(s.key, state),
      ...(s.key === 'graphics' && needsJob ? { needsJob: true } : {}),
    };
  });

  const cur = done ? stages[stages.length - 1] : stages[nowIdx];
  const furthestKey = furthest >= 0 ? JOB_STAGES[furthest].key : null;

  // What happens next, in plain words.
  // The thing that finishes the blue step.
  let nextStep = 'Nothing left';
  if (!done) {
    const NEXT: Record<JobStageKey, string> = {
      submitted: 'Customer approval',
      parts_ordered: 'Order the parts',
      graphics: needsJob ? 'Create the graphics job' : inRevision ? 'Send the revised proof' : 'Send the proof for approval',
      parts_in: 'Receive the parts',
      scheduled: input.onsite ? 'Schedule the install' : 'Schedule the drop-off',
      arrived: input.onsite ? 'Install day' : 'Vehicle drop-off',
      install: 'Tech starts the install',
      complete: 'Finish and invoice',
    };
    nextStep = NEXT[cur.key];
  }

  let partsTile: { text: string; ok: boolean };
  if (input.partsAllInAt) partsTile = { text: 'All items in', ok: true };
  else if (p.total === 0) partsTile = { text: 'Nothing ordered', ok: true };
  else if (p.received >= p.total) partsTile = { text: `All ${p.total} items in`, ok: true };
  else partsTile = { text: `${p.ordered} of ${p.total} ordered · ${p.received} in`, ok: false };

  return {
    stages,
    current: cur.key,
    currentLabel: cur.label,
    currentDetail: cur.detail,
    since: done ? reachedAt.complete : (furthestKey ? reachedAt[furthestKey] : null),
    nextStep,
    parts: partsTile,
    heldUp: stages.filter(s => s.state === 'held').map(s => s.label),
    done,
  };
}

// ── The parts list behind the bar (Craig 2026-11-06, picked C): tap Parts
//    ordered, Parts in, the Parts & materials tile or the customer card's
//    Parts line to see which parts are in and which aren't. ──

export type JobPartStatus = 'not_ordered' | 'ordered' | 'in';

/** Everything the loader found about one part number on the order. */
export interface JobPartTrace {
  itemNumber: string;
  description: string | null;
  quantity: number | null;
  /** A purchase request exists (any status but cancelled). */
  requested: boolean;
  ordered: boolean;
  received: boolean;
  poNumbers: string[];
  vendors: string[];
  /** Earliest ETA among its open POs (YYYY-MM-DD). */
  eta: string | null;
  /** "Got it" on the job, when that's how it came in. */
  gotItAt: string | null;
  fromStock: boolean;
  /** Drop ship PO number ('' when it has none yet); null = not a drop ship. */
  dropShip: string | null;
  /** Covered by the sales order's hand "Mark parts ordered". */
  markedOrdered: boolean;
}

export interface JobPart {
  itemNumber: string;
  description: string | null;
  quantity: number | null;
  status: JobPartStatus;
  /** "PO2311 · Masterack · ETA Nov 10", "Received · PO2301", "From stock"… */
  where: string;
}

const STATUS_ORDER: Record<JobPartStatus, number> = { not_ordered: 0, ordered: 1, in: 2 };

export function describeJobParts(traces: JobPartTrace[], partsAllInAt: string | null): JobPart[] {
  const parts = traces.map((t): JobPart => {
    const po = t.poNumbers.join(', ');
    const vendor = t.vendors.join(', ');
    let status: JobPartStatus = t.received ? 'in' : t.ordered ? 'ordered' : 'not_ordered';
    let where: string;
    if (status === 'in') {
      if (t.fromStock) where = 'From stock';
      else if (t.dropShip != null) where = ['Drop ship', t.dropShip || null, vendor || null].filter(Boolean).join(' · ');
      else if (t.gotItAt) where = ['Got it', fmtDay(t.gotItAt)].filter(Boolean).join(' · ');
      else where = ['Received', po || null, vendor || null].filter(Boolean).join(' · ');
    } else if (partsAllInAt) {
      status = 'in';
      where = ['Marked all parts in', fmtDay(partsAllInAt)].filter(Boolean).join(' · ');
    } else if (status === 'ordered') {
      where = [po || null, vendor || null, t.eta ? `ETA ${fmtDay(t.eta)}` : null].filter(Boolean).join(' · ')
        || (t.markedOrdered ? 'Marked ordered on the sales order' : 'Ordered');
    } else {
      where = t.requested ? 'Requested, not on a PO yet' : 'Not on a PO yet';
    }
    return { itemNumber: t.itemNumber, description: t.description, quantity: t.quantity, status, where };
  });
  return parts.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.itemNumber.localeCompare(b.itemNumber));
}
