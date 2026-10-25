import { describe, it, expect } from 'vitest';
import { areaMiles, AREA_ZIP3, AREA_ZIP_MILES } from './outreach-area';
import { parseDotRow, parsePlace, tidyName, formatPhone, dotWhere, MIN_FLEET } from './outreach-sources';
import { weekOf, companyKey, phoneKey, isNewCompany, remember, dealOut, byNearest, type KnownCompanies } from './outreach-batch';

const empty = (): KnownCompanies => ({ names: new Set(), phones: new Set(), emails: new Set(), sourceIds: new Set() });

describe('outreach area', () => {
  it('knows the shop ZIP and nearby towns, and stops at 100 miles', () => {
    expect(areaMiles('63366')).toBe(0);
    expect(areaMiles('63366-1234')).toBe(0);
    expect(areaMiles('62234')).toBeGreaterThan(20); // Collinsville
    expect(areaMiles('64101')).toBeNull(); // Kansas City
    expect(areaMiles('60601')).toBeNull(); // Chicago
    expect(Math.max(...AREA_ZIP_MILES.values())).toBeLessThanOrEqual(100);
    expect(AREA_ZIP3).toContain('633');
    expect(dotWhere()).toContain("starts_with(phy_zip, '633')");
  });
});

describe('DOT census rows', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    dot_number: '1234567', legal_name: 'GATEWAY ROUTE FREIGHT LLC', dba_name: '',
    phy_street: '100 MAIN ST', phy_city: 'COLLINSVILLE', phy_state: 'IL', phy_zip: '62234-0001',
    telephone: '6185550193', email_address: 'Dispatch@Gateway.example', nbr_power_unit: '34', driver_total: '40',
    carrier_operation: 'A', ...over,
  });

  it('turns a fleet into a candidate with tidy names', () => {
    const c = parseDotRow(row())!;
    expect(c.companyName).toBe('Gateway Route Freight LLC');
    expect(c.city).toBe('Collinsville');
    expect(c.zip).toBe('62234');
    expect(c.phone).toBe('(618) 555-0193');
    expect(c.email).toBe('dispatch@gateway.example');
    expect(c.fleetSize).toBe(34);
    expect(c.facts.drivers).toBe(40);
    expect(c.miles).toBe(areaMiles('62234'));
  });

  it('prefers the DBA name when there is one', () => {
    expect(parseDotRow(row({ dba_name: 'GATEWAY ROUTE' }))!.companyName).toBe('Gateway Route');
  });

  it('skips tiny fleets, far-away fleets, and ones with no way to reach them', () => {
    expect(parseDotRow(row({ nbr_power_unit: String(MIN_FLEET - 1) }))).toBeNull();
    expect(parseDotRow(row({ phy_zip: '64101' }))).toBeNull();
    expect(parseDotRow(row({ telephone: '', email_address: '' }))).toBeNull();
    expect(parseDotRow(row({ nbr_power_unit: '' }))).toBeNull();
  });

  it('drops a malformed email but keeps the fleet', () => {
    const c = parseDotRow(row({ email_address: 'none' }))!;
    expect(c.email).toBeNull();
    expect(c.phone).toBeTruthy();
  });
});

