import { describe, it, expect } from 'vitest';
import {
  deliveryFromRow, deliveryLines, deliveryProblem, deliveryText, deliveryToRow,
  installLocationForDelivery, normalizeDelivery, sameDelivery, EMPTY_DELIVERY,
} from './delivery';

describe('delivery method', () => {
  it('requires a method only when asked to', () => {
    expect(deliveryProblem(EMPTY_DELIVERY, true)).toMatch(/Pick a delivery method/);
    expect(deliveryProblem(EMPTY_DELIVERY, false)).toBeNull();
  });

  it('names what each method is missing', () => {
    expect(deliveryProblem({ method: 'direct_ship' }, true)).toBe('Direct Ship needs a shipping speed and a ship-to address.');
    expect(deliveryProblem({ method: 'onsite_install', address: '1 Main St' }, true))
      .toBe("Onsite Installation needs the installation contact and the contact's phone.");
    expect(deliveryProblem({ method: 'customer_pickup', contactName: 'Dana', contactPhone: '314' }, true)).toBeNull();
    expect(deliveryProblem({ method: 'bmg_shop' }, true)).toBeNull();
  });

  it('clears fields the method does not use', () => {
    const n = normalizeDelivery({ method: 'customer_pickup', shipSpeed: 'ups_ground', address: 'x', installer: 'cni', contactName: ' Dana ' });
    expect(n).toMatchObject({ shipSpeed: null, address: null, installer: null, contactName: 'Dana' });
    // Old pickup "speed" isn't a UPS speed.
    expect(normalizeDelivery({ method: 'direct_ship', shipSpeed: 'customer_pickup' }).shipSpeed).toBeNull();
  });

  it('maps graphics jobs onto ship_speed / ship_to', () => {
    const row = deliveryToRow({ method: 'direct_ship', shipSpeed: 'ups_2nd_day_air', address: 'A\nB' }, 'graphics_jobs');
    expect(row).toMatchObject({ delivery_method: 'direct_ship', ship_speed: 'ups_2nd_day_air', ship_to: 'A\nB' });
    expect(deliveryFromRow(row, 'graphics_jobs')).toMatchObject({ method: 'direct_ship', shipSpeed: 'ups_2nd_day_air', address: 'A\nB' });
    // No method: an old job's speed and address are left alone.
    expect(deliveryToRow(EMPTY_DELIVERY, 'graphics_jobs')).not.toHaveProperty('ship_speed');
    expect(deliveryToRow({ method: 'bmg_shop' }, 'estimates')).toMatchObject({ delivery_method: 'bmg_shop', delivery_address: null });
  });

  it('compares after normalizing', () => {
    expect(sameDelivery({ method: 'bmg_shop', notes: ' ' }, { method: 'bmg_shop' })).toBe(true);
    expect(sameDelivery({ method: 'bmg_shop' }, null)).toBe(false);
  });

  it('implies an install location', () => {
    expect(installLocationForDelivery({ method: 'bmg_shop' })).toBe("O'Fallon Shop");
    expect(installLocationForDelivery({ method: 'onsite_install', installer: 'cni' })).toBe('CNI Installer');
    expect(installLocationForDelivery({ method: 'onsite_install' })).toBe('Customer Site');
    expect(installLocationForDelivery({ method: 'direct_ship' })).toBeUndefined();
  });

  it('writes print lines and a one-line text without the installer', () => {
    const d = { method: 'onsite_install' as const, address: 'Yard\n3500 Hampton Ave', contactName: 'Marcus', contactPhone: '555-0177', installer: 'cni' as const, notes: 'Gate 4471' };
    expect(deliveryLines(d).map(l => l.label)).toEqual(['Delivery', 'Install at', 'Contact', 'Installed by', 'Install notes']);
    expect(deliveryText(d)).toBe('Onsite Installation · Install at: Yard, 3500 Hampton Ave · Contact: Marcus · 555-0177 · Install notes: Gate 4471');
    expect(deliveryText(EMPTY_DELIVERY)).toBeNull();
  });
});
