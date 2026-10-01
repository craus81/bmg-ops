import { describe, it, expect } from 'vitest';
import {
  buildProofBoxes,
  findWheels,
  labelComponents,
  matchSizeRow,
  sanitizeProofRead,
  snapBox,
  unplacedLegendRows,
  usesLegendSize,
  type RgbaImage,
} from './proof-sizing';

// ───── Synthetic pages: white paper, black outline, coloured decals ─────

type Rgb = [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const BLUE: Rgb = [30, 80, 220];

function blank(width: number, height: number, color: Rgb = WHITE): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0]; data[i * 4 + 1] = color[1]; data[i * 4 + 2] = color[2]; data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, color: Rgb) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
      const p = (yy * img.width + xx) * 4;
      img.data[p] = color[0]; img.data[p + 1] = color[1]; img.data[p + 2] = color[2];
    }
  }
}

function fillDisc(img: RgbaImage, cx: number, cy: number, r: number, color: Rgb) {
  for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++) {
    for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
      if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) fillRect(img, xx, yy, 1, 1, color);
    }
  }
}

/** A hairline rectangle outline, like a vehicle body drawn at 2 px. */
function outline(img: RgbaImage, x: number, y: number, w: number, h: number, t = 2) {
  fillRect(img, x, y, w, t, BLACK);
  fillRect(img, x, y + h - t, w, t, BLACK);
  fillRect(img, x, y, t, h, BLACK);
  fillRect(img, x + w - t, y, t, h, BLACK);
}

/** A side view: body outline 200..1000 × 150..420, road wheels 400 px apart at y=400. */
function sideViewPage(): RgbaImage {
  const img = blank(1200, 500);
  outline(img, 200, 150, 800, 270);
  fillDisc(img, 300, 400, 40, BLACK);
  fillDisc(img, 700, 400, 40, BLACK);
  return img;
}

describe('labelComponents', () => {
  it('separates 4-connected blobs that only touch diagonally', () => {
    const mask = new Uint8Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]);
    expect(labelComponents(mask, 3, 3, false).comps).toHaveLength(3);
    expect(labelComponents(mask, 3, 3, true).comps).toHaveLength(1);
  });

  it('reports each blob\'s bounding box and area', () => {
    const mask = new Uint8Array(5 * 4);
    for (const i of [1, 2, 6, 7, 18]) mask[i] = 1;
    const { comps } = labelComponents(mask, 5, 4, false);
    expect(comps).toHaveLength(2);
    expect(comps[0]).toEqual({ minX: 1, minY: 0, maxX: 2, maxY: 1, area: 4 });
    expect(comps[1]).toEqual({ minX: 3, minY: 3, maxX: 3, maxY: 3, area: 1 });
  });
});

describe('findWheels', () => {
  it('finds the two road wheels, ignoring the body outline that runs through them', () => {
    const img = sideViewPage();
    const found = findWheels(img, { x: 0, y: 0, w: 1200, h: 500 });
    expect(found).not.toBeNull();
    expect(found!.a.x).toBeCloseTo(300, -1);
    expect(found!.b.x).toBeCloseTo(700, -1);
    expect(found!.a.y).toBeCloseTo(400, -1);
    expect(found!.b.y).toBeCloseTo(400, -1);
    expect(found!.a.r).toBeCloseTo(40, -1);
  });

  it('prefers the lowest pair — a forklift drawn on the box truck is not the road wheels', () => {
    const img = sideViewPage();
    fillDisc(img, 350, 250, 40, BLACK);
    fillDisc(img, 650, 250, 40, BLACK);
    const found = findWheels(img, { x: 0, y: 0, w: 1200, h: 500 });
    expect(found!.a.y).toBeCloseTo(400, -1);
    expect(found!.a.x).toBeCloseTo(300, -1);
  });

  it('ignores blobs too small to be a tyre', () => {
    const img = blank(1200, 500);
    fillDisc(img, 300, 400, 12, BLACK);
    fillDisc(img, 420, 400, 12, BLACK);
    expect(findWheels(img, { x: 0, y: 0, w: 1200, h: 500 })).toBeNull();
  });

  it('refuses a pair that is not spaced like a wheelbase', () => {
    const img = blank(1200, 500);
    fillDisc(img, 300, 400, 40, BLACK);
    fillDisc(img, 420, 400, 40, BLACK); // 3 radii apart — a dual axle, not a wheelbase
    expect(findWheels(img, { x: 0, y: 0, w: 1200, h: 500 })).toBeNull();
  });

  it('returns page coordinates when asked to look inside a crop', () => {
    const img = blank(1600, 900);
    fillDisc(img, 500, 700, 40, BLACK);
    fillDisc(img, 900, 700, 40, BLACK);
    const found = findWheels(img, { x: 200, y: 300, w: 1200, h: 500 });
    expect(found!.a.x).toBeCloseTo(500, -1);
    expect(found!.b.x).toBeCloseTo(900, -1);
    expect(found!.a.y).toBeCloseTo(700, -1);
  });
});

