import { describe, it, expect, afterEach } from 'vitest';
import {
  pickInvoiceLocation,
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

describe('pickInvoiceLocation confidence', () => {
  // `confident` gates the backfill: it must be false ONLY when we fell back to
  // O'Fallon for a Masterack invoice whose plant we couldn't identify, so the
  // backfill never overwrites an already-correct plant with that guess.
  it('is not confident for Masterack with an indeterminate plant', () => {
    expect(pickInvoiceLocation({ customerName: 'Masterack LLC' })).toEqual({ name: "O'Fallon", confident: false });
    expect(pickInvoiceLocation({ customerName: 'Masterack', city: 'Detroit' })).toEqual({ name: "O'Fallon", confident: false });
  });

  it('is confident for a matched Masterack plant', () => {
    expect(pickInvoiceLocation({ customerName: 'Masterack LLC', city: 'Wentzville' })).toEqual({ name: 'Wentzville', confident: true });
    expect(pickInvoiceLocation({ locationName: 'Masterack - Kansas City' })).toEqual({ name: 'Kansas City', confident: true });
  });

  it('is confident for Designs That Stick and for the everything-else O\'Fallon', () => {
    expect(pickInvoiceLocation({ customerName: 'Designs That Stick' })).toEqual({ name: 'Kansas City', confident: true });
    expect(pickInvoiceLocation({ customerName: 'Acme Fleet' })).toEqual({ name: "O'Fallon", confident: true });
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
      confident: true,
    });
    __resetLocationCache();
    expect(await resolveInvoiceLocation({ customerName: 'Acme' })).toEqual({
      id: KNOWN_LOCATION_IDS.ofallon,
      name: "O'Fallon",
      confident: true,
    });
  });
});
