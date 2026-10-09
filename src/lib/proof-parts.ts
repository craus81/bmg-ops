// The parts list on a photo / customer proof: every box becomes a numbered
// part, and boxes that are the same piece (the door logo on each side) share
// one number and one size.
//
// Matching pieces come out of the drawing a fraction of an inch apart — two
// hand-drawn boxes over the same logo never measure identically — but they
// are printed from one file, so the quote and the customer's list must show
// one size. Owner rule (2026-10-09): matching elements are normalized.
//
// Pure functions, so pricing (photo measurement lines), the editor, the
// on-screen preview and the saved customer picture all read the same answer.

import type { CoverageBox, PhotoProof } from './coverage-proof';

/** Two pieces with the same name are the same part only within this size difference. */
export const MATCH_TOLERANCE = 0.15;

export interface PartSize {
  width_in: number;
  height_in: number;
  area_in2: number;
}

export interface ProofPart {
  /** 1-based number shown on the picture and in the table. */
  number: number;
  /** The first member's label (trimmed), or '' for an unnamed box. */
  name: string;
  substrate_id: string | null;
  /** The one size every sized member carries, or null when none is sized. */
  size: PartSize | null;
  /** Box ids, in proof order. */
  boxIds: string[];
}

export interface ProofPartsIndex {
  parts: ProofPart[];
  partOf: Map<string, ProofPart>;
  /** The size a box is priced and shown at — the part's size, scaled for
   *  perspective when the box carried its own true area. Absent for boxes
   *  with no size. */
  sizeOf: Map<string, PartSize>;
}

// Words that say WHERE a piece goes rather than what it is: "Logo (driver)"
// and "Logo (passenger)" are the same part.
const SIDE_WORDS = /\b(driver'?s?|passenger'?s?|left|right|lh|rh|ds|ps|curb|street|l\/r|r\/l)\b/g;

