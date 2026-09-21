import { describe, it, expect } from 'vitest';
import { compareShipToLocation, sameCity } from './plant-location';

// The rule these lock down (field ask, 2026-09-21: "when matching PO's the
// location has to match"): the same part is ordered per plant, so an install
// done at one plant must never consume another plant's PO line. What it must
// NOT do is refuse a PO it simply can't place — most ship-tos are extracted
// from a PDF and plenty are blank.

const PLANTS = ['wentzville', 'kansascity', 'socialcircle'];

describe('compareShipToLocation', () => {
  it('agrees when the ship-to and the work location name the same plant', () => {
    expect(compareShipToLocation({ city: 'Kansas City' }, 'Masterack - Kansas City', PLANTS)).toBe('match');
    expect(compareShipToLocation({ name: 'Masterack Wentzville' }, 'Masterack - Wentzville', PLANTS)).toBe('match');
  });

  it('conflicts when they name different plants — the bug this exists to stop', () => {
    expect(compareShipToLocation({ city: 'Wentzville' }, 'Masterack - Kansas City', PLANTS)).toBe('conflict');
    expect(compareShipToLocation({ city: 'Social Circle' }, 'Masterack - Wentzville', PLANTS)).toBe('conflict');
  });

  it('reads the plant out of a messy ship-to name with no city field', () => {
    // Real shape from an imported PO: the city lives only inside the name.
    expect(
      compareShipToLocation({ name: 'MFG Wentzville MO Install Wentzville' }, 'Masterack - Wentzville', PLANTS)
    ).toBe('match');
    expect(
      compareShipToLocation({ name: 'MFG Wentzville MO Install Wentzville' }, 'Masterack - Kansas City', PLANTS)
    ).toBe('conflict');
  });

  it('is case- and punctuation-insensitive', () => {
    expect(compareShipToLocation({ city: 'KANSAS CITY' }, 'masterack-kansas city', PLANTS)).toBe('match');
  });

  it("says unknown — not conflict — when the PO has no usable ship-to", () => {
    expect(compareShipToLocation(null, 'Masterack - Kansas City', PLANTS)).toBe('unknown');
    expect(compareShipToLocation({}, 'Masterack - Kansas City', PLANTS)).toBe('unknown');
    expect(compareShipToLocation({ city: 'Detroit' }, 'Masterack - Kansas City', PLANTS)).toBe('unknown');
  });

  it('says unknown for work locations that name no plant', () => {
    // "BMG Shop" and "National Fleet" have no city in work_locations, so they
    // are never evidence that a PO is the wrong one.
    expect(compareShipToLocation({ city: 'Wentzville' }, 'BMG Shop', PLANTS)).toBe('unknown');
    expect(compareShipToLocation({ city: 'Wentzville' }, 'National Fleet', PLANTS)).toBe('unknown');
    expect(compareShipToLocation({ city: 'Wentzville' }, null, PLANTS)).toBe('unknown');
  });

  it('ignores the street address, so a road named after another town cannot move the PO', () => {
    expect(
      compareShipToLocation({ city: 'Wentzville', name: 'Masterack' } as any, 'Masterack - Wentzville', PLANTS)
    ).toBe('match');
  });
});


describe('sameCity', () => {
  it('treats a bare city and a full work-location label as the same place', () => {
    expect(sameCity('Kansas City', 'Masterack - Kansas City')).toBe(true);
    expect(sameCity('Wentzville', 'Masterack - Wentzville')).toBe(true);
  });

  it('separates two different plants', () => {
    expect(sameCity('Wentzville', 'Masterack - Kansas City')).toBe(false);
  });

  it('says yes when either side is blank — it is a warning hint, not a gate', () => {
    expect(sameCity('', 'Masterack - Kansas City')).toBe(true);
    expect(sameCity('Wentzville', null)).toBe(true);
  });
});
