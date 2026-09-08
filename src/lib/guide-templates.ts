/**
 * Install-guide model templates (R6-10).
 *
 * A guide's real work is the calibration — px_per_in per page, the
 * standard dimension set, the sections that always say the same thing.
 * It is redone by hand for every job, even when the vehicle is the same
 * Transit 148" high-roof somebody dimensioned last month.
 *
 * A template is a guide flagged as one and keyed to a year/make/model, so
 * "New from template" can offer the ones that actually fit the job's
 * vehicle rather than a flat list somebody scrolls.
 */

export interface GuideDim {
  id: string;
  [k: string]: unknown;
}

export interface GuidePage {
  id: string;
  dims?: GuideDim[];
  [k: string]: unknown;
}

export interface GuideSection {
  id: string;
  [k: string]: unknown;
}

export interface GuideLike {
  id?: string;
  title?: string | null;
  customer_name?: string | null;
  vehicle_desc?: string | null;
  scale?: string | null;
  units?: string | null;
  fraction_denominator?: number | null;
  pages?: GuidePage[] | null;
  sections?: GuideSection[] | null;
  is_template?: boolean | null;
  template_name?: string | null;
  template_year?: string | null;
  template_make?: string | null;
  template_model?: string | null;
  graphics_job_id?: string | null;
  cni_job_id?: string | null;
  fleet_checkin_id?: string | null;
}

export interface VehicleKey {
  year?: string | null;
  make?: string | null;
  model?: string | null;
}

const clean = (s: unknown): string | null => {
  const t = String(s ?? '').trim();
  return t ? t : null;
};
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/**
 * Best-effort year/make/model out of a free-text vehicle line
 * ("2024 Ford Transit 148 High Roof").
 *
 * Deliberately shallow: the first 4-digit 19xx/20xx token is the year,
 * the next word is the make, the rest is the model. It exists to
 * PRE-FILL a form somebody then corrects, never to decide anything on
 * its own — which is why nothing downstream treats a parse as authority.
 */
export function parseVehicleDesc(desc: string | null | undefined): VehicleKey {
  const text = String(desc || '').trim();
  if (!text) return { year: null, make: null, model: null };
  const tokens = text.split(/\s+/);
  const yearIdx = tokens.findIndex(t => /^(19|20)\d{2}$/.test(t));
  const year = yearIdx >= 0 ? tokens[yearIdx] : null;
  const rest = yearIdx >= 0 ? tokens.slice(yearIdx + 1) : tokens;
  return {
    year,
    make: clean(rest[0]),
    model: clean(rest.slice(1).join(' ')),
  };
}

/** A fresh id for a cloned page/dim/section. */
function freshId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * Deep-clone a guide's pages and sections with NEW ids throughout.
 *
 * Sharing ids between a template and everything made from it means any
 * tool that addresses a dimension by id can act on the wrong document,
 * and it makes two guides indistinguishable to any future cross-guide
 * feature. Cheap to do once here; very hard to unpick later.
 */
export function clonePages(pages: GuidePage[] | null | undefined): GuidePage[] {
  return (pages || []).map(page => ({
    ...page,
    id: freshId(),
    dims: (page.dims || []).map(dim => ({ ...dim, id: freshId() })),
  }));
}

export function cloneSections(sections: GuideSection[] | null | undefined): GuideSection[] {
  return (sections || []).map(section => ({ ...section, id: freshId() }));
}

/**
 * The row a "Save as template" writes.
 *
 * Strips the customer and every job link. A template that quietly carried
 * a customer would print somebody else's name on every guide made from
 * it; one carrying graphics_job_id would attach new guides to the
 * ORIGINAL job. Migration 293 backstops both with a CHECK.
 */
