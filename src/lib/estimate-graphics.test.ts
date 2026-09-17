import { describe, it, expect } from 'vitest';
import { coveragePictures } from './estimate-graphics';

// What the estimate's customer copy shows as "the coverage proof". A
// photo-proof quote (migration 317) can carry several views; only the lead
// one is mirrored into diagram_path, and rendering that alone showed a
// customer one photo of a job quoted from four.

const proof = (over: Record<string, unknown> = {}) => ({
  id: 'p1', path: 'quote-photos/a.jpg', label: '', boxes: [], calibration: null,
  diagram_path: 'quote-diagrams/a.png',
  ...over,
});

describe('coveragePictures', () => {
  it('returns every flattened photo proof, in estimator order', () => {
    const pics = coveragePictures({
      photo_proofs: [
        proof({ id: 'p1', label: 'Driver side', diagram_path: 'd/1.png' }),
        proof({ id: 'p2', label: 'Rear', diagram_path: 'd/2.png' }),
        proof({ id: 'p3', label: 'Roof', diagram_path: 'd/3.png' }),
      ],
      diagram_path: 'd/1.png',
    });
    expect(pics.map(p => p.path)).toEqual(['d/1.png', 'd/2.png', 'd/3.png']);
    expect(pics.map(p => p.caption)).toEqual(['Driver side', 'Rear', 'Roof']);
  });

  it('captions unlabelled views by position rather than leaving them blank', () => {
    const pics = coveragePictures({
      photo_proofs: [proof({ id: 'p1', diagram_path: 'd/1.png' }), proof({ id: 'p2', diagram_path: 'd/2.png' })],
    });
    expect(pics.map(p => p.caption)).toEqual(['Photo 1', 'Photo 2']);
  });

  it('leaves a single view uncaptioned — one picture needs no "Photo 1"', () => {
    const pics = coveragePictures({ photo_proofs: [proof({ label: 'Driver side' })] });
    expect(pics).toEqual([{ path: 'quote-diagrams/a.png', caption: null }]);
  });

  it('skips photos that were never flattened to a picture', () => {
    const pics = coveragePictures({
      photo_proofs: [
        proof({ id: 'p1', diagram_path: null }),
        proof({ id: 'p2', diagram_path: 'd/2.png' }),
      ],
    });
    expect(pics).toEqual([{ path: 'd/2.png', caption: null }]);
  });

  it('falls back to the template diagram on a 1:20 quote', () => {
    expect(coveragePictures({ photo_proofs: [], diagram_path: 'quote-diagrams/t.png' }))
      .toEqual([{ path: 'quote-diagrams/t.png', caption: null }]);
  });

  it('reads the pre-317 single-photo shape, whose picture is diagram_path', () => {
    const pics = coveragePictures({
      photo_proofs: null,
      photo_path: 'quote-photos/old.jpg',
      photo_boxes: [],
      diagram_path: 'quote-diagrams/old.png',
    });
    expect(pics).toEqual([{ path: 'quote-diagrams/old.png', caption: null }]);
  });

  it('has nothing to show when the quote has no proof at all', () => {
    expect(coveragePictures({ photo_proofs: [], diagram_path: null })).toEqual([]);
    expect(coveragePictures({})).toEqual([]);
  });
});