describe('snapBox', () => {
  it('tightens a loose box to the artwork and drops the body line crossing it', () => {
    const img = blank(400, 300);
    fillRect(img, 100, 100, 120, 60, BLUE);
    fillRect(img, 0, 130, 400, 2, BLACK); // door seam running through the decal
    const snapped = snapBox(img, { x: 80, y: 80, w: 180, h: 110 }, 5);
    expect(snapped).toEqual({ x: 100, y: 100, w: 120, h: 60 });
  });

  it('keeps a thin letter next to the artwork — it is lettering, not a seam', () => {
    const img = blank(400, 300);
    fillRect(img, 100, 100, 120, 60, BLUE);
    fillRect(img, 225, 100, 2, 20, BLUE); // an "l" five px to the right
    const snapped = snapBox(img, { x: 80, y: 80, w: 180, h: 110 }, 5);
    expect(snapped).toEqual({ x: 100, y: 100, w: 127, h: 60 });
  });

  it('drops a thin stroke that is far from any artwork', () => {
    const img = blank(400, 300);
    fillRect(img, 100, 100, 120, 60, BLUE);
    fillRect(img, 250, 100, 2, 20, BLUE); // 30 px away — a crease line
    const snapped = snapBox(img, { x: 80, y: 80, w: 180, h: 110 }, 5);
    expect(snapped).toEqual({ x: 100, y: 100, w: 120, h: 60 });
  });

  it('leaves the box alone when nothing inside differs from the background', () => {
    const img = blank(400, 300);
    const rect = { x: 80, y: 80, w: 180, h: 110 };
    expect(snapBox(img, rect, 5)).toEqual(rect);
  });

  it('measures against the box\'s own background, so a decal on a dark panel still snaps', () => {
    const img = blank(400, 300, [40, 40, 40]);
    fillRect(img, 100, 100, 120, 60, WHITE);
    expect(snapBox(img, { x: 80, y: 80, w: 180, h: 110 }, 5)).toEqual({ x: 100, y: 100, w: 120, h: 60 });
  });
});

describe('matchSizeRow', () => {
  const rows = [
    { name: 'Door Logo', width_in: 24, height_in: 12, qty: 2 },
    { name: 'Phone number', width_in: 36, height_in: 4, qty: null },
    { name: 'Rear door stripe', width_in: null, height_in: 6, qty: null },
  ];
  it('matches the same name regardless of case and punctuation', () => {
    expect(matchSizeRow('door logo', rows)).toBe(0);
    expect(matchSizeRow('Door-Logo', rows)).toBe(0);
  });
  it('matches a name that contains the row name', () => {
    expect(matchSizeRow('Driver door logo', rows)).toBe(0);
  });
  it('matches on shared words when half of them agree', () => {
    expect(matchSizeRow('rear stripe', rows)).toBe(2);
  });
  it('gives up rather than guess', () => {
    expect(matchSizeRow('Hood graphic', rows)).toBeNull();
    expect(matchSizeRow('', rows)).toBeNull();
  });
});

