/**
 * VIN/decode → vehicle_platforms resolution (N4-B2 phase 2). Maps a vPIC
 * decode (make/model) to a platform key, then squeezes wheelbase/roof out
 * of the VIN where the OEM encodes it:
 *  - Ford Transit: positions 5-7 are the body code (e.g. R2C) — position 6
 *    digit is the wheelbase, position 7 letter is the roof
 *  - Sprinter: positions 5-6 encode wheelbase; roof is NOT in the VIN
 *  - Everyone else: platform only (matchQualifiersToConfig picks up
 *    vPIC's dimensional fields where they're unambiguous)
 * Deliberately conservative: null qualifiers mean "ask or ignore", never
 * a guess.
 */

export interface PlatformResolution {
  platformKey: string | null;
  wheelbase: string | null;
  roof: 'low' | 'medium' | 'high' | null;
}

// Ford Transit VIN body code, positions 5-7 (2015+ US full-size Transit).
// Position 5: R = van (wagons/cutaways use other letters — not decoded).
// Position 6 digit = wheelbase: 1 = 130", 2 = 148", 3 = 148" EL.
// Position 7 letter = roof (+ door config): Y/Z = low, C/D = medium,
// X/U = high. Y/Z/C/X confirmed against Ford dealer body-decoder tables
// (R1Y/R1Z low·130, R2Y/R2Z low·148, R1C medium·130, R2C medium·148,
// R2X high·148, R3X high·148 EL); D/U are the same tables' door variants.
const TRANSIT_WB: Record<string, string> = { '1': '130', '2': '148', '3': '148 EL' };
const TRANSIT_ROOF: Record<string, 'low' | 'medium' | 'high'> = {
  Y: 'low', Z: 'low', C: 'medium', D: 'medium', X: 'high', U: 'high',
};

function transitBody(v: string): { roof: PlatformResolution['roof']; wheelbase: string | null } | null {
  const code = v.slice(4, 7);
  if (!/^R\d[A-Z]$/.test(code)) return null;
  const wheelbase = TRANSIT_WB[code[1]] || null;
  const roof = TRANSIT_ROOF[code[2]] || null;
  return wheelbase || roof ? { roof, wheelbase } : null;
}

// Sprinter VIN positions 5-6 → wheelbase (US cargo vans).
const SPRINTER_WB: Record<string, string> = {
  E7: '144', F0: '144',
  E8: '170', F1: '170',
};

const MODEL_MAP: { re: RegExp; key: string }[] = [
  { re: /TRANSIT\s*CONNECT/i, key: 'transit-connect' },
  { re: /E-?TRANSIT|TRANSIT/i, key: 'transit' },
  { re: /PROMASTER\s*CITY/i, key: 'promaster-city' },
  { re: /PROMASTER/i, key: 'promaster' },
  { re: /SPRINTER/i, key: 'sprinter' },
  { re: /METRIS/i, key: 'metris' },
  { re: /CITY\s*EXPRESS/i, key: 'city-express' },
  { re: /EXPRESS|SAVANA/i, key: 'express-savana' },
  { re: /ZEVO|BRIGHTDROP/i, key: 'brightdrop' },
  { re: /MAVERICK/i, key: 'maverick' },
  { re: /F-?[23]50|SUPER\s*DUTY/i, key: 'super-duty' },
  { re: /F-?150/i, key: 'f-150' },
  { re: /FRONTIER/i, key: 'frontier' },
  { re: /TACOMA/i, key: 'tacoma' },
];

