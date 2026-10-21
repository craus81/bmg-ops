// The vehicle a customer proof names, and the template it points at.
//
// Craig 2026-10-21 reversed the 10-01 "never guess the vehicle from the
// proof" rule: when the proof PRINTS the vehicle (title block, notes —
// "2024 Ford Transit 148" WB High Roof"), the Graphics Builder picks the
// matching template and measures by its wheelbase, with a Change button.
// The reader is told to report only what is written, never to guess from
// the drawing's shape (Craig's pick, same day). A vehicle the rep already
// picked is never swapped on its own: a disagreement asks.

import { normText, type VehicleTemplate } from '@/lib/vehicle-templates';
import { templateFacets, ROOF_ORDER } from '@/lib/template-facets';

export interface ProofVehicle {
  year: string | null;
  make: string | null;
  model: string | null;
  /** Body words as printed: "Cargo Van", "Crew Cab", "Extended". */
  body: string | null;
  wheelbase_in: number | null;
  /** Normalised to the picker's roof names: Low, Standard, Medium, High… */
  roof: string | null;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A wheelbase no real vehicle goes below or above — anything else is a misread. */
const MIN_WB = 60, MAX_WB = 300;

/** Two wheelbases this close are the same vehicle (148 vs 147.6). */
const WB_TOLERANCE = 1.5;

function roofName(raw: string): string | null {
  const t = raw.toLowerCase().replace(/\broof\b/g, '').trim();
  if (!t) return null;
  if (/super\s*high/.test(t)) return 'Super High';
  if (/mega/.test(t)) return 'Mega';
  if (/high/.test(t)) return 'High';
  if (/med/.test(t)) return 'Medium';
  if (/low/.test(t)) return 'Low';
  if (/standard|regular/.test(t)) return 'Standard';
  return null;
}

/** What the reader said about the vehicle, or null when it said nothing usable. */
export function sanitizeProofVehicle(raw: any): ProofVehicle | null {
  if (!raw || typeof raw !== 'object') return null;
  const yearM = /\b(19[89]\d|20[0-4]\d)\b/.exec(String(raw.year ?? ''));
  const wbN = typeof raw.wheelbase_in === 'string' ? parseFloat(raw.wheelbase_in) : Number(raw.wheelbase_in);
  const v: ProofVehicle = {
    year: yearM ? yearM[1] : null,
    make: str(raw.make, 40) || null,
    model: str(raw.model, 60) || null,
    body: str(raw.body, 60) || null,
    wheelbase_in: Number.isFinite(wbN) && wbN >= MIN_WB && wbN <= MAX_WB ? wbN : null,
    roof: roofName(str(raw.roof, 30)),
  };
  // A year or a roof alone names no vehicle.
  if (!v.make && !v.model && !v.wheelbase_in) return null;
  return v;
}

export const proofVehicleLabel = (v: ProofVehicle) =>
  [v.year, v.make, v.model, v.body, v.wheelbase_in ? `${v.wheelbase_in}" WB` : null, v.roof ? `${v.roof} Roof` : null]
    .filter(Boolean).join(' ');

type TemplateLike = Pick<VehicleTemplate, 'wheelbase_in' | 'variant' | 'name'> & Partial<Pick<VehicleTemplate, 'facet_wheelbase' | 'facet_roof' | 'facet_body' | 'year' | 'make' | 'model'>>;

/**
 * The template's wheelbase: its wheelbase_in column, else the inches in its
 * name ("Cargo Van, 148in, High Roof"). Most of the library only has the
 * latter, which is why picking a vehicle after reading a proof used to
 * leave the drawing unmeasured.
 */
export function templateWheelbase(t: TemplateLike | null | undefined): number | null {
  if (!t) return null;
  const col = Number(t.wheelbase_in);
  if (Number.isFinite(col) && col > 0) return col;
  const facet = t.facet_wheelbase ?? templateFacets(t).wheelbase;
  const n = parseFloat(facet || '');
  return Number.isFinite(n) && n > 0 ? n : null;
}

const roofOf = (t: TemplateLike) => t.facet_roof ?? templateFacets(t).roof;
const bodyOf = (t: TemplateLike) => t.facet_body ?? templateFacets(t).body;

/** Search texts to try against the template library, most specific first. */
export function proofVehicleQueries(v: ProofVehicle): string[] {
  const mm = [v.make, v.model].filter(Boolean).join(' ');
  if (!mm) return [];
  const qs = [v.year ? `${v.year} ${mm}` : '', mm].filter(q => q.trim().length >= 2);
  return Array.from(new Set(qs));
}

const yearCovers = (tplYear: string | null | undefined, year: string) => {
  const nums = (tplYear || '').match(/\d{4}/g)?.map(Number) || [];
  if (nums.length === 0) return false;
  const y = Number(year);
  return nums.length === 1 ? nums[0] === y : y >= Math.min(...nums) && y <= Math.max(...nums);
};

/**
 * Narrow a library search to the templates that fit what the proof prints.
 * Wheelbase and roof are hard filters (a 148 is not a 130); year and body
 * only narrow when something fits them, since the library doesn't cover
 * every model year.
 */
export function narrowProofVehicleMatches<T extends TemplateLike>(rows: T[], v: ProofVehicle): T[] {
  let out = rows;
  if (v.wheelbase_in) {
    out = out.filter(t => {
      const wb = templateWheelbase(t);
      return wb != null && Math.abs(wb - v.wheelbase_in!) <= WB_TOLERANCE;
    });
  }
  if (v.roof && ROOF_ORDER.includes(v.roof)) out = out.filter(t => roofOf(t) === v.roof);
  const narrowIfAny = (keep: (t: T) => boolean) => {
    const kept = out.filter(keep);
    if (kept.length > 0) out = kept;
  };
  if (v.year) narrowIfAny(t => yearCovers(t.year, v.year!));
  if (v.body) {
    const body = templateFacets({ variant: v.body }).body;
    if (body) narrowIfAny(t => bodyOf(t) === body);
  }
  // "Extended" is a different vehicle on the same wheelbase.
  const extended = /\bextended\b(?! cab)/i.test(v.body || '');
  narrowIfAny(t => /\bextended\b(?! cab)/i.test(`${t.variant || ''} ${t.name || ''}`) === extended);
  return out;
}

// Makes printed under another name than the library files them under.
const MAKE_ALIASES: Record<string, string> = { chevy: 'chevrolet', vw: 'volkswagen', dodge: 'ram', mercedes: 'mercedesbenz', benz: 'mercedesbenz' };
const alnum = (s: string | null | undefined) => {
  const a = normText(s).replace(/[^a-z0-9]/g, '');
  return MAKE_ALIASES[a] || a;
};
const sameWord = (a: string | null | undefined, b: string | null | undefined) => {
  const x = alnum(a), y = alnum(b);
  return !x || !y || x.includes(y) || y.includes(x);
};

/** True when the template the rep picked is plainly not the vehicle the proof prints. */
export function proofVehicleDisagrees(t: TemplateLike | null, v: ProofVehicle | null): boolean {
  if (!t || !v) return false;
  const wb = templateWheelbase(t);
  if (v.wheelbase_in && wb && Math.abs(wb - v.wheelbase_in) > WB_TOLERANCE) return true;
  if (v.make && t.make && !sameWord(t.make, v.make)) return true;
  if (v.model && t.model && !sameWord(t.model, v.model)) return true;
  return false;
}
