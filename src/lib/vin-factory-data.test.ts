import { describe, it, expect } from 'vitest';
import {
  bedFromText, bedFromWheelbase, roofFromText, roofFromHeight, parseCarsxeSpecs, mergeFactory,
} from './vin-factory-data';
import type { VinDetails } from './vin-decoder';

describe('bedFromText', () => {
  it('reads the common box spellings', () => {
    expect(bedFromText("SuperCrew 4WD 5.5' Box")).toBe(5.5);
    expect(bedFromText('Crew Cab 6.5 ft. Bed')).toBe(6.5);
    expect(bedFromText(`Crew Cab 5'7" Box`)).toBeCloseTo(5 + 7 / 12);
    expect(bedFromText('Regular Cab 8 ft box')).toBe(8);
    expect(bedFromText('Crew 78.9" Box')).toBeCloseTo(6.575);
    expect(bedFromText('XLT 4WD')).toBeNull();
  });
});

describe('bedFromWheelbase', () => {
  it('pins F-150 and Ram 1500 boxes from cab + wheelbase', () => {
    expect(bedFromWheelbase('FORD F-150', 'Crew/ Super Crew/ Crew Max', 145.4)).toBe(5.5);
    expect(bedFromWheelbase('FORD F-150', 'SuperCrew', 157)).toBe(6.5);
    expect(bedFromWheelbase('RAM 1500', 'Crew Cab', 144.6)).toBeCloseTo(5 + 7 / 12);
  });
  it('stays out of HD trucks and unknown wheelbases', () => {
    expect(bedFromWheelbase('FORD F-250', 'Crew', 160)).toBeNull();
    expect(bedFromWheelbase('RAM 2500', 'Crew', 149.5)).toBeNull();
    expect(bedFromWheelbase('FORD F-150', 'Crew', 150)).toBeNull();
    expect(bedFromWheelbase('FORD F-150', 'Crew', NaN)).toBeNull();
  });
});

describe('roof', () => {
  it('reads roof names from the style', () => {
    expect(roofFromText('T-250 148" Med Rf 9070 GVWR')).toBe('Medium');
    expect(roofFromText('2500 High Roof 159" WB')).toBe('High');
    expect(roofFromText('3500 Super High Roof 159"')).toBe('Super high');
    expect(roofFromText('XLT')).toBeNull();
  });
  it('works the roof out from overall height on full-size vans', () => {
    expect(roofFromHeight('Transit', 83.6)).toBe('Low');
    expect(roofFromHeight('Transit', 100.8)).toBe('Medium');
    expect(roofFromHeight('Transit', 109.4)).toBe('High');
    expect(roofFromHeight('ProMaster', 101)).toBe('High');
    expect(roofFromHeight('Transit Connect', 72)).toBeNull();
    expect(roofFromHeight('F-150', 77)).toBeNull();
  });
});

describe('parseCarsxeSpecs + mergeFactory', () => {
  const f150 = {
    success: true,
    attributes: {
      year: '2023', make: 'Ford', model: 'F-150', trim: 'XLT', style: 'SuperCrew 4WD',
      type: 'Truck', category: 'Crew Cab Pickup', wheelbase_length: '145.40 in.',
      overall_height: '77.20 in.', gross_vehicle_weight_rating: '7,050 lbs', curb_weight: '4,947 lbs',
      colors: [{ name: 'Oxford White' }],
    },
  };

  it('returns null when CarsXE found nothing', () => {
    expect(parseCarsxeSpecs({ success: false, message: 'Invalid VIN' })).toBeNull();
    expect(parseCarsxeSpecs(null)).toBeNull();
  });

  it('works out the F-150 bed from the wheelbase and fills NHTSA blanks', () => {
    const f = parseCarsxeSpecs(f150, 'Crew/ Super Crew/ Crew Max')!;
    expect(f.bed).toEqual({ value: '5.5 ft', source: 'from 145.4" wheelbase' });
    expect(f.roof).toBeNull();
    expect(f.raw.some(r => r.label === 'Colors')).toBe(false);

    const nhtsa: VinDetails = {
      title: '2023 FORD F-150 XLT', make: 'FORD', warning: '',
      groups: [
        { heading: 'Vehicle', rows: [{ label: 'Series', value: 'F-150' }] },
        { heading: 'Body', rows: [{ label: 'Body', value: 'Pickup' }, { label: 'Cab', value: 'Crew' }, { label: 'Bed length', value: '' }, { label: 'Wheelbase', value: '' }] },
        { heading: 'Weight', rows: [{ label: 'GVWR', value: 'Class 2E: 6,001 - 7,000 lb' }] },
      ],
    };
    const m = mergeFactory(nhtsa, f)!;
    const body = m.groups[1].rows;
    expect(body.find(r => r.label === 'Bed length')).toMatchObject({ value: '5.5 ft', note: 'CarsXE · from 145.4" wheelbase' });
    expect(body.find(r => r.label === 'Wheelbase')?.value).toBe('145.4"');
    expect(m.groups[0].rows.map(r => r.label)).toEqual(['Series', 'Style', 'Trim']);
    // NHTSA's own value wins.
    expect(m.groups[2].rows[0].value).toBe('Class 2E: 6,001 - 7,000 lb');
    // The NHTSA object isn't mutated.
    expect(nhtsa.groups[1].rows[2].value).toBe('');
  });

  it('shows CarsXE alone when NHTSA knew nothing', () => {
    const m = mergeFactory(null, parseCarsxeSpecs(f150))!;
    expect(m.title).toBe('2023 Ford F-150 XLT');
    expect(m.make).toBe('Ford');
  });
});

