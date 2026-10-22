import { describe, it, expect } from 'vitest';
import { sentTags } from './estimate-file-tags';

describe('sentTags', () => {
  it('one tag per kind and day, ignoring junk', () => {
    expect(sentTags([
      { kind: 'approval', at: '2026-10-21T15:00:00' },
      { kind: 'approval', at: '2026-10-21T18:00:00' },
      { kind: 'follow_up', at: '2026-10-23T15:00:00' },
      { kind: 'nope' as any, at: '2026-10-23T15:00:00' },
    ])).toEqual(['Sent for approval 10/21', 'Sent in follow-up 10/23']);
    expect(sentTags(null)).toEqual([]);
    expect(sentTags({} as any)).toEqual([]);
  });
});