describe('sanitizeProofRead', () => {
  it('clamps boxes to the page and drops the unusable', () => {
    const r = sanitizeProofRead({
      views: [
        { kind: 'driver_side', label: 'Driver', box: { x: -0.1, y: 0.2, w: 0.7, h: 0.5 } },
        { kind: 'nonsense', box: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } },
        { kind: 'rear', box: { x: 0.5, y: 0.5, w: 0, h: 0.2 } },
      ],
      size_table: [
        { name: 'Logo', width_in: '24', height_in: 12 },
        { name: 'No size', width_in: null, height_in: null },
        { name: '', width_in: 3, height_in: 3 },
      ],
      decals: [
        { name: 'Logo', view: 0, box: { x: 0.2, y: 0.3, w: 0.1, h: 0.1 }, size_table_index: 0 },
        { name: 'Stray', view: 7, box: { x: 0.2, y: 0.3, w: 0.1, h: 0.1 }, size_table_index: 9 },
        { name: 'Bad box', view: 0, box: { x: 'a', y: 0, w: 1, h: 1 } },
      ],
    });
    expect(r.views).toHaveLength(2);
    expect(r.views[0].box).toEqual({ x: 0, y: 0.2, w: 0.6, h: 0.5 });
    expect(r.views[1].kind).toBe('other');
    expect(r.size_table).toEqual([{ name: 'Logo', width_in: 24, height_in: 12, qty: null }]);
    expect(r.decals).toHaveLength(2);
    expect(r.decals[0].size_table_index).toBe(0);
    expect(r.decals[1]).toMatchObject({ view: null, size_table_index: null });
  });

  it('survives garbage', () => {
    expect(sanitizeProofRead(null)).toEqual({ page_title: null, views: [], size_table: [], decals: [] });
    expect(sanitizeProofRead('x').decals).toEqual([]);
  });
});

