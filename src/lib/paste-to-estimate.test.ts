import { describe, it, expect } from 'vitest';
import {
  parseDraftReply, matchRequest, matchScore, summarize, MIN_MATCH_SCORE, DRAFT_SYSTEM,
  type CatalogPart,
} from './paste-to-estimate';

const part = (over: Partial<CatalogPart> = {}): CatalogPart => ({
  id: 'p1', item_number: 'RACK-100', display_name: 'Aluminum roof rack',
  description: 'Aluminum roof rack, full length', sales_price: 450, labor_hours: 1.5, ...over,
});
const req = (over = {}) => ({ raw: 'roof racks', itemNumber: null, description: 'roof rack', quantity: 2, ...over });

describe('parseDraftReply', () => {
  it('reads the model reply out of surrounding prose', () => {
    const d = parseDraftReply('Here you go:\n{"vehicleCount":12,"lines":[{"raw":"12 racks","itemNumber":null,"description":"roof rack","quantity":12}]}\nHope that helps.');
    expect(d?.vehicleCount).toBe(12);
    expect(d?.lines[0].description).toBe('roof rack');
  });

  it('is null — not an empty draft — when the reply is not JSON at all', () => {
    expect(parseDraftReply('I could not read that document.')).toBeNull();
    expect(parseDraftReply('')).toBeNull();
    expect(parseDraftReply('{ broken')).toBeNull();
  });

  it('treats an unstated quantity as UNKNOWN, never 1', () => {
    // "We need roof racks" does not say how many; assuming one under-quotes
    // a fleet order by the whole fleet.
    const d = parseDraftReply('{"lines":[{"raw":"racks","description":"roof rack","quantity":null}]}');
    expect(d?.lines[0].quantity).toBeNull();
  });

  it('refuses a zero or negative quantity as a quantity', () => {
    const d = parseDraftReply('{"lines":[{"description":"a","quantity":0},{"description":"b","quantity":-3}]}');
    expect(d?.lines.map(l => l.quantity)).toEqual([null, null]);
  });

  it('keeps an empty line list rather than failing — some emails ask for nothing', () => {
    expect(parseDraftReply('{"vehicleCount":null,"lines":[]}')).toEqual({ vehicleCount: null, lines: [] });
  });

  it('falls back to the raw wording when a line has no description', () => {
    const d = parseDraftReply('{"lines":[{"raw":"two of the big ones","description":""}]}');
    expect(d?.lines[0].description).toBe('two of the big ones');
  });

  it('ignores a vehicle count below one', () => {
    expect(parseDraftReply('{"vehicleCount":0,"lines":[]}')?.vehicleCount).toBeNull();
  });
});

describe('the prompt', () => {
  it('forbids the model from producing a price at all', () => {
    // The one output that would be quoted, sent and signed if it were wrong.
    expect(DRAFT_SYSTEM).toMatch(/NEVER include a price/);
  });
  it('forbids inventing a part number', () => {
    expect(DRAFT_SYSTEM).toMatch(/Never construct, guess or complete one/);
  });
});

describe('matchRequest — stated part number', () => {
  it('is an exact match when the catalog carries it', () => {
    const m = matchRequest(req({ itemNumber: 'RACK-100' }), [part()]);
    expect(m.confidence).toBe('exact');
    expect(m.unitPrice).toBe(450);
    expect(m.laborHours).toBe(1.5);
  });

  it('ignores case and spacing in the stated number', () => {
    expect(matchRequest(req({ itemNumber: ' rack-100 ' }), [part()]).confidence).toBe('exact');
    expect(matchRequest(req({ itemNumber: 'rack-100' }), [part()]).confidence).toBe('exact');
  });

  it('finds a punctuation-only variant, but calls it a NEAR match and says why', () => {
    // Customers write RACK-100, RACK 100 and rack100 for one part. Collapsing
    // punctuation can also merge two genuinely different catalog numbers, so
    // the rep confirms rather than the code deciding.
    const m = matchRequest(req({ itemNumber: 'rack 100' }), [part()]);
    expect(m.confidence).toBe('strong');
    expect(m.part?.item_number).toBe('RACK-100');
    expect(m.signal).toMatch(/different punctuation/);
  });

  it('does NOT substitute a lookalike when the stated number is not in the catalog', () => {
    // The customer named a part we do not carry. That is a fact to surface,
    // not a licence to quote something else.
    const m = matchRequest(req({ itemNumber: 'RACK-999', description: 'roof rack' }), [part()]);
    expect(m.confidence).toBe('none');
    expect(m.part).toBeNull();
    expect(m.signal).toMatch(/not in the catalog/);
  });
});

