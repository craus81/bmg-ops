import { describe, it, expect } from 'vitest';
import {
  summarizeCondition, conditionNote, conditionContentHash, canSendForAcknowledgment,
  fuelLabel, severityLabel, severityTone, formatOdometer,
  CONDITION_AGREEMENT_TEXT, type DamageRecord,
} from './vehicle-condition';

const dmg = (over: Partial<DamageRecord> = {}): DamageRecord => ({
  location: 'Left front door', severity: 'minor', description: 'Scuff', photo_paths: ['a.jpg'],
  ...over,
});

describe('summarizeCondition', () => {
  it('counts by severity and names the worst', () => {
    const s = summarizeCondition([dmg(), dmg({ severity: 'severe' }), dmg({ severity: 'moderate' })]);
    expect(s.total).toBe(3);
    expect(s.bySeverity).toEqual({ minor: 1, moderate: 1, severe: 1 });
    expect(s.worst).toBe('severe');
  });

  it('counts findings with no photo — the ones that get argued about', () => {
    const s = summarizeCondition([dmg(), dmg({ photo_paths: [] }), dmg({ photo_paths: null })]);
    expect(s.unphotographed).toBe(2);
    expect(s.photos).toBe(1);
  });

  it('has no worst severity when there is no damage', () => {
    expect(summarizeCondition([]).worst).toBeNull();
    expect(conditionNote(summarizeCondition([]))).toBe('No pre-existing damage recorded.');
  });

  it('says how many findings lack a photo in the one-liner', () => {
    const note = conditionNote(summarizeCondition([dmg(), dmg({ photo_paths: [] })]));
    expect(note).toBe('2 findings (2 minor) · 1 with no photo');
  });
});

describe('conditionContentHash', () => {
  const checkin = { odometer_miles: 41200, fuel_level: 'half' };

  it('is stable across a reordered read', () => {
    const a = conditionContentHash(checkin, [dmg({ description: 'Scuff' }), dmg({ description: 'Dent' })]);
    const b = conditionContentHash(checkin, [dmg({ description: 'Dent' }), dmg({ description: 'Scuff' })]);
    expect(a).toBe(b);
  });

  it('changes when the odometer changes', () => {
    const a = conditionContentHash(checkin, [dmg()]);
    const b = conditionContentHash({ ...checkin, odometer_miles: 41201 }, [dmg()]);
    expect(a).not.toBe(b);
  });

  it('changes when a severity is edited after send', () => {
    const a = conditionContentHash(checkin, [dmg({ severity: 'minor' })]);
    const b = conditionContentHash(checkin, [dmg({ severity: 'severe' })]);
    expect(a).not.toBe(b);
  });

  it('changes when a photo is ADDED after send', () => {
    // Deliberate: the customer agreed to a specific set of pictures, and
    // silently enlarging it is the substitution this guards against.
    const a = conditionContentHash(checkin, [dmg({ photo_paths: ['a.jpg'] })]);
    const b = conditionContentHash(checkin, [dmg({ photo_paths: ['a.jpg', 'b.jpg'] })]);
    expect(a).not.toBe(b);
  });

  it('ignores whitespace-only edits to a description', () => {
    const a = conditionContentHash(checkin, [dmg({ description: 'Scuff' })]);
    const b = conditionContentHash(checkin, [dmg({ description: '  Scuff  ' })]);
    expect(a).toBe(b);
  });
});

describe('canSendForAcknowledgment', () => {
  it('refuses a report with nothing on it', () => {
    const v = canSendForAcknowledgment({ odometer_miles: null, fuel_level: null }, []);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('before sending');
  });

  it('allows a clean vehicle when a reading was taken', () => {
    // "No damage, 41,200 miles, half a tank" is a real and useful record.
    expect(canSendForAcknowledgment({ odometer_miles: 41200, fuel_level: 'half' }, []).ok).toBe(true);
  });

  it('allows damage with no odometer reading', () => {
    expect(canSendForAcknowledgment({ odometer_miles: null, fuel_level: null }, [dmg()]).ok).toBe(true);
  });

  it('treats a zero odometer as a real reading, not a missing one', () => {
    expect(canSendForAcknowledgment({ odometer_miles: 0, fuel_level: null }, []).ok).toBe(true);
  });
});

describe('labels', () => {
  it('renders fuel and severity, and rejects junk', () => {
    expect(fuelLabel('three_quarter')).toBe('¾');
    expect(fuelLabel('sloshing')).toBeNull();
    expect(fuelLabel(null)).toBeNull();
    expect(severityLabel('severe')).toBe('Severe');
    expect(severityLabel('catastrophic')).toBe('Minor');   // unknown falls back
    expect(severityTone('severe')).toBe('bad');
  });

  it('formats an odometer and refuses a nonsense one', () => {
    expect(formatOdometer(41200)).toBe('41,200 mi');
    expect(formatOdometer(0)).toBe('0 mi');
    expect(formatOdometer(-5)).toBeNull();
    expect(formatOdometer(null)).toBeNull();
  });
});

describe('CONDITION_AGREEMENT_TEXT', () => {
  it('confirms accuracy without claiming to waive anything', () => {
    // Widening this into a liability waiver is a business decision, not
    // something the app asserts on the owner's behalf.
    expect(CONDITION_AGREEMENT_TEXT).toContain('accurately reflects the condition');
    expect(CONDITION_AGREEMENT_TEXT).toContain('E-SIGN Act');
    expect(CONDITION_AGREEMENT_TEXT.toLowerCase()).not.toContain('waive');
    expect(CONDITION_AGREEMENT_TEXT.toLowerCase()).not.toContain('release');
    expect(CONDITION_AGREEMENT_TEXT.toLowerCase()).not.toContain('not liable');
  });
});