describe('Google listings', () => {
  const place = (over: any = {}) => ({
    id: 'ChIJabc', displayName: { text: 'Riverbend Plumbing & Drain' }, businessStatus: 'OPERATIONAL',
    nationalPhoneNumber: '(636) 555-0142', websiteUri: 'https://riverbend.example',
    location: { latitude: 38.79, longitude: -90.5 }, userRatingCount: 88, googleMapsUri: 'https://maps.google.com/?cid=1',
    addressComponents: [
      { longText: '12', types: ['street_number'] }, { longText: 'Elm St', types: ['route'] },
      { longText: 'St. Charles', types: ['locality'] }, { longText: 'Missouri', shortText: 'MO', types: ['administrative_area_level_1'] },
      { longText: '63301', types: ['postal_code'] },
    ],
    ...over,
  });

  it('turns a listing into a trade candidate', () => {
    const c = parsePlace(place(), 'Plumbing')!;
    expect(c).toMatchObject({ source: 'google', kind: 'trade', trade: 'Plumbing', city: 'St. Charles', state: 'MO', zip: '63301', street: '12 Elm St' });
    expect(c.miles).toBe(areaMiles('63301'));
    expect(c.facts.reviews).toBe(88);
  });

  it('skips closed businesses and far-away ones', () => {
    expect(parsePlace(place({ businessStatus: 'CLOSED_PERMANENTLY' }), 'Plumbing')).toBeNull();
    expect(parsePlace(place({ addressComponents: [], location: { latitude: 39.1, longitude: -94.6 } }), 'Plumbing')).toBeNull();
  });
});

describe('names and phones', () => {
  it('tidies all-caps names and leaves mixed case alone', () => {
    expect(tidyName('ACME HVAC & PLUMBING CO')).toBe('Acme HVAC & Plumbing CO');
    expect(tidyName("O'NEIL BROS")).toBe("O'Neil Bros");
    expect(tidyName('Riverbend Plumbing')).toBe('Riverbend Plumbing');
  });

  it('formats 10-digit phones', () => {
    expect(formatPhone('+1 636-555-0142')).toBe('(636) 555-0142');
    expect(formatPhone('5550142')).toBe('5550142');
  });

  it('matches the same company however it is written', () => {
    expect(companyKey('The Acme Plumbing Co., LLC')).toBe(companyKey('ACME PLUMBING'));
    expect(companyKey('A & B Electric')).toBe(companyKey('A and B Electric Inc'));
    expect(phoneKey('(636) 555-0142')).toBe(phoneKey('1-636-555-0142'));
  });
});

describe('batch building', () => {
  it('weeks start on Monday, Chicago time', () => {
    expect(weekOf(new Date('2026-10-26T15:00:00Z'))).toBe('2026-10-26'); // Monday
    expect(weekOf(new Date('2026-11-01T18:00:00Z'))).toBe('2026-10-26'); // Sunday
    // 03:00Z Monday is still Sunday evening in O'Fallon.
    expect(weekOf(new Date('2026-10-26T03:00:00Z'))).toBe('2026-10-19');
  });

  it('skips anyone already known by name, phone, email or source', () => {
    const c = parseDotRow({
      dot_number: '9', legal_name: 'ACME TRUCKING INC', phy_zip: '63366', telephone: '6365550100',
      email_address: 'a@acme.example', nbr_power_unit: '9',
    })!;
    const known = empty();
    expect(isNewCompany(c, known)).toBe(true);
    known.names.add(companyKey('Acme Trucking'));
    expect(isNewCompany(c, known)).toBe(false);
    const k2 = empty(); k2.phones.add('6365550100');
    expect(isNewCompany(c, k2)).toBe(false);
    const k3 = empty(); k3.emails.add('a@acme.example');
    expect(isNewCompany(c, k3)).toBe(false);
    const k4 = empty(); remember(c, k4);
    expect(isNewCompany(c, k4)).toBe(false);
  });

  it('deals evenly and never past what each rep needs', () => {
    const dealt = dealOut([1, 2, 3, 4, 5, 6, 7], new Map([['a', 3], ['b', 2], ['c', 0]]));
    expect(dealt.get('a')).toEqual([1, 3, 5]);
    expect(dealt.get('b')).toEqual([2, 4]);
    expect(dealt.get('c')).toEqual([]);
  });

  it('sorts nearest first, then bigger fleets', () => {
    const mk = (miles: number, fleetSize: number, companyName = 'x') => ({ miles, fleetSize, companyName } as any);
    const sorted = [mk(30, 5), mk(10, 5), mk(10, 50)].sort(byNearest);
    expect(sorted.map(s => [s.miles, s.fleetSize])).toEqual([[10, 50], [10, 5], [30, 5]]);
  });
});
