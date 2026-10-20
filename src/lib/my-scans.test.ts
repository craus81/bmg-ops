import { describe, expect, it } from 'vitest';
import { groupMyScans, type MyScanRow } from './my-scans';

const day = (iso: string) => iso.slice(0, 10);
const row = (over: Partial<MyScanRow>): MyScanRow => ({
  id: 's1', vin: 'VIN1', part_number: 'P1', unit_number: null, billable_customer: null,
  location_name: null, vehicle_year: null, vehicle_make: null, vehicle_model: null,
  scanned_at: '2026-10-20T15:00:00Z', ...over,
});

describe('groupMyScans', () => {
  it('folds a multi-part capture into one entry with the shared photo once', () => {
    const groups = groupMyScans(
      [row({ id: 'a', part_number: 'P1' }), row({ id: 'b', part_number: 'P2', scanned_at: '2026-10-20T15:00:05Z' })],
      [
        { scan_log_id: 'a', storage_path: 'scans/a/1.jpg', created_at: '2026-10-20T15:01:00Z' },
        { scan_log_id: 'b', storage_path: 'scans/a/1.jpg', created_at: '2026-10-20T15:01:00Z' },
      ],
      day,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].parts.sort()).toEqual(['P1', 'P2']);
    expect(groups[0].photoPaths).toEqual(['scans/a/1.jpg']);
    expect(groups[0].scannedAt).toBe('2026-10-20T15:00:00Z');
  });

  it('keeps the same VIN on different days apart, newest first', () => {
    const groups = groupMyScans(
      [row({ id: 'a', scanned_at: '2026-10-19T15:00:00Z' }), row({ id: 'b', scanned_at: '2026-10-20T15:00:00Z' })],
      [],
      day,
    );
    expect(groups.map(g => g.id)).toEqual(['b', 'a']);
  });

  it('builds the vehicle name and leaves it empty when nothing is known', () => {
    const [g] = groupMyScans([row({ vehicle_year: 2024, vehicle_make: 'Ford', vehicle_model: 'Explorer' })], [], day);
    expect(g.vehicle).toBe('2024 Ford Explorer');
    expect(groupMyScans([row({})], [], day)[0].vehicle).toBeNull();
  });
});
