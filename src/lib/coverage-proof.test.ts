import { describe, it, expect } from 'vitest';
import {
  boxCaption,
  measureBoxes,
  sanitizeCoverageBoxes,
  sanitizeCalibration,
  sanitizePhotoProofs,
  allProofBoxes,
  proofLabel,
  MAX_PHOTO_PROOFS,
  type CoverageBox,
} from './coverage-proof';

const box = (over: Partial<CoverageBox> = {}): CoverageBox => ({
  id: 'b1', label: 'Driver side', color: '#06b6d4',
  rect: { x: 0, y: 0, w: 200, h: 100 },
  ...over,
});

// 4 px/in across the photo.
const line = { x1: 0, y1: 0, x2: 400, y2: 0, inches: 100 };

describe('measureBoxes', () => {
  it('measures every box against the photo scale', () => {
    const [m] = measureBoxes([box()], { line });
    expect(m.width_in).toBeCloseTo(50, 8);
    expect(m.height_in).toBeCloseTo(25, 8);
    expect(m.area_in2).toBeCloseTo(1250, 8);
    expect(m.measured_by).toBe('line');
  });

  it('leaves typed dimensions alone — that is what typing one means', () => {
    const typed = box({ manual: true, width_in: 96, height_in: 48, area_in2: 4608 });
    const [m] = measureBoxes([typed], { line });
    expect(m.width_in).toBe(96);
    expect(m.height_in).toBe(48);
  });

  it('clears sizes when the photo has no scale, rather than keeping stale ones', () => {
    // Boxes measured under an old calibration must not keep those numbers
    // after it is removed — a stale inch count would price the quote.
    const measured = measureBoxes([box()], { line })[0];
    const [cleared] = measureBoxes([measured], null);
    expect(cleared.width_in).toBeNull();
    expect(cleared.area_in2).toBeNull();
    expect(cleared.measured_by).toBeNull();
  });
});

describe('boxCaption', () => {
  it('shows the label alone until the box has a size', () => {
    expect(boxCaption(box())).toBe('Driver side');
  });

  it('adds the measured size once there is one', () => {
    expect(boxCaption(box({ width_in: 96.04, height_in: 48 }))).toBe('Driver side · 96" × 48"');
  });

  it('falls back to the size when the box has no name', () => {
    expect(boxCaption(box({ label: '', width_in: 12, height_in: 6 }))).toBe('12" × 6"');
    expect(boxCaption(box({ label: '' }))).toBe('');
  });
});

describe('sanitizeCoverageBoxes', () => {
  it('keeps usable boxes and fills in the defaults', () => {
    const [b] = sanitizeCoverageBoxes([{ rect: { x: 1, y: 2, w: 3, h: 4 } }]);
    expect(b.qty).toBe(1);
    expect(b.substrate_id).toBeNull();
    expect(b.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(b.id).toBeTruthy();
  });

  it('drops boxes with no usable geometry', () => {
    expect(sanitizeCoverageBoxes([
      { rect: { x: 0, y: 0, w: 0, h: 10 } },
      { rect: { x: 0, y: 0, w: 10, h: -1 } },
      { rect: { x: 'a', y: 0, w: 10, h: 10 } },
      {},
      null,
    ])).toEqual([]);
    expect(sanitizeCoverageBoxes('nonsense')).toEqual([]);
  });

  it('round-trips the measurement fields', () => {
    const [b] = sanitizeCoverageBoxes([{
      id: 'x', label: 'Rear', color: '#ff0000', rect: { x: 0, y: 0, w: 5, h: 5 },
      qty: 3, substrate_id: 'film-1', width_in: 20, height_in: 10, area_in2: 200,
      manual: true, measured_by: 'plane',
    }]);
    expect(b).toMatchObject({
      id: 'x', qty: 3, substrate_id: 'film-1', width_in: 20, height_in: 10,
      area_in2: 200, manual: true, measured_by: 'plane',
    });
  });

  it('rejects a measured_by value it did not write', () => {
    const [b] = sanitizeCoverageBoxes([{ rect: { x: 0, y: 0, w: 5, h: 5 }, measured_by: 'vibes' }]);
    expect(b.measured_by).toBeNull();
  });
});

describe('sanitizeCalibration', () => {
  it('keeps a usable line', () => {
    expect(sanitizeCalibration({ line: { x1: 0, y1: 0, x2: 10, y2: 0, inches: 5 } })!.line).toEqual(
      { x1: 0, y1: 0, x2: 10, y2: 0, inches: 5 });
  });

  it('keeps a usable plane', () => {
    const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    expect(sanitizeCalibration({ plane: { corners, widthIn: 36, heightIn: 80 } })!.plane!.widthIn).toBe(36);
  });

  it('throws out references that cannot measure anything', () => {
    expect(sanitizeCalibration({ line: { x1: 0, y1: 0, x2: 10, y2: 0, inches: 0 } })).toBeNull();
    expect(sanitizeCalibration({ plane: { corners: [{ x: 0, y: 0 }], widthIn: 10, heightIn: 10 } })).toBeNull();
    expect(sanitizeCalibration({ plane: { corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], widthIn: -1, heightIn: 10 } })).toBeNull();
    expect(sanitizeCalibration(null)).toBeNull();
    expect(sanitizeCalibration({})).toBeNull();
  });
});

