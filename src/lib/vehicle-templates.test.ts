import { describe, expect, it } from 'vitest';
import { estimateVehicleFields, platformFromVehicle, tidyVehicleText, type PlatformLite, type VehicleTemplate } from './vehicle-templates';

const PLATFORMS: PlatformLite[] = [
  { id: 'p-transit', key: 'transit', config: { wheelbases: ['130', '148', '148 EL'], roofs: ['low', 'medium', 'high'] } },
  { id: 'p-promaster', key: 'promaster', config: { wheelbases: ['118', '136', '159', '159 EXT'], roofs: ['low', 'high', 'super high'] } },
  { id: 'p-f150', key: 'f-150', config: { cabs: ['Regular', 'SuperCab', 'SuperCrew'], beds: ['5.5', '6.5', '8'] } },
  { id: 'p-ram1500', key: 'ram-1500', config: { cabs: ['Regular', 'Quad', 'Crew'], beds: ['5.6', '6.4', '8'] } },
];

const tpl = (over: Partial<VehicleTemplate>): VehicleTemplate => ({
  id: 't1', name: 'x', make: 'FORD', model: 'Transit', year: '2023', variant: null, scale: '1:20',
  template_code: null, template_image_path: 'a.png', px_per_in: null, overall_length_in: null,
  overall_height_in: null, wheelbase_in: null, panel_data: null, is_active: true, ...over,
});

describe('platformFromVehicle', () => {
  it('maps a Transit template to the platform and its own labels', () => {
    expect(platformFromVehicle({ make: 'FORD', model: 'Transit', wheelbase: '148 Extended', roof: 'High' }, PLATFORMS))
      .toEqual({ platformId: 'p-transit', wheelbase: '148 EL', roof: 'high', cab: '', bed: '' });
    expect(platformFromVehicle({ make: 'Ford', model: 'Transit', wheelbase: '148', roof: 'Medium' }, PLATFORMS))
      .toMatchObject({ wheelbase: '148', roof: 'medium' });
  });
  it('maps ProMaster super high roof and EXT wheelbase', () => {
    expect(platformFromVehicle({ make: 'RAM', model: 'ProMaster 2500', wheelbase: '159 Extended', roof: 'Super High' }, PLATFORMS))
      .toMatchObject({ platformId: 'p-promaster', wheelbase: '159 EXT', roof: 'super high' });
  });
  it('maps truck cabs and beds', () => {
    expect(platformFromVehicle({ make: 'Ford', model: 'F-150', cab: 'SuperCrew', bed: "5.5'" }, PLATFORMS))
      .toMatchObject({ platformId: 'p-f150', cab: 'SuperCrew', bed: '5.5' });
    expect(platformFromVehicle({ make: 'RAM', model: '1500', cab: 'Crew Cab', bed: "6'4\"" }, PLATFORMS))
      .toMatchObject({ platformId: 'p-ram1500', cab: 'Crew', bed: '6.4' });
  });
  it('leaves off-list vehicles without a platform', () => {
    expect(platformFromVehicle({ make: 'Isuzu', model: 'NPR' }, PLATFORMS).platformId).toBeNull();
    expect(platformFromVehicle({}, PLATFORMS).platformId).toBeNull();
  });
});

describe('estimateVehicleFields', () => {
  it('writes the template, make, model, year and platform', () => {
    const f = estimateVehicleFields(tpl({ variant: '148in High Roof', facet_wheelbase: '148', facet_roof: 'High' }), {}, PLATFORMS);
    expect(f).toMatchObject({
      vehicle_template_id: 't1', vehicle_make: 'FORD', vehicle_model: 'Transit', vehicle_year: '2023',
      vehicle_platform_id: 'p-transit', vehicle_other: null, vehicle_wheelbase: '148', vehicle_roof: 'high',
    });
  });
  it('prints an off-platform vehicle through vehicle_other, tidied', () => {
    const f = estimateVehicleFields(tpl({ make: 'ISUZU', model: 'NPR HD', variant: '16ft Box' }), {}, PLATFORMS);
    expect(f.vehicle_platform_id).toBeNull();
    expect(f.vehicle_other).toBe('Isuzu NPR HD 16ft Box');
  });
  it('works from make / model filters with no template', () => {
    const f = estimateVehicleFields(null, { make: 'Ford', model: 'Transit', roof: 'Low' }, PLATFORMS);
    expect(f).toMatchObject({ vehicle_template_id: null, vehicle_platform_id: 'p-transit', vehicle_roof: 'low' });
  });
});

describe('tidyVehicleText', () => {
  it('title-cases shouty words only', () => {
    expect(tidyVehicleText('FORD TRANSIT 148 High Roof')).toBe('Ford Transit 148 High Roof');
    expect(tidyVehicleText('GMC Savana F-150 RAM')).toBe('GMC Savana F-150 RAM');
  });
});
