import { describe, expect, it } from 'vitest';
import { photoPages, photoPdfName } from './photo-print';

describe('photoPages', () => {
  it('puts one photo on each page for Print', () => {
    expect(photoPages(['a', 'b'], 1)).toEqual([['a'], ['b']]);
  });
  it('puts four to a page for Print all, the last page short', () => {
    expect(photoPages(['a', 'b', 'c', 'd', 'e', 'f'], 4)).toEqual([['a', 'b', 'c', 'd'], ['e', 'f']]);
  });
  it('makes no pages for no photos', () => {
    expect(photoPages([], 4)).toEqual([]);
  });
});

describe('photoPdfName', () => {
  it('names the file after the heading and the count', () => {
    expect(photoPdfName('Part MRK-120 · installed photos', 6)).toBe('Part-MRK-120-installed-photos-6-photos.pdf');
  });
  it('falls back to Photos and leaves the count off for one photo', () => {
    expect(photoPdfName(undefined, 1)).toBe('Photos.pdf');
  });
});