describe('matchRequest — by description', () => {
  it('calls an exact name match strong', () => {
    const m = matchRequest(req({ description: 'Aluminum roof rack' }), [part()]);
    expect(m.confidence).toBe('strong');
  });

  it('offers a partial match as a WEAK suggestion, with what it matched and how well', () => {
    const m = matchRequest(req({ description: 'aluminum rack for the roof' }), [part()]);
    expect(m.confidence).toBe('weak');
    expect(m.matchedText).toBeTruthy();
    expect(m.score).toBeGreaterThanOrEqual(MIN_MATCH_SCORE);
    expect(m.signal).toMatch(/% of the request/);
  });

  it('offers nothing at all below the threshold rather than the least-bad guess', () => {
    const m = matchRequest(req({ description: 'windshield wiper blades' }), [part()]);
    expect(m.confidence).toBe('none');
    expect(m.part).toBeNull();
  });

  it('has nothing to match against an empty catalog', () => {
    expect(matchRequest(req(), []).confidence).toBe('none');
  });
});

describe('price handling', () => {
  it('reports NO price rather than zero when the catalog has none', () => {
    // A zero would be quoted as free.
    const m = matchRequest(req({ itemNumber: 'RACK-100' }), [part({ sales_price: 0 })]);
    expect(m.confidence).toBe('exact');
    expect(m.unitPrice).toBeNull();
  });

  it('reports no price for a null catalog price', () => {
    expect(matchRequest(req({ itemNumber: 'RACK-100' }), [part({ sales_price: null })]).unitPrice).toBeNull();
  });

  it('keeps a catalog labor of 0 as 0 — that is "no labor", a real answer', () => {
    expect(matchRequest(req({ itemNumber: 'RACK-100' }), [part({ labor_hours: 0 })]).laborHours).toBe(0);
  });

  it('reports labor as unknown when the catalog never set it', () => {
    expect(matchRequest(req({ itemNumber: 'RACK-100' }), [part({ labor_hours: null })]).laborHours).toBeNull();
  });
});

describe('matchScore', () => {
  it('is measured against the REQUEST, so a long catalog entry does not dilute it', () => {
    expect(matchScore('roof rack', 'Aluminum roof rack, full length, powder coated, fleet grade')).toBe(1);
  });
  it('is zero with nothing in common', () => {
    expect(matchScore('roof rack', 'floor mat')).toBe(0);
  });
  it('ignores short filler words', () => {
    expect(matchScore('a to the of', 'roof rack')).toBe(0);
  });
});

describe('summarize', () => {
  it('counts what the rep still has to do', () => {
    const lines = [
      matchRequest(req({ itemNumber: 'RACK-100' }), [part()]),
      matchRequest(req({ description: 'aluminum rack for the roof' }), [part()]),
      matchRequest(req({ description: 'windshield wipers' }), [part()]),
      matchRequest(req({ itemNumber: 'RACK-100', quantity: null }), [part({ sales_price: null })]),
    ];
    const s = summarize(lines);
    expect(s.total).toBe(4);
    expect(s.exact).toBe(2);
    expect(s.suggested).toBe(1);
    expect(s.unmatched).toBe(1);
    expect(s.missingQuantity).toBe(1);
    expect(s.missingPrice).toBe(1);
  });
});
