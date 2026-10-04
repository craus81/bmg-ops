// Filter facets for the wrap estimator's vehicle picker.
//
// Template rows carry year / make / model as columns, but body details live
// in the free-text variant ("Passenger Van, 148in, Med Roof, Sliding Door",
// "Super Duty Crew Cab Dually 172in", "Supercrew 5.5' Box"). This pulls the
// three a person narrows by — roof height, bed length, cab size — out of that
// text, plus the wheelbase (the wheelbase_in column, else an "NNNin" token),
// so the picker can offer them as dropdowns without a schema change.

export interface FacetSource {
  variant?: string | null;
  name?: string | null;
  wheelbase_in?: number | string | null;
}

export interface TemplateFacets {
  /** Whole inches as a string ("148"), or '' when unknown. */
  wheelbase: string;
  roof: string;
  bed: string;
  cab: string;
}

// Checked in order — first hit wins, so the longer names sit above the ones
// they contain ("SuperCrew" before "Crew Cab", "Super Cab" before plain cab).
const CABS: [RegExp, string][] = [
  [/\bsuper ?crew\b/i, 'SuperCrew'],
  [/\bcrew ?max\b/i, 'CrewMax'],
  [/\bsuper ?cab\b/i, 'Super Cab'],
  [/\bcrew ?cab\b/i, 'Crew Cab'],
  [/\bextended cab\b/i, 'Extended Cab'],
  [/\bdouble cab\b/i, 'Double Cab'],
  [/\bquad cab\b/i, 'Quad Cab'],
  [/\bmega cab\b/i, 'Mega Cab'],
  [/\bking cab\b/i, 'King Cab'],
  [/\baccess cab\b/i, 'Access Cab'],
  [/\bclub cab\b/i, 'Club Cab'],
  [/\bxtra ?cab\b/i, 'XtraCab'],
  [/\b(?:regular|reg|single|standard) cab\b/i, 'Regular Cab'],
  [/\bday cab\b/i, 'Day Cab'],
];

const ROOFS: [RegExp, string][] = [
  [/\bsuper high roof\b/i, 'Super High'],
  [/\bmega roof\b/i, 'Mega'],
  [/\bhigh roof\b/i, 'High'],
  [/\bmed(?:ium)?\.? roof\b/i, 'Medium'],
  [/\blow roof\b/i, 'Low'],
  [/\b(?:standard|regular) roof\b/i, 'Standard'],
];

/** Display order for the roof dropdown (lowest first). */
export const ROOF_ORDER = ['Low', 'Standard', 'Medium', 'High', 'Super High', 'Mega'];

function bedOf(text: string): string {
  // A measured bed/box wins over a word: "Supercrew 5.5' Box", "16ft Box".
  const measured = /(\d+(?:\.\d+)?)\s*(?:'|ft)\s*(?:standard |long |short )?(?:box|bed)\b/i.exec(text);
  if (measured) return `${measured[1]}'`;
  const feetInches = /(\d+)'(\d+)in\s*(?:box|bed)\b/i.exec(text); // "6'4in Box"
  if (feetInches) return `${feetInches[1]}'${feetInches[2]}"`;
  const bare = /\b(\d+(?:\.\d+)?) (?:box|bed)\b/i.exec(text); // "Supercab 8 Box" (foot mark dropped)
  if (bare) return `${bare[1]}'`;
  if (/\bflat ?bed\b/i.test(text)) return 'Flat Bed';
  if (/\bflareside\b/i.test(text)) return 'Flareside';
  const worded = /\b(short|standard|regular|reg|long)\s?(?:box|bed)\b/i.exec(text);
  if (worded) {
    const w = worded[1].toLowerCase();
    return w === 'short' ? 'Short' : w === 'long' ? 'Long' : 'Standard';
  }
  if (/\bcab chassis\b|\bchassis\b/i.test(text) && /\bcab\b/i.test(text) && !/\bchassis cab\b/i.test(text)) return 'Chassis';
  return '';
}

export function templateFacets(t: FacetSource): TemplateFacets {
  const text = `${t.variant || ''} ${t.variant ? '' : t.name || ''}`.trim();
  const wbCol = Number(t.wheelbase_in);
  const wbText = /(?:^|[\s,;])(\d{2,3})in\b/.exec(text);
  const wheelbase = wbCol > 0 ? String(Math.round(wbCol)) : wbText ? wbText[1] : '';
  return {
    wheelbase,
    roof: ROOFS.find(([re]) => re.test(text))?.[1] || '',
    bed: bedOf(text),
    cab: CABS.find(([re]) => re.test(text))?.[1] || '',
  };
}
