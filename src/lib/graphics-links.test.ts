import { describe, it, expect } from 'vitest';
import { estimateJobPo, estimateVehicleLine, joinBlocks, wrapQuoteJobFields } from './graphics-links';

describe('estimateVehicleLine', () => {
  it('names year, model, unit and the full VIN', () => {
    expect(estimateVehicleLine({
      vehicle_year: 2025, vehicle_platforms: { label: 'Ford Transit 148' }, unit_number: '12', vin: '1FTBR3X8XRKA12345',
    })).toBe('2025 Ford Transit 148 · Unit 12 · VIN 1FTBR3X8XRKA12345');
  });
  it('falls back to the typed vehicle and drops what is missing', () => {
    expect(estimateVehicleLine({ vehicle_other: 'Box truck', vin: null })).toBe('Box truck');
    expect(estimateVehicleLine({})).toBeNull();
    expect(estimateVehicleLine(null)).toBeNull();
  });
});

describe('estimateJobPo', () => {
  it("puts the customer's PO in the PO field and names the SO", () => {
    expect(estimateJobPo({ po_number: ' 4500123 ', netsuite_so_number: '1060' }))
      .toEqual({ poNumber: '4500123', soNote: 'SO #1060' });
  });
  it('falls back to the SO # when the customer gave no PO', () => {
    expect(estimateJobPo({ po_number: '', netsuite_so_number: '1060' })).toEqual({ poNumber: '1060', soNote: null });
    expect(estimateJobPo(null)).toEqual({ poNumber: null, soNote: null });
  });
});

describe('wrapQuoteJobFields', () => {
  it('turns the measurement snapshot into films and coverage lines', () => {
    const f = wrapQuoteJobFields({
      measurements: [
        { name: 'Driver side', qty: 1, dim1_in: 120, dim2_in: 40, substrate: { name: 'IJ180 + 8518', film_name: 'IJ180', laminate_name: '8518' } },
        { name: 'Door', qty: 2, dim1_in: 20, dim2_in: 10, substrate: { name: 'IJ180 + 8518', film_name: 'IJ180', laminate_name: '8518' } },
      ],
      total_area_sqft: 36.1,
      project_type: 'Partial wrap',
      project_notes: 'Match fleet blue',
    });
    expect(f.vinylType).toBe('IJ180');
    expect(f.laminate).toBe('8518');
    expect(f.content).toContain('Door: 2× ');
    expect(f.content).toContain('Total coverage: 36.1 ft²');
    expect(f.notes).toBe('Partial wrap — Match fleet blue');
  });
  it('is empty for a quote with nothing drawn', () => {
    expect(wrapQuoteJobFields({})).toEqual({ content: null, vinylType: null, laminate: null, notes: null });
  });
});

describe('joinBlocks', () => {
  it('skips empty blocks and separates the rest with a blank line', () => {
    expect(joinBlocks('a', null, '  ', 'b')).toBe('a\n\nb');
    expect(joinBlocks(null, '')).toBeNull();
  });
});
