import { describe, it, expect } from 'vitest';
import {
  haversineMiles, nextBestCompany, rankCompanies, zip3,
  type CompanyForMatch, type JobForMatch,
} from './invite-matching';

const co = (over: Partial<CompanyForMatch> = {}): CompanyForMatch => ({
  companyId: 'c1', companyName: 'Acme Installs', zip: '60601', state: 'IL',
  serviceArea: null, coverageRadiusMiles: 50,
  serviceTypes: ['graphics_install'], equipmentCapabilities: ['shop'],
  availabilityStatus: 'available', riskTags: [], onTimeRate: 0.95, completions: 10,
  ...over,
});
const job: JobForMatch = { zip: '60614', state: 'IL', serviceType: 'graphics_install', requiredEquipment: [] };
const noCoords = { job: null, byCompanyId: {} };

describe('haversineMiles', () => {
  it('measures a known distance — Chicago to Milwaukee is about 83 miles', () => {
    const miles = haversineMiles({ latitude: 41.8781, longitude: -87.6298 }, { latitude: 43.0389, longitude: -87.9065 });
    expect(miles).toBeGreaterThan(75);
    expect(miles).toBeLessThan(90);
  });
});

describe('rankCompanies — never invents a distance', () => {
  it('with no centroid data, reports an AREA match and no mileage', () => {
    const [m] = rankCompanies([co()], job, noCoords);
    expect(m.distanceMiles).toBeNull();
    expect(m.chips.map(c => c.text).join(' ')).toContain(`same area (ZIP ${zip3('60614')}…)`);
    // Nothing in the output claims miles.
    expect(m.chips.some(c => /\d+\s*mi\b/.test(c.text))).toBe(false);
  });

  it('uses real mileage and the radius verdict once coordinates exist', () => {
    const coords = {
      job: { latitude: 41.9227, longitude: -87.6490 },        // Chicago
      byCompanyId: { c1: { latitude: 43.0389, longitude: -87.9065 } }, // Milwaukee
    };
    const [m] = rankCompanies([co({ coverageRadiusMiles: 50 })], job, coords);
    expect(m.distanceMiles).toBeGreaterThan(70);
    expect(m.outsideRadius).toBe(true);
    expect(m.chips[0].text).toMatch(/outside their 50 mi radius/);
  });

  it('trusts an explicit ZIP list over everything else', () => {
    const covers = co({ serviceArea: { type: 'zips', value: ['60614', '60601'] } });
    const misses = co({ companyId: 'c2', companyName: 'Bravo', serviceArea: { type: 'zips', value: ['90210'] } });
    const ranked = rankCompanies([misses, covers], job, noCoords);
    expect(ranked[0].companyId).toBe('c1');
    expect(ranked[0].chips[0].text).toBe('covers 60614');
    expect(ranked[1].outsideRadius).toBe(true);
  });

  it('honors a declared state list', () => {
    const [m] = rankCompanies([co({ zip: null, serviceArea: { type: 'states', value: ['IL', 'WI'] } })], job, noCoords);
    expect(m.chips[0].text).toBe('covers IL');
  });
});

describe('rankCompanies — ordering and flags', () => {
  it('sorts do-not-assign last and flags it rather than hiding it', () => {
    const banned = co({ companyId: 'c2', companyName: 'Banned Co', riskTags: ['do_not_assign'] });
    const ranked = rankCompanies([banned, co()], job, noCoords);
    expect(ranked[ranked.length - 1].companyId).toBe('c2');
    expect(ranked[ranked.length - 1]).toMatchObject({ excluded: true, excludedReason: 'Tagged do-not-assign', score: 0 });
  });

  it('rewards availability, service-type and equipment matches, and says what is missing', () => {
    const unavailable = co({ companyId: 'c2', companyName: 'Busy Co', availabilityStatus: 'unavailable' });
    const ranked = rankCompanies([unavailable, co()], job, noCoords);
    expect(ranked[0].companyId).toBe('c1');
    expect(ranked[1].chips.some(c => c.text === 'marked unavailable')).toBe(true);

    const needsLift: JobForMatch = { ...job, requiredEquipment: ['lift_bucket'] };
    const [m] = rankCompanies([co()], needsLift, noCoords);
    expect(m.chips.some(c => c.text === 'missing lift bucket')).toBe(true);
  });

  it('calls thin history what it is instead of scoring it as good', () => {
    const [rookie] = rankCompanies([co({ onTimeRate: 1, completions: 1 })], job, noCoords);
    expect(rookie.chips.some(c => c.text === '1 job, thin history')).toBe(true);
    expect(rookie.chips.some(c => /% on time/.test(c.text))).toBe(false);
  });

  it('stays neutral on service type when the job never declared one', () => {
    const untyped: JobForMatch = { ...job, serviceType: null };
    const [m] = rankCompanies([co({ serviceTypes: [] })], untyped, noCoords);
    expect(m.chips.some(c => /no .* on their profile/.test(c.text))).toBe(false);
  });
});

describe('nextBestCompany', () => {
  it('skips the already-invited, the excluded, and anyone out of radius', () => {
    const matches = rankCompanies([
      co({ companyId: 'a', companyName: 'A' }),
      co({ companyId: 'b', companyName: 'B' }),
      co({ companyId: 'x', companyName: 'X', riskTags: ['do_not_assign'] }),
    ], job, noCoords);
    expect(nextBestCompany(matches, ['a'])?.companyId).toBe('b');
    expect(nextBestCompany(matches, ['a', 'b'])).toBeNull();
  });
});
