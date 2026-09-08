import { describe, it, expect } from 'vitest';
import {
  blockedFromChecking, lineState, packProgress, packSummaryNote, quantityFlag,
  type PackItem,
} from './pack-checklist';

const item = (over: Partial<PackItem> = {}): PackItem => ({
  id: 'i1', lineIndex: 0, partNumber: 'GFX-1', description: 'Door decal',
  quantityExpected: 4, quantityPacked: null,
  packedBy: null, packedAt: null, checkedBy: null, checkedAt: null,
  photoPath: null, notes: null, ...over,
});

const packed = (by = 'alice') => item({ packedBy: by, packedAt: '2026-09-08T10:00:00Z', quantityPacked: 4 });
const verified = (by = 'bob') => ({ ...packed(), checkedBy: by, checkedAt: '2026-09-08T10:05:00Z' });

describe('lineState', () => {
  it('walks open → packed → verified', () => {
    expect(lineState(item())).toBe('open');
    expect(lineState(packed())).toBe('packed');
    expect(lineState(verified())).toBe('verified');
  });
});

describe('blockedFromChecking', () => {
  it('refuses the packer verifying their own line — the whole point of the second signature', () => {
    expect(blockedFromChecking(packed('alice'), 'alice')).toBe('Someone else has to verify what you packed.');
    expect(blockedFromChecking(packed('alice'), 'bob')).toBeNull();
  });

  it('refuses verifying a line nobody packed, and re-verifying a done line', () => {
    expect(blockedFromChecking(item(), 'bob')).toBe('Pack the line before verifying it.');
    expect(blockedFromChecking(verified(), 'carol')).toBe('Already verified.');
  });
});

describe('quantityFlag', () => {
  it('surfaces short and over counts, and stays quiet when unknown or exact', () => {
    expect(quantityFlag(item({ quantityExpected: 4, quantityPacked: 3 }))).toBe('short');
    expect(quantityFlag(item({ quantityExpected: 4, quantityPacked: 5 }))).toBe('over');
    expect(quantityFlag(item({ quantityExpected: 4, quantityPacked: 4 }))).toBeNull();
    expect(quantityFlag(item({ quantityExpected: null, quantityPacked: 4 }))).toBeNull();
  });
});

describe('packProgress', () => {
  it('counts states, photos and short lines, and only calls it complete when every line is verified', () => {
    const items = [
      verified('bob'),
      { ...packed('alice'), id: 'i2', photoPath: 'pack/x.jpg' },
      { ...item({ id: 'i3', quantityExpected: 4, quantityPacked: 2, packedBy: 'alice', packedAt: 'now' }) },
    ];
    const p = packProgress(items);
    expect(p).toMatchObject({ total: 3, packed: 3, verified: 1, withPhoto: 1, shortLines: 1, complete: false });

    const allDone = [verified('bob'), { ...verified('bob'), id: 'i2' }];
    expect(packProgress(allDone).complete).toBe(true);
  });

  it('an empty checklist is never "complete" — nothing verified is not everything verified', () => {
    expect(packProgress([]).complete).toBe(false);
  });
});

describe('packSummaryNote', () => {
  it('reports photos and short counts when there are any', () => {
    expect(packSummaryNote(packProgress([verified('bob')])))
      .toBe('Pack check complete — 1/1 lines packed and verified.');
    const withIssues = packProgress([
      { ...verified('bob'), photoPath: 'p.jpg', quantityExpected: 4, quantityPacked: 3 },
    ]);
    expect(packSummaryNote(withIssues)).toContain('1 with a photo');
    expect(packSummaryNote(withIssues)).toContain('1 short');
  });
});
