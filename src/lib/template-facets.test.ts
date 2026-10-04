import { describe, it, expect } from 'vitest';
import { templateFacets } from './template-facets';

const f = (variant: string | null, wheelbase_in: number | null = null) => templateFacets({ variant, wheelbase_in });

describe('templateFacets', () => {
  it('reads roof and wheelbase off a van description', () => {
    expect(f('Passenger Van, 148in, Med Roof, Sliding Door', 148)).toEqual({ wheelbase: '148', body: 'Passenger', roof: 'Medium', bed: '', cab: '' });
    expect(f('Cargo Van, 130in, Low Roof, Swing Doors')).toMatchObject({ wheelbase: '130', roof: 'Low' });
    expect(f('Standard Roof; Cargo; 170in')).toMatchObject({ wheelbase: '170', roof: 'Standard' });
    expect(f('1500 Cargo, Low Roof, 136in')).toMatchObject({ wheelbase: '136', roof: 'Low' });
  });

  it('gives extended-body vans their own wheelbase choice', () => {
    expect(f('Cargo Van, 148in, Extended, High Roof', 147.6)).toMatchObject({ wheelbase: '148 Extended', body: 'Cargo' });
    expect(f('3500, Cargo, High Roof, Extended Body', 159)).toMatchObject({ wheelbase: '159 Extended', roof: 'High' });
    expect(f('2500-3500 Cargo, High Roof', 159).wheelbase).toBe('159');
    expect(f('Extended Cab Long Box', 143.5)).toMatchObject({ wheelbase: '144', cab: 'Extended Cab' });
  });

  it('reads the body style', () => {
    expect(f('Sedan').body).toBe('Sedan');
    expect(f('5 Door Hatchback').body).toBe('Hatchback');
    expect(f('Wagon SLT').body).toBe('Wagon');
    expect(f('Crew Cab Short Bed').body).toBe('');
  });

  it('prefers the wheelbase column over the text', () => {
    expect(f('155in', 155.4).wheelbase).toBe('155');
    expect(f('Sedan').wheelbase).toBe('');
  });

  it('tells the cab sizes apart, longest name first', () => {
    expect(f("Supercrew 5.5' Box")).toMatchObject({ cab: 'SuperCrew', bed: "5.5'" });
    expect(f('Super Duty Crew Cab Dually 172in')).toMatchObject({ cab: 'Crew Cab', wheelbase: '172' });
    expect(f('Super Duty Super Cab; Short Bed')).toMatchObject({ cab: 'Super Cab', bed: 'Short' });
    expect(f("CrewMax 5.5' Standard Bed")).toMatchObject({ cab: 'CrewMax', bed: "5.5'" });
    expect(f('Single Cab').cab).toBe('Regular Cab');
    expect(f('Crewcab').cab).toBe('Crew Cab');
  });

  it('reads bed length words and chassis cabs', () => {
    expect(f('Crew Cab Standard Bed').bed).toBe('Standard');
    expect(f('HD Double Cab Long Box').bed).toBe('Long');
    expect(f('Super Duty Crew Cab; Flat Bed').bed).toBe('Flat Bed');
    expect(f('HD Crew Cab Chassis').bed).toBe('Chassis');
    expect(f('Extended Cab; Flareside').bed).toBe('Flareside');
    expect(f('Heavy Duty Crew Cab Reg Bed').bed).toBe('Standard');
    expect(f("Crew Cab; 6'4in Box").bed).toBe(`6'4"`);
    expect(f('Supercab 8 Box').bed).toBe("8'");
  });

  it('does not treat a Transit "Chassis Cab" as a pickup', () => {
    expect(f('Chassis Cab, 138in, Low Roof')).toEqual({ wheelbase: '138', body: 'Chassis Cab', roof: 'Low', bed: '', cab: '' });
  });

  it('falls back to the name when there is no variant', () => {
    expect(templateFacets({ variant: null, name: 'Ford Transit 148 High Roof' }).roof).toBe('High');
  });
});
