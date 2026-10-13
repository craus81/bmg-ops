import { describe, it, expect } from 'vitest';
import {
  completionPhotoFileName, numberedFileNames, isCompletionPhotoId, completionPhotoRecordLink,
} from './completion-photos';

const row = { customer_name: 'Orkin', job_label: 'SO-24817', vin: '1FTBR1C80PKA41927', storage_path: 'vehicles/x/completion-1.JPG' };

describe('completionPhotoFileName', () => {
  it('names a photo by customer, job and VIN last 6', () => {
    expect(completionPhotoFileName(row, 1)).toBe('Orkin – SO-24817 – A41927 – 1.jpg');
  });

  it('drops missing parts and falls back to Photo', () => {
    expect(completionPhotoFileName({ ...row, job_label: null }, 2)).toBe('Orkin – A41927 – 2.jpg');
    expect(completionPhotoFileName({ customer_name: null, job_label: null, vin: null, storage_path: 'a.png' }, 1)).toBe('Photo – 1.png');
  });

  it('strips characters a file system rejects', () => {
    expect(completionPhotoFileName({ ...row, customer_name: 'A/B: "Co"' }, 1)).toBe('A B Co – SO-24817 – A41927 – 1.jpg');
  });
});

describe('numberedFileNames', () => {
  it('numbers repeats so a zip never overwrites one', () => {
    const other = { ...row, vin: 'XXXXXXXXXXXB18832' };
    expect(numberedFileNames([row, row, other])).toEqual([
      'Orkin – SO-24817 – A41927 – 1.jpg',
      'Orkin – SO-24817 – A41927 – 2.jpg',
      'Orkin – SO-24817 – B18832 – 1.jpg',
    ]);
  });
});

describe('isCompletionPhotoId', () => {
  it('accepts only <source>:<uuid>', () => {
    expect(isCompletionPhotoId('shop:0b6c5f7e-1d2a-4c3b-9e8f-0a1b2c3d4e5f')).toBe(true);
    expect(isCompletionPhotoId('scan:0b6c5f7e-1d2a-4c3b-9e8f-0a1b2c3d4e5f')).toBe(true);
    expect(isCompletionPhotoId('estimate:0b6c5f7e-1d2a-4c3b-9e8f-0a1b2c3d4e5f')).toBe(false);
    expect(isCompletionPhotoId('shop:1,2')).toBe(false);
    expect(isCompletionPhotoId(42)).toBe(false);
  });
});

describe('completionPhotoRecordLink', () => {
  it('links each source to where the photo lives', () => {
    expect(completionPhotoRecordLink({ source: 'shop', record_id: 'c1', vin: 'V' })).toBe('/tracking?vehicle=c1');
    expect(completionPhotoRecordLink({ source: 'installer', record_id: 'j1', vin: 'V' })).toBe('/admin/cni/jobs/j1/photos');
    expect(completionPhotoRecordLink({ source: 'scan', record_id: 's1', vin: 'abc' })).toBe('/vehicles/ABC');
    expect(completionPhotoRecordLink({ source: 'scan', record_id: 's1', vin: null })).toBeNull();
  });
});
