import { describe, it, expect } from 'vitest';
import {
  groupEstimateFiles, groupCompletionPhotos, completionFolderName, completionJobKey,
  completionCustomerFilter, completionRowIsCustomer, estimateFolderName,
} from './client-files-fleetsuite';

describe('From Estimates folders', () => {
  it('groups files by estimate, newest estimate first', () => {
    const est1 = { id: 'e1', estimate_number: 'EST-2610-001', netsuite_estimate_number: null };
    const est2 = { id: 'e2', estimate_number: 'EST-2610-014', netsuite_estimate_number: 'EST1234' };
    const out = groupEstimateFiles([
      { id: 'a', size_bytes: 100, created_at: '2026-10-20T10:00:00Z', estimate: est1 },
      { id: 'b', size_bytes: '50', created_at: '2026-10-21T10:00:00Z', estimate: est2 },
      { id: 'c', size_bytes: null, created_at: '2026-10-19T10:00:00Z', estimate: est1 },
      { id: 'd', size_bytes: 1, created_at: '2026-10-22T10:00:00Z', estimate: null },
    ]);
    expect(out.map(f => f.key)).toEqual(['e2', 'e1']);
    expect(out[0]).toMatchObject({ name: 'EST-2610-014 (EST1234)', files: 1, bytes: 50 });
    expect(out[1]).toMatchObject({ name: 'EST-2610-001', files: 2, bytes: 100, latest: '2026-10-20T10:00:00Z' });
  });

  it('names an estimate by whichever number it has', () => {
    expect(estimateFolderName({ estimate_number: 'EST-1', netsuite_estimate_number: 'EST-1' })).toBe('EST-1');
    expect(estimateFolderName({ estimate_number: null, netsuite_estimate_number: 'EST9' })).toBe('EST9');
    expect(estimateFolderName({ estimate_number: null })).toBe('Estimate');
  });
});

describe('Completion Photos folders', () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id, source: 'shop', taken_at: '2026-10-20T15:00:00Z', vin: '1FTBR1C82PKA54821', vehicle: '2024 Ford Transit',
    job_label: '5512', record_id: 'r1', ...over,
  });

  it('one folder per job, named from its newest photo', () => {
    const out = groupCompletionPhotos([
      row('shop:1', { taken_at: '2026-10-21T15:00:00Z' }),
      row('shop:2'),
      row('installer:3', { source: 'installer', record_id: 'r9', job_label: 'CNI-77', taken_at: '2026-10-22T09:00:00Z', vin: null, vehicle: null }),
    ]);
    expect(out.map(f => f.key)).toEqual(['installer:r9', 'shop:r1']);
    expect(out[1]).toMatchObject({ name: '2026-10-21 · SO 5512 · 2024 Ford Transit · VIN …A54821', files: 2 });
    expect(out[0].name).toBe('2026-10-22 · CNI-77');
  });

  it('a photo with no record gets its own folder', () => {
    expect(completionJobKey({ id: 'scan:x', source: 'scan', record_id: null })).toBe('scan:x');
    expect(completionFolderName({ taken_at: null, job_label: null, vehicle: null, vin: null })).toBe('Photos');
  });
});

describe('matching completion photos to a customer', () => {
  it('quotes the name so commas and parentheses survive', () => {
    expect(completionCustomerFilter('c1', ' Acme,  Plumbing (MO) ')).toBe('customer_id.eq.c1,customer_name.ilike."acme,%plumbing%(mo)"');
    expect(completionCustomerFilter('c1', 'A "Q" 100%_x')).toBe('customer_id.eq.c1,customer_name.ilike."a%\\"q\\"%100\\\\%\\\\_x"');
    expect(completionCustomerFilter('c1', null)).toBe('customer_id.eq.c1');
  });

  it('keeps only the id match or the same name apart from case and spacing', () => {
    expect(completionRowIsCustomer({ customer_id: 'c1', customer_name: 'Other' }, 'c1', 'Acme')).toBe(true);
    expect(completionRowIsCustomer({ customer_id: null, customer_name: ' ACME   plumbing' }, 'c1', 'Acme Plumbing')).toBe(true);
    expect(completionRowIsCustomer({ customer_id: null, customer_name: 'Acme Plumbing West' }, 'c1', 'Acme Plumbing')).toBe(false);
    expect(completionRowIsCustomer({ customer_id: null, customer_name: '' }, 'c1', '')).toBe(false);
  });
});
