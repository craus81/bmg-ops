/**
 * Vehicle fitment detection from part text (N4-B2 phase 1). Craig's
 * observation: "most of the vehicle specific parts have the vehicle name
 * in the description" — so scan item text for platform names plus
 * wheelbase/roof qualifiers and emit advisory fitment tags
 * (source='description'; never overwrites human tags).
 *
 * Ordering traps handled here and pinned by tests: TRANSIT CONNECT must
 * not tag as TRANSIT, PROMASTER CITY not as PROMASTER, CITY EXPRESS not
 * as EXPRESS/SAVANA, and bare "RAM" (as in a Sprinter's cargo ram) never
 * tags a Ram truck — only RAM 1500/2500/3500 do.
 */

export interface FitmentHit {
  platformKey: string;
  wheelbase: string | null;
  roof: string | null;
}

// Most-specific first — a hit on an earlier pattern suppresses the broader
// sibling listed in `excludes`.
const PLATFORM_PATTERNS: { key: string; re: RegExp; excludes?: string[] }[] = [
  { key: 'transit-connect', re: /\bTRANSIT[\s-]*CONNECT\b/i, excludes: ['transit'] },
  { key: 'transit', re: /\b(?:E-)?TRANSIT\b/i },
  { key: 'promaster-city', re: /\bPRO[\s-]?MASTER[\s-]*CITY\b/i, excludes: ['promaster'] },
  { key: 'promaster', re: /\bPRO[\s-]?MASTER\b/i },
  { key: 'sprinter', re: /\bSPRINTER\b/i },
  { key: 'metris', re: /\bMETRIS\b/i },
  { key: 'city-express', re: /\bCITY[\s-]*EXPRESS\b/i, excludes: ['express-savana'] },
  { key: 'express-savana', re: /\bEXPRESS\b|\bSAVANA\b/i },
  { key: 'brightdrop', re: /\bBRIGHTDROP\b|\bZEVO\b/i },
  { key: 'maverick', re: /\bMAVERICK\b/i },
  { key: 'super-duty', re: /\bF[\s-]?[23]50\b|\bSUPER[\s-]*DUTY\b/i },
  { key: 'f-150', re: /\bF[\s-]?150\b/i },
  { key: 'ram-hd', re: /\bRAM[\s-]*[23]500\b/i },
  { key: 'ram-1500', re: /\bRAM[\s-]*1500\b/i },
  { key: 'silverado-sierra-hd', re: /\b(?:SILVERADO|SIERRA)[\s-]*(?:[23]500|HD)\b/i, excludes: ['silverado-sierra-1500'] },
  { key: 'silverado-sierra-1500', re: /\bSILVERADO\b|\bSIERRA\b/i },
  { key: 'frontier', re: /\bFRONTIER\b/i },
  { key: 'tacoma', re: /\bTACOMA\b/i },
];

// Wheelbases seen across BMG's platforms; matched as a number followed by
// an optional EL and either a quote mark, WB, or a roof abbreviation.
const WHEELBASE_RE = /\b(1[0-7]\d)(?:\s*(EL))?\s*(?:["”]|\s?WB\b|\s?(?:HR|MR|LR)\b|\s+(?:HIGH|MED(?:IUM)?|MID|LOW)\s+ROOF)/i;

const ROOF_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'high', re: /\bHIGH[\s-]*ROOF\b|\b1[0-7]\d\s*(?:EL\s*)?HR\b|\bHR\s+ROOF\b/i },
  { label: 'medium', re: /\bMED(?:IUM)?[\s-]*ROOF\b|\bMID[\s-]*ROOF\b|\b1[0-7]\d\s*(?:EL\s*)?MR\b/i },
  { label: 'low', re: /\bLOW[\s-]*ROOF\b|\b1[0-7]\d\s*(?:EL\s*)?LR\b/i },
];

/**
 * Detect platform fitment tags in free text. Returns at most one hit per
 * platform, with wheelbase/roof qualifiers when the text carries them.
 */
export function detectFitment(text: string | null | undefined): FitmentHit[] {
  if (!text) return [];
  const hits: FitmentHit[] = [];
  const suppressed = new Set<string>();

  const wbMatch = text.match(WHEELBASE_RE);
  const wheelbase = wbMatch ? `${wbMatch[1]}${wbMatch[2] ? ' EL' : ''}` : null;
  const roof = ROOF_PATTERNS.find(r => r.re.test(text))?.label || null;

  for (const p of PLATFORM_PATTERNS) {
    if (suppressed.has(p.key)) continue;
    if (!p.re.test(text)) continue;
    hits.push({ platformKey: p.key, wheelbase, roof });
    for (const ex of p.excludes || []) suppressed.add(ex);
  }
  return hits;
}
