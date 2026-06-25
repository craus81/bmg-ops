import { describe, it, expect, afterEach } from 'vitest';
import {
  pickInvoiceLocationName,
  resolveInvoiceLocation,
  KNOWN_LOCATION_IDS,
  __resetLocationCache,
} from './invoice-location';

// The picker is pure business policy: which NetSuite location a FleetSuite
// invoice books to, given its customer + ship-to. These lock the rule down.

describe('pickInvoiceLocationName', () => {
  it('routes Masterack to the plant named in the ship-to city', () => {
    expect(pickInvoiceLocationName({ customerName: 'Masterack LLC', city: 'Wentzville' })).toBe('Wentzville');
    expect(pickInvoiceLocationName({ customerName: 'Masterack LLC', city: 'Kansas City' })).toBe('Kansas City');
    expect(pickInvoiceLocationName({ customerName: 'Masterack LLC', city: 'Social Circle' })).toBe('Social Circle');
  });

  it('reads the Masterack plant from a scan work-location name', () => {
    expect(
      pickInvoiceLocationName({ customerName: 'Masterack LLC', locationName: 'Masterack - Kansas City' })
    ).toBe('Kansas City');
    expect(pickInvoiceLocationName({ locationName: 'Masterack - Social Circle' })).toBe('Social Circle');
  });

  it('defaults Masterack to O\'Fallon when the plant is indeterminate', () => {
    expect(pickInvoiceLocationName({ customerName: 'Masterack LLC' })).toBe("O'Fallon");
    expect(pickInvoiceLocationName({ customerName: 'Masterack', city: 'Detroit' })).toBe("O'Fallon");
  });

  it('routes Designs That Stick to Kansas City regardless of ship-to', () => {
    expect(pickInvoiceLocationName({ customerName: 'Designs That Stick' })).toBe('Kansas City');
    expect(pickInvoiceLocationName({ customerName: 'Designs That Stick LLC', city: 'Wentzville' })).toBe('Kansas City');
  });

  it('books everything else to O\'Fallon — even a non-Masterack customer shipping to a plant city', () => {
    // The faithfulness test: only Masterack / Designs That Stick get a non-O'Fallon location.
    expect(pickInvoiceLocationName({ customerName: 'Ranger Design', city: 'Kansas City' })).toBe("O'Fallon");
    expect(pickInvoiceLocationName({ customerName: 'Enterprise Fleet', city: 'Wentzville' })).toBe("O'Fallon");
    expect(pickInvoiceLocationName({ customerName: 'Some Dealership' })).toBe("O'Fallon");
    expect(pickInvoiceLocationName({})).toBe("O'Fallon");
  });

  it('is case- and punctuation-insensitive', () => {
    expect(pickInvoiceLocationName({ customerName: 'MASTERACK', city: 'wentzville' })).toBe('Wentzville');
    expect(pickInvoiceLocationName({ customerName: '  masterack llc ', city: "Kansas  City" })).toBe('Kansas City');
  });
});

describe('resolveInvoiceLocation', () => {
  afterEach(() => __resetLocationCache());

  // With no NetSuite env configured the live lookup throws and is swallowed, so
  // resolution falls back to the known production ids — which is exactly the
  // id→name mapping we want to assert here.
  it('maps the chosen location name to its NetSuite internal id', async () => {
    expect(await resolveInvoiceLocation({ customerName: 'Masterack LLC', city: 'Kansas City' })).toEqual({
      id: KNOWN_LOCATION_IDS.kansascity,
      name: 'Kansas City',
    });
    __resetLocationCache();
    expect(await resolveInvoiceLocation({ customerName: 'Acme' })).toEqual({
      id: KNOWN_LOCATION_IDS.ofallon,
      name: "O'Fallon",
    });
  });
});
