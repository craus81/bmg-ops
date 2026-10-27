import { describe, it, expect } from 'vitest';
import { legacyQuotesTarget } from './legacy-quotes-url';

const p = (qs: string) => new URLSearchParams(qs);

describe('legacyQuotesTarget', () => {
  it('keeps the exact row', () => {
    expect(legacyQuotesTarget(p('item=estimate-6f1c2a9e-1111-2222-3333-444455556666'))).toBe('/estimates?item=estimate-6f1c2a9e-1111-2222-3333-444455556666');
    expect(legacyQuotesTarget(p('item=wrap-abc'))).toBe('/estimates?item=wrap-abc');
  });
  it('maps the old status groups', () => {
    expect(legacyQuotesTarget(p(''))).toBe('/estimates?status=sent');
    expect(legacyQuotesTarget(p('status=sent'))).toBe('/estimates?status=sent');
    expect(legacyQuotesTarget(p('status=working'))).toBe('/estimates?status=draft');
    expect(legacyQuotesTarget(p('status=lost'))).toBe('/estimates?status=rejected');
    expect(legacyQuotesTarget(p('status=won'))).toBe('/estimates');
    expect(legacyQuotesTarget(p('status=all'))).toBe('/estimates');
  });
  it('ignores a malformed item', () => {
    expect(legacyQuotesTarget(p('item=<script>'))).toBe('/estimates?status=sent');
  });
});
