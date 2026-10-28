import { describe, it, expect } from 'vitest';
import { estimateJobPo, estimateVehicleLine, joinBlocks, linkQuoteClientFiles, proofClientFileIds, wrapQuoteJobFields } from './graphics-links';

describe('estimateVehicleLine', () => {
  it('names year, model, unit and the full VIN', () => {
    expect(estimateVehicleLine({
      vehicle_year: 2025, vehicle_platforms: { label: 'Ford Transit 148' }, unit_number: '12', vin: '1FTBR3X8XRKA12345',
    })).toBe('2025 Ford Transit 148 · Unit 12 · VIN 1FTBR3X8XRKA12345');
  });
  it('adds the stock number after the unit', () => {
    expect(estimateVehicleLine({ vehicle_year: 2025, vehicle_other: 'Transit', unit_number: '12', stock_number: 'F24-0912' }))
      .toBe('2025 Transit · Unit 12 · Stock F24-0912');
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

describe('client files from a worksheet\'s proof pages', () => {
  const A = '0b5c3a2e-1f4d-4c8e-9a7b-2d6e8f1a3c5b';
  const B = '7e1d2c3b-4a5f-4e6d-8c7b-9a0f1e2d3c4b';

  it('collects each page\'s client file once and ignores pages without one', () => {
    expect(proofClientFileIds([
      { path: 'a', client_file_id: A }, { path: 'b', client_file_id: A }, { path: 'c' }, { path: 'd', client_file_id: B }, { client_file_id: 'junk' },
    ])).toEqual([A, B]);
    expect(proofClientFileIds(null)).toEqual([]);
    expect(proofClientFileIds('x')).toEqual([]);
  });

  const fakeSupabase = (photoProofs: any, upsertError: any = null) => {
    const upserts: any[] = [];
    const client: any = {
      from: (table: string) => {
        if (table === 'wrap_quotes') {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { photo_proofs: photoProofs } }) }) }) };
        }
        return { upsert: async (rows: any, opts: any) => { upserts.push({ table, rows, opts }); return { error: upsertError }; } };
      },
    };
    return { client, upserts };
  };

  it('links the worksheet\'s client files onto the job without duplicating', async () => {
    const { client, upserts } = fakeSupabase([{ path: 'a', client_file_id: A }]);
    expect(await linkQuoteClientFiles(client, 'job-1', 'wq-1', 'user-1')).toBe(1);
    expect(upserts).toEqual([{
      table: 'graphics_job_client_files',
      rows: [{ job_id: 'job-1', client_file_id: A, added_by: 'user-1' }],
      opts: { onConflict: 'job_id,client_file_id', ignoreDuplicates: true },
    }]);
  });

  it('does nothing with no worksheet or no client files, and never throws', async () => {
    const empty = fakeSupabase([{ path: 'a' }]);
    expect(await linkQuoteClientFiles(empty.client, 'job-1', null)).toBe(0);
    expect(await linkQuoteClientFiles(empty.client, 'job-1', 'wq-1')).toBe(0);
    expect(empty.upserts).toEqual([]);
    const failing = fakeSupabase([{ path: 'a', client_file_id: A }], { message: 'boom' });
    expect(await linkQuoteClientFiles(failing.client, 'job-1', 'wq-1')).toBe(0);
  });
});
