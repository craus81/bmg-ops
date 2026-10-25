// The vehicle picker's shared vocabulary: the Art Station template library
// (vehicle_templates, ~9,450 rows) is the one make / model list in
// FleetSuite. The Graphics Builder draws on it and estimates pick from it
// (Craig 2026-10-19: "the vehicle make and model selector on the estimates
// should mirror the graphics builder selections"). The older 18-row
// vehicle_platforms list stays behind the scenes as the parts-catalog
// fitment key: platformFromVehicle() works it out from the make / model the
// picker chose.

import type { PanelDimension } from '@/lib/wrap-reference';
import { resolvePlatform } from '@/lib/vin-platform';
import { ROOF_ORDER } from '@/lib/template-facets';

export interface VehicleTemplate {
  id: string;
  name: string;
  make: string;
  model: string;
  year: string | null;
  variant: string | null;
  scale: string | null;
  template_code: string | null;
  template_image_path: string | null;
  px_per_in: number | null;
  // What the wrap dimension sheet publishes for this vehicle — the
  // yardstick the scale is calibrated against. See src/lib/wrap-reference.ts.
  overall_length_in: number | null;
  overall_height_in: number | null;
  wheelbase_in: number | null;
  panel_data: PanelDimension[] | null;
  is_active: boolean | null;
  // Generated in the database from the variant (migration 345, a port of
  // src/lib/template-facets.ts) — what the picker's narrower dropdowns
  // filter on.
  facet_wheelbase?: string | null;
  facet_body?: string | null;
  facet_roof?: string | null;
  facet_bed?: string | null;
  facet_cab?: string | null;
}

export const TEMPLATE_COLUMNS = 'id, name, make, model, year, variant, scale, template_code, template_image_path, px_per_in, overall_length_in, overall_height_in, wheelbase_in, panel_data, is_active, facet_wheelbase, facet_body, facet_roof, facet_bed, facet_cab';

export type TemplateFilterKey = 'year' | 'make' | 'model' | 'body' | 'wheelbase' | 'roof' | 'bed' | 'cab';
export type TemplateFilters = Record<TemplateFilterKey, string>;
export const FILTER_KEYS: TemplateFilterKey[] = ['year', 'make', 'model', 'body', 'wheelbase', 'roof', 'bed', 'cab'];
export const EMPTY_FILTERS: TemplateFilters = { year: '', make: '', model: '', body: '', wheelbase: '', roof: '', bed: '', cab: '' };
export const EMPTY_FILTER_OPTIONS: Record<TemplateFilterKey, string[]> = { year: [], make: [], model: [], body: [], wheelbase: [], roof: [], bed: [], cab: [] };

export interface TemplateSearchResult { rows: VehicleTemplate[]; total: number; unfilteredTotal: number }

export const templateLabel = (t: Pick<VehicleTemplate, 'year' | 'make' | 'model' | 'variant'>) =>
  [t.year, t.make, t.model, t.variant].filter(Boolean).join(' ');

// Template make/model/year come in verbatim from ZIP folder names, so the
// library holds mixed casings ("FORD" and "Ford") — every compare and dedupe
// over them must go through this.
export const normText = (v?: string | null) => (v || '').trim().toLowerCase();

// For printing a library value on a customer document: shouty folder-name
// words ("FORD TRANSIT") read as "Ford Transit"; short codes (GMC, RAM) and
// anything with a digit (F-150, 2500HD) stay as they are.
export const tidyVehicleText = (v?: string | null) =>
  (v || '').trim().replace(/\b[A-Z]{4,}\b/g, w => w[0] + w.slice(1).toLowerCase());

// The library is ~9,450 templates, so nothing downloads it: the database
// searches and filters it (migration 345). Every space-separated search term
// must match somewhere in the label, name, or code ("transit 2023 high"
// finds 2023 High Roof Transits regardless of word order).
export const searchTemplates = async (
  supabase: any,
  opts: { query?: string; filters?: Partial<TemplateFilters>; limit?: number; offset?: number; includeRetired?: boolean },
): Promise<TemplateSearchResult | null> => {
  const { data, error } = await supabase.rpc('search_vehicle_templates', {
    p_query: opts.query || '',
    p_filters: opts.filters || {},
    p_limit: opts.limit ?? 50,
    p_offset: opts.offset ?? 0,
    p_include_retired: !!opts.includeRetired,
  });
  if (error || !data) return null;
  return { rows: (data.rows || []) as VehicleTemplate[], total: Number(data.total) || 0, unfilteredTotal: Number(data.unfiltered_total) || 0 };
};

// ----- Fitment platform from the picked vehicle -----

export interface PlatformLite {
  id: string;
  key: string;
  config: { wheelbases?: string[]; roofs?: string[]; cabs?: string[]; beds?: string[] } | null;
}

export interface VehicleChoice {
  make?: string | null;
  model?: string | null;
  wheelbase?: string | null;
  roof?: string | null;
  cab?: string | null;
  bed?: string | null;
}

export interface PlatformMatch {
  platformId: string | null;
  wheelbase: string;
  roof: string;
  cab: string;
  bed: string;
}

const squash = (v: string) => v.toLowerCase().replace(/[\s-]+/g, '');

// Template facet → the platform's own option label, or '' when the platform
// doesn't offer it (or offers two that both fit).
const pickOption = (options: string[] | undefined, test: (o: string) => boolean): string => {
  const hits = (options || []).filter(test);
  return hits.length === 1 ? hits[0] : '';
};

