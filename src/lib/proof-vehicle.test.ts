import { describe, it, expect } from 'vitest';
import {
  narrowProofVehicleMatches,
  proofVehicleDisagrees,
  proofVehicleLabel,
  proofVehicleQueries,
  sanitizeProofVehicle,
  templateWheelbase,
  type ProofVehicle,
} from './proof-vehicle';

const tpl = (over: Record<string, any>) => ({
  id: over.id || 'x', name: '', make: 'Ford', model: 'Transit', year: '2024', variant: null,
  wheelbase_in: null, ...over,
});

const transit148: ProofVehicle = { year: '2024', make: 'Ford', model: 'Transit', body: 'Cargo Van', wheelbase_in: 148, roof: 'High' };

describe('sanitizeProofVehicle', () => {
  it('keeps what was printed and normalises it', () => {
    expect(sanitizeProofVehicle({ year: 2024, make: ' Ford ', model: 'Transit', body: 'Cargo Van', wheelbase_in: '148', roof: 'High Roof' }))
      .toEqual(transit148);
  });
  it('drops misreads and says nothing when nothing names a vehicle', () => {
    expect(sanitizeProofVehicle({ year: 1492, make: 'Ram', wheelbase_in: 9999, roof: 'tall' }))
      .toEqual({ year: null, make: 'Ram', model: null, body: null, wheelbase_in: null, roof: null });
    expect(sanitizeProofVehicle({ year: 2024, roof: 'High' })).toBeNull();
    expect(sanitizeProofVehicle(null)).toBeNull();
    expect(sanitizeProofVehicle('Ford')).toBeNull();
  });
});

describe('templateWheelbase', () => {
  it('uses the column, else the inches in the name', () => {
    expect(templateWheelbase(tpl({ wheelbase_in: 130 }))).toBe(130);
    expect(templateWheelbase(tpl({ variant: 'Cargo Van, 148in, High Roof' }))).toBe(148);
    expect(templateWheelbase(tpl({ facet_wheelbase: '159 Extended' }))).toBe(159);
    expect(templateWheelbase(tpl({ variant: 'Cargo Van' }))).toBeNull();
    expect(templateWheelbase(null)).toBeNull();
  });
});

describe('proofVehicleQueries / label', () => {
  it('tries year make model, then make model', () => {
    expect(proofVehicleQueries(transit148)).toEqual(['2024 Ford Transit', 'Ford Transit']);
    expect(proofVehicleQueries({ ...transit148, year: null })).toEqual(['Ford Transit']);
    expect(proofVehicleQueries({ ...transit148, make: null, model: null })).toEqual([]);
  });
  it('reads like the proof', () => {
    expect(proofVehicleLabel(transit148)).toBe('2024 Ford Transit Cargo Van 148" WB High Roof');
  });
});

describe('narrowProofVehicleMatches', () => {
  const rows = [
    tpl({ id: '130-low', variant: 'Cargo Van, 130in, Low Roof' }),
    tpl({ id: '148-med', variant: 'Cargo Van, 148in, Med Roof' }),
    tpl({ id: '148-high', variant: 'Cargo Van, 148in, High Roof' }),
    tpl({ id: '148-high-ext', variant: 'Cargo Van, 148in, High Roof, Extended' }),
    tpl({ id: '148-high-pass', variant: 'Passenger Van, 148in, High Roof' }),
    tpl({ id: '148-high-2019', year: '2019', variant: 'Cargo Van, 148in, High Roof' }),
  ];
  it('narrows to the one template the proof describes', () => {
    expect(narrowProofVehicleMatches(rows, transit148).map(t => t.id)).toEqual(['148-high']);
  });
  it('leaves several when the proof says less', () => {
    const ids = narrowProofVehicleMatches(rows, { ...transit148, roof: null, body: null }).map(t => t.id);
    expect(ids).toEqual(['148-med', '148-high', '148-high-pass']);
  });
  it('finds nothing for a wheelbase the library lacks', () => {
    expect(narrowProofVehicleMatches(rows, { ...transit148, wheelbase_in: 176 })).toEqual([]);
  });
  it('picks Extended only when the proof says Extended', () => {
    expect(narrowProofVehicleMatches(rows, { ...transit148, body: 'Cargo Van Extended' }).map(t => t.id)).toEqual(['148-high-ext']);
  });
  it('treats year as a preference, matching year ranges', () => {
    const ranged = [tpl({ id: 'r', year: '2015-2023', variant: 'Cargo Van, 148in, High Roof' })];
    expect(narrowProofVehicleMatches(ranged, { ...transit148, year: '2020' }).map(t => t.id)).toEqual(['r']);
    expect(narrowProofVehicleMatches(ranged, { ...transit148, year: '2025' }).map(t => t.id)).toEqual(['r']);
  });
});

describe('proofVehicleDisagrees', () => {
  const picked = tpl({ variant: 'Cargo Van, 148in, High Roof' });
  it('flags a different wheelbase, make or model', () => {
    expect(proofVehicleDisagrees(picked, { ...transit148, wheelbase_in: 130 })).toBe(true);
    expect(proofVehicleDisagrees(picked, { ...transit148, make: 'Ram', model: 'ProMaster', wheelbase_in: 159 })).toBe(true);
    expect(proofVehicleDisagrees(picked, { ...transit148, model: 'E-Series' })).toBe(true);
  });
  it('lets the same vehicle through, however it is written', () => {
    expect(proofVehicleDisagrees(picked, transit148)).toBe(false);
    expect(proofVehicleDisagrees(tpl({ make: 'FORD', model: 'TRANSIT 250' }), transit148)).toBe(false);
    expect(proofVehicleDisagrees(tpl({ make: 'Chevrolet', model: 'Express' }), { ...transit148, make: 'Chevy', model: 'Express', wheelbase_in: null })).toBe(false);
    expect(proofVehicleDisagrees(tpl({ make: 'Ram', model: 'ProMaster' }), { ...transit148, make: 'Dodge', model: 'ProMaster', wheelbase_in: null })).toBe(false);
    expect(proofVehicleDisagrees(null, transit148)).toBe(false);
  });
});
