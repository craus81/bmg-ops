import { describe, expect, it } from 'vitest';
import { normalizeLast6, pickVinMatch, statusAfterFixBy, vehicleLabel } from './qc-fixes';
import { buildQcFixedEmail, buildQcReportedEmail } from './qc-fixes-server';

describe('normalizeLast6', () => {
  it('upper-cases and keeps the last 6', () => {
    expect(normalizeLast6('b47213')).toBe('B47213');
    expect(normalizeLast6('1FTBR3X89TKB47213')).toBe('B47213');
    expect(normalizeLast6(' b4-72 13 ')).toBe('B47213');
  });
  it('is null with fewer than 6 letters/digits', () => {
    expect(normalizeLast6('B472')).toBeNull();
    expect(normalizeLast6('')).toBeNull();
    expect(normalizeLast6(null)).toBeNull();
  });
});

describe('pickVinMatch', () => {
  const a1 = { id: 'a1', vin: '1FTBR3X89TKB47213', created_at: '2026-09-01T00:00:00Z', vehicle_year: '2026', vehicle_make: 'Ford', vehicle_model: 'Transit' };
  const a2 = { ...a1, id: 'a2', created_at: '2026-10-01T00:00:00Z' };
  const b = { id: 'b', vin: '3C6LRVDG5PEB47213', created_at: '2026-10-02T00:00:00Z' };
  it('takes the newest visit of the one VIN', () => {
    expect(pickVinMatch([a1, a2], 'B47213')?.id).toBe('a2');
  });
  it('refuses to guess between two different VINs', () => {
    expect(pickVinMatch([a1, b], 'B47213')).toBeNull();
  });
  it('ignores rows that do not end with the last 6', () => {
    expect(pickVinMatch([{ ...b, vin: '3C6LRVDG5PEB47219' }, a1], 'B47213')?.id).toBe('a1');
    expect(pickVinMatch([], 'B47213')).toBeNull();
  });
});

describe('statusAfterFixBy', () => {
  it('schedules with a date, un-schedules without, and leaves fixed alone', () => {
    expect(statusAfterFixBy('new', '2026-10-17')).toBe('scheduled');
    expect(statusAfterFixBy('scheduled', null)).toBe('new');
    expect(statusAfterFixBy('fixed', null)).toBe('fixed');
  });
});

describe('vehicleLabel', () => {
  it('joins what it has', () => {
    expect(vehicleLabel({ vehicle_year: '2026', vehicle_make: 'Ford', vehicle_model: 'Transit', vehicle_trim: '148 EL' })).toBe('2026 Ford Transit 148 EL');
    expect(vehicleLabel({ vehicle_make: ' ', vehicle_model: null })).toBeNull();
  });
});

describe('QC emails', () => {
  const report = { vin_last6: 'B47213', vehicle_label: 'Ford <Transit>', reported_by_name: 'Chaquanna', comments: 'Rack rubbing\nDecal lifting', created_at: '2026-10-15T14:41:00Z' };
  it('reported email names the VIN, escapes text and links the report', () => {
    const { subject, html } = buildQcReportedEmail({ customerName: 'Masterack', report, photoUrls: ['https://x/p/1'], linkUrl: 'https://go.bmgfleet.com/qc/t?report=r' });
    expect(subject).toBe('QC fix reported: VIN …B47213');
    expect(html).toContain('Ford &lt;Transit&gt;');
    expect(html).toContain('Rack rubbing<br>Decal lifting');
    expect(html).toContain('https://x/p/1');
    expect(html).toContain('View the report');
  });
  it('fixed email carries the note and fixed date', () => {
    const { subject, html } = buildQcFixedEmail({ report, message: 'Swapped the pad.', fixedOn: '2026-10-17T15:00:00Z', fixPhotoUrls: [], linkUrl: 'https://l', signature: null });
    expect(subject).toBe('QC fix done: VIN …B47213');
    expect(html).toContain('Swapped the pad.');
    expect(html).toContain('Oct 17, 2026');
  });
});
