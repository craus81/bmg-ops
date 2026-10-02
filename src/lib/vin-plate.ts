/**
 * Reading a VIN off a photo of the VIN plate (owner ask 2026-10-02: some
 * vehicles have no barcode the scanner can read). The AI does the reading
 * (/api/vin-plate/read); this is the pure checking around it, so a misread
 * character is caught or corrected before anyone pulls the wrong van in.
 */

const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Upper-case, strip spaces/dashes, and map the letters a VIN can never
 *  hold to the digits they are read for (I→1, O/Q→0). */
export function normalizeVinRead(raw: string | null | undefined): string {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/I/g, '1')
    .replace(/[OQ]/g, '0');
}

/** Position 9 check digit (North American VINs — every vehicle we upfit). */
export function vinCheckDigitOk(vin: string): boolean {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    const v = /[0-9]/.test(c) ? Number(c) : TRANSLIT[c];
    if (v === undefined) return false;
    sum += v * WEIGHTS[i];
  }
  const r = sum % 11;
  return vin[8] === (r === 10 ? 'X' : String(r));
}

function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export interface VinPlateMatch {
  vin: string;
  /** How sure: exact read, or the closest vehicle on the lot to a misread. */
  kind: 'exact' | 'close';
  differences: number;
}

/**
 * Find the vehicle on the lot a read refers to. An exact read wins. Failing
 * that, a vehicle within two characters of a 17-character read — or one
 * whose last 8 match — is offered, but only when it is the ONLY such
 * vehicle: two near-misses means we can't tell, and the tech confirms.
 */
export function matchVinRead(reads: string[], lotVins: string[]): VinPlateMatch | null {
  const lot = [...new Set(lotVins.map(v => v.toUpperCase()))];
  const lotSet = new Set(lot);
  const cleaned = reads.map(normalizeVinRead).filter(Boolean);
  for (const r of cleaned) if (lotSet.has(r)) return { vin: r, kind: 'exact', differences: 0 };

  const near = new Map<string, number>();
  for (const r of cleaned) {
    if (r.length === 17) {
      for (const v of lot) {
        const d = hamming(r, v);
        if (d <= 2 && (near.get(v) ?? 99) > d) near.set(v, d);
      }
    }
    if (r.length >= 8) {
      const tail = r.slice(-8);
      for (const v of lot) if (v.endsWith(tail) && !near.has(v)) near.set(v, r.length === 17 ? hamming(r, v) : 0);
    }
  }
  if (near.size !== 1) return null;
  const [[vin, differences]] = [...near.entries()];
  return { vin, kind: 'close', differences };
}
