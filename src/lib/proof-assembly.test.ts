import { describe, expect, it } from 'vitest';
import type { GuidePage } from './install-guide';
import { baseSourcePath, planProofAssembly } from './proof-assembly';

const page = (id: string, src: string | null, n: number | null): GuidePage => ({
  id,
  name: id,
  image_path: `install-guides/g/${id}.png`,
  image_w: 3300,
  image_h: 2550,
  px_per_in: 10.8,
  dims: [],
  source_pdf_path: src,
  source_page: n,
});

describe('baseSourcePath', () => {
  it('picks the first PDF source in guide order', () => {
    expect(baseSourcePath([page('a', null, null), page('b', 'src.pdf', 3)])).toBe('src.pdf');
  });

  it('returns null when nothing came from a PDF', () => {
    expect(baseSourcePath([page('a', null, null)])).toBeNull();
  });
});

describe('planProofAssembly — replace', () => {
  it('swaps dimensioned pages in for their originals and keeps the rest', () => {
    // 5-page deck (cover, notes, 3 proofs); pages 3 and 4 were dimensioned.
    const plan = planProofAssembly(
      5,
      [page('d3', 'src.pdf', 3), page('d4', 'src.pdf', 4)],
      'src.pdf',
      'replace',
    );
    expect(plan.steps).toEqual([
      { kind: 'original', sourceIndex: 0 },
      { kind: 'original', sourceIndex: 1 },
      { kind: 'dimensioned', pageId: 'd3' },
      { kind: 'dimensioned', pageId: 'd4' },
      { kind: 'original', sourceIndex: 4 },
    ]);
    expect(plan.appended).toEqual([]);
  });

  it('appends image uploads and pages from other PDFs at the end', () => {
    const plan = planProofAssembly(
      2,
      [page('d1', 'src.pdf', 1), page('img', null, null), page('other', 'other.pdf', 1)],
      'src.pdf',
      'replace',
    );
    expect(plan.steps).toEqual([
      { kind: 'dimensioned', pageId: 'd1' },
      { kind: 'original', sourceIndex: 1 },
    ]);
    expect(plan.appended).toEqual(['img', 'other']);
  });

  it('treats an out-of-range source page as unmatched', () => {
    const plan = planProofAssembly(2, [page('d9', 'src.pdf', 9)], 'src.pdf', 'replace');
    expect(plan.steps).toEqual([
      { kind: 'original', sourceIndex: 0 },
      { kind: 'original', sourceIndex: 1 },
    ]);
    expect(plan.appended).toEqual(['d9']);
  });
});

describe('planProofAssembly — insert', () => {
  it('keeps every original and slots the dimensioned page right after it', () => {
    const plan = planProofAssembly(3, [page('d2', 'src.pdf', 2)], 'src.pdf', 'insert');
    expect(plan.steps).toEqual([
      { kind: 'original', sourceIndex: 0 },
      { kind: 'original', sourceIndex: 1 },
      { kind: 'dimensioned', pageId: 'd2' },
      { kind: 'original', sourceIndex: 2 },
    ]);
  });

  it('keeps duplicate imports of one source page in guide order', () => {
    const plan = planProofAssembly(
      1,
      [page('first', 'src.pdf', 1), page('second', 'src.pdf', 1)],
      'src.pdf',
      'insert',
    );
    expect(plan.steps).toEqual([
      { kind: 'original', sourceIndex: 0 },
      { kind: 'dimensioned', pageId: 'first' },
      { kind: 'dimensioned', pageId: 'second' },
    ]);
  });
});
