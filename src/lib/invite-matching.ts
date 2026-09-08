/**
 * Smart invite matching (R6-5): rank the CNI invite picker instead of
 * showing an unordered list a coordinator has to eyeball.
 *
 * Honesty rule that shapes the whole design: this NEVER invents a
 * distance. Mileage appears only when the zip_centroids table has been
 * loaded with real data (migration 286 ships it empty on purpose). Until
 * then the ranking uses what the app genuinely knows — an explicit ZIP
 * list or state service area, ZIP-prefix proximity, service type,
 * equipment, availability and the R5-12 scorecard — and each chip names
 * the signal it actually used. A coordinator can trust "same area (ZIP
 * 606…)" in a way they could never trust a fabricated "42 mi".
 */

export interface CompanyForMatch {
  companyId: string;
  companyName: string;
  zip: string | null;
  state: string | null;
  serviceArea: { type?: string; value?: unknown } | null;
  coverageRadiusMiles: number | null;
  serviceTypes: string[];
  equipmentCapabilities: string[];
  availabilityStatus: string | null;
  riskTags: string[];
  /** From the R5-12 scorecards: 0-1, or null when there is no history. */
  onTimeRate: number | null;
  completions: number;
}

export interface JobForMatch {
  zip: string | null;
  state: string | null;
  /** Optional — cni_jobs carries free-text scope, not a typed service. */
  serviceType: string | null;
  requiredEquipment: string[];
}

export interface Coord { latitude: number; longitude: number }

export interface MatchChip { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' }

export interface CompanyMatch {
  companyId: string;
  companyName: string;
  score: number;
  chips: MatchChip[];
  /** Excluded outright — shown last, greyed, with the reason. */
  excluded: boolean;
  excludedReason: string | null;
  distanceMiles: number | null;
  outsideRadius: boolean;
}

const R_EARTH_MI = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle miles between two points. */
export function haversineMiles(a: Coord, b: Coord): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R_EARTH_MI * Math.asin(Math.min(1, Math.sqrt(s))) * 10) / 10;
}

export const zip5 = (z: string | null | undefined) => String(z || '').replace(/\D+/g, '').slice(0, 5);
export const zip3 = (z: string | null | undefined) => zip5(z).slice(0, 3);

/** The ZIPs a company listed, when its service area is a ZIP list. */
function listedZips(area: CompanyForMatch['serviceArea']): string[] {
  if (!area || area.type !== 'zips') return [];
  const v = area.value;
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  return raw.map(z => zip5(String(z))).filter(Boolean);
}

function listedStates(area: CompanyForMatch['serviceArea']): string[] {
  if (!area || area.type !== 'states') return [];
  const v = area.value;
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  return raw.map(s => String(s).trim().toUpperCase()).filter(Boolean);
}

interface CoverageResult {
  points: number;
  chip: MatchChip;
  distanceMiles: number | null;
  outsideRadius: boolean;
}

/**
 * How well the company covers the job's location, and the plain-language
 * chip explaining it. Distance is used ONLY when both ends have real
 * coordinates.
 */
function scoreCoverage(
  company: CompanyForMatch,
  job: JobForMatch,
  jobCoord: Coord | null,
  companyCoord: Coord | null,
): CoverageResult {
  const jz = zip5(job.zip);
  const cz = zip5(company.zip);

  // 1. An explicit ZIP list is the company's own answer — trust it first.
  const zips = listedZips(company.serviceArea);
  if (jz && zips.length > 0) {
    return zips.includes(jz)
      ? { points: 40, chip: { text: `covers ${jz}`, tone: 'good' }, distanceMiles: null, outsideRadius: false }
      : { points: 0, chip: { text: `${jz} not in their ZIP list`, tone: 'bad' }, distanceMiles: null, outsideRadius: true };
  }

  // 2. Real mileage, when we actually have coordinates for both ends.
  if (jobCoord && companyCoord) {
    const miles = haversineMiles(jobCoord, companyCoord);
    const radius = company.coverageRadiusMiles;
    if (radius && radius > 0) {
      if (miles <= radius) {
        // Closer is better inside the radius, but everything in-radius earns most of it.
        const closeness = 1 - Math.min(miles / radius, 1);
        return {
          points: 30 + Math.round(closeness * 10),
          chip: { text: `${miles} mi · inside their ${radius} mi radius`, tone: 'good' },
          distanceMiles: miles, outsideRadius: false,
        };
      }
      return {
        points: 0,
        chip: { text: `${miles} mi — outside their ${radius} mi radius`, tone: 'bad' },
        distanceMiles: miles, outsideRadius: true,
      };
    }
    return {
      points: miles <= 50 ? 34 : miles <= 150 ? 22 : 8,
      chip: { text: `${miles} mi away · no radius set`, tone: miles <= 150 ? 'good' : 'warn' },
      distanceMiles: miles, outsideRadius: false,
    };
  }

  // 3. A declared state list.
  const states = listedStates(company.serviceArea);
  if (job.state && states.length > 0) {
    const js = job.state.trim().toUpperCase();
    return states.includes(js)
      ? { points: 30, chip: { text: `covers ${js}`, tone: 'good' }, distanceMiles: null, outsideRadius: false }
      : { points: 0, chip: { text: `${js} not in their states`, tone: 'bad' }, distanceMiles: null, outsideRadius: true };
  }

  // 4. No coordinates: ZIP prefixes are geographically clustered, so a
  //    shared prefix is a real proximity signal — reported as what it is,
  //    an area match, never dressed up as mileage.
  if (jz && cz) {
    if (zip3(jz) === zip3(cz)) {
      return { points: 25, chip: { text: `same area (ZIP ${zip3(jz)}…)`, tone: 'good' }, distanceMiles: null, outsideRadius: false };
    }
    if (job.state && company.state && job.state.trim().toUpperCase() === company.state.trim().toUpperCase()) {
      return { points: 15, chip: { text: `same state (${company.state.toUpperCase()})`, tone: 'warn' }, distanceMiles: null, outsideRadius: false };
    }
    return { points: 4, chip: { text: `ZIP ${cz} · load the ZIP table for mileage`, tone: 'muted' }, distanceMiles: null, outsideRadius: false };
  }

  return { points: 0, chip: { text: 'no service area on file', tone: 'muted' }, distanceMiles: null, outsideRadius: false };
}