describe('CarsXE "No Data" fields (new model years)', () => {
  const tacoma = {
    success: true,
    attributes: {
      year: '2026', make: 'Toyota', model: 'Tacoma', trim: 'SR5 Xtracab 2WD', style: 'EXTENDED CAB PICKUP 2-DR',
      engine: '2.4L L4 DOHC 16V', curb_weight: 'No Data lbs', gross_vehicle_weight_rating: 'No Data lbs',
      overall_height: 'No Data in.', wheelbase_length: 'No Data in.', production_seq_number: '058197',
    },
  };

  it('treats "No Data" as blank and hides it from the field list', () => {
    const f = parseCarsxeSpecs(tacoma)!;
    expect(f.gvwr).toBe('');
    expect(f.curbWeight).toBe('');
    expect(f.wheelbase).toBe('');
    expect(f.raw.map(r => r.label)).not.toContain('Curb weight');
    expect(f.raw.map(r => r.label)).toContain('Engine');
  });

  it('gives the 2024+ Tacoma XtraCab its only bed, and fills trim', () => {
    const f = parseCarsxeSpecs(tacoma)!;
    expect(f.bed).toEqual({ value: '6 ft', source: 'only bed on a 2024+ Tacoma XtraCab' });
    const m = mergeFactory({
      title: '2026 TOYOTA Tacoma', make: 'TOYOTA', warning: '',
      groups: [{ heading: 'Vehicle', rows: [{ label: 'Model', value: 'Tacoma' }, { label: 'Trim', value: '' }] }],
    }, f)!;
    expect(m.groups[0].rows.find(r => r.label === 'Trim')?.value).toBe('SR5 Xtracab 2WD');
  });

  it('leaves an older Tacoma Access Cab alone', () => {
    const f = parseCarsxeSpecs({ ...tacoma, attributes: { ...tacoma.attributes, year: '2022' } })!;
    expect(f.bed).toBeNull();
  });
});

describe('Transit with the wheelbase only in its trim', () => {
  const transit = {
    success: true,
    attributes: {
      year: '2027', make: 'Ford', model: 'Transit', trim: '150 Van Low Roof w/Sliding Pass. 130-in. WB',
      style: 'CARGO VAN', wheelbase_length: 'No Data in.', overall_height: 'No Data in.',
    },
  };

  it('reads the wheelbase and roof from the trim and narrows NHTSA\'s range', () => {
    const f = parseCarsxeSpecs(transit)!;
    expect(f.wheelbase).toBe('130"');
    expect(f.roof).toEqual({ value: 'Low', source: 'factory style' });
    const m = mergeFactory({
      title: '2027 FORD Transit Low Roof', make: 'FORD', warning: '',
      groups: [
        { heading: 'Vehicle', rows: [{ label: 'Trim', value: 'Low Roof' }] },
        { heading: 'Body', rows: [{ label: 'Wheelbase', value: '130" – 148"' }, { label: 'Roof', value: 'Low' }] },
      ],
    }, f)!;
    expect(m.groups[0].rows.find(r => r.label === 'Factory trim')?.value).toBe('150 Van Low Roof w/Sliding Pass. 130-in. WB');
    expect(m.groups[1].rows.find(r => r.label === 'Wheelbase')).toMatchObject({ value: '130"', note: 'CarsXE · from trim' });
  });

  it('reads 148" WB spellings too', () => {
    const f = parseCarsxeSpecs({ ...transit, attributes: { ...transit.attributes, trim: 'T-250 148" WB Med Rf' } })!;
    expect(f.wheelbase).toBe('148"');
    expect(f.roof?.value).toBe('Medium');
  });
});