// "148" → "148"; "148 Extended" → the platform's "148 EL" / "159 EXT".
export const matchWheelbase = (facet: string, options?: string[]) => {
  const m = facet.match(/^(\d+)/);
  if (!m) return '';
  const extended = /extended/i.test(facet);
  return pickOption(options, o => {
    const om = o.match(/^(\d+)\s*(.*)$/);
    if (!om || om[1] !== m[1]) return false;
    const optExtended = /^(el|ext|extended)$/i.test(om[2].trim());
    return extended ? optExtended : om[2].trim() === '';
  });
};

// "Low" ↔ the platform's "low".
export const matchRoof = (roof: string, options?: string[]) =>
  roof ? pickOption(options, o => normText(o) === normText(roof)) : '';

/**
 * The other way round: a platform's roof / wheelbase labels ("low",
 * "148 EL", "159 EXT") in the template library's facet words ("Low",
 * "148 Extended"), so a VIN decode can set the picker's Roof and Wheelbase
 * dropdowns. Anything it can't place is left out.
 */
export function pickerFiltersFromPlatform(roof: string | null, wheelbase: string | null): Partial<TemplateFilters> {
  const out: Partial<TemplateFilters> = {};
  const r = ROOF_ORDER.find(o => normText(o) === normText(roof));
  if (r) out.roof = r;
  const m = (wheelbase || '').trim().match(/^(\d+)\s*(.*)$/);
  if (m) {
    const rest = m[2].trim();
    if (!rest) out.wheelbase = m[1];
    else if (/^(el|ext|extended)$/i.test(rest)) out.wheelbase = `${m[1]} Extended`;
  }
  return out;
}

// "Crew Cab" ↔ "Crew", "Super Cab" ↔ "SuperCab", "Regular Cab" ↔ "Regular".
const matchCab = (facet: string, options?: string[]) => {
  const f = squash(facet);
  return pickOption(options, o => {
    const s = squash(o);
    return s === f || `${s}cab` === f || s === `${f}cab`;
  });
};

// Facet beds are feet: "5.5'", "6'6\"". Platform beds are feet as numbers.
const matchBed = (facet: string, options?: string[]) => {
  const m = facet.match(/^(\d+(?:\.\d+)?)'(?:(\d+)")?/);
  if (!m) return '';
  return matchBedFeet(parseFloat(m[1]) + (m[2] ? parseInt(m[2], 10) / 12 : 0), options);
};
export const matchBedFeet = (feet: number | null, options?: string[]) =>
  feet != null && Number.isFinite(feet) ? pickOption(options, o => Math.abs(parseFloat(o) - feet) <= 0.15) : '';

/**
 * Which vehicle_platforms row (the parts catalog's fitment key) the picked
 * make / model belongs to, and the platform's own labels for the roof,
 * wheelbase, cab and bed the template says. Conservative like the VIN
 * resolver: anything ambiguous comes back empty rather than guessed.
 */
export function platformFromVehicle(choice: VehicleChoice, platforms: PlatformLite[]): PlatformMatch {
  const none: PlatformMatch = { platformId: null, wheelbase: '', roof: '', cab: '', bed: '' };
  if (!choice.make && !choice.model) return none;
  const { platformKey } = resolvePlatform({ make: choice.make || '', model: choice.model || '' });
  const platform = platformKey ? platforms.find(p => p.key === platformKey) : null;
  if (!platform) return none;
  const cfg = platform.config || {};
  const roof = (choice.roof || '').trim();
  return {
    platformId: platform.id,
    wheelbase: choice.wheelbase ? matchWheelbase(choice.wheelbase, cfg.wheelbases) : '',
    roof: roof ? pickOption(cfg.roofs, o => o.toLowerCase() === roof.toLowerCase()) : '',
    cab: choice.cab ? matchCab(choice.cab, cfg.cabs) : '',
    bed: choice.bed ? matchBed(choice.bed, cfg.beds) : '',
  };
}

// The estimate columns a picked vehicle writes (migration 410). A template
// pick carries everything; make / model alone (no template for this
// vehicle) still finds the fitment platform. Off-platform vehicles print
// through vehicle_other, as before.
export function estimateVehicleFields(
  template: VehicleTemplate | null,
  filters: Partial<TemplateFilters>,
  platforms: PlatformLite[],
) {
  const make = (template?.make ?? filters.make ?? '').trim();
  const model = (template?.model ?? filters.model ?? '').trim();
  const year = (template?.year ?? filters.year ?? '').trim();
  const match = platformFromVehicle({
    make, model,
    wheelbase: template ? template.facet_wheelbase : filters.wheelbase,
    roof: template ? template.facet_roof : filters.roof,
    cab: template ? template.facet_cab : filters.cab,
    bed: template ? template.facet_bed : filters.bed,
  }, platforms);
  const variant = (template?.variant || '').trim();
  const other = tidyVehicleText([make, model, variant].filter(Boolean).join(' ')).slice(0, 120);
  return {
    vehicle_template_id: template?.id || null,
    vehicle_make: make || null,
    vehicle_model: model || null,
    vehicle_year: year || null,
    vehicle_platform_id: match.platformId,
    vehicle_other: match.platformId ? null : other || null,
    vehicle_wheelbase: match.wheelbase || null,
    vehicle_roof: match.roof || null,
    vehicle_cab: match.cab || null,
    vehicle_bed: match.bed || null,
  };
}