/**
 * Rank companies for one job. Excluded companies (do_not_assign) are kept
 * in the list but flagged and sorted last — a coordinator should see that
 * a company was deliberately skipped, not wonder where it went.
 */
export function rankCompanies(
  companies: CompanyForMatch[],
  job: JobForMatch,
  coords: { job: Coord | null; byCompanyId: Record<string, Coord> },
): CompanyMatch[] {
  const out = companies.map((c): CompanyMatch => {
    const chips: MatchChip[] = [];
    let score = 0;

    const cov = scoreCoverage(c, job, coords.job, coords.byCompanyId[c.companyId] || null);
    score += cov.points;
    chips.push(cov.chip);

    // Service type — neutral when the job doesn't declare one, rather than
    // penalising every company for a blank field.
    if (job.serviceType) {
      if (c.serviceTypes.includes(job.serviceType)) {
        score += 20;
        chips.push({ text: `does ${job.serviceType.replace(/_/g, ' ')}`, tone: 'good' });
      } else {
        chips.push({ text: `no ${job.serviceType.replace(/_/g, ' ')} on their profile`, tone: 'warn' });
      }
    } else {
      score += 10;
    }

    if (job.requiredEquipment.length > 0) {
      const missing = job.requiredEquipment.filter(e => !c.equipmentCapabilities.includes(e));
      if (missing.length === 0) {
        score += 10;
        chips.push({ text: 'has the equipment', tone: 'good' });
      } else {
        chips.push({ text: `missing ${missing.join(', ').replace(/_/g, ' ')}`, tone: 'warn' });
      }
    } else {
      score += 5;
    }

    const avail = c.availabilityStatus || 'available';
    if (avail === 'available') { score += 15; }
    else if (avail === 'limited') { score += 7; chips.push({ text: 'limited availability', tone: 'warn' }); }
    else { chips.push({ text: 'marked unavailable', tone: 'bad' }); }

    if (c.onTimeRate != null && c.completions >= 3) {
      score += Math.round(c.onTimeRate * 15);
      chips.push({
        text: `${Math.round(c.onTimeRate * 100)}% on time (${c.completions})`,
        tone: c.onTimeRate >= 0.9 ? 'good' : c.onTimeRate >= 0.7 ? 'warn' : 'bad',
      });
    } else {
      chips.push({ text: c.completions > 0 ? `${c.completions} job${c.completions !== 1 ? 's' : ''}, thin history` : 'no history yet', tone: 'muted' });
    }

    if (c.riskTags.includes('preferred')) {
      score += 5;
      chips.push({ text: 'preferred', tone: 'good' });
    }

    const excluded = c.riskTags.includes('do_not_assign');
    return {
      companyId: c.companyId,
      companyName: c.companyName,
      score: excluded ? 0 : score,
      chips,
      excluded,
      excludedReason: excluded ? 'Tagged do-not-assign' : null,
      distanceMiles: cov.distanceMiles,
      outsideRadius: cov.outsideRadius,
    };
  });

  return out.sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    return a.companyName.localeCompare(b.companyName);
  });
}

/** The next company to try when a job has no responses past SLA. */
export function nextBestCompany(matches: CompanyMatch[], alreadyInvited: string[]): CompanyMatch | null {
  const invited = new Set(alreadyInvited);
  return matches.find(m => !m.excluded && !invited.has(m.companyId) && !m.outsideRadius) || null;
}
