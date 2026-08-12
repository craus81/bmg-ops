/**
 * VIN/decode → vehicle_platforms resolution (N4-B2 phase 2). Maps a vPIC
 * decode (make/model) to a platform key, then squeezes wheelbase/roof out
 * of the VIN where the OEM encodes it:
 *  - Ford Transit: positions 5-7 encode body/series incl. roof + WB (the
 *    table below covers the common cargo-van codes; unknown codes simply
 *    resolve without qualifiers — the rep can answer instead)
 *  - Sprinter: positions 5-6 encode wheelbase; roof is NOT in the VIN
 *  - Everyone else: platform only (vPIC's WheelBase field helps when set)
 * Deliberately conservative: null qualifiers mean "ask or ignore", never
 * a guess.
 */

export interface PlatformResolution {
  platformKey: string | null;
  wheelbase: string | null;
  roof: 'low' | 'medium' | 'high' | null;
}

// Ford Transit VIN positions 5-7 (cargo/passenger van codes, 2015+).
// R=roof (L/M/H), WB in inches. Partial by design — extend as codes appear.
const TRANSIT_BODY: Record<string, { roof: 'low' | 'medium' | 'high'; wheelbase: string }> = {
  E1Y: { roof: 'low', wheelbase: '130' },
  E1C: { roof: 'medium', wheelbase: '130' },
  E1Z: { roof: 'low', wheelbase: '148' },
  E2C: { roof: 'medium', wheelbase: '148' },
  E1X: { roof: 'high', wheelbase: '148' },
  E2X: { roof: 'high', wheelbase: '148 EL' },
};

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
    const body = TRANSIT_BODY[v.slice(4, 7)];
    if (body) { roof = body.roof; wheelbase = body.wheelbase; }
  }
  if (platformKey === 'sprinter' && v.length === 17) {
    wheelbase = SPRINTER_WB[v.slice(4, 6)] || null;
  }
  return { platformKey, wheelbase, roof };
}