export function templateFromGuide(guide: GuideLike, name: string, vehicle: VehicleKey) {
  return {
    title: guide.title || name,
    template_name: name,
    is_template: true,
    customer_name: null,
    graphics_job_id: null,
    cni_job_id: null,
    fleet_checkin_id: null,
    vehicle_desc: [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || guide.vehicle_desc || null,
    template_year: clean(vehicle.year),
    template_make: clean(vehicle.make),
    template_model: clean(vehicle.model),
    scale: guide.scale || '1:20',
    units: guide.units || 'in',
    fraction_denominator: guide.fraction_denominator ?? 8,
    // The calibration is the point of the template — pages carry
    // px_per_in and the standard dimension set.
    pages: clonePages(guide.pages),
    sections: cloneSections(guide.sections),
  };
}

/** The row a "New from template" writes. */
export function guideFromTemplate(
  template: GuideLike,
  opts: { title?: string | null; customerName?: string | null; vehicleDesc?: string | null;
          graphicsJobId?: string | null; cniJobId?: string | null; fleetCheckinId?: string | null },
) {
  return {
    title: opts.title || template.template_name || template.title || 'Install guide',
    is_template: false,
    template_name: null,
    created_from_template_id: template.id || null,
    customer_name: clean(opts.customerName),
    vehicle_desc: clean(opts.vehicleDesc) || template.vehicle_desc || null,
    graphics_job_id: opts.graphicsJobId || null,
    cni_job_id: opts.cniJobId || null,
    fleet_checkin_id: opts.fleetCheckinId || null,
    scale: template.scale || '1:20',
    units: template.units || 'in',
    fraction_denominator: template.fraction_denominator ?? 8,
    pages: clonePages(template.pages),
    sections: cloneSections(template.sections),
  };
}

// ── Matching ──────────────────────────────────────────────────────────

export interface TemplateMatch {
  template: GuideLike;
  score: number;
  /** Plain words for why it's offered — never a bare ranking. */
  reason: string;
}

/**
 * Rank templates against the job's vehicle.
 *
 * Make+model is the match that matters; the year is a tiebreak, because a
 * body style rarely changes year to year and refusing last year's
 * template would send somebody back to dimensioning from scratch. Every
 * template stays reachable — a non-matching one is offered LAST with its
 * reason said out loud, rather than hidden on a guess.
 */
export function rankTemplates(templates: GuideLike[], vehicle: VehicleKey): TemplateMatch[] {
  const wantMake = norm(vehicle.make);
  const wantModel = norm(vehicle.model);
  const wantYear = norm(vehicle.year);

  const matches = templates.map(template => {
    const make = norm(template.template_make);
    const model = norm(template.template_model);
    const year = norm(template.template_year);

    let score = 0;
    const bits: string[] = [];
    if (wantMake && make && make === wantMake) { score += 10; bits.push(template.template_make!); }
    if (wantModel && model && (model === wantModel || model.startsWith(wantModel) || wantModel.startsWith(model))) {
      score += 20; bits.push(template.template_model!);
    }
    if (wantYear && year && year === wantYear) { score += 3; bits.push(year); }

    const reason = score === 0
      ? (template.template_make || template.template_model
        ? `For ${[template.template_year, template.template_make, template.template_model].filter(Boolean).join(' ')} — different vehicle`
        : 'Not keyed to a vehicle')
      : `Matches ${bits.join(' ')}`;
    return { template, score, reason };
  });

  matches.sort((a, b) =>
    b.score - a.score
    || String(a.template.template_name || '').localeCompare(String(b.template.template_name || '')));
  return matches;
}

/** How much of a template is actually reusable work. */
export function templateSummary(t: GuideLike): string {
  const pages = (t.pages || []).length;
  const dims = (t.pages || []).reduce((n, p) => n + (p.dims || []).length, 0);
  const sections = (t.sections || []).length;
  const parts: string[] = [];
  if (pages) parts.push(`${pages} page${pages !== 1 ? 's' : ''}`);
  if (dims) parts.push(`${dims} dimension${dims !== 1 ? 's' : ''}`);
  if (sections) parts.push(`${sections} section${sections !== 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join(' · ') : 'Empty template';
}