export function resolvePlatform(
  decoded: { make?: string | null; model?: string | null; series?: string | null },
  vin?: string | null,
): PlatformResolution {
  const make = (decoded.make || '').toUpperCase();
  const model = (decoded.model || '').toUpperCase();
  const series = (decoded.series || '').toUpperCase();
  const v = (vin || '').toUpperCase();

  let platformKey: string | null = null;
  // Ram/Silverado/Sierra numeric models need the make for disambiguation.
  if (/RAM/.test(make) || /DODGE/.test(make)) {
    if (/PROMASTER\s*CITY/.test(model)) platformKey = 'promaster-city';
    else if (/PROMASTER/.test(model)) platformKey = 'promaster';
    else if (/1500/.test(model + series)) platformKey = 'ram-1500';
    else if (/[23]500/.test(model + series)) platformKey = 'ram-hd';
  } else if (/CHEVROLET|GMC/.test(make) && /SILVERADO|SIERRA/.test(model)) {
    platformKey = /[23]500|HD/.test(model + series) ? 'silverado-sierra-hd' : 'silverado-sierra-1500';
  } else {
    platformKey = MODEL_MAP.find(m => m.re.test(model))?.key || null;
  }

  let wheelbase: string | null = null;
  let roof: PlatformResolution['roof'] = null;
  if (platformKey === 'transit' && v.length === 17) {
    const body = transitBody(v);
    if (body) { roof = body.roof; wheelbase = body.wheelbase; }
  }
  if (platformKey === 'sprinter' && v.length === 17) {
    wheelbase = SPRINTER_WB[v.slice(4, 6)] || null;
  }
  return { platformKey, wheelbase, roof };
}

export interface QualifierFill {
  wheelbase: string | null;
  cab: string | null;
  bed: string | null;
}

// vPIC's BodyCabType is a category string, not the marketing name: crew-style
// cabs come back as "Crew/ Super Crew/ Crew Max", extended-style as
// "Extra/Super/Quad/Double/King/Extended". Match each family against the
// platform's configured cab labels.
const CREW_OPTION_RE = /crew|mega|max/i;
const EXT_OPTION_RE = /xtra|extra|super|quad|double|king|extended/i;

const uniqueOrNull = (candidates: string[]): string | null =>
  candidates.length === 1 ? candidates[0] : null;

/**
 * Map vPIC's dimensional/config decode fields onto a platform's configured
 * option labels — the fallback for what the VIN itself doesn't encode.
 * Fills a field only when exactly one configured option matches; two
 * candidates (Transit 148 vs 148 EL share a 148" wheelbase, Ram Crew vs
 * Mega are both vPIC "Crew") mean the rep picks by hand.
 */
export function matchQualifiersToConfig(
  decoded: { wheelBaseIn?: string | null; bedLengthIn?: string | null; cabType?: string | null },
  config: { wheelbases?: string[]; cabs?: string[]; beds?: string[] } | null | undefined,
): QualifierFill {
  const fill: QualifierFill = { wheelbase: null, cab: null, bed: null };
  if (!config) return fill;

  const wbIn = parseFloat(decoded.wheelBaseIn || '');
  if (Number.isFinite(wbIn) && config.wheelbases?.length) {
    fill.wheelbase = uniqueOrNull(
      config.wheelbases.filter(w => Math.abs(parseFloat(w) - wbIn) <= 2.5),
    );
  }

  const bedIn = parseFloat(decoded.bedLengthIn || '');
  if (Number.isFinite(bedIn) && config.beds?.length) {
    // Bed labels are feet ("5.5", "8"); vPIC reports inches. ~4" tolerance.
    fill.bed = uniqueOrNull(
      config.beds.filter(b => Math.abs(parseFloat(b) - bedIn / 12) <= 0.35),
    );
  }

  const cab = decoded.cabType || '';
  if (cab && config.cabs?.length) {
    if (/crew/i.test(cab)) {
      fill.cab = uniqueOrNull(config.cabs.filter(c => CREW_OPTION_RE.test(c)));
    } else if (EXT_OPTION_RE.test(cab)) {
      fill.cab = uniqueOrNull(config.cabs.filter(c => EXT_OPTION_RE.test(c) && !/crew/i.test(c)));
    } else if (/regular/i.test(cab)) {
      fill.cab = uniqueOrNull(config.cabs.filter(c => /regular/i.test(c)));
    }
  }

  return fill;
}
