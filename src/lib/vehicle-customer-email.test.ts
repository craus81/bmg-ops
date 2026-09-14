import { describe, it, expect } from 'vitest';
import {
  VEHICLE_EMAIL_KINDS, buildVehicleCustomerEmail, vehicleEmailLabel,
} from './vehicle-customer-email';

const APP = 'https://ops.example.com';
const van = {
  id: 'v1',
  vin: '1FTBW3XM8PKA12345',
  vehicle_year: 2024,
  vehicle_make: 'Ford',
  vehicle_model: 'Transit',
  customer_portal_token: 'tok123',
};

describe('vehicleEmailLabel', () => {
  it('prefers the year/make/model description', () => {
    expect(vehicleEmailLabel(van)).toBe('2024 Ford Transit');
  });

  it('falls back to the VIN tail when there is no description', () => {
    expect(vehicleEmailLabel({ id: 'v1', vin: '1FTBW3XM8PKA12345' })).toBe('VIN PKA12345');
  });
});

describe('buildVehicleCustomerEmail', () => {
  it('points the two pickup emails at the vehicle booking page', () => {
    for (const kind of ['ready', 'pickup_reminder'] as const) {
      const c = buildVehicleCustomerEmail(van, kind, APP);
      expect(c.ctaUrl).toBe(`${APP}/book/tok123`);
      expect(c.ctaLabel).toBe('Book your pickup time');
    }
  });

  it('never offers a booking link on a shipped vehicle — there is nothing left to book', () => {
    const c = buildVehicleCustomerEmail(van, 'shipped', APP);
    expect(c.ctaUrl).toBe(`${APP}/customer/dashboard`);
    expect(c.smsBody).toBeNull();
  });

  it('falls back to the portal dashboard when the vehicle has no booking token', () => {
    const c = buildVehicleCustomerEmail({ ...van, customer_portal_token: null }, 'ready', APP);
    // Never a dead link, and never a button that promises booking it can't do.
    expect(c.ctaUrl).toBe(`${APP}/customer/dashboard`);
    expect(c.ctaLabel).toBe('View order status');
    expect(c.body).toContain('contact us to arrange pickup');
    expect(c.smsBody).toBeNull();
  });

  it('counts the wait in the reminder, and reads correctly at one day', () => {
    expect(buildVehicleCustomerEmail({ ...van, daysReady: 5 }, 'pickup_reminder', APP).body)
      .toContain('ready for pickup for 5 days');
    expect(buildVehicleCustomerEmail({ ...van, daysReady: 1 }, 'pickup_reminder', APP).body)
      .toContain('ready for pickup for 1 day.');
  });

  it('drops the day count rather than saying "0 days" when we do not know the wait', () => {
    const c = buildVehicleCustomerEmail({ ...van, daysReady: 0 }, 'pickup_reminder', APP);
    expect(c.body).toContain('is ready for pickup');
    expect(c.body).not.toContain('0 day');
  });

  it('gives every kind a subject, a body and a live CTA', () => {
    for (const kind of VEHICLE_EMAIL_KINDS) {
      const c = buildVehicleCustomerEmail(van, kind, APP);
      expect(c.subject).toContain('2024 Ford Transit');
      expect(c.body.length).toBeGreaterThan(20);
      expect(c.ctaUrl.startsWith(APP)).toBe(true);
      expect(c.ctaLabel).toBeTruthy();
      expect(c.threadSubject).toBeTruthy();
    }
  });
});