describe('buildProofBoxes', () => {
  const page = () => {
    const img = sideViewPage();
    fillRect(img, 400, 150, 160, 80, BLUE); // door logo: 40" × 20" at 4 px/in
    fillRect(img, 650, 200, 100, 40, BLUE); // unlisted lettering: 25" × 10"
    return img;
  };
  const read = sanitizeProofRead({
    page_title: 'Driver side',
    views: [{ kind: 'driver_side', label: 'Driver side', box: { x: 0.1, y: 0.2, w: 0.75, h: 0.7 } }],
    size_table: [{ name: 'Door logo', width_in: 40, height_in: 22, qty: 2 }],
    decals: [
      { name: 'Door logo', view: 0, box: { x: 390 / 1200, y: 140 / 500, w: 180 / 1200, h: 100 / 500 }, size_table_index: 0 },
      { name: 'Lettering', view: 0, box: { x: 640 / 1200, y: 190 / 500, w: 120 / 1200, h: 60 / 500 }, size_table_index: null },
    ],
  });
  let n = 0;
  const newId = () => `id-${++n}`;

  it('scales the page by the wheelbase and sizes each decal — table first, drawing second', () => {
    n = 0;
    const built = buildProofBoxes({ img: page(), read, wheelbaseIn: 100, defaultFilmId: 'film-1', newId });
    expect(built.wheels).not.toBeNull();
    expect(built.calibration?.line).toMatchObject({ inches: 100 });
    expect(built.calibration!.line!.x1).toBeCloseTo(300, -1);
    expect(built.calibration!.line!.x2).toBeCloseTo(700, -1);

    const [logo, lettering] = built.boxes;
    // Snapped tight to the artwork, not to the reader's loose box.
    expect(logo.rect).toEqual({ x: 400, y: 150, w: 160, h: 80 });
    expect(lettering.rect).toEqual({ x: 650, y: 200, w: 100, h: 40 });
    // The printed size wins where there is one (22" tall, though it draws at 20").
    expect(logo.legend).toEqual({ row_id: built.legend[0].id, name: 'Door logo', width_in: 40, height_in: 22 });
    expect(logo.manual).toBe(true);
    expect(logo.width_in).toBe(40);
    expect(logo.height_in).toBe(22);
    expect(usesLegendSize(logo)).toBe(true);
    // No row: the drawing's own measurement, at 400 px / 100 in.
    expect(lettering.legend).toBeNull();
    expect(lettering.manual).toBeFalsy();
    expect(lettering.width_in).toBeCloseTo(25, 5);
    expect(lettering.height_in).toBeCloseTo(10, 5);
    expect(lettering.measured_by).toBe('line');
    expect(lettering.substrate_id).toBe('film-1');
    expect(built.notes[0]).toBe('2 decals found: 1 sized from the size table, 1 measured off the drawing.');
    expect(unplacedLegendRows(built.legend, built.boxes)).toEqual([]);
  });

  it('keeps the printed sizes but measures nothing when the template has no wheelbase', () => {
    n = 0;
    const built = buildProofBoxes({ img: page(), read, wheelbaseIn: null, defaultFilmId: null, newId });
    expect(built.calibration).toBeNull();
    expect(built.boxes[0].width_in).toBe(40);
    expect(built.boxes[1].width_in).toBeNull();
    expect(built.notes.some(s => s.includes('no wheelbase'))).toBe(true);
    expect(built.notes[0]).toContain('1 still need a size');
  });

  it('borrows the missing dimension from the drawing when the table prints only one', () => {
    n = 0;
    const oneDim = sanitizeProofRead({
      ...read,
      size_table: [{ name: 'Door logo', width_in: null, height_in: 22 }],
    });
    const built = buildProofBoxes({ img: page(), read: oneDim, wheelbaseIn: 100, defaultFilmId: null, newId });
    const logo = built.boxes[0];
    expect(logo.height_in).toBe(22);
    expect(logo.width_in).toBeCloseTo(40, 5);
    expect(logo.manual).toBe(true);
    expect(usesLegendSize(logo)).toBe(true);
  });

  it('matches a row by name when the reader did not pair it', () => {
    n = 0;
    const unpaired = sanitizeProofRead({
      ...read,
      decals: read.decals.map(d => ({ ...d, size_table_index: null })),
    });
    const built = buildProofBoxes({ img: page(), read: unpaired, wheelbaseIn: 100, defaultFilmId: null, newId });
    expect(built.boxes[0].legend?.name).toBe('Door logo');
    expect(built.boxes[1].legend).toBeNull();
  });

  it('says so when there is no side view to scale from', () => {
    n = 0;
    const rearOnly = sanitizeProofRead({ ...read, views: [{ kind: 'rear', box: { x: 0, y: 0, w: 1, h: 1 } }] });
    const built = buildProofBoxes({ img: page(), read: rearOnly, wheelbaseIn: 100, defaultFilmId: null, newId });
    expect(built.calibration).toBeNull();
    expect(built.notes.some(s => s.startsWith('No side view'))).toBe(true);
  });
});

describe('unplacedLegendRows', () => {
  const rows = [
    { id: 'p1-logo', name: 'Door logo', width_in: 24, height_in: 12, qty: 2 },
    { id: 'p1-phone', name: 'Phone', width_in: 36, height_in: 4, qty: null },
  ];
  const box = (legend: any) => ({ id: 'b', label: '', color: '#06b6d4', rect: { x: 0, y: 0, w: 1, h: 1 }, legend });
  it('lists rows no box uses', () => {
    expect(unplacedLegendRows(rows, [box({ row_id: 'p1-logo', name: 'Door logo', width_in: 24, height_in: 12 })]).map(r => r.id)).toEqual(['p1-phone']);
  });
  it('counts a box placed from another page\'s copy of the same row', () => {
    expect(unplacedLegendRows(rows, [box({ row_id: 'p2-logo', name: 'door  logo', width_in: 24, height_in: 12 })]).map(r => r.id)).toEqual(['p1-phone']);
  });
  it('does not confuse rows that share a name but not a size', () => {
    expect(unplacedLegendRows(rows, [box({ row_id: 'p2-logo', name: 'Door logo', width_in: 48, height_in: 24 })]).map(r => r.id)).toEqual(['p1-logo', 'p1-phone']);
  });
});
