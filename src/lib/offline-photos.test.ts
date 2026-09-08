import { describe, it, expect } from 'vitest';
import { countByScan, waitingNote, orphanedPhotos } from './offline-photos';

describe('countByScan', () => {
  it('counts photos per queued scan', () => {
    expect(countByScan([
      { localScanId: 'a' }, { localScanId: 'a' }, { localScanId: 'b' },
    ])).toEqual({ a: 2, b: 1 });
  });

  it('is empty when nothing is queued', () => {
    expect(countByScan([])).toEqual({});
  });
});

describe('waitingNote', () => {
  it('says nothing when nothing waits', () => {
    expect(waitingNote(0)).toBeNull();
  });
  it('pluralizes', () => {
    expect(waitingNote(1)).toBe('1 photo waiting');
    expect(waitingNote(3)).toBe('3 photos waiting');
  });
});

describe('orphanedPhotos', () => {
  it('finds photos whose scan has left the queue', () => {
    const orphans = orphanedPhotos(
      [{ id: 'p1', localScanId: 'gone' }, { id: 'p2', localScanId: 'live' }],
      ['live'],
    );
    expect(orphans).toEqual(['p1']);
  });

  it('reports rather than assuming — a photo of a finished install is evidence', () => {
    // The function only NAMES them; deleting is the caller's deliberate act
    // after telling somebody.
    expect(orphanedPhotos([{ id: 'p1', localScanId: 'x' }], [])).toEqual(['p1']);
  });

  it('finds nothing when every photo still has its scan', () => {
    expect(orphanedPhotos([{ id: 'p1', localScanId: 'a' }], ['a', 'b'])).toEqual([]);
  });
});