/** What a label says the piece IS, for matching — case, punctuation and side words ignored. */
export function partKey(label: string): string {
  return (label || '')
    .toLowerCase()
    .replace(SIDE_WORDS, ' ')
    .replace(/side\s*\)/g, ')') // "(driver side)" → "()" once the side word goes
    .replace(/[^a-z0-9.#&]+/g, ' ')
    .replace(/\b(side)\s*$/, '')
    .trim();
}

const sized = (b: CoverageBox) =>
  (b.width_in ?? 0) > 0 && (b.height_in ?? 0) > 0;

const close = (a: number, b: number) => Math.abs(a - b) <= MATCH_TOLERANCE * Math.max(a, b);

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Proof pages are read top to bottom, left to right — boxes whose vertical
 * spans overlap sit on one row, ordered by x — so the numbers on the
 * picture run in reading order whatever order they were drawn in.
 */
function readingOrder(boxes: CoverageBox[]): CoverageBox[] {
  const byTop = [...boxes].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const rows: { bottom: number; boxes: CoverageBox[] }[] = [];
  for (const b of byTop) {
    const mid = b.rect.y + b.rect.h / 2;
    const row = rows[rows.length - 1];
    if (row && mid <= row.bottom) {
      row.boxes.push(b);
      row.bottom = Math.max(row.bottom, b.rect.y + b.rect.h);
    } else {
      rows.push({ bottom: b.rect.y + b.rect.h, boxes: [b] });
    }
  }
  return rows.flatMap(r => r.boxes.sort((a, b) => a.rect.x - b.rect.x));
}

/**
 * Number every box across every page and give matching pieces one size.
 *
 * Same part = same name (ignoring side words), same film, and — when both are
 * sized — within 15% in each dimension (a big and a small "Logo" stay two
 * parts). The shared size is a printed/typed one when any member has it
 * (a person knew better than the drawing); otherwise the average of the
 * members' measurements, to a tenth of an inch. Boxes with no size yet share
 * the number but stay unsized, so an uncalibrated picture is still priced at
 * nothing.
 */
export function proofParts(proofs: PhotoProof[]): ProofPartsIndex {
  const parts: ProofPart[] = [];
  const members = new Map<ProofPart, CoverageBox[]>();
  const partOf = new Map<string, ProofPart>();

  for (const proof of proofs) {
    for (const b of readingOrder(proof.boxes)) {
      const key = partKey(b.label);
      const film = b.substrate_id || null;
      let part: ProofPart | undefined;
      if (key) {
        part = parts.find(p => {
          if (partKey(p.name) !== key || p.substrate_id !== film) return false;
          const ref = members.get(p)!.find(sized);
          if (!ref || !sized(b)) return true;
          return close(ref.width_in!, b.width_in!) && close(ref.height_in!, b.height_in!);
        });
      }
      if (!part) {
        part = { number: parts.length + 1, name: (b.label || '').trim(), substrate_id: film, size: null, boxIds: [] };
        parts.push(part);
        members.set(part, []);
      }
      part.boxIds.push(b.id);
      members.get(part)!.push(b);
      partOf.set(b.id, part);
    }
  }

  const sizeOf = new Map<string, PartSize>();
  for (const part of parts) {
    const withSize = members.get(part)!.filter(sized);
    if (withSize.length === 0) continue;
    if (withSize.length === 1) {
      // Nothing to even out — the box keeps its exact size (and price).
      const b = withSize[0];
      part.size = { width_in: b.width_in!, height_in: b.height_in!, area_in2: b.area_in2 ?? b.width_in! * b.height_in! };
      continue;
    }
    const typed = withSize.find(b => b.manual);
    const w = typed ? typed.width_in! : round1(withSize.reduce((s, b) => s + b.width_in!, 0) / withSize.length);
    const h = typed ? typed.height_in! : round1(withSize.reduce((s, b) => s + b.height_in!, 0) / withSize.length);
    part.size = { width_in: w, height_in: h, area_in2: w * h };
    for (const b of withSize) {
      // A measured box under perspective covers a true area that isn't
      // width × height; keep that ratio when its size is evened out.
      const own = b.width_in! * b.height_in!;
      const area = b.area_in2 && b.area_in2 > 0 && own > 0 ? b.area_in2 * (w * h) / own : w * h;
      sizeOf.set(b.id, { width_in: w, height_in: h, area_in2: area });
    }
  }

  return { parts, partOf, sizeOf };
}

/** A box with the size it is priced and shown at. */
export function withPartSize(b: CoverageBox, index: ProofPartsIndex): CoverageBox {
  const s = index.sizeOf.get(b.id);
  if (!s) return b;
  if (s.width_in === b.width_in && s.height_in === b.height_in && s.area_in2 === b.area_in2) return b;
  return { ...b, width_in: s.width_in, height_in: s.height_in, area_in2: s.area_in2 };
}

/** One row of the table printed under a proof picture. */
export interface PartRow {
  number: number;
  name: string;
  size: string;
  film: string;
  qty: number;
}

const inches = (n: number) => `${round1(n).toLocaleString('en-US')}"`;

export const partSizeText = (s: PartSize | null) =>
  s ? `${inches(s.width_in)} × ${inches(s.height_in)}` : '';

/**
 * The table for ONE page: the parts on that page in number order, with how
 * many of each that page shows (a box's own qty counts — "×2" on one box is
 * two pieces).
 */
export function partRowsForPage(
  boxes: CoverageBox[],
  index: ProofPartsIndex,
  filmName: (substrateId: string | null) => string,
): PartRow[] {
  const qty = new Map<ProofPart, number>();
  for (const b of boxes) {
    const p = index.partOf.get(b.id);
    if (!p) continue;
    qty.set(p, (qty.get(p) || 0) + Math.max(1, Math.round(b.qty || 1)));
  }
  return [...qty.entries()]
    .sort(([a], [b]) => a.number - b.number)
    .map(([p, n]) => ({
      number: p.number,
      name: p.name || 'Area',
      size: partSizeText(p.size),
      film: filmName(p.substrate_id),
      qty: n,
    }));
}

export interface BadgeSpot {
  boxId: string;
  number: number;
  x: number;
  y: number;
}

/** Badge radius on the saved picture, in photo pixels — sized with the picture like its old tags. */
export const badgeRadius = (photoW: number) => Math.max(9, Math.round(photoW / 110));

type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where each number goes: just outside its piece — left, then right, above,
 * below — at the first spot that stays on the picture and covers no other
 * piece or number. With no clear spot it sits on the piece's top-left corner,
 * which still reads as "this one".
 */
export function badgeSpots(
  boxes: CoverageBox[],
  numberOf: (boxId: string) => number | undefined,
  photoW: number,
  photoH: number,
  r = badgeRadius(photoW),
): BadgeSpot[] {
  const gap = Math.max(2, r * 0.35);
  const placed: Rect[] = [];
  const spots: BadgeSpot[] = [];
  for (const b of boxes) {
    const n = numberOf(b.id);
    if (n == null) continue;
    const { x, y, w, h } = b.rect;
    const cy = y + h / 2, cx = x + w / 2;
    const candidates = [
      { x: x - gap - r, y: cy },
      { x: x + w + gap + r, y: cy },
      { x: cx, y: y - gap - r },
      { x: cx, y: y + h + gap + r },
      { x: x - gap - r, y: y + r },
      { x: x + w + gap + r, y: y + r },
    ];
    const free = candidates.find(c => {
      const disc = { x: c.x - r, y: c.y - r, w: r * 2, h: r * 2 };
      if (disc.x < 0 || disc.y < 0 || disc.x + disc.w > photoW || disc.y + disc.h > photoH) return false;
      if (boxes.some(o => o.id !== b.id && overlaps(disc, o.rect))) return false;
      return !placed.some(p => overlaps(disc, p));
    });
    const at = free || { x: Math.min(Math.max(x, r), photoW - r), y: Math.min(Math.max(y, r), photoH - r) };
    placed.push({ x: at.x - r, y: at.y - r, w: r * 2, h: r * 2 });
    spots.push({ boxId: b.id, number: n, x: at.x, y: at.y });
  }
  return spots;
}
