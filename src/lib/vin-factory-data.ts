/**
 * Paid factory data for the VIN Lookup window (CarsXE /specs). NHTSA's free
 * decode often has no bed length, wheelbase or roof height; CarsXE carries
 * the factory style name ("SuperCrew 4WD 5.5' Box", "T-250 148\" Med Roof")
 * plus exterior dimensions. Everything here is pure so it can be tested
 * without the API: the route fetches, this file reads.
 *
 * Where a value isn't printed outright it is worked out, and the window says
 * so ("from wheelbase", "from overall height") — never a silent guess.
 */

import type { VinDetails, VinDetailRow } from '@/lib/vin-decoder';

export interface FactoryValue { value: string; source: string }

export interface FactoryData {
  title: string;
  style: string;
  bed: FactoryValue | null;
  roof: FactoryValue | null;
  wheelbase: string;
  overallHeight: string;
  overallLength: string;
  gvwr: string;
  curbWeight: string;
  engine: string;
  drivetrain: string;
  transmission: string;
  seating: string;
  /** Every plain field CarsXE sent, for the "All factory fields" list. */
  raw: { label: string; value: string }[];
}

/** "145.00 in." / "145" → 145. NaN when there's no number. */
export function inches(s: string | null | undefined): number {
  const m = String(s ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

const fmtIn = (n: number) => (Number.isFinite(n) && n > 0 ? `${+n.toFixed(1)}"` : '');
const feet = (n: number) => `${+n.toFixed(1)} ft`;

/**
 * Bed length printed in a style/trim string: "5.5' Box", "6.5 ft. Bed",
 * "5'7\" Box", "8 ft box", "78.9\" Box". Returns feet, or null.
 */
export function bedFromText(text: string): number | null {
  const t = text.replace(/[’′]/g, "'").replace(/[”″]/g, '"');
  let m = t.match(/(\d)\s*'\s*(\d{1,2})\s*"?\s*(?:box|bed)/i);
  if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 12;
  m = t.match(/(\d(?:\.\d)?)\s*(?:'|ft\.?|feet|foot)\s*(?:long\s*)?(?:box|bed)/i);
  if (m) return parseFloat(m[1]);
  m = t.match(/(\d{2,3}(?:\.\d+)?)\s*(?:"|in\.?|inch(?:es)?)\s*(?:box|bed)/i);
  if (m) return parseFloat(m[1]) / 12;
  return null;
}

// Half-ton pickups: cab + wheelbase pins down the box. Wheelbases in
// inches (±1.5" tolerance), box in feet. F-150 2015+, Ram 1500 2019+,
// Silverado/Sierra 1500 2019+.
const PICKUP_BOXES: { model: RegExp; cab: RegExp; wb: number; box: number }[] = [
  { model: /F-?150/i, cab: /crew/i, wb: 145, box: 5.5 },
  { model: /F-?150/i, cab: /crew/i, wb: 157, box: 6.5 },
  { model: /F-?150/i, cab: /super\s*cab|extended|ext/i, wb: 145, box: 6.5 },
  { model: /F-?150/i, cab: /super\s*cab|extended|ext/i, wb: 164, box: 8 },
  { model: /F-?150/i, cab: /regular|reg/i, wb: 122, box: 6.5 },
  { model: /F-?150/i, cab: /regular|reg/i, wb: 141, box: 8 },
  { model: /\bRAM\b/i, cab: /crew/i, wb: 144.5, box: 5 + 7 / 12 },
  { model: /\bRAM\b/i, cab: /crew/i, wb: 153.5, box: 6 + 4 / 12 },
  { model: /\bRAM\b/i, cab: /quad/i, wb: 140.5, box: 6 + 4 / 12 },
  { model: /SILVERADO|SIERRA/i, cab: /crew/i, wb: 147.4, box: 5 + 10 / 12 },
  { model: /SILVERADO|SIERRA/i, cab: /crew/i, wb: 157, box: 6 + 7 / 12 },
  { model: /SILVERADO|SIERRA/i, cab: /double/i, wb: 147.4, box: 6 + 7 / 12 },
];

/** `model` should include the make ("RAM 1500") — Ram's model is just "1500". */
export function bedFromWheelbase(model: string, cabText: string, wheelbaseIn: number): number | null {
  if (!Number.isFinite(wheelbaseIn) || /\b(2500|3500|HD)\b/i.test(model)) return null;
  const hits = PICKUP_BOXES.filter(r =>
    r.model.test(model) && r.cab.test(cabText) && Math.abs(r.wb - wheelbaseIn) <= 1.5);
  return hits.length === 1 ? hits[0].box : null;
}

/** Roof printed in a style/trim string: "Medium Roof", "Med Rf", "High Roof", "Super High Roof", "Low Roof", "Standard Roof". */
export function roofFromText(text: string): string | null {
  if (/super\s*high\s*(?:roof|rf)/i.test(text)) return 'Super high';
  if (/\bhigh\s*(?:roof|rf)\b|\bHR\b/i.test(text)) return 'High';
  if (/\b(?:medium|mid|med)\s*(?:roof|rf)\b/i.test(text)) return 'Medium';
  if (/\blow\s*(?:roof|rf)\b/i.test(text)) return 'Low';
  if (/\bstandard\s*(?:roof|rf)\b/i.test(text)) return 'Standard';
  return null;
}

// Full-size vans: exterior height separates the roofs by 8"+ on every
// platform, so a band per roof is safe. Inches, published spec ranges.
const VAN_ROOFS: { model: RegExp; bands: [number, string][] }[] = [
  { model: /TRANSIT(?!\s*CONNECT)/i, bands: [[92, 'Low'], [105, 'Medium'], [Infinity, 'High']] },
  { model: /PROMASTER(?!\s*CITY)/i, bands: [[95, 'Low'], [105, 'High'], [Infinity, 'Super high']] },
  { model: /SPRINTER/i, bands: [[101, 'Standard'], [112, 'High'], [Infinity, 'Super high']] },
];

export function roofFromHeight(model: string, overallHeightIn: number): string | null {
  if (!Number.isFinite(overallHeightIn) || overallHeightIn < 70) return null;
  const van = VAN_ROOFS.find(v => v.model.test(model));
  if (!van) return null;
  return van.bands.find(([max]) => overallHeightIn < max)![1];
}

const LABELS: Record<string, string> = {
  gross_vehicle_weight_rating: 'GVWR',
  manufacturer_suggested_retail_price: 'MSRP',
};
const label = (k: string) =>
  LABELS[k] || k.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

/**
 * Read a CarsXE /specs response. Returns null when it found nothing.
 * `cabHint` is NHTSA's cab type, used when CarsXE's style doesn't say.
 */
export function parseCarsxeSpecs(json: any, cabHint = ''): FactoryData | null {
  const a = json?.attributes;
  if (!json?.success || !a || typeof a !== 'object') return null;
  const s = (k: string) => {
    const v = a[k];
    return v == null ? '' : String(v).trim();
  };
  const model = s('model');
  const style = s('style');
  const text = [s('trim'), style, s('category'), s('type')].join(' ');

  const wbIn = inches(s('wheelbase_length') || s('wheelbase'));
  const heightIn = inches(s('overall_height'));

  let bed: FactoryValue | null = null;
  const printed = bedFromText(text);
  if (printed) bed = { value: feet(printed), source: 'factory style' };
  else if (/pickup|truck/i.test(text)) {
    const est = bedFromWheelbase(`${s('make')} ${model}`, `${text} ${cabHint}`, wbIn);
    if (est) bed = { value: feet(est), source: `from ${fmtIn(wbIn)} wheelbase` };
  }

  let roof: FactoryValue | null = null;
  const roofText = roofFromText(text);
  if (roofText) roof = { value: roofText, source: 'factory style' };
  else {
    const est = roofFromHeight(model, heightIn);
    if (est) roof = { value: est, source: `from ${fmtIn(heightIn)} overall height` };
  }

  const raw = Object.entries(a)
    .filter(([, v]) => v != null && v !== '' && typeof v !== 'object')
    .map(([k, v]) => ({ label: label(k), value: String(v) }));

  return {
    title: [s('year'), s('make'), model, s('trim')].filter(Boolean).join(' '),
    style,
    bed,
    roof,
    wheelbase: fmtIn(wbIn),
    overallHeight: fmtIn(heightIn),
    overallLength: fmtIn(inches(s('overall_length'))),
    gvwr: s('gross_vehicle_weight_rating'),
    curbWeight: s('curb_weight'),
    engine: s('engine'),
    drivetrain: s('drivetrain'),
    transmission: s('transmission'),
    seating: s('standard_seating'),
    raw,
  };
}

/**
 * Fold CarsXE's answers into the NHTSA decode the window shows: fill the
 * rows NHTSA left blank, add the style and exterior dimensions, and tag each
 * filled value with where it came from. NHTSA's own values are kept — the
 * two agree on everything they both carry. Works when NHTSA knew nothing.
 */
export function mergeFactory(details: VinDetails | null, f: FactoryData | null): VinDetails | null {
  if (!f) return details;
  const base: VinDetails = details && details.title ? structuredClone(details) : {
    title: '', make: '', warning: details?.warning || '',
    groups: [
      { heading: 'Vehicle', rows: [] }, { heading: 'Body', rows: [] },
      { heading: 'Drivetrain', rows: [] }, { heading: 'Weight', rows: [] },
    ],
  };
  if (!base.title) base.title = f.title;
  if (!base.make) base.make = f.title.split(' ')[1] || '';
  const group = (h: string) => {
    let g = base.groups.find(x => x.heading === h);
    if (!g) { g = { heading: h, rows: [] }; base.groups.push(g); }
    return g.rows;
  };
  const fill = (h: string, label: string, value: string, note = 'CarsXE', after?: string) => {
    if (!value) return;
    const rows = group(h);
    const row = rows.find(r => r.label === label);
    if (row) {
      if (!row.value) { row.value = value; row.note = note; }
      return;
    }
    const nr: VinDetailRow = { label, value, note };
    const i = after ? rows.findIndex(r => r.label === after) : -1;
    if (i >= 0) rows.splice(i + 1, 0, nr); else rows.push(nr);
  };
  fill('Vehicle', 'Style', f.style, 'CarsXE', 'Series');
  if (f.bed) fill('Body', 'Bed length', f.bed.value, `CarsXE · ${f.bed.source}`, 'Cab');
  fill('Body', 'Wheelbase', f.wheelbase);
  if (f.roof) fill('Body', 'Roof', f.roof.value, `CarsXE · ${f.roof.source}`, 'Wheelbase');
  fill('Body', 'Overall height', f.overallHeight, 'CarsXE', f.roof ? 'Roof' : 'Wheelbase');
  fill('Body', 'Overall length', f.overallLength, 'CarsXE', 'Overall height');
  fill('Drivetrain', 'Drive', f.drivetrain);
  fill('Drivetrain', 'Engine', f.engine);
  fill('Drivetrain', 'Transmission', f.transmission);
  fill('Weight', 'GVWR', f.gvwr);
  fill('Weight', 'Curb weight', f.curbWeight);
  return base;
}