describe('sanitizePhotoProofs', () => {
  it('reads the stored list in order', () => {
    const proofs = sanitizePhotoProofs([
      { id: 'p1', path: 'quote-photos/a.jpg', label: 'Driver side', boxes: [{ rect: { x: 0, y: 0, w: 4, h: 4 } }] },
      { id: 'p2', path: 'quote-photos/b.jpg', label: 'Rear', boxes: [] },
    ]);
    expect(proofs.map(p => p.id)).toEqual(['p1', 'p2']);
    expect(allProofBoxes(proofs)).toHaveLength(1);
  });

  it('drops entries with no photo behind them', () => {
    expect(sanitizePhotoProofs([{ label: 'ghost', boxes: [] }, { path: '   ' }])).toEqual([]);
  });

  it('caps the list rather than loading an unbounded array', () => {
    const many = Array.from({ length: MAX_PHOTO_PROOFS + 5 }, (_, i) => ({ path: `p${i}.jpg` }));
    expect(sanitizePhotoProofs(many)).toHaveLength(MAX_PHOTO_PROOFS);
  });

  it('reads a migration-315 quote through its old columns', () => {
    // A row the 317 backfill has not reached still opens with its proof.
    const proofs = sanitizePhotoProofs([], {
      path: 'quote-photos/old.jpg',
      boxes: [{ rect: { x: 0, y: 0, w: 10, h: 10 }, label: 'Side' }],
    });
    expect(proofs).toHaveLength(1);
    expect(proofs[0].path).toBe('quote-photos/old.jpg');
    expect(proofs[0].boxes[0].label).toBe('Side');
  });

  it('prefers the new list when both shapes are present', () => {
    const proofs = sanitizePhotoProofs(
      [{ path: 'new.jpg', boxes: [] }],
      { path: 'old.jpg', boxes: [{ rect: { x: 0, y: 0, w: 5, h: 5 } }] },
    );
    expect(proofs).toHaveLength(1);
    expect(proofs[0].path).toBe('new.jpg');
  });
});

describe('proofLabel', () => {
  it('names an unlabelled view by its position', () => {
    expect(proofLabel({ id: 'p', path: 'a.jpg', label: '', boxes: [] }, 2)).toBe('Photo 3');
    expect(proofLabel({ id: 'p', path: 'a.jpg', label: '  Rear  ', boxes: [] }, 0)).toBe('Rear');
  });
});

describe('customer-proof fields', () => {
  it('keeps a box\'s size-table pairing and drops one with no size', () => {
    const [kept, bare] = sanitizeCoverageBoxes([
      { rect: { x: 0, y: 0, w: 4, h: 4 }, legend: { row_id: 'r1', name: 'Door logo', width_in: '24', height_in: 12 } },
      { rect: { x: 0, y: 0, w: 4, h: 4 }, legend: { row_id: 'r2', name: 'Nothing', width_in: null, height_in: 0 } },
    ]);
    expect(kept.legend).toEqual({ row_id: 'r1', name: 'Door logo', width_in: 24, height_in: 12 });
    expect(bare.legend).toBeNull();
  });

  it('reopens a proof page as one: its source, size table and wheel line survive', () => {
    const [p] = sanitizePhotoProofs([{
      id: 'p1', path: 'quote-proofs/a.jpg', label: 'Driver side', boxes: [],
      source: 'customer_proof',
      legend: [
        { id: 'r1', name: 'Door logo', width_in: 24, height_in: 12, qty: 2 },
        { id: 'r2', name: '', width_in: 24, height_in: 12 },
        { id: 'r3', name: 'No size', width_in: null, height_in: null },
        { name: 'Unit number', width_in: null, height_in: 2 },
      ],
      wheel_line: { x1: 1, y1: 2, x2: 300, y2: 2 },
    }]);
    expect(p.source).toBe('customer_proof');
    expect(p.legend).toHaveLength(2);
    expect(p.legend![0]).toEqual({ id: 'r1', name: 'Door logo', width_in: 24, height_in: 12, qty: 2 });
    expect(p.legend![1].name).toBe('Unit number');
    expect(p.legend![1].id).toBeTruthy();
    expect(p.wheel_line).toEqual({ x1: 1, y1: 2, x2: 300, y2: 2 });
  });

  it('reads a plain photo as a plain photo', () => {
    const [p] = sanitizePhotoProofs([{ id: 'p1', path: 'quote-photos/a.jpg', boxes: [], source: 'camera', wheel_line: { x1: 'a' } }]);
    expect(p.source).toBeNull();
    expect(p.legend).toEqual([]);
    expect(p.wheel_line).toBeNull();
  });
});
